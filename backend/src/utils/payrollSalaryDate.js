// ---------------------------------------------------------------------------
// SALARY CREDIT DATE (founder 2026-11-28): "whoever applies 2 or more leaves from 16 Nov gets the salary on 10 Dec; those who apply no
// such leave between 15 Nov and 30 Nov get it on 30 Nov" - the same for every payroll month.
//
// For payroll month M the WINDOW is the day after the pay period ends (16 M) to the last day of month M. Leave days APPLIED in the window
// are counted: approved or still waiting (rejected / cancelled do not count - founder's answer "Applied leave"), working days only (a week
// off or a holiday inside a leave is not counted), half a day for a half-day leave, one date never more than 1.
//   count >= leaveDays (2)  -> the lateDay (10th) of the next month
//   otherwise               -> the last day of month M
// Worked out live from the leave requests, so it can still change until the window closes. Nothing is stored on a payroll record and no
// amount changes. ON only where AppSetting 'payroll.salaryDates' {on, from:'YYYY-MM', leaveDays, lateDay} says so.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const D = require('./attendanceDays');
const PC = require('./payrollCycle');

const KEY = 'payroll.salaryDates';
const isMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));
const shift = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const lastDayOf = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); };
const dayOfNext = (m, day) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo, day)).toISOString().slice(0, 10); };
const todayIst = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

// the stored setting -> { from, leaveDays, lateDay } | null
function ruleFrom(value) {
  try {
    const v = JSON.parse(value);
    if (!v || !v.on || !isMonth(v.from)) return null;
    const leaveDays = Number(v.leaveDays) > 0 ? Number(v.leaveDays) : 2;
    const lateDay = Number(v.lateDay) >= 1 && Number(v.lateDay) <= 28 ? Math.floor(Number(v.lateDay)) : 10;
    return { from: v.from, leaveDays, lateDay };
  } catch { return null; }
}

// pure: leaves of ONE person -> { days, dates: [{ date, value, waiting }] }. isWorkDay(date) says which dates count.
function countLeave(leaves, window, isWorkDay) {
  const byDate = new Map();
  (leaves || []).forEach((l) => {
    if (/reject|cancel|withdraw/i.test(String(l.status || ''))) return;
    const all = D.eachDay(l.fromDate, l.toDate).filter(isWorkDay);
    if (!all.length) return;
    // "x.5" days: the last working day of the request is the half day
    const half = (Number(l.days) * 2) % 2 === 1 ? all[all.length - 1] : null;
    all.filter((d) => d >= window.from && d <= window.to).forEach((d) => {
      const had = byDate.get(d) || { date: d, value: 0, waiting: false };
      had.value = Math.min(1, had.value + (d === half ? 0.5 : 1));
      if (!/^approved/i.test(String(l.status || ''))) had.waiting = true;
      byDate.set(d, had);
    });
  });
  const dates = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  return { days: dates.reduce((n, x) => n + x.value, 0), dates };
}

// pure
const dateFor = (month, days, rule) => (days >= rule.leaveDays ? dayOfNext(month, rule.lateDay) : lastDayOf(month));

// -> null when the rule is off for the month, else
//    { rule, window: { from, to }, onTime: 'YYYY-MM-DD', late: 'YYYY-MM-DD', closed, of: Map(employeeId -> { date, late, leaveDays, dates }) }
async function forMonth(month, employeeIds) {
  if (!isMonth(month)) return null;
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } }).catch(() => null);
  const rule = row ? ruleFrom(row.value) : null;
  if (!rule || month < rule.from) return null;
  const cycle = await PC.cycleFor(month);
  const window = { from: shift(cycle.to, 1), to: lastDayOf(month) };
  const none = window.from > window.to; // a calendar-month payroll has no days left after it: everybody on the last day
  const policy = await require('./payrollEngine').getPolicy(); // eslint-disable-line global-require
  const offs = D.weeklyOffs(policy);
  const ids = [...new Set(employeeIds || [])];
  let leaves = [];
  let holidays = new Set();
  if (!none && ids.length) {
    const [l, h] = await Promise.all([
      prisma.leaveRequest.findMany({ where: { employeeId: { in: ids }, fromDate: { lte: window.to }, toDate: { gte: window.from } }, select: { employeeId: true, fromDate: true, toDate: true, days: true, status: true } }),
      prisma.holiday.findMany({ where: { date: { gte: shift(window.from, -40), lte: shift(window.to, 40) } }, select: { date: true } }),
    ]);
    leaves = l;
    holidays = new Set(h.map((x) => String(x.date).slice(0, 10)));
  }
  const isWorkDay = (d) => !offs.has(new Date(`${d}T00:00:00Z`).getUTCDay()) && !holidays.has(d);
  const by = new Map();
  leaves.forEach((l) => { if (!by.has(l.employeeId)) by.set(l.employeeId, []); by.get(l.employeeId).push(l); });
  const of = new Map();
  ids.forEach((id) => {
    const c = none ? { days: 0, dates: [] } : countLeave(by.get(id), window, isWorkDay);
    const date = dateFor(month, c.days, rule);
    of.set(id, { date, late: c.days >= rule.leaveDays, leaveDays: c.days, dates: c.dates });
  });
  return { rule, window, onTime: lastDayOf(month), late: dayOfNext(month, rule.lateDay), closed: todayIst() > window.to, of };
}

// the header the screens need (without the per-person map). `threshold` = how many leave days move the salary to the later date
// (never called leaveDays: that is each person's own count).
const summaryOf = (s) => (s ? { window: s.window, onTime: s.onTime, late: s.late, closed: s.closed, threshold: s.rule.leaveDays } : null);

module.exports = { KEY, ruleFrom, countLeave, dateFor, forMonth, summaryOf };
