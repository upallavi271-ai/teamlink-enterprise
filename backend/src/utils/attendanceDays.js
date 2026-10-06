// ---------------------------------------------------------------------------
// HRMS-24 §4 / §10 / §11 — ONE STATUS PER PERSON PER DAY, derived from facts.
//
// A day's status is computed from what actually happened — the punches (web,
// mobile AND biometric), the marked Attendance row, approved leave, holidays
// and weekly offs — never stored, so a late biometric upload or an approved
// regularization corrects the status the next time it is read. It is the same
// rule for everyone who has an employee record: a TL, STL, HR, Assistant
// Manager, Manager or Super Admin is judged exactly like an employee. There is
// no role anywhere in this file, on purpose.
//
// The statuses (one per day, so a month's counts add up to its working days):
//   Present, Late, Half Day, Absent, On Leave,
//   Missing Check-In  (checked out with no check-in, or — when the policy says
//                      so — a past working day with nothing at all),
//   Missing Check-Out (checked in, never checked out, day is over),
// and the uncounted ones: Holiday, Weekly Off, Checked In (today, still at
// work), Not Checked In (today, nothing yet), Not Joined (before joining).
//
// Payroll still reads the marked Attendance rows (utils/attendanceMath.js
// monthStats); nothing here writes, so pay is unaffected by reading a screen.
//
// 2026-10-05 (user): THE KPI RULE — classifyDay() below. Absent = no check-in
// and nobody told (no leave / request); left 5:00–6:00 PM = Early logout,
// before 5:00 PM = Half day (1st half), came at / after 1:30 PM = Half day
// (2nd half); Missing check-in / check-out listed for HR. Every day row also
// carries `kpi` (the one card it lands on) and `reason` (plain words). The
// old rule is kept verbatim for payroll until the user decides (classifyDay
// explains the switch: preview / attendanceRulesFrom).
// ---------------------------------------------------------------------------

const { toMinutes, isLate, sortedPunches, dayCheckIn, dayCheckOut, monthLabel } = require('./attendanceMath');
const { DEFAULTS: POLICY_DEFAULTS, withExtras } = require('./attendancePolicy');
const { parse: parseLeaveText } = require('./leaveText');

const hhmm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// HRMS changes items 1-4: Early Logout, the half-day sessions and the seven
// punch x leave cases add these (still one status per person per day):
//   Early Logout            worked the full-day hours but left before the end
//                           of the working day (a full paid day, flagged)
//   Half Day + Half Leave   worked one half, approved leave covers the other
//   Half Day, Under Review  worked one half, the leave is still waiting
//   Leave Under Review      nothing worked, the leave is still waiting
//   Half Leave + Absent     half-day leave approved, nothing worked
// Every day row also carries the fractions the 7-case table speaks in:
//   present / leave / absent (unpaid) / pending (decided by the approval),
// and `paid` = present + leave. Payroll and the leave balance read these.
const STATUS = {
  EARLY: 'Early Logout',
  HALF_HALF_LEAVE: 'Half Day + Half Leave',
  HALF_REVIEW: 'Half Day, Under Review',
  LEAVE_REVIEW: 'Leave Under Review',
  HALF_LEAVE_ABSENT: 'Half Leave + Absent',
  // KPI rules (user, 2026-10-05):
  //   Informed       no punch, but an attendance correction (regularization)
  //                  is waiting for the manager — they told someone, so the
  //                  day is NOT Absent
  //   No device data a past working day on which NOBODY in the company has a
  //                  punch, mark or import (the device / import has not sent
  //                  that day yet) — not shown as Absent
  INFORMED: 'Informed',
  NO_DATA: 'No device data',
};
const COUNTED = ['Present', 'Late', 'Half Day', 'Absent', 'On Leave', 'Missing Check-In', 'Missing Check-Out',
  STATUS.EARLY, STATUS.HALF_HALF_LEAVE, STATUS.HALF_REVIEW, STATUS.LEAVE_REVIEW, STATUS.HALF_LEAVE_ABSENT,
  STATUS.INFORMED, STATUS.NO_DATA];
const MISSING_RULES = ['Missing Check-In', 'Absent'];

// The four colours of the simple-UX rule, for every screen that shows a day.
//   green done · blue going on · orange waiting · red problem · '' = no colour
const COLOUR = {
  Present: 'green', 'On Leave': 'green', [STATUS.HALF_HALF_LEAVE]: 'green',
  Late: 'orange', [STATUS.EARLY]: 'orange', [STATUS.HALF_REVIEW]: 'orange', [STATUS.LEAVE_REVIEW]: 'orange', [STATUS.INFORMED]: 'orange',
  'Checked In': 'blue', 'Not Checked In': 'blue',
  Absent: 'red', 'Half Day': 'red', 'Missing Check-In': 'red', 'Missing Check-Out': 'red', [STATUS.HALF_LEAVE_ABSENT]: 'red',
};
const colourOf = (status) => COLOUR[status] || '';

// Local calendar date (YYYY-MM-DD) and clock (HH:MM). The server's own clock is
// the office clock; toISOString() would be UTC and put an early-morning punch
// on the previous day.
const pad = (n) => String(n).padStart(2, '0');
function localDate(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function localTime(d = new Date()) { return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }

function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)); }

