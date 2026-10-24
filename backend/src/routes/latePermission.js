// ---------------------------------------------------------------------------
// LATE COMING (user, 2026-10-09 "late permission"; 2026-10-10 "late coming ... approval from higher roles").
//
// ONE table, ONE approval chain, two ways to ask (LatePermission.kind):
//   Explain  "Tell why I was late"  - after the person really came late. The date must be a day on which the day
//            engine (utils/attendanceDays.js) says the first check-in was after the Late-after time; the arrival time is
//            READ from the punches (never typed); the reason is picked from a short plain list + a note; an optional
//            picture / PDF can be attached. Window: today back to N days (setting, default 7).
//   Advance  "I will come in late on <day> by <time>" - today (no check-in yet) or a coming day (up to 90 days ahead).
//
// APPROVAL = the same ladder as a leave / attendance regularization (utils/approvalWorkflow.js WORKFLOWS.latePermission:
// TL -> STL -> HR -> Assistant Manager -> Manager -> Super Admin, resolved from the employee's own reporting line, the
// levels and "required / visibility" switches are the Leave -> Approval levels settings). Only the login whose turn it
// is may decide (chain.decide); out-of-scope requests are 403; a rejection needs a reason; nobody decides their own.
//
// WHAT APPROVAL DOES to the day is in utils/latePermission.js + utils/attendanceDays.js: approved = stays Present, "Late
// (approved)", not a late arrival for the policy; pending / rejected / none keep counting as Late with a chip.
//
//   GET   /api/late-permissions/settings              { pastDays, monthlyAllowance, reasons }
//   PUT   /api/late-permissions/settings              Attendance & Time "configure"
//   GET   /api/late-permissions/usage?employeeId&month
//   GET   /api/late-permissions/eligible?date&employeeId   { late, checkIn, kind, canApply, why }
//   GET   /api/late-permissions                       scoped list: ?status&month&from&to&employeeId&department&date
//   POST  /api/late-permissions                       JSON or multipart: { date, reasonCode?, reason?, note?, expectedTime? (Advance),
//                                                      kind?, employeeId? (HR / Admin on behalf), file? }
//   PATCH /api/late-permissions/:id/decision          { status: Approved | Rejected, reason }
//   POST  /api/late-permissions/bulk-decision         { ids:[...], status, reason }  (only the ones whose turn it is)
//   PATCH /api/late-permissions/:id/cancel            the person (or an approver in scope) while Pending
//   GET   /api/late-permissions/:id/attachment        the attached picture / PDF
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm, can } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { employeeRecordWhere, employeeWhere, employeeInScope, OUT_OF_SCOPE } = require('../utils/scope');
const { withoutSystemAccounts } = require('../utils/systemAccounts');
const { systemRequesterError } = require('../utils/systemAccounts');
const chain = require('../utils/chainRoute');
const D = require('../utils/attendanceDays');
const LP = require('../utils/latePermission');
const attachments = require('../utils/attachments');
const { toMinutes } = require('../utils/attendanceMath');
const hrmsNotify = require('../utils/hrmsNotify');
const workflow = require('../utils/approvalWorkflow');

const router = express.Router();
router.use(requireAuth);

// WHO CAN BE PICKED (HRMS item 3, 2026-10-13): only people who still work here. Exited, Relieved, Terminated,
// Inactive and Exit Process employees (treated as left, like the seat rule) and people whose login is switched off
// never appear in the Late-coming pickers, and the server refuses their id.
const LEFT_EMPLOYMENT = ['Exited', 'Relieved', 'Terminated', 'Inactive', 'Exit Process', 'Suspended'];
const isWorking = (e) => !!e && !LEFT_EMPLOYMENT.includes(e.employmentStatus);
const workingWhere = () => ({ AND: [{ employmentStatus: { notIn: LEFT_EMPLOYMENT } }, { OR: [{ userId: null }, { user: { is: { status: { not: 'Inactive' } } } }] }] });
const LEFT_MESSAGE = 'That person no longer works here (exited, relieved or inactive), so a late-coming request cannot be made for them.';

