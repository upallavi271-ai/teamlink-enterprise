// ---------------------------------------------------------------------------
// WEB FORMS (Omni-Channel > Web Forms, 2026-10-17): lead-capture forms with a public page and a permission box.
//   OmniForm (v3schema.js)  + three columns made here on first use: description, memberIds (who may open the data), thanks already exists.
//   OmniFormSubmission      one row per send: { formId, contactId, result: { outcome: 'created' | 'updated' | 'kept', answer } , at }. The row holds NO phone, NO email
//                           and NO name (the person is read from the contact when the list is shown, so an erased person disappears from it).
// THE PUBLIC SIDE (outreachFormsPublic.js) shows the fields + the consent words (a required tick) and, per way of contact the person ticks, records
// "yes" (source 'form', evidence = the form's name + the version of the words). It never lifts an opt-out, never makes a second person for the same
// phone / email, and answers every send the same way (nothing says whether the person was already known).
// WHO: Admin sees every form; Manager / Assistant Manager look at every form (no changes); BDE, BDE TL and Team Lead (access.js mayForms) the forms they made or
// were named in as "permitted members"; everybody else none.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const S = require('./store');
const A = require('./access');
const C = require('./consent');
const K = require('./contacts');
const Pol = require('./policy');
const { logAudit } = require('../utils/audit');

const CH = ['whatsapp', 'email', 'sms'];
const CH_WORDS = { whatsapp: 'WhatsApp', email: 'Email', sms: 'SMS' };
const DEFAULT_CONSENT = 'I agree that TeamLink may contact me about jobs, on the ways I have ticked below. I can say STOP at any time and they will stop.';
// the boxes a form can ask for besides the custom fields (key -> label, kind of answer)
const CORE = [
  { key: 'name', label: 'Full name', type: 'text' },
  { key: 'phone', label: 'Phone Number', type: 'phone' },
  { key: 'email', label: 'Email Address', type: 'email' },
  { key: 'company', label: 'Company Name', type: 'text' },
  { key: 'city', label: 'City', type: 'text' },
  { key: 'skills', label: 'Skills', type: 'text' },
  { key: 'language', label: 'Language', type: 'text' },
  { key: 'preferredChannel', label: 'Preferred channel', type: 'dropdown', options: ['WhatsApp', 'Email', 'SMS', 'Call'] },
  { key: 'notes', label: 'Notes', type: 'longtext' },
];
const coreOf = (k) => CORE.find((c) => c.key === k);

let readyAt = 0;
async function ensure() {
  if (readyAt && Date.now() - readyAt < 600000) return;
  await require('./v3schema').ensure(); // eslint-disable-line global-require
  const cols = await S.q('PRAGMA table_info("OmniForm")');
  for (const [c, t] of [['description', 'TEXT'], ['memberIds', 'TEXT']]) if (cols.length && !cols.some((x) => x.name === c)) await S.run(`ALTER TABLE "OmniForm" ADD COLUMN "${c}" ${t}`); // eslint-disable-line no-await-in-loop
  await S.run('CREATE INDEX IF NOT EXISTS "OmniFormSubmission_contact" ON "OmniFormSubmission"("contactId")');
  readyAt = Date.now();
}
const textVersion = (text) => `form-${crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 8)}`;
const token = () => crypto.randomBytes(12).toString('base64url');

// the picker list: core boxes + every custom field that may go on a form
async function catalog() {
  const defs = (await Pol.customFields()).filter((f) => f.inForms !== false);
  return [
    ...CORE.map((c) => ({ key: c.key, label: c.label, type: c.type === 'dropdown' ? 'Select' : (c.type === 'longtext' ? 'Long text' : 'Text'), kind: 'core' })),
    ...defs.map((f) => ({ key: `cf:${f.id}`, label: f.name, type: Pol.isDropdown(f.type) ? 'Select' : Pol.FIELD_TYPE_WORDS[f.type], kind: 'custom', color: f.color })),
  ];
}
// a stored list of keys -> only the ones that still exist, in order
async function cleanKeys(list) {
  const cat = await catalog();
  const keys = new Set(cat.map((c) => c.key));
  return [...new Set((Array.isArray(list) ? list : []).map((k) => String(k)).filter((k) => keys.has(k)))];
}

