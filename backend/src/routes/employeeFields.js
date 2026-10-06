// ---------------------------------------------------------------------------
// EMPLOYEE MANAGEMENT -> MANAGE FIELDS (HRMS spec item 15).
//
// Administrators add their own fields to the employee form — Text, Number,
// Date, Dropdown, Multi-select, Checkbox, File — with simple validation
// (required, min / max, longest text, the list of choices). Values are kept
// per employee in EmployeeFieldValue.
//
//   GET    /api/employee-fields                 the fields (active; ?all=1 for the Manage screen)
//   POST   /api/employee-fields                 add a field          (Employee Management / configure)
//   PUT    /api/employee-fields/:id             edit a field         (configure)
//   DELETE /api/employee-fields/:id             remove — or switch off when people already have a value
//   GET    /api/employee-fields/values/:employeeId          one employee's values (view + scope)
//   PUT    /api/employee-fields/values/:employeeId          save values          (edit + scope)
//   POST   /api/employee-fields/values/:employeeId/:fieldId/file   upload (edit + scope)
//   GET    /api/employee-fields/values/:employeeId/:fieldId/file   download (view + scope)
//
// Files reuse utils/attachments.js (PDF / PNG / JPEG / WebP, 5 MB, random
// stored names, private folder) and are only ever served through the scope
// check below. Nothing here writes the employee's core columns.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm, can } = require('../middleware/auth');
const { employeeWhere, hrmsGlobal } = require('../utils/scope');
const attachments = require('../utils/attachments');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);

const TYPES = ['TEXT', 'NUMBER', 'DATE', 'DROPDOWN', 'MULTISELECT', 'CHECKBOX', 'FILE'];
const TYPE_LABEL = {
  TEXT: 'Text', NUMBER: 'Number', DATE: 'Date', DROPDOWN: 'Dropdown', MULTISELECT: 'Multi-select', CHECKBOX: 'Checkbox', FILE: 'File',
};
const DEFAULT_MAX_TEXT = 500;

// Until the migration has run the tables do not exist; say so in words.
const ready = () => !!(prisma.employeeField && prisma.employeeFieldValue);
router.use((req, res, next) => {
  if (ready()) return next();
  return res.status(503).json({ error: 'Manage Fields needs a database update that has not been applied yet. Please try again later.' });
});

const parseOptions = (raw) => {
  if (Array.isArray(raw)) return raw;
  try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
};

function shape(f, valueCount) {
  return {
    id: f.id,
    key: f.key,
    label: f.label,
    type: f.type,
    typeLabel: TYPE_LABEL[f.type] || f.type,
    options: parseOptions(f.options),
    required: !!f.required,
    minValue: f.minValue,
    maxValue: f.maxValue,
    maxLength: f.maxLength,
    helpText: f.helpText || '',
    active: !!f.active,
    position: f.position,
    ...(valueCount !== undefined ? { valueCount } : {}),
  };
}

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'field';

