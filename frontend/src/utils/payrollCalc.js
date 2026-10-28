// COPY of the shared block of backend/src/utils/payrollCalc.js for the browser (live Before -> After preview of the payroll editor).
// KEEP IN SYNC: backend/scripts/payroll-calc-test.js fails when the two differ. Edit the backend file, then run: node backend/scripts/payroll-calc-sync.js
// ---- BEGIN SHARED ----
const PAYROLL_CALC_AUTO = ['lopDeduction', 'pfEmployee', 'esiEmployee', 'professionalTax', 'tds', 'pfEmployer', 'esiEmployer', 'gratuity'];
const PAYROLL_CALC_LIMIT = 10000000;

function pcR0(n) { return Math.round(Number(n) || 0); }
function pcNn(n) { return Math.max(0, pcR0(n)); }
function pcSum(list) { return (list || []).reduce((a, x) => a + pcNn(x), 0); }
// paise (Excel ROUND(x, 2)) for the pay-register mode
function pcR2(n) { const x = Number(n) || 0; const s = x < 0 ? -1 : 1; return (s * Math.round(Math.abs(x) * 100 + 1e-6)) / 100; }
function pcNn2(n) { return Math.max(0, pcR2(n)); }
function pcSum2(list) { return pcR2((list || []).reduce((a, x) => a + pcNn2(x), 0)); }
function pcCeil(n) { return Math.ceil(Number((Number(n) || 0).toFixed(6))); }
function pcCap(value, cap) { return Number(cap) > 0 ? Math.min(value, Number(cap)) : value; }
function pcSlab(slab, g) {
  const gross = Number(g) || 0;
  const row = (slab || []).find((r) => gross > r.above);
  return row ? row.tax : 0;
}

