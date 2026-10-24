// ---------------------------------------------------------------------------
// CONTACTS: the table behind the Contacts tab. Create / find / list (with the role's scope and masking), tags, channel consent rows.
// Phone is stored as E.164 digits (+91 default), email lower-case; phoneKey = last 10 digits, emailKey = the lower-case address
// (the live unique indexes in the migration make a second live contact with the same key impossible).
// ---------------------------------------------------------------------------
const core = require('../utils/messagingCore');
const S = require('./store');
const A = require('./access');
const R = require('./rules');
const C = require('./consent');
const Pol = require('./policy');
const { logAudit } = require('../utils/audit');

const CHANNELS = R.CHANNELS;

// ---- normalising ---------------------------------------------------------------
function phoneOf(raw) {
  const first = String(raw == null ? '' : raw).split(/[/,;\n]| or /i).map((s) => s.trim()).filter(Boolean)[0] || '';
  if (!first) return { blank: true, ok: false };
  const n = core.normalizeMobile(first.replace(/^(ph|tel|phone|mob|mobile|cell|whatsapp|wa)\.?\s*(no\.?|number)?\s*[:.-]?\s*/i, '').replace(/\.0+$/, ''));
  return n.ok ? { ok: true, e164: n.e164, key: n.e164.slice(-10) } : { ok: false, reason: n.reason };
}
function emailOf(raw) {
  const t = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!t) return { blank: true, ok: false };
  const first = t.split(/[;, ]+/)[0];
  return core.validEmail(first) && first.length <= 160 ? { ok: true, addr: first, key: first } : { ok: false, reason: `${t.slice(0, 60)} is not a valid email address` };
}

// ---- lookups ---------------------------------------------------------------------
async function findByKeys(phoneKey, emailKey) {
  const out = [];
  if (phoneKey) out.push(...await S.q('SELECT * FROM "OutreachContact" WHERE phoneKey = ? AND status = \'active\'', phoneKey));
  if (emailKey) out.push(...await S.q('SELECT * FROM "OutreachContact" WHERE emailKey = ? AND status = \'active\'', emailKey));
  return [...new Map(out.map((r) => [r.id, r])).values()];
}
async function getRow(id) {
  const r = await S.q('SELECT * FROM "OutreachContact" WHERE id = ?', id);
  return r[0] || null;
}

// ---- consent for a NEW address on a contact ------------------------------------------
// consent: { declared: bool, rowSaysNo: bool, source, evidence, textVersion, legacyStops:{whatsapp:Set,sms:Set} }
async function addChannelRow(contactId, contact, channel, consent, by) {
  const address = channel === 'email' ? contact.email : contact.phoneE164;
  if (!address) return null;
  const hash = C.hashFor(contact, channel);
  const now = Date.now();
  let optIn = 'unknown'; let reason = null; let source = null; let evidence = null; let optOutReason = null;
  const key = channel === 'email' ? contact.emailKey : contact.phoneKey;
  if (await C.isSuppressedHash(hash, channel) || await C.isSuppressedHash(hash, '*')) { optIn = 'opted_out'; optOutReason = 'suppression'; reason = 'suppression'; }
  else if (consent && consent.legacyStops && consent.legacyStops[channel] && key && consent.legacyStops[channel].has(contact.phoneE164)) { optIn = 'opted_out'; optOutReason = 'stop_reply'; reason = 'legacy_stop_list'; }
  else if (consent && consent.rowSaysNo) { optIn = 'opted_out'; optOutReason = 'import_flag'; reason = 'import_flag'; }
  else if (consent && consent.declared) { optIn = 'opted_in'; source = consent.source || 'import_declared'; evidence = consent.evidence; }
  const id = S.newId('occ');
  await S.run('INSERT INTO "OutreachContactChannel" (id, contactId, channel, address, optIn, optInAt, optInSource, optInEvidence, optOutAt, optOutReason) VALUES (?,?,?,?,?,?,?,?,?,?)',
    id, contactId, channel, address, optIn, optIn === 'opted_in' ? now : null, source, evidence ? S.clip(evidence, 400) : null, optIn === 'opted_out' ? now : null, optOutReason);
  if (optIn === 'opted_in') await C.recordEvent({ contactId, hash, channel, action: 'opt_in', source, evidence, textVersion: consent.textVersion, byUserId: by && by.id, at: now });
  if (optIn === 'opted_out') {
    await C.suppress(hash, channel, optOutReason, reason);
    await C.recordEvent({ contactId, hash, channel, action: 'opt_out', source: reason, evidence: C.OPT_OUT_REASONS[optOutReason], byUserId: by && by.id, at: now });
  }
  return { id, optIn };
}

