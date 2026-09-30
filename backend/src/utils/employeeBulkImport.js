// ---------------------------------------------------------------------------
// EMPLOYEE BULK IMPORT — Employee Management → Bulk Import.
//
//   Download Sample Excel  →  fill it in  →  upload .xlsx / .csv
//   →  Check file (row-wise validation, writes nothing)
//   →  Import valid rows (ONLY the rows that pass; the rest are reported)
//   →  counts + a downloadable summary with every failed row and its reasons
//
// IMPORT_FIELDS below is THE definition of the file. The sample workbook, its
// Instructions sheet, the header matching and the validation are all built
// from it, so the sample can never ask for a column the importer ignores.
// The fields are the existing Employee Management fields (the same ones Add
// Employee writes) — nothing new is stored.
//
// ONE PERSON = ONE LOGIN. An email that already belongs to an employee OR to
// a login is refused, in the file and in the database, so an import can never
// mint a second identity for somebody who already has one. Logins are created
// only when asked (createLogins) and exactly as before: role and product
// access derived from the designation, NO password generated or emailed — a
// single-use set-password link instead.
//
// Rows whose Employee ID starts with "EXAMPLE-" are the sample's example rows
// and are skipped, so the sample re-imported unchanged imports nothing.
// ---------------------------------------------------------------------------
const XLSX = require('xlsx');
const prisma = require('../db');
const { nextFrom } = require('./employeeCode');
const { EMP_TYPES, EMP_STATUSES } = require('./adminCatalog');
const { DEPTS } = require('./atsVocab');
const { designationRows, productRolesForDesignation, loginRoleFor } = require('./employeeAdmin');
const { mappingFor } = require('./identity');
const { sendCredentials, unguessablePasswordHash } = require('./employeeInvite');
const { SYSTEM_ACCOUNT_ROLES } = require('./systemAccounts');

const EXAMPLE_PREFIX = 'EXAMPLE-';
const MAX_ROWS = 1000;

const IMPORT_FIELDS = [
  { key: 'employeeCode', label: 'Employee ID', required: false, width: 14,
    rule: 'Unique. Leave blank to allocate the next free TL number (e.g. TL517). Letters, digits, - _ . / only.',
    aliases: ['employee id', 'emp id', 'employee code', 'code', 'id'] },
  { key: 'name', label: 'Employee Name', required: true, width: 24,
    rule: 'Full name.', aliases: ['name', 'employee name', 'full name'] },
  { key: 'email', label: 'Email', required: true, width: 28,
    rule: 'Valid, unique email. Must not already belong to an employee or a login (one person = one login).',
    aliases: ['email', 'email id', 'work email', 'official email'] },
  { key: 'phone', label: 'Phone', required: false, width: 14,
    rule: '10 digits, unique.', aliases: ['phone', 'mobile', 'mobile number', 'phone number', 'contact'] },
  { key: 'department', label: 'Department', required: true, width: 16, list: 'departments',
    rule: 'One of the departments listed below (Department master).', aliases: ['department', 'dept'] },
  { key: 'team', label: 'Team', required: false, width: 16,
    rule: 'Optional team name within the department.', aliases: ['team'] },
  { key: 'designation', label: 'Designation', required: true, width: 20, list: 'designations',
    rule: 'Job title. When "Create logins" is ticked it must be one of the designations listed below — it decides the login\'s product access.',
    aliases: ['designation', 'job title', 'title'] },
  { key: 'role', label: 'Role', required: false, width: 18, list: 'roles',
    rule: 'Optional. One ACTIVE role from Role & Permission Management (listed below). Applied to the login when one is created. Super Admin cannot be imported — it is a system account, not an employee.',
    aliases: ['role', 'user role', 'login role'] },
  { key: 'dateOfJoining', label: 'Date of Joining', required: false, width: 16, date: true,
    rule: 'YYYY-MM-DD (e.g. 2026-04-01). DD-MM-YYYY, DD/MM/YYYY and Excel date cells are also accepted.',
    aliases: ['date of joining', 'doj', 'joining date', 'date joined'] },
  { key: 'reportingManager', label: 'Reporting Manager', required: false, width: 22,
    rule: 'Employee ID (preferred), email or exact name of an existing employee in your scope — or the Employee ID of another row in this file.',
    aliases: ['reporting manager', 'manager', 'reports to'] },
  { key: 'location', label: 'Location', required: false, width: 14,
    rule: 'Office location, e.g. Hyderabad.', aliases: ['location', 'office', 'work location'] },
  { key: 'employeeType', label: 'Employment Type', required: false, width: 16, list: 'employmentTypes',
    rule: 'One of the employment types listed below.', aliases: ['employment type', 'employee type', 'type'] },
  { key: 'employmentStatus', label: 'Status', required: false, width: 14, list: 'statuses',
    rule: 'One of the statuses listed below. Blank = Active.', aliases: ['status', 'employment status'] },
];