async function staff() {
  const rows = await prisma.user.findMany({ where: { status: 'Active', atsAccess: true, NOT: { atsRole: { in: ['CLIENT', 'CANDIDATE', 'VENDOR', 'PARTNER'] } }, role: { notIn: ['CLIENT', 'CANDIDATE', 'VENDOR', 'PARTNER'] } }, select: { id: true, name: true, email: true, atsRole: true, role: true }, orderBy: { name: 'asc' }, take: 500 }).catch(() => []);
  return rows.map((u) => ({ id: u.id, name: u.name, email: u.email, role: String(u.atsRole || u.role || '').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()) }));
}

const view = (r, extra = {}) => ({
  id: r.id, token: r.token, title: r.name, description: r.description || '', fields: S.parse(r.fields, []), channels: S.parse(r.channels, CH).filter((c) => CH.includes(c)),
  consentText: r.consentText, consentVersion: textVersion(r.consentText), thanks: r.thanks || '', status: r.status === 'off' ? 'off' : 'on', department: r.department || '',
  memberIds: S.parse(r.memberIds, []), createdById: r.createdById || null, createdByName: r.createdByName || '', createdAt: S.iso(r.createdAt), updatedAt: S.iso(r.updatedAt), path: `/forms-public/${r.token}`, ...extra,
});

const mayManage = (user) => A.has('mayForms')(user);
async function visibleRows(user) {
  await ensure();
  const rows = await S.q('SELECT * FROM "OmniForm" WHERE deletedAt IS NULL ORDER BY createdAt DESC');
  const k = A.kind(user);
  if (k === 'admin' || k === 'view') return rows;
  if (!mayManage(user)) return [];
  return rows.filter((r) => r.createdById === user.id || S.parse(r.memberIds, []).includes(user.id));
}
const mayEdit = (user, r) => A.isAdmin(user) || (mayManage(user) && r.createdById === user.id);

async function list(user) {
  const rows = await visibleRows(user);
  const cat = await catalog();
  const members = await staff();
  const counts = {};
  if (rows.length) (await S.q(`SELECT formId, COUNT(*) n FROM "OmniFormSubmission" WHERE formId IN (${rows.map(() => '?').join(',')}) GROUP BY formId`, ...rows.map((r) => r.id))).forEach((x) => { counts[x.formId] = S.num(x.n); });
  const nameOf = new Map(members.map((m) => [m.id, m]));
  return {
    forms: rows.map((r) => { const v = view(r, { submissions: counts[r.id] || 0, canEdit: mayEdit(user, r) }); return { ...v, fieldCount: v.fields.length, members: v.memberIds.map((i) => nameOf.get(i)).filter(Boolean) }; }),
    canCreate: mayManage(user), catalog: cat, members, channels: CH.map((c) => ({ id: c, label: CH_WORDS[c] })), defaultConsent: DEFAULT_CONSENT, customFieldCount: cat.filter((c) => c.kind === 'custom').length,
  };
}

async function cleanBody(user, b, current) {
  const title = S.clip(b.title !== undefined ? b.title : (current && current.name), 80);
  if (title.length < 2) return { error: 'Give the form a title.', status: 400 };
  const keys = await cleanKeys(b.fields !== undefined ? b.fields : (current ? S.parse(current.fields, []) : ['name', 'phone', 'email']));
  if (!keys.includes('phone') && !keys.includes('email')) return { error: 'Pick Phone Number or Email Address (or both), so we can reach the person.', status: 400 };
  const members = new Set((await staff()).map((m) => m.id));
  const memberIds = [...new Set((Array.isArray(b.memberIds) ? b.memberIds : (current ? S.parse(current.memberIds, []) : [])).map(String).filter((i) => members.has(i)))].slice(0, 200);
  const channels = (Array.isArray(b.channels) ? b.channels : (current ? S.parse(current.channels, CH) : CH)).filter((c) => CH.includes(c));
  if (!channels.length) return { error: 'Pick at least one way people may agree to be contacted.', status: 400 };
  const consentText = S.clip(b.consentText !== undefined ? b.consentText : (current && current.consentText) || DEFAULT_CONSENT, 600) || DEFAULT_CONSENT;
  if (consentText.length < 20) return { error: 'The permission words are too short. Write what the person agrees to.', status: 400 };
  return { title, keys, memberIds, channels, consentText, description: S.clip(b.description !== undefined ? b.description : (current && current.description), 400), thanks: S.clip(b.thanks !== undefined ? b.thanks : (current && current.thanks), 300) || 'Thank you. We have your details.', status: b.status === 'off' ? 'off' : (b.status === 'on' ? 'on' : (current ? current.status : 'on')) };
}

