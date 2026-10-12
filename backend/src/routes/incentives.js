// ---------------------------------------------------------------------------
// /api/incentives - Payroll -> Incentives (HRMS spec 2026-10-09, point 4).
// The logic is utils/incentives.js; this file is who may do what:
//
//   Super Admin   everything: write the rules, work out the month, add an award,
//                 APPROVE / reject / undo, see every amount.
//   HR / Admin / Manager / payroll roles (Payroll & Compensation: create or export)
//                 read the rules, the month and every award and history.
//   anybody       their OWN incentive history (the awards are their pay).
// Every change is written to the audit log.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../middleware/auth');
const { can } = require('../utils/permissions');
const { scopeOf, employeeWhere } = require('../utils/scope');
const { withoutSystemAccounts } = require('../utils/systemAccounts');
const { logAudit } = require('../utils/audit');
const INC = require('../utils/incentives');
const RJ = require('../utils/recruiterJoinings');

const router = express.Router();
router.use(requireAuth);

const s = (v) => (typeof v === 'string' ? v.trim() : '');
const isSuperAdmin = (u) => { const sc = scopeOf(u); return sc.role === 'SUPER_ADMIN' || sc.hrmsRole === 'SUPER_ADMIN'; };
const err = (res, status, error) => res.status(status).json({ error });
const guarded = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    if (e && e.status) return err(res, e.status, e.message);
    // eslint-disable-next-line no-console
    console.error('[incentives]', e);
    return err(res, 500, 'Something went wrong with incentives. Please try again.');
  }
  return undefined;
};
async function viewerOf(user) {
  const sa = isSuperAdmin(user);
  // `view` alone is every employee's right to their own payslip; staff who may run or
  // oversee payroll hold `create` (HR) or `export` (Manager / Assistant Manager).
  const all = sa || await can(user, 'hrms', 'hrms', 'Payroll & Compensation', 'create') || await can(user, 'hrms', 'hrms', 'Payroll & Compensation', 'export');
  return { sa, all };
}
const need = (cond, res, msg) => { if (!cond) { err(res, 403, msg); return false; } return true; };

// ---- what the screen needs ----------------------------------------------------
router.get('/options', guarded(async (req, res) => {
  const v = await viewerOf(req.user);
  const [depts, desigs] = await Promise.all([
    prisma.employee.findMany({ where: withoutSystemAccounts({ employmentStatus: { in: RJ.PAYABLE } }), select: { department: true, designation: true } }),
    Promise.resolve(null),
  ]);
  void desigs;
  const count = (k) => { const m = new Map(); depts.forEach((e) => { if (e[k]) m.set(e[k], (m.get(e[k]) || 0) + 1); }); return [...m.entries()].map(([value, n]) => ({ value, label: value, count: n })).sort((a, b) => a.label.localeCompare(b.label)); };
  res.json({
    viewer: { superAdmin: v.sa, all: v.all },
    metrics: INC.METRICS, bases: INC.BASES, statuses: INC.STATUSES,
    departments: count('department'), roles: count('designation'),
    thisMonth: RJ.thisMonth(), lastMonth: RJ.prevMonth(),
  });
}));

// ---- rules ----------------------------------------------------------------------
const ruleView = (r) => ({
  id: r.id, name: r.name, department: r.department, role: r.role, metric: r.metric, minAchieved: r.minAchieved, target: r.target, basis: r.basis, amount: r.amount,
  maxAmount: r.maxAmount, carryForward: !!r.carryForward, fromMonth: r.fromMonth, toMonth: r.toMonth, active: r.active, note: r.note, createdByName: r.createdByName, updatedAt: r.updatedAt,
});
router.get('/rules', guarded(async (req, res) => {
  const v = await viewerOf(req.user);
  if (!need(v.all, res, 'Incentive rules are visible to Super Admin, HR and payroll roles.')) return;
  const rules = await INC.loadRules();
  res.json({ canEdit: v.sa, rules: rules.map(ruleView) });
}));