const EXAMPLES = [
  {
    employeeCode: 'EXAMPLE-001', name: 'Asha Rao (example — skipped)', email: 'asha.rao@example.test', phone: '9876543210',
    department: '', team: '', designation: 'Employee', role: 'EMPLOYEE', dateOfJoining: '2026-04-01',
    reportingManager: '', location: 'Hyderabad', employeeType: 'Full Time', employmentStatus: 'Active',
  },
  {
    employeeCode: 'EXAMPLE-002', name: 'Ravi Kumar (example — skipped)', email: 'ravi.kumar@example.test', phone: '9876543211',
    department: '', team: '', designation: 'Employee', role: 'EMPLOYEE', dateOfJoining: '2026-04-15',
    reportingManager: 'EXAMPLE-001', location: 'Bengaluru', employeeType: 'Contract', employmentStatus: 'Probation',
  },
];

const norm = (s) => String(s == null ? '' : s).trim();
const key = (s) => norm(s).toLowerCase().replace(/\*|\(required\)|\(optional\)/g, '').replace(/[\s_-]+/g, ' ').trim();
const loose = (s) => norm(s).toLowerCase().replace(/[\s_-]+/g, '');

const HEADER_TO_KEY = new Map();
IMPORT_FIELDS.forEach((f) => {
  [f.label, f.key, ...(f.aliases || [])].forEach((h) => HEADER_TO_KEY.set(key(h), f.key));
});

// ---------------------------------------------------------------------------
// The option lists the sample and the validation both read.
// ---------------------------------------------------------------------------
const PRIVILEGED_ROLES = ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'HR'];
const EXTERNAL = ['CLIENT', 'CANDIDATE'];

// ACTIVE roles from Role & Permission Management (utils/roleRegistry.js). If
// that registry is not available the catalogue codes are used instead.
async function activeRoles() {
  try {
    // eslint-disable-next-line global-require
    const reg = require('./roleRegistry');
    const rows = await reg.listRoles({ activeOnly: true });
    if (rows && rows.length) {
      return rows.filter((r) => !EXTERNAL.includes(r.code)).map((r) => ({ code: r.code, name: r.name || r.code }));
    }
  } catch { /* fall through to the catalogue */ }
  // eslint-disable-next-line global-require
  const { CATALOG_ROLES } = require('./roleAccess');
  // eslint-disable-next-line global-require
  const { atsRoleLabel } = require('./atsVocab');
  return CATALOG_ROLES.filter((c) => !EXTERNAL.includes(c)).map((c) => ({ code: c, name: atsRoleLabel(c) || c }));
}

// scopeDepts: undefined = every department; else the importer's departments.
async function optionLists({ scopeDepts, designationFilter }) {
  const [depts, desigRows, roles] = await Promise.all([
    prisma.department.findMany({ select: { name: true }, orderBy: { name: 'asc' } }),
    designationRows(),
    activeRoles(),
  ]);
  const master = depts.length ? depts.map((d) => d.name) : DEPTS;
  const departments = scopeDepts === undefined ? master : master.filter((d) => scopeDepts.includes(d));
  const allowedDesig = designationFilter ? designationFilter(desigRows) : desigRows;
  return {
    departments,
    masterDepartments: master,
    designations: allowedDesig.map((r) => r.designation),
    allDesignations: desigRows.map((r) => r.designation),
    roles,
    employmentTypes: EMP_TYPES,
    statuses: EMP_STATUSES,
  };
}

