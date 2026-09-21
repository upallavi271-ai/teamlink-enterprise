const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);


// Notice Period is where a resignation starts; Relieved and Withdrawn are terminal.
const STATUSES = ['Notice Period', 'Accepted', 'Relieved', 'Withdrawn'];
const TERMINAL = ['Relieved', 'Withdrawn'];

// The same checklist drives the offboarding tracker on each employee's record.
const EXIT_CHECKLIST = [
  'Exit interview scheduled',
  'Assets returned',
  'Access revoked',
  'Full & final settlement processed',
  'Experience letter issued',
];

const DAY_MS = 86400000;

async function noticePeriodDays() {
  let cfg = await prisma.hrConfig.findFirst();
  if (!cfg) cfg = await prisma.hrConfig.create({ data: {} });
  return cfg.noticePeriodDays;
}

// Last working day = the resignation date plus the configured notice period, in
// calendar days (weekends and holidays are not excluded).
function noticeEnd(fromDate, days) {
  const d = new Date(fromDate);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// Calendar days still to serve; negative once the last working day has passed.
function daysLeft(lastWorkingDate) {
  const lwd = new Date(lastWorkingDate);
  if (Number.isNaN(lwd.getTime())) return null;
  const today = new Date(new Date().toISOString().slice(0, 10));
  return Math.ceil((lwd - today) / DAY_MS);
}

// An employee's employment status mirrors the resignation: relieving ends the
// employment, withdrawing puts them back to Active, everything else is notice.
function employmentStatusFor(status) {
  if (status === 'Relieved') return 'Relieved';
  if (status === 'Withdrawn') return 'Active';
  return 'Notice Period';
}

function present(record, days) {
  return {
    ...record,
    reason: record.title,
    notes: record.detail,
    lastWorkingDate: record.date,
    daysLeft: record.date ? daysLeft(record.date) : null,
    noticePeriodDays: days,
    submittedAt: record.createdAt,
  };
}

router.get('/', async (req, res) => {
  const where = { type: 'RESIGNATION' };
  if (req.user.caps.hrmsSelfOnly) {
    const own = await prisma.employee.findUnique({ where: { userId: req.user.id } });
    if (!own) return res.json([]);
    where.employeeId = own.id;
  } else if (req.query.employeeId) {
    where.employeeId = req.query.employeeId;
  }
  if (req.query.status) where.status = req.query.status;
  const [records, days] = await Promise.all([
    prisma.employeeRecord.findMany({ where, include: { employee: true }, orderBy: { createdAt: 'desc' } }),
    noticePeriodDays(),
  ]);
  res.json(records.map((r) => present(r, days)));
});

// Summary for the Resignation screen: how many are serving notice, how many have
// been relieved, the configured notice period and the standard exit checklist.
router.get('/summary', requirePerm(null, 'hrms', 'Employee Services', 'export'), async (req, res) => {
  const [records, days] = await Promise.all([
    prisma.employeeRecord.findMany({ where: { type: 'RESIGNATION' } }),
    noticePeriodDays(),
  ]);
  res.json({
    servingNotice: records.filter((r) => !TERMINAL.includes(r.status)).length,
    relieved: records.filter((r) => r.status === 'Relieved').length,
    withdrawn: records.filter((r) => r.status === 'Withdrawn').length,
    noticePeriodDays: days,
    exitChecklist: EXIT_CHECKLIST,
  });
});

// Submitting a resignation computes the last working day from the notice period
// (an HR user may override it) and puts the employee on notice.
router.post('/', async (req, res) => {
  const { title, detail, date, resignationDate } = req.body;
  let employeeId = req.body.employeeId;
  if (req.user.caps.hrmsSelfOnly) {
    const own = await prisma.employee.findUnique({ where: { userId: req.user.id } });
    if (!own) return res.status(404).json({ error: 'No employee record linked to this account' });
    employeeId = own.id;
  }
  if (!employeeId) return res.status(400).json({ error: 'employeeId is required' });
  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee) return res.status(404).json({ error: 'Employee not found' });

  const days = await noticePeriodDays();
  const from = resignationDate || new Date().toISOString().slice(0, 10);
  // HR may set an agreed last working day; otherwise it is resignation date + notice.
  const lastWorkingDate = (!req.user.caps.hrmsSelfOnly && date) ? date : noticeEnd(from, days);

  const record = await prisma.employeeRecord.create({
    data: { type: 'RESIGNATION', employeeId, title: title || 'Resignation', detail, date: lastWorkingDate, status: 'Notice Period' },
  });
  await prisma.employee.update({ where: { id: employeeId }, data: { employmentStatus: 'Notice Period', offboardingStatus: 'Serving Notice' } });
  await logAudit({ userId: req.user.id, action: 'Resignation recorded', entity: 'EmployeeRecord', entityId: record.id, fromValue: employee.employmentStatus, toValue: 'Notice Period' });
  res.status(201).json(present(record, days));
});

router.patch('/:id/status', requirePerm(null, 'hrms', 'Employee Services', 'approve'), async (req, res) => {
  const { status } = req.body;
  if (!STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  const existing = await prisma.employeeRecord.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.type !== 'RESIGNATION') return res.status(404).json({ error: 'Resignation not found' });
  if (TERMINAL.includes(existing.status)) return res.status(409).json({ error: `A ${existing.status.toLowerCase()} resignation can no longer be changed.` });

  const record = await prisma.employeeRecord.update({ where: { id: req.params.id }, data: { status } });
  await prisma.employee.update({
    where: { id: existing.employeeId },
    data: {
      employmentStatus: employmentStatusFor(status),
      offboardingStatus: status === 'Relieved' ? 'Cleared' : status === 'Withdrawn' ? null : 'Serving Notice',
    },
  });

  // Relieving raises the Full & Final settlement request the Payroll screen acts on.
  if (status === 'Relieved') {
    const open = await prisma.fnfRequest.findFirst({ where: { employeeId: existing.employeeId, status: 'Pending' } });
    if (!open) await prisma.fnfRequest.create({ data: { employeeId: existing.employeeId, lastWorkingDate: existing.date || new Date().toISOString().slice(0, 10) } });
  }

  await logAudit({ userId: req.user.id, action: `Resignation ${status}`, entity: 'EmployeeRecord', entityId: record.id, fromValue: existing.status, toValue: status });
  const days = await noticePeriodDays();
  res.json(present(record, days));
});

// Agreeing a different last working day (early release or an extension).
router.patch('/:id', requirePerm(null, 'hrms', 'Employee Services', 'approve'), async (req, res) => {
  const { date, detail } = req.body;
  const existing = await prisma.employeeRecord.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.type !== 'RESIGNATION') return res.status(404).json({ error: 'Resignation not found' });
  const record = await prisma.employeeRecord.update({
    where: { id: req.params.id },
    data: { date: date !== undefined ? date : undefined, detail: detail !== undefined ? detail : undefined },
  });
  await logAudit({ userId: req.user.id, action: 'Last working day updated', entity: 'EmployeeRecord', entityId: record.id, fromValue: existing.date, toValue: record.date });
  const days = await noticePeriodDays();
  res.json(present(record, days));
});

module.exports = router;
