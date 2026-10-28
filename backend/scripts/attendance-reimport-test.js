#!/usr/bin/env node
// ---------------------------------------------------------------------------
// RE-IMPORTING A DAY ADDS WHAT THE NEWER FILE KNOWS (founder 2026-10-28: "Oct 11 to today some records are there, some are not").
// A morning export imported first, then the full-day file: the day used to be skipped as "Already imported", so the evening
// check-out never reached the employee's My Attendance. Runs in-process on a COPY of the database (refuses dev.db):
//   TL_TEST_DB=C:/path/copy.db node scripts/attendance-reimport-test.js
// ---------------------------------------------------------------------------
const path = require('path');

const BACK = path.resolve(__dirname, '..');
const DB = String(process.env.TL_TEST_DB || '');
if (!DB || /(^|[\\/])dev\.db$/i.test(DB)) { console.error('Refusing: set TL_TEST_DB to a COPY of the database (never dev.db).'); process.exit(2); }
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}`;

const prisma = require(path.join(BACK, 'src/db'));
const H = require(path.join(BACK, 'src/utils/attendanceHistoryImport'));
const D = require(path.join(BACK, 'src/utils/attendanceDays'));

let pass = 0; let fail = 0;
const check = (name, ok, detail) => {
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail != null ? `  -> ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 500)}` : ''}`);
};
// the old HRMS's two day files: the report (first in / last out) and the bio-metric log (every punch time)
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const pulseDate = (iso) => `${iso.slice(8)}-${MONTHS[Number(iso.slice(5, 7)) - 1]}-${iso.slice(0, 4)}`;
const files = (rows) => [
  { name: 'report.csv', text: ['Employee Ref No,Employee Name,Date,First Check In,Last Check Out,Total Time Worked,Total Time In Break,Total Hours,Work Location',
    ...rows.map((r) => `${r.code},${r.code}-X,${pulseDate(r.date)},${r.fin || ''},${r.lout || ''},,,,Office`)].join('\n') },
  { name: 'logs.csv', text: ['Employee,Attendance Date,Time Interval', ...rows.map((r) => `${r.code} - X,${pulseDate(r.date)},${r.log}`)].join('\n') },
];
const run = async (rows) => { const p = await H.plan(files(rows)); const r = await H.apply(p, { userId: null }); return { p, r }; };

