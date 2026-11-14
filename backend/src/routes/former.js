// ---------------------------------------------------------------------------
// FORMER EMPLOYEE SHELL API (founder, 2026-10-15). Mounted at /api/former. See utils/formerAccess.js.
// A Relieved / Exited employee keeps a LIMITED login (founder 2026-11-14): only to download their own attendance, leave
// records, offer letter and joining letter - nothing else (the exact allow-list is utils/formerAccess.js pathAllowed).
// Everything is read from the SIGNED-IN person's own employee id; an id in the URL can never reach another
// person's letter, and attendance / leave exports take no employee id at all.
//
//   GET /me                       { person, letters[] (Offer Letter / Joining Letter only), message }
//   GET /letters/:docId/file      own offer / joining letter download
//   GET /attendance/export        own attendance, day by day, joining date to last working day (?from ?to ?format=xlsx|csv)
//   GET /leaves/export            own leave requests (?format=xlsx|csv)
//   (Admin side, not for former employees)
//   GET /settings  PUT /settings  how long they keep this access (Admin / Super Admin change; HR desk reads)
//   POST /employee/:employeeId/switch-off  | /switch-on   Admin / Super Admin / HR desk, audited
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const former = require('../utils/formerAccess');
const exitDate = require('../utils/exitDate');
const attachments = require('../utils/attachments');
const AD = require('../utils/attendanceDays');
const { toCsv, toXlsx } = require('../utils/tabularExport');
const { notifyDataIo } = require('../utils/dataIoNotify');

const router = express.Router();
router.use(requireAuth);

const plain = (res, status, error) => res.status(status).json({ error });
const isFormer = (req) => !!(req.user && req.user.formerAccess);
const isTop = (u) => !!u && !u.hrSuper && ['SUPER_ADMIN', 'ADMIN'].includes(u.role);
const deskOk = (u) => isTop(u) || exitDate.isHrDesk(u);

router.get('/me', async (req, res, next) => {
  try {
    if (!isFormer(req)) return plain(res, 403, 'This page is for former employees.');
    const employeeId = req.user.employeeId;
    if (!employeeId) return res.json({ person: await former.sessionPayload(req.user), letters: [], message: former.MESSAGE });
    const docs = await prisma.employeeDocument.findMany({ where: { employeeId, docType: { in: former.LETTER_TYPES } }, orderBy: { uploadedAt: 'desc' } });
    res.json({
      person: await former.sessionPayload(req.user),
      letters: docs.filter(former.isLetter).map((d) => ({ id: d.id, label: d.docType, fileName: d.fileName, uploadedAt: d.uploadedAt })),
      message: former.MESSAGE,
    });
  } catch (err) { next(err); }
});

// ---- own attendance and own leave records, as a download ----------------------------------------
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const dmy = (d) => (d ? `${String(d).slice(8, 10)}-${String(d).slice(5, 7)}-${String(d).slice(0, 4)}` : '');
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const safeName = (s) => String(s || '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'employee';
function send(res, format, name, headers, rows, sheet) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.${format}"`);
  if (format === 'csv') return res.type('text/csv').send(`﻿${toCsv(headers, rows)}`);
  return res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(toXlsx(headers, rows, sheet));
}
async function ownEmployee(req) {
  if (!isFormer(req) || !req.user.employeeId) return null;
  return prisma.employee.findUnique({ where: { id: req.user.employeeId } });
}

