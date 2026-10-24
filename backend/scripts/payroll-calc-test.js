// Payroll calc test (item 5, 2026-10-13): the ONE calculation module (utils/payrollCalc.js)
// - formula table (PF ceiling, ESI threshold, PT slab, LOP, per-day on 30/31-day cycles, manual lines, new rows, rounding)
// - equal to the engine's computeEntry for unedited records
// - frontend copy identical (text) and equal on 500 random inputs
// Pure: no server, no database rows. Run: node scripts/payroll-calc-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'file:C:/Users/user/Desktop/All_Projects/teamlink-enterprise/backend/prisma/sandbox.db';
const { payrollCalc, payrollCalcProblems } = require('../src/utils/payrollCalc');
const PEdit = require('../src/utils/payrollEdit');
const E = require('../src/utils/payrollEngine');

let pass = 0; let fail = 0;
const ok = (c, label, extra) => { if (c) { pass += 1; console.log('PASS', label); } else { fail += 1; console.log('FAIL', label, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); } };

const policy = { esiEnabled: true, esiGrossCeiling: 21000, esiEmployeePct: 0.75, esiEmployerPct: 3.25, tdsDefaultPctOfGross: 0, employeePfPctOfBasic: 12, employerPfPctOfBasic: 12, employeePfMonthlyCap: 1800, employerPfMonthlyCap: 1800, gratuityPctOfBasic: 4.81 };
const version = { payMode: 'Package', basic: 10000, hra: 4000, bonus: 1000, specialAllowance: 8319, conveyance: 0, employeePf: 1200, employerPf: 1200, gratuity: 481, professionalTax: 200, esiApplicable: null, tds: null, otherDeductions: 0 };
const rules = PEdit.rulesFromVersion(version, policy, 'Package');
const base = { workingDays: 26, daysLop: 0, basic: 10000, hra: 4000, bonus: 1000, specialAllowance: 8319, conveyance: 0, incentive: 0, arrears: 0, extraEarn: [], extraDed: [], otherDeductions: 0, loan: 0, manual: {} };
const c = (o) => payrollCalc({ ...base, ...o }, rules);

// 1. an unedited CTC 25,000 record = the user's own example
let r = c({});
ok(r.grossPay === 23319 && r.pfEmployee === 1200 && r.professionalTax === 200 && r.esiEmployee === 0 && r.totalDeductions === 1400 && r.netPay === 21919, 'T01 CTC 25,000: gross 23,319 / PF 1,200 / PT 200 / net 21,919', r);
ok(r.ctc === 25000, 'T02 monthly CTC = gross + employer PF + gratuity = 25,000', r.ctc);

// 3. equals the engine for several LOP days (the whole point of one formula)
const att = (lop, wd = 26) => ({ workingDays: wd, daysPresent: wd - lop, daysLop: lop });
[0, 0.5, 2, 7.5, 26].forEach((lop) => {
  const eng = E.computeEntry({ version, att: att(lop), policy, incentive: 0 });
  const k = c({ daysLop: lop });
  const same = ['grossPay', 'lopDeduction', 'earnedGross', 'pfEmployee', 'esiEmployee', 'professionalTax', 'tds', 'otherDeductions', 'totalDeductions', 'netPay', 'pfEmployer', 'esiEmployer', 'gratuity'].every((f) => eng[f] === k[f]);
  ok(same, `T03 equals the engine at ${lop} LOP day(s)`, { eng, k });
});
// with incentive + a small ESI-eligible package
const small = { ...version, basic: 8000, hra: 3200, bonus: 1000, specialAllowance: 6800, employeePf: 960, employerPf: 960, gratuity: 385, professionalTax: 150 };
const rs = PEdit.rulesFromVersion(small, policy, 'Package');
const engS = E.computeEntry({ version: small, att: att(3), policy, incentive: 1500 });
const kS = payrollCalc({ ...base, basic: 8000, hra: 3200, bonus: 1000, specialAllowance: 6800, daysLop: 3, incentive: 1500 }, rs);
ok(['grossPay', 'earnedGross', 'pfEmployee', 'esiEmployee', 'esiEmployer', 'professionalTax', 'totalDeductions', 'netPay'].every((f) => engS[f] === kS[f]), 'T04 equals the engine: ESI-eligible package + incentive + LOP', { engS, kS });

