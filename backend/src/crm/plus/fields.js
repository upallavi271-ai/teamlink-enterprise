// ---------------------------------------------------------------------------
// CRM WAVE C - CUSTOMISING THE CRM WITHOUT CODE (02.04 custom fields, 17.02 page layouts, 16.08 validation rules, 16.09 encrypted fields,
// 17.01 record types of your own). A Sales manager / Admin changes these in CRM settings > Customise; everybody on the CRM team reads them.
//
//   custom field    kind (lead / account / contact / deal), label, type (text, long text, number, date, pick one, pick several, yes / no, email,
//                   phone, link), required, "sensitive" (kept ENCRYPTED in the database with utils/secrets.js, shown masked to anyone who
//                   cannot change the record), a section and a place. Values live in the record's "customJson" column.
//   layout          per kind: the sections and the order of the fields on the form, the fields hidden from a Salesperson / Viewer, and the fields
//                   a Salesperson may read but not change (that one is enforced here on save, not only on the screen).
//   validation rule kind, field (built-in or custom), check (required, pattern, min, max, min length, max length, one of, not one of), the message,
//                   and optionally "only when <field> is <value>". Checked on every save through the CRM screens and the API (crm/service.js).
//   record type     a new kind of record ("Branches", "Contracts" ...) with its own fields, optionally linked to an account / lead / deal; its records
//                   are listed under Accounts & Contacts > More records and on the linked record.
// ---------------------------------------------------------------------------
const P = require('./db');
const S = require('../service');

const KINDS = ['lead', 'account', 'contact', 'deal'];
const TYPES = ['text', 'long', 'number', 'date', 'select', 'multi', 'checkbox', 'email', 'phone', 'url'];
const TYPE_WORDS = { text: 'Text', long: 'Long text', number: 'Number', date: 'Date', select: 'Pick one', multi: 'Pick several', checkbox: 'Yes / no', email: 'Email', phone: 'Phone', url: 'Link' };
const OPS = ['required', 'pattern', 'min', 'max', 'minLength', 'maxLength', 'oneOf', 'notOneOf'];
const OP_WORDS = { required: 'must be filled', pattern: 'must match the pattern', min: 'must be at least', max: 'must be at most', minLength: 'must have at least N characters', maxLength: 'must have at most N characters', oneOf: 'must be one of', notOneOf: 'must not be one of' };
// the built-in fields of each kind (crm/service.js KINDS) with their words, so a layout / rule can name them
const BUILT_IN = {
  lead: { company: 'Company', contactName: 'Contact person', designation: 'Designation', phone: 'Phone', email: 'Email', industry: 'Industry', city: 'City', source: 'Source', expectedValue: 'Expected value', rating: 'Rating', notes: 'Notes', tags: 'Tags' },
  account: { name: 'Company name', industry: 'Industry', city: 'City', website: 'Website', phone: 'Phone', email: 'Email', source: 'Source', gstin: 'GSTIN', state: 'State', pincode: 'Pincode', address: 'Address', tags: 'Tags', notes: 'Notes', parentId: 'Parent company' },
  contact: { name: 'Name', designation: 'Designation', role: 'Role in the deal', phone: 'Phone', email: 'Email', accountId: 'Account', reportsToId: 'Reports to', tags: 'Tags', notes: 'Notes' },
  deal: { title: 'Deal name', accountId: 'Account', contactId: 'Contact', value: 'Deal value', currency: 'Currency', discountPercent: 'Discount %', expectedClose: 'Expected close', nextStep: 'Next step', tags: 'Tags' },
};
const clip = (v, n = 300) => { const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, n) : ''; };
const mayAdmin = (user) => S.mayAssign(S.roleOf(user));
const NO_ADMIN = () => S.fail(403, 'Only a Sales manager or an Admin can change how the CRM is set up.');

