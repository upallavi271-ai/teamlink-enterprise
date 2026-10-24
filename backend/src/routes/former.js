// ---------------------------------------------------------------------------
// FORMER EMPLOYEE SHELL API (founder, 2026-10-15). Mounted at /api/former. See utils/formerAccess.js.
// A Relieved / Exited employee keeps their login for ONE thing: downloading their own payslips and letters.
// Everything is read from the SIGNED-IN person's own employee id; an id in the URL can never reach another
// person's payslip or letter.
//
//   GET /me                       { person, payslips[], letters[], message }
//   GET /payslips/:id/pdf         own payslip PDF
//   GET /letters/:docId/file      own letter (offer / joining / experience ...) download
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
    if (!employeeId) return res.json({ person: await former.sessionPayload(req.user), payslips: [], letters: [], message: former.MESSAGE });
    const [slips, docs] = await Promise.all([
      prisma.payslip.findMany({ where: { employeeId }, orderBy: { month: 'desc' }, select: { id: true, month: true, netPay: true } }),
      prisma.employeeDocument.findMany({ where: { employeeId }, orderBy: { uploadedAt: 'desc' } }),
    ]);
    res.json({
      person: await former.sessionPayload(req.user),
      payslips: slips.map((s) => ({ id: s.id, month: s.month, netPay: s.netPay })),
      letters: docs.filter(former.isLetter).map((d) => ({ id: d.id, label: d.docType === 'Other Documents' ? (d.docName || d.fileName) : d.docType, fileName: d.fileName, uploadedAt: d.uploadedAt })),
      message: former.MESSAGE,
    });
  } catch (err) { next(err); }
});

router.get('/payslips/:id/pdf', async (req, res, next) => {
  try {
    if (!isFormer(req) || !req.user.employeeId) return plain(res, 403, former.MESSAGE);
    const slip = await prisma.payslip.findUnique({ where: { id: req.params.id }, include: { employee: true } });
    if (!slip || slip.employeeId !== req.user.employeeId) return plain(res, 404, 'Payslip not found');
    const payroll = require('./payroll'); // eslint-disable-line global-require
    const payload = await payroll.payslipPayload(slip);
    const safe = (s) => String(s || '').replace(/[^A-Za-z0-9_-]+/g, '-');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Payslip-${safe(payload.employee.employeeCode || payload.employee.name)}-${payload.month}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    await logAudit({ userId: req.user.id, action: 'Payslip downloaded (former employee)', entity: 'Payslip', entityId: slip.id, toValue: payload.month });
    require('../utils/payslipPdf').renderPayslip(payload, res); // eslint-disable-line global-require
    return undefined;
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
      fromValue: has ? 'Off' : 'On', toValue: off ? 'Off' : 'On', reason: `${employee.name}: ${off ? 'cannot download payslips and letters any more' : 'can download payslips and letters again'}`,
    });
    res.json({ ok: true, switchedOff: off, message: off ? `${employee.name} can no longer sign in.` : `${employee.name} can sign in again to download their payslips and letters.` });
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