const WF = 'latePermission';
const KEY = 'latePermission.settings';
const DEFAULTS = { pastDays: 7, monthlyAllowance: 0 }; // 0 = unlimited
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const ready = () => !!prisma.latePermission;
// The columns of migration 20261010120000_late_coming exist in the generated client?
const hasNewColumns = () => {
  try { return require('@prisma/client').Prisma.dmmf.datamodel.models.find((m) => m.name === 'LatePermission').fields.some((f) => f.name === 'kind'); } catch { return false; }
};
const EMP_SELECT = { id: true, name: true, employeeCode: true, department: true, designation: true, userId: true, employmentStatus: true };

async function getSettings() {
  let v = {};
  try { const row = await prisma.appSetting.findUnique({ where: { key: KEY } }); v = row ? JSON.parse(row.value) : {}; } catch { v = {}; }
  return {
    pastDays: Number.isInteger(v.pastDays) && v.pastDays >= 0 ? v.pastDays : DEFAULTS.pastDays,
    monthlyAllowance: Number.isInteger(v.monthlyAllowance) && v.monthlyAllowance >= 0 ? v.monthlyAllowance : DEFAULTS.monthlyAllowance,
  };
}
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const hhmm = (t) => { const m = toMinutes(String(t || '')); return m == null ? null : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
async function getCfg() { return (await prisma.hrConfig.findFirst()) || { graceTime: '09:15', weeklyOffDays: '0' }; }
async function ownEmployee(req) { return prisma.employee.findUnique({ where: { userId: req.user.id } }); }
const dmy = (iso) => { const [y, m, d] = String(iso).split('-'); return `${d}-${m}-${y}`; };

// Permissions used in a month = Pending + Approved (a rejected or cancelled one is given back).
async function usageOf(employeeId, month) {
  const s = await getSettings();
  const used = await prisma.latePermission.count({ where: { employeeId, date: { startsWith: month }, status: { in: ['Pending', 'Approved'] } } });
  return { month, used, allowance: s.monthlyAllowance || null, remaining: s.monthlyAllowance ? Math.max(0, s.monthlyAllowance - used) : null };
}

// What the day engine says about this person on this date: the first check-in and whether it was after the Late-after time.
async function lateFacts(employee, date) {
  const cfg = await getCfg();
  const { days } = await D.loadDays(prisma, { employees: [employee], from: date, to: date, cfg, preview: true });
  const row = days(employee)[0] || null;
  const checkIn = row && row.checkIn ? String(row.checkIn).slice(0, 5) : null;
  return { row, cfg, checkIn, late: !!(row && (row.late || row.lateExcused) && checkIn) };
}

// May this login apply for this person on this date, and as which kind? { ok, kind, arrivedAt, error }
async function planFor(employee, date, body, settings) {
  const today = D.localDate();
  if (!ISO.test(date) || !D.isDate(date)) return { error: 'Pick the day you were late (or will be late).' };
  if (date > addDays(today, 90)) return { error: 'That date is too far ahead (90 days at most).' };
  const facts = date <= today ? await lateFacts(employee, date) : null;
  let kind = body.kind === 'Advance' || body.kind === 'Explain' ? body.kind : null;
  if (!kind) kind = (date < today || (facts && facts.checkIn)) ? 'Explain' : 'Advance';
  if (kind === 'Explain') {
    if (date > today) return { error: 'You can tell why you were late only for a day that has started. To ask for a coming day, use "I will be late".' };
    if (date < addDays(today, -settings.pastDays)) return { error: `You can tell why you were late for today and up to ${settings.pastDays} day(s) back. That day is older.` };
    if (!facts.checkIn) return { error: 'There is no check-in for that day, so there is no late arrival to explain.' };
    if (!facts.late) return { error: `You were not late on ${dmy(date)} (first check-in ${D.clock(toMinutes(facts.checkIn))}, not after the Late-after time). Only a late day can be explained.` };
    return { kind, arrivedAt: facts.checkIn, expectedTime: facts.checkIn };
  }
  // Advance
  if (date < today) return { error: 'That day has passed. If you came late, choose "Tell why I was late" - it uses your real check-in time.' };
  if (date === today && facts && facts.checkIn) return { error: 'You have already checked in today. If it was after the Late-after time, choose "Tell why I was late".' };
  const expectedTime = hhmm(body.expectedTime);
  if (!expectedTime) return { error: 'Type the time you will arrive by, like 10:30.' };
  const lateAfter = toMinutes((await getCfg()).graceTime);
  if (lateAfter != null && toMinutes(expectedTime) <= lateAfter) return { error: `Pick a time after ${D.clock(lateAfter)} - that is already on time.` };
  return { kind, arrivedAt: null, expectedTime };
}

// The "Add for a person" picker: working employees in the caller's scope, narrowed by department, with counts.
// GET /api/late-permissions/people?department=  ->  { people:[{id,name,employeeCode,department,designation,userId}], departments:[{name,count}] }
router.get('/people', async (req, res) => {
  try {
    if (req.user.caps.hrmsSelfOnly) return res.json({ people: [], departments: [] });
    const base = { AND: [employeeWhere(req.user), workingWhere(), withoutSystemAccounts({})] };
    const sel = { id: true, name: true, employeeCode: true, department: true, designation: true, userId: true };
    const rows = await prisma.employee.findMany({ where: base, select: sel, orderBy: { name: 'asc' } });
    const counts = new Map();
    rows.forEach((e) => { const d = e.department || 'No department'; counts.set(d, (counts.get(d) || 0) + 1); });
    const dept = String(req.query.department || '').trim();
    const people = dept ? rows.filter((e) => (e.department || 'No department') === dept) : rows;
    res.json({ people, departments: [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name)) });
  } catch (err) { res.status(500).json({ error: 'Could not load the list of people.' }); }
});

