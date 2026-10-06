// ---------------------------------------------------------------------------
// /api/recruiter-joinings — HRMS → Performance & Development → Recruiter
// joinings, and the Super Admin popup on the HRMS dashboard (user, 2026-10-05).
// The count itself is utils/recruiterJoinings.js (one rule, one place).
//
// WHO SEES WHAT (server-enforced; the screen only hides):
//   Super Admin       everyone, every decision with its amount; the ONLY one
//                     who may decide (incentive / raise / no action), set
//                     targets, snooze the popup.
//   Admin / HR /      everyone's joinings vs target and WHICH decision was
//   Manager / AM      taken — never an amount or the note.
//   TL / STL          their team's joinings vs target (seats under their TL
//                     seat, else their team / department) — no decisions.
//   Recruiter / rest  their own row only — no decisions.
// Every decision, target change and export is written to the AuditLog.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../middleware/auth');
const { scopeOf } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const { toXlsxBook } = require('../utils/tabularExport');
const RJ = require('../utils/recruiterJoinings');
const SV = require('../utils/salaryVersions');

const router = express.Router();
router.use(requireAuth);

const DECISIONS = { INCENTIVE: 'Incentive given', RAISE: 'Salary raised', NONE: 'No action' };
const MAX_INCENTIVE = 500000;
const SNOOZE_KEY = (userId) => `recruiterJoinings.snooze.${userId}`;
const rupee = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const s = (v) => (typeof v === 'string' ? v.trim() : '');

function isSuperAdmin(user) {
  const sc = scopeOf(user);
  return sc.role === 'SUPER_ADMIN' || sc.hrmsRole === 'SUPER_ADMIN';
}
function viewerOf(user) {
  const sc = scopeOf(user);
  if (isSuperAdmin(user)) return { level: 'sa', money: true, decide: true, decisions: true };
  if (sc.adminGlobal || sc.global || sc.hrmsRole === 'HR' || sc.role === 'HR') return { level: 'all', money: false, decide: false, decisions: true };
  if (['TL', 'STL'].includes(sc.atsRole)) return { level: 'team', money: false, decide: false, decisions: false };
  return { level: 'self', money: false, decide: false, decisions: false };
}

// The rows this viewer may see.
function scopeRows(user, viewer, rows) {
  if (viewer.level === 'sa' || viewer.level === 'all') return rows;
  if (viewer.level === 'team') {
    const sc = scopeOf(user);
    const p = sc.positions;
    if (p) {
      const codes = new Set(p.positionCodes || []);
      const holders = new Set(p.holderUserIds || []);
      return rows.filter((r) => r.userId === user.id || r.tlUserId === user.id || (r.seat && codes.has(r.seat)) || (r.userId && holders.has(r.userId)));
    }
    if (sc.teamUserIds) {
      const team = new Set(sc.teamUserIds);
      return rows.filter((r) => r.userId === user.id || r.tlUserId === user.id || (r.userId && team.has(r.userId)));
    }
    const depts = new Set(sc.departments || []);
    return rows.filter((r) => r.userId === user.id || r.tlUserId === user.id || (r.department && depts.has(r.department)));
  }
  return rows.filter((r) => (r.userId && r.userId === user.id) || (user.employeeId && r.employeeId === user.employeeId));
}

// A decision as this viewer may see it.
function decisionFor(viewer, d) {
  if (!d || !viewer.decisions) return null;
  const base = {
    id: d.id, decision: d.decision, word: DECISIONS[d.decision] || d.decision,
    decidedByName: d.decidedByName, decidedAt: d.updatedAt, raiseFrom: d.raiseFrom || null,
    payMonth: d.payMonth || null, payLabel: d.payMonth ? RJ.monthLabel(d.payMonth) : null,
  };
  if (!viewer.money) return base;
  return { ...base, amount: d.amount, note: d.note, salaryVersionId: d.salaryVersionId, payrollEntryId: d.payrollEntryId, joinings: d.joinings, target: d.target };
}

