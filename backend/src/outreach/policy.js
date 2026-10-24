// ---------------------------------------------------------------------------
// OMNI-CHANNEL POLICY SWITCHES (Admin, all default OFF / empty). Kept in AppSetting, read with a 10 second memory so the sending path stays cheap.
//   omni.consentRules   { atsAppliedMeansJobAllowed }  default false. ON = a contact copied from ATS (Import from ATS) who applied to OUR job may get
//                       JOB-RELATED messages (a job promotion on a way they have an address for) even though no consent was recorded yet.
//                       Opt-outs and the do-not-contact list still win. Everything else (staff messages, other kinds of contact) still needs a recorded yes.
//   omni.approval       { required }  default false. ON = a campaign made by a BDE waits for a Team Lead / BDE TL / Admin to approve it before Send.
//   omni.waNumbers      [{ id, label, number (digits, shown masked), departments[] }]  Configuration > Meta WhatsApp: which number a department uses.
//                       CONFIG + ROUTING ONLY: sending still uses the ONE connected WhatsApp number (Administration > Integrations) until more
//                       numbers are really connected there. The mapping decides the "Account" shown on a campaign and which number is ASKED for.
//   omni.customFields   [{ id, key, name, type (12 kinds, see below), options[], color, description, required, ... }]  CRM Fields page (Admin edits; never saved yet = the two starter fields).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('../utils/audit');

const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const cache = new Map();
async function getKey(key, d) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 10000) return hit.v;
  const r = await prisma.appSetting.findUnique({ where: { key } }).catch(() => null);
  const v = r ? parse(r.value, d) : d;
  cache.set(key, { at: Date.now(), v });
  return v;
}
async function putKey(key, value, user) {
  const v = JSON.stringify(value);
  await prisma.appSetting.upsert({ where: { key }, create: { key, value: v, updatedById: user && user.id, updatedByName: user && user.name }, update: { value: v, updatedById: user && user.id, updatedByName: user && user.name } });
  cache.set(key, { at: Date.now(), v: value });
  return value;
}
const forget = () => cache.clear();

// ---- consent rule + approval switch ------------------------------------------------------------------------------
async function consentRules() { const v = await getKey('omni.consentRules', {}); return { atsAppliedMeansJobAllowed: v.atsAppliedMeansJobAllowed === true }; }
async function approval() { const v = await getKey('omni.approval', {}); return { required: v.required === true }; }
async function saveSwitches(user, b) {
  const out = {};
  if (b.atsAppliedMeansJobAllowed !== undefined) {
    const cur = await consentRules(); const next = { atsAppliedMeansJobAllowed: b.atsAppliedMeansJobAllowed === true };
    await putKey('omni.consentRules', next, user); out.consentRules = next;
    if (cur.atsAppliedMeansJobAllowed !== next.atsAppliedMeansJobAllowed) await logAudit({ userId: user.id, actorName: user.name, action: next.atsAppliedMeansJobAllowed ? 'Omni-Channel rule ON: applied to our job = job messages allowed' : 'Omni-Channel rule OFF: applied to our job = job messages allowed', entity: 'OmniConsentRules', entityId: 'ats', toValue: next.atsAppliedMeansJobAllowed ? 'on' : 'off' });
  }
  if (b.approvalRequired !== undefined) {
    const cur = await approval(); const next = { required: b.approvalRequired === true };
    await putKey('omni.approval', next, user); out.approval = next;
    if (cur.required !== next.required) await logAudit({ userId: user.id, actorName: user.name, action: next.required ? 'Omni-Channel campaign approval switched ON' : 'Omni-Channel campaign approval switched OFF', entity: 'OmniApproval', entityId: 'policy', toValue: next.required ? 'on' : 'off' });
  }
  return out;
}

