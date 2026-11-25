// ---------------------------------------------------------------------------
// WHICH DATES ARE THE LOP DAYS? (founder 2026-11-19: "when I click the LOP count, like Navya's 2, a screen should
// show which date the LOP is deducted, is it leave or absent, is it approved or not - every detail".)
//
// A payroll record stores only the NUMBER of LOP days (EmployeePayrollRun.daysLop), not the dates. This file rebuilds the
// dates, READ-ONLY, from the very same inputs and the very same arithmetic the payroll engine uses
// (utils/payrollEngine.js attendanceDefaults):
//
//   LOP = absent fractions                      Absent, the unworked half of a Half Day, an unpaid leave type
//       + pending fractions                     leave / correction still waiting: unpaid until it is approved
//       + Missing Check-In days                 (when the policy says unmarked working days are unpaid)
//       + approved paid leave beyond the paid-leave days of the pay period
//       + working days before the joining date, and days after the last working day
//       + half a day per late arrival beyond the free allowance
//       + the extra LOP of "absent without applying leave"
//     capped at the payroll days of the pay period.
//
// Each term is spread over the dates it comes from, so the dates always add up to the engine's number (the cap is shown
// separately). Two terms are allowances over a whole pay period (paid leave, free late arrivals): the engine only knows
// the total, so the allowance is given to the EARLIEST days and the later ones carry the cost - said so on the screen.
//
// What the record stores can differ from what attendance gives today:
//   * HR typed the days (PayrollAttendance override / the imported pay register)   -> shown as such, with reason, who, when
//   * somebody edited the record (payroll edit)                                     -> "Edited by X on D: from a to b"
//   * a leave was decided / a punch uploaded after the payroll was calculated       -> said plainly, never hidden
// Nothing is written here.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const D = require('./attendanceDays');
const E = require('./payrollEngine');
const PC = require('./payrollCycle');
const ANL = require('./absentNoLeave');
const PEdit = require('./payrollEdit');
const LR = require('./payrollLeaveRule'); // leave that is not approved + carry-forward leave (founder 2026-11-25)
const LC = require('./payrollLeaveCarry'); // the unused monthly free leave day, saved until 31 Dec
const { monthLabel } = require('./attendanceMath');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const weekdayOf = (date) => WEEKDAY[new Date(`${date}T00:00:00Z`).getUTCDay()];
const NOT_COUNTED_STATUSES = ['Upcoming', 'Not Joined', 'Left'];
const LEVEL_WORD = { TL: 'TL', STL: 'STL', HR: 'HR', ASSISTANT_MANAGER: 'Asst Manager', MANAGER: 'Manager', ADMIN: 'Admin', SUPER_ADMIN: 'Super Admin' };
const dayText = (n) => `${r2(n)} day${r2(n) === 1 ? '' : 's'}`;
const clockText = (t) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
  if (!m) return '';
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`;
};

// ---- The arithmetic, spread over the dates (pure: rows in, parts out) --------------------------------------------
// rows   one employee's day rows for the pay period (utils/attendanceDays.js loadDays -> days(employee))
// ctx    { policy, workingDays, rule (PC.absentRuleFor), awlCtx ({ withData, rejected } | null), employeeId }
// -> { byDate: Map(date -> parts), total, listed, workingDays, capped, terms }
function explainRows(rows, ctx) {
  const { policy, workingDays, rule } = ctx;
  const offs = D.weeklyOffs(policy);
  const payable = (date) => policy.weekendsPaid || !offs.has(new Date(`${date}T00:00:00Z`).getUTCDay());
  const unmarkedUnpaid = policy.unmarkedDaysUnpaid !== false;
  const freeLate = Number(policy.freeLateArrivalsPerMonth || 0);
  const paidLeave = Number(policy.paidLeaveDaysPerMonth || 0);
  const considered = rows.filter((d) => !NOT_COUNTED_STATUSES.includes(d.status));
  const byDate = new Map();
  const part = (date) => {
    if (!byDate.has(date)) {
      byDate.set(date, {
        date, absent: 0, pending: 0, missingCheckIn: 0, awlExtra: 0, awlKind: null, lateCost: 0, lateNo: 0, leaveCost: 0, leaveFree: 0,
        notJoined: 0, afterExit: 0, rejectedExtra: 0, free: 0, pendingFraction: 0, carryUsed: 0,
      });
    }
    return byDate.get(date);
  };

  // the terms summarise() adds up: only the days that count
  considered.forEach((d) => {
    if (!d.counted) return;
    const p = part(d.date);
    p.absent = r2(d.absent);
    p.pending = r2(d.pending);
    if (d.status === 'Missing Check-In' && unmarkedUnpaid) p.missingCheckIn = 1;
  });
  // working days before the joining date / after the last working day
  rows.forEach((d) => {
    if (d.status === 'Not Joined' && payable(d.date)) part(d.date).notJoined = 1;
    if (d.status === 'Left' && payable(d.date)) part(d.date).afterExit = 1;
  });
  // late arrivals. Old rule: the first `freeLate` of the period are free, each later one costs half a day. Late-coming group rule
  // (Payroll policy, founder 2026-11-25): every `every`-th late arrival closes a group and costs `days` LOP (3 late = 1, 6 = 2).
  const lr = ctx.lateRule && ctx.lateRule.active ? ctx.lateRule : null;
  const lateRows = considered.filter((d) => d.late).sort((a, b) => (a.date < b.date ? -1 : 1));
  lateRows.forEach((d, i) => {
    const p = part(d.date);
    p.lateNo = i + 1;
    if (lr) { if ((i + 1) % lr.every === 0) p.lateCost = lr.days; } else if (i + 1 > freeLate) p.lateCost = 0.5;
  });
  // approved paid leave: the paid-leave days of the period cover the earliest leave days, the rest is unpaid
  let allowance = paidLeave;
  considered.filter((d) => d.counted && Number(d.leave) > 0).sort((a, b) => (a.date < b.date ? -1 : 1)).forEach((d) => {
    const p = part(d.date);
    const free = Math.min(Number(d.leave) || 0, allowance);
    allowance = r2(allowance - free);
    p.leaveFree = r2(free);
    p.leaveCost = r2((Number(d.leave) || 0) - free);
  });
  // absent without applying leave: the extra over what the day already counts (same test as utils/absentNoLeave.js detect())
  if (rule.active) {
    const rejected = ctx.awlCtx ? (ctx.awlCtx.rejected.get(ctx.employeeId) || null) : null;
    rows.forEach((r) => {
      const kind = ANL.classify(r, { withData: ctx.awlCtx ? ctx.awlCtx.withData : null, rejected: !!(r && rejected && rejected.has(r.date)) });
      const p = part(r.date);
      if (kind === 'full') {
        const base = r.status === 'Missing Check-In' ? (unmarkedUnpaid ? 1 : 0) : (Number(r.absent) || 1);
        p.awlExtra = r2(Math.max(0, rule.days - base)); p.awlKind = 'full';
      } else if (kind === 'half') {
        const base = Number(r.absent) || 0.5;
        p.awlExtra = r2(Math.max(0, rule.halfDayDays - base)); p.awlKind = 'half';
      }
    });
  }
  // LEAVE NOT APPROVED (Payroll policy, founder 2026-11-25): from the one function the engine uses (utils/payrollLeaveRule.js), replacing the
  // waiting-leave and paid-leave terms above: one free leave day a month (approved or not), approved leave beyond it 1 LOP, a leave day that is
  // not approved (waiting, or rejected while absent) `days` LOP.
  // CARRY-FORWARD LEAVE (founder 2026-11-25): the saved days of the earlier pay periods cover approved leave left over after the free day
  // (same function again). Either rule on = the leave terms below come from it.
  const un = ctx.unRule && ctx.unRule.active ? ctx.unRule : null;
  const carryOn = !!(ctx.carryRule && ctx.carryRule.active);
  if (un || carryOn) {
    const alloc = LR.allocate(rows, { paidLeave, days: un ? un.days : null, carry: carryOn ? (ctx.carryIn || 0) : 0, rejected: un ? (ctx.rejectedSet || null) : null, unmarkedUnpaid });
    byDate.forEach((p) => { p.leaveCost = 0; p.leaveFree = 0; });
    if (un) considered.forEach((d) => { if (d.counted && LR.isLeavePending(d)) part(d.date).pending = 0; }); // their waiting part is priced again below
    alloc.byDate.forEach((a, date) => {
      const p = part(date);
      p.leaveCost = a.leaveCost; p.leaveFree = a.free; p.carryUsed = a.carryUsed;
      if (un) { p.free = a.free; p.pendingFraction = a.pendingFraction; p.pending = r2(p.pending + a.pendingLop); p.rejectedExtra = a.rejectedExtra; }
    });
  }
  let sum = 0;
  byDate.forEach((p) => {
    p.lop = r2(p.absent + p.pending + p.missingCheckIn + p.awlExtra + p.lateCost + p.leaveCost + p.notJoined + p.afterExit + p.rejectedExtra);
    sum += p.lop;
  });
  const listed = r2(sum);
  const total = Math.min(Number(workingDays) || 0, listed);
  const terms = {
    absent: r2([...byDate.values()].reduce((n, p) => n + p.absent, 0)),
    pending: r2([...byDate.values()].reduce((n, p) => n + p.pending, 0)),
    missingCheckIn: [...byDate.values()].reduce((n, p) => n + p.missingCheckIn, 0),
    awlExtra: r2([...byDate.values()].reduce((n, p) => n + p.awlExtra, 0)),
    lateArrivals: r2([...byDate.values()].reduce((n, p) => n + p.lateCost, 0)),
    leaveBeyondAllowance: r2([...byDate.values()].reduce((n, p) => n + p.leaveCost, 0)),
    rejectedLeave: r2([...byDate.values()].reduce((n, p) => n + p.rejectedExtra, 0)),
    carryCovered: r2([...byDate.values()].reduce((n, p) => n + p.carryUsed, 0)),
    beforeJoining: [...byDate.values()].reduce((n, p) => n + p.notJoined, 0),
    afterLeaving: [...byDate.values()].reduce((n, p) => n + p.afterExit, 0),
  };
  return { byDate, listed, total, capped: r2(listed - total), terms, freeLate, paidLeave, lateCount: lateRows.length, lateRule: lr, unapprovedRule: un, carryRule: carryOn ? ctx.carryRule : null };
}

// ---- Words ------------------------------------------------------------------------------------------------------
function absentWhy(row) {
  const lv = row.leaveType ? ` (${row.leaveType})` : '';
  switch (row.status) {
    case 'Absent':
      if (row.note === 'Marked by HR') return 'HR marked this day Absent.';
      if (/^Worked /.test(row.note || '')) return `${row.note}. The old attendance rule counts that as Absent.`;
      if (row.leaveRejected) return 'No check-in, and the leave request for this day was rejected.';
      return 'No check-in on a working day, and no leave or attendance-correction request was made for it.';
    case 'Half Day':
      return `Only one half of the day was worked${row.session ? ` (${row.session.toLowerCase()})` : ''}, so the other half (0.5) is unpaid. ${row.note === 'Marked by HR' ? 'HR marked this day as a Half Day.' : ''}`.trim();
    case 'Half Leave + Absent':
      return `${row.leaveHalf || 'Half-day'} leave${lv} was approved, but the other half of the day was not worked${Number(row.unpaidLeave) > 0 ? ', and this leave type is unpaid' : ''}.`;
    case 'On Leave':
      return Number(row.unpaidLeave) > 0 ? `Approved leave of an unpaid type${lv}: unpaid days.` : 'Leave day.';
    case 'No device data':
      return 'No attendance has come from the device / import for this date for anyone in the company yet, so the day is unpaid until the data arrives.';
    default:
      return row.reason || `${row.status} is unpaid.`;
  }
}

function unapprovedWhy(row, p, ctx) {
  return `${row.sandwichWaiting ? 'A weekly off or holiday between two leave days counts as leave (sandwich rule), and one of the two leaves is not approved. ' : 'A leave was applied but it is not approved by the time of payroll. '}`
    + `Each such day counts ${ctx.unRule.days} LOP days (the same as absent with no leave applied).${p.free > 0 ? ` Part of it is the free leave day of the pay period (${ctx.paidLeave} a month), which is not cut.` : ''}`
    + ' When the leave is approved and the payroll is calculated again, an approved leave costs 1 LOP day beyond the free day.';
}

function pendingWhy(row) {
  if (row.sandwichWaiting) return 'A weekly off or holiday between two leave days counts as leave (sandwich rule). One of the two leaves is still waiting for approval, so this day is unpaid until both are approved.';
  if (row.status === 'Informed') return 'An attendance correction was asked for but is still waiting for approval. The day stays unpaid until it is approved.';
  if (row.status === 'Half Day, Under Review') return 'Worked one half; the leave asked for the other half is still waiting for approval. Unpaid until it is approved.';
  if (row.status === 'Leave Under Review') return 'A leave was applied but is still waiting for approval. The day is unpaid until it is approved.';
  return 'Waiting for an approval; unpaid until it is approved.';
}

function reasonsOf(row, p, ctx) {
  const out = [];
  if (p.notJoined) out.push({ code: 'before-joining', days: 1, text: `A working day before the joining date${ctx.joinedOn ? ` (${ctx.joinedOn})` : ''}, so it is not paid in this pay period.` });
  if (p.afterExit) out.push({ code: 'after-leaving', days: 1, text: 'A working day after the last working day, so it is not paid.' });
  if (p.absent) out.push({ code: 'absent', days: p.absent, text: absentWhy(row) });
  if (p.pending) out.push({ code: 'pending', days: p.pending, text: ctx.unRule && ctx.unRule.active && LR.isLeavePending(row) ? unapprovedWhy(row, p, ctx) : pendingWhy(row) });
  if (p.rejectedExtra) {
    out.push({
      code: 'rejected-leave', days: p.rejectedExtra,
      text: `A leave was applied for this day but it was rejected (not approved) and the person was absent: it counts ${ctx.unRule.days} LOP days instead of 1 (this is the extra ${p.rejectedExtra}).`,
    });
  }
  if (p.missingCheckIn) {
    out.push({
      code: 'missing-check-in', days: 1,
      text: `${row.checkOut ? `Only a check-out (${clockText(row.checkOut)}) was recorded, no check-in.` : 'No check-in was recorded.'} The policy counts working days with no check-in as unpaid.`,
    });
  }
  if (p.awlExtra) {
    out.push({
      code: 'absent-without-leave', days: p.awlExtra,
      text: p.awlKind === 'half'
        ? `Half day with no leave of any kind applied: the payroll rule counts it as ${ctx.rule.halfDayDays} LOP day(s) instead of 0.5 (this is the extra ${p.awlExtra}).`
        : `Absent without applying for leave: the payroll rule counts such a day as ${ctx.rule.days} LOP days instead of 1 (this is the extra ${p.awlExtra}).`,
    });
  }
  if (p.lateCost) {
    out.push({
      code: 'late', days: p.lateCost,
      text: ctx.lateRule && ctx.lateRule.active
        ? `Late arrival no. ${p.lateNo} of the pay period. Every ${ctx.lateRule.every} late arrivals in a pay period count as ${ctx.lateRule.days} LOP day(s); this one completes group ${p.lateNo / ctx.lateRule.every}.`
        : `Late arrival no. ${p.lateNo} of the pay period. The first ${ctx.freeLate} late arrival(s) are free; each one after that costs half a day.`,
    });
  }
  if (p.leaveCost) {
    out.push({
      code: 'leave-beyond-allowance', days: p.leaveCost,
      text: `${row.sandwich ? `${row.note || 'Sandwich leave'} (counted as leave). ` : `Approved ${row.leaveType || 'paid'} leave. `}Only ${ctx.paidLeave} paid leave day(s) are allowed in a pay period. The allowance covers the earliest leave days; later leave days are unpaid.`,
    });
  }
  return out;
}

// Why a day that looks like an absence was NOT counted.
function notCountedNotes(row, p, ctx) {
  const notes = [];
  if (row.status === 'Holiday') notes.push({ kind: 'holiday', text: `Holiday${row.note ? ` (${row.note})` : ''}: not a working day.` });
  if (row.sandwichWaiting) notes.push({ kind: 'sandwich', text: `${row.note || 'Sandwich leave'}. The sandwich rule treats it as leave.` });
  else if (row.sandwich) notes.push({ kind: 'sandwich', text: `${row.note || 'Sandwich leave'}. The sandwich rule treats it as leave, and that leave is paid.` });
  else if (Number(row.leave) > 0 && p && p.carryUsed > 0 && !(p.leaveFree > 0)) {
    notes.push({ kind: 'carry', text: `Approved ${row.leaveType || ''} leave paid from the carry-forward leave: ${p.carryUsed} day of the ${ctx.carryIn} saved from earlier pay periods of this year (the unused free leave days), so it is not cut.`.replace('  ', ' ') });
  } else if (Number(row.leave) > 0 && p && p.leaveFree > 0) {
    notes.push({ kind: 'leave', text: `${row.status === 'Half Day + Half Leave' ? 'Worked one half and approved leave covers the other half.' : `Approved ${row.leaveType || ''} leave`.replace('  ', ' ')} Paid: it is within the ${ctx.paidLeave} paid leave day(s) of the pay period.`.trim() });
  }
  if (ctx.unRule && ctx.unRule.active && p && p.free > 0 && LR.isLeavePending(row)) {
    notes.push({ kind: 'free-day', text: `This is the free leave day of the pay period (${ctx.paidLeave} a month): it is not cut, even though the leave is not approved.` });
  }
  if (row.lateExcused || row.lateState === 'approved') notes.push({ kind: 'late', text: 'Came late, but the late-coming request was approved, so it is not counted as a late arrival.' });
  else if (row.late && p && p.lateNo && !p.lateCost) {
    notes.push({
      kind: 'late',
      text: ctx.lateRule && ctx.lateRule.active
        ? `Late arrival no. ${p.lateNo}: every ${ctx.lateRule.every} late arrivals count as ${ctx.lateRule.days} LOP day(s), and this one does not complete a group yet (${p.lateNo % ctx.lateRule.every} of ${ctx.lateRule.every}), so no cut.`
        : `Late arrival no. ${p.lateNo}: within the ${ctx.freeLate} free late arrival(s) of the pay period, so no cut.`,
    });
  }
  if (row.regularization === 'Approved') notes.push({ kind: 'regularized', text: 'An attendance correction (regularization) was approved for this day, so it counts as worked.' });
  return notes;
}

// ---- The requests behind each date -------------------------------------------------------------------------------
const chainOf = (steps) => steps.map((s) => ({
  level: LEVEL_WORD[s.level] || s.level, who: s.actedByName || s.approverName || null, status: s.status, at: s.actedAt || null, direct: !!s.direct,
}));

async function loadRequests(employeeId, from, to) {
  const [leaves, regs, lates] = await Promise.all([
    prisma.leaveRequest.findMany({ where: { employeeId, fromDate: { lte: to }, toDate: { gte: from } }, orderBy: { createdAt: 'asc' } }),
    prisma.attendanceRegularization.findMany({ where: { employeeId, date: { gte: from, lte: to } }, orderBy: { createdAt: 'asc' } }),
    (prisma.latePermission ? prisma.latePermission.findMany({ where: { employeeId, date: { gte: from, lte: to } }, orderBy: { requestedAt: 'asc' } }) : Promise.resolve([])).catch(() => []),
  ]);
  const ids = [...leaves.map((l) => l.id), ...regs.map((r) => r.id), ...lates.map((l) => l.id)];
  const steps = ids.length
    ? await prisma.approvalStep.findMany({
      where: { recordId: { in: ids }, workflow: { in: ['leave', 'regularization', 'latePermission'] }, level: { not: 'EMPLOYEE' }, status: { in: ['Approved', 'Rejected', 'Pending'] } },
      orderBy: { seq: 'asc' },
    }).catch(() => [])
    : [];
  const stepsOf = (workflow, id) => chainOf(steps.filter((s) => s.workflow === workflow && s.recordId === id));
  const halfOf = (l) => require('./leaveText').halfOf(l) || null;
  return {
    leaves: leaves.map((l) => {
      const chain = stepsOf('leave', l.id);
      return {
        id: l.id, type: l.type, from: String(l.fromDate).slice(0, 10), to: String(l.toDate).slice(0, 10), days: l.days, half: halfOf(l),
        status: l.status, reason: l.reason || null, appliedAt: l.createdAt, decidedBy: l.decidedBy || null, decidedAt: l.decidedAt || null,
        note: l.status === 'Rejected' ? (l.rejectReason || null) : (l.approvalReason || null),
        cancelledAt: l.cancelledAt || null, cancelledBy: l.cancelledBy || null, cancelReason: l.cancelReason || null,
        waitingFor: chain.filter((c) => c.status === 'Pending').map((c) => c.who).filter(Boolean).join(' / ') || null,
        chain,
      };
    }),
    regs: regs.map((r) => {
      const chain = stepsOf('regularization', r.id);
      const last = [...chain].reverse().find((c) => c.status === 'Approved' || c.status === 'Rejected');
      return {
        id: r.id, date: r.date, requestedCheckIn: r.requestedCheckIn || null, requestedCheckOut: r.requestedCheckOut || null, reason: r.reason || null,
        status: r.status, appliedAt: r.createdAt, decidedAt: r.decidedAt || null, decidedBy: last ? last.who : null, chain,
      };
    }),
    lates: lates.map((l) => ({
      id: l.id, date: l.date, kind: l.kind || 'Advance', expectedTime: l.expectedTime || null, reason: l.reason || null, note: l.note || null, status: l.status,
      appliedAt: l.requestedAt, appliedBy: l.appliedBy || null, decidedBy: l.decidedBy || null, decidedAt: l.decidedAt || null, decisionNote: l.decisionNote || null,
      chain: stepsOf('latePermission', l.id),
    })),
  };
}

// ---- One date, as the screen shows it ----------------------------------------------------------------------------
function dayOf(row, p, ctx, req) {
  const leaves = req.leaves.filter((l) => l.from <= row.date && l.to >= row.date);
  return {
    date: row.date,
    weekday: weekdayOf(row.date),
    lop: p ? p.lop : 0,
    status: row.status,
    colour: row.colour || '',
    attendance: row.reason || row.note || row.status,
    checkIn: row.checkIn || null,
    checkOut: row.checkOut || null,
    hours: row.hours != null ? row.hours : null,
    source: row.howText || '',
    punches: (row.punchList || []).map((x) => ({ time: x.time, direction: x.direction, source: x.sourceLabel, usedAs: x.usedAs || '' })),
    leaveType: row.leaveType || null,
    reasons: p ? reasonsOf(row, p, ctx) : [],
    leave: leaves,
    regularization: req.regs.filter((r) => r.date === row.date),
    late: req.lates.filter((l) => l.date === row.date),
  };
}

// ---- The whole breakdown for payroll records -----------------------------------------------------------------------
// entry: an EmployeePayrollRun row INCLUDING `employee`, or anything shaped like one ({ id|null, employeeId, employee, month,
// daysLop, daysPresent, workingDays, attendanceSource, ... } - e.g. a payslip of a month without per-employee records).
// desk: true = the payroll desk (may see who edited / the reason HR typed); false = the employee on their own payslip.
async function forEntry(entry, { desk = true } = {}) {
  const month = entry.month;
  const emp = entry.employee;
  const policy = await E.getPolicy();
  const settings = await PC.getSettings();
  const cycle = PC.cycleOf(month, settings.cycle);
  const rule = PC.absentRuleFor(month, settings.absent);
  const leavers = await E.leaversIn([emp], cycle);
  const { days } = await D.loadDays(prisma, { employees: [emp], from: cycle.from, to: cycle.to, cfg: policy, lastDayOf: leavers.size ? leavers : null });
  const rows = days(emp);
  const workingDays = E.payrollWorkingDays(month, policy, cycle);
  const unRule = PC.unapprovedRuleFor(month, settings.unapproved);
  const carryRule = PC.carryRuleFor(month, settings.carry);
  // the saved (carry-forward) leave days brought into this pay period: worked out for the screen whether or not pay uses them yet
  const carryInfo = (await LC.carryIn([emp], month, policy, settings)).get(emp.id) || { saved: 0, months: [] };
  const awlCtx = (rule.active || unRule.active) ? await E.awlContext([emp], cycle) : null;
  const joinedOn = emp.dateOfJoining ? new Date(emp.dateOfJoining).toISOString().slice(0, 10) : null;
  const ctx = { policy, workingDays, rule, awlCtx, employeeId: emp.id, joinedOn, lateRule: PC.lateRuleFor(month, settings.late), unRule, carryRule, carryIn: carryInfo.saved, rejectedSet: awlCtx ? (awlCtx.rejected.get(emp.id) || null) : null };
  const x = explainRows(rows, ctx);
  ctx.freeLate = x.freeLate; ctx.paidLeave = x.paidLeave;
  const req = await loadRequests(emp.id, cycle.from, cycle.to);

  const counted = [];
  const notCounted = [];
  let weeklyOffs = 0;
  rows.forEach((row) => {
    const p = x.byDate.get(row.date) || null;
    if (p && p.lop > 0) { counted.push(dayOf(row, p, ctx, req)); return; }
    if (row.status === 'Weekly Off' && !row.sandwich) { weeklyOffs += 1; return; }
    const notes = notCountedNotes(row, p, ctx);
    if (notes.length) { const d = dayOf(row, p, ctx, req); d.notes = notes; notCounted.push(d); }
  });

  // ---- what is stored, and why it may differ from attendance -------------------------------------------------------
  const stored = r2(entry.daysLop);
  const att = r2(x.total);
  const override = entry.attendanceSource === 'OVERRIDE'
    ? await prisma.payrollAttendance.findUnique({ where: { employeeId_month: { employeeId: emp.id, month } } }).catch(() => null)
    : null;
  const state = entry.id ? await PEdit.readState(entry.id) : null;
  const versions = state && state.versions ? state.versions : [];
  const calculatedLop = versions.length && versions[0].after && versions[0].after.fields && versions[0].after.fields.daysLop != null
    ? r2(versions[0].after.fields.daysLop) : stored;
  const edits = [];
  versions.slice(1).forEach((v) => {
    (v.changes || []).filter((c) => c.field === 'daysLop').forEach((c) => edits.push({
      kind: v.kind, at: v.at, by: desk ? v.byName : null, reason: desk ? (v.reason || null) : null, from: r2(c.old), to: r2(c.new), change: r2(Number(c.new) - Number(c.old)),
    }));
  });
  const notes = [];
  if (x.capped > 0) notes.push(`The dates add up to ${x.listed} days, but a pay period cannot lose more than its ${workingDays} payroll days, so the payroll counts ${att}.`);
  const typedByHand = entry.attendanceSource === 'OVERRIDE' || !!(entry.importNote || entry.importedBreakup);
  let status = 'match';
  if (Math.abs(stored - att) > 0.001) {
    if (override || edits.length || typedByHand) status = 'adjusted';
    else if (entry.id || entry.attendanceSource) status = 'attendance-changed';
    else status = 'unknown';
  }
  if (override) {
    notes.push(`HR entered ${r2(override.daysLop)} LOP day(s) for this record by hand instead of working it out from attendance (details under "Changed by hand"). The dates below are what the attendance module shows.`);
    if (override.autoDaysLop != null && Math.abs(r2(override.autoDaysLop) - att) > 0.001) {
      notes.push(`Attendance gave ${r2(override.autoDaysLop)} LOP day(s) when HR saved this; it gives ${att} now (a leave decision, a punch upload or a correction since).`);
    }
  }
  if (!override && typedByHand) {
    notes.push(entry.importNote
      ? `These LOP days were imported from the team's pay register (${String(entry.importNote).slice(0, 160)}), not worked out from attendance. The dates below are what the attendance module shows.`
      : "These LOP days were typed by HR (or imported from the team's attendance / pay register sheet), not worked out from attendance. The entry on file does not say who or when. The dates below are what the attendance module shows.");
  }
  if (!override && !edits.length && status === 'attendance-changed') {
    notes.push(`The payroll was calculated with ${stored} LOP day(s); attendance gives ${att} now. A leave, correction or biometric upload was probably decided or added after the payroll was calculated, so the dates below are today's picture. Recalculating the month (while it is not submitted) brings the payroll up to date.`);
  }
  if (edits.length && Math.abs(calculatedLop - att) > 0.001) {
    notes.push(`When the payroll was first calculated it had ${calculatedLop} LOP day(s); attendance gives ${att} now.`);
  }
  if (Number(entry.workingDays) && Math.abs(Number(entry.workingDays) - workingDays) > 0.001 && !override) {
    notes.push(`This record has ${entry.workingDays} payroll days, the pay period now has ${workingDays} (the pay-period or week-off policy changed since it was calculated).`);
  }

  return {
    employee: { id: emp.id, name: emp.name, code: emp.employeeCode || null, department: emp.department || null },
    month, monthLabel: monthLabel(month),
    cycle: { from: cycle.from, to: cycle.to, days: cycle.days, rangeText: cycle.rangeText, label: cycle.label },
    record: {
      id: entry.id || null, status: entry.status || null, source: entry.attendanceSource || null,
      workingDays: Number(entry.workingDays) || workingDays, daysPresent: Number(entry.daysPresent) || 0, daysLop: stored,
      paidDays: r2(Math.max(0, (Number(entry.workingDays) || workingDays) - stored)),
    },
    attendanceLop: att,
    listedLop: x.listed,
    status,
    notes,
    adjustments: {
      override: override ? {
        daysLop: r2(override.daysLop), autoDaysLop: override.autoDaysLop != null ? r2(override.autoDaysLop) : null,
        by: desk ? override.overriddenByName || null : null, at: override.overriddenAt || null, reason: desk ? override.reason || null : null,
      } : null,
      edits,
      calculatedLop,
    },
    policy: {
      freeLateArrivals: x.freeLate, paidLeaveDays: x.paidLeave, unmarkedDaysUnpaid: policy.unmarkedDaysUnpaid !== false,
      weekendsPaid: !!policy.weekendsPaid, sandwichLeave: policy.sandwichLeave !== false,
      absentWithoutLeave: rule.active ? { days: rule.days, halfDayDays: rule.halfDayDays } : null,
      lateRule: ctx.lateRule.active ? { every: ctx.lateRule.every, days: ctx.lateRule.days } : null,
      unapprovedRule: unRule.active ? { days: unRule.days } : null,
      leaveCarry: carryRule.active,
    },
    terms: x.terms,
    // CARRY-FORWARD LEAVE: the unused free leave days of the earlier pay periods of this year, and how much pay used
    carry: {
      applied: carryRule.active, saved: carryInfo.saved, months: carryInfo.months,
      used: carryRule.active ? x.terms.carryCovered : 0, left: r2(carryInfo.saved - (carryRule.active ? x.terms.carryCovered : 0)),
    },
    capped: x.capped,
    dates: counted,
    notCounted,
    weeklyOffs,
  };
}

module.exports = { forEntry, explainRows, loadRequests };