// ---- the v3 columns: language, preferredChannel, notes, customValues (customValues also holds the Platform ID as "_platformId") ----------------
const PREFERRED = R.PREFERRED;
const prefOf = (v) => { const t = String(v == null ? '' : v).trim().toLowerCase(); if (!t) return ''; if (PREFERRED.includes(t)) return t; if (/^(wa|whats ?app)$/.test(t)) return 'whatsapp'; if (/^(mail|e-?mail)$/.test(t)) return 'email'; if (/^(text|message)$/.test(t)) return 'sms'; if (/^(phone|voice|calls?)$/.test(t)) return 'call'; return null; };
const jsonOrNull = (o) => (o && Object.keys(o).length ? JSON.stringify(o) : null);
async function writeExtras(id, data) {
  const sets = []; const params = [];
  if (data.language) { sets.push('language = ?'); params.push(S.clip(data.language, 40)); }
  if (data.preferredChannel) { sets.push('preferredChannel = ?'); params.push(prefOf(data.preferredChannel) || null); }
  if (data.notes) { sets.push('notes = ?'); params.push(S.clip(data.notes, 1000)); }
  const cv = { ...(data.customValues || {}) };
  if (data.platformId) cv._platformId = S.clip(data.platformId, 80);
  const cvj = jsonOrNull(cv);
  if (cvj) { sets.push('customValues = ?'); params.push(cvj); }
  if (!sets.length) return;
  await require('./v3schema').ensure(); // eslint-disable-line global-require
  await S.run(`UPDATE "OutreachContact" SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
}
const parseCv = (v) => { try { const o = v ? JSON.parse(v) : {}; return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; } };

// ---- create ---------------------------------------------------------------------------
// data: { type, name, phone:{e164,key}|null, email:{addr,key}|null, company, city, skills, experience, source, importId, industries[] }
async function insert(user, data, consent) {
  const id = S.newId('oc');
  const now = Date.now();
  const phone = data.phone || null; const email = data.email || null;
  await S.run(`INSERT INTO "OutreachContact" (id, contactType, name, phoneE164, email, phoneKey, emailKey, company, city, skills, experience, source, importId, ownerUserId, department,
      status, consentSource, consentAt, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?,?,?,?,?)`,
  id, data.type, S.clip(data.name, 120) || null, phone ? phone.e164 : null, email ? email.addr : null, phone ? phone.key : null, email ? email.key : null,
  S.clip(data.company, 120) || null, S.clip(data.city, 80) || null, S.clip(data.skills, 200) || null, S.clip(data.experience, 30) || null, S.clip(data.source, 140) || null,
  data.importId || null, user ? user.id : null, data.department || null, consent && consent.declared ? (consent.source || 'import_declared') : null, consent && consent.declared ? now : null,
  user ? user.id : null, user ? user.name : null, now, now);
  await writeExtras(id, data);
  const row = await getRow(id);
  for (const ind of data.industries || []) await S.run('INSERT OR IGNORE INTO "OutreachContactTag" (contactId, industry) VALUES (?,?)', id, ind); // eslint-disable-line no-await-in-loop
  const made = [];
  if (email) made.push(['email']);
  if (phone) made.push(['whatsapp'], ['sms']);
  for (const [ch] of made) await addChannelRow(id, row, ch, consent, user); // eslint-disable-line no-await-in-loop
  return row;
}

// one person typed in by hand (the "Add a person" box): same rules as an import row
async function createManual(user, b, consent) {
  const type = b.contactType === 'internal' ? 'internal' : 'candidate_lead';
  if (!A.mayWrite(user, type)) return { error: 'You cannot add this kind of contact.', status: 403 };
  const phone = phoneOf(b.phone); const email = emailOf(b.email);
  if (!phone.ok && !email.ok) return { error: 'Give a valid phone number or email address.', status: 400 };
  if (phone.blank === false && !phone.ok && !email.ok) return { error: phone.reason, status: 400 };
  const inds = await S.industries();
  const tags = (Array.isArray(b.industries) ? b.industries : []).map((x) => inds.find((i) => i.name.toLowerCase() === String(x).toLowerCase())).filter(Boolean).map((i) => i.name);
  const dups = await findByKeys(phone.ok ? phone.key : null, email.ok ? email.key : null);
  if (dups.length) return { error: 'This person is already in your contacts.', status: 409, duplicateId: A.isAdmin(user) || dups[0].ownerUserId === user.id ? dups[0].id : undefined };
  // v3: language, preferred channel, notes, Platform ID and the custom fields of the CRM Fields page
  const pref = b.preferredChannel === undefined || b.preferredChannel === '' ? '' : prefOf(b.preferredChannel);
  if (pref === null) return { error: 'Preferred channel must be WhatsApp, Email, SMS or Call.', status: 400 };
  const defs = await Pol.customFields();
  const cvIn = b.customValues && typeof b.customValues === 'object' ? b.customValues : {};
  const cv = await Pol.cleanValues(A.masked(user) ? Object.fromEntries(Object.entries(cvIn).filter(([k]) => { const f = defs.find((x) => x.id === k); return f && !['phone', 'email'].includes(f.type); })) : cvIn, defs);
  if (cv.problems.length) return { error: cv.problems[0], status: 400 };
  const missing = Pol.missingRequired(cv.values, defs);
  if (missing.length) return { error: missing[0], status: 400 };
  let row;
  try {
    row = await insert(user, { type, name: b.name, phone: phone.ok ? phone : null, email: email.ok ? email : null, company: b.company, city: b.city, skills: b.skills, source: b.source || 'Added by hand', industries: tags, language: b.language, preferredChannel: pref, notes: b.notes, customValues: cv.values, platformId: b.platformId }, consent || { declared: false });
  } catch (e) { if (/UNIQUE/i.test(String(e.message))) return { error: 'This person is already in your contacts.', status: 409 }; throw e; }
  await logAudit({ userId: user.id, actorName: user.name, action: 'Outreach contact added by hand', entity: 'OutreachContact', entityId: row.id, toValue: `type ${type}` });
  return { contact: row.id };
}

// ---- reading ---------------------------------------------------------------------------
// SCOPE: which contacts this login may see, as SQL on alias c.  null = nothing.
async function scopeConds(user, type) {
  const k = A.kind(user);
  if (!A.mayRead(user, type)) return null;
  if (type === 'internal') return { conds: ['c.contactType = \'internal\''], params: [] };
  if (A.seesAllLeads(user) && k !== 'recruiter') return { conds: ['c.contactType = \'candidate_lead\''], params: [] };
  if (k === 'recruiter') {
    // the contacts of the segments this recruiter may see
    const Sg = require('./segments'); // eslint-disable-line global-require
    const segs = await Sg.visibleSegments(user);
    const parts = []; const params = [];
    // v2: ALSO the contacts of their own department (the contact's department, or a kind that belongs to it), even before an audience exists
    const myDepts = A.departmentsOf(user);
    if (myDepts.length) {
      const inds = await S.industries();
      const mine = inds.filter((i) => myDepts.includes(String(i.department || i.name).toLowerCase())).map((i) => i.name);
      const ors = [`LOWER(COALESCE(c.department, '')) IN (${R.ph(myDepts.length)})`]; const ps = [...myDepts];
      if (mine.length) { ors.push(`EXISTS (SELECT 1 FROM "OutreachContactTag" t WHERE t.contactId = c.id AND t.industry IN (${R.ph(mine.length)}))`); ps.push(...mine); }
      parts.push(`(c.contactType = 'candidate_lead' AND (${ors.join(' OR ')}))`); params.push(...ps);
    }
    if (!segs.length && !parts.length) return null;
    segs.forEach((s) => { const rc = R.segmentConds(s.rules); parts.push(`(${[...rc.conds, 'c.contactType = \'candidate_lead\''].join(' AND ')})`); params.push(...rc.params); });
    return { conds: [`(${parts.join(' OR ')})`], params };
  }
  // bde / bdetl / tl: the contacts they brought in
  return { conds: ['c.contactType = \'candidate_lead\'', '(c.ownerUserId = ? OR c.createdById = ?)'], params: [user.id, user.id] };
}

function filterConds(f, masked) {
  const conds = []; const params = [];
  const rc = R.ruleConds({ industries: f.industries, cities: f.cities, importIds: f.importIds });
  conds.push(...rc.conds); params.push(...rc.params);
  const t = String(f.q || '').trim().slice(0, 80);
  if (t) {
    const like = `%${t.replace(/[%_]/g, '')}%`;
    const digits = t.replace(/\D/g, '');
    const parts = ['c.name LIKE ?', 'c.company LIKE ?', 'c.city LIKE ?', 'c.skills LIKE ?']; const ps = [like, like, like, like];
    // a masked login may not find a person by phone or email (it would reveal the hidden value)
    if (!masked) { parts.push('c.email LIKE ?'); ps.push(like); if (digits.length >= 4) { parts.push('c.phoneKey LIKE ?'); ps.push(`%${digits.slice(-10)}%`); } }
    conds.push(`(${parts.join(' OR ')})`); params.push(...ps);
  }
  if (f.channel && CHANNELS.includes(f.channel)) {
    const st = ['opted_in', 'opted_out', 'unknown'].includes(f.optin) ? f.optin : null;
    conds.push(`EXISTS (SELECT 1 FROM "OutreachContactChannel" h WHERE h.contactId = c.id AND h.channel = ?${st ? ' AND h.optIn = ?' : ''})`);
    params.push(f.channel); if (st) params.push(st);
  } else if (['opted_in', 'opted_out', 'unknown'].includes(f.optin)) {
    conds.push('EXISTS (SELECT 1 FROM "OutreachContactChannel" h WHERE h.contactId = c.id AND h.optIn = ?)'); params.push(f.optin);
  }
  return { conds, params };
}

const maskPhone = (e) => (e ? core.maskMobile(e) : '');
const maskMail = (e) => (e ? core.maskEmail(e) || '' : '');
function view(row, user, tags, chans) {
  const m = A.masked(user);
  return {
    id: row.id, contactType: row.contactType, name: row.name || '', phone: m ? maskPhone(row.phoneE164) : (row.phoneE164 ? `+${row.phoneE164}` : ''), email: m ? maskMail(row.email) : (row.email || ''),
    company: row.company || '', city: row.city || '', skills: row.skills || '', experience: row.experience || '', source: row.source || '', importId: row.importId || null,
    industries: tags || [], channels: (chans || []).map((c) => ({ channel: c.channel, optIn: c.optIn, optOutReason: c.optOutReason || null, optOutWords: c.optOutReason ? C.OPT_OUT_REASONS[c.optOutReason] || c.optOutReason : null, health: c.health, hasAddress: !!c.address, optInAt: S.iso(c.optInAt), optInSource: c.optInSource || null, optOutAt: S.iso(c.optOutAt) })),
    language: row.language || '', preferredChannel: row.preferredChannel || '', notes: row.notes || '', lastReplyAt: S.iso(row.lastReplyAt), unsubscribedAt: S.iso(row.unsubscribedAt), consentSource: row.consentSource || null, consentAt: S.iso(row.consentAt), linkedApplicantId: row.linkedApplicantId || null, createdAt: S.iso(row.createdAt), ownerUserId: row.ownerUserId,
  };
}

async function list(user, f = {}) {
  const type = f.type === 'internal' ? 'internal' : 'candidate_lead';
  const sc = await scopeConds(user, type);
  if (!sc) return { contacts: [], total: 0, page: 1, pageSize: 50, facets: { industries: [], cities: [], optin: [] }, masked: A.masked(user) };
  const masked = A.masked(user);
  const base = ['c.status = \'active\'', ...sc.conds]; const baseP = [...sc.params];
  const fc = filterConds(f, masked);
  const where = [...base, ...fc.conds].join(' AND '); const params = [...baseP, ...fc.params];
  const pageSize = Math.min(100, Math.max(5, Number(f.pageSize) || 50));
  const page = Math.max(1, Number(f.page) || 1);
  const total = S.num((await S.q(`SELECT COUNT(*) n FROM "OutreachContact" c WHERE ${where}`, ...params))[0].n);
  const rows = await S.q(`SELECT c.* FROM "OutreachContact" c WHERE ${where} ORDER BY c.createdAt DESC, c.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, ...params);
  const ids = rows.map((r) => r.id);
  const tagRows = ids.length ? await S.q(`SELECT contactId, industry FROM "OutreachContactTag" WHERE contactId IN (${R.ph(ids.length)})`, ...ids) : [];
  const chRows = ids.length ? await S.q(`SELECT * FROM "OutreachContactChannel" WHERE contactId IN (${R.ph(ids.length)})`, ...ids) : [];
  const tagsBy = {}; tagRows.forEach((t) => { (tagsBy[t.contactId] = tagsBy[t.contactId] || []).push(t.industry); });
  const chBy = {}; chRows.forEach((t) => { (chBy[t.contactId] = chBy[t.contactId] || []).push(t); });
  return { contacts: rows.map((r) => view(r, user, (tagsBy[r.id] || []).sort(), (chBy[r.id] || []).sort((a, b) => a.channel.localeCompare(b.channel)))), total, page, pageSize, facets: await facets(user, f, type, sc, masked), masked };
}

