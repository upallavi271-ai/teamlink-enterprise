// ---------------------------------------------------------------------------
// CRM (Omni-Channel > CRM Fields / All Customers / Segments / Web Forms): the page-level logic behind routes/omniGsCrm.js.
//   fields    CRM Fields page: the custom fields (policy.js), Admin edits.
//   customers the All Customers table: one row per person, the role's scope and masking (contacts.scopeConds), column filters + sort + paging on the server.
//   detail    one person: boxes, a clear "who may message them" table (Allowed / Not asked / Opted out with the date and where it came from), the timeline.
//   export    the table as an Excel file (Admin only, audited, counts only in the audit row).
// Masking: a BDE / BDE TL / Recruiter / Marketing login never gets a phone or an email, also not inside a custom field of type Phone / Email, and cannot search,
// filter or sort by them (that would reveal what is hidden). Nothing here sends a message.
// ---------------------------------------------------------------------------
const XLSX = require('xlsx');
const prisma = require('../db');
const core = require('../utils/messagingCore');
const S = require('./store');
const A = require('./access');
const C = require('./consent');
const K = require('./contacts');
const R = require('./rules');
const Pol = require('./policy');
const { logAudit } = require('../utils/audit');

const SRC_WORDS = { import_declared: 'File import (permission ticked)', form: 'Web form', admin: 'Recorded by an Admin', manual: 'Recorded by the team', screen: 'Recorded on screen', unsubscribe_link: 'Unsubscribe link', stop_reply: 'Replied STOP' };
const STATE_WORDS = { allowed: 'Allowed', not_asked: 'Not asked', opted_out: 'Opted out' };
const STATE_OF = { opted_in: 'allowed', unknown: 'not_asked', opted_out: 'opted_out' };
const WA = { whatsapp: 'WhatsApp', email: 'Email', sms: 'SMS' };
const likeOf = (v) => `%${String(v == null ? '' : v).replace(/[%_]/g, '').trim().slice(0, 80)}%`;

// ---- CRM FIELDS ----------------------------------------------------------------------------------------------------------------------------
async function fieldsList(user) {
  return { fields: await Pol.customFields(), types: Pol.FIELD_TYPES.map((id) => ({ id, label: Pol.FIELD_TYPE_WORDS[id] })), canEdit: A.has('mayCustomFields')(user) };
}
async function fieldCreate(user, b) {
  if (!A.has('mayCustomFields')(user)) return { error: 'Only an Admin can add or change fields.', status: 403 };
  const cur = await Pol.customFields();
  const name = S.clip(b.name || b.label, 40);
  if (name.length < 2) return { error: 'Display label is required.', status: 400 };
  if (cur.some((f) => f.name.toLowerCase() === name.toLowerCase())) return { error: `A field called "${name}" already exists.`, status: 409 };
  const out = await Pol.saveCustomFields(user, [{ ...b, name, key: undefined, id: undefined, builtin: false }, ...cur]); // the newest field goes to the top
  return out.error ? out : { ok: `Field "${name}" created.`, fields: out.fields, field: out.fields.find((f) => f.name === name) };
}
async function fieldUpdate(user, id, b) {
  if (!A.has('mayCustomFields')(user)) return { error: 'Only an Admin can add or change fields.', status: 403 };
  const cur = await Pol.customFields();
  const f = cur.find((x) => x.id === id);
  if (!f) return { error: 'This field was not found.', status: 404 };
  const name = S.clip(b.name || b.label || f.name, 40);
  if (cur.some((x) => x.id !== id && x.name.toLowerCase() === name.toLowerCase())) return { error: `A field called "${name}" already exists.`, status: 409 };
  const out = await Pol.saveCustomFields(user, cur.map((x) => (x.id === id ? { ...x, ...b, name, key: x.key, id: x.id } : x)));
  return out.error ? out : { ok: `Field "${name}" updated.`, fields: out.fields, field: out.fields.find((x) => x.id === id) };
}
async function fieldDelete(user, id) {
  if (!A.has('mayCustomFields')(user)) return { error: 'Only an Admin can add or change fields.', status: 403 };
  const cur = await Pol.customFields();
  const f = cur.find((x) => x.id === id);
  if (!f) return { error: 'This field was not found.', status: 404 };
  const out = await Pol.saveCustomFields(user, cur.filter((x) => x.id !== id));
  return out.error ? out : { ok: `"${f.name}" deleted.`, fields: out.fields };
}

