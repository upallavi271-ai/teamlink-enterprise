// ---------------------------------------------------------------------------
// PAYROLL TOTALS — the one helper other modules read payroll money through.
//
// Used by the Accounts combined summary (GET /api/accounts/combined-summary,
// Office & Expenses) and by the payroll reconciliation. Read-only.
//
//   const { monthlyPayrollTotals } = require('../utils/payrollTotals');
//   const t = await monthlyPayrollTotals('2026-09');
//   t.grossPay            full-month gross of the counted records
//   t.earnedGross         gross after loss of pay (what the salary expense is built on)
//   t.net                 net pay
//   t.employerPf / t.employerEsi / t.employerContributions
//   t.totalCost           earnedGross + employer contributions (= Salary Expense booked)
//   t.paid / t.paidCount  net actually marked paid (status PAID)
//   t.byStatus            { DRAFT: {count, net}, ... } — every record, whatever `statuses` says
//   t.source              'entries' | 'legacy-run' (a month run from before the
//                         per-employee records, e.g. August 2026) | 'none'
//
// options.statuses — which records count (default: APPROVED, SYNCED_TO_ACCOUNTS,
// PAID — i.e. payroll that has been approved). Pass the full list to include drafts.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const FINAL = ['APPROVED', 'SYNCED_TO_ACCOUNTS', 'PAID'];

function emptyTotals(month) {
  return {
    month, source: 'none', employees: 0, grossPay: 0, lopDeductions: 0, earnedGross: 0, deductions: 0, net: 0,
    employeePf: 0, employeeEsi: 0, professionalTax: 0, tds: 0, otherDeductions: 0,
    employerPf: 0, employerEsi: 0, employerContributions: 0, totalCost: 0, paid: 0, paidCount: 0, byStatus: {},
  };
}

async function monthlyPayrollTotals(month, { statuses = FINAL } = {}) {
  const out = emptyTotals(month);
  const all = await prisma.employeePayrollRun.findMany({ where: { month } });
  all.forEach((e) => {
    const s = out.byStatus[e.status] || (out.byStatus[e.status] = { count: 0, net: 0 });
    s.count += 1; s.net += e.netPay;
  });
  if (!all.length) {
    const legacy = await prisma.payrollRun.findUnique({ where: { month } });
    if (!legacy) return out;
    return {
      ...out, source: 'legacy-run', employees: legacy.employees, grossPay: legacy.totalGross, earnedGross: legacy.totalGross,
      deductions: legacy.totalDeductions, net: legacy.totalNet, totalCost: legacy.totalGross,
      paid: legacy.status === 'Paid' ? legacy.totalNet : 0, paidCount: legacy.status === 'Paid' ? legacy.employees : 0,
    };
  }
  out.source = 'entries';
  all.filter((e) => statuses.includes(e.status)).forEach((e) => {
    out.employees += 1;
    out.grossPay += e.grossPay;
    out.lopDeductions += e.lopDeduction;
    out.earnedGross += e.earnedGross;
    out.deductions += e.totalDeductions;
    out.net += e.netPay;
    out.employeePf += e.pfEmployee;
    out.employeeEsi += e.esiEmployee;
    out.professionalTax += e.professionalTax;
    out.tds += e.tds;
    out.otherDeductions += e.otherDeductions;
    out.employerPf += e.pfEmployer;
    out.employerEsi += e.esiEmployer;
    if (e.status === 'PAID') { out.paid += e.netPay; out.paidCount += 1; }
  });
  out.employerContributions = out.employerPf + out.employerEsi;
  out.totalCost = out.earnedGross + out.employerContributions;
  return out;
}

// Several months at once: { 'YYYY-MM': totals }.
async function payrollTotalsForMonths(months, options) {
  const out = {};
  for (const m of months) {
    // eslint-disable-next-line no-await-in-loop
    out[m] = await monthlyPayrollTotals(m, options);
  }
  return out;
}

module.exports = { monthlyPayrollTotals, payrollTotalsForMonths, FINAL_STATUSES: FINAL };