router.get('/settings', async (req, res) => res.json({ ...(await getSettings()), reasons: LP.REASONS }));
router.put('/settings', require('../utils/internalHr').blockRoute('settings'), requirePerm(null, 'hrms', 'Attendance & Time', 'configure'), async (req, res) => {
  const cur = await getSettings();
  const next = { ...cur };
  if (req.body.pastDays !== undefined) {
    const n = Number(req.body.pastDays);
    if (!Number.isInteger(n) || n < 0 || n > 30) return res.status(400).json({ error: 'Days back must be a whole number from 0 to 30.' });
    next.pastDays = n;
  }
  if (req.body.monthlyAllowance !== undefined) {
    const n = Number(req.body.monthlyAllowance);
    if (!Number.isInteger(n) || n < 0 || n > 31) return res.status(400).json({ error: 'Requests per month must be a whole number from 0 (no limit) to 31.' });
    next.monthlyAllowance = n;
  }
  await prisma.appSetting.upsert({
    where: { key: KEY }, create: { key: KEY, value: JSON.stringify(next), updatedById: req.user.id, updatedByName: req.user.name },
    update: { value: JSON.stringify(next), updatedById: req.user.id, updatedByName: req.user.name },
  });
  await logAudit({ userId: req.user.id, action: 'Late coming settings changed', entity: 'AppSetting', entityId: KEY, fromValue: JSON.stringify(cur), toValue: JSON.stringify(next) });
  res.json({ ...next, reasons: LP.REASONS });
});

// Who may I look at? myself, or someone in my scope.
async function targetEmployee(req, employeeId) {
  const own = await ownEmployee(req);
  if (!employeeId || (own && employeeId === own.id)) return { employee: own, own };
  if (req.user.caps.hrmsSelfOnly) return { error: { status: 403, body: { error: 'You can only look at your own days.' } } };
  const e = await prisma.employee.findUnique({ where: { id: String(employeeId) } });
  if (!e) return { error: { status: 404, body: { error: 'That employee was not found.' } } };
  if (!employeeInScope(req.user, e)) return { error: { status: 403, body: OUT_OF_SCOPE } };
  if (!isWorking(e)) return { error: { status: 400, body: { error: LEFT_MESSAGE } } };
  return { employee: e, own };
}

