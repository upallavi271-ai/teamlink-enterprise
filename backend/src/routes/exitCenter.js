// ---------------------------------------------------------------------------
// EXIT CENTER (HRMS spec items 6 + 7, 2026-10-13). Mounted at /api/resignations/exit
// by routes/resignations.js (auth + Act-as actor already applied).
//
//   GET  /approvals                 the Exit approvals tab (filters + counts)
//   GET  /settings  PUT /settings   who finally approves (Super Admin edits) + reminder hours
//   GET  /date-changes              report list: every last-working-day change
//   GET  /records.xlsx | .pdf       exit status records (separate Excel / PDF buttons)
//   GET  /employee/:employeeId      the live exit of one person (profile chip)
//   POST /employee/:employeeId/initiate          HR starts an exit ("Initiate exit")
//   POST /employee/:employeeId/finalize-override Super Admin only: finish WITHOUT approval (reason, audited)
//   GET  /:id                       the EXIT RECORD: timeline, card, "Where this date is used"
//   POST /:id/approve | /reject | /send-back     the three buttons for the current approver
//   POST /:id/finalize | /early-release          HR desk
//   POST /:id/date/check   PUT /:id/date         Edit exit date (warnings first, then save)
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { employeeRecordWhere, employeeInScope, OUT_OF_SCOPE } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const workflow = require('../utils/approvalWorkflow');
const exitFlow = require('../utils/exitFlow');
const exitDate = require('../utils/exitDate');
const { toXlsx, toPdf } = require('../utils/tabularExport');
const { systemRequesterError } = require('../utils/systemAccounts');

const router = express.Router();
router.use(requireAuth);

const WF = exitFlow.WF;
const PENDING = exitFlow.PENDING;
const SERVING = exitFlow.SERVING;
const OPEN = [PENDING, ...SERVING];
const today = () => require('../utils/positions').today();
// a delegate with HR super access (utils/hrSuper.js) is NOT a Super Admin for the override and the exit settings
const isSA = (u) => workflow.isSuperAdmin(u) && !(u && u.hrSuper);
const desk = (u) => exitDate.isHrDesk(u);
const HOUR = 3600000;
const clean = exitFlow.clean;
const plain = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });
const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthWords = (key) => (/^\d{4}-\d{2}$/.test(key) ? `${MON3[Number(key.slice(5)) - 1]} ${key.slice(0, 4)}` : key);

// ---- the exit's STAGE, in plain words (one word list for the list, the card and the chips) ----
const STAGES = {
  waiting: 'Waiting for approval',
  notice: 'Approved, serving notice',
  ready: 'Last day reached: ready to finish',
  relieved: 'Relieved',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};
function stageOf(record, employee, steps, day = today(), lwd = null) {
  const s = record.status;
  if (s === 'Rejected') return { key: 'rejected', label: STAGES.rejected };
  if (s === 'Withdrawn') return { key: 'withdrawn', label: STAGES.withdrawn };
  if (s === 'Relieved') return { key: 'relieved', label: employee && employee.employmentStatus === 'Exited' ? 'Exited' : 'Relieved' };
  if (s === PENDING) {
    const cur = (steps || []).find((x) => x.status === 'Pending');
    return { key: 'waiting', label: cur ? `Waiting for ${workflow.labelFor(cur.level).label}` : STAGES.waiting };
  }
  return lwd && lwd <= day ? { key: 'ready', label: STAGES.ready } : { key: 'notice', label: STAGES.notice };
}
const stageGroup = (key) => (key === 'waiting' ? STAGES.waiting : key === 'notice' ? 'Serving notice' : key === 'ready' ? 'Ready to finish' : STAGES[key] || key);
const waitBucket = (hours) => (hours == null ? null : hours < 24 ? 'Under 1 day' : hours < 72 ? '1 to 3 days' : 'More than 3 days');
const WAIT_BUCKETS = ['Under 1 day', '1 to 3 days', 'More than 3 days'];

// ---- who may see an exit ----------------------------------------------------
async function mayView(user, record, employee) {
  if (employee && user.employeeId && employee.id === user.employeeId) return true;
  return workflow.canSee(WF, record.id, user, employee);
}
const isOwn = (user, employee) => !!(user.employeeId && employee && employee.id === user.employeeId);

async function loadExit(id) {
  const record = await prisma.employeeRecord.findUnique({ where: { id }, include: { employee: true } });
  if (!record || record.type !== 'RESIGNATION') return null;
  const detail = await prisma.resignationDetail.findUnique({ where: { recordId: record.id } });
  return { record, employee: record.employee, detail };
}

// ---- THE LIST: Exit approvals tab -------------------------------------------
async function listRows(req) {
  const user = req.user;
  const scoped = employeeRecordWhere(user);
  const mine = await workflow.recordIdsForParticipant(WF, user.id);
  const where = { type: 'RESIGNATION' };
  if (req.query.include !== 'all') where.status = { in: OPEN };
  if (Object.keys(scoped).length) where.OR = mine.length ? [scoped, { id: { in: mine } }] : [scoped];
  const records = await prisma.employeeRecord.findMany({ where, include: { employee: true }, orderBy: { createdAt: 'desc' }, take: 2000 });
  if (!records.length) return [];
  const ids = records.map((r) => r.id);
  const [details, steps] = await Promise.all([
    prisma.resignationDetail.findMany({ where: { recordId: { in: ids } } }),
    prisma.approvalStep.findMany({ where: { workflow: WF, recordId: { in: ids } }, orderBy: { seq: 'asc' } }),
  ]);
  const detailOf = new Map(details.map((d) => [d.recordId, d]));
  const stepsOf = new Map();
  steps.forEach((s) => { stepsOf.set(s.recordId, [...(stepsOf.get(s.recordId) || []), s]); });
  const day = today();
  const now = Date.now();
  return records.map((r) => {
    const d = detailOf.get(r.id) || null;
    const st = stepsOf.get(r.id) || [];
    const lwd = exitDate.dateOf(r, d);
    const stage = stageOf(r, r.employee, st, day, lwd);
    const cur = st.find((x) => x.status === 'Pending') || null;
    const waited = cur && cur.activatedAt ? Math.floor((now - new Date(cur.activatedAt).getTime()) / HOUR) : null;
    return {
      id: r.id,
      employee: r.employee ? { id: r.employee.id, name: r.employee.name, employeeCode: r.employee.employeeCode, department: r.employee.department, designation: r.employee.designation } : null,
      department: r.employee ? r.employee.department || '' : '',
      employeeStatus: r.employee ? r.employee.employmentStatus : null,
      status: r.status,
      stage: stage.key, stageLabel: stage.label, stageGroup: stageGroup(stage.key),
      lastWorkingDate: lwd,
      daysLeft: lwd && SERVING.includes(r.status) ? Math.ceil((new Date(`${lwd}T00:00:00Z`) - new Date(`${day}T00:00:00Z`)) / 86400000) : null,
      reason: d ? (d.reason === 'Other' && d.reasonOther ? `Other: ${d.reasonOther}` : d.reason) : r.title,
      source: d ? (/^Imported/i.test(d.submittedByName || '') ? 'Imported' : (d.source || 'TeamLink')) : 'TeamLink',
      initiatedAt: d ? d.submittedAt : r.createdAt,
      initiatedBy: d ? d.submittedByName : null,
      waitingOn: cur ? { name: cur.approverName, level: workflow.labelFor(cur.level).label, userId: cur.approverUserId } : null,
      waitedHours: waited,
      waitBucket: waitBucket(waited),
      canAct: !!(cur && (cur.approverUserId === user.id || workflow.isSuperAdmin(user))),
      mine: !!(cur && cur.approverUserId === user.id),
    };
  });
}