function shapeBoard(user, viewer, board) {
  const rows = scopeRows(user, viewer, board.rows).map((r) => ({ ...r, decision: decisionFor(viewer, r.decision) }));
  const needs = rows.filter((r) => r.needsDecision);
  const summary = {
    people: rows.length,
    joinings: rows.reduce((n, r) => n + r.joinings, 0),
    target: rows.reduce((n, r) => n + (r.target || 0), 0),
    reached: rows.filter((r) => r.tone === 'green').length,
    close: rows.filter((r) => r.tone === 'orange').length,
    low: rows.filter((r) => r.tone === 'red').length,
    notCounted: rows.reduce((n, r) => n + r.notCountedCount, 0),
  };
  if (viewer.decisions) {
    summary.needDecision = needs.length;
    summary.decided = needs.filter((r) => r.decision).length;
    summary.pending = needs.filter((r) => !r.decision).length;
  }
  return {
    month: board.month, label: board.label, from: board.from, to: board.to, ended: board.ended, current: board.current,
    defaultTarget: board.defaultTarget, rule: board.rule,
    rows,
    // Skipped = joined but credited to nobody: only the company-wide viewers.
    skipped: viewer.level === 'sa' || viewer.level === 'all' ? board.skipped : [],
    undatedCount: viewer.level === 'sa' || viewer.level === 'all' ? board.undatedCount : 0,
    summary,
    viewer: { level: viewer.level, money: viewer.money, decide: viewer.decide && board.ended, decisions: viewer.decisions, setTarget: viewer.level === 'sa' },
  };
}

const monthOf = (q, fallback) => {
  const m = s(q && q.month);
  return RJ.isMonth(m) ? m : fallback;
};
const err = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });
const guarded = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    if (e && e.status) return err(res, e.status, e.message);
    // eslint-disable-next-line no-console
    console.error('[recruiter-joinings]', e);
    return err(res, 500, 'Something went wrong loading recruiter joinings. Please try again.');
  }
  return undefined;
};

// ---- Board ------------------------------------------------------------------
router.get('/board', guarded(async (req, res) => {
  const month = monthOf(req.query, RJ.thisMonth());
  const viewer = viewerOf(req.user);
  const board = await RJ.monthBoard(month, { fresh: req.query.fresh === '1' });
  res.json(shapeBoard(req.user, viewer, board));
}));

// The signed-in person's own "3 of 4 this month".
router.get('/mine', guarded(async (req, res) => {
  const month = monthOf(req.query, RJ.thisMonth());
  const own = await RJ.ownFigure(req.user, month);
  if (!own) return res.json({ month, label: RJ.monthLabel(month), listed: false });
  return res.json({ ...own, listed: true });
}));

// Month by month for one person.
router.get('/history/:employeeId', guarded(async (req, res) => {
  const viewer = viewerOf(req.user);
  const id = req.params.employeeId;
  // In scope? Their row must be visible to this viewer in this or last month,
  // or (TL) they must sit in the team; self is always fine.
  const [cur, prev] = await Promise.all([RJ.monthBoard(RJ.thisMonth()), RJ.monthBoard(RJ.prevMonth())]);
  const visible = [...scopeRows(req.user, viewer, cur.rows), ...scopeRows(req.user, viewer, prev.rows)].some((r) => r.employeeId === id);
  if (!visible && viewer.level !== 'sa' && viewer.level !== 'all') return err(res, 403, 'You can only see the people in your own area.');
  const months = Math.min(24, Math.max(3, Number(req.query.months) || 12));
  const hist = await RJ.personHistory(id, months);
  const emp = await prisma.employee.findUnique({ where: { id }, select: { id: true, name: true, employeeCode: true } });
  res.json({ employee: emp, months: hist.map((h) => ({ ...h, decision: decisionFor(viewer, h.decision) })) });
}));

// Joined applications that belong to no month (no usable joining date).
router.get('/skipped', guarded(async (req, res) => {
  const viewer = viewerOf(req.user);
  if (!['sa', 'all'].includes(viewer.level)) return err(res, 403, 'Only Super Admin, Admin and HR can see this list.');
  const month = monthOf(req.query, RJ.thisMonth());
  const [board, undated] = await Promise.all([RJ.monthBoard(month), RJ.undatedJoinings(month)]);
  res.json({ month, label: board.label, noRecruiter: board.skipped, undated });
}));