// Checks a field DEFINITION. Returns { data } or { error }.
function cleanDefinition(body, existing) {
  const label = String(body.label ?? (existing ? existing.label : '')).trim();
  if (!label) return { error: 'Give the field a name.' };
  if (label.length > 60) return { error: 'The field name can have at most 60 characters.' };
  const type = String(body.type ?? (existing ? existing.type : '')).toUpperCase();
  if (!TYPES.includes(type)) return { error: 'Choose a field type: Text, Number, Date, Dropdown, Multi-select, Checkbox or File.' };
  let options = body.options !== undefined ? body.options : (existing ? parseOptions(existing.options) : []);
  if (typeof options === 'string') options = options.split(/\r?\n|,/);
  options = [...new Set((options || []).map((o) => String(o).trim()).filter(Boolean))];
  if (['DROPDOWN', 'MULTISELECT'].includes(type)) {
    if (options.length < 2) return { error: 'A dropdown or multi-select needs at least 2 choices.' };
    if (options.length > 100) return { error: 'At most 100 choices.' };
    if (options.some((o) => o.length > 80)) return { error: 'Each choice can have at most 80 characters.' };
  } else options = [];
  const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
  const minValue = type === 'NUMBER' ? num(body.minValue !== undefined ? body.minValue : existing && existing.minValue) : null;
  const maxValue = type === 'NUMBER' ? num(body.maxValue !== undefined ? body.maxValue : existing && existing.maxValue) : null;
  if ((minValue !== null && !Number.isFinite(minValue)) || (maxValue !== null && !Number.isFinite(maxValue))) return { error: 'Smallest and largest must be numbers.' };
  if (minValue !== null && maxValue !== null && minValue > maxValue) return { error: 'The smallest number cannot be bigger than the largest.' };
  let maxLength = type === 'TEXT' ? num(body.maxLength !== undefined ? body.maxLength : existing && existing.maxLength) : null;
  if (maxLength !== null && (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > 2000)) return { error: 'Longest text must be a whole number from 1 to 2000.' };
  if (type === 'TEXT' && maxLength === null) maxLength = DEFAULT_MAX_TEXT;
  const helpText = String(body.helpText ?? (existing ? existing.helpText || '' : '')).trim().slice(0, 200) || null;
  const required = body.required !== undefined ? !!body.required : !!(existing && existing.required);
  return { data: { label, type, options: options.length ? JSON.stringify(options) : null, minValue, maxValue, maxLength, helpText, required } };
}

