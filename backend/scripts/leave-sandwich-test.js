#!/usr/bin/env node
// ---------------------------------------------------------------------------
// SANDWICH RULE TEST (2026-11-25) - SANDBOX ONLY.
//   node scripts/leave-sandwich-test.js        (needs prisma/sandbox.db; no API needed)
//
// Founder 2026-11-25: "the sandwich method (Sunday is calculated) applies for one person and not for the new people - find the error".
// Cause found: utils/attendanceDays.js applySandwich() only looked at leave that was already APPROVED. People whose leave was still waiting
// for approval (most of the newer employees) got no sandwich day, although a leave applied is a leave day, approved or not (founder
// 2026-10-26). Now a weekly off / holiday between two full-day leaves counts when both leaves are approved (leave, as before) and, when at
// least one is still waiting, as a day that WAITS with it (Leave Under Review: unpaid until both are approved).
// ZZSW fixtures (Feb 2026, a month nobody is paid for here); removes every row it made. Refuses to run against dev.db.
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
const prisma = require('../src/db');
const D = require('../src/utils/attendanceDays');
const E = require('../src/utils/payrollEngine');
const LB = require('../src/utils/payrollLopBreakdown');

let pass = 0; let fail = 0;
const ok = (cond, name, extra = '') => { if (cond) { pass += 1; console.log(`  ok   ${name}`); } else { fail += 1; console.log(`  FAIL ${name} ${String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 400)}`); } };
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.001;
const RUN = Date.now().toString(36);
const made = { users: [], emps: [], holidays: [] };
let seq = 0;

async function newEmp(label, joined = '2024-01-01') {
  seq += 1;
  const code = `ZZSW${String(seq).padStart(2, '0')}-${RUN}`.slice(0, 40);
  const u = await prisma.user.create({ data: { name: `ZZSW ${label}`, email: `${code.toLowerCase()}@example.test`, passwordHash: 'x'.repeat(40), role: 'EMPLOYEE' } });
  made.users.push(u.id);
  const e = await prisma.employee.create({
    data: { userId: u.id, name: `ZZSW ${label}`, employeeCode: code, email: u.email, department: 'ZZSW', designation: 'Tester', employmentStatus: 'Active', dateOfJoining: new Date(`${joined}T00:00:00Z`) },
  });
  made.emps.push(e.id);
  return e;
}
const leave = (e, from, to, status, extra = {}) => prisma.leaveRequest.create({
  data: { employeeId: e.id, type: 'Casual Leave', fromDate: from, toDate: to || from, days: 1, status, reason: 'ZZSW', decidedBy: status === 'Approved' || status === 'Rejected' ? 'ZZSW Approver' : null, decidedAt: status === 'Approved' || status === 'Rejected' ? new Date() : null, ...extra },
});
// every Mon-Sat of Feb 2026 worked, except the dates in `skip`
const FEB = [];
for (let d = 1; d <= 28; d += 1) { const date = `2026-02-${String(d).padStart(2, '0')}`; if (new Date(`${date}T00:00:00Z`).getUTCDay() !== 0) FEB.push(date); }
async function worked(e, skip = []) {
  const rows = [...FEB, '2026-03-02'].filter((d) => !skip.includes(d)).map((date) => ({ employeeId: e.id, date, status: 'Present', checkIn: '09:00', checkOut: '18:30' }));
  await prisma.attendance.createMany({ data: rows });
}
async function rowsOf(e, cfgPatch = {}) {
  const full = await prisma.employee.findUnique({ where: { id: e.id } });
  const cfg = { ...(await prisma.hrConfig.findFirst()), ...cfgPatch };
  const { days } = await D.loadDays(prisma, { employees: [full], from: '2026-02-01', to: '2026-03-03', cfg });
  const rows = days(full);
  return { row: (date) => rows.find((r) => r.date === date), rows, full };
}

