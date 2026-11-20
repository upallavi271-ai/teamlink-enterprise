// ---------------------------------------------------------------------------
// WORKING DAYS FOR ATS DUE DATES AND ESCALATION (Extra 762). The HRMS holiday calendar (Holiday) and the weekly-off days (HrConfig.weeklyOffDays,
// Sunday by default) decide what a working day is. Used only when the Admin switch "SLA counts working days only" is on (default OFF); with it off
// every function here counts calendar days exactly as before. A synchronous snapshot, refreshed whenever nextAction refreshes its own.
// ---------------------------------------------------------------------------
const prisma = require('../../db');
const core = require('./core');

let HOLIDAYS = new Set();
let OFFS = new Set([0]);
let AT = 0;

async function refresh({ maxAgeMs = 60000 } = {}) {
  const s = await core.load();
  if (!s.sla.workingDaysOnly && !s.sla.businessHoursOnly) return s;
  if (Date.now() - AT < maxAgeMs) return s;
  const [hol, cfg] = await Promise.all([
    prisma.holiday.findMany({ select: { date: true } }).catch(() => []),
    prisma.hrConfig.findFirst({ select: { weeklyOffDays: true } }).catch(() => null),
  ]);
  HOLIDAYS = new Set(hol.map((h) => String(h.date).slice(0, 10)));
  OFFS = new Set(String((cfg && cfg.weeklyOffDays) ?? '0').split(',').map((v) => Number(v.trim())).filter(Number.isFinite));
  AT = Date.now();
  return s;
}
// for tests / the settings save: take the snapshot from given values
function seed({ holidays, offs } = {}) { if (holidays) HOLIDAYS = new Set(holidays); if (offs) OFFS = new Set(offs); AT = Date.now(); }

const dow = (day) => new Date(`${day}T00:00:00Z`).getUTCDay();
const plus = (day, n) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isWorkingDay = (day) => !OFFS.has(dow(day)) && !HOLIDAYS.has(day);
const on = () => !!core.now().sla.workingDaysOnly;

// day + n WORKING days (n >= 0). The start day itself need not be a working day.
function addWorkingDays(day, n) {
  let d = day; let left = Math.max(0, Math.round(n));
  let guard = 0;
  while (left > 0 && guard < 3700) { d = plus(d, 1); guard += 1; if (isWorkingDay(d)) left -= 1; }
  return d;
}
// the working days after `from` up to and including `to` (0 when to <= from)
function workingDaysBetween(from, to) {
  if (!(to > from)) return 0;
  let n = 0; let d = from; let guard = 0;
  while (d < to && guard < 3700) { d = plus(d, 1); guard += 1; if (isWorkingDay(d)) n += 1; }
  return n;
}
// A due date: day + n days, in working days when the switch is on.
const dueAfter = (day, n) => (on() ? addWorkingDays(day, n) : plus(day, n));
// How late: calendar days normally, working days when the switch is on.
const daysLate = (due, today) => (on() ? workingDaysBetween(due, today) : Math.round((new Date(`${today}T00:00:00Z`) - new Date(`${due}T00:00:00Z`)) / 86400000));
// Hours between two moments that fall inside business hours on working days (IST), when the business-hours switch is on; plain hours otherwise.
function elapsedHours(fromMs, toMs) {
  const s = core.now().sla;
  if (!(toMs > fromMs)) return 0;
  if (!s.businessHoursOnly) return (toMs - fromMs) / 3600000;
  let total = 0;
  const IST = 330 * 60000;
  let cursor = fromMs; let guard = 0;
  while (cursor < toMs && guard < 5000) {
    guard += 1;
    const ist = new Date(cursor + IST);
    const day = ist.toISOString().slice(0, 10);
    const dayStart = new Date(`${day}T00:00:00+05:30`).getTime();
    const open = dayStart + s.startHour * 3600000; const close = dayStart + s.endHour * 3600000;
    if (isWorkingDay(day) || !s.workingDaysOnly) {
      const a = Math.max(cursor, open); const b = Math.min(toMs, close);
      if (b > a) total += (b - a) / 3600000;
    }
    cursor = dayStart + 86400000;
  }
  return total;
}

module.exports = { refresh, seed, isWorkingDay, addWorkingDays, workingDaysBetween, dueAfter, daysLate, elapsedHours, plus, on };