function payrollCalc(c, rules) {
  const R = rules || {};
  if (R.register) return payrollCalcRegister(c, R);
  const manual = c.manual || {};
  const stipend = R.payMode === 'Stipend';
  const workingDays = Math.max(0, Number(c.workingDays) || 0);
  const daysLop = Math.max(0, Math.min(workingDays, Number(c.daysLop) || 0));
  const ratio = workingDays > 0 ? (workingDays - daysLop) / workingDays : 1;

  const basic = stipend ? 0 : pcNn(c.basic);
  const hra = stipend ? 0 : pcNn(c.hra);
  const bonus = stipend ? 0 : pcNn(c.bonus);
  const specialAllowance = stipend ? 0 : pcNn(c.specialAllowance);
  const conveyance = stipend ? 0 : pcNn(c.conveyance);
  const baseGross = stipend ? pcNn(c.stipend) : basic + hra + bonus + specialAllowance + conveyance;
  const perDay = workingDays > 0 ? baseGross / workingDays : 0;
  const lopAuto = workingDays > 0 ? pcR0((baseGross * daysLop) / workingDays) : 0;
  const lopDeduction = manual.lopDeduction ? pcNn(c.lopDeduction) : lopAuto;

  const incentive = pcNn(c.incentive);
  const arrears = pcNn(c.arrears) + pcSum(c.extraEarn); // "Other earnings" column
  const grossPay = baseGross + incentive + arrears;
  const earnedGross = grossPay - lopDeduction;

  // Provident fund + gratuity: the structure's own full-month figure while Basic is untouched,
  // otherwise the configured % of Basic (monthly cap), then x the paid-day ratio.
  const pf = R.pf || {};
  const basicSame = pf.basicRef === undefined || pf.basicRef === null || basic === pcR0(pf.basicRef);
  const empFull = basicSame ? pcNn(pf.employeeFull) : pcR0(pcCap((basic * (Number(pf.empPct) || 0)) / 100, pf.empCap));
  const erFull = basicSame ? pcNn(pf.employerFull) : pcR0(pcCap((basic * (Number(pf.erPct) || 0)) / 100, pf.erCap));
  const gratFull = basicSame ? pcNn(pf.gratuityFull) : pcR0((basic * (Number(pf.gratuityPct) || 0)) / 100);
  const pfEmployee = manual.pfEmployee ? pcNn(c.pfEmployee) : (stipend ? 0 : pcR0(empFull * ratio));
  const pfEmployer = manual.pfEmployer ? pcNn(c.pfEmployer) : (stipend ? 0 : pcR0(erFull * ratio));
  const gratuity = manual.gratuity ? pcNn(c.gratuity) : (stipend ? 0 : pcR0(gratFull * ratio));

  // ESI: decided on the full-month base gross, charged on what was earned.
  const esi = R.esi || {};
  const ceiling = esi.ceiling === undefined || esi.ceiling === null ? 21000 : Number(esi.ceiling);
  const eligible = esi.applicable === true || esi.applicable === false
    ? esi.applicable
    : (esi.enabled !== false && baseGross > 0 && baseGross <= ceiling);
  const ePct = esi.empPct === undefined || esi.empPct === null ? 0.75 : Number(esi.empPct);
  const rPct = esi.erPct === undefined || esi.erPct === null ? 3.25 : Number(esi.erPct);
  const esiOn = eligible && earnedGross > 0;
  const esiEmployee = manual.esiEmployee ? pcNn(c.esiEmployee) : (esiOn ? Math.ceil(Math.round(earnedGross * ePct) / 100) : 0);
  const esiEmployer = manual.esiEmployer ? pcNn(c.esiEmployer) : (esiOn ? Math.ceil(Math.round(earnedGross * rPct) / 100) : 0);

  // Professional tax: the slab on what was earned (never above the structure's own PT while the gross is untouched).
  const pt = R.pt || {};
  const ptSame = pt.baseGrossRef === undefined || pt.baseGrossRef === null || baseGross === pcR0(pt.baseGrossRef);
  const ptSlab = pcSlab(pt.slab, earnedGross);
  const ptAuto = stipend ? 0 : (ptSame && pt.versionMax !== undefined && pt.versionMax !== null ? Math.min(pcNn(pt.versionMax), ptSlab) : ptSlab);
  const professionalTax = manual.professionalTax ? pcNn(c.professionalTax) : ptAuto;

  // TDS: never more than what is left after PF, ESI and PT.
  const tdsR = R.tds || {};
  const statutory = pfEmployee + esiEmployee + professionalTax;
  const room = Math.max(0, earnedGross - statutory);
  const want = tdsR.fixed !== undefined && tdsR.fixed !== null
    ? pcR0(tdsR.fixed)
    : pcR0((earnedGross * (Number(tdsR.pct) || 0)) / 100);
  const tds = manual.tds ? pcNn(c.tds) : Math.min(Math.max(0, want), room);

  const other = pcNn(c.otherDeductions);
  const loan = pcNn(c.loan);
  const otherDeductions = other + loan + pcSum(c.extraDed); // "Other deductions" column
  const totalDeductions = pfEmployee + esiEmployee + professionalTax + tds + lopDeduction + otherDeductions;
  const netPay = grossPay - totalDeductions;
  const ctc = earnedGross + pfEmployer + esiEmployer + gratuity;
  return {
    workingDays, daysLop, ratio, perDay, baseGross,
    basic, hra, bonus, specialAllowance, conveyance, incentive, arrears,
    grossPay, lopDeduction, earnedGross,
    pfEmployee, esiEmployee, professionalTax, tds, otherDeductions, totalDeductions, netPay,
    pfEmployer, esiEmployer, gratuity, ctc,
    negativeNet: netPay < 0,
  };
}

