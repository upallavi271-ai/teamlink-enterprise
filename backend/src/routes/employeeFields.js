// ---------------------------------------------------------------------------
// EMPLOYEE MANAGEMENT -> MANAGE FIELDS (HRMS spec item 15).
//
// Administrators add their own fields to the employee form — Text, Number,
// Date, Dropdown, Multi-select, Checkbox, File — with simple validation
// (required, min / max, longest text, the list of choices). Values are kept
// per employee in EmployeeFieldValue.
//
//   GET    /api/employee-fields                 the added fields (active); ?all=1 = the ONE list of built-in + added fields (Super Admin / HR; seeds the built-ins on first open)
//   GET    /api/employee-fields/layout          labels / help / required / Pause / order of the built-in fields (any signed-in login; used by the forms)
//   POST   /api/employee-fields                 add a field          (Super Admin / HR)
//   PUT    /api/employee-fields/:id             edit a field, Pause / Resume (built-in: label, help, required, active only)
//   POST   /api/employee-fields/reorder         move one field up / down inside its section
//   DELETE /api/employee-fields/:id             remove an added field — or pause it when people already have a value (built-in: refused)
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
const defs = require('../utils/employeeFieldDefs');
const cat = require('../utils/employeeFieldCatalog');

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

// Only Super Admin and HR change the field list (the matrix's `configure` is
// wider — Admin has it too — so this is checked on top of it, on the server).
const mayManage = (user) => [user.role, user.hrmsRole].some((r) => r === 'SUPER_ADMIN' || r === 'HR');
// (HR holds the Employee Management `create` right, as the HR desk; a TL / STL does not.)
async function mayManageNow(user) {
  return mayManage(user) && can(user, 'hrms', 'hrms', 'Employee Management', 'create');
}
async function needManage(req, res, next) {
  if (await mayManageNow(req.user)) return next();
  return res.status(403).json({ error: 'Only the Super Admin and HR can change the employee fields.' });
}
// The added (custom) fields only — the built-in ones are rows with key core.<column>.
const ADDED = { NOT: { key: { startsWith: 'core.' } } };

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
const PAUSE_WHY_REQUIRED = (label) => `"${label}" is required, so it cannot be paused. Make it optional first, then pause it.`;

// One built-in field, as the Manage Fields list draws it.
function shapeBuiltIn(c, r, count) {
  const required = c.reqLocked ? true : !!r.required;
  const canPause = !c.needed && !required;
  return {
    id: r.id,
    key: r.key,
    builtin: true,
    dbName: c.col,
    originalName: c.label,
    label: r.label,
    type: c.type,
    typeLabel: TYPE_LABEL[c.type] || c.type,
    options: [],
    choicesFrom: c.choices || null,
    hint: c.hint || '',
    required,
    requiredLocked: !!c.reqLocked,
    helpText: r.helpText || '',
    active: c.needed ? true : !!r.active,
    position: r.position,
    section: c.section,
    where: c.where,
    needed: !!c.needed,
    neededWhy: c.neededWhy || '',
    canPause,
    pauseBlockedWhy: c.needed ? `Needed by the system. ${c.neededWhy}` : (required ? PAUSE_WHY_REQUIRED(r.label) : ''),
    valueCount: count === undefined ? null : count,
  };
}

function shapeAdded(f, count, groups) {
  return {
    ...shape(f, count),
    builtin: false,
    dbName: null,
    originalName: f.label,
    section: groups[f.id] || cat.CUSTOM_SECTION,
    group: groups[f.id] || '',
    where: { form: true, profile: true, list: false },
    needed: false,
    neededWhy: '',
    requiredLocked: false,
    canPause: !f.required,
    pauseBlockedWhy: f.required ? PAUSE_WHY_REQUIRED(f.label) : '',
  };
}

const bucketOf = (item) => (item.builtin ? cat.sectionIndex(item.section) : cat.SECTION_ORDER.length - 1);
const displayOrder = (a, b) => bucketOf(a) - bucketOf(b) || a.position - b.position;

// How many employees hold a value in each built-in column — one read for all.
async function builtInCounts() {
  const cols = cat.CATALOG.map((c) => c.col).filter((c) => !['position', 'roleCode'].includes(c));
  const real = cols.map((c) => (c === 'aadhaarNumber' ? 'aadhaarLast4' : c));
  const select = Object.fromEntries([...new Set(real)].map((c) => [c, true]));
  const rows = await prisma.employee.findMany({ select });
  const out = {};
  cols.forEach((c) => {
    const col = c === 'aadhaarNumber' ? 'aadhaarLast4' : c;
    out[c] = rows.filter((r) => r[col] !== null && r[col] !== undefined && r[col] !== '').length;
  });
  return out;
}