// ---------------------------------------------------------------------------
// SAMPLE WORKBOOK
// ---------------------------------------------------------------------------
function sampleWorkbook(opts) {
  const wb = XLSX.utils.book_new();
  const headers = IMPORT_FIELDS.map((f) => (f.required ? `${f.label} *` : f.label));
  const dept0 = opts.departments[0] || '';
  const examples = EXAMPLES.map((ex) => IMPORT_FIELDS.map((f) => (f.key === 'department' ? dept0 : ex[f.key] || '')));
  const ws = XLSX.utils.aoa_to_sheet([headers, ...examples]);
  ws['!cols'] = IMPORT_FIELDS.map((f) => ({ wch: f.width || 16 }));
  // Text-format the ID, phone and date columns so Excel keeps leading zeros
  // and does not turn 2026-04-01 into a serial.
  const textCols = ['employeeCode', 'phone', 'dateOfJoining'].map((k) => IMPORT_FIELDS.findIndex((f) => f.key === k));
  for (let r = 0; r <= examples.length + 200; r += 1) {
    textCols.forEach((c) => {
      const ref = XLSX.utils.encode_cell({ r, c });
      if (!ws[ref]) ws[ref] = { t: 's', v: '' };
      ws[ref].z = '@';
    });
  }
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: examples.length + 200, c: IMPORT_FIELDS.length - 1 } });
  XLSX.utils.book_append_sheet(wb, ws, 'Employees');

  const ins = [
    ['EMPLOYEE BULK IMPORT — INSTRUCTIONS'],
    [''],
    ['1. Fill in the "Employees" sheet, one employee per row, below the header row. Do not rename or reorder the headers.'],
    ['2. Columns marked * are required.'],
    [`3. Rows whose Employee ID starts with "${EXAMPLE_PREFIX}" are examples and are ALWAYS skipped — overwrite or delete them.`],
    ['4. Upload the file on Employee Management → Bulk Import, press "Check file", then "Import valid rows". Only rows that pass every check are imported; the others are listed with their reasons and can be downloaded as a summary.'],
    ['5. Dates: YYYY-MM-DD (e.g. 2026-04-01).'],
    ['6. One person = one login: an email already used by an employee or a login is refused. Tick "Create logins" to give each imported employee a login; no password is generated or emailed — each gets a single-use set-password link.'],
    [''],
    ['Field', 'Required', 'Rule / allowed values'],
    ...IMPORT_FIELDS.map((f) => [f.label, f.required ? 'Yes *' : 'No', f.rule]),
    [''],
    ['ALLOWED VALUES'],
  ];
  const lists = [
    ['Department', opts.departments],
    ['Designation', opts.designations],
    ['Role (active)', opts.roles.map((r) => `${r.code} — ${r.name}`)],
    ['Employment Type', opts.employmentTypes],
    ['Status', opts.statuses],
  ];
  const longest = Math.max(...lists.map(([, v]) => v.length));
  ins.push(lists.map(([h]) => h));
  for (let i = 0; i < longest; i += 1) ins.push(lists.map(([, v]) => v[i] || ''));
  const wsI = XLSX.utils.aoa_to_sheet(ins);
  wsI['!cols'] = [{ wch: 26 }, { wch: 22 }, { wch: 70 }, { wch: 22 }, { wch: 16 }];
  XLSX.utils.book_append_sheet(wb, wsI, 'Instructions');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ---------------------------------------------------------------------------