function readRule(body) {
  const b = body || {};
  const out = {};
  const name = s(b.name);
  if (!name) return { error: 'Give the rule a name, like "Education recruiter - 4 joinings".' };
  out.name = name.slice(0, 120);
  out.department = s(b.department) || null;
  out.role = s(b.role) || null;
  out.metric = INC.METRICS.some((m) => m.key === b.metric) ? b.metric : null;
  if (!out.metric) return { error: 'Choose what is measured: joinings, a monthly target, or a number HR types.' };
  out.basis = INC.BASES.some((m) => m.key === b.basis) ? b.basis : null;
  if (!out.basis) return { error: 'Choose how the amount is worked out.' };
  const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
  out.minAchieved = num(b.minAchieved) ?? 0;
  out.target = num(b.target);
  out.amount = num(b.amount);
  out.maxAmount = num(b.maxAmount);
  if (!(out.minAchieved >= 0 && out.minAchieved <= 100000)) return { error: 'The minimum achieved must be a number, 0 or more.' };
  if (out.target !== null && !(out.target >= 0)) return { error: 'The target must be a number, 0 or more.' };
  // A "when the target is completed" rule may leave the amount EMPTY: Super Admin gives it each time.
  if (out.basis === 'COMPLETION' && (out.amount === null || out.amount === 0 || Number.isNaN(out.amount))) out.amount = 0;
  else if (!(out.amount > 0 && out.amount <= INC.MAX_AMOUNT)) return { error: 'Enter the amount in rupees (more than 0).' };
  out.carryForward = out.metric === 'JOININGS' && !!b.carryForward;
  if (out.carryForward && out.basis !== 'COMPLETION') return { error: 'Carrying the missing joinings forward goes with "when the target is completed".' };
  if (out.carryForward && !(out.target > 0)) return { error: 'Give the base target (for example 4 joinings a month).' };
  if (out.maxAmount !== null && !(out.maxAmount > 0)) return { error: 'The cap must be more than 0, or blank for no cap.' };
  out.fromMonth = s(b.fromMonth);
  if (out.carryForward && !out.fromMonth) return { error: 'Say which month counting starts from, so the carried target is worked out from there.' };
  out.toMonth = s(b.toMonth) || null;
  if (out.fromMonth && !RJ.isMonth(out.fromMonth)) return { error: 'Pick a proper start month.' };
  if (out.toMonth && !RJ.isMonth(out.toMonth)) return { error: 'Pick a proper end month.' };
  if (out.fromMonth && out.toMonth && out.toMonth < out.fromMonth) return { error: 'The end month is before the start month.' };
  out.active = b.active === undefined ? true : !!b.active;
  out.note = s(b.note).slice(0, 300) || null;
  return { data: out };
}
router.post('/rules', guarded(async (req, res) => {
  if (!need(isSuperAdmin(req.user), res, 'Only Super Admin writes incentive rules.')) return;
  const r = readRule(req.body);
  if (r.error) return err(res, 400, r.error);
  const row = await INC.withOptionalFields((d) => prisma.incentiveRule.create({ data: d }), { ...r.data, createdById: req.user.id, createdByName: req.user.name }, ['carryForward']);
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Incentive rule added', entity: 'IncentiveRule', entityId: row.id, toValue: `${row.name} · ${row.department || 'all departments'} · ${row.basis} ₹${row.amount}` });
  res.status(201).json({ ok: true, message: 'Saved - the rule is on.', rule: ruleView(row) });
}));
router.put('/rules/:id', guarded(async (req, res) => {
  if (!need(isSuperAdmin(req.user), res, 'Only Super Admin writes incentive rules.')) return;
  const before = await prisma.incentiveRule.findUnique({ where: { id: req.params.id } });
  if (!before) return err(res, 404, 'That rule is already gone.');
  const r = readRule({ ...ruleView(before), ...req.body });
  if (r.error) return err(res, 400, r.error);
  const row = await INC.withOptionalFields((d) => prisma.incentiveRule.update({ where: { id: before.id }, data: d }), r.data, ['carryForward']);
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Incentive rule changed', entity: 'IncentiveRule', entityId: row.id, fromValue: `${before.basis} ₹${before.amount} min ${before.minAchieved} ${before.active ? 'on' : 'off'}`, toValue: `${row.basis} ₹${row.amount} min ${row.minAchieved} ${row.active ? 'on' : 'off'}` });
  res.json({ ok: true, message: 'Saved.', rule: ruleView(row) });
}));
router.delete('/rules/:id', guarded(async (req, res) => {
  if (!need(isSuperAdmin(req.user), res, 'Only Super Admin writes incentive rules.')) return;
  const before = await prisma.incentiveRule.findUnique({ where: { id: req.params.id } });
  if (!before) return err(res, 404, 'That rule is already gone.');
  const used = await prisma.incentiveAward.count({ where: { ruleId: before.id } });
  if (used) {
    await prisma.incentiveRule.update({ where: { id: before.id }, data: { active: false } });
    await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Incentive rule switched off', entity: 'IncentiveRule', entityId: before.id, toValue: `${before.name} (kept: ${used} award(s) were made under it)` });
    return res.json({ ok: true, message: `Switched off, not deleted: ${used} award(s) were made under it and stay in the history.` });
  }
  await prisma.incentiveRule.delete({ where: { id: before.id } });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Incentive rule removed', entity: 'IncentiveRule', entityId: before.id, fromValue: before.name });
  return res.json({ ok: true, message: 'Removed.' });
}));