router.get('/', requirePerm(null, 'hrms', 'Employee Management', 'view'), async (req, res) => {
  const all = String(req.query.all || '') === '1';
  const manage = await mayManageNow(req.user);
  if (!all) {
    const fields = await prisma.employeeField.findMany({ where: { active: true, ...ADDED }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
    return res.json({
      types: TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] })),
      canConfigure: manage,
      fileRule: 'PDF, PNG, JPEG or WebP, up to 5 MB.',
      fields: fields.map((f) => shape(f)),
    });
  }
  // The full list (with the Pause / Edit powers behind it) is for Super Admin and HR only.
  if (!manage) return res.status(403).json({ error: 'Only the Super Admin and HR can open the field list.' });
  // First time anyone with the right opens this screen, the built-in fields
  // are written down from the real form. Later opens never overwrite them.
  await defs.ensureBuiltins(req.user.id);
  const [rows, groups, counts] = await Promise.all([
    prisma.employeeField.findMany({ orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] }),
    defs.readGroups(),
    builtInCounts(),
  ]);
  const g = await prisma.employeeFieldValue.groupBy({ by: ['fieldId'], _count: true, where: { OR: [{ value: { not: null } }, { fileStored: { not: null } }] } });
  const valueCounts = Object.fromEntries(g.map((r) => [r.fieldId, r._count]));
  const items = [];
  rows.forEach((r) => {
    if (cat.isBuiltInKey(r.key)) {
      const c = cat.BY_KEY.get(r.key);
      if (c) items.push(shapeBuiltIn(c, r, counts[c.col]));
    } else items.push(shapeAdded(r, valueCounts[r.id] || 0, groups));
  });
  items.sort(displayOrder);
  res.json({
    types: TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] })),
    canConfigure: manage,
    seeded: items.some((i) => i.builtin),
    sections: cat.SECTION_ORDER,
    groups: [...new Set(Object.values(groups).filter(Boolean))],
    fileRule: 'PDF, PNG, JPEG or WebP, up to 5 MB.',
    fields: items,
  });
});

// What the forms, the profile and the list need to draw themselves: the label
// override, help text, required flag, order and Pause state of every built-in
// field. Any signed-in person may read it (My Profile uses it too); it holds
// no employee data.
router.get('/layout', async (req, res) => {
  res.json(await defs.layoutFor());
});

router.post('/', needManage, async (req, res) => {
  const { data, error } = cleanDefinition(req.body || {});
  if (error) return res.status(400).json({ error });
  const clash = await prisma.employeeField.findFirst({ where: { label: data.label } });
  if (clash) return res.status(409).json({ error: `There is already a field called "${data.label}".` });
  let key = slug(data.label);
  for (let i = 2; await prisma.employeeField.findUnique({ where: { key } }); i += 1) key = `${slug(data.label)}_${i}`; // eslint-disable-line no-await-in-loop
  const last = await prisma.employeeField.aggregate({ _max: { position: true } });
  const field = await prisma.employeeField.create({ data: { ...data, key, position: (last._max.position ?? -1) + 1, createdById: req.user.id } });
  const group = String((req.body || {}).group || '').trim().slice(0, 40);
  if (group && group !== cat.CUSTOM_SECTION) await defs.writeGroup(field.id, group, req.user);
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Employee field added', entity: 'EmployeeField', entityId: field.id, field: key, fieldLabel: field.label, toValue: `${field.label} (${TYPE_LABEL[field.type]})` });
  res.status(201).json(shape(field, 0));
});