// Filters with cascading counts: each facet is counted over the rows the OTHER filters leave.
function facetsOf(rows, q) {
  const FILTERS = {
    stage: (r) => !q.stage || r.stageGroup === q.stage,
    department: (r) => !q.department || r.department === q.department,
    wait: (r) => !q.wait || r.waitBucket === q.wait,
    mine: (r) => !q.mine || r.mine,
    q: (r) => !q.q || `${r.employee ? r.employee.name : ''} ${r.employee ? r.employee.employeeCode : ''} ${r.reason}`.toLowerCase().includes(String(q.q).toLowerCase()),
  };
  const except = (skip) => rows.filter((r) => Object.entries(FILTERS).every(([k, fn]) => k === skip || fn(r)));
  const tally = (list, keyOf) => { const m = {}; list.forEach((r) => { const k = keyOf(r); if (k) m[k] = (m[k] || 0) + 1; }); return m; };
  const stage = tally(except('stage'), (r) => r.stageGroup);
  const department = tally(except('department'), (r) => r.department);
  const wait = tally(except('wait').filter((r) => r.waitBucket), (r) => r.waitBucket);
  const shown = rows.filter((r) => Object.values(FILTERS).every((fn) => fn(r)));
  return { shown, counts: { stage, department, wait, mine: except('mine').filter((r) => r.mine).length } };
}

router.get('/approvals', async (req, res, next) => {
  try {
    const rows = await listRows(req);
    const { shown, counts } = facetsOf(rows, req.query);
    const waiting = rows.filter((r) => r.stage === 'waiting').length;
    res.json({
      rows: shown,
      counts: { ...counts, total: rows.length, waiting, waitingOnMe: rows.filter((r) => r.mine).length, stageOrder: [STAGES.waiting, 'Serving notice', 'Ready to finish', 'Relieved', 'Rejected', 'Withdrawn'], waitOrder: WAIT_BUCKETS },
      settings: await exitFlow.getSettings(),
      today: today(),
    });
  } catch (err) { next(err); }
});

// ---- settings -----------------------------------------------------------------
router.get('/settings', async (req, res, next) => {
  try {
    if (!desk(req.user)) return plain(res, 403, "This isn't included in your role's permissions");
    res.json({ ...(await exitFlow.getSettings()), options: exitFlow.FINAL_APPROVERS.map(([key, label]) => ({ key, label })), canEdit: isSA(req.user) });
  } catch (err) { next(err); }
});
router.put('/settings', async (req, res, next) => {
  try {
    if (!isSA(req.user)) return plain(res, 403, 'Only the Super Admin can change who finally approves an exit.');
    const next1 = await exitFlow.saveSettings({ finalApprover: req.body.finalApprover, reminderHours: req.body.reminderHours }, req.user);
    res.json({ ...next1, options: exitFlow.FINAL_APPROVERS.map(([key, label]) => ({ key, label })), canEdit: true });
  } catch (err) { next(err); }
});

// ---- date changes report ------------------------------------------------------------
router.get('/date-changes', async (req, res, next) => {
  try {
    if (!desk(req.user)) return plain(res, 403, "This isn't included in your role's permissions");
    res.json({ rows: await exitDate.changesFor({ limit: 500 }) });
  } catch (err) { next(err); }
});

