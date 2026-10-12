// ---------------------------------------------------------------------------
// INCENTIVE MANAGEMENT (HRMS spec 2026-10-09, point 4) - department-wise rules,
// awards, approval, and the hand-over to Payroll.
//
//   RULES    Super Admin writes them (Payroll -> Incentives). The table starts
//            EMPTY: no amount is ever invented. A rule says: for this
//            department (and role), measured by this metric, when the person
//            achieves at least X in the month, pay this much (a fixed amount,
//            an amount per unit, or an amount per unit above the target),
//            optionally capped, for months from .. to.
//   METRICS  JOININGS - the recruiter's counted joinings (ATS summary, the same
//                       count as Performance -> Recruiter joinings);
//            TARGET   - achieved vs the person's Monthly Targets;
//            MANUAL   - HR types the number (BDE revenue, IT delivery ...).
//   AWARDS   one per person per month per rule: Pending -> Approved (or
//            Rejected). ONLY Super Admin approves (as with the B1 recruiter
//            incentive). Approving fixes the PAY MONTH.
//   PAYROLL  an Approved award is an "Incentive" earning of its pay month's
//            payroll record (payrollEngine.incentivesFor adds it to the B1
//            recruiter-joinings incentive), so it is in the payslip, in the
//            gross, and - when that month is posted to Accounts - in the one
//            payroll journal (Salary Expense = earned gross).
//   HISTORY  every award (and the B1 recruiter decisions) per employee.
// When several rules fit one person for one metric, the MOST SPECIFIC wins
// (department + role, then department, then role, then everyone).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const RJ = require('./recruiterJoinings');
const SV = require('./salaryVersions');
const { withoutSystemAccounts } = require('./systemAccounts');
const { logAudit } = require('./audit');

const METRICS = [
  { key: 'JOININGS', label: 'Joinings (counted in ATS)', unit: 'joinings' },
  { key: 'TARGET', label: 'Monthly Target achieved', unit: 'units' },
  { key: 'MANUAL', label: 'A number HR types in', unit: 'units' },
];
const BASES = [
  { key: 'COMPLETION', label: 'When the target is completed (the amount is decided each time)' },
  { key: 'FIXED', label: 'One fixed amount' },
  { key: 'PER_UNIT', label: 'An amount for every one achieved' },
  { key: 'PER_UNIT_OVER_TARGET', label: 'An amount for every one above the target' },
];
const WAITING_AMOUNT = 'Waiting for amount';
const STATUSES = [WAITING_AMOUNT, 'Pending', 'Approved', 'Rejected', 'Paid'];
const MAX_AMOUNT = 1000000;
const isMonth = RJ.isMonth;
const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
const round = (n) => Math.round(Number(n) || 0);

async function loadRules({ activeOnly = false } = {}) {
  try {
    return await prisma.incentiveRule.findMany({ where: activeOnly ? { active: true } : {}, orderBy: [{ department: 'asc' }, { createdAt: 'asc' }] });
  } catch { return []; }
}

const inWindow = (rule, month) => (!rule.fromMonth || rule.fromMonth <= month) && (!rule.toMonth || month <= rule.toMonth);
const specificity = (r) => (r.department ? 2 : 0) + (r.role ? 1 : 0);

// The rule that applies to this person for this metric in this month, or null.
function ruleFor(rules, emp, metric, month) {
  const fit = rules.filter((r) => r.active && r.metric === metric && inWindow(r, month)
    && (!r.department || same(r.department, emp.department)) && (!r.role || same(r.role, emp.designation)));
  fit.sort((a, b) => specificity(b) - specificity(a) || String(b.fromMonth || '').localeCompare(String(a.fromMonth || '')) || b.createdAt - a.createdAt);
  return fit[0] || null;
}