// ---- the month: who qualifies --------------------------------------------------------
const monthOf = (q, d) => (RJ.isMonth(s(q.month)) ? s(q.month) : d);
router.get('/preview', guarded(async (req, res) => {
  const v = await viewerOf(req.user);
  if (!need(v.all, res, 'The incentive month is visible to Super Admin, HR and payroll roles.')) return;
  const month = monthOf(req.query, RJ.prevMonth());
  res.json({ ...(await INC.preview(month)), ended: month < RJ.thisMonth(), canGenerate: v.sa });
}));
router.post('/generate', guarded(async (req, res) => {
  if (!need(isSuperAdmin(req.user), res, 'Only Super Admin works out incentives.')) return;
  const month = monthOf(req.body || {}, '');
  if (!month) return err(res, 400, 'Pick the month.');
  if (month >= RJ.thisMonth()) return err(res, 400, `${RJ.monthLabel(month)} has not ended yet - work it out after the month is over.`);
  const r = await INC.generate(month, req.user);
  res.json({ ok: true, ...r, message: r.created ? `Worked out - ${r.created} incentive(s) are waiting for your approval.` : (r.existing ? 'Nothing new - everyone who qualifies already has one.' : 'Nobody qualifies under the rules for this month.') });
}));
router.post('/awards', guarded(async (req, res) => {
  if (!need(isSuperAdmin(req.user), res, 'Only Super Admin adds an incentive by hand.')) return;
  const b = req.body || {};
  const row = await INC.manual({ employeeId: s(b.employeeId), month: s(b.month), ruleId: s(b.ruleId), achieved: b.achieved, amount: b.amount, note: s(b.note) }, req.user, { mayTypeAmount: true });
  res.status(201).json({ ok: true, message: 'Added - it waits for approval.', award: row });
}));