// ---- Popup (Super Admin, HRMS dashboard) ------------------------------------------
async function snoozedToday(userId) {
  const row = await prisma.appSetting.findUnique({ where: { key: SNOOZE_KEY(userId) } }).catch(() => null);
  if (!row) return false;
  try { return JSON.parse(row.value).day === RJ.todayIst(); } catch { return false; }
}
router.get('/popup', guarded(async (req, res) => {
  const viewer = viewerOf(req.user);
  if (viewer.level !== 'sa') return res.json({ show: false });
  const month = RJ.prevMonth();
  const board = shapeBoard(req.user, viewer, await RJ.monthBoard(month));
  const snoozed = await snoozedToday(req.user.id);
  const pending = board.summary.pending || 0;
  // ?peek=1 opens it on demand (the "Recruiter joinings" button), snoozed or not.
  const show = pending > 0 && (!snoozed || req.query.peek === '1');
  return res.json({ show, snoozed, pending, ...board });
}));
router.post('/popup/snooze', guarded(async (req, res) => {
  if (!isSuperAdmin(req.user)) return err(res, 403, 'Only Super Admin decides recruiter incentives.');
  const value = JSON.stringify({ day: RJ.todayIst(), month: RJ.prevMonth() });
  await prisma.appSetting.upsert({
    where: { key: SNOOZE_KEY(req.user.id) },
    create: { key: SNOOZE_KEY(req.user.id), value, updatedById: req.user.id, updatedByName: req.user.name },
    update: { value, updatedById: req.user.id, updatedByName: req.user.name },
  });
  res.json({ ok: true, message: 'Okay — we will remind you again tomorrow.' });
}));

// ---- Decisions (Super Admin only) ------------------------------------------------
// The payroll month an incentive is paid in: the month after the joinings
// (or this month, if that is later), moved past any month whose payroll for
// this employee is already beyond Draft.
async function payMonthFor(employeeId, month) {
  let pm = RJ.nextMonth(month);
  if (RJ.thisMonth() > pm) pm = RJ.thisMonth();
  const locked = await SV.lastLockedMonth(employeeId);
  if (locked && locked.month >= pm) pm = RJ.nextMonth(locked.month);
  return pm;
}
async function lockedEntry(d) {
  if (!d || d.decision !== 'INCENTIVE' || !d.payMonth) return null;
  const e = await prisma.employeePayrollRun.findUnique({ where: { employeeId_month: { employeeId: d.employeeId, month: d.payMonth } }, select: { id: true, status: true } });
  return e && e.status !== 'DRAFT' ? e : null;
}
const summaryOf = (d) => {
  if (!d) return null;
  if (d.decision === 'INCENTIVE') return `Incentive ${rupee(d.amount)} (paid with ${RJ.monthLabel(d.payMonth)} salary)`;
  if (d.decision === 'RAISE') return `Salary raised from ${RJ.monthLabel(d.raiseFrom)}`;
  return 'No action';
};