// ---- CUSTOMERS ------------------------------------------------------------------------------------------------------------------------------
// what a masked login sees of a phone- or email-type custom value
function maskCustomValue(f, v) {
  if (f.type === 'email') return core.maskEmail(String(v)) || '';
  if (f.type === 'phone') { const d = String(v).replace(/\D/g, ''); return d ? `${'•'.repeat(Math.max(0, d.length - 2))}${d.slice(-2)}` : ''; }
  return v;
}
function customOf(row, defs, user) {
  const cv = K.parseCv(row.customValues); const masked = A.masked(user);
  const out = {};
  defs.forEach((f) => {
    const v = cv[f.id];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return;
    out[f.id] = masked && ['phone', 'email'].includes(f.type) ? maskCustomValue(f, Array.isArray(v) ? v.join(', ') : v) : v;
  });
  return { values: out, platformId: cv._platformId ? String(cv._platformId) : '', raw: cv };
}
function channelsView(chans) {
  return ['whatsapp', 'email', 'sms'].map((ch) => {
    const r = (chans || []).find((x) => x.channel === ch);
    if (!r || !r.hasAddress) return { channel: ch, label: WA[ch], state: 'none', words: 'No address' };
    const state = STATE_OF[r.optIn] || 'not_asked';
    const at = state === 'allowed' ? r.optInAt : (state === 'opted_out' ? r.optOutAt : null);
    const how = state === 'allowed' ? (SRC_WORDS[r.optInSource] || r.optInSource || '') : (state === 'opted_out' ? (r.optOutWords || '') : '');
    return { channel: ch, label: WA[ch], state, words: STATE_WORDS[state], at, how, problem: r.health && r.health !== 'ok' ? 'Address problem' : null };
  });
}
async function ownerNames(rows) {
  const ids = [...new Set(rows.map((r) => r.ownerUserId).filter(Boolean))];
  if (!ids.length) return {};
  const us = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }).catch(() => []);
  return Object.fromEntries(us.map((u) => [u.id, u.name]));
}
function rowView(row, user, tags, chans, defs, owners) {
  const v = K.view(row, user, tags, chans);
  const cv = customOf(row, defs, user);
  return {
    id: v.id, contactType: v.contactType, name: v.name, phone: v.phone, email: v.email, platformId: cv.platformId, source: v.source, city: v.city, company: v.company, skills: v.skills, experience: v.experience,
    language: v.language, preferredChannel: v.preferredChannel, notes: v.notes, lastReplyAt: v.lastReplyAt, kinds: v.industries, channels: channelsView(v.channels), customValues: cv.values,
    leadStage: cv.values.lead_stage || '', leadStatus: cv.values.lead_status || '', ownerName: (owners && owners[row.ownerUserId]) || row.createdByName || '', createdAt: v.createdAt, fromAts: !!row.linkedApplicantId,
  };
}

// the columns that can be searched / filtered / sorted: id -> { sql (an expression), param? , maskedBlocked }
function colExpr(id, defs) {
  const simple = { name: 'c.name', phone: 'c.phoneE164', email: 'c.email', source: 'c.source', city: 'c.city', company: 'c.company', skills: 'c.skills', language: 'c.language', preferredChannel: 'c.preferredChannel', owner: 'c.createdByName', created: 'c.createdAt', lastReply: 'c.lastReplyAt' };
  if (simple[id]) return { sql: simple[id], blocked: id === 'phone' || id === 'email' };
  if (id === 'platformId') return { sql: "json_extract(c.customValues, '$._platformId')" };
  if (id === 'kinds') return { sql: '(SELECT GROUP_CONCAT(t.industry, \', \') FROM "OutreachContactTag" t WHERE t.contactId = c.id)' };
  if (id.startsWith('cf:')) {
    const f = defs.find((x) => x.id === id.slice(3));
    if (f) return { sql: 'json_extract(c.customValues, ?)', param: `$.${f.id}`, blocked: ['phone', 'email'].includes(f.type) };
  }
  return null;
}
const DEPT_KINDS = async (dept) => { const inds = await S.industries(); return inds.filter((i) => String(i.department || i.name).toLowerCase() === dept.toLowerCase()).map((i) => i.name); };