// { eligible, amount, why } for one rule and one achievement.
function amountOf(rule, achieved, target) {
  const a = Number(achieved) || 0;
  const min = Number(rule.minAchieved) || 0;
  if (rule.basis === 'COMPLETION') {
    // Earned when the target is completed. The amount is whatever the rule says
    // (0 = not decided yet: Super Admin gives it when approving) - never invented.
    const t = rule.target != null ? Number(rule.target) : (target != null ? Number(target) : min);
    if (!(t > 0)) return { eligible: false, amount: 0, why: 'No target to complete' };
    if (a < t) return { eligible: false, amount: 0, why: `Achieved ${a} of ${t}` };
    let amt = round(rule.amount);
    if (amt > 0 && rule.maxAmount != null && Number(rule.maxAmount) > 0) amt = Math.min(amt, Number(rule.maxAmount));
    return { eligible: true, amount: amt, why: '' };
  }
  if (!(a > 0) && !(rule.metric === 'MANUAL')) return { eligible: false, amount: 0, why: 'Nothing achieved this month' };
  if (a < min) return { eligible: false, amount: 0, why: `Achieved ${a}, needs at least ${min}` };
  let amount = 0;
  if (rule.basis === 'FIXED') amount = Number(rule.amount) || 0;
  else if (rule.basis === 'PER_UNIT') amount = (Number(rule.amount) || 0) * a;
  else {
    const base = rule.target != null ? Number(rule.target) : (target != null ? Number(target) : min);
    const over = Math.max(0, a - base);
    if (!(over > 0)) return { eligible: false, amount: 0, why: `Achieved ${a}, not above the target of ${base}` };
    amount = (Number(rule.amount) || 0) * over;
  }
  if (rule.maxAmount != null && Number(rule.maxAmount) > 0) amount = Math.min(amount, Number(rule.maxAmount));
  amount = round(amount);
  return amount > 0 ? { eligible: true, amount, why: '' } : { eligible: false, amount: 0, why: 'The rule works out to nothing' };
}

// What each person achieved in a month, per metric: Map(employeeId -> { JOININGS, TARGET }).
async function achievements(month) {
  const out = new Map();
  const set = (id, key, v) => { if (!out.has(id)) out.set(id, {}); out.get(id)[key] = v; };
  const board = await RJ.monthBoard(month).catch(() => ({ rows: [] }));
  board.rows.forEach((r) => { if (r.employeeId) set(r.employeeId, 'JOININGS', { achieved: r.joinings, target: r.target, department: r.department }); });
  const tg = await prisma.employeeRecord.findMany({ where: { type: 'TARGET', date: month }, select: { employeeId: true, amount: true, achieved: true } }).catch(() => []);
  const by = new Map();
  tg.forEach((t) => {
    const c = by.get(t.employeeId) || { achieved: 0, target: 0 };
    c.achieved += Number(t.achieved) || 0; c.target += Number(t.amount) || 0;
    by.set(t.employeeId, c);
  });
  by.forEach((v, id) => set(id, 'TARGET', v));
  return out;
}

const key = (employeeId, month, ruleId) => `${employeeId}|${month}|${ruleId}`;

