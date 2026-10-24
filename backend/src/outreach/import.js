// ---------------------------------------------------------------------------
// IMPORT (CSV / Excel): column mapping, checks, duplicate detection, preview, save, undo, history.
//   check()  reads + classifies the file and returns counts and rows. NOTHING is saved.
//   save()   needs the tick "I have permission to message these people" (stored with who / when / the words), then applies:
//            new people are created; people already there are skipped (default), updated (file wins for name / company / city ...)
//            or merged (file only fills blanks). An existing opt-out is NEVER changed by an import (no mode can override it).
//   undo()   takes a whole batch back (new people removed, changed people restored). Opt-outs made since stay in the do-not-contact list.
// The legacy WhatsApp / SMS STOP lists (msg.optout.*, bc.dnc.*) are honoured: those numbers land opted out.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const L = require('../broadcast/lists');
const core = require('../utils/messagingCore');
const delivery = require('../utils/messageDelivery');
const S = require('./store');
const A = require('./access');
const C = require('./consent');
const K = require('./contacts');
const Pol = require('./policy');
const { logAudit } = require('../utils/audit');

const MAX_ROWS = 5000;
const UNDO_MS = 7 * 86400000;
const CONSENT_TEXT_VERSION = 'import-tick-v1';
const FIELDS = ['name', 'phone', 'email', 'company', 'city', 'skills', 'experience', 'industry', 'tags', 'consent', 'language', 'preferredChannel', 'notes', 'platformId'];
const FIELD_WORDS = { name: 'Name', phone: 'Phone / WhatsApp', email: 'Email', company: 'Company', city: 'City', skills: 'Skills', experience: 'Experience', industry: 'Kind (Medical, Education ...)', tags: 'Tags (separated by commas)', consent: 'Permission (yes/no)', language: 'Language', preferredChannel: 'Preferred channel (WhatsApp, Email, SMS, Call)', notes: 'Notes', platformId: 'Platform ID' };
const MAX_TAGS = 10;
const ALIASES = {
  name: ['name', 'full name', 'fullname', 'contact name', 'candidate name', 'person', 'first name', 'firstname', 'employee name', 'naam'],
  phone: ['phone', 'mobile', 'mobile number', 'mobile no', 'whatsapp', 'whatsapp number', 'whatsapp no', 'phone number', 'phone no', 'contact number', 'contact no', 'cell', 'cell phone', 'mob', 'number', 'ph no', 'tel', 'telephone', 'mobile phone'],
  email: ['email', 'e-mail', 'email id', 'email address', 'mail', 'mail id', 'emailid'],
  company: ['company', 'organisation', 'organization', 'org', 'employer', 'current company', 'company name', 'hospital', 'firm', 'institution', 'college', 'school'],
  city: ['city', 'location', 'place', 'town', 'current location', 'district'],
  skills: ['skills', 'skill', 'key skills', 'keyskills', 'skill set', 'specialisation', 'specialization', 'designation', 'role'],
  experience: ['experience', 'exp', 'years', 'total experience', 'yrs', 'experience years'],
  industry: ['industry', 'industries', 'kind', 'sector', 'segment', 'category', 'group', 'tag', 'department'],
  tags: ['tags', 'labels', 'label', 'keywords', 'tag list'],
  consent: ['consent', 'permission', 'opted in', 'optin', 'opt in', 'allowed', 'whatsapp consent', 'email consent'],
  language: ['language', 'languages', 'lang', 'preferred language', 'mother tongue'],
  preferredChannel: ['preferred channel', 'preferred contact', 'contact preference', 'preferred mode', 'contact mode', 'channel'],
  notes: ['notes', 'note', 'remarks', 'remark', 'comments', 'comment'],
  platformId: ['platform id', 'lead id', 'fb lead id', 'source id', 'external id', 'reference id', 'ref id', 'ref no'],
};
// the custom fields of the CRM Fields page that may be filled from a file (mapping key "cf:<field id>")
async function importFields() { try { return (await Pol.customFields()).filter((f) => f.inImport !== false); } catch { return []; } }
const cfKey = (f) => `cf:${f.id}`;
function wordsFor(customs) { const w = { ...FIELD_WORDS }; (customs || []).forEach((f) => { w[cfKey(f)] = `${f.name} (your own field)`; }); return w; }
const norm = (h) => String(h == null ? '' : h).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const NO = /^(no|n|false|0|not allowed|declined|withdrawn|opted out|optout|dnc|unsubscribed)$/i;

function autoMap(headers, customs) {
  const map = {}; const used = new Set();
  const aliasOf = (f) => ALIASES[f];
  const all = [...FIELDS.map((f) => [f, aliasOf(f)]), ...(customs || []).map((c) => [cfKey(c), [norm(c.name), norm(c.key).trim()].filter(Boolean)])];
  all.forEach(([f, al]) => {
    let idx = headers.findIndex((h, i) => !used.has(i) && al.includes(norm(h)));
    if (idx < 0 && !f.startsWith('cf:')) idx = headers.findIndex((h, i) => !used.has(i) && al.some((a) => a.length > 3 && norm(h).includes(a)));
    if (idx >= 0) { map[f] = idx; used.add(idx); }
  });
  return map;
}