// Edit a BUILT-IN field. Its database column and type never change; only the
// label, help text, required flag and Pause / Resume.
async function editBuiltIn(req, res, existing) {
  const c = cat.BY_KEY.get(existing.key);
  if (!c) return res.status(404).json({ error: 'Field not found' });
  const body = req.body || {};
  if (body.type !== undefined && String(body.type).toUpperCase() !== existing.type) {
    return res.status(409).json({ error: `The type of "${existing.label}" is part of the employee record and cannot be changed.` });
  }
  if (Array.isArray(body.options) ? body.options.length : String(body.options || '').trim()) {
    return res.status(409).json({ error: `The choices of "${existing.label}" are kept in Company Setup > Master lists.` });
  }
  const patch = {};
  const notes = [];
  if (body.label !== undefined) {
    const label = String(body.label).trim();
    if (!label) return res.status(400).json({ error: 'Give the field a name.' });
    if (label.length > 60) return res.status(400).json({ error: 'The field name can have at most 60 characters.' });
    if (label !== existing.label) {
      if (await prisma.employeeField.findFirst({ where: { label, NOT: { id: existing.id } } })) {
        return res.status(409).json({ error: `There is already a field called "${label}".` });
      }
      patch.label = label;
      notes.push({ action: 'Employee field renamed', from: existing.label, to: label });
    }
  }
  if (body.helpText !== undefined) {
    const help = String(body.helpText || '').trim().slice(0, 200) || null;
    if (help !== (existing.helpText || null)) { patch.helpText = help; notes.push({ action: 'Employee field help text changed', from: existing.helpText || '', to: help || '' }); }
  }
  const wasRequired = c.reqLocked ? true : !!existing.required;
  const wasActive = c.needed ? true : !!existing.active;
  let required = wasRequired;
  let active = wasActive;
  if (body.required !== undefined) {
    required = !!body.required;
    if (c.reqLocked && !required) return res.status(409).json({ error: `"${existing.label}" is always required: the system needs it.` });
  }
  if (body.active !== undefined) {
    active = !!body.active;
    if (c.needed && !active) return res.status(409).json({ error: `"${existing.label}" is needed by the system and cannot be paused. ${c.neededWhy}` });
  }
  if (!active && required) {
    return res.status(409).json({ error: wasActive ? PAUSE_WHY_REQUIRED(patch.label || existing.label) : `"${existing.label}" is paused. Resume it before making it required.` });
  }
  if (required !== wasRequired) { patch.required = required; notes.push({ action: required ? 'Employee field made required' : 'Employee field made optional', from: wasRequired ? 'Required' : 'Optional', to: required ? 'Required' : 'Optional' }); }
  if (active !== wasActive) { patch.active = active; notes.push({ action: active ? 'Employee field resumed' : 'Employee field paused', from: wasActive ? 'Active' : 'Paused', to: active ? 'Active' : 'Paused' }); }
  if (Object.keys(patch).length) {
    await prisma.employeeField.update({ where: { id: existing.id }, data: patch });
    defs.invalidate();
    await defs.refresh();
    // eslint-disable-next-line no-restricted-syntax
    for (const n of notes) {
      // eslint-disable-next-line no-await-in-loop
      await logAudit({
        userId: req.user.id, actorName: req.user.name, action: n.action, entity: 'EmployeeField', entityId: existing.id,
        field: c.col, fieldLabel: patch.label || existing.label, fromValue: n.from, toValue: n.to,
      });
    }
  }
  const fresh = await prisma.employeeField.findUnique({ where: { id: existing.id } });
  const counts = await builtInCounts();
  return res.json(shapeBuiltIn(c, fresh, counts[c.col]));
}

router.put('/:id', needManage, async (req, res) => {
  const existing = await prisma.employeeField.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Field not found' });
  if (cat.isBuiltInKey(existing.key)) return editBuiltIn(req, res, existing);
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
  if (body.active !== undefined) {
    patch.active = !!body.active;
    if (!patch.active && data.required) return res.status(409).json({ error: PAUSE_WHY_REQUIRED(data.label) });
  }
  const field = await prisma.employeeField.update({ where: { id: existing.id }, data: patch });
  if (body.group !== undefined) {
    const group = String(body.group || '').trim().slice(0, 40);
    await defs.writeGroup(field.id, group === cat.CUSTOM_SECTION ? '' : group, req.user);
  }
  const what = [];
  if (existing.label !== field.label) what.push(`renamed "${existing.label}" to "${field.label}"`);
  if (!!existing.required !== !!field.required) what.push(field.required ? 'made required' : 'made optional');
  if (!!existing.active !== !!field.active) what.push(field.active ? 'resumed' : 'paused');
  await logAudit({
    userId: req.user.id,
    actorName: req.user.name,
    action: existing.active && !field.active ? 'Employee field paused' : (!existing.active && field.active ? 'Employee field resumed' : 'Employee field edited'),
    entity: 'EmployeeField',
    entityId: field.id,
    field: field.key,
    fieldLabel: field.label,
    fromValue: existing.label,
    toValue: what.join('; ') || field.label,
  });
  res.json(shape(field, used));
});

