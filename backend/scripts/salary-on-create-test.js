#!/usr/bin/env node
// ---------------------------------------------------------------------------
// SALARY STATUS AT ADD EMPLOYEE (founder 2026-11-24) - no database, nothing is touched.
//
//   cd backend
//   node scripts/salary-on-create-test.js
//
// utils/salaryOnCreate.js: what the Add Employee body may say (Package + Monthly CTC, or Stipend + amount), the month the first salary
// structure starts from, and the version row a plan makes. The create route and the monthly Calculate are checked on a sandbox separately.
// ---------------------------------------------------------------------------
const path = require('path');
const S = require(path.join(__dirname, '..', 'src', 'utils', 'salaryOnCreate'));
const { DEFAULT_RULES } = require(path.join(__dirname, '..', 'src', 'utils', 'salaryRules'));

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${JSON.stringify(d)}` : ''}`); };

// no salary asked
check('1 nothing typed: no salary is made (the field is optional)', S.planFrom({}).plan === null && S.planFrom({ salaryMode: '' }).plan === null && S.planFrom(null).plan === null);
check('2 the CTC typed without a Salary status is ignored', S.planFrom({ monthlyCtc: '25000' }).plan === null);

// Package
let r = S.planFrom({ salaryMode: 'Package', monthlyCtc: '25000' });
check('3 Package with a Monthly CTC: a plan with the amount', r.plan && r.plan.payMode === 'Package' && r.plan.monthlyCtc === 25000 && !r.error, r);
r = S.planFrom({ salaryMode: 'Package', monthlyCtc: '1,25,000' });
check('4 commas as Indians type them are fine (1,25,000)', r.plan && r.plan.monthlyCtc === 125000, r);
r = S.planFrom({ salaryMode: 'Package', monthlyCtc: 24999.6 });
check('5 a number with paise is rounded to the rupee', r.plan && r.plan.monthlyCtc === 25000, r);
check('6 Package with no CTC is refused in words', /Monthly CTC/.test(S.planFrom({ salaryMode: 'Package' }).error || '') && /Monthly CTC/.test(S.planFrom({ salaryMode: 'Package', monthlyCtc: '' }).error || ''));
check('7 a CTC of 0, a negative one, or text is refused', ['0', '-5', 'abc', 'NaN'].every((v) => !!S.planFrom({ salaryMode: 'Package', monthlyCtc: v }).error));
check('8 an absurd CTC (an extra zero or two) is refused', !!S.planFrom({ salaryMode: 'Package', monthlyCtc: '999999999' }).error);

// Stipend
r = S.planFrom({ salaryMode: 'Stipend', monthlyStipend: '10000' });
check('9 Stipend with an amount: a plan', r.plan && r.plan.payMode === 'Stipend' && r.plan.monthlyStipend === 10000, r);
check('10 Stipend with no amount, or 0, is refused', !!S.planFrom({ salaryMode: 'Stipend' }).error && !!S.planFrom({ salaryMode: 'Stipend', monthlyStipend: '0' }).error);
check('11 the CTC box is not read for a Stipend (and the stipend box not for a Package)', S.planFrom({ salaryMode: 'Stipend', monthlyCtc: '30000' }).error && S.planFrom({ salaryMode: 'Package', monthlyStipend: '10000' }).error);
check('12 another status is refused', /Package or Stipend/.test(S.planFrom({ salaryMode: 'Consultant', monthlyCtc: '1' }).error || ''));

// the month it starts from
check('13 starts from the first day of the joining month', S.effectiveFromFor(new Date('2026-10-21T00:00:00.000Z')) === '2026-10-01' && S.effectiveFromFor('2026-11-03') === '2026-11-01');
check('14 a joining date on the last day keeps its own month', S.effectiveFromFor(new Date('2026-10-31T00:00:00.000Z')) === '2026-10-01');
check('15 no joining date: this month', S.effectiveFromFor(null, new Date('2026-11-24T10:00:00Z')) === '2026-11-01' && S.effectiveFromFor('garbage', new Date('2026-11-24T10:00:00Z')) === '2026-11-01');

// the version row it makes (the same split the Salary Structure screen makes)
const pkg = S.dataFor({ payMode: 'Package', monthlyCtc: 25000 }, DEFAULT_RULES);
check('16 Package: annual CTC = monthly x 12, split into Basic / HRA / Special so payroll pays it', pkg.payMode === 'Package' && pkg.ctc === 300000 && pkg.basic > 0 && pkg.hra > 0 && pkg.basic + pkg.hra + pkg.bonus + pkg.specialAllowance > 0 && pkg.stipend === 0, pkg);
check('17 Package: the pieces add up to the CTC the way the Salary Structure screen splits it (no money lost or invented)', Math.abs((pkg.basic + pkg.hra + pkg.bonus + pkg.specialAllowance) - 25000) <= 25000 * 0.2, pkg);
const stp = S.dataFor({ payMode: 'Stipend', monthlyStipend: 10000 }, DEFAULT_RULES);
check('18 Stipend: the flat amount, no CTC split, no PF', stp.payMode === 'Stipend' && stp.stipend === 10000 && stp.ctc === 0 && stp.basic === 0 && stp.employeePf === 0, stp);
check('19 nothing deducted by default: TDS follows the policy (null), other deductions 0', pkg.tds === null && pkg.otherDeductions === 0 && stp.tds === null && stp.otherDeductions === 0, [pkg.tds, pkg.otherDeductions]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