// ---- custom field definitions --------------------------------------------------------------------------------
const defOut = (d) => ({ id: d.id, kind: d.kind, key: d.key, label: d.label, type: d.type, typeWord: TYPE_WORDS[d.type] || d.type, options: P.parse(d.optionsJson, []), required: !!d.required, sensitive: !!d.sensitive, section: d.section || '', position: d.position, helpText: d.helpText || '', active: !!d.active });
async function defs(kind, { all = false } = {}) {
  const rows = await P.all(`SELECT * FROM "CrmFieldDef" WHERE ${kind ? '"kind" = ?' : '1=1'}${all ? '' : ' AND "active" = 1'} ORDER BY "kind", "position", "createdAt"`, ...(kind ? [kind] : []));
  return rows.map(defOut);
}
const keyOf = (label) => `cf_${String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'field'}`;
async function saveField(user, body = {}) {
  if (!mayAdmin(user)) return NO_ADMIN();
  const kind = KINDS.includes(body.kind) ? body.kind : null;
  if (!kind) return S.fail(400, 'Say which records the field is for: leads, accounts, contacts or deals.');
  const label = clip(body.label, 60);
  if (!label) return S.fail(400, 'Give the field a name.');
  const type = TYPES.includes(body.type) ? body.type : 'text';
  const options = (Array.isArray(body.options) ? body.options : String(body.options || '').split(/\n|,/)).map((x) => clip(x, 80)).filter(Boolean);
  if (['select', 'multi'].includes(type) && !options.length) return S.fail(400, 'A pick list needs its choices (one a line).');
  const sensitive = body.sensitive === true;
  if (sensitive && !require('../../utils/secrets').secretsConfigured()) return S.fail(409, require('../../utils/secrets').NO_KEY_MESSAGE); // eslint-disable-line global-require
  if (sensitive && ['select', 'multi', 'checkbox', 'number', 'date'].includes(type)) return S.fail(400, 'Only a text, long text, email, phone or link field can be kept encrypted.');
  const now = P.nowIso();
  const data = { label, type, optionsJson: JSON.stringify([...new Set(options)].slice(0, 100)), required: body.required === true ? 1 : 0, sensitive: sensitive ? 1 : 0, section: clip(body.section, 60) || null, helpText: clip(body.helpText, 200) || null, active: body.active === false ? 0 : 1, updatedAt: now };
  if (body.position != null && Number.isFinite(Number(body.position))) data.position = Math.round(Number(body.position));
  if (body.id) {
    const was = await P.one('SELECT * FROM "CrmFieldDef" WHERE "id" = ?', clip(body.id, 60));
    if (!was) return S.fail(404, 'This field is not there.');
    if (!!was.sensitive !== sensitive) return S.fail(400, 'A field cannot be switched between encrypted and plain once it has values. Add a new field instead.');
    const cols = Object.keys(data);
    await P.run(`UPDATE "CrmFieldDef" SET ${cols.map((c) => `"${c}" = ?`).join(', ')} WHERE "id" = ?`, ...cols.map((c) => data[c]), was.id);
    await S.audit(user, 'CRM custom field changed', 'CrmFieldDef', was.id, `${was.kind}: ${label} (${type})`);
    return S.okBody({ ok: true, field: defOut(await P.one('SELECT * FROM "CrmFieldDef" WHERE "id" = ?', was.id)) });
  }
  let key = keyOf(label);
  if (BUILT_IN[kind][key]) key = `${key}_x`;
  for (let i = 2; await P.one('SELECT "id" FROM "CrmFieldDef" WHERE "kind" = ? AND "key" = ?', kind, key); i += 1) key = `${keyOf(label)}_${i}`; // eslint-disable-line no-await-in-loop
  const n = await P.one('SELECT COUNT(*) AS "n" FROM "CrmFieldDef" WHERE "kind" = ?', kind);
  if (Number(n && n.n) >= 80) return S.fail(400, 'At most 80 custom fields for one kind of record.');
  const row = { id: P.newId('cfd'), kind, key, ...data, position: data.position != null ? data.position : (Number(n && n.n) + 1) * 10, createdById: user.id, createdAt: now };
  const cols = Object.keys(row);
  await P.run(`INSERT INTO "CrmFieldDef" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => row[c]));
  await S.audit(user, 'CRM custom field added', 'CrmFieldDef', row.id, `${kind}: ${label} (${type})`);
  return S.okBody({ ok: true, field: defOut(row) });
}
async function removeField(user, id) {
  if (!mayAdmin(user)) return NO_ADMIN();
  const was = await P.one('SELECT * FROM "CrmFieldDef" WHERE "id" = ?', clip(id, 60));
  if (!was) return S.fail(404, 'This field is not there.');
  // switched off, never wiped: the values already typed stay on the records (and come back if the field is switched on again)
  await P.run('UPDATE "CrmFieldDef" SET "active" = 0, "updatedAt" = ? WHERE "id" = ?', P.nowIso(), was.id);
  await S.audit(user, 'CRM custom field removed', 'CrmFieldDef', was.id, `${was.kind}: ${was.label}`);
  return S.okBody({ ok: true });
}

// ---- values ------------------------------------------------------------------------------------------------------
const SECRETS = () => require('../../utils/secrets'); // eslint-disable-line global-require
const mask = (v) => { const s = String(v || ''); return s ? `${'•'.repeat(Math.min(8, Math.max(4, s.length - 4)))}${s.length > 6 ? s.slice(-4) : ''}` : ''; };
// one value checked and shaped for its type -> { value } | { error }
function cleanValue(d, raw) {
  if (raw == null || raw === '' || (Array.isArray(raw) && !raw.length)) return { value: null };
  const s = String(raw).trim();
  switch (d.type) {
    case 'number': { const n = Number(s.replace(/[, ]/g, '')); return Number.isFinite(n) ? { value: n } : { error: `${d.label} must be a number.` }; }
    case 'date': return /^\d{4}-\d{2}-\d{2}$/.test(s) ? { value: s } : { error: `${d.label} must be a date.` };
    case 'checkbox': return { value: raw === true || /^(true|1|yes|y)$/i.test(s) };
    case 'email': return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? { value: s.slice(0, 200) } : { error: `${d.label} does not look like an email address.` };
    case 'phone': return s.replace(/\D/g, '').length >= 8 ? { value: s.slice(0, 40) } : { error: `${d.label} looks too short for a phone number.` };
    case 'url': return /^https?:\/\/\S+$/i.test(s) || /^[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i.test(s) ? { value: s.slice(0, 400) } : { error: `${d.label} does not look like a web address.` };
    case 'select': return d.options.includes(s) ? { value: s } : { error: `Pick ${d.label} from its list.` };
    case 'multi': {
      const vals = (Array.isArray(raw) ? raw : s.split(',')).map((x) => String(x).trim()).filter(Boolean);
      const bad = vals.find((x) => !d.options.includes(x));
      return bad ? { error: `"${bad.slice(0, 40)}" is not one of the choices for ${d.label}.` } : { value: [...new Set(vals)] };
    }
    case 'long': return { value: s.slice(0, 4000) };
    default: return { value: s.slice(0, 500) };
  }
}
// the custom values of a record as the reader may see them: { key: value }, sensitive ones decrypted for someone who can change the record, else masked
async function valuesOf(user, kind, row, { forEdit } = {}) {
  const list = await defs(kind, { all: true });
  const stored = P.parse(row && row.customJson, {});
  const r = S.roleOf(user);
  const open = forEdit === undefined ? S.canEditRow(user, r, row) || S.mayAssign(r) : forEdit;
  const out = {};
  list.forEach((d) => {
    if (!(d.key in stored)) return;
    let v = stored[d.key];
    if (d.sensitive && v) { const plainV = SECRETS().decryptSecret(v); v = open ? (plainV == null ? '(cannot be read with this server key)' : plainV) : mask(plainV || ''); }
    out[d.key] = v;
  });
  return out;
}
const display = (d, v) => {
  if (v == null || v === '') return '';
  if (d.type === 'checkbox') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
};

// ---- validation rules ----------------------------------------------------------------------------------------------
const ruleOut = (x) => ({ id: x.id, kind: x.kind, field: x.field, op: x.op, opWord: OP_WORDS[x.op], value: x.value || '', message: x.message || '', whenField: x.whenField || '', whenValue: x.whenValue || '', active: !!x.active });
async function rules(kind) {
  return (await P.all(`SELECT * FROM "CrmValidationRule" WHERE ${kind ? '"kind" = ?' : '1=1'} ORDER BY "kind", "createdAt"`, ...(kind ? [kind] : []))).map(ruleOut);
}
async function saveRule(user, body = {}) {
  if (!mayAdmin(user)) return NO_ADMIN();
  const kind = KINDS.includes(body.kind) ? body.kind : null;
  if (!kind) return S.fail(400, 'Say which records the rule is for.');
  const field = clip(body.field, 60);
  const custom = await defs(kind);
  if (!BUILT_IN[kind][field] && !custom.some((d) => d.key === field)) return S.fail(400, 'Pick the field the rule checks.');
  const op = OPS.includes(body.op) ? body.op : null;
  if (!op) return S.fail(400, 'Pick what the rule checks.');
  const value = clip(body.value, 300);
  if (['min', 'max', 'minLength', 'maxLength'].includes(op) && !Number.isFinite(Number(value))) return S.fail(400, 'This check needs a number.');
  if (op === 'pattern') { try { new RegExp(value); } catch { return S.fail(400, 'That pattern is not a valid regular expression.'); } } // eslint-disable-line no-new
  if (['oneOf', 'notOneOf', 'pattern'].includes(op) && !value) return S.fail(400, 'This check needs its value.');
  const whenField = clip(body.whenField, 60);
  if (whenField && !BUILT_IN[kind][whenField] && !custom.some((d) => d.key === whenField)) return S.fail(400, 'Pick the field of the "only when" part from the list.');
  const row = { kind, field, op, value: value || null, message: clip(body.message, 200) || null, whenField: whenField || null, whenValue: whenField ? clip(body.whenValue, 120) || null : null, active: body.active === false ? 0 : 1 };
  if (body.id) {
    const was = await P.one('SELECT * FROM "CrmValidationRule" WHERE "id" = ?', clip(body.id, 60));
    if (!was) return S.fail(404, 'This rule is not there.');
    const cols = Object.keys(row);
    await P.run(`UPDATE "CrmValidationRule" SET ${cols.map((c) => `"${c}" = ?`).join(', ')} WHERE "id" = ?`, ...cols.map((c) => row[c]), was.id);
    await S.audit(user, 'CRM validation rule changed', 'CrmValidationRule', was.id, `${kind}.${field} ${op} ${value || ''}`);
    return S.okBody({ ok: true, rule: ruleOut({ ...was, ...row }) });
  }
  const full = { id: P.newId('vrule'), ...row, createdById: user.id, createdAt: P.nowIso() };
  const cols = Object.keys(full);
  await P.run(`INSERT INTO "CrmValidationRule" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => full[c]));
  await S.audit(user, 'CRM validation rule added', 'CrmValidationRule', full.id, `${kind}.${field} ${op} ${value || ''}`);
  return S.okBody({ ok: true, rule: ruleOut(full) });
}
async function removeRule(user, id) {
  if (!mayAdmin(user)) return NO_ADMIN();
  const n = await P.run('DELETE FROM "CrmValidationRule" WHERE "id" = ?', clip(id, 60));
  if (!Number(n)) return S.fail(404, 'This rule is not there.');
  await S.audit(user, 'CRM validation rule removed', 'CrmValidationRule', clip(id, 60), '');
  return S.okBody({ ok: true });
}
const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length) || v === false;
const asText = (v) => (Array.isArray(v) ? v.join(', ') : String(v == null ? '' : v));
function failsRule(x, v) {
  const t = asText(v);
  switch (x.op) {
    case 'required': return isEmpty(v);
    case 'pattern': if (isEmpty(v)) return false; try { return !new RegExp(x.value).test(t); } catch { return false; }
    case 'min': return !isEmpty(v) && Number(v) < Number(x.value);
    case 'max': return !isEmpty(v) && Number(v) > Number(x.value);
    case 'minLength': return !isEmpty(v) && t.length < Number(x.value);
    case 'maxLength': return !isEmpty(v) && t.length > Number(x.value);
    case 'oneOf': return !isEmpty(v) && !String(x.value).split(',').map((s) => s.trim().toLowerCase()).includes(t.trim().toLowerCase());
    case 'notOneOf': return !isEmpty(v) && String(x.value).split(',').map((s) => s.trim().toLowerCase()).includes(t.trim().toLowerCase());
    default: return false;
  }
}