// FACETS (cascading): each filter's options are counted with every OTHER filter applied.
async function facets(user, f, type, sc, masked) {
  const base = ['c.status = \'active\'', ...sc.conds];
  const without = (omit) => {
    const ff = { ...f }; omit.forEach((k) => { delete ff[k]; });
    const fc = filterConds(ff, masked);
    return { where: [...base, ...fc.conds].join(' AND '), params: [...sc.params, ...fc.params] };
  };
  const a = without(['industries']);
  const ind = await S.q(`SELECT t.industry AS v, COUNT(DISTINCT c.id) AS n FROM "OutreachContact" c JOIN "OutreachContactTag" t ON t.contactId = c.id WHERE ${a.where} GROUP BY t.industry ORDER BY n DESC`, ...a.params);
  const b = without(['cities']);
  const cit = await S.q(`SELECT c.city AS v, COUNT(*) AS n FROM "OutreachContact" c WHERE ${b.where} AND c.city IS NOT NULL AND c.city <> '' GROUP BY c.city ORDER BY n DESC LIMIT 40`, ...b.params);
  const d = without(['optin', 'channel']);
  const opt = await S.q(`SELECT h.optIn AS v, COUNT(DISTINCT c.id) AS n FROM "OutreachContact" c JOIN "OutreachContactChannel" h ON h.contactId = c.id WHERE ${d.where} GROUP BY h.optIn`, ...d.params);
  const g = without(['importIds']);
  const imps = await S.q(`SELECT c.importId AS v, COUNT(*) AS n FROM "OutreachContact" c WHERE ${g.where} AND c.importId IS NOT NULL GROUP BY c.importId ORDER BY n DESC LIMIT 40`, ...g.params);
  const names = imps.length ? await S.q(`SELECT id, fileName, createdAt FROM "OutreachImport" WHERE id IN (${R.ph(imps.length)})`, ...imps.map((i) => i.v)) : [];
  const nameOf = Object.fromEntries(names.map((n) => [n.id, n.fileName || 'Import']));
  const m = (rows) => rows.map((r) => ({ value: r.v, count: S.num(r.n) }));
  return { industries: m(ind), cities: m(cit), optin: m(opt), imports: imps.map((i) => ({ value: i.v, count: S.num(i.n), label: nameOf[i.v] || 'Import' })) };
}