// ---- awards ---------------------------------------------------------------------------
const awardView = (a, emp, v) => ({
  id: a.id, employeeId: a.employeeId, employeeCode: emp ? emp.employeeCode : null, name: emp ? emp.name : '', department: a.department || (emp && emp.department) || null,
  month: a.month, label: RJ.monthLabel(a.month), ruleId: a.ruleId, rule: a.ruleName, metric: a.metric, achieved: a.achieved, target: a.target, baseTarget: a.baseTarget, carriedIn: a.carriedIn, amount: a.amount, status: a.status,
  payMonth: a.payMonth, payLabel: a.payMonth ? RJ.monthLabel(a.payMonth) : null, source: a.source, note: v.sa ? a.note : null, decidedByName: a.decidedByName, decidedAt: a.decidedAt,
});
router.get('/awards', guarded(async (req, res) => {
  const v = await viewerOf(req.user);
  if (!need(v.all, res, 'The awards list is visible to Super Admin, HR and payroll roles.')) return;
  const where = {};
  if (RJ.isMonth(s(req.query.month))) where.month = s(req.query.month);
  if (INC.STATUSES.includes(s(req.query.status))) where.status = s(req.query.status);
  if (s(req.query.department)) where.department = s(req.query.department);
  if (s(req.query.employeeId)) where.employeeId = s(req.query.employeeId);
  const rows = await prisma.incentiveAward.findMany({ where, orderBy: [{ month: 'desc' }, { createdAt: 'desc' }], take: 1000 });
  const emps = await prisma.employee.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.employeeId))] } }, select: { id: true, employeeCode: true, name: true, department: true } });
  const by = new Map(emps.map((e) => [e.id, e]));
  res.json({ canDecide: v.sa, rows: rows.map((r) => awardView(r, by.get(r.employeeId), v)) });
}));
router.post('/awards/:id/decision', guarded(async (req, res) => {
  if (!need(isSuperAdmin(req.user), res, 'Only Super Admin approves incentives.')) return;
  const b = req.body || {};
  const row = await INC.decide(req.params.id, s(b.decision).toLowerCase(), { payMonth: s(b.payMonth), note: s(b.note), amount: b.amount }, req.user);
  const word = row.status === 'Approved' ? `Approved - paid with the ${RJ.monthLabel(row.payMonth)} salary.` : row.status === 'Rejected' ? 'Rejected.' : 'Back to waiting.';
  res.json({ ok: true, message: word, award: row });
}));

// ---- one person's history -----------------------------------------------------------------
router.get('/history/:employeeId', guarded(async (req, res) => {
  const v = await viewerOf(req.user);
  const own = req.user.employeeId && req.user.employeeId === req.params.employeeId;
  if (!own && !v.all) return err(res, 403, 'You can see your own incentive history.');
  if (!own && !v.sa) {
    const e = await prisma.employee.findFirst({ where: { AND: [employeeWhere(req.user), { id: req.params.employeeId }] }, select: { id: true } });
    if (!e) return err(res, 403, 'That person is outside your area.');
  }
  const emp = await prisma.employee.findUnique({ where: { id: req.params.employeeId }, select: { id: true, name: true, employeeCode: true, department: true, designation: true } });
  if (!emp) return err(res, 404, 'Employee not found.');
  const rows = await INC.historyFor(emp.id);
  const total = rows.filter((r) => ['Approved', 'Paid'].includes(r.status)).reduce((n, r) => n + (Number(r.amount) || 0), 0);
  res.json({ employee: emp, rows: rows.map((r) => ({ ...r, note: v.sa ? r.note : null })), totalApproved: total });
}));
router.get('/mine', guarded(async (req, res) => {
  if (!req.user.employeeId) return res.json({ rows: [], totalApproved: 0, employee: null });
  const emp = await prisma.employee.findUnique({ where: { id: req.user.employeeId }, select: { id: true, name: true, employeeCode: true, department: true, designation: true } });
  const rows = await INC.historyFor(req.user.employeeId);
  res.json({ employee: emp, rows: rows.map((r) => ({ ...r, note: null })), totalApproved: rows.filter((r) => ['Approved', 'Paid'].includes(r.status)).reduce((n, r) => n + (Number(r.amount) || 0), 0) });
}));
// People to pick from (department filtered), for adding an award / opening a history.
router.get('/people', guarded(async (req, res) => {
  const v = await viewerOf(req.user);
  if (!need(v.all, res, 'Visible to Super Admin, HR and payroll roles.')) return;
  const where = { AND: [employeeWhere(req.user), withoutSystemAccounts({}), ...(s(req.query.department) ? [{ department: s(req.query.department) }] : [])] };
  const rows = await prisma.employee.findMany({ where, select: { id: true, employeeCode: true, name: true, department: true, designation: true, employmentStatus: true }, orderBy: { name: 'asc' } });
  res.json({ people: rows });
}));

module.exports = router;