// ---------------------------------------------------------------------------
// THE JOININGS TARGET THAT CARRIES FORWARD (user, 2026-10-09).
//   A department rule (metric JOININGS, "carry forward" on) has a BASE target
//   (4 a month). Each month's target = base + what was still missing from the
//   month before:
//       target(m)  = base + carried(m)
//       missing(m) = max(0, target(m) - achieved(m))        (0 when completed)
//       carried(m+1) = missing(m)
//   Jan: target 4, joined 2 -> missing 2 -> Feb target 6; Feb joined 2 -> missing
//   4 -> Mar target 8. The incentive is earned in a month when that month's
//   target is COMPLETED (achieved >= target); then nothing is carried. Joining
//   MORE than the target does not make the next target smaller than the base
//   (no negative carry). Counting starts at the rule's "from month" (carried = 0
//   there); a month in which the person is not on the recruiter list adds
//   nothing. Only ATS summary counts are used (RJ.monthBoard) - no names.
// ---------------------------------------------------------------------------
const addMonths = RJ.addMonthsOf || ((m, n) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo - 1 + n, 1)).toISOString().slice(0, 7); });
const MAX_CHAIN = 24;
// ONE month of the carry rule, as a pure function (unit-tested):
//   target = base + carried;  completed = achieved >= target;
//   missing = what is still short (0 when completed or ahead) -> carried into next month.
// Joining MORE than the target never makes the next target smaller than the base.
function carryStep(base, carried, achieved) {
  const b = Number(base) || 0; const c = Math.max(0, Number(carried) || 0); const a = Math.max(0, Number(achieved) || 0);
  const target = b + c;
  const completed = target > 0 && a >= target;
  const missing = completed ? 0 : Math.max(0, target - a);
  return { target, completed, missing, next: b + missing };
}
// The columns added by the carry-forward migration may not be in the generated Prisma
// client yet: create / update with them, and without them when the client says unknown.
async function withOptionalFields(run, data, optionalKeys) {
  try { return await run(data); } catch (e) {
    if (e && /Unknown (argument|arg)|Unknown field/i.test(String(e.message || ''))) {
      const slim = { ...data }; optionalKeys.forEach((k) => delete slim[k]);
      return run(slim);
    }
    throw e;
  }
}
function carrySentence(rule, base) {
  return `Target ${base} a month. If you join fewer, the missing ones are added to next month's target.`;
}
// Map(employeeId -> { ruleId, ruleName, base, carried, target, achieved, completed, missing, next, department, history: [...] })
async function joiningsPlan(month, { rules: given = null } = {}) {
  const rules = (given || await loadRules({ activeOnly: true })).filter((r) => r.metric === 'JOININGS' && r.carryForward);
  const out = new Map();
  if (!rules.length || !isMonth(month)) return out;
  const designation = new Map((await prisma.employee.findMany({ select: { id: true, designation: true } })).map((e) => [e.id, e.designation]));
  const start = rules.map((r) => r.fromMonth).filter(Boolean).sort()[0] || month;
  const first = start > addMonths(month, -(MAX_CHAIN - 1)) ? start : addMonths(month, -(MAX_CHAIN - 1));
  const state = new Map(); // employeeId -> { carried, history }
  for (let m = first; m <= month; m = addMonths(m, 1)) {
    // eslint-disable-next-line no-await-in-loop
    const board = await RJ.monthBoard(m).catch(() => ({ rows: [] }));
    board.rows.forEach((row) => {
      if (!row.employeeId) return;
      const rule = ruleFor(rules, { department: row.department, designation: designation.get(row.employeeId) }, 'JOININGS', m);
      if (!rule) return;
      const st = state.get(row.employeeId) || { carried: 0, history: [] };
      const base = rule.target != null ? Number(rule.target) : RJ.DEFAULT_TARGET;
      const carried = st.carried;
      const achieved = Number(row.joinings) || 0;
      const { target, completed, missing } = carryStep(base, carried, achieved);
      const entry = { month: m, label: RJ.monthLabel(m), base, carried, target, achieved, completed, missing, ruleId: rule.id };
      st.history.push(entry);
      state.set(row.employeeId, { carried: missing, history: st.history });
      if (m === month) {
        out.set(row.employeeId, {
          ruleId: rule.id, ruleName: rule.name, base, carried, target, achieved, completed, missing, next: base + missing, department: row.department,
          amount: round(rule.amount), sentence: carrySentence(rule, base), history: st.history,
        });
      }
    });
  }
  return out;
}

