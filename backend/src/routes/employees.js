const express = require('express');
const { HR_STATUSES } = require('../utils/hrStatus');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const prisma = require('../db');
const { requireAuth, requirePerm, can } = require('../middleware/auth');
const {
  scopeOf,
  hrmsGlobal,
  scopeDepartments: scopeDepartmentsOf,
  employeeWhere: employeeWhereOf,
  employeeInScope,
  scopeLabel: scopeLabelOf,
  clientWhere,
} = require('../utils/scope');
const attachments = require('../utils/attachments');
const { atsRoleLabel } = require('../utils/atsVocab');
const { logAudit, logFieldChanges, resolveFieldApprovals } = require('../utils/audit');
const { sendCredentials, unguessablePasswordHash } = require('../utils/employeeInvite');
const { strengthError, passwordEventData, passwordStatusOf } = require('../utils/passwordPolicy');
// The designation -> role / product-access mapping. DATA in the
// DesignationRole table, never a switch statement here: the same "TL" row
// serves Medical, IT and everyone else, because the DEPARTMENT is the scope.
const { mappingFor } = require('../utils/identity');
const { toCsv, toXlsx, toXlsxBook, toPdf } = require('../utils/tabularExport');
// Employee administration — the shared vocabulary the Employee Management
// surface below and the Administration → Users screen both read. Moved out of
// routes/admin.js with the routes; see utils/employeeAdmin.js for why.
const {
  ALL_ROLES, EMAIL_RE, normalEmail,
  designationRows, defaultProductAccessByRole, loginRoleFor, productRolesForDesignation,
  EMP_MGMT_INCLUDE, shapeEmployeeMgmtRow, tlWiseGroups,
  OTP_TTL_MINUTES, OTP_MAX_ATTEMPTS, OTP_PURPOSE, hashOtp, liveVerification,
  syncLoginToEmployee,
  employeeListExtras, transferHistoryOf, isLead, OPEN_RESIGNATION,
} = require('../utils/employeeAdmin');
const { CATALOG_ROLES } = require('../utils/roleAccess');
const {
  listRoles, roleByCode, isPrivilegedRole, loginPatchForRole,
} = require('../utils/roleRegistry');
const {
  EMP_TYPES, EMP_STATUSES, EMP_GENDERS, EMP_MGMT_STATUS_FILTER,
} = require('../utils/adminCatalog');
const { DEPTS, LOCS } = require('../utils/atsVocab');
const mailer = require('../utils/mailer');
const { senderIdentity } = require('../utils/candidateComms');
const { today: positionToday, hasLeft: seatHolderLeft, lastWorkingDayOf } = require('../utils/positions');
const empVerify = require('../utils/employeeVerification');
const emailVerify = require('../utils/employeeEmailVerification');
// Super Admin is a system account, not an employee: it drops out of every
// employee list, count, export and import below.
const { withoutSystemAccounts } = require('../utils/systemAccounts');
// Employee ID: the next TL<nnn> and the checks on a changed one.
const employeeCodes = require('../utils/employeeCode');
// Every export / import tells the Super Admin (in-app + throttled email).
const { notifyDataIo } = require('../utils/dataIoNotify');

const router = express.Router();

// NO ASYNC HANDLER IN THIS FILE CAN TAKE THE PROCESS DOWN.
// Express 4 does not catch a rejected promise returned from a handler, so one
// bad write (a foreign key, a date string in a DateTime column) becomes an
// unhandled rejection and node exits. That has happened twice. Every handler
// registered below is wrapped so a rejection becomes next(err) and the error
// handler in index.js answers 500 instead.
['get', 'post', 'put', 'patch', 'delete'].forEach((method) => {
  const original = router[method].bind(router);
  router[method] = (path, ...handlers) => original(path, ...handlers.map((h) => (
    typeof h !== 'function' || h.length >= 4 ? h : function guarded(req, res, next) {
      try {
        const out = h(req, res, next);
        if (out && typeof out.catch === 'function') out.catch(next);
        return out;
      } catch (err) { return next(err); }
    }
  )));
});

router.use(requireAuth);

// STL/TL are themselves employees, scoped to their own department only. Manager
// and Assistant Manager have cross-department oversight (see Role Catalog) so
// they get the same unrestricted, company-wide visibility as Super Admin/Admin —
// including the full Department dropdown when adding an employee.
// Department scoping now comes from the resolved identity's scope, so an
// STL with several departments really gets several departments.

// EVERY department the requesting user may reach, or `undefined` when their
// role is unrestricted (Super Admin / Admin, or a Manager with no configured
// list). This used to return departments[0] and throw the rest away, so an
// STL or a Manager scoped to several departments saw one department's list
// while assertInScope() below happily allowed all of theirs — the list and
// the record check disagreed. One function now answers for both.
// These three moved to utils/scope.js, where attendance, leave, payroll, the
// employee-record routers and the option endpoints now read the SAME copy.
// They are kept here as thin req-taking wrappers so the dozens of call sites
// below read unchanged — there is still exactly one rule.
const scopeDepartments = (req) => scopeDepartmentsOf(req.user);
// EVERY CALLER OF THIS ONE QUERIES prisma.employee, so it must be the EMPLOYEE
// rule and not the bare department filter. departmentWhereOf() is a plain
// `department IN (...)` for any model that has a department column; it knows
// nothing about who outranks whom, which is why a Medical TL's list carried
// their own STL and both Medical Managers while employeeWhere() — the rule the
// rest of HRMS uses — already excluded them.
const departmentWhere = (req) => employeeWhereOf(req.user);
const scopeLabel = (req) => scopeLabelOf(req.user);

async function assertInScope(req, employee) {
  // hrmsGlobal() is scopeOf().global (Super Admin / Admin, an unconfigured
  // Manager) PLUS the HR desk: "all employees are visible to HR" (§6), so HR
  // is not held to a department the way a Manager, an STL or a TL is. It is
  // the same helper utils/scope.js employeeWhere() uses for the list, so the
  // record check and the list query cannot disagree.
  if (hrmsGlobal(req.user)) return true;
  // EXACTLY the list's rule (employeeWhere): a TL reaches their own team only,
  // never a peer team or anyone senior, even inside the same department.
  if (!employee || !employee.id) return false;
  const n = await prisma.employee.count({ where: { AND: [{ id: employee.id }, employeeWhereOf(req.user)] } });
  return n > 0;
}

const DEFAULT_ONBOARDING_TASKS = [
  'Offer letter signed', 'ID proof collected', 'PAN card collected',
  'Laptop/asset assigned', 'Reporting manager introduction', 'System access provisioned',
];
const DEFAULT_OFFBOARDING_TASKS = [
  'Exit interview scheduled', 'Assets returned', 'Access revoked',
  'Full & final settlement processed', 'Experience letter issued',
];

// Fields the employee fills in themselves after HR creates their bare login
// (id/name/department/role/email/password). Department/designation/employmentStatus
// stay HR-controlled even after the profile is unlocked.
const SELF_SERVICE_FIELDS = {
  phone: 'Phone', email: 'Email', dateOfBirth: 'Date of birth', gender: 'Gender', bloodGroup: 'Blood group',
  addressType: 'Address type', addressLine1: 'Address line 1', addressLine2: 'Address line 2', city: 'City',
  district: 'District', state: 'State', country: 'Country', postalCode: 'Postal code',
  emergencyContactName: 'Emergency contact name', emergencyContactPhone: 'Emergency contact phone', emergencyContactRelation: 'Emergency contact relation',
  branch: 'Branch', shift: 'Shift', employmentExperience: 'Employment type', educationDetails: 'Education details', skills: 'Skills & certifications',
  bankName: 'Bank name', bankAccountNumber: 'Account number', ifscCode: 'IFSC code', panNumber: 'PAN number',
  aadhaarNumber: 'Aadhaar number', uanNumber: 'UAN number', pfNumber: 'PF number', esiNumber: 'ESI number',
};

