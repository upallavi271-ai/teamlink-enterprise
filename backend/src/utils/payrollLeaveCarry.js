// ---------------------------------------------------------------------------
// CARRY-FORWARD LEAVE (founder 2026-11-25): "an employee who took no leave for 2 months has 2 leaves saved to take next month". Chosen with him:
//   * the saved leaves are the UNUSED monthly free leave day (HrConfig.paidLeaveDaysPerMonth, 1) of the earlier pay periods;
//   * they stay until 31 Dec and start again from zero in January (payroll month keys of one calendar year: Jan payroll resets);
//   * an approved leave beyond this period's free day is paid from the saved days first, and only then cut as LOP (payrollLeaveRule.js).
// Worked out, never stored: for each earlier pay period of the year (cycle-aware: utils/payrollCycle.js) the approved leave days the person took
// (utils/attendanceDays.js rows, the same ones payroll reads), starting with the period the person had joined by:
//     used <= free  ->  the unused part is saved          used > free  ->  the extra is paid from the saved days (as far as they go)
// Reads only. Results of one earlier pay period are kept for 5 minutes (one payroll run asks for many people and many months).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const D = require('./attendanceDays');
const PC = require('./payrollCycle');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pad = (n) => String(n).padStart(2, '0');
const cache = new Map();
const TTL_MS = 5 * 60 * 1000;

// Map(employeeId -> { used, onRoll, from, to }) for ONE earlier payroll month.
async function usedIn(employees, q, policy, settings) {
  const cycle = PC.cycleOf(q, settings.cycle);
  const out = new Map();
  const todo = [];
  const now = Date.now();
  employees.forEach((e) => {
    const c = cache.get(`${q}|${cycle.from}|${cycle.to}|${e.id}`);
    if (c && now - c.t < TTL_MS) out.set(e.id, c.v); else todo.push(e);
  });
  if (todo.length) {
    const { days } = await D.loadDays(prisma, { employees: todo, from: cycle.from, to: cycle.to, cfg: policy });
    todo.forEach((e) => {
      const rows = days(e);
      const used = r2(rows.filter((r) => r.counted).reduce((n, r) => n + (Number(r.leave) || 0), 0));
      const joined = e.dateOfJoining ? new Date(e.dateOfJoining).toISOString().slice(0, 10) : null;
      const v = { used, onRoll: !joined || joined <= cycle.to, from: cycle.from, to: cycle.to };
      cache.set(`${q}|${cycle.from}|${cycle.to}|${e.id}`, { t: now, v });
      out.set(e.id, v);
    });
  }
  return out;
}

// -> Map(employeeId -> { saved, months: [{ month, label, from, to, used, saved, covered }] }) : the days saved at the START of `month`.
async function carryIn(employees, month, policy, settings) {
  const free = Number(policy.paidLeaveDaysPerMonth || 0);
  const [y, m] = String(month).split('-').map(Number);
  const res = new Map(employees.map((e) => [e.id, { saved: 0, months: [] }]));
  for (let i = 1; i < m; i += 1) {
    const q = `${y}-${pad(i)}`;
    // eslint-disable-next-line no-await-in-loop
    const used = await usedIn(employees, q, policy, settings);
    employees.forEach((e) => {
      const u = used.get(e.id);
      const st = res.get(e.id);
      if (!u || !u.onRoll) return; // not yet with the company: no free day that month
      let saved = 0;
      let covered = 0;
      if (u.used <= free) saved = r2(free - u.used);
      else covered = Math.min(st.saved, r2(u.used - free));
      st.saved = r2(st.saved + saved - covered);
      st.months.push({ month: q, label: PC.cycleOf(q, settings.cycle).label, from: u.from, to: u.to, used: u.used, saved, covered });
    });
  }
  return res;
}

module.exports = { carryIn };
