// Unit tests for classifyDay (utils/attendanceDays.js). Pure — no database.
// cd backend && node scripts/test-classify-day.js   (no database is read or written)
const assert = require('assert');
const D = require(process.argv[2] || '../src/utils/attendanceDays');

const cfg = {
  graceTime: '09:30', halfDayHours: 4, fullDayHours: 8, weeklyOffDays: '0,6',
  workStartTime: '09:00', workEndTime: '18:00', halfDaySplit: '13:30', earlyLogoutFrom: '17:00', earlyLogoutGraceMinutes: 0,
};
const PAST = '2026-09-15'; // a Tuesday
const TODAY = '2026-10-05'; // Monday
const SAT = '2026-09-19';
const punch = (time, direction) => ({ time, clockTime: `${time}:00`, direction, method: 'Biometric' });
const day = (ins, outs, extra = {}) => D.classifyDay({
  date: PAST, today: TODAY, cfg, record: null, preview: true,
  punches: [...ins.map((t) => punch(t, 'In')), ...outs.map((t) => punch(t, 'Out'))], ...extra,
});

let n = 0;
function check(name, row, want) {
  n += 1;
  Object.entries(want).forEach(([k, v]) => assert.deepStrictEqual(row[k], v, `${name}: ${k} = ${JSON.stringify(row[k])}, want ${JSON.stringify(v)} (reason: ${row.reason})`));
  console.log(`ok  ${name.padEnd(46)} ${String(row.kpi).padEnd(15)} ${row.reason}`);
}

