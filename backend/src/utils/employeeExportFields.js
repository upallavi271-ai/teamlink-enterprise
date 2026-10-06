// ---------------------------------------------------------------------------
// THE EMPLOYEE EXPORT FIELD REGISTRY — Employee Management → Global Export.
//
// ONE server-side list of every exportable Employee field, generated from the
// Employee MODEL itself (Prisma's DMMF) plus a handful of derived fields
// (Role, Reporting Manager, Login, Position, Salary). The screen never keeps
// its own list: GET /api/employees/export/fields hands it this registry, so a
// column added to the Employee model shows up in the picker by itself — and
// until somebody classifies it below it is treated as PERSONAL (restricted),
// never as open.
//
// FIELD-LEVEL PERMISSIONS live in ONE place: SENSITIVITY_ACCESS. The route
// strips any field the caller may not export even when the request names it
// by hand, and the panel shows those fields locked.
//
//   sensitivity  what                                   who may export it
//   basic        ID, name, work contact, dept, role …   anyone with Employee Management / export
//   standard     team, branch, shift, profile status …  anyone with Employee Management / export
//   personal     DOB, gender, blood group, address,     HR · Super Admin · Admin
//                emergency contact
//   statutory    PAN, UAN, PF, ESI, Aadhaar (last 4)    HR · Super Admin · Admin
//   bank         bank name, account number, IFSC        HR · Accounts · Super Admin · Admin
//   salary       CTC and structure (SalaryStructure)    HR · Accounts · Super Admin · Admin
//   documents    documents on file, count, missing       HR · Super Admin · Admin
//                required ones, one Yes/No per type,
//                the "Documents" sheet and the ZIP of
//                the files themselves
//
// AADHAAR: only the last four digits are stored (aadhaarLast4), and only
// those, masked, can ever be exported. The deprecated full-number column is
// excluded outright.
//
// DOCUMENTS (EmployeeDocument rows and their files): see the DOCUMENTS block
// below — REQUIRED_DOCUMENT_TYPES, the stricter rule for Aadhaar / PAN
// copies (SENSITIVE_DOCUMENTS) and the ZIP size cap all live there.
// ---------------------------------------------------------------------------
const { Prisma } = require('@prisma/client');
const { DOC_TYPES, SENSITIVE_DOC_TYPES } = require('./employeeDocTypes');

// WHO MAY EXPORT WHICH SENSITIVITY — the single definition.
const SENSITIVITY_ACCESS = {
  basic: 'any',
  standard: 'any',
  personal: ['HR', 'SUPER_ADMIN', 'ADMIN'],
  statutory: ['HR', 'SUPER_ADMIN', 'ADMIN'],
  bank: ['HR', 'ACCOUNTANT', 'SUPER_ADMIN', 'ADMIN'],
  salary: ['HR', 'ACCOUNTANT', 'SUPER_ADMIN', 'ADMIN'],
  documents: ['HR', 'SUPER_ADMIN', 'ADMIN'],
};

const SENSITIVITY_LABEL = {
  basic: 'Basic',
  standard: 'Work details',
  personal: 'Personal (HR / Super Admin / Admin)',
  statutory: 'Statutory (HR / Super Admin / Admin)',
  bank: 'Bank (HR / Accounts / Super Admin / Admin)',
  salary: 'Salary (HR / Accounts / Super Admin / Admin)',
  documents: 'Documents (HR / Super Admin / Admin)',
};

const ROLE_LABEL = { HR: 'HR', ACCOUNTANT: 'Accounts', SUPER_ADMIN: 'Super Admin', ADMIN: 'Admin' };

// Never exported: internal ids, OTP state, drafts, JSON blobs, and the
// deprecated full-Aadhaar column.
const EXCLUDED = new Set([
  'id', 'userId', 'reportingManagerId', 'aadhaarNumber', 'aadhaarVerifyRef',
  'verifyKind', 'verifyTarget', 'verifyLast4', 'verifyOtpHash', 'verifyOtpExpiresAt', 'verifyOtpAttempts',
  'onboardingTasks', 'offboardingTasks', 'pendingChanges', 'unlockedById', 'checkInMethods',
]);

