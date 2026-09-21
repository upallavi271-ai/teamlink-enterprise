const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const prisma = require('../db');
const { requireAuth, requirePerm, can } = require('../middleware/auth');
const {
  scopeOf,
  scopeDepartments: scopeDepartmentsOf,
  departmentWhere: departmentWhereOf,
  scopeLabel: scopeLabelOf,
  clientWhere,
} = require('../utils/scope');
const { logAudit, logFieldChanges, resolveFieldApprovals } = require('../utils/audit');
const { sendCredentials, unguessablePasswordHash } = require('../utils/employeeInvite');
// The designation -> role / product-access mapping. DATA in the
// DesignationRole table, never a switch statement here: the same "TL" row
// serves Medical, IT and everyone else, because the DEPARTMENT is the scope.
const { mappingFor } = require('../utils/identity');
const { toCsv, toXlsx, toPdf } = require('../utils/tabularExport');
// Employee administration — the shared vocabulary the Employee Management
// surface below and the Administration → Users screen both read. Moved out of
// routes/admin.js with the routes; see utils/employeeAdmin.js for why.
const {
  ALL_ROLES, EMAIL_RE, normalEmail,
  designationRows, defaultProductAccessByRole, loginRoleFor, productRolesForDesignation,
  EMP_MGMT_INCLUDE, shapeEmployeeMgmtRow,
  OTP_TTL_MINUTES, OTP_MAX_ATTEMPTS, OTP_PURPOSE, hashOtp, liveVerification,
} = require('../utils/employeeAdmin');
const { CATALOG_ROLES } = require('../utils/roleAccess');
const {
  EMP_TYPES, EMP_STATUSES, EMP_GENDERS, EMP_MGMT_STATUS_FILTER,
} = require('../utils/adminCatalog');
const { DEPTS, LOCS } = require('../utils/atsVocab');
const mailer = require('../utils/mailer');
const { senderIdentity } = require('../utils/candidateComms');

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
const departmentWhere = (req) => departmentWhereOf(req.user);
const scopeLabel = (req) => scopeLabelOf(req.user);

async function assertInScope(req, employee) {
  const s = scopeOf(req.user);
  if (s.global) return true;
  if (!s.departments.length) return false;
  return s.departments.includes(employee.department);
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
  res.json(withComputed(employee));
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
  if (changes.length === 0) return res.status(400).json({ error: 'No changes to submit' });

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
    entity: 'Employee', entityId: employee.id, toValue: `${changes.length} field(s)`,
  });
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
];

// ONE query, ONE scope decision, THREE formats. CSV, Excel and PDF all come
// out of buildExport() below, so a new format can never be the one that
// forgets the department filter or the `export` permission.
async function buildExport(req) {
  const where = departmentWhere(req);
  if (scopeDepartments(req) === undefined && req.query.department) where.department = req.query.department;
  if (req.query.employmentStatus) where.employmentStatus = req.query.employmentStatus;

  const employees = await prisma.employee.findMany({
    where, include: { reportingManager: { select: { name: true } } }, orderBy: { name: 'asc' },
  });
  const rows = employees.map((e) => {
    const c = withComputed(e);
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

router.get('/management', requirePerm(null, 'hrms', 'Employee Management', 'view'), async (req, res) => {
  const where = departmentWhere(req);
  if (req.query.employmentStatus) where.employmentStatus = req.query.employmentStatus;
  if (scopeDepartments(req) === undefined && req.query.department) where.department = req.query.department;
  const employees = await prisma.employee.findMany({
    where, include: EMP_MGMT_INCLUDE, orderBy: { name: 'asc' },
  });
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
    },
    rows: employees.map(shapeEmployeeMgmtRow),
  });
});

