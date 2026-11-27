#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE SALARY BREAKUP OF THE DETAILS WINDOW (2026-11-27) - SANDBOX ONLY, reads only.
//   node scripts/payroll-salary-lines-test.js    (prisma/sandbox.db; TL_API for the route check, default http://localhost:4011; --no-api skips it)
//
// utils/payrollSalaryLines.js: for EVERY payroll record on file the lines must add up to the stored figures (gross, loss of pay, earned,
// deductions, net pay, company share); plus made-up records for the rounding, the added lines and the pay-register month.
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
const prisma = require('../src/db');
const jwt = require('jsonwebtoken');
const SL = require('../src/utils/payrollSalaryLines');
const PEdit = require('../src/utils/payrollEdit');
const REG = require('../src/utils/payrollRegister');

let pass = 0; let fail = 0;
const ok = (cond, name, extra = '') => { if (cond) { pass += 1; console.log(`  ok   ${name}`); } else { fail += 1; console.log(`  FAIL ${name} ${String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 600)}`); } };
const near = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.011;
// every promise the screen makes about one record
function check(e, l) {
  const bad = [];
  const want = (c, w) => { if (!c) bad.push(w); };
  want(near(l.totals.full, e.grossPay), `full ${l.totals.full} != gross ${e.grossPay}`);
  if (l.imported) {
    // the register rounds its loss of pay to the rupee: its own earned pay is the figure
    want(near(l.totals.earned, e.earnedGross), `earned ${l.totals.earned} != register ${e.earnedGross}`);
    want(near(l.totals.full - l.totals.cut, l.totals.earned), 'totals');
  } else {
    want(near(l.totals.cut, e.lopDeduction), `cut ${l.totals.cut} != LOP ${e.lopDeduction}`);
    want(near(l.totals.earned, e.grossPay - e.lopDeduction), `earned ${l.totals.earned}`);
  }
  want(l.earnings.every((x) => near(x.full - x.cut, x.earned)), 'a row does not add up');
  want(near(l.earnings.reduce((n, x) => n + x.earned, 0), l.totals.earned), 'rows do not add up to the total');
  if (l.imported) want(near(l.deductionsTotal, e.pfEmployee + e.esiEmployee + e.professionalTax + e.tds + e.otherDeductions), 'register deductions');
  else want(near(l.deductionsTotal, e.totalDeductions - e.lopDeduction), `deductions ${l.deductionsTotal} != ${e.totalDeductions} - ${e.lopDeduction}`);
  want(near(l.deductions.reduce((n, x) => n + x.amount, 0), l.deductionsTotal), 'deduction rows do not add up');
  want(near(l.netPay, e.netPay), 'net');
  want(near(l.totals.earned - l.deductionsTotal, e.netPay) === l.addsUp, 'addsUp flag wrong');
  want(near(l.employerTotal, e.pfEmployer + e.esiEmployer + (e.gratuity || 0)), 'company share');
  want(near(l.costThisMonth, l.totals.earned + l.employerTotal), 'cost to company');
  want(near(l.days.paidDays + l.days.unpaidDays, e.workingDays) || e.daysLop > e.workingDays, 'days');
  return bad;
}

