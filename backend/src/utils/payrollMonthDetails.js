// ---------------------------------------------------------------------------
// ACCOUNTS -> PAYROLL MONTHS -> OPEN: the month's complete employee-wise salary
// sheet (Accounts fixes spec, 2026-10-09).
//
// One row per employee that has a payroll record (EmployeePayrollRun) in the
// month. Every figure is read from the stored record, never recomputed:
//   * records the app calculated carry the full-month Basic / HRA / allowances,
//     the loss-of-pay amount as its own deduction line and the net;
//   * records IMPORTED from the pay registers (importedBreakup) keep the sheet's
//     Conveyance and Arrears as their own columns, and their stored net pay is
//     the register's figure - the sheet is authoritative. Where the register's
//     net is not "gross - deductions" (it ignored TDS / the last PT, or rounded)
//     the row says so (netNote) instead of being forced to add up.
// The month totals are the sum of the very same rows, in whole paise, so the
// cards can never disagree with the table (asserted in the test).
//
// Components shown (gross = sum of them, always):
//   basic, hra, conveyance, arrears, otherAllowances (special allowance + bonus
//   + stipend + the paise left over), incentive
// Deductions (totalDeductions = sum of them, always):
//   pf, esi, tds, lossOfPay, otherDeductions (professional tax + any other)
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { monthLabel } = require('./attendanceMath');

const paise = (n) => Math.round((Number(n) || 0) * 100);
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const isMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));

const STATUS_LABEL = {
  DRAFT: 'Draft', PENDING_APPROVAL: 'Waiting for approval', APPROVED: 'Approved', SYNCED_TO_ACCOUNTS: 'Approved', PAID: 'Paid',
};

function parseBreakup(raw) {
  if (!raw) return null;
  try { const j = JSON.parse(raw); return j && typeof j === 'object' ? j : null; } catch { return null; }
}

function shapeRow(e) {
  const imp = parseBreakup(e.importedBreakup);
  const basic = r2(e.basic);
  const hra = r2(e.hra);
  const conveyance = r2(e.conveyance);
  const arrears = r2(e.arrears);
  const incentive = r2(e.incentive);
  const gross = r2(e.grossPay);
  // Whatever the named parts do not explain: special allowance, bonus, a
  // stipend, and any paise of rounding - so the earnings always add up to gross.
  const otherAllowances = r2(gross - basic - hra - conveyance - arrears - incentive);
  const pf = r2(e.pfEmployee);
  const esi = r2(e.esiEmployee);
  const tds = r2(e.tds);
  const lossOfPay = r2(e.lopDeduction);
  const totalDeductions = r2(e.totalDeductions);
  const otherDeductions = r2(totalDeductions - pf - esi - tds - lossOfPay);
  const netPay = r2(e.netPay);
  const gap = r2(gross - totalDeductions - netPay);
  let netNote = null;
  if (Math.abs(gap) >= 1) {
    const flags = imp && Array.isArray(imp.flags) ? imp.flags : [];
    netNote = flags.includes('net-ignores-tds-lpt')
      ? `Net pay is the pay register's figure: it does not take off TDS / last-month professional tax (${Math.abs(gap)} difference).`
      : `Net pay is the ${imp ? 'pay register' : 'saved'} figure; gross minus deductions is ${gap > 0 ? 'higher' : 'lower'} by ${Math.abs(gap)}.`;
  }
  const attendance = imp && imp.attendance && Number.isFinite(Number(imp.attendance.payableDays)) ? Number(imp.attendance.payableDays) : null;
  const workingDays = Number(e.workingDays) || 0;
  const paidDays = attendance != null ? attendance : Math.max(0, r2(workingDays - (Number(e.daysLop) || 0)));
  const paid = e.status === 'PAID';
  return {
    id: e.id,
    employeeId: e.employeeId,
    employeeCode: e.employee ? e.employee.employeeCode : null,
    name: e.employee ? e.employee.name : null,
    department: (e.employee && e.employee.department) || null,
    designation: (e.employee && e.employee.designation) || null,
    workingDays, paidDays,
    basic, hra, conveyance, arrears, otherAllowances, incentive, gross,
    pf, esi, tds, lossOfPay, otherDeductions, totalDeductions,
    netPay, netNote,
    paymentStatus: paid ? 'Paid' : 'Not paid yet',
    stage: STATUS_LABEL[e.status] || e.status,
    paidOn: paid && e.paidAt ? new Date(e.paidAt).toISOString().slice(0, 10) : null,
    imported: !!imp,
    importNote: e.importNote || null,
  };
}