// PARSING — .xlsx / .xls / .csv, or rows already parsed by the screen.
// ---------------------------------------------------------------------------
function dateFromSerial(n) {
  const p = XLSX.SSF.parse_date_code(Number(n));
  if (!p || !p.y) return null;
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

function mapRow(obj) {
  const row = {};
  const unknown = [];
  Object.entries(obj).forEach(([h, v]) => {
    const k = HEADER_TO_KEY.get(key(h));
    if (k) row[k] = v;
    else if (norm(h)) unknown.push(norm(h));
  });
  return { row, unknown };
}

function parseUpload(buffer, fileName = '') {
  const isCsv = /\.csv$/i.test(fileName) || /\.txt$/i.test(fileName);
  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer', raw: isCsv, cellDates: false });
  } catch (err) {
    return { error: `That file could not be read as Excel or CSV (${String(err.message || err).slice(0, 80)}).` };
  }
  const sheetName = wb.SheetNames.find((n) => n.toLowerCase() === 'employees')
    || wb.SheetNames.find((n) => n.toLowerCase() !== 'instructions')
    || wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  if (!ws) return { error: 'That workbook has no sheets.' };
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true, blankrows: true });
  const headerIdx = aoa.findIndex((r) => r.some((c) => norm(c) !== ''));
  if (headerIdx < 0) return { error: 'That file has no header row.' };
  const headers = aoa[headerIdx].map((h) => norm(h));
  const mapped = headers.map((h) => HEADER_TO_KEY.get(key(h)) || null);
  if (!mapped.includes('name')) {
    return { error: `The header row must include "Employee Name". Found: ${headers.filter(Boolean).join(', ') || '(nothing)'}. Download the sample for the exact headers.` };
  }
  const rows = [];
  for (let i = headerIdx + 1; i < aoa.length; i += 1) {
    const cells = aoa[i];
    const row = { line: i + 1 };
    mapped.forEach((k, c) => {
      if (!k) return;
      let v = cells[c];
      if (typeof v === 'number' && IMPORT_FIELDS.find((f) => f.key === k).date) v = dateFromSerial(v) || String(v);
      row[k] = v == null ? '' : String(v).trim();
    });
    if (IMPORT_FIELDS.some((f) => norm(row[f.key]))) rows.push(row);
  }
  return {
    sheetName,
    rows,
    ignoredColumns: headers.filter((h, c) => h && !mapped[c]),
  };
}

// Rows the screen parsed from pasted CSV: [{header: value}] objects.
function rowsFromObjects(list) {
  return list.map((obj, i) => {
    const { row } = mapRow(obj || {});
    const out = { line: Number(obj && obj.__line) || i + 2 };
    IMPORT_FIELDS.forEach((f) => { out[f.key] = norm(row[f.key]); });
    return out;
  }).filter((r) => IMPORT_FIELDS.some((f) => r[f.key]));
}

// ---------------------------------------------------------------------------
// VALIDATION
// ---------------------------------------------------------------------------
function parseDate(v) {
  const s = norm(v);
  if (!s) return { value: null };
  let y; let m; let d;
  let mt = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (mt) [, y, m, d] = mt;
  else {
    mt = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
    if (mt) [, d, m, y] = mt;
    else if (/^\d{5}$/.test(s)) return parseDate(dateFromSerial(Number(s)));
    else return { error: true };
  }
  const dt = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (Number.isNaN(dt.getTime()) || dt.getUTCFullYear() !== Number(y) || dt.getUTCMonth() !== Number(m) - 1 || dt.getUTCDate() !== Number(d)) return { error: true };
  if (Number(y) < 1950 || Number(y) > new Date().getFullYear() + 1) return { error: true };
  return { value: dt, iso: dt.toISOString().slice(0, 10) };
}

function pickFrom(list, value) {
  const want = loose(value);
  return list.find((x) => loose(x) === want) || null;
}