(async () => {
  try {
    console.log('A. Every payroll record on file');
    const regFrom = await REG.registerFrom();
    const entries = await prisma.employeePayrollRun.findMany({ include: { employee: { select: { employeeCode: true } } } });
    const problems = []; const odd = []; let negative = 0;
    for (const e of entries) {
      // eslint-disable-next-line no-await-in-loop
      const state = await PEdit.readState(e.id);
      const l = SL.salaryLines(e, { state, register: REG.registerOn(e.month, regFrom) });
      const bad = check(e, l);
      if (bad.length) problems.push(`${e.month} ${e.employee.employeeCode}: ${bad.join(', ')}`);
      if (!l.addsUp) odd.push(`${e.month} ${e.employee.employeeCode}: earned ${l.totals.earned} - ${l.deductionsTotal} vs net ${e.netPay}`);
      if (l.earnings.some((x) => x.earned < -0.001 && x.key !== 'further' && x.key !== 'rounding')) negative += 1;
    }
    ok(entries.length > 0 && problems.length === 0, `the lines add up to the stored figures for all ${entries.length} records`, problems.slice(0, 6).join(' | '));
    ok(negative === 0, 'no pay part shows a negative earned amount', negative);
    console.log(`     records whose stored figures do not reach the net pay (said on screen): ${odd.length}`);
    odd.slice(0, 5).forEach((x) => console.log(`       ${x}`));

    const appMade = entries.filter((e) => !e.importedBreakup);
    ok(odd.every((x) => entries.some((e) => e.importedBreakup && x.startsWith(`${e.month} ${e.employee.employeeCode}:`))), `every record the app calculated itself (${appMade.length}) reaches its net pay`, odd.slice(0, 4));
    console.log('B. Made-up records');
    const rec = {
      payMode: 'Package', month: '2026-11', workingDays: 31, daysLop: 9, basic: 4000, hra: 1600, conveyance: 0, specialAllowance: 4400, bonus: 0, incentive: 0, arrears: 0,
      grossPay: 10000, lopDeduction: 2903, earnedGross: 7097, pfEmployee: 341, esiEmployee: 54, professionalTax: 0, tds: 0, otherDeductions: 0, totalDeductions: 3298, netPay: 6702, pfEmployer: 341, esiEmployer: 231, gratuity: 0,
    };
    let l = SL.salaryLines(rec, { version: { employeePf: 480 } });
    ok(check(rec, l).length === 0 && l.addsUp && l.earnings.length === 3 && l.earnings.map((x) => x.cut).join() === '1161,464,1278', 'rounding: the cut is shared in whole rupees and adds up', l.earnings);
    ok(l.deductions[0].how === 'Salary record: ₹480 for a full month, for 22 of 31 days', 'PF says where it comes from', l.deductions[0].how);
    const added = { ...rec, arrears: 1500, grossPay: 11500, earnedGross: 8597, otherDeductions: 700, totalDeductions: 3998, netPay: 7502 };
    l = SL.salaryLines(added, { state: { extras: { earnings: [{ label: 'Diwali gift', amount: 1000 }], deductions: [{ label: 'Laptop', amount: 200 }] }, loan: 500, manual: { pfEmployee: true } } });
    ok(check(added, l).length === 0 && l.earnings.some((x) => x.label === 'Diwali gift' && x.earned === 1000) && l.earnings.some((x) => x.key === 'arrears' && x.earned === 500), 'added earning lines keep their names; the rest is arrears', l.earnings);
    ok(l.deductions.some((x) => x.label === 'Loan / advance' && x.amount === 500) && l.deductions.some((x) => x.label === 'Laptop') && l.deductions[0].how === 'Typed by hand', 'loan and added deduction lines are shown; a typed PF says so', l.deductions);
    const stip = { ...rec, payMode: 'Stipend', basic: 0, hra: 0, specialAllowance: 0, pfEmployee: 0, pfEmployer: 0, totalDeductions: 2957, netPay: 7043 };
    l = SL.salaryLines(stip, {});
    ok(check(stip, l).length === 0 && l.earnings.length === 1 && l.earnings[0].label === 'Stipend' && l.earnings[0].earned === 7097 && l.deductions[0].how === 'No PF on a stipend', 'a stipend is one line', l.earnings);
    const paise = { ...rec, grossPay: 10000.5, basic: 4000.5, lopDeduction: 2903.37, earnedGross: 7097.13, totalDeductions: 3298.37, netPay: 6702.13 };
    l = SL.salaryLines(paise, {});
    ok(check(paise, l).length === 0 && l.addsUp, 'amounts in paise add up too', l.totals);
    const big = { ...rec, incentive: 20000, grossPay: 30000, lopDeduction: 12000, earnedGross: 18000, totalDeductions: 12395, netPay: 17605 };
    l = SL.salaryLines(big, {});
    ok(check(big, l).length === 0 && l.earnings.some((x) => x.key === 'further' && x.cut === 2000), 'a cut larger than the pay parts is shown on its own line', l.earnings);

    if (!process.argv.includes('--no-api')) {
      console.log('C. The Details route');
      const API = `${String(process.env.TL_API || 'http://localhost:4011').replace(/\/+$/, '').replace(/\/api$/, '')}/api`;
      if (/:4010(\/|$)/.test(API)) throw new Error('4010 is the real server');
      const admin = await prisma.user.create({ data: { name: 'ZZSL Admin', email: `zzsl-${Date.now().toString(36)}@example.test`, passwordHash: 'x'.repeat(40), role: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN', accountsRole: 'SUPER_ADMIN', atsRole: 'NONE', hrmsAccess: true, accountsAccess: true, atsAccess: false, status: 'Active' } });
      try {
        const one = entries.sort((a, b) => b.month.localeCompare(a.month))[0];
        const r = await fetch(`${API}/payroll/entries/${one.id}`, { headers: { Authorization: `Bearer ${jwt.sign({ id: admin.id }, process.env.JWT_SECRET, { expiresIn: '1h' })}` } });
        const b = await r.json();
        ok(r.status === 200 && b.lines && check(one, b.lines).length === 0 && b.period && b.period.rangeText, 'Details answers with the lines and the pay period', r.status);
      } finally { await prisma.user.delete({ where: { id: admin.id } }).catch(() => {}); }
    }
  } catch (e) {
    console.error(e);
    fail += 1;
  } finally {
    console.log(`\n${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