router.post('/decisions', guarded(async (req, res) => {
  if (!isSuperAdmin(req.user)) return err(res, 403, 'Only Super Admin decides recruiter incentives and salary raises.');
  const body = req.body || {};
  const month = s(body.month);
  const decision = s(body.decision).toUpperCase();
  const employeeId = s(body.employeeId);
  const note = s(body.note).slice(0, 500) || null;
  if (!RJ.isMonth(month)) return err(res, 400, 'Pick the month.');
  if (month >= RJ.thisMonth()) return err(res, 400, `${RJ.monthLabel(month)} has not ended yet — decide after the month is over.`);
  if (!DECISIONS[decision]) return err(res, 400, 'Choose Give incentive, Raise salary or No action.');
  const board = await RJ.monthBoard(month, { fresh: true });
  const row = board.rows.find((r) => r.employeeId === employeeId);
  if (!row) return err(res, 404, 'This person is not on the recruiter list for that month.');
  const emp = await prisma.employee.findUnique({ where: { id: employeeId }, select: { id: true, name: true, employmentStatus: true } });
  const existing = await prisma.recruiterJoiningDecision.findUnique({ where: { employeeId_month: { employeeId, month } } });
  const lock = await lockedEntry(existing);
  if (lock) return err(res, 409, `The incentive is already in ${RJ.monthLabel(existing.payMonth)} payroll (${lock.status.replace(/_/g, ' ').toLowerCase()}), so it can no longer be changed.`);

  const data = {
    joinings: row.joinings, target: row.target, decision, note,
    amount: null, payMonth: null, payrollEntryId: null, salaryVersionId: null, raiseFrom: null,
    decidedById: req.user.id, decidedByName: req.user.name,
  };
  if (decision === 'INCENTIVE') {
    const amount = Math.round(Number(body.amount));
    if (!(amount > 0)) return err(res, 400, 'Enter the incentive amount in rupees.');
    if (amount > MAX_INCENTIVE) return err(res, 400, `That is more than ${rupee(MAX_INCENTIVE)} — please check the amount.`);
    if (!RJ.PAYABLE.includes(emp.employmentStatus)) return err(res, 409, `${emp.name} is no longer on the payroll (${emp.employmentStatus}). Pay it in their final settlement instead, and choose No action here.`);
    data.amount = amount;
    data.payMonth = await payMonthFor(employeeId, month);
  } else if (decision === 'RAISE') {
    const vid = s(body.salaryVersionId);
    const v = vid ? await prisma.salaryStructureVersion.findUnique({ where: { id: vid } }) : null;
    if (!v || v.employeeId !== employeeId) return err(res, 400, 'Save the new salary first, then record the raise.');
    if (v.effectiveFrom.slice(0, 7) <= month) return err(res, 400, `The raise must start after ${RJ.monthLabel(month)}.`);
    data.salaryVersionId = v.id;
    data.raiseFrom = v.effectiveFrom.slice(0, 7);
  }
  const saved = existing
    ? await prisma.recruiterJoiningDecision.update({ where: { id: existing.id }, data })
    : await prisma.recruiterJoiningDecision.create({ data: { employeeId, month, ...data } });
  await logAudit({
    userId: req.user.id, actorName: req.user.name,
    action: existing ? 'Recruiter joinings decision changed' : 'Recruiter joinings decision',
    entity: 'RecruiterJoiningDecision', entityId: saved.id,
    fromValue: summaryOf(existing),
    toValue: `${row.name}${row.seat ? ` · ${row.seat}` : ''} · ${board.label} · ${row.joinings} / ${row.target} joinings → ${summaryOf(saved)}`,
    reason: note,
  });
  // A payroll draft already calculated for the pay month must be recalculated
  // before it can be submitted (payrollEngine.transition checks this).
  const months = [...new Set([saved.payMonth, existing && existing.payMonth].filter(Boolean))];
  const drafts = months.length ? await prisma.employeePayrollRun.findMany({ where: { employeeId, month: { in: months }, status: 'DRAFT' }, select: { month: true } }) : [];
  RJ.invalidate();
  const word = decision === 'INCENTIVE'
    ? `Saved — ${row.name} gets an incentive of ${rupee(saved.amount)} with the ${RJ.monthLabel(saved.payMonth)} salary.`
    : decision === 'RAISE' ? `Saved — ${row.name}'s salary is raised from ${RJ.monthLabel(saved.raiseFrom)}.` : `Saved — no action for ${row.name}.`;
  return res.json({
    ok: true, message: word, decision: decisionFor(viewerOf(req.user), saved),
    recalculate: drafts.map((d) => d.month),
  });
}));

