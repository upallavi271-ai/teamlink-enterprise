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
const { halfOf: leaveHalfOf } = require('./leaveText');
const LP = require('./latePermission'); // late coming requests: Approved / Pending / Rejected / Not explained
const PC = require('./payrollCycle'); // payroll cycle + the absent-without-leave rule
const ANL = require('./absentNoLeave');
const PS = require('./punchSources'); // where each punch came from (Web / Biometric / Pulse / HR)

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

// WEEK OFF = SUNDAY ONLY (user, 2026-10-09: Saturday is a working day). The
// configured HrConfig.weeklyOffDays decides (day numbers, 0 = Sunday); when it
// is missing the answer is '0' - never '0,6'.
function weeklyOffs(cfg) {
  return new Set(String((cfg && cfg.weeklyOffDays) ?? '0').split(',').map((x) => Number(x.trim()))
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
  // times the Super Admin (or HR, when allowed) set in Marked attendance stand over the punches (2026-10-26)
  const setByHr = !!(record && record.timesSetBy);
  const checkIn = (setByHr && record.checkIn) || (fin && fin.time) || (record && record.checkIn) || null;
  let checkOut = (setByHr && record.checkOut) || (lout && lout.time) || (record && record.checkOut) || null;
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
    // A LEAVE APPLIED IS A LEAVE DAY, approved or still waiting - today too (founder 2026-10-26: "leave ani apply chesthe approve
    // ayina kaakapoyina leave ane count"), never "Not in yet" with a punch prompt.
    if (pendingLeave) {
      const n = pendingLeave.half ? 0.5 : 1;
      // A half-day request that is still waiting counts as a Half day (pendingHalf) - the leave state chip says "Pending approval".
      return out(STATUS.LEAVE_REVIEW, { counted: true, pending: n, absent: 1 - n, note: 'Leave is waiting for approval', pendingLeaveId: pendingLeave.id || null, ...(pendingLeave.half ? { pendingHalf: true } : {}) });
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
    // A half-day leave that is still waiting (user 2026-10-09, Navitha 15 Sep): the person is ONE Half day
    // (half worked + half leave waiting, exactly like case 3), with the missing punch noted - never a whole
    // Present. No leave applied at all = just the missing punch (Present / Missing Check-In as before).
    const pendHalf = !approved && pendingLeave && pendingLeave.half ? { pendingHalf: true, pendingLeaveId: pendingLeave.id || null } : null;
    if (!checkIn) return out('Missing Check-In', { note: 'Checked out without a check-in', counted: true, ...half, ...(pendHalf ? { ...pendHalf, pending: 0.5 } : {}) });
    // Today, before the end of the working day: still in the office.
    if (date === today && !(now && toMinutes(now) != null && toMinutes(now) >= p.end)) return out('Checked In', { late, counted: false, ...half, ...(pendHalf || {}) });
    const dbl = doublePunch ? { doublePunch: true, reason: `Missing check-out — check-in ${clockOfTime(checkIn)} and check-out ${clockOfTime(checkOut)} only minutes apart (wrong key?)` } : {};
    return out('Missing Check-Out', { late, note: 'Checked in, never checked out', counted: true, present: (approved && approved.half) || pendHalf ? 0.5 : 1, ...half, ...(pendHalf ? { ...pendHalf, pending: 0.5 } : {}), ...dbl });
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
  // times the Super Admin (or HR, when allowed) set in Marked attendance stand over the punches (2026-10-26)
  const setByHr = !!(record && record.timesSetBy);
  const checkIn = (setByHr && record.checkIn) || (fin && fin.time) || (record && record.checkIn) || null;
  let checkOut = (setByHr && record.checkOut) || (lout && lout.time) || (record && record.checkOut) || null;
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
    // A LEAVE APPLIED IS A LEAVE DAY, approved or still waiting - today too (founder 2026-10-26: "leave ani apply chesthe approve
    // ayina kaakapoyina leave ane count"), never "Not in yet" with a punch prompt.
    if (pendingLeave) {
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
const isLateDay = (row) => !!(row && (row.late || row.lateExcused) && ['present', 'earlyLogout', 'halfDay', 'missingCheckOut', 'inOffice'].includes(row.kpi));

// The plain reason a list shows — "Half day — worked 1st half (9:00–1:30), left 3:10 PM".
function reasonOf(row, cfg = {}, { leave = null, pendingLeave = null } = {}) {
  const p = policyTimes(cfg);
  const ci = row.checkIn ? clockOfTime(row.checkIn) : '';
  const co = row.checkOut ? clockOfTime(row.checkOut) : '';
  const lateBit = row.late && ci ? `, came late ${ci}` : '';
  const lv = (l) => (l && l.type ? l.type : 'Leave');
  const by = (l) => (l && l.approvedBy ? ` by ${l.approvedBy}` : '');
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
    case 'On Leave': return row.sandwich ? row.note : `On leave — ${lv(leave)} (approved${by(leave)})${row.punches ? ', a punch was also recorded' : ''}`;
    case STATUS.HALF_LEAVE_ABSENT: return `${row.leaveHalf || 'Half-day'} leave (approved${by(leave)}); the other half not worked`;
    case STATUS.LEAVE_REVIEW: return `Leave (pending) — ${lv(pendingLeave)} waiting for approval${pendingLeave && pendingLeave.waitingFor ? ` from ${pendingLeave.waitingFor}` : ''}`;
    case STATUS.INFORMED: return 'Informed — asked for an attendance correction (waiting for approval)';
    case 'Missing Check-In': if (row.noRecord) return 'Absent — no check-in, no leave or request (old rule called it "No record")';
      return (co ? `Missing check-in — only a check-out at ${co}` : 'Missing check-in') + (row.leaveHalf ? '; half-day leave (approved) covers the other half' : '');
    case 'Missing Check-Out': return (ci ? `Missing check-out — only a check-in at ${ci}` : 'Missing check-out') + (row.leaveHalf ? '; half-day leave (approved) covers the other half' : row.pendingHalf ? '; half-day leave is waiting for approval' : '');
    case 'Checked In': return `Still in office — came ${ci}` + (row.leaveHalf ? '; half-day leave (approved) covers the other half' : '');
    case 'Not Checked In': return 'Not in yet today';
    case STATUS.NO_DATA: return 'No device data for this date yet — not counted as Absent';
    case 'Holiday': return `Holiday — ${row.note || ''}`.trim();
    case 'Weekly Off': return 'Week off';
    default: return row.note || row.status || '';
  }
}

// HOW A DAY WAS MARKED (HRMS spec 2026-10-09, point 2) — in the words the
// "How marked" column and filter use, from what the data really holds:
//   Biometric device · Face check-in · Web check-in · Mobile app ·
//   Entered by HR · Marked by HR (a mark with no punch) · Imported (old HRMS)
// It follows the FIRST check-in (the one that decides the day), else the first
// punch, else the marked row. '' = nothing was recorded for the day.
// CHECK-IN METHOD (user, 2026-10-09: "How marked" is the "Check-in method"). The six plain
// labels every attendance list uses, whatever the source:
//   Biometric (device) - the fingerprint / face device (AttendancePunch.method 'Biometric')
//   Web check-in       - the browser, GPS / location (source 'Web')
//   Mobile check-in    - the phone (source 'Mobile')
//   Face check-in      - the Face Recognition method (verified live capture)
//   Manual (HR)        - entered or marked by HR (source 'Manual entry', or a mark with no punch)
//   Imported           - the old HRMS / Excel import
const HOW = {
  BIOMETRIC: 'Biometric (device)', FACE: 'Face check-in', WEB: 'Web check-in', MOBILE: 'Mobile check-in',
  MANUAL: 'Manual (HR)', IMPORTED: 'Imported',
};
HOW.ENTERED = HOW.MANUAL; HOW.MARKED = HOW.MANUAL; // older names
const HOW_ORDER = [HOW.BIOMETRIC, HOW.WEB, HOW.MOBILE, HOW.FACE, HOW.MANUAL, HOW.IMPORTED];
// One punch -> one label.
function methodOfPunch(p) {
  if (!p) return '';
  const m = String(p.method || '');
  const src = String(p.source || '');
  // A punch the old HRMS exported from the fingerprint device keeps method 'Biometric' (the import
  // marks it so); everything else that came in by import is just 'Imported'.
  if (p.imputed || /import/i.test(m)) return HOW.IMPORTED;
  if (/manual/i.test(src)) return HOW.MANUAL;
  if (/biometric|finger/i.test(m) || p.deviceVerify != null) return HOW.BIOMETRIC;
  if (src === 'PulseHRM import') return HOW.IMPORTED;
  if (/face/i.test(m)) return HOW.FACE;
  if (/mobile/i.test(src)) return HOW.MOBILE;
  if (/web/i.test(src)) return HOW.WEB;
  if (/mobile|gps/i.test(m)) return /mobile/i.test(m) ? HOW.MOBILE : HOW.WEB;
  if (/web/i.test(m)) return HOW.WEB;
  return m || HOW.MANUAL;
}
// The method of the day's first check-in (what the lists filter by), else the first punch,
// else the marked row ('' = nothing recorded).
function howMarkedOf(ps, record, imputed) {
  const first = dayCheckIn(ps) || ps[0] || null;
  if (!first) return record ? HOW.MANUAL : '';
  return imputed ? HOW.IMPORTED : methodOfPunch(first);
}
// The method of the day's last check-out ('' = no check-out punch).
function howOutOf(ps) {
  const out = dayCheckOut(ps);
  return out ? methodOfPunch(out) : '';
}
// "Biometric (device)" or, when the check-out came another way, "In: Mobile check-in · Out: Biometric (device)".
function howTextOf(inLabel, outLabel) {
  if (inLabel && outLabel && inLabel !== outLabel) return `In: ${inLabel} · Out: ${outLabel}`;
  return inLabel || outLabel || '';
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
// Map(employeeId -> [{ from, to }]) for people who REJOINED (EmployeeRecord type REJOINING, status Done; the gap is kept in
// its notes JSON). Never throws: a failure just means no gap is applied.
async function rejoinGapsFor(prisma, ids) {
  const out = new Map();
  if (!ids || !ids.length) return out;
  try {
    const rows = await prisma.employeeRecord.findMany({ where: { type: 'REJOINING', status: 'Done', employeeId: { in: ids } }, select: { employeeId: true, notes: true } });
    rows.forEach((r) => {
      let n = null;
      try { n = JSON.parse(r.notes || 'null'); } catch { n = null; }
      const g = n && n.gap;
      if (g && /^\d{4}-\d{2}-\d{2}$/.test(g.from || '') && /^\d{4}-\d{2}-\d{2}$/.test(g.to || '') && g.from <= g.to) {
        if (!out.has(r.employeeId)) out.set(r.employeeId, []);
        out.get(r.employeeId).push({ from: g.from, to: g.to });
      }
    });
  } catch { /* no gaps */ }
  return out;
}
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
  // REJOINED PEOPLE (utils/rejoin.js): the days between the last working day of an earlier stint and the rejoining date
  // read 'Left' (not counted), so a person who came back is not shown absent for the months they were not with the company.
  const gapsOf = await rejoinGapsFor(prisma, ids);
  const [records, punches, leaves, holidays, regs, imported, leaveTypes, ...dataDays] = await Promise.all([
    prisma.attendance.findMany({ where: { employeeId: { in: ids }, date: { gte: from, lte: to } } }),
    prisma.attendancePunch.findMany({ where: { employeeId: { in: ids }, date: { gte: from, lte: to } } }),
    prisma.leaveRequest.findMany({
      // Approved leave covers the day; Pending leave makes it "Under Review".
      where: { employeeId: { in: ids }, status: { in: ['Approved', 'Cancellation Requested', 'Pending'] }, fromDate: { lte: to }, toDate: { gte: from } },
      select: { id: true, employeeId: true, fromDate: true, toDate: true, type: true, status: true, reason: true, days: true, decidedBy: true },
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
  // SUPER ADMIN (founder, 2026-10-15): "all days present for the Super Admin, and marking must still exist".
  // A Super Admin's working day reads Present whatever the device says. Real check-ins / HR marks still
  // work and still show their times; approved leave stays leave; holidays and week offs stay days off.
  const superIds = new Set();
  try {
    (await prisma.employee.findMany({ where: { id: { in: ids }, user: { role: 'SUPER_ADMIN' } }, select: { id: true } })).forEach((e) => superIds.add(e.id));
  } catch { /* no user link on an old database: nobody is auto-present */ }
  const SUPER_FIXABLE = new Set(['Absent', 'Not Checked In', 'Missing Check-In', 'Missing Check-Out', 'Half Day', 'Checked In', STATUS.NO_DATA, STATUS.INFORMED, STATUS.LEAVE_REVIEW, STATUS.HALF_REVIEW]);
  // Half-day requests that were REJECTED: only a note on the day (never a half day).
  const rejectedRows = await prisma.leaveRequest.findMany({
    where: { employeeId: { in: ids }, status: 'Rejected', fromDate: { lte: to }, toDate: { gte: from } },
    select: { employeeId: true, fromDate: true, toDate: true, reason: true, days: true },
  });
  const rejectedHalf = rejectedRows.filter((l) => leaveHalfOf(l)).map((l) => ({ employeeId: l.employeeId, fromDate: String(l.fromDate).slice(0, 10), toDate: String(l.toDate).slice(0, 10) }));
  // Any rejected request (full day too): still an APPLICATION, so the day is not "absent without leave".
  const rejectedAny = rejectedRows.map((l) => ({ employeeId: l.employeeId, fromDate: String(l.fromDate).slice(0, 10), toDate: String(l.toDate).slice(0, 10) }));
  // ABSENT WITHOUT APPLYING LEAVE (2026-10-12): the rule per payroll month, to tag the day.
  const pcSettings = await PC.getSettings();
  const awlRuleCache = new Map();
  const awlRuleOfDate = (d) => {
    if (!awlRuleCache.has(d)) { const m = PC.monthOfDate(d, pcSettings.cycle); // during the switch-over a date sits in two periods: the LATER (cycle) one decides the rule
      awlRuleCache.set(d, PC.absentRuleFor(m ? m.months[m.months.length - 1] : d.slice(0, 7), pcSettings.absent)); }
    return awlRuleCache.get(d);
  };
  const lateReq = await LP.loadFor(prisma, ids, from, to); // late-coming requests of the range (never throws)
  const lateGap = policyTimes(cfg).lateGap;
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
  // WHO APPROVED / WHO IS TO APPROVE (founder 2026-10-27: the On leave card says approved / pending; it must also say who approved):
  // an approved leave names its decider (LeaveRequest.decidedBy), a pending one the approver whose turn it is (its Pending chain step).
  const pendIds = leaves.filter((l) => l.status === 'Pending').map((l) => l.id);
  const waitingFor = new Map();
  if (pendIds.length) {
    const steps = await prisma.approvalStep.findMany({ where: { workflow: 'leave', recordId: { in: pendIds }, status: 'Pending' }, select: { recordId: true, approverName: true } }).catch(() => []);
    steps.forEach((s) => { if (!s.approverName) return; if (!waitingFor.has(s.recordId)) waitingFor.set(s.recordId, []); waitingFor.get(s.recordId).push(s.approverName); });
  }
  const leaveRows = leaves.map((l) => ({
    ...l, from: String(l.fromDate).slice(0, 10), to: String(l.toDate).slice(0, 10),
    // Half day = the form's marker OR a single date applied for 0.5 day (leaveText.halfOf).
    half: leaveHalfOf(l), unpaid: unpaidTypes.has(l.type),
    approvedBy: l.status !== 'Pending' ? (l.decidedBy || null) : null, waitingFor: waitingFor.has(l.id) ? waitingFor.get(l.id).join(' / ') : null,
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
    const gaps = gapsOf.get(employee.id) || null;
    const rows = range.map((d) => {
      if (left && (!lastDay || d > lastDay)) {
        return { date: d, status: 'Left', counted: false, checkIn: null, checkOut: null, hours: null, method: null, punches: 0, note: 'Left company', present: 0, leave: 0, absent: 0, pending: 0, paid: 0, colour: '' };
      }
      if (gaps && gaps.some((g) => d >= g.from && d <= g.to)) {
        return { date: d, status: 'Left', counted: false, checkIn: null, checkOut: null, hours: null, method: null, punches: 0, note: 'Not with the company (left, then rejoined)', present: 0, leave: 0, absent: 0, pending: 0, paid: 0, colour: '' };
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
        leave: leave ? { id: leave.id, type: leave.type, half: leave.half, unpaid: leave.unpaid, approvedBy: leave.approvedBy || null } : null,
        pendingLeave: pend ? { id: pend.id, type: pend.type, half: pend.half, waitingFor: pend.waitingFor || null } : null,
        holiday: holidayOf.get(d) || null, joined, cfg, today, offs, now, preview,
        // The latest correction request for the day, when it is still waiting.
        regularization: regRowOf.has(k) && regRowOf.get(k).status === 'Pending' ? regRowOf.get(k) : null,
        noData: !withData.has(d),
      });
      if (superIds.has(employee.id) && SUPER_FIXABLE.has(row.status) && !leave) {
        Object.assign(row, {
          status: 'Present', counted: true, present: 1, absent: 0, pending: 0, leave: 0, paid: 1, session: null, earlyLogout: false,
          colour: colourOf('Present'), note: 'Super Admin: present every working day', superAdminPresent: true,
        });
        delete row.pendingHalf; delete row.noRecord; delete row.pendingLeaveId; delete row.regularizationId;
        row.kpi = kpiOf(row);
        row.reason = 'Present — Super Admin (counted present on every working day)';
      }
      // A half-day request that was REJECTED is not a half day - the day reads as it would without it, with a note.
      if (rejectedHalf.some((l) => l.employeeId === employee.id && l.fromDate <= d && l.toDate >= d)) row.leaveRejected = true;
      // THE TAG: a working day absent with no leave applied reads "Absent: no leave applied: 2 LOP" (only from the rule's first payroll month).
      const awlRule = awlRuleOfDate(d);
      if (awlRule.active) {
        const kind = ANL.classify(row, { withData, rejected: rejectedAny.some((l) => l.employeeId === employee.id && l.fromDate <= d && l.toDate >= d) });
        if (kind) { row.awlKind = kind; row.awlText = ANL.tagText(awlRule, kind); row.awlLop = kind === 'full' ? awlRule.days : awlRule.halfDayDays; }
      }
      // LATE COMING: a late day carries the state of its request (Approved / Pending / Rejected / Not explained); an approved
      // one is excused under the new rule (utils/latePermission.js).
      LP.annotate(row, lateReq.get(k) || null, lateGap);
      row.how = howMarkedOf(ps, recordOf.get(k) || null, !!(ps[0] && ps[0].imputed));
      row.howOut = howOutOf(ps);
      row.howText = howTextOf(row.how, row.howOut);
      if (leave && row.status === 'On Leave' && !row.note) row.note = `${leave.type} leave`;
      if (leave) row.leaveType = leave.type;
      // Location status of the day's first check-in (web/mobile), for §10.
      const fin = dayCheckIn(ps);
      row.locationStatus = fin ? (fin.locationStatus || (fin.location ? 'Captured' : fin.method === 'Biometric' ? 'Device' : 'Not captured')) : null;
      row.verification = fin ? (fin.verificationStatus || null) : null;
      row.distanceM = fin && fin.distanceM != null ? Math.round(fin.distanceM) : null; // metres from the office at check-in
      row.regularization = regOf.get(k) || null;
      // EVERY raw punch of the day, all sources, with the one the day rule used (utils/punchSources.js; display only).
      row.punchList = PS.rawPunchList(ps, logOf.get(k) || null, !!(ps.find((p) => p.direction === 'Out')));
      row.sourceCounts = PS.countsOf(row.punchList);
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
    // late-coming requests: how many late days are approved (excused: not in lateArrivals), waiting, rejected, not explained
    lateApproved: 0, latePending: 0, lateRejected: 0, lateNotExplained: 0,
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
    if (d.late) c.lateArrivals += 1; // an approved late coming is not a late arrival (lateExcused, late=false)
    if (d.lateExcused || d.late) {
      if (d.lateState === 'approved') c.lateApproved += 1; else if (d.lateState === 'pending') c.latePending += 1;
      else if (d.lateState === 'rejected') c.lateRejected += 1; else c.lateNotExplained += 1;
    }
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
  } else if (existing && !existing.timesSetBy) { // times set by the Super Admin / HR are not overwritten by a later punch
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
  // THE EXIT DATE IS THE LAST DAY ON THE ROLLS (HRMS spec item 7, utils/exitDate.js): a person with a recorded last working
  // day is on the rolls up to it and 'Left company' after it - whether they are still on notice or already relieved - instead of
  // guessing from their last attendance. A leaver with no attendance at all stays off the rolls (the older leavers), as before.
  // Only people with a leaving status are asked about, so this is one cheap read; no exit date on file = the old rule.
  const leavingNow = employees.filter((e) => LEFT_EMPLOYMENT.includes(e.employmentStatus) || ['Notice Period', 'Exit Process'].includes(e.employmentStatus)).map((e) => e.id);
  if (leavingNow.length) {
    const exits = await require('./exitDate').exitDatesFor(leavingNow).catch(() => new Map()); // eslint-disable-line global-require
    exits.forEach(({ date }, id) => {
      if (left.has(id)) { if (lastDayOf.get(id)) lastDayOf.set(id, date); } else lastDayOf.set(id, date);
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
  // Approved HALF-DAY leave and the person came in: a punch with the other
  // punch missing, or still in the office. They are one Half Day person (half
  // worked + half on leave) every day, never a whole Present and never a
  // whole On Leave (user 2026-10-07: "one employee took half-day leave:
  // correct the KPIs every day"). A full day's work or a day with no punch is
  // unchanged. This only decides the KPI box; the day's paid / leave / absent
  // numbers (and so payroll) are not touched.
  // A half-day leave that is still waiting (pendingHalf) is the same: the person applied, so the Half day shows.
  if (d && (d.leaveHalf || d.pendingHalf) && !d.noRecord && ['Checked In', 'Missing Check-Out', 'Missing Check-In'].includes(d.status)) return 'halfDay';
  switch (d && d.status) {
    case 'Present': case 'Late': case 'Checked In': case 'Missing Check-Out': case STATUS.EARLY: return 'present';
    case STATUS.HALF_HALF_LEAVE: case STATUS.HALF_REVIEW: return 'halfDay';
    // Applied for leave / asked for a correction = they told someone: not Absent.
    case STATUS.LEAVE_REVIEW: return d.pendingHalf ? 'halfDay' : 'onLeave'; // a waiting HALF-day request is a Half day
    case STATUS.INFORMED: return 'onLeave';
    // Half-day leave and the other half not worked (no punch at all, or under the half-day
    // minimum): half on leave, half absent = ONE Half day person - never a whole On leave
    // and never a whole absence (user 2026-10-09). Pay / leave numbers are unchanged.
    case STATUS.HALF_LEAVE_ABSENT: return 'halfDay';
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

// THE ONE TILE SET (user, 2026-10-09). Every attendance screen (HRMS dashboard,
// the Attendance report / day report, Team Attendance, the AI's answers) shows
//   Present + Absent + Half day + On leave + Week off / Holiday = Headcount
// (plus, only when somebody is in them: No device data / Not checked in yet /
// Upcoming - a date nothing has come for yet). A person is in exactly ONE tile:
// bucketOf(). PRESENT = everyone who worked: Late, Early logout, Missing
// check-in and Missing check-out are people WITH a punch, so they are Present.
// They are shown only as small notes inside the Present tile (notesOf), never
// as tiles and never in the equation. Payroll / leave still tell Missing
// check-in / out apart through summarise() - that is unchanged.
const NOTE_KEYS = ['late', 'earlyLogout', 'missingCheckIn', 'missingCheckOut', 'noPunches', 'punchOnLeave', 'leaveRejected'];
const NOTE_LABEL = {
  late: 'Late', earlyLogout: 'Early logout', missingCheckIn: 'Missing check-in', missingCheckOut: 'Missing check-out',
  noPunches: 'No punches', punchOnLeave: 'Punch on a leave day', leaveRejected: 'Half-day leave rejected',
};
// The tiles that carry notes: Present, and (a person with a leave who still punched) Half day and On leave;
// Absent carries only "Half-day leave rejected" (a turned-down half-day request is not a half day).
const NOTE_TILES = ['present', 'halfDay', 'onLeave', 'absent'];
// The notes of ONE day row. A missing check-in / check-out stays visible even when the person has
// a leave that day (the leave moves them to Half day / On leave, the punch gap is still HR's to fix).
//   Present   - from the day's status (Late, Early Logout, Missing Check-In / Check-Out)
//   Half day  - Late, Missing check-in / check-out (from the punches), and
//               'No punches' for a half-day leave with nothing worked at all
//   On leave  - Missing check-in / check-out from a stray punch, and 'Punch on a leave day'
function notesOf(d, bucket) {
  const out = [];
  if (!d) return out;
  const b = bucket === undefined ? bucketOf(d) : bucket;
  if (b === 'absent') { if (d.leaveRejected) out.push('leaveRejected'); return out; }
  if (b === 'present') {
    if (d.late || d.lateExcused || d.status === 'Late') out.push('late');
    if (d.status === STATUS.EARLY || (d.earlyLogout && d.status !== 'Half Day')) out.push('earlyLogout');
    if (d.status === 'Missing Check-In' && !d.noRecord) out.push('missingCheckIn');
    if (d.status === 'Missing Check-Out') out.push('missingCheckOut');
    if (d.leaveRejected) out.push('leaveRejected');
    // Worked on a day with an approved full-day leave: the leave was not taken - HR should see it.
    if (/on a leave day/.test(d.note || '') && d.status !== 'On Leave') out.push('punchOnLeave');
    return out;
  }
  if (b !== 'halfDay' && b !== 'onLeave') return out;
  const past = d.date && d.date < localDate();
  const hasIn = !!d.checkIn; const hasOut = !!d.checkOut;
  if (b === 'onLeave' && d.status !== 'On Leave') return out; // pending / informed: no punches expected
  if (b === 'halfDay' && (d.status === STATUS.HALF_LEAVE_ABSENT || d.status === STATUS.LEAVE_REVIEW) && !hasIn && !hasOut && !d.punches) { out.push('noPunches'); return out; }
  if (!hasIn && !hasOut) return out;
  if ((d.late || d.lateExcused) && hasIn) out.push('late');
  if (d.earlyLogout && hasOut && b === 'onLeave') out.push('earlyLogout'); // a half day leaves early by definition
  // The day's own status says a punch is missing (also when the two punches are minutes apart), else the punches say it.
  if ((d.status === 'Missing Check-In' && !d.noRecord) || (!hasIn && hasOut)) out.push('missingCheckIn');
  if (d.status === 'Missing Check-Out' || (hasIn && !hasOut && past && d.status !== 'Checked In')) out.push('missingCheckOut');
  if (b === 'onLeave') out.push('punchOnLeave');
  return out;
}

// People counts for ONE day from that day's rows (one row per person).
// headcount = sum of the buckets. The rest are subsets, for information.
function tally(dayRows) {
  const c = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  c.headcount = 0;
  c.late = 0; c.missingCheckIn = 0; c.missingCheckOut = 0; c.checkedIn = 0; c.checkedOut = 0; c.punched = 0; c.biometric = 0;
  c.earlyLogout = 0; c.underReview = 0;
  // Late arrivals by the state of their late-coming request (utils/latePermission.js). late = everyone who came after the
  // Late-after time; approved ones are excused (not a policy late) but still listed here so the numbers add up.
  c.lateStates = { late: 0, approved: 0, pending: 0, rejected: 0, none: 0 };
  c.lateExcused = 0;
  // The notes inside the Present tile (people who are Present AND late / left early / missed a punch).
  // Notes per tile (Present / Half day / On leave); none of them is a tile and none is in the equation.
  c.tileNotes = Object.fromEntries(NOTE_TILES.map((t) => [t, Object.fromEntries(NOTE_KEYS.map((k) => [k, 0]))]));
  c.notes = c.tileNotes.present;
  dayRows.forEach((d) => {
    const b = bucketOf(d);
    if (!b) return;
    c.headcount += 1;
    c[b] += 1;
    if (NOTE_TILES.includes(b)) notesOf(d, b).forEach((k) => { c.tileNotes[b][k] += 1; });
    // LATE = the Late note inside the PRESENT tile (the same number as tileNotes.present.late / the dashboard / the Monthly Summary).
    // A late person who is a Half day / On leave carries Late as a note on that tile (tileNotes), not here.
    if (b === 'present' && (d.late || d.lateExcused || d.status === 'Late')) c.late += 1;
    if (b === 'present' && d.lateExcused) c.lateExcused += 1;
    if (b === 'present' && d.lateState && (d.late || d.lateExcused)) { c.lateStates.late += 1; c.lateStates[d.lateState] += 1; }
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

// ONE PERSON over a period, in the ONE tile definition (bucketOf + notesOf) - what the Monthly Summary row and the Biometric
// list's per-person totals both show, so they can never differ. `rows` = that person's day rows for the period.
//   days = every day the person is on the rolls (one bucket each) = present + halfDay + absent + onLeave + offDay + noRecord + notYet + upcoming
//   workingDays = days - offDay - upcoming
// Present INCLUDES late / early logout / missing check-in / missing check-out (they are notes inside it, never extra tiles).
// punchDays / punchRows / checkInDays are plain facts (days with a punch, punches received, days with a check-in), labelled as such.
function tallyPerson(rows) {
  const c = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  c.days = 0;
  c.late = 0; c.lateExcused = 0; c.earlyLogout = 0; c.missingCheckIn = 0; c.missingCheckOut = 0;
  c.lateStates = { late: 0, approved: 0, pending: 0, rejected: 0, none: 0 };
  c.punchDays = 0; c.punchRows = 0; c.checkInDays = 0;
  (rows || []).forEach((d) => {
    const b = bucketOf(d);
    if (!b) return;
    c.days += 1;
    c[b] += 1;
    if (d.punches) { c.punchDays += 1; c.punchRows += Number(d.punches) || 0; }
    if (d.checkIn) c.checkInDays += 1;
    if (b !== 'present') return;
    const n = notesOf(d, b);
    if (n.includes('late')) c.late += 1;
    if (d.lateExcused) c.lateExcused += 1;
    if (n.includes('late') && d.lateState) { c.lateStates.late += 1; c.lateStates[d.lateState] += 1; }
    if (n.includes('earlyLogout')) c.earlyLogout += 1;
    if (n.includes('missingCheckIn')) c.missingCheckIn += 1;
    if (n.includes('missingCheckOut')) c.missingCheckOut += 1;
  });
  c.workingDays = c.days - c.offDay - c.upcoming;
  return c;
}
// Several people added up (person-days). Same keys as tallyPerson.
function addTallies(list) {
  const t = tallyPerson([]);
  (list || []).forEach((c) => {
    Object.keys(t).forEach((k) => {
      if (k === 'lateStates') Object.keys(t.lateStates).forEach((s) => { t.lateStates[s] += c.lateStates[s] || 0; });
      else t[k] += c[k] || 0;
    });
  });
  return t;
}
// "Present 20 + Absent 3 + Half day 1 + On leave 1 + Week off / Holiday 4 = 29 days" - the equation under every count.
function equationText(c) {
  const bits = [`Present ${c.present}`, `Absent ${c.absent}`, `Half day ${c.halfDay}`, `On leave ${c.onLeave}`, `Week off / Holiday ${c.offDay}`];
  if (c.noRecord) bits.push(`No device data ${c.noRecord}`);
  if (c.notYet) bits.push(`Not checked in yet ${c.notYet}`);
  if (c.upcoming) bits.push(`Upcoming ${c.upcoming}`);
  return `${bits.join(' + ')} = ${c.days} days`;
}

module.exports = {
  tallyPerson, addTallies, equationText,
  applyPunchToDay,
  LEFT_EMPLOYMENT, rollOf, joinedOn, onRolls, BUCKETS, BUCKET_LABEL, bucketOf, tally,
  COUNTED, MISSING_RULES, STATUS, COLOUR, colourOf, workOf, policyTimes, applySandwich,
  localDate, localTime, isDate, eachDay, monthRange, weeklyOffs, hoursBetween,
  dayStatus, loadDays, summarise, monthLabel, NOTE_KEYS, NOTE_LABEL, NOTE_TILES, notesOf,
  classifyDay, kpiOf, leaveKindOf, isLateDay, LP, reasonOf, KPI_KEYS, KPI_LABEL, clock, HOW, HOW_ORDER, howMarkedOf, howOutOf, howTextOf, methodOfPunch,
};
