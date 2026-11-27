// ---------------------------------------------------------------------------
// THE SALARY BREAKUP OF ONE PAYROLL RECORD, LINE BY LINE (founder 2026-11-27: "give me the clear salary break down on the Process Payroll
// Details button"). What the Details window shows, worked out from the STORED record only - nothing is calculated again and nothing written:
//
//   earnings    each pay part: full month | cut for unpaid days | earned.  The three totals are the record's gross, loss-of-pay amount and
//               earned pay, to the rupee (the cut is shared between the parts by their size; the largest part takes the rounding)
//   deductions  PF, ESI, professional tax, TDS, loan and the added lines, with a short "how"
//   net pay     earned - deductions = the record's net pay
//   employer    what the company pays on top (never cut from the salary)
// ---------------------------------------------------------------------------
const REG = require('./payrollRegister');

const r2 = (n) => REG.r2(n);
const sum = (list, k) => r2(list.reduce((n, x) => n + (Number(x[k]) || 0), 0));
const money = (n) => Number(r2(n)).toLocaleString('en-IN', { maximumFractionDigits: 2 });

// a month imported from the team's pay register carries the register's own earned amounts (scripts/payroll-import-register-as-is.js)
function sheetOf(e) {
  if (!e.importedBreakup) return null;
  try { const s = JSON.parse(e.importedBreakup).sheet; return s || null; } catch { return null; }
}
const sheetEarned = (s, key) => (key === 'bonus' ? (Number(s.performanceBonus) || 0) + (Number(s.monthlyBonus) || 0) : s[key]);

const PARTS = [['basic', 'Basic'], ['hra', 'HRA (house rent)'], ['conveyance', 'Conveyance'], ['specialAllowance', 'Special allowance'], ['bonus', 'Bonus']];

// The loss-of-pay amount shared between the parts. -> [cut per part]; the cuts add up to min(lop, base).
function shareCut(parts, lop, base) {
  if (!(lop > 0) || !(base > 0)) return parts.map(() => 0);
  const take = Math.min(lop, base);
  const whole = Number.isInteger(r2(take)) && parts.every((x) => Number.isInteger(r2(x.full)));
  const round = (v) => (whole ? Math.round(v) : r2(v));
  const cuts = parts.map((x) => round((take * x.full) / base));
  const biggest = parts.reduce((b, x, i) => (x.full > parts[b].full ? i : b), 0);
  cuts[biggest] = r2(cuts[biggest] + (take - cuts.reduce((n, c) => n + c, 0)));
  return cuts;
}

