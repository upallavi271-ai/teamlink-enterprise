// ---------------------------------------------------------------------------
// LEAVE DAYS THAT COUNT (founder, 2026-10-15): "when an employee applies for leave, the company festival
// dates are not counted, and Sundays are not counted."
//
// A request from 1 Oct to 5 Oct with 2 Oct a company holiday and 4 Oct a Sunday asks for 3 days, not 5.
//   * week off  = HrConfig.weeklyOffDays (Sunday only unless HR changed it; see attendanceDays.weeklyOffs)
//   * holiday   = every row of the company holiday calendar EXCEPT type 'Optional' (an optional holiday is a
//                 holiday only for whoever takes it, exactly as the attendance day rule reads it)
// Pure counting helpers + one loader. The sandwich rule (Leave Policy) is a separate, existing switch that
// decides what the approval charges when a day off sits between two leave days.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { weeklyOffs } = require('./attendanceDays');

const dayStr = (v) => String(v || '').slice(0, 10);
const validIso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const addDay = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dow = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Pure: which days of from..to count, and which are skipped (and why).
function countRange(from, to, { offs, holidays }) {
  const f = dayStr(from);
  const t = dayStr(to || from);
  if (!validIso(f) || !validIso(t) || t < f) return { calendarDays: 0, countedDays: 0, skipped: [] };
  const skipped = [];
  let counted = 0;
  let calendar = 0;
  for (let d = f; d <= t && calendar < 400; d = addDay(d, 1)) {
    calendar += 1;
    const name = holidays.get(d);
    if (name) skipped.push({ date: d, reason: `Company holiday: ${name}` });
    else if (offs.has(dow(d))) skipped.push({ date: d, reason: WEEKDAY[dow(d)] });
    else counted += 1;
  }
  return { calendarDays: calendar, countedDays: counted, skipped };
}

async function load(from, to) {
  const cfg = (await prisma.hrConfig.findFirst()) || {};
  const offs = weeklyOffs(cfg);
  const rows = await prisma.holiday.findMany({ where: { date: { gte: dayStr(from), lte: dayStr(to || from) } } });
  const holidays = new Map(rows.filter((h) => h.type !== 'Optional').map((h) => [dayStr(h.date), h.name]));
  return { offs, holidays };
}

async function countFor(from, to) {
  const ctx = await load(from, to);
  return countRange(from, to, ctx);
}

module.exports = { countRange, countFor, load };
