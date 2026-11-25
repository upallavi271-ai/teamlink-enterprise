#!/usr/bin/env node
// ---------------------------------------------------------------------------
// PAYROLL LOP BREAKDOWN TEST (2026-11-19) - SANDBOX ONLY.
//   node scripts/payroll-lop-breakdown-test.js [--months=2026-10,2026-11] [--all] [--no-api]
//
// "Which dates are the LOP days?" (utils/payrollLopBreakdown.js, GET /payroll/entries/:id/lop-breakdown and
// GET /payroll/payslips/:id/lop-breakdown). Needs prisma/sandbox.db (TL_TEST_DB to pick another copy) and, for the route
// checks, the sandbox API (TL_API, default http://localhost:4011; 4010 is refused).
//
//   A  SYNTHETIC FIXTURES (ZZLOP employees, a March-2026 calendar month nobody is paid for): one employee per rule -
//      absent, half day, unpaid leave, pending leave, paid leave beyond the allowance, late beyond the free allowance, missing
//      check-in, before joining, holiday / sandwich, absent-without-leave - and the dates add up to the engine's own number.
//      + the LATE COMING group rule (every 3 late = 1 LOP, Payroll policy): off / on / starting a later month, and its save route.
//   B  EVERY EMPLOYEE OF THE RUN: for every payroll record of the chosen months, the listed dates add up to exactly what the
//      engine's attendanceDefaults() gives, and (for a record taken from attendance and never edited) to the stored LOP days.
//      Records HR typed or somebody edited are reported separately, with the difference and the reason. Read-only.
//   C  THE ROUTES: payroll desk 200, an employee 403 on the run route, the own payslip 200, somebody else's payslip 403,
//      and no editor names / HR's reason for the employee.
// Removes every row it made. Refuses to run against dev.db / port 4010.
// ---------------------------------------------------------------------------
/* eslint-disable no-console */
const path = require('path');
const fs = require('fs');

const BACK = path.resolve(__dirname, '..');
const DB = path.join(BACK, 'prisma', (process.env.TL_TEST_DB || 'sandbox.db'));
if (!fs.existsSync(DB) || /dev\.db$/.test(DB)) { console.error('No prisma/sandbox.db - start the sandbox first (never dev.db).'); process.exit(2); }
process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}`;
require('dotenv').config({ path: path.join(BACK, '.env') });
process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}`;
process.env.TEST_MODE = process.env.TEST_MODE || '1';
const API = `${String(process.env.TL_API || 'http://localhost:4011').replace(/\/+$/, '').replace(/\/api$/, '')}/api`;
if (/:4010(\/|$)/.test(API)) { console.error('Refusing: 4010 is the real server.'); process.exit(2); }
const prisma = require('../src/db');
const jwt = require('jsonwebtoken');
const E = require('../src/utils/payrollEngine');
const PC = require('../src/utils/payrollCycle');
const LB = require('../src/utils/payrollLopBreakdown');

const args = process.argv.slice(2);
const ALL = args.includes('--all');
const NO_API = args.includes('--no-api');
const monthsArg = (args.find((a) => a.startsWith('--months=')) || '').split('=')[1];