const d10 = (v) => (v ? new Date(v).toISOString().slice(0, 10) : '');
const ts = (v) => (v ? new Date(v).toISOString().replace('T', ' ').slice(0, 16) : '');

// Classification + label for the model's own columns. Order here is the
// order in the picker; anything unlisted is appended after, as PERSONAL.
const MODEL_FIELDS = [
  ['employeeCode', 'Employee ID', 'basic', true],
  ['name', 'Employee Name', 'basic', true],
  ['email', 'Email', 'basic', true],
  ['phone', 'Phone', 'basic', true],
  ['department', 'Department', 'basic', true],
  ['designation', 'Designation', 'basic', true],
  // (role — derived, inserted after designation)
  ['dateOfJoining', 'Date of Joining', 'basic', true],
  // (reportingManager — derived)
  ['location', 'Location', 'basic', true],
  ['employeeType', 'Employment Type', 'basic', true],
  ['employmentStatus', 'Status', 'basic', true],
  ['team', 'Team', 'standard'],
  ['stl', 'STL', 'standard'],
  ['tl', 'TL', 'standard'],
  ['branch', 'Branch', 'standard'],
  ['shift', 'Shift', 'standard'],
  ['employmentExperience', 'Experience', 'standard'],
  ['skills', 'Skills & Certifications', 'standard'],
  ['educationDetails', 'Education', 'standard'],
  ['mobileVerified', 'Mobile Verified', 'standard'],
  ['mobileVerifiedAt', 'Mobile Verified On', 'standard'],
  ['profileStage', 'Profile Status', 'standard'],
  ['isLocked', 'Profile Locked', 'standard'],
  ['credentialsSentStatus', 'Sign-in Email', 'standard'],
  ['credentialsSentAt', 'Sign-in Email Sent On', 'standard'],
  ['offboardingStatus', 'Offboarding Status', 'standard'],
  ['unlockRequestStatus', 'Edit Request Status', 'standard'],
  ['unlockRequestReason', 'Edit Request Reason', 'standard'],
  ['unlockRequestCount', 'Edit Requests Made', 'standard'],
  ['reviewDecision', 'Last Review Decision', 'standard'],
  ['reviewNote', 'Last Review Note', 'standard'],
  ['reviewedAt', 'Last Reviewed On', 'standard'],
  ['reviewedByName', 'Last Reviewed By', 'standard'],
  ['unlockDecisionNote', 'Edit Request Decision Note', 'standard'],
  ['unlockDecidedAt', 'Edit Request Decided On', 'standard'],
  ['unlockExpiresAt', 'Edit Access Expires', 'standard'],
  ['unlockedByName', 'Edit Access Granted By', 'standard'],
  ['unlockedAt', 'Edit Access Granted On', 'standard'],
  ['unlockGrantReason', 'Edit Access Reason', 'standard'],
  ['unlockGrantSection', 'Edit Access Section', 'standard'],
  ['createdAt', 'Record Created', 'standard'],
  ['updatedAt', 'Record Updated', 'standard'],
  ['dateOfBirth', 'Date of Birth', 'personal'],
  ['gender', 'Gender', 'personal'],
  ['bloodGroup', 'Blood Group', 'personal'],
  ['emergencyContactName', 'Emergency Contact Name', 'personal'],
  ['emergencyContactPhone', 'Emergency Contact Phone', 'personal'],
  ['emergencyContactRelation', 'Emergency Contact Relation', 'personal'],
  ['addressType', 'Address Type', 'personal'],
  ['address', 'Address (legacy)', 'personal'],
  ['addressLine1', 'Address Line 1', 'personal'],
  ['addressLine2', 'Address Line 2', 'personal'],
  ['city', 'City', 'personal'],
  ['district', 'District', 'personal'],
  ['state', 'State', 'personal'],
  ['country', 'Country', 'personal'],
  ['postalCode', 'PIN Code', 'personal'],
  ['panNumber', 'PAN', 'statutory'],
  ['uanNumber', 'UAN', 'statutory'],
  ['pfNumber', 'PF Number', 'statutory'],
  ['esiNumber', 'ESI Number', 'statutory'],
  ['aadhaarLast4', 'Aadhaar (last 4 only)', 'statutory'],
  ['aadhaarVerifiedAt', 'Aadhaar Verified On', 'statutory'],
  ['aadhaarVerifyNote', 'Aadhaar Verification Note', 'statutory'],
  ['bankName', 'Bank Name', 'bank'],
  ['bankAccountNumber', 'Bank Account Number', 'bank'],
  ['ifscCode', 'IFSC Code', 'bank'],
];