// The month's proposals, worked out from the rules (nothing is written).
async function preview(month) {
  const allRules = await loadRules({ activeOnly: true });
  const plan = await joiningsPlan(month, { rules: allRules });
  const [rules, ach, emps, awards] = await Promise.all([
    Promise.resolve(allRules), achievements(month),
    prisma.employee.findMany({ where: withoutSystemAccounts({ employmentStatus: { in: RJ.PAYABLE } }), select: { id: true, employeeCode: true, name: true, department: true, designation: true } }),
    prisma.incentiveAward.findMany({ where: { month } }).catch(() => []),
  ]);
  const awardOf = new Map(awards.map((a) => [a.dedupeKey, a]));
  const rows = [];
  emps.forEach((e) => {
    const a = ach.get(e.id) || {};
    ['JOININGS', 'TARGET'].forEach((metric) => {
      const got = a[metric];
      // A joinings rule that CARRIES the target forward: worked out from the plan.
      const cp = metric === 'JOININGS' ? plan.get(e.id) : null;
      if (cp) {
        const rule = rules.find((r) => r.id === cp.ruleId);
        const ar = awardOf.get(key(e.id, month, cp.ruleId)) || null;
        rows.push({
          employeeId: e.id, employeeCode: e.employeeCode, name: e.name, department: cp.department || e.department, designation: e.designation,
          ruleId: cp.ruleId, ruleName: cp.ruleName, metric, achieved: cp.achieved, target: cp.target, baseTarget: cp.base, carriedIn: cp.carried,
          eligible: cp.completed, amount: cp.completed ? round(rule && rule.amount) : 0,
          why: cp.completed ? '' : `Joined ${cp.achieved} of ${cp.target}${cp.carried ? ` (${cp.base} + ${cp.carried} carried)` : ''}`,
          award: ar ? { id: ar.id, status: ar.status, amount: ar.amount } : null,
        });
        return;
      }
      if (!got || !(got.achieved > 0)) return;
      // JOININGS follows the SEAT's department that month (the board's).
      const emp = { ...e, department: (metric === 'JOININGS' && got.department) || e.department };
      const rule = ruleFor(rules, emp, metric, month);
      if (!rule) return;
      const r = amountOf(rule, got.achieved, got.target);
      const award = awardOf.get(key(e.id, month, rule.id)) || null;
      rows.push({
        employeeId: e.id, employeeCode: e.employeeCode, name: e.name, department: emp.department, designation: e.designation,
        ruleId: rule.id, ruleName: rule.name, metric, achieved: got.achieved, target: rule.target != null ? rule.target : got.target,
        eligible: r.eligible, amount: r.amount, why: r.why,
        award: award ? { id: award.id, status: award.status, amount: award.amount } : null,
      });
    });
  });
  rows.sort((a, b) => String(a.department || '').localeCompare(String(b.department || '')) || a.name.localeCompare(b.name));
  return { month, label: RJ.monthLabel(month), rules: rules.length, rows };
}

async function generate(month, actor) {
  const p = await preview(month);
  let created = 0; let existing = 0;
  // A completion-based award (target completed) may have no amount yet: it waits for Super Admin.
  const ruleBy = new Map((await loadRules()).map((x) => [x.id, x]));
  for (const r of p.rows.filter((x) => x.eligible && (x.amount > 0 || (ruleBy.get(x.ruleId) || {}).basis === 'COMPLETION'))) {
    if (r.award) { existing += 1; continue; }
    try {
      // eslint-disable-next-line no-await-in-loop
      const row = await withOptionalFields((d) => prisma.incentiveAward.create({ data: d }), {
          dedupeKey: key(r.employeeId, month, r.ruleId), employeeId: r.employeeId, month, ruleId: r.ruleId, ruleName: r.ruleName,
          department: r.department, metric: r.metric, achieved: r.achieved, target: r.target, baseTarget: r.baseTarget ?? null, carriedIn: r.carriedIn ?? null,
          amount: r.amount, status: r.amount > 0 ? 'Pending' : WAITING_AMOUNT, source: 'RULE',
          createdById: actor.id, createdByName: actor.name,
      }, ['baseTarget', 'carriedIn']);
      created += 1;
      // eslint-disable-next-line no-await-in-loop
      await logAudit({ userId: actor.id, actorName: actor.name, action: 'Incentive proposed', entity: 'IncentiveAward', entityId: row.id, toValue: `${r.name} · ${RJ.monthLabel(month)} · ${r.ruleName} · ₹${r.amount}`, reason: `${r.achieved} achieved` });
    } catch (e) { if (!(e && e.code === 'P2002')) throw e; existing += 1; }
  }
  return { created, existing, notEligible: p.rows.filter((x) => !x.eligible).length, month };
}

