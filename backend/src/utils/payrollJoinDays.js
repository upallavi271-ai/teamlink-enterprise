// ---------------------------------------------------------------------------
// SOMEBODY WHO JOINED INSIDE THE PAY PERIOD (founder 2026-11-27: "Koushik joined 21 Oct: calculate from 21 Oct to 15 Nov, the days from
// 16 Oct must not come as LOP").
//
// The payroll record keeps ONE number of unpaid days (EmployeePayrollRun.daysLop) and the money is worked out from it
// (full-month pay x paid days / days in the pay period). For a joiner that number holds two different things: the days before the
// joining date (never employed) and real loss of pay. This file splits it for what people SEE: "5 days before joining, 4 LOP".
// Nothing stored and no amount changes: pay is still counted from the joining date.
//
// No split (the record shows as it always did) when: the person did not join inside this pay period; the record's payroll days are not
// the pay period's days (typed as a part month); or the record deducts fewer days than there are before the joining date.
// ---------------------------------------------------------------------------
const D = require('./attendanceDays');
const E = require('./payrollEngine');
const PC = require('./payrollCycle');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const isoDay = (d) => {
  if (!d) return null;
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? null : x.toISOString().slice(0, 10);
};
const dayBefore = (s) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };

// pure: cycle = { from, to }, periodDays = the pay period's payroll days
function splitOf({ workingDays, daysLop, dateOfJoining }, cycle, policy, periodDays) {
  const joinedOn = isoDay(dateOfJoining);
  if (!joinedOn || !cycle || joinedOn <= cycle.from || joinedOn > cycle.to) return null;
  const wd = Number(workingDays) || 0;
  const unpaid = Number(daysLop) || 0;
  if (!(wd > 0) || Math.abs(wd - periodDays) > 0.001) return null;
  const offs = D.weeklyOffs(policy);
  const beforeTo = dayBefore(joinedOn);
  let beforeDays = 0;
  D.eachDay(cycle.from, beforeTo).forEach((d) => { if (policy.weekendsPaid || !offs.has(new Date(`${d}T00:00:00Z`).getUTCDay())) beforeDays += 1; });
  if (!beforeDays || unpaid + 0.001 < beforeDays) return null;
  return {
    joinedOn, periodFrom: cycle.from, periodTo: cycle.to, beforeTo, beforeDays,
    daysFromJoining: r2(wd - beforeDays), lopDays: r2(unpaid - beforeDays), paidDays: r2(Math.max(0, wd - unpaid)),
  };
}

// The loss-of-pay amount of such a record, shared between the two by their days (the two always add up to it).
function amountsOf(lopDeduction, split) {
  const total = r2(lopDeduction);
  const unpaid = r2(split.beforeDays + split.lopDays);
  const raw = unpaid > 0 ? (total * split.beforeDays) / unpaid : 0;
  const before = Number.isInteger(total) ? Math.round(raw) : r2(raw);
  return { beforeJoining: before, lop: r2(total - before) };
}

// -> async (month, record, dateOfJoining) => split | null. record = { workingDays, daysLop }. One per request: the settings are read once.
async function splitter() {
  const policy = await E.getPolicy();
  const months = new Map();
  return async (month, record, dateOfJoining) => {
    if (!dateOfJoining || !record) return null;
    if (!months.has(month)) {
      const cycle = await PC.cycleFor(month);
      months.set(month, { cycle, days: E.payrollWorkingDays(month, policy, cycle) });
    }
    const m = months.get(month);
    return splitOf({ workingDays: record.workingDays, daysLop: record.daysLop, dateOfJoining }, m.cycle, policy, m.days);
  };
}

module.exports = { splitOf, amountsOf, splitter };