// entry: an EmployeePayrollRun row. state: its edit state (utils/payrollEdit.js readState). version: the salary record it was made from.
// register: true in a pay-register month (utils/payrollRegister.js).
function salaryLines(entry, { state = null, version = null, register = false } = {}) {
  const e = entry;
  const stipend = e.payMode === 'Stipend';
  const incentive = r2(e.incentive);
  const arrears = r2(e.arrears);
  const lop = r2(e.lopDeduction);
  const workingDays = Number(e.workingDays) || 0;
  const paidDays = r2(Math.max(0, workingDays - (Number(e.daysLop) || 0)));

  // ---- earnings ------------------------------------------------------------------------------------------
  const parts = stipend
    ? [{ key: 'stipend', label: 'Stipend', full: r2(Number(e.grossPay) - incentive - arrears) }]
    : PARTS.map(([key, label]) => ({ key, label, full: r2(e[key]) })).filter((x) => x.key === 'basic' || x.full !== 0);
  const base = sum(parts, 'full');
  const sheet = sheetOf(e);
  const fromSheet = !!sheet && !stipend && sheet.basic !== undefined && sheet.basic !== null;
  let cuts = null;
  if (fromSheet) cuts = parts.map((x) => r2(x.full - (Number(sheetEarned(sheet, x.key)) || 0)));
  if (!cuts && register) {
    // the pay register's own earned parts, when the record's loss of pay is exactly theirs
    const ep = REG.earnedParts(e);
    const own = parts.map((x) => r2(x.full - ep[x.key]));
    if (Math.abs(own.reduce((n, c) => n + c, 0) - lop) < 0.005) cuts = own;
  }
  if (!cuts) cuts = shareCut(parts, lop, base);
  const earnings = parts.map((x, i) => ({ ...x, cut: r2(cuts[i]), earned: r2(x.full - cuts[i]) }));
  const further = sheet ? 0 : r2(lop - sum(earnings, 'cut')); // only when more was cut than the pay parts hold (a typed figure)
  const extra = (state && state.extras && state.extras.earnings) || [];
  const flat = (key, label, amount) => ({ key, label, full: r2(amount), cut: 0, earned: r2(amount) });
  if (incentive > 0) earnings.push(flat('incentive', 'Incentive', incentive));
  const named = r2(extra.reduce((n, x) => n + (Number(x.amount) || 0), 0));
  if (named > 0 && named <= arrears + 0.005) {
    extra.forEach((x, i) => earnings.push(flat(`earn${i}`, x.label, x.amount)));
    if (arrears - named > 0.005) earnings.push(flat('arrears', 'Arrears / other earnings', arrears - named));
  } else if (arrears > 0) earnings.push(flat('arrears', 'Arrears / other earnings', arrears));
  if (Math.abs(further) > 0.005) earnings.push({ key: 'further', label: 'Further loss of pay', full: 0, cut: further, earned: r2(-further) });
  // an imported month: the register's own gross and earned pay are the totals; what its parts do not hold gets a line of its own
  if (sheet) {
    const full = r2(Number(e.grossPay) - sum(earnings, 'full'));
    const earned = r2(Number(e.earnedGross) - sum(earnings, 'earned'));
    if (Math.abs(full) > 0.005 || Math.abs(earned) > 0.005) {
      earnings.push({ key: 'rounding', label: Math.abs(full) < 1 && Math.abs(earned) < 1 ? 'Rounding in the pay register' : 'Other pay in the pay register', full, cut: r2(full - earned), earned });
    }
  }
  const totals = { full: sum(earnings, 'full'), cut: sum(earnings, 'cut'), earned: sum(earnings, 'earned') };

  // ---- deductions ----------------------------------------------------------------------------------------
  const typed = (k) => !!(state && state.manual && state.manual[k]);
  const part = workingDays > 0 && paidDays < workingDays ? `, for ${paidDays} of ${workingDays} days` : '';
  const pfFull = version ? r2(version.employeePf) : null;
  const pfHow = () => {
    if (sheet) return 'From the pay register';
    if (stipend) return 'No PF on a stipend';
    if (typed('pfEmployee')) return 'Typed by hand';
    if (pfFull === 0 && !Number(e.pfEmployee)) return 'No PF in the salary record';
    // part month but the full figure was taken: PF at the limit (payrollEngine.forMonth)
    if (part && pfFull > 0 && Math.abs(Number(e.pfEmployee) - pfFull) < 0.005) return `Fixed ₹${money(pfFull)} (the PF limit): not reduced for unpaid days`;
    return pfFull !== null ? `Salary record: ₹${money(pfFull)} for a full month${part}` : '';
  };
  const deductions = [
    { key: 'pf', label: 'Provident fund (PF)', amount: r2(e.pfEmployee), how: pfHow() },
    { key: 'esi', label: 'ESI', amount: r2(e.esiEmployee), how: typed('esiEmployee') ? 'Typed by hand' : (Number(e.esiEmployee) > 0 ? '0.75% of the earned pay' : 'Not applied') },
    { key: 'pt', label: 'Professional tax', amount: r2(e.professionalTax), how: typed('professionalTax') ? 'Typed by hand' : 'Telangana slab on the earned pay' },
    { key: 'tds', label: 'TDS (income tax)', amount: r2(e.tds), how: typed('tds') ? 'Typed by hand' : (Number(e.tds) > 0 ? 'From the salary record' : 'None') },
  ];
  const loan = r2(state && state.loan);
  const lines = (state && state.extras && state.extras.deductions) || [];
  const other = r2(e.otherDeductions);
  const listed = r2(loan + lines.reduce((n, x) => n + (Number(x.amount) || 0), 0));
  if (listed > 0 && listed <= other + 0.005) {
    if (loan > 0) deductions.push({ key: 'loan', label: 'Loan / advance', amount: loan, how: '' });
    lines.forEach((x, i) => deductions.push({ key: `ded${i}`, label: x.label, amount: r2(x.amount), how: 'Added line' }));
    if (other - listed > 0.005) deductions.push({ key: 'other', label: 'Other deductions', amount: r2(other - listed), how: '' });
  } else if (other > 0) deductions.push({ key: 'other', label: 'Other deductions', amount: other, how: '' });
  if (sheet) deductions.forEach((x) => { x.how = 'From the pay register'; });
  const deductionsTotal = sum(deductions, 'amount');

  // ---- the company's share -------------------------------------------------------------------------------
  const employer = [
    { key: 'pfEmployer', label: 'Provident fund (company)', amount: r2(e.pfEmployer) },
    { key: 'esiEmployer', label: 'ESI (company)', amount: r2(e.esiEmployer) },
    ...(Number(e.gratuity) > 0 ? [{ key: 'gratuity', label: 'Gratuity', amount: r2(e.gratuity) }] : []),
  ];
  const employerTotal = sum(employer, 'amount');
  const netPay = r2(e.netPay);
  return {
    days: { workingDays, paidDays, unpaidDays: r2(Number(e.daysLop) || 0) },
    earnings, totals, deductions, deductionsTotal, netPay,
    employer, employerTotal, costThisMonth: r2(totals.earned + employerTotal),
    imported: !!sheet,
    // false = the stored figures do not add up (said on the screen, with the difference, instead of hiding it)
    addsUp: Math.abs(r2(totals.earned - deductionsTotal) - netPay) < 0.011,
    gap: r2(netPay - (totals.earned - deductionsTotal)),
  };
}

module.exports = { salaryLines, shareCut };
