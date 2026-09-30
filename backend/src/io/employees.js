// ---------------------------------------------------------------------------
// EMPLOYEE MANAGEMENT — the employee MASTER TEMPLATE: sample, export, import
// (the user's rule, 2026-09-29: "an import sample file with ALL the form
// fields; export and import options for everyone; every export/import tells
// the Super Admin").
//
// THE TEMPLATE IS THE FORM. Every field the Add / Edit employee form and the
// profile carry is a column, in the form's section order. Export writes
// exactly these columns, so an export re-imports with NO changes.
//
// WHO
//   * Export — anyone who can open Employee Management, SCOPED: a TL gets
//     their team, an STL their department (utils/scope.js employeeWhere).
//   * Import applied DIRECTLY — only company-wide HRMS administrators who
//     hold Employee Management create AND edit (Super Admin / Admin / HR).
//   * Everyone else who can open Employee Management (Manager, Assistant
//     Manager, STL, TL …) submits an IMPORT REQUEST: it is checked against
//     THEIR scope, stored, and nothing changes until a Super Admin approves it
//     (routes/dataIo.js /requests).
//
// SENSITIVE FIELDS (export)
//   * Aadhaar: last four digits only, masked, read-only; never imported.
//   * Bank account number: in full for Super Admin / HR only; masked
//     (XXXXXX1234) for everybody else, and a masked value is ignored on import.
//   * Personal / statutory / bank / document columns follow the export field
//     registry (utils/employeeExportFields.js): a role that may not export a
//     group gets those cells BLANK — and blank never overwrites on import.
//   * CTC: only for roles that can already see salary. Passwords / tokens /
//     OTP state are never columns.
//
// IMPORT RULES: match on Employee ID; a blank Employee ID is a NEW employee
// and gets the next TL### (utils/employeeCode.js); a blank cell never
// overwrites; one audit row per changed field; an ID whose name clearly
// differs is refused (it is probably the wrong row); new rows get no login
// (logins are created on Employee Management / Administration → Users —
// one person = one login).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const io = require('../utils/moduleIo');
const { can } = require('../utils/permissions');
const { hrmsGlobal, scopeDepartments } = require('../utils/scope');
const { masterLists } = require('../utils/masters');
const { designationRows, syncLoginToEmployee } = require('../utils/employeeAdmin');
const { nextFrom, checkFormat } = require('../utils/employeeCode');
const exportFields = require('../utils/employeeExportFields');
const { hrStatusOf } = require('../utils/hrStatus');
const { REQUIRED_DOCUMENT_TYPES } = require('../utils/employeeExportFields');

const FEATURE = 'Employee Management';
const DEFAULT_ONBOARDING_TASKS = [
  'Offer letter signed', 'ID proof collected', 'PAN card collected',
  'Laptop/asset assigned', 'Reporting manager introduction', 'System access provisioned',
];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const MASKED_RE = /[xX•*]{3,}/;

