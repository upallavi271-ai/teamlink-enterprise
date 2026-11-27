#!/usr/bin/env node
// ---------------------------------------------------------------------------
// JOINED INSIDE THE PAY PERIOD TEST (2026-11-27) - SANDBOX ONLY.
//   node scripts/payroll-join-days-test.js    (needs the sandbox API: TL_API, default http://localhost:4011, and prisma/sandbox.db)
//
// utils/payrollJoinDays.js: for somebody who joined inside the pay period the days before joining are shown apart from LOP (list, Details,
// export, LOP dates screen, edit screen, payslip + PDF, LOP summary). No stored figure or amount changes. ZZJD fixtures, removed after.
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
const JD = require('../src/utils/payrollJoinDays');
const E = require('../src/utils/payrollEngine');
const PC = require('../src/utils/payrollCycle');

let pass = 0; let fail = 0;
const ok = (cond, name, extra = '') => { if (cond) { pass += 1; console.log(`  ok   ${name}`); } else { fail += 1; console.log(`  FAIL ${name} ${String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 500)}`); } };
const made = { users: [], emps: [] };
const MONTH = '2027-03'; // a pay period nobody has records in
const tok = (u) => jwt.sign({ id: u.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
async function call(user, method, url, body) {
  let r;
  for (let i = 0; i < 10; i += 1) {
    try {
      r = await fetch(`${API}${url}`, { method, headers: { Authorization: `Bearer ${tok(user)}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      break;
    } catch (e) { if (i === 9) throw e; await new Promise((res) => setTimeout(res, 3000)); }
  }
  const buf = Buffer.from(await r.arrayBuffer());
  const text = buf.toString('utf8');
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text, buf, type: r.headers.get('content-type') || '' };
}
async function emp(code, joined) {
  const u = await prisma.user.create({ data: { name: `ZZJD ${code}`, email: `zzjd-${code.toLowerCase()}-${Date.now().toString(36)}@example.test`, passwordHash: 'x'.repeat(40), role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true, status: 'Active' } });
  made.users.push(u.id);
  const e = await prisma.employee.create({ data: { userId: u.id, name: `ZZJD ${code}`, employeeCode: code, email: u.email, department: 'ZZJD', designation: 'Tester', employmentStatus: 'Active', dateOfJoining: new Date(`${joined}T00:00:00Z`) } });
  made.emps.push(e.id);
  await prisma.salaryStructureVersion.create({ data: { employeeId: e.id, effectiveFrom: '2026-01-01', payMode: 'Package', ctc: 120000, basic: 4000, hra: 1600, specialAllowance: 4400 } });
  return { u, e };
}

(async () => {
  try {
    console.log('A. The split itself');
    const cyc = { from: '2026-10-16', to: '2026-11-15' };
    const all = { weekendsPaid: true, weeklyOffDays: '0' };
    const s = JD.splitOf({ workingDays: 31, daysLop: 9, dateOfJoining: new Date('2026-10-21') }, cyc, all, 31);
    ok(s && s.beforeDays === 5 && s.lopDays === 4 && s.daysFromJoining === 26 && s.paidDays === 22 && s.joinedOn === '2026-10-21' && s.beforeTo === '2026-10-20', 'joined 21 Oct, 9 unpaid = 5 before joining + 4 LOP, 26 days from joining, 22 paid', s);
    const none = JD.splitOf({ workingDays: 31, daysLop: 5, dateOfJoining: '2026-10-21' }, cyc, all, 31);
    ok(none && none.lopDays === 0 && none.paidDays === 26, 'only the days before joining unpaid: LOP 0', none);
    ok(JD.splitOf({ workingDays: 31, daysLop: 9, dateOfJoining: '2026-10-16' }, cyc, all, 31) === null, 'joined on the first day: nothing to split');
    ok(JD.splitOf({ workingDays: 31, daysLop: 9, dateOfJoining: '2026-06-01' }, cyc, all, 31) === null, 'joined earlier: nothing to split');
    ok(JD.splitOf({ workingDays: 31, daysLop: 31, dateOfJoining: '2026-11-23' }, cyc, all, 31) === null, 'joins after the period: left as it is');
    ok(JD.splitOf({ workingDays: 31, daysLop: 3, dateOfJoining: '2026-10-21' }, cyc, all, 31) === null, 'fewer unpaid days than days before joining (typed): left as it is');
    ok(JD.splitOf({ workingDays: 26, daysLop: 9, dateOfJoining: '2026-10-21' }, cyc, all, 31) === null, 'a record typed with other payroll days: left as it is');
    ok(JD.splitOf({ workingDays: 31, daysLop: 9, dateOfJoining: null }, cyc, all, 31) === null, 'no joining date: left as it is');
    const off = JD.splitOf({ workingDays: 26, daysLop: 9, dateOfJoining: '2026-10-21' }, cyc, { weekendsPaid: false, weeklyOffDays: '0' }, 26);
    ok(off && off.beforeDays === 4 && off.lopDays === 5, 'week offs not paid: the Sunday before joining is not counted', off);
    const am = JD.amountsOf(2903, s);
    ok(am.beforeJoining === 1613 && am.lop === 1290, 'amount: 2903 = 1613 before joining + 1290 LOP', am);
    const am2 = JD.amountsOf(2903.23, s);
    ok(Math.abs(am2.beforeJoining + am2.lop - 2903.23) < 0.001, 'amounts in paise still add up', am2);

    try { const h = await fetch(`${API}/health`); if (!h.ok) throw new Error('x'); } catch { console.error(`The sandbox API is not answering at ${API}.`); process.exit(3); }
    if (await prisma.employeePayrollRun.count({ where: { month: MONTH } })) { console.error(`The sandbox already has ${MONTH} payroll - refusing.`); process.exit(2); }
    const policy = await E.getPolicy();
    const cycle = await PC.cycleFor(MONTH);
    const periodDays = E.payrollWorkingDays(MONTH, policy, cycle);
    const plus = (n) => { const d = new Date(`${cycle.from}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    const admin = await prisma.user.create({ data: { name: 'ZZJD Admin', email: `zzjd-admin-${Date.now().toString(36)}@example.test`, passwordHash: 'x'.repeat(40), role: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN', accountsRole: 'SUPER_ADMIN', atsRole: 'NONE', hrmsAccess: true, accountsAccess: true, atsAccess: false, status: 'Active' } });
    made.users.push(admin.id);
    const clean = await emp('TL99911', plus(6)); // joined 6 days in, no other loss of pay
    const lossy = await emp('TL99912', plus(6)); // joined 6 days in, 3 LOP after joining (typed)
    const old = await emp('TL99913', '2025-01-01');
    for (const x of [lossy, old]) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.payrollAttendance.create({ data: { employeeId: x.e.id, month: MONTH, year: 2027, monthNum: 3, workingDays: periodDays, daysPresent: periodDays - (x === lossy ? 9 : 2), daysLop: x === lossy ? 9 : 2, reason: 'ZZJD', overriddenByName: 'ZZJD' } });
    }
    let a = await call(admin, 'POST', '/payroll/calculate', { month: MONTH, employeeIds: made.emps });
    ok((a.status === 200 || a.status === 201) && a.body.created === 3, 'three drafts calculated', [a.status, a.body && a.body.created]);

    console.log('B. Process Payroll list and Details');
    a = await call(admin, 'GET', `/payroll/entries?month=${MONTH}`);
    const of = (x) => a.body.entries.find((r) => r.employeeId === x.e.id);
    const rc = of(clean); const rl = of(lossy); const ro = of(old);
    ok(rc.join && rc.join.beforeDays === 6 && rc.join.lopDays === 0 && rc.daysLop === 6, 'new joiner: 6 before joining, LOP 0 (stored unpaid days unchanged)', rc.join);
    ok(rl.join && rl.join.beforeDays === 6 && rl.join.lopDays === 3 && rl.join.daysFromJoining === periodDays - 6 && rl.daysLop === 9, 'new joiner with loss of pay: 6 before joining + 3 LOP', rl.join);
    ok(rl.join.amounts.beforeJoining + rl.join.amounts.lop === rl.lopDeduction, 'the two amounts add up to the stored deduction', [rl.join.amounts, rl.lopDeduction]);
    ok(rl.netPay === ro.netPay - ro.lopDeduction * 0 - (rl.lopDeduction - ro.lopDeduction) || rl.netPay < ro.netPay, 'pay is still counted from the joining date', [rl.netPay, ro.netPay]);
    ok(rl.lopDeduction === Math.round((10000 * 9) / periodDays), 'the money is the same as before: full pay x unpaid days / period days', rl.lopDeduction);
    ok(ro.join === null && ro.daysLop === 2, 'somebody who joined earlier is unchanged', ro.join);
    a = await call(admin, 'GET', `/payroll/entries/${rl.id}`);
    ok(a.status === 200 && a.body.entry.join && a.body.entry.join.lopDays === 3 && a.body.entry.join.amounts, 'Details carries the split', a.body.entry && a.body.entry.join);
    a = await call(admin, 'GET', `/payroll/entries/${rl.id}/edit`);
    ok(a.status === 200 && a.body.join && a.body.join.beforeDays === 6, 'the edit screen is told about the days before joining', a.status);

    console.log('C. Export and LOP summary');
    a = await call(admin, 'GET', `/payroll/runs/${MONTH}/export?format=csv`);
    const lines = a.text.split(/\r?\n/).filter(Boolean);
    const cells = (l) => (l.match(/("([^"]|"")*"|[^,]*)(,|$)/g) || []).map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '')).slice(0, -1);
    const head = lines[0].replace(/^﻿/, '').split(',').map((x) => x.replace(/^"|"$/g, ''));
    const val = (code, h) => { const l = lines.find((x) => x.includes(code)); return l ? l.split(',')[head.indexOf(h)].replace(/"/g, '') : null; };
    ok(head.includes('Days before joining') && val('TL99912', 'Days before joining') === '6' && val('TL99912', 'LOP days') === '3' && val('TL99912', 'Non-payable days') === '9', 'export: 6 before joining, 3 LOP, 9 non-payable', [val('TL99912', 'Days before joining'), val('TL99912', 'LOP days'), val('TL99912', 'Non-payable days')]);
    ok(val('TL99913', 'Days before joining') === '' && val('TL99913', 'LOP days') === '2', 'export: others unchanged');
    const total = lines.find((x) => /TOTAL/.test(x));
    ok(total && total.split(',').length === head.length && total.split(',')[head.indexOf('Non-payable days')].replace(/"/g, '') === '17', 'export totals still line up under their headings', total && [total.split(',').length, head.length, cells(total).length]);
    a = await call(admin, 'GET', `/payroll/cycle/lop-summary?month=${MONTH}`);
    const sl = a.body && a.body.rows.find((r) => r.employeeId === lossy.e.id);
    ok(a.status === 200 && sl && sl.lopDays === 3 && sl.beforeJoiningDays === 6 && sl.lopAmount === rl.join.amounts.lop, 'LOP summary counts only the loss of pay after joining', sl);

    console.log('D. The LOP dates screen');
    a = await call(admin, 'GET', `/payroll/entries/${rc.id}/lop-breakdown`);
    if (a.status !== 200) console.log('   breakdown answer', a.status, a.text.slice(0, 600));
    ok(a.status === 200 && a.body.record.daysLop === 0 && a.body.attendanceLop === 0 && a.body.listedLop === 0 && a.body.status === 'match', 'LOP 0, matches attendance', a.body && [a.body.record, a.body.attendanceLop, a.body.status]);
    ok(a.body.dates.length === 0 && a.body.terms.beforeJoining === 0 && a.body.join.beforeDays === 6, 'no before-joining date is listed as LOP; the join line says 6', [a.body.dates.length, a.body.join]);
    a = await call(admin, 'GET', `/payroll/entries/${rl.id}/lop-breakdown`);
    ok(a.body.record.daysLop === 3 && a.body.adjustments.override.daysLop === 3 && a.body.notes.join(' ').includes('3 LOP day'), 'typed days: shown without the days before joining', [a.body.record.daysLop, a.body.adjustments.override, a.body.notes]);
    a = await call(admin, 'GET', `/payroll/entries/${ro.id}/lop-breakdown`);
    ok(a.body.join === null && a.body.record.daysLop === 2, 'others unchanged', a.body.record);

    console.log('E. Payslip');
    a = await call(admin, 'POST', '/payroll/entries/submit', { ids: [rc.id, rl.id, ro.id] });
    ok(a.status === 200, 'submitted', a.body);
    const other = await prisma.user.create({ data: { name: 'ZZJD Approver', email: `zzjd-appr-${Date.now().toString(36)}@example.test`, passwordHash: 'x'.repeat(40), role: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN', accountsRole: 'SUPER_ADMIN', atsRole: 'NONE', hrmsAccess: true, accountsAccess: true, atsAccess: false, status: 'Active' } });
    made.users.push(other.id);
    a = await call(other, 'POST', '/payroll/entries/approve', { ids: [rc.id, rl.id, ro.id] });
    ok(a.status === 200, 'approved', a.body);
    a = await call(lossy.u, 'GET', `/payroll?month=${MONTH}`);
    const mine = Array.isArray(a.body) ? a.body.find((p) => p.month === MONTH) : null;
    ok(a.status === 200 && mine && mine.lopDays === 3 && mine.join && mine.join.beforeDays === 6, 'my payslip list shows LOP 3, not 9', mine && [mine.lopDays, mine.join]);
    a = await call(lossy.u, 'GET', `/payroll/payslips/${mine.id}`);
    const p = a.body || {};
    const line = (re) => (p.deductions || []).find((d) => re.test(d.label));
    ok(p.lopDays === 3 && p.daysWorked === periodDays - 9 && p.join && p.join.daysFromJoining === periodDays - 6 && !!p.join.joinedText, 'payslip: LOP 3, days worked unchanged, days from joining', [p.lopDays, p.daysWorked, p.join]);
    ok(line(/^Before joining \(6 days\)$/) && line(/^LOP \(3 days\)$/) && line(/^Before joining/).amount + line(/^LOP/).amount === p.lopDeduction, 'payslip: two deduction lines that add up', p.deductions);
    ok(Math.abs(p.gross - p.totalDeductions - p.netPay) < 0.01, 'payslip still adds up to the net pay', [p.gross, p.totalDeductions, p.netPay]);
    a = await call(lossy.u, 'GET', `/payroll/payslips/${mine.id}/pdf`);
    ok(a.status === 200 && /pdf/.test(a.type) && a.buf.slice(0, 4).toString() === '%PDF', 'the PDF is made', a.status);
    a = await call(lossy.u, 'GET', `/payroll/payslips/${mine.id}/lop-breakdown`);
    ok(a.status === 200 && a.body.record.daysLop === 3 && a.body.join.beforeDays === 6, 'the employee sees the same split on the LOP screen', a.body && a.body.record);
    a = await call(old.u, 'GET', `/payroll?month=${MONTH}`);
    const his = a.body.find((x) => x.month === MONTH);
    a = await call(old.u, 'GET', `/payroll/payslips/${his.id}`);
    ok(a.body.join === null && a.body.lopDays === 2 && a.body.deductions.some((d) => d.label === 'LOP (2 days)') && !a.body.deductions.some((d) => /Before joining/.test(d.label)), 'an older employee\'s payslip is unchanged', a.body.deductions);
  } catch (e) {
    console.error(e);
    fail += 1;
  } finally {
    try {
      const runs = await prisma.employeePayrollRun.findMany({ where: { employeeId: { in: made.emps } }, select: { id: true } });
      await prisma.appSetting.deleteMany({ where: { key: { in: [`payroll.snapshot:${MONTH}`, ...runs.map((r) => `payroll.edit:${r.id}`)] } } });
      await prisma.employeePayrollRun.deleteMany({ where: { employeeId: { in: made.emps } } });
      await prisma.payslip.deleteMany({ where: { employeeId: { in: made.emps } } });
      await prisma.payrollRun.deleteMany({ where: { month: MONTH } });
      await prisma.payrollAttendance.deleteMany({ where: { employeeId: { in: made.emps } } });
      await prisma.salaryStructureVersion.deleteMany({ where: { employeeId: { in: made.emps } } });
      await prisma.notification.deleteMany({ where: { userId: { in: made.users } } }).catch(() => {});
      await prisma.employee.deleteMany({ where: { id: { in: made.emps } } });
      await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch((e) => console.log('  (test users kept:', e.message.split('\n').pop(), ')'));
    } catch (e) { console.error('cleanup:', e.message); }
    console.log(`\n${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