// the legacy STOP lists, once per call: { whatsapp:Set(e164), sms:Set(e164) }
async function legacyStops() {
  const out = { whatsapp: new Set(), sms: new Set() };
  const rows = await prisma.appSetting.findMany({ where: { OR: [{ key: { startsWith: delivery.OPTOUT_PREFIX } }, { key: { startsWith: 'bc.dnc.' } }] }, select: { key: true } });
  rows.forEach((r) => {
    if (r.key.startsWith('bc.dnc.')) out.whatsapp.add(r.key.slice(7));
    else if (r.key.startsWith(`${delivery.OPTOUT_PREFIX}WhatsApp.`)) out.whatsapp.add(r.key.slice(`${delivery.OPTOUT_PREFIX}WhatsApp.`.length));
    else if (r.key.startsWith(`${delivery.OPTOUT_PREFIX}SMS.`)) out.sms.add(r.key.slice(`${delivery.OPTOUT_PREFIX}SMS.`.length));
  });
  return out;
}

const STATUS_WORDS = {
  new: 'Will be added', duplicate: 'Already in your contacts', conflict: 'Needs a person to choose', dup_in_file: 'Repeated in the file', invalid: 'No usable phone or email',
  opted_out_file: 'Added, but marked opted out', suppressed: 'Added, but was opted out before',
};

// rows: from L.readFile; map: field -> column index. -> { items, totals }
// the tags of one cell: split on , ; | (a "/" is part of a tag), cleaned, no repeats (any capital letters), the first MAX_TAGS
const tagsOf = (raw) => {
  const seen = new Set(); const out = [];
  String(raw || '').split(/[;,|]/).map((x) => x.replace(/\s+/g, ' ').trim().slice(0, 40)).filter(Boolean).forEach((x) => { if (!seen.has(x.toLowerCase())) { seen.add(x.toLowerCase()); out.push(x); } });
  return out.slice(0, MAX_TAGS);
};