// Undo a decision (not once its incentive is in an approved payroll).
router.delete('/decisions/:id', guarded(async (req, res) => {
  if (!isSuperAdmin(req.user)) return err(res, 403, 'Only Super Admin decides recruiter incentives and salary raises.');
  const d = await prisma.recruiterJoiningDecision.findUnique({ where: { id: req.params.id } });
  if (!d) return err(res, 404, 'That decision is already gone.');
  const lock = await lockedEntry(d);
  if (lock) return err(res, 409, `The incentive is already in ${RJ.monthLabel(d.payMonth)} payroll, so it can no longer be undone.`);
  await prisma.recruiterJoiningDecision.delete({ where: { id: d.id } });
  await logAudit({
    userId: req.user.id, actorName: req.user.name, action: 'Recruiter joinings decision undone',
    entity: 'RecruiterJoiningDecision', entityId: d.id, fromValue: summaryOf(d), toValue: null,
    reason: d.decision === 'RAISE' ? 'The salary version itself stays — remove it in Payroll → Salary Structure if needed.' : null,
  });
  RJ.invalidate();
  res.json({
    ok: true,
    message: d.decision === 'RAISE'
      ? 'Undone. The new salary itself is still saved — change it in Payroll → Salary Structure if needed.'
      : 'Undone.',
  });
}));

// ---- Targets ----------------------------------------------------------------------
router.get('/targets', guarded(async (req, res) => {
  const viewer = viewerOf(req.user);
  if (!['sa', 'all'].includes(viewer.level)) return err(res, 403, 'Only Super Admin, Admin and HR can see the target settings.');
  const rules = await RJ.loadTargetRules();
  const ids = rules.filter((r) => r.scope === 'EMPLOYEE').map((r) => r.scopeKey);
  const emps = ids.length ? await prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, employeeCode: true } }) : [];
  const nameOf = new Map(emps.map((e) => [e.id, `${e.name}${e.employeeCode ? ` · ${e.employeeCode}` : ''}`]));
  res.json({
    defaultTarget: RJ.DEFAULT_TARGET,
    canEdit: viewer.level === 'sa' && viewer.decide,
    rules: rules.sort((a, b) => b.fromMonth.localeCompare(a.fromMonth)).map((r) => ({
      id: r.id, scope: r.scope, scopeKey: r.scopeKey, fromMonth: r.fromMonth, fromLabel: RJ.monthLabel(r.fromMonth), target: r.target, note: r.note,
      who: r.scope === 'ALL' ? 'Everyone' : r.scope === 'DEPARTMENT' ? r.scopeKey : (nameOf.get(r.scopeKey) || 'One person'),
      setByName: r.setByName, updatedAt: r.updatedAt,
    })),
  });
}));
router.post('/targets', guarded(async (req, res) => {
  if (!isSuperAdmin(req.user)) return err(res, 403, 'Only Super Admin can change the joinings target.');
  const body = req.body || {};
  const scope = s(body.scope).toUpperCase();
  const fromMonth = s(body.fromMonth);
  const target = Math.round(Number(body.target));
  let scopeKey = s(body.scopeKey);
  if (!['ALL', 'DEPARTMENT', 'EMPLOYEE'].includes(scope)) return err(res, 400, 'Choose who the target is for: everyone, a department or one person.');
  if (scope === 'ALL') scopeKey = '';
  if (scope !== 'ALL' && !scopeKey) return err(res, 400, scope === 'DEPARTMENT' ? 'Pick the department.' : 'Pick the person.');
  if (scope === 'EMPLOYEE' && !(await prisma.employee.findUnique({ where: { id: scopeKey }, select: { id: true } }))) return err(res, 400, 'That person was not found.');
  if (!RJ.isMonth(fromMonth)) return err(res, 400, 'Pick the month the target starts from.');
  if (!(target >= 0 && target <= 100)) return err(res, 400, 'The target must be a number from 0 to 100.');
  const where = { scope_scopeKey_fromMonth: { scope, scopeKey, fromMonth } };
  const before = await prisma.recruiterJoiningTarget.findUnique({ where });
  const note = s(body.note).slice(0, 300) || null;
  const row = await prisma.recruiterJoiningTarget.upsert({
    where,
    create: { scope, scopeKey, fromMonth, target, note, setById: req.user.id, setByName: req.user.name },
    update: { target, note, setById: req.user.id, setByName: req.user.name },
  });
  await logAudit({
    userId: req.user.id, actorName: req.user.name, action: 'Recruiter joinings target set', entity: 'RecruiterJoiningTarget', entityId: row.id,
    fromValue: before ? String(before.target) : null, toValue: `${scope === 'ALL' ? 'Everyone' : scopeKey} · from ${fromMonth} · ${target} a month`, reason: note,
  });
  RJ.invalidate();
  res.json({ ok: true, message: `Saved — ${target} joinings a month from ${RJ.monthLabel(fromMonth)}.`, rule: row });
}));
router.delete('/targets/:id', guarded(async (req, res) => {
  if (!isSuperAdmin(req.user)) return err(res, 403, 'Only Super Admin can change the joinings target.');
  const r = await prisma.recruiterJoiningTarget.findUnique({ where: { id: req.params.id } });
  if (!r) return err(res, 404, 'That target is already gone.');
  await prisma.recruiterJoiningTarget.delete({ where: { id: r.id } });
  await logAudit({
    userId: req.user.id, actorName: req.user.name, action: 'Recruiter joinings target removed', entity: 'RecruiterJoiningTarget', entityId: r.id,
    fromValue: `${r.scope === 'ALL' ? 'Everyone' : r.scopeKey} · from ${r.fromMonth} · ${r.target} a month`,
  });
  RJ.invalidate();
  res.json({ ok: true, message: 'Removed.' });
}));

