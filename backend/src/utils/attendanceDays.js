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
// ---------------------------------------------------------------------------

const { toMinutes, isLate, sortedPunches, dayCheckIn, dayCheckOut, monthLabel } = require('./attendanceMath');

const COUNTED = ['Present', 'Late', 'Half Day', 'Absent', 'On Leave', 'Missing Check-In', 'Missing Check-Out'];
const MISSING_RULES = ['Missing Check-In', 'Absent'];

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

// The one rule. `ctx` carries the policy plus what is known about the day.
//   record    the marked Attendance row for the day, or null
//   punches   that day's AttendancePunch rows (any method)
//   onLeave   an approved leave covers the day
//   holiday   the Holiday row's name, or null
//   joined    YYYY-MM-DD the person joined, or null
function dayStatus({ date, record, punches = [], onLeave = false, holiday = null, joined = null, cfg, today, offs }) {
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
  const base = { date, checkIn, checkOut, hours, method: firstMethod, punches: ps.length, note: '' };
  const late = !!checkIn && isLate(checkIn, cfg.graceTime);
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  const weeklyOff = (offs || weeklyOffs(cfg)).has(dow);
  const marked = record ? record.status : null;

  if (joined && date < joined) return { ...base, status: 'Not Joined', counted: false };
  if (date > today) return { ...base, status: 'Upcoming', counted: false };
  if (onLeave || marked === 'Leave' || marked === 'On Leave') return { ...base, status: 'On Leave', counted: true };

  const worked = !!(checkIn || checkOut);
  if (!worked) {
    if (holiday) return { ...base, status: 'Holiday', note: holiday, counted: false };
    if (weeklyOff) return { ...base, status: 'Weekly Off', counted: false };
    // Hand-marked by HR without times (Present / Late / Absent / Half Day /
    // WFH) is honoured as marked.
    if (marked) {
      const status = marked === 'WFH' ? 'Present' : marked;
      return { ...base, status, note: marked === 'WFH' ? 'WFH' : 'Marked by HR', counted: COUNTED.includes(status) };
    }
    if (date === today) return { ...base, status: 'Not Checked In', counted: false };
    const rule = MISSING_RULES.includes(cfg.missingCheckInRule) ? cfg.missingCheckInRule : 'Missing Check-In';
    // noRecord: nothing at all was recorded for the day (no punch, no mark, no
    // leave) — the status comes from the policy rule, not from a punch.
    return { ...base, status: rule, note: 'No check-in recorded', counted: true, noRecord: true };
  }
  if (!checkIn) return { ...base, status: 'Missing Check-In', note: 'Checked out without a check-in', counted: true };
  if (!checkOut) {
    if (date === today) return { ...base, status: 'Checked In', late, counted: false };
    return { ...base, status: 'Missing Check-Out', late, note: 'Checked in, never checked out', counted: true };
  }
  // A marked Half Day / Absent is HR's decision and stands.
  if (marked === 'Half Day' || marked === 'Absent') return { ...base, status: marked, late, note: 'Marked by HR', counted: true };
  const full = Number(cfg.fullDayHours || 8);
  const half = Number(cfg.halfDayHours || 4);
  if (hours != null && hours < half) return { ...base, status: 'Absent', late, note: `Worked ${hours}h, under the ${half}h half-day minimum`, counted: true };
  if (hours != null && hours < full) return { ...base, status: 'Half Day', late, note: `Worked ${hours}h, under the ${full}h full-day minimum`, counted: true };
  return { ...base, status: late ? 'Late' : 'Present', late, counted: true };
}