// resolutions: { [line]: contactId }  the person's choice for a conflict row (the phone and the email belong to two different people)
async function classify(user, rows, map, { type, dupMode, industriesAll, resolutions, customs }) {
  const inds = await S.industries();
  const defs = customs || await importFields();
  const stops = await legacyStops();
  const get = (r, f) => (map[f] === undefined || map[f] === null || map[f] === '' ? '' : String(r.cells[map[f]] || '').trim());
  const seenPhone = new Set(); const seenEmail = new Set();
  const pick = resolutions && typeof resolutions === 'object' ? resolutions : {};
  const totals = { total: rows.length, new: 0, duplicate: 0, conflict: 0, dup_in_file: 0, invalid: 0, opted_out: 0, unknownIndustry: 0, unknownTags: 0 };
  const unknown = new Set(); const unknownTagSet = new Set();
  const items = [];
  for (const r of rows) {
    const phone = K.phoneOf(get(r, 'phone')); const email = K.emailOf(get(r, 'email'));
    const it = {
      i: r.line, name: get(r, 'name').slice(0, 120), company: get(r, 'company').slice(0, 120), city: get(r, 'city').slice(0, 80), skills: get(r, 'skills').slice(0, 200), experience: get(r, 'experience').slice(0, 30),
      phone: phone.ok ? phone : null, email: email.ok ? email : null, rawPhone: get(r, 'phone').slice(0, 40), rawEmail: get(r, 'email').slice(0, 160),
      status: 'new', why: '', notes: [], industries: [], existingId: null, rowSaysNo: false,
      language: get(r, 'language').slice(0, 40), about: get(r, 'notes').slice(0, 1000), preferredChannel: '', custom: {},
    };
    const prefRaw = get(r, 'preferredChannel');
    if (prefRaw) { const pc = K.prefOf(prefRaw); if (pc) it.preferredChannel = pc; else it.notes.push(`Preferred channel "${prefRaw.slice(0, 30)}" was not understood (left empty)`); }
    const rawCustom = {};
    defs.forEach((f) => { const v = get(r, cfKey(f)); if (v !== '') rawCustom[f.id] = v; });
    if (Object.keys(rawCustom).length) { const cv = await Pol.cleanValues(rawCustom, defs); it.custom = cv.values; cv.problems.slice(0, 3).forEach((p) => it.notes.push(`${p} (left empty)`)); } // eslint-disable-line no-await-in-loop
    const pid = get(r, 'platformId').slice(0, 80);
    if (pid) it.custom._platformId = pid;
    // industries: the picked ones for the whole file + whatever the row says (only listed kinds count)
    const tags = new Set(industriesAll);
    get(r, 'industry').split(/[;,/|]/).map((x) => x.trim()).filter(Boolean).forEach((x) => {
      const c = inds.find((i) => i.name.toLowerCase() === x.toLowerCase());
      if (c) tags.add(c.name); else { unknown.add(x.slice(0, 40)); it.notes.push(`"${x.slice(0, 40)}" is not in the kinds list (ignored)`); }
    });
    // the Tags column: each tag that is a listed kind is added to the person; any other word is reported (never silently dropped)
    tagsOf(get(r, 'tags')).forEach((x) => {
      const c = inds.find((i) => i.name.toLowerCase() === x.toLowerCase());
      if (c) tags.add(c.name); else { unknownTagSet.add(x); it.notes.push(`Tag "${x}" is not in the kinds list, so it was not added`); }
    });
    it.industries = [...tags];
    const cs = get(r, 'consent'); it.rowSaysNo = !!(cs && NO.test(cs));
    if (!phone.ok && phone.blank === false && email.ok) it.notes.push(`Phone ignored: ${phone.reason}`);
    if (!email.ok && email.blank === false && phone.ok) it.notes.push(`Email ignored: ${email.reason}`);
    if (!phone.ok && !email.ok) {
      it.status = 'invalid'; it.why = phone.blank === false ? phone.reason : (email.blank === false ? email.reason : 'There is no phone number or email in this row.');
    } else if ((phone.ok && seenPhone.has(phone.key)) || (email.ok && seenEmail.has(email.key))) {
      it.status = 'dup_in_file'; it.why = 'This phone or email is already in an earlier row of the file.';
    } else {
      if (phone.ok) seenPhone.add(phone.key);
      if (email.ok) seenEmail.add(email.key);
      const hit = await K.findByKeys(phone.ok ? phone.key : null, email.ok ? email.key : null); // eslint-disable-line no-await-in-loop
      if (hit.length) {
        // ONE RULE for "the phone is one person and the email is another" (or several old duplicates): nothing is touched and the row waits for a
        // person to choose (the "resolutions" of the screen). A row whose choice is given goes on as an ordinary "already here" row.
        const chosen = hit.length > 1 && pick[it.i] ? hit.find((h) => h.id === pick[it.i]) : null;
        const one = hit.length === 1 ? hit[0] : chosen;
        const mayOf = (h) => !!h && h.contactType === type && (A.isAdmin(user) || h.ownerUserId === user.id || h.createdById === user.id);
        if (hit.length > 1 && !chosen) {
          it.status = 'conflict'; it.existingId = null; it.conflict = true;
          it.matches = hit.filter((h) => mayOf(h) || A.isAdmin(user)).map((h) => ({ id: h.id, name: h.name || '(no name)', hint: [h.phoneE164 ? core.maskMobile(h.phoneE164) : '', h.email ? core.maskEmail(h.email) : ''].filter(Boolean).join(' · ') }));
          it.why = 'The phone and the email belong to two different people already. Nothing was changed. Choose which person this row is, or leave it.';
          if (it.matches.length < hit.length) it.why = 'The phone and the email belong to two different people already, and at least one is not yours. Nothing was changed.';
        } else {
          it.status = 'duplicate'; it.existingId = one.id; it.conflict = false; it.resolvedChoice = !!chosen;
          it.why = chosen ? 'You chose this person for a row that matched two people.' : 'This person is already in your contacts.';
          it.mayChange = mayOf(one);
          if (!it.mayChange && dupMode !== 'skip') it.why += ' (not yours to change, skipped)';
        }
      } else {
        // the do-not-contact list: lands opted out
        let sup = false;
        if (phone.ok) sup = sup || await C.isSuppressedHash(S.hashAddress('phone', phone.e164), '*') || await C.isSuppressedHash(S.hashAddress('phone', phone.e164), 'whatsapp') || stops.whatsapp.has(phone.e164); // eslint-disable-line no-await-in-loop
        if (email.ok) sup = sup || await C.isSuppressedHash(S.hashAddress('email', email.addr), '*') || await C.isSuppressedHash(S.hashAddress('email', email.addr), 'email'); // eslint-disable-line no-await-in-loop
        if (sup) { it.status = 'suppressed'; it.why = 'This address was opted out before. It stays opted out.'; } else if (it.rowSaysNo) { it.status = 'opted_out_file'; it.why = 'The file says this person did not give permission.'; }
      }
    }
    if (['new', 'opted_out_file', 'suppressed'].includes(it.status)) totals.new += 1;
    if (['opted_out_file', 'suppressed'].includes(it.status)) totals.opted_out += 1;
    if (it.status === 'duplicate') totals.duplicate += 1;
    if (it.status === 'conflict') totals.conflict += 1;
    if (it.status === 'dup_in_file') totals.dup_in_file += 1;
    if (it.status === 'invalid') totals.invalid += 1;
    items.push(it);
  }
  totals.unknownIndustry = unknown.size; totals.unknownTags = unknownTagSet.size;
  return { items, totals, unknownIndustries: [...unknown].slice(0, 20), stops };
}