// ---- exports (separate Excel / PDF buttons) -------------------------------------------
async function exportRows(req) {
  const rows = await listRows({ ...req, query: { ...req.query, include: req.query.include || 'all' } });
  const { shown } = facetsOf(rows, req.query);
  return shown;
}
function exportTable(rows) {
  const headers = ['Employee', 'Code', 'Department', 'Exit status', 'Waiting on', 'Last working day', 'Reason', 'Started on', 'Started by'];
  return {
    headers,
    rows: rows.map((r) => [
      r.employee ? r.employee.name : '', r.employee ? r.employee.employeeCode || '' : '', r.department, r.stageLabel,
      r.waitingOn ? `${r.waitingOn.name || ''} (${r.waitingOn.level})` : '', r.lastWorkingDate || '', r.reason || '',
      r.initiatedAt ? new Date(r.initiatedAt).toISOString().slice(0, 10) : '', r.initiatedBy || '',
    ]),
  };
}
router.get('/records.xlsx', async (req, res, next) => {
  try {
    if (!desk(req.user) && !(await workflow.permissionFor(WF, req.user)).mayAct) return plain(res, 403, "This isn't included in your role's permissions");
    const rows = await exportRows(req);
    const t = exportTable(rows);
    await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Exit status records exported (XLSX)', entity: 'EmployeeRecord', toValue: `${rows.length} row(s)` });
    res.setHeader('Content-Disposition', `attachment; filename="exit-records-${today()}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(toXlsx(t.headers, t.rows, 'Exit records'));
  } catch (err) { next(err); }
});
router.get('/records.pdf', async (req, res, next) => {
  try {
    if (!desk(req.user) && !(await workflow.permissionFor(WF, req.user)).mayAct) return plain(res, 403, "This isn't included in your role's permissions");
    const rows = await exportRows(req);
    const t = exportTable(rows);
    await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Exit status records exported (PDF)', entity: 'EmployeeRecord', toValue: `${rows.length} row(s)` });
    res.setHeader('Content-Disposition', `attachment; filename="exit-records-${today()}.pdf"`);
    res.setHeader('Content-Type', 'application/pdf');
    res.send(toPdf(t.headers, t.rows, { title: 'Exit status records', subtitle: `${rows.length} exit(s)${req.query.stage ? ` - ${req.query.stage}` : ''} - ${new Date().toLocaleString('en-GB')}` }));
  } catch (err) { next(err); }
});

// ---- one person's live exit (employee profile + directory chip) -----------------------------
router.get('/employee/:employeeId', async (req, res, next) => {
  try {
    const employee = await prisma.employee.findUnique({ where: { id: req.params.employeeId } });
    if (!employee) return plain(res, 404, 'Employee not found');
    const live = (await exitDate.liveRecords([employee.id])).get(employee.id);
    if (!live) return res.json({ exit: null });
    if (!(await mayView(req.user, live.record, employee))) return plain(res, 403, OUT_OF_SCOPE.error);
    const steps = await prisma.approvalStep.findMany({ where: { workflow: WF, recordId: live.record.id }, orderBy: { seq: 'asc' } });
    const lwd = exitDate.dateOf(live.record, live.detail);
    const stage = stageOf(live.record, employee, steps, today(), lwd);
    res.json({ exit: { recordId: live.record.id, stage: stage.key, stageLabel: stage.label, status: live.record.status, lastWorkingDate: lwd } });
  } catch (err) { next(err); }
});

// ---- HR INITIATES an exit ---------------------------------------------------------------------
router.post('/employee/:employeeId/initiate', async (req, res, next) => {
  try {
    if (!desk(req.user)) return plain(res, 403, 'Only HR or the Super Admin can start an exit for someone else.');
    const employee = await prisma.employee.findUnique({ where: { id: req.params.employeeId } });
    if (!employee) return plain(res, 404, 'Employee not found');
    if (!employeeInScope(req.user, employee)) return res.status(403).json(OUT_OF_SCOPE);
    const sys = await systemRequesterError(employee, 'an exit');
    if (sys) return plain(res, 403, sys);
    if (exitFlow.FINAL_STATUSES.includes(employee.employmentStatus)) return plain(res, 409, `${employee.name} has already left.`);
    const reason = clean(req.body.reason, 200);
    if (!reason || reason.length < 3) return plain(res, 400, 'Say why the exit is starting (a few words).');
    const lwd = clean(req.body.lastWorkingDate, 10);
    if (lwd && !exitDate.realDate(lwd)) return plain(res, 400, 'The last working day must be a date.');
    const live = (await exitDate.liveRecords([employee.id])).get(employee.id);
    if (live && OPEN.includes(live.record.status)) return plain(res, 409, `${employee.name} already has an exit in progress.`, { recordId: live.record.id });
    const out = await exitFlow.startExit({ employee, by: req.user, source: 'Started by HR (Initiate exit)', reason: 'Other', reasonOther: reason, lastWorkingDate: lwd, note: clean(req.body.note) });
    await exitFlow.notifyTurn({ recordId: out.record.id, employee, detail: out.detail, lwd: exitDate.dateOf(out.record, out.detail) });
    res.status(201).json({ recordId: out.record.id, created: out.created });
  } catch (err) { next(err); }
});

// ---- RELIEVE NOW (HR desk, skips approval; setting 'exit.hrDirectRelieve', default ON) --------------
// GET  /relieve-now/options                       the switch, the reasons, today (the dialog opens from it)
// PUT  /relieve-now/setting                       Admin / Super Admin only: switch it on or off
// POST /employee/:employeeId/relieve-now          { status: 'Relieved' | 'Exited', reason, remarks?, lastWorkingDate }
router.get('/relieve-now/options', async (req, res, next) => {
  try {
    const setting = await exitFlow.getDirectRelieve();
    let reasons = [];
    try { reasons = (await require('./resignations').formConfig()).reasons.filter((r) => r !== 'Other'); } catch { reasons = []; } // eslint-disable-line global-require
    const topUser = !req.user.hrSuper && ['SUPER_ADMIN', 'ADMIN'].includes(req.user.role);
    res.json({ enabled: setting.enabled, isDefault: setting.isDefault, updatedByName: setting.updatedByName, isDesk: desk(req.user), canUse: desk(req.user) && setting.enabled, canChange: topUser, reasons, today: today(), ownEmployeeId: req.user.employeeId || null, isSuperAdmin: isSA(req.user) });
  } catch (err) { next(err); }
});
router.put('/relieve-now/setting', async (req, res, next) => {
  try {
    if (req.user.hrSuper || !['SUPER_ADMIN', 'ADMIN'].includes(req.user.role)) return plain(res, 403, 'Only an Admin or the Super Admin can change this.');
    if (typeof (req.body && req.body.enabled) !== 'boolean') return plain(res, 400, 'Choose On or Off.');
    const s = await exitFlow.saveDirectRelieve(req.body.enabled, req.user);
    res.json({ enabled: s.enabled, isDefault: s.isDefault, updatedByName: s.updatedByName });
  } catch (err) { next(err); }
});
router.post('/employee/:employeeId/relieve-now', async (req, res, next) => {
  try {
    const employee = await prisma.employee.findUnique({ where: { id: req.params.employeeId } });
    if (!employee) return plain(res, 404, 'Employee not found');
    if (desk(req.user) && !employeeInScope(req.user, employee)) return res.status(403).json(OUT_OF_SCOPE);
    const b = req.body || {};
    // A forced failure is only honoured in the sandbox, to prove the transaction rolls back.
    const testFail = b.__testFail === true && require('../utils/sandbox').isSandbox(); // eslint-disable-line global-require
    const status = b.status === 'Exited' ? 'Exited' : 'Relieved';
    const out = await exitFlow.relieveNow({ employee, user: req.user, reason: b.reason, remarks: b.remarks, lastWorkingDate: clean(b.lastWorkingDate, 10), status, testFail });
    res.json({ ok: true, ...out, message: `${employee.name} is now ${status} (last working day ${exitDate.dmy(out.lastWorkingDate)}).` });
  } catch (err) { next(err); }
});

// ---- REJOIN (HR desk): bring a relieved / exited employee back, same ID, history kept (utils/rejoin.js) --------
// GET  /employee/:employeeId/rejoin/options?department=   what the dialog offers (departments, seats of the department, leads ...)
// GET  /employee/:employeeId/rejoin/info                  'First joined ... - Rejoined ...' for the profile and the table
// POST /employee/:employeeId/rejoin                       { date, department, designation, team, tlId, stlId, seat, roleCode, employeeType, location, remarks }
// POST /employee/:employeeId/rejoin/undo                  Admin / Super Admin only, before anything else is recorded
const rejoinLib = () => require('../utils/rejoin'); // eslint-disable-line global-require
async function rejoinTarget(req, res) {
  const employee = await prisma.employee.findUnique({ where: { id: req.params.employeeId } });
  if (!employee) { plain(res, 404, 'Employee not found'); return null; }
  if (desk(req.user) && !employeeInScope(req.user, employee)) { res.status(403).json(OUT_OF_SCOPE); return null; }
  return employee;
}
router.get('/employee/:employeeId/rejoin/info', async (req, res, next) => {
  try {
    const employee = await rejoinTarget(req, res);
    if (!employee) return undefined;
    if (!desk(req.user) && !(req.user.employeeId && req.user.employeeId === employee.id)) return plain(res, 403, 'Only HR can see this.');
    const info = await rejoinLib().info(employee.id);
    return res.json({ ...info, canRejoin: desk(req.user) && rejoinLib().LEFT.includes(employee.employmentStatus) && !(req.user.employeeId && req.user.employeeId === employee.id), canUndo: !!info.rejoined && !req.user.hrSuper && ['SUPER_ADMIN', 'ADMIN'].includes(req.user.role), status: employee.employmentStatus });
  } catch (err) { return next(err); }
});
router.get('/employee/:employeeId/rejoin/options', async (req, res, next) => {
  try {
    if (!desk(req.user)) return plain(res, 403, 'Only HR, an Admin or the Super Admin can bring someone back.');
    const employee = await rejoinTarget(req, res);
    if (!employee) return undefined;
    return res.json(await rejoinLib().optionsFor({ employee, actor: req.user, department: clean(req.query.department, 80) }));
  } catch (err) { return next(err); }
});
router.post('/employee/:employeeId/rejoin', async (req, res, next) => {
  try {
    const employee = await rejoinTarget(req, res);
    if (!employee) return undefined;
    const R = rejoinLib();
    const out = await R.prepare({ employee, actor: req.user, input: req.body || {} });
    if (out.refusal) return plain(res, out.refusal.status, out.refusal.error, out.refusal.code ? { code: out.refusal.code } : {});
    // A forced failure is only honoured in the sandbox, to prove the transaction rolls back.
    const testFail = (req.body || {}).__testFail === true && require('../utils/sandbox').isSandbox(); // eslint-disable-line global-require
    const done = await R.apply({ plan: out.plan, actor: req.user, testFail });
    return res.status(201).json({
      ok: true, recordId: done.recordId, rejoinedOn: out.plan.date, department: out.plan.department, seat: done.seat, seatFrom: done.seatFrom, gap: done.gap,
      needsLogin: done.needsLogin, warnings: out.plan.warnings, told: done.told,
      message: `${employee.name} rejoined on ${R.nice(out.plan.date)}. The ID ${employee.employeeCode} and all history are kept.`,
    });
  } catch (err) { return next(err); }
});
router.post('/employee/:employeeId/rejoin/undo', async (req, res, next) => {
  try {
    if (req.user.hrSuper || !['SUPER_ADMIN', 'ADMIN'].includes(req.user.role)) return plain(res, 403, 'Only an Admin or the Super Admin can undo a rejoin.');
    const employee = await rejoinTarget(req, res);
    if (!employee) return undefined;
    const R = rejoinLib();
    const info = await R.info(employee.id);
    if (!info.rejoined) return plain(res, 409, `${employee.name} has no rejoin to undo.`);
    try {
      await R.undo({ recordId: info.recordId, actor: req.user });
    } catch (e) { if (e.status) return plain(res, e.status, e.message, e.code ? { code: e.code } : {}); throw e; }
    return res.json({ ok: true, message: `The rejoin of ${employee.name} was undone. The status is back to what it was.` });
  } catch (err) { return next(err); }
});

// ---- SUPER ADMIN OVERRIDE: finish an exit WITHOUT approval --------------------------------------
router.post('/employee/:employeeId/finalize-override', async (req, res, next) => {
  try {
    if (!isSA(req.user)) return plain(res, 403, 'Only the Super Admin can use "Finish without approval". HR: use "Relieve now (HR, skip approval)" on the employee.');
    const employee = await prisma.employee.findUnique({ where: { id: req.params.employeeId } });
    if (!employee) return plain(res, 404, 'Employee not found');
    const status = req.body.status === 'Exited' ? 'Exited' : 'Relieved';
    const reason = clean(req.body.reason, 400);
    if (!reason || reason.length < 10) return plain(res, 400, 'Write the reason for finishing this exit without approval (at least a sentence).');
    if (exitFlow.FINAL_STATUSES.includes(employee.employmentStatus)) return plain(res, 409, `${employee.name} has already left.`);
    const live = await exitFlow.ensureExitRecord(employee, req.user, { status: 'Notice Period' });
    const record = await exitFlow.finalize({ record: live.record, employee, user: req.user, status, note: `Finalized WITHOUT approval (Super Admin override): ${reason}`, override: true });
    await logAudit({
      userId: req.user.id, actorName: req.user.name || req.user.email, action: 'Exit finalized WITHOUT approval (Super Admin override)', entity: 'EmployeeRecord', entityId: live.record.id,
      fromValue: employee.employmentStatus, toValue: status, reason,
    });
    const around = await exitFlow.peopleAround(employee);
    const sas = await exitFlow.superAdmins({ allowTest: exitFlow.isTest(employee.name, employee.email) });
    await exitFlow.tell({
      userIds: [around.hr, around.tl, ...sas.map((s) => s.id)], title: `Exit finished without approval: ${employee.name}`,
      message: `${req.user.name || 'The Super Admin'} finished ${employee.name}'s exit without the normal approval. Reason: ${reason}`, link: exitFlow.exitLink(record.id),
      key: `${record.id}:override`, email: true, exceptUserId: req.user.id,
    });
    res.json({ ok: true, recordId: record.id, status });
  } catch (err) { next(err); }
});