// one contact, if this login may see it
async function getOne(user, id) {
  const row = await getRow(id);
  if (!row || row.status !== 'active') return null;
  const sc = await scopeConds(user, row.contactType);
  if (!sc) return null;
  const hit = await S.q(`SELECT 1 x FROM "OutreachContact" c WHERE c.id = ? AND ${[...sc.conds].join(' AND ')}`, id, ...sc.params);
  if (!hit.length) return null;
  const tags = (await S.q('SELECT industry FROM "OutreachContactTag" WHERE contactId = ?', id)).map((t) => t.industry).sort();
  const chans = await C.channelRows(id);
  return { row, view: view(row, user, tags, chans) };
}

async function setIndustries(user, id, names) {
  const one = await getOne(user, id);
  if (!one) return { error: 'This person was not found.', status: 404 };
  if (!A.mayWrite(user, one.row.contactType)) return { error: 'You cannot change this contact.', status: 403 };
  const inds = await S.industries();
  const keep = (names || []).map((x) => inds.find((i) => i.name.toLowerCase() === String(x).toLowerCase())).filter(Boolean).map((i) => i.name);
  await S.run('DELETE FROM "OutreachContactTag" WHERE contactId = ?', id);
  for (const n of keep) await S.run('INSERT OR IGNORE INTO "OutreachContactTag" (contactId, industry) VALUES (?,?)', id, n); // eslint-disable-line no-await-in-loop
  await S.run('UPDATE "OutreachContact" SET updatedAt = ? WHERE id = ?', Date.now(), id);
  return { industries: keep };
}