function viewItem(it, user) {
  const m = A.masked(user);
  return {
    i: it.i, name: it.name, phone: it.phone ? (m ? core.maskMobile(it.phone.e164) : `+${it.phone.e164}`) : it.rawPhone, email: it.email ? (m ? core.maskEmail(it.email.addr) : it.email.addr) : it.rawEmail,
    company: it.company, city: it.city, industries: it.industries, status: it.status, statusWords: STATUS_WORDS[it.status], why: it.why, notes: it.notes,
    ...(it.matches ? { matches: it.matches } : {}),
  };
}

function parsedFile(buf, mapping, customs) {
  const file = L.readFile(buf);
  if (file.error) return { error: file.error, status: 400 };
  if (file.rows.length > MAX_ROWS) return { error: `The file has ${file.rows.length} rows. The most for one import is ${MAX_ROWS}. Split it into two files.`, status: 400, code: 'TOO_MANY_ROWS' };
  const auto = autoMap(file.headers, customs);
  const map = mapping && typeof mapping === 'object' && Object.keys(mapping).length ? mapping : auto;
  return { file, map, auto };
}
async function cleanIndustries(list) {
  const inds = await S.industries();
  return (Array.isArray(list) ? list : []).map((x) => inds.find((i) => i.name.toLowerCase() === String(x).toLowerCase())).filter(Boolean).map((i) => i.name);
}
function typeOf(b) { return b.contactType === 'internal' ? 'internal' : 'candidate_lead'; }
// "If a person is already here": skip | merge ("fill empty boxes only", alias fill) | overwrite ("update from the file", needs the confirm tick) | update (the old API word for overwrite)
function modeOf(o) {
  const m = String(o.dupMode || '');
  if (m === 'overwrite') return { dupMode: 'update', overwrite: true };
  if (m === 'fill') return { dupMode: 'merge', overwrite: false };
  return { dupMode: ['skip', 'update', 'merge'].includes(m) ? m : 'skip', overwrite: false };
}
const truthy = (v) => v === true || v === '1' || v === 'true' || v === 1;
// the choices for conflict rows: { "<row>": "<contactId>" } (at most 300)
function resolutionsOf(o) {
  const r = o.resolutions && typeof o.resolutions === 'object' ? o.resolutions : {};
  const out = {};
  Object.entries(r).slice(0, 300).forEach(([k, v]) => { if (/^\d{1,6}$/.test(k) && typeof v === 'string' && v.length < 80) out[k] = v; });
  return out;
}
// what a person sees for "rows that need a look": everything that is not a clean new row, and clean rows that still carry a note (an unknown tag ...)
const needsLook = (x) => x.status !== 'new' || x.notes.length > 0;

// ---- CHECK (nothing saved) ---------------------------------------------------------
async function check(user, buf, o) {
  const type = typeOf(o);
  if (!A.mayWrite(user, type)) return { error: type === 'internal' ? 'Only the HR desk and Admins bring in internal contacts.' : 'Importing is done by a team lead, client manager or Admin.', status: 403 };
  const customs = await importFields();
  const p = parsedFile(buf, o.mapping, customs);
  if (p.error) return p;
  const needContact = p.map.phone === undefined && p.map.email === undefined;
  if (needContact) return { needsMapping: true, headers: p.file.headers, mapping: p.map, fields: wordsFor(customs), rowCount: p.file.rows.length, message: 'We could not find a phone or email column. Choose it below.' };
  const { dupMode, overwrite } = modeOf(o);
  const industriesAll = await cleanIndustries(o.industries);
  const out = await classify(user, p.file.rows, p.map, { type, dupMode, industriesAll, resolutions: resolutionsOf(o), customs });
  const problems = out.items.filter(needsLook);
  return {
    headers: p.file.headers, mapping: p.map, fields: wordsFor(customs), rowCount: p.file.rows.length, totals: out.totals, dupMode: overwrite ? 'overwrite' : dupMode, needsConfirm: overwrite, contactType: type, unknownIndustries: out.unknownIndustries,
    preview: out.items.slice(0, 30).map((x) => viewItem(x, user)), problems: problems.slice(0, 5000).map((x) => viewItem(x, user)), problemCount: problems.length, statusWords: STATUS_WORDS,
  };
}