async function main() {
  console.log('Sandwich rule: a weekly off / holiday between two full-day leaves');
  const base = await newEmp('Base');
  await worked(base);
  const SAT = '2026-02-07'; const SUN = '2026-02-08'; const MON = '2026-02-09';

  // S1 both approved: leave, as before
  const s1 = await newEmp('ApprovedBoth');
  await worked(s1, [SAT, MON]);
  await leave(s1, SAT, null, 'Approved'); await leave(s1, MON, null, 'Approved');
  let r = await rowsOf(s1);
  ok(r.row(SUN).status === 'On Leave' && r.row(SUN).sandwich === true && r.row(SUN).leave === 1 && !r.row(SUN).sandwichWaiting, 'approved + approved: Sunday is sandwich leave (as before)', r.row(SUN));

  // S2 both waiting: the new behaviour
  const s2 = await newEmp('PendingBoth');
  await worked(s2, [SAT, MON]);
  await leave(s2, SAT, null, 'Pending'); await leave(s2, MON, null, 'Pending');
  r = await rowsOf(s2);
  const d2 = r.row(SUN);
  ok(d2.status === 'Leave Under Review' && d2.sandwich === true && d2.sandwichWaiting === true && d2.pending === 1 && d2.leave === 0 && d2.absent === 0 && d2.counted === true, 'pending + pending: Sunday is a sandwich day that waits (Leave Under Review, pending 1)', d2);
  ok(/sandwich/i.test(d2.reason) && /waiting for approval/i.test(d2.reason) && d2.kpi === 'onLeave', 'the reason says sandwich and waiting for approval');
  ok(d2.pendingLeaveId && d2.pendingLeaveId === r.row(MON).pendingLeaveId, 'it points at the waiting leave');

  // S3 / S4 one approved, one waiting
  const s3 = await newEmp('ApprovedThenPending');
  await worked(s3, [SAT, MON]);
  await leave(s3, SAT, null, 'Approved'); await leave(s3, MON, null, 'Pending');
  r = await rowsOf(s3);
  ok(r.row(SUN).status === 'Leave Under Review' && r.row(SUN).sandwichWaiting === true, 'approved Saturday + waiting Monday: Sunday waits');
  const s4 = await newEmp('PendingThenApproved');
  await worked(s4, [SAT, MON]);
  await leave(s4, SAT, null, 'Pending'); await leave(s4, MON, null, 'Approved');
  r = await rowsOf(s4);
  ok(r.row(SUN).status === 'Leave Under Review' && r.row(SUN).sandwichWaiting === true, 'waiting Saturday + approved Monday: Sunday waits');

  // S5 a rejected neighbour: no leave on that side, so no sandwich
  const s5 = await newEmp('PendingThenRejected');
  await worked(s5, [SAT, MON]);
  await leave(s5, SAT, null, 'Pending'); await leave(s5, MON, null, 'Rejected');
  r = await rowsOf(s5);
  ok(r.row(SUN).status === 'Weekly Off' && !r.row(SUN).sandwich, 'waiting Saturday + rejected Monday: Sunday stays a week off');

  // S6 a half-day neighbour is not a full leave day
  const s6 = await newEmp('PendingHalf');
  await worked(s6, [SAT, MON]);
  await leave(s6, SAT, null, 'Approved'); await leave(s6, MON, null, 'Pending', { days: 0.5, reason: '[Half day: First Half] ZZSW' });
  r = await rowsOf(s6);
  ok(r.row(SUN).status === 'Weekly Off' && !r.row(SUN).sandwich, 'approved Saturday + a waiting HALF day on Monday: Sunday stays a week off');

  // S7 a holiday and a Sunday in a row between two waiting leaves
  const FRI = '2026-02-20'; const HOL = '2026-02-21'; const SUN2 = '2026-02-22'; const MON2 = '2026-02-23';
  const hol = await prisma.holiday.create({ data: { name: 'ZZSW Holiday', date: HOL, type: 'Company' } }).catch(() => null);
  if (hol) made.holidays.push(hol.id);
  const s7 = await newEmp('HolidayRun');
  await worked(s7, [FRI, HOL, MON2]);
  await leave(s7, FRI, null, 'Pending'); await leave(s7, MON2, null, 'Pending');
  r = await rowsOf(s7);
  ok(r.row(HOL).status === 'Leave Under Review' && r.row(SUN2).status === 'Leave Under Review' && r.row(HOL).sandwichWaiting && r.row(SUN2).sandwichWaiting, 'holiday + Sunday between two waiting leaves: both days wait', [r.row(HOL).status, r.row(SUN2).status]);
  ok(/holiday \(ZZSW Holiday\)/.test(r.row(HOL).note), 'the holiday is named');

  // S8 a NEW employee behaves like an old one
  const s8 = await newEmp('NewJoiner', '2026-01-20');
  await worked(s8, [SAT, MON]);
  await leave(s8, SAT, null, 'Pending'); await leave(s8, MON, null, 'Pending');
  r = await rowsOf(s8);
  ok(r.row(SUN).status === 'Leave Under Review' && r.row(SUN).sandwichWaiting === true, 'a new joiner with waiting leave gets the same sandwich day as anyone else');
  const s8b = await newEmp('NewJoinerApproved', '2026-01-20');
  await worked(s8b, [SAT, MON]);
  await leave(s8b, SAT, null, 'Approved'); await leave(s8b, MON, null, 'Approved');
  r = await rowsOf(s8b);
  ok(r.row(SUN).status === 'On Leave' && r.row(SUN).sandwich === true, 'a new joiner with approved leave gets sandwich leave');

  // S9 the switch
  r = await rowsOf(s2, { sandwichLeave: false });
  ok(r.row(SUN).status === 'Weekly Off' && !r.row(SUN).sandwich, 'rule switched off: no sandwich day, even with waiting leave');

  // S10 what payroll reads (daysLop): approved both = 2 unpaid beyond the 1 paid leave day; waiting both = 3 (all three days wait); off = 2
  const policy = await E.getPolicy();
  const lop = async (e, p = policy) => (await E.attendanceDefaults([await prisma.employee.findUnique({ where: { id: e.id } })], '2026-02', p)).map.get(e.id).daysLop;
  const paid = Number(policy.paidLeaveDaysPerMonth || 0);
  ok(near(await lop(s1), Math.max(0, 3 - paid)), `payroll, approved + approved: 3 leave days, ${paid} paid, ${Math.max(0, 3 - paid)} LOP`, await lop(s1));
  ok(near(await lop(s2), 3), 'payroll, waiting + waiting: Saturday, Sunday and Monday all wait = 3 LOP until approved', await lop(s2));
  ok(near(await lop(s2, { ...policy, sandwichLeave: false }), 2), 'payroll, rule off: only the 2 waiting working days = 2 LOP', await lop(s2, { ...policy, sandwichLeave: false }));

  // S11 once the waiting leaves are approved the Sunday turns into sandwich leave by itself
  await prisma.leaveRequest.updateMany({ where: { employeeId: s2.id, status: 'Pending' }, data: { status: 'Approved', decidedBy: 'ZZSW Approver', decidedAt: new Date() } });
  r = await rowsOf(s2);
  ok(r.row(SUN).status === 'On Leave' && r.row(SUN).sandwich === true && !r.row(SUN).sandwichWaiting, 'after both leaves are approved the same Sunday reads as sandwich leave');
  await prisma.leaveRequest.updateMany({ where: { employeeId: s2.id }, data: { status: 'Pending', decidedBy: null, decidedAt: null } });

  // S12 the LOP dates screen explains it
  const fullS2 = await prisma.employee.findUnique({ where: { id: s2.id } });
  const b = await LB.forEntry({ id: null, employeeId: s2.id, employee: fullS2, month: '2026-02', status: 'DRAFT', attendanceSource: 'ATTENDANCE', daysLop: 3, workingDays: 28, daysPresent: 25 }, { desk: true });
  const sun = b.dates.find((x) => x.date === SUN);
  ok(sun && near(sun.lop, 1) && sun.reasons.some((x) => x.code === 'pending' && /sandwich/i.test(x.text)), 'the LOP dates screen lists the Sunday and says it is a sandwich day waiting for approval', sun && sun.reasons);
  ok(near(b.listedLop, 3) && near(b.attendanceLop, 3), 'and its dates add up to the payroll number (3)');
}

(async () => {
  try {
    await main();
  } catch (e) {
    console.error(e);
    fail += 1;
  } finally {
    try {
      await prisma.leaveRequest.deleteMany({ where: { employeeId: { in: made.emps } } });
      await prisma.attendance.deleteMany({ where: { employeeId: { in: made.emps } } });
      if (made.holidays.length) await prisma.holiday.deleteMany({ where: { id: { in: made.holidays } } });
      await prisma.employee.deleteMany({ where: { id: { in: made.emps } } });
      await prisma.user.deleteMany({ where: { id: { in: made.users } } });
    } catch (e) { console.error('cleanup failed:', e.message); }
    const left = await prisma.employee.count({ where: { employeeCode: { startsWith: 'ZZSW' } } }).catch(() => -1);
    console.log(`\nZZSW test employees left in the sandbox: ${left}`);
    console.log(`${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