// Derived fields: not a column on Employee, computed from its relations.
const DERIVED = {
  role: { label: 'Role', sensitivity: 'basic', default: true, after: 'designation', get: (e) => (e.user ? e.user.role : '') },
  reportingManager: { label: 'Reporting Manager', sensitivity: 'basic', default: true, after: 'dateOfJoining', get: (e) => (e.reportingManager ? e.reportingManager.name : '') },
  loginStatus: { label: 'Login', sensitivity: 'standard', get: (e) => (e.user ? (e.user.status || 'Active') : 'No login') },
  hrStatus: { label: 'HR Status', sensitivity: 'standard', get: (e, ctx) => ctx.hrStatusOf(e.employmentStatus, e.user ? (e.user.status || 'Active') : 'No login') },
  position: { label: 'Position', sensitivity: 'standard', get: (e, ctx) => (ctx.seat(e) ? ctx.seat(e).code : '') },
  positionFrom: { label: 'In Position From', sensitivity: 'standard', get: (e, ctx) => (ctx.seat(e) ? d10(ctx.seat(e).from) : '') },
  salaryPayMode: { label: 'Pay Mode', sensitivity: 'salary', salary: true, get: (e) => (e.salaryStructure ? e.salaryStructure.payMode || '' : '') },
  salaryCtc: { label: 'CTC (annual)', sensitivity: 'salary', salary: true, get: (e) => (e.salaryStructure ? e.salaryStructure.ctc : '') },
  salaryBasic: { label: 'Basic (monthly)', sensitivity: 'salary', salary: true, get: (e) => (e.salaryStructure ? e.salaryStructure.basic : '') },
  salaryHra: { label: 'HRA (monthly)', sensitivity: 'salary', salary: true, get: (e) => (e.salaryStructure ? e.salaryStructure.hra : '') },
  salarySpecial: { label: 'Special Allowance (monthly)', sensitivity: 'salary', salary: true, get: (e) => (e.salaryStructure ? e.salaryStructure.specialAllowance : '') },
  salaryBonus: { label: 'Bonus', sensitivity: 'salary', salary: true, get: (e) => (e.salaryStructure ? e.salaryStructure.bonus : '') },
  salaryEffectiveFrom: { label: 'Salary Effective From', sensitivity: 'salary', salary: true, get: (e) => (e.salaryStructure ? e.salaryStructure.effectiveFrom || '' : '') },
};

// --- DOCUMENTS -------------------------------------------------------------
// The documents every employee is expected to have on file. "Missing Required
// Documents" is measured against THIS list and nothing else.
// 'Education Certificate' replaced 'Degree Certificate' (spec item 25); a file
// still filed under the old name counts too (see the documents count below).
const REQUIRED_DOCUMENT_TYPES = ['Aadhaar', 'PAN', 'Education Certificate', 'Photo'];

// AADHAAR / PAN COPIES are identity documents. The rule:
//   * only these roles may export the COPY — its row on the Documents sheet
//     and its file in the ZIP. (Today the same roles as the whole Documents
//     level; kept separate so it can be tightened without touching anything
//     else.) Whether one is on file — "Aadhaar on File", the count, "Missing
//     Required Documents" — is compliance status, not the copy, and stays
//     true for anyone allowed the Documents group.
//   * their document / file NAMES are masked wherever an export writes them
//     (sheet cells and ZIP entry names): any run of 4+ digits becomes XXXX,
//     because people name the scan after the number. The file BYTES are the
//     original — masking a scan is not something a server can do honestly.
const SENSITIVE_DOCUMENTS = {
  types: [...SENSITIVE_DOC_TYPES],
  roles: ['HR', 'SUPER_ADMIN', 'ADMIN'],
};