// PF ceiling / percentage
ok(c({ basic: 20000 }).pfEmployee === 1800, 'T05 PF capped at the monthly ceiling (Basic 20,000 -> 1,800)', c({ basic: 20000 }).pfEmployee);
ok(c({ basic: 12000 }).pfEmployee === 1440, 'T06 Basic changed to 12,000 -> PF 12% = 1,440', c({ basic: 12000 }).pfEmployee);
ok(c({ basic: 12000, daysLop: 13 }).pfEmployee === 720, 'T07 PF follows paid days (half the month -> half the PF)', c({ basic: 12000, daysLop: 13 }).pfEmployee);
// ESI threshold
const lowRules = PEdit.rulesFromVersion({ ...version, basic: 8000, hra: 3200, bonus: 1000, specialAllowance: 7800, professionalTax: 150, employeePf: 960, employerPf: 960 }, policy, 'Package');
const lowC = (o) => payrollCalc({ ...base, basic: 8000, hra: 3200, bonus: 1000, specialAllowance: 7800, ...o }, lowRules);
ok(lowC({}).baseGross === 20000 && lowC({}).esiEmployee === 150, 'T08 gross 20,000: ESI 0.75% = 150 charged', lowC({}).esiEmployee);
ok(lowC({ specialAllowance: 8800 }).baseGross === 21000 && lowC({ specialAllowance: 8800 }).esiEmployee > 0, 'T09 gross exactly 21,000 still ESI-eligible', lowC({ specialAllowance: 8800 }).esiEmployee);
ok(lowC({ specialAllowance: 8801 }).esiEmployee === 0 && lowC({ specialAllowance: 8801 }).esiEmployer === 0, 'T10 gross 21,001 crosses the ESI threshold: no ESI', lowC({ specialAllowance: 8801 }));
ok(lowC({ daysLop: 5 }).esiEmployee > 0 && lowC({ daysLop: 5 }).esiEmployee < lowC({}).esiEmployee, 'T11 ESI is decided on the full gross but charged on what was earned', lowC({ daysLop: 5 }).esiEmployee);
// PT slab (gross no longer the structure's: slab applies)
ok(payrollCalc({ ...base, basic: 6000, hra: 2400, bonus: 0, specialAllowance: 5000 }, rules).professionalTax === 0, 'T12 PT slab: gross 13,400 -> 0', null);
ok(payrollCalc({ ...base, basic: 6000, hra: 2400, bonus: 1000, specialAllowance: 6000 }, rules).professionalTax === 150, 'T13 PT slab: gross 15,400 -> 150', null);
ok(payrollCalc({ ...base, basic: 12000, hra: 4800, bonus: 1000, specialAllowance: 8000 }, rules).professionalTax === 200, 'T14 PT slab: gross 25,800 -> 200', null);
// LOP / per-day on 30- and 31-day cycles
ok(c({ daysLop: 2 }).lopDeduction === Math.round(23319 * 2 / 26), 'T15 LOP 2 of 26 days = round(gross x 2 / 26)', c({ daysLop: 2 }).lopDeduction);
ok(c({ workingDays: 31, daysLop: 1 }).lopDeduction === Math.round(23319 / 31) && Math.abs(c({ workingDays: 31 }).perDay - 23319 / 31) < 1e-9, 'T16 per-day rate on a 31-day cycle = gross / 31', c({ workingDays: 31, daysLop: 1 }));
ok(c({ workingDays: 30, daysLop: 1 }).lopDeduction === Math.round(23319 / 30), 'T17 per-day rate on a 30-day cycle = gross / 30', c({ workingDays: 30, daysLop: 1 }).lopDeduction);
ok(c({ daysLop: 99 }).daysLop === 26, 'T18 LOP days can never exceed the working days', c({ daysLop: 99 }).daysLop);
// manual line kept
const m1 = c({ manual: { pfEmployee: true }, pfEmployee: 500 });
ok(m1.pfEmployee === 500 && c({ manual: { pfEmployee: true }, pfEmployee: 500, basic: 15000 }).pfEmployee === 500, 'T19 a line typed by hand is kept on later recalculations', m1.pfEmployee);
ok(c({ manual: { professionalTax: true }, professionalTax: 0 }).professionalTax === 0 && c({}).professionalTax === 200, 'T20 manual PT 0 is kept while the auto line stays 200', null);
ok(c({ manual: { lopDeduction: true }, lopDeduction: 700, daysLop: 3 }).lopDeduction === 700, 'T21 LOP amount can be typed by hand', null);
// rows
const e1 = c({ extraEarn: [1000, 500] });
ok(e1.grossPay === 24819 && e1.arrears === 1500 && e1.netPay === c({}).netPay + 1500, 'T22 added earning rows raise gross and net (+1,500)', e1);
const d1 = c({ extraDed: [300, 200], loan: 1000, otherDeductions: 100 });
ok(d1.otherDeductions === 1600 && d1.totalDeductions === 1400 + 1600 && d1.netPay === 21919 - 1600, 'T23 added deduction rows + loan + other = 1,600 off the net', d1);
// rounding
ok(c({ basic: 10001, daysLop: 1, workingDays: 26 }).lopDeduction === Math.round((10001 + 4000 + 1000 + 8319) * 1 / 26), 'T24 rounding: whole rupees, round half up like the engine', null);
ok(c({ basic: 10000.4, hra: 3999.6 }).basic === 10000 && c({ basic: 10000.4, hra: 3999.6 }).hra === 4000, 'T25 typed amounts are rounded to whole rupees', null);
// TDS
const tdsRules = PEdit.rulesFromVersion({ ...version, tds: 500 }, policy, 'Package');
ok(payrollCalc({ ...base }, tdsRules).tds === 500, 'T26 structure TDS 500 is taken', null);
ok(payrollCalc({ ...base, basic: 400, hra: 0, bonus: 0, specialAllowance: 0 }, tdsRules).tds <= 400, 'T27 TDS never exceeds what is left after PF/ESI/PT', payrollCalc({ ...base, basic: 400, hra: 0, bonus: 0, specialAllowance: 0 }, tdsRules).tds);
const pctRules = PEdit.rulesFromVersion(version, { ...policy, tdsDefaultPctOfGross: 10 }, 'Package');
ok(payrollCalc({ ...base }, pctRules).tds === Math.round(23319 * 0.10) || payrollCalc({ ...base }, pctRules).tds === Math.min(Math.round(23319 * 0.1), 23319 - 1400), 'T28 policy TDS % of earned gross', payrollCalc({ ...base }, pctRules).tds);
// stipend
const stRules = PEdit.rulesFromVersion({ payMode: 'Stipend', stipend: 9000 }, policy, 'Stipend');
const st = payrollCalc({ workingDays: 26, daysLop: 2, stipend: 9000, incentive: 0, extraEarn: [], extraDed: [], manual: {} }, stRules);
ok(st.grossPay === 9000 && st.pfEmployee === 0 && st.professionalTax === 0 && st.lopDeduction === Math.round(9000 * 2 / 26), 'T29 stipend: no PF / PT, LOP on the stipend', st);
// validations
const res0 = c({ extraDed: [30000] });
ok(res0.negativeNet && payrollCalcProblems({ ...base, extraDed: [30000] }, res0, {}).some((p) => p.field === 'netPay'), 'T30 net below 0 is flagged and needs a reason', res0.netPay);
ok(!payrollCalcProblems({ ...base, extraDed: [30000] }, res0, { allowNegativeReason: 'recovery agreed' }).length, 'T31 negative net allowed with a reason', null);
ok(payrollCalcProblems({ ...base, basic: -5 }, c({}), {}).length === 1, 'T32 negative amount refused', null);
ok(payrollCalcProblems({ ...base, daysLop: 27 }, c({}), {}).some((p) => p.field === 'daysLop'), 'T33 LOP above working days refused', null);
ok(payrollCalcProblems({ ...base, daysLop: 1.3 }, c({}), {}).some((p) => /half/.test(p.message)), 'T34 days must be whole / half', null);
ok(payrollCalcProblems({ ...base, manual: { basic: true } }, c({}), {}).length === 1, 'T35 only the auto lines can be typed by hand', null);
ok(payrollCalcProblems({ ...base, basic: 99999999999 }, c({}), {}).length === 1, 'T36 absurd amount refused (cap)', null);
ok(c({ workingDays: 0 }).lopDeduction === 0 && Number.isFinite(c({ workingDays: 0 }).netPay), 'T37 zero working days does not blow up', null);
// identities on random inputs
let identities = true;
const rnd = (n) => Math.floor(Math.random() * n);
for (let i = 0; i < 500; i += 1) {
  const x = c({ basic: rnd(40000), hra: rnd(15000), bonus: rnd(3000), specialAllowance: rnd(20000), daysLop: rnd(27), extraEarn: [rnd(2000)], extraDed: [rnd(1500)], incentive: rnd(3000), loan: rnd(800) });
  if (x.grossPay - x.totalDeductions !== x.netPay || x.ctc !== x.earnedGross + x.pfEmployer + x.esiEmployer + x.gratuity || x.earnedGross !== x.grossPay - x.lopDeduction) { identities = false; break; }
}
ok(identities, 'T38 identities hold on 500 random inputs (net = gross - deductions, CTC, earned = gross - LOP)', null);