// ---- THE EXIT RECORD ------------------------------------------------------------------------------
const LEVEL_WORDS = {
  TL: 'TL reviewed', STL: 'STL reviewed', HR: 'HR reviewed', ASSISTANT_MANAGER: 'Assistant Manager reviewed', MANAGER: 'Manager reviewed', SUPER_ADMIN: 'Super Admin approved',
};

async function timelineOf({ record, employee, detail, steps, day, simple }) {
  const audits = await prisma.auditLog.findMany({
    where: { OR: [{ entity: 'EmployeeRecord', entityId: record.id }, { entity: 'Employee', entityId: employee.id, action: { in: ['Offboarding cleared'] } }] },
    orderBy: { createdAt: 'asc' },
  });
  const lwd = exitDate.dateOf(record, detail);
  const items = [];
  const push = (it) => items.push({ who: null, at: null, note: null, ...it });
  const source = detail && detail.source ? detail.source : 'Filed in TeamLink';
  const reasonText = detail ? (detail.reason === 'Other' && detail.reasonOther ? detail.reasonOther : detail.reason) : record.title;
  push({ key: 'initiated', label: 'Exit initiated', state: 'done', who: detail ? detail.submittedByName : record.raisedBy, at: detail ? detail.submittedAt : record.createdAt, note: simple ? null : `${reasonText || ''}${source ? ` (${source})` : ''}` });
  const rejected = record.status === 'Rejected';
  steps.filter((s) => s.mode !== 'applicant').forEach((s) => {
    if (s.status === 'Visibility') return;
    const direct = !!s.direct;
    if (s.status === 'Skipped' && !/directly|skip ahead/i.test(s.note || '')) return;
    const base = LEVEL_WORDS[s.level] || `${workflow.labelFor(s.level).label} reviewed`;
    if (s.status === 'Approved') push({ key: `step-${s.id}`, label: base, state: 'done', who: s.actedByName || s.approverName, at: s.actedAt, note: simple ? null : [direct ? 'Approved directly (skipped the steps below)' : null, s.note].filter(Boolean).join(' · ') || null });
    else if (s.status === 'Rejected') push({ key: `step-${s.id}`, label: `${workflow.labelFor(s.level).label} rejected`, state: 'rejected', who: s.actedByName || s.approverName, at: s.actedAt, note: simple ? null : s.note });
    else if (s.status === 'Pending') push({ key: `step-${s.id}`, label: `Waiting for ${workflow.labelFor(s.level).label}`, state: 'current', who: s.approverName, at: s.activatedAt, note: simple ? null : s.note });
    else if (s.status === 'Waiting') push({ key: `step-${s.id}`, label: base.replace(/ reviewed| approved/, ' to review'), state: 'todo', who: s.approverName, at: null, note: null });
    else if (s.status === 'Skipped') push({ key: `step-${s.id}`, label: workflow.labelFor(s.level).label, state: 'skipped', who: null, at: null, note: simple ? 'Skipped' : s.note });
  });
  if (record.status === 'Withdrawn') {
    const w = audits.find((a) => /withdrawn/i.test(a.action));
    push({ key: 'withdrawn', label: 'Withdrawn', state: 'rejected', who: w ? w.actorName : null, at: w ? w.createdAt : record.updatedAt });
    return { items, audits };
  }
  if (rejected) return { items, audits };
  const approvedAudit = audits.filter((a) => /^Resignation approved/.test(a.action)).pop();
  const approved = SERVING.includes(record.status) || record.status === 'Relieved';
  const lwdReached = !!lwd && lwd <= day;
  push({
    key: 'notice', label: 'Notice period', state: !approved ? 'todo' : (record.status === 'Relieved' || lwdReached ? 'done' : 'current'),
    who: approved && approvedAudit ? approvedAudit.actorName : null, at: approved && approvedAudit ? approvedAudit.createdAt : null,
    note: lwd ? `Until ${exitDate.dmy(lwd)}` : null,
  });
  push({ key: 'lwd', label: 'Last working day', state: approved && lwdReached ? 'done' : 'todo', at: lwd ? `${lwd}T00:00:00.000Z` : null, note: lwd ? exitDate.dmy(lwd) : 'Not set', dateOnly: true });
  const tasks = (() => { try { return employee.offboardingTasks ? JSON.parse(employee.offboardingTasks) : []; } catch { return []; } })();
  const cleared = employee.offboardingStatus === 'Cleared';
  const clearedAudit = audits.filter((a) => a.action === 'Offboarding cleared').pop();
  push({
    key: 'offboarding', label: 'Offboarding done', state: cleared ? 'done' : (approved ? 'current' : 'todo'), who: cleared && clearedAudit ? clearedAudit.actorName : null, at: cleared && clearedAudit ? clearedAudit.createdAt : null,
    note: tasks.length ? `${tasks.filter((t) => t.completed).length} of ${tasks.length} things done` : null,
  });
  const fnf = await prisma.fnfRequest.findFirst({ where: { employeeId: employee.id }, orderBy: { createdAt: 'desc' } });
  push({
    key: 'fnf', label: 'Full & final', state: fnf && fnf.status === 'Processed' ? 'done' : (fnf ? 'current' : 'todo'), at: fnf ? (fnf.processedAt || fnf.createdAt) : null,
    note: fnf ? (fnf.status === 'Processed' ? 'Settled' : 'Waiting in Payroll') : null,
  });
  const rel = audits.filter((a) => /^Resignation (Relieved|Exited)$/.test(a.action) || /^Exit finalized WITHOUT/.test(a.action)).pop();
  push({
    key: 'relieved', label: employee.employmentStatus === 'Exited' ? 'Exited' : 'Relieved', state: record.status === 'Relieved' ? 'done' : 'todo', who: rel ? rel.actorName : null,
    at: rel ? rel.createdAt : null, note: simple ? null : (rel && /WITHOUT/.test(rel.action) ? `Finished without approval: ${rel.reason || ''}` : null),
  });
  return { items, audits };
}

