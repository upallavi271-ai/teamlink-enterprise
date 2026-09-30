// ---------------------------------------------------------------------------
// Employee DOCUMENT TYPES — the one list, shared by the documents routes
// (upload / view / delete in routes/employees.js) and the Global Export field
// registry (utils/employeeExportFields.js), so a type added here appears in
// the upload picker AND gets its own "<type> on file" export column.
// ---------------------------------------------------------------------------

// 'Photo' is the employee's profile photo — the latest one is shown on
// their details form (components/EmployeePhoto.jsx). Images only.
const PHOTO_DOC_TYPE = 'Photo';
const OTHER_DOC_TYPE = 'Other Documents';
const DOC_TYPES = [
  PHOTO_DOC_TYPE, 'Aadhaar', 'PAN', 'Academic Certificate', 'Degree Certificate',
  'Experience Certificate', 'Joining Documents', OTHER_DOC_TYPE,
];
// Identity copies. Their names are never written to the audit log, and the
// export registry applies its stricter rule to them.
const SENSITIVE_DOC_TYPES = new Set(['Aadhaar', 'PAN']);
// Types the company expects on every file. The employee forms mark them ✱
// (Add Employee, Edit, My Profile); nothing refuses a save without them. Empty
// today — add a type from DOC_TYPES here to mark it.
const REQUIRED_DOC_TYPES = [];

module.exports = {
  PHOTO_DOC_TYPE, OTHER_DOC_TYPE, DOC_TYPES, SENSITIVE_DOC_TYPES, REQUIRED_DOC_TYPES,
};