// ---- SAVE -------------------------------------------------------------------------------
async function save(user, buf, o) {
  const type = typeOf(o);
  if (!A.mayWrite(user, type)) return { error: 'You cannot import this kind of contact.', status: 403 };
  // THE TICK: no import without it, and it is kept (who, when, the words)
  if (!(o.permission === true || o.permission === '1' || o.permission === 'true')) return { error: 'Tick "I have permission to message these people" first. Without it nothing is saved.', status: 400, code: 'NO_PERMISSION_TICK' };
  const basis = S.clip(o.basis, 400);
  if (basis.length < 5) return { error: 'Write in a few words where these contacts come from (for example: "Our own past candidates who gave their number").', status: 400, code: 'NO_BASIS' };
  await require('./v3schema').ensure(); // eslint-disable-line global-require
  const customs = await importFields();
  const p = parsedFile(buf, o.mapping, customs);
  if (p.error) return p;
  if (p.map.phone === undefined && p.map.email === undefined) return { error: 'Choose the phone or email column first.', status: 400 };
  const { dupMode, overwrite } = modeOf(o);
  // "Update them from the file" replaces what is in the boxes, so it needs a second, clear yes
  if (overwrite && !truthy(o.confirmOverwrite)) return { error: 'To replace what is already saved with what is in the file, tick "Yes, replace their details". Or choose "Fill their empty boxes only".', status: 400, code: 'CONFIRM_OVERWRITE' };
  const industriesAll = await cleanIndustries(o.industries);
  const out = await classify(user, p.file.rows, p.map, { type, dupMode, industriesAll, resolutions: resolutionsOf(o), customs });
  if (!out.totals.new && !(out.totals.duplicate && dupMode !== 'skip')) return { error: 'None of the rows can be added, so nothing was saved. Check the file and try again.', status: 400, totals: out.totals };

  const batchId = S.newId('oi');
  const now = Date.now();
  const fileName = S.clip(o.fileName, 120);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const source = S.clip(o.source, 140) || fileName || 'Import';
  await S.run(`INSERT INTO "OutreachImport" (id, fileName, sha256, mapping, contactType, dupMode, basis, basisConfirmedById, basisConfirmedAt, source, industries, createdById, createdByName, createdAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, batchId, fileName || null, sha, JSON.stringify(p.map), type, overwrite ? 'overwrite' : dupMode, basis, user.id, now, source, JSON.stringify(industriesAll), user.id, user.name, now);
  const undo = { created: [], updated: [] };
  const counts = { created: 0, updated: 0, duplicates: 0, invalid: 0, optedOut: 0, skipped: 0, conflicts: 0 };
  const results = []; // one line per row: { line, name, result: created|updated|skipped|conflict|failed, why }  (no phone, no email)
  const note = (it, result, why, flag = false) => results.push({ line: it.i, name: it.name || '', result, why: [why, ...it.notes].filter(Boolean).join('. ').slice(0, 300), look: flag || it.notes.length > 0 || !['created', 'updated'].includes(result) });
  const inds = await S.industries();
  const dept = (industriesAll[0] && (inds.find((i) => i.name === industriesAll[0]) || {}).department) || null;
  for (const it of out.items) {
    if (it.status === 'invalid') { counts.invalid += 1; note(it, 'failed', `No usable phone or email: ${it.why}`); continue; } // eslint-disable-line no-continue
    if (it.status === 'dup_in_file') { counts.duplicates += 1; note(it, 'skipped', 'This phone or email is already in an earlier row of the file'); continue; } // eslint-disable-line no-continue
    if (it.status === 'conflict') { counts.conflicts += 1; note(it, 'conflict', it.why); continue; } // eslint-disable-line no-continue
    const evidence = `${fileName || 'import'} row ${it.i}; ${basis}`;
    const consent = { declared: true, rowSaysNo: it.rowSaysNo, source: 'import_declared', evidence, textVersion: CONSENT_TEXT_VERSION, legacyStops: out.stops };
    if (it.status === 'duplicate') {
      counts.duplicates += 1;
      if (dupMode === 'skip') { counts.skipped += 1; note(it, 'skipped', 'Already in your contacts (you chose to skip people already here)'); continue; } // eslint-disable-line no-continue
      if (!it.mayChange) { counts.skipped += 1; note(it, 'skipped', 'Already in your contacts, and not yours to change'); continue; } // eslint-disable-line no-continue
      const before = await K.getRow(it.existingId); // eslint-disable-line no-await-in-loop
      const beforeTags = (await S.q('SELECT industry FROM "OutreachContactTag" WHERE contactId = ?', it.existingId)).map((t) => t.industry); // eslint-disable-line no-await-in-loop
      const rec = { id: it.existingId, before: { name: before.name, company: before.company, city: before.city, skills: before.skills, experience: before.experience, phoneE164: before.phoneE164, phoneKey: before.phoneKey, email: before.email, emailKey: before.emailKey, language: before.language || null, preferredChannel: before.preferredChannel || null, notes: before.notes || null, customValues: before.customValues || null }, addedTags: [], addedChannels: [] };
      const pick = (cur, next) => (dupMode === 'update' ? (next || cur) : (cur || next));
      // an address is only ever ADDED to an empty box, and never one that belongs to somebody else
      let nextPhone = before.phoneE164 ? null : it.phone; let nextEmail = before.email ? null : it.email;
      const withheld = [];
      if (nextPhone) { const o2 = await K.findByKeys(nextPhone.key, null); if (o2.some((x) => x.id !== it.existingId)) { nextPhone = null; withheld.push('the phone belongs to another person'); } } // eslint-disable-line no-await-in-loop
      if (nextEmail) { const o2 = await K.findByKeys(null, nextEmail.key); if (o2.some((x) => x.id !== it.existingId)) { nextEmail = null; withheld.push('the email belongs to another person'); } } // eslint-disable-line no-await-in-loop
      const next = { name: pick(before.name, it.name) || null, company: pick(before.company, it.company) || null, city: pick(before.city, it.city) || null, skills: pick(before.skills, it.skills) || null, experience: pick(before.experience, it.experience) || null };
      const curCv = K.parseCv(before.customValues);
      const nextCv = dupMode === 'update' ? { ...curCv, ...it.custom } : { ...it.custom, ...curCv };
      Object.assign(next, { language: pick(before.language, it.language) || null, preferredChannel: pick(before.preferredChannel, it.preferredChannel) || null, notes: pick(before.notes, it.about) || null, customValues: Object.keys(nextCv).length ? JSON.stringify(nextCv) : null });
      const changedBoxes = ['name', 'company', 'city', 'skills', 'experience', 'language', 'preferredChannel', 'notes', 'customValues'].filter((k) => (next[k] || null) !== (before[k] || null));
      try {
        await S.run('UPDATE "OutreachContact" SET name = ?, company = ?, city = ?, skills = ?, experience = ?, phoneE164 = COALESCE(?, phoneE164), phoneKey = COALESCE(?, phoneKey), email = COALESCE(?, email), emailKey = COALESCE(?, emailKey), updatedAt = ? WHERE id = ?', // eslint-disable-line no-await-in-loop
          next.name, next.company, next.city, next.skills, next.experience,
          nextPhone ? nextPhone.e164 : null, nextPhone ? nextPhone.key : null, nextEmail ? nextEmail.addr : null, nextEmail ? nextEmail.key : null, Date.now(), it.existingId);
        await S.run('UPDATE "OutreachContact" SET language = ?, preferredChannel = ?, notes = ?, customValues = ? WHERE id = ?', next.language, next.preferredChannel, next.notes, next.customValues, it.existingId); // eslint-disable-line no-await-in-loop
      } catch (e) { counts.skipped += 1; note(it, 'skipped', 'Could not be updated (a phone or email in the row belongs to someone else)'); continue; } // eslint-disable-line no-continue
      for (const t of it.industries) if (!beforeTags.includes(t)) { await S.run('INSERT OR IGNORE INTO "OutreachContactTag" (contactId, industry) VALUES (?,?)', it.existingId, t); rec.addedTags.push(t); } // eslint-disable-line no-await-in-loop
      // a newly filled address gets its channel rows (opt-outs are never touched: an existing channel row is left exactly as it is)
      const fresh = await K.getRow(it.existingId); // eslint-disable-line no-await-in-loop
      const chans = [];
      if (nextEmail) chans.push('email');
      if (nextPhone) chans.push('whatsapp', 'sms');
      for (const ch of chans) { const made = await K.addChannelRow(it.existingId, fresh, ch, consent, user); if (made) rec.addedChannels.push(made.id); } // eslint-disable-line no-await-in-loop
      undo.updated.push(rec); counts.updated += 1;
      const did = [...changedBoxes, ...(nextPhone ? ['phone'] : []), ...(nextEmail ? ['email'] : [])];
      note(it, 'updated', `${did.length ? `Filled or changed: ${did.join(', ')}` : 'Nothing needed changing'}${rec.addedTags.length ? `. Tags added: ${rec.addedTags.join(', ')}` : ''}${withheld.length ? `. Not added: ${withheld.join('; ')}` : ''}`, withheld.length > 0);
      continue; // eslint-disable-line no-continue
    }
    try {
      const row = await K.insert(user, { type, name: it.name, phone: it.phone, email: it.email, company: it.company, city: it.city, skills: it.skills, experience: it.experience, source, importId: batchId, industries: it.industries, department: dept, language: it.language, preferredChannel: it.preferredChannel, notes: it.about, customValues: it.custom }, consent); // eslint-disable-line no-await-in-loop
      undo.created.push(row.id); counts.created += 1;
      if (['opted_out_file', 'suppressed'].includes(it.status)) { counts.optedOut += 1; note(it, 'created', `Added, but marked opted out (${it.why})`); } else note(it, 'created', it.industries.length ? `Added. Tags: ${it.industries.join(', ')}` : 'Added');
    } catch (e) {
      if (/UNIQUE/i.test(String(e.message))) { counts.duplicates += 1; counts.skipped += 1; note(it, 'skipped', 'Someone else added this phone or email a moment ago'); } else throw e;
    }
  }
  await S.run('UPDATE "OutreachImport" SET total = ?, created = ?, updated = ?, duplicates = ?, invalid = ?, optedOut = ?, undoLog = ? WHERE id = ?',
    out.totals.total, counts.created, counts.updated, counts.duplicates, counts.invalid, counts.optedOut, JSON.stringify(undo), batchId);
  // the per-row results are kept (when the quick-wins table exists) so the "rows with problems" file can be downloaded later
  const saved = await saveRows(batchId, results);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Outreach contacts imported', entity: 'OutreachImport', entityId: batchId, reason: basis, toValue: `${type} · ${out.totals.total} rows · ${counts.created} added · ${counts.updated} changed · ${counts.duplicates} repeated · ${counts.conflicts} to choose · ${counts.invalid} unusable · ${counts.optedOut} opted out` });
  const problems = results.filter((r) => r.look);
  return { ok: `Saved: ${counts.created} added${counts.updated ? `, ${counts.updated} changed` : ''}${counts.conflicts ? `, ${counts.conflicts} waiting for you to choose` : ''}. Nothing was sent.`, importId: batchId, counts, totals: out.totals, rowsSaved: saved, problemCount: problems.length, problems: problems.slice(0, 5000) };
}

// ---- per-row results (OutreachImportRow) --------------------------------------------------------------------
async function saveRows(importId, results) {
  if (!(await S.quickReady())) return false;
  const rows = results.slice(0, MAX_ROWS);
  for (let i = 0; i < rows.length; i += 200) {
    const part = rows.slice(i, i + 200);
    await S.run(`INSERT OR REPLACE INTO "OutreachImportRow" (importId, line, name, result, why, look) VALUES ${part.map(() => '(?,?,?,?,?,?)').join(',')}`, ...part.flatMap((r) => [importId, r.line, S.clip(r.name, 120) || null, r.result, S.clip(r.why, 300) || null, r.look ? 1 : 0])); // eslint-disable-line no-await-in-loop
  }
  return true;
}
const RESULT_WORDS = { created: 'Added', updated: 'Changed', skipped: 'Skipped', conflict: 'Needs a person to choose', failed: 'Not usable' };
const safeCell = (v) => require('./messageLog').safeCell(v); // eslint-disable-line global-require
// the file of rows that need a look (or every row): the same import the login may see; no phone, no email in it
async function rowsCsv(user, id, { only = 'problems' } = {}) {
  const r = (await S.q('SELECT * FROM "OutreachImport" WHERE id = ?', id))[0];
  if (!r) return { error: 'This import was not found.', status: 404 };
  const seeAll = A.isAdmin(user) || A.kind(user) === 'view' || r.contactType === 'internal';
  if (!A.mayRead(user, r.contactType) || !(seeAll || r.createdById === user.id)) return { error: 'This import was not found.', status: 404 };
  if (!(await S.quickReady())) return { error: 'The per-row list is being set up. Please try again in a little while.', status: 503, setup: true };
  const rows = await S.q(`SELECT line, name, result, why FROM "OutreachImportRow" WHERE importId = ?${only === 'problems' ? ' AND look = 1' : ''} ORDER BY line`, id);
  const lines = [['Row', 'Name', 'Result', 'Why'].map(safeCell).join(',')];
  rows.forEach((x) => lines.push([x.line, x.name, RESULT_WORDS[x.result] || x.result, x.why].map(safeCell).join(',')));
  return { csv: `﻿${lines.join('\r\n')}\r\n`, count: rows.length, fileName: r.fileName || 'import' };
}

// ---- history + undo ------------------------------------------------------------------------
const importView = (r) => ({
  id: r.id, fileName: r.fileName || '', source: r.source || '', contactType: r.contactType, dupMode: r.dupMode, total: S.num(r.total), created: S.num(r.created), updated: S.num(r.updated), duplicates: S.num(r.duplicates),
  invalid: S.num(r.invalid), optedOut: S.num(r.optedOut), basis: r.basis || '', confirmedAt: S.iso(r.basisConfirmedAt), createdByName: r.createdByName || '', createdById: r.createdById, createdAt: S.iso(r.createdAt),
  undoneAt: S.iso(r.undoneAt), canUndo: !r.undoneAt && Date.now() - S.ms(r.createdAt) < UNDO_MS, industries: S.parse(r.industries, []),
});
async function history(user, { type } = {}) {
  const want = type === 'internal' ? 'internal' : 'candidate_lead';
  if (!A.mayRead(user, want)) return [];
  const rows = await S.q('SELECT * FROM "OutreachImport" WHERE contactType = ? ORDER BY createdAt DESC LIMIT 200', want);
  const seeAll = A.isAdmin(user) || A.kind(user) === 'view' || want === 'internal';
  const mine = rows.filter((r) => seeAll || r.createdById === user.id);
  // which imports have a saved per-row list (and how many rows need a look): for the "Download rows with problems" button
  const probs = {};
  if (mine.length && (await S.quickReady())) {
    (await S.q(`SELECT importId, COUNT(*) n FROM "OutreachImportRow" WHERE look = 1 AND importId IN (${mine.map(() => '?').join(',')}) GROUP BY importId`, ...mine.map((r) => r.id))).forEach((x) => { probs[x.importId] = S.num(x.n); });
    (await S.q(`SELECT DISTINCT importId FROM "OutreachImportRow" WHERE importId IN (${mine.map(() => '?').join(',')})`, ...mine.map((r) => r.id))).forEach((x) => { if (probs[x.importId] === undefined) probs[x.importId] = 0; });
  }
  return mine.map((r) => ({ ...importView(r), rowsSaved: probs[r.id] !== undefined, problemRows: probs[r.id] || 0 }));
}
async function undoBatch(user, id) {
  const r = (await S.q('SELECT * FROM "OutreachImport" WHERE id = ?', id))[0];
  if (!r) return { error: 'This import was not found.', status: 404 };
  if (!A.isAdmin(user) && r.createdById !== user.id) return { error: 'You can take back only your own imports.', status: 403 };
  if (!A.mayWrite(user, r.contactType)) return { error: 'You cannot change this kind of contact.', status: 403 };
  if (r.undoneAt) return { error: 'This import was already taken back.', status: 409 };
  if (Date.now() - S.ms(r.createdAt) > UNDO_MS) return { error: 'This import is older than 7 days. It can no longer be taken back.', status: 409 };
  const log = S.parse(r.undoLog, { created: [], updated: [] });
  let removed = 0; let restored = 0;
  for (const cid of log.created) {
    // an opt-out stays on the do-not-contact list (that is a hash); the person's details are removed
    await S.run('DELETE FROM "OutreachContactChannel" WHERE contactId = ?', cid); // eslint-disable-line no-await-in-loop
    await S.run('DELETE FROM "OutreachContactTag" WHERE contactId = ?', cid); // eslint-disable-line no-await-in-loop
    removed += await S.run('DELETE FROM "OutreachContact" WHERE id = ? AND importId = ?', cid, id); // eslint-disable-line no-await-in-loop
  }
  for (const u of log.updated) {
    const b = u.before || {};
    await S.run('UPDATE "OutreachContact" SET name = ?, company = ?, city = ?, skills = ?, experience = ?, phoneE164 = ?, phoneKey = ?, email = ?, emailKey = ?, updatedAt = ? WHERE id = ?', b.name, b.company, b.city, b.skills, b.experience, b.phoneE164, b.phoneKey, b.email, b.emailKey, Date.now(), u.id); // eslint-disable-line no-await-in-loop
    if ('language' in b) await S.run('UPDATE "OutreachContact" SET language = ?, preferredChannel = ?, notes = ?, customValues = ? WHERE id = ?', b.language, b.preferredChannel, b.notes, b.customValues, u.id); // eslint-disable-line no-await-in-loop
    for (const t of u.addedTags || []) await S.run('DELETE FROM "OutreachContactTag" WHERE contactId = ? AND industry = ?', u.id, t); // eslint-disable-line no-await-in-loop
    for (const ch of u.addedChannels || []) await S.run('DELETE FROM "OutreachContactChannel" WHERE id = ?', ch); // eslint-disable-line no-await-in-loop
    restored += 1;
  }
  await S.run('UPDATE "OutreachImport" SET undoneAt = ?, undoneById = ? WHERE id = ?', Date.now(), user.id, id);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Outreach import taken back', entity: 'OutreachImport', entityId: id, toValue: `${removed} removed · ${restored} restored` });
  return { ok: `Taken back: ${removed} people removed${restored ? `, ${restored} restored to how they were` : ''}.`, removed, restored };
}

// the template file
function templateRows(type, customs) {
  const cf = customs || [];
  const head = ['Name', 'Phone / WhatsApp', 'Email', 'Company', 'City', 'Skills', 'Experience', 'Kind', 'Permission (yes/no)', 'Language', 'Preferred channel', 'Notes', ...cf.map((f) => f.name)];
  const sample = (f) => (f.type === 'dropdown' || f.type === 'multi' ? f.options[0] || '' : '');
  return [head, type === 'internal' ? ['Ravi Kumar', '9876543210', 'ravi@example.com', 'TeamLink', 'Hyderabad', 'HR', '4', '', 'yes', 'Telugu', 'whatsapp', '', ...cf.map(sample)] : ['Anita Rao', '9876543210', 'anita@example.com', 'City Care Hospital', 'Hyderabad', 'ICU nursing', '3', 'Medical', 'yes', 'Telugu', 'whatsapp', 'Prefers evening calls', ...cf.map(sample)]];
}

module.exports = { MAX_ROWS, FIELD_WORDS, STATUS_WORDS, importFields, wordsFor, autoMap, check, save, history, undoBatch, templateRows, classify, importView, rowsCsv, tagsOf };