function eventsOf(audits) {
  const WANT = /^(Exit date changed|Exit dates edited|Exit early release|Exit finalized WITHOUT|Exit sent back|Exit approval finished|Resignation (approved|rejected)|Direct Super Admin)/;
  return audits.filter((a) => WANT.test(a.action)).map((a) => ({
    id: a.id, action: a.action, by: a.actorName || 'System', at: a.createdAt, from: a.fromValue, to: a.toValue, reason: a.reason || null,
  })).reverse();
}

// "WHERE THIS DATE IS USED": each place, its current value, and OK / Mismatch / Check.
async function usageOf({ record, employee, detail }) {
  const lwd = exitDate.dateOf(record, detail);
  const day = today();
  const rows = [];
  const add = (key, label, value, state, note = null) => rows.push({ key, label, value, state, note });
  const dm = (d) => (d ? exitDate.dmy(d) : 'not set');
  if (!lwd) {
    add('record', 'Exit date', 'Not set yet', 'check', 'Set the last working day with Edit exit date.');
    return { rows, allOk: false, date: null };
  }
  const final = exitFlow.FINAL_STATUSES.includes(employee.employmentStatus);
  if (final && lwd > day) add('employee', 'Employee record', `Status ${employee.employmentStatus}, but the last working day is ${dm(lwd)}`, 'mismatch', 'The status says they left; the date is still ahead.');
  else if (!final && ['Notice Period', 'Exit Process'].includes(employee.employmentStatus) && lwd < day) add('employee', 'Employee record', `Status ${employee.employmentStatus}; last working day ${dm(lwd)} has passed`, 'check', 'Ready to be finished (relieved).');
  else add('employee', 'Employee record', `Status ${employee.employmentStatus}; last working day ${dm(lwd)}`, 'ok');
  add('resignation', 'Resignation record', dm(exitDate.isoDay(record.date)), exitDate.isoDay(record.date) === lwd ? 'ok' : 'mismatch');
  const formDate = detail ? (record.status === PENDING ? detail.requestedLastWorkingDate : detail.approvedLastWorkingDate) : null;
  add('form', 'Resignation form', detail ? dm(formDate) : 'No form on file', !detail || formDate === lwd ? 'ok' : 'mismatch');
  const fnf = await prisma.fnfRequest.findFirst({ where: { employeeId: employee.id }, orderBy: { createdAt: 'desc' } });
  if (fnf) add('fnf', 'Full & final', `${fnf.status}, last working day ${dm(exitDate.isoDay(fnf.lastWorkingDate))}`, fnf.status === 'Pending' && exitDate.isoDay(fnf.lastWorkingDate) !== lwd ? 'mismatch' : 'ok');
  else add('fnf', 'Full & final', 'Not raised yet (it is raised when the person is relieved)', 'ok');
  const seat = await exitDate.seatOf(employee.id);
  if (seat.ended) add('seat', 'Seat', `${seat.ended.position.code} ended ${dm(seat.ended.toDate)}`, seat.ended.toDate === lwd ? 'ok' : 'mismatch', seat.ended.toDate === lwd ? null : 'The seat end date is different from the last working day.');
  else if (seat.open) add('seat', 'Seat', `${seat.open.position.code}: frees after ${dm(lwd)}`, lwd < day && final ? 'mismatch' : 'ok');
  else add('seat', 'Seat', 'No seat', 'ok');
  try {
    const D = require('../utils/attendanceDays');
    const roll = await D.rollOf(prisma, [employee]);
    const rolled = roll.lastDayOf.has(employee.id) ? roll.lastDayOf.get(employee.id) : null;
    const after = await prisma.attendance.count({ where: { employeeId: employee.id, date: { gt: lwd }, status: { in: ['Present', 'Half Day', 'Late', 'On Time'] } } });
    const rollOk = rolled ? rolled === lwd : ['Notice Period', 'Exit Process'].includes(employee.employmentStatus);
    add('attendance', 'Attendance', `${rolled ? `On the rolls until ${dm(rolled)}` : 'On the rolls (not yet left)'}; days after it show "Left company"${after ? `; ${after} day(s) marked present after it` : ''}`, rollOk && !after ? 'ok' : (after ? 'check' : 'mismatch'), after ? 'Attendance was marked after the last working day.' : null);
  } catch { add('attendance', 'Attendance', 'Could not read', 'check'); }
  const leaves = await exitDate.leaveAfter(employee.id, lwd);
  add('leave', 'Leave', leaves.length ? `${leaves.length} leave request(s) run past the last working day` : 'No leave after the last working day', leaves.length ? 'check' : 'ok', leaves.length ? leaves.map((l) => `${l.type} ${l.fromDate} to ${l.toDate} (${l.status})`).join('; ') : null);
  const pay = await exitDate.payrollStatusOn(lwd);
  if (pay) {
    const worked = Math.max(0, Math.round((Date.parse(`${lwd > pay.to ? pay.to : lwd}T00:00:00Z`) - Date.parse(`${pay.from}T00:00:00Z`)) / 86400000) + 1);
    add('payroll', 'Payroll', `${monthWords(pay.month)} (${pay.from} to ${pay.to}): ${worked} of ${pay.days} days worked${pay.closed ? `; this payroll is already ${pay.paid ? 'paid' : 'posted'}` : ''}`, pay.closed ? 'check' : 'ok', pay.closed ? 'A difference will be adjusted in the next payroll.' : null);
  } else add('payroll', 'Payroll', 'Not worked out for this month yet', 'ok');
  add('reports', 'Headcount and reports', lwd < day ? `Not counted in headcount after ${dm(lwd)}` : `Counted until ${dm(lwd)}, then "Exited" in the month of ${monthWords(lwd.slice(0, 7))}`, 'ok');
  const login = employee.userId ? await prisma.user.findUnique({ where: { id: employee.userId }, select: { status: true } }) : null;
  add('login', 'Login', login ? `Login ${login.status}; the date is ${dm(lwd)} (the login is not switched off automatically)` : 'No login', 'ok');
  return { rows, allOk: rows.every((r) => r.state === 'ok'), date: lwd };
}