// ctx: { scopeDepts, globalImporter, createLogins, managerWhere, designationFilter }
async function validateRows(rows, ctx) {
  const opts = await optionLists(ctx);
  const errors = [];
  const skipped = [];
  const prepared = [];

  const emails = [...new Set(rows.flatMap((r) => [norm(r.email), norm(r.email).toLowerCase()]).filter(Boolean))];
  const phones = rows.map((r) => norm(r.phone).replace(/\s/g, '')).filter(Boolean);
  const codes = rows.map((r) => norm(r.employeeCode)).filter(Boolean);
  const [empByEmail, userByEmail, empByPhone, empByCode, managers] = await Promise.all([
    emails.length ? prisma.employee.findMany({ where: { email: { in: emails } }, select: { email: true, name: true, employeeCode: true } }) : [],
    emails.length ? prisma.user.findMany({ where: { email: { in: emails } }, select: { email: true, name: true } }) : [],
    phones.length ? prisma.employee.findMany({ where: { phone: { in: phones } }, select: { phone: true, name: true, employeeCode: true } }) : [],
    codes.length ? prisma.employee.findMany({ select: { employeeCode: true, name: true } }) : [],
    prisma.employee.findMany({ where: ctx.managerWhere || {}, select: { id: true, name: true, email: true, employeeCode: true } }),
  ]);
  const lower = (s) => String(s || '').toLowerCase();
  const eMail = new Map(empByEmail.map((e) => [lower(e.email), e]));
  const uMail = new Map(userByEmail.map((u) => [lower(u.email), u]));
  const ePhone = new Map(empByPhone.map((e) => [String(e.phone), e]));
  const eCode = new Map(empByCode.map((e) => [lower(e.employeeCode), e]));

  const seenEmail = new Map();
  const seenPhone = new Map();
  const seenCode = new Map();
  const fileCodes = new Map();
  rows.forEach((r) => { if (norm(r.employeeCode) && !/^example-/i.test(norm(r.employeeCode))) fileCodes.set(lower(norm(r.employeeCode)), r.line); });

  rows.forEach((raw) => {
    const r = {};
    IMPORT_FIELDS.forEach((f) => { r[f.key] = norm(raw[f.key]); });
    const line = raw.line;
    if (r.employeeCode.toUpperCase().startsWith(EXAMPLE_PREFIX)) { skipped.push({ row: line, name: r.name, reason: 'Example row from the sample file' }); return; }
    const rowErrors = [];
    const fail = (field, message, expected) => rowErrors.push({ row: line, line, field, message, expected: expected || '', name: r.name });

    IMPORT_FIELDS.filter((f) => f.required).forEach((f) => { if (!r[f.key]) fail(f.label, `${f.label} is required.`, f.rule); });

    // Employee ID
    if (r.employeeCode) {
      if (!/^[A-Za-z0-9._\-/]{1,30}$/.test(r.employeeCode)) fail('Employee ID', `"${r.employeeCode}" is not a valid Employee ID.`, 'letters, digits, - _ . / (max 30)');
      const k = lower(r.employeeCode);
      if (seenCode.has(k)) fail('Employee ID', `Employee ID ${r.employeeCode} also appears on row ${seenCode.get(k)} of this file.`, 'a unique Employee ID');
      else seenCode.set(k, line);
      const clash = eCode.get(k);
      if (clash) fail('Employee ID', `Employee ID ${r.employeeCode} already belongs to ${clash.name}.`, 'an Employee ID not already in use');
    }
    // Email — the one-person rule.
    if (r.email) {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email)) fail('Email', `"${r.email}" is not a valid email address.`, 'name@example.com');
      const k = lower(r.email);
      if (seenEmail.has(k)) fail('Email', `Email ${r.email} also appears on row ${seenEmail.get(k)} of this file.`, 'a unique email');
      else seenEmail.set(k, line);
      const e = eMail.get(k);
      if (e) fail('Email', `Email ${r.email} already belongs to employee ${e.name} (${e.employeeCode}).`, 'an email not already on an employee');
      const u = uMail.get(k);
      if (u && !e) fail('Email', `${r.email} already has a login (${u.name}). One person = one login — link that login instead of importing a second identity.`, 'an email with no existing login');
    }
    // Phone
    if (r.phone) {
      const p = r.phone.replace(/\s/g, '');
      if (!/^\d{10}$/.test(p)) fail('Phone', `Phone "${r.phone}" should be 10 digits.`, '10 digits, e.g. 9876543210');
      else {
        if (seenPhone.has(p)) fail('Phone', `Phone ${p} also appears on row ${seenPhone.get(p)} of this file.`, 'a unique phone');
        else seenPhone.set(p, line);
        const e = ePhone.get(p);
        if (e) fail('Phone', `Phone ${p} already belongs to ${e.name} (${e.employeeCode}).`, 'a phone not already on an employee');
        r.phone = p;
      }
    }
    // Department — must exist in the master, and be in the importer's scope.
    if (r.department) {
      const inMaster = pickFrom(opts.masterDepartments, r.department);
      if (!inMaster) fail('Department', `Department "${r.department}" does not exist.`, `one of ${opts.masterDepartments.join(', ')}`);
      else if (ctx.scopeDepts !== undefined && !ctx.scopeDepts.includes(inMaster)) {
        fail('Department', `${inMaster} is outside your scope.`, ctx.scopeDepts.join(' or '));
      } else r.department = inMaster;
    }
    // Designation — known (and not a privileged one for a scoped importer).
    let mappingName = null;
    if (r.designation) {
      mappingName = pickFrom(opts.allDesignations, r.designation);
      if (mappingName && !opts.designations.includes(mappingName)) {
        fail('Designation', `You cannot create a ${mappingName}. Roles beyond ${opts.designations.join(', ')} are granted on Administration → Users after the record exists.`, `one of ${opts.designations.join(', ')}`);
      } else if (!mappingName && ctx.createLogins) {
        fail('Designation', `"${r.designation}" is not a designation this organisation maps to a role, so a login cannot be derived from it.`, `one of ${opts.designations.join(', ')}`);
      }
      if (mappingName) r.designation = mappingName;
    }
    // Role — must exist and be ACTIVE in Role & Permission Management.
    if (r.role) {
      const role = opts.roles.find((x) => lower(x.code) === lower(r.role) || lower(x.name) === lower(r.role) || loose(x.name) === loose(r.role));
      if (!role) fail('Role', `Role "${r.role}" does not exist or is not active.`, `one of ${opts.roles.map((x) => x.name).join(', ')}`);
      else if (SYSTEM_ACCOUNT_ROLES.includes(role.code)) fail('Role', 'Super Admin is a system account, not an employee — it cannot be imported.', 'an employee role');
      else if (PRIVILEGED_ROLES.includes(role.code) && !ctx.globalImporter) fail('Role', `Only a company-wide administrator can import someone as ${role.name}.`, 'a non-privileged role');
      else r.role = role.code;
    }
    // Date of Joining
    if (r.dateOfJoining) {
      const d = parseDate(r.dateOfJoining);
      if (d.error) fail('Date of Joining', `"${r.dateOfJoining}" is not a valid date.`, 'YYYY-MM-DD, e.g. 2026-04-01');
      else { r.dateOfJoiningDate = d.value; r.dateOfJoining = d.iso; }
    }
    // Employment Type / Status
    if (r.employeeType) {
      const t = pickFrom(opts.employmentTypes, r.employeeType);
      if (!t) fail('Employment Type', `"${r.employeeType}" is not an employment type.`, `one of ${opts.employmentTypes.join(', ')}`);
      else r.employeeType = t;
    }
    if (r.employmentStatus) {
      const s = pickFrom(opts.statuses, r.employmentStatus);
      if (!s) fail('Status', `"${r.employmentStatus}" is not a status.`, `one of ${opts.statuses.join(', ')}`);
      else r.employmentStatus = s;
    }
    // Reporting Manager — resolvable to exactly one person.
    if (r.reportingManager) {
      const m = lower(r.reportingManager);
      const byCode = managers.filter((e) => lower(e.employeeCode) === m);
      const byMail = managers.filter((e) => lower(e.email) === m);
      const byName = managers.filter((e) => lower(e.name) === m);
      const hit = byCode.length ? byCode : byMail.length ? byMail : byName;
      if (hit.length === 1) r.reportingManagerId = hit[0].id;
      else if (hit.length > 1) fail('Reporting Manager', `"${r.reportingManager}" matches ${hit.length} employees.`, 'use the manager\'s Employee ID');
      else if (fileCodes.has(m) && lower(r.employeeCode) !== m) r.reportingManagerRow = fileCodes.get(m);
      else fail('Reporting Manager', `"${r.reportingManager}" could not be found in your scope.`, 'the Employee ID, email or exact name of an existing employee');
    }

    errors.push(...rowErrors);
    prepared.push({ ...r, line, raw, valid: rowErrors.length === 0 });
  });

  // A row whose manager is another row of THIS file needs that row to import.
  let changed = true;
  while (changed) {
    changed = false;
    const byLine = new Map(prepared.map((p) => [p.line, p]));
    prepared.forEach((p) => {
      if (p.valid && p.reportingManagerRow) {
        const mgr = byLine.get(p.reportingManagerRow);
        if (!mgr || !mgr.valid) {
          p.valid = false;
          changed = true;
          errors.push({ row: p.line, line: p.line, field: 'Reporting Manager', message: `The manager on row ${p.reportingManagerRow} fails validation, so this row cannot link to them.`, expected: 'fix that row, or name an existing employee', name: p.name });
        }
      }
    });
  }
  errors.sort((a, b) => a.row - b.row);
  return { errors, prepared, skipped, opts };
}