// Self-service fields that are DateTime columns rather than strings. The form
// posts "YYYY-MM-DD"; Prisma wants a Date. See the approve handler.
const DATE_FIELDS = new Set(['dateOfBirth']);
function toDate(value) {
  if (!value) return null;
  const d = new Date(String(value).length === 10 ? `${value}T00:00:00.000Z` : value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// --- THE PROFILE STATUS VOCABULARY ------------------------------------------
// Six values, each meaning exactly one thing. The old three (Assigned /
// Pending Review / Locked) could not tell "nobody has filled this in yet"
// apart from "HR sent it back" or "HR has opened it for 48 hours", which is
// the difference between three completely different things HR has to do.
// Existing rows were migrated in place — see
// prisma/migrations/..._empmgmt_status_unlock_grant_field_audit.
const PROFILE_STATUS = {
  INCOMPLETE: 'Profile Incomplete',
  PENDING: 'Pending Review',
  APPROVED: 'Approved',
  LOCKED: 'Locked',
  CHANGE_REQUESTED: 'Change Requested',
  EDIT_GRANTED: 'Edit Access Granted',
};
const PROFILE_STATUSES = Object.values(PROFILE_STATUS);

// DERIVED from the facts, in this order of precedence, so the badge can never
// contradict what the server will actually let the employee do. Employee.
// profileStage stores the same value at every transition; withComputed()
// overrides the stored one with this, so a row written by an older code path
// still renders correctly instead of showing a stale word.
function profileStatusOf(e) {
  if (!e) return PROFILE_STATUS.INCOMPLETE;
  if (e.pendingChanges) return PROFILE_STATUS.PENDING;
  if (e.isLocked) return PROFILE_STATUS.LOCKED;
  if (e.unlockExpiresAt && new Date(e.unlockExpiresAt) > new Date()) return PROFILE_STATUS.EDIT_GRANTED;
  if (e.reviewDecision === 'Rejected') return PROFILE_STATUS.CHANGE_REQUESTED;
  if (e.reviewDecision === 'Approved') return PROFILE_STATUS.APPROVED;
  return PROFILE_STATUS.INCOMPLETE;
}

const UNLOCK_REQUEST_LIMIT = 3;
const UNLOCK_REQUEST_REASONS = [
  'Incorrect information entered', 'Address changed', 'Bank details need update',
  'Contact number changed', 'Name correction needed', 'Other',
];

// --- The edit window an approved unlock request grants ----------------------
// HR granting edit access does NOT reopen the profile for good. The grant is
// bounded twice over:
//   * TIME — UNLOCK_WINDOW_HOURS from the approval (48h). After that the very
//     next self-service write re-locks the profile and is refused (see
//     enforceEditWindow below), so an unlock that nobody used cannot sit open.
//   * USE  — submitting the changes ends the window immediately: the profile
//     goes back to Pending Review, and HR's approval locks it again.
// Whichever comes first wins.
const UNLOCK_WINDOW_HOURS = Number(process.env.UNLOCK_WINDOW_HOURS || 48);

// --- EDIT ACCESS IS NOT DATA SCOPE ------------------------------------------
// Two different things share the word "access" and must never be conflated:
//
//   EDIT SCOPE        (Administration -> Users -> Edit scope)
//     WHICH RECORDS a login may reach — departments, teams, clients. It is
//     permanent until changed and it is about OTHER people's data.
//     Stored on User.atsScopeDepartments / Teams / Clients.
//
//   GRANT EDIT ACCESS (Employee Management -> Grant Edit Access)
//     TEMPORARILY reopens ONE employee's OWN locked profile so they can
//     correct it. It expires, it is spent by submitting, and it is about
//     that person's own record only.
//     Stored on Employee.unlockExpiresAt + the unlockedBy/At/Reason record.
//
// Granting edit access never widens what anybody can see; changing edit scope
// never unlocks anybody's profile.
//
// The section a grant is limited to. Recorded on the employee so "we opened
// bank details only" is a fact on the record rather than a memory.
const EDIT_ACCESS_SECTIONS = [
  'All fields', 'Personal Information', 'Address', 'Emergency Contact',
  'Work Details', 'Bank & Statutory Details',
];

// How long a grant may run. Configurable per grant (HR types the hours), with
// a floor and a ceiling so nobody can grant 0 hours by accident or leave a
// profile open for a year.
const MIN_GRANT_HOURS = 1;
const MAX_GRANT_HOURS = 24 * 30;
function grantHours(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return UNLOCK_WINDOW_HOURS;
  return Math.min(MAX_GRANT_HOURS, Math.max(MIN_GRANT_HOURS, Math.round(n)));
}

// The one place that writes an edit-access grant onto an employee, so every
// route into that state records the same six facts the lifecycle asks for:
// which employee, which section, why, when it starts, when it expires, and
// who granted it.
function grantEditAccessData({ actingUser, hours, reason, section }) {
  const now = new Date();
  return {
    isLocked: false,
    profileStage: PROFILE_STATUS.EDIT_GRANTED,
    unlockExpiresAt: new Date(now.getTime() + hours * 60 * 60 * 1000),
    unlockedAt: now,
    unlockedById: actingUser && actingUser.id ? actingUser.id : null,
    unlockedByName: (actingUser && actingUser.name) || null,
    unlockGrantReason: reason ? String(reason).slice(0, 500) : null,
    unlockGrantSection: EDIT_ACCESS_SECTIONS.includes(section) ? section : 'All fields',
  };
}

// The single place that decides "may this person still edit their own
// profile?". Called by every self-service write. It RE-LOCKS an expired
// window rather than merely refusing, so the state on screen matches the
// answer the server just gave.
async function enforceEditWindow(employee) {
  if (employee.isLocked) {
    return { allowed: false, error: 'Your profile is locked. Request edit access from HR to make further changes.' };
  }
  if (employee.unlockExpiresAt && new Date(employee.unlockExpiresAt) < new Date()) {
    await prisma.employee.update({
      where: { id: employee.id },
      data: { isLocked: true, profileStage: PROFILE_STATUS.LOCKED, unlockExpiresAt: null },
    });
    await logAudit({ action: 'Edit window expired — profile re-locked', entity: 'Employee', entityId: employee.id });
    return {
      allowed: false,
      error: `The edit access HR granted you expired on ${new Date(employee.unlockExpiresAt).toLocaleString('en-GB')}. Request edit access again if you still need to change something.`,
    };
  }
  return { allowed: true };
}

function completionPct(e) {
  const fields = [
    'name', 'department', 'designation', 'reportingManagerId', 'location', 'phone', 'email', 'dateOfJoining',
    'dateOfBirth', 'gender', 'bloodGroup', 'addressLine1', 'city', 'state', 'postalCode',
    'emergencyContactName', 'emergencyContactPhone', 'branch', 'bankName', 'bankAccountNumber', 'ifscCode',
    'panNumber', 'aadhaarNumber', 'educationDetails', 'skills',
  ];
  const filled = fields.filter((f) => e[f]).length;
  return Math.round((filled / fields.length) * 100);
}

function withComputed(e) {
  const profileStatus = profileStatusOf(e);
  return {
    ...e,
    // Both names carry the SAME derived value. `profileStage` is what every
    // existing screen already reads; `profileStatus` is the name the
    // lifecycle uses. Neither can drift from the other.
    profileStage: profileStatus,
    profileStatus,
    profileCompletionPct: completionPct(e),
    onboardingTasks: e.onboardingTasks ? JSON.parse(e.onboardingTasks) : null,
    offboardingTasks: e.offboardingTasks ? JSON.parse(e.offboardingTasks) : null,
    pendingChanges: e.pendingChanges ? JSON.parse(e.pendingChanges) : null,
  };
}

router.get('/me/config', (req, res) => {
  res.json({
    unlockRequestLimit: UNLOCK_REQUEST_LIMIT,
    unlockRequestReasons: UNLOCK_REQUEST_REASONS,
    unlockWindowHours: UNLOCK_WINDOW_HOURS,
    profileStatuses: PROFILE_STATUSES,
    // The sections an edit-access grant can be scoped to. HR picks one when
    // granting, and it is recorded on the employee record.
    editAccessSections: EDIT_ACCESS_SECTIONS,
  });
});

router.get('/me', async (req, res) => {
  const employee = await prisma.employee.findUnique({ where: { userId: req.user.id }, include: { reportingManager: true } });
  if (!employee) return res.status(404).json({ error: 'No employee record linked to this account' });
  // What is proved, what is outstanding, and whether a code can actually be
  // delivered — so the screen never offers a button that cannot work.
  // The seat, read-only on this screen. An employee may see which desk they
  // hold; they may not change it.
  const seat = await prisma.positionAssignment.findFirst({
    where: { employeeId: employee.id, toDate: null },
    include: { position: true },
  });
  res.json({
    ...withComputed(employee),
    position: seat ? seat.position.code : '',
    verification: empVerify.verificationState(employee),
    emailVerification: await emailVerify.emailState(employee),
    channels: { sms: await empVerify.smsChannel() },
  });
});

// =========================================================================
// IDENTITY VERIFICATION — the employee proving their OWN mobile and Aadhaar.
//
// Both routes resolve the employee from the LOGIN, never from a parameter.
// There is deliberately no :id form: "verify employee X" is not an action
// anybody should be able to take on somebody else, and an id in the path is
// how that ends up possible.
// =========================================================================
router.post('/me/verify/start', async (req, res, next) => {
  try {
    const employee = await prisma.employee.findUnique({ where: { userId: req.user.id } });
    if (!employee) return res.status(404).json({ error: 'No employee record linked to this account' });

    const started = await empVerify.startVerification(employee, {
      kind: req.body.kind, mobile: req.body.mobile, aadhaar: req.body.aadhaar,
    });
    if (started.error) return res.status(400).json({ error: started.error });

    // THE CODE IS DELIVERED, NEVER RETURNED. Returning it would let the
    // holder of the session pass a check that is meant to prove a phone.
    //
    // And it is delivered by SMS or not at all: mailing a code to verify a
    // MOBILE proves the mailbox, not the number. No SMS client exists yet,
    // so today this always reports undelivered — and says why, rather than
    // emailing it and calling the mobile verified.
    let delivery = null;
    if (started.sms.deliverable) {
      delivery = `sent by SMS to ${started.masked}`;
    }

    await logAudit({
      userId: req.user.id,
      action: `Identity verification started (${started.kind})`,
      entity: 'Employee', entityId: employee.id,
    });

    return res.json({
      kind: started.kind,
      mobile: started.masked,
      ttlMinutes: started.ttlMinutes,
      delivered: !!delivery,
      delivery,
      // Said plainly on the screen of the person who just pressed the button.
      note: delivery ? null : started.sms.reason,
      esign: started.esign ? started.esign.name : null,
      esignNote: started.kind === "AADHAAR" && !started.esign
        ? 'No Aadhaar eSign provider is connected, so this can only check the number offline — it will not be a UIDAI-authenticated verification.'
        : null,
    });
  } catch (err) { return next(err); }
});

router.post('/me/verify/confirm', async (req, res, next) => {
  try {
    const employee = await prisma.employee.findUnique({ where: { userId: req.user.id } });
    if (!employee) return res.status(404).json({ error: 'No employee record linked to this account' });

    const done = await empVerify.confirmVerification(employee, { otp: req.body.otp });
    if (done.error) return res.status(400).json({ error: done.error });

    await logAudit({
      userId: req.user.id,
      action: `${done.kind} verified${done.kind === "AADHAAR" && !done.esign ? " (offline check only)" : ""}`,
      entity: 'Employee', entityId: employee.id,
    });

    return res.json({
      kind: done.kind,
      verified: done.verified,
      note: done.note,
      verification: empVerify.verificationState(done.employee),
    });
  } catch (err) { return next(err); }
});

// EMAIL VERIFICATION — the employee proving the email on their own form.
// The address comes in the body because the employee may be verifying the
// NEW address they just typed, before submitting it; the code goes to that
// address and nowhere else. See utils/employeeEmailVerification.js.
router.get('/me/verify-email', async (req, res) => {
  const employee = await prisma.employee.findUnique({ where: { userId: req.user.id } });
  if (!employee) return res.status(404).json({ error: 'No employee record linked to this account' });
  res.json(await emailVerify.emailState(employee, req.query.email || employee.email));
});
router.post('/me/verify-email/start', async (req, res) => {
  const employee = await prisma.employee.findUnique({ where: { userId: req.user.id } });
  if (!employee) return res.status(404).json({ error: 'No employee record linked to this account' });
  const out = await emailVerify.start(employee, req.body.email, req.user);
  const { status, ...body } = out;
  res.status(status).json({ ...body, state: await emailVerify.emailState(employee, body.email || req.body.email || employee.email) });
});
router.post('/me/verify-email/confirm', async (req, res) => {
  const employee = await prisma.employee.findUnique({ where: { userId: req.user.id } });
  if (!employee) return res.status(404).json({ error: 'No employee record linked to this account' });
  const out = await emailVerify.confirm(employee, req.body.email, req.body.code, req.user);
  const { status, ...body } = out;
  res.status(status).json({ ...body, state: await emailVerify.emailState(employee, req.body.email || employee.email) });
});

// Employee self-service: fills in the rest of their own profile (everything HR
// didn't set at login creation). Submits for HR review rather than applying
// directly. Blocked once the profile is locked (post-approval) or already
// awaiting a decision.
router.put('/me', async (req, res) => {
  const employee = await prisma.employee.findUnique({ where: { userId: req.user.id } });
  if (!employee) return res.status(404).json({ error: 'No employee record linked to this account' });
  // Server-side, and the ONLY thing that decides it. A disabled input in the
  // browser is not access control: this is the 403 a locked employee gets
  // whether they use the screen, curl or anything else.
  const gate = await enforceEditWindow(employee);
  if (!gate.allowed) return res.status(403).json({ error: gate.error });
  if (employee.pendingChanges) return res.status(409).json({ error: 'Your last submission is still awaiting HR review.' });

  const changes = [];
  for (const [field, label] of Object.entries(SELF_SERVICE_FIELDS)) {
    if (req.body[field] === undefined) continue;
    // A DateTime column comes back as a Date; the form sends "YYYY-MM-DD".
    // Comparing those raw made an unchanged date of birth look like an edit.
    const current = DATE_FIELDS.has(field) && employee[field]
      ? new Date(employee[field]).toISOString().slice(0, 10)
      : (employee[field] || '');
    if (req.body[field] !== current) {
      changes.push({ field, label, from: current, to: req.body[field] });
    }
  }
  // SUBMITTING WITH NO FIELD CHANGES IS STILL A SUBMISSION. An employee whose
  // record HR already filled in, or who was sent back only to upload a
  // document, confirms the form as it stands — and it locks for them exactly
  // as an edited one does. HR's review then sees "0 field(s)" and decides.
  const updated = await prisma.employee.update({
    where: { id: employee.id },
    data: {
      pendingChanges: JSON.stringify(changes),
      profileStage: PROFILE_STATUS.PENDING,
      // Submitting SPENDS the granted edit window — see UNLOCK_WINDOW_HOURS.
      unlockExpiresAt: null,
      // The previous decision is history now; the banner should show this
      // submission's state, not the last one's verdict.
      reviewDecision: null, reviewNote: null, reviewedAt: null, reviewedByName: null,
    },
  });
  await logAudit({
    userId: req.user.id, actorName: req.user.name, action: 'Profile submitted for review',
    entity: 'Employee', entityId: employee.id,
    toValue: changes.length ? `${changes.length} field(s)` : 'Confirmed as it stands — no field changes',
  });
  // The email they are submitting (new or unchanged) — not verified? HR hears.
  await emailVerify.notifyHrUnverified(employee, req.body.email !== undefined ? req.body.email : employee.email,
    'they submitted their profile without verifying it').catch(() => null);
  // ONE AUDIT ROW PER FIELD, not one per submission: Employee · Field · Old
  // Value · New Value · Changed By · Changed At, with Approval Status set to
  // Pending until HR decides. resolveFieldApprovals() stamps the approver on
  // these same rows, so the history shows who allowed each value through.
  await logFieldChanges({
    userId: req.user.id, actorName: req.user.name, entity: 'Employee', entityId: employee.id,
    action: 'Profile field submitted', changes, approvalStatus: 'Pending',
  });
  res.json(withComputed(updated));
});

// Employee requests edit access back on a locked profile, capped at UNLOCK_REQUEST_LIMIT.
router.post('/me/unlock-request', async (req, res) => {
  const { reason } = req.body;
  if (!reason || !UNLOCK_REQUEST_REASONS.includes(reason)) return res.status(400).json({ error: 'A valid reason is required' });
  const employee = await prisma.employee.findUnique({ where: { userId: req.user.id } });
  if (!employee) return res.status(404).json({ error: 'No employee record linked to this account' });
  if (!employee.isLocked) return res.status(400).json({ error: 'Your profile is already editable' });
  if (employee.unlockRequestStatus === 'Pending') return res.status(409).json({ error: 'You already have an edit request awaiting HR review' });
  if (employee.unlockRequestCount >= UNLOCK_REQUEST_LIMIT) {
    return res.status(403).json({ error: `You've reached the maximum of ${UNLOCK_REQUEST_LIMIT} edit requests. Please contact HR directly.` });
  }
  const updated = await prisma.employee.update({
    where: { id: employee.id },
    data: { unlockRequestReason: reason, unlockRequestStatus: 'Pending', unlockRequestCount: { increment: 1 } },
  });
  await logAudit({ userId: req.user.id, action: 'Edit access requested', entity: 'Employee', entityId: employee.id, toValue: reason });
  res.json(withComputed(updated));
});

// --- HR's review surface ----------------------------------------------------
// One call that answers "what is waiting for me?". Both queues are scoped the
// same way the employee list is: a TL reviews their own department's
// submissions, never the company's.
router.get('/review-queue', requirePerm(null, 'hrms', 'Employee Management', 'view'), async (req, res) => {
  const where = departmentWhere(req);

  const [submitted, unlocks] = await Promise.all([
    prisma.employee.findMany({ where: { ...where, pendingChanges: { not: null } }, orderBy: { updatedAt: 'asc' } }),
    prisma.employee.findMany({ where: { ...where, unlockRequestStatus: 'Pending' }, orderBy: { updatedAt: 'asc' } }),
  ]);
  res.json({
    scope: scopeLabel(req),
    unlockRequestLimit: UNLOCK_REQUEST_LIMIT,
    unlockWindowHours: UNLOCK_WINDOW_HOURS,
    // May this caller actually decide, or only watch the queue? The engine
    // answers, not a role list here.
    canDecide: await can(req.user, 'hrms', 'hrms', 'Employee Management', 'approve'),
    submitted: submitted.map(withComputed),
    unlockRequests: unlocks.map((e) => ({
      id: e.id, name: e.name, employeeCode: e.employeeCode, department: e.department,
      unlockRequestReason: e.unlockRequestReason, unlockRequestCount: e.unlockRequestCount,
      updatedAt: e.updatedAt,
    })),
  });
});

// --- CSV export -------------------------------------------------------------
// Honours the caller's data scope: a TL downloads their own department, not
// the company. The `export` action is the permission — a role that may VIEW
// the list is not automatically allowed to take a copy of it away.
const EXPORT_COLUMNS = [
  ['employeeCode', 'Employee ID'], ['name', 'Name'], ['email', 'Email'], ['phone', 'Mobile'],
  ['department', 'Department'], ['team', 'Team'], ['designation', 'Designation'], ['location', 'Location'],
  ['branch', 'Branch'], ['employmentStatus', 'Employment Status'], ['employeeType', 'Employment Type'],
  ['dateOfJoining', 'Date of Joining'], ['reportingManagerName', 'Reporting Manager'],
  ['profileStatus', 'Profile Status'], ['profileCompletionPct', 'Profile Completion %'],
  ['credentialsSentStatus', 'Sign-in Email'],
  ['seatCode', 'Position'], ['seatFrom', 'In Position From'], ['seatTo', 'In Position To'],
  ['seatTookOverFrom', 'Took Over From'], ['seatHandedTo', 'Handed To'],
];

// ONE query, ONE scope decision, THREE formats. CSV, Excel and PDF all come
// out of buildExport() below, so a new format can never be the one that
// forgets the department filter or the `export` permission.
async function buildExport(req) {
  const where = departmentWhere(req);
  if (scopeDepartments(req) === undefined && req.query.department) where.department = req.query.department;
  if (req.query.employmentStatus) where.employmentStatus = req.query.employmentStatus;
  // THE ROWS ON SCREEN. The list's filters (status, department, search …)
  // run in the browser, so it sends the ids it is showing; they only narrow
  // the scoped query, never widen it.
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(String) : null;
  const scoped = ids ? { AND: [where, { id: { in: ids } }] } : where;

  const [employees, seats] = await Promise.all([
    prisma.employee.findMany({
      where: withoutSystemAccounts(scoped), include: { reportingManager: { select: { name: true } } }, orderBy: { name: 'asc' },
    }),
    seatTimelines(),
  ]);
  const rows = employees.map((e) => {
    const c = withComputed(e);
    const seat = seatSummary(seats.get(e.id));
    if (seat) {
      c.seatCode = seat.code;
      c.seatFrom = seat.from;
      c.seatTo = seat.current ? 'Present' : seat.to;
      c.seatTookOverFrom = seat.tookOverFrom ? seat.tookOverFrom.name : '';
      c.seatHandedTo = seat.handedTo ? `${seat.handedTo.name} (from ${seat.handedTo.from})` : '';
    }
    c.reportingManagerName = e.reportingManager ? e.reportingManager.name : '';
    c.dateOfJoining = e.dateOfJoining ? new Date(e.dateOfJoining).toISOString().slice(0, 10) : '';
    return EXPORT_COLUMNS.map(([key]) => (c[key] === null || c[key] === undefined ? '' : c[key]));
  });
  const departments = scopeDepartments(req);
  return {
    headers: EXPORT_COLUMNS.map(([, label]) => label),
    rows,
    count: employees.length,
    scopeLabel: scopeLabel(req),
    suffix: departments === undefined ? 'all' : departments.join('-').replace(/[^\w-]+/g, '-').toLowerCase(),
  };
}

async function sendExport(req, res, format) {
  const { headers, rows, count, scopeLabel: label, suffix } = await buildExport(req);
  const stamp = new Date().toISOString().slice(0, 10);
  await notifyDataIo(req, { kind: 'export', module: 'Employee Management', count, what: 'employee records', format, detail: `list export · scope: ${label}` });
  await logAudit({
    userId: req.user.id, actorName: req.user.name,
    action: `Employee list exported (${format.toUpperCase()})`, entity: 'Employee',
    toValue: `${count} row(s), scope: ${label}`,
  });
  const filename = `employees-${suffix}-${stamp}.${format}`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    return res.send(toCsv(headers, rows));
  }
  if (format === 'xlsx') {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return res.send(toXlsx(headers, rows, 'Employees'));
  }
  res.setHeader('Content-Type', 'application/pdf');
  return res.send(toPdf(headers, rows, {
    title: 'Employee Master',
    subtitle: `${count} employee(s) · scope: ${label} · exported ${new Date().toLocaleString('en-GB')} by ${req.user.name || 'user'}`,
  }));
}

// The `export` action is the permission — a role that may VIEW the list is
// not automatically allowed to take a copy of it away. Every format carries
// the same guard and the same scope.
router.get('/export.csv', requirePerm(null, 'hrms', 'Employee Management', 'export'), (req, res) => sendExport(req, res, 'csv'));
router.get('/export.xlsx', requirePerm(null, 'hrms', 'Employee Management', 'export'), (req, res) => sendExport(req, res, 'xlsx'));
router.get('/export.pdf', requirePerm(null, 'hrms', 'Employee Management', 'export'), (req, res) => sendExport(req, res, 'pdf'));
// The same, for exactly the rows the screen is showing (body: { ids }).
router.post('/export.xlsx', requirePerm(null, 'hrms', 'Employee Management', 'export'), (req, res) => sendExport(req, res, 'xlsx'));

// --- GLOBAL EXPORT with the Export Fields picker ----------------------------
//
// GET  /export/fields   every exportable field, from the ONE server-side
//                       registry (utils/employeeExportFields.js, generated
//                       from the Employee model), each marked allowed / locked
//                       for THIS caller.
// POST /export/global   { fields, format: xlsx|csv|pdf, filters }
//
// SCOPE: the same scoped query the list uses — departmentWhere() (role,
// department and team scope) minus system accounts — then the SAME filters
// the screen applies (search, department, designation, role, status, login,
// position) plus a Date of Joining range. A TL exports their team, never the
// company. An employee (self-only HRMS login) gets 403.
//
// FIELD-LEVEL PERMISSIONS: any field this caller may not export is STRIPPED
// even when the request names it by hand (and reported back in
// X-Export-Stripped); a request made only of such fields is refused (403).
// Every export is audit-logged with its fields, row count and filters.
const exportFields = require('../utils/employeeExportFields');
const { formatOf } = require('../utils/exportKit');
const { hrStatusOf: hrStatusOfExport } = require('../utils/hrStatus');

const GLOBAL_EXPORT_FILTERS = ['q', 'dept', 'designation', 'role', 'status', 'login', 'position', 'joinedFrom', 'joinedTo'];

function globalExportRefusal(req) {
  if (req.user.caps && req.user.caps.hrmsSelfOnly) {
    return 'Global Export is not available to an employee login — it reaches only your own record.';
  }
  return null;
}

function cleanExportFilters(raw) {
  const f = {};
  GLOBAL_EXPORT_FILTERS.forEach((k) => {
    const v = raw && raw[k] !== undefined && raw[k] !== null ? String(raw[k]).trim().slice(0, 120) : '';
    if (v) f[k] = v;
  });
  ['joinedFrom', 'joinedTo'].forEach((k) => { if (f[k] && !/^\d{4}-\d{2}-\d{2}$/.test(f[k])) delete f[k]; });
  return f;
}

// Employees.jsx `filtered`, on the server. Kept identical on purpose.
function matchesListFilters(e, f, seatList) {
  const loginStatus = e.user ? (e.user.status || 'Active') : 'No login';
  const employmentStatus = e.employmentStatus || 'Active';
  if (f.position && !(seatList || []).some((t) => t.code === f.position)) return false;
  const q = (f.q || '').toLowerCase();
  if (q && !`${e.name} ${e.employeeCode} ${e.email || ''}`.toLowerCase().includes(q)) return false;
  if (f.dept && e.department !== f.dept) return false;
  if (f.designation && e.designation !== f.designation) return false;
  if (f.role && ((e.user && e.user.role) || '') !== f.role) return false;
  if (!f.position && f.status && hrStatusOfExport(employmentStatus, loginStatus) !== f.status) return false;
  if (f.login && loginStatus !== f.login) return false;
  const doj = e.dateOfJoining ? new Date(e.dateOfJoining).toISOString().slice(0, 10) : '';
  if (f.joinedFrom && (!doj || doj < f.joinedFrom)) return false;
  if (f.joinedTo && (!doj || doj > f.joinedTo)) return false;
  return true;
}

router.get('/export/fields', requirePerm(null, 'hrms', 'Employee Management', 'export'), (req, res) => {
  const refusal = globalExportRefusal(req);
  if (refusal) return res.status(403).json({ error: refusal });
  return res.json({
    fields: exportFields.fieldsFor(req.user),
    sensitivity: Object.entries(exportFields.SENSITIVITY_ACCESS).map(([level, who]) => ({
      level, label: exportFields.SENSITIVITY_LABEL[level], roles: who === 'any' ? 'any' : who,
    })),
    formats: [{ id: 'xlsx', label: 'Excel' }, { id: 'csv', label: 'CSV' }, { id: 'pdf', label: 'PDF' }],
    filters: GLOBAL_EXPORT_FILTERS,
    scope: scopeLabel(req),
    // The "Include document files (ZIP)" switch: allowed / locked + the cap.
    documentFiles: exportFields.documentFilesAccess(req.user),
  });
});

// DOCUMENTS (the "Documents" group, HR / Super Admin / Admin only — see the
// registry): the per-employee columns go into every format; an .xlsx also
// gets a second sheet, "Documents", one row per document of exactly the
// exported employees. `includeFiles: true` returns a .zip instead: the
// spreadsheet plus "<EmployeeID> - <Name>/<DocType> - <original name>" for
// every file, streamed (archiver), capped by DOCUMENT_ZIP_LIMITS, and
// audit-logged with the file count and total size. A caller who may not
// export documents gets 403 for the ZIP.
const zipFs = require('fs');
const DOCUMENTS_SHEET_HEADERS = [
  'Employee ID', 'Employee Name', 'Department', 'Document Type', 'Document Name',
  'File Name', 'File Type', 'Size (KB)', 'Uploaded By', 'Uploaded On',
];
const exportTs = (v) => (v ? new Date(v).toISOString().replace('T', ' ').slice(0, 16) : '');
// A name safe as a ZIP folder / file on Windows, macOS and Linux.
const zipSafe = (s, max = 120) => String(s || '')
  .replace(/[\\/:*?"<>|]/g, '_')
  .split('').filter((ch) => ch.charCodeAt(0) >= 32).join('')
  .replace(/[. ]+$/, '')
  .trim()
  .slice(0, max) || '_';

router.post('/export/global', requirePerm(null, 'hrms', 'Employee Management', 'export'), async (req, res) => {
  const refusal = globalExportRefusal(req);
  if (refusal) return res.status(403).json({ error: refusal });
  const b = req.body || {};
  const format = formatOf({ format: b.format || 'xlsx' });
  if (!format) return res.status(400).json({ error: 'Format must be xlsx, csv or pdf.' });
  const wantFiles = b.includeFiles === true || b.includeFiles === 'true';
  const { allowed, stripped, unknown } = exportFields.authorise(req.user, b.fields);
  if (wantFiles && !exportFields.mayExportDocuments(req.user)) {
    await logAudit({
      userId: req.user.id, actorName: req.user.name, action: 'Employee Global Export refused', entity: 'Employee',
      field: 'export', toValue: JSON.stringify({ refused: ['includeFiles', ...stripped.map((f) => f.key)] }),
    });
    return res.status(403).json({
      error: exportFields.documentFilesAccess(req.user).lockedReason,
      stripped: ['includeFiles', ...stripped.map((f) => f.key)],
    });
  }
  if (!allowed.length) {
    if (stripped.length) {
      await logAudit({
        userId: req.user.id, actorName: req.user.name, action: 'Employee Global Export refused', entity: 'Employee',
        field: 'export', toValue: JSON.stringify({ refused: stripped.map((f) => f.key) }),
      });
      return res.status(403).json({
        error: `You may not export ${stripped.map((f) => f.label).join(', ')}.`,
        stripped: stripped.map((f) => f.key),
      });
    }
    return res.status(400).json({ error: 'Pick at least one field to export.', unknown });
  }
  const filters = cleanExportFilters(b.filters || {});
  const needSalary = allowed.some((f) => f.salary);
  const needDocs = wantFiles || allowed.some((f) => f.documents);
  const [employees, seats] = await Promise.all([
    prisma.employee.findMany({
      where: withoutSystemAccounts(departmentWhere(req)),
      include: {
        user: { select: { role: true, status: true } },
        reportingManager: { select: { name: true } },
        ...(needSalary ? { salaryStructure: true } : {}),
      },
      orderBy: { name: 'asc' },
    }),
    seatTimelines(),
  ]);
  const matched = employees.filter((e) => matchesListFilters(e, filters, seats.get(e.id)));

  // Documents of EXACTLY the matched employees. docsOf() (what is on file)
  // feeds the per-employee columns; copiesOf() — the Documents sheet rows and
  // the ZIP files — also drops any Aadhaar / PAN copy this caller may not
  // take under the registry's stricter rule.
  const docsByEmp = new Map();
  let uploaderName = new Map();
  if (needDocs && matched.length) {
    const docs = await prisma.employeeDocument.findMany({
      where: { employeeId: { in: matched.map((e) => e.id) } },
      select: {
        id: true, employeeId: true, docType: true, docName: true, fileName: true, mime: true,
        size: true, uploadedBy: true, uploadedAt: true, file: wantFiles,
      },
      orderBy: { uploadedAt: 'asc' },
    });
    const typeOrder = (t) => { const i = DOC_TYPES.indexOf(t); return i < 0 ? DOC_TYPES.length : i; };
    docs.sort((x, y) => typeOrder(x.docType) - typeOrder(y.docType) || new Date(x.uploadedAt) - new Date(y.uploadedAt));
    docs.forEach((d) => { if (!docsByEmp.has(d.employeeId)) docsByEmp.set(d.employeeId, []); docsByEmp.get(d.employeeId).push(d); });
    const ids = [...new Set(docs.map((d) => d.uploadedBy).filter(Boolean))];
    if (ids.length) {
      const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
      uploaderName = new Map(users.map((u) => [u.id, u.name]));
    }
  }
  const docsOf = (e) => docsByEmp.get(e.id) || [];
  const copiesOf = (e) => docsOf(e).filter((d) => exportFields.mayExportDocumentType(req.user, d.docType));

  const ctx = { hrStatusOf: hrStatusOfExport, seat: (e) => seatSummary(seats.get(e.id)), docsOf };
  const headers = allowed.map((f) => f.label);
  const rows = matched.map((e) => allowed.map((f) => {
    const v = f.get(e, ctx);
    return v === null || v === undefined ? '' : v;
  }));
  const label = scopeLabel(req);
  const stamp = new Date().toISOString().slice(0, 10);
  const baseName = `employees-global-export-${stamp}`;
  const filterText = Object.entries(filters).map(([k, v]) => `${k}=${v}`).join(', ') || 'none';

  // The spreadsheet itself, in the chosen format.
  const buildSheet = () => {
    if (format === 'csv') return Buffer.from(`﻿${toCsv(headers, rows)}`, 'utf8');
    if (format === 'pdf') {
      return toPdf(headers, rows, {
        title: 'Employee Export',
        subtitle: `${rows.length} employee(s) · scope: ${label} · filters: ${filterText} · exported ${new Date().toLocaleString('en-GB')} by ${req.user.name || 'user'}`,
      });
    }
    if (!needDocs) return toXlsx(headers, rows, 'Employees');
    const docRows = [];
    matched.forEach((e) => copiesOf(e).forEach((d) => docRows.push([
      e.employeeCode || '', e.name || '', e.department || '', d.docType,
      exportFields.exportedDocName(d.docType, d.docName), exportFields.exportedDocName(d.docType, d.fileName),
      (attachments.ALLOWED[d.mime] || d.mime || '').toUpperCase(),
      d.size ? (d.size / 1024).toFixed(1) : '',
      d.uploadedBy ? (uploaderName.get(d.uploadedBy) || 'Unknown user') : '',
      exportTs(d.uploadedAt),
    ])));
    return toXlsxBook([
      { name: 'Employees', headers, rows },
      { name: 'Documents', headers: DOCUMENTS_SHEET_HEADERS, rows: docRows },
    ]);
  };

  res.setHeader('X-Export-Rows', String(rows.length));
  res.setHeader('X-Export-Stripped', stripped.map((f) => f.key).join(','));

  if (wantFiles) {
    // Plan every entry first: the cap is checked BEFORE a byte is sent.
    const entries = [];
    const missing = [];
    let totalBytes = 0;
    let sensitiveFiles = 0;
    matched.forEach((e) => {
      const folder = zipSafe(`${e.employeeCode || 'NO-ID'} - ${e.name || ''}`);
      const usedNames = new Set();
      copiesOf(e).forEach((d) => {
        const full = attachments.resolveStored(d.file);
        if (!full) { missing.push(`${folder}: ${d.docType}`); return; }
        const first = zipSafe(`${d.docType} - ${exportFields.exportedDocName(d.docType, d.fileName) || 'file'}`);
        const dot = first.lastIndexOf('.');
        const stem = dot > 0 ? first.slice(0, dot) : first;
        const ext = dot > 0 ? first.slice(dot) : '';
        let name = first;
        for (let n = 2; usedNames.has(name.toLowerCase()); n += 1) name = `${stem} (${n})${ext}`;
        usedNames.add(name.toLowerCase());
        const size = zipFs.statSync(full).size;
        totalBytes += size;
        if (exportFields.SENSITIVE_DOCUMENTS.types.includes(d.docType)) sensitiveFiles += 1;
        entries.push({ full, name: `${folder}/${name}` });
      });
    });
    const lim = exportFields.DOCUMENT_ZIP_LIMITS;
    if (entries.length > lim.maxFiles || totalBytes > lim.maxBytes) {
      const mb = (n) => (n / (1024 * 1024)).toFixed(1);
      return res.status(413).json({
        error: `That export would pack ${entries.length.toLocaleString('en-IN')} file(s), ${mb(totalBytes)} MB — `
          + `more than the ${lim.maxFiles.toLocaleString('en-IN')} files / ${mb(lim.maxBytes)} MB a single ZIP may hold. `
          + 'Narrow the filters (department, status, joining dates) and export in parts, or export without the files.',
        files: entries.length,
        bytes: totalBytes,
      });
    }
    const sheetBuf = buildSheet();
    await notifyDataIo(req, { kind: 'export', module: 'Employee Management', count: rows.length, what: 'employee records (with document files)', format, detail: `global export ZIP · ${entries.length} file(s) · scope: ${label}` });
    await logAudit({
      userId: req.user.id,
      actorName: req.user.name,
      action: `Employee Global Export (ZIP with documents, ${format.toUpperCase()})`,
      entity: 'Employee',
      field: 'export',
      fieldLabel: `${rows.length} row(s), ${entries.length} file(s), ${(totalBytes / 1024).toFixed(1)} KB`,
      toValue: JSON.stringify({
        rows: rows.length, format, zip: true, files: entries.length, totalBytes, sensitiveFiles,
        missingFiles: missing.length, scope: label, fields: allowed.map((f) => f.key), filters,
        stripped: stripped.map((f) => f.key),
      }),
    });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${baseName}.zip"`);
    res.setHeader('X-Export-Files', String(entries.length));
    res.setHeader('X-Export-Bytes', String(totalBytes));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Export-Rows, X-Export-Stripped, X-Export-Files, X-Export-Bytes');
    const archiver = require('archiver');
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('warning', (err) => console.warn('[global-export zip]', err.message));
    archive.on('error', (err) => { console.error('[global-export zip]', err); res.destroy(err); });
    res.on('close', () => { if (!res.writableFinished) archive.abort(); });
    archive.pipe(res);
    archive.append(sheetBuf, { name: `${baseName}.${format}` });
    // Images and PDFs are already compressed: stored as-is, read from disk
    // one at a time as the stream drains.
    entries.forEach((en) => archive.file(en.full, { name: en.name, store: true }));
    if (missing.length) {
      archive.append(`These documents are recorded but their files are no longer on the server:\r\n${missing.join('\r\n')}\r\n`, { name: 'MISSING FILES.txt' });
    }
    await archive.finalize();
    return undefined;
  }

  await notifyDataIo(req, { kind: 'export', module: 'Employee Management', count: rows.length, what: 'employee records', format, detail: `global export · fields: ${allowed.map((f) => f.key).join(', ')} · scope: ${label}` });
  await logAudit({
    userId: req.user.id,
    actorName: req.user.name,
    action: `Employee Global Export (${format.toUpperCase()})`,
    entity: 'Employee',
    field: 'export',
    fieldLabel: `${rows.length} row(s)`,
    toValue: JSON.stringify({
      rows: rows.length, format, scope: label, fields: allowed.map((f) => f.key), filters,
      stripped: stripped.map((f) => f.key),
    }),
  });
  res.setHeader('Content-Disposition', `attachment; filename="${baseName}.${format}"`);
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Export-Rows, X-Export-Stripped');
  if (format === 'csv') res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  else if (format === 'xlsx') res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  else res.setHeader('Content-Type', 'application/pdf');
  return res.send(buildSheet());
});

// ONE EMPLOYEE'S FULL RECORD, AS EXCEL — the row action on Employee
// Management. Sheet 1 is the record, section by section; sheet 2 every
// position held with the handover; sheet 3 the documents on file. Aadhaar
// goes out as its last four digits only, and nothing internal (OTP hashes,
// pending-change drafts) is included.
router.get('/:id/export.xlsx', requirePerm(null, 'hrms', 'Employee Management', 'export'), async (req, res) => {
  const e = await prisma.employee.findUnique({
    where: { id: req.params.id },
    include: {
      reportingManager: { select: { name: true } },
      user: { select: { status: true } },
      documents: { select: { docType: true, docName: true, fileName: true, uploadedBy: true, uploadedAt: true }, orderBy: { uploadedAt: 'desc' } },
    },
  });
  if (!e) return res.status(404).json({ error: 'Employee not found' });
  if (!(await assertInScope(req, e))) return res.status(403).json({ error: 'This record is outside your department scope' });
  const XLSX = require('xlsx');
  const c = withComputed(e);
  const d = (v) => (v ? new Date(v).toISOString().slice(0, 10) : '');
  const aadhaar = e.aadhaarLast4 || (e.aadhaarNumber ? String(e.aadhaarNumber).slice(-4) : '');
  const sections = [
    ['Employment', [
      ['Employee ID', e.employeeCode], ['Name', e.name], ['Department', e.department], ['Team', e.team],
      ['Designation', e.designation], ['Reporting Manager', e.reportingManager && e.reportingManager.name], ['TL', e.tl], ['STL', e.stl],
      ['Employment Status', e.employmentStatus], ['Employment Type', e.employeeType], ['Date of Joining', d(e.dateOfJoining)],
      ['Location', e.location], ['Branch', e.branch], ['Shift', e.shift], ['Experience', e.employmentExperience],
      ['Skills', e.skills], ['Education', e.educationDetails],
    ]],
    ['Contact', [
      ['Email', e.email], ['Mobile', e.phone], ['Mobile Verified', e.mobileVerified],
      ['Emergency Contact', e.emergencyContactName], ['Emergency Phone', e.emergencyContactPhone],
      ['Emergency Relation', e.emergencyContactRelation],
    ]],
    ['Personal', [
      ['Date of Birth', d(e.dateOfBirth)], ['Gender', e.gender], ['Blood Group', e.bloodGroup],
    ]],
    ['Address', [
      ['Address Type', e.addressType], ['Line 1', e.addressLine1 || e.address], ['Line 2', e.addressLine2],
      ['City', e.city], ['District', e.district], ['State', e.state], ['Country', e.country], ['PIN Code', e.postalCode],
    ]],
    ['Bank & Statutory', [
      ['Bank Name', e.bankName], ['Account Number', e.bankAccountNumber], ['IFSC', e.ifscCode],
      ['PAN', e.panNumber], ['Aadhaar (last 4)', aadhaar ? `XXXX XXXX ${aadhaar}` : ''],
      ['UAN', e.uanNumber], ['PF Number', e.pfNumber], ['ESI Number', e.esiNumber],
    ]],
    ['Profile', [
      ['Profile Status', c.profileStatus], ['Profile Completion %', c.profileCompletionPct],
      ['Locked', e.isLocked ? 'Yes' : 'No'], ['Login', e.user ? (e.user.status || 'Active') : 'No login'],
      ['Sign-in Email', e.credentialsSentStatus], ['Record Created', d(e.createdAt)], ['Last Updated', d(e.updatedAt)],
    ]],
  ];
  const profile = [['Section', 'Field', 'Value']];
  sections.forEach(([name, fields]) => fields.forEach(([k, v], i) => profile.push([i === 0 ? name : '', k, v == null ? '' : v])));
  const seats = (await seatTimelines()).get(e.id) || [];
  const positions = [['Position', 'Name', 'Department', 'From', 'To', 'Took Over From', 'Handed To', 'Handed Over On']]
    .concat(seats.map((t) => [t.code, t.name || '', t.department || '', t.from, t.current ? 'Present' : t.to,
      t.tookOverFrom ? t.tookOverFrom.name : '', t.handedTo ? t.handedTo.name : '', t.handedTo ? t.handedTo.from : '']));
  const docs = [['Document Type', 'Document', 'File', 'Uploaded By', 'Uploaded On']]
    .concat((e.documents || []).map((x) => [x.docType, x.docName || '', x.fileName || '', x.uploadedBy || '', d(x.uploadedAt)]));
  const wb = XLSX.utils.book_new();
  const sheet = (aoa, widths) => { const ws = XLSX.utils.aoa_to_sheet(aoa); ws['!cols'] = widths.map((w) => ({ wch: w })); return ws; };
  XLSX.utils.book_append_sheet(wb, sheet(profile, [18, 24, 44]), 'Employee');
  XLSX.utils.book_append_sheet(wb, sheet(positions, [12, 20, 14, 12, 12, 24, 24, 16]), 'Positions');
  XLSX.utils.book_append_sheet(wb, sheet(docs, [20, 28, 30, 20, 14]), 'Documents');
  await notifyDataIo(req, { kind: 'export', module: 'Employee Management', count: 1, what: `employee record (${e.employeeCode} ${e.name})`, format: 'xlsx' });
  await logAudit({
    userId: req.user.id, actorName: req.user.name, action: 'Employee record exported (XLSX)',
    entity: 'Employee', entityId: e.id, toValue: e.employeeCode,
  });
  const filename = `${e.employeeCode}-${e.name}`.replace(/[^\w-]+/g, '_') + '.xlsx';
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  return res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
});

/* ==========================================================================
   EMPLOYEE MANAGEMENT — the administration surface for employee accounts.

   MOVED HERE from routes/admin.js. It used to sit behind
   `administration / Users`, which is Super Admin + Admin only, so a TL who
   opened Employee Management got a 403 for the list and saw nothing but the
   review queue. Every route below is guarded by
   `hrms / Employee Management / <action>` — the same feature the screen's nav
   entry asks for — and every list and record is held to the caller's data
   scope by departmentWhere() / assertInScope(), so a TL now gets THEIR
   employees rather than an error.

   These routes are registered BEFORE `/:id` below, so `/management` is never
   swallowed by the employee-detail route.

   ONE EMPLOYEE = ONE USER = ONE LOGIN. There is exactly one Add Employee in
   the app (POST /management) and exactly one Edit Scope
   (PUT /management/:id/scope); Administration → Users links here rather than
   carrying a second copy.
   ========================================================================== */

// Which departments this caller may create into / act on.
function assertDepartmentAllowed(req, department) {
  const allowed = scopeDepartments(req);
  if (allowed === undefined) return { ok: true, department };
  if (!department) return { ok: true, department: allowed[0] };
  if (!allowed.includes(department)) {
    return { ok: false, error: `${department} is outside your department scope (${allowed.join(', ')}).` };
  }
  return { ok: true, department };
}

// THE HANDOVER, PER PERSON. Every seat somebody has held, oldest first, with
// who sat in it before them and who took it after:
//
//   Keerthana   MED-2  Jan 2026 – Apr 2026   took over from Niveditha, handed to Renuka A
//               MED-TL Apr 2026 – today      took over from Sannidhi
//
// Built from PositionAssignment in one read, so the Employee Management list
// can say where a person sits — and a former employee where they sat and who
// replaced them — without a request per row.
async function seatTimelines() {
  const rows = await prisma.positionAssignment.findMany({
    select: {
      employeeId: true, fromDate: true, toDate: true,
      position: { select: { id: true, code: true, name: true, department: true } },
      employee: { select: { name: true } },
    },
    orderBy: { fromDate: 'asc' },
  });
  const bySeat = new Map();
  rows.forEach((r) => {
    // Opened and closed the same day: never really held, so not a handover.
    if (r.toDate && r.toDate <= r.fromDate) return;
    if (!bySeat.has(r.position.id)) bySeat.set(r.position.id, []);
    bySeat.get(r.position.id).push(r);
  });
  const byEmployee = new Map();
  bySeat.forEach((list) => list.forEach((r, i) => {
    const prev = list[i - 1];
    const next = list[i + 1];
    const t = {
      code: r.position.code, name: r.position.name || null, department: r.position.department || null,
      from: r.fromDate, to: r.toDate || null, current: !r.toDate,
      tookOverFrom: prev && prev.employeeId !== r.employeeId ? { name: prev.employee.name, to: prev.toDate } : null,
      handedTo: next && next.employeeId !== r.employeeId ? { name: next.employee.name, from: next.fromDate } : null,
    };
    if (!byEmployee.has(r.employeeId)) byEmployee.set(r.employeeId, []);
    byEmployee.get(r.employeeId).push(t);
  }));
  byEmployee.forEach((list) => list.sort((a, b) => a.from.localeCompare(b.from)));
  return byEmployee;
}
// The seat the list shows: the one held now, else the last one held.
function seatSummary(list) {
  if (!list || !list.length) return null;
  return list.find((t) => t.current) || list[list.length - 1];
}

router.get('/management', requirePerm(null, 'hrms', 'Employee Management', 'view'), async (req, res) => {
  const where = departmentWhere(req);
  if (req.query.employmentStatus) where.employmentStatus = req.query.employmentStatus;
  if (scopeDepartments(req) === undefined && req.query.department) where.department = req.query.department;
  const [employees, seats, provedEmails] = await Promise.all([
    prisma.employee.findMany({ where: withoutSystemAccounts(where), include: EMP_MGMT_INCLUDE, orderBy: { name: 'asc' } }),
    seatTimelines(),
    emailVerify.verifiedSet(),
  ]);
  // Photo id, document count and last working date — three reads for the
  // whole list, never one per row.
  const extras = await employeeListExtras(employees.map((e) => e.id));
  const canEdit = await can(req.user, 'hrms', 'hrms', 'Employee Management', 'edit');
  res.json({
    scope: scopeLabel(req),
    // What this caller may actually do, so the screen offers exactly that and
    // the API is still the thing that refuses.
    caps: {
      create: await can(req.user, 'hrms', 'hrms', 'Employee Management', 'create'),
      edit: await can(req.user, 'hrms', 'hrms', 'Employee Management', 'edit'),
      export: await can(req.user, 'hrms', 'hrms', 'Employee Management', 'export'),
      // Edit Scope is `assign` — Super Admin / Admin, per the matrix. A TL may
      // see the Scope column without being able to widen anyone's reach.
      assign: await can(req.user, 'hrms', 'hrms', 'Employee Management', 'assign'),
      approve: await can(req.user, 'hrms', 'hrms', 'Employee Management', 'approve'),
      configure: await can(req.user, 'hrms', 'hrms', 'Employee Management', 'configure'),
      delete: await can(req.user, 'hrms', 'hrms', 'Employee Management', 'delete'),
      // Reset Password / Send Password Reset — the HR desk (hrms-24 §12).
      passwords: await mayManagePasswords(req.user),
      // Change Employee ID — Super Admin / Admin / HR (see mayEditCode).
      editCode: await mayEditCode(req.user),
      // Manager / Assistant Manager: every department, nothing changed.
      viewOnly: isViewOnlyAdmin(req.user) && !canEdit,
      // Setting a notice-period employee's last working date is an edit.
      lastWorkingDate: canEdit,
    },
    rows: employees.map((e) => ({
      ...shapeEmployeeMgmtRow(e),
      ...(extras.get(e.id) || { photoDocId: null, docCount: 0, lastWorkingDate: null, lastWorkingDateSource: null }),
      seat: seatSummary(seats.get(e.id)),
      // Every seat they ever held — the Positions filter lists past holders too.
      seats: seats.get(e.id) || [],
      seatCount: (seats.get(e.id) || []).length,
      emailVerified: !!(e.email && provedEmails.has(normalEmail(e.email))),
    })),
  });
});

// TL-WISE — the same scoped list grouped by team lead (utils/employeeAdmin.js
// tlWiseGroups). The screen's filters run in the browser, so it posts the ids
// it is counting; like the list export they only narrow the scoped query,
// never widen it. Without ids it is the caller's whole scope.
async function tlWiseFor(req) {
  const where = departmentWhere(req);
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(String) : null;
  const scoped = ids ? { AND: [where, { id: { in: ids } }] } : where;
  const [members, directory] = await Promise.all([
    prisma.employee.findMany({
      where: withoutSystemAccounts(scoped),
      include: { user: { select: { status: true } }, reportingManager: { select: { name: true } } },
      orderBy: { name: 'asc' },
    }),
    prisma.employee.findMany({
      where: withoutSystemAccounts(departmentWhere(req)),
      select: { name: true, employeeCode: true, designation: true, department: true },
    }),
  ]);
  return { scope: scopeLabel(req), ...tlWiseGroups(members, directory) };
}
router.post('/management/tl-wise', requirePerm(null, 'hrms', 'Employee Management', 'view'), async (req, res) => {
  res.json(await tlWiseFor(req));
});
router.post('/management/tl-wise.xlsx', requirePerm(null, 'hrms', 'Employee Management', 'export'), async (req, res) => {
  const data = await tlWiseFor(req);
  const t = data.totals;
  const summary = data.groups.map((g) => [
    g.tl, g.tlEmployeeCode || '', g.tlDesignation || '', g.department || '', g.teamSize, g.active, g.notice, g.relieved, g.other,
  ]);
  summary.push(['TOTAL', `${t.teams} TL(s)`, '', '', t.teamSize, t.active, t.notice, t.relieved, t.other]);
  const members = data.groups.flatMap((g) => g.members.map((m) => [
    g.tl, m.employeeCode, m.name, m.designation || '', m.department || '', m.employmentStatus, m.hrStatus, m.dateOfJoining || '',
  ]));
  await notifyDataIo(req, { kind: 'export', module: 'Employee Management', count: t.teamSize, what: 'employee records (TL-wise summary)', format: 'xlsx' });
  await logAudit({
    userId: req.user.id, actorName: req.user.name, action: 'Employee TL-wise summary exported (XLSX)', entity: 'Employee',
    toValue: `${t.teamSize} employee(s) in ${data.groups.length} group(s), scope: ${data.scope}`,
  });
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="employees-tl-wise-${stamp}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(toXlsxBook([
    { name: 'TL-wise summary', headers: ['TL', 'TL Employee ID', 'TL Designation', 'Department', 'Team size', 'Active', 'Notice Period', 'Relieved', 'Other'], rows: summary },
    { name: 'Members', headers: ['TL', 'Employee ID', 'Name', 'Designation', 'Department', 'Employment Status', 'HR Status', 'Date of Joining'], rows: members },
  ]));
});