async function buildView(req, ctx) {
  const { record, employee, detail } = ctx;
  const user = req.user;
  const own = isOwn(user, employee) && !desk(user);
  const day = today();
  const steps = await workflow.loadSteps(WF, record.id);
  const lwd = exitDate.dateOf(record, detail);
  const stage = stageOf(record, employee, steps, day, lwd);
  const { items, audits } = await timelineOf({ record, employee, detail, steps, day, simple: own });
  const cur = steps.find((s) => s.status === 'Pending') || null;
  const { mayAct } = await workflow.permissionFor(WF, user);
  const canAct = !!(cur && mayAct && cur.approverUserId === user.id);
  const wfView = steps.length ? await workflow.view(WF, record.id, user, { canAct }) : null;
  const canDirect = !!(wfView && wfView.canDirect && mayAct);
  const mayDecide = !own && (canAct || canDirect);
  const verdict = SERVING.includes(record.status) ? await exitFlow.canFinalizeExit(employee.id) : null;
  const dateChanges = await exitDate.changesFor({ recordId: record.id, limit: 50 });
  const around = await exitFlow.peopleAround(employee);
  const settings = await exitFlow.getSettings();
  const actions = {
    canApprove: mayDecide, canReject: mayDecide, canSendBack: mayDecide, direct: canDirect && !canAct,
    canEditDate: desk(user) && !['Rejected', 'Withdrawn'].includes(record.status),
    canFinalize: desk(user) && !!verdict && verdict.ok,
    finalizeBlocked: desk(user) && verdict && !verdict.ok ? verdict.message : null,
    canEarlyRelease: desk(user) && SERVING.includes(record.status) && !!lwd && lwd > day,
    canOverride: isSA(user) && ![...exitFlow.FINAL_STATUSES].includes(employee.employmentStatus) && !['Rejected', 'Withdrawn'].includes(record.status),
    canWithdraw: isOwn(user, employee) && OPEN.includes(record.status),
    canSettings: isSA(user),
    canMark: await exitFlow.deskDirect(user) && !exitFlow.FINAL_STATUSES.includes(employee.employmentStatus) && !isOwn(user, employee),
  };
  const out = {
    id: record.id,
    employee: { id: employee.id, name: employee.name, employeeCode: employee.employeeCode, department: employee.department, designation: employee.designation, employmentStatus: employee.employmentStatus, dateOfJoining: employee.dateOfJoining ? new Date(employee.dateOfJoining).toISOString().slice(0, 10) : null },
    status: record.status, stage: stage.key, stageLabel: stage.label,
    reason: detail ? (detail.reason === 'Other' && detail.reasonOther ? `Other: ${detail.reasonOther}` : detail.reason) : record.title,
    comments: own ? null : (detail ? detail.comments : record.detail),
    resignationDate: detail ? detail.resignationDate : null,
    noticeDays: detail && detail.noticePeriodDays != null ? detail.noticePeriodDays : null,
    requestedLastWorkingDate: detail ? detail.requestedLastWorkingDate : null,
    lastWorkingDate: lwd,
    daysLeft: lwd && SERVING.includes(record.status) ? Math.ceil((new Date(`${lwd}T00:00:00Z`) - new Date(`${day}T00:00:00Z`)) / 86400000) : null,
    initiatedBy: detail ? detail.submittedByName : null, initiatedAt: detail ? detail.submittedAt : record.createdAt,
    source: detail ? detail.source : null,
    timeline: items,
    simple: own,
    workflow: own ? null : wfView,
    actions: own ? { canWithdraw: actions.canWithdraw } : actions,
    finalApprover: (exitFlow.FINAL_APPROVERS.find(([k]) => k === settings.finalApprover) || [])[1],
    dateChanges: own ? dateChanges.map((d) => ({ from: d.from, to: d.to, at: d.at })) : dateChanges,
  };
  if (!own) {
    out.events = eventsOf(audits);
    out.usage = await usageOf({ record, employee, detail });
    out.people = { tlUserId: around.tl, hrUserId: around.hr };
  }
  return out;
}

router.get('/:id', async (req, res, next) => {
  try {
    const ctx = await loadExit(req.params.id);
    if (!ctx) return plain(res, 404, 'Exit not found');
    if (!(await mayView(req.user, ctx.record, ctx.employee))) return res.status(403).json(OUT_OF_SCOPE);
    res.json(await buildView(req, ctx));
  } catch (err) { next(err); }
});

// ---- the three buttons: Approve / Reject / Send back -----------------------------------------------
async function viaStatusHandler(req, res, next, body) {
  const R = require('./resignations');
  req.body = body;
  return R.statusHandler(req, res, next);
}
const needApprovePerm = requirePerm(null, 'hrms', 'Employee Services', 'approve');
router.post('/:id/approve', needApprovePerm, (req, res, next) => viaStatusHandler(req, res, next, {
  status: 'Accepted', reason: req.body && req.body.note, lastWorkingDate: req.body && req.body.lastWorkingDate,
}));
router.post('/:id/reject', needApprovePerm, (req, res, next) => {
  const note = clean(req.body && req.body.note);
  if (!note || note.length < 3) return plain(res, 400, 'A rejection reason is required.');
  return viaStatusHandler(req, res, next, { status: 'Rejected', reason: note });
});
router.post('/:id/send-back', needApprovePerm, async (req, res, next) => {
  try {
    const ctx = await loadExit(req.params.id);
    if (!ctx || ctx.record.status !== PENDING) return plain(res, 404, 'This exit is not waiting for approval.');
    if (!(await workflow.canSee(WF, ctx.record.id, req.user, ctx.employee))) return res.status(403).json(OUT_OF_SCOPE);
    const out = await exitFlow.sendBack({ recordId: ctx.record.id, user: req.user, note: req.body && req.body.note });
    await exitFlow.notifyTurn({ recordId: ctx.record.id, employee: ctx.employee, detail: ctx.detail, lwd: exitDate.dateOf(ctx.record, ctx.detail) });
    if (!out.to && ctx.detail && ctx.detail.submittedByUserId) {
      await exitFlow.tell({
        userIds: [ctx.detail.submittedByUserId], title: `Exit sent back: ${ctx.employee.name}`,
        message: `${req.user.name || 'The approver'} sent ${ctx.employee.name}'s exit back: ${clean(req.body.note)}`, link: exitFlow.exitLink(ctx.record.id), key: `${ctx.record.id}:back:${Date.now()}`, email: false,
      });
    }
    res.json(await buildView(req, await loadExit(req.params.id)));
  } catch (err) { next(err); }
});