function previewPayload({ rows, errors, prepared, skipped, createLogins, scopeLabel }) {
  const valid = prepared.filter((p) => p.valid);
  const invalidLines = new Set(prepared.filter((p) => !p.valid).map((p) => p.line));
  return {
    ok: errors.length === 0,
    rowCount: rows.length,
    validCount: valid.length,
    invalidCount: invalidLines.size,
    skippedCount: skipped.length,
    skipped,
    valid: valid.map((p) => ({
      row: p.line, employeeCode: p.employeeCode || '(auto)', name: p.name, email: p.email, phone: p.phone,
      department: p.department, designation: p.designation, role: p.role, dateOfJoining: p.dateOfJoining,
      reportingManager: p.reportingManager, location: p.location, employeeType: p.employeeType,
      employmentStatus: p.employmentStatus || 'Active', willCreateLogin: !!(createLogins && p.email),
    })),
    invalid: errors,
    errors,
    createLogins,
    scope: scopeLabel,
    canImport: valid.length > 0,
    message: `${valid.length} valid row(s), ${invalidLines.size} invalid row(s)${skipped.length ? `, ${skipped.length} example row(s) skipped` : ''}. `
      + (valid.length ? `Only the ${valid.length} valid row(s) will be imported${createLogins ? ' with logins' : ''}.` : 'Nothing can be imported as the file stands.'),
  };
}