// Every option list the Add Employee modal, the filter row and the Edit Scope
// editor render — one call, so the screen never has to reach into
// /api/admin/* for a lookup it is no longer allowed to make.
// WHICH DESIGNATIONS ADD EMPLOYEE MAY OFFER.
//
// "add employee lo employee matram dropdown undali" — it was offering Super
// Admin, Admin and Manager, so anybody who could add a person could mint a
// Super Admin from the joining form. That is not an onboarding decision.
//
// EMPLOYEE IS THE BASE IDENTITY. A new joiner is created as one, with HRMS
// self-service. The ATS or Accounts role that makes them a Recruiter, a BDE
// or a TL is ADDED to that SAME login afterwards on Administration -> Users,
// which is the screen that owns roles — one employee, one login, roles
// layered on, never a second account.
//
// Super Admin and Admin keep the full list, because seeding an organisation
// from scratch has to be possible. Everybody else gets the HRMS-only base
// identities.
// THE PICKER NAMES THE WHOLE IDENTITY: "Employee + Recruiter".
//
// A designation grants a role in each product at once, and the picker used to
// print only its own name — "Recruiter" — which reads as though it replaced
// being an employee. It does not. A recruiter is an EMPLOYEE in HRMS who also
// works ATS, on ONE login, and the label now says exactly that so nobody
// imagines a second account is involved.
//
// Built from the roles the designation actually derives, so the label cannot
// drift from what creating it will do.
function designationLabel(row) {
  const derived = productRolesForDesignation(row);
  const NONE = 'NONE';
  const roles = [];
  const seen = new Set();
  [derived.hrmsRole, derived.atsRole, derived.accountsRole].forEach((r) => {
    if (!r || r === NONE || seen.has(r)) return;
    seen.add(r);
    roles.push(atsRoleLabel(r));
  });
  const access = roles.join(' + ');
  const products = [row.hrms && 'HRMS', row.ats && 'ATS', row.accounts && 'Accounts'].filter(Boolean);
  return {
    // THE JOB TITLE STAYS. Three different designations derive plain
    // EMPLOYEE, so a label of just "Employee" appeared three times and the
    // picker could not be read. The access is appended only when it says
    // something the title does not — "Recruiter" becomes "Recruiter —
    // Employee + Recruiter", while "Employee" is left alone.
    label: access && access !== row.designation ? `${row.designation} — ${access}` : row.designation,
    accessLabel: access,
    productsLabel: products.join(' + '),
  };
}