// ---- FINISH the exit (relieve) --------------------------------------------------------------------------
router.post('/:id/finalize', async (req, res, next) => {
  try {
    if (!desk(req.user)) return plain(res, 403, 'Only HR or the Super Admin can finish an exit.');
    const ctx = await loadExit(req.params.id);
    if (!ctx) return plain(res, 404, 'Exit not found');
    if (!employeeInScope(req.user, ctx.employee) && !(await workflow.isParticipant(WF, ctx.record.id, req.user.id))) return res.status(403).json(OUT_OF_SCOPE);
    if (await exitFlow.deskDirect(req.user)) {
      // The HR desk needs no approval: a pending request is closed as "Completed by HR".
      const day = today();
      const lwd = exitDate.dateOf(ctx.record, ctx.detail);
      const out = await exitFlow.relieveNow({ employee: ctx.employee, user: req.user, reason: clean(req.body && req.body.reason, 200) || 'Completed by HR', remarks: clean(req.body && req.body.note, 300), lastWorkingDate: lwd && lwd <= day ? lwd : day, status: req.body && req.body.status === 'Exited' ? 'Exited' : 'Relieved' });
      return res.json({ ...(await buildView(req, await loadExit(req.params.id))), relieved: out });
    }
    if (!SERVING.includes(ctx.record.status)) return plain(res, 409, ctx.record.status === PENDING ? `This exit is not approved yet: ${ctx.employee.name}'s exit is still waiting for approval.` : `This exit is ${ctx.record.status.toLowerCase()}.`);
    const verdict = await exitFlow.canFinalizeExit(ctx.employee.id);
    if (!verdict.ok) return plain(res, 409, verdict.message, { code: verdict.code }); // a process step, not a permission problem
    const status = req.body && req.body.status === 'Exited' ? 'Exited' : 'Relieved';
    await exitFlow.finalize({ record: ctx.record, employee: ctx.employee, user: req.user, status, note: clean(req.body && req.body.note, 300) });
    res.json(await buildView(req, await loadExit(req.params.id)));
  } catch (err) { next(err); }
});

// Early release: HR records it with the approver's note; the last working day becomes today.
router.post('/:id/early-release', async (req, res, next) => {
  try {
    if (!desk(req.user)) return plain(res, 403, 'Only HR or the Super Admin can record an early release.');
    const ctx = await loadExit(req.params.id);
    if (!ctx) return plain(res, 404, 'Exit not found');
    if (!SERVING.includes(ctx.record.status)) return plain(res, 409, 'An early release needs an approved exit that is serving notice.');
    const note = clean(req.body && req.body.note, 400);
    if (!note || note.length < 5) return plain(res, 400, "Write the approver's note: who agreed to release them early, and why.");
    const lwd = exitDate.dateOf(ctx.record, ctx.detail);
    if (lwd && lwd <= today()) return plain(res, 409, 'The last working day has already been reached; just finish the exit.');
    const out = await exitDate.setExitDate({ employeeId: ctx.employee.id, date: today(), reason: `Early release: ${note}`, user: req.user, source: 'UI' });
    await logAudit({ userId: req.user.id, actorName: req.user.name || req.user.email, action: 'Exit early release', entity: 'EmployeeRecord', entityId: ctx.record.id, fromValue: lwd || '(none)', toValue: today(), reason: note });
    await notifyDateChange({ ctx, from: out.from, to: out.to, reason: `Early release: ${note}`, by: req.user });
    res.json({ ...(await buildView(req, await loadExit(req.params.id))), warnings: out.warnings });
  } catch (err) { next(err); }
});

// ---- EDIT EXIT DATE ---------------------------------------------------------------------------------------
async function notifyDateChange({ ctx, from, to, reason, by }) {
  try {
    const around = await exitFlow.peopleAround(ctx.employee);
    const sas = await exitFlow.superAdmins({ allowTest: exitFlow.isTest(ctx.employee.name, ctx.employee.email) });
    const stamp = `${ctx.record.id}:date:${from || 'none'}>${to}:${Date.now()}`;
    const line = `${ctx.employee.name}'s last working day changed from ${from ? exitDate.dmy(from) : 'not set'} to ${exitDate.dmy(to)} by ${by.name || by.email}. Reason: ${reason}`;
    const link = exitFlow.exitLink(ctx.record.id);
    // The employee: their own short summary. TL, HR and the Super Admin(s) (when HR changed it): the full line.
    if (ctx.employee.userId) {
      await exitFlow.tell({ userIds: [ctx.employee.userId], title: 'Your last working day changed', message: `Your last working day is now ${exitDate.dmy(to)} (it was ${from ? exitDate.dmy(from) : 'not set'}).`, link, key: `${stamp}:me`, email: false, exceptUserId: by.id });
    }
    const team = [around.tl, around.hr];
    if (!isSA(by)) team.push(...sas.map((s) => s.id));
    await exitFlow.tell({ userIds: team, title: `Last working day changed: ${ctx.employee.name}`, message: line, link, key: `${stamp}:team`, email: false, exceptUserId: by.id });
    if (ctx.employee.userId == null) return;
    // Leave that now runs past the exit: HR is told.
    const past = await exitDate.leaveAfter(ctx.employee.id, to);
    if (past.length && around.hr) {
      await exitFlow.tell({ userIds: [around.hr], title: `Leave after the last working day: ${ctx.employee.name}`, message: `${ctx.employee.name} has ${past.length} leave request(s) that run past ${exitDate.dmy(to)}. Please check them.`, link, key: `${stamp}:leave`, email: false });
    }
  } catch (err) { console.error('[exitCenter] date change notice failed:', err && err.message); } // eslint-disable-line no-console
}

async function ensureFor(ctx, user) {
  return async () => exitFlow.ensureExitRecord(ctx.employee, user);
}
router.post('/:id/date/check', async (req, res, next) => {
  try {
    if (!desk(req.user)) return plain(res, 403, 'Only HR or the Super Admin can change the last working day.');
    const ctx = await loadExit(req.params.id);
    if (!ctx) return plain(res, 404, 'Exit not found');
    const out = await exitDate.setExitDate({ employeeId: ctx.employee.id, date: req.body && req.body.date, reason: (req.body && req.body.reason) || 'check', user: req.user, dryRun: true });
    res.json({ ok: true, from: out.from, to: out.to, warnings: out.warnings });
  } catch (err) { next(err); }
});
router.put('/:id/date', async (req, res, next) => {
  try {
    if (!desk(req.user)) return plain(res, 403, 'Only HR or the Super Admin can change the last working day.');
    const ctx = await loadExit(req.params.id);
    if (!ctx) return plain(res, 404, 'Exit not found');
    if (['Rejected', 'Withdrawn'].includes(ctx.record.status)) return plain(res, 409, `This exit is ${ctx.record.status.toLowerCase()}, so it has no last working day to change.`);
    const reason = clean(req.body && req.body.reason, 300);
    const out = await exitDate.setExitDate({ employeeId: ctx.employee.id, date: req.body && req.body.date, reason, note: clean(req.body && req.body.note, 200), user: req.user, source: 'UI' });
    await notifyDateChange({ ctx, from: out.from, to: out.to, reason, by: req.user });
    res.json({ ...(await buildView(req, await loadExit(req.params.id))), warnings: out.warnings });
  } catch (err) { next(err); }
});