// Everything dayStatus() needs for a set of employees over a range, in four
// queries. Returns { cfg, today, days(employee) -> [day rows] }.
//   lastDayOf (optional, from rollOf()) — for a person who has LEFT, the last
//   day they were on the rolls; every later day reads 'Left' (not counted).
async function loadDays(prisma, { employees, from, to, cfg, lastDayOf = null }) {
  const ids = employees.map((e) => e.id);
  const [records, punches, leaves, holidays, regs, imported] = await Promise.all([
    prisma.attendance.findMany({ where: { employeeId: { in: ids }, date: { gte: from, lte: to } } }),
    prisma.attendancePunch.findMany({ where: { employeeId: { in: ids }, date: { gte: from, lte: to } } }),
    prisma.leaveRequest.findMany({
      where: { employeeId: { in: ids }, status: { in: ['Approved', 'Cancellation Requested'] }, fromDate: { lte: to }, toDate: { gte: from } },
      select: { employeeId: true, fromDate: true, toDate: true, type: true },
    }),
    prisma.holiday.findMany({ where: { date: { gte: from, lte: to } } }),
    prisma.attendanceRegularization.findMany({
      where: { employeeId: { in: ids }, date: { gte: from, lte: to } },
      select: { employeeId: true, date: true, status: true, createdAt: true }, orderBy: { createdAt: 'desc' },
    }),
    // Imported old-HRMS days with punch times but no first check-in in the
    // report (e.g. today's log exported before the report was): read below.
    prisma.attendanceHistory.findMany({
      where: { employeeId: { in: ids }, date: { gte: from, lte: to }, punchTimes: { not: null } },
      select: { employeeId: true, date: true, punchTimes: true },
    }),
  ]);
  const key = (id, d) => `${id}|${d}`;
  const recordOf = new Map(records.map((r) => [key(r.employeeId, r.date), r]));
  const punchesOf = new Map();
  punches.forEach((p) => { const k = key(p.employeeId, p.date); if (!punchesOf.has(k)) punchesOf.set(k, []); punchesOf.get(k).push(p); });
  // An OPTIONAL holiday is a holiday only for whoever takes it, so it is not
  // a day off for everyone: those dates stay working days here.
  const holidayOf = new Map(holidays.filter((h) => h.type !== 'Optional').map((h) => [String(h.date).slice(0, 10), h.name]));
  const logOf = new Map(imported.map((h) => [key(h.employeeId, h.date), h.punchTimes]));
  const regOf = new Map();
  regs.forEach((r) => { const k = key(r.employeeId, r.date); if (!regOf.has(k)) regOf.set(k, r.status); });
  const leaveOf = (id, d) => leaves.find((l) => l.employeeId === id && String(l.fromDate).slice(0, 10) <= d && String(l.toDate).slice(0, 10) >= d) || null;
  const today = localDate();
  const offs = weeklyOffs(cfg);
  const range = eachDay(from, to);

  function days(employee) {
    const joined = employee.dateOfJoining ? new Date(employee.dateOfJoining).toISOString().slice(0, 10) : null;
    const left = lastDayOf && lastDayOf.has(employee.id);
    const lastDay = left ? lastDayOf.get(employee.id) : null;
    return range.map((d) => {
      if (left && (!lastDay || d > lastDay)) {
        return { date: d, status: 'Left', counted: false, checkIn: null, checkOut: null, hours: null, method: null, punches: 0, note: 'No longer on the rolls' };
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
      const row = dayStatus({
        date: d, record: recordOf.get(k) || null, punches: ps, onLeave: !!leave,
        holiday: holidayOf.get(d) || null, joined, cfg, today, offs,
      });
      if (leave && row.status === 'On Leave') row.note = `${leave.type} leave`;
      // Location status of the day's first check-in (web/mobile), for §10.
      const fin = dayCheckIn(ps);
      row.locationStatus = fin ? (fin.locationStatus || (fin.location ? 'Captured' : fin.method === 'Biometric' ? 'Device' : 'Not captured')) : null;
      row.verification = fin ? (fin.verificationStatus || null) : null;
      row.regularization = regOf.get(k) || null;
      return row;
    });
  }
  return { today, days };
}

// §11 — the month's counts for one employee, from their day rows.
function summarise(dayRows) {
  const c = { workingDays: 0, present: 0, absent: 0, late: 0, halfDay: 0, onLeave: 0, missingCheckIn: 0, missingCheckOut: 0, holidays: 0, weeklyOffs: 0, lateArrivals: 0, noRecord: 0 };
  dayRows.forEach((d) => {
    // noRecord is a SUBSET of missingCheckIn (or of absent, per the policy):
    // the working days on which nothing at all was recorded.
    if (d.noRecord) c.noRecord += 1;
    if (d.status === 'Holiday') c.holidays += 1;
    if (d.status === 'Weekly Off') c.weeklyOffs += 1;
    if (d.late) c.lateArrivals += 1;
    if (!d.counted) return;
    c.workingDays += 1;
    if (d.status === 'Present') c.present += 1;
    else if (d.status === 'Late') c.late += 1;
    else if (d.status === 'Half Day') c.halfDay += 1;
    else if (d.status === 'Absent') c.absent += 1;
    else if (d.status === 'On Leave') c.onLeave += 1;
    else if (d.status === 'Missing Check-In') c.missingCheckIn += 1;
    else if (d.status === 'Missing Check-Out') c.missingCheckOut += 1;
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
  offDay: 'Week-off / Holiday', noRecord: 'No record', notYet: 'Not checked in yet', upcoming: 'Upcoming',
};
function bucketOf(d) {
  switch (d && d.status) {
    case 'Present': case 'Late': case 'Checked In': case 'Missing Check-Out': return 'present';
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
  dayRows.forEach((d) => {
    const b = bucketOf(d);
    if (!b) return;
    c.headcount += 1;
    c[b] += 1;
    if (d.late || d.status === 'Late') c.late += 1;
    if (d.status === 'Missing Check-Out') c.missingCheckOut += 1;
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
  COUNTED, MISSING_RULES,
  localDate, localTime, isDate, eachDay, monthRange, weeklyOffs, hoursBetween,
  dayStatus, loadDays, summarise, monthLabel,
};