// WHICH DESIGNATIONS ADD EMPLOYEE MAY OFFER.
//
// Creating somebody as "Employee + Recruiter" is ordinary onboarding — that
// is the combined identity this product is built around, and HR does it every
// week. Creating a SUPER ADMIN is not: it hands over the whole company, and
// it used to be available from the joining form to anybody who could add a
// person.
//
// So the line is drawn at PRIVILEGE, not at products: the working identities
// are open, the ones that govern other people are Super Admin / Admin only.
const PRIVILEGED_DESIGNATION_ROLES = ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'HR'];
function addEmployeeDesignations(req, rows) {
  const s = scopeOf(req.user);
  if (s.global || ['SUPER_ADMIN', 'ADMIN'].includes(s.role)) return rows;
  return rows.filter((r) => {
    const derived = productRolesForDesignation(r);
    return ![derived.hrmsRole, derived.atsRole, derived.accountsRole]
      .some((role) => PRIVILEGED_DESIGNATION_ROLES.includes(role));
  });
}

router.get('/management/options', requirePerm(null, 'hrms', 'Employee Management', 'view'), async (req, res) => {
  const [employees, departments, rows, nextEmployeeCode, cfg, clients, positions, seatHolders] = await Promise.all([
    prisma.employee.findMany({
      where: departmentWhere(req),
      select: { id: true, name: true, department: true, location: true },
      orderBy: { name: 'asc' },
    }),
    // The department tree and the client list are OPTION LISTS too, and they
    // were company-wide: a Medical TL opening Add Employee was offered all
    // nine departments in the Edit Scope checklist and all four clients.
    // Both are now held to the caller's own scope.
    prisma.department.findMany({
      where: scopeDepartments(req) === undefined ? {} : { name: { in: scopeDepartments(req) } },
      include: { teams: true },
      orderBy: { name: 'asc' },
    }),
    designationRows(),
    // The next TL<nnn> (utils/employeeCode.js) — TL516 on file gives TL517.
    employeeCodes.nextEmployeeCode(),
    mailer.emailConfig(),
    prisma.client.findMany({ where: clientWhere(req.user), select: { id: true, name: true }, orderBy: { name: 'asc' } }).catch(() => []),
    // THE SEATS. Held to the caller's departments like everything else here.
    prisma.position.findMany({
      where: {
        active: true,
        ...(scopeDepartments(req) === undefined ? {} : { department: { in: scopeDepartments(req) } }),
      },
      orderBy: [{ department: 'asc' }, { code: 'asc' }],
    }),
    // Who is sitting in one right now. An open-ended assignment IS the
    // current tenure, so this is the whole occupancy picture in one query
    // rather than one per seat.
    prisma.positionAssignment.findMany({
      where: { toDate: null },
      select: { positionId: true, employee: { select: { name: true } } },
    }),
  ]);
  // The department and location pickers are CREATABLE (both columns are plain
  // strings by design), so a value typed into Add Employee is not in the
  // Department master table. Union the master list with the values on file.
  const inUse = (key) => employees.map((e) => e[key]).filter(Boolean);
  const union = (base, used) => [...new Set([...base, ...used])].sort((a, b) => a.localeCompare(b));
  const masterDepts = departments.length ? departments.map((d) => d.name) : DEPTS;
  const allowed = scopeDepartments(req);


  // A seat the form may offer, with its current holder if it has one. The
  // picker needs to SAY a seat is taken rather than silently omit it — a
  // missing MED-3 reads as "no such seat", which is a different fact.
  const heldBy = new Map(seatHolders.map((a) => [a.positionId, a.employee ? a.employee.name : null]));

  res.json({
    nextEmployeeCode,
    // Seats, for the Position picker on Add Employee. Grouped by the form.
    positions: positions.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name || null,
      department: r.department || null,
      team: r.team || null,
      holder: heldBy.has(r.id) ? (heldBy.get(r.id) || 'somebody') : null,
    })),
    scope: scopeLabel(req),
    empTypes: EMP_TYPES,
    empStatuses: EMP_STATUSES,
    genders: EMP_GENDERS,
    statusFilter: HR_STATUSES,
    // A department-scoped caller is offered only the departments they hold —
    // the same list assertDepartmentAllowed() then enforces on the write.
    departments: allowed === undefined
      ? union(masterDepts, inUse('department'))
      : allowed,
    // Departments with their teams, for the Edit Scope checklists.
    departmentTree: departments.map((d) => ({
      id: d.id, name: d.name, teams: (d.teams || []).map((t) => ({ id: t.id, name: t.name })),
    })),
    clients,
    locations: union(LOCS, inUse('location')),
    managerNames: [...new Set(employees.map((e) => e.name))],
    reportingManagers: employees.map((e) => ({ id: e.id, name: e.name })),
    // ROLES ARE DATA (utils/roleRegistry.js): active system + custom roles.
    // `roles` stays a list of codes for the readers that expect one;
    // `roleCatalog` is the Add Employee Role dropdown — only the roles this
    // caller may hand out, never an external (Client / Candidate) kind.
    roles: (await listRoles({ activeOnly: true })).map((r) => r.code).filter((c) => CATALOG_ROLES.includes(c) || c.startsWith('CUSTOM_')),
    roleCatalog: (await listRoles({ activeOnly: true }))
      .filter((r) => !r.external)
      .filter((r) => scopeOf(req.user).global || ['SUPER_ADMIN', 'ADMIN'].includes(scopeOf(req.user).role) || !isPrivilegedRole(r))
      .map((r) => ({
        code: r.code, name: r.name, isSystem: r.isSystem, scopeLevel: r.scopeLevel, description: r.description, products: r.products,
      })),
    // Straight off the DesignationRole table — this is the Role / Designation
    // picker, and each row says what that designation will actually grant.
    designations: addEmployeeDesignations(req, rows).map((r) => ({
      // "Employee + Recruiter" — the whole identity, not half of it.
      ...designationLabel(r),
      designation: r.designation,
      atsRole: r.atsRole || null,
      // What this designation grants in each product — the picker says it
      // outright rather than leaving the reader to infer it from a tick.
      productRoles: productRolesForDesignation(r),
      products: { hrms: !!r.hrms, ats: !!r.ats, accounts: !!r.accounts },
      landing: r.landing || null,
    })),
    designationRoles: rows,
    productAccess: await defaultProductAccessByRole(),
    email: { configured: cfg.configured, reason: cfg.configured ? null : cfg.reason },
    // The Documents section of Add Employee (no employee yet, so it cannot ask
    // GET /:id/documents). The upload itself goes through that route after the
    // employee is created, under its usual rules.
    documents: {
      docTypes: DOC_TYPES,
      requiredTypes: REQUIRED_DOC_TYPES,
      maxBytes: attachments.MAX_BYTES,
      allowedTypes: Object.keys(attachments.ALLOWED),
    },
  });
});

// THE NEXT EMPLOYEE ID — what Add Employee pre-fills. The server still
// allocates (and re-checks) it on create, so two people adding at once cannot
// both get it.
async function sendNextCode(req, res) {
  res.json({ nextEmployeeCode: await employeeCodes.nextEmployeeCode() });
}
router.get('/next-code', requirePerm(null, 'hrms', 'Employee Management', 'create'), sendNextCode);
router.get('/management/next-code', requirePerm(null, 'hrms', 'Employee Management', 'create'), sendNextCode);

// --- The email one-time code that gates Add Employee -----------------------
router.post('/management/email-otp/send', requirePerm(null, 'hrms', 'Employee Management', 'create'), async (req, res) => {
  const email = normalEmail(req.body.email);
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'That email does not look right.' });
  const taken = await prisma.user.findUnique({ where: { email } });
  if (taken) return res.status(409).json({ error: 'That email already has a login.' });

  const cfg = await mailer.emailConfig();
  if (!cfg.configured) {
    // Recorded, not transmitted — the same vocabulary the mail worker uses.
    return res.json({
      configured: false,
      sent: false,
      reason: cfg.reason,
      message: `No email channel is configured, so no code was sent — ${cfg.reason} Set up Administration → Integrations → Email (SMTP) to verify an address. The employee can still be created without verification.`,
    });
  }

  // A fresh request retires every earlier code for this address.
  await prisma.emailVerification.updateMany({
    where: { email, purpose: OTP_PURPOSE, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);
  const row = await prisma.emailVerification.create({
    data: {
      email, purpose: OTP_PURPOSE, codeHash: hashOtp(email, code), expiresAt, requestedById: req.user.id,
    },
  });

  const sender = await senderIdentity(req.user).catch(() => ({}));
  const sent = await mailer.sendMail({
    to: email,
    subject: 'TeamLink — your verification code',
    text: [
      `Your TeamLink verification code is ${code}.`,
      '',
      `It expires in ${OTP_TTL_MINUTES} minutes and can be entered ${OTP_MAX_ATTEMPTS} times at most.`,
      '',
      `Requested by ${req.user.name} while creating your employee record.`,
      'If you were not expecting this, ignore this message — no account is created until the code is entered.',
    ].join('\n'),
    senderEmail: sender.email,
    senderName: sender.name,
  });

  if (!sent.ok) {
    await prisma.emailVerification.update({ where: { id: row.id }, data: { consumedAt: new Date() } });
    return res.status(502).json({
      configured: true, sent: false, error: `The provider did not accept it — ${sent.error}`,
    });
  }
  // The code itself is never logged.
  await logAudit({
    userId: req.user.id, action: 'Verification code sent', entity: 'EmailVerification', entityId: row.id, toValue: email,
  });
  res.json({
    configured: true, sent: true, expiresAt, attemptsAllowed: OTP_MAX_ATTEMPTS, ttlMinutes: OTP_TTL_MINUTES,
  });
});

router.post('/management/email-otp/verify', requirePerm(null, 'hrms', 'Employee Management', 'create'), async (req, res) => {
  const email = normalEmail(req.body.email);
  const code = String(req.body.code || '').trim();
  if (!code) return res.status(400).json({ error: 'Enter the code that was emailed.' });
  const row = await liveVerification(email);
  if (!row) return res.status(400).json({ error: 'No live code for that address — send one first.' });
  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'Too many attempts on that code — send a new one.' });
  }
  const attempts = row.attempts + 1;
  if (row.codeHash !== hashOtp(email, code)) {
    await prisma.emailVerification.update({ where: { id: row.id }, data: { attempts } });
    const left = OTP_MAX_ATTEMPTS - attempts;
    return res.status(400).json({
      error: left > 0 ? `That code is not right — ${left} attempt(s) left.` : 'That code is not right, and the attempts are used up. Send a new one.',
    });
  }
  await prisma.emailVerification.update({ where: { id: row.id }, data: { attempts, verifiedAt: new Date() } });
  res.json({ verified: true, email });
});

// --- ADD EMPLOYEE — the one and only implementation ------------------------
//
// The employee record, the User and the login are created together. Department
// + Role/Designation are what everything else is DERIVED from:
// utils/identity.js mappingFor() reads the DesignationRole TABLE (never a
// hard-coded list) for the ATS role, the product access and the landing
// workspace, and the department becomes the login's data scope. No compound
// role such as "Medical Recruiter" is ever stored.
router.post('/management', requirePerm(null, 'hrms', 'Employee Management', 'create'), async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const email = normalEmail(b.email);
  let designation = String(b.designation || '').trim();
  // Add Employee no longer asks for a designation (user, 2026-09-29). It is
  // taken from the chosen Role when the master has a matching designation
  // (TL → TL, HR → HR, Accountant → Accountant …), otherwise "Employee"; the
  // Role itself still sets the product roles. HR can change it later on Edit.
  if (!designation) {
    const code = String(b.roleCode || '').trim().toUpperCase();
    const rows = await designationRows();
    const match = code && rows.find((r) => (r.atsRole && r.atsRole === code)
      || r.designation.toUpperCase().replace(/\s+/g, '_') === code);
    designation = match ? match.designation : 'Employee';
  }
  const phone = b.phone ? String(b.phone).trim() : '';
  const wantedCode = String(b.employeeId || b.employeeCode || '').trim();
  const password = String(b.password || '');

  if (!name) return res.status(400).json({ error: 'Enter the full name.' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'That email does not look right.' });
  if (!String(b.department || '').trim()) return res.status(400).json({ error: 'Select a department.' });
  if (!designation) return res.status(400).json({ error: 'Select a role / designation.' });
  // ENFORCED, NOT JUST HIDDEN. Narrowing the dropdown is a convenience; this
  // is the rule. Without it anyone who may add an employee could still POST
  // designation "Super Admin" and mint one, because the picker is the only
  // thing that was stopping them.
  {
    const allowed = addEmployeeDesignations(req, await designationRows());
    if (!allowed.some((r) => r.designation === designation)) {
      return res.status(403).json({
        error: `You can create a new joiner as ${allowed.map((r) => r.designation).join(', ')}. `
          + 'Roles beyond that are granted on Administration → Users after the record exists.',
      });
    }
  }
  if (phone && !/^\d{10}$/.test(phone.replace(/\s/g, ''))) {
    return res.status(400).json({ error: 'Mobile should be 10 digits.' });
  }
  if (password && password.length < 6) {
    return res.status(400).json({ error: 'A login password must be at least 6 characters — or leave it empty for a set-password link.' });
  }
  if (b.role && !ALL_ROLES.includes(b.role)) return res.status(400).json({ error: 'Unknown role' });
  // THE ROLE DROPDOWN (roles as data). Optional; when given it must be an
  // ACTIVE, internal role, and a privileged one only for a global caller.
  let chosenRole = null;
  if (b.roleCode) {
    chosenRole = await roleByCode(String(b.roleCode));
    if (!chosenRole || chosenRole.external) return res.status(400).json({ error: 'Unknown role' });
    if (!chosenRole.active) return res.status(400).json({ error: `The role "${chosenRole.name}" is inactive.` });
    const sc = scopeOf(req.user);
    if (isPrivilegedRole(chosenRole) && !(sc.global || ['SUPER_ADMIN', 'ADMIN'].includes(sc.role))) {
      return res.status(403).json({ error: `You cannot give a new joiner the role "${chosenRole.name}".` });
    }
  }

  const deptCheck = assertDepartmentAllowed(req, String(b.department).trim());
  if (!deptCheck.ok) return res.status(403).json({ error: deptCheck.error });
  const department = deptCheck.department;
  // THE DEPARTMENTS THEY WORK — Add Employee's checklist ("All departments",
  // or two for a TL, three for an STL). The first is their home department
  // (seat, team, employee record); ALL of them become the login's data scope.
  // Each is held to the creator's own scope, like the home department.
  const extraDepts = [...new Set((Array.isArray(b.departments) ? b.departments : String(b.departments || '').split(','))
    .map((d) => String(d).trim()).filter(Boolean))];
  for (const d of extraDepts) {
    const c = assertDepartmentAllowed(req, d);
    if (!c.ok) return res.status(403).json({ error: c.error });
  }
  const scopeDepts = [...new Set([department, ...extraDepts])].join(',');

  // THE SEAT (optional). MED-1, EDU BDE 2 — the desk, not the person.
  //
  // Checked HERE, before the login and the employee row exist, because a
  // seat clash discovered afterwards would leave a half-made employee behind
  // and somebody would have to clean it up by hand. The picker offers the
  // department's own seats and is creatable, exactly like Department itself,
  // so a company can add MED-6 the moment it needs one without going to
  // Administration first.
  const seatCode = String(b.position || '').trim();
  let seat = null;
  if (seatCode) {
    // Codes are unique and case matters to people, so a case-different
    // spelling must REUSE the seat rather than mint a second one beside it.
    const sameDept = await prisma.position.findMany({ where: { department } });
    seat = sameDept.find((r) => r.code.toUpperCase() === seatCode.toUpperCase()) || null;
    if (!seat) {
      // A code that exists in ANOTHER department is not free to take.
      const elsewhere = await prisma.position.findFirst({ where: { code: seatCode } });
      if (elsewhere) {
        return res.status(409).json({
          error: `Position ${elsewhere.code} already belongs to ${elsewhere.department || 'another department'}. Use a code that is free, or move that seat on Administration → Positions.`,
        });
      }
    } else if (!seat.active) {
      return res.status(409).json({ error: `Position ${seat.code} is retired. Reactivate it on Administration → Positions before assigning it.` });
    } else {
      // ONE PERSON PER SEAT AT A TIME. An open-ended assignment means
      // somebody is sitting in it right now.
      const held = await prisma.positionAssignment.findFirst({
        where: { positionId: seat.id, toDate: null },
        include: { employee: { select: { name: true, employeeCode: true } } },
      });
      if (held) {
        return res.status(409).json({
          error: `${seat.code} is currently held by ${held.employee ? held.employee.name : 'somebody'}`
            + `${held.employee && held.employee.employeeCode ? ` (${held.employee.employeeCode})` : ''}`
            + '. Vacate it on Administration → Positions first, or pick another seat.',
        });
      }
    }
  }

  if (await prisma.user.findUnique({ where: { email } })) {
    return res.status(409).json({ error: 'That email already has a login.' });
  }
  const dup = await prisma.employee.findFirst({
    where: { OR: [{ email }, ...(phone ? [{ phone }] : [])] },
  });
  if (dup) {
    return res.status(409).json({
      error: `${dup.name} (${dup.employeeCode}) already has that ${dup.email === email ? 'email' : 'mobile'}.`,
    });
  }

  // NO EMAIL GATE ON CREATE.
  //
  // This used to require the address to be proved by a one-time code before
  // the employee could be created, which meant HR typed an address, waited
  // for a code they could not see, and could not finish without it. HR asked
  // for the straight path: type the address and the password, press Create,
  // and the welcome mail goes out on its own.
  //
  // The address is still checked for SHAPE above, and still has to be unique
  // against every login and every employee. What is gone is the proof that
  // somebody is reading that mailbox — so a typo now means a welcome mail
  // that lands nowhere rather than a create that refuses. The send result is
  // reported back and written onto the employee record either way, which is
  // where HR sees that it did not arrive.
  const cfg = await mailer.emailConfig();
  // A code may still exist from an earlier flow; if it does it is consumed
  // below rather than left live.
  const verification = cfg.configured ? await liveVerification(email) : null;
  const emailProved = !!(verification && verification.verifiedAt);

  // Employee ID: the one typed (unique in ANY case), or the next TL<nnn> —
  // utils/employeeCode.js. An auto code that loses a race to a simultaneous
  // add is re-allocated below rather than failing the create.
  const autoCode = !wantedCode;
  if (wantedCode) {
    const fmt = employeeCodes.checkFormat(wantedCode);
    if (fmt.error) return res.status(400).json({ error: fmt.error });
    const holder = await employeeCodes.codeHolder(wantedCode);
    if (holder) {
      return res.status(409).json({ error: `Employee ID ${holder.employeeCode} is already taken by ${holder.name}.` });
    }
  }
  let employeeCode = wantedCode || await employeeCodes.nextEmployeeCode();

  // Role, product access and scope are DERIVED, never typed: designation ->
  // DesignationRole. An explicit `role` is honoured as an override, but the
  // products and the scope still come from the mapping and the department.
  const mapping = await mappingFor(designation);
  const role = b.role && ALL_ROLES.includes(b.role) ? b.role : loginRoleFor(mapping);
  const team = b.team ? String(b.team).trim() : null;

  const user = await prisma.user.create({
    data: {
      name,
      email,
      passwordHash: password ? await bcrypt.hash(password, 10) : await unguessablePasswordHash(),
      // HR typed a first password: its owner must change it (hrms-24 §12).
      ...(password ? passwordEventData('initial') : {}),
      role,
      username: email,
      status: 'Active',
      branch: b.location || 'Hyderabad',
      team,
      atsDepartment: department,
      // All three product roles, derived from the designation mapping.
      ...productRolesForDesignation(mapping),
      atsScopeDepartments: scopeDepts,
      atsScopeTeams: team,
      hrmsAccess: mapping ? !!mapping.hrms : true,
      atsAccess: mapping ? !!mapping.ats : false,
      accountsAccess: mapping ? !!mapping.accounts : false,
      landingWorkspace: (mapping && mapping.landing) || null,
      // The chosen Role fills the product role(s) it is for — its permissions
      // apply from the first request (utils/roleRegistry.js).
      ...loginPatchForRole(chosenRole),
    },
  });

  const employeeData = {
    name,
    email,
    phone: phone || null,
    department,
    designation,
    team,
    // Every employee is Hyderabad branch (user, 2026-09-29) unless HR says otherwise.
    location: b.location || 'Hyderabad',
    branch: b.branch || b.location || 'Hyderabad',
    stl: b.stl || null,
    tl: b.tl || null,
    reportingManagerId: b.reportingManagerId || null,
    gender: b.gender && b.gender !== '—' ? b.gender : null,
    employeeType: b.employeeType || null,
    employmentStatus: b.employmentStatus || 'Active',
    dateOfBirth: toDate(b.dateOfBirth),
    dateOfJoining: toDate(b.dateOfJoining),
    userId: user.id,
    onboardingTasks: JSON.stringify(DEFAULT_ONBOARDING_TASKS.map((task) => ({ task, completed: false }))),
  };
  let employee = null;
  for (let attempt = 0; !employee; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      employee = await prisma.employee.create({ data: { ...employeeData, employeeCode }, include: EMP_MGMT_INCLUDE });
    } catch (err) {
      if (autoCode && employeeCodes.isCodeClash(err) && attempt < 5) {
        // Somebody else took this code a moment ago: take the next one.
        // eslint-disable-next-line no-await-in-loop
        employeeCode = await employeeCodes.nextEmployeeCode(prisma, [employeeCode]);
      } else {
        // The login above was made for THIS create; it must not be left
        // behind as a login with no employee.
        // eslint-disable-next-line no-await-in-loop
        await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
        if (employeeCodes.isCodeClash(err)) {
          return res.status(409).json({ error: `Employee ID ${employeeCode} was taken a moment ago — try again.` });
        }
        throw err;
      }
    }
  }

  // The seat, now that there is somebody to put in it. Created on the fly
  // when the code is new — the validation above has already proved it is
  // free and does not belong to another department.
  if (seatCode) {
    if (!seat) {
      seat = await prisma.position.create({ data: { code: seatCode, department, team: team || null } });
      await logAudit({ userId: req.user.id, action: `Position ${seatCode} created`, entity: 'Position', entityId: seat.id });
    }
    await prisma.positionAssignment.create({
      data: { positionId: seat.id, employeeId: employee.id, fromDate: positionToday() },
    });
    await logAudit({
      userId: req.user.id,
      action: `${name} assigned to position ${seat.code}`,
      entity: 'Employee', entityId: employee.id, toValue: seat.code,
    });
  }

  if (verification) {
    await prisma.emailVerification.update({ where: { id: verification.id }, data: { consumedAt: new Date() } });
  }
  // The password is never echoed back and never logged.
  await logAudit({
    userId: req.user.id,
    action: `Employee and login created${emailProved ? ' (email verified by code)' : ' (email not verified — no code was required)'}`,
    entity: 'Employee',
    entityId: employee.id,
    toValue: `${employeeCode} · ${designation} · ${role} · scope ${department}`,
  });

  // Sign-in details: a single-use, expiring set-password link from the acting
  // HR user's own address. NEVER a password in a mail body. The result travels
  // back verbatim so the screen can say "not sent — no provider" rather than
  // implying the employee was told.
  // The password travels straight into the welcome mail and nowhere else.
  // Blank (the common case) means no password was set, and sendCredentials
  // sends the set-password link instead.
  const credentials = await sendCredentials({
    employee, userId: user.id, actingUser: req.user, req, password,
  });
  await logAudit({ userId: req.user.id, action: `Sign-in details: ${credentials.status}`, entity: 'Employee', entityId: employee.id });

  const fresh = await prisma.employee.findUnique({ where: { id: employee.id }, include: EMP_MGMT_INCLUDE });
  res.status(201).json({
    ...shapeEmployeeMgmtRow(fresh),
    credentials,
    login: {
      id: user.id, email: user.email, role: user.role, atsRole: user.atsRole,
      products: { hrms: user.hrmsAccess, ats: user.atsAccess, accounts: user.accountsAccess },
      scope: department,
    },
    emailVerified: emailProved,
    // Says what actually happened, not what the old gate assumed.
    emailChannel: emailProved
      ? 'verified by one-time code'
      : (cfg.configured
        ? 'not verified — the welcome mail was sent to the address as typed'
        : `not sent — no email channel is configured (${cfg.reason})`),
  });
});