// ---------------------------------------------------------------------------
// IMPORT — each valid row in its own transaction; a row the database refuses
// is reported as failed and never takes the others with it.
// ---------------------------------------------------------------------------
async function importRows({ prepared, errors, skipped, createLogins, req, profileIncomplete, onboardingTasks }) {
  // A blank Employee ID gets the next TL<nnn> (utils/employeeCode.js) — the
  // same series Add Employee issues. Codes typed on other rows of this file
  // are reserved too, so an allocated code never collides with one of them.
  const codes = (await prisma.employee.findMany({ select: { employeeCode: true } })).map((e) => e.employeeCode);
  const taken = new Set(codes.map((c) => c.toLowerCase()));
  prepared.forEach((p) => { if (p.valid && p.employeeCode) taken.add(String(p.employeeCode).toLowerCase()); });
  const codeFor = () => {
    const code = nextFrom(codes, [...taken]);
    taken.add(code.toLowerCase());
    return code;
  };
  const failures = new Map(); // line -> reasons[]
  errors.forEach((e) => {
    if (!failures.has(e.line)) failures.set(e.line, []);
    failures.get(e.line).push(`${e.field}: ${e.message}`);
  });

  const imported = [];
  const createdByLine = new Map();
  const invites = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const r of prepared.filter((p) => p.valid)) {
    const employeeCode = r.employeeCode || codeFor();
    try {
      // eslint-disable-next-line no-await-in-loop
      const mapping = createLogins ? await mappingFor(r.designation) : null;
      // eslint-disable-next-line no-await-in-loop
      const out = await prisma.$transaction(async (tx) => {
        let userId = null;
        if (createLogins && r.email) {
          const user = await tx.user.create({
            data: {
              name: r.name,
              email: r.email.toLowerCase(),
              // NEVER a generated password that somebody then has to email.
              passwordHash: await unguessablePasswordHash(),
              role: r.role || loginRoleFor(mapping),
              username: r.email.toLowerCase(),
              status: 'Active',
              branch: r.location || null,
              team: r.team || null,
              atsDepartment: r.department || null,
              ...productRolesForDesignation(mapping),
              atsScopeDepartments: r.department || null,
              atsScopeTeams: r.team || null,
              hrmsAccess: mapping ? !!mapping.hrms : true,
              atsAccess: mapping ? !!mapping.ats : false,
              accountsAccess: mapping ? !!mapping.accounts : false,
              landingWorkspace: (mapping && mapping.landing) || null,
            },
          });
          userId = user.id;
        }
        const employee = await tx.employee.create({
          data: {
            employeeCode,
            name: r.name,
            email: r.email ? r.email.toLowerCase() : null,
            phone: r.phone || null,
            department: r.department || null,
            team: r.team || null,
            designation: r.designation || null,
            location: r.location || null,
            dateOfJoining: r.dateOfJoiningDate || null,
            employeeType: r.employeeType || null,
            employmentStatus: r.employmentStatus || 'Active',
            reportingManagerId: r.reportingManagerId || null,
            userId,
            profileStage: profileIncomplete,
            onboardingTasks: JSON.stringify(onboardingTasks.map((task) => ({ task, completed: false }))),
          },
        });
        return { employee, userId };
      }, { timeout: 30000 });
      imported.push({ row: r.line, employeeCode, name: r.name, id: out.employee.id, email: r.email, userId: out.userId });
      createdByLine.set(r.line, out);
    } catch (err) {
      taken.delete(employeeCode.toLowerCase());
      failures.set(r.line, [`Database: ${String(err.message || err).split('\n').pop().slice(0, 200)}`]);
      r.valid = false;
    }
  }

  // Managers named by another row of this file, now that both exist.
  // eslint-disable-next-line no-restricted-syntax
  for (const r of prepared.filter((p) => p.valid && p.reportingManagerRow && createdByLine.has(p.line))) {
    const mgr = createdByLine.get(r.reportingManagerRow);
    if (mgr) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.employee.update({ where: { id: createdByLine.get(r.line).employee.id }, data: { reportingManagerId: mgr.employee.id } });
    }
  }

  // Invitations AFTER the rows are saved, each one guarded.
  if (createLogins) {
    // eslint-disable-next-line no-restricted-syntax
    for (const { employee, userId } of createdByLine.values()) {
      if (!userId) continue; // eslint-disable-line no-continue
      let outcome;
      try {
        // eslint-disable-next-line no-await-in-loop
        outcome = await sendCredentials({ employee, userId, actingUser: req.user, req });
      } catch (err) {
        outcome = { sent: false, status: `Failed: ${String(err.message || err).slice(0, 200)}` };
      }
      invites.push({ name: employee.name, email: employee.email, status: outcome.status, sent: !!outcome.sent, link: outcome.link || null });
    }
  }

  const failedRows = prepared.filter((p) => failures.has(p.line)).map((p) => ({
    row: p.line,
    values: IMPORT_FIELDS.reduce((o, f) => ({ ...o, [f.key]: norm(p.raw[f.key]) }), {}),
    reasons: failures.get(p.line),
  }));
  return { imported, failedRows, invites, skipped };
}