// "Include document files (ZIP)" refuses anything larger than this — the
// caller is told to narrow the filters instead.
const DOCUMENT_ZIP_LIMITS = { maxFiles: 2000, maxBytes: 500 * 1024 * 1024 };

const docTypeSlug = (t) => String(t).replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : '')).replace(/^./, (c) => c.toUpperCase());
const typesOnFile = (docs) => DOC_TYPES.filter((t) => docs.some((d) => d.docType === t))
  .concat([...new Set(docs.map((d) => d.docType))].filter((t) => !DOC_TYPES.includes(t)));

// Each needs ctx.docsOf(e): that employee's documents this caller may export
// (the route loads them only when a Documents field or the ZIP is asked for).
const DOCUMENT_FIELDS = {
  docsOnFile: { label: 'Documents on File', get: (e, ctx) => typesOnFile(ctx.docsOf(e)).join(', ') },
  docCount: { label: 'Document Count', get: (e, ctx) => ctx.docsOf(e).length },
  docsMissing: {
    label: 'Missing Required Documents',
    get: (e, ctx) => REQUIRED_DOCUMENT_TYPES.filter((t) => !ctx.docsOf(e).some((d) => d.docType === t
      || (t === 'Education Certificate' && ['Degree Certificate', 'Academic Certificate'].includes(d.docType)))).join(', '),
  },
  docsLastUploaded: {
    label: 'Last Document Uploaded On',
    get: (e, ctx) => ts(ctx.docsOf(e).reduce((m, d) => (!m || new Date(d.uploadedAt) > new Date(m) ? d.uploadedAt : m), null)),
  },
  ...Object.fromEntries(DOC_TYPES.map((t) => [`docHas${docTypeSlug(t)}`, {
    label: `${t} on File`,
    get: (e, ctx) => (ctx.docsOf(e).some((d) => d.docType === t) ? 'Yes' : 'No'),
  }])),
};

const humanize = (k) => k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim();

let cached = null;
// The registry: [{ key, label, sensitivity, default, get(e, ctx), salary }]
function registry() {
  if (cached) return cached;
  const model = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Employee');
  const scalars = new Map(model.fields.filter((f) => f.kind === 'scalar' || f.kind === 'enum').map((f) => [f.name, f]));
  const out = [];
  const seen = new Set();
  const pushDerivedAfter = (key) => {
    Object.entries(DERIVED).forEach(([dk, d]) => {
      if (d.after === key && !seen.has(dk)) { out.push({ key: dk, ...d }); seen.add(dk); }
    });
  };
  const fromModel = (name, label, sensitivity, dflt) => {
    const f = scalars.get(name);
    if (!f || EXCLUDED.has(name)) return;
    const isDate = f.type === 'DateTime';
    const isBool = f.type === 'Boolean';
    const get = name === 'aadhaarLast4'
      ? (e) => (e.aadhaarLast4 ? `XXXX XXXX ${String(e.aadhaarLast4).slice(-4)}` : '')
      : (e) => {
        const v = e[name];
        if (v === null || v === undefined) return '';
        if (isDate) return ['createdAt', 'updatedAt', 'reviewedAt', 'unlockExpiresAt', 'unlockedAt', 'unlockDecidedAt', 'credentialsSentAt', 'mobileVerifiedAt', 'aadhaarVerifiedAt'].includes(name) ? ts(v) : d10(v);
        if (isBool) return v ? 'Yes' : 'No';
        return v;
      };
    out.push({ key: name, label, sensitivity, default: !!dflt, get });
    seen.add(name);
    pushDerivedAfter(name);
  };
  MODEL_FIELDS.forEach(([name, label, sensitivity, dflt]) => fromModel(name, label, sensitivity, dflt));
  // Columns on the model nobody has classified yet: listed, but PERSONAL.
  scalars.forEach((f, name) => { if (!seen.has(name) && !EXCLUDED.has(name)) fromModel(name, humanize(name), 'personal', false); });
  Object.entries(DERIVED).forEach(([dk, d]) => { if (!seen.has(dk)) { out.push({ key: dk, ...d }); seen.add(dk); } });
  Object.entries(DOCUMENT_FIELDS).forEach(([dk, d]) => { out.push({ key: dk, sensitivity: 'documents', documents: true, ...d }); seen.add(dk); });
  cached = out;
  return out;
}