// ---- THE SAVE HOOK (crm/service.js create / edit): custom values, layouts' read-only fields, rules, and the extra columns of wave C -------------
// -> { error } | { data: { extra columns to write } }. `clean` is what crm/service.js cleanFields kept; `prev` is the row being changed (null on create).
async function beforeSave(user, kind, body = {}, clean = {}, prev = null) {
  if (!KINDS.includes(kind)) return { data: {} };
  const R = require('./records'); // eslint-disable-line global-require
  const out = {};
  const r = S.roleOf(user);
  const cfg = await P.config();
  // fields a Salesperson may read but not change (Customise > Layouts): refused here, not only greyed on the screen
  const ro = ((cfg.layouts[kind] || {}).readOnly || {}).rep || [];
  if (prev && (r === 'bde' || r === 'bdeAll') && ro.length) {
    const prevCustom = P.parse(prev.customJson, {});
    const touched = ro.find((k) => (k in body && String(body[k] ?? '') !== String(prev[k] ?? '')) || (body.custom && k in body.custom && asText(body.custom[k]) !== asText(prevCustom[k])));
    if (touched) return { error: `${(BUILT_IN[kind] || {})[touched] || touched} is set by a Sales manager. Ask them to change it.` };
  }
  // custom values: only the ones sent change; a required one must be there on a new record, and cannot be emptied
  const list = await defs(kind);
  const stored = P.parse(prev && prev.customJson, {});
  const given = body.custom && typeof body.custom === 'object' ? body.custom : {};
  const next = { ...stored };
  let customChanged = false;
  for (const d of list) {
    if (!(d.key in given)) {
      if (!prev && d.required && isEmpty(stored[d.key])) return { error: `${d.label} is needed.` };
      continue; // eslint-disable-line no-continue
    }
    const c = cleanValue(d, given[d.key]);
    if (c.error) return { error: c.error };
    if (d.required && isEmpty(c.value)) return { error: `${d.label} is needed.` };
    if (d.sensitive && c.value != null) {
      if (!SECRETS().secretsConfigured()) return { error: SECRETS().NO_KEY_MESSAGE };
      // a masked value sent back unchanged keeps what is stored
      if (/^•+/.test(String(c.value))) continue; // eslint-disable-line no-continue
      next[d.key] = SECRETS().encryptSecret(String(c.value));
    } else if (c.value == null) delete next[d.key]; else next[d.key] = c.value;
    customChanged = true;
  }
  if (customChanged || (!prev && Object.keys(next).length)) out.customJson = JSON.stringify(next);
  // the wave C columns that ride on the same save: tags, parent company, reports-to, currency, business unit
  const extra = await R.extraColumns(user, kind, body, clean, prev, cfg);
  if (extra.error) return { error: extra.error };
  Object.assign(out, extra.data);
  // validation rules on the record as it will be (only rules whose field, or "only when" field, is part of this save on an edit)
  const ruleList = (await rules(kind)).filter((x) => x.active);
  if (ruleList.length) {
    const plainCustom = { ...stored, ...Object.fromEntries(Object.entries(given)) };
    const merged = { ...(prev || {}), ...clean, ...out, ...plainCustom };
    const sent = (k) => !prev || k in body || k in given || k in out;
    for (const x of ruleList) {
      if (!sent(x.field) && !(x.whenField && sent(x.whenField))) continue; // eslint-disable-line no-continue
      if (x.whenField && asText(merged[x.whenField]).trim().toLowerCase() !== String(x.whenValue || '').trim().toLowerCase()) continue; // eslint-disable-line no-continue
      if (failsRule(x, merged[x.field])) {
        const label = (BUILT_IN[kind] || {})[x.field] || (list.find((d) => d.key === x.field) || {}).label || x.field;
        return { error: x.message || `${label} ${x.opWord}${['required'].includes(x.op) ? '' : ` ${x.value}`}.` };
      }
    }
  }
  return { data: out };
}