// frontend copy: identical text + identical numbers
const BEND = fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'payrollCalc.js'), 'utf8');
const FEND = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', 'utils', 'payrollCalc.js'), 'utf8');
const blk = (s) => (s.match(/\/\/ ---- BEGIN SHARED ----\r?\n([\s\S]*?)\/\/ ---- END SHARED ----/) || [])[1];
ok(blk(BEND) && blk(BEND).replace(/\r\n/g, '\n') === (blk(FEND) || '').replace(/\r\n/g, '\n'), 'T39 the browser copy (frontend/src/utils/payrollCalc.js) is identical to the server block');
const tmp = path.join(os.tmpdir(), `payrollCalc-fe-${Date.now()}.mjs`);
fs.writeFileSync(tmp, FEND);
import(`file:///${tmp.replace(/\\/g, '/')}`).then((fe) => {
  let eq = true; let bad = null;
  for (let i = 0; i < 500; i += 1) {
    const comp = { ...base, basic: rnd(40000), hra: rnd(15000), bonus: rnd(3000), specialAllowance: rnd(20000), daysLop: rnd(27) / 2, workingDays: 26 + rnd(6), extraEarn: [rnd(2000)], extraDed: [rnd(1500)], incentive: rnd(3000), loan: rnd(800), manual: rnd(2) ? { pfEmployee: true } : {}, pfEmployee: rnd(2000) };
    const a = JSON.stringify(payrollCalc(comp, rules)); const b = JSON.stringify(fe.payrollCalc(comp, rules));
    if (a !== b) { eq = false; bad = { a, b }; break; }
    if (JSON.stringify(payrollCalcProblems(comp, payrollCalc(comp, rules), {})) !== JSON.stringify(fe.payrollCalcProblems(comp, fe.payrollCalc(comp, rules), {}))) { eq = false; bad = 'problems'; break; }
  }
  ok(eq, 'T40 the browser copy gives the same numbers as the server on 500 random inputs', bad);
  fs.unlinkSync(tmp);
  console.log(`\nSUMMARY pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
});