router.get('/usage', async (req, res) => {
  if (!ready()) return res.json({ used: 0, allowance: null, remaining: null });
  const t = await targetEmployee(req, String(req.query.employeeId || ''));
  if (t.error) return res.status(t.error.status).json(t.error.body);
  if (!t.employee) return res.json({ used: 0, allowance: null, remaining: null });
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? String(req.query.month) : D.localDate().slice(0, 7);
  res.json(await usageOf(t.employee.id, month));
});

// The form asks this when a date is picked: was the person late that day, and at what time did they come?
router.get('/eligible', async (req, res) => {
  const date = String(req.query.date || '').slice(0, 10);
  const t = await targetEmployee(req, String(req.query.employeeId || ''));
  if (t.error) return res.status(t.error.status).json(t.error.body);
  if (!t.employee) return res.status(404).json({ error: 'No employee record linked to this account' });
  const s = await getSettings();
  const plan = await planFor(t.employee, date, { kind: req.query.kind }, s).catch((e) => ({ error: e.message }));
  const clash = ready() && ISO.test(date) ? await prisma.latePermission.findFirst({ where: { employeeId: t.employee.id, date, status: { not: 'Cancelled' } } }) : null;
  res.json({
    date, kind: plan.kind || null, arrivedAt: plan.arrivedAt || null, canApply: !plan.error && !clash,
    why: clash ? `There is already a request for ${dmy(date)} (${clash.status.toLowerCase()}).` : (plan.error || ''),
    existing: clash ? { id: clash.id, status: clash.status } : null, windowDays: s.pastDays,
  });
});

// Scope like Regularization: department scope OR being named on the request's own chain; an employee sees only their own.
router.get('/', async (req, res) => {
  if (!ready()) return res.json([]);
  const own = await ownEmployee(req);
  const scoped = employeeRecordWhere(req.user); // { employee: <scope> } or {} (everyone)
  const onMyChain = await chain.participantIds(WF, req.user.id);
  const and = [];
  if (req.user.caps.hrmsSelfOnly) {
    if (!own) return res.json([]);
    and.push({ employeeId: own.id });
  } else {
    // department / team scope, OR being named on the request's own chain (an approver outside the scope still sees what they decide)
    if (Object.keys(scoped).length) and.push({ OR: onMyChain.length ? [scoped, { id: { in: onMyChain } }] : [scoped] });
    if (req.query.employeeId) and.push({ employeeId: String(req.query.employeeId) });
  }
  if (req.query.status) and.push({ status: String(req.query.status) });
  if (ISO.test(String(req.query.date || ''))) and.push({ date: String(req.query.date) });
  else if (/^d{4}-d{2}$/.test(String(req.query.month || ''))) and.push({ date: { startsWith: String(req.query.month) } });
  else {
    if (ISO.test(String(req.query.from || ''))) and.push({ date: { gte: String(req.query.from) } });
    if (ISO.test(String(req.query.to || ''))) and.push({ date: { lte: String(req.query.to) } });
  }
  if (req.query.department) and.push({ employee: { is: { department: String(req.query.department) } } });
  const rows = await prisma.latePermission.findMany({ where: and.length ? { AND: and } : {}, include: { employee: { select: EMP_SELECT } }, orderBy: [{ date: 'desc' }, { requestedAt: 'desc' }], take: 2000 });
  res.json((await chain.decorate(WF, rows)).map((r) => ({ ...r, reasonLabel: LP.REASON_LABEL[r.reasonCode] || null, hasAttachment: !!r.attachmentFile, attachmentFile: undefined })));
});