// Checks ONE value against its field. Returns { value } (string or null) or { error }.
function cleanValue(f, raw) {
  const name = f.label;
  const empty = raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && !raw.length);
  if (f.type === 'CHECKBOX') {
    const on = raw === true || raw === 'true' || raw === 1 || raw === '1';
    if (f.required && !on) return { error: `Tick "${name}".` };
    return { value: on ? 'true' : 'false' };
  }
  if (empty) return f.required ? { error: `"${name}" is required.` } : { value: null };
  switch (f.type) {
    case 'TEXT': {
      const s = String(raw).trim();
      const max = f.maxLength || DEFAULT_MAX_TEXT;
      if (s.length > max) return { error: `"${name}" can have at most ${max} characters.` };
      return { value: s };
    }
    case 'NUMBER': {
      const n = Number(String(raw).replace(/,/g, ''));
      if (!Number.isFinite(n)) return { error: `"${name}" must be a number.` };
      if (f.minValue !== null && f.minValue !== undefined && n < f.minValue) return { error: `"${name}" must be at least ${f.minValue}.` };
      if (f.maxValue !== null && f.maxValue !== undefined && n > f.maxValue) return { error: `"${name}" must be at most ${f.maxValue}.` };
      return { value: String(n) };
    }
    case 'DATE': {
      const s = String(raw).slice(0, 10);
      const d = new Date(`${s}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return { error: `"${name}" must be a real date.` };
      return { value: s };
    }
    case 'DROPDOWN': {
      const s = String(raw);
      if (!parseOptions(f.options).includes(s)) return { error: `Choose one of the listed options for "${name}".` };
      return { value: s };
    }
    case 'MULTISELECT': {
      const list = (Array.isArray(raw) ? raw : parseOptions(raw)).map(String);
      const opts = parseOptions(f.options);
      if (list.some((v) => !opts.includes(v))) return { error: `Choose only the listed options for "${name}".` };
      return { value: JSON.stringify([...new Set(list)]) };
    }
    case 'FILE':
      return { error: `Use the Upload button for "${name}".` };
    default:
      return { error: `"${name}" has an unknown type.` };
  }
}

const readValue = (f, v) => {
  if (!v) return f.type === 'MULTISELECT' ? [] : (f.type === 'CHECKBOX' ? false : null);
  if (f.type === 'FILE') return v.fileStored ? { name: v.fileName, size: v.fileSize, mime: v.fileMime } : null;
  if (f.type === 'MULTISELECT') return parseOptions(v.value);
  if (f.type === 'CHECKBOX') return v.value === 'true';
  if (f.type === 'NUMBER') return v.value === null ? null : Number(v.value);
  return v.value;
};

// The employee, if this login may reach them (the same rule as the list).
async function employeeFor(req, res, { write = false } = {}) {
  const employee = await prisma.employee.findUnique({ where: { id: req.params.employeeId } });
  if (!employee) { res.status(404).json({ error: 'Employee not found' }); return null; }
  const own = req.user.employeeId && req.user.employeeId === employee.id;
  const mayView = await can(req.user, 'hrms', 'hrms', 'Employee Management', 'view');
  const mayEdit = await can(req.user, 'hrms', 'hrms', 'Employee Management', 'edit');
  const inScope = hrmsGlobal(req.user)
    || (await prisma.employee.count({ where: { AND: [{ id: employee.id }, employeeWhere(req.user)] } })) > 0;
  if (write ? !(mayEdit && inScope) : !(own || (mayView && inScope))) {
    res.status(403).json({ error: "This isn't included in your role's permissions" });
    return null;
  }
  return { employee, mayEdit: mayEdit && inScope };
}

// ---- the definitions --------------------------------------------------------
router.get('/', requirePerm(null, 'hrms', 'Employee Management', 'view'), async (req, res) => {
  const all = String(req.query.all || '') === '1';
  const fields = await prisma.employeeField.findMany({ where: all ? {} : { active: true }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
  let counts = {};
  if (all) {
    const g = await prisma.employeeFieldValue.groupBy({ by: ['fieldId'], _count: true, where: { OR: [{ value: { not: null } }, { fileStored: { not: null } }] } });
    counts = Object.fromEntries(g.map((r) => [r.fieldId, r._count]));
  }
  res.json({
    types: TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] })),
    canConfigure: await can(req.user, 'hrms', 'hrms', 'Employee Management', 'configure'),
    fileRule: 'PDF, PNG, JPEG or WebP, up to 5 MB.',
    fields: fields.map((f) => shape(f, all ? counts[f.id] || 0 : undefined)),
  });
});

router.post('/', requirePerm(null, 'hrms', 'Employee Management', 'configure'), async (req, res) => {
  const { data, error } = cleanDefinition(req.body || {});
  if (error) return res.status(400).json({ error });
  const clash = await prisma.employeeField.findFirst({ where: { label: data.label } });
  if (clash) return res.status(409).json({ error: `There is already a field called "${data.label}".` });
  let key = slug(data.label);
  for (let i = 2; await prisma.employeeField.findUnique({ where: { key } }); i += 1) key = `${slug(data.label)}_${i}`; // eslint-disable-line no-await-in-loop
  const last = await prisma.employeeField.aggregate({ _max: { position: true } });
  const field = await prisma.employeeField.create({ data: { ...data, key, position: (last._max.position ?? -1) + 1, createdById: req.user.id } });
  await logAudit({ userId: req.user.id, action: 'Employee field added', entity: 'EmployeeField', entityId: field.id, toValue: `${field.label} (${TYPE_LABEL[field.type]})` });
  res.status(201).json(shape(field, 0));
});

router.put('/:id', requirePerm(null, 'hrms', 'Employee Management', 'configure'), async (req, res) => {
  const existing = await prisma.employeeField.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Field not found' });
  const body = req.body || {};
  const used = await prisma.employeeFieldValue.count({ where: { fieldId: existing.id, OR: [{ value: { not: null } }, { fileStored: { not: null } }] } });
  if (body.type && String(body.type).toUpperCase() !== existing.type && used) {
    return res.status(409).json({ error: `${used} employee${used === 1 ? ' has' : 's have'} a value in "${existing.label}", so its type cannot change. Add a new field instead.` });
  }
  const { data, error } = cleanDefinition(body, existing);
  if (error) return res.status(400).json({ error });
  if (data.label !== existing.label && await prisma.employeeField.findFirst({ where: { label: data.label, NOT: { id: existing.id } } })) {
    return res.status(409).json({ error: `There is already a field called "${data.label}".` });
  }
  const patch = { ...data };
  if (body.active !== undefined) patch.active = !!body.active;
  if (body.position !== undefined && Number.isInteger(Number(body.position))) patch.position = Number(body.position);
  const field = await prisma.employeeField.update({ where: { id: existing.id }, data: patch });
  await logAudit({ userId: req.user.id, action: 'Employee field edited', entity: 'EmployeeField', entityId: field.id, fromValue: existing.label, toValue: field.label });
  res.json(shape(field, used));
});

// REMOVE. A field nobody has filled in is deleted. One that holds values is
// switched off instead — hidden from every form, the values kept — so a
// mis-click never wipes data; "Switch on" brings it back.
router.delete('/:id', requirePerm(null, 'hrms', 'Employee Management', 'configure'), async (req, res) => {
  const existing = await prisma.employeeField.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Field not found' });
  const used = await prisma.employeeFieldValue.count({ where: { fieldId: existing.id, OR: [{ value: { not: null } }, { fileStored: { not: null } }] } });
  if (used) {
    await prisma.employeeField.update({ where: { id: existing.id }, data: { active: false } });
    await logAudit({ userId: req.user.id, action: 'Employee field switched off', entity: 'EmployeeField', entityId: existing.id, fromValue: existing.label, reason: `${used} value(s) kept` });
    return res.json({ ok: true, removed: false, switchedOff: true, message: `"${existing.label}" is hidden now. ${used} employee${used === 1 ? '' : 's'} had a value, so the values are kept.` });
  }
  await prisma.employeeFieldValue.deleteMany({ where: { fieldId: existing.id } });
  await prisma.employeeField.delete({ where: { id: existing.id } });
  await logAudit({ userId: req.user.id, action: 'Employee field removed', entity: 'EmployeeField', entityId: existing.id, fromValue: existing.label });
  return res.json({ ok: true, removed: true, message: `"${existing.label}" removed.` });
});

// ---- one employee's values -----------------------------------------------------
router.get('/values/:employeeId', async (req, res) => {
  const ctx = await employeeFor(req, res);
  if (!ctx) return;
  const [fields, values] = await Promise.all([
    prisma.employeeField.findMany({ where: { active: true }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] }),
    prisma.employeeFieldValue.findMany({ where: { employeeId: ctx.employee.id } }),
  ]);
  const byField = new Map(values.map((v) => [v.fieldId, v]));
  res.json({
    canEdit: ctx.mayEdit,
    fileRule: 'PDF, PNG, JPEG or WebP, up to 5 MB.',
    fields: fields.map((f) => ({ ...shape(f), value: readValue(f, byField.get(f.id)) })),
  });
});

router.put('/values/:employeeId', async (req, res) => {
  const ctx = await employeeFor(req, res, { write: true });
  if (!ctx) return;
  const input = (req.body && req.body.values) || {};
  const fields = await prisma.employeeField.findMany({ where: { active: true, type: { not: 'FILE' } } });
  const errors = {};
  const writes = [];
  for (const f of fields) {
    if (!(f.key in input) && !(f.id in input)) {
      // Not sent: only a problem when it is required and empty on file.
      if (f.required && f.type !== 'CHECKBOX') {
        const have = await prisma.employeeFieldValue.findUnique({ where: { fieldId_employeeId: { fieldId: f.id, employeeId: ctx.employee.id } } }); // eslint-disable-line no-await-in-loop
        if (!have || have.value === null) errors[f.key] = `"${f.label}" is required.`;
      }
      continue; // eslint-disable-line no-continue
    }
    const r = cleanValue(f, f.key in input ? input[f.key] : input[f.id]);
    if (r.error) errors[f.key] = r.error;
    else writes.push({ f, value: r.value });
  }
  if (Object.keys(errors).length) {
    return res.status(400).json({ error: Object.values(errors)[0], errors });
  }
  for (const { f, value } of writes) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.employeeFieldValue.upsert({
      where: { fieldId_employeeId: { fieldId: f.id, employeeId: ctx.employee.id } },
      create: { fieldId: f.id, employeeId: ctx.employee.id, value, updatedById: req.user.id },
      update: { value, updatedById: req.user.id },
    });
  }
  if (writes.length) {
    await logAudit({ userId: req.user.id, action: 'Employee extra fields saved', entity: 'Employee', entityId: ctx.employee.id, toValue: writes.map((w) => w.f.label).join(', ') });
  }
  res.json({ ok: true, saved: writes.length, message: writes.length ? 'Saved.' : 'Nothing changed.' });
});

router.post('/values/:employeeId/:fieldId/file', async (req, res) => {
  const ctx = await employeeFor(req, res, { write: true });
  if (!ctx) return;
  const field = await prisma.employeeField.findUnique({ where: { id: req.params.fieldId } });
  if (!field || !field.active || field.type !== 'FILE') return res.status(404).json({ error: 'Field not found' });
  let parsed;
  try {
    parsed = await attachments.parseMultipart(req);
  } catch (err) {
    return res.status(400).json({ error: attachments.MESSAGE[err.code] || 'Could not read the upload.' });
  }
  let stored;
  try {
    stored = attachments.store(parsed.file);
  } catch (err) {
    return res.status(400).json({ error: attachments.MESSAGE[err.code] || 'Could not store the upload.' });
  }
  const before = await prisma.employeeFieldValue.findUnique({ where: { fieldId_employeeId: { fieldId: field.id, employeeId: ctx.employee.id } } });
  try {
    await prisma.employeeFieldValue.upsert({
      where: { fieldId_employeeId: { fieldId: field.id, employeeId: ctx.employee.id } },
      create: { fieldId: field.id, employeeId: ctx.employee.id, value: null, fileStored: stored.billFile, fileName: stored.billName, fileMime: stored.billMime, fileSize: stored.billSize, updatedById: req.user.id },
      update: { fileStored: stored.billFile, fileName: stored.billName, fileMime: stored.billMime, fileSize: stored.billSize, updatedById: req.user.id },
    });
  } catch (err) {
    attachments.remove(stored.billFile); // no row, no file
    throw err;
  }
  if (before && before.fileStored && before.fileStored !== stored.billFile) attachments.remove(before.fileStored);
  await logAudit({ userId: req.user.id, action: 'Employee extra field file uploaded', entity: 'Employee', entityId: ctx.employee.id, toValue: field.label });
  res.status(201).json({ ok: true, file: { name: stored.billName, size: stored.billSize, mime: stored.billMime }, message: 'Uploaded.' });
});

router.get('/values/:employeeId/:fieldId/file', async (req, res) => {
  const ctx = await employeeFor(req, res);
  if (!ctx) return;
  const v = await prisma.employeeFieldValue.findUnique({ where: { fieldId_employeeId: { fieldId: req.params.fieldId, employeeId: ctx.employee.id } } });
  const full = v && v.fileStored ? attachments.resolveStored(v.fileStored) : null;
  if (!full) return res.status(404).json({ error: 'No file uploaded yet.' });
  const mime = attachments.ALLOWED[v.fileMime] ? v.fileMime : 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Disposition', `${req.query.disposition === 'inline' ? 'inline' : 'attachment'}; filename="${attachments.safeDisplayName(v.fileName)}"`);
  return res.sendFile(full);
});

router.delete('/values/:employeeId/:fieldId/file', async (req, res) => {
  const ctx = await employeeFor(req, res, { write: true });
  if (!ctx) return;
  const v = await prisma.employeeFieldValue.findUnique({ where: { fieldId_employeeId: { fieldId: req.params.fieldId, employeeId: ctx.employee.id } } });
  if (!v || !v.fileStored) return res.status(404).json({ error: 'No file uploaded yet.' });
  await prisma.employeeFieldValue.update({ where: { id: v.id }, data: { fileStored: null, fileName: null, fileMime: null, fileSize: null, updatedById: req.user.id } });
  attachments.remove(v.fileStored);
  await logAudit({ userId: req.user.id, action: 'Employee extra field file removed', entity: 'Employee', entityId: ctx.employee.id });
  res.json({ ok: true, message: 'File removed.' });
});

module.exports = router;
module.exports.cleanValue = cleanValue;
module.exports.cleanDefinition = cleanDefinition;