check('9:02-6:05 Present', day(['09:02'], ['18:05']), { status: 'Present', kpi: 'present', late: false, present: 1 });
check('9:00-5:20 Early logout', day(['09:00'], ['17:20']), { status: 'Early Logout', kpi: 'earlyLogout', present: 1 });
check('9:00-5:00 sharp = Early logout', day(['09:00'], ['17:00']), { kpi: 'earlyLogout', present: 1 });
check('9:00-4:59 = Half day 1st half', day(['09:00'], ['16:59']), { kpi: 'halfDay', session: 'First half', present: 0.5, absent: 0.5 });
check('9:00-3:10 Half day 1st half', day(['09:00'], ['15:10']), { status: 'Half Day', kpi: 'halfDay', session: 'First half', present: 0.5 });
check('9:00-1:30 sharp = Half day 1st half', day(['09:00'], ['13:30']), { kpi: 'halfDay', session: 'First half' });
check('9:00-11:00 Half day (short, not Absent)', day(['09:00'], ['11:00']), { kpi: 'halfDay', session: 'First half', present: 0.5 });
check('1:45-6:00 Half day 2nd half', day(['13:45'], ['18:00']), { status: 'Half Day', kpi: 'halfDay', session: 'Second half', late: false });
check('1:30 sharp-6:00 = Half day 2nd half', day(['13:30'], ['18:00']), { kpi: 'halfDay', session: 'Second half' });
check('1:29-6:00 = Late (full day)', day(['13:29'], ['18:00']), { status: 'Late', kpi: 'present', late: true });
check('9:45-6:10 Late', day(['09:45'], ['18:10']), { status: 'Late', kpi: 'present', late: true, present: 1 });
check('9:45-5:30 Early logout + late flag', day(['09:45'], ['17:30']), { kpi: 'earlyLogout', late: true });
check('8:15-7:30 PM (before 9 / after 6) Present', day(['08:15'], ['19:30']), { status: 'Present', kpi: 'present' });
check('7:00-8:30 AM (both before 9) Half day', day(['07:00'], ['08:30']), { kpi: 'halfDay', session: 'First half' });
check('6:30-8:00 PM (both after 6) Half day 2nd', day(['18:30'], ['20:00']), { kpi: 'halfDay', session: 'Second half' });
check('no punch + no leave = Absent', day([], []), { status: 'Absent', kpi: 'absent', absent: 1 });
check('no punch + pending leave = Leave (pending)', day([], [], { pendingLeave: { id: 'L1', type: 'Casual Leave', half: null } }), { kpi: 'onLeave', status: 'Leave Under Review', pending: 1, absent: 0 });
check('no punch + approved leave = On leave', day([], [], { leave: { id: 'L2', type: 'Casual Leave', half: null, unpaid: false } }), { kpi: 'onLeave', status: 'On Leave', leave: 1 });
check('no punch + pending correction = Informed', day([], [], { regularization: { id: 'R1' } }), { kpi: 'onLeave', status: 'Informed', absent: 0 });
check('no punch on a week off = not Absent', D.classifyDay({ preview: true, date: SAT, today: TODAY, cfg, record: null, punches: [] }), { status: 'Weekly Off', kpi: 'offDay' });
check('no punch on a holiday = not Absent', day([], [], { holiday: 'Gandhi Jayanti' }), { status: 'Holiday', kpi: 'offDay' });
const satWork = D.classifyDay({ preview: true, date: SAT, today: TODAY, cfg, record: null, punches: [punch('09:01', 'In'), punch('18:02', 'Out')] });
check('punched on a week off (Sat) = Present + tag', satWork, { kpi: 'present', status: 'Present', workedOnOff: 'week off' });
check('no data from device for anyone', day([], [], { noData: true }), { kpi: 'noData', status: 'No device data' });
check('out only = Missing check-in', day([], ['18:10']), { status: 'Missing Check-In', kpi: 'missingCheckIn' });
check('in only (past day) = Missing check-out', day(['09:05'], []), { status: 'Missing Check-Out', kpi: 'missingCheckOut' });
check('in only today 11:00 = Still in office', D.classifyDay({ preview: true, date: TODAY, today: TODAY, now: '11:00', cfg, record: null, punches: [punch('09:05', 'In')] }), { status: 'Checked In', kpi: 'inOffice' });
check('in only today after 6 PM = Missing check-out', D.classifyDay({ preview: true, date: TODAY, today: TODAY, now: '18:30', cfg, record: null, punches: [punch('09:05', 'In')] }), { kpi: 'missingCheckOut' });
check('half worked + pending leave', day(['09:00'], ['14:00'], { pendingLeave: { id: 'L3', type: 'Casual Leave', half: 'Second Half' } }), { kpi: 'halfDay', status: 'Half Day, Under Review' });
check('half worked + approved half leave', day(['13:40'], ['18:00'], { leave: { id: 'L4', type: 'Casual Leave', half: 'First Half', unpaid: false } }), { kpi: 'halfDay', status: 'Half Day + Half Leave', present: 0.5, leave: 0.5 });
check('marked WFH, no punch = Present', day([], [], { record: { status: 'WFH' } }), { kpi: 'present' });
check('9:09 in + 9:10 out (wrong key) = Missing check-out', day(['09:09'], ['09:10']), { kpi: 'missingCheckOut', doublePunch: true });
check('9:00-9:15 = Half day (15 min is a real visit)', day(['09:00'], ['09:15']), { kpi: 'halfDay' });
// THE SWITCH — payroll (no preview, no date) keeps the old rule; a date moves everyone.
const raw = (date, ins, outs, extra = {}) => D.classifyDay({ date, today: TODAY, cfg, record: null, punches: [...ins.map((t) => punch(t, 'In')), ...outs.map((t) => punch(t, 'Out'))], ...extra });
check('OLD rule (payroll): 9:31-5:14 = Half Day', raw(PAST, ['09:31'], ['17:14']), { rule: 'old', status: 'Half Day', present: 0.5 });
check('OLD rule (payroll): no punch = Missing Check-In', raw(PAST, [], []), { rule: 'old', status: 'Missing Check-In', absent: 0 });
check('NEW via preview: 9:31-5:14 = Early logout', raw(PAST, ['09:31'], ['17:14'], { preview: true }), { rule: 'new', kpi: 'earlyLogout', present: 1 });
const dated = { ...cfg, attendanceRulesFrom: '2026-10-01' };
check('date set: 30 Sep (before) = old, even preview', raw('2026-09-30', ['09:31'], ['17:14'], { preview: true, cfg: dated }), { rule: 'old', status: 'Half Day' });
check('date set: 1 Oct (on) = new, payroll too', raw('2026-10-01', ['09:31'], ['17:14'], { cfg: dated }), { rule: 'new', kpi: 'earlyLogout' });
console.log(`\n${n} cases passed.`);