// ---- WhatsApp numbers per department -------------------------------------------------------------------------------
const maskNum = (n) => { const d = String(n || '').replace(/\D/g, ''); return d ? `${'*'.repeat(Math.max(0, d.length - 4))}${d.slice(-4)}` : ''; };
async function waNumbers() {
  // WHATSAPP NUMBERS (utils/waNumbers.js): once real numbers are added, THESE are the numbers (the old routing-only mapping is not used any more)
  try {
    const WN = require('../utils/waNumbers'); // eslint-disable-line global-require
    if (await WN.hasNumbers()) {
      const out = [];
      for (const r of await WN.listRows()) out.push({ id: r.id, label: r.label, number: r.displayDigits, numberMasked: maskNum(r.displayDigits), departments: (await WN.accessOf(r.id)).filter((a) => a.kind === 'DEPARTMENT').map((a) => a.refId), real: true }); // eslint-disable-line no-await-in-loop
      return out;
    }
  } catch { /* the old mapping below */ }
  const list = await getKey('omni.waNumbers', []);
  return (Array.isArray(list) ? list : []).map((r) => ({ id: r.id, label: r.label, number: r.number, numberMasked: maskNum(r.number), departments: r.departments || [] }));
}
async function saveWaNumbers(user, rows) {
  try { if (await require('../utils/waNumbers').hasNumbers()) return { error: 'These are real WhatsApp numbers now. Add, assign and reconnect them in Administration > Integrations > WhatsApp & SMS > WhatsApp numbers.', status: 409 }; } catch { /* the old mapping */ } // eslint-disable-line global-require
  const out = []; const seen = new Set();
  for (const r of (Array.isArray(rows) ? rows : []).slice(0, 20)) {
    const label = clip(r.label, 60); const digits = String(r.number || '').replace(/\D/g, '').slice(0, 15);
    if (!label) return { error: 'Give each number a name (for example "Medical team").', status: 400 };
    if (digits.length < 10) return { error: `The number for "${label}" must have at least 10 digits.`, status: 400 };
    if (seen.has(digits)) return { error: `The number for "${label}" is already in the list.`, status: 400 };
    seen.add(digits);
    const departments = [...new Set((Array.isArray(r.departments) ? r.departments : []).map((d) => clip(d, 60)).filter(Boolean))].slice(0, 20);
    out.push({ id: clip(r.id, 40) || `wn${Date.now().toString(36)}${out.length}`, label, number: digits, departments });
  }
  await putKey('omni.waNumbers', out, user);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Omni-Channel WhatsApp numbers mapping changed', entity: 'OmniWaNumbers', entityId: 'map', toValue: `${out.length} numbers (config and routing only)` });
  return { ok: 'Saved. Sending still uses the one connected WhatsApp number until more numbers are connected in Administration > Integrations.', numbers: await waNumbers() };
}
// which number a department uses: { label, number, numberMasked, mapped } (the connected number when nothing is mapped)
async function numberFor(department, connected = {}) {
  const d = String(department || '').trim().toLowerCase();
  try {
    const WN = require('../utils/waNumbers'); // eslint-disable-line global-require
    if (await WN.hasNumbers()) {
      const rows = (await WN.listRows()).filter((r) => r.active);
      let hit = null;
      for (const r of rows) { if (d && (await WN.accessOf(r.id)).some((a) => a.kind === 'DEPARTMENT' && String(a.refId).toLowerCase() === d)) { hit = r; break; } } // eslint-disable-line no-await-in-loop
      const row = hit || rows.find((r) => r.isDefault) || rows[0];
      if (row) return { label: row.label, number: row.displayDigits, numberMasked: maskNum(row.displayDigits), mapped: !!hit };
    }
  } catch { /* the old mapping */ }
  const list = await getKey('omni.waNumbers', []);
  const hit = d ? (Array.isArray(list) ? list : []).find((r) => (r.departments || []).some((x) => String(x).toLowerCase() === d)) : null;
  if (hit) return { label: hit.label, number: hit.number, numberMasked: maskNum(hit.number), mapped: true };
  return { label: 'Company WhatsApp number', number: connected.number || '', numberMasked: connected.number ? maskNum(connected.number) : '', mapped: false };
}