// section · key · label · type/list · sensitivity (for the export mask)
// `field` is the Employee column it reads/writes (absent = derived / read-only).
const COLUMNS = [
  // --- Identity & job (the Add Employee form) ---
  { key: 'employeeCode', field: 'employeeCode', label: 'Employee ID', s: 'basic', example: 'TL999', note: 'Blank = a NEW employee (the next TL### is allocated). An existing ID updates that employee.' },
  { key: 'name', field: 'name', label: 'Employee Name', required: true, s: 'basic', example: 'Asha Rao' },
  { key: 'email', field: 'email', label: 'Email', s: 'basic', example: 'asha.rao@example.test', note: 'Required for a new employee. Must not belong to another employee or login.' },
  { key: 'phone', field: 'phone', label: 'Phone', s: 'basic', example: '9876543210', note: '10 digits.' },
  { key: 'department', field: 'department', label: 'Department', list: 'Departments', s: 'basic', example: 'Medical', note: 'Required for a new employee.' },
  { key: 'team', field: 'team', label: 'Team', list: 'Teams', s: 'standard', example: '' },
  { key: 'designation', field: 'designation', label: 'Designation', list: 'Designations', s: 'basic', example: 'Employee', note: 'Required for a new employee. Changing it re-derives the login\'s roles.' },
  { key: 'role', label: 'Role', readOnly: true, s: 'basic', note: 'Login role — change it on Administration → Users / Assign roles.' },
  { key: 'position', label: 'Position', readOnly: true, s: 'standard', note: 'The seat — change it on the Edit form.' },
  { key: 'reportingManager', label: 'Reporting Manager (Employee ID)', s: 'basic', example: 'TL101', note: 'Employee ID of an existing employee in your scope, or of another row in this file.' },
  { key: 'tl', field: 'tl', label: 'TL', s: 'standard', example: '' },
  { key: 'stl', field: 'stl', label: 'STL', s: 'standard', example: '' },
  { key: 'dateOfJoining', field: 'dateOfJoining', label: 'Date of Joining', type: 'date', s: 'basic', example: '2026-04-01' },
  { key: 'employeeType', field: 'employeeType', label: 'Employment Type', list: 'Employment Types', s: 'basic', example: 'Full Time' },
  { key: 'employmentStatus', field: 'employmentStatus', label: 'Employment Status', list: 'Employment Statuses', s: 'basic', example: 'Active', note: 'Blank = Active for a new employee.' },
  { key: 'location', field: 'location', label: 'Location', list: 'Locations', s: 'basic', example: 'Hyderabad' },
  { key: 'branch', field: 'branch', label: 'Branch', list: 'Branches', s: 'standard', example: 'Hyderabad' },
  { key: 'shift', field: 'shift', label: 'Shift', list: 'Shifts', s: 'standard', example: '' },
  { key: 'employmentExperience', field: 'employmentExperience', label: 'Experience', list: 'Experience', s: 'standard', example: 'Fresher' },
  // --- Personal ---
  { key: 'dateOfBirth', field: 'dateOfBirth', label: 'Date of Birth', type: 'date', s: 'personal', example: '1999-01-15' },
  { key: 'gender', field: 'gender', label: 'Gender', list: 'Genders', s: 'personal', example: 'Female' },
  { key: 'bloodGroup', field: 'bloodGroup', label: 'Blood Group', list: 'Blood Groups', s: 'personal', example: 'O+' },
  // --- Address ---
  { key: 'addressType', field: 'addressType', label: 'Address Type', list: 'Address Types', s: 'personal', example: 'Current' },
  { key: 'addressLine1', field: 'addressLine1', label: 'Address Line 1', s: 'personal', example: '' },
  { key: 'addressLine2', field: 'addressLine2', label: 'Address Line 2', s: 'personal', example: '' },
  { key: 'city', field: 'city', label: 'City', s: 'personal', example: 'Hyderabad' },
  { key: 'district', field: 'district', label: 'District', s: 'personal', example: '' },
  { key: 'state', field: 'state', label: 'State', s: 'personal', example: 'Telangana' },
  { key: 'country', field: 'country', label: 'Country', s: 'personal', example: 'India' },
  { key: 'postalCode', field: 'postalCode', label: 'PIN Code', s: 'personal', example: '500001' },
  // --- Emergency contact ---
  { key: 'emergencyContactName', field: 'emergencyContactName', label: 'Emergency Contact Name', s: 'personal', example: '' },
  { key: 'emergencyContactRelation', field: 'emergencyContactRelation', label: 'Emergency Contact Relation', s: 'personal', example: '' },
  { key: 'emergencyContactPhone', field: 'emergencyContactPhone', label: 'Emergency Contact Phone', s: 'personal', example: '' },
  // --- Education & work experience ---
  { key: 'educationDetails', field: 'educationDetails', label: 'Education Details', s: 'standard', example: 'B.Sc (Nursing) · 78% · Passout 2021' },
  { key: 'skills', field: 'skills', label: 'Skills & Certifications', s: 'standard', example: '' },
  // --- Bank & statutory ---
  { key: 'bankName', field: 'bankName', label: 'Bank Name', s: 'bank', example: '' },
  { key: 'bankAccountNumber', field: 'bankAccountNumber', label: 'Bank Account Number', s: 'bank', example: '', note: 'Exported in full to Super Admin / HR only; a masked value (XXXX…) is ignored on import.' },
  { key: 'ifscCode', field: 'ifscCode', label: 'IFSC Code', s: 'bank', example: '' },
  { key: 'panNumber', field: 'panNumber', label: 'PAN', s: 'statutory', example: '' },
  { key: 'uanNumber', field: 'uanNumber', label: 'UAN', s: 'statutory', example: '' },
  { key: 'pfNumber', field: 'pfNumber', label: 'PF Number', s: 'statutory', example: '' },
  { key: 'esiNumber', field: 'esiNumber', label: 'ESI Number', s: 'statutory', example: '' },
  { key: 'aadhaarLast4', label: 'Aadhaar (last 4)', readOnly: true, s: 'statutory', note: 'Only the last four digits exist; verified by the employee. Never imported.' },
  // --- Record status & documents (reference only) ---
  { key: 'login', label: 'Login', readOnly: true, s: 'standard' },
  { key: 'profileStatus', label: 'Profile Status', readOnly: true, s: 'standard' },
  { key: 'docsOnFile', label: 'Documents on File', readOnly: true, s: 'documents' },
  { key: 'docsMissing', label: 'Missing Required Documents', readOnly: true, s: 'documents' },
  { key: 'ctc', label: 'CTC (annual)', readOnly: true, s: 'salary', type: 'number', note: 'Only for roles that can see salary. Salary is changed on Payroll, never by this import.' },
];
const WRITABLE = COLUMNS.filter((c) => c.field && !c.readOnly);
const DATE_FIELDS = new Set(['dateOfJoining', 'dateOfBirth']);