// ---- record types of your own (17.01) -----------------------------------------------------------------------------------
const OBJ_LINKS = ['account', 'lead', 'deal', 'contact', ''];
const objOut = (o) => ({ id: o.id, key: o.key, name: o.name, plural: o.plural || `${o.name}s`, linkTo: o.linkTo || '', fields: P.parse(o.fieldsJson, []), active: !!o.active });
function cleanObjFields(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).map((f) => {
    const label = clip(f && f.label, 60);
    const type = TYPES.includes(f && f.type) ? f.type : 'text';
    let key = clip(f && f.key, 40) || keyOf(label).replace(/^cf_/, '');
    if (seen.has(key)) key = `${key}_${seen.size}`;
    seen.add(key);
    return { key, label, type, options: (Array.isArray(f && f.options) ? f.options : String((f && f.options) || '').split(/\n|,/)).map((x) => clip(x, 80)).filter(Boolean).slice(0, 60), required: !!(f && f.required) };
  }).filter((f) => f.label && (!['select', 'multi'].includes(f.type) || f.options.length)).slice(0, 40);
}
async function objects({ all = false } = {}) {
  return (await P.all(`SELECT * FROM "CrmObjectDef" ${all ? '' : 'WHERE "active" = 1'} ORDER BY "name" COLLATE NOCASE`)).map(objOut);
}
async function saveObject(user, body = {}) {
  if (!mayAdmin(user)) return NO_ADMIN();
  const name = clip(body.name, 60);
  if (!name) return S.fail(400, 'Name the record type, e.g. Branch or Contract.');
  const fields = cleanObjFields(body.fields);
  const linkTo = OBJ_LINKS.includes(body.linkTo) ? body.linkTo : '';
  const now = P.nowIso();
  if (body.id) {
    const was = await P.one('SELECT * FROM "CrmObjectDef" WHERE "id" = ?', clip(body.id, 60));
    if (!was) return S.fail(404, 'This record type is not there.');
    await P.run('UPDATE "CrmObjectDef" SET "name" = ?, "plural" = ?, "linkTo" = ?, "fieldsJson" = ?, "active" = ?, "updatedAt" = ? WHERE "id" = ?', name, clip(body.plural, 60) || null, linkTo, JSON.stringify(fields), body.active === false ? 0 : 1, now, was.id);
    await S.audit(user, 'CRM record type changed', 'CrmObjectDef', was.id, `${name}: ${fields.length} fields`);
    return S.okBody({ ok: true, object: objOut(await P.one('SELECT * FROM "CrmObjectDef" WHERE "id" = ?', was.id)) });
  }
  let key = keyOf(name).replace(/^cf_/, 'obj_');
  if (await P.one('SELECT "id" FROM "CrmObjectDef" WHERE "key" = ?', key)) key = `${key}_${Date.now().toString(36)}`;
  const row = { id: P.newId('obj'), key, name, plural: clip(body.plural, 60) || null, linkTo, fieldsJson: JSON.stringify(fields), active: 1, createdById: user.id, createdAt: now, updatedAt: now };
  const cols = Object.keys(row);
  await P.run(`INSERT INTO "CrmObjectDef" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => row[c]));
  await S.audit(user, 'CRM record type added', 'CrmObjectDef', row.id, `${name}: ${fields.length} fields`);
  return S.okBody({ ok: true, object: objOut(row) });
}
async function objectRecords(user, objectId, q = {}) {
  const o = await P.one('SELECT * FROM "CrmObjectDef" WHERE "id" = ?', clip(objectId, 60));
  if (!o) return S.fail(404, 'This record type is not there.');
  const r = S.roleOf(user);
  const s = S.scopeSql(user, r, 'x.');
  const where = ['x."objectId" = ?', s.sql]; const params = [o.id, ...s.params];
  for (const col of ['accountId', 'leadId', 'dealId', 'contactId']) if (q[col]) { where.push(`x."${col}" = ?`); params.push(clip(q[col], 60)); }
  const text = clip(q.q, 80);
  if (text) { where.push('(x."name" LIKE ? OR x."valuesJson" LIKE ?)'); params.push(`%${text}%`, `%${text}%`); }
  const rows = await P.all(`SELECT x.*, a."name" AS "accountName" FROM "CrmObjectRecord" x LEFT JOIN "CrmAccount" a ON a."id" = x."accountId" WHERE ${where.join(' AND ')} ORDER BY x."updatedAt" DESC LIMIT 500`, ...params);
  return S.okBody({ object: objOut(o), rows: rows.map((x) => ({ ...x, values: P.parse(x.valuesJson, {}), canEdit: S.canEditRow(user, r, x) })) });
}
async function saveObjectRecord(user, objectId, body = {}, id = null) {
  const r = S.roleOf(user);
  const o = await P.one('SELECT * FROM "CrmObjectDef" WHERE "id" = ? AND "active" = 1', clip(objectId, 60));
  if (!o) return S.fail(404, 'This record type is not there.');
  if (!S.mayEdit(r) || !S.can(user, id ? 'edit' : 'create')) return S.fail(403, 'Your CRM rights do not allow this.');
  const fields = P.parse(o.fieldsJson, []);
  const name = clip(body.name, 200);
  if (!name) return S.fail(400, `Name this ${o.name.toLowerCase()}.`);
  const was = id ? await P.one('SELECT * FROM "CrmObjectRecord" WHERE "id" = ? AND "objectId" = ?', clip(id, 60), o.id) : null;
  if (id && !was) return S.fail(404, 'This record is not there.');
  if (was && !S.canEditRow(user, r, was)) return S.fail(403, 'You can read this record but not change it.');
  const values = { ...P.parse(was && was.valuesJson, {}) };
  const given = body.values || {};
  for (const f of fields) {
    if (!(f.key in given)) { if (!was && f.required) return S.fail(400, `${f.label} is needed.`); continue; } // eslint-disable-line no-continue
    const c = cleanValue(f, given[f.key]);
    if (c.error) return S.fail(400, c.error);
    if (f.required && isEmpty(c.value)) return S.fail(400, `${f.label} is needed.`);
    if (c.value == null) delete values[f.key]; else values[f.key] = c.value;
  }
  // the linked record must be one the person can see
  const link = {};
  for (const [col, kind] of [['accountId', 'account'], ['leadId', 'lead'], ['dealId', 'deal'], ['contactId', 'contact']]) {
    if (!(col in body)) continue; // eslint-disable-line no-continue
    const v = clip(body[col], 60);
    if (v) { const row = await S.getRow(kind, v); if (!S.canSeeRow(user, r, row)) return S.fail(400, `Pick one of your ${kind}s.`); } // eslint-disable-line no-await-in-loop
    link[col] = v || null;
  }
  const now = P.nowIso();
  if (was) {
    const data = { name, valuesJson: JSON.stringify(values), ...link, updatedAt: now };
    const cols = Object.keys(data);
    await P.run(`UPDATE "CrmObjectRecord" SET ${cols.map((c) => `"${c}" = ?`).join(', ')} WHERE "id" = ?`, ...cols.map((c) => data[c]), was.id);
    return S.okBody({ ok: true, record: await P.one('SELECT * FROM "CrmObjectRecord" WHERE "id" = ?', was.id) });
  }
  const row = { id: P.newId('orec'), objectId: o.id, name, valuesJson: JSON.stringify(values), accountId: null, leadId: null, dealId: null, contactId: null, ...link, ownerId: user.id, ownerName: user.name || null, createdById: user.id, createdAt: now, updatedAt: now };
  const cols = Object.keys(row);
  await P.run(`INSERT INTO "CrmObjectRecord" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => row[c]));
  await S.audit(user, `CRM ${o.name.toLowerCase()} added`, 'CrmObjectRecord', row.id, name);
  return S.okBody({ ok: true, record: row });
}
async function removeObjectRecord(user, id) {
  const r = S.roleOf(user);
  const was = await P.one('SELECT * FROM "CrmObjectRecord" WHERE "id" = ?', clip(id, 60));
  if (!was) return S.fail(404, 'This record is not there.');
  if (!S.mayAssign(r) && !(S.canEditRow(user, r, was) && S.can(user, 'delete'))) return S.fail(403, 'Your CRM rights do not allow deleting this.');
  await P.run('DELETE FROM "CrmObjectRecord" WHERE "id" = ?', was.id);
  await S.audit(user, 'CRM custom record deleted', 'CrmObjectRecord', was.id, was.name);
  return S.okBody({ ok: true });
}

