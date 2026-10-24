// ---------------------------------------------------------------------------
// LEAVE: Pulse sync, old pending, duplicates, settings (mounted at /api/leave/pulse by routes/leave.js).
// HR / Admin / Super Admin only (Leave & Holidays "configure"), except the read-only status line.
//
//   GET  /status                  last sync line + settings + pending counts
//   POST /preview?create&createPending     body = the Pulse export file (raw bytes)   -> plan, nothing changed
//   POST /apply?create&createPending       same file                                  -> does it, returns the result
//   GET  /result/:syncId.csv      the result as CSV
//   POST /undo                    undo the last sync (24 h)
//   GET  /old-pending             pending requests that are not genuine (left / duplicate / old), with names
//   POST /old-pending/:id/close   { action: 'reject' | 'approve', reason }   (reason required, audited)
//   POST /old-pending/bulk-reject { ids, reason }
//   GET  /duplicates              read-only scan of duplicate / overlapping live requests
//   PUT  /settings                { staleDays, reminderAfterHours }
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requirePerm } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const pulse = require('../utils/pulseSync');
const genuine = require('../utils/leaveGenuine');
const leaveText = require('../utils/leaveText');

const router = express.Router();
const configure = requirePerm(null, 'hrms', 'Leave & Holidays', 'edit'); // HR, Admin, Super Admin (a view-only Manager has no edit)
const raw = express.raw({ type: () => true, limit: '12mb' });
const flag = (v, d) => (v === undefined ? d : !/^(0|false|no)$/i.test(String(v)));
const WF = 'leave';

async function settingsOut() {
  const { leaveReminderHours } = require('../utils/chainAlerts'); // eslint-disable-line global-require
  return { staleDays: await genuine.getStaleDays(), reminderAfterHours: await leaveReminderHours() };
}

router.get('/status', async (req, res, next) => {
  try {
    const last = await pulse.lastSync();
    const b = await genuine.pendingBuckets();
    res.json({
      last: last ? { at: last.at, by: last.by, counts: last.counts, undoable: last.undoable, undone: !!last.undone, syncId: last.syncId } : null,
      settings: await settingsOut(),
      pending: { genuine: b.genuine.length, left: b.leaver.length, duplicate: b.duplicate.length, old: b.old.length, all: b.all.length },
      api: { available: false, note: 'Pulse HRMS publishes no public API or webhook we can call, so leave is synced from its Leave History export file.' },
    });
  } catch (err) { next(err); }
});

async function fileOf(req, res) {
  if (!Buffer.isBuffer(req.body) || !req.body.length) { res.status(400).json({ error: 'Choose the Leave History file from Pulse first (.xlsx or .csv).' }); return null; }
  let parsed;
  try { parsed = pulse.parseExport(req.body); } catch (e) { res.status(400).json({ error: 'That file could not be read. Upload the Leave History .xlsx or .csv exported from Pulse.' }); return null; }
  if (parsed.problems.length) { res.status(400).json({ error: parsed.problems[0] }); return null; }
  return parsed;
}
const optsOf = (req) => ({ create: flag(req.query.create, true), createPending: flag(req.query.createPending, true) });

router.post('/preview', configure, raw, async (req, res, next) => {
  try {
    const parsed = await fileOf(req, res); if (!parsed) return;
    const pl = await pulse.plan(parsed.rows, optsOf(req));
    res.json({ counts: pl.counts, fileRows: pl.fileRows, items: pl.items.slice(0, 1500).map((i) => ({ row: i.row, code: i.code, name: i.name, type: i.type, from: i.from, to: i.end, pulseStatus: i.pulseStatus, action: i.action, reason: i.reason })), only: pl.only });
  } catch (err) { next(err); }
});

router.post('/apply', configure, raw, async (req, res, next) => {
  try {
    const parsed = await fileOf(req, res); if (!parsed) return;
    const out = await pulse.apply(parsed.rows, req.user, optsOf(req));
    res.json(out);
  } catch (err) { next(err); }
});