const d10 = (v) => (v ? new Date(v).toISOString().slice(0, 10) : '');
const lower = (v) => io.str(v).toLowerCase();
const current = (e, field) => (DATE_FIELDS.has(field) ? d10(e[field]) : io.str(e[field]));
// The comparable form of a value: case-blind email, digits-only phones, upper-case PAN / IFSC.
function canon(field, v) {
  const s = io.str(v);
  if (field === 'email') return s.toLowerCase();
  if (field === 'phone' || field === 'emergencyContactPhone') { const dg = s.replace(/\D/g, ''); return dg.length > 10 ? dg.slice(-10) : dg; }
  if (field === 'panNumber' || field === 'ifscCode') return s.toUpperCase();
  return s;
}

// Bank account in full: Super Admin / HR only (the user's rule).
function mayFullBank(user) {
  const held = new Set([user.role, user.hrmsRole].filter(Boolean));
  return held.has('SUPER_ADMIN') || held.has('HR');
}
const maskAccount = (v) => { const s = io.str(v); return s ? `${'X'.repeat(Math.max(4, s.length - 4))}${s.slice(-4)}` : ''; };

// Two names are "the same person" when they share a real word (≥3 letters),
// or one contains the other once spaces are gone. Initials never count.
function sameName(a, b) {
  const t = (s) => lower(s).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[^a-z]+/g, ' ').trim().split(' ').filter((x) => x.length >= 3);
  const A = t(a); const B = t(b);
  if (!A.length || !B.length) return lower(a).replace(/\W/g, '') === lower(b).replace(/\W/g, '');
  if (A.some((x) => B.includes(x))) return true;
  const ja = A.join(''); const jb = B.join('');
  return ja.includes(jb) || jb.includes(ja);
}

async function caps(user, base) {
  const [create, edit] = await Promise.all([
    can(user, 'hrms', 'hrms', FEATURE, 'create'),
    can(user, 'hrms', 'hrms', FEATURE, 'edit'),
  ]);
  const direct = base.canView && create && edit && hrmsGlobal(user);
  return {
    ...base,
    // "Export for everyone who can open Employee Management" — scoped.
    canExport: base.canView,
    selfExport: false,
    canImport: direct,
    allowRequest: base.canView && !direct,
    importBlockedReason: direct ? null : 'Your import goes to the Super Admin as a request.',
  };
}

async function lists() {
  const m = await masterLists();
  return {
    Departments: m.departments,
    Teams: m.teamNames,
    Designations: m.designations,
    Roles: m.roles.map((r) => `${r.name} (${r.code})`),
    'Employment Types': m.employmentTypes,
    'Employment Statuses': m.employmentStatuses,
    Locations: m.locations,
    Branches: m.branches,
    Shifts: m.shifts,
    Experience: m.experience,
    Genders: m.genders,
    'Blood Groups': m.bloodGroups,
    'Address Types': m.addressTypes,
  };
}

