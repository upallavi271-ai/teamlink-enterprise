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
// Spec item 25 — the Document type dropdown, in this order.
const DOC_TYPES = [
  PHOTO_DOC_TYPE, 'Aadhaar', 'PAN', 'Passport', 'Education Certificate',
  'Experience Certificate', 'Offer Letter', 'Joining Letter', 'Bank Document', OTHER_DOC_TYPE,
];
// Names used before item 25. Not offered any more; a file already filed under
// one keeps its type and stays viewable (the documents list shows it).
const LEGACY_DOC_TYPES = ['Academic Certificate', 'Degree Certificate', 'Joining Documents'];
// Identity / bank copies. Their names are never written to the audit log, and
// the export registry applies its stricter rule to them.
const SENSITIVE_DOC_TYPES = new Set(['Aadhaar', 'PAN', 'Passport', 'Bank Document']);
// Types the company expects on every file. The employee forms mark them ✱
// (Add Employee, Edit, My Profile); nothing refuses a save without them. Empty
// today — add a type from DOC_TYPES here to mark it.
const REQUIRED_DOC_TYPES = [];

module.exports = {
  PHOTO_DOC_TYPE, OTHER_DOC_TYPE, DOC_TYPES, LEGACY_DOC_TYPES, SENSITIVE_DOC_TYPES, REQUIRED_DOC_TYPES,
};