// HR / Super Admin types one in: a rule + the achieved number (amount worked out),
// or an amount by itself (Super Admin).
async function manual({ employeeId, month, ruleId, achieved, amount, note }, actor, { mayTypeAmount = false } = {}) {
  const emp = await prisma.employee.findUnique({ where: { id: employeeId }, select: { id: true, name: true, department: true, designation: true, employmentStatus: true } });
  if (!emp) throw Object.assign(new Error('That employee was not found.'), { status: 404 });
  if (!RJ.PAYABLE.includes(emp.employmentStatus)) throw Object.assign(new Error(`${emp.name} is no longer on the payroll (${emp.employmentStatus}). Pay it in the final settlement instead.`), { status: 409 });
  if (!isMonth(month)) throw Object.assign(new Error('Pick the month the work was done in.'), { status: 400 });
  let rule = null; let amt = null;
  if (ruleId) {
    rule = await prisma.incentiveRule.findUnique({ where: { id: ruleId } });
    if (!rule) throw Object.assign(new Error('That rule was not found.'), { status: 404 });
    if ((rule.department && !same(rule.department, emp.department)) || (rule.role && !same(rule.role, emp.designation))) throw Object.assign(new Error(`That rule is for ${[rule.department, rule.role].filter(Boolean).join(' · ')}, not for ${emp.name}.`), { status: 400 });
    const a = Number(achieved);
    if (!(a >= 0)) throw Object.assign(new Error('Enter how much was achieved.'), { status: 400 });
    const r = amountOf(rule, a, null);
    if (!r.eligible) throw Object.assign(new Error(`${r.why}. Nothing to award under this rule.`), { status: 400 });
    amt = r.amount;
  } else {
    if (!mayTypeAmount) throw Object.assign(new Error('Pick the rule this award is under.'), { status: 400 });
    amt = round(amount);
  }
  if (!(amt > 0)) throw Object.assign(new Error('Enter the amount in rupees.'), { status: 400 });
  if (amt > MAX_AMOUNT) throw Object.assign(new Error(`That is more than ₹${MAX_AMOUNT.toLocaleString('en-IN')} - please check it.`), { status: 400 });
  const k = ruleId ? key(emp.id, month, ruleId) : `MANUAL|${emp.id}|${month}|${Date.now().toString(36)}`;
  let row;
  try {
    row = await prisma.incentiveAward.create({
      data: {
        dedupeKey: k, employeeId: emp.id, month, ruleId: rule ? rule.id : null, ruleName: rule ? rule.name : 'Typed in by Super Admin', department: emp.department,
        metric: rule ? rule.metric : 'MANUAL', achieved: Number(achieved) || 0, target: rule ? rule.target : null, amount: amt, status: 'Pending', source: 'MANUAL',
        note: note ? String(note).slice(0, 500) : null, createdById: actor.id, createdByName: actor.name,
      },
    });
  } catch (e) {
    if (e && e.code === 'P2002') throw Object.assign(new Error(`${emp.name} already has an award for ${RJ.monthLabel(month)} under this rule.`), { status: 409 });
    throw e;
  }
  await logAudit({ userId: actor.id, actorName: actor.name, action: 'Incentive added', entity: 'IncentiveAward', entityId: row.id, toValue: `${emp.name} · ${RJ.monthLabel(month)} · ${row.ruleName} · ₹${amt}`, reason: note || undefined });
  return row;
}

// The payroll month an approved award is paid in: the month after the work
// (or this month, if later), moved past a month already beyond Draft.
async function payMonthFor(employeeId, month) {
  let pm = RJ.nextMonth(month);
  if (RJ.thisMonth() > pm) pm = RJ.thisMonth();
  const locked = await SV.lastLockedMonth(employeeId);
  if (locked && locked.month >= pm) pm = RJ.nextMonth(locked.month);
  return pm;
}
async function lockedEntry(award) {
  if (!award || award.status !== 'Approved' || !award.payMonth) return null;
  const e = await prisma.employeePayrollRun.findUnique({ where: { employeeId_month: { employeeId: award.employeeId, month: award.payMonth } }, select: { id: true, status: true } });
  return e && e.status !== 'DRAFT' ? e : null;
}