(async () => {
  const emps = await prisma.employee.findMany({ where: { employmentStatus: 'Active', userId: { not: null } }, take: 3, orderBy: { employeeCode: 'asc' } });
  const [A, B, C] = emps;
  // dates nobody has data on in this copy
  const DAY_A = '2026-12-01'; const DAY_B = '2026-12-02'; const DAY_C = '2026-12-03';
  const ids = emps.map((e) => e.id);
  const clean = async () => {
    const w = { employeeId: { in: ids }, date: { in: [DAY_A, DAY_B, DAY_C] } };
    await prisma.attendancePunch.deleteMany({ where: w }); await prisma.attendance.deleteMany({ where: w });
    await prisma.attendanceHistory.deleteMany({ where: { employeeRef: { in: emps.map((e) => e.employeeCode) }, date: { in: [DAY_A, DAY_B, DAY_C] } } });
  };
  try {
    await clean();
    // A: morning export, then the full-day file
    let x = await run([{ code: A.employeeCode, date: DAY_A, fin: '09:01:00', lout: '09:05:00', log: '09:01:00|09:05:00' }]);
    let att = await prisma.attendance.findFirst({ where: { employeeId: A.id, date: DAY_A } });
    check('A1 morning file: the day is created with the morning times', x.p.days.byAction.create === 1 && att && att.checkOut === '09:05', [x.p.days, att]);
    x = await run([{ code: A.employeeCode, date: DAY_A, fin: '09:01:00', lout: '18:10:00', log: '09:01:00|09:05:00|13:30:00|18:10:00' }]);
    att = await prisma.attendance.findFirst({ where: { employeeId: A.id, date: DAY_A } });
    const outs = await prisma.attendancePunch.findMany({ where: { employeeId: A.id, date: DAY_A, direction: 'Out' } });
    const hist = await prisma.attendanceHistory.findFirst({ where: { employeeRef: A.employeeCode, date: DAY_A } });
    check('A2 full-day file: NOT skipped — counted as updated', x.p.days.updated === 1 && !x.p.days.byAction.skip && x.r.daysUpdated === 1, x.p.days);
    check('A3 the check-out the morning import wrote moves to 18:10 (one Out punch, moved, not a second one)', att.checkOut === '18:10' && outs.length === 1 && outs[0].clockTime === '18:10:00', [att, outs]);
    check('A4 the stored day has the later check-out and all four punch times', hist.lastCheckOut === '18:10:00' && hist.punchTimes === '09:01:00|09:05:00|13:30:00|18:10:00', hist);
    const { days } = await D.loadDays(prisma, { employees: [A], from: DAY_A, to: DAY_A, cfg: (await prisma.hrConfig.findFirst()) || {}, preview: true });
    const day = days(A)[0];
    check('A5 the employee\'s My Attendance reads the 18:10 check-out', day.checkOut === '18:10', day);
    x = await run([{ code: A.employeeCode, date: DAY_A, fin: '09:01:00', lout: '18:10:00', log: '09:01:00|09:05:00|13:30:00|18:10:00' }]);
    check('A6 the same file again: skipped, nothing doubled', x.p.days.byAction.skip === 1 && !x.p.days.updated && (await prisma.attendancePunch.count({ where: { employeeId: A.id, date: DAY_A } })) === 2, x.p.days);

    // B: the device sent only the morning check-in; morning export (no check-out), then the full-day file
    await prisma.attendance.create({ data: { employeeId: B.id, date: DAY_B, status: 'Present', checkIn: '09:00' } });
    await prisma.attendancePunch.create({ data: { employeeId: B.id, date: DAY_B, time: '09:00', clockTime: '09:00:10', direction: 'In', method: 'Biometric' } });
    x = await run([{ code: B.employeeCode, date: DAY_B, fin: '09:00:10', lout: '', log: '09:00:10' }]);
    check('B1 morning file over the device check-in: kept', x.p.days.byAction.keep === 1, x.p.days);
    x = await run([{ code: B.employeeCode, date: DAY_B, fin: '09:00:10', lout: '18:02:00', log: '09:00:10|18:02:00' }]);
    att = await prisma.attendance.findFirst({ where: { employeeId: B.id, date: DAY_B } });
    const bOut = await prisma.attendancePunch.findMany({ where: { employeeId: B.id, date: DAY_B, direction: 'Out' } });
    const bIn = await prisma.attendancePunch.count({ where: { employeeId: B.id, date: DAY_B, direction: 'In' } });
    check('B2 full-day file: the check-out is filled and an Out punch added; the device check-in is not doubled', att.checkOut === '18:02' && bOut.length === 1 && bOut[0].clockTime === '18:02:00' && bIn === 1, [att, bOut, bIn]);

    // C: HR / Super Admin set the times by hand: a newer file never moves them
    x = await run([{ code: C.employeeCode, date: DAY_C, fin: '09:10:00', lout: '09:20:00', log: '09:10:00|09:20:00' }]);
    await prisma.attendance.updateMany({ where: { employeeId: C.id, date: DAY_C }, data: { checkOut: '09:20', timesSetBy: 'Super Admin' } });
    x = await run([{ code: C.employeeCode, date: DAY_C, fin: '09:10:00', lout: '18:30:00', log: '09:10:00|09:20:00|18:30:00' }]);
    att = await prisma.attendance.findFirst({ where: { employeeId: C.id, date: DAY_C } });
    check('C1 times set by hand stand (the stored day still learns the later time)', att.checkOut === '09:20' && x.p.days.byAction.keep === 1, [att, x.p.days]);

    // D: a web / GPS check-in at 09:49 was the only punch; the device file says 09:12 in, 18:17 out
    const DAY_D = DAY_A;
    await clean();
    await prisma.attendance.create({ data: { employeeId: A.id, date: DAY_D, status: 'Late', checkIn: '09:49' } });
    await prisma.attendancePunch.create({ data: { employeeId: A.id, date: DAY_D, time: '09:49', direction: 'In', method: 'GPS / Location', source: 'Web' } });
    x = await run([{ code: A.employeeCode, date: DAY_D, fin: '09:12:33', lout: '18:17:34', log: '09:14:59|18:17:32|18:17:34' }]);
    const dIn = await prisma.attendancePunch.findMany({ where: { employeeId: A.id, date: DAY_D }, orderBy: { time: 'asc' } });
    const dd = (await D.loadDays(prisma, { employees: [A], from: DAY_D, to: DAY_D, cfg: (await prisma.hrConfig.findFirst()) || {}, preview: true })).days(A)[0];
    check('D1 the device check-in earlier than the web one, and the check-out, are added (the web punch stays)', dIn.length === 3 && dIn[0].clockTime === '09:12:33' && dIn[2].clockTime === '18:17:34' && dIn.some((p) => p.source === 'Web'), dIn.map((p) => `${p.time} ${p.direction} ${p.source}`));
    check('D2 My Attendance reads 09:12 - 18:17, not Late 09:49', dd.checkIn === '09:12' && dd.checkOut === '18:17' && dd.status !== 'Late', dd);
    x = await run([{ code: A.employeeCode, date: DAY_D, fin: '09:12:33', lout: '18:17:34', log: '09:14:59|18:17:32|18:17:34' }]);
    check('D3 the same file again adds nothing more', x.p.days.byAction.skip === 1 && (await prisma.attendancePunch.count({ where: { employeeId: A.id, date: DAY_D } })) === 3, x.p.days);

    // E: only the bio-metric LOG (no report): the morning export first, then the full-day log
    await clean();
    const logOnly = (log) => [{ name: 'logs.csv', text: ['Employee,Attendance Date,Time Interval', `${B.employeeCode} - X,${pulseDate(DAY_B)},${log}`].join('\n') }];
    let lp = await H.plan(logOnly('09:01:10|09:01:12')); await H.apply(lp, { userId: null });
    let eAtt = await prisma.attendance.findFirst({ where: { employeeId: B.id, date: DAY_B } });
    check('E1 a log-only morning day: check-in from the log, no check-out invented', lp.days.byAction.create === 1 && eAtt && eAtt.checkIn === '09:01' && !eAtt.checkOut, [lp.days, eAtt]);
    lp = await H.plan(logOnly('09:01:10|09:01:12|18:04:11|18:04:14')); await H.apply(lp, { userId: null });
    eAtt = await prisma.attendance.findFirst({ where: { employeeId: B.id, date: DAY_B } });
    const eDay = (await D.loadDays(prisma, { employees: [B], from: DAY_B, to: DAY_B, cfg: (await prisma.hrConfig.findFirst()) || {}, preview: true })).days(B)[0];
    check('E2 the full-day log: the last evening time becomes the check-out, My Attendance shows it', lp.days.updated === 1 && eAtt.checkOut === '18:04' && eDay.checkOut === '18:04', [lp.days, eAtt, eDay.status]);
    lp = await H.plan([{ name: 'logs.csv', text: ['Employee,Attendance Date,Time Interval', `${C.employeeCode} - X,${pulseDate(DAY_C)},18:03:49|18:03:52`].join('\n') }]);
    check('E3 an evening-only log (one press) is a check-in, never a check-out', lp.items[0].firstCheckIn === '18:03:49' && !lp.items[0].lastCheckOut, lp.items[0]);
  } finally {
    await clean();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