// ---- change a person's details (Customers > Edit, and the inline Lead stage / Lead status) ------------------------------------------------
// patch: { name, company, city, skills, experience, language, preferredChannel, notes, customValues: { fieldId: value | '' to clear, _platformId },
//          phone, email (only fill a box that is EMPTY: a saved number is never replaced), enforceRequired }
// Who: the logins that may write this kind of contact AND can see this person (a BDE / TL only their own people; an Admin anybody). A masked login
// never sets a phone- or email-type custom value (it could not see what is there).
async function updateFields(user, id, p = {}) {
  const one = await getOne(user, id);
  if (!one) return { error: 'This person was not found.', status: 404 };
  const row = one.row;
  if (!A.mayWrite(user, row.contactType)) return { error: 'You cannot change this contact.', status: 403 };
  const masked = A.masked(user);
  const sets = []; const params = []; const changed = [];
  const text = (k, n) => { if (p[k] === undefined) return; const v = S.clip(p[k], n) || null; if ((row[k] || null) !== v) { sets.push(`${k} = ?`); params.push(v); changed.push(k); } };
  text('name', 120); text('company', 120); text('city', 80); text('skills', 200); text('experience', 30); text('language', 40); text('notes', 1000);
  if (p.preferredChannel !== undefined) {
    const v = p.preferredChannel === '' || p.preferredChannel === null ? null : prefOf(p.preferredChannel);
    if (p.preferredChannel && v === null) return { error: 'Preferred channel must be WhatsApp, Email, SMS or Call.', status: 400 };
    if ((row.preferredChannel || null) !== v) { sets.push('preferredChannel = ?'); params.push(v); changed.push('preferredChannel'); }
  }
  const defs = await Pol.customFields();
  if (p.customValues && typeof p.customValues === 'object') {
    const cur = parseCv(row.customValues); const next = { ...cur };
    for (const [k, v] of Object.entries(p.customValues)) {
      if (k === '_platformId') { const t = S.clip(v, 80); if (t) next._platformId = t; else delete next._platformId; continue; } // eslint-disable-line no-continue
      const f = defs.find((x) => x.id === k || x.key === k);
      if (!f) continue; // eslint-disable-line no-continue
      if (masked && ['phone', 'email'].includes(f.type)) continue; // eslint-disable-line no-continue
      const empty = v === null || v === '' || (Array.isArray(v) && !v.length);
      if (empty) { delete next[f.id]; continue; } // eslint-disable-line no-continue
      const c = Pol.cleanValue(f, v);
      if (c.error) return { error: c.error, status: 400 };
      if (Array.isArray(c.value) ? !c.value.length : c.value === '') delete next[f.id]; else next[f.id] = c.value;
    }
    if (p.enforceRequired) { const miss = Pol.missingRequired(next, defs.filter((f) => !(masked && ['phone', 'email'].includes(f.type)))); if (miss.length) return { error: miss[0], status: 400 }; }
    if (JSON.stringify(next) !== JSON.stringify(cur)) { sets.push('customValues = ?'); params.push(jsonOrNull(next)); changed.push('customValues'); }
  }
  // an address is only ADDED to an empty box, and never one that belongs to somebody else
  const added = [];
  if (p.phone !== undefined && !row.phoneE164) {
    const ph = phoneOf(p.phone);
    if (ph.ok) {
      if ((await findByKeys(ph.key, null)).some((x) => x.id !== id)) return { error: 'That phone number already belongs to another person.', status: 409 };
      sets.push('phoneE164 = ?', 'phoneKey = ?'); params.push(ph.e164, ph.key); changed.push('phone'); added.push('whatsapp', 'sms');
    } else if (!ph.blank) return { error: ph.reason || 'That phone number does not look right.', status: 400 };
  }
  if (p.email !== undefined && !row.email) {
    const em = emailOf(p.email);
    if (em.ok) {
      if ((await findByKeys(null, em.key)).some((x) => x.id !== id)) return { error: 'That email address already belongs to another person.', status: 409 };
      sets.push('email = ?', 'emailKey = ?'); params.push(em.addr, em.key); changed.push('email'); added.push('email');
    } else if (!em.blank) return { error: em.reason || 'That email address does not look right.', status: 400 };
  }
  if (!sets.length) return { ok: true, changed: [] };
  await require('./v3schema').ensure(); // eslint-disable-line global-require
  try { await S.run(`UPDATE "OutreachContact" SET ${sets.join(', ')}, updatedAt = ? WHERE id = ?`, ...params, Date.now(), id); } catch (e) { if (/UNIQUE/i.test(String(e.message))) return { error: 'That phone or email already belongs to another person.', status: 409 }; throw e; }
  if (added.length) { const fresh = await getRow(id); for (const ch of added) await addChannelRow(id, fresh, ch, { declared: false }, user); } // eslint-disable-line no-await-in-loop
  await logAudit({ userId: user.id, actorName: user.name, action: 'Outreach contact changed', entity: 'OutreachContact', entityId: id, toValue: `fields: ${changed.join(', ')}` });
  return { ok: true, changed };
}

module.exports = { phoneOf, emailOf, findByKeys, getRow, insert, createManual, updateFields, addChannelRow, list, getOne, setIndustries, scopeConds, view, parseCv, prefOf, CHANNELS };