let pass = 0; let fail = 0;
const ok = (cond, name, extra = '') => { if (cond) { pass += 1; console.log(`  ok   ${name}`); } else { fail += 1; console.log(`  FAIL ${name} ${extra}`); } };
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.001;
const tok = (u) => jwt.sign({ id: u.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
async function http(user, url) {
  let r;
  for (let i = 0; i < 10; i += 1) {
    try { r = await fetch(`${API}${url}`, { headers: { Authorization: `Bearer ${tok(user)}` } }); break; } catch (e) { if (i === 9) throw e; await new Promise((res) => setTimeout(res, 3000)); }
  }
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json };
}
async function send(user, method, url, body) {
  let r;
  for (let i = 0; i < 10; i += 1) {
    try { r = await fetch(`${API}${url}`, { method, headers: { Authorization: `Bearer ${tok(user)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); break; } catch (e) { if (i === 9) throw e; await new Promise((res) => setTimeout(res, 3000)); }
  }
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json };
}
const sum = (list, k) => Math.round(list.reduce((n, x) => n + (Number(x[k]) || 0), 0) * 100) / 100;

// ---- A: fixtures -------------------------------------------------------------------------------------------------
const FIX_MONTH = '2026-03'; // a calendar month (the payroll cycle starts later): 1-31 March 2026
const made = { emps: [], users: [], holidays: [] };
let seq = 0;
async function newEmp(label, extra = {}) {
  seq += 1;
  const code = `ZZLOP${String(seq).padStart(2, '0')}`;
  const u = await prisma.user.create({ data: { name: `ZZLOP ${label}`, email: `${code.toLowerCase()}@example.test`, passwordHash: 'x', role: 'EMPLOYEE' } });
  made.users.push(u.id);
  const e = await prisma.employee.create({
    data: {
      userId: u.id, name: `ZZLOP ${label}`, employeeCode: code, email: u.email, department: 'ZZLOP', designation: 'Tester',
      employmentStatus: 'Active', dateOfJoining: new Date('2025-01-01T00:00:00Z'), ...extra,
    },
  });
  made.emps.push(e.id);
  return e;
}
const att = (e, date, status, checkIn, checkOut) => prisma.attendance.create({ data: { employeeId: e.id, date, status, checkIn: checkIn || null, checkOut: checkOut || null } });
async function worked(e, dates) { for (const d of dates) await att(e, d, 'Present', '09:00', '18:30'); } // eslint-disable-line no-restricted-syntax, no-await-in-loop
const WORKDAYS = []; // Mon-Sat of March 2026 (Sunday is the week off)
for (let d = 1; d <= 31; d += 1) { const date = `2026-03-${String(d).padStart(2, '0')}`; if (new Date(`${date}T00:00:00Z`).getUTCDay() !== 0) WORKDAYS.push(date); }

async function breakdownOf(e) {
  const full = await prisma.employee.findUnique({ where: { id: e.id } });
  const row = { id: null, employeeId: e.id, employee: full, month: FIX_MONTH, status: 'DRAFT', attendanceSource: 'ATTENDANCE', daysLop: 0, workingDays: 31, daysPresent: 0 };
  const policy = await E.getPolicy();
  const auto = (await E.attendanceDefaults([full], FIX_MONTH, policy)).map.get(full.id);
  row.daysLop = auto.daysLop; row.workingDays = auto.workingDays; row.daysPresent = auto.daysPresent;
  const b = await LB.forEntry(row, { desk: true });
  return { b, auto };
}
const lopOn = (b, date) => (b.dates.find((d) => d.date === date) || { lop: 0 }).lop;
const codesOn = (b, date) => ((b.dates.find((d) => d.date === date) || { reasons: [] }).reasons).map((r) => r.code);

async function fixtures() {
  console.log('\nA. Synthetic fixtures (one rule each), month', FIX_MONTH);
  const policy = await E.getPolicy();
  const free = Number(policy.freeLateArrivalsPerMonth || 0);
  const paid = Number(policy.paidLeaveDaysPerMonth || 0);
  // every working day of March also needs data from "somebody" so a gap is Absent, not "No device data"
  const base = await newEmp('Base');
  await worked(base, WORKDAYS);

  // 1 absent: worked every day but 2 and 3 March (Mon, Tue)
  const eAbs = await newEmp('Absent');
  await worked(eAbs, WORKDAYS.filter((d) => d !== '2026-03-02' && d !== '2026-03-03'));
  let r = await breakdownOf(eAbs);
  ok(near(r.b.listedLop, r.auto.daysLop) && near(r.b.attendanceLop, r.auto.daysLop), 'absent: listed dates = engine LOP', `${r.b.listedLop} vs ${r.auto.daysLop}`);
  ok(near(lopOn(r.b, '2026-03-02'), 1) && near(lopOn(r.b, '2026-03-03'), 1) && r.b.dates.length === 2, 'absent: exactly the 2 absent dates, 1 day each');
  ok(codesOn(r.b, '2026-03-02').includes('absent'), 'absent: reason says absent');

  // 2 half day: 4 March came 09:00, left 12:00 (before 1:30 PM)
  const eHalf = await newEmp('HalfDay');
  await worked(eHalf, WORKDAYS.filter((d) => d !== '2026-03-04'));
  await att(eHalf, '2026-03-04', 'Present', '09:00', '14:00'); // first half worked (left after the 1:30 PM split, before 5 PM)
  r = await breakdownOf(eHalf);
  ok(near(r.b.listedLop, r.auto.daysLop), 'half day: listed dates = engine LOP', `${r.b.listedLop} vs ${r.auto.daysLop}`);
  ok(near(lopOn(r.b, '2026-03-04'), 0.5), 'half day: 0.5 LOP on the half day', JSON.stringify(r.b.dates.map((d) => [d.date, d.lop])));

  // 3 pending leave: applied for 5 March, not yet decided
  const ePend = await newEmp('PendingLeave');
  await worked(ePend, WORKDAYS.filter((d) => d !== '2026-03-05'));
  const lvP = await prisma.leaveRequest.create({ data: { employeeId: ePend.id, type: 'Casual', fromDate: '2026-03-05', toDate: '2026-03-05', days: 1, status: 'Pending', reason: 'ZZLOP pending' } });
  r = await breakdownOf(ePend);
  ok(near(r.b.listedLop, r.auto.daysLop), 'pending leave: listed dates = engine LOP', `${r.b.listedLop} vs ${r.auto.daysLop}`);
  ok(near(lopOn(r.b, '2026-03-05'), 1) && codesOn(r.b, '2026-03-05').includes('pending'), 'pending leave: counted, reason pending');
  const day5 = r.b.dates.find((d) => d.date === '2026-03-05');
  ok(day5 && day5.leave.length === 1 && day5.leave[0].id === lvP.id && day5.leave[0].status === 'Pending', 'pending leave: the request is attached with its status');

  // 4 approved leave beyond the paid allowance: paid+2 approved Casual days (Mon-)
  const eLeave = await newEmp('LeaveBeyond');
  const leaveDays = WORKDAYS.slice(7, 7 + paid + 2);
  await worked(eLeave, WORKDAYS.filter((d) => !leaveDays.includes(d)));
  await prisma.leaveRequest.create({ data: { employeeId: eLeave.id, type: 'Casual', fromDate: leaveDays[0], toDate: leaveDays[leaveDays.length - 1], days: leaveDays.length, status: 'Approved', decidedBy: 'ZZLOP Approver', decidedAt: new Date(), reason: 'ZZLOP approved' } });
  r = await breakdownOf(eLeave);
  ok(near(r.b.listedLop, r.auto.daysLop), 'leave beyond allowance: listed dates = engine LOP', `${r.b.listedLop} vs ${r.auto.daysLop}`);
  ok(near(r.b.terms.leaveBeyondAllowance, 2), 'leave beyond allowance: 2 days beyond the allowance', JSON.stringify(r.b.terms));
  ok(r.b.notCounted.some((d) => d.notes.some((n) => n.kind === 'leave')), 'leave beyond allowance: the paid leave day is listed under "not counted"');
  const costed = r.b.dates.find((d) => d.reasons.some((x) => x.code === 'leave-beyond-allowance'));
  ok(costed && costed.leave[0] && costed.leave[0].decidedBy === 'ZZLOP Approver' && costed.leave[0].status === 'Approved', 'leave beyond allowance: approver and status are shown');

  // 5 late beyond the free allowance: free+2 late days (check-in 10:30)
  const eLate = await newEmp('Late');
  const lateDays = WORKDAYS.slice(10, 10 + free + 2);
  await worked(eLate, WORKDAYS.filter((d) => !lateDays.includes(d)));
  for (const d of lateDays) await att(eLate, d, 'Late', '10:30', '18:30'); // eslint-disable-line no-restricted-syntax, no-await-in-loop
  r = await breakdownOf(eLate);
  ok(near(r.b.listedLop, r.auto.daysLop), 'late: listed dates = engine LOP', `${r.b.listedLop} vs ${r.auto.daysLop}`);
  ok(near(r.b.terms.lateArrivals, 1) && r.b.dates.length === 2 && r.b.dates.every((d) => near(d.lop, 0.5)), 'late: the 2 late days beyond the free ones cost 0.5 each', JSON.stringify(r.b.terms));
  ok(r.b.notCounted.filter((d) => d.notes.some((n) => n.kind === 'late')).length === free, 'late: the free late arrivals are listed under "not counted"');

  // 6 missing check-in (a check-out only)
  const eMiss = await newEmp('MissingIn');
  await worked(eMiss, WORKDAYS.filter((d) => d !== '2026-03-17'));
  await att(eMiss, '2026-03-17', 'Present', null, '18:30');
  r = await breakdownOf(eMiss);
  ok(near(r.b.listedLop, r.auto.daysLop), 'missing check-in: listed dates = engine LOP', `${r.b.listedLop} vs ${r.auto.daysLop}`);
  ok(codesOn(r.b, '2026-03-17').length > 0 && lopOn(r.b, '2026-03-17') >= 1 - 0.001, 'missing check-in: the day is counted', JSON.stringify(r.b.dates.map((d) => [d.date, d.lop, d.status])));

  // 7 before the joining date: joined 20 March
  const eJoin = await newEmp('Joiner', { dateOfJoining: new Date('2026-03-20T00:00:00Z') });
  await worked(eJoin, WORKDAYS.filter((d) => d >= '2026-03-20'));
  r = await breakdownOf(eJoin);
  ok(near(r.b.listedLop, r.auto.daysLop), 'joined late: listed dates = engine LOP', `${r.b.listedLop} vs ${r.auto.daysLop}`);
  ok(r.b.terms.beforeJoining === 19 && codesOn(r.b, '2026-03-02').includes('before-joining'), 'joined late: the 19 pay days before the joining date are listed', JSON.stringify(r.b.terms)); // week offs are paid days here (weekendsPaid), so Sundays count too

  // 8 holiday + sandwich: a holiday on 9 March; approved leave on 7 (Sat) and 10 (Tue) around a Sunday + a holiday? (Sunday 8 + holiday 9 between Sat 7 and Tue 10)
  const hol = await prisma.holiday.create({ data: { name: 'ZZLOP Holiday', date: '2026-03-09', type: 'Public' } }).catch(() => null);
  if (hol) made.holidays.push(hol.id);
  const eSand = await newEmp('Sandwich');
  await worked(eSand, WORKDAYS.filter((d) => !['2026-03-07', '2026-03-10'].includes(d) && d !== '2026-03-09'));
  await prisma.leaveRequest.create({ data: { employeeId: eSand.id, type: 'Casual', fromDate: '2026-03-07', toDate: '2026-03-07', days: 1, status: 'Approved', decidedBy: 'ZZLOP Approver', decidedAt: new Date() } });
  await prisma.leaveRequest.create({ data: { employeeId: eSand.id, type: 'Casual', fromDate: '2026-03-10', toDate: '2026-03-10', days: 1, status: 'Approved', decidedBy: 'ZZLOP Approver', decidedAt: new Date() } });
  r = await breakdownOf(eSand);
  ok(near(r.b.listedLop, r.auto.daysLop), 'sandwich + holiday: listed dates = engine LOP', `${r.b.listedLop} vs ${r.auto.daysLop}`);
  const sandDay = [...r.b.dates, ...r.b.notCounted].find((d) => d.date === '2026-03-09');
  ok(sandDay && /sandwich/i.test(`${sandDay.attendance} ${(sandDay.reasons || []).map((x) => x.text).join(' ')} ${(sandDay.notes || []).map((x) => x.text).join(' ')}`), 'sandwich + holiday: the holiday between two leave days is explained as a sandwich day');

  // 9 regularization approved: day with a request, attendance record corrected
  const eReg = await newEmp('Regularized');
  await worked(eReg, WORKDAYS.filter((d) => d !== '2026-03-12'));
  await att(eReg, '2026-03-12', 'Present', '09:05', '18:30');
  await prisma.attendanceRegularization.create({ data: { employeeId: eReg.id, date: '2026-03-12', requestedCheckIn: '09:05', requestedCheckOut: '18:30', reason: 'ZZLOP forgot to punch', status: 'Approved', decidedAt: new Date() } });
  r = await breakdownOf(eReg);
  ok(near(r.b.listedLop, r.auto.daysLop) && r.b.dates.length === 0, 'regularized: no LOP, listed = engine');
  ok(r.b.notCounted.some((d) => d.date === '2026-03-12' && d.regularization.length === 1), 'regularized: shown under "not counted" with the request');

  // 10 informed (correction waiting): unpaid until approved
  const eInf = await newEmp('Informed');
  await worked(eInf, WORKDAYS.filter((d) => d !== '2026-03-13'));
  await prisma.attendanceRegularization.create({ data: { employeeId: eInf.id, date: '2026-03-13', requestedCheckIn: '09:00', requestedCheckOut: '18:00', reason: 'ZZLOP waiting', status: 'Pending' } });
  r = await breakdownOf(eInf);
  ok(near(r.b.listedLop, r.auto.daysLop) && near(lopOn(r.b, '2026-03-13'), 1), 'correction waiting: counted, listed = engine', `${r.b.listedLop} vs ${r.auto.daysLop}`);
  const d13 = r.b.dates.find((d) => d.date === '2026-03-13');
  ok(d13 && d13.regularization[0] && d13.regularization[0].status === 'Pending', 'correction waiting: the request is attached');

  // 11 nothing at all in a window: capped / total 31
  const eNone = await newEmp('Nothing');
  r = await breakdownOf(eNone);
  ok(near(r.b.attendanceLop, r.auto.daysLop), 'no attendance at all: total = engine LOP (capped at the payroll days)', `${r.b.attendanceLop} vs ${r.auto.daysLop}`);
  ok(r.b.listedLop >= r.b.attendanceLop - 0.001 && near(r.b.listedLop - r.b.capped, r.b.attendanceLop), 'no attendance at all: listed minus cap = total');

  // 12 absent without applying leave (the rule is switched on for the test only, and put back)
  const PCs = require('../src/utils/payrollCycle');
  const prevRule = await prisma.appSetting.findUnique({ where: { key: PCs.ABSENT_KEY } });
  const awlValue = JSON.stringify({ days: 2, halfDayDays: 1, effectiveFrom: '2026-03' });
  await prisma.appSetting.upsert({ where: { key: PCs.ABSENT_KEY }, update: { value: awlValue }, create: { key: PCs.ABSENT_KEY, value: awlValue } });
  PCs.clearCache();
  made.restoreRule = prevRule;
  const eAwl = await newEmp('AbsentNoLeave');
  await worked(eAwl, WORKDAYS.filter((d) => d !== '2026-03-16'));
  r = await breakdownOf(eAwl);
  ok(near(r.b.listedLop, r.auto.daysLop) && near(r.auto.daysLop, 2), 'absent without leave: listed dates = engine LOP (2 for one day)', `${r.b.listedLop} vs ${r.auto.daysLop}`);
  ok(codesOn(r.b, '2026-03-16').includes('absent') && codesOn(r.b, '2026-03-16').includes('absent-without-leave') && near(lopOn(r.b, '2026-03-16'), 2), 'absent without leave: 1 for the absence + 1 extra, both explained');
  const eAwl2 = await newEmp('AbsentButApplied');
  await worked(eAwl2, WORKDAYS.filter((d) => d !== '2026-03-16'));
  await prisma.leaveRequest.create({ data: { employeeId: eAwl2.id, type: 'Casual', fromDate: '2026-03-16', toDate: '2026-03-16', days: 1, status: 'Rejected', decidedBy: 'ZZLOP Approver', decidedAt: new Date(), rejectReason: 'ZZLOP no' } });
  r = await breakdownOf(eAwl2);
  ok(near(r.b.listedLop, r.auto.daysLop) && near(lopOn(r.b, '2026-03-16'), 1) && !codesOn(r.b, '2026-03-16').includes('absent-without-leave'), 'rejected leave: a normal 1 LOP day (it was an application), no extra');
  const d16 = r.b.dates.find((d) => d.date === '2026-03-16');
  ok(d16 && d16.leave[0] && d16.leave[0].status === 'Rejected' && d16.leave[0].decidedBy === 'ZZLOP Approver', 'rejected leave: shown with status and who rejected it');
  await prisma.appSetting.deleteMany({ where: { key: PCs.ABSENT_KEY } });
  if (prevRule) await prisma.appSetting.create({ data: { key: prevRule.key, value: prevRule.value } });
  made.restoreRule = null;
  PCs.clearCache();

  // 13 HR typed the days (an override row) and an edited record
  const full = await prisma.employee.findUnique({ where: { id: eAbs.id } });
  const typed = { id: null, employeeId: full.id, employee: full, month: FIX_MONTH, status: 'DRAFT', attendanceSource: 'OVERRIDE', daysLop: 5, workingDays: 31, daysPresent: 26 };
  await prisma.payrollAttendance.create({ data: { employeeId: full.id, month: FIX_MONTH, year: 2026, monthNum: 3, workingDays: 31, daysPresent: 26, daysLop: 5, autoDaysPresent: 29, autoDaysLop: 2, reason: 'ZZLOP typed reason', overriddenByName: 'ZZLOP HR', overriddenAt: new Date() } });
  let bd = await LB.forEntry(typed, { desk: true });
  ok(bd.status === 'adjusted' && bd.adjustments.override && bd.adjustments.override.by === 'ZZLOP HR' && bd.adjustments.override.reason === 'ZZLOP typed reason' && near(bd.adjustments.override.daysLop, 5), 'HR typed days: status adjusted, who / reason / days shown to the payroll desk', JSON.stringify(bd.adjustments.override));
  ok(near(bd.attendanceLop, 2) && near(bd.record.daysLop, 5), 'HR typed days: stored 5, attendance 2, both shown');
  bd = await LB.forEntry(typed, { desk: false });
  ok(bd.adjustments.override && bd.adjustments.override.by === null && bd.adjustments.override.reason === null && !JSON.stringify(bd).includes('ZZLOP HR') && !JSON.stringify(bd).includes('ZZLOP typed reason'), "HR typed days: the employee's view carries no name and no reason");
  const entryKey = 'payroll.edit:zzlop-entry';
  made.settingKeys = [entryKey];
  const editState = {
    v: 1,
    edited: true,
    versions: [
      { n: 0, kind: 'calculated', at: '2026-03-31T10:00:00.000Z', byName: 'Payroll calculation', after: { fields: { daysLop: 2 }, totals: {} } },
      { n: 1, kind: 'edit', at: '2026-04-02T11:06:00.000Z', byName: 'ZZLOP Editor', reason: 'Attendance correction', changes: [{ field: 'daysLop', label: 'LOP days', old: 2, new: 1 }] },
    ],
  };
  await prisma.appSetting.create({ data: { key: entryKey, value: JSON.stringify(editState) } });
  const edited = { id: 'zzlop-entry', employeeId: full.id, employee: full, month: FIX_MONTH, status: 'DRAFT', attendanceSource: 'ATTENDANCE', daysLop: 1, workingDays: 31, daysPresent: 30 };
  bd = await LB.forEntry(edited, { desk: true });
  ok(bd.status === 'adjusted' && bd.adjustments.edits.length === 1 && bd.adjustments.edits[0].by === 'ZZLOP Editor' && bd.adjustments.edits[0].change === -1 && bd.adjustments.edits[0].reason === 'Attendance correction', 'edited record: "edited by X: -1 day" with the reason (desk)', JSON.stringify(bd.adjustments.edits));
  ok(near(bd.adjustments.calculatedLop, 2) && near(bd.attendanceLop, 2), 'edited record: as calculated 2, attendance 2, stored 1');
  bd = await LB.forEntry(edited, { desk: false });
  ok(bd.adjustments.edits[0].by === null && bd.adjustments.edits[0].reason === null, "edited record: the employee's view carries no editor and no reason");
  const same = await LB.forEntry({ ...edited, id: null, daysLop: 2, attendanceSource: 'ATTENDANCE' }, { desk: true });
  ok(same.status === 'match' && same.adjustments.edits.length === 0, 'unedited record with the attendance figure: match, no adjustments');
  const stale = await LB.forEntry({ ...edited, id: null, daysLop: 7, attendanceSource: 'ATTENDANCE' }, { desk: true });
  ok(stale.status === 'attendance-changed' && stale.notes.some((n) => /attendance gives 2/.test(n)), 'attendance changed since calculation is said plainly');

  // 13b LATE COMING group rule (founder 2026-11-25): every 3 late arrivals = 1 LOP (3 -> 1, 4 -> 1, 5 -> 1, 6 -> 2). Off = the old rule.
  made.lateTouched = true;
  made.restoreLate = await prisma.appSetting.findUnique({ where: { key: PCs.LATE_KEY } });
  const setLate = async (value) => {
    await prisma.appSetting.deleteMany({ where: { key: PCs.LATE_KEY } });
    if (value) await prisma.appSetting.create({ data: { key: PCs.LATE_KEY, value: JSON.stringify(value) } });
    PCs.clearCache();
  };
  const lateStaff = [];
  for (const n of [2, 3, 4, 5, 6, 9]) { // eslint-disable-line no-restricted-syntax
    const e = await newEmp(`Late${n}`); // eslint-disable-line no-await-in-loop
    const days = WORKDAYS.slice(3, 3 + n);
    await worked(e, WORKDAYS.filter((d) => !days.includes(d))); // eslint-disable-line no-await-in-loop
    for (const d of days) await att(e, d, 'Late', '10:30', '18:30'); // eslint-disable-line no-restricted-syntax, no-await-in-loop
    lateStaff.push({ n, e, days });
  }
  await setLate(null);
  for (const { n, e } of lateStaff) { // eslint-disable-line no-restricted-syntax
    r = await breakdownOf(e); // eslint-disable-line no-await-in-loop
    const want = 0.5 * Math.max(0, n - free);
    ok(near(r.auto.daysLop, want) && near(r.b.listedLop, r.auto.daysLop) && r.b.policy.lateRule === null, `late rule OFF: ${n} late = ${want} LOP (the old rule), dates add up`, `engine ${r.auto.daysLop} dates ${r.b.listedLop}`);
  }
  await setLate({ every: 3, days: 1, effectiveFrom: '2026-03' });
  for (const { n, e, days } of lateStaff) { // eslint-disable-line no-restricted-syntax
    r = await breakdownOf(e); // eslint-disable-line no-await-in-loop
    const want = Math.floor(n / 3);
    ok(near(r.auto.daysLop, want) && near(r.b.listedLop, r.auto.daysLop), `late rule every 3 = 1 LOP: ${n} late = ${want} LOP, dates add up`, `engine ${r.auto.daysLop} dates ${r.b.listedLop}`);
    const costed = r.b.dates.filter((d) => d.reasons.some((x) => x.code === 'late')).map((d) => d.date);
    ok(JSON.stringify(costed) === JSON.stringify(days.filter((_, i) => (i + 1) % 3 === 0)), `late rule: the cost sits on late arrival no. 3, 6, 9 (${n} late)`, JSON.stringify(costed));
    ok(r.b.policy.lateRule && r.b.policy.lateRule.every === 3 && r.b.policy.lateRule.days === 1, 'late rule: the screen says which rule it used');
  }
  const staff4 = lateStaff.find((x) => x.n === 4);
  const l4 = await breakdownOf(staff4.e);
  const note4 = (l4.b.notCounted.find((d) => d.date === staff4.days[3]) || { notes: [] }).notes.map((nt) => nt.text).join(' ');
  ok(l4.b.notCounted.filter((d) => d.notes.some((nt) => nt.kind === 'late')).length === 3 && /does not complete a group yet \(1 of 3\)/.test(note4), 'late rule: the 1st, 2nd and 4th late arrivals say they do not complete a group yet (4th = 1 of 3 of the next group)', note4);
  await setLate({ every: 2, days: 0.5, effectiveFrom: '2026-03' });
  r = await breakdownOf(lateStaff.find((x) => x.n === 5).e);
  ok(near(r.auto.daysLop, 1) && near(r.b.listedLop, 1), 'late rule every 2 = 0.5 LOP: 5 late = 1 LOP');
  await setLate({ every: 3, days: 1, effectiveFrom: '2026-04' });
  r = await breakdownOf(lateStaff.find((x) => x.n === 3).e);
  ok(near(r.auto.daysLop, 0.5) && r.b.policy.lateRule === null, 'late rule starting April: March still uses the old rule (3 late = 0.5)');
  await setLate(made.restoreLate ? JSON.parse(made.restoreLate.value) : null);
  made.lateTouched = false;

  // 14 empty state
  const eFull = await newEmp('FullAttendance');
  await worked(eFull, WORKDAYS);
  r = await breakdownOf(eFull);
  ok(r.b.dates.length === 0 && near(r.b.listedLop, 0) && near(r.auto.daysLop, 0), 'full attendance: no LOP dates (empty state)');
}

// ---- B: every employee of the run -----------------------------------------------------------------------------------
async function everyone() {
  console.log('\nB. Every payroll record: the listed dates add up');
  let months = monthsArg ? monthsArg.split(',') : null;
  if (!months) {
    const all = (await prisma.employeePayrollRun.groupBy({ by: ['month'], _count: { _all: true } })).map((m) => m.month).sort();
    months = ALL ? all : all.slice(-3);
  }
  const policy = await E.getPolicy();
  const totals = { records: 0, matchEngine: 0, mismatchEngine: 0, stored: { match: 0, adjusted: 0, changed: 0, other: 0 } };
  const problems = [];
  const changed = [];
  const adjusted = [];
  for (const month of months) { // eslint-disable-line no-restricted-syntax
    // eslint-disable-next-line no-await-in-loop
    const entries = await prisma.employeePayrollRun.findMany({ where: { month }, include: { employee: true }, orderBy: { employee: { name: 'asc' } } });
    if (!entries.length) { console.log(`  (no payroll records for ${month})`); continue; } // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const { map } = await E.attendanceDefaults(entries.map((e) => e.employee), month, policy);
    let monthMatch = 0;
    for (const e of entries) { // eslint-disable-line no-restricted-syntax
      // eslint-disable-next-line no-await-in-loop
      const b = await LB.forEntry(e, { desk: true });
      const auto = map.get(e.employeeId);
      totals.records += 1;
      const listedOk = near(b.listedLop - b.capped, auto.daysLop) && near(b.attendanceLop, auto.daysLop) && near(sum(b.dates, 'lop'), b.listedLop);
      if (listedOk) { totals.matchEngine += 1; monthMatch += 1; } else { totals.mismatchEngine += 1; problems.push(`${month} ${e.employee.employeeCode} ${e.employee.name}: dates ${b.listedLop} (cap ${b.capped}) vs engine ${auto.daysLop}`); }
      if (b.status === 'match') totals.stored.match += 1;
      else if (b.status === 'adjusted') { totals.stored.adjusted += 1; adjusted.push(`${month} ${e.employee.employeeCode} ${e.employee.name}: stored ${b.record.daysLop}, attendance ${b.attendanceLop} (${e.attendanceSource}${b.adjustments.edits.length ? ', edited' : ''})`); }
      else if (b.status === 'attendance-changed') { totals.stored.changed += 1; changed.push(`${month} ${e.employee.employeeCode} ${e.employee.name}: stored ${b.record.daysLop}, attendance now ${b.attendanceLop}`); } else totals.stored.other += 1;
    }
    console.log(`  ${month}: ${entries.length} record(s), dates = engine LOP for ${monthMatch}`);
  }
  ok(totals.records > 0, `records checked: ${totals.records} over ${months.join(', ')}`);
  ok(totals.mismatchEngine === 0, `listed dates = the engine's LOP for all ${totals.records} records`, problems.slice(0, 8).join(' | '));
  console.log(`  vs the STORED LOP days: ${totals.stored.match} equal, ${totals.stored.adjusted} typed/edited by hand (explained), ${totals.stored.changed} attendance changed since calculation, ${totals.stored.other} other`);
  adjusted.slice(0, 6).forEach((l) => console.log(`     typed/edited: ${l}`));
  changed.slice(0, 12).forEach((l) => console.log(`     changed since: ${l}`));
  return totals;
}

// ---- C: the routes -----------------------------------------------------------------------------------------------------
async function routes() {
  console.log('\nC. Routes (fixtures: a Super Admin and two employees, each with a March-2026 payroll record and payslip)');
  try { const h = await fetch(`${API}/health`); if (!h.ok) throw new Error('not ok'); } catch { console.log(`  (sandbox API not answering at ${API} - route checks skipped)`); return; }
  const mkUser = (name, role) => prisma.user.create({
    data: {
      name, email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}.${Date.now().toString(36)}@example.test`, passwordHash: 'x'.repeat(40), role, hrmsRole: role, atsRole: 'NONE',
      accountsRole: role === 'SUPER_ADMIN' ? 'SUPER_ADMIN' : 'NONE', hrmsAccess: true, accountsAccess: role === 'SUPER_ADMIN', atsAccess: false, status: 'Active',
    },
  });
  const admin = await mkUser('ZZLOP Route Admin', 'SUPER_ADMIN'); made.users.push(admin.id);
  const uA = await mkUser('ZZLOP Route A', 'EMPLOYEE'); made.users.push(uA.id);
  const uB = await mkUser('ZZLOP Route B', 'EMPLOYEE'); made.users.push(uB.id);
  const mk = async (u, label) => {
    seq += 1;
    const e = await prisma.employee.create({
      data: {
        userId: u.id, name: label, employeeCode: `ZZLOP${String(seq).padStart(2, '0')}`, email: u.email, department: 'ZZLOP', designation: 'Tester',
        employmentStatus: 'Active', dateOfJoining: new Date('2025-01-01T00:00:00Z'),
      },
    });
    made.emps.push(e.id);
    await worked(e, WORKDAYS.filter((d) => d !== '2026-03-02'));
    const slip = await prisma.payslip.create({ data: { employeeId: e.id, month: FIX_MONTH, basic: 1000, hra: 0, allowances: 0, deductions: 0, netPay: 1000, lopDays: 1, workingDays: 31 } });
    const run = await prisma.employeePayrollRun.create({ data: { employeeId: e.id, month: FIX_MONTH, year: 2026, monthNum: 3, workingDays: 31, daysPresent: 30, daysLop: 1, status: 'APPROVED', payslipId: slip.id } });
    await prisma.payslip.update({ where: { id: slip.id }, data: { payrollEntryId: run.id } });
    return { e, slip, run };
  };
  const A = await mk(uA, 'ZZLOP Route A');
  const B = await mk(uB, 'ZZLOP Route B');
  let r = await http(admin, `/payroll/entries/${A.run.id}/lop-breakdown`);
  ok(r.status === 200 && r.body && r.body.employee.id === A.e.id && Array.isArray(r.body.dates), 'payroll desk (Super Admin) on the run route: 200 with the breakdown', `got ${r.status}`);
  ok(r.body && r.body.dates && r.body.dates.length === 1 && r.body.dates[0].date === '2026-03-02' && near(r.body.record.daysLop, 1) && r.body.status === 'match', 'the one absent date (2 March) is listed and adds up to the record');
  r = await http(admin, '/payroll/entries/nope/lop-breakdown');
  ok(r.status === 404, 'unknown record: 404', `got ${r.status}`);
  r = await http(uA, `/payroll/entries/${A.run.id}/lop-breakdown`);
  ok(r.status === 403, 'an employee on the payroll run route (even their own record): 403', `got ${r.status}`);
  r = await http(uA, `/payroll/payslips/${A.slip.id}/lop-breakdown`);
  ok(r.status === 200 && r.body.employee.id === A.e.id && r.body.dates.length === 1, 'an employee on their OWN payslip: 200', `got ${r.status}`);
  r = await http(uA, `/payroll/payslips/${B.slip.id}/lop-breakdown`);
  ok(r.status === 403, "an employee on SOMEBODY ELSE'S payslip: 403", `got ${r.status}`);
  r = await http(admin, `/payroll/payslips/${B.slip.id}/lop-breakdown`);
  ok(r.status === 200 && r.body.employee.id === B.e.id, 'the payroll desk on any payslip in scope: 200', `got ${r.status}`);
  r = await http(admin, `/payroll/entries/${A.run.id}/lop-breakdown`);
  ok(!/netPay|grossPay|lopDeduction|bankAccount|"basic"/.test(JSON.stringify(r.body)), 'no salary amounts or bank details in the answer');
  // the late-coming rule is saved with the other payroll cycle settings (Super Admin / Admin only)
  made.lateTouched = true;
  const before = await prisma.appSetting.findUnique({ where: { key: 'payroll.lateRule' } });
  r = await http(admin, '/payroll/cycle');
  ok(r.status === 200 && r.body.settings && 'late' in r.body.settings && r.body.text && r.body.text.late, 'GET /payroll/cycle carries the late-coming rule and its words', `got ${r.status}`);
  r = await send(admin, 'PUT', '/payroll/cycle', { late: { every: 3, days: 1, effectiveFrom: '2026-12' } });
  ok(r.status === 200 && r.body.settings.late.every === 3 && r.body.settings.late.days === 1 && r.body.settings.late.effectiveFrom === '2026-12' && r.body.settings.saved.late === true, 'PUT /payroll/cycle saves "every 3 late = 1 LOP from 2026-12"', JSON.stringify(r.body));
  r = await http(admin, '/payroll/cycle');
  ok(r.body.settings.late.every === 3, 'the saved rule reads back');
  r = await send(admin, 'PUT', '/payroll/cycle', { late: { every: 1, days: 1, effectiveFrom: '2026-12' } });
  ok(r.status === 400, 'every 1 is refused (2 to 10)', `got ${r.status}`);
  r = await send(admin, 'PUT', '/payroll/cycle', { late: { every: 3, days: 1, effectiveFrom: 'December' } });
  ok(r.status === 400, 'a start month that is not YYYY-MM is refused', `got ${r.status}`);
  r = await send(admin, 'PUT', '/payroll/cycle', { late: { every: 3, days: 0.3, effectiveFrom: '2026-12' } });
  ok(r.status === 400, 'LOP days that are not in halves are refused', `got ${r.status}`);
  r = await send(uA, 'PUT', '/payroll/cycle', { late: { every: 4, days: 1, effectiveFrom: '2026-12' } });
  ok(r.status === 403, 'an employee cannot change the rule: 403', `got ${r.status}`);
  r = await http(admin, '/payroll/cycle');
  ok(r.body.settings.late.every === 3, 'the refused changes left the saved rule as it was');
  r = await send(admin, 'PUT', '/payroll/cycle', { late: { off: true } });
  ok(r.status === 200 && r.body.settings.saved.late === false && !r.body.settings.late.every, 'Switch off removes the rule (the old way applies again)', JSON.stringify(r.body));
  if (before) await prisma.appSetting.create({ data: { key: before.key, value: before.value } });
  require('../src/utils/payrollCycle').clearCache();
  made.lateTouched = false;
  // a payslip of an older month that has no per-employee record still opens, from its own figures
  await prisma.employeePayrollRun.delete({ where: { id: B.run.id } });
  r = await http(admin, `/payroll/payslips/${B.slip.id}/lop-breakdown`);
  ok(r.status === 200 && near(r.body.record.daysLop, 1) && r.body.record.id === null, 'a payslip with no payroll record: 200, from the payslip figures', `got ${r.status}`);
}

async function cleanup() {
  if (made.lateTouched) { // the late-coming rule was being tested when something failed: back to what it was
    await prisma.appSetting.deleteMany({ where: { key: 'payroll.lateRule' } });
    if (made.restoreLate) await prisma.appSetting.create({ data: { key: made.restoreLate.key, value: made.restoreLate.value } });
    require('../src/utils/payrollCycle').clearCache();
  }
  if (made.restoreRule) { // the absent rule was being tested when something failed: put it back
    await prisma.appSetting.deleteMany({ where: { key: made.restoreRule.key } });
    await prisma.appSetting.create({ data: { key: made.restoreRule.key, value: made.restoreRule.value } });
    require('../src/utils/payrollCycle').clearCache();
  }
  await prisma.payslip.deleteMany({ where: { employeeId: { in: made.emps } } });
  await prisma.employeePayrollRun.deleteMany({ where: { employeeId: { in: made.emps } } });
  await prisma.payrollAttendance.deleteMany({ where: { employeeId: { in: made.emps } } });
  if (made.settingKeys && made.settingKeys.length) await prisma.appSetting.deleteMany({ where: { key: { in: made.settingKeys } } });
  await prisma.attendanceRegularization.deleteMany({ where: { employeeId: { in: made.emps } } });
  await prisma.leaveRequest.deleteMany({ where: { employeeId: { in: made.emps } } });
  await prisma.attendance.deleteMany({ where: { employeeId: { in: made.emps } } });
  await prisma.attendancePunch.deleteMany({ where: { employeeId: { in: made.emps } } });
  if (made.holidays.length) await prisma.holiday.deleteMany({ where: { id: { in: made.holidays } } });
  await prisma.employee.deleteMany({ where: { id: { in: made.emps } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
}

(async () => {
  try {
    await fixtures();
    await everyone();
    if (!NO_API) await routes();
  } catch (e) {
    console.error(e);
    fail += 1;
  } finally {
    try { await cleanup(); } catch (e) { console.error('cleanup failed', e.message); }
    const left = await prisma.employee.count({ where: { employeeCode: { startsWith: 'ZZLOP' } } }).catch(() => -1);
    console.log(`\nZZLOP test employees left in the sandbox: ${left}`);
    console.log(`${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