// Create Login — attaches a login to an employee who has none. Never a second
// identity for someone who already has one.
router.post('/management/:id/create-login', requirePerm(null, 'hrms', 'Employee Management', 'edit'), async (req, res) => {
  const employee = await prisma.employee.findUnique({ where: { id: req.params.id }, include: { user: true } });
  if (!employee) return res.status(404).json({ error: 'Employee not found' });
  if (!(await assertInScope(req, employee))) return res.status(403).json({ error: 'This record is outside your department scope' });
  if (employee.userId) return res.status(409).json({ error: 'That employee already has a login' });
  if (!employee.email) return res.status(400).json({ error: 'That employee has no email address — add one before creating a login.' });
  const taken = await prisma.user.findUnique({ where: { email: employee.email } });
  if (taken) {
    // The login exists but was never linked: link it rather than duplicate it.
    await prisma.employee.update({ where: { id: employee.id }, data: { userId: taken.id } });
    await logAudit({ userId: req.user.id, action: 'Login linked to employee', entity: 'User', entityId: taken.id, toValue: employee.employeeCode });
  } else {
    const { password } = req.body || {};
    // Role and reach are derived from the designation, exactly as Add Employee
    // derives them — the same mapping, so the two paths cannot disagree.
    const mapping = await mappingFor(employee.designation);
    const role = req.body && req.body.role && ALL_ROLES.includes(req.body.role)
      ? req.body.role : loginRoleFor(mapping);
    const user = await prisma.user.create({
      data: {
        name: employee.name,
        email: employee.email,
        passwordHash: password && String(password).length >= 6
          ? await bcrypt.hash(String(password), 10)
          : await unguessablePasswordHash(),
        ...(password && String(password).length >= 6 ? passwordEventData('initial') : {}),
        role,
        username: employee.email,
        atsDepartment: employee.department,
        ...productRolesForDesignation(mapping),
        atsScopeDepartments: employee.department,
        atsScopeTeams: employee.team || null,
        hrmsAccess: mapping ? !!mapping.hrms : true,
        atsAccess: mapping ? !!mapping.ats : false,
        accountsAccess: mapping ? !!mapping.accounts : false,
        landingWorkspace: (mapping && mapping.landing) || null,
        branch: employee.branch || employee.location,
        team: employee.team,
        status: 'Active',
      },
    });
    await prisma.employee.update({ where: { id: employee.id }, data: { userId: user.id } });
    await logAudit({ userId: req.user.id, action: 'User auto-created and linked to employee', entity: 'User', entityId: user.id, toValue: employee.employeeCode });
  }
  const fresh = await prisma.employee.findUnique({ where: { id: req.params.id }, include: EMP_MGMT_INCLUDE });
  // A login without sign-in details is a login nobody can use.
  const credentials = fresh.userId
    ? await sendCredentials({ employee: fresh, userId: fresh.userId, actingUser: req.user, req })
    : null;
  if (credentials) await logAudit({ userId: req.user.id, action: `Sign-in details: ${credentials.status}`, entity: 'Employee', entityId: fresh.id });
  res.json({ ...shapeEmployeeMgmtRow(fresh), credentials });
});

// Activate / Deactivate the employee's login.
router.post('/management/:id/toggle-login', requirePerm(null, 'hrms', 'Employee Management', 'edit'), async (req, res) => {
  const employee = await prisma.employee.findUnique({ where: { id: req.params.id }, include: { user: true } });
  if (!employee) return res.status(404).json({ error: 'Employee not found' });
  if (!(await assertInScope(req, employee))) return res.status(403).json({ error: 'This record is outside your department scope' });
  if (!employee.user) return res.status(404).json({ error: 'That employee has no login yet.' });
  if (employee.user.id === req.user.id) return res.status(409).json({ error: 'You cannot disable your own login' });
  const prev = employee.user.status || 'Active';
  const next = prev === 'Active' ? 'Inactive' : 'Active';
  await prisma.user.update({ where: { id: employee.user.id }, data: { status: next } });
  await logAudit({ userId: req.user.id, action: `Login ${next === 'Active' ? 'activated' : 'deactivated'}`, entity: 'User', entityId: employee.user.id, fromValue: prev, toValue: next });
  const fresh = await prisma.employee.findUnique({ where: { id: req.params.id }, include: EMP_MGMT_INCLUDE });
  res.json(shapeEmployeeMgmtRow(fresh));
});

// PASSWORD ACTIONS ARE THE HR DESK'S (hrms-24 §12): HR, Super Admin and Admin
// — or whoever holds Employee Management / configure. A TL / STL may edit
// their people's records but does not hand out their passwords.
async function mayManagePasswords(user) {
  if (['SUPER_ADMIN', 'ADMIN', 'HR'].includes(user.hrmsRole) || ['SUPER_ADMIN', 'ADMIN'].includes(user.role)) return true;
  return can(user, 'hrms', 'hrms', 'Employee Management', 'configure');
}
const PASSWORD_DENIED = { error: 'Password reset is for HR and the Super Admin.' };

// MANAGER / ASSISTANT MANAGER in HRMS — every department, VIEW ONLY
// (utils/permissions.js can() / viewOnlyAllows). Used where a route's own
// guard is broader than view (documents, Grant Edit Access).
function isViewOnlyAdmin(user) {
  // eslint-disable-next-line global-require
  const { rolesFor } = require('../utils/permissions');
  const roles = rolesFor(user, 'hrms') || [];
  return roles.some((r) => ['MANAGER', 'ASSISTANT_MANAGER'].includes(r));
}

// CHANGING AN EMPLOYEE ID is the HR desk's (Super Admin, Admin, HR): it needs
// BOTH `edit` (maintaining the record) and `create` (issuing IDs) on Employee
// Management — the pair the permission matrix gives SET.HR_DESK. A lead who
// may edit their people's records (STL) does not renumber them, and a
// view-only Manager / Assistant Manager or a TL has no `edit` at all.
async function mayEditCode(user) {
  return (await can(user, 'hrms', 'hrms', 'Employee Management', 'edit'))
    && can(user, 'hrms', 'hrms', 'Employee Management', 'create');
}

// PUT /management/:id/code { employeeCode } — change an Employee ID.
//
// Everything else in TeamLink points at an employee by its internal id, never
// by the code string: attendance, punches, leave, payroll, documents (stored
// under server-chosen names), seats and the audit trail all carry employeeId.
// The code-keyed rows are deliberately left as they are:
//   * Employee.biometricPin — the device PIN is its own field; a mapped PIN
//     keeps working. (Admin → Biometric only SUGGESTS unmapped PINs that equal
//     a code, so an unmapped PIN equal to the OLD code stops being suggested.)
//   * AttendanceHistory / AttendanceHistorySummary.employeeRef — "the Employee
//     ID as written in the file", linked by employeeId; kept as imported.
//   * ResignationDetail.employeeCode — a snapshot of the form as filed.
router.put('/management/:id/code', requirePerm(null, 'hrms', 'Employee Management', 'edit'), async (req, res) => {
  if (!(await mayEditCode(req.user))) {
    return res.status(403).json({ error: 'Changing an Employee ID is for HR and the Super Admin.' });
  }
  const employee = await prisma.employee.findUnique({ where: { id: req.params.id } });
  if (!employee) return res.status(404).json({ error: 'Employee not found' });
  if (!(await assertInScope(req, employee))) return res.status(403).json({ error: 'This record is outside your department scope' });
  const wanted = String((req.body && req.body.employeeCode) || '').trim();
  const fmt = employeeCodes.checkFormat(wanted);
  if (fmt.error) return res.status(400).json({ error: fmt.error });
  if (wanted === employee.employeeCode) return res.status(400).json({ error: `${employee.name} already has Employee ID ${wanted}.` });
  const holder = await employeeCodes.codeHolder(wanted, employee.id);
  if (holder) {
    return res.status(409).json({ error: `Employee ID ${holder.employeeCode} already belongs to ${holder.name}.` });
  }
  try {
    await prisma.employee.update({ where: { id: employee.id }, data: { employeeCode: wanted } });
  } catch (err) {
    if (employeeCodes.isCodeClash(err)) return res.status(409).json({ error: `Employee ID ${wanted} was taken a moment ago.` });
    throw err;
  }
  await logAudit({
    userId: req.user.id,
    actorName: req.user.name,
    action: 'Employee ID changed',
    entity: 'Employee',
    entityId: employee.id,
    field: 'employeeCode',
    fieldLabel: 'Employee ID',
    fromValue: employee.employeeCode,
    toValue: wanted,
    reason: req.body && req.body.reason ? String(req.body.reason).slice(0, 300) : null,
  });
  const fresh = await prisma.employee.findUnique({ where: { id: employee.id }, include: EMP_MGMT_INCLUDE });
  res.json({ ok: true, row: shapeEmployeeMgmtRow(fresh), from: employee.employeeCode, to: wanted, warning: fmt.warning || null });
});

router.post('/management/:id/reset-password', requirePerm(null, 'hrms', 'Employee Management', 'edit'), async (req, res) => {
  const { password } = req.body || {};
  if (!(await mayManagePasswords(req.user))) return res.status(403).json(PASSWORD_DENIED);
  const employee = await prisma.employee.findUnique({ where: { id: req.params.id }, include: { user: true } });
  if (!employee) return res.status(404).json({ error: 'Employee not found' });
  if (!(await assertInScope(req, employee))) return res.status(403).json({ error: 'This record is outside your department scope' });
  if (!employee.user) return res.status(404).json({ error: 'That employee has no login yet.' });
  const weak = strengthError(password, { email: employee.user.email, name: employee.user.name });
  if (weak) return res.status(400).json({ error: weak });
  // Live at once. The owner must change it at their next sign-in, any lock is
  // lifted, and a pending set-password link stops working.
  await prisma.user.update({
    where: { id: employee.user.id },
    data: {
      passwordHash: await bcrypt.hash(String(password), 10),
      ...passwordEventData('admin'),
      setPasswordTokenHash: null, setPasswordExpiresAt: null,
    },
  });
  // The new password is never echoed back or logged.
  await logAudit({ userId: req.user.id, action: 'Password reset', entity: 'User', entityId: employee.user.id, toValue: 'Reset — change required at next sign-in' });
  const fresh = await prisma.employee.findUnique({ where: { id: req.params.id }, include: EMP_MGMT_INCLUDE });
  res.json({ ok: true, row: shapeEmployeeMgmtRow(fresh), passwordStatus: passwordStatusOf(fresh.user) });
});

// SEND PASSWORD RESET — a fresh single-use set-password link, emailed from the
// company mailbox (utils/employeeInvite.js sendCredentials). HR never learns
// the new password. The current password keeps working until the link is
// used; the row reads "Reset Required" meanwhile.
router.post('/management/:id/send-password-reset', requirePerm(null, 'hrms', 'Employee Management', 'edit'), async (req, res) => {
  if (!(await mayManagePasswords(req.user))) return res.status(403).json(PASSWORD_DENIED);
  const employee = await prisma.employee.findUnique({ where: { id: req.params.id }, include: { user: true } });
  if (!employee) return res.status(404).json({ error: 'Employee not found' });
  if (!(await assertInScope(req, employee))) return res.status(403).json({ error: 'This record is outside your department scope' });
  if (!employee.user) return res.status(404).json({ error: 'That employee has no login yet.' });
  const credentials = await sendCredentials({ employee, userId: employee.user.id, actingUser: req.user, req });
  await prisma.user.update({ where: { id: employee.user.id }, data: { passwordResetRequired: true } });
  await logAudit({
    userId: req.user.id, action: 'Password reset link sent', entity: 'User', entityId: employee.user.id,
    toValue: credentials.sent ? 'Emailed' : 'Not emailed', reason: credentials.sent ? null : (credentials.reason || null),
  });
  const fresh = await prisma.employee.findUnique({ where: { id: req.params.id }, include: EMP_MGMT_INCLUDE });
  res.json({
    ok: true,
    sent: !!credentials.sent,
    status: credentials.status,
    // Handed back only when it could NOT be emailed, so HR can pass it on —
    // the same rule as the sign-in details on Add Employee.
    link: credentials.sent ? null : (credentials.link || null),
    expiresAt: credentials.expiresAt || null,
    row: shapeEmployeeMgmtRow(fresh),
  });
});

// Assign Roles — product access on the SAME login, plus the reporting chain.
router.put('/management/:id/roles', requirePerm(null, 'hrms', 'Employee Management', 'edit'), async (req, res) => {
  const { role, atsDepartment, stl, tl } = req.body || {};
  const employee = await prisma.employee.findUnique({ where: { id: req.params.id }, include: { user: true } });
  if (!employee) return res.status(404).json({ error: 'Employee not found' });
  if (!(await assertInScope(req, employee))) return res.status(403).json({ error: 'This record is outside your department scope' });
  if (!employee.user) return res.status(400).json({ error: 'Create a login for this employee first.' });
  if (role && !ALL_ROLES.includes(role)) return res.status(400).json({ error: 'Unknown role' });

  // THE FULL EDIT FORM's Role dropdown (roles as data — system AND custom,
  // exactly the Add Employee rules): an ACTIVE internal role from Role
  // Catalog, a privileged one only for a company-wide caller.
  if (req.body && req.body.roleCode) {
    const chosen = await roleByCode(String(req.body.roleCode));
    if (!chosen || chosen.external) return res.status(400).json({ error: 'Unknown role' });
    if (!chosen.active) return res.status(400).json({ error: `The role "${chosen.name}" is inactive.` });
    const sc = scopeOf(req.user);
    if (isPrivilegedRole(chosen) && !(sc.global || ['SUPER_ADMIN', 'ADMIN'].includes(sc.role))) {
      return res.status(403).json({ error: `You cannot give the role "${chosen.name}".` });
    }
    const patch = loginPatchForRole(chosen);
    const prev = { role: employee.user.role, hrmsRole: employee.user.hrmsRole, atsRole: employee.user.atsRole, accountsRole: employee.user.accountsRole };
    await prisma.user.update({ where: { id: employee.user.id }, data: patch });
    await logAudit({
      userId: req.user.id, actorName: req.user.name, action: 'Role changed on the employee form', entity: 'User', entityId: employee.user.id,
      fromValue: JSON.stringify(prev), toValue: `${chosen.name} (${chosen.code})`,
    });
  }

  const before = employee.user.role;
  if (role || atsDepartment !== undefined) {
    await prisma.user.update({
      where: { id: employee.user.id },
      data: { ...(role ? { role } : {}), ...(atsDepartment !== undefined ? { atsDepartment: atsDepartment || null } : {}) },
    });
  }
  if (stl !== undefined || tl !== undefined) {
    await prisma.employee.update({
      where: { id: employee.id },
      data: { ...(stl !== undefined ? { stl: stl || null } : {}), ...(tl !== undefined ? { tl: tl || null } : {}) },
    });
  }
  if (role && role !== before) {
    await logAudit({ userId: req.user.id, action: 'Product roles assigned', entity: 'User', entityId: employee.user.id, fromValue: before, toValue: role });
  }
  const fresh = await prisma.employee.findUnique({ where: { id: req.params.id }, include: EMP_MGMT_INCLUDE });
  res.json(shapeEmployeeMgmtRow(fresh));
});

// EDIT SCOPE — the data scope on the Scope column. THE only implementation:
// Administration → Users links here rather than carrying its own copy.
//
// `assign` is the action, which the matrix gives to Super Admin / Admin: a TL
// reads the Scope column but cannot widen anybody's reach, including their
// own. Scope is re-resolved from the database on every request
// (middleware/auth.js), so a change here applies on that user's very next
// call — no re-login.
router.put('/management/:id/scope', requirePerm(null, 'hrms', 'Employee Management', 'assign'), async (req, res) => {
  const employee = await prisma.employee.findUnique({ where: { id: req.params.id }, include: { user: true } });
  if (!employee) return res.status(404).json({ error: 'Employee not found' });
  if (!(await assertInScope(req, employee))) return res.status(403).json({ error: 'This record is outside your department scope' });
  if (!employee.user) return res.status(400).json({ error: 'Create a login for this employee first — scope belongs to the login.' });

  const clean = (v) => {
    if (v === undefined) return undefined;
    const s = String(v || '').split(',').map((x) => x.trim()).filter(Boolean).join(',');
    return s || null;
  };
  const data = {};
  const departments = clean(req.body?.atsScopeDepartments);
  const teams = clean(req.body?.atsScopeTeams);
  const clients = clean(req.body?.atsScopeClients);
  if (departments !== undefined) data.atsScopeDepartments = departments;
  if (teams !== undefined) data.atsScopeTeams = teams;
  if (clients !== undefined) data.atsScopeClients = clients;
  if (!Object.keys(data).length) return res.status(400).json({ error: 'Nothing to change.' });

  const before = [employee.user.atsScopeDepartments, employee.user.atsScopeTeams, employee.user.atsScopeClients]
    .filter(Boolean).join(' · ') || 'own department';
  await prisma.user.update({ where: { id: employee.user.id }, data });
  const after = [
    data.atsScopeDepartments ?? employee.user.atsScopeDepartments,
    data.atsScopeTeams ?? employee.user.atsScopeTeams,
    data.atsScopeClients ?? employee.user.atsScopeClients,
  ].filter(Boolean).join(' · ') || 'own department';
  await logAudit({
    userId: req.user.id, action: 'Data scope changed', entity: 'User',
    entityId: employee.user.id, fromValue: before, toValue: after,
  });
  const fresh = await prisma.employee.findUnique({ where: { id: req.params.id }, include: EMP_MGMT_INCLUDE });
  res.json(shapeEmployeeMgmtRow(fresh));
});