// MOVE a field one step up or down inside its section. The positions of the
// whole list are rewritten in one go so two fields never share a place.
router.post('/reorder', needManage, async (req, res) => {
  const { id, direction } = req.body || {};
  if (!['up', 'down'].includes(direction)) return res.status(400).json({ error: 'Say whether to move it up or down.' });
  const rows = await prisma.employeeField.findMany({ orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
  const items = rows.map((r) => ({
    r,
    bucket: cat.isBuiltInKey(r.key) ? (cat.BY_KEY.get(r.key) ? cat.sectionIndex(cat.BY_KEY.get(r.key).section) : 99) : cat.SECTION_ORDER.length - 1,
  })).sort((a, b) => a.bucket - b.bucket || a.r.position - b.r.position);
  const i = items.findIndex((x) => x.r.id === id);
  if (i < 0) return res.status(404).json({ error: 'Field not found' });
  const j = direction === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= items.length || items[j].bucket !== items[i].bucket) {
    return res.status(409).json({ error: direction === 'up' ? 'It is already first in its section.' : 'It is already last in its section.' });
  }
  [items[i], items[j]] = [items[j], items[i]];
  const ops = [];
  items.forEach((x, n) => { if (x.r.position !== n) ops.push(prisma.employeeField.update({ where: { id: x.r.id }, data: { position: n } })); });
  await prisma.$transaction(ops);
  defs.invalidate();
  const moved = rows.find((r) => r.id === id);
  await logAudit({
    userId: req.user.id,
    actorName: req.user.name,
    action: 'Employee field moved',
    entity: 'EmployeeField',
    entityId: id,
    field: moved.key,
    fieldLabel: moved.label,
    toValue: direction === 'up' ? 'Moved up' : 'Moved down',
  });
  res.json({ ok: true });
});

// REMOVE (added fields only). A field nobody has filled in is deleted. One that
// holds values is paused instead — hidden from every form, the values kept — so
// a mis-click never wipes data; "Resume" brings it back. Built-in fields are
// part of the employee record: they can be paused, never removed.
router.delete('/:id', needManage, async (req, res) => {
  const existing = await prisma.employeeField.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Field not found' });
  if (cat.isBuiltInKey(existing.key)) {
    return res.status(409).json({ error: `"${existing.label}" is part of the employee record and cannot be removed. Use Pause to hide it.` });
  }
  const used = await prisma.employeeFieldValue.count({ where: { fieldId: existing.id, OR: [{ value: { not: null } }, { fileStored: { not: null } }] } });
  if (used) {
    await prisma.employeeField.update({ where: { id: existing.id }, data: { active: false } });
    await logAudit({
      userId: req.user.id, actorName: req.user.name, action: 'Employee field paused', entity: 'EmployeeField', entityId: existing.id, field: existing.key, fieldLabel: existing.label, fromValue: 'Active', toValue: 'Paused', reason: `${used} value(s) kept`,
    });
    return res.json({ ok: true, removed: false, switchedOff: true, message: `"${existing.label}" is paused now. ${used} employee${used === 1 ? '' : 's'} had a value, so the values are kept.` });
  }
  await prisma.employeeFieldValue.deleteMany({ where: { fieldId: existing.id } });
  await prisma.employeeField.delete({ where: { id: existing.id } });
  await defs.writeGroup(existing.id, '', req.user);
  await logAudit({
    userId: req.user.id, actorName: req.user.name, action: 'Employee field removed', entity: 'EmployeeField', entityId: existing.id, field: existing.key, fieldLabel: existing.label, fromValue: existing.label,
  });
  return res.json({ ok: true, removed: true, message: `"${existing.label}" removed.` });
});

// ---- one employee's values -----------------------------------------------------
router.get('/values/:employeeId', async (req, res) => {
  const ctx = await employeeFor(req, res);
  if (!ctx) return;
  const [fields, values] = await Promise.all([
    prisma.employeeField.findMany({ where: { active: true, ...ADDED }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] }),
    prisma.employeeFieldValue.findMany({ where: { employeeId: ctx.employee.id } }),
  ]);
  const byField = new Map(values.map((v) => [v.fieldId, v]));
  const groups = await defs.readGroups();
  res.json({
    canEdit: ctx.mayEdit,
    fileRule: 'PDF, PNG, JPEG or WebP, up to 5 MB.',
    fields: fields.map((f) => ({ ...shape(f), group: groups[f.id] || '', value: readValue(f, byField.get(f.id)) })),
  });
});

router.put('/values/:employeeId', async (req, res) => {
  const ctx = await employeeFor(req, res, { write: true });
  if (!ctx) return;
  const input = (req.body && req.body.values) || {};
  const fields = await prisma.employeeField.findMany({ where: { active: true, type: { not: 'FILE' }, ...ADDED } });
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
  if (!field || !field.active || field.type !== 'FILE' || cat.isBuiltInKey(field.key)) return res.status(404).json({ error: 'Field not found' });
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