// The roles a login holds for this decision.
function rolesOf(user) {
  return new Set([user && user.role, user && user.hrmsRole, user && user.accountsRole].filter(Boolean));
}

function mayExportSensitivity(user, sensitivity) {
  const rule = SENSITIVITY_ACCESS[sensitivity] || SENSITIVITY_ACCESS.personal;
  if (rule === 'any') return true;
  const held = rolesOf(user);
  return rule.some((r) => held.has(r));
}

// --- documents: who may take which, and how names are written ---------------
function mayExportDocuments(user) {
  return mayExportSensitivity(user, 'documents');
}

// One document (row, Yes column or file) — Aadhaar / PAN need SENSITIVE_DOCUMENTS.roles too.
function mayExportDocumentType(user, docType) {
  if (!mayExportDocuments(user)) return false;
  if (!SENSITIVE_DOCUMENTS.types.includes(docType)) return true;
  const held = rolesOf(user);
  return SENSITIVE_DOCUMENTS.roles.some((r) => held.has(r));
}

const maskDigits = (s) => String(s || '').replace(/\d{4,}/g, 'XXXX');
// A document / file name as an export may write it.
function exportedDocName(docType, name) {
  if (!name) return '';
  return SENSITIVE_DOCUMENTS.types.includes(docType) ? maskDigits(name) : String(name);
}

// The "Include document files (ZIP)" switch, as the panel draws it.
function documentFilesAccess(user) {
  const allowed = mayExportDocuments(user);
  return {
    allowed,
    lockedReason: allowed ? null : `Only ${SENSITIVITY_ACCESS.documents.map((r) => ROLE_LABEL[r] || r).join(', ')} may export document files.`,
    maxFiles: DOCUMENT_ZIP_LIMITS.maxFiles,
    maxBytes: DOCUMENT_ZIP_LIMITS.maxBytes,
  };
}

// What the panel draws: every field, with whether THIS caller may pick it.
function fieldsFor(user) {
  return registry().map((f) => {
    const allowed = mayExportSensitivity(user, f.sensitivity);
    const rule = SENSITIVITY_ACCESS[f.sensitivity];
    return {
      key: f.key,
      label: f.label,
      sensitivity: f.sensitivity,
      group: SENSITIVITY_LABEL[f.sensitivity] || f.sensitivity,
      sensitive: rule !== 'any',
      default: !!f.default && allowed,
      allowed,
      lockedReason: allowed ? null : `Only ${rule.map((r) => ROLE_LABEL[r] || r).join(', ')} may export this field.`,
    };
  });
}

// Split a requested key list into what may go out and what is stripped.
function authorise(user, requested) {
  const byKey = new Map(registry().map((f) => [f.key, f]));
  const keys = [...new Set((Array.isArray(requested) ? requested : String(requested || '').split(','))
    .map((k) => String(k).trim()).filter(Boolean))];
  const allowed = [];
  const stripped = [];
  const unknown = [];
  keys.forEach((k) => {
    const f = byKey.get(k);
    if (!f) unknown.push(k);
    else if (mayExportSensitivity(user, f.sensitivity)) allowed.push(f);
    else stripped.push(f);
  });
  return { allowed, stripped, unknown };
}

module.exports = {
  SENSITIVITY_ACCESS,
  SENSITIVITY_LABEL,
  registry,
  fieldsFor,
  authorise,
  mayExportSensitivity,
  REQUIRED_DOCUMENT_TYPES,
  SENSITIVE_DOCUMENTS,
  DOCUMENT_ZIP_LIMITS,
  mayExportDocuments,
  mayExportDocumentType,
  exportedDocName,
  documentFilesAccess,
};