router.post('/', async (req, res) => {
  if (!ready()) return res.status(503).json({ error: 'Late coming is not set up yet. Ask Admin to finish the update.' });
  // JSON, or multipart when a picture / PDF is attached.
  let body = req.body || {};
  let file = null;
  if (/^multipart\/form-data/i.test(req.headers['content-type'] || '')) {
    try { const parsed = await attachments.parseMultipart(req); body = parsed.fields; file = parsed.file; } catch (err) {
      return res.status(400).json({ error: attachments.MESSAGE[err.code] || 'Could not read the form.' });
    }
  }
  const date = String(body.date || '').slice(0, 10);
  const note = String(body.note || '').trim() || null;
  const reasonCode = String(body.reasonCode || '').trim();
  if (reasonCode && !LP.REASON_LABEL[reasonCode]) return res.status(400).json({ error: 'Pick a reason from the list.' });
  // The reason line: the picked reason (+ the note), or free text from an older caller.
  let reason = String(body.reason || '').trim();
  if (reasonCode) {
    if (reasonCode === 'other' && (!note || note.length < 3)) return res.status(400).json({ error: 'Please write a few words in the note - you picked "Something else".' });
    reason = reasonCode === 'other' ? note : LP.REASON_LABEL[reasonCode];
  }
  if (reason.length < 3) return res.status(400).json({ error: 'Please say why (pick a reason from the list).' });

  // Who is it for? Yourself - or, for HR / Admin (approve right on Attendance & Time), somebody in their scope.
  const mine = await ownEmployee(req);
  let employee = mine;
  const onBehalf = body.employeeId && (!mine || body.employeeId !== mine.id);
  if (onBehalf) {
    if (req.user.caps.hrmsSelfOnly || !await can(req.user, 'hrms', 'hrms', 'Attendance & Time', 'approve')) return res.status(403).json({ error: 'Only HR or Admin can apply for somebody else.' });
    employee = await prisma.employee.findUnique({ where: { id: String(body.employeeId) } });
    if (!employee) return res.status(404).json({ error: 'That employee was not found.' });
    if (!employeeInScope(req.user, employee)) return res.status(403).json(OUT_OF_SCOPE);
    if (!isWorking(employee)) return res.status(400).json({ error: LEFT_MESSAGE });
    const lu = employee.userId ? await prisma.user.findUnique({ where: { id: employee.userId }, select: { status: true } }) : null;
    if (lu && lu.status === 'Inactive') return res.status(400).json({ error: LEFT_MESSAGE });
  }
  if (!employee) return res.status(404).json({ error: 'No employee record linked to this account' });
  { const sys = await systemRequesterError(employee, 'late coming'); if (sys) return res.status(403).json({ error: sys }); }

  const s = await getSettings();
  const plan = await planFor(employee, date, body, s);
  if (plan.error) return res.status(400).json({ error: plan.error });
  const clash = await prisma.latePermission.findFirst({ where: { employeeId: employee.id, date, status: { not: 'Cancelled' } } });
  if (clash) return res.status(409).json({ error: `There is already a late coming request for ${dmy(date)} (${clash.status.toLowerCase()}). Cancel it first to apply again.` });
  if (s.monthlyAllowance) {
    const u = await usageOf(employee.id, date.slice(0, 7));
    if (u.used >= s.monthlyAllowance) return res.status(409).json({ error: `${employee.id === (mine && mine.id) ? 'You have' : `${employee.name} has`} used all ${s.monthlyAllowance} late coming request(s) for this month.` });
  }

  const data = { employeeId: employee.id, date, expectedTime: plan.expectedTime, reason, note, appliedBy: req.user.name || req.user.email };
  let stored = null;
  if (hasNewColumns()) {
    data.kind = plan.kind; data.reasonCode = reasonCode || null; data.arrivedAt = plan.arrivedAt || null;
    if (file) {
      try { stored = attachments.store(file); } catch (err) { return res.status(400).json({ error: attachments.MESSAGE[err.code] || 'Could not save the attachment.' }); }
      data.attachmentFile = stored.billFile; data.attachmentName = stored.billName;
    }
  } else if (file) return res.status(503).json({ error: 'Attachments need the pending database update. Ask Admin to finish the update.' });
  let perm;
  try {
    perm = await prisma.latePermission.create({ data });
  } catch (e) {
    if (stored) attachments.remove(stored.billFile);
    if (/unique/i.test(String(e.message))) return res.status(409).json({ error: `There is already a late coming request for ${dmy(date)}.` });
    throw e;
  }
  await logAudit({
    userId: req.user.id, action: onBehalf ? `Late coming requested for ${employee.name}` : 'Late coming requested', entity: 'LatePermission', entityId: perm.id,
    toValue: `${plan.kind === 'Explain' ? 'came' : 'until'} ${plan.expectedTime} on ${date} · ${reason}${onBehalf ? ` · applied by ${req.user.name || req.user.email} on behalf` : ''}`,
  });
  // The chain goes down with the request; the approvers see it in "Approvals waiting on me" and their bell.
  const started = await chain.raise(WF, { recordId: perm.id, employee });
  hrmsNotify.latePermissionRaised({ perm, employee, by: req.user }).catch((e) => console.error('[latePermission] notify failed', e.message));
  res.status(201).json({ ...perm, attachmentFile: undefined, workflow: started.summary });
});

