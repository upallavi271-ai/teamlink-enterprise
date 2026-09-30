// ---------------------------------------------------------------------------
// DOCUMENTS — export only.
//
// The export already exists: GET /api/insights/documents/export — every
// in-scope employee's documents on file (EmployeeDocument: type, name, file
// name, uploaded by / on) and their policy acknowledgments, ?employeeId= for
// one employee, own records without the export right; it goes through
// exportKit.sendTable, which notifies the Super Admin. The screen passes that
// URL to <DataIoBar>, so this spec only describes the rows and the rights.
//
// NO IMPORT, deliberately: a document here IS a file (the stored bytes behind
// EmployeeDocument.file, or a published policy). A spreadsheet can carry a
// file NAME but not the file, so an "imported document" would be a row
// pointing at nothing; and an imported acknowledgment would claim an employee
// read and accepted a policy they never opened. Documents are uploaded on the
// employee's profile (Documents) and policies are published on this screen.
// ---------------------------------------------------------------------------
const NO_IMPORT = 'Documents are files — a spreadsheet cannot carry them, and an acknowledgment must come from the employee. Upload documents on the employee\'s profile; publish policies here.';

const columns = [
  ['employeeCode', 'Employee ID'], ['employeeName', 'Name'], ['department', 'Department'], ['record', 'Record'],
  ['document', 'Document'], ['type', 'Type / Category'], ['file', 'File'], ['date', 'Date'], ['by', 'By'],
].map(([key, label]) => ({ key, label, readOnly: true, example: '' }));

module.exports = {
  key: 'documents',
  label: 'Employee documents',
  module: 'Documents',
  what: 'employee documents',
  feature: 'Employee Services',
  exportVia: '/insights/documents/export',
  sheet: 'Employee documents',
  entity: 'EmployeeDocument',
  columns,
  caps: async (user, base) => ({ ...base, canImport: false, allowRequest: false, importBlockedReason: NO_IMPORT }),
  async validate(rows) {
    return rows.map((r) => ({ line: r.line, errors: [{ field: 'File', message: NO_IMPORT }], action: 'error' }));
  },
  async apply() {
    return { created: 0, updated: 0, skipped: 0, failed: [] };
  },
};
