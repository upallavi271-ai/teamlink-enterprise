// Punch-derived attendance maths, shared by the attendance routes and by payroll
// (which needs the same half-day-cut number to price late arrivals). Everything
// here is computed from AttendancePunch/Attendance rows rather than stored, so a
// corrected punch immediately corrects the hours, the lateness and the monthly cut.

// The ways a punch can reach us — the self check-in methods Super Admin assigns
// per employee (routes/attendance.js).
// Older punches keep the method they were recorded with and are still counted.
const CHECKIN_METHODS = ['GPS / Location', 'Biometric', 'Face Recognition'];
const DIRECTIONS = ['In', 'Out'];

// Accepts "09:30" and "9:30 AM"; returns minutes since midnight, or null when the
// string isn't a clock time at all (including out-of-range values like "25:99").
function toMinutes(t) {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ap = (m[3] || '').toUpperCase();
  if (min > 59) return null;
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap === 'PM' && h !== 12) h += 12;
    if (ap === 'AM' && h === 12) h = 0;
  } else if (h > 23) {
    return null;
  }
  return h * 60 + min;
}

function isLate(time, graceTime) {
  const t = toMinutes(time);
  const g = toMinutes(graceTime);
  return t != null && g != null && t > g;
}

// Device punches carry seconds (clockTime); two punches in the same minute keep their order.
const clockOf = (p) => p.clockTime || p.time || '';
const sortedPunches = (punches) => [...punches].sort((a, b) => clockOf(a).localeCompare(clockOf(b)));
const firstIn = (punches) => sortedPunches(punches).find((p) => p.direction === 'In') || null;
const lastOut = (punches) => {
  const outs = sortedPunches(punches).filter((p) => p.direction === 'Out');
  return outs.length ? outs[outs.length - 1] : null;
};

// ONE RULE FOR A DAY'S CHECK-IN AND CHECK-OUT, used by every report.
//   * Each punch is a check-in or a check-out exactly as recorded — for the
//     biometric device that is the state key the person pressed (deviceState).
//   * First In = the earliest check-in. Last Out = the latest check-out.
//   * No check-out is ever inferred: a second scan, however late, is not a
//     check-out unless the person pressed check-out. A day without one shows
//     no check-out (and is a missing check-out for regularization).
const OUT_STATES = new Set(['1', '2', '5']); // check-out, break-out, OT-out
const directionFromState = (state) => (OUT_STATES.has(String(state)) ? 'Out' : 'In');

function daySplit(punches) {
  const ps = sortedPunches(punches);
  const ins = ps.filter((p) => p.direction !== 'Out');
  const outs = ps.filter((p) => p.direction === 'Out');
  const last = ps[ps.length - 1];
  return {
    punches: ps,
    ins,
    outs,
    checkIn: ins[0] || null,
    checkOut: outs.length ? outs[outs.length - 1] : null,
    status: ps.length ? (last.direction === 'Out' ? 'Checked Out' : 'Checked In') : null,
  };
}
const dayCheckIn = (punches) => daySplit(punches).checkIn;
const dayCheckOut = (punches) => daySplit(punches).checkOut;

// "Biometric (Fingerprint)" etc. from the device's verify code.
const VERIFY_LABEL = { 0: 'Password', 1: 'Fingerprint', 2: 'Card', 3: 'Password', 4: 'Card', 15: 'Face', 25: 'Palm' };
function methodLabel(p) {
  if (!p) return '—';
  if (p.method === 'Biometric' && p.deviceVerify != null && VERIFY_LABEL[p.deviceVerify]) return `Biometric (${VERIFY_LABEL[p.deviceVerify]})`;
  return p.method || '—';
}

// "HH:MM[:SS]" -> seconds since midnight.
function toSeconds(t) {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] || 0) : null;
}
function hms(totalSeconds) {
  if (totalSeconds == null || totalSeconds < 0) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(totalSeconds / 3600))}:${pad(Math.floor((totalSeconds % 3600) / 60))}:${pad(totalSeconds % 60)}`;
}

function calendarDays(month) {
  const [y, m] = String(month || '').split('-').map(Number);
  if (!y || !m) return 30;
  return new Date(y, m, 0).getDate();
}

function businessDays(month) {
  const [y, m] = String(month || '').split('-').map(Number);
  if (!y || !m) return 0;
  let n = 0;
  for (let d = 1; d <= calendarDays(month); d++) {
    const dow = new Date(y, m - 1, d).getDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function monthLabel(month) {
  const [y, m] = String(month || '').split('-').map(Number);
  return y && m ? `${MONTH_NAMES[m - 1]} ${y}` : String(month || '');
}

// Per-employee monthly roll-up. Present/half-day/absent/leave come from the marked
// Attendance rows; lateness is derived from punches (distinct dates with a late
// check-in) unioned with any day explicitly marked Late, so hand-marked history
// still counts. Days beyond the free monthly allowance become half-day cuts.
function monthStats({ month, records, punches, cfg }) {
  const present = records.filter((r) => r.status === 'Present' || r.status === 'WFH').length;
  const halfDay = records.filter((r) => r.status === 'Half Day').length;
  const absent = records.filter((r) => r.status === 'Absent').length;
  const leave = records.filter((r) => r.status === 'Leave' || r.status === 'On Leave').length;
  const markedLate = records.filter((r) => r.status === 'Late').length;

  const lateDates = new Set(records.filter((r) => r.status === 'Late').map((r) => r.date));
  punches.filter((p) => p.direction === 'In' && isLate(p.time, cfg.graceTime)).forEach((p) => lateDates.add(p.date));
  const late = lateDates.size;

  const free = Number(cfg.freeLateArrivalsPerMonth || 0);
  const halfDayCut = Math.max(0, late - free);
  const working = calendarDays(month);
  // Late days are still worked days, so they count towards Present for the percentage.
  const pct = working > 0 ? Math.round((((present + markedLate) + halfDay * 0.5) / working) * 100) : 0;
  return { present, halfDay, absent, leave, late, halfDayCut, working, businessDays: businessDays(month), pct };
}

// Code / name / department / designation filters, shared by every HR-facing tab.
// Substring (case-insensitive) on code and name; exact match on department and role.
function employeeMatchesFilters(e, q = {}) {
  // One search box: employee ID or name (the attendance filter bars).
  if (q.q) {
    const s = String(q.q).trim().toLowerCase();
    if (s && !`${e.employeeCode || ''} ${e.name || ''}`.toLowerCase().includes(s)) return false;
  }
  if (q.code && !(e.employeeCode || '').toLowerCase().includes(String(q.code).toLowerCase())) return false;
  if (q.name && !(e.name || '').toLowerCase().includes(String(q.name).toLowerCase())) return false;
  if (q.department && e.department !== q.department) return false;
  if (q.role && e.designation !== q.role) return false;
  return true;
}

module.exports = {
  CHECKIN_METHODS, DIRECTIONS,
  toMinutes, isLate, sortedPunches, firstIn, lastOut, clockOf,
  directionFromState, daySplit, dayCheckIn, dayCheckOut, methodLabel, toSeconds, hms,
  calendarDays, businessDays, monthLabel, monthStats, employeeMatchesFilters,
};