// One decision, shared by the single and the bulk route: { status, body }.
async function decideOne(user, id, status, comment) {
  const existing = await prisma.latePermission.findUnique({ where: { id }, include: { employee: true } });
  if (!existing) return { status: 404, body: { error: 'Request not found' } };
  if (!await chain.mayTouch(WF, existing.id, user, existing.employee)) return { status: 403, body: chain.OUT_OF_SCOPE };
  if (existing.employee && existing.employee.userId && existing.employee.userId === user.id) return { status: 403, body: { error: 'You cannot decide your own request. Your approver will.' } };
  if (existing.status !== 'Pending') return { status: 409, body: { error: `This request was already ${existing.status.toLowerCase()}.` } };
  if (status === 'Rejected' && !comment) return { status: 400, body: { error: 'A rejection reason is required.' } };

  await chain.ensure(WF, { recordId: existing.id, employee: existing.employee, open: true });
  const step = await chain.decide(WF, existing.id, user, { decision: status, note: comment || null });
  if (step.error) return { status: step.error.status, body: step.error.body };
  if (step.chained && !step.result.complete) {
    await logAudit({ userId: user.id, action: `Late coming ${status.toLowerCase()} at ${step.result.level}`, entity: 'LatePermission', entityId: existing.id, fromValue: step.result.level, toValue: step.result.nextLevel || step.result.outcome });
    return { status: 200, body: { ...existing, employee: undefined, status: 'Pending', workflow: step.view } };
  }
  const perm = await prisma.latePermission.update({
    where: { id: existing.id },
    data: { status, decidedAt: new Date(), decidedById: user.id, decidedBy: user.name || user.email, decisionNote: comment || null },
  });
  await logAudit({ userId: user.id, action: `Late coming ${status.toLowerCase()}`, entity: 'LatePermission', entityId: perm.id, fromValue: 'Pending', toValue: `${status}${comment ? ` · ${comment}` : ''}` });
  if (status === 'Approved') require('../utils/attendanceTasks').closeFixedFor(perm.employeeId);
  hrmsNotify.latePermissionDecided({ perm, employee: existing.employee, by: user }).catch((e) => console.error('[latePermission] notify failed', e.message));
  return { status: 200, body: { ...perm, attachmentFile: undefined } };
}

router.patch('/:id/decision', requirePerm(null, 'hrms', 'Attendance & Time', 'approve'), async (req, res) => {
  const { status } = req.body;
  if (!['Approved', 'Rejected'].includes(status)) return res.status(400).json({ error: 'status must be Approved or Rejected' });
  const comment = String(req.body.reason || req.body.comment || req.body.rejectReason || '').trim();
  const r = await decideOne(req.user, req.params.id, status, comment);
  res.status(r.status).json(r.body);
});