// Every option list the Add Employee modal, the filter row and the Edit Scope
// editor render — one call, so the screen never has to reach into
// /api/admin/* for a lookup it is no longer allowed to make.
router.get('/management/options', requirePerm(null, 'hrms', 'Employee Management', 'view'), async (req, res) => {
  const [employees, departments, rows, count, cfg, clients] = await Promise.all([
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
    prisma.employee.count(),
    mailer.emailConfig(),
    prisma.client.findMany({ where: clientWhere(req.user), select: { id: true, name: true }, orderBy: { name: 'asc' } }).catch(() => []),
  ]);
  // The department and location pickers are CREATABLE (both columns are plain
  // strings by design), so a value typed into Add Employee is not in the
  // Department master table. Union the master list with the values on file.
  const inUse = (key) => employees.map((e) => e[key]).filter(Boolean);
  const union = (base, used) => [...new Set([...base, ...used])].sort((a, b) => a.localeCompare(b));
  const masterDepts = departments.length ? departments.map((d) => d.name) : DEPTS;
  const allowed = scopeDepartments(req);

  let nextEmployeeCode = `EMP-${String(count + 1).padStart(4, '0')}`;
  // eslint-disable-next-line no-await-in-loop
  while (await prisma.employee.findUnique({ where: { employeeCode: nextEmployeeCode } })) {
    nextEmployeeCode = `EMP-${String(Number(nextEmployeeCode.slice(4)) + 1).padStart(4, '0')}`;
  }

  res.json({
    nextEmployeeCode,
    scope: scopeLabel(req),
    empTypes: EMP_TYPES,
    empStatuses: EMP_STATUSES,
    genders: EMP_GENDERS,
    statusFilter: EMP_MGMT_STATUS_FILTER,
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
    roles: CATALOG_ROLES,
    // Straight off the DesignationRole table — this is the Role / Designation
    // picker, and each row says what that designation will actually grant.
    designations: rows.map((r) => ({
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
  });
});

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
  const designation = String(b.designation || '').trim();
  const phone = b.phone ? String(b.phone).trim() : '';
  const wantedCode = String(b.employeeId || b.employeeCode || '').trim();
  const password = String(b.password || '');

  if (!name) return res.status(400).json({ error: 'Enter the full name.' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'That email does not look right.' });
  if (!String(b.department || '').trim()) return res.status(400).json({ error: 'Select a department.' });
  if (!designation) return res.status(400).json({ error: 'Select a role / designation.' });
  if (phone && !/^\d{10}$/.test(phone.replace(/\s/g, ''))) {
    return res.status(400).json({ error: 'Mobile should be 10 digits.' });
  }
  if (password && password.length < 6) {
    return res.status(400).json({ error: 'A login password must be at least 6 characters — or leave it empty for a set-password link.' });
  }
  if (b.role && !ALL_ROLES.includes(b.role)) return res.status(400).json({ error: 'Unknown role' });

  const deptCheck = assertDepartmentAllowed(req, String(b.department).trim());
  if (!deptCheck.ok) return res.status(403).json({ error: deptCheck.error });
  const department = deptCheck.department;

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

  // THE EMAIL GATE. Where a channel exists the address must have been proved
  // by a code; where none exists we say so and go ahead unverified rather than
  // pretending a code was ever sent.
  const cfg = await mailer.emailConfig();
  let verification = null;
  if (cfg.configured) {
    verification = await liveVerification(email);
    if (!verification || !verification.verifiedAt) {
      return res.status(400).json({
        error: 'Verify this email first — send the code with Send OTP and enter it.',
      });
    }
  }

  // Employee ID: the one typed, or the next free EMP-nnnn.
  let employeeCode = wantedCode;
  if (employeeCode) {
    if (await prisma.employee.findUnique({ where: { employeeCode } })) {
      return res.status(409).json({ error: `Employee ID ${employeeCode} is already taken.` });
    }
  } else {
    const count = await prisma.employee.count();
    employeeCode = `EMP-${String(count + 1).padStart(4, '0')}`;
    // eslint-disable-next-line no-await-in-loop
    while (await prisma.employee.findUnique({ where: { employeeCode } })) {
      employeeCode = `EMP-${String(Number(employeeCode.slice(4)) + 1).padStart(4, '0')}`;
    }
  }

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
      role,
      username: email,
      status: 'Active',
      branch: b.location || null,
      team,
      atsDepartment: department,
      // All three product roles, derived from the designation mapping.
      ...productRolesForDesignation(mapping),
      atsScopeDepartments: department,
      atsScopeTeams: team,
      hrmsAccess: mapping ? !!mapping.hrms : true,
      atsAccess: mapping ? !!mapping.ats : false,
      accountsAccess: mapping ? !!mapping.accounts : false,
      landingWorkspace: (mapping && mapping.landing) || null,
    },
  });

  const employee = await prisma.employee.create({
    data: {
      employeeCode,
      name,
      email,
      phone: phone || null,
      department,
      designation,
      team,
      location: b.location || null,
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
    },
    include: EMP_MGMT_INCLUDE,
  });

  if (verification) {
    await prisma.emailVerification.update({ where: { id: verification.id }, data: { consumedAt: new Date() } });
  }
  // The password is never echoed back and never logged.
  await logAudit({
    userId: req.user.id,
    action: `Employee and login created${verification ? ' (email verified by code)' : ' (email unverified — no SMTP channel)'}`,
    entity: 'Employee',
    entityId: employee.id,
    toValue: `${employeeCode} · ${designation} · ${role} · scope ${department}`,
  });

  // Sign-in details: a single-use, expiring set-password link from the acting
  // HR user's own address. NEVER a password in a mail body. The result travels
  // back verbatim so the screen can say "not sent — no provider" rather than
  // implying the employee was told.
  const credentials = await sendCredentials({ employee, userId: user.id, actingUser: req.user, req });
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
    emailVerified: !!verification,
    emailChannel: cfg.configured
      ? 'verified by one-time code'
      : `not verified — no email channel is configured (${cfg.reason})`,
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