// ---- custom fields (CRM Fields page, 2026-10-17 Green Start rebuild) -------------------------------------------------------------
// One field = { id, key, name (the label people see), type, options[], color, description, required, updatedAt, inForms, inImport, inFilters, builtin }.
//   id = key = a lowercase slug made from the label (never changes after it is made, so saved values stay attached);
//   type  dropdown | multi | text | longtext | number | currency | date | datetime | email | phone | checkbox | url
//   (the old list said text | number | date | choice: "choice" is read as "dropdown", its `choices` as `options`; `choices` is still sent for older code)
// Values are saved in OutreachContact.customValues (JSON, keyed by field id): a string; an array for "multi"; 'yes' for a ticked checkbox.
// Never saved yet = the two starter fields "Lead stage" and "Lead status" (an Admin may edit or delete them like any other field).
const FIELD_TYPES = ['dropdown', 'multi', 'text', 'longtext', 'number', 'currency', 'date', 'datetime', 'email', 'phone', 'checkbox', 'url'];
const FIELD_TYPE_WORDS = {
  dropdown: 'Dropdown (Single Selection)', multi: 'Dropdown (Multi Selection)', text: 'Text', longtext: 'Long Text', number: 'Number', currency: 'Currency',
  date: 'Date', datetime: 'Date & Time', email: 'Email', phone: 'Phone', checkbox: 'Checkbox', url: 'URL',
};
const LEGACY_TYPES = { choice: 'dropdown', select: 'dropdown', string: 'text' };
const DEFAULT_COLOR = '#16a34a';
const isDropdown = (t) => t === 'dropdown' || t === 'multi';
// the starter fields
function defaultFields() {
  const at = new Date('2026-10-17T00:00:00Z').toISOString();
  return [
    { id: 'lead_stage', key: 'lead_stage', name: 'Lead stage', type: 'dropdown', options: ['New', 'Contacted', 'Interested', 'Applied', 'Interview', 'Offered', 'Joined', 'Not interested'], color: '#166534', description: 'Where this person is on the way to a job.', required: false, updatedAt: at, inForms: true, inImport: true, inFilters: true, builtin: true },
    { id: 'lead_status', key: 'lead_status', name: 'Lead status', type: 'dropdown', options: ['New', 'Open', 'Working', 'Follow up', 'Hot', 'Warm', 'Cold', 'On hold', 'Closed'], color: '#15803d', description: 'How warm the person is right now.', required: false, updatedAt: at, inForms: true, inImport: true, inFilters: true, builtin: true },
  ];
}
const slugOf = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
const HEX = /^#[0-9a-fA-F]{6}$/;
const optionList = (v) => [...new Map((Array.isArray(v) ? v : String(v || '').split(/[,\n]/)).map((c) => clip(c, 60)).filter(Boolean).map((c) => [c.toLowerCase(), c])).values()].slice(0, 60);

// raw list -> { fields } or { error }. lenient: skip a bad row instead of refusing the whole list (used when reading what is already saved).
function cleanFields(raw, { lenient = false } = {}) {
  const out = []; const names = new Set(); const keys = new Set();
  for (const r of (Array.isArray(raw) ? raw : []).slice(0, 60)) {
    const name = clip(r && (r.name || r.label), 40);
    if (name.length < 2) { if (lenient) continue; return { error: 'Give each custom field a name (at least 2 letters).' }; } // eslint-disable-line no-continue
    if (names.has(name.toLowerCase())) { if (lenient) continue; return { error: `There are two fields called "${name}".` }; } // eslint-disable-line no-continue
    const rawType = String(r.type || 'text');
    const type = FIELD_TYPES.includes(rawType) ? rawType : (LEGACY_TYPES[rawType] || 'text');
    const options = isDropdown(type) ? optionList(r.options !== undefined ? r.options : r.choices) : [];
    if (isDropdown(type) && options.length < 1) { if (lenient) continue; return { error: `Add at least one option to the dropdown "${name}".` }; } // eslint-disable-line no-continue
    let key = /^[a-z0-9_]{1,40}$/.test(String(r.key || '')) ? String(r.key) : (/^[a-z0-9_]{1,40}$/.test(String(r.id || '')) ? String(r.id) : (slugOf(name) || 'field'));
    const base = key; let n = 2;
    while (keys.has(key)) { key = `${base.slice(0, 36)}_${n}`; n += 1; }
    names.add(name.toLowerCase()); keys.add(key);
    out.push({
      id: key, key, name, type, options, choices: options, color: HEX.test(String(r.color || '')) ? String(r.color).toLowerCase() : DEFAULT_COLOR, description: clip(r.description || r.desc, 200), required: r.required === true,
      updatedAt: r.updatedAt && !Number.isNaN(Date.parse(r.updatedAt)) ? new Date(r.updatedAt).toISOString() : new Date().toISOString(), inForms: r.inForms !== false, inImport: r.inImport !== false, inFilters: r.inFilters !== false, builtin: r.builtin === true,
    });
  }
  return { fields: out };
}
async function customFields() {
  const list = await getKey('omni.customFields', null);
  if (list === null || list === undefined) return defaultFields();
  const c = cleanFields(list, { lenient: true });
  return c.fields || [];
}
const sameShape = (a, b) => !!a && !!b && a.name === b.name && a.type === b.type && a.color === b.color && a.description === b.description && a.required === b.required && JSON.stringify(a.options) === JSON.stringify(b.options);
async function saveCustomFields(user, rows) {
  const c = cleanFields(rows);
  if (c.error) return { error: c.error, status: 400 };
  // the "last updated" day moves only for a field that really changed (or is new)
  const before = await customFields();
  const stamped = c.fields.map((f) => { const old = before.find((x) => x.id === f.id); return old && sameShape(old, f) ? { ...f, updatedAt: old.updatedAt } : { ...f, updatedAt: new Date().toISOString() }; });
  await putKey('omni.customFields', stamped, user);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Omni-Channel custom fields changed', entity: 'OmniCustomFields', entityId: 'list', toValue: `${stamped.length} fields` });
  return { ok: 'Saved.', fields: stamped };
}