// decision: 'approve' | 'reject' | 'undo' (back to Pending).
async function decide(id, decision, { payMonth, note, amount }, actor) {
  const a = await prisma.incentiveAward.findUnique({ where: { id } });
  if (!a) throw Object.assign(new Error('That award is already gone.'), { status: 404 });
  const emp = await prisma.employee.findUnique({ where: { id: a.employeeId }, select: { name: true, employmentStatus: true } });
  const lock = await lockedEntry(a);
  if (lock) throw Object.assign(new Error(`This incentive is already in ${RJ.monthLabel(a.payMonth)} payroll (${lock.status.replace(/_/g, ' ').toLowerCase()}), so it can no longer be changed.`), { status: 409 });
  let data;
  if (decision === 'approve') {
    if (a.status === 'Approved') throw Object.assign(new Error('Already approved.'), { status: 409 });
    // The amount: the award's own, or the one Super Admin types now (a completed
    // target whose amount was not decided yet).
    let amt = Number(a.amount) || 0;
    if (!(amt > 0)) {
      amt = round(amount);
      if (!(amt > 0)) throw Object.assign(new Error('Enter the incentive amount in rupees to approve it.'), { status: 400 });
      if (amt > MAX_AMOUNT) throw Object.assign(new Error(`That is more than ₹${MAX_AMOUNT.toLocaleString('en-IN')} - please check it.`), { status: 400 });
    } else if (amount !== undefined && amount !== '' && round(amount) > 0) {
      amt = round(amount);
      if (amt > MAX_AMOUNT) throw Object.assign(new Error(`That is more than ₹${MAX_AMOUNT.toLocaleString('en-IN')} - please check it.`), { status: 400 });
    }
    // The B1 recruiter-joinings incentive for the same person and month: never both.
    const rjd = await prisma.recruiterJoiningDecision.findFirst({ where: { employeeId: a.employeeId, month: a.month, decision: 'INCENTIVE' } }).catch(() => null);
    if (rjd) throw Object.assign(new Error(`${emp.name} already has a recruiter-joinings incentive of ₹${Math.round(rjd.amount || 0).toLocaleString('en-IN')} for ${RJ.monthLabel(a.month)}. Undo that one first, or reject this one - never both.`), { status: 409 });
    if (!RJ.PAYABLE.includes(emp.employmentStatus)) throw Object.assign(new Error(`${emp.name} is no longer on the payroll (${emp.employmentStatus}). Pay it in the final settlement instead and reject it here.`), { status: 409 });
    let pm = payMonth && isMonth(payMonth) ? payMonth : await payMonthFor(a.employeeId, a.month);
    if (payMonth && isMonth(payMonth)) {
      const locked = await SV.lastLockedMonth(a.employeeId);
      if (locked && locked.month >= pm) throw Object.assign(new Error(`${RJ.monthLabel(pm)} payroll for ${emp.name} is already past Draft - pick a later month.`), { status: 409 });
      if (pm <= a.month) throw Object.assign(new Error('Pay it in a month after the work was done.'), { status: 400 });
    }
    data = { amount: amt, status: 'Approved', payMonth: pm, payrollEntryId: null, decidedById: actor.id, decidedByName: actor.name, decidedAt: new Date(), note: note ? String(note).slice(0, 500) : a.note };
  } else if (decision === 'reject') {
    data = { status: 'Rejected', payMonth: null, payrollEntryId: null, decidedById: actor.id, decidedByName: actor.name, decidedAt: new Date(), note: note ? String(note).slice(0, 500) : a.note };
  } else if (decision === 'undo') {
    // Back to where it was: waiting for the amount when it never had one.
    data = { status: Number(a.amount) > 0 ? 'Pending' : WAITING_AMOUNT, payMonth: null, payrollEntryId: null, decidedById: null, decidedByName: null, decidedAt: null };
  } else throw Object.assign(new Error('Choose approve, reject or undo.'), { status: 400 });
  const row = await prisma.incentiveAward.update({ where: { id }, data });
  await logAudit({
    userId: actor.id, actorName: actor.name, action: `Incentive ${decision === 'undo' ? 'decision undone' : decision === 'approve' ? 'approved' : 'rejected'}`,
    entity: 'IncentiveAward', entityId: id, fromValue: a.status, toValue: `${emp.name} · ${RJ.monthLabel(a.month)} · ₹${a.amount}${row.payMonth ? ` · paid with ${RJ.monthLabel(row.payMonth)} salary` : ''}`, reason: note || undefined,
  });
  return row;
}

