const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../db');
const { requireAuth, requirePerm, can } = require('../middleware/auth');
const { scopeOf } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const { sendCredentials, unguessablePasswordHash } = require('../utils/employeeInvite');

const ROLE_BY_DESIGNATION = {
  'Super Admin': 'SUPER_ADMIN', 'HR Admin': 'ADMIN', 'Manager': 'MANAGER', 'Assistant Manager': 'ASSISTANT_MANAGER',
  'Senior Team Lead (STL)': 'STL', 'Team Lead (TL)': 'TL', 'Employee (Self-Service)': 'EMPLOYEE', 'Accountant': 'ACCOUNTANT',
};

const router = express.Router();
router.use(requireAuth);

// STL/TL are themselves employees, scoped to their own department only. Manager
// and Assistant Manager have cross-department oversight (see Role Catalog) so
// they get the same unrestricted, company-wide visibility as Super Admin/Admin —
// including the full Department dropdown when adding an employee.
// Department scoping now comes from the resolved identity's scope, so an
// STL with several departments really gets several departments.

// Returns the requesting user's own department when their role is department-scoped,
// or undefined when they have unrestricted (Super Admin/Admin) access.
async function scopeDepartment(req) {
  const s = scopeOf(req.user);
  if (s.global) return undefined;
  return s.departments[0] || '__no_department_assigned__';
}

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
      data: { isLocked: true, profileStage: 'Locked', unlockExpiresAt: null },
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
  return {
    ...e,
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
      profileStage: 'Pending Review',
      // Submitting SPENDS the granted edit window — see UNLOCK_WINDOW_HOURS.
      unlockExpiresAt: null,
      // The previous decision is history now; the banner should show this
      // submission's state, not the last one's verdict.
      reviewDecision: null, reviewNote: null, reviewedAt: null, reviewedByName: null,
    },
  });
  await logAudit({ userId: req.user.id, action: 'Profile submitted for review', entity: 'Employee', entityId: employee.id, toValue: `${changes.length} field(s)` });
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
  const where = {};
  const scopedDept = await scopeDepartment(req);
  if (scopedDept !== undefined) where.department = scopedDept;

  const [submitted, unlocks] = await Promise.all([
    prisma.employee.findMany({ where: { ...where, pendingChanges: { not: null } }, orderBy: { updatedAt: 'asc' } }),
    prisma.employee.findMany({ where: { ...where, unlockRequestStatus: 'Pending' }, orderBy: { updatedAt: 'asc' } }),
  ]);
  res.json({
    scope: scopedDept === undefined ? 'All departments' : scopedDept,
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
  ['profileStage', 'Profile Stage'], ['profileCompletionPct', 'Profile Completion %'],
  ['credentialsSentStatus', 'Sign-in Email'],
];

// RFC 4180 quoting. A field is quoted when it holds a comma, a quote or a
// newline, and an embedded quote is doubled — so a designation like
// 'Engineer, Senior' cannot shift every later column.
function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

router.get('/export.csv', requirePerm(null, 'hrms', 'Employee Management', 'export'), async (req, res) => {
  const where = {};
  const scopedDept = await scopeDepartment(req);
  if (scopedDept !== undefined) where.department = scopedDept;
  else if (req.query.department) where.department = req.query.department;
  if (req.query.employmentStatus) where.employmentStatus = req.query.employmentStatus;

  const employees = await prisma.employee.findMany({
    where, include: { reportingManager: { select: { name: true } } }, orderBy: { name: 'asc' },
  });
  const rows = employees.map((e) => {
    const c = withComputed(e);
    c.reportingManagerName = e.reportingManager ? e.reportingManager.name : '';
    c.dateOfJoining = e.dateOfJoining ? new Date(e.dateOfJoining).toISOString().slice(0, 10) : '';
    return EXPORT_COLUMNS.map(([key]) => csvCell(c[key])).join(',');
  });
  const csv = [EXPORT_COLUMNS.map(([, label]) => csvCell(label)).join(','), ...rows].join('\r\n');

  await logAudit({
    userId: req.user.id, action: 'Employee list exported', entity: 'Employee',
    toValue: `${employees.length} row(s), scope: ${scopedDept === undefined ? 'all departments' : scopedDept}`,
  });
  const stamp = new Date().toISOString().slice(0, 10);
  const suffix = scopedDept === undefined ? 'all' : String(scopedDept).replace(/[^\w-]+/g, '-').toLowerCase();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="employees-${suffix}-${stamp}.csv"`);
  res.send(csv);
});

router.get('/', requirePerm(null, 'hrms', 'Employee Management', 'view'), async (req, res) => {
  const where = {};
  if (req.query.employmentStatus) where.employmentStatus = req.query.employmentStatus;
  const scopedDept = await scopeDepartment(req);
  if (scopedDept !== undefined) {
    where.department = scopedDept; // department-scoped role: always restricted to their own department
  } else if (req.query.department) {
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

// Creates the employee record and — when a role + password are supplied — their
// login account together, in one step (matching the reference app's combined flow).
router.post('/', requirePerm(null, 'hrms', 'Employee Management', 'create'), async (req, res) => {
  let { employeeCode, department } = req.body;
  const { name, email, phone, team, designation, location, dateOfJoining, dateOfBirth, gender, employeeType, role, password, branch } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!employeeCode) {
    const count = await prisma.employee.count();
    employeeCode = 'EMP-' + String(count + 1).padStart(4, '0');
  }
  const scopedDept = await scopeDepartment(req);
  if (scopedDept !== undefined) department = scopedDept; // department-scoped role: can only add to their own department

  let userId = null;
  if (role) {
    if (!email) return res.status(400).json({ error: 'email is required to create a login account' });
    // A password may still be supplied (an internal relay-less deployment),
    // but the default and the recommended path is NO password at all: the
    // account gets an unguessable hash and the employee sets their own
    // through the single-use link the credentials email carries.
    const passwordHash = password ? await bcrypt.hash(password, 10) : await unguessablePasswordHash();
    const user = await prisma.user.create({ data: { name, email, passwordHash, role } });
    userId = user.id;
  }

  const employee = await prisma.employee.create({
    data: {
      employeeCode, name, email, phone, department, team, designation, location, gender, employeeType, branch, userId,
      dateOfJoining: dateOfJoining ? new Date(dateOfJoining) : null,
      dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
      onboardingTasks: JSON.stringify(DEFAULT_ONBOARDING_TASKS.map((task) => ({ task, completed: false }))),
    },
  });
  await logAudit({ userId: req.user.id, action: 'Employee created' + (userId ? ' with login account' : ''), entity: 'Employee', entityId: employee.id });

  // Sign-in details, from the acting HR user's own address. The result is
  // handed back verbatim so the screen can say "not sent — no provider"
  // instead of implying the employee has been told.
  let credentials = null;
  if (userId) {
    credentials = await sendCredentials({ employee, userId, actingUser: req.user, req });
    await logAudit({ userId: req.user.id, action: `Sign-in details: ${credentials.status}`, entity: 'Employee', entityId: employee.id });
  }
  const fresh = await prisma.employee.findUnique({ where: { id: employee.id } });
  res.status(201).json({ ...withComputed(fresh), credentials });
});

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
    userId: req.user.id, action: 'Profile changes approved — profile locked', entity: 'Employee',
    entityId: employee.id, toValue: `${changes.length} field(s) applied`,
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
      profileStage: 'Assigned',
      isLocked: false,
      reviewDecision: 'Rejected',
      reviewNote: reason.slice(0, 500),
      reviewedAt: new Date(),
      reviewedByName: req.user.name || null,
    },
  });
  await logAudit({ userId: req.user.id, action: 'Profile changes sent back for edit', entity: 'Employee', entityId: employee.id, toValue: reason.slice(0, 200) });
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
  const hours = Number(req.body && req.body.hours) > 0
    ? Math.min(Number(req.body.hours), 24 * 14)
    : UNLOCK_WINDOW_HOURS;
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
  const updated = await prisma.employee.update({
    where: { id: req.params.id },
    data: {
      isLocked: false,
      unlockRequestStatus: 'Approved',
      profileStage: 'Assigned',
      unlockExpiresAt: expiresAt,
      unlockDecidedAt: new Date(),
      unlockDecisionNote: (req.body && req.body.note) ? String(req.body.note).slice(0, 500) : null,
    },
  });
  await logAudit({
    userId: req.user.id, action: `Edit access granted for ${hours}h`, entity: 'Employee',
    entityId: employee.id, toValue: expiresAt.toISOString(),
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
  const employee = await prisma.employee.update({
    where: { id: req.params.id },
    data: {
      isLocked: nextLocked,
      profileStage: nextLocked ? 'Locked' : 'Assigned',
      unlockRequestStatus: nextLocked ? existing.unlockRequestStatus : null,
      // An HR unlock is bounded exactly like an approved request, so no route
      // into this state leaves a profile open indefinitely.
      unlockExpiresAt: nextLocked ? null : new Date(Date.now() + UNLOCK_WINDOW_HOURS * 60 * 60 * 1000),
    },
  });
  await logAudit({ userId: req.user.id, action: nextLocked ? 'Profile locked by HR' : 'Profile unlocked by HR', entity: 'Employee', entityId: employee.id });
  res.json(withComputed(employee));
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

// --- Bulk import ------------------------------------------------------------
// ALL OR NOTHING. Every row is validated against the database and against the
// rest of the file BEFORE a single write happens; if any row fails, nothing is
// written and the caller gets the line number and the reason for each failure.
// A half-applied employee master is worse than a rejected file.
//
// The importer's data scope is enforced here too: a department-scoped caller
// (TL/STL) may only create employees in their own department, and a row naming
// another one is an ERROR rather than being silently rewritten — quietly
// moving somebody's department is exactly the kind of thing an import should
// not do behind your back.
//
// Import never creates logins. Sign-in details are issued deliberately, one
// employee at a time, through POST /:id/send-credentials once HR has checked
// the record — so a CSV can never mint accounts for a department the importer
// cannot see.
const IMPORT_COLUMNS = ['name', 'email', 'phone', 'department', 'designation', 'location'];

function normalizeImportRow(raw) {
  const row = {};
  IMPORT_COLUMNS.forEach((k) => { row[k] = raw[k] === undefined || raw[k] === null ? '' : String(raw[k]).trim(); });
  return row;
}

async function validateImport(rows, { scopedDept, allowedDepartments }) {
  const errors = [];
  const emailsSeen = new Map();
  const phonesSeen = new Map();
  const prepared = [];

  const fileEmails = rows.map((r) => r.email).filter(Boolean);
  const filePhones = rows.map((r) => r.phone).filter(Boolean);
  const [emailClashes, phoneClashes] = await Promise.all([
    fileEmails.length ? prisma.employee.findMany({ where: { email: { in: fileEmails } }, select: { email: true, name: true, employeeCode: true } }) : [],
    filePhones.length ? prisma.employee.findMany({ where: { phone: { in: filePhones } }, select: { phone: true, name: true, employeeCode: true } }) : [],
  ]);
  const byEmail = new Map(emailClashes.map((e) => [String(e.email).toLowerCase(), e]));
  const byPhone = new Map(phoneClashes.map((e) => [String(e.phone), e]));

  rows.forEach((row, i) => {
    // Line 1 is the header, so the first data row is line 2 — which is the
    // line number the person's spreadsheet is showing them.
    const line = i + 2;
    const fail = (message) => errors.push({ line, message, name: row.name || '' });

    if (!row.name) fail('Name is required.');
    if (row.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(row.email)) fail(`"${row.email}" is not a valid email address.`);
    if (row.phone && !/^\d{10}$/.test(row.phone.replace(/\s/g, ''))) fail(`Mobile "${row.phone}" should be 10 digits.`);

    if (row.email) {
      const key = row.email.toLowerCase();
      if (emailsSeen.has(key)) fail(`Email ${row.email} also appears on line ${emailsSeen.get(key)} of this file.`);
      else emailsSeen.set(key, line);
      const clash = byEmail.get(key);
      if (clash) fail(`Email ${row.email} already belongs to ${clash.name} (${clash.employeeCode}).`);
    }
    if (row.phone) {
      if (phonesSeen.has(row.phone)) fail(`Mobile ${row.phone} also appears on line ${phonesSeen.get(row.phone)} of this file.`);
      else phonesSeen.set(row.phone, line);
      const clash = byPhone.get(row.phone);
      if (clash) fail(`Mobile ${row.phone} already belongs to ${clash.name} (${clash.employeeCode}).`);
    }

    let department = row.department || null;
    if (scopedDept !== undefined) {
      if (department && department !== scopedDept) {
        fail(`You can only import into ${scopedDept}; this row says "${department}".`);
      }
      department = scopedDept;
    } else if (department && allowedDepartments.length && !allowedDepartments.includes(department)) {
      fail(`"${department}" is not a department in this organisation.`);
    }

    prepared.push({ ...row, department });
  });

  return { errors, prepared };
}

router.post('/bulk-import', requirePerm(null, 'hrms', 'Employee Management', 'create'), async (req, res) => {
  const raw = req.body.rows;
  if (!Array.isArray(raw)) return res.status(400).json({ error: 'rows must be an array' });
  if (!raw.length) return res.status(400).json({ error: 'That file has no data rows.' });
  if (raw.length > 1000) return res.status(400).json({ error: 'Import at most 1000 rows at a time.' });
  const dryRun = req.body.validateOnly === true;

  const rows = raw.map(normalizeImportRow);
  const scopedDept = await scopeDepartment(req);
  const departments = await prisma.department.findMany({ select: { name: true } });
  const { errors, prepared } = await validateImport(rows, {
    scopedDept,
    allowedDepartments: departments.map((d) => d.name),
  });

  if (errors.length) {
    await logAudit({
      userId: req.user.id, action: 'Bulk import rejected', entity: 'Employee',
      toValue: `${rows.length} row(s) read, ${errors.length} error(s), nothing written`,
    });
    return res.status(422).json({
      ok: false,
      written: 0,
      rowCount: rows.length,
      errors,
      message: `Nothing was imported. ${errors.length} problem(s) across ${rows.length} row(s) — fix the file and try again.`,
    });
  }

  if (dryRun) {
    return res.json({ ok: true, written: 0, rowCount: rows.length, errors: [], validateOnly: true, message: `${rows.length} row(s) look good.` });
  }

  // One transaction: either every row lands or none does.
  const seq = await prisma.employee.count();
  const creates = prepared.map((r, i) => prisma.employee.create({
    data: {
      employeeCode: 'EMP-' + String(seq + i + 1).padStart(4, '0'),
      name: r.name,
      email: r.email || null,
      phone: r.phone || null,
      department: r.department,
      designation: r.designation || null,
      location: r.location || null,
      onboardingTasks: JSON.stringify(DEFAULT_ONBOARDING_TASKS.map((task) => ({ task, completed: false }))),
    },
  }));
  try {
    await prisma.$transaction(creates);
  } catch (err) {
    await logAudit({ userId: req.user.id, action: 'Bulk import failed — rolled back', entity: 'Employee', toValue: String(err.message || err).slice(0, 200) });
    return res.status(409).json({
      ok: false, written: 0, rowCount: rows.length,
      errors: [{ line: 0, message: `The database refused the file, so nothing was written: ${String(err.message || err).slice(0, 200)}` }],
      message: 'Nothing was imported.',
    });
  }

  await logAudit({
    userId: req.user.id, action: 'Bulk import run', entity: 'Employee',
    toValue: `${prepared.length} imported into ${scopedDept === undefined ? 'their own departments' : scopedDept}`,
  });
  res.json({
    ok: true,
    written: prepared.length,
    rowCount: rows.length,
    errors: [],
    // Kept for older callers that read `imported`. Nothing is ever "skipped"
    // now — a row either imports or the whole file is refused.
    imported: prepared.length,
    skipped: 0,
    message: `${prepared.length} employee(s) imported. No logins were created — send sign-in details per employee once you've checked the records.`,
  });
});

module.exports = router;