// ---- one typed value -> the clean value for that field, or { error } -----------------------------------------------------------------
const NUM = (t) => { const n = Number(String(t).replace(/[,₹\s]/g, '')); return Number.isFinite(n) ? n : null; };
function cleanValue(field, v) {
  const name = field.name;
  if (field.type === 'multi') {
    let arr = v;
    if (typeof v === 'string') { try { const j = JSON.parse(v); arr = Array.isArray(j) ? j : v.split(/[,;|]/); } catch { arr = v.split(/[,;|]/); } }
    arr = (Array.isArray(arr) ? arr : (arr == null || arr === '' ? [] : [arr])).map((x) => clip(x, 60)).filter(Boolean);
    const out = [];
    for (const x of arr) { const hit = (field.options || []).find((o) => o.toLowerCase() === x.toLowerCase()); if (!hit) return { error: `"${x}" is not one of the choices for "${name}".` }; if (!out.includes(hit)) out.push(hit); }
    return { value: out };
  }
  const t = clip(v, field.type === 'longtext' ? 2000 : 300);
  if (t === '') return { value: '' };
  switch (field.type) {
    case 'number': { const n = NUM(t); return n === null ? { error: `"${name}" must be a number.` } : { value: String(n) }; }
    case 'currency': { const n = NUM(t); return n === null || n < 0 ? { error: `"${name}" must be an amount (numbers only).` } : { value: String(n) }; }
    case 'date': { const d = /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : (() => { const x = Date.parse(t); return Number.isFinite(x) ? new Date(x).toISOString().slice(0, 10) : null; })(); return d && !Number.isNaN(Date.parse(d)) ? { value: d } : { error: `"${name}" must be a date.` }; }
    case 'datetime': { const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(t); if (m && !Number.isNaN(Date.parse(`${m[1]}T${m[2]}`))) return { value: `${m[1]}T${m[2]}` }; const x = Date.parse(t); return Number.isFinite(x) ? { value: new Date(x).toISOString().slice(0, 16) } : { error: `"${name}" must be a date and time.` }; }
    case 'email': return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(t) && t.length <= 160 ? { value: t.toLowerCase() } : { error: `"${name}" must be an email address.` };
    case 'phone': { const d = t.replace(/[^\d+]/g, ''); return /^\+?\d{7,15}$/.test(d) ? { value: d } : { error: `"${name}" must be a phone number.` }; }
    case 'url': { try { const u = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`); return /^https?:$/.test(u.protocol) && u.hostname.includes('.') ? { value: u.toString().slice(0, 300) } : { error: `"${name}" must be a web link.` }; } catch { return { error: `"${name}" must be a web link.` }; } }
    case 'checkbox': return { value: /^(1|yes|y|true|on|checked|ticked)$/i.test(t) ? 'yes' : '' };
    case 'dropdown': { const hit = (field.options || []).find((c) => c.toLowerCase() === t.toLowerCase()); return hit ? { value: hit } : { error: `"${t}" is not one of the choices for "${name}".` }; }
    default: return { value: t };
  }
}
// { [fieldId]: value } from whatever came in; unknown fields and bad values are dropped with a note. Empty values are dropped (not saved).
async function cleanValues(input, fields) {
  const defs = fields || await customFields();
  const out = {}; const problems = [];
  Object.entries(input && typeof input === 'object' ? input : {}).forEach(([id, v]) => {
    const f = defs.find((x) => x.id === id || x.key === id);
    if (!f) return;
    const c = cleanValue(f, v);
    if (c.error) problems.push(c.error); else if (Array.isArray(c.value) ? c.value.length : c.value !== '') out[f.id] = c.value;
  });
  return { values: out, problems };
}
// the "Required" rule, in a plain sentence per missing field (checked when a person is saved by hand or a form is sent, not on imports)
function missingRequired(values, fields, only) {
  const v = values && typeof values === 'object' ? values : {};
  return (fields || []).filter((f) => f.required && (!only || only.includes(f.id))).filter((f) => (Array.isArray(v[f.id]) ? !v[f.id].length : !String(v[f.id] == null ? '' : v[f.id]).trim())).map((f) => `${f.name} is needed before this can be saved.`);
}

module.exports = { getKey, putKey, forget, consentRules, approval, saveSwitches, waNumbers, saveWaNumbers, numberFor, maskNum, customFields, saveCustomFields, cleanValues, cleanValue, cleanFields, missingRequired, defaultFields, isDropdown, slugOf, FIELD_TYPES, FIELD_TYPE_WORDS };