// Totals in whole paise, so the cards equal the sum of the rows exactly.
const SUM_KEYS = ['basic', 'hra', 'conveyance', 'arrears', 'otherAllowances', 'incentive', 'gross', 'pf', 'esi', 'tds', 'lossOfPay', 'otherDeductions', 'totalDeductions', 'netPay'];
function totalsOf(rows) {
  const t = { employees: rows.length, paidEmployees: 0 };
  SUM_KEYS.forEach((k) => { t[k] = rows.reduce((n, r) => n + paise(r[k]), 0) / 100; });
  t.totalPaid = rows.filter((r) => r.paymentStatus === 'Paid').reduce((n, r) => n + paise(r.netPay), 0) / 100;
  t.paidEmployees = rows.filter((r) => r.paymentStatus === 'Paid').length;
  t.totalDeductionsAll = t.totalDeductions;
  return t;
}

const norm = (s) => String(s || '').trim().toLowerCase();
const codeKey = (c) => String(c || '').replace(/(\d+)/g, (m) => m.padStart(8, '0')).toLowerCase();

// filters: { q, department, paymentStatus }. Facets cascade: each filter's
// options are counted over the rows that match the OTHER filters.
async function monthDetails(month, filters = {}) {
  if (!isMonth(month)) throw Object.assign(new Error('month must be YYYY-MM'), { status: 400 });
  const entries = await prisma.employeePayrollRun.findMany({
    where: { month },
    include: { employee: { select: { id: true, name: true, employeeCode: true, department: true, designation: true } } },
  });
  const all = entries.map(shapeRow).sort((a, b) => (codeKey(a.employeeCode) < codeKey(b.employeeCode) ? -1 : codeKey(a.employeeCode) > codeKey(b.employeeCode) ? 1 : String(a.name || '').localeCompare(String(b.name || ''))));
  const q = norm(filters.q);
  const dept = filters.department ? String(filters.department) : '';
  const pay = filters.paymentStatus ? String(filters.paymentStatus) : '';
  const matchQ = (r) => !q || norm(`${r.employeeCode || ''} ${r.name || ''} ${r.designation || ''}`).includes(q);
  const matchDept = (r) => !dept || (r.department || 'Not set') === dept;
  const matchPay = (r) => !pay || r.paymentStatus === pay;
  const rows = all.filter((r) => matchQ(r) && matchDept(r) && matchPay(r));
  const count = (list, keyOf) => {
    const m = new Map();
    list.forEach((r) => { const k = keyOf(r); m.set(k, (m.get(k) || 0) + 1); });
    return m;
  };
  const deptCounts = count(all.filter((r) => matchQ(r) && matchPay(r)), (r) => r.department || 'Not set');
  const payCounts = count(all.filter((r) => matchQ(r) && matchDept(r)), (r) => r.paymentStatus);
  const departments = [...deptCounts.entries()].map(([value, n]) => ({ value, label: value, count: n })).sort((a, b) => a.label.localeCompare(b.label));
  if (dept && !deptCounts.has(dept)) departments.push({ value: dept, label: dept, count: 0 });
  const statuses = ['Paid', 'Not paid yet'].map((value) => ({ value, label: value, count: payCounts.get(value) || 0 })).filter((o) => o.count > 0 || o.value === pay);
  return {
    month, period: monthLabel(month), records: all.length, shown: rows.length,
    filtered: !!(q || dept || pay),
    rows, totals: totalsOf(rows), monthTotals: totalsOf(all),
    facets: { departments, statuses },
    importedCount: all.filter((r) => r.imported).length,
  };
}

const EXPORT_HEADERS = [
  'Employee ID', 'Name', 'Department', 'Designation', 'Working days', 'Paid days',
  'Basic', 'HRA', 'Conveyance', 'Arrears', 'Other allowances', 'Incentives', 'Gross',
  'PF', 'ESI', 'TDS', 'Loss of pay', 'Other deductions', 'Total deductions', 'Net pay', 'Payment status', 'Paid on', 'Note',
];
const blank = (n) => (n ? n : '');
function exportRows(d) {
  const rows = d.rows.map((r) => [
    r.employeeCode || '', r.name || '', r.department || '', r.designation || '', r.workingDays, r.paidDays,
    blank(r.basic), blank(r.hra), blank(r.conveyance), blank(r.arrears), blank(r.otherAllowances), blank(r.incentive), r.gross,
    blank(r.pf), blank(r.esi), blank(r.tds), blank(r.lossOfPay), blank(r.otherDeductions), r.totalDeductions, r.netPay, r.paymentStatus, r.paidOn || '', r.netNote || '',
  ]);
  const t = d.totals;
  rows.push([
    'TOTAL', `${t.employees} employee(s)`, '', '', '', '',
    t.basic, t.hra, t.conveyance, t.arrears, t.otherAllowances, t.incentive, t.gross,
    t.pf, t.esi, t.tds, t.lossOfPay, t.otherDeductions, t.totalDeductions, t.netPay, `Paid: ${t.totalPaid}`, '', '',
  ]);
  return rows;
}

module.exports = { monthDetails, shapeRow, totalsOf, EXPORT_HEADERS, exportRows, isMonth };
