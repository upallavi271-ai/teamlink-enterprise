// ---------------------------------------------------------------------------
// LEAVE DAYS AND WHAT THEY COST IN LOP - one function for the payroll engine and the LOP dates screen.
//
// 1) LEAVE THAT IS NOT APPROVED (founder 2026-11-25: "if a leave is applied it is not one LOP; only if the applied leave is approved is it
//    one LOP; if the leave is not approved it is 2 LOP; absent with no leave applied is 2 LOP too; and one day a month is not cut - approved
//    or not, that is the employee's leave"). From the payroll month set in Payroll policy (utils/payrollCycle.js unapprovedRuleFor), per pay
//    period:
//      * ONE leave day (HrConfig.paidLeaveDaysPerMonth) is free: the earliest applied leave day(s), approved OR still waiting for approval.
//      * every other APPROVED leave day costs 1 LOP (as before: leave beyond the paid-leave days)
//      * every other leave day that is NOT approved - still waiting at the time of payroll, or rejected while the person was absent -
//        costs `days` LOP (2: the same as an absent day with no leave applied)
//      * absent with no leave applied: unchanged (its own rule, utils/absentNoLeave.js)
//    Not on (opt.days null) = the old arithmetic, exactly: waiting leave 1 LOP a day, the free day only for approved leave.
//
// 2) CARRY-FORWARD LEAVE (founder 2026-11-25: "an employee who took no leave for 2 months has 2 saved leaves to take next month - tell it at
//    LOP time, and do not cut those as LOP"). Each pay period has 1 free leave day; the unused ones of the earlier pay periods of the same
//    calendar year are SAVED (utils/payrollLeaveCarry.js, reset on 1 Jan). `opt.carry` days cover APPROVED leave days that are left over after
//    the free day, earliest first, before any is cut as LOP. A leave still waiting never uses a saved day.
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

// rows: one employee's day rows for the pay period.
// opt: { paidLeave, days (null = leave-not-approved rule off), carry (saved days brought in), rejected: Set(dates)|null, unmarkedUnpaid }
// -> { byDate: Map(date -> { free, carryUsed, leaveCost, pendingLop, rejectedExtra, pendingFraction }), leavePendingDays, pendingLop, leaveCost,
//      rejectedExtra, carryUsed }
function allocate(rows, opt) {
  const un = Number(opt.days) > 0 ? Number(opt.days) : null;
  const byDate = new Map();
  const part = (date) => {
    if (!byDate.has(date)) byDate.set(date, { date, free: 0, carryUsed: 0, leaveCost: 0, pendingLop: 0, rejectedExtra: 0, pendingFraction: 0 });
    return byDate.get(date);
  };
  let allowance = Number(opt.paidLeave) || 0;
  let carry = Math.max(0, Number(opt.carry) || 0);
  let leavePendingDays = 0;
  rows
    .filter((r) => r.counted && ((Number(r.leave) || 0) > 0 || (un && isLeavePending(r))))
    .sort((a, b) => (a.date < b.date ? -1 : (a.date > b.date ? 1 : 0)))
    .forEach((r) => {
      const p = part(r.date);
      const lv = Number(r.leave) || 0;
      const pe = un && isLeavePending(r) ? Number(r.pending) || 0 : 0;
      leavePendingDays += pe;
      const free = Math.min(lv + pe, allowance);
      allowance = r2(allowance - free);
      const freeLeave = Math.min(lv, free);
      const freePending = r2(free - freeLeave);
      p.free = r2(free);
      // what is left of an APPROVED leave after the free day is covered by the saved (carry-forward) days, then cut
      const left = r2(lv - freeLeave);
      const covered = Math.min(carry, left);
      carry = r2(carry - covered);
      p.carryUsed = r2(covered);
      p.leaveCost = r2(left - covered);
      p.pendingFraction = r2(pe);
      p.pendingLop = un ? r2((pe - freePending) * un) : 0;
    });
  // a leave that was applied for and REJECTED while the person was absent: the day is "not approved" too
  if (un && opt.rejected && opt.rejected.size) {
    rows.forEach((r) => {
      if (!opt.rejected.has(r.date) || !ANL.isFullCandidate(r)) return;
      const base = r.status === 'Missing Check-In' ? (opt.unmarkedUnpaid === false ? 0 : 1) : (Number(r.absent) || 1);
      const extra = r2(Math.max(0, un - base));
      if (extra) part(r.date).rejectedExtra = extra;
    });
  }
  const sum = (k) => r2([...byDate.values()].reduce((n, p) => n + p[k], 0));
  return {
    byDate, leavePendingDays: r2(leavePendingDays), pendingLop: sum('pendingLop'), leaveCost: sum('leaveCost'), rejectedExtra: sum('rejectedExtra'), carryUsed: sum('carryUsed'),
  };
}

module.exports = { allocate, isLeavePending };