// ---- export ---------------------------------------------------------------
async function exportRows(ctx, { employeeIds, filters }) {
  const user = ctx.user;
  const may = (s) => exportFields.mayExportSensitivity(user, s);
  const fullBank = mayFullBank(user);
  const needSalary = may('salary');
  const needDocs = may('documents');
  const employees = await prisma.employee.findMany({
    where: { id: { in: employeeIds } },
    include: {
      user: { select: { role: true, status: true } },
      reportingManager: { select: { employeeCode: true, name: true } },
      ...(needSalary ? { salaryStructure: true } : {}),
      ...(needDocs ? { documents: { select: { docType: true } } } : {}),
      positionAssignments: { where: { toDate: null }, include: { position: { select: { code: true } } } },
    },
    orderBy: [{ name: 'asc' }],
  });
  const f = filters || {};
  const q = lower(f.q);
  const rows = employees.filter((e) => {
    const loginStatus = e.user ? (e.user.status || 'Active') : 'No login';
    if (q && !`${e.name} ${e.employeeCode} ${e.email || ''}`.toLowerCase().includes(q)) return false;
    if (f.dept && e.department !== f.dept) return false;
    if (f.designation && e.designation !== f.designation) return false;
    if (f.role && ((e.user && e.user.role) || '') !== f.role) return false;
    if (f.status && hrStatusOf(e.employmentStatus || 'Active', loginStatus) !== f.status) return false;
    if (f.employmentStatus && (e.employmentStatus || 'Active') !== f.employmentStatus) return false;
    if (f.login && loginStatus !== f.login) return false;
    return true;
  });
  return rows.map((e) => {
    const out = {};
    COLUMNS.forEach((c) => {
      if (!may(c.s)) { out[c.key] = ''; return; }
      if (c.field) out[c.key] = current(e, c.field);
    });
    if (may('bank')) out.bankAccountNumber = fullBank ? io.str(e.bankAccountNumber) : maskAccount(e.bankAccountNumber);
    out.role = e.user ? e.user.role : '';
    out.position = e.positionAssignments && e.positionAssignments[0] ? e.positionAssignments[0].position.code : '';
    out.reportingManager = e.reportingManager ? e.reportingManager.employeeCode : '';
    out.aadhaarLast4 = may('statutory') && e.aadhaarLast4 ? `XXXX XXXX ${String(e.aadhaarLast4).slice(-4)}` : '';
    out.login = e.user ? (e.user.status || 'Active') : 'No login';
    out.profileStatus = e.profileStage || '';
    if (needDocs) {
      const types = [...new Set((e.documents || []).map((d) => d.docType))];
      out.docsOnFile = types.join(', ');
      out.docsMissing = REQUIRED_DOCUMENT_TYPES.filter((t) => !types.includes(t)).join(', ');
    }
    out.ctc = needSalary && e.salaryStructure ? e.salaryStructure.ctc : '';
    return out;
  });
}