async function create(user, b, dept) {
  if (!mayManage(user)) return { error: 'Only a Team Lead, a client manager or an Admin can make a form.', status: 403 };
  await ensure();
  const c = await cleanBody(user, b || {}, null);
  if (c.error) return c;
  if ((await S.q('SELECT 1 x FROM "OmniForm" WHERE deletedAt IS NULL AND LOWER(name) = ?', c.title.toLowerCase())).length) return { error: `There is already a form called "${c.title}".`, status: 409 };
  const id = S.newId('of'); const now = Date.now();
  await S.run('INSERT INTO "OmniForm" (id, token, name, department, industry, fields, channels, consentText, thanks, status, createdById, createdByName, createdAt, updatedAt, description, memberIds) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id, token(), c.title, dept || null, null, JSON.stringify(c.keys), JSON.stringify(c.channels), c.consentText, c.thanks, c.status, user.id, user.name, now, now, c.description || null, JSON.stringify(c.memberIds));
  await logAudit({ userId: user.id, actorName: user.name, action: 'Omni-Channel form created', entity: 'OmniForm', entityId: id, toValue: `${c.keys.length} fields` });
  return { form: view((await S.q('SELECT * FROM "OmniForm" WHERE id = ?', id))[0], { canEdit: true }) };
}
async function update(user, id, b) {
  await ensure();
  const r = (await S.q('SELECT * FROM "OmniForm" WHERE id = ? AND deletedAt IS NULL', id))[0];
  if (!r || !(await visibleRows(user)).some((x) => x.id === id)) return { error: 'This form was not found.', status: 404 };
  if (!mayEdit(user, r)) return { error: 'You can change only the forms you made.', status: 403 };
  const c = await cleanBody(user, b || {}, r);
  if (c.error) return c;
  if ((await S.q('SELECT 1 x FROM "OmniForm" WHERE deletedAt IS NULL AND id <> ? AND LOWER(name) = ?', id, c.title.toLowerCase())).length) return { error: `There is already a form called "${c.title}".`, status: 409 };
  await S.run('UPDATE "OmniForm" SET name = ?, fields = ?, channels = ?, consentText = ?, thanks = ?, status = ?, description = ?, memberIds = ?, updatedAt = ? WHERE id = ?',
    c.title, JSON.stringify(c.keys), JSON.stringify(c.channels), c.consentText, c.thanks, c.status, c.description || null, JSON.stringify(c.memberIds), Date.now(), id);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Omni-Channel form changed', entity: 'OmniForm', entityId: id, toValue: `${c.keys.length} fields · ${c.status}` });
  return { form: view((await S.q('SELECT * FROM "OmniForm" WHERE id = ?', id))[0], { canEdit: true }) };
}
async function remove(user, id) {
  await ensure();
  const r = (await S.q('SELECT * FROM "OmniForm" WHERE id = ? AND deletedAt IS NULL', id))[0];
  if (!r || !(await visibleRows(user)).some((x) => x.id === id)) return { error: 'This form was not found.', status: 404 };
  if (!mayEdit(user, r)) return { error: 'You can delete only the forms you made.', status: 403 };
  await S.run('UPDATE "OmniForm" SET deletedAt = ?, status = \'off\' WHERE id = ?', Date.now(), id); // the link stops working at once; the people it collected stay in Customers
  await logAudit({ userId: user.id, actorName: user.name, action: 'Omni-Channel form deleted', entity: 'OmniForm', entityId: id, toValue: r.name });
  return { ok: true };
}

// the latest sends of the forms this login may open: names only (never a phone or an email), so it is the same for masked logins
async function submissions(user, { formId, limit = 20 } = {}) {
  const forms = await visibleRows(user);
  const ids = formId ? forms.filter((f) => f.id === formId).map((f) => f.id) : forms.map((f) => f.id);
  if (!ids.length) return { rows: [] };
  const nameOfForm = new Map(forms.map((f) => [f.id, f.name]));
  const rows = await S.q(`SELECT s.id, s.formId, s.contactId, s.result, s.at, c.name cname, c.status cstatus FROM "OmniFormSubmission" s LEFT JOIN "OutreachContact" c ON c.id = s.contactId WHERE s.formId IN (${ids.map(() => '?').join(',')}) ORDER BY s.at DESC LIMIT ${Math.min(100, Math.max(1, Number(limit) || 20))}`, ...ids);
  const WORDS = { created: 'New', updated: 'Already known', kept: 'Already known' };
  return {
    rows: rows.map((r) => { const res = S.parse(r.result, {}); return { id: r.id, formId: r.formId, form: nameOfForm.get(r.formId) || 'Form', contactId: r.cstatus === 'active' ? r.contactId : null, person: r.cstatus === 'active' && r.cname ? r.cname : '(removed)', answer: res.answer || '', outcome: res.outcome || 'created', status: WORDS[res.outcome] || 'New', at: S.iso(r.at) }; }),
  };
}

// ---- THE PUBLIC SIDE -----------------------------------------------------------------------------------------------------------------
async function publicForm(tok) {
  await ensure();
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(String(tok || ''))) return null;
  const r = (await S.q('SELECT * FROM "OmniForm" WHERE token = ? AND deletedAt IS NULL AND status = \'on\'', tok))[0];
  return r || null;
}
async function publicShape(r) {
  const defs = await Pol.customFields();
  const fields = [];
  for (const key of S.parse(r.fields, [])) {
    if (key.startsWith('cf:')) {
      const f = defs.find((x) => x.id === key.slice(3));
      if (f) fields.push({ key, label: f.name, type: f.type, options: f.options || [], required: !!f.required, hint: f.description || '' });
    } else {
      const c = coreOf(key);
      if (c) fields.push({ key, label: c.label, type: c.type, options: c.options || [], required: key === 'name', hint: '' });
    }
  }
  return { title: r.name, description: r.description || '', thanks: r.thanks || 'Thank you. We have your details.', consentText: r.consentText, consentVersion: textVersion(r.consentText), fields, channels: S.parse(r.channels, CH).filter((c) => CH.includes(c)).map((id) => ({ id, label: CH_WORDS[id] })) };
}
const tidy = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);

