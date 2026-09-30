// ---------------------------------------------------------------------------
// PAYROLL — PAYSLIPS: export only.
//
// The export already exists: GET /api/insights/payroll/export (scoped by
// payslipReach(), ?employeeId= for one employee, ?mine=1 / no export right =
// own payslips; it goes through exportKit.sendTable, which notifies the Super
// Admin). The screen passes that URL to <DataIoBar>, so this spec only
// describes the rows and the rights.
//
// NO IMPORT, deliberately: a payslip is the OUTPUT of an approved payroll
// run (payrollEngine.writePayslip) — it carries a snapshot of the salary
// version, attendance input and statutory deductions that produced it, and it
// feeds the Accounts journal. A spreadsheet of payslips would bypass the run,
// its approval chain and the ledger. Salary structures and attendance inputs
// are importable instead (payroll-salary, payroll-attendance); the run then
// produces the payslips.
// ---------------------------------------------------------------------------
const NO_IMPORT = 'Payslips are produced by the payroll run (Process Payroll → approve), so they cannot be imported. Import salary structures or attendance inputs instead.';

const columns = [
  ['employeeCode', 'Employee ID'], ['employeeName', 'Name'], ['department', 'Department'], ['month', 'Month'],
  ['workingDays', 'Working Days'], ['lopDays', 'LOP Days'], ['basic', 'Basic'], ['hra', 'HRA'], ['allowances', 'Allowances'],
  ['gross', 'Gross'], ['deductions', 'Deductions'], ['netPay', 'Net Pay'],
].map(([key, label]) => ({ key, label, readOnly: true, example: '' }));

module.exports = {
  key: 'payslips',
  label: 'Payslips',
  module: 'Payroll',
  what: 'payslips',
  feature: 'Payroll & Compensation',
  exportVia: '/insights/payroll/export',
  sheet: 'Payslips',
  entity: 'Payslip',
  columns,
  // Export follows the insights endpoint's rule (export right = payslipReach
  // scope, otherwise own payslips). Import is never offered.
  caps: async (user, base) => ({ ...base, canImport: false, allowRequest: false, importBlockedReason: NO_IMPORT }),
  async validate(rows) {
    return rows.map((r) => ({ line: r.line, errors: [{ field: 'File', message: NO_IMPORT }], action: 'error' }));
  },
  async apply() {
    return { created: 0, updated: 0, skipped: 0, failed: [] };
  },
};