router.get('/result/:syncId.csv', configure, async (req, res, next) => {
  try {
    const run = await pulse.getRun(req.params.syncId);
    if (!run) return res.status(404).json({ error: 'That sync result was not found.' });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="pulse-sync-${run.at.slice(0, 10)}.csv"`);
    res.send(pulse.resultCsv(run));
  } catch (err) { next(err); }
});

router.post('/undo', configure, async (req, res, next) => {
  try {
    const r = await pulse.undoLast(req.user);
    if (r.error) return res.status(409).json({ error: r.error });
    res.json(r);
  } catch (err) { next(err); }
});

const dmy = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d || '').slice(0, 10));
router.get('/old-pending', configure, async (req, res, next) => {
  try {
    const b = await genuine.pendingBuckets();
    const steps = await prisma.approvalStep.findMany({ where: { workflow: WF, status: 'Pending', recordId: { in: b.all.map((r) => r.id) } }, select: { recordId: true, approverName: true, level: true } });
    const withWho = new Map(steps.map((s) => [s.recordId, s]));
    const rows = b.all.filter((r) => b.reasonOf.has(r.id)).map((r) => ({
      id: r.id, kind: b.reasonOf.get(r.id), why: genuine.REASON_TEXT[b.reasonOf.get(r.id)],
      employee: r.employee.name, code: r.employee.employeeCode, department: r.employee.department, employeeStatus: r.employee.employmentStatus,
      type: r.type, from: dmy(r.fromDate), to: dmy(r.toDate), days: r.days, appliedOn: dmy(r.createdAt),
      halfDay: leaveText.halfOf(r), waitingOn: withWho.get(r.id) ? `${withWho.get(r.id).approverName || withWho.get(r.id).level}` : null,
    }));
    res.json({ staleDays: await genuine.getStaleDays(), counts: { left: b.leaver.length, duplicate: b.duplicate.length, old: b.old.length }, rows });
  } catch (err) { next(err); }
});

async function closeOne(id, action, reason, user) {
  const cur = await prisma.leaveRequest.findUnique({ where: { id }, include: { employee: true } });
  if (!cur) return { error: 'Request not found' };
  if (cur.status !== 'Pending') return { error: `Already ${cur.status}` };
  const by = user.name || user.email;
  const decision = action === 'approve' ? 'Approved' : 'Rejected';
  const steps = await prisma.approvalStep.findMany({ where: { workflow: WF, recordId: id, status: { in: ['Pending', 'Waiting', 'Visibility'] } } });
  for (const s of steps) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.approvalStep.update({ where: { id: s.id }, data: { status: s.status === 'Pending' ? decision : 'Skipped', actedAt: new Date(), actedByUserId: user.id, actedByName: by, note: `${decision === 'Approved' ? 'Approved (backdated)' : 'Closed as stale'} by ${by}: ${reason}` } });
  }
  const upd = await prisma.leaveRequest.update({
    where: { id },
    data: { status: decision, decidedAt: new Date(), decidedBy: by, ...(decision === 'Approved' ? { approvalReason: `Approved (backdated): ${reason}` } : { rejectReason: `Closed as stale: ${reason}` }) },
  });
  if (decision === 'Approved') {
    const pre = await prisma.auditLog.findFirst({ where: { entity: 'LeaveRequest', entityId: id, action: 'Leave imported — days already counted in PulseHRM availed' }, select: { id: true } });
    if (!pre && !['Exited', 'Relieved'].includes(cur.employee.employmentStatus)) { try { await require('../utils/leaveCharge').onApprove(upd, user.id); } catch { /* balance untouched */ } } // eslint-disable-line global-require
  }
  await logAudit({ userId: user.id, actorName: by, action: decision === 'Approved' ? 'Old pending leave approved (backdated)' : 'Old pending leave closed as Rejected (stale)', entity: 'LeaveRequest', entityId: id, fromValue: 'Pending', toValue: decision, reason });
  return { ok: true };
}
router.post('/old-pending/:id/close', configure, async (req, res, next) => {
  try {
    const reason = String(req.body.reason || '').trim();
    const action = req.body.action === 'approve' ? 'approve' : 'reject';
    if (!reason) return res.status(400).json({ error: 'Please write a reason.' });
    const b = await genuine.pendingBuckets({ employeeIds: null });
    if (!b.reasonOf.has(req.params.id)) return res.status(409).json({ error: 'That request is a normal pending one. Decide it from the approval card.' });
    const r = await closeOne(req.params.id, action, reason, req.user);
    if (r.error) return res.status(409).json({ error: r.error });
    res.json(r);
  } catch (err) { next(err); }
});
router.post('/old-pending/bulk-reject', configure, async (req, res, next) => {
  try {
    const reason = String(req.body.reason || '').trim();
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(String).slice(0, 500) : [];
    if (!reason) return res.status(400).json({ error: 'Please write a reason.' });
    if (!ids.length) return res.status(400).json({ error: 'Pick the requests to close.' });
    const b = await genuine.pendingBuckets();
    let done = 0; const skipped = [];
    for (const id of ids) {
      if (!b.reasonOf.has(id)) { skipped.push(id); continue; } // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      const r = await closeOne(id, 'reject', reason, req.user);
      if (r.ok) done += 1; else skipped.push(id);
    }
    res.json({ closed: done, skipped: skipped.length });
  } catch (err) { next(err); }
});

// Read-only: groups of live requests that overlap for the same person and leave type.
router.get('/duplicates', configure, async (req, res, next) => {
  try {
    const rows = await prisma.leaveRequest.findMany({ where: { status: { in: ['Pending', 'Approved', 'Cancellation Requested'] } }, include: { employee: { select: { name: true, employeeCode: true, employmentStatus: true } } }, orderBy: { fromDate: 'asc' } });
    const groups = []; const by = new Map();
    rows.forEach((r) => { const k = `${r.employeeId}|${r.type}`; if (!by.has(k)) by.set(k, []); by.get(k).push(r); });
    by.forEach((list) => {
      const used = new Set();
      list.forEach((a, i) => {
        if (used.has(a.id)) return;
        const clash = list.filter((b, j) => j !== i && !used.has(b.id) && dmy(a.fromDate) <= dmy(b.toDate) && dmy(b.fromDate) <= dmy(a.toDate));
        if (clash.length) { const g = [a, ...clash]; g.forEach((x) => used.add(x.id)); groups.push(g); }
      });
    });
    res.json({ groups: groups.length, rows: groups.map((g) => ({ employee: g[0].employee.name, code: g[0].employee.employeeCode, type: g[0].type, exact: g.every((x) => dmy(x.fromDate) === dmy(g[0].fromDate) && dmy(x.toDate) === dmy(g[0].toDate)), requests: g.map((x) => ({ id: x.id, from: dmy(x.fromDate), to: dmy(x.toDate), status: x.status })) })) });
  } catch (err) { next(err); }
});

router.put('/settings', configure, async (req, res, next) => {
  try {
    const out = {};
    if (req.body.staleDays !== undefined) {
      const r = await genuine.setStaleDays(req.body.staleDays, req.user);
      if (r.error) return res.status(400).json({ error: r.error });
    }
    if (req.body.reminderAfterHours !== undefined) {
      const n = Number(req.body.reminderAfterHours);
      if (!Number.isFinite(n) || n < 0 || n > 720) return res.status(400).json({ error: 'Hours must be from 0 to 720.' });
      const value = JSON.stringify(n);
      await prisma.appSetting.upsert({ where: { key: 'leave.reminder.afterHours' }, update: { value, updatedById: req.user.id, updatedByName: req.user.name }, create: { key: 'leave.reminder.afterHours', value, updatedById: req.user.id, updatedByName: req.user.name } });
    }
    await logAudit({ userId: req.user.id, action: 'Leave pending settings changed', entity: 'AppSetting', entityId: 'leave.pending', toValue: JSON.stringify(req.body) });
    Object.assign(out, await settingsOut());
    res.json(out);
  } catch (err) { next(err); }
});

module.exports = router;