router.get('/attendance/export', async (req, res, next) => {
  try {
    const emp = await ownEmployee(req);
    if (!emp) return plain(res, 403, former.MESSAGE);
    const format = req.query.format === 'csv' ? 'csv' : 'xlsx';
    const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    let lwd = null;
    try { const m = await exitDate.exitDatesFor([emp.id], { approvedOnly: false }); if (m.has(emp.id)) lwd = m.get(emp.id).date; } catch { lwd = null; }
    const joined = emp.dateOfJoining ? new Date(emp.dateOfJoining).toISOString().slice(0, 10) : null;
    const end = lwd && lwd < today ? lwd : today;                     // never past the last working day
    const start0 = joined || new Date(Date.parse(`${end}T00:00:00Z`) - 365 * 86400000).toISOString().slice(0, 10);
    let from = isDay(req.query.from) ? String(req.query.from) : start0;
    let to = isDay(req.query.to) ? String(req.query.to) : end;
    if (from < start0) from = start0;                                  // nothing before they joined
    if (to > end) to = end;
    if (from > to) return plain(res, 400, 'The "from" date is after the "to" date.');
    if (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 6 * 366 * 86400000) return plain(res, 400, 'Pick a period of up to 6 years.');
    const cfg = (await prisma.hrConfig.findFirst()) || {};
    const { days } = await AD.loadDays(prisma, { employees: [emp], from, to, cfg, lastDayOf: lwd ? new Map([[emp.id, lwd]]) : null });
    const list = days(emp);
    const rows = list.map((d) => [
      dmy(d.date), WEEKDAY[new Date(`${d.date}T00:00:00Z`).getUTCDay()], d.status || '',
      d.checkIn || '', d.checkOut || '', d.hours === null || d.hours === undefined ? '' : d.hours,
      d.leaveType || '', d.note || '',
    ]);
    const headers = ['Date', 'Day', 'Status', 'Check-in', 'Check-out', 'Hours', 'Leave type', 'Note'];
    await logAudit({ userId: req.user.id, action: 'Attendance downloaded (former employee)', entity: 'Employee', entityId: emp.id, toValue: `${from} to ${to}, ${rows.length} days` });
    notifyDataIo(req, { kind: 'export', module: 'Former employee', count: rows.length, what: 'days of their own attendance', format, detail: `${emp.employeeCode || emp.name}: ${from} to ${to}` }).catch(() => {});
    return send(res, format, `Attendance-${safeName(emp.employeeCode || emp.name)}-${from}-to-${to}`, headers, rows, 'Attendance');
  } catch (err) { return next(err); }
});

router.get('/leaves/export', async (req, res, next) => {
  try {
    const emp = await ownEmployee(req);
    if (!emp) return plain(res, 403, former.MESSAGE);
    const format = req.query.format === 'csv' ? 'csv' : 'xlsx';
    const list = await prisma.leaveRequest.findMany({ where: { employeeId: emp.id }, orderBy: { fromDate: 'desc' } });
    const rows = list.map((l) => [
      l.type, dmy(String(l.fromDate).slice(0, 10)), dmy(String(l.toDate).slice(0, 10)), l.days, l.status,
      l.reason || '', l.createdAt ? dmy(new Date(l.createdAt).toISOString().slice(0, 10)) : '', l.decidedBy || '',
    ]);
    const headers = ['Leave type', 'From', 'To', 'Days', 'Status', 'Reason', 'Applied on', 'Decided by'];
    await logAudit({ userId: req.user.id, action: 'Leave records downloaded (former employee)', entity: 'Employee', entityId: emp.id, toValue: `${rows.length} requests` });
    notifyDataIo(req, { kind: 'export', module: 'Former employee', count: rows.length, what: 'of their own leave requests', format, detail: emp.employeeCode || emp.name }).catch(() => {});
    return send(res, format, `Leaves-${safeName(emp.employeeCode || emp.name)}`, headers, rows, 'Leave records');
  } catch (err) { return next(err); }
});

router.get('/letters/:docId/file', async (req, res, next) => {
  try {
    if (!isFormer(req) || !req.user.employeeId) return plain(res, 403, former.MESSAGE);
    const doc = await prisma.employeeDocument.findUnique({ where: { id: req.params.docId } });
    if (!doc || doc.employeeId !== req.user.employeeId || !former.isLetter(doc)) return plain(res, 404, 'Letter not found');
    const full = attachments.resolveStored(doc.file);
    if (!full) return plain(res, 404, 'The file is no longer on the server. Please ask HR.');
    const mime = attachments.ALLOWED[doc.mime] ? doc.mime : 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `attachment; filename="${attachments.safeDisplayName(doc.fileName)}"`);
    await logAudit({ userId: req.user.id, action: 'Letter downloaded (former employee)', entity: 'EmployeeDocument', entityId: doc.id, toValue: doc.docType });
    return res.sendFile(full);
  } catch (err) { return next(err); }
});