// body: { answers: { key: value }, channels: [], consent: true }. -> { ok, message } or { error, status }. The honeypot is checked by the route.
async function publicSubmit(r, body) {
  const b = body && typeof body === 'object' ? body : {};
  if (b.consent !== true) return { error: 'Please tick the box to say we may contact you.', status: 400 };
  const shape = await publicShape(r);
  const defs = await Pol.customFields();
  const ans = b.answers && typeof b.answers === 'object' ? b.answers : {};
  const val = (k) => tidy(ans[k], k === 'notes' ? 1000 : 200);
  const asked = new Set(shape.fields.map((f) => f.key));
  // contact boxes
  const name = asked.has('name') ? val('name') : '';
  if (asked.has('name') && name.length < 2) return { error: 'Please type your name.', status: 400 };
  const phone = asked.has('phone') ? K.phoneOf(val('phone')) : { blank: true, ok: false };
  const email = asked.has('email') ? K.emailOf(val('email')) : { blank: true, ok: false };
  if (!phone.ok && !email.ok) return { error: asked.has('phone') && asked.has('email') ? 'Please give a phone number or an email address that works.' : (asked.has('phone') ? 'Please give a phone number that works.' : 'Please give an email address that works.'), status: 400 };
  if (!phone.blank && !phone.ok && asked.has('email') && !email.ok) return { error: 'That phone number does not look right.', status: 400 };
  // the custom fields on this form: type checks + "Required"
  const raw = {};
  shape.fields.filter((f) => f.key.startsWith('cf:')).forEach((f) => { raw[f.key.slice(3)] = ans[f.key]; });
  const cleaned = await Pol.cleanValues(raw, defs);
  if (cleaned.problems.length) return { error: cleaned.problems[0], status: 400 };
  const miss = Pol.missingRequired(cleaned.values, defs, shape.fields.filter((f) => f.key.startsWith('cf:')).map((f) => f.key.slice(3)));
  if (miss.length) return { error: miss[0], status: 400 };
  const pref = asked.has('preferredChannel') && val('preferredChannel') ? K.prefOf(val('preferredChannel')) : '';
  if (pref === null) return { error: 'Please pick a way to be contacted from the list.', status: 400 };
  // which ways they agreed to: only ways this form offers and the person gave an address for
  const offered = shape.channels.map((c) => c.id);
  const reachable = [...(email.ok ? ['email'] : []), ...(phone.ok ? ['whatsapp', 'sms'] : [])];
  const chosen = [...new Set((Array.isArray(b.channels) ? b.channels : []).map(String))].filter((c) => offered.includes(c) && reachable.includes(c));
  if (!chosen.length) return { error: 'Please choose at least one way we may contact you.', status: 400 };

  const owner = { id: r.createdById || null, name: r.createdByName || 'Web form' };
  const evidence = `Form: ${r.name}; consent text ${textVersion(r.consentText)}`;
  const answerText = shape.fields.filter((f) => f.key.startsWith('cf:') && cleaned.values[f.key.slice(3)] !== undefined).map((f) => { const v = cleaned.values[f.key.slice(3)]; const def = defs.find((x) => x.id === f.key.slice(3)); return def && ['email', 'phone'].includes(def.type) ? null : (Array.isArray(v) ? v.join(', ') : v); }).filter(Boolean).join(' · ').slice(0, 160);
  let contactId; let outcome;
  const hit = await K.findByKeys(phone.ok ? phone.key : null, email.ok ? email.key : null);
  if (hit.length) {
    // somebody we know: fill only EMPTY boxes, never replace; never touch a staff contact
    const c0 = hit[0];
    contactId = c0.id; outcome = 'kept';
    if (c0.contactType === 'candidate_lead') {
      outcome = 'updated';
      const sets = []; const params = [];
      const fill = (col, v, n) => { if (v && !c0[col]) { sets.push(`${col} = ?`); params.push(S.clip(v, n)); } };
      fill('name', name, 120); fill('company', val('company'), 120); fill('city', val('city'), 80); fill('skills', val('skills'), 200); fill('language', val('language'), 40); fill('notes', val('notes'), 1000);
      if (pref && !c0.preferredChannel) { sets.push('preferredChannel = ?'); params.push(pref); }
      const cur = K.parseCv(c0.customValues); const next = { ...cleaned.values, ...cur }; // what they already have wins
      if (JSON.stringify(next) !== JSON.stringify(cur) && Object.keys(next).length) { sets.push('customValues = ?'); params.push(JSON.stringify(next)); }
      const addCh = [];
      if (phone.ok && !c0.phoneE164 && !(await K.findByKeys(phone.key, null)).some((x) => x.id !== c0.id)) { sets.push('phoneE164 = ?', 'phoneKey = ?'); params.push(phone.e164, phone.key); addCh.push('whatsapp', 'sms'); }
      if (email.ok && !c0.email && !(await K.findByKeys(null, email.key)).some((x) => x.id !== c0.id)) { sets.push('email = ?', 'emailKey = ?'); params.push(email.addr, email.key); addCh.push('email'); }
      if (sets.length) { try { await S.run(`UPDATE "OutreachContact" SET ${sets.join(', ')}, updatedAt = ? WHERE id = ?`, ...params, Date.now(), c0.id); } catch { addCh.length = 0; } }
      if (addCh.length) { const fresh = await K.getRow(c0.id); for (const ch of addCh) await K.addChannelRow(c0.id, fresh, ch, { declared: false }, null); } // eslint-disable-line no-await-in-loop
      await C.optInFromForm(c0.id, chosen, { evidence, textVersion: textVersion(r.consentText) });
    }
  } else {
    let row;
    try {
      row = await K.insert(owner, { type: 'candidate_lead', name, phone: phone.ok ? phone : null, email: email.ok ? email : null, company: val('company'), city: val('city'), skills: val('skills'), source: `Form: ${r.name}`.slice(0, 140), department: r.department || null, industries: [], language: val('language'), preferredChannel: pref, notes: val('notes'), customValues: cleaned.values }, { declared: false });
    } catch (e) {
      if (!/UNIQUE/i.test(String(e.message))) throw e;
      row = (await K.findByKeys(phone.ok ? phone.key : null, email.ok ? email.key : null))[0]; // two people sent at the same moment
    }
    contactId = row && row.id; outcome = 'created';
    if (contactId) await C.optInFromForm(contactId, chosen, { evidence, textVersion: textVersion(r.consentText) });
  }
  await S.run('INSERT INTO "OmniFormSubmission" (id, formId, contactId, result, at) VALUES (?,?,?,?,?)', S.newId('ofs'), r.id, contactId || null, JSON.stringify({ outcome, answer: answerText }), Date.now());
  return { ok: true, message: r.thanks || 'Thank you. We have your details.' };
}

module.exports = { ensure, catalog, list, create, update, remove, submissions, publicForm, publicShape, publicSubmit, staff, view, textVersion, DEFAULT_CONSENT, CORE, CH };