// Every YYYY-MM-DD from `from` to `to`, inclusive.
function eachDay(from, to) {
  const out = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end && out.length < 400) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function monthRange(month) {
  const [y, m] = String(month).split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${pad(last)}` };
}

function weeklyOffs(cfg) {
  return new Set(String((cfg && cfg.weeklyOffDays) ?? '0,6').split(',').map((x) => Number(x.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6));
}

function hoursBetween(inTime, outTime) {
  const a = toMinutes(inTime);
  const b = toMinutes(outTime);
  if (a == null || b == null || b <= a) return null;
  return Number(((b - a) / 60).toFixed(2));
}

// The policy clock times (utils/attendancePolicy.js), with the spec defaults
// when a caller passes a bare HrConfig.
function policyTimes(cfg = {}) {
  const start = toMinutes(cfg.workStartTime) ?? toMinutes(POLICY_DEFAULTS.workStartTime);
  const end = toMinutes(cfg.workEndTime) ?? toMinutes(POLICY_DEFAULTS.workEndTime);
  let split = toMinutes(cfg.halfDaySplit) ?? toMinutes(POLICY_DEFAULTS.halfDaySplit);
  if (!(split > start && split < end)) split = Math.round((start + end) / 2);
  const g = toMinutes(cfg.graceTime);
  const lateGap = g != null && g >= start ? g - start : 0;
  const earlyGrace = Math.max(0, Number(cfg.earlyLogoutGraceMinutes ?? POLICY_DEFAULTS.earlyLogoutGraceMinutes) || 0);
  // Leaving from `early` (17:00) up to the end = Early Logout; before it = Half Day.
  let early = toMinutes(cfg.earlyLogoutFrom) ?? toMinutes(POLICY_DEFAULTS.earlyLogoutFrom);
  if (!(early >= split && early <= end)) early = Math.max(split, Math.min(end, early ?? end - 60));
  return { start, end, split, lateGap, earlyGrace, early };
}

// "13:30" -> "1:30 PM" — the words every reason line uses.
function clock(m) {
  if (m == null) return '';
  const h = Math.floor(m / 60) % 24;
  return `${h % 12 === 0 ? 12 : h % 12}:${pad(m % 60)} ${h >= 12 ? 'PM' : 'AM'}`;
}
const clockOfTime = (t) => clock(toMinutes(String(t || '').slice(0, 5)));
// In and out closer than this = one visit to the device (see newDayStatus).
const DOUBLE_PUNCH_MINUTES = 10;
const shortClock = (m) => clock(m).replace(/ (AM|PM)$/, '');

// HOW MUCH OF THE DAY WAS WORKED — a CLOCK rule (user, 2026-10-05), from the
// first check-in and the last check-out. Office hours 9:00–6:00; first half
// 9:00–1:30, second half 1:30–6:00 (all from the Attendance policy).
//   came at / after the split (1:30 PM)      Half day — 2nd half only
//   left before "early logout from" (5 PM)    Half day — 1st half only
//   left 5:00 PM (sharp) up to 6:00 PM        Early logout (a full day, flagged)
//   left at / after 6:00 PM                   full day (Late when the check-in
//                                             is after the grace time)
// Anyone who checked in AND out is never Absent. `short`: under the half-day
// hours (it still reads as a half day; with a leave it stays leave).
// late: checked in after the grace time — not counted on a 2nd-half-only
// day, which is already a half day.
function workOf(checkIn, checkOut, cfg = {}) {
  const p = policyTimes(cfg);
  const ci = toMinutes(checkIn);
  const co = toMinutes(checkOut);
  const hours = Number(((co - ci) / 60).toFixed(2));
  const halfMin = Number(cfg.halfDayHours ?? 4);
  const short = hours < halfMin;
  const secondOnly = ci >= p.split;
  const beforeEarly = co < p.early;
  const earlyLogout = co < p.end - p.earlyGrace;
  if (secondOnly) return { part: 0.5, hours, late: false, earlyLogout, session: 'Second half', short, ci, co };
  const late = isLate(checkIn, cfg.graceTime);
  if (beforeEarly) return { part: 0.5, hours, late, earlyLogout, session: 'First half', short, ci, co };
  return { part: 1, hours, late, earlyLogout, session: null, short: false, ci, co };
}

// The plain words for a half day: "Half day — worked 1st half (9:00–1:30), left 3:10 PM".
function halfWords(w, cfg) {
  const p = policyTimes(cfg);
  const hrs = w.short ? ` — only ${w.hours}h worked` : '';
  if (w.session === 'Second half') {
    return `Half day — 2nd half only (${shortClock(p.split)}–${shortClock(p.end)}), came ${clock(w.ci)}${w.co < p.early ? `, left ${clock(w.co)}` : ''}${hrs}`;
  }
  if (w.co < p.split) return `Half day — 1st half only, left ${clock(w.co)} (before ${clock(p.split)})${hrs}`;
  return `Half day — worked 1st half (${shortClock(p.start)}–${shortClock(p.split)}), left ${clock(w.co)}${hrs}`;
}

// A leave on the day, as loadDays() hands it in:
//   { id, type, half: 'First Half' | 'Second Half' | null, unpaid: bool }
// `leave` is APPROVED (or cancellation requested), `pendingLeave` is waiting.
// `onLeave: true` without a leave object is read as an approved full day.
//
// THE ONE RULE — classifyDay() (dayStatus is the same function). The summary
// cards, the lists, the Excel export, payroll and the employee's own
// attendance all read their day from here, so they can never disagree.
// `ctx` carries the policy plus what is known about the day:
//   record         the marked Attendance row for the day, or null
//   punches        that day's AttendancePunch rows (any method)
//   holiday        the Holiday row's name, or null
//   joined         YYYY-MM-DD the person joined, or null
//   regularization a correction request for the day still waiting, or null
//   noData         true when NOBODY in the company has anything recorded on
//                  this date (the device / import has not sent it yet)
//   now            HH:MM, the clock now (today's "Still in office" ends at
//                  the end of the working day)
// ABSENT (user, 2026-10-05) = no check-in AND nothing that says they told
// the manager (no approved / applied leave, no correction request) AND not a
// holiday / week off. Anyone who checked in and out is never Absent.
// The leave cases keep the 7-case table:
//   1 worked a half + half-day leave approved  Half Day + Half Leave  .5 / .5 / 0
//   2 worked a half + no leave                 Half Day               .5 / 0 / .5
//   3 worked a half + leave waiting            Half Day, Under Review .5 / pending .5
//   4 worked a half + full-day leave approved  Half Day + Half Leave  .5 / .5 / 0  (only .5 off the balance)
//   5 no punch + full-day leave approved       On Leave               0 / 1 / 0
//   6 no punch + leave waiting                 Leave Under Review     0 / pending 1
//   7 no punch + correction request waiting    Informed               0 / pending 1
//   8 no punch + nothing                       Absent                 0 / 0 / 1
// (present / leave / absent). An unpaid leave type (unit 'unpaid') puts its
// share in `absent`, because it is not a paid day.
function newDayStatus({
  date, record, punches = [], onLeave = false, leave = null, pendingLeave = null, holiday = null, joined = null, cfg, today, offs,
  regularization = null, noData = false, now = null,
}) {
  const ps = sortedPunches(punches);
  const fin = dayCheckIn(ps);
  const lout = dayCheckOut(ps);
  const checkIn = (fin && fin.time) || (record && record.checkIn) || null;
  let checkOut = (lout && lout.time) || (record && record.checkOut) || null;
  if (checkOut && checkIn && toMinutes(checkOut) != null && toMinutes(checkIn) != null && toMinutes(checkOut) <= toMinutes(checkIn)) {
    // An "out" earlier than the first "in" is not the end of this session.
    checkOut = null;
  }
  const hours = checkIn && checkOut ? hoursBetween(checkIn, checkOut) : null;
  const firstMethod = (fin || ps[0] || {}).method || null;
  const base = {
    date, checkIn, checkOut, hours, method: firstMethod, punches: ps.length, note: '',
    present: 0, leave: 0, absent: 0, pending: 0, earlyLogout: false, session: null, leaveId: null, leaveHalf: null,
  };
  const late = !!checkIn && isLate(checkIn, cfg.graceTime);
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  const weeklyOff = (offs || weeklyOffs(cfg)).has(dow);
  const marked = record ? record.status : null;
  const approved = leave || (onLeave || marked === 'Leave' || marked === 'On Leave' ? { id: null, type: null, half: null, unpaid: false } : null);
  const p = policyTimes(cfg);
  const out = (status, extra = {}) => {
    const row = { ...base, status, ...extra };
    row.paid = row.present + row.leave;
    row.colour = colourOf(status);
    row.kpi = kpiOf(row);
    row.reason = row.reason || reasonOf(row, cfg, { leave: approved, pendingLeave });
    return row;
  };
  // The leave share of a day goes to `leave`, or to `absent` for an unpaid type.
  const leaveShare = (lv, n) => (lv && lv.unpaid ? { leave: 0, absent: n, unpaidLeave: n } : { leave: n });
  const leaveTag = (lv) => (lv ? { leaveId: lv.id || null, leaveHalf: lv.half || null } : {});

  if (joined && date < joined) return out('Not Joined', { counted: false });
  if (date > today) return out('Upcoming', { counted: false });

  const worked = !!(checkIn || checkOut);
  if (!worked) {
    // A holiday / weekly off with nothing worked stays a day off here; a day
    // off BETWEEN two leave days becomes leave in loadDays() (sandwich rule).
    if (holiday) return out('Holiday', { note: holiday, counted: false });
    if (weeklyOff) return out('Weekly Off', { counted: false });
    if (approved && !approved.half) return out('On Leave', { counted: true, ...leaveShare(approved, 1), ...leaveTag(approved) });
    if (approved && approved.half) {
      return out(STATUS.HALF_LEAVE_ABSENT, { counted: true, ...leaveShare(approved, 0.5), absent: 0.5 + (approved.unpaid ? 0.5 : 0), ...leaveTag(approved), note: `${approved.half} leave, the other half not worked` });
    }
    if (pendingLeave && date !== today) {
      const n = pendingLeave.half ? 0.5 : 1;
      return out(STATUS.LEAVE_REVIEW, { counted: true, pending: n, absent: 1 - n, note: 'Leave is waiting for approval', pendingLeaveId: pendingLeave.id || null });
    }
    // Hand-marked by HR without times (Present / Late / Absent / Half Day /
    // WFH) is honoured as marked.
    if (marked) {
      const status = marked === 'WFH' ? 'Present' : marked;
      const fr = status === 'Absent' ? { absent: 1 } : status === 'Half Day' ? { present: 0.5, absent: 0.5 } : COUNTED.includes(status) ? { present: 1 } : {};
      return out(status, { note: marked === 'WFH' ? 'WFH' : 'Marked by HR', counted: COUNTED.includes(status), ...fr });
    }
    if (date === today) return out('Not Checked In', { counted: false });
    // They told someone: an attendance correction is waiting. Unpaid until
    // it is approved (as a missing day always was), but not Absent.
    if (regularization) return out(STATUS.INFORMED, { counted: true, pending: 1, note: 'Attendance correction is waiting for approval', regularizationId: regularization.id || null });
    // Nobody in the company has anything on this date: the device / import
    // has not sent it. Not shown as Absent; unpaid until the data arrives
    // (exactly as the old "Missing Check-In" no-record day was).
    if (noData) return out(STATUS.NO_DATA, { counted: true, noRecord: true, absent: 1, note: 'Nothing has come from the device for this date yet' });
    // noRecord: nothing at all was recorded for the day (no punch, no mark,
    // no leave, no request) — the user's definition of Absent.
    return out('Absent', { note: 'No check-in, no leave or request', counted: true, noRecord: true, absent: 1 });
  }
  // A check-in and a check-out minutes apart (e.g. 9:09 / 9:10) is one visit
  // to the device with the wrong key pressed, not a worked half day: it reads
  // as ONE punch — a missing check-out for HR to fix.
  const doublePunch = !!(checkIn && checkOut && toMinutes(checkOut) - toMinutes(checkIn) < DOUBLE_PUNCH_MINUTES);
  // A punch is missing. A full-day leave still covers the day; a half-day
  // leave covers its half.
  if (!checkIn || !checkOut || doublePunch) {
    if (approved && !approved.half) return out('On Leave', { counted: true, ...leaveShare(approved, 1), ...leaveTag(approved), note: 'A punch was recorded on a leave day' });
    const half = approved && approved.half ? { ...leaveShare(approved, 0.5), ...leaveTag(approved) } : {};
    if (!checkIn) return out('Missing Check-In', { note: 'Checked out without a check-in', counted: true, ...half });
    // Today, before the end of the working day: still in the office.
    if (date === today && !(now && toMinutes(now) != null && toMinutes(now) >= p.end)) return out('Checked In', { late, counted: false, ...half });
    const dbl = doublePunch ? { doublePunch: true, reason: `Missing check-out — check-in ${clockOfTime(checkIn)} and check-out ${clockOfTime(checkOut)} only minutes apart (wrong key?)` } : {};
    return out('Missing Check-Out', { late, note: 'Checked in, never checked out', counted: true, present: approved && approved.half ? 0.5 : 1, ...half, ...dbl });
  }
  const w = workOf(checkIn, checkOut, cfg);
  // A marked Half Day / Absent is HR's decision and stands.
  if (marked === 'Half Day' && !approved && !pendingLeave) return out('Half Day', { late: w.late, session: w.session, note: 'Marked by HR', counted: true, present: 0.5, absent: 0.5 });
  if (marked === 'Absent' && !approved && !pendingLeave) return out('Absent', { late, note: 'Marked by HR', counted: true, absent: 1 });

  // Leaving early is not an Early Logout when a leave (approved or applied
  // for) covers the rest of the day.
  const flags = { late: w.late, earlyLogout: w.earlyLogout && !(w.part < 1 && (approved || pendingLeave)), session: w.session };
  if (w.part === 1) {
    const note = approved ? 'Worked the full day on a leave day — no leave taken' : (w.earlyLogout ? `Checked out at ${checkOut}, before ${hhmm(p.end)}` : '');
    return out(w.earlyLogout ? STATUS.EARLY : (w.late ? 'Late' : 'Present'), { ...flags, counted: true, present: 1, note });
  }
  const worked1 = halfWords(w, cfg);
  // A very short day with a leave stays leave (the punch was a visit).
  if (w.short && approved && !approved.half) return out('On Leave', { ...flags, counted: true, ...leaveShare(approved, 1), ...leaveTag(approved), note: `${worked1}; leave covers the day` });
  if (w.short && approved && approved.half) return out(STATUS.HALF_LEAVE_ABSENT, { ...flags, counted: true, ...leaveShare(approved, 0.5), absent: 0.5 + (approved.unpaid ? 0.5 : 0), ...leaveTag(approved), note: worked1 });
  if (w.short && pendingLeave && !pendingLeave.half) return out(STATUS.LEAVE_REVIEW, { ...flags, counted: true, pending: 1, pendingLeaveId: pendingLeave.id || null, note: `${worked1}; leave is waiting for approval` });
  // Cases 1 and 4: approved leave (half or full day) covers the other half.
  if (approved) return out(STATUS.HALF_HALF_LEAVE, { ...flags, counted: true, present: 0.5, ...leaveShare(approved, 0.5), ...leaveTag(approved), note: `${worked1}; leave covers the other half` });
  // Case 3: the leave is still waiting — decided when it is approved / rejected.
  if (pendingLeave) return out(STATUS.HALF_REVIEW, { ...flags, counted: true, present: 0.5, pending: 0.5, pendingLeaveId: pendingLeave.id || null, note: `${worked1}; leave is waiting for approval` });
  // Case 2.
  return out('Half Day', { ...flags, counted: true, present: 0.5, absent: 0.5, note: worked1 });
}
// THE OLD RULE (before 2026-10-05), kept VERBATIM: the hours rule (full day
// = fullDayHours, half day = halfDayHours or a complete session) and the
// policy's missing check-in rule. Payroll and the leave balance read it until
// the user decides how pay follows the new rule (see classifyDay below).
function legacyWorkOf(checkIn, checkOut, cfg = {}) {
  const p = policyTimes(cfg);
  const ci = toMinutes(checkIn);
  const co = toMinutes(checkOut);
  const hours = Number(((co - ci) / 60).toFixed(2));
  const late = isLate(checkIn, cfg.graceTime);
  const earlyLogout = co < p.end - p.earlyGrace;
  const halfMin = Number(cfg.halfDayHours ?? 4);
  const fullMin = Number(cfg.fullDayHours ?? 8);
  const s1 = ci <= p.start + p.lateGap && co >= p.split;
  const s2 = ci <= p.split + p.lateGap && co >= p.end - p.earlyGrace;
  const overlap = (a, b) => Math.max(0, Math.min(co, b) - Math.max(ci, a));
  const session = s1 && !s2 ? 'First half' : s2 && !s1 ? 'Second half'
    : (overlap(p.start, p.split) >= overlap(p.split, p.end) ? 'First half' : 'Second half');
  if (hours >= fullMin || (s1 && s2)) return { part: 1, hours, late, earlyLogout, session: null };
  const halfOk = cfg.halfDayBySession ? (s1 || s2) : (hours >= halfMin || s1 || s2);
  if (halfOk) return { part: 0.5, hours, late, earlyLogout, session };
  return { part: 0, hours, late, earlyLogout, session: null, under: halfMin };
}
function legacyDayStatus({
  date, record, punches = [], onLeave = false, leave = null, pendingLeave = null, holiday = null, joined = null, cfg, today, offs,
}) {
  const ps = sortedPunches(punches);
  const fin = dayCheckIn(ps);
  const lout = dayCheckOut(ps);
  const checkIn = (fin && fin.time) || (record && record.checkIn) || null;
  let checkOut = (lout && lout.time) || (record && record.checkOut) || null;
  if (checkOut && checkIn && toMinutes(checkOut) != null && toMinutes(checkIn) != null && toMinutes(checkOut) <= toMinutes(checkIn)) {
    // An "out" earlier than the first "in" is not the end of this session.
    checkOut = null;
  }
  const hours = checkIn && checkOut ? hoursBetween(checkIn, checkOut) : null;
  const firstMethod = (fin || ps[0] || {}).method || null;
  const base = {
    date, checkIn, checkOut, hours, method: firstMethod, punches: ps.length, note: '',
    present: 0, leave: 0, absent: 0, pending: 0, earlyLogout: false, session: null, leaveId: null, leaveHalf: null,
  };
  const late = !!checkIn && isLate(checkIn, cfg.graceTime);
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  const weeklyOff = (offs || weeklyOffs(cfg)).has(dow);
  const marked = record ? record.status : null;
  const approved = leave || (onLeave || marked === 'Leave' || marked === 'On Leave' ? { id: null, type: null, half: null, unpaid: false } : null);
  const out = (status, extra = {}) => {
    const row = { ...base, status, ...extra };
    row.paid = row.present + row.leave;
    row.colour = colourOf(status);
    return row;
  };
  // The leave share of a day goes to `leave`, or to `absent` for an unpaid type.
  const leaveShare = (lv, n) => (lv && lv.unpaid ? { leave: 0, absent: n, unpaidLeave: n } : { leave: n });
  const leaveTag = (lv) => (lv ? { leaveId: lv.id || null, leaveHalf: lv.half || null } : {});

  if (joined && date < joined) return out('Not Joined', { counted: false });
  if (date > today) return out('Upcoming', { counted: false });

  const worked = !!(checkIn || checkOut);
  if (!worked) {
    // A holiday / weekly off with nothing worked stays a day off here; a day
    // off BETWEEN two leave days becomes leave in loadDays() (sandwich rule).
    if (holiday) return out('Holiday', { note: holiday, counted: false });
    if (weeklyOff) return out('Weekly Off', { counted: false });
    if (approved && !approved.half) return out('On Leave', { counted: true, ...leaveShare(approved, 1), ...leaveTag(approved) });
    if (approved && approved.half) {
      return out(STATUS.HALF_LEAVE_ABSENT, { counted: true, ...leaveShare(approved, 0.5), absent: 0.5 + (approved.unpaid ? 0.5 : 0), ...leaveTag(approved), note: `${approved.half} leave, the other half not worked` });
    }
    if (pendingLeave && date !== today) {
      const n = pendingLeave.half ? 0.5 : 1;
      return out(STATUS.LEAVE_REVIEW, { counted: true, pending: n, absent: 1 - n, note: 'Leave is waiting for approval', pendingLeaveId: pendingLeave.id || null });
    }
    // Hand-marked by HR without times (Present / Late / Absent / Half Day /
    // WFH) is honoured as marked.
    if (marked) {
      const status = marked === 'WFH' ? 'Present' : marked;
      const fr = status === 'Absent' ? { absent: 1 } : status === 'Half Day' ? { present: 0.5, absent: 0.5 } : COUNTED.includes(status) ? { present: 1 } : {};
      return out(status, { note: marked === 'WFH' ? 'WFH' : 'Marked by HR', counted: COUNTED.includes(status), ...fr });
    }
    if (date === today) return out('Not Checked In', { counted: false });
    const rule = MISSING_RULES.includes(cfg.missingCheckInRule) ? cfg.missingCheckInRule : 'Missing Check-In';
    // noRecord: nothing at all was recorded for the day (no punch, no mark, no
    // leave) — the status comes from the policy rule, not from a punch.
    return out(rule, { note: 'No check-in recorded', counted: true, noRecord: true, ...(rule === 'Absent' ? { absent: 1 } : {}) });
  }
  // A punch is missing. A full-day leave still covers the day; a half-day
  // leave covers its half.
  if (!checkIn || !checkOut) {
    if (approved && !approved.half) return out('On Leave', { counted: true, ...leaveShare(approved, 1), ...leaveTag(approved), note: 'A punch was recorded on a leave day' });
    const half = approved && approved.half ? { ...leaveShare(approved, 0.5), ...leaveTag(approved) } : {};
    if (!checkIn) return out('Missing Check-In', { note: 'Checked out without a check-in', counted: true, ...half });
    if (date === today) return out('Checked In', { late, counted: false, ...half });
    return out('Missing Check-Out', { late, note: 'Checked in, never checked out', counted: true, present: approved && approved.half ? 0.5 : 1, ...half });
  }
  // A marked Half Day / Absent is HR's decision and stands.
  if (marked === 'Half Day' && !approved && !pendingLeave) return out('Half Day', { late, note: 'Marked by HR', counted: true, present: 0.5, absent: 0.5 });
  if (marked === 'Absent' && !approved && !pendingLeave) return out('Absent', { late, note: 'Marked by HR', counted: true, absent: 1 });

  const w = legacyWorkOf(checkIn, checkOut, cfg);
  // Leaving early is not an Early Logout when a leave (approved or applied
  // for) covers the rest of the day.
  const flags = { late: w.late, earlyLogout: w.earlyLogout && !(w.part < 1 && (approved || pendingLeave)), session: w.session };
  if (w.part === 1) {
    const note = approved ? 'Worked the full day on a leave day — no leave taken' : (w.earlyLogout ? `Checked out at ${checkOut}, before ${hhmm(policyTimes(cfg).end)}` : '');
    return out(w.earlyLogout ? STATUS.EARLY : (w.late ? 'Late' : 'Present'), { ...flags, counted: true, present: 1, note });
  }
  if (w.part === 0.5) {
    const worked = `Worked the ${w.session.toLowerCase()} (${hours}h)`;
    // Cases 1 and 4: approved leave (half or full day) covers the other half.
    if (approved) return out(STATUS.HALF_HALF_LEAVE, { ...flags, counted: true, present: 0.5, ...leaveShare(approved, 0.5), ...leaveTag(approved), note: `${worked}; leave covers the other half` });
    // Case 3: the leave is still waiting — decided when it is approved / rejected.
    if (pendingLeave) return out(STATUS.HALF_REVIEW, { ...flags, counted: true, present: 0.5, pending: 0.5, pendingLeaveId: pendingLeave.id || null, note: `${worked}; leave is waiting for approval` });
    // Case 2.
    return out('Half Day', { ...flags, counted: true, present: 0.5, absent: 0.5, note: worked });
  }
  // Case 7: under the half-day minimum. Leave covers the day if there is one.
  const under = `Worked ${hours}h, under the ${w.under}h half-day minimum`;
  if (approved && !approved.half) return out('On Leave', { ...flags, counted: true, ...leaveShare(approved, 1), ...leaveTag(approved), note: under });
  if (approved && approved.half) return out(STATUS.HALF_LEAVE_ABSENT, { ...flags, counted: true, ...leaveShare(approved, 0.5), absent: 0.5 + (approved.unpaid ? 0.5 : 0), ...leaveTag(approved), note: under });
  if (pendingLeave) {
    const n = pendingLeave.half ? 0.5 : 1;
    return out(STATUS.LEAVE_REVIEW, { ...flags, counted: true, pending: n, absent: 1 - n, pendingLeaveId: pendingLeave.id || null, note: `${under}; leave is waiting for approval` });
  }
  return out('Absent', { ...flags, counted: true, absent: 1, note: under });
}
// WHICH RULE A DAY USES — one place, so a day never has two answers:
//   * the policy's "New attendance rules from" date (attendanceRulesFrom,
//     utils/attendancePolicy.js) is set: days ON / AFTER it use the new
//     rule, days before it the old one — for every reader, screens and
//     payroll alike;
//   * not set: the KPI screens (loadDays({ preview: true })) show the new
//     rule, while payroll and the leave balance keep the old one.
function usesNewRule(ctx) {
  const from = ctx.cfg && ctx.cfg.attendanceRulesFrom;
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(String(from))) return ctx.date >= from;
  return !!ctx.preview;
}
function classifyDay(ctx) {
  const useNew = usesNewRule(ctx);
  const row = useNew ? newDayStatus(ctx) : legacyDayStatus(ctx);
  row.rule = useNew ? 'new' : 'old';
  if (row.kpi === undefined) row.kpi = kpiOf(row);
  if (!row.reason) row.reason = reasonOf(row, ctx.cfg, { leave: ctx.leave, pendingLeave: ctx.pendingLeave });
  // Came in on a week off / holiday: the day counts as worked (Present etc.)
  // and carries a tag, so it is never hidden inside 'Week off'. A tag only —
  // nothing it pays changes here.
  if (row.counted !== false || row.status === 'Checked In') {
    const dow = new Date(`${ctx.date}T00:00:00Z`).getUTCDay();
    const off = ctx.holiday ? `holiday (${ctx.holiday})` : ((ctx.offs || weeklyOffs(ctx.cfg)).has(dow) ? 'week off' : null);
    if (off && (row.checkIn || row.checkOut)) {
      row.workedOnOff = off;
      row.reason = `${row.reason} — worked on a ${off}`;
    }
  }
  return row;
}
const dayStatus = classifyDay;

// THE KPI CARD a day lands on — exactly one per counted day, so every card's
// number is the length of its list. null = not a working day for that person
// (holiday, week off, before joining, after leaving, a future date).
//   present          Present / Late (a full day, incl. marked Present / WFH)
//   earlyLogout      left between 5:00 PM and 6:00 PM
//   halfDay          one half worked (1st / 2nd: row.session)
//   absent           no check-in and nobody was told
//   onLeave          approved leave, leave waiting (pending), or Informed
//   missingCheckIn   a check-out with no check-in
//   missingCheckOut  a check-in with no check-out (a past day)
//   inOffice         today, checked in, before 6:00 PM
//   notYet           today, nothing yet
//   noData           nothing from the device for anyone that day
// "Late" is a FLAG on top (row.late), its own card listing those days.
const KPI_OF_STATUS = {
  Present: 'present', Late: 'present',
  [STATUS.EARLY]: 'earlyLogout',
  'Half Day': 'halfDay', [STATUS.HALF_HALF_LEAVE]: 'halfDay', [STATUS.HALF_REVIEW]: 'halfDay',
  Absent: 'absent',
  'On Leave': 'onLeave', [STATUS.HALF_LEAVE_ABSENT]: 'onLeave', [STATUS.LEAVE_REVIEW]: 'onLeave', [STATUS.INFORMED]: 'onLeave',
  'Missing Check-In': 'missingCheckIn',
  'Missing Check-Out': 'missingCheckOut',
  'Checked In': 'inOffice',
  // Week off / holiday with nothing worked: not a working day for them, but
  // still a card, so the cards add up to the headcount (user, 2026-10-05).
  Holiday: 'offDay', 'Weekly Off': 'offDay',
  'Not Checked In': 'notYet',
  [STATUS.NO_DATA]: 'noData',
};
const KPI_KEYS = ['present', 'absent', 'halfDay', 'earlyLogout', 'late', 'missingCheckIn', 'missingCheckOut', 'onLeave', 'inOffice', 'notYet', 'noData', 'offDay'];
const KPI_LABEL = {
  present: 'Present', absent: 'Absent', halfDay: 'Half day', earlyLogout: 'Early logout', late: 'Late',
  missingCheckIn: 'Missing check-in', missingCheckOut: 'Missing check-out', onLeave: 'On leave',
  inOffice: 'Still in office', notYet: 'Not in yet', noData: 'No device data', offDay: 'Week off / Holiday',
};
function kpiOf(row) {
  if (!row) return null;
  if (row.status === 'Missing Check-In' && row.noRecord) return 'absent'; // older callers' rule
  return KPI_OF_STATUS[row.status] || null;
}
// The On leave card's three kinds.
function leaveKindOf(row) {
  if (!row || row.kpi !== 'onLeave') return null;
  if (row.status === STATUS.INFORMED) return 'informed';
  if (row.status === STATUS.LEAVE_REVIEW) return 'pending';
  return 'approved';
}
// Late is counted only on days they came to work.
const isLateDay = (row) => !!(row && row.late && ['present', 'earlyLogout', 'halfDay', 'missingCheckOut', 'inOffice'].includes(row.kpi));

// The plain reason a list shows — "Half day — worked 1st half (9:00–1:30), left 3:10 PM".
function reasonOf(row, cfg = {}, { leave = null, pendingLeave = null } = {}) {
  const p = policyTimes(cfg);
  const ci = row.checkIn ? clockOfTime(row.checkIn) : '';
  const co = row.checkOut ? clockOfTime(row.checkOut) : '';
  const lateBit = row.late && ci ? `, came late ${ci}` : '';
  const lv = (l) => (l && l.type ? l.type : 'Leave');
  switch (row.status) {
    case 'Present': return row.note === 'WFH' ? 'Present — work from home' : (ci ? `Present — ${ci} to ${co}` : 'Present — marked by HR');
    case 'Late': return ci ? `Late — came ${ci} (after ${clockOfTime(cfg.graceTime) || 'the grace time'}), left ${co}` : 'Late — marked by HR';
    case STATUS.EARLY: return `Early logout — left ${co} (before ${clock(p.end)})${lateBit}`;
    case 'Half Day': case STATUS.HALF_HALF_LEAVE: case STATUS.HALF_REVIEW:
      if (!ci || !co) return 'Half day — marked by HR';
      if (row.rule === 'old') return `Half day — ${row.note || `${ci} to ${co}`} (old rule)`;
      if (row.note === 'Marked by HR') return `Half day — marked by HR (${ci} to ${co})`;
      return `${halfWords(workOf(row.checkIn, row.checkOut, cfg), cfg)}${row.status === STATUS.HALF_HALF_LEAVE ? '; leave covers the other half' : row.status === STATUS.HALF_REVIEW ? '; leave is waiting for approval' : ''}`;
    case 'Absent': if (/^Worked /.test(row.note || '')) return `Absent — ${row.note.charAt(0).toLowerCase()}${row.note.slice(1)} (old rule)`;
      return row.note === 'Marked by HR' ? 'Absent — marked by HR' : 'Absent — no check-in, no leave or request, did not inform';
    case 'On Leave': return row.sandwich ? row.note : `On leave — ${lv(leave)} (approved)${row.punches ? ', a punch was also recorded' : ''}`;
    case STATUS.HALF_LEAVE_ABSENT: return `${row.leaveHalf || 'Half-day'} leave (approved); the other half not worked`;
    case STATUS.LEAVE_REVIEW: return `Leave (pending) — ${lv(pendingLeave)} waiting for approval`;
    case STATUS.INFORMED: return 'Informed — asked for an attendance correction (waiting for approval)';
    case 'Missing Check-In': if (row.noRecord) return 'Absent — no check-in, no leave or request (old rule called it "No record")';
      return co ? `Missing check-in — only a check-out at ${co}` : 'Missing check-in';
    case 'Missing Check-Out': return ci ? `Missing check-out — only a check-in at ${ci}` : 'Missing check-out';
    case 'Checked In': return `Still in office — came ${ci}`;
    case 'Not Checked In': return 'Not in yet today';
    case STATUS.NO_DATA: return 'No device data for this date yet — not counted as Absent';
    case 'Holiday': return `Holiday — ${row.note || ''}`.trim();
    case 'Weekly Off': return 'Week off';
    default: return row.note || row.status || '';
  }
}

// Everything dayStatus() needs for a set of employees over a range, in four
// queries. Returns { cfg, today, days(employee) -> [day rows] }.
//   lastDayOf (optional, from rollOf()) — for a person who has LEFT, the last
//   day they were on the rolls; every later day reads 'Left' (not counted).
//   The SANDWICH RULE (item 6, Leave Policy on/off): a holiday / weekly off
//   run with full-day leave on the working day before AND after it reads as
//   On Leave too, charged to the later leave. To see the neighbours of a run
//   at the edge of the range, the range is read SANDWICH_PAD days wider and
//   cut back at the end.
const SANDWICH_PAD = 10;
const OFF_STATUSES = ['Holiday', 'Weekly Off'];
const shiftDay = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
//   asOf (optional) — read the days as if today were this date. The leave
//   balance (utils/leaveCharge.js) uses it to see a leave planned for later
//   days as taken; every screen leaves it out.
//   preview (optional) — the KPI screens: show the new rule even before the
//   policy's attendanceRulesFrom date is set (classifyDay). Payroll and the
//   leave balance leave it out.
async function loadDays(prisma, { employees, from: wantFrom, to: wantTo, cfg: rawCfg, lastDayOf = null, asOf = null, preview = false }) {
  const cfg = await withExtras(rawCfg);
  const sandwich = cfg.sandwichLeave !== false;
  const from = sandwich ? shiftDay(wantFrom, -SANDWICH_PAD) : wantFrom;
  const to = sandwich ? shiftDay(wantTo, SANDWICH_PAD) : wantTo;
  const ids = employees.map((e) => e.id);
  const [records, punches, leaves, holidays, regs, imported, leaveTypes, ...dataDays] = await Promise.all([
    prisma.attendance.findMany({ where: { employeeId: { in: ids }, date: { gte: from, lte: to } } }),
    prisma.attendancePunch.findMany({ where: { employeeId: { in: ids }, date: { gte: from, lte: to } } }),
    prisma.leaveRequest.findMany({
      // Approved leave covers the day; Pending leave makes it "Under Review".
      where: { employeeId: { in: ids }, status: { in: ['Approved', 'Cancellation Requested', 'Pending'] }, fromDate: { lte: to }, toDate: { gte: from } },
      select: { id: true, employeeId: true, fromDate: true, toDate: true, type: true, status: true, reason: true, days: true },
    }),
    prisma.holiday.findMany({ where: { date: { gte: from, lte: to } } }),
    prisma.attendanceRegularization.findMany({
      where: { employeeId: { in: ids }, date: { gte: from, lte: to } },
      select: { id: true, employeeId: true, date: true, status: true, createdAt: true }, orderBy: { createdAt: 'desc' },
    }),
    // Imported old-HRMS days with punch times but no first check-in in the
    // report (e.g. today's log exported before the report was): read below.
    prisma.attendanceHistory.findMany({
      where: { employeeId: { in: ids }, date: { gte: from, lte: to }, punchTimes: { not: null } },
      select: { employeeId: true, date: true, punchTimes: true },
    }),
    prisma.leaveType.findMany({ select: { name: true, unit: true } }),
    // The dates on which ANYONE in the company has a punch, a mark or an
    // imported day: a past working day outside them is 'No device data', not
    // Absent (the device / import has not sent that day yet).
    ...[prisma.attendancePunch, prisma.attendance, prisma.attendanceHistory].map((m) => m.groupBy({ by: ['date'], where: { date: { gte: from, lte: to } } })),
  ]);
  const withData = new Set(dataDays.flat().map((g) => g.date));
  const key = (id, d) => `${id}|${d}`;
  const recordOf = new Map(records.map((r) => [key(r.employeeId, r.date), r]));
  const punchesOf = new Map();
  punches.forEach((p) => { const k = key(p.employeeId, p.date); if (!punchesOf.has(k)) punchesOf.set(k, []); punchesOf.get(k).push(p); });
  // An OPTIONAL holiday is a holiday only for whoever takes it, so it is not
  // a day off for everyone: those dates stay working days here.
  const holidayOf = new Map(holidays.filter((h) => h.type !== 'Optional').map((h) => [String(h.date).slice(0, 10), h.name]));
  const logOf = new Map(imported.map((h) => [key(h.employeeId, h.date), h.punchTimes]));
  const regOf = new Map();
  const regRowOf = new Map();
  regs.forEach((r) => { const k = key(r.employeeId, r.date); if (!regOf.has(k)) { regOf.set(k, r.status); regRowOf.set(k, r); } });
  const unpaidTypes = new Set(leaveTypes.filter((t) => t.unit === 'unpaid').map((t) => t.name));
  const leaveRows = leaves.map((l) => ({
    ...l, from: String(l.fromDate).slice(0, 10), to: String(l.toDate).slice(0, 10),
    half: parseLeaveText(l.reason).halfDay, unpaid: unpaidTypes.has(l.type),
  }));
  const covering = (id, d, pending) => leaveRows.find((l) => l.employeeId === id && l.from <= d && l.to >= d && (l.status === 'Pending') === pending) || null;
  const leaveOf = (id, d) => covering(id, d, false);
  const pendingOf = (id, d) => covering(id, d, true);
  const today = asOf || localDate();
  const now = asOf ? null : localTime();
  const offs = weeklyOffs(cfg);
  const range = eachDay(from, to);

  function days(employee) {
    const joined = employee.dateOfJoining ? new Date(employee.dateOfJoining).toISOString().slice(0, 10) : null;
    const left = lastDayOf && lastDayOf.has(employee.id);
    const lastDay = left ? lastDayOf.get(employee.id) : null;
    const rows = range.map((d) => {
      if (left && (!lastDay || d > lastDay)) {
        return { date: d, status: 'Left', counted: false, checkIn: null, checkOut: null, hours: null, method: null, punches: 0, note: 'No longer on the rolls', present: 0, leave: 0, absent: 0, pending: 0, paid: 0, colour: '' };
      }
      const k = key(employee.id, d);
      let ps = punchesOf.get(k) || [];
      // DERIVED ONLY: a day with nothing stored but an imported punch log
      // reads its first log time as the check-in (no check-out is ever
      // inferred). Nothing is written.
      if (!ps.length && !recordOf.has(k) && logOf.has(k)) {
        const first = logOf.get(k).split('|').filter(Boolean).sort()[0];
        if (first) ps = [{ time: first.slice(0, 5), clockTime: first, direction: 'In', method: 'Imported log', source: 'PulseHRM import', imputed: true }];
      }
      const leave = leaveOf(employee.id, d);
      const pend = leave ? null : pendingOf(employee.id, d);
      const row = dayStatus({
        date: d, record: recordOf.get(k) || null, punches: ps,
        leave: leave ? { id: leave.id, type: leave.type, half: leave.half, unpaid: leave.unpaid } : null,
        pendingLeave: pend ? { id: pend.id, type: pend.type, half: pend.half } : null,
        holiday: holidayOf.get(d) || null, joined, cfg, today, offs, now, preview,
        // The latest correction request for the day, when it is still waiting.
        regularization: regRowOf.has(k) && regRowOf.get(k).status === 'Pending' ? regRowOf.get(k) : null,
        noData: !withData.has(d),
      });
      if (leave && row.status === 'On Leave' && !row.note) row.note = `${leave.type} leave`;
      if (leave) row.leaveType = leave.type;
      // Location status of the day's first check-in (web/mobile), for §10.
      const fin = dayCheckIn(ps);
      row.locationStatus = fin ? (fin.locationStatus || (fin.location ? 'Captured' : fin.method === 'Biometric' ? 'Device' : 'Not captured')) : null;
      row.verification = fin ? (fin.verificationStatus || null) : null;
      row.regularization = regOf.get(k) || null;
      return row;
    });
    if (sandwich) applySandwich(rows);
    return sandwich ? rows.filter((r) => r.date >= wantFrom && r.date <= wantTo) : rows;
  }
  return { today, days, cfg };
}

// Off days between two full leave days become leave (in place).
function applySandwich(rows) {
  const isFullLeave = (r) => r && r.status === 'On Leave' && (r.leave + (r.unpaidLeave || 0)) >= 1;
  let i = 0;
  while (i < rows.length) {
    if (!OFF_STATUSES.includes(rows[i].status)) { i += 1; continue; }
    let j = i;
    while (j + 1 < rows.length && OFF_STATUSES.includes(rows[j + 1].status)) j += 1;
    const before = rows[i - 1];
    const after = rows[j + 1];
    if (isFullLeave(before) && isFullLeave(after)) {
      const unpaid = !!after.unpaidLeave;
      for (let k = i; k <= j; k += 1) {
        const r = rows[k];
        const was = r.status === 'Holiday' ? `holiday (${r.note || 'Holiday'})` : 'weekly off';
        Object.assign(r, {
          status: 'On Leave', counted: true, sandwich: true, colour: colourOf('On Leave'),
          leave: unpaid ? 0 : 1, absent: unpaid ? 1 : 0, unpaidLeave: unpaid ? 1 : 0, paid: unpaid ? 0 : 1,
          leaveId: after.leaveId || null, leaveType: after.leaveType || null,
          note: `Sandwich leave: ${was} between two leave days`,
          kpi: 'onLeave', reason: `On leave — sandwich: ${was} between two leave days`,
        });
      }
    }
    i = j + 1;
  }
}

// §11 — the month's counts for one employee, from their day rows.
function summarise(dayRows) {
  const c = {
    workingDays: 0, present: 0, absent: 0, late: 0, halfDay: 0, onLeave: 0, missingCheckIn: 0, missingCheckOut: 0, holidays: 0, weeklyOffs: 0, lateArrivals: 0, noRecord: 0,
    // Items 2-4: the new day statuses, and the day FRACTIONS of the 7-case
    // table summed over the period (what payroll and the balance read).
    earlyLogout: 0, earlyLogouts: 0, halfDayHalfLeave: 0, halfDayUnderReview: 0, leaveUnderReview: 0, halfLeaveAbsent: 0, sandwichDays: 0,
    presentDays: 0, leaveDays: 0, absentDays: 0, pendingDays: 0, paidDays: 0, unpaidLeaveDays: 0,
    informed: 0, noData: 0,
    // The KPI cards (kpiOf) — the same counts the Attendance report shows.
    kpi: Object.fromEntries(KPI_KEYS.map((k) => [k, 0])), halfFirst: 0, halfSecond: 0,
  };
  const add = (k, v) => { c[k] = Math.round((c[k] + (Number(v) || 0)) * 100) / 100; };
  dayRows.forEach((d) => {
    if (d.earlyLogout) c.earlyLogouts += 1;
    if (d.sandwich) c.sandwichDays += 1;
    // noRecord is a SUBSET of missingCheckIn (or of absent, per the policy):
    // the working days on which nothing at all was recorded.
    if (d.noRecord) c.noRecord += 1;
    if (d.status === 'Holiday') c.holidays += 1;
    if (d.status === 'Weekly Off') c.weeklyOffs += 1;
    if (d.late) c.lateArrivals += 1;
    const kpi = d.kpi === undefined ? kpiOf(d) : d.kpi;
    if (kpi) c.kpi[kpi] += 1;
    if (isLateDay({ ...d, kpi })) c.kpi.late += 1;
    if (kpi === 'halfDay' && d.session === 'First half') c.halfFirst += 1;
    if (kpi === 'halfDay' && d.session === 'Second half') c.halfSecond += 1;
    if (!d.counted) return;
    c.workingDays += 1;
    add('presentDays', d.present); add('leaveDays', d.leave); add('absentDays', d.absent);
    add('pendingDays', d.pending); add('paidDays', d.paid); add('unpaidLeaveDays', d.unpaidLeave);
    if (d.status === 'Present') c.present += 1;
    else if (d.status === STATUS.EARLY) c.earlyLogout += 1;
    else if (d.status === STATUS.HALF_HALF_LEAVE) c.halfDayHalfLeave += 1;
    else if (d.status === STATUS.HALF_REVIEW) c.halfDayUnderReview += 1;
    else if (d.status === STATUS.LEAVE_REVIEW) c.leaveUnderReview += 1;
    else if (d.status === STATUS.HALF_LEAVE_ABSENT) c.halfLeaveAbsent += 1;
    else if (d.status === 'Late') c.late += 1;
    else if (d.status === 'Half Day') c.halfDay += 1;
    else if (d.status === 'Absent') c.absent += 1;
    else if (d.status === 'On Leave') c.onLeave += 1;
    else if (d.status === 'Missing Check-In') c.missingCheckIn += 1;
    else if (d.status === 'Missing Check-Out') c.missingCheckOut += 1;
    else if (d.status === STATUS.INFORMED) c.informed += 1;
    else if (d.status === STATUS.NO_DATA) c.noData += 1;
  });
  return c;
}

// A new punch keeps the day's marked row in step, so the punch log and the
// daily marking sheet never disagree: the first check-in creates the row
// (Present, or Late against the grace clock time), a check-out stamps the
// latest check-out.
async function applyPunchToDay(prisma, punch, cfg) {
  const where = { employeeId_date: { employeeId: punch.employeeId, date: punch.date } };
  const existing = await prisma.attendance.findUnique({ where });
  if (punch.direction === 'In') {
    if (!existing) {
      await prisma.attendance.create({
        data: { employeeId: punch.employeeId, date: punch.date, status: isLate(punch.time, cfg.graceTime) ? 'Late' : 'Present', checkIn: punch.time },
      });
    } else if (!existing.checkIn) {
      await prisma.attendance.update({ where: { id: existing.id }, data: { checkIn: punch.time } });
    }
  } else if (existing) {
    await prisma.attendance.update({ where: { id: existing.id }, data: { checkOut: punch.time } });
  }
}

// ---------------------------------------------------------------------------
// HEADCOUNT — WHO IS ON THE ROLLS ON A DAY. Every attendance KPI counts
// PEOPLE out of this roster, so a day's buckets always add up to it.
//
//   * Super Admin (a system account) is never in it — the callers pass
//     employees already filtered by utils/systemAccounts.js.
//   * Not before the date of joining.
//   * A person who has LEFT (Relieved / Exited) is on the rolls up to their
//     last recorded attendance day (Attendance, punch or imported history) —
//     the Employee record carries no relieving date, so their own last day of
//     attendance is the honest one. Someone who left with no attendance on
//     file at all (the older leavers) is never in the roster.
//   * Everyone else (Active, On Probation, Notice Period, Exit Process…) is
//     on the rolls every day from joining.
// ---------------------------------------------------------------------------
const LEFT_EMPLOYMENT = ['Relieved', 'Exited'];

//   * Attendance recorded BEFORE the date of joining (a DOJ typed later than
//     the person actually started) is not thrown away: the roster starts on
//     the earlier of the DOJ and the first recorded attendance day. With no
//     DOJ on file it starts on the first recorded attendance day.
const joinedOn = (e) => (e && e.dateOfJoining ? new Date(e.dateOfJoining).toISOString().slice(0, 10) : null);

// { employees, lastDayOf, earlyStarts }
//   employees   the same people, with dateOfJoining moved back to the first
//               recorded attendance day where that is earlier (copies — the
//               records themselves are never changed)
//   lastDayOf   employeeId -> last day on the rolls (YYYY-MM-DD, or null =
//               none) for the people who have left; anyone not in it is
//               still on the rolls
//   earlyStarts the people whose attendance starts before their DOJ
async function rollOf(prisma, employees) {
  const ids = employees.map((e) => e.id);
  const left = new Set(employees.filter((e) => LEFT_EMPLOYMENT.includes(e.employmentStatus)).map((e) => e.id));
  const lastDayOf = new Map([...left].map((id) => [id, null]));
  const firstDayOf = new Map();
  if (ids.length) {
    const where = { employeeId: { in: ids } };
    const agg = { _max: { date: true }, _min: { date: true } };
    const groups = await Promise.all([
      prisma.attendance.groupBy({ by: ['employeeId'], where, ...agg }),
      prisma.attendancePunch.groupBy({ by: ['employeeId'], where, ...agg }),
      prisma.attendanceHistory.groupBy({ by: ['employeeId'], where, ...agg }),
    ]);
    groups.flat().forEach((g) => {
      const max = g._max && g._max.date;
      const min = g._min && g._min.date;
      if (left.has(g.employeeId) && max) {
        const cur = lastDayOf.get(g.employeeId);
        if (!cur || max > cur) lastDayOf.set(g.employeeId, max);
      }
      if (min && (!firstDayOf.has(g.employeeId) || min < firstDayOf.get(g.employeeId))) firstDayOf.set(g.employeeId, min);
    });
  }
  const earlyStarts = [];
  const adjusted = employees.map((e) => {
    const doj = joinedOn(e);
    const first = firstDayOf.get(e.id);
    // No DOJ on file: the first recorded attendance day is the best start we
    // have (with neither, the person is on the rolls throughout).
    if (!doj) return first ? { ...e, dateOfJoining: new Date(`${first}T00:00:00.000Z`) } : e;
    if (!first || first >= doj) return e;
    earlyStarts.push({ employeeId: e.id, employeeCode: e.employeeCode, name: e.name, dateOfJoining: doj, firstAttendance: first });
    return { ...e, dateOfJoining: new Date(`${first}T00:00:00.000Z`) };
  });
  return { employees: adjusted, lastDayOf, earlyStarts };
}

// On the rolls on at least one day of [from, to].
function onRolls(e, from, to, lastDayOf) {
  const j = joinedOn(e);
  if (j && j > to) return false;
  if (lastDayOf && lastDayOf.has(e.id)) {
    const last = lastDayOf.get(e.id);
    if (!last || last < from) return false;
  }
  return true;
}

// The ONE mapping from a day status to a headcount bucket. Exactly one bucket
// per person per day, so the buckets of a day add up to that day's headcount.
//   present   came to work: Present, Late, Checked In (today, still in),
//             Missing Check-Out (checked in, never pressed check-out) and a
//             check-out with no check-in (they were there — a punch is missing)
//   halfDay   Half Day (worked under the full-day hours, or marked)
//   absent    Absent (marked, worked under the half-day minimum, or — when the
//             policy says so — a past working day with nothing recorded)
//   onLeave   approved leave / marked leave
//   offDay    weekly off or holiday, nothing worked
//   noRecord  a past working day with nothing recorded (policy: Missing Check-In)
//   notYet    today, no punch yet
//   upcoming  a future date
const BUCKETS = ['present', 'halfDay', 'absent', 'onLeave', 'offDay', 'noRecord', 'notYet', 'upcoming'];
const BUCKET_LABEL = {
  present: 'Present', halfDay: 'Half Day', absent: 'Absent', onLeave: 'On Leave',
  // noRecord: with the new rule only "No device data" days land here (a
  // working day with nothing recorded for the person is Absent).
  offDay: 'Week-off / Holiday', noRecord: 'No device data', notYet: 'Not checked in yet', upcoming: 'Upcoming',
};
function bucketOf(d) {
  switch (d && d.status) {
    case 'Present': case 'Late': case 'Checked In': case 'Missing Check-Out': case STATUS.EARLY: return 'present';
    case STATUS.HALF_HALF_LEAVE: case STATUS.HALF_REVIEW: return 'halfDay';
    // Applied for leave / asked for a correction = they told someone: not Absent.
    case STATUS.LEAVE_REVIEW: case STATUS.INFORMED: return 'onLeave';
    case STATUS.HALF_LEAVE_ABSENT: return 'onLeave';
    case STATUS.NO_DATA: return 'noRecord';
    case 'Missing Check-In': return d.noRecord ? 'noRecord' : 'present';
    case 'Half Day': return 'halfDay';
    case 'Absent': return 'absent';
    case 'On Leave': return 'onLeave';
    case 'Holiday': case 'Weekly Off': return 'offDay';
    case 'Not Checked In': return 'notYet';
    case 'Upcoming': return 'upcoming';
    default: return null; // Not Joined / Left — not on the rolls that day
  }
}

// People counts for ONE day from that day's rows (one row per person).
// headcount = sum of the buckets. The rest are subsets, for information.
function tally(dayRows) {
  const c = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  c.headcount = 0;
  c.late = 0; c.missingCheckIn = 0; c.missingCheckOut = 0; c.checkedIn = 0; c.checkedOut = 0; c.punched = 0; c.biometric = 0;
  c.earlyLogout = 0; c.underReview = 0;
  dayRows.forEach((d) => {
    const b = bucketOf(d);
    if (!b) return;
    c.headcount += 1;
    c[b] += 1;
    if (d.late || d.status === 'Late') c.late += 1;
    if (d.status === 'Missing Check-Out') c.missingCheckOut += 1;
    if (d.earlyLogout) c.earlyLogout += 1;
    if (d.status === STATUS.HALF_REVIEW || d.status === STATUS.LEAVE_REVIEW) c.underReview += 1;
    if (d.status === 'Missing Check-In' && !d.noRecord) c.missingCheckIn += 1;
    if (d.checkIn) c.checkedIn += 1;
    if (d.checkOut) c.checkedOut += 1;
    if (d.punches) c.punched += 1;
    if (d.method === 'Biometric') c.biometric += 1;
  });
  return c;
}

module.exports = {
  applyPunchToDay,
  LEFT_EMPLOYMENT, rollOf, joinedOn, onRolls, BUCKETS, BUCKET_LABEL, bucketOf, tally,
  COUNTED, MISSING_RULES, STATUS, COLOUR, colourOf, workOf, policyTimes, applySandwich,
  localDate, localTime, isDate, eachDay, monthRange, weeklyOffs, hoursBetween,
  dayStatus, loadDays, summarise, monthLabel,
  classifyDay, kpiOf, leaveKindOf, isLateDay, reasonOf, KPI_KEYS, KPI_LABEL, clock,
};