// The View modal: the employee's details, their login and their recent activity.
// THE DESIGNATION MASTER for the Edit form's Designation dropdown — the same
// DesignationRole rows Add Employee picks from, without the rest of /options.
router.get('/management/designations', requirePerm(null, 'hrms', 'Employee Management', 'view'), async (req, res) => {
  const rows = await designationRows();
  res.json({ designations: rows.map((r) => ({ designation: r.designation, ...designationLabel(r) })) });
});

// THE LIST AVATAR. The newest Photo document, for anybody who may see this
// employee in Employee Management (a photo is not Aadhaar / PAN — those stay
// behind the documents door). The list asks only for rows that HAVE a photo
// (photoDocId), lazily, so a page of initials costs nothing.
router.get('/management/:id/photo', requirePerm(null, 'hrms', 'Employee Management', 'view'), async (req, res) => {
  const employee = await prisma.employee.findUnique({ where: { id: req.params.id } });
  if (!employee) return res.status(404).json({ error: 'Employee not found' });
  if (!(await assertInScope(req, employee))) return res.status(403).json({ error: 'This record is outside your department scope' });
  const doc = await prisma.employeeDocument.findFirst({
    where: { employeeId: employee.id, docType: PHOTO_DOC_TYPE }, orderBy: { uploadedAt: 'desc' },
  });
  if (!doc) return res.status(404).json({ error: 'No photo' });
  const full = attachments.resolveStored(doc.file);
  if (!full || !['image/jpeg', 'image/png', 'image/webp'].includes(doc.mime)) return res.status(404).json({ error: 'No photo' });
  res.setHeader('Content-Type', doc.mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=300');
  return res.sendFile(full);
});

// LAST WORKING DATE for somebody on notice. The resignation record is the
// source (EmployeeRecord type RESIGNATION, `date` = last working day — what
// routes/resignations.js reads and writes). Where the person resigned outside
// TeamLink and no record exists, HR records one here, already serving notice,
// so the resignation module and this screen show the same date.
router.put('/management/:id/last-working-date', requirePerm(null, 'hrms', 'Employee Management', 'edit'), async (req, res) => {
  const employee = await prisma.employee.findUnique({ where: { id: req.params.id } });
  if (!employee) return res.status(404).json({ error: 'Employee not found' });
  if (!(await assertInScope(req, employee))) return res.status(403).json({ error: 'This record is outside your department scope' });
  const date = String((req.body && req.body.lastWorkingDate) || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
    return res.status(400).json({ error: 'Last working date must be a date (YYYY-MM-DD).' });
  }
  const open = await prisma.employeeRecord.findFirst({
    where: { type: 'RESIGNATION', employeeId: employee.id, status: { in: OPEN_RESIGNATION } },
    orderBy: { updatedAt: 'desc' },
  });
  if (!open && !['Notice Period', 'Exit Process'].includes(employee.employmentStatus)) {
    return res.status(400).json({ error: `${employee.name} is not on notice (status ${employee.employmentStatus}). Set the status to Notice Period first, or file the resignation in Employee Services.` });
  }
  let record;
  if (open) {
    record = await prisma.employeeRecord.update({ where: { id: open.id }, data: { date } });
    const form = await prisma.resignationDetail.findUnique({ where: { recordId: open.id } });
    if (form) {
      await prisma.resignationDetail.update({
        where: { id: form.id },
        data: open.status === 'Pending' ? { requestedLastWorkingDate: date } : { approvedLastWorkingDate: date },
      });
    }
  } else {
    record = await prisma.employeeRecord.create({
      data: {
        type: 'RESIGNATION',
        employeeId: employee.id,
        title: 'Resignation recorded by HR',
        detail: 'Recorded from Employee Management — no resignation was filed in TeamLink. Last working date set by HR.',
        status: 'Notice Period',
        date,
        raisedBy: req.user.name || null,
      },
    });
  }
  await logAudit({
    userId: req.user.id, actorName: req.user.name, action: 'Last working date set',
    entity: 'Employee', entityId: employee.id, field: 'lastWorkingDate', fieldLabel: 'Last working date',
    fromValue: open ? (open.date || '') : '', toValue: date,
  });
  return res.json({ ok: true, lastWorkingDate: date, resignationId: record.id, created: !open });
});

router.get('/management/:id', requirePerm(null, 'hrms', 'Employee Management', 'view'), async (req, res) => {
  const employee = await prisma.employee.findUnique({ where: { id: req.params.id }, include: EMP_MGMT_INCLUDE });
  if (!employee) return res.status(404).json({ error: 'Employee not found' });
  if (!(await assertInScope(req, employee))) return res.status(403).json({ error: 'This record is outside your department scope' });
  const ids = [employee.id, ...(employee.userId ? [employee.userId] : [])];
  const activity = await prisma.auditLog.findMany({
    where: { entityId: { in: ids } },
    include: { user: true },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
  const seats = (await seatTimelines()).get(employee.id) || [];
  // TRANSFER HISTORY — seats plus department / team / reporting changes from
  // the audit trail, with who made each change. Same scope check as above.
  const transferAudit = await prisma.auditLog.findMany({
    where: { entity: 'Employee', entityId: employee.id },
    include: { user: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });
  const extras = (await employeeListExtras([employee.id])).get(employee.id) || {};
  res.json({
    ...shapeEmployeeMgmtRow(employee),
    photoDocId: extras.photoDocId || null,
    docCount: extras.docCount || 0,
    lastWorkingDate: extras.lastWorkingDate || null,
    lastWorkingDateSource: extras.lastWorkingDateSource || null,
    isLead: isLead(employee),
    transferHistory: transferHistoryOf(transferAudit, seats),
    seatHistory: seats,
    emailVerification: await emailVerify.emailState(employee),
    activity: activity.map((a) => ({ action: a.action, date: new Date(a.createdAt).toLocaleString(), by: a.user?.name || 'System' })),
  });
});

router.get('/', requirePerm(null, 'hrms', 'Employee Management', 'view'), async (req, res) => {
  const where = departmentWhere(req);
  if (req.query.employmentStatus) where.employmentStatus = req.query.employmentStatus;
  // A department-scoped role is already restricted by departmentWhere(); the
  // filter box may only narrow an unrestricted caller.
  if (scopeDepartments(req) === undefined && req.query.department) {
    where.department = req.query.department;
  }
  const employees = await prisma.employee.findMany({ where: withoutSystemAccounts(where), include: { reportingManager: true }, orderBy: { name: 'asc' } });
  res.json(employees.map(withComputed));
});

router.put('/:id/manager', requirePerm(null, 'hrms', 'Employee Management', 'edit'), async (req, res) => {
  const existing = await prisma.employee.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Employee not found' });
  if (!(await assertInScope(req, existing))) return res.status(403).json({ error: 'This record is outside your department scope' });
  const { reportingManagerId } = req.body;
  const employee = await prisma.employee.update({ where: { id: req.params.id }, data: { reportingManagerId: reportingManagerId || null } });
  await logAudit({ userId: req.user.id, action: 'Reporting manager set', entity: 'Employee', entityId: employee.id });
  res.json(withComputed(employee));
});

router.get('/:id', async (req, res) => {
  const employee = await prisma.employee.findUnique({
    where: { id: req.params.id },
    include: { reportingManager: true, user: { select: { id: true, name: true, email: true, role: true, hrmsRole: true, atsRole: true, accountsRole: true } }, salaryStructure: true },
  });
  if (!employee) return res.status(404).json({ error: 'Employee not found' });
  if (req.user.caps.hrmsSelfOnly && employee.userId !== req.user.id) {
    return res.status(403).json({ error: "This isn't included in your role's permissions" });
  }
  if (!(await assertInScope(req, employee))) {
    return res.status(403).json({ error: 'This record is outside your department scope' });
  }

  // THE SEAT, and the seats this person could be moved to. Sent with the
  // record rather than fetched separately, because the form that edits the
  // employee is the form that assigns the seat — one screen, one request.
  const [heldNow, deptSeats, occupied] = await Promise.all([
    prisma.positionAssignment.findFirst({
      where: { employeeId: employee.id, toDate: null },
      include: { position: true },
    }),
    prisma.position.findMany({
      where: { active: true, department: employee.department },
      orderBy: { code: 'asc' },
    }),
    prisma.positionAssignment.findMany({
      where: { toDate: null },
      select: { positionId: true, employeeId: true, employee: { select: { name: true, employmentStatus: true } } },
    }),
  ]);
  // A seat whose holder has LEFT is offered as free (it is released on save).
  const heldBy = new Map(occupied
    .filter((a) => !(a.employee && seatHolderLeft(a.employee.employmentStatus)))
    .map((a) => [a.positionId, a]));

  res.json({
    ...withComputed(employee),
    position: heldNow ? heldNow.position.code : '',
    positionSince: heldNow ? heldNow.fromDate : null,
    // Free seats first; a taken one is listed and LABELLED rather than
    // hidden, because a missing code reads as "no such seat".
    positionOptions: deptSeats.map((r) => {
      const a = heldBy.get(r.id);
      return {
        code: r.code,
        name: r.name || null,
        holder: a && a.employeeId !== employee.id ? (a.employee ? a.employee.name : 'somebody') : null,
        mine: !!(a && a.employeeId === employee.id),
      };
    }).sort((a, b) => (a.holder ? 1 : 0) - (b.holder ? 1 : 0)
      || a.code.localeCompare(b.code, undefined, { numeric: true })),
  });
});

// ADD EMPLOYEE lives at POST /management above — ONE implementation, with the
// email one-time code, the auto Employee ID, the designation-derived role,
// products and scope, and the single-use set-password link. The second create
// path that used to sit here has been REMOVED rather than left as a quieter
// copy of it.

// Re-send (or first-send) the sign-in link for an employee who already has a
// login — the fix for "the mail bounced" and for an employee created while
// SMTP was down. Issuing a new link invalidates any previous one.
router.post('/:id/send-credentials', requirePerm(null, 'hrms', 'Employee Management', 'configure'), async (req, res) => {
  const employee = await prisma.employee.findUnique({ where: { id: req.params.id } });
  if (!employee) return res.status(404).json({ error: 'Employee not found' });
  if (!(await assertInScope(req, employee))) return res.status(403).json({ error: 'This record is outside your department scope' });
  if (!employee.userId) return res.status(400).json({ error: 'That employee has no login yet — create one first.' });
  const credentials = await sendCredentials({ employee, userId: employee.userId, actingUser: req.user, req });
  await logAudit({ userId: req.user.id, action: `Sign-in details re-sent: ${credentials.status}`, entity: 'Employee', entityId: employee.id });
  const fresh = await prisma.employee.findUnique({ where: { id: employee.id } });
  res.json({ ...withComputed(fresh), credentials });
});

// Editing, pausing, locking/unlocking and transferring an employee are HR/Super
// Admin actions — Manager/Assistant Manager/STL/TL get read-only visibility into
// their own department (see the GET routes above), not the ability to change records.
// EDITING AN EMPLOYEE'S MASTER RECORD IS `edit`, NOT `configure`.
//
// The matrix has said so since Employee Management was split (see
// utils/permissions.js): `view` and `edit` are the HR grants, while `create` /
// `export` / `delete` / `approve` / `assign` / `configure` are Administration's.
// This route asked for `configure`, which made the whole screen read-only for
// every HR role — and the HR desk (§6) whose job IS the employee master could
// not change a phone number.
//
// It also loaded the record "for scope" and never checked it. It does now:
// assertInScope() holds a TL or an STL to their own department, and lets HR
// and the admins through, so widening WHO may edit does not widen WHAT they
// may edit.
router.put('/:id', requirePerm(null, 'hrms', 'Employee Management', 'edit'), async (req, res) => {
  const existingForScope = await prisma.employee.findUnique({ where: { id: req.params.id } });
  if (!existingForScope) return res.status(404).json({ error: 'Employee not found' });
  if (!(await assertInScope(req, existingForScope))) {
    return res.status(403).json({ error: 'This record is outside your department scope' });
  }
  const editableFields = [
    'name', 'email', 'phone', 'department', 'team', 'designation', 'location', 'employmentStatus', 'employeeType',
    'emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelation', 'address', 'addressType',
    'addressLine1', 'addressLine2', 'city', 'district', 'state', 'country', 'postalCode', 'bloodGroup',
    'branch', 'shift', 'employmentExperience', 'educationDetails', 'skills',
    'bankName', 'bankAccountNumber', 'ifscCode', 'panNumber', 'uanNumber', 'pfNumber', 'esiNumber',
    // Date of birth and gender were on the employee's own form but not on
    // HR's, so the two forms could not be the same form. HR may now correct
    // them too; the date is coerced exactly as the approve handler does.
    'dateOfBirth', 'gender',
    // THE FULL EDIT FORM (2026-09-29): every field the Add form and the
    // profile show is now editable here too — joining date, the TL / STL
    // names and the reporting manager.
    'dateOfJoining', 'tl', 'stl', 'reportingManagerId',
  ];
  const data = {};
  editableFields.forEach((f) => { if (req.body[f] !== undefined) data[f] = req.body[f]; });
  if (data.dateOfBirth !== undefined) data.dateOfBirth = toDate(data.dateOfBirth);
  if (data.dateOfJoining !== undefined) data.dateOfJoining = toDate(data.dateOfJoining);
  // A masked account number (what a non-HR export shows) is never written back.
  if (data.bankAccountNumber !== undefined && /[xX•*]{3,}/.test(String(data.bankAccountNumber))) delete data.bankAccountNumber;
  // AADHAAR: the full number is never stored (see the schema). Twelve digits
  // typed on the form keep only their last four; four digits are kept as-is.
  if (req.body.aadhaarNumber !== undefined && req.body.aadhaarNumber !== null && String(req.body.aadhaarNumber).trim() !== '') {
    const digits = String(req.body.aadhaarNumber).replace(/\D/g, '');
    if (!/^\d{12}$/.test(digits) && !/^\d{4}$/.test(digits)) {
      return res.status(400).json({ error: 'Aadhaar must be 12 digits (only the last four are kept) or the last four digits.' });
    }
    data.aadhaarLast4 = digits.slice(-4);
  }
  // Reporting manager: somebody in the caller's scope, never the employee.
  if (data.reportingManagerId !== undefined) {
    data.reportingManagerId = String(data.reportingManagerId || '').trim() || null;
    if (data.reportingManagerId) {
      if (data.reportingManagerId === existingForScope.id) return res.status(400).json({ error: 'An employee cannot report to themselves.' });
      const mgr = await prisma.employee.findUnique({ where: { id: data.reportingManagerId } });
      if (!mgr || !(await assertInScope(req, mgr))) return res.status(400).json({ error: 'Pick a reporting manager from the list (someone in your scope).' });
    }
  }

  // DESIGNATION COMES FROM THE MASTER (DesignationRole). A legacy value already
  // on the record is kept (warned, not blocked); CHANGING to a value that is
  // not in the master is refused, because the login's roles derive from it.
  let designationWarning = null;
  if (data.designation !== undefined) {
    data.designation = String(data.designation || '').trim() || null;
    const master = (await designationRows()).map((r) => r.designation);
    const inMaster = (v) => master.some((m) => m.toLowerCase() === String(v).toLowerCase());
    if (data.designation && !inMaster(data.designation)) {
      if (data.designation !== existingForScope.designation) {
        return res.status(400).json({ error: `"${data.designation}" is not in the designation master. Choose one of: ${master.join(', ')} (Administration → Role mapping adds new ones).` });
      }
      designationWarning = `"${data.designation}" is a legacy designation that is not in the designation master — kept as it is.`;
    } else if (data.designation) {
      data.designation = master.find((m) => m.toLowerCase() === data.designation.toLowerCase());
    }
  }

  // DEPARTMENT IS EDITABLE HERE, and it used to be deleted from this payload
  // with "move departments only via /transfer". The reason was sound — a
  // department move has to drag the ATS scope and the seat with it, and
  // /transfer is where that was written — but the effect was a field sitting
  // greyed out on the edit form with a note telling you to go somewhere else.
  //
  // So the field is live, and everything /transfer does happens here too:
  // the login's atsDepartment and atsScopeDepartments follow (below), the
  // seat follows (further below), and both are audited. The one thing
  // /transfer still has that this does not is a REASON, which is why that
  // route stays: a reorganisation wants a reason, a correction does not.
  const departmentChanged = data.department !== undefined
    && String(data.department).trim() !== ''
    && data.department !== existingForScope.department;
  if (data.department !== undefined && !String(data.department).trim()) {
    return res.status(400).json({ error: 'An employee must belong to a department.' });
  }
  if (departmentChanged) {
    // The caller must be allowed to put somebody INTO that department, not
    // merely to edit this record — otherwise a department-scoped HR user could
    // move people out of their own reach.
    const allowed = assertDepartmentAllowed(req, String(data.department).trim());
    if (!allowed.ok) return res.status(403).json({ error: allowed.error });
    data.department = allowed.department;
    // A team belongs to a department. Carrying "Team-A" from Education into
    // Medical would name a team that does not exist there.
    if (req.body.team === undefined) data.team = null;
  }

  // SEAT PRE-CHECK (user, 2026-09-29: "when I change the position it's not
  // taken"). Decided BEFORE anything is saved, so a refused seat never leaves a
  // half-applied change (the old code vacated the current seat first and then
  // refused the new one). A seat whose open tenure belongs to somebody who has
  // LEFT (Relieved / Exited …) counts as free: that tenure is closed on their
  // last working day when the new holder takes it.
  let seatPlan = null;
  if (req.body.position !== undefined) {
    const wanted = String(req.body.position || '').trim();
    const seatDept = data.department || existingForScope.department;
    const current = await prisma.positionAssignment.findFirst({
      where: { employeeId: existingForScope.id, toDate: null },
      include: { position: true },
    });
    const currentCode = current ? current.position.code : '';
    if (wanted.toUpperCase() !== currentCode.toUpperCase()) {
      let seat = null;
      let departedHolder = null;
      if (wanted) {
        const inDept = await prisma.position.findMany({ where: { department: seatDept } });
        seat = inDept.find((r) => r.code.toUpperCase() === wanted.toUpperCase()) || null;
        if (!seat) {
          const elsewhere = await prisma.position.findFirst({ where: { code: wanted } });
          if (elsewhere) {
            return res.status(409).json({ error: `Position ${elsewhere.code} belongs to ${elsewhere.department || 'another department'}.` });
          }
        } else if (!seat.active) {
          return res.status(409).json({ error: `Position ${seat.code} is retired. Reactivate it on Administration → Positions first.` });
        } else {
          const held = await prisma.positionAssignment.findFirst({
            where: { positionId: seat.id, toDate: null },
            include: { employee: { select: { id: true, name: true, employmentStatus: true } } },
          });
          if (held && held.employeeId !== existingForScope.id) {
            if (held.employee && seatHolderLeft(held.employee.employmentStatus)) departedHolder = held;
            else {
              return res.status(409).json({
                error: `${seat.code} is held by ${held.employee ? held.employee.name : 'somebody else'} (${held.employee ? held.employee.employmentStatus : 'active'}). Vacate it first.`,
              });
            }
          }
        }
      }
      seatPlan = { wanted, current, currentCode, seat, departedHolder, seatDept };
    }
  }

  const employee = await prisma.employee.update({ where: { id: req.params.id }, data });

  // THE LOGIN FOLLOWS THE DEPARTMENT, exactly as it does on /transfer.
  if (departmentChanged) {
    const moved = await syncLoginToEmployee(employee, existingForScope);
    await logAudit({
      userId: req.user.id,
      actorName: req.user.name,
      action: 'Department changed',
      entity: 'Employee',
      entityId: employee.id,
      fromValue: existingForScope.department || '(none)',
      toValue: employee.department,
    });
    if (moved) {
      await logAudit({
        userId: req.user.id,
        actorName: req.user.name,
        action: 'Login scope followed the department change',
        entity: 'User',
        entityId: employee.userId,
        toValue: moved.changes.join('; ').slice(0, 200),
      });
    }
    // AND THE SEAT. A seat belongs to a department, so HR-4 is wrong the
    // moment somebody moves to Medical. The tenure is CLOSED, never deleted —
    // the seat keeps what was done under it. No new seat is invented here:
    // the caller picks one in the Position field, which is now showing the
    // new department's seats.
    const held = await prisma.positionAssignment.findFirst({
      where: { employeeId: employee.id, toDate: null },
      include: { position: true },
    });
    if (held && held.position.department && held.position.department !== employee.department) {
      await prisma.positionAssignment.update({
        where: { id: held.id },
        data: { toDate: positionToday() },
      });
      await logAudit({
        userId: req.user.id,
        actorName: req.user.name,
        action: `Vacated seat ${held.position.code} — it belongs to ${held.position.department}`,
        entity: 'Employee',
        entityId: employee.id,
        fromValue: held.position.code,
        toValue: '(none — pick a seat in the new department)',
      });
    }
  }

  // THE SEAT — settable here, by an admin, and nowhere else.
  //
  // Department, designation and position are the three fields the employee
  // may never touch: department and designation are kept off
  // SELF_SERVICE_FIELDS so PUT /me ignores them, and a position is not a
  // column on Employee at all — it is a PositionAssignment, and the routes
  // that write those need Employee Management / configure, which no employee
  // holds. This is where an admin assigns one without going to another
  // screen.
  //
  // `position` is a seat CODE. Empty string vacates; absent leaves it alone,
  // so a form that does not send the field cannot silently unseat somebody.
  if (seatPlan) {
    const { wanted, current, currentCode, departedHolder } = seatPlan;
    let { seat } = seatPlan;
    // Leaving a seat ENDS the tenure, it does not delete it: the seat keeps
    // what was done under it, which is the entire point of seats.
    if (current) {
      await prisma.positionAssignment.update({ where: { id: current.id }, data: { toDate: positionToday() } });
    }
    if (wanted) {
      // The previous holder has LEFT: close their tenure on their last working
      // day (never before it started), audited, so the seat history stays true.
      let prevEnd = null;
      if (departedHolder) {
        prevEnd = await lastWorkingDayOf(departedHolder.employeeId);
        if (prevEnd < departedHolder.fromDate) prevEnd = departedHolder.fromDate;
        await prisma.positionAssignment.update({ where: { id: departedHolder.id }, data: { toDate: prevEnd } });
        await logAudit({
          userId: req.user.id, actorName: req.user.name,
          action: `Seat ${seat.code} released — previous holder ${departedHolder.employee.name} is ${departedHolder.employee.employmentStatus}`,
          entity: 'Position', entityId: seat.id, fromValue: departedHolder.employee.name, toValue: `tenure closed ${prevEnd}`,
        });
      }
      if (!seat) {
        seat = await prisma.position.create({ data: { code: wanted, department: employee.department } });
        await logAudit({ userId: req.user.id, action: `Position ${wanted} created`, entity: 'Position', entityId: seat.id });
      }
      // START DATE (user: "calculate according to the employee's joining date"):
      // a person's FIRST seat starts on their date of joining; a later move
      // starts today. Never before the previous holder's tenure ended.
      const hadSeatBefore = await prisma.positionAssignment.count({ where: { employeeId: employee.id } });
      let fromDate = positionToday();
      if (!hadSeatBefore && employee.dateOfJoining) {
        const doj = new Date(employee.dateOfJoining).toISOString().slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(doj)) fromDate = doj;
      }
      if (prevEnd && fromDate < prevEnd) fromDate = prevEnd;
      await prisma.positionAssignment.create({
        data: { positionId: seat.id, employeeId: employee.id, fromDate },
      });
    }
    await logAudit({
      userId: req.user.id, actorName: req.user.name,
      action: 'Position changed', entity: 'Employee', entityId: employee.id,
      fromValue: currentCode || '(none)', toValue: wanted || '(none)',
    });
  }
  // A DESIGNATION CHANGE IS A ROLE CHANGE. Promoting a Recruiter to TL used to
  // leave an ATS login that was still a RECRUITER, because the designation ->
  // role derivation only ever ran when the login was created.
  const designationChanged = data.designation !== undefined && data.designation !== existingForScope.designation;
  const synced = await syncLoginToEmployee(employee, existingForScope, { designationChanged });
  if (synced) {
    await logAudit({
      userId: req.user.id, actorName: req.user.name, action: 'Login re-derived from the HR record',
      entity: 'User', entityId: employee.userId, toValue: synced.changes.join('; ').slice(0, 200),
    });
  }
  await logAudit({ userId: req.user.id, action: 'Employee updated', entity: 'Employee', entityId: employee.id });
  // ONE AUDIT ROW PER CHANGED FIELD, old -> new (Employee -> History tab).
  // Bank account numbers are recorded masked, never in full.
  {
    const show = (f, v) => {
      if (v === null || v === undefined) return '';
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      if (f === 'bankAccountNumber') { const s = String(v); return s ? `${'X'.repeat(Math.max(4, s.length - 4))}${s.slice(-4)}` : ''; }
      return String(v);
    };
    const changes = Object.keys(data)
      .filter((f) => show(f, existingForScope[f]) !== show(f, employee[f]))
      .map((f) => ({ field: f, label: SELF_SERVICE_FIELDS[f] || f.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()), from: show(f, existingForScope[f]), to: show(f, employee[f]) }));
    if (changes.length) {
      await logFieldChanges({
        userId: req.user.id, actorName: req.user.name, entity: 'Employee', entityId: employee.id,
        action: 'Employee edited (full form)', changes, approvalStatus: null,
      });
    }
  }
  res.json(designationWarning ? { ...withComputed(employee), designationWarning } : withComputed(employee));
});

// Permanently removes an employee record and everything hanging off it
// (attendance, leave, payslips, reviews, etc.) — Super Admin/Admin only.
router.delete('/:id', requirePerm(null, 'hrms', 'Employee Management', 'delete'), async (req, res) => {
  const existing = await prisma.employee.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Employee not found' });
  // The document ROWS go with the transaction; their stored BYTES are removed
  // once it has committed, so a rolled-back delete never loses a file.
  const docFiles = (await prisma.employeeDocument.findMany({
    where: { employeeId: req.params.id }, select: { file: true },
  })).map((d) => d.file);
  await prisma.$transaction([
    prisma.employee.updateMany({ where: { reportingManagerId: req.params.id }, data: { reportingManagerId: null } }),
    prisma.employeeDocument.deleteMany({ where: { employeeId: req.params.id } }),
    prisma.employeeRecord.deleteMany({ where: { employeeId: req.params.id } }),
    prisma.attendance.deleteMany({ where: { employeeId: req.params.id } }),
    prisma.attendanceRegularization.deleteMany({ where: { employeeId: req.params.id } }),
    prisma.leaveRequest.deleteMany({ where: { employeeId: req.params.id } }),
    prisma.payslip.deleteMany({ where: { employeeId: req.params.id } }),
    prisma.salaryStructure.deleteMany({ where: { employeeId: req.params.id } }),
    prisma.fnfRequest.deleteMany({ where: { employeeId: req.params.id } }),
    prisma.performanceReview.deleteMany({ where: { employeeId: req.params.id } }),
    prisma.courseAssignment.deleteMany({ where: { employeeId: req.params.id } }),
    prisma.courseMaterialProgress.deleteMany({ where: { employeeId: req.params.id } }),
    prisma.projectAssignment.deleteMany({ where: { employeeId: req.params.id } }),
    prisma.surveyResponse.deleteMany({ where: { employeeId: req.params.id } }),
    prisma.acknowledgment.deleteMany({ where: { employeeId: req.params.id } }),
    prisma.employee.delete({ where: { id: req.params.id } }),
  ]);
  docFiles.forEach((f) => attachments.remove(f));
  await logAudit({ userId: req.user.id, action: 'Employee deleted', entity: 'Employee', entityId: req.params.id, fromValue: existing.name });
  res.json({ ok: true });
});

// Links (or unlinks) this employee record to a login account — lets Administration
// grant an employee self-service access without duplicating their profile data.
router.put('/:id/link-user', requirePerm(null, 'hrms', 'Employee Management', 'assign'), async (req, res) => {
  const { userId } = req.body;
  if (userId) {
    const alreadyLinked = await prisma.employee.findFirst({ where: { userId, id: { not: req.params.id } } });
    if (alreadyLinked) return res.status(409).json({ error: 'That user account is already linked to another employee' });
  }
  const employee = await prisma.employee.update({ where: { id: req.params.id }, data: { userId: userId || null } });
  await logAudit({ userId: req.user.id, action: 'Employee linked to user account', entity: 'Employee', entityId: employee.id });
  res.json(withComputed(employee));
});

// Approve or reject an employee's self-submitted profile changes. Approval
// locks the profile — the employee can no longer self-edit until HR grants
// an unlock request (see below).
router.patch('/:id/changes/approve', requirePerm(null, 'hrms', 'Employee Management', 'approve'), async (req, res) => {
  const employee = await prisma.employee.findUnique({ where: { id: req.params.id } });
  if (!employee || !employee.pendingChanges) return res.status(400).json({ error: 'No pending changes' });
  if (!(await assertInScope(req, employee))) return res.status(403).json({ error: 'This record is outside your department scope' });
  const changes = JSON.parse(employee.pendingChanges);
  const data = {
    pendingChanges: null,
    isLocked: true,
    profileStage: 'Locked',
    // An approval ends any granted edit window, and records who decided what
    // so the employee is told rather than left guessing.
    unlockExpiresAt: null,
    unlockRequestStatus: null,
    reviewDecision: 'Approved',
    reviewNote: (req.body && req.body.note) ? String(req.body.note).slice(0, 500) : null,
    reviewedAt: new Date(),
    reviewedByName: req.user.name || null,
  };
  // Only the fields the employee was actually allowed to submit are applied —
  // a hand-crafted pendingChanges row cannot smuggle in a department change.
  // DATE COLUMNS need coercing: the self-service form submits "1996-04-12" and
  // pendingChanges stores that string, but Employee.dateOfBirth is a DateTime.
  // Writing the bare string made Prisma throw ("premature end of input"),
  // which in an async Express handler took the whole process down.
  changes.filter((c) => SELF_SERVICE_FIELDS[c.field]).forEach((c) => {
    data[c.field] = DATE_FIELDS.has(c.field) ? toDate(c.to) : c.to;
  });
  let updated;
  try {
    updated = await prisma.employee.update({ where: { id: req.params.id }, data });
  } catch (err) {
    return res.status(400).json({ error: `Those changes could not be applied: ${String(err.message || err).split('\n').pop()}` });
  }
  await logAudit({
    userId: req.user.id, actorName: req.user.name, action: 'Profile changes approved — profile locked',
    entity: 'Employee', entityId: employee.id, toValue: `${changes.length} field(s) applied`,
    approvalStatus: 'Approved', approvedByName: req.user.name || null, approvedAt: new Date(),
    reason: data.reviewNote || null,
  });
  // Stamp the verdict onto the per-field rows the employee's submission
  // wrote, so the history shows Approval Status and the approver per field
  // instead of leaving every row 'Pending' for ever.
  await resolveFieldApprovals({
    entity: 'Employee', entityId: employee.id, approvalStatus: 'Approved',
    approvedByName: req.user.name || null, reason: data.reviewNote || null,
  });
  res.json(withComputed(updated));
});

// Reject = send it back to the employee to fix, WITH A REASON. The reason is
// required: "rejected" with no explanation is what makes people ring HR.
router.patch('/:id/changes/reject', requirePerm(null, 'hrms', 'Employee Management', 'approve'), async (req, res) => {
  const reason = req.body && req.body.reason ? String(req.body.reason).trim() : '';
  if (!reason) return res.status(400).json({ error: 'Give the employee a reason for sending this back.' });
  const existing = await prisma.employee.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Employee not found' });
  if (!existing.pendingChanges) return res.status(400).json({ error: 'No pending changes' });
  if (!(await assertInScope(req, existing))) return res.status(403).json({ error: 'This record is outside your department scope' });
  const employee = await prisma.employee.update({
    where: { id: req.params.id },
    data: {
      pendingChanges: null,
      // Sent back to the employee — that is a DIFFERENT state from "never
      // filled in", and the badge now says so.
      profileStage: PROFILE_STATUS.CHANGE_REQUESTED,
      isLocked: false,
      reviewDecision: 'Rejected',
      reviewNote: reason.slice(0, 500),
      reviewedAt: new Date(),
      reviewedByName: req.user.name || null,
    },
  });
  await logAudit({
    userId: req.user.id, actorName: req.user.name, action: 'Profile changes sent back for edit',
    entity: 'Employee', entityId: employee.id, toValue: reason.slice(0, 200),
    approvalStatus: 'Rejected', approvedByName: req.user.name || null, approvedAt: new Date(), reason: reason.slice(0, 500),
  });
  await resolveFieldApprovals({
    entity: 'Employee', entityId: employee.id, approvalStatus: 'Rejected',
    approvedByName: req.user.name || null, reason: reason.slice(0, 500),
  });
  res.json(withComputed(employee));
});

// HR DECIDES THE REQUEST. TWO STEPS, NOT ONE.
//
// This used to approve the request AND open the edit window in the same call,
// which left no moment at which an Unlock button could exist. The asked-for
// flow is: the employee requests edit access -> Approve / Reject appear ->
// Approve -> UNLOCK appears -> Unlock opens the window -> they edit and submit
// -> the profile locks again.
//
// So approving only records the DECISION. Opening the window is the separate
// POST /:id/grant-edit-access below, which is what the Unlock button calls and
// which is where the duration, the section and the reason are chosen.
router.patch('/:id/unlock-request/approve', requirePerm(null, 'hrms', 'Employee Management', 'approve'), async (req, res) => {
  const employee = await prisma.employee.findUnique({ where: { id: req.params.id } });
  if (!employee || employee.unlockRequestStatus !== 'Pending') return res.status(400).json({ error: 'No pending unlock request' });
  if (!(await assertInScope(req, employee))) return res.status(403).json({ error: 'This record is outside your department scope' });
  const note = (req.body && req.body.note) ? String(req.body.note).slice(0, 500) : null;
  const updated = await prisma.employee.update({
    where: { id: req.params.id },
    data: {
      unlockRequestStatus: 'Approved',
      unlockDecidedAt: new Date(),
      unlockDecisionNote: note,
    },
  });
  await logAudit({
    userId: req.user.id, actorName: req.user.name,
    action: 'Edit-access request approved — awaiting Unlock',
    entity: 'Employee', entityId: employee.id,
    reason: note || employee.unlockRequestReason,
    approvalStatus: 'Approved', approvedByName: req.user.name || null, approvedAt: new Date(),
  });
  res.json(withComputed(updated));
});

router.patch('/:id/unlock-request/reject', requirePerm(null, 'hrms', 'Employee Management', 'approve'), async (req, res) => {
  const reason = req.body && req.body.reason ? String(req.body.reason).trim() : '';
  if (!reason) return res.status(400).json({ error: 'Give the employee a reason for declining this request.' });
  const existing = await prisma.employee.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Employee not found' });
  if (existing.unlockRequestStatus !== 'Pending') return res.status(400).json({ error: 'No pending unlock request' });
  if (!(await assertInScope(req, existing))) return res.status(403).json({ error: 'This record is outside your department scope' });
  const employee = await prisma.employee.update({
    where: { id: req.params.id },
    data: {
      unlockRequestStatus: 'Rejected',
      unlockDecidedAt: new Date(),
      unlockDecisionNote: reason.slice(0, 500),
    },
  });
  await logAudit({ userId: req.user.id, action: 'Edit access request denied', entity: 'Employee', entityId: employee.id, toValue: reason.slice(0, 200) });
  res.json(withComputed(employee));
});

// Direct HR lock/unlock toggle — no request/reason needed, unlike the employee's
// own unlock-request flow above. Used from the employee list's row actions.
router.patch('/:id/toggle-lock', requirePerm(null, 'hrms', 'Employee Management', 'configure'), async (req, res) => {
  const existing = await prisma.employee.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Employee not found' });
  const nextLocked = !existing.isLocked;
  const hours = grantHours(req.body && req.body.hours);
  const employee = await prisma.employee.update({
    where: { id: req.params.id },
    data: nextLocked
      ? {
        isLocked: true,
        profileStage: PROFILE_STATUS.LOCKED,
        unlockRequestStatus: existing.unlockRequestStatus,
        unlockExpiresAt: null,
      }
      // An HR unlock is bounded and recorded exactly like an approved
      // request, so no route into this state leaves a profile open
      // indefinitely or without a name against it.
      : {
        ...grantEditAccessData({
          actingUser: req.user, hours,
          reason: (req.body && req.body.reason) || 'Unlocked directly by HR',
          section: req.body && req.body.section,
        }),
        unlockRequestStatus: null,
      },
  });
  await logAudit({
    userId: req.user.id, actorName: req.user.name,
    action: nextLocked ? 'Profile locked by HR' : `Profile unlocked by HR for ${hours}h`,
    entity: 'Employee', entityId: employee.id,
    reason: nextLocked ? null : ((req.body && req.body.reason) || 'Unlocked directly by HR'),
  });
  res.json(withComputed(employee));
});

// --- GRANT EDIT ACCESS ------------------------------------------------------
// HR reopening ONE employee's own locked profile, WITHOUT waiting for them to
// ask. Distinct from Edit Scope (Administration -> Users), which changes which
// records a login may reach and never touches a lock. See the note beside
// EDIT_ACCESS_SECTIONS.
//
// Everything the lifecycle asks to be recorded is recorded: which employee,
// which section, the reason, when access starts, when it expires and who
// granted it.
router.post('/:id/grant-edit-access', requirePerm(null, 'hrms', 'Employee Management', 'approve'), async (req, res) => {
  // Reopening a profile is not a turn on an approval chain: a view-only
  // Manager / Assistant Manager may not do it.
  if (isViewOnlyAdmin(req.user) && !(await can(req.user, 'hrms', 'hrms', 'Employee Management', 'edit'))) {
    return res.status(403).json({ error: "This isn't included in your role's permissions" });
  }
  const existing = await prisma.employee.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Employee not found' });
  if (!(await assertInScope(req, existing))) return res.status(403).json({ error: 'This record is outside your department scope' });
  const reason = req.body && req.body.reason ? String(req.body.reason).trim() : '';
  if (!reason) return res.status(400).json({ error: 'Say why you are opening this profile — it goes on the record.' });
  const hours = grantHours(req.body && req.body.hours);
  const section = req.body && req.body.section;
  if (section && !EDIT_ACCESS_SECTIONS.includes(section)) {
    return res.status(400).json({ error: `Unknown section. Choose one of: ${EDIT_ACCESS_SECTIONS.join(', ')}.` });
  }
  const grant = grantEditAccessData({ actingUser: req.user, hours, reason, section });
  const employee = await prisma.employee.update({
    where: { id: req.params.id },
    // THE REQUEST IS SPENT ONCE THE WINDOW IS OPEN. Clearing it is what makes
    // the Unlock button disappear after it has been used — the row moves on to
    // "Edit Access Granted" and the next thing HR sees is the submission.
    data: { ...grant, unlockRequestStatus: null, unlockDecidedAt: new Date() },
  });
  await logAudit({
    userId: req.user.id, actorName: req.user.name,
    action: `Edit access granted for ${hours}h (${grant.unlockGrantSection})`,
    entity: 'Employee', entityId: employee.id,
    fromValue: existing.isLocked ? 'Locked' : profileStatusOf(existing),
    toValue: grant.unlockExpiresAt.toISOString(), reason,
    approvalStatus: 'Approved', approvedByName: req.user.name || null, approvedAt: new Date(),
  });
  res.json({ ...withComputed(employee), grantedHours: hours });
});

// --- THE FIELD-BY-FIELD HISTORY --------------------------------------------
// Employee · Field · Old Value · New Value · Changed By · Changed At ·
// Reason · Approval Status, newest first. Scoped like every other read of an
// employee: a TL sees their own department's history, never the company's.
router.get('/:id/audit', requirePerm(null, 'hrms', 'Employee Management', 'view'), async (req, res) => {
  const employee = await prisma.employee.findUnique({ where: { id: req.params.id } });
  if (!employee) return res.status(404).json({ error: 'Employee not found' });
  if (req.user.caps.hrmsSelfOnly && employee.userId !== req.user.id) {
    return res.status(403).json({ error: "This isn't included in your role's permissions" });
  }
  if (!(await assertInScope(req, employee))) {
    return res.status(403).json({ error: 'This record is outside your department scope' });
  }
  const rows = await prisma.auditLog.findMany({
    where: { entity: 'Employee', entityId: req.params.id },
    include: { user: { select: { name: true, email: true } } },
    orderBy: { createdAt: 'desc' },
    take: 300,
  });
  res.json({
    employee: { id: employee.id, name: employee.name, employeeCode: employee.employeeCode },
    entries: rows.map((r) => ({
      id: r.id,
      field: r.field || null,
      label: r.fieldLabel || r.field || null,
      action: r.action,
      from: r.fromValue,
      to: r.toValue,
      changedBy: r.actorName || (r.user && r.user.name) || 'System',
      changedAt: r.createdAt,
      reason: r.reason || null,
      approvalStatus: r.approvalStatus || null,
      approvedBy: r.approvedByName || null,
      approvedAt: r.approvedAt || null,
    })),
  });
});

// =========================================================================
// EMPLOYEE DOCUMENTS — Aadhaar, PAN, certificates, joining paperwork.
//
// As many as needed per employee, several of one type if that is what the
// person has. The bytes go through utils/attachments.js (allow-listed MIME,
// magic-byte check, server-chosen name in the private upload directory);
// EmployeeDocument keeps the stored name in `file` and the sanitised original
// in `fileName`, for display only.
//
// WHO MAY TOUCH THEM — two doors and no third:
//   * HR / Admin / Super Admin: Employee Management `edit` — the SAME grant
//     that edits the employee — held to the caller's employee scope
//     (utils/scope.js employeeWhere). View, upload and delete.
//   * The employee, on THEIR OWN record only: view and upload always; delete
//     only a document they uploaded themselves, and only while their profile
//     is open to them (not locked, not awaiting review, window not expired).
//     A submitted profile is a submitted profile — its evidence stays put.
// A view-only Manager, a TL without `edit`, or anybody else gets a 403 —
// Aadhaar and PAN copies are not "list" data.
//
// Nothing about a document's CONTENTS is ever logged. The audit row names the
// type, never the file name or anything typed that might carry a number.
// =========================================================================
// The types ('Photo' = the profile photo, images only) live in ONE list,
// shared with the Global Export registry: utils/employeeDocTypes.js.
const {
  PHOTO_DOC_TYPE, DOC_TYPES, OTHER_DOC_TYPE, SENSITIVE_DOC_TYPES, REQUIRED_DOC_TYPES,
} = require('../utils/employeeDocTypes');

// What this caller may do with this employee's documents.
async function documentAccess(req, employee) {
  const self = !!employee.userId && employee.userId === req.user.id;
  const inScope = employeeInScope(req.user, employee);
  const hr = inScope && await can(req.user, 'hrms', 'hrms', 'Employee Management', 'edit');
  // Manager / Assistant Manager: every department, VIEW ONLY — they may open
  // and download the documents on a record they can see, never upload or
  // delete (the POST / DELETE handlers below require `allowed` / `hr`).
  const viewer = !self && !hr && inScope && isViewOnlyAdmin(req.user)
    && await can(req.user, 'hrms', 'hrms', 'Employee Management', 'view');
  return { self, hr, viewer, allowed: self || hr };
}

// The audit wording for a document: its type, and for "Other" the name typed
// for it with any long digit run masked. Never the file name.
function docAuditLabel(doc) {
  if (SENSITIVE_DOC_TYPES.has(doc.docType) || !doc.docName) return doc.docType;
  return `${doc.docType}: ${String(doc.docName).replace(/\d{4,}/g, '••••').slice(0, 80)}`;
}

async function loadForDocuments(req, res, { read = false } = {}) {
  const employee = await prisma.employee.findUnique({ where: { id: req.params.id } });
  if (!employee) { res.status(404).json({ error: 'Employee not found' }); return null; }
  const access = await documentAccess(req, employee);
  if (!access.allowed && !(read && access.viewer)) { res.status(403).json({ error: "This isn't included in your role's permissions" }); return null; }
  return { employee, access };
}

router.get('/:id/documents', async (req, res) => {
  const ctx = await loadForDocuments(req, res, { read: true });
  if (!ctx) return;
  const { employee, access } = ctx;
  const docs = await prisma.employeeDocument.findMany({
    where: { employeeId: employee.id }, orderBy: { uploadedAt: 'desc' },
  });
  // `uploadedBy` holds the uploader's user id (so "their own upload" is a
  // fact, not a name match); the screen is given the name.
  const uploaderIds = [...new Set(docs.map((d) => d.uploadedBy).filter(Boolean))];
  const uploaders = uploaderIds.length
    ? await prisma.user.findMany({ where: { id: { in: uploaderIds } }, select: { id: true, name: true } })
    : [];
  const nameOf = new Map(uploaders.map((u) => [u.id, u.name]));
  // Whether the employee's own form is still open — decides self-delete.
  const selfOpen = !employee.isLocked && !employee.pendingChanges
    && !(employee.unlockExpiresAt && new Date(employee.unlockExpiresAt) < new Date());
  res.json({
    docTypes: DOC_TYPES,
    requiredTypes: REQUIRED_DOC_TYPES,
    maxBytes: attachments.MAX_BYTES,
    allowedTypes: Object.keys(attachments.ALLOWED),
    canUpload: access.allowed,
    documents: docs.map((d) => ({
      id: d.id,
      docType: d.docType,
      docName: d.docName,
      fileName: d.fileName,
      mime: d.mime,
      size: d.size,
      uploadedAt: d.uploadedAt,
      uploadedByName: d.uploadedBy ? (nameOf.get(d.uploadedBy) || 'Unknown user') : null,
      uploadedBySelf: !!d.uploadedBy && d.uploadedBy === employee.userId,
      canDelete: access.hr || (access.self && selfOpen && d.uploadedBy === req.user.id),
    })),
  });
});

// Multipart: docType, docName (required for "Other Documents"), file.
router.post('/:id/documents', async (req, res) => {
  const ctx = await loadForDocuments(req, res);
  if (!ctx) return;
  const { employee } = ctx;

  let parsed;
  try {
    parsed = await attachments.parseMultipart(req);
  } catch (err) {
    return res.status(400).json({ error: attachments.MESSAGE[err.code] || 'Could not read the upload.' });
  }
  const docType = String(parsed.fields.docType || '').trim();
  const docName = String(parsed.fields.docName || '').trim().slice(0, 120) || null;
  if (!DOC_TYPES.includes(docType)) {
    return res.status(400).json({ error: `Choose a document type: ${DOC_TYPES.join(', ')}.` });
  }
  if (docType === OTHER_DOC_TYPE && !docName) {
    return res.status(400).json({ error: 'Give the document a name when the type is Other Documents.' });
  }
  if (docType === PHOTO_DOC_TYPE && !['image/jpeg', 'image/png', 'image/webp'].includes(String((parsed.file && parsed.file.contentType) || ''))) {
    return res.status(400).json({ error: 'A photo must be a JPEG, PNG or WebP image.' });
  }
  // Validated BEFORE anything is written, so a refused form leaves no file.
  let stored;
  try {
    stored = attachments.store(parsed.file);
  } catch (err) {
    return res.status(400).json({ error: attachments.MESSAGE[err.code] || 'Could not store the upload.' });
  }
  let doc;
  try {
    doc = await prisma.employeeDocument.create({
      data: {
        employeeId: employee.id,
        docType,
        docName,
        file: stored.billFile,
        fileName: stored.billName,
        mime: stored.billMime,
        size: stored.billSize,
        uploadedBy: req.user.id,
      },
    });
  } catch (err) {
    // No row, no file: never leave bytes on disk that nothing points at.
    attachments.remove(stored.billFile);
    throw err;
  }
  await logAudit({
    userId: req.user.id, actorName: req.user.name,
    action: 'Employee document uploaded', entity: 'Employee', entityId: employee.id,
    toValue: docAuditLabel(doc),
  });
  return res.status(201).json({
    id: doc.id, docType: doc.docType, docName: doc.docName, fileName: doc.fileName,
    mime: doc.mime, size: doc.size, uploadedAt: doc.uploadedAt,
  });
});

// ?disposition=inline (View) or attachment (Download, the default). The path
// is rebuilt from the stored name only after utils/attachments.js has
// re-validated it, so an id in the URL can never reach another file.
router.get('/:id/documents/:docId/file', async (req, res) => {
  const ctx = await loadForDocuments(req, res, { read: true });
  if (!ctx) return;
  const doc = await prisma.employeeDocument.findUnique({ where: { id: req.params.docId } });
  if (!doc || doc.employeeId !== ctx.employee.id) return res.status(404).json({ error: 'Document not found' });
  const full = attachments.resolveStored(doc.file);
  if (!full) return res.status(404).json({ error: 'The file is no longer on the server' });
  const disposition = req.query.disposition === 'inline' ? 'inline' : 'attachment';
  // Only a type this module allow-listed is ever sent as itself.
  const mime = attachments.ALLOWED[doc.mime] ? doc.mime : 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Disposition', `${disposition}; filename="${attachments.safeDisplayName(doc.fileName)}"`);
  return res.sendFile(full);
});

router.delete('/:id/documents/:docId', async (req, res) => {
  const ctx = await loadForDocuments(req, res);
  if (!ctx) return;
  const { employee, access } = ctx;
  const doc = await prisma.employeeDocument.findUnique({ where: { id: req.params.docId } });
  if (!doc || doc.employeeId !== employee.id) return res.status(404).json({ error: 'Document not found' });
  if (!access.hr) {
    // The employee's own door: their own upload, while the form is theirs.
    if (doc.uploadedBy !== req.user.id) {
      return res.status(403).json({ error: 'Only HR can remove a document HR added to your record.' });
    }
    if (employee.pendingChanges) {
      return res.status(403).json({ error: 'Your profile is awaiting HR review, so its documents cannot be removed now.' });
    }
    const gate = await enforceEditWindow(employee);
    if (!gate.allowed) return res.status(403).json({ error: gate.error });
  }
  await prisma.employeeDocument.delete({ where: { id: doc.id } });
  attachments.remove(doc.file);
  await logAudit({
    userId: req.user.id, actorName: req.user.name,
    action: 'Employee document deleted', entity: 'Employee', entityId: employee.id,
    fromValue: docAuditLabel(doc),
  });
  return res.json({ ok: true });
});

// Pause/resume — toggles Active <-> On Probation, mirroring the reference app's
// row-level Pause button (used e.g. to pause someone during a review).
router.patch('/:id/toggle-pause', requirePerm(null, 'hrms', 'Employee Management', 'configure'), async (req, res) => {
  const existing = await prisma.employee.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Employee not found' });
  const nextStatus = existing.employmentStatus === 'On Probation' ? 'Active' : 'On Probation';
  const employee = await prisma.employee.update({ where: { id: req.params.id }, data: { employmentStatus: nextStatus } });
  await logAudit({ userId: req.user.id, action: 'Employee status toggled', entity: 'Employee', entityId: employee.id, fromValue: existing.employmentStatus, toValue: nextStatus });
  res.json(withComputed(employee));
});

// Transfer an employee to a new department, keeping a note in the audit trail.
router.post('/:id/transfer', requirePerm(null, 'hrms', 'Employee Management', 'assign'), async (req, res) => {
  const { department, team, reason } = req.body;
  if (!department) return res.status(400).json({ error: 'department is required' });
  const existing = await prisma.employee.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Employee not found' });
  const employee = await prisma.employee.update({ where: { id: req.params.id }, data: { department, team: team || null } });
  // THE LOGIN MOVES WITH THE PERSON. Without this the HR record said IT while
  // the ATS scope still pointed at Medical — the same employee reading the old
  // desk's requirements, candidates and clients.
  const moved = await syncLoginToEmployee(employee, existing);
  if (moved) {
    await logAudit({
      userId: req.user.id, actorName: req.user.name, action: 'Login scope followed transfer',
      entity: 'User', entityId: employee.userId, toValue: moved.changes.join('; ').slice(0, 200),
    });
  }
  await logAudit({ userId: req.user.id, action: 'Employee transferred' + (reason ? ` (${reason})` : ''), entity: 'Employee', entityId: employee.id, fromValue: existing.department, toValue: department });
  res.json(withComputed(employee));
});

// Onboarding checklist
router.patch('/:id/onboarding/:index', requirePerm(null, 'hrms', 'Employee Management', 'edit'), async (req, res) => {
  const employee = await prisma.employee.findUnique({ where: { id: req.params.id } });
  if (!employee) return res.status(404).json({ error: 'Employee not found' });
  if (!(await assertInScope(req, employee))) return res.status(403).json({ error: 'This record is outside your department scope' });
  const tasks = employee.onboardingTasks ? JSON.parse(employee.onboardingTasks) : DEFAULT_ONBOARDING_TASKS.map((task) => ({ task, completed: false }));
  const idx = Number(req.params.index);
  if (!tasks[idx]) return res.status(400).json({ error: 'Invalid task index' });
  tasks[idx].completed = !tasks[idx].completed;
  const updated = await prisma.employee.update({ where: { id: req.params.id }, data: { onboardingTasks: JSON.stringify(tasks) } });
  res.json(withComputed(updated));
});

// Offboarding
router.post('/:id/offboarding', requirePerm(null, 'hrms', 'Employee Management', 'edit'), async (req, res) => {
  const employee = await prisma.employee.findUnique({ where: { id: req.params.id } });
  if (!employee) return res.status(404).json({ error: 'Employee not found' });
  if (!(await assertInScope(req, employee))) return res.status(403).json({ error: 'This record is outside your department scope' });
  if (employee.offboardingStatus) return res.status(400).json({ error: 'Offboarding already in progress for this employee' });
  const updated = await prisma.employee.update({
    where: { id: req.params.id },
    data: {
      offboardingStatus: 'Serving Notice',
      offboardingTasks: JSON.stringify(DEFAULT_OFFBOARDING_TASKS.map((task) => ({ task, completed: false }))),
      employmentStatus: 'Notice Period',
    },
  });
  await logAudit({ userId: req.user.id, action: 'Offboarding initiated', entity: 'Employee', entityId: employee.id, fromValue: employee.employmentStatus, toValue: 'Notice Period' });
  res.json(withComputed(updated));
});

router.patch('/:id/offboarding/:index', requirePerm(null, 'hrms', 'Employee Management', 'edit'), async (req, res) => {
  const employee = await prisma.employee.findUnique({ where: { id: req.params.id } });
  if (!employee || !employee.offboardingTasks) return res.status(400).json({ error: 'No offboarding in progress' });
  if (!(await assertInScope(req, employee))) return res.status(403).json({ error: 'This record is outside your department scope' });
  const tasks = JSON.parse(employee.offboardingTasks);
  const idx = Number(req.params.index);
  if (!tasks[idx]) return res.status(400).json({ error: 'Invalid task index' });
  tasks[idx].completed = !tasks[idx].completed;
  const allDone = tasks.every((t) => t.completed);
  const data = { offboardingTasks: JSON.stringify(tasks), offboardingStatus: allDone ? 'Cleared' : 'Serving Notice' };
  if (allDone) data.employmentStatus = 'Relieved';
  const updated = await prisma.employee.update({ where: { id: req.params.id }, data });
  if (allDone) {
    await prisma.fnfRequest.create({ data: { employeeId: employee.id, lastWorkingDate: new Date().toISOString().slice(0, 10) } });
    await logAudit({ userId: req.user.id, action: 'Offboarding cleared', entity: 'Employee', entityId: employee.id, toValue: 'Relieved' });
  }
  res.json(withComputed(updated));
});

// --- Bulk import: Sample Excel -> Upload -> Check -> Import VALID rows -------
//
// The file, the sample workbook and every check are defined ONCE, in
// utils/employeeBulkImport.js (IMPORT_FIELDS), so "Download Sample Excel"
// can never ask for a column the importer ignores.
//
//   1. SAMPLE   GET  /bulk-import/sample.xlsx — the Employees sheet with the
//               real headers and two EXAMPLE- rows (always skipped), and an
//               Instructions sheet: required marks, the departments in the
//               importer's scope, the ACTIVE roles (Role & Permission
//               Management), designations, employment types, statuses and
//               the date format.
//   2. CHECK    POST /bulk-import/preview — the uploaded .xlsx / .csv (raw
//               body) or pasted CSV rows (JSON). Row-wise errors; writes
//               nothing.
//   3. IMPORT   POST /bulk-import — imports ONLY the rows that pass. Each row
//               is its own transaction, so one bad row never takes the others
//               with it. Returns imported / failed / skipped counts and a
//               downloadable summary workbook (failed rows + reasons).
//
// Scope: a department-scoped importer may only import into their own
// departments, and a reporting manager must be somebody they can see.
// ONE PERSON = ONE LOGIN: an email already on an employee or a login is
// refused. NO PASSWORD is generated: logins (only when asked) get a
// single-use set-password link, exactly like Add Employee.
const bulkImport = require('../utils/employeeBulkImport');

const rawUpload = express.raw({
  type: ['application/octet-stream', 'text/csv', 'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  limit: '10mb',
});

function importContext(req, createLogins) {
  const scopeDepts = scopeDepartments(req);
  return {
    scopeDepts,
    globalImporter: scopeDepts === undefined,
    createLogins,
    // Reporting managers: people this importer can see, never Super Admin.
    managerWhere: withoutSystemAccounts(departmentWhere(req)),
    designationFilter: (rows) => addEmployeeDesignations(req, rows),
  };
}

async function readImportRequest(req) {
  const isFile = Buffer.isBuffer(req.body) && req.body.length > 0;
  const createLogins = isFile ? String(req.query.createLogins) === 'true' : !!(req.body && req.body.createLogins === true);
  let rows;
  let fileName = '';
  if (isFile) {
    fileName = String(req.query.fileName || 'upload.xlsx').slice(0, 200);
    const parsed = bulkImport.parseUpload(req.body, fileName);
    if (parsed.error) return { error: parsed.error };
    rows = parsed.rows;
  } else if (req.body && Array.isArray(req.body.rows)) {
    rows = bulkImport.rowsFromObjects(req.body.rows);
  } else {
    return { error: 'Upload an .xlsx or .csv file (or paste CSV rows).' };
  }
  if (!rows.length) return { error: 'That file has no data rows.' };
  if (rows.length > bulkImport.MAX_ROWS) return { error: `Import at most ${bulkImport.MAX_ROWS} rows at a time.` };
  const { errors, prepared, skipped } = await bulkImport.validateRows(rows, importContext(req, createLogins));
  return { rows, errors, prepared, skipped, createLogins, fileName, scopeLabel: scopeLabel(req) };
}

// The fields and option lists, for the screen's own instructions.
router.get('/bulk-import/fields', requirePerm(null, 'hrms', 'Employee Management', 'create'), async (req, res) => {
  const opts = await bulkImport.optionLists(importContext(req, false));
  res.json({
    fields: bulkImport.IMPORT_FIELDS.map(({ key, label, required, rule }) => ({ key, label, required, rule })),
    examplePrefix: bulkImport.EXAMPLE_PREFIX,
    maxRows: bulkImport.MAX_ROWS,
    departments: opts.departments,
    roles: opts.roles,
    designations: opts.designations,
    employmentTypes: opts.employmentTypes,
    statuses: opts.statuses,
  });
});

// STEP 1 — the sample workbook, built from IMPORT_FIELDS and the live masters.
router.get('/bulk-import/sample.xlsx', requirePerm(null, 'hrms', 'Employee Management', 'create'), async (req, res) => {
  const opts = await bulkImport.optionLists(importContext(req, false));
  const buf = bulkImport.sampleWorkbook(opts);
  res.setHeader('Content-Disposition', 'attachment; filename="employee-import-sample.xlsx"');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// STEP 2 — the check. Read-only: it writes nothing, ever.
router.post('/bulk-import/preview', rawUpload, requirePerm(null, 'hrms', 'Employee Management', 'create'), async (req, res) => {
  const parsed = await readImportRequest(req);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  res.json({ ...bulkImport.previewPayload(parsed), preview: true });
});

// STEP 3 — import the valid rows.
router.post('/bulk-import', rawUpload, requirePerm(null, 'hrms', 'Employee Management', 'create'), async (req, res) => {
  const parsed = await readImportRequest(req);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const preview = bulkImport.previewPayload(parsed);
  // `validateOnly` is the old dry-run flag; it returns the preview.
  if (req.body && req.body.validateOnly === true) return res.json({ ...preview, validateOnly: true, preview: true, written: 0 });

  const { imported, failedRows, invites, skipped } = preview.validCount > 0
    ? await bulkImport.importRows({
      prepared: parsed.prepared,
      errors: parsed.errors,
      skipped: parsed.skipped,
      createLogins: parsed.createLogins,
      req,
      profileIncomplete: PROFILE_STATUS.INCOMPLETE,
      onboardingTasks: DEFAULT_ONBOARDING_TASKS,
    })
    : {
      imported: [],
      failedRows: parsed.prepared.filter((p) => !p.valid).map((p) => ({
        row: p.line,
        values: bulkImport.IMPORT_FIELDS.reduce((o, f) => ({ ...o, [f.key]: String(p.raw[f.key] || '') }), {}),
        reasons: parsed.errors.filter((e) => e.line === p.line).map((e) => `${e.field}: ${e.message}`),
      })),
      invites: [],
      skipped: parsed.skipped,
    };

  const summary = bulkImport.summaryWorkbook({
    imported, failedRows, skipped, fileName: parsed.fileName, by: req.user.name || req.user.email,
  });
  await notifyDataIo(req, { kind: 'import', module: 'Employee Management', count: parsed.rows.length, created: imported.length, updated: 0, skipped: failedRows.length + skipped.length, what: 'employee records (bulk create)', detail: `file ${parsed.fileName || 'pasted CSV'}` });
  await logAudit({
    userId: req.user.id, actorName: req.user.name, action: 'Bulk import run', entity: 'Employee',
    toValue: `${imported.length} imported, ${failedRows.length} failed, ${skipped.length} skipped`
      + `${parsed.createLogins ? `, ${invites.length} login(s) created` : ''}; file: ${parsed.fileName || 'pasted CSV'}; scope: ${scopeLabel(req)}`,
  });
  const status = imported.length ? 200 : 422;
  res.status(status).json({
    ok: imported.length > 0,
    written: imported.length,
    imported: imported.length,
    failed: failedRows.length,
    skipped: skipped.length,
    rowCount: parsed.rows.length,
    importedRows: imported.map(({ row, employeeCode, name, email, userId }) => ({ row, employeeCode, name, email, loginCreated: !!userId })),
    failedRows,
    skippedRows: skipped,
    invalid: parsed.errors,
    errors: parsed.errors,
    createLogins: parsed.createLogins,
    invites,
    summaryFile: {
      name: `employee-import-summary-${new Date().toISOString().slice(0, 10)}.xlsx`,
      base64: summary.toString('base64'),
    },
    message: `${imported.length} employee(s) imported, ${failedRows.length} row(s) failed`
      + `${skipped.length ? `, ${skipped.length} example row(s) skipped` : ''}.`
      + (parsed.createLogins
        ? ` ${invites.filter((i) => i.sent).length} sign-in link(s) emailed — no password was generated or sent.`
        : (imported.length ? ' No logins were created — send sign-in details per employee once you have checked the records.' : '')),
  });
});

module.exports = router;
