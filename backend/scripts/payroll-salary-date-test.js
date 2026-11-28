#!/usr/bin/env node
// ---------------------------------------------------------------------------
// SALARY CREDIT DATE TEST (founder 2026-11-28) - SANDBOX ONLY.
//   node scripts/payroll-salary-date-test.js      (needs the sandbox API: TL_API, default http://localhost:4011, and prisma/sandbox.db)
// utils/payrollSalaryDate.js: 2 or more leave days applied after the pay period -> the 10th of the next month, else the month's last
// day; shown in the list, Details and export; off without the setting. ZZPD fixtures, removed after; the setting is put back.
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
const API = `${String(process.env.TL_API || 'http://localhost:4011').replace(/\/+$/, '').replace(/\/api$/, '')}/api`;
if (/:4010(\/|$)/.test(API)) { console.error('Refusing: 4010 is the real server.'); process.exit(2); }
const prisma = require('../src/db');
const jwt = require('jsonwebtoken');
const SD = require('../src/utils/payrollSalaryDate');

let pass = 0; let fail = 0;
const ok = (cond, name, extra = '') => { if (cond) { pass += 1; console.log(`  ok   ${name}`); } else { fail += 1; console.log(`  FAIL ${name} ${String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 500)}`); } };
const made = { emps: [], users: [] };
const MONTH = '2027-05'; // a payroll month nobody has records in; window 16 - 31 May 2027
const tok = (u) => jwt.sign({ id: u.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
async function call(user, url, raw = false) {
  let r;
  for (let i = 0; i < 10; i += 1) {
    try { r = await fetch(`${API}${url}`, { headers: { Authorization: `Bearer ${tok(user)}` } }); break; } catch (e) { if (i === 9) throw e; await new Promise((res) => setTimeout(res, 3000)); }
  }
  const buf = Buffer.from(await r.arrayBuffer());
  if (raw) return { status: r.status, text: buf.toString('utf8') };
  let body = null; try { body = JSON.parse(buf.toString('utf8')); } catch { /* not json */ }
  return { status: r.status, body };
}

async function main() {
  const had = await prisma.appSetting.findUnique({ where: { key: SD.KEY } });
  try {
    // ---- pure ------------------------------------------------------------------------------------------
    const win = { from: '2027-05-16', to: '2027-05-31' };
    const work = (d) => new Date(`${d}T00:00:00Z`).getUTCDay() !== 0;
    const L = (fromDate, toDate, days, status = 'Approved') => ({ fromDate, toDate, days, status });
    const count = (list) => SD.countLeave(list, win, work).days;
    ok(count([]) === 0 && count([L('2027-05-17', '2027-05-17', 1)]) === 1, 'P01 none = 0, one day = 1');
    ok(count([L('2027-05-17', '2027-05-18', 2)]) === 2 && count([L('2027-05-17', '2027-05-17', 1), L('2027-05-25', '2027-05-25', 1, 'Pending')]) === 2, 'P02 two days in one request, or two requests (one waiting) = 2');
    ok(count([L('2027-05-17', '2027-05-18', 2, 'Rejected'), L('2027-05-19', '2027-05-19', 1, 'Cancelled')]) === 0, 'P03 rejected and cancelled do not count');
    ok(count([L('2027-05-22', '2027-05-24', 3)]) === 2, 'P04 a Sunday inside a leave is not counted (Sat 22, Mon 24)');
    ok(count([L('2027-05-17', '2027-05-17', 0.5), L('2027-05-18', '2027-05-18', 1)]) === 1.5 && count([L('2027-05-17', '2027-05-18', 1.5)]) === 1.5, 'P05 half days');
    ok(count([L('2027-05-17', '2027-05-17', 1), L('2027-05-17', '2027-05-17', 1, 'Pending')]) === 1, 'P06 one date twice counts once');
    ok(count([L('2027-05-13', '2027-05-18', 5)]) === 2 && count([L('2027-05-31', '2027-06-02', 3)]) === 1, 'P07 only the days inside the window (13-18 May: 17 and 18 count)');
    const rule = SD.ruleFrom(JSON.stringify({ on: true, from: '2026-11' }));
    ok(rule && rule.leaveDays === 2 && rule.lateDay === 10 && SD.ruleFrom('{"on":false,"from":"2026-11"}') === null && SD.ruleFrom('x') === null, 'P08 the setting: defaults 2 days / 10th; off or unreadable = no rule');
    ok(SD.dateFor('2026-11', 0, rule) === '2026-11-30' && SD.dateFor('2026-11', 1.5, rule) === '2026-11-30' && SD.dateFor('2026-11', 2, rule) === '2026-12-10' && SD.dateFor('2026-11', 5, rule) === '2026-12-10', 'P09 November: under 2 = 30 Nov, 2 or more = 10 Dec');
    ok(SD.dateFor('2026-12', 2, rule) === '2027-01-10' && SD.dateFor('2026-12', 0, rule) === '2026-12-31' && SD.dateFor('2027-02', 0, rule) === '2027-02-28', 'P10 year end and February');

    // ---- through the API ---------------------------------------------------------------------------------
    const admin = await prisma.user.create({ data: { name: 'ZZPD Admin', email: `zzpd-admin-${Date.now().toString(36)}@example.test`, passwordHash: 'x'.repeat(40), role: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN', accountsRole: 'SUPER_ADMIN', atsRole: 'NONE', hrmsAccess: true, accountsAccess: true, atsAccess: false, status: 'Active' } });
    made.users.push(admin.id);
    const mk = async (code, name) => {
      const e = await prisma.employee.create({ data: { employeeCode: code, name, employmentStatus: 'Active', department: 'IT', dateOfJoining: new Date('2026-01-05T00:00:00Z') } });
      made.emps.push(e.id);
      await prisma.employeePayrollRun.create({ data: { employeeId: e.id, month: MONTH, year: 2027, monthNum: 5, payMode: 'Stipend', workingDays: 31, daysPresent: 31, daysLop: 0, grossPay: 10000, earnedGross: 10000, netPay: 10000, status: 'DRAFT' } });
      return e;
    };
    const a = await mk('ZZPD1', 'ZZPD No Leave'); const b = await mk('ZZPD2', 'ZZPD Two Leaves'); const c = await mk('ZZPD3', 'ZZPD One Leave');
    const lv = (employeeId, fromDate, toDate, days, status) => prisma.leaveRequest.create({ data: { employeeId, type: 'Casual Leave', fromDate, toDate, days, status, reason: 'ZZPD' } });
    await lv(b.id, '2027-05-18', '2027-05-18', 1, 'Approved'); await lv(b.id, '2027-05-20', '2027-05-20', 1, 'Pending');
    await lv(c.id, '2027-05-19', '2027-05-19', 1, 'Approved'); await lv(c.id, '2027-05-21', '2027-05-21', 1, 'Rejected');

    await prisma.appSetting.deleteMany({ where: { key: SD.KEY } });
    const off = await call(admin, `/payroll/entries?month=${MONTH}`);
    const offRow = off.body && off.body.entries.find((x) => x.employee.employeeCode === 'ZZPD2');
    ok(off.status === 200 && off.body.salaryDates === null && offRow && offRow.salaryDate === null, 'A01 no setting: no salary date anywhere', [off.status, off.body && off.body.salaryDates]);
    await prisma.appSetting.create({ data: { key: SD.KEY, value: JSON.stringify({ on: true, from: '2026-11', leaveDays: 2, lateDay: 10 }) } });
    const on = await call(admin, `/payroll/entries?month=${MONTH}`);
    const row = (code) => on.body.entries.find((x) => x.employee.employeeCode === code);
    ok(on.status === 200 && on.body.salaryDates.onTime === '2027-05-31' && on.body.salaryDates.late === '2027-06-10' && on.body.salaryDates.window.from === '2027-05-16' && on.body.salaryDates.window.to === '2027-05-31', 'A02 the month header: 31 May / 10 Jun, window 16-31 May', on.body && on.body.salaryDates);
    ok(row('ZZPD1').salaryDate.date === '2027-05-31' && row('ZZPD1').salaryDate.leaveDays === 0, 'A03 no leave = 31 May', row('ZZPD1').salaryDate);
    ok(row('ZZPD2').salaryDate.date === '2027-06-10' && row('ZZPD2').salaryDate.late === true && row('ZZPD2').salaryDate.leaveDays === 2 && row('ZZPD2').salaryDate.dates.some((x) => x.waiting), 'A04 two applied days = 10 Jun, the waiting one marked', row('ZZPD2').salaryDate);
    ok(row('ZZPD3').salaryDate.date === '2027-05-31' && row('ZZPD3').salaryDate.leaveDays === 1, 'A05 one approved + one rejected = 31 May', row('ZZPD3').salaryDate);
    ok(row('ZZPD2').netPay === 10000, 'A06 no amount changes');
    const det = await call(admin, `/payroll/entries/${row('ZZPD2').id}`);
    ok(det.status === 200 && det.body.salaryDate && det.body.salaryDate.date === '2027-06-10' && det.body.salaryDate.window.to === '2027-05-31' && det.body.salaryDate.leaveDays === 2 && det.body.salaryDate.threshold === 2, 'A07 Details carries the date, the window and the person\'s own leave days', det.body && det.body.salaryDate);
    for (const [code, days] of [['ZZPD1', 0], ['ZZPD3', 1]]) {
      const d2 = await call(admin, `/payroll/entries/${row(code).id}`);
      ok(d2.status === 200 && d2.body.salaryDate.leaveDays === days && d2.body.salaryDate.date === '2027-05-31', `A07b Details of ${code}: ${days} leave day(s), 31 May`, d2.body && d2.body.salaryDate);
    }
    const csv = await call(admin, `/payroll/runs/${MONTH}/export?format=csv`, true);
    const lines = csv.text.split(/\r?\n/);
    ok(csv.status === 200 && /Salary date/.test(lines[0]) && lines.some((l) => /ZZPD2/.test(l) && /2027-06-10/.test(l) && /waiting/.test(l)) && lines.some((l) => /ZZPD1/.test(l) && /2027-05-31/.test(l)), 'A08 the export has the salary date, days and dates', lines[0]);
    const before = await call(admin, '/payroll/entries?month=2026-10');
    ok(before.status === 200 && before.body.salaryDates === null, 'A09 months before the start have no salary date');
  } finally {
    await prisma.leaveRequest.deleteMany({ where: { employeeId: { in: made.emps } } });
    await prisma.employeePayrollRun.deleteMany({ where: { employeeId: { in: made.emps } } });
    await prisma.employee.deleteMany({ where: { id: { in: made.emps } } });
    await prisma.auditLog.deleteMany({ where: { userId: { in: made.users } } });
    await prisma.user.deleteMany({ where: { id: { in: made.users } } });
    await prisma.appSetting.deleteMany({ where: { key: SD.KEY } });
    if (had) await prisma.appSetting.create({ data: { key: had.key, value: had.value } });
    await prisma.$disconnect();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