// q: { type, q, page, pageSize, sort, dir, filters: { colId: text }, form, dept }
async function customers(user, q = {}) {
  await require('./v3schema').ensure(); // eslint-disable-line global-require
  const type = q.type === 'internal' ? 'internal' : 'candidate_lead';
  const defs = await Pol.customFields();
  const masked = A.masked(user);
  const meta = await metaOf(user, defs, type);
  const empty = { contacts: [], total: 0, page: 1, pageSize: Number(q.pageSize) || 20, masked, meta };
  const sc = await K.scopeConds(user, type);
  if (!sc || q.dept === null) return empty;
  const where = ["c.status = 'active'", ...sc.conds]; const params = [...sc.params];
  // the department picked in the top bar (promotion contacts only)
  if (type !== 'internal' && q.dept) {
    const kinds = await DEPT_KINDS(q.dept);
    const ors = ['LOWER(COALESCE(c.department, \'\')) = ?']; const ps = [String(q.dept).toLowerCase()];
    if (kinds.length) { ors.push(`EXISTS (SELECT 1 FROM "OutreachContactTag" t WHERE t.contactId = c.id AND t.industry IN (${R.ph(kinds.length)}))`); ps.push(...kinds); }
    where.push(`(${ors.join(' OR ')})`); params.push(...ps);
  }
  // the search box: name, phone, email, source, city, company, skills, platform ID, language
  const t = String(q.q || '').trim().slice(0, 80);
  if (t) {
    const like = likeOf(t); const digits = t.replace(/\D/g, '');
    const parts = ['c.name LIKE ?', 'c.source LIKE ?', 'c.city LIKE ?', 'c.company LIKE ?', 'c.skills LIKE ?', 'c.language LIKE ?', "json_extract(c.customValues, '$._platformId') LIKE ?"]; const ps = [like, like, like, like, like, like, like];
    if (!masked) { parts.push('c.email LIKE ?'); ps.push(like); if (digits.length >= 4) { parts.push('c.phoneKey LIKE ?'); ps.push(`%${digits.slice(-10)}%`); } }
    where.push(`(${parts.join(' OR ')})`); params.push(...ps);
  }
  // one box per column: "contains"
  const filters = q.filters && typeof q.filters === 'object' ? q.filters : {};
  for (const [id, raw] of Object.entries(filters).slice(0, 12)) {
    const v = String(raw == null ? '' : raw).trim().slice(0, 80);
    if (!v) continue; // eslint-disable-line no-continue
    if (id === 'permission') {
      const st = /allow|yes|ok/i.test(v) ? 'opted_in' : (/not|ask|unknown/i.test(v) ? 'unknown' : (/opt|stop/i.test(v) ? 'opted_out' : null));
      where.push(st ? 'EXISTS (SELECT 1 FROM "OutreachContactChannel" h WHERE h.contactId = c.id AND h.optIn = ?)' : '0 = 1'); if (st) params.push(st);
      continue; // eslint-disable-line no-continue
    }
    const e = colExpr(id, defs);
    if (!e || e.blocked && masked) continue; // eslint-disable-line no-continue
    if (id === 'created' || id === 'lastReply') continue; // eslint-disable-line no-continue
    if (id === 'phone') { const d = v.replace(/\D/g, ''); if (d.length >= 3) { where.push('c.phoneE164 LIKE ?'); params.push(`%${d}%`); } continue; } // eslint-disable-line no-continue
    where.push(`${e.sql} LIKE ?`); if (e.param) params.push(e.param); params.push(likeOf(v));
  }
  // the form tab ("Default" = everybody)
  if (q.form && /^[A-Za-z0-9_-]{4,60}$/.test(String(q.form))) { await require('./forms').ensure(); where.push('EXISTS (SELECT 1 FROM "OmniFormSubmission" s WHERE s.contactId = c.id AND s.formId = ?)'); params.push(String(q.form)); } // eslint-disable-line global-require
  const W = where.join(' AND ');
  // sort: one column at a time (natural order), newest first by default
  let order = 'c.createdAt DESC, c.id DESC'; const orderParams = [];
  const se = q.sort ? colExpr(String(q.sort), defs) : null;
  if (se && !(se.blocked && masked)) { const dir = q.dir === 'desc' ? 'DESC' : 'ASC'; order = `${q.sort === 'created' || q.sort === 'lastReply' ? se.sql : `LOWER(COALESCE(${se.sql}, ''))`} ${dir}, c.id ${dir}`; if (se.param) orderParams.push(se.param); }
  const pageSize = [10, 20, 50, 100].includes(Number(q.pageSize)) ? Number(q.pageSize) : 20;
  const total = S.num((await S.q(`SELECT COUNT(*) n FROM "OutreachContact" c WHERE ${W}`, ...params))[0].n);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pages, Math.max(1, Number(q.page) || 1));
  const rows = await S.q(`SELECT c.* FROM "OutreachContact" c WHERE ${W} ORDER BY ${order} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, ...params, ...orderParams);
  const ids = rows.map((r) => r.id);
  const tagRows = ids.length ? await S.q(`SELECT contactId, industry FROM "OutreachContactTag" WHERE contactId IN (${R.ph(ids.length)})`, ...ids) : [];
  const chRows = ids.length ? await S.q(`SELECT * FROM "OutreachContactChannel" WHERE contactId IN (${R.ph(ids.length)})`, ...ids) : [];
  const tagsBy = {}; tagRows.forEach((x) => { (tagsBy[x.contactId] = tagsBy[x.contactId] || []).push(x.industry); });
  const chBy = {}; chRows.forEach((x) => { (chBy[x.contactId] = chBy[x.contactId] || []).push(x); });
  const owners = await ownerNames(rows);
  const canWrite = A.mayWrite(user, type);
  return { contacts: rows.map((r) => rowView(r, user, (tagsBy[r.id] || []).sort(), chBy[r.id] || [], defs, owners)), total, page, pageSize, masked, canWrite, meta };
}

async function metaOf(user, defs, type) {
  let forms = [];
  try { forms = (await require('./forms').list(user)).forms.map((f) => ({ id: f.id, title: f.title })); } catch { forms = []; } // eslint-disable-line global-require
  const ready = await S.ready();
  return {
    fields: defs.map((f) => ({ id: f.id, name: f.name, type: f.type, options: f.options || [], color: f.color, required: f.required, description: f.description })),
    kinds: ready ? (await S.industries()).map((i) => i.name) : [], forms, canImport: A.mayWrite(user, type), canAdd: A.mayWrite(user, type), canExport: A.isAdmin(user), canImportAts: A.has('mayImportAts')(user), canInternal: A.seesInternal(user),
    canPromo: A.seesLeads(user), isAdmin: A.isAdmin(user), masked: A.masked(user), canOptOut: A.mayOptOut(user), canOptIn: A.mayOptIn(user),
  };
}

// add one person by hand (the Add Customer box): kinds go through setIndustries after the person exists
async function addCustomer(user, b) {
  const type = b.contactType === 'internal' ? 'internal' : 'candidate_lead';
  const phone = K.phoneOf(b.phone); const email = K.emailOf(b.email);
  if (!String(b.name || '').trim() && !phone.ok) return { error: 'Enter at least a name or a phone number: a customer with neither cannot be reached.', status: 400 };
  if (!email.ok && !email.blank) return { error: 'That email address does not look valid.', status: 400 };
  if (!phone.ok && !email.ok) return { error: !phone.blank ? (phone.reason || 'That phone number does not look right.') : 'Give a phone number or an email address.', status: 400 };
  const dups = await K.findByKeys(phone.ok ? phone.key : null, email.ok ? email.key : null);
  if (dups.length) {
    const seen = await K.getOne(user, dups[0].id);
    const who = seen && seen.row.name ? seen.row.name : 'an existing contact';
    return { error: seen ? `${phone.ok && dups[0].phoneKey === phone.key ? 'That phone number' : 'That email address'} already belongs to ${who}. Edit that record instead of adding a copy.` : 'This person is already in the list (it belongs to another team). Nothing was added.', status: 409, duplicateId: seen ? dups[0].id : undefined };
  }
  const out = await K.createManual(user, { ...b, contactType: type, industries: Array.isArray(b.kinds) ? b.kinds : [] });
  return out.error ? out : { ok: `${String(b.name || '').trim() || 'Customer'} added.`, id: out.contact };
}
async function editCustomer(user, id, b) {
  const out = await K.updateFields(user, id, { ...b, enforceRequired: b.enforceRequired !== false });
  if (out.error) return out;
  if (Array.isArray(b.kinds)) { const k = await K.setIndustries(user, id, b.kinds); if (k.error) return k; }
  return { ok: 'Customer updated.', changed: out.changed };
}

// ONE person, with the full "who may message them" table and the timeline
async function detail(user, id) {
  const one = await K.getOne(user, id);
  if (!one) return null;
  const defs = await Pol.customFields();
  const chans = await C.channelRows(id);
  const owners = await ownerNames([one.row]);
  const tags = one.view.industries;
  const row = rowView(one.row, user, tags, chans, defs, owners);
  let lastReplyAt = row.lastReplyAt;
  try { const rp = require('./replies'); if (rp && rp.lastReplyOf) { const r = await rp.lastReplyOf(id); if (r && r.at) lastReplyAt = r.at; } } catch { /* the replies module is not there: the column value stays */ } // eslint-disable-line global-require
  let timeline = [];
  try { const t = await require('./overview').timeline(user, id); timeline = t ? t.items : []; } catch { timeline = []; } // eslint-disable-line global-require
  const type = one.row.contactType;
  const history = A.kind(user) === 'recruiter' ? [] : (await C.history(id)).map((h) => ({ ...h, channelLabel: WA[h.channel] || h.channel, how: SRC_WORDS[h.source] || h.source || '' }));
  const mayChange = A.mayWrite(user, type);
  return {
    contact: { ...row, lastReplyAt, consentSource: one.view.consentSource, consentAt: one.view.consentAt, unsubscribedAt: one.view.unsubscribedAt },
    timeline, history, flags: { canEdit: mayChange, canOptOut: A.mayOptOut(user) && mayChange, canOptIn: A.mayOptIn(user), canErase: A.isAdmin(user), masked: A.masked(user) },
  };
}

// ---- EXPORT (Admin only, audited) -----------------------------------------------------------------------------------------------------------
const EXPORT_COLS = [
  ['name', 'Customer Name', (c) => c.name], ['phone', 'Phone Number', (c) => c.phone], ['email', 'Email Address', (c) => c.email], ['platformId', 'Platform ID', (c) => c.platformId], ['source', 'Source', (c) => c.source],
  ['kinds', 'Kinds', (c) => c.kinds.join(', ')], ['city', 'City', (c) => c.city], ['company', 'Company', (c) => c.company], ['skills', 'Skills', (c) => c.skills], ['language', 'Language', (c) => c.language],
  ['preferredChannel', 'Preferred channel', (c) => ({ ...WA, call: 'Call' }[c.preferredChannel] || c.preferredChannel || '')],
  ['lastReply', 'Last reply', (c) => c.lastReplyAt || ''], ['notes', 'Notes', (c) => c.notes],
  ['permission', 'Permission', (c) => c.channels.filter((x) => x.state !== 'none').map((x) => `${x.label}: ${x.words}`).join('; ')],
  ['owner', 'Owner', (c) => c.ownerName], ['created', 'Created On', (c) => c.createdAt || ''],
];
async function exportXlsx(user, q = {}) {
  if (!A.isAdmin(user)) return { error: 'Only an Admin can download the list.', status: 403 };
  const defs = await Pol.customFields();
  const want = Array.isArray(q.cols) && q.cols.length ? q.cols : null;
  const cols = [...EXPORT_COLS.filter((c) => !want || want.includes(c[0])), ...defs.filter((f) => !want || want.includes(`cf:${f.id}`)).map((f) => [`cf:${f.id}`, f.name, (c) => { const v = c.customValues[f.id]; return Array.isArray(v) ? v.join(', ') : (v || ''); }])];
  const rows = [cols.map((c) => c[1])];
  let page = 1; let n = 0;
  for (;;) {
    const got = await customers(user, { ...q, page, pageSize: 100 }); // eslint-disable-line no-await-in-loop
    got.contacts.forEach((c) => { rows.push(cols.map(([, , f]) => String(f(c) == null ? '' : f(c)))); n += 1; });
    if (page * 100 >= got.total || n >= 20000) break;
    page += 1;
  }
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Customers');
  await logAudit({ userId: user.id, actorName: user.name, action: 'Outreach contacts downloaded', entity: 'OutreachContact', entityId: q.type === 'internal' ? 'internal' : 'candidate_lead', toValue: `${n} customers (Customers page)` });
  return { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), count: n };
}

// ---- SEGMENTS: what the Create / Edit box can pick from ---------------------------------------------------------------------------------------
async function segmentMeta(user, type) {
  const defs = await Pol.customFields();
  const sc = await K.scopeConds(user, type);
  let cities = []; let languages = []; let imports = [];
  if (sc) {
    const base = `c.status = 'active' AND ${sc.conds.join(' AND ')}`;
    cities = (await S.q(`SELECT c.city v, COUNT(*) n FROM "OutreachContact" c WHERE ${base} AND c.city IS NOT NULL AND c.city <> '' GROUP BY c.city ORDER BY n DESC LIMIT 60`, ...sc.params)).map((r) => r.v);
    languages = (await S.q(`SELECT c.language v, COUNT(*) n FROM "OutreachContact" c WHERE ${base} AND c.language IS NOT NULL AND c.language <> '' GROUP BY c.language ORDER BY n DESC LIMIT 40`, ...sc.params)).map((r) => r.v);
    const imps = await S.q(`SELECT c.importId v, COUNT(*) n FROM "OutreachContact" c WHERE ${base} AND c.importId IS NOT NULL GROUP BY c.importId ORDER BY n DESC LIMIT 60`, ...sc.params);
    const names = imps.length ? await S.q(`SELECT id, fileName, source FROM "OutreachImport" WHERE id IN (${R.ph(imps.length)})`, ...imps.map((i) => i.v)) : [];
    imports = imps.map((i) => { const n = names.find((x) => x.id === i.v); return { id: i.v, name: (n && (n.source || n.fileName)) || 'Import', count: S.num(i.n) }; });
  }
  return {
    kinds: (await S.industries()).map((i) => i.name), cities, languages, imports, preferred: R.PREFERRED.map((c) => ({ id: c, label: c === 'call' ? 'Call' : WA[c] })), reachable: R.CHANNELS.map((c) => ({ id: c, label: WA[c] })),
    fields: defs.filter((f) => f.inFilters !== false && (Pol.isDropdown(f.type) || f.type === 'checkbox')).map((f) => ({ id: f.id, name: f.name, options: f.type === 'checkbox' ? ['yes'] : f.options })),
    fieldDefs: defs.map((f) => ({ id: f.id, name: f.name })),
  };
}

module.exports = { fieldsList, fieldCreate, fieldUpdate, fieldDelete, customers, addCustomer, editCustomer, detail, exportXlsx, segmentMeta, metaOf, maskCustomValue, EXPORT_COLS };
