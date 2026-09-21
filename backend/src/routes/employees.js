const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { scopeOf } = require('../utils/scope');
const { logAudit } = require('../utils/audit');

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

const UNLOCK_REQUEST_LIMIT = 3;
const UNLOCK_REQUEST_REASONS = [
  'Incorrect information entered', 'Address changed', 'Bank details need update',
  'Contact number changed', 'Name correction needed', 'Other',
];

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
  res.json({ unlockRequestLimit: UNLOCK_REQUEST_LIMIT, unlockRequestReasons: UNLOCK_REQUEST_REASONS });
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
  if (employee.isLocked) return res.status(403).json({ error: 'Your profile is locked. Request edit access from HR to make further changes.' });
  if (employee.pendingChanges) return res.status(409).json({ error: 'Your last submission is still awaiting HR review.' });

  const changes = [];
  for (const [field, label] of Object.entries(SELF_SERVICE_FIELDS)) {
    if (req.body[field] !== undefined && req.body[field] !== (employee[field] || '')) {
      changes.push({ field, label, from: employee[field] || '', to: req.body[field] });
    }
  }
  if (changes.length === 0) return res.status(400).json({ error: 'No changes to submit' });

  const updated = await prisma.employee.update({
    where: { id: employee.id },
    data: { pendingChanges: JSON.stringify(changes), profileStage: 'Pending Review' },
  });
  await logAudit({ userId: req.user.id, action: 'Profile submitted for review', entity: 'Employee', entityId: employee.id });
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
  if (role && password) {
    if (!email) return res.status(400).json({ error: 'email is required to create a login account' });
    const passwordHash = await bcrypt.hash(password, 10);
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
  res.status(201).json(withComputed(employee));
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
  const changes = JSON.parse(employee.pendingChanges);
  const data = { pendingChanges: null, isLocked: true, profileStage: 'Locked' };
  changes.forEach((c) => { data[c.field] = c.to; });
  const updated = await prisma.employee.update({ where: { id: req.params.id }, data });
  await logAudit({ userId: req.user.id, action: 'Profile changes approved — profile locked', entity: 'Employee', entityId: employee.id });
  res.json(withComputed(updated));
});

router.patch('/:id/changes/reject', requirePerm(null, 'hrms', 'Employee Management', 'approve'), async (req, res) => {
  const existing = await prisma.employee.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Employee not found' });
  const employee = await prisma.employee.update({ where: { id: req.params.id }, data: { pendingChanges: null, profileStage: 'Assigned' } });
  await logAudit({ userId: req.user.id, action: 'Profile changes sent back for edit', entity: 'Employee', entityId: employee.id });
  res.json(withComputed(employee));
});

// HR decides an employee's request to unlock their (already-approved) profile.
router.patch('/:id/unlock-request/approve', requirePerm(null, 'hrms', 'Employee Management', 'approve'), async (req, res) => {
  const employee = await prisma.employee.findUnique({ where: { id: req.params.id } });
  if (!employee || employee.unlockRequestStatus !== 'Pending') return res.status(400).json({ error: 'No pending unlock request' });
  const updated = await prisma.employee.update({
    where: { id: req.params.id },
    data: { isLocked: false, unlockRequestStatus: 'Approved', profileStage: 'Assigned' },
  });
  await logAudit({ userId: req.user.id, action: 'Edit access granted', entity: 'Employee', entityId: employee.id });
  res.json(withComputed(updated));
});

router.patch('/:id/unlock-request/reject', requirePerm(null, 'hrms', 'Employee Management', 'approve'), async (req, res) => {
  const existing = await prisma.employee.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Employee not found' });
  const employee = await prisma.employee.update({ where: { id: req.params.id }, data: { unlockRequestStatus: 'Rejected' } });
  await logAudit({ userId: req.user.id, action: 'Edit access request denied', entity: 'Employee', entityId: employee.id });
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
    data: { isLocked: nextLocked, profileStage: nextLocked ? 'Locked' : 'Assigned', unlockRequestStatus: nextLocked ? existing.unlockRequestStatus : null },
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

// Bulk import — CSV rows already parsed client-side into objects.
router.post('/bulk-import', requirePerm(null, 'hrms', 'Employee Management', 'create'), async (req, res) => {
  const rows = req.body.rows;
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows must be an array' });
  let imported = 0, skipped = 0;
  let seq = await prisma.employee.count();
  const scopedDept = await scopeDepartment(req);
  for (const r of rows) {
    if (!r.name) { skipped++; continue; }
    if (r.email) {
      const dup = await prisma.employee.findFirst({ where: { email: r.email } });
      if (dup) { skipped++; continue; }
    }
    seq += 1;
    await prisma.employee.create({
      data: {
        employeeCode: 'EMP-' + String(seq).padStart(4, '0'),
        name: r.name, email: r.email || null, phone: r.phone || null,
        department: scopedDept !== undefined ? scopedDept : (r.department || null), designation: r.designation || null, location: r.location || null,
        onboardingTasks: JSON.stringify(DEFAULT_ONBOARDING_TASKS.map((task) => ({ task, completed: false }))),
      },
    });
    imported++;
  }
  await logAudit({ userId: req.user.id, action: 'Bulk import run', entity: 'Employee', toValue: `${imported} imported, ${skipped} skipped` });
  res.json({ imported, skipped });
});

module.exports = router;