router.post('/management/:id/reset-password', requirePerm(null, 'hrms', 'Employee Management', 'edit'), async (req, res) => {
  const { password } = req.body || {};
  if (!password || String(password).length < 6) return res.status(400).json({ error: 'A password of at least 6 characters is required' });
  const employee = await prisma.employee.findUnique({ where: { id: req.params.id }, include: { user: true } });
  if (!employee) return res.status(404).json({ error: 'Employee not found' });
  if (!(await assertInScope(req, employee))) return res.status(403).json({ error: 'This record is outside your department scope' });
  if (!employee.user) return res.status(404).json({ error: 'That employee has no login yet.' });
  await prisma.user.update({ where: { id: employee.user.id }, data: { passwordHash: await bcrypt.hash(String(password), 10) } });
  // The new password is never echoed back or logged.
  await logAudit({ userId: req.user.id, action: 'Password reset', entity: 'User', entityId: employee.user.id, toValue: 'Reset' });
  res.json({ ok: true });
});

// Assign Roles — product access on the SAME login, plus the reporting chain.
router.put('/management/:id/roles', requirePerm(null, 'hrms', 'Employee Management', 'edit'), async (req, res) => {
  const { role, atsDepartment, stl, tl } = req.body || {};
  const employee = await prisma.employee.findUnique({ where: { id: req.params.id }, include: { user: true } });
  if (!employee) return res.status(404).json({ error: 'Employee not found' });
  if (!(await assertInScope(req, employee))) return res.status(403).json({ error: 'This record is outside your department scope' });
  if (!employee.user) return res.status(400).json({ error: 'Create a login for this employee first.' });
  if (role && !ALL_ROLES.includes(role)) return res.status(400).json({ error: 'Unknown role' });

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
  res.json({
    ...shapeEmployeeMgmtRow(employee),
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
  const employees = await prisma.employee.findMany({ where, include: { reportingManager: true }, orderBy: { name: 'asc' } });
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
    include: { reportingManager: true, user: { select: { id: true, name: true, email: true, role: true } }, salaryStructure: true },
  });
  if (!employee) return res.status(404).json({ error: 'Employee not found' });
  if (req.user.caps.hrmsSelfOnly && employee.userId !== req.user.id) {
    return res.status(403).json({ error: "This isn't included in your role's permissions" });
  }
  if (!(await assertInScope(req, employee))) {
    return res.status(403).json({ error: 'This record is outside your department scope' });
  }
  res.json(withComputed(employee));
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
router.put('/:id', requirePerm(null, 'hrms', 'Employee Management', 'configure'), async (req, res) => {
  const existingForScope = await prisma.employee.findUnique({ where: { id: req.params.id } });
  if (!existingForScope) return res.status(404).json({ error: 'Employee not found' });
  const editableFields = [
    'name', 'email', 'phone', 'department', 'team', 'designation', 'location', 'employmentStatus', 'employeeType',
    'emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelation', 'address', 'addressType',
    'addressLine1', 'addressLine2', 'city', 'district', 'state', 'country', 'postalCode', 'bloodGroup',
    'branch', 'shift', 'employmentExperience', 'educationDetails', 'skills',
    'bankName', 'bankAccountNumber', 'ifscCode', 'panNumber', 'aadhaarNumber', 'uanNumber', 'pfNumber', 'esiNumber',
  ];
  const data = {};
  editableFields.forEach((f) => { if (req.body[f] !== undefined) data[f] = req.body[f]; });
  delete data.department; // move departments only via /transfer, which keeps an audit trail
  const employee = await prisma.employee.update({ where: { id: req.params.id }, data });
  await logAudit({ userId: req.user.id, action: 'Employee updated', entity: 'Employee', entityId: employee.id });
  res.json(withComputed(employee));
});

// Permanently removes an employee record and everything hanging off it
// (attendance, leave, payslips, reviews, etc.) — Super Admin/Admin only.
router.delete('/:id', requirePerm(null, 'hrms', 'Employee Management', 'delete'), async (req, res) => {
  const existing = await prisma.employee.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Employee not found' });
  await prisma.$transaction([
    prisma.employee.updateMany({ where: { reportingManagerId: req.params.id }, data: { reportingManagerId: null } }),
    prisma.employeeRecord.deleteMany({ where: { employeeId: req.params.id } }),
    prisma.attendance.deleteMany({ where: { employeeId: req.params.id } }),
    prisma.attendanceRegularization.deleteMany({ where: { employeeId: req.params.id } }),
    prisma.leaveRequest.deleteMany({ where: { employeeId: req.params.id } }),
    prisma.payslip.deleteMany({ where: { employeeId: req.params.id } }),
    prisma.salaryStructure.deleteMany({ where: { employeeId: req.params.id } }),
    prisma.fnfRequest.deleteMany({ where: { employeeId: req.params.id } }),
    prisma.performanceReview.deleteMany({ where: { employeeId: req.params.id } }),
    prisma.courseAssignment.deleteMany({ where: { employeeId: req.params.id } }),
    prisma.projectAssignment.deleteMany({ where: { employeeId: req.params.id } }),
    prisma.surveyResponse.deleteMany({ where: { employeeId: req.params.id } }),
    prisma.acknowledgment.deleteMany({ where: { employeeId: req.params.id } }),
    prisma.employee.delete({ where: { id: req.params.id } }),
  ]);
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

// HR decides an employee's request to unlock their (already-approved) profile.
// Approving grants a BOUNDED window — see UNLOCK_WINDOW_HOURS. It is not a
// return to the un-reviewed state: the employee edits, submits, HR approves,
// and the profile locks again.
router.patch('/:id/unlock-request/approve', requirePerm(null, 'hrms', 'Employee Management', 'approve'), async (req, res) => {
  const employee = await prisma.employee.findUnique({ where: { id: req.params.id } });
  if (!employee || employee.unlockRequestStatus !== 'Pending') return res.status(400).json({ error: 'No pending unlock request' });
  if (!(await assertInScope(req, employee))) return res.status(403).json({ error: 'This record is outside your department scope' });
  // Configurable, not a blanket 48 hours: HR types the window, picks the
  // section and gives a reason, and all of it is recorded on the employee.
  const hours = grantHours(req.body && req.body.hours);
  const note = (req.body && req.body.note) ? String(req.body.note).slice(0, 500) : null;
  const grant = grantEditAccessData({
    actingUser: req.user, hours, section: req.body && req.body.section,
    reason: note || employee.unlockRequestReason,
  });
  const updated = await prisma.employee.update({
    where: { id: req.params.id },
    data: {
      ...grant,
      unlockRequestStatus: 'Approved',
      unlockDecidedAt: new Date(),
      unlockDecisionNote: note,
    },
  });
  await logAudit({
    userId: req.user.id, actorName: req.user.name,
    action: `Edit access granted for ${hours}h (${grant.unlockGrantSection})`,
    entity: 'Employee', entityId: employee.id,
    fromValue: 'Locked', toValue: grant.unlockExpiresAt.toISOString(),
    reason: grant.unlockGrantReason, approvalStatus: 'Approved', approvedByName: req.user.name || null, approvedAt: new Date(),
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
    data: { ...grant, unlockRequestStatus: existing.unlockRequestStatus === 'Pending' ? 'Approved' : null, unlockDecidedAt: new Date() },
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

// --- Bulk import: Validate -> Preview -> Confirm -> Import -------------------
//
// THREE STEPS, NOT ONE.
//   1. VALIDATE  every row, against the database and against the rest of the
//      file, before anything is written.
//   2. PREVIEW   the split: Valid Records and Invalid Records, each invalid
//      row naming the Row number, the Field, the Error and what was expected
//      (e.g. "Row 8 - Department - Invalid department - one of IT, HR, ...").
//      HR sees exactly what will land before agreeing to it.
//   3. CONFIRM   and import, in ONE transaction. Still all-or-nothing: a
//      half-applied employee master is worse than a rejected file.
//
// The importer's data scope is enforced here too: a department-scoped caller
// (TL/STL) may only create employees in a department they hold, and a row
// naming another one is an ERROR rather than being silently rewritten —
// quietly moving somebody's department is exactly the kind of thing an import
// should not do behind your back.
//
// LOGINS. The lifecycle requires an imported employee to keep the
//   Employee -> User -> Login -> Product Access -> Role -> Scope
// relationship wherever the workflow needs login access, so the import DOES
// create logins when asked (`createLogins`). It does it the same way the Add
// Employee form does and with the same safety:
//   * role and product access are DERIVED from the designation through the
//     DesignationRole table — never typed, never department-qualified;
//   * data scope is the employee's department;
//   * NO PASSWORD IS EVER GENERATED OR EMAILED. Each new login gets an
//     unguessable hash and a single-use, expiring set-password link, exactly
//     like POST /employees.
// A caller who cannot see a department cannot import into it, so a CSV can
// never mint accounts somewhere the importer has no reach.
const IMPORT_COLUMNS = ['name', 'email', 'phone', 'department', 'designation', 'location'];

function normalizeImportRow(raw) {
  const row = {};
  IMPORT_COLUMNS.forEach((k) => { row[k] = raw[k] === undefined || raw[k] === null ? '' : String(raw[k]).trim(); });
  return row;
}

async function validateImport(rows, { allowedDepartments, scopeDepts, createLogins, designations }) {
  const errors = [];
  const emailsSeen = new Map();
  const phonesSeen = new Map();
  const prepared = [];

  const fileEmails = rows.map((r) => r.email).filter(Boolean);
  const filePhones = rows.map((r) => r.phone).filter(Boolean);
  const [emailClashes, phoneClashes, userClashes] = await Promise.all([
    fileEmails.length ? prisma.employee.findMany({ where: { email: { in: fileEmails } }, select: { email: true, name: true, employeeCode: true } }) : [],
    filePhones.length ? prisma.employee.findMany({ where: { phone: { in: filePhones } }, select: { phone: true, name: true, employeeCode: true } }) : [],
    fileEmails.length ? prisma.user.findMany({ where: { email: { in: fileEmails } }, select: { email: true, name: true } }) : [],
  ]);
  const byEmail = new Map(emailClashes.map((e) => [String(e.email).toLowerCase(), e]));
  const byPhone = new Map(phoneClashes.map((e) => [String(e.phone), e]));
  const byUser = new Map(userClashes.map((u) => [String(u.email).toLowerCase(), u]));

  const deptList = allowedDepartments.join(', ');

  rows.forEach((row, i) => {
    // Line 1 is the header, so the first data row is line 2 — which is the
    // line number the person's spreadsheet is showing them.
    const line = i + 2;
    const before = errors.length;
    // Field + expected value, so the preview can say
    // "Row 8 — Department — Invalid department — one of IT, HR, ...".
    const fail = (field, message, expected) => errors.push({
      line, row: line, field, message, expected: expected || '', name: row.name || '',
    });

    if (!row.name) fail('Name', 'Name is required.', 'a full name');
    if (row.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(row.email)) {
      fail('Email', `"${row.email}" is not a valid email address.`, 'name@example.com');
    }
    if (row.phone && !/^\d{10}$/.test(row.phone.replace(/\s/g, ''))) {
      fail('Mobile', `Mobile "${row.phone}" should be 10 digits.`, '10 digits, e.g. 9876543210');
    }

    if (row.email) {
      const key = row.email.toLowerCase();
      if (emailsSeen.has(key)) fail('Email', `Email ${row.email} also appears on line ${emailsSeen.get(key)} of this file.`, 'a unique email address');
      else emailsSeen.set(key, line);
      const clash = byEmail.get(key);
      if (clash) fail('Email', `Email ${row.email} already belongs to ${clash.name} (${clash.employeeCode}).`, 'an email not already on an employee');
      const userClash = byUser.get(key);
      if (userClash && createLogins) fail('Email', `${row.email} already has a login (${userClash.name}).`, 'an email with no existing login');
    }
    if (row.phone) {
      if (phonesSeen.has(row.phone)) fail('Mobile', `Mobile ${row.phone} also appears on line ${phonesSeen.get(row.phone)} of this file.`, 'a unique mobile number');
      else phonesSeen.set(row.phone, line);
      const clash = byPhone.get(row.phone);
      if (clash) fail('Mobile', `Mobile ${row.phone} already belongs to ${clash.name} (${clash.employeeCode}).`, 'a mobile not already on an employee');
    }

    let department = row.department || null;
    if (scopeDepts !== undefined) {
      if (department && !scopeDepts.includes(department)) {
        fail('Department', `Outside your scope — you can only import into ${scopeDepts.join(', ')}.`, scopeDepts.join(' or '));
      }
      if (!department) department = scopeDepts[0];
    } else if (department && allowedDepartments.length && !allowedDepartments.includes(department)) {
      fail('Department', 'Invalid department', `one of ${deptList}`);
    }

    // A login needs an email and a designation the DesignationRole table
    // knows, because that is what supplies the role and the product access.
    let mapping = null;
    if (createLogins) {
      if (!row.email) fail('Email', 'A login cannot be created without an email address.', 'name@example.com');
      if (!row.designation) fail('Designation', 'A designation is required to derive the role and product access.', `one of ${designations.join(', ')}`);
      else {
        mapping = designations.find((d) => d.toLowerCase() === row.designation.toLowerCase()) || null;
        if (!mapping) fail('Designation', `"${row.designation}" is not a designation this organisation maps to a role.`, `one of ${designations.join(', ')}`);
      }
    }

    prepared.push({ ...row, department, line, valid: errors.length === before });
  });

  return { errors, prepared };
}

// Shared by the preview and the import, so the preview can never describe a
// different file from the one that lands.
async function readImportRequest(req) {
  const raw = req.body.rows;
  if (!Array.isArray(raw)) return { error: 'rows must be an array' };
  if (!raw.length) return { error: 'That file has no data rows.' };
  if (raw.length > 1000) return { error: 'Import at most 1000 rows at a time.' };

  const rows = raw.map(normalizeImportRow);
  const scopeDepts = scopeDepartments(req);
  const [departments, designationRows] = await Promise.all([
    prisma.department.findMany({ select: { name: true }, orderBy: { name: 'asc' } }),
    prisma.designationRole.findMany({ select: { designation: true }, orderBy: { designation: 'asc' } }),
  ]);
  const createLogins = req.body.createLogins === true;
  const { errors, prepared } = await validateImport(rows, {
    allowedDepartments: departments.map((d) => d.name),
    scopeDepts,
    createLogins,
    designations: designationRows.map((d) => d.designation),
  });
  return { rows, errors, prepared, createLogins, scopeDepts };
}

function previewPayload({ rows, errors, prepared, createLogins, scopeDepts }) {
  const invalidLines = new Set(errors.map((e) => e.line));
  const valid = prepared.filter((r) => !invalidLines.has(r.line)).map((r) => ({
    row: r.line,
    name: r.name,
    email: r.email || '',
    phone: r.phone || '',
    department: r.department || '',
    designation: r.designation || '',
    location: r.location || '',
    willCreateLogin: createLogins && !!r.email,
  }));
  return {
    ok: errors.length === 0,
    rowCount: rows.length,
    validCount: valid.length,
    invalidCount: invalidLines.size,
    valid,
    invalid: errors,
    errors, // the older shape, kept so nothing that already reads it breaks
    createLogins,
    scope: scopeDepts === undefined ? 'All departments' : scopeDepts.join(', '),
    canImport: errors.length === 0 && valid.length > 0,
    message: errors.length
      ? `${errors.length} problem(s) across ${rows.length} row(s). Nothing will be imported until every row passes.`
      : `${valid.length} row(s) ready to import${createLogins ? ' with logins' : ''}.`,
  };
}

// STEP 2 — the preview. Read-only: it writes nothing, ever.
router.post('/bulk-import/preview', requirePerm(null, 'hrms', 'Employee Management', 'create'), async (req, res) => {
  const parsed = await readImportRequest(req);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  res.json({ ...previewPayload(parsed), preview: true });
});

// STEP 3 — confirm and import.
router.post('/bulk-import', requirePerm(null, 'hrms', 'Employee Management', 'create'), async (req, res) => {
  const parsed = await readImportRequest(req);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const { rows, errors, prepared, createLogins } = parsed;

  // `validateOnly` is the old dry-run flag; it now returns the full preview.
  if (req.body.validateOnly === true) {
    return res.json({ ...previewPayload(parsed), validateOnly: true, preview: true, written: 0 });
  }

  if (errors.length) {
    await logAudit({
      userId: req.user.id, actorName: req.user.name, action: 'Bulk import rejected', entity: 'Employee',
      toValue: `${rows.length} row(s) read, ${errors.length} error(s), nothing written`,
    });
    return res.status(422).json({
      ...previewPayload(parsed),
      written: 0,
      message: `Nothing was imported. ${errors.length} problem(s) across ${rows.length} row(s) — fix the file and try again.`,
    });
  }

  // Employee codes are allocated up front and checked against the database,
  // so a gap in the sequence cannot collide with an existing record.
  const taken = new Set((await prisma.employee.findMany({ select: { employeeCode: true } })).map((e) => e.employeeCode));
  let next = taken.size + 1;
  const codeFor = () => {
    let code = `EMP-${String(next).padStart(4, '0')}`;
    while (taken.has(code)) { next += 1; code = `EMP-${String(next).padStart(4, '0')}`; }
    taken.add(code);
    next += 1;
    return code;
  };
  const plan = prepared.map((r) => ({ ...r, employeeCode: codeFor() }));

  // Role and product access are DERIVED from the designation, so an imported
  // "TL" in Medical is role TL scoped to Medical — never a "Medical TL".
  const mappings = new Map();
  if (createLogins) {
    // eslint-disable-next-line no-restricted-syntax
    for (const r of plan) {
      if (!mappings.has(r.designation)) {
        // eslint-disable-next-line no-await-in-loop
        mappings.set(r.designation, await mappingFor(r.designation));
      }
    }
  }

  let created = [];
  try {
    // ONE transaction: either every row lands or none does. Interactive,
    // because a login and its employee record must be created together and
    // the employee needs the user's id.
    created = await prisma.$transaction(async (tx) => {
      const out = [];
      // eslint-disable-next-line no-restricted-syntax
      for (const r of plan) {
        let userId = null;
        if (createLogins && r.email) {
          const mapping = mappings.get(r.designation) || null;
          const atsRole = mapping && mapping.atsRole ? mapping.atsRole : null;
          const role = atsRole || (mapping && mapping.accounts && !mapping.ats ? 'ACCOUNTANT' : 'EMPLOYEE');
          // eslint-disable-next-line no-await-in-loop
          const user = await tx.user.create({
            data: {
              name: r.name,
              email: r.email,
              // NEVER a generated password that somebody then has to email.
              // eslint-disable-next-line no-await-in-loop
              passwordHash: await unguessablePasswordHash(),
              role,
              username: r.email,
              status: 'Active',
              atsDepartment: r.department || null,
              ...productRolesForDesignation(mapping),
              atsScopeDepartments: r.department || null,
              hrmsAccess: mapping ? !!mapping.hrms : true,
              atsAccess: mapping ? !!mapping.ats : false,
              accountsAccess: mapping ? !!mapping.accounts : false,
              landingWorkspace: (mapping && mapping.landing) || null,
            },
          });
          userId = user.id;
        }
        // eslint-disable-next-line no-await-in-loop
        const employee = await tx.employee.create({
          data: {
            employeeCode: r.employeeCode,
            name: r.name,
            email: r.email || null,
            phone: r.phone || null,
            department: r.department,
            designation: r.designation || null,
            location: r.location || null,
            userId,
            profileStage: PROFILE_STATUS.INCOMPLETE,
            onboardingTasks: JSON.stringify(DEFAULT_ONBOARDING_TASKS.map((task) => ({ task, completed: false }))),
          },
        });
        out.push({ employee, userId });
      }
      return out;
    }, { timeout: 120000 });
  } catch (err) {
    await logAudit({
      userId: req.user.id, actorName: req.user.name, action: 'Bulk import failed — rolled back',
      entity: 'Employee', toValue: String(err.message || err).slice(0, 200),
    });
    return res.status(409).json({
      ok: false, written: 0, rowCount: rows.length, validCount: 0, invalidCount: rows.length, valid: [],
      invalid: [{ line: 0, row: 0, field: '', message: `The database refused the file, so nothing was written: ${String(err.message || err).slice(0, 200)}`, expected: '' }],
      errors: [{ line: 0, message: `The database refused the file, so nothing was written: ${String(err.message || err).slice(0, 200)}` }],
      message: 'Nothing was imported.',
    });
  }

  // The invitations go out AFTER the transaction commits, one at a time and
  // each one guarded: a mail failure must not roll back employees that are
  // already saved, and it must not reject into the process.
  const invites = [];
  if (createLogins) {
    // eslint-disable-next-line no-restricted-syntax
    for (const { employee, userId } of created) {
      if (!userId) continue;
      let outcome;
      try {
        // eslint-disable-next-line no-await-in-loop
        outcome = await sendCredentials({ employee, userId, actingUser: req.user, req });
      } catch (err) {
        outcome = { sent: false, status: `Failed: ${String(err.message || err).slice(0, 200)}` };
      }
      invites.push({ name: employee.name, email: employee.email, status: outcome.status, sent: !!outcome.sent, link: outcome.link || null });
    }
  }

  await logAudit({
    userId: req.user.id, actorName: req.user.name, action: 'Bulk import run', entity: 'Employee',
    toValue: `${created.length} imported${createLogins ? `, ${invites.length} login(s) created` : ''}, scope: ${scopeLabel(req)}`,
  });
  res.json({
    ok: true,
    written: created.length,
    rowCount: rows.length,
    validCount: created.length,
    invalidCount: 0,
    valid: [],
    invalid: [],
    errors: [],
    // Kept for older callers that read `imported`.
    imported: created.length,
    skipped: 0,
    createLogins,
    invites,
    message: createLogins
      ? `${created.length} employee(s) imported with logins. ${invites.filter((i) => i.sent).length} sign-in link(s) emailed — no password was generated or sent.`
      : `${created.length} employee(s) imported. No logins were created — send sign-in details per employee once you've checked the records.`,
  });
});

module.exports = router;
