// ---------------------------------------------------------------------------
// SALARY STRUCTURE RULES — the one place a CTC becomes pay components.
//
// The rules are the user's Standard Package (2026-09-25):
//
//   Basic             = basicPctOfCtc % of the MONTHLY CTC            (40%)
//   HRA               = hraPctOfBasic % of Basic                      (40%)
//   Bonus             = a fixed monthly amount, bonusFixedMonthly     (₹1,000)
//   Employer PF       = employerPfPctOfBasic % of Basic (monthly cap) (12%)
//   Gratuity          = gratuityPctOfBasic % of Basic, rounded        (4.81%)
//   Special Allowance = CTC − (Basic + HRA + Bonus + Employer PF + Gratuity)
//   Gross             = Basic + HRA + Bonus + Special Allowance
//   Employee PF       = employeePfPctOfBasic % of Basic (monthly cap) (12%)
//   PT                = the professional-tax slab below, on Gross
//   Total Deductions  = Employee PF + PT;   Net = Gross − Total Deductions
//
// Every figure is a whole rupee, and Special Allowance is computed LAST from
// the rounded pieces, so it absorbs the rounding and Gross + Employer PF +
// Gratuity is exactly the monthly CTC.
//
// Monthly CTC 25,000 → Basic 10,000 · HRA 4,000 · Bonus 1,000 · Special 8,319 ·
// Gross 23,319 · PF 1,200 · PT 200 · Deductions 1,400 · Net 21,919 ·
// Employer PF 1,200 · Gratuity 481 · CTC 25,000.
//
// The percentages, PF caps and the bonus live on HrConfig (Payroll → Salary
// Structure → CTC Split Configuration). The PT slab lives HERE, below.
// ---------------------------------------------------------------------------

// Professional tax — Telangana slab, on monthly gross. Checked top down: the
// first row whose `above` the gross exceeds wins. THE ONLY copy of the slab.
const PT_SLAB = [
  { above: 20000, tax: 200 }, // gross > 20,000
  { above: 15000, tax: 150 }, // 15,001 – 20,000
  { above: 0, tax: 0 }, // up to 15,000
];
const PT_STATE = 'Telangana';

function professionalTaxFor(gross) {
  const g = Number(gross) || 0;
  const row = PT_SLAB.find((r) => g > r.above);
  return row ? row.tax : 0;
}

// Used when there is no HrConfig row, and for any column a row leaves null.
const DEFAULT_RULES = {
  basicPctOfCtc: 40,
  hraPctOfBasic: 40,
  bonusFixedMonthly: 1000,
  employeePfPctOfBasic: 12,
  employerPfPctOfBasic: 12,
  employeePfMonthlyCap: 1800,
  employerPfMonthlyCap: 1800,
  gratuityPctOfBasic: 4.81,
};

function num(v, fallback) {
  const n = Number(v);
  return v == null || v === '' || Number.isNaN(n) ? fallback : n;
}

function rulesFrom(cfg = {}) {
  const out = {};
  Object.keys(DEFAULT_RULES).forEach((k) => { out[k] = num(cfg[k], DEFAULT_RULES[k]); });
  return out;
}

// A cap of 0 (or less) means "no cap".
function capped(value, cap) {
  return cap > 0 ? Math.min(value, cap) : value;
}

// monthlyCtc → the full structure. `opts.bonus` overrides the configured bonus
// for this one computation (the reference card's Bonus field).
function computeStructure(monthlyCtc, cfg, opts = {}) {
  const r = rulesFrom(cfg);
  const ctc = Math.max(0, Math.round(Number(monthlyCtc) || 0));
  const basic = Math.round(ctc * (r.basicPctOfCtc / 100));
  const hra = Math.round(basic * (r.hraPctOfBasic / 100));
  const bonus = Math.round(num(opts.bonus, r.bonusFixedMonthly));
  const employerPf = Math.round(capped(basic * (r.employerPfPctOfBasic / 100), r.employerPfMonthlyCap));
  const gratuity = Math.round(basic * (r.gratuityPctOfBasic / 100));
  const special = ctc - (basic + hra + bonus + employerPf + gratuity);
  const gross = basic + hra + bonus + special;
  const employeePf = Math.round(capped(basic * (r.employeePfPctOfBasic / 100), r.employeePfMonthlyCap));
  const professionalTax = professionalTaxFor(gross);
  const deductions = employeePf + professionalTax;
  const net = gross - deductions;
  return {
    monthlyCtc: ctc,
    annualCtc: ctc * 12,
    basic, hra, bonus, special, gross,
    employeePf, professionalTax, deductions, net,
    employerPf, gratuity,
    ctcCheck: gross + employerPf + gratuity,
    // A CTC too small to carry the fixed pieces leaves Special negative; the
    // screens show it rather than silently inventing money.
    valid: special >= 0,
  };
}

// The same shape, read back from a stored SalaryStructure row (which may carry
// HR's overrides). Totals are always recomputed from the stored pieces.
function structureFromRow(ss) {
  const basic = Number(ss.basic) || 0;
  const hra = Number(ss.hra) || 0;
  const bonus = Number(ss.bonus) || 0;
  const special = Number(ss.specialAllowance) || 0;
  const employerPf = Number(ss.employerPf) || 0;
  const gratuity = Number(ss.gratuity) || 0;
  const employeePf = Number(ss.employeePf) || 0;
  const professionalTax = Number(ss.professionalTax) || 0;
  const gross = basic + hra + bonus + special;
  const deductions = employeePf + professionalTax;
  const monthlyCtc = Math.round((Number(ss.ctc) || 0) / 12);
  return {
    monthlyCtc,
    annualCtc: Number(ss.ctc) || 0,
    basic, hra, bonus, special, gross,
    employeePf, professionalTax, deductions, net: gross - deductions,
    employerPf, gratuity,
    ctcCheck: gross + employerPf + gratuity,
    valid: special >= 0,
  };
}

module.exports = {
  PT_SLAB, PT_STATE, DEFAULT_RULES, professionalTaxFor, computeStructure, structureFromRow, rulesFrom,
};
