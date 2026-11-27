// ---------------------------------------------------------------------------
// SOMEBODY WHO JOINED, OR CAME BACK, INSIDE THE PAY PERIOD (founder 2026-11-27: "Koushik joined 21 Oct: calculate from 21 Oct to 15 Nov,
// the days from 16 Oct must not come as LOP"; "Luhitha rejoined on the 9th: calculate from 9 Nov").
//
// The payroll record keeps ONE number of unpaid days (EmployeePayrollRun.daysLop) and the money is worked out from it
// (full-month pay x paid days / days in the pay period). For such a person that number holds two different things: the days before the
// start date (not employed) and real loss of pay. This file splits it for what people SEE, and says how many days before the start
// there are, so that nobody can type a number that would pay them (routes refuse it; the edit window counts LOP after the start).
//
// start = the joining date when it is inside the pay period, else the day after a rejoining gap (utils/rejoin.js) that covers the first
// day of the period and ends inside it.
//
// No split (the record shows as it always did) when: neither applies; the record's payroll days are not the pay period's days (typed as a
// part month); or the record deducts fewer days than there are before the start.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const D = require('./attendanceDays');
const E = require('./payrollEngine');
const PC = require('./payrollCycle');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const isoDay = (d) => {
  if (!d) return null;
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? null : x.toISOString().slice(0, 10);
};
const shift = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// -> { start, word: 'joining' | 'rejoining' } | null
function startInside(dateOfJoining, gaps, cycle) {
  const joined = isoDay(dateOfJoining);
  if (joined && joined > cycle.from && joined <= cycle.to) return { start: joined, word: 'joining' };
  const g = (gaps || []).find((x) => x.from <= cycle.from && x.to >= cycle.from && x.to < cycle.to);
  return g ? { start: shift(g.to, 1), word: 'rejoining' } : null;
}

// pure: cycle = { from, to }, periodDays = the pay period's payroll days
function splitOf({ workingDays, daysLop, dateOfJoining, gaps = null }, cycle, policy, periodDays) {
  if (!cycle) return null;
  const s = startInside(dateOfJoining, gaps, cycle);
  if (!s) return null;
  const wd = Number(workingDays) || 0;
  const unpaid = Number(daysLop) || 0;
  if (!(wd > 0) || Math.abs(wd - periodDays) > 0.001) return null;
  const offs = D.weeklyOffs(policy);
  const beforeTo = shift(s.start, -1);
  let beforeDays = 0;
  D.eachDay(cycle.from, beforeTo).forEach((d) => { if (policy.weekendsPaid || !offs.has(new Date(`${d}T00:00:00Z`).getUTCDay())) beforeDays += 1; });
  if (!beforeDays || unpaid + 0.001 < beforeDays) return null;
  return {
    joinedOn: s.start, word: s.word, periodFrom: cycle.from, periodTo: cycle.to, beforeTo, beforeDays,
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

// -> async (month, record, dateOfJoining) => split | null. record = { workingDays, daysLop, employeeId }. One per request: the settings
// are read once.
async function splitter() {
  const policy = await E.getPolicy();
  const months = new Map();
  const gapsOf = new Map();
  return async (month, record, dateOfJoining) => {
    if (!record) return null;
    if (!months.has(month)) {
      const cycle = await PC.cycleFor(month);
      months.set(month, { cycle, days: E.payrollWorkingDays(month, policy, cycle) });
    }
    const id = record.employeeId;
    if (id && !gapsOf.has(id)) gapsOf.set(id, (await D.rejoinGapsFor(prisma, [id])).get(id) || []);
    const m = months.get(month);
    return splitOf({ workingDays: record.workingDays, daysLop: record.daysLop, dateOfJoining, gaps: id ? gapsOf.get(id) : null }, m.cycle, policy, m.days);
  };
}

// The days before the start, whatever the record deducts today: what can never be typed away. -> split of an all-unpaid record | null
async function startOf(month, { workingDays, employeeId }, dateOfJoining, split = null) {
  const s = split || await splitter();
  return s(month, { workingDays, daysLop: workingDays, employeeId }, dateOfJoining);
}

// "N Vennela joined on 21 Oct: the 5 days before are not paid, ..." - why a smaller number is refused
function tooFew(name, start, unpaid) {
  if (!start || Number(unpaid) + 0.001 >= start.beforeDays) return null;
  const d = new Date(`${start.joinedOn}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `${name} ${start.word === 'rejoining' ? 'rejoined' : 'joined'} on ${d}: the ${start.beforeDays} day(s) before are not paid, so the unpaid days cannot be less than ${start.beforeDays}. Type only the loss of pay after that date.`;
}

module.exports = { splitOf, amountsOf, splitter, startOf, tooFew };
