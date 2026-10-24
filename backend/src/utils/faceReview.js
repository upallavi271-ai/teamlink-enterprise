'use strict';
// ---------------------------------------------------------------------------
// FACE CHECK REVIEW for web check-ins (lives inside Attendance; no new sidebar entry).
//
//   GET  /attendance/face-review?from&to&state=pending|all   punches whose face was "not matched" / "not checked"
//   POST /attendance/face-review/:id   { decision: 'ok' | 'reject' }   HR desk / Admin / Internal HR only
//   GET  /attendance/face-summary      today's counts: web check-ins, matched, not matched, not checked, waiting for review
//
// Only people who manage HRMS (and only for employees in their scope) see the list. The selfie itself is served by
// GET /attendance/punches/:id/image (the employee and HR in scope only). A decision here changes the punch's face
// status and writes an audit line - it NEVER changes a day status, late or leave (no automatic penalty).
// retention: sweepSelfies() deletes selfies older than the retention days (default 30); the punch row stays.
// ---------------------------------------------------------------------------

const prisma = require('../db');
const { logAudit } = require('./audit');
const attachments = require('./attachments');
const { employeeInScope, OUT_OF_SCOPE } = require('./scope');
const D = require('./attendanceDays');
const settings = require('./checkinSettings');

const PENDING = ['Face not matched', 'Face not checked'];
const REVIEWED = ['Face OK (HR)', 'Not this person (HR)'];
const WEB = ['Web', 'Mobile'];

const daysAgo = (n) => { const d = new Date(Date.now() - n * 86400000); return D.localDate(d); };

function register(router, { requirePerm } = {}) {
  const canReview = (req, res) => {
    if (!req.user.caps.hrmsManage) { res.status(403).json({ error: "This isn't included in your role's permissions" }); return false; }
    return true;
  };

  router.get('/face-review', async (req, res) => {
    if (!canReview(req, res)) return undefined;
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || '')) ? String(req.query.from) : daysAgo(14);
    const to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || '')) ? String(req.query.to) : D.localDate();
    const statuses = req.query.state === 'all' ? [...PENDING, ...REVIEWED] : PENDING;
    const rows = await prisma.attendancePunch.findMany({
      where: { source: { in: WEB }, date: { gte: from, lte: to }, verificationStatus: { in: statuses } },
      include: { employee: true }, orderBy: [{ date: 'desc' }, { time: 'desc' }], take: 500,
    });
    const out = rows.filter((p) => employeeInScope(req.user, p.employee)).map((p) => ({
      id: p.id, employeeId: p.employeeId, employeeCode: p.employee.employeeCode, name: p.employee.name, department: p.employee.department || null,
      date: p.date, time: p.time, direction: p.direction, status: p.verificationStatus,
      score: p.verificationScore, reason: p.livenessStatus || '', distanceM: p.distanceM != null ? Math.round(p.distanceM) : null,
      accuracyM: p.accuracyM != null ? Math.round(p.accuracyM) : null, hasSelfie: !!p.imageFile,
    }));
    res.json({
      from, to, rows: out,
      counts: {
        waiting: out.filter((r) => PENDING.includes(r.status)).length,
        notMatched: out.filter((r) => r.status === 'Face not matched').length,
        notChecked: out.filter((r) => r.status === 'Face not checked').length,
      },
    });
    return undefined;
  });

  router.post('/face-review/:id', async (req, res) => {
    if (!canReview(req, res)) return undefined;
    const decision = req.body && req.body.decision;
    if (!['ok', 'reject'].includes(decision)) return res.status(400).json({ error: 'Choose Mark OK or Not this person.' });
    const p = await prisma.attendancePunch.findUnique({ where: { id: req.params.id }, include: { employee: true } });
    if (!p || !WEB.includes(p.source || '')) return res.status(404).json({ error: 'That check-in was not found.' });
    if (!employeeInScope(req.user, p.employee)) return res.status(403).json(OUT_OF_SCOPE);
    const status = decision === 'ok' ? 'Face OK (HR)' : 'Not this person (HR)';
    const before = p.verificationStatus;
    const updated = await prisma.attendancePunch.update({ where: { id: p.id }, data: { verificationStatus: status } });
    await logAudit({
      userId: req.user.id, action: `Face check reviewed: ${decision === 'ok' ? 'marked OK' : 'not this person'}`, entity: 'AttendancePunch', entityId: p.id,
      fromValue: before || '', toValue: `${p.employee.name} · ${p.date} ${p.time} · ${status}`,
    });
    return res.json({ id: updated.id, status });
  });

  router.get('/face-summary', async (req, res) => {
    if (!canReview(req, res)) return undefined;
    const today = D.localDate();
    const rows = await prisma.attendancePunch.findMany({ where: { source: { in: WEB }, date: today }, include: { employee: true } });
    const mine = rows.filter((p) => employeeInScope(req.user, p.employee));
    const count = (f) => mine.filter(f).length;
    const waiting = await prisma.attendancePunch.findMany({ where: { source: { in: WEB }, date: { gte: daysAgo(14) }, verificationStatus: { in: PENDING } }, include: { employee: true } });
    res.json({
      date: today,
      webCheckins: mine.length,
      people: new Set(mine.map((p) => p.employeeId)).size,
      matched: count((p) => p.verificationStatus === 'Verified' || p.verificationStatus === 'Face OK (HR)'),
      notMatched: count((p) => p.verificationStatus === 'Face not matched'),
      notChecked: count((p) => p.verificationStatus === 'Face not checked'),
      waitingForReview: waiting.filter((p) => employeeInScope(req.user, p.employee)).length,
    });
    return undefined;
  });
}

// Delete selfies older than the retention days. The punch (time, distance, score) stays. Returns how many were removed.
async function sweepSelfies(days, now = new Date(), only = null) {
  const keep = Number(days) > 0 ? Number(days) : (await settings.load()).selfieRetentionDays;
  const cutoff = new Date(now.getTime() - keep * 86400000);
  const old = await prisma.attendancePunch.findMany({ where: { imageFile: { not: null }, createdAt: { lt: cutoff }, source: { in: WEB }, ...(only ? { employeeId: { in: only } } : {}) }, select: { id: true, imageFile: true }, take: 500 });
  for (const p of old) {
    attachments.remove(p.imageFile);
    await prisma.attendancePunch.update({ where: { id: p.id }, data: { imageFile: null } });
  }
  return old.length;
}

let timer = null;
function startSelfieSweep() {
  if (timer) return;
  const run = () => sweepSelfies().catch(() => {});
  setTimeout(run, 60 * 1000).unref();
  timer = setInterval(run, 6 * 60 * 60 * 1000);
  timer.unref();
}

module.exports = { register, sweepSelfies, startSelfieSweep, PENDING, REVIEWED };