// The pay-register mode (see the header): the same inputs and outputs, in paise.
function payrollCalcRegister(c, R) {
  const manual = c.manual || {};
  const stipendMode = R.payMode === 'Stipend';
  const workingDays = Math.max(0, Number(c.workingDays) || 0);
  const daysLop = Math.max(0, Math.min(workingDays, Number(c.daysLop) || 0));
  const ratio = workingDays > 0 ? (workingDays - daysLop) / workingDays : 1;
  const earn = (full) => (workingDays > 0 ? pcR2((full * (workingDays - daysLop)) / workingDays) : full);

  const basic = stipendMode ? 0 : pcNn2(c.basic);
  const hra = stipendMode ? 0 : pcNn2(c.hra);
  const bonus = stipendMode ? 0 : pcNn2(c.bonus);
  const specialAllowance = stipendMode ? 0 : pcNn2(c.specialAllowance);
  const conveyance = stipendMode ? 0 : pcNn2(c.conveyance);
  const stipendFull = stipendMode ? pcNn2(c.stipend) : 0;
  const baseGross = stipendMode ? stipendFull : pcR2(basic + hra + bonus + specialAllowance + conveyance);
  const earnedBasic = earn(basic);
  const earnedBase = stipendMode ? earn(stipendFull) : pcR2(earnedBasic + earn(hra) + earn(bonus) + earn(specialAllowance) + earn(conveyance));
  const perDay = workingDays > 0 ? baseGross / workingDays : 0;
  const lopAuto = pcR2(baseGross - earnedBase);
  const lopDeduction = manual.lopDeduction ? pcNn2(c.lopDeduction) : lopAuto;

  const incentive = pcNn2(c.incentive);
  const arrears = pcR2(pcNn2(c.arrears) + pcSum2(c.extraEarn));
  const grossPay = pcR2(baseGross + incentive + arrears);
  const earnedGross = pcR2(grossPay - lopDeduction);

  const pf = R.pf || {};
  const rule = pf.rule || null;
  const basicSame = pf.basicRef === undefined || pf.basicRef === null || basic === pcR2(pf.basicRef);
  const empFull = basicSame ? pcNn2(pf.employeeFull) : pcR2(pcCap((basic * (Number(pf.empPct) || 0)) / 100, pf.empCap));
  const erFull = basicSame ? pcNn2(pf.employerFull) : pcR2(pcCap((basic * (Number(pf.erPct) || 0)) / 100, pf.erCap));
  const gratFull = basicSame ? pcNn2(pf.gratuityFull) : pcR2((basic * (Number(pf.gratuityPct) || 0)) / 100);
  let pfRuleAmt;
  if (stipendMode || earnedBase <= 0) pfRuleAmt = 0;
  else if (rule && rule.mode === 'PCT') pfRuleAmt = pcR2((earnedBasic * (Number(rule.pct) || 0)) / 100);
  else if (rule && rule.mode === 'FIXED') pfRuleAmt = pcNn2(rule.amount);
  else pfRuleAmt = pcR2(empFull * ratio);
  const pfEmployee = manual.pfEmployee ? pcNn2(c.pfEmployee) : pfRuleAmt;
  const pfEmployer = manual.pfEmployer ? pcNn2(c.pfEmployer) : (stipendMode ? 0 : pcR2(erFull * ratio));
  const gratuity = manual.gratuity ? pcNn2(c.gratuity) : (stipendMode ? 0 : pcR2(gratFull * ratio));

  const esi = R.esi || {};
  const ceiling = esi.ceiling === undefined || esi.ceiling === null ? 21000 : Number(esi.ceiling);
  const eligible = esi.applicable === true || esi.applicable === false
    ? esi.applicable
    : (esi.enabled !== false && baseGross > 0 && baseGross <= ceiling);
  const ePct = esi.empPct === undefined || esi.empPct === null ? 0.75 : Number(esi.empPct);
  const rPct = esi.erPct === undefined || esi.erPct === null ? 3.25 : Number(esi.erPct);
  const esiOn = !stipendMode && eligible && earnedGross > 0;
  const esiEmployee = manual.esiEmployee ? pcNn2(c.esiEmployee) : (esiOn ? pcCeil((earnedGross * ePct) / 100) : 0);
  const esiEmployer = manual.esiEmployer ? pcNn2(c.esiEmployer) : (esiOn ? pcCeil((earnedGross * rPct) / 100) : 0);

  const pt = R.pt || {};
  const ptAuto = stipendMode ? 0 : pcSlab(pt.slab, earnedGross);
  const professionalTax = manual.professionalTax ? pcNn2(c.professionalTax) : ptAuto;

  const tdsR = R.tds || {};
  const statutory = pcR2(pfEmployee + esiEmployee + professionalTax);
  const room = Math.max(0, pcR2(earnedGross - statutory));
  const want = tdsR.fixed !== undefined && tdsR.fixed !== null
    ? pcR2(tdsR.fixed)
    : pcR2((earnedGross * (Number(tdsR.pct) || 0)) / 100);
  const tds = manual.tds ? pcNn2(c.tds) : Math.min(Math.max(0, want), room);

  const otherDeductions = pcR2(pcNn2(c.otherDeductions) + pcNn2(c.loan) + pcSum2(c.extraDed));
  const totalDeductions = pcR2(pfEmployee + esiEmployee + professionalTax + tds + lopDeduction + otherDeductions);
  const netPay = pcR2(grossPay - totalDeductions);
  const ctc = pcR2(earnedGross + pfEmployer + esiEmployer + gratuity);
  return {
    workingDays, daysLop, ratio, perDay, baseGross,
    basic, hra, bonus, specialAllowance, conveyance, incentive, arrears,
    grossPay, lopDeduction, earnedGross,
    pfEmployee, esiEmployee, professionalTax, tds, otherDeductions, totalDeductions, netPay,
    pfEmployer, esiEmployer, gratuity, ctc,
    negativeNet: netPay < 0,
  };
}