// ---- Excel export (separate button) ----------------------------------------------
router.get('/export', guarded(async (req, res) => {
  const month = monthOf(req.query, RJ.thisMonth());
  const viewer = viewerOf(req.user);
  const b = shapeBoard(req.user, viewer, await RJ.monthBoard(month));
  const f = { department: s(req.query.department), tl: s(req.query.tl), recruiter: s(req.query.recruiter) };
  const rows = b.rows.filter((r) => (!f.department || r.department === f.department)
    && (!f.tl || r.tlName === f.tl) && (!f.recruiter || r.key === f.recruiter));
  const head = ['Recruiter', 'Employee ID', 'Seat', 'Department', 'Team lead', 'Target', 'Joinings', 'Status', 'Not counted'];
  if (viewer.decisions) head.push('Decision');
  if (viewer.money) head.push('Incentive (₹)', 'Paid with', 'Raise from', 'Note');
  const main = rows.map((r) => {
    const out = [r.name, r.employeeCode, r.seat, r.department, r.tlName, r.target, r.joinings, r.toneWord, r.notCountedCount];
    if (viewer.decisions) out.push(r.decision ? r.decision.word : (r.needsDecision ? 'Waiting for decision' : '—'));
    if (viewer.money) {
      const d = r.decision || {};
      out.push(d.decision === 'INCENTIVE' ? d.amount : null, d.payLabel || null, d.raiseFrom ? RJ.monthLabel(d.raiseFrom) : null, d.note || null);
    }
    return out;
  });
  const list = (key) => rows.flatMap((r) => r[key].map((a) => [r.name, r.seat, a.candidate, a.client, a.job, a.joiningDate, a.status, a.note || '']));
  const sheets = [
    { name: `${b.label}`, headers: head, rows: main },
    { name: 'Joinings counted', headers: ['Recruiter', 'Seat', 'Candidate', 'Client', 'Job', 'Joining date', 'Status', 'Check'], rows: list('joiningList') },
    { name: 'Not counted', headers: ['Recruiter', 'Seat', 'Candidate', 'Client', 'Job', 'Joining date', 'Why not counted', 'Note'], rows: list('notCountedList') },
  ];
  if (b.skipped.length) sheets.push({ name: 'Skipped', headers: ['Candidate', 'Client', 'Job', 'Joining date', 'Why skipped'], rows: b.skipped.map((a) => [a.candidate, a.client, a.job, a.joiningDate, a.reason]) });
  await logAudit({
    userId: req.user.id, actorName: req.user.name, action: 'Recruiter joinings exported (XLSX)', entity: 'RecruiterJoiningDecision',
    toValue: `${b.label} · ${rows.length} recruiter(s)`,
  });
  res.setHeader('Content-Disposition', `attachment; filename="recruiter-joinings-${month}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(toXlsxBook(sheets));
}));

module.exports = router;
module.exports.viewerOf = viewerOf;
module.exports.isSuperAdmin = isSuperAdmin;