// The downloadable summary: Summary · Failed Rows (with reasons) · Imported.
function summaryWorkbook({ imported, failedRows, skipped, fileName, by }) {
  const wb = XLSX.utils.book_new();
  const summary = [
    ['Employee bulk import — summary'],
    ['File', fileName || '(pasted CSV)'],
    ['Run by', by || ''],
    ['Run at', new Date().toLocaleString('en-GB')],
    ['Imported', imported.length],
    ['Failed', failedRows.length],
    ['Skipped (example rows)', skipped.length],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), 'Summary');
  const failed = [['Row', ...IMPORT_FIELDS.map((f) => f.label), 'Reasons']]
    .concat(failedRows.map((f) => [f.row, ...IMPORT_FIELDS.map((x) => f.values[x.key] || ''), f.reasons.join(' | ')]));
  const wsF = XLSX.utils.aoa_to_sheet(failed);
  wsF['!cols'] = [{ wch: 6 }, ...IMPORT_FIELDS.map((f) => ({ wch: f.width || 14 })), { wch: 90 }];
  XLSX.utils.book_append_sheet(wb, wsF, 'Failed Rows');
  const ok = [['Row', 'Employee ID', 'Employee Name', 'Email', 'Login created']]
    .concat(imported.map((i) => [i.row, i.employeeCode, i.name, i.email || '', i.userId ? 'Yes' : 'No']));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ok), 'Imported');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = {
  IMPORT_FIELDS,
  EXAMPLE_PREFIX,
  MAX_ROWS,
  optionLists,
  sampleWorkbook,
  parseUpload,
  rowsFromObjects,
  validateRows,
  previewPayload,
  importRows,
  summaryWorkbook,
};