// Plain-words problems with a set of components; [] = fine.
function payrollCalcProblems(c, res, opts) {
  const o = opts || {};
  const out = [];
  const wd = Number(c.workingDays);
  const lop = Number(c.daysLop);
  if (!Number.isFinite(wd) || wd < 1 || wd > 31) out.push({ field: 'workingDays', message: 'Working days must be between 1 and 31.' });
  if (!Number.isFinite(lop) || lop < 0 || (Number.isFinite(wd) && lop > wd)) out.push({ field: 'daysLop', message: 'LOP days must be between 0 and the working days.' });
  if (Number.isFinite(lop) && (lop * 2) % 1) out.push({ field: 'daysLop', message: 'Days are whole or half days.' });
  if (Number.isFinite(wd) && (wd * 2) % 1) out.push({ field: 'workingDays', message: 'Days are whole or half days.' });
  const money = ['basic', 'hra', 'bonus', 'specialAllowance', 'conveyance', 'incentive', 'arrears', 'stipend', 'loan', 'otherDeductions',
    'pfEmployee', 'esiEmployee', 'professionalTax', 'tds', 'pfEmployer', 'esiEmployer', 'gratuity', 'lopDeduction'];
  money.forEach((k) => {
    if (c[k] === undefined || c[k] === null || c[k] === '') return;
    const n = Number(c[k]);
    if (!Number.isFinite(n)) out.push({ field: k, message: 'Type a number.' });
    else if (n < 0) out.push({ field: k, message: 'An amount cannot be below 0.' });
    else if (n > PAYROLL_CALC_LIMIT) out.push({ field: k, message: 'That amount is too large.' });
  });
  ['extraEarn', 'extraDed'].forEach((k) => {
    (c[k] || []).forEach((x) => {
      const n = Number(x);
      if (!Number.isFinite(n) || n < 0 || n > PAYROLL_CALC_LIMIT) out.push({ field: k, message: 'Every added line needs an amount from 0 up.' });
    });
  });
  Object.keys(c.manual || {}).forEach((k) => {
    if (c.manual[k] && PAYROLL_CALC_AUTO.indexOf(k) < 0) out.push({ field: k, message: 'That line cannot be typed by hand.' });
  });
  if (res && res.earnedGross < 0) out.push({ field: 'lopDeduction', message: 'The loss-of-pay amount is more than the gross pay.' });
  if (res && res.netPay < 0 && !o.allowNegativeReason) out.push({ field: 'netPay', message: 'Net pay would be below 0. Reduce a deduction, or tick "Allow negative net pay" and say why.' });
  return out;
}
// ---- END SHARED ----

export { payrollCalc, payrollCalcProblems, PAYROLL_CALC_AUTO, PAYROLL_CALC_LIMIT };