// ---- EDIT ALL THE EXIT DATES AT ONCE (founder, 2026-10-24) -------------------------------------------------
// "HR (Divya, Purna) and Super Admin Vasu sir must be able to fix the notice period, exit and resignation dates as they see fit."
// The people who may: the HR desk = Super Admin, Admin, HR and the Internal HR delegates (utils/hrSuper.js escalates Divya and Purna to
// Super Admin power), exactly the rule the single "Edit exit date" already used. Three things can change here, any of them alone:
//   resignationDate   when the person resigned                       (ResignationDetail.resignationDate)
//   noticeDays        the notice period in days                      (ResignationDetail.noticePeriodDays)
//   lastWorkingDate   the exit date                                  (through utils/exitDate.js setExitDate: attendance, leave, payroll, seat, F&F follow)
// recalculate:true (and no explicit lastWorkingDate) moves the exit date to resignation date + notice days. A reason is always needed, every
// field that moved gets its own audit row (old -> new, who, why), the people around the exit are told.
router.put('/:id/dates', async (req, res, next) => {
  try {
    if (!desk(req.user)) return plain(res, 403, 'Only HR or the Super Admin can change these dates.');
    const ctx = await loadExit(req.params.id);
    if (!ctx) return plain(res, 404, 'Exit not found');
    if (['Rejected', 'Withdrawn'].includes(ctx.record.status)) return plain(res, 409, `This exit is ${ctx.record.status.toLowerCase()}, so it has no dates to change.`);
    if (!ctx.detail) return plain(res, 409, 'This exit has no resignation form to change.');
    const b = req.body || {};
    const reason = clean(b.reason, 300);
    if (!reason || reason.length < 3) return plain(res, 400, 'Say why the dates are changing (at least a few words).');

    const { record, employee, detail } = ctx;
    const curRes = exitDate.isoDay(detail.resignationDate);
    const curDays = detail.noticePeriodDays != null ? detail.noticePeriodDays : null;
    const curLwd = exitDate.dateOf(record, detail);
    const blank = (v) => v === undefined || v === null || String(v).trim() === '';
    const newRes = blank(b.resignationDate) ? curRes : String(b.resignationDate).trim();
    let newDays = curDays;
    if (!blank(b.noticeDays)) {
      const n = Number(b.noticeDays);
      if (!Number.isInteger(n) || n < 0 || n > 365) return plain(res, 400, 'The notice period is a whole number of days, 0 to 365.');
      newDays = n;
    }
    if (newRes && !exitDate.realDate(newRes)) return plain(res, 400, 'Pick the resignation date as a real date.');
    let newLwd = blank(b.lastWorkingDate) ? curLwd : String(b.lastWorkingDate).trim();
    // the resignation date (or the notice days) moved and no exit date was given: the last working day follows = resignation date + notice days
    // (founder 2026-10-26), unless the caller says recalculate:false
    const startMoved = newRes !== curRes || (b.noticeDays !== undefined && !blank(b.noticeDays));
    if (blank(b.lastWorkingDate) && (b.recalculate || (startMoved && b.recalculate !== false)) && newRes && newDays != null) newLwd = exitFlow.noticeEnd(newRes, newDays);
    if (newLwd && !exitDate.realDate(newLwd)) return plain(res, 400, 'Pick the last working day as a real date.');

    const joined = employee.dateOfJoining ? new Date(employee.dateOfJoining).toISOString().slice(0, 10) : null;
    if (joined && newRes && newRes < joined) return plain(res, 400, `The resignation date cannot be before the joining date (${exitDate.dmy(joined)}).`);
    if (newRes && newLwd && newLwd < newRes) return plain(res, 400, `The last working day cannot be before the resignation date (${exitDate.dmy(newRes)}).`);

    const resChanged = !!newRes && newRes !== curRes;
    const daysChanged = newDays !== curDays;
    const lwdChanged = !!newLwd && newLwd !== curLwd;
    if (!resChanged && !daysChanged && !lwdChanged) return plain(res, 400, 'Nothing is different from what is saved.');

    const by = req.user;
    const actorName = by.name || by.email;
    const row = (field, label, from, to) => logAudit({
      userId: by.id, actorName, action: 'Exit dates edited', entity: 'EmployeeRecord', entityId: record.id,
      field, fieldLabel: label, fromValue: from == null || from === '' ? '(none)' : String(from), toValue: String(to), reason,
    });
    // The resignation date and the notice days first: the last working day check reads the resignation date it finds in the database.
    if (resChanged || daysChanged) {
      await prisma.resignationDetail.update({
        where: { id: detail.id },
        data: { ...(resChanged ? { resignationDate: newRes } : {}), ...(daysChanged ? { noticePeriodDays: newDays } : {}) },
      });
      if (resChanged) await row('resignationDate', 'Resignation date', curRes, newRes);
      if (daysChanged) await row('noticeDays', 'Notice period (days)', curDays, newDays);
    }
    let warnings = [];
    if (lwdChanged) {
      const out = await exitDate.setExitDate({ employeeId: employee.id, date: newLwd, reason, user: by, source: 'UI' });
      warnings = out.warnings || [];
      await notifyDateChange({ ctx, from: out.from, to: out.to, reason, by });
    } else if (resChanged || daysChanged) {
      try {
        const around = await exitFlow.peopleAround(employee);
        const sas = await exitFlow.superAdmins({ allowTest: exitFlow.isTest(employee.name, employee.email) });
        const team = [around.tl, around.hr];
        if (!isSA(by)) team.push(...sas.map((s) => s.id));
        const bits = [resChanged ? `resignation date ${curRes ? exitDate.dmy(curRes) : 'not set'} to ${exitDate.dmy(newRes)}` : null, daysChanged ? `notice period ${curDays == null ? 'not set' : `${curDays} days`} to ${newDays} days` : null].filter(Boolean).join(' and ');
        await exitFlow.tell({ userIds: team, title: `Exit dates changed: ${employee.name}`, message: `${employee.name}'s ${bits} (by ${actorName}). Reason: ${reason}`, link: exitFlow.exitLink(record.id), key: `${record.id}:dates:${Date.now()}`, email: false, exceptUserId: by.id });
      } catch (e) { console.error('[exitCenter] dates notice failed:', e && e.message); } // eslint-disable-line no-console
    }
    return res.json({ ...(await buildView(req, await loadExit(req.params.id))), warnings });
  } catch (err) { next(err); }
});

module.exports = router;