// For payroll: Map(employeeId -> rupees) of APPROVED awards paid in `payMonth`.
async function approvedFor(employeeIds, payMonth) {
  const out = new Map();
  if (!employeeIds.length) return out;
  const rows = await prisma.incentiveAward.findMany({ where: { employeeId: { in: employeeIds }, payMonth, status: { in: ['Approved', 'Paid'] } }, select: { employeeId: true, amount: true } }).catch(() => []);
  rows.forEach((r) => out.set(r.employeeId, (out.get(r.employeeId) || 0) + Math.max(0, round(r.amount))));
  return out;
}
// The payroll records now carry the awards: point them at it.
async function linkPayroll(employeeId, payMonth, entryId) {
  await prisma.incentiveAward.updateMany({ where: { employeeId, payMonth, status: 'Approved' }, data: { payrollEntryId: entryId } }).catch(() => {});
}

// One person's complete incentive history, newest first (awards + the B1
// recruiter-joinings decisions), each with where it stands in payroll.
async function historyFor(employeeId) {
  const [awards, rj] = await Promise.all([
    prisma.incentiveAward.findMany({ where: { employeeId }, orderBy: [{ month: 'desc' }, { createdAt: 'desc' }] }).catch(() => []),
    prisma.recruiterJoiningDecision.findMany({ where: { employeeId, decision: 'INCENTIVE' }, orderBy: { month: 'desc' } }).catch(() => []),
  ]);
  const months = [...new Set([...awards.map((a) => a.payMonth), ...rj.map((d) => d.payMonth)].filter(Boolean))];
  const runs = months.length ? await prisma.employeePayrollRun.findMany({ where: { employeeId, month: { in: months } }, select: { month: true, status: true } }) : [];
  const runOf = new Map(runs.map((r) => [r.month, r.status]));
  const payWord = (pm) => { if (!pm) return ''; const s = runOf.get(pm); return !s ? `to be paid with ${RJ.monthLabel(pm)} salary` : s === 'PAID' ? `paid with ${RJ.monthLabel(pm)} salary` : `in ${RJ.monthLabel(pm)} payroll (${s.replace(/_/g, ' ').toLowerCase()})`; };
  const out = [
    ...awards.map((a) => ({
      id: a.id, kind: 'award', month: a.month, label: RJ.monthLabel(a.month), rule: a.ruleName || '', metric: a.metric, achieved: a.achieved, target: a.target, amount: a.amount,
      status: a.status === 'Approved' && runOf.get(a.payMonth) === 'PAID' ? 'Paid' : a.status, payMonth: a.payMonth, pay: a.status === 'Approved' ? payWord(a.payMonth) : '',
      note: a.note, decidedByName: a.decidedByName, decidedAt: a.decidedAt, source: a.source,
    })),
    ...rj.map((d) => ({
      id: d.id, kind: 'recruiter', month: d.month, label: RJ.monthLabel(d.month), rule: 'Recruiter joinings', metric: 'JOININGS', achieved: d.joinings, target: d.target, amount: d.amount,
      status: runOf.get(d.payMonth) === 'PAID' ? 'Paid' : 'Approved', payMonth: d.payMonth, pay: payWord(d.payMonth), note: d.note, decidedByName: d.decidedByName, decidedAt: d.updatedAt, source: 'RECRUITER_JOININGS',
    })),
  ].sort((a, b) => b.month.localeCompare(a.month));
  return out;
}

module.exports = {
  carryStep, withOptionalFields, WAITING_AMOUNT, joiningsPlan, carrySentence, METRICS, BASES, STATUSES, MAX_AMOUNT, loadRules, ruleFor, amountOf, achievements, preview, generate, manual, decide, payMonthFor, approvedFor, linkPayroll, historyFor, lockedEntry,
};