// ---- admin side ---------------------------------------------------------------------------------
async function view(req) {
  const cfg = await former.settings();
  return { limitMonths: cfg.limitMonths, options: former.LIMITS, switchedOff: cfg.off.length, canChange: isTop(req.user) };
}
router.get('/settings', async (req, res, next) => {
  try {
    if (isFormer(req) || !deskOk(req.user)) return plain(res, 403, "This isn't included in your role's permissions");
    res.json(await view(req));
  } catch (err) { next(err); }
});
router.put('/settings', async (req, res, next) => {
  try {
    if (isFormer(req) || !isTop(req.user)) return plain(res, 403, 'Only an Admin or the Super Admin can change this.');
    const m = Number(req.body && req.body.limitMonths);
    if (!former.LIMITS.some((l) => l.months === m)) return plain(res, 400, 'Pick Forever, 1 year, 2 years or 3 years.');
    const cur = await former.settings();
    await former.save({ ...cur, limitMonths: m }, req.user);
    const label = (x) => (former.LIMITS.find((l) => l.months === x) || {}).label;
    await logAudit({ userId: req.user.id, actorName: req.user.name || req.user.email, action: 'Exit setting changed: how long former employees keep limited access', entity: 'AppSetting', entityId: former.KEY, fromValue: label(cur.limitMonths), toValue: label(m) });
    res.json(await view(req));
  } catch (err) { next(err); }
});

async function switchTo(req, res, next, off) {
  try {
    if (isFormer(req) || !deskOk(req.user)) return plain(res, 403, 'Only HR, an Admin or the Super Admin can do this.');
    const employee = await prisma.employee.findUnique({ where: { id: req.params.employeeId } });
    if (!employee) return plain(res, 404, 'Employee not found');
    if (!employee.userId) return plain(res, 409, `${employee.name} has no login.`);
    if (!['Relieved', 'Exited', 'Terminated'].includes(employee.employmentStatus)) return plain(res, 409, `${employee.name} still works here. This switch is only for people who have left.`);
    const cfg = await former.settings();
    const has = cfg.off.some((x) => x.userId === employee.userId);
    const who = req.user.name || req.user.email;
    if (off && !has) cfg.off.push({ userId: employee.userId, at: new Date().toISOString(), byName: who, reason: String((req.body && req.body.reason) || '').slice(0, 200) || null });
    if (!off) cfg.off = cfg.off.filter((x) => x.userId !== employee.userId);
    await former.save(cfg, req.user);
    await logAudit({
      userId: req.user.id, actorName: who, action: off ? 'Former employee access switched off' : 'Former employee access switched on', entity: 'Employee', entityId: employee.id,
      fromValue: has ? 'Off' : 'On', toValue: off ? 'Off' : 'On', reason: `${employee.name}: ${off ? 'cannot download their attendance, leave records and letters any more' : 'can download their attendance, leave records and letters again'}`,
    });
    res.json({ ok: true, switchedOff: off, message: off ? `${employee.name} can no longer sign in.` : `${employee.name} can sign in again to download their attendance, leave records and letters.` });
  } catch (err) { next(err); }
}
router.post('/employee/:employeeId/switch-off', (req, res, next) => switchTo(req, res, next, true));
router.post('/employee/:employeeId/switch-on', (req, res, next) => switchTo(req, res, next, false));
router.get('/employee/:employeeId/state', async (req, res, next) => {
  try {
    if (isFormer(req) || !deskOk(req.user)) return plain(res, 403, "This isn't included in your role's permissions");
    const employee = await prisma.employee.findUnique({ where: { id: req.params.employeeId }, select: { id: true, userId: true, employmentStatus: true } });
    if (!employee) return plain(res, 404, 'Employee not found');
    const cfg = await former.settings();
    const off = cfg.off.find((x) => x.userId === employee.userId) || null;
    res.json({ hasLogin: !!employee.userId, left: ['Relieved', 'Exited', 'Terminated'].includes(employee.employmentStatus), switchedOff: !!off, by: off ? off.byName : null, at: off ? off.at : null });
  } catch (err) { next(err); }
});

module.exports = router;