// ---- validate ---------------------------------------------------------------
async function validate(rows, ctx) {
  const m = await masterLists();
  const desigMaster = (await designationRows()).map((r) => r.designation);
  const scopeDepts = scopeDepartments(ctx.user); // undefined = every department
  const codes = rows.map((r) => io.str(r.employeeCode)).filter(Boolean);
  const emails = rows.map((r) => lower(r.email)).filter(Boolean);
  const phones = rows.map((r) => io.str(r.phone).replace(/\D/g, '').slice(-10)).filter(Boolean);
  const [allCodes, byEmailEmp, byEmailUser, byPhone, full] = await Promise.all([
    prisma.employee.findMany({ select: { id: true, employeeCode: true, name: true } }),
    emails.length ? prisma.employee.findMany({ where: { email: { in: emails } }, select: { id: true, email: true, name: true, employeeCode: true } }) : [],
    emails.length ? prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true, email: true, name: true, employee: { select: { id: true } } } }) : [],
    phones.length ? prisma.employee.findMany({ where: { phone: { in: phones } }, select: { id: true, phone: true, name: true, employeeCode: true } }) : [],
    // The in-scope employees named by the file, in full, for the diff.
    prisma.employee.findMany({
      where: { id: { in: ctx.employees.list.filter((e) => codes.some((c) => c.toUpperCase() === io.str(e.employeeCode).toUpperCase())).map((e) => e.id) } },
      include: { reportingManager: { select: { employeeCode: true } } },
    }),
  ]);
  const codeAnywhere = new Map(allCodes.map((e) => [io.str(e.employeeCode).toUpperCase(), e]));
  const fullById = new Map(full.map((e) => [e.id, e]));
  const fileCodes = new Map();
  rows.forEach((r) => { const c = io.str(r.employeeCode).toUpperCase(); if (c && !fileCodes.has(c)) fileCodes.set(c, r.line); });
  const seenCode = new Map(); const seenEmail = new Map();

  return rows.map((r) => {
    const errors = io.requiredErrors(module.exports, r);
    const fail = (field, message) => errors.push({ field, message });
    const code = io.str(r.employeeCode);
    const codeU = code.toUpperCase();
    let existing = null;
    if (code) {
      if (seenCode.has(codeU)) fail('Employee ID', `Employee ID ${code} is also on row ${seenCode.get(codeU)}.`);
      else seenCode.set(codeU, r.line);
      const hit = ctx.employees.resolve(code);
      if (hit.employee && io.str(hit.employee.employeeCode).toUpperCase() === codeU) existing = fullById.get(hit.employee.id) || null;
      else if (codeAnywhere.has(codeU)) fail('Employee ID', `Employee ID ${code} belongs to an employee outside your scope.`);
      else {
        const fmt = checkFormat(code);
        if (fmt.error) fail('Employee ID', fmt.error);
      }
    }
    const label = existing ? `${existing.name} (${existing.employeeCode})` : `${io.str(r.name) || '(no name)'} — new${code ? ` ${code}` : ''}`;
    if (existing && io.str(r.name) && !sameName(r.name, existing.name)) {
      fail('Employee Name', `Employee ID ${existing.employeeCode} is "${existing.name}" in TeamLink, not "${io.str(r.name)}" — check the row (a name correction must keep at least one word of the old name; otherwise edit it on the form).`);
    }
    const isNew = !existing;
    if (isNew) {
      if (!io.str(r.email)) fail('Email', 'Email is required for a new employee.');
      if (!io.str(r.department)) fail('Department', 'Department is required for a new employee.');
      if (!io.str(r.designation)) fail('Designation', 'Designation is required for a new employee.');
    }

    // Normalise every writable value; blank = "leave as it is".
    const want = {};
    WRITABLE.forEach((c) => {
      const raw = io.str(r[c.key]);
      if (!raw) return;
      if (c.type === 'date') {
        const d = io.parseDate(raw);
        if (d.error) fail(c.label, `"${raw}" is not a valid date (YYYY-MM-DD).`);
        else want[c.field] = d.value;
        return;
      }
      want[c.field] = raw;
    });
    const cur = (f) => (existing ? current(existing, f) : '');
    // Same value written differently (case, spaces, +91) is NOT a change — an export re-imports clean.
    const same = (f, x, y) => canon(f, x) === canon(f, y);
    const changedTo = (f) => want[f] !== undefined && !same(f, want[f], cur(f));
    // Email
    if (want.email !== undefined) {
      want.email = want.email.toLowerCase();
      if (!changedTo('email') && !isNew) { /* unchanged — a legacy value is left alone */ } else if (!EMAIL_RE.test(want.email)) fail('Email', `"${want.email}" is not a valid email address.`);
      else if (changedTo('email') || isNew) {
        if (seenEmail.has(want.email)) fail('Email', `Email ${want.email} is also on row ${seenEmail.get(want.email)}.`);
        seenEmail.set(want.email, r.line);
        const e2 = byEmailEmp.find((x) => lower(x.email) === want.email && (!existing || x.id !== existing.id));
        const u2 = byEmailUser.find((x) => lower(x.email) === want.email && (!existing || !x.employee || x.employee.id !== existing.id));
        if (e2) fail('Email', `${want.email} already belongs to ${e2.name} (${e2.employeeCode}).`);
        else if (u2 && !(existing && existing.userId && u2.id === existing.userId)) fail('Email', `${want.email} already has a login (${u2.name}) — one person = one login.`);
      }
    }
    // Phones
    ['phone', 'emergencyContactPhone'].forEach((f) => {
      if (want[f] === undefined || (!isNew && !changedTo(f))) return;
      let p = want[f].replace(/\D/g, '');
      if (p.length === 12 && p.startsWith('91')) p = p.slice(2);
      if (!/^\d{10}$/.test(p)) { fail(f === 'phone' ? 'Phone' : 'Emergency Contact Phone', `"${want[f]}" should be 10 digits.`); return; }
      want[f] = p;
      if (f === 'phone' && changedTo('phone')) {
        const clash = byPhone.find((x) => x.phone === p && (!existing || x.id !== existing.id));
        if (clash) fail('Phone', `Phone ${p} already belongs to ${clash.name} (${clash.employeeCode}).`);
      }
    });
    // Department (master + scope)
    if (want.department !== undefined && !isNew && io.loose(want.department) === io.loose(cur('department'))) want.department = cur('department');
    if (want.department !== undefined) {
      const d = io.pick(m.departments, want.department);
      if (!d) fail('Department', `"${want.department}" is not a department (see the Lists sheet).`);
      else {
        want.department = d;
        if ((changedTo('department') || isNew) && scopeDepts !== undefined && !scopeDepts.includes(d)) fail('Department', `${d} is outside your scope.`);
      }
    }
    // Designation (master; an unchanged legacy value is kept)
    if (want.designation !== undefined) {
      const d = io.pick(desigMaster, want.designation);
      if (d) want.designation = d;
      else if (changedTo('designation') || isNew) fail('Designation', `"${want.designation}" is not in the designation master (see the Lists sheet).`);
    }
    // Closed lists: an unchanged legacy value passes, a new one must be in the list.
    [
      ['team', 'Team', m.teamNames], ['employeeType', 'Employment Type', m.employmentTypes], ['employmentStatus', 'Employment Status', m.employmentStatuses],
      ['employmentExperience', 'Experience', m.experience], ['gender', 'Gender', m.genders], ['bloodGroup', 'Blood Group', m.bloodGroups],
      ['addressType', 'Address Type', m.addressTypes],
    ].forEach(([f, lab, list]) => {
      if (want[f] === undefined) return;
      // The same word spelt differently (Full-time / Full Time) is the value already on file.
      if (!isNew && io.loose(want[f]) === io.loose(cur(f))) { want[f] = cur(f); return; }
      const v = io.pick(list, want[f]);
      if (v) want[f] = v;
      else if (changedTo(f) || isNew) fail(lab, `"${want[f]}" is not one of: ${list.join(', ')}.`);
    });
    // Open lists (branch, location, shift): free text, as the form allows.
    // Bank / statutory formats — checked only when the value changes.
    if (want.bankAccountNumber !== undefined && MASKED_RE.test(want.bankAccountNumber)) delete want.bankAccountNumber; // a masked export value
    if (want.panNumber !== undefined) { want.panNumber = want.panNumber.toUpperCase(); if (changedTo('panNumber') && !PAN_RE.test(want.panNumber)) fail('PAN', `"${want.panNumber}" is not a valid PAN (ABCDE1234F).`); }
    if (want.ifscCode !== undefined) { want.ifscCode = want.ifscCode.toUpperCase(); if (changedTo('ifscCode') && !IFSC_RE.test(want.ifscCode)) fail('IFSC Code', `"${want.ifscCode}" is not a valid IFSC (e.g. SBIN0001234).`); }
    if (want.postalCode !== undefined && changedTo('postalCode') && !/^\d{6}$/.test(want.postalCode)) fail('PIN Code', `"${want.postalCode}" should be 6 digits.`);
    // Reporting manager: an in-scope Employee ID, or another row of this file.
    let manager = null;
    const mgrRaw = io.str(r.reportingManager);
    if (mgrRaw) {
      const hit = ctx.employees.resolve(mgrRaw);
      if (hit.employee) {
        if (existing && hit.employee.id === existing.id) fail('Reporting Manager (Employee ID)', 'An employee cannot report to themselves.');
        else manager = { id: hit.employee.id, code: hit.employee.employeeCode };
      } else if (fileCodes.has(mgrRaw.toUpperCase()) && mgrRaw.toUpperCase() !== codeU) manager = { fileCode: mgrRaw.toUpperCase() };
      else fail('Reporting Manager (Employee ID)', hit.error);
    }

    if (errors.length) return { line: r.line, label, errors, action: 'error' };
    const changes = [];
    WRITABLE.forEach((c) => {
      if (c.field === 'employeeCode') return;
      if (want[c.field] === undefined) return;
      if (isNew || !same(c.field, want[c.field], cur(c.field))) changes.push({ field: c.label, key: c.field, from: isNew ? '' : cur(c.field), to: want[c.field] });
    });
    const curMgr = existing && existing.reportingManager ? existing.reportingManager.employeeCode : '';
    if (manager && (isNew || (manager.code || manager.fileCode) !== curMgr)) changes.push({ field: 'Reporting Manager', key: 'reportingManagerId', from: curMgr, to: manager.code || manager.fileCode });
    return {
      line: r.line,
      label,
      errors: [],
      action: isNew ? 'create' : (changes.length ? 'update' : 'nochange'),
      changes: changes.map(({ key, ...c }) => c),
      data: { existingId: existing ? existing.id : null, code: code || null, want, manager, changeKeys: changes.map((c) => c.key) },
    };
  });
}