// Approve / reject many at once. Each one is decided on its own (only the login whose turn it is succeeds);
// the answer lists what was done and what was skipped, with the reason in plain words.
router.post('/bulk-decision', requirePerm(null, 'hrms', 'Attendance & Time', 'approve'), async (req, res) => {
  const { status } = req.body;
  if (!['Approved', 'Rejected'].includes(status)) return res.status(400).json({ error: 'status must be Approved or Rejected' });
  const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map(String))].slice(0, 200);
  if (!ids.length) return res.status(400).json({ error: 'Tick at least one request.' });
  const comment = String(req.body.reason || '').trim();
  if (status === 'Rejected' && !comment) return res.status(400).json({ error: 'A rejection reason is required.' });
  const done = []; const skipped = [];
  for (const id of ids) { // eslint-disable-line no-restricted-syntax
    const r = await decideOne(req.user, id, status, comment); // eslint-disable-line no-await-in-loop
    if (r.status === 200) done.push({ id, status: r.body.status, moved: r.body.status === 'Pending' }); else skipped.push({ id, error: (r.body && r.body.error) || 'Could not decide this one.' });
  }
  res.json({ done: done.length, skipped: skipped.length, results: done, skippedList: skipped });
});

// Withdraw while Pending: the person it is for, or an approver in scope. Open approval steps close as Skipped.
router.patch('/:id/cancel', async (req, res) => {
  const existing = await prisma.latePermission.findUnique({ where: { id: req.params.id }, include: { employee: true } });
  if (!existing) return res.status(404).json({ error: 'Request not found' });
  const mine = await ownEmployee(req);
  const isOwner = !!(mine && mine.id === existing.employeeId);
  const isApprover = !isOwner && !req.user.caps.hrmsSelfOnly && await can(req.user, 'hrms', 'hrms', 'Attendance & Time', 'approve') && employeeInScope(req.user, existing.employee);
  if (!isOwner && !isApprover) return res.status(403).json({ error: 'Only the person it is for (or HR) can cancel a late coming request.' });
  if (existing.status !== 'Pending') return res.status(409).json({ error: `This request was already ${existing.status.toLowerCase()}.` });
  const perm = await prisma.latePermission.update({ where: { id: existing.id }, data: { status: 'Cancelled', cancelledAt: new Date() } });
  await prisma.approvalStep.updateMany({
    where: { workflow: WF, recordId: existing.id, status: { in: ['Pending', 'Waiting'] } },
    data: { status: 'Skipped', note: 'Not reached — the request was cancelled' },
  });
  await logAudit({ userId: req.user.id, action: 'Late coming cancelled', entity: 'LatePermission', entityId: existing.id, fromValue: 'Pending', toValue: 'Cancelled' });
  res.json({ ...perm, attachmentFile: undefined });
});

router.get('/:id/attachment', async (req, res) => {
  const row = await prisma.latePermission.findUnique({ where: { id: req.params.id }, include: { employee: true } });
  if (!row || !row.attachmentFile) return res.status(404).json({ error: 'No attachment.' });
  const mine = await ownEmployee(req);
  const ok = (mine && mine.id === row.employeeId) || await chain.mayTouch(WF, row.id, req.user, row.employee);
  if (!ok) return res.status(403).json(OUT_OF_SCOPE);
  const full = attachments.resolveStored(row.attachmentFile);
  if (!full) return res.status(404).json({ error: 'The file is gone.' });
  res.setHeader('Content-Disposition', `inline; filename="${String(row.attachmentName || 'attachment').replace(/[^\w.\- ]/g, '_')}"`);
  return res.sendFile(full);
});

void workflow;
module.exports = router;
module.exports.getSettings = getSettings;
module.exports.usageOf = usageOf;