// ---- what the screens read once: every definition, the layouts, the lists ---------------------------------------------
async function setup() {
  const cfg = await P.config();
  return {
    fields: await defs(null), rules: await rules(null), objects: await objects(), layouts: cfg.layouts, builtIn: BUILT_IN, types: TYPES.map((t) => ({ value: t, label: TYPE_WORDS[t] })), ops: OPS.map((o) => ({ value: o, label: OP_WORDS[o] })),
    currencies: cfg.currencies, baseCurrency: cfg.baseCurrency, units: cfg.unitsOn ? cfg.units : [], unitsOn: cfg.unitsOn, fiscal: cfg.fiscal, branding: { color: cfg.branding.color, tagline: cfg.branding.tagline, hasLogo: !!cfg.branding.logo }, locale: cfg.locale,
  };
}
async function saveLayout(user, kind, body = {}) {
  if (!mayAdmin(user)) return NO_ADMIN();
  if (!KINDS.includes(kind)) return S.fail(400, 'Pick leads, accounts, contacts or deals.');
  const cfg = await P.config({ fresh: true });
  const layouts = { ...cfg.layouts, [kind]: { sections: body.sections, hidden: body.hidden, readOnly: body.readOnly } };
  if (body.reset === true) delete layouts[kind];
  const next = await P.saveConfig({ layouts });
  await S.audit(user, 'CRM page layout changed', 'AppSetting', 'crm.plus', `${kind}: ${body.reset ? 'back to the standard form' : `${(next.layouts[kind] || { sections: [] }).sections.length} sections`}`);
  return S.okBody({ ok: true, layout: next.layouts[kind] || null });
}

module.exports = { KINDS, TYPES, BUILT_IN, defs, saveField, removeField, valuesOf, display, cleanValue, rules, saveRule, removeRule, beforeSave, objects, saveObject, objectRecords, saveObjectRecord, removeObjectRecord, setup, saveLayout, failsRule };
