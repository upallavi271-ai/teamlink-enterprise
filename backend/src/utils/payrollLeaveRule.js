// ---------------------------------------------------------------------------
// LEAVE THAT IS NOT APPROVED (founder 2026-11-25, in his words: "if a leave is applied it is not one LOP; only if the applied leave is
// approved is it one LOP; if the leave is not approved it is 2 LOP; absent with no leave applied is 2 LOP too; and one day a month is not
// cut - approved or not, that is the employee's leave").
//
// From the payroll month set in Payroll policy -> Leave not approved (utils/payrollCycle.js unapprovedRuleFor), per pay period:
//   * ONE leave day (HrConfig.paidLeaveDaysPerMonth) is free: the earliest applied leave day(s), approved OR still waiting for approval.
//   * every other APPROVED leave day costs 1 LOP (as before: leave beyond the paid-leave days)
//   * every other leave day that is NOT approved - still waiting at the time of payroll, or rejected while the person was absent -
//     costs `days` LOP (2: the same as an absent day with no leave applied)
//   * absent with no leave applied: unchanged (its own rule, utils/absentNoLeave.js)
// Nothing saved = the old arithmetic, exactly (waiting leave 1 LOP a day, the paid-leave days only for approved leave).
//
// Pure: day rows in (utils/attendanceDays.js), per-date amounts out. The payroll engine (utils/payrollEngine.js) takes the TOTALS and the
// LOP dates screen (utils/payrollLopBreakdown.js) the per-date parts, from this one function, so they cannot disagree.
// ---------------------------------------------------------------------------
const ANL = require('./absentNoLeave');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// A day that waits for a LEAVE's approval (not an attendance correction waiting: that stays as it was).
function isLeavePending(r) {
  return (Number(r.pending) || 0) > 0 && (r.status === 'Leave Under Review' || r.status === 'Half Day, Under Review' || !!r.pendingHalf || !!r.pendingLeaveId);
}

// rows: one employee's day rows for the pay period. opt: { paidLeave, days, rejected: Set(dates)|null, unmarkedUnpaid }
// -> { byDate: Map(date -> { free, leaveCost, pendingLop, rejectedExtra }), leavePendingDays, pendingLop, leaveCost, rejectedExtra }
function allocate(rows, opt) {
  const days = Number(opt.days) || 2;
  const byDate = new Map();
  const part = (date) => {
    if (!byDate.has(date)) byDate.set(date, { date, free: 0, leaveCost: 0, pendingLop: 0, rejectedExtra: 0, pendingFraction: 0 });
    return byDate.get(date);
  };
  let allowance = Number(opt.paidLeave) || 0;
  let leavePendingDays = 0;
  rows
    .filter((r) => r.counted && ((Number(r.leave) || 0) > 0 || isLeavePending(r)))
    .sort((a, b) => (a.date < b.date ? -1 : (a.date > b.date ? 1 : 0)))
    .forEach((r) => {
      const p = part(r.date);
      const lv = Number(r.leave) || 0;
      const pe = isLeavePending(r) ? Number(r.pending) || 0 : 0;
      leavePendingDays += pe;
      const free = Math.min(lv + pe, allowance);
      allowance = r2(allowance - free);
      const freeLeave = Math.min(lv, free);
      const freePending = r2(free - freeLeave);
      p.free = r2(free);
      p.leaveCost = r2(lv - freeLeave);
      p.pendingFraction = r2(pe);
      p.pendingLop = r2((pe - freePending) * days);
    });
  // a leave that was applied for and REJECTED while the person was absent: the day is "not approved" too
  if (opt.rejected && opt.rejected.size) {
    rows.forEach((r) => {
      if (!opt.rejected.has(r.date) || !ANL.isFullCandidate(r)) return;
      const base = r.status === 'Missing Check-In' ? (opt.unmarkedUnpaid === false ? 0 : 1) : (Number(r.absent) || 1);
      const extra = r2(Math.max(0, days - base));
      if (extra) part(r.date).rejectedExtra = extra;
    });
  }
  const sum = (k) => r2([...byDate.values()].reduce((n, p) => n + p[k], 0));
  return { byDate, leavePendingDays: r2(leavePendingDays), pendingLop: sum('pendingLop'), leaveCost: sum('leaveCost'), rejectedExtra: sum('rejectedExtra') };
}

module.exports = { allocate, isLeavePending };