// ---- apply --------------------------------------------------------------------
const toDb = (field, v) => (DATE_FIELDS.has(field) ? new Date(`${v}T00:00:00.000Z`) : v);

async function apply(valid, ctx) {
  const actorName = ctx.user.name || ctx.user.email;
  const via = ctx.request ? ` (import request by ${ctx.request.requestedBy}, approved by ${actorName})` : '';
  const codes = (await prisma.employee.findMany({ select: { employeeCode: true } })).map((e) => e.employeeCode);
  const reserved = valid.filter((v) => v.data.code).map((v) => v.data.code);
  const createdByCode = new Map();
  let created = 0; let updated = 0;
  const failed = [];
  const pendingManagers = [];

  // eslint-disable-next-line no-restricted-syntax
  for (const v of valid) {
    const { want, manager } = v.data;
    try {
      if (v.action === 'create') {
        const employeeCode = v.data.code || nextFrom(codes, reserved);
        codes.push(employeeCode);
        const data = {};
        Object.entries(want).forEach(([f, val]) => { if (f !== 'employeeCode') data[f] = toDb(f, val); });
        if (!data.employmentStatus) data.employmentStatus = 'Active';
        // eslint-disable-next-line no-await-in-loop
        const emp = await prisma.employee.create({
          data: {
            ...data,
            employeeCode,
            reportingManagerId: manager && manager.id ? manager.id : null,
            profileStage: 'Profile Incomplete',
            onboardingTasks: JSON.stringify(DEFAULT_ONBOARDING_TASKS.map((task) => ({ task, completed: false }))),
          },
        });
        createdByCode.set(employeeCode.toUpperCase(), emp.id);
        if (manager && manager.fileCode) pendingManagers.push({ id: emp.id, fileCode: manager.fileCode, line: v.line });
        // eslint-disable-next-line no-await-in-loop
        await prisma.auditLog.create({
          data: {
            userId: ctx.user.id, actorName, action: 'Employee created by import', entity: 'Employee', entityId: emp.id,
            toValue: `${employeeCode} ${emp.name}`, reason: `Employee Management import${via}`,
          },
        });
        created += 1;
      } else if (v.action === 'update') {
        // eslint-disable-next-line no-await-in-loop
        const before = await prisma.employee.findUnique({ where: { id: v.data.existingId }, include: { reportingManager: { select: { employeeCode: true } } } });
        const data = {};
        const audit = [];
        v.data.changeKeys.forEach((f) => {
          if (f === 'reportingManagerId') {
            if (manager && manager.id) {
              data.reportingManagerId = manager.id;
              audit.push({ field: 'reportingManagerId', label: 'Reporting Manager', from: before.reportingManager ? before.reportingManager.employeeCode : '', to: manager.code });
            } else if (manager && manager.fileCode) pendingManagers.push({ id: before.id, fileCode: manager.fileCode, line: v.line, from: before.reportingManager ? before.reportingManager.employeeCode : '' });
            return;
          }
          data[f] = toDb(f, want[f]);
          const col = COLUMNS.find((c) => c.field === f);
          audit.push({ field: f, label: col ? col.label : f, from: current(before, f), to: want[f] });
        });
        if (Object.keys(data).length) {
          // eslint-disable-next-line no-await-in-loop
          const after = await prisma.employee.update({ where: { id: before.id }, data });
          // The login follows a department / designation change, exactly as the Edit form does.
          if (data.department !== undefined || data.designation !== undefined) {
            // eslint-disable-next-line no-await-in-loop
            const synced = await syncLoginToEmployee(after, before, { designationChanged: data.designation !== undefined && data.designation !== before.designation });
            if (synced) audit.push({ field: 'login', label: 'Login re-derived', from: '', to: synced.changes.join('; ').slice(0, 200) });
            if (data.department !== undefined && data.department !== before.department) {
              // A seat belongs to a department: close the tenure (never delete it).
              // eslint-disable-next-line no-await-in-loop
              const held = await prisma.positionAssignment.findFirst({ where: { employeeId: before.id, toDate: null }, include: { position: true } });
              if (held && held.position.department && held.position.department !== after.department) {
                // eslint-disable-next-line no-await-in-loop
                await prisma.positionAssignment.update({ where: { id: held.id }, data: { toDate: new Date().toISOString().slice(0, 10) } });
                audit.push({ field: 'position', label: 'Position', from: held.position.code, to: '(vacated — seat belongs to another department)' });
              }
            }
          }
        }
        if (audit.length) {
          // eslint-disable-next-line no-await-in-loop
          await prisma.auditLog.createMany({
            data: audit.map((a) => ({
              userId: ctx.user.id, actorName, action: 'Employee updated by import', entity: 'Employee', entityId: before.id,
              field: a.field, fieldLabel: a.label, fromValue: String(a.from ?? ''), toValue: String(a.to ?? ''), reason: `Employee Management import${via}`,
            })),
          });
        }
        updated += 1;
      }
    } catch (err) {
      failed.push({ line: v.line, reason: `Database: ${String(err.message || err).split('\n').pop().slice(0, 200)}` });
    }
  }
  // Managers who are other rows of this file, now that both exist.
  // eslint-disable-next-line no-restricted-syntax
  for (const p of pendingManagers) {
    const mgrId = createdByCode.get(p.fileCode) || (ctx.employees.resolve(p.fileCode).employee || {}).id;
    if (!mgrId) { failed.push({ line: p.line, reason: `Reporting manager ${p.fileCode} was not imported, so it could not be linked.` }); continue; } // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    await prisma.employee.update({ where: { id: p.id }, data: { reportingManagerId: mgrId } });
    // eslint-disable-next-line no-await-in-loop
    await prisma.auditLog.create({
      data: {
        userId: ctx.user.id, actorName, action: 'Employee updated by import', entity: 'Employee', entityId: p.id,
        field: 'reportingManagerId', fieldLabel: 'Reporting Manager', fromValue: p.from || '', toValue: p.fileCode, reason: `Employee Management import${via}`,
      },
    });
  }
  return { created, updated, skipped: 0, failed };
}

module.exports = {
  key: 'employees',
  label: 'Employee master',
  module: 'Employee Management',
  what: 'employee records',
  feature: FEATURE,
  entity: 'Employee',
  sheet: 'Employees',
  allowRequest: true,
  columns: COLUMNS.map(({ s, field, ...c }) => c),
  instructions: [
    'Every field of the Add / Edit employee form is a column, in the form\'s order. An export of Employee Management uses exactly these columns, so an export can be edited and imported back.',
    'Employee ID: an existing ID UPDATES that employee (the name must still match); a blank ID creates a NEW employee with the next TL### ID. New employees get no login — create one on Employee Management.',
    'Blank cells never overwrite what TeamLink already has. To clear a value, edit it on the form.',
    'Required for a NEW employee: Employee Name, Email, Department, Designation.',
    'Aadhaar (last 4), Role, Position, Login, Profile Status, documents and CTC are reference columns — they are ignored on import. Bank account numbers shown masked (XXXX…) are ignored too.',
    'Super Admin / Admin / HR import directly. Everyone else submits an import REQUEST — nothing changes until a Super Admin approves it.',
  ],
  lists,
  caps,
  exportRows,
  validate,
  apply,
  // exported for tests / other screens
  COLUMNS,
};
