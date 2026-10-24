// ---------------------------------------------------------------------------
// EARLY LOGOUT CHECK (HRMS item 4, 2026-10-13).
//
// "When an employee applies for leave, check the previous working day's attendance for early
// logout. Display the logout date, time and duration, or indicate if no early logout was recorded.
// Show these details to authorized approvers."
//
// THE RULE IS THE APP'S OWN (utils/attendanceDays.js workOf()): a day is an early logout when the
// last check-out is before  closing time - earlyLogoutGraceMinutes  (Attendance policy: workEndTime,
// default 18:00, grace 0). Nothing here invents a threshold.
//
// PREVIOUS WORKING DAY: the day before the first leave date, skipping Sundays / weekly offs and
// company holidays; a day on which the person was on a full leave day is also skipped, looking back
// up to 7 days.
//
// OUTCOMES (state):
//   early        left before closing time           "left at 16:40 on 09 Oct 2026, 1 h 50 min before closing time (18:00)"
//   ok           worked to closing time or later     "No early logout recorded on Fri 09 Oct (left at 18:42)"
//   nocheckout   checked in, never checked out       "Checked in at 09:10 on Fri 09 Oct but no check-out was recorded"
//   none         nothing recorded                    "No attendance recorded on Fri 09 Oct"
//   leave        every day looked at was on leave    "On approved leave that day"
//   noday        no working day in the last 7 days   "No working day found in the 7 days before the leave"
//
// A SNAPSHOT is stored with the request when it is applied (AppSetting leave.early.<leaveId>), so a
// punch edited later never changes what the approver was shown; compute() is the live recompute.
// Visible to the applicant and to approvers only (the routes decide who).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const D = require('./attendanceDays');
const { toMinutes } = require('./attendanceMath');

const KEY = (id) => `leave.early.${id}`;
const LOOK_BACK = 7;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');
const addDays = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const label = (iso) => `${DAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()]} ${iso.slice(8, 10)} ${MON[Number(iso.slice(5, 7)) - 1]}`;
const longDate = (iso) => `${iso.slice(8, 10)} ${MON[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const hhmm = (m) => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
function durationText(mins) {
  const h = Math.floor(mins / 60); const m = mins % 60;
  if (h && m) return `${h} h ${m} min`;
  if (h) return `${h} h`;
  return `${m} min`;
}

// employee: Employee row. fromDate: first day of the leave (YYYY-MM-DD). leaveId (optional) is
// ignored for the day itself: the leave being applied for starts AFTER the day looked at.
async function compute(employee, fromDate, { cfg = null } = {}) {
  const first = String(fromDate).slice(0, 10);
  const conf = cfg || (await prisma.hrConfig.findFirst()) || {};
  const p = D.policyTimes(await require('./attendancePolicy').withExtras(conf)); // eslint-disable-line global-require
  const closing = p.end - p.earlyGrace;
  const from = addDays(first, -LOOK_BACK);
  const to = addDays(first, -1);
  const loaded = await D.loadDays(prisma, { employees: [employee], from, to, cfg: conf });
  const rows = loaded.days(employee).slice().sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first
  const rule = `Closing time ${hhmm(p.end)}${p.earlyGrace ? ` minus ${p.earlyGrace} min grace` : ''} (Attendance policy)`;
  let sawLeave = false;
  for (const row of rows) {
    if (['Holiday', 'Weekly Off', 'Not Joined', 'Left'].includes(row.status)) continue; // not a working day
    if (row.status === 'On Leave' && (row.leave || 0) + (row.unpaidLeave || 0) >= 1 && !row.checkIn && !row.checkOut) { sawLeave = true; continue; } // a full leave day: look further back
    const head = `Early logout check (previous working day ${label(row.date)}): `;
    const base = { date: row.date, dateLabel: label(row.date), closing: hhmm(p.end), rule, graceMinutes: p.earlyGrace };
    if (!row.checkIn && !row.checkOut) {
      return { ...base, state: 'none', text: `${head}No attendance recorded on ${label(row.date)}`, chip: null };
    }
    if (row.checkIn && !row.checkOut) {
      return { ...base, state: 'nocheckout', checkIn: row.checkIn, text: `${head}Checked in at ${String(row.checkIn).slice(0, 5)} on ${label(row.date)} but no check-out was recorded`, chip: null };
    }
    const co = toMinutes(String(row.checkOut).slice(0, 5));
    const coText = String(row.checkOut).slice(0, 5);
    // A half-day leave that covers the rest of that day is not an early logout.
    const halfCovered = !!row.leaveHalf && /Leave/.test(row.status || '');
    if (co != null && co < closing && !halfCovered) {
      const mins = closing - co;
      return { ...base, state: 'early', checkOut: coText, minutesEarly: mins, duration: durationText(mins), chip: `Early logout ${Math.floor(mins / 60) ? `${Math.floor(mins / 60)}h` : ''}${Math.floor(mins / 60) && mins % 60 ? ' ' : ''}${mins % 60 ? `${mins % 60}m` : ''}`,
        text: `${head}left at ${coText} on ${longDate(row.date)}, ${durationText(mins)} before closing time (${hhmm(p.end)})` };
    }
    return { ...base, state: 'ok', checkOut: coText, chip: null, text: `${head}No early logout recorded on ${label(row.date)} (left at ${coText})` };
  }
  if (sawLeave) return { state: 'leave', date: null, dateLabel: null, closing: hhmm(p.end), rule, chip: null, text: `Early logout check: On approved leave that day (the previous ${LOOK_BACK} days were leave or days off)` };
  return { state: 'noday', date: null, dateLabel: null, closing: hhmm(p.end), rule, chip: null, text: `Early logout check: No working day found in the ${LOOK_BACK} days before the leave` };
}

// Store the snapshot for a request (once; never overwritten unless force).
async function snapshot(leave, employee, { force = false } = {}) {
  const key = KEY(leave.id);
  if (!force) { const have = await prisma.appSetting.findUnique({ where: { key } }); if (have) return JSON.parse(have.value); }
  const result = await compute(employee, leave.fromDate);
  const value = JSON.stringify({ ...result, snapshotAt: new Date().toISOString() });
  await prisma.appSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
  return JSON.parse(value);
}
async function snapshotOf(leaveId) {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY(leaveId) } });
  try { return row ? JSON.parse(row.value) : null; } catch { return null; }
}
async function snapshotsOf(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    // eslint-disable-next-line no-await-in-loop
    const rows = await prisma.appSetting.findMany({ where: { key: { in: part.map(KEY) } } });
    rows.forEach((r) => { try { out.set(r.key.slice('leave.early.'.length), JSON.parse(r.value)); } catch { /* skip */ } });
  }
  return out;
}

module.exports = { compute, snapshot, snapshotOf, snapshotsOf, KEY, LOOK_BACK };
