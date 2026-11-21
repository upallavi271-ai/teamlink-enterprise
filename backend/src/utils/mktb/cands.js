// ---------------------------------------------------------------------------
// MARKET WAVE B - CANDIDATES (03.02 / 03.05 / 03.08 / 03.09 / 03.10 / 03.12 / 03.13 / 03.15 / 03.17 / 03.18 / 03.20 / 03.21, 09.12).
//
//   03.02 OCR backlog         resumes saved before OCR was installed (no text): count them and read them again in small batches.
//   03.05 Field parsing agent  rules per custom field (label in the resume / pattern / pick-list / AI): proposals, applied to empty fields.
//   03.08 Natural search      "java developers in hyderabad 5+ years notice 30 days" -> filters (shown) -> people in this login's scope.
//   03.09 Saved searches      named searches; "new since last look"; bells only with the Admin switch (alerts.savedSearch) ON.
//   03.10 Talent pools        named lists (own or shared): add / remove many, add all to a requirement (the normal add, from the screen).
//   03.12 Enrichment          ONLY from the person's own resume and their own updates (no scraping): proposals for empty fields.
//   03.13 Self-updating       stale profiles (no change for stale.days), job changes seen in the person's own update.
//   03.15 / 09.12 Client CV   a branded PDF without phone / email / address; the summary written by the AI (masked) or by rules.
//   03.17 Update link         a private link (14 days, one use) where the person corrects their own details.
//   03.18 Document expiry     an expiry date on a document; the expiring list; bells only with alerts.docExpiry ON.
//   03.20 Fraud signals       same phone / email / file on different names, experience that does not add up, proxy words in feedback:
//                             a flag in a review queue, never an automatic action.
//   03.21 Bulk profile review  up to 50 people against a job: a score from the facts (never the name or gender), an optional AI line;
//                             "Not a fit" waits in the human review queue.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../../db');
const S = require('./store');

const lower = (s) => String(s || '').toLowerCase();
const csv = (s) => String(s || '').split(/[,;|]/).map((x) => x.trim()).filter(Boolean);
const scopeW = (user) => require('../scope').candidateWhere(user); // eslint-disable-line global-require

// ---- 03.02 OCR backlog ------------------------------------------------------------------------------------------------------------
async function ocrBacklog() {
  const OCR = require('../resumeOcr'); // eslint-disable-line global-require
  const rows = await prisma.candidateResume.findMany({ where: { kind: 'ORIGINAL', hiddenAt: null, file: { not: null } }, select: { id: true, candidateId: true, fileName: true, text: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 20000 });
  const waiting = rows.filter((r) => /\.(pdf|jpe?g|png)$/i.test(r.fileName || '') && OCR.letterCount(r.text || '') < OCR.MIN_LETTERS);
  const st = await OCR.status().catch(() => ({ available: false }));
  return { waiting: waiting.length, sample: waiting.slice(0, 10).map((r) => ({ id: r.id, candidateId: r.candidateId, fileName: r.fileName, at: r.createdAt })), ocr: { available: !!st.available, languages: st.languages || [], why: st.why || null } };
}
async function ocrRerun({ limit = 10 } = {}, user) {
  const OCR = require('../resumeOcr'); // eslint-disable-line global-require
  const st = await OCR.status().catch(() => ({ available: false }));
  if (!st.available) return { notInstalled: true, done: 0, read: 0, message: 'OCR is not installed on this server yet (docs/OCR-SETUP.md). Nothing was read.' };
  const RS = require('../resumeStore'); const RP = require('../resumeParse'); // eslint-disable-line global-require
  const fs = require('fs'); // eslint-disable-line global-require
  const back = await ocrBacklog();
  const ids = (await prisma.candidateResume.findMany({ where: { kind: 'ORIGINAL', hiddenAt: null, file: { not: null } }, select: { id: true, file: true, fileName: true, text: true }, orderBy: { createdAt: 'desc' }, take: 20000 }))
    .filter((r) => /\.(pdf|jpe?g|png)$/i.test(r.fileName || '') && OCR.letterCount(r.text || '') < OCR.MIN_LETTERS).slice(0, Math.min(25, Math.max(1, limit)));
  let read = 0;
  for (const r of ids) {
    const full = RS.resolveResumeFile(r.file);
    if (!full) continue; // eslint-disable-line no-continue
    const buf = fs.readFileSync(full);
    // eslint-disable-next-line no-await-in-loop
    const out = await RP.extractAndParse(buf, RS.sniffKind(buf));
    if (out.text && OCR.letterCount(out.text) >= OCR.MIN_LETTERS) {
      read += 1;
      // eslint-disable-next-line no-await-in-loop
      await prisma.candidateResume.update({ where: { id: r.id }, data: { text: out.text, parsed: out.parsed ? JSON.stringify(out.parsed) : null, parser: out.parser } });
    }
  }
  return { done: ids.length, read, waitingBefore: back.waiting, by: user ? user.name : 'system' };
}

// ---- resume text of a person --------------------------------------------------------------------------------------------------------
async function latestResume(candidateId) {
  return prisma.candidateResume.findFirst({ where: { candidateId, kind: 'ORIGINAL', hiddenAt: null }, orderBy: { createdAt: 'desc' }, select: { id: true, text: true, parsed: true, fileName: true, createdAt: true } });
}

// ---- 03.05 custom-field parsing agent -------------------------------------------------------------------------------------------------
const FIELD_METHODS = ['label', 'pattern', 'list', 'ai'];
async function fieldRules() {
  const PD = require('../candidateProfileDepth'); // eslint-disable-line global-require
  const defs = await PD.fieldDefs();
  const rows = await S.q('SELECT * FROM "MktFieldRule"');
  return { fields: defs, rules: rows.map((r) => ({ ...r, active: Number(r.active) !== 0, label: (defs.find((d) => d.id === r.fieldId) || {}).label || '(field removed)' })) };
}
async function saveFieldRule(body, user) {
  const PD = require('../candidateProfileDepth'); // eslint-disable-line global-require
  const def = (await PD.fieldDefs()).find((d) => d.id === body.fieldId);
  if (!def) return { error: 'Pick a custom field (Administration > Candidate fields).' };
  const method = FIELD_METHODS.includes(body.method) ? body.method : 'label';
  const pattern = S.clean(body.pattern, 200);
  if (method === 'pattern') { try { new RegExp(pattern, 'i'); } catch { return { error: 'That pattern is not valid.' }; } } // eslint-disable-line no-new
  if (method === 'list' && def.type !== 'select') return { error: 'Pick-list reading works only for a select field.' };
  const id = body.id || S.newId();
  await S.x('INSERT INTO "MktFieldRule" ("id","fieldId","method","pattern","active","byName","at") VALUES (?,?,?,?,?,?,?) ON CONFLICT("id") DO UPDATE SET "fieldId"=excluded."fieldId","method"=excluded."method","pattern"=excluded."pattern","active"=excluded."active","byName"=excluded."byName","at"=excluded."at"',
    id, def.id, method, pattern, body.active === false ? 0 : 1, user.name, S.now());
  return { id };
}
async function deleteFieldRule(id) { await S.x('DELETE FROM "MktFieldRule" WHERE "id" = ?', id); return { ok: true }; }
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function parseFields(candidateId, { useAi = true } = {}) {
  const { fields, rules } = await fieldRules();
  const active = rules.filter((r) => r.active);
  if (!active.length) return { proposals: [], note: 'No field rules yet.' };
  const res = await latestResume(candidateId);
  const text = String((res && res.text) || '');
  if (!text) return { proposals: [], note: 'No resume text on file for this person.' };
  const PD = require('../candidateProfileDepth'); // eslint-disable-line global-require
  const current = await PD.customValuesOf(candidateId);
  const proposals = [];
  for (const r of active) {
    const def = fields.find((d) => d.id === r.fieldId);
    if (!def) continue; // eslint-disable-line no-continue
    let value = null;
    if (r.method === 'label') {
      const label = r.pattern || def.label;
      const m = text.match(new RegExp(`${escRe(label)}\\s*[:\\-–]\\s*([^\\n]{1,80})`, 'i'));
      value = m ? m[1].trim() : null;
    } else if (r.method === 'pattern') {
      const m = text.match(new RegExp(r.pattern, 'i'));
      value = m ? (m[1] || m[0]).trim() : null;
    } else if (r.method === 'list') {
      value = (def.options || []).find((o) => new RegExp(`\\b${escRe(o)}\\b`, 'i').test(text)) || null;
    } else if (r.method === 'ai' && useAi) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const out = await require('../fastAi').chat(`From the resume, give the value of "${def.label}"${r.pattern ? ` (${r.pattern})` : ''}${def.type === 'select' ? `, one of: ${(def.options || []).join(', ')}` : ''}. Reply with JSON {"value": string|null}. null when the resume does not say.`, [{ role: 'user', content: text.slice(0, 6000) }], { json: true, maxTokens: 120, temperature: 0, purpose: 'Custom-field parsing', fallbackToApp: false, deadlineMs: 15000 }); // eslint-disable-line global-require
        const j = require('../ai').parseJsonLoose(out.text); // eslint-disable-line global-require
        value = j && j.value ? String(j.value).slice(0, 120) : null;
      } catch { value = null; }
    }
    if (value == null || value === '') continue; // eslint-disable-line no-continue
    const ok = PD.checkValue(def, value);
    if (ok.error) continue; // eslint-disable-line no-continue
    const now = current.has(def.id) ? current.get(def.id).value : null;
    proposals.push({ fieldId: def.id, label: def.label, value: ok.value, current: now || null, method: r.method, empty: !now });
  }
  return { proposals };
}
async function applyFields(candidateId, values, user) {
  const PD = require('../candidateProfileDepth'); // eslint-disable-line global-require
  return PD.saveCustomValues(candidateId, values, user);
}

// ---- 03.08 natural-language search -----------------------------------------------------------------------------------------------
const STOP = new Set(['in', 'at', 'with', 'and', 'or', 'the', 'a', 'an', 'of', 'for', 'who', 'are', 'is', 'from', 'having', 'people', 'candidates', 'candidate', 'profiles', 'show', 'me', 'find', 'all', 'any', 'near', 'around', 'based', 'located', 'living', 'than', 'less', 'more', 'within', 'max', 'maximum', 'min', 'minimum', 'upto', 'up', 'to', 'yrs', 'years', 'year', 'exp', 'experience', 'experienced', 'notice', 'period', 'days', 'day', 'lpa', 'lakh', 'lakhs', 'salary', 'ctc', 'expected', 'plus', 'over', 'under', 'below', 'above', 'immediate', 'joiners', 'joiner', 'serving', 'who', 'can', 'join']);
const ROLE_NOUNS = /^(developers?|engineers?|nurses?|teachers?|doctors?|executives?|managers?|analysts?|testers?|designers?|accountants?|technicians?|operators?|consultants?|specialists?|leads?|architects?|administrators?|officers?|assistants?|associates?|lecturers?|professors?|pharmacists?|supervisors?)$/i;
async function parseNl(text) {
  const t = ` ${lower(text).replace(/[^\w.+#\s-]/g, ' ').replace(/\s+/g, ' ')} `;
  const f = { skills: [], location: null, minExp: null, maxExp: null, noticeMaxDays: null, maxSalary: null, title: null, education: null };
  let rest = t;
  const take = (re, fn) => { const m = rest.match(re); if (m) { fn(m); rest = rest.replace(m[0], ' '); } return m; };
  take(/(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)\s*(?:yrs?|years?)/, (m) => { f.minExp = Number(m[1]); f.maxExp = Number(m[2]); });
  if (f.minExp == null) take(/(\d+(?:\.\d+)?)\s*\+\s*(?:yrs?|years?)?|(?:more than|over|above|at least|min(?:imum)?)\s*(\d+(?:\.\d+)?)\s*(?:yrs?|years?)|(\d+(?:\.\d+)?)\s*(?:yrs?|years?)(?:\s*(?:of\s*)?(?:exp(?:erience)?))?(?:\s*(?:or more|and above|plus))?/, (m) => { f.minExp = Number(m[1] || m[2] || m[3]); });
  take(/(?:less than|under|below|max(?:imum)?|upto|up to)\s*(\d+(?:\.\d+)?)\s*(?:yrs?|years?)/, (m) => { f.maxExp = Number(m[1]); });
  if (/\b(immediate(?:ly)?|immediate joiners?)\b/.test(rest)) { f.noticeMaxDays = 0; rest = rest.replace(/\bimmediate(?:ly)?( joiners?)?\b/, ' '); }
  take(/notice(?: period)?\s*(?:of|within|under|less than|max(?:imum)?|upto|up to)?\s*(\d+)\s*(days?|months?)?/, (m) => { f.noticeMaxDays = Number(m[1]) * (/month/.test(m[2] || '') ? 30 : 1); });
  if (f.noticeMaxDays == null) take(/(\d+)\s*(days?|months?)\s*notice/, (m) => { f.noticeMaxDays = Number(m[1]) * (/month/.test(m[2] || '') ? 30 : 1); });
  take(/(?:salary|ctc|expected)?\s*(?:under|below|less than|max(?:imum)?|upto|up to|within)\s*(\d+(?:\.\d+)?)\s*(?:lpa|lakhs?|l)\b/, (m) => { f.maxSalary = Number(m[1]); });
  const edu = rest.match(/\b(b\.?tech|m\.?tech|mba|mca|bca|b\.?sc|m\.?sc|b\.?com|m\.?com|mbbs|md|gnm|b\.?ed|ph\.?d|diploma|iti)\b/);
  if (edu) { f.education = edu[1]; rest = rest.replace(edu[0], ' '); }
  // places: the job locations list + places on file
  let places = [];
  try { places = ((await require('../jobLocations').list()).locations || []).map((p) => lower(p.name)); } catch { places = []; } // eslint-disable-line global-require
  ['hyderabad', 'bangalore', 'bengaluru', 'chennai', 'mumbai', 'pune', 'delhi', 'noida', 'gurgaon', 'gurugram', 'kolkata', 'vijayawada', 'visakhapatnam', 'vizag', 'warangal', 'secunderabad', 'ahmedabad', 'kochi', 'coimbatore', 'remote'].forEach((p) => places.push(p));
  const place = [...new Set(places)].filter((p) => p && p.length >= 3).sort((a, b) => b.length - a.length).find((p) => new RegExp(`\\b${escRe(p)}\\b`).test(rest));
  if (place) { f.location = place.replace(/\b\w/g, (c) => c.toUpperCase()); rest = rest.replace(new RegExp(`\\b${escRe(place)}\\b`), ' '); }
  // skills: words of the vocabulary; a role noun ("developers") becomes the title word
  const RP = require('../resumeParse'); // eslint-disable-line global-require
  const vocab = (await RP.skillVocabulary()).filter((v) => v.length >= 2 && v.length <= 30).sort((a, b) => b.length - a.length);
  vocab.forEach((term) => { if (f.skills.length < 8 && RP.textHasTerm(rest, term)) { f.skills.push(term); rest = rest.replace(new RegExp(escRe(term), 'i'), ' '); } });
  const words = rest.split(/\s+/).filter((w) => w && !STOP.has(w) && !/^\d+$/.test(w));
  const role = words.find((w) => ROLE_NOUNS.test(w));
  if (role) f.title = role.replace(/s$/, '');
  words.filter((w) => w !== role && w.length >= 2 && !ROLE_NOUNS.test(w)).slice(0, 4).forEach((w) => { if (!f.skills.includes(w)) f.skills.push(w); });
  return f;
}
function noticeDaysOf(v) {
  const s = lower(v);
  if (!s) return null;
  if (/immediate|serving|0\s*day/.test(s)) return 0;
  const n = Number((s.match(/\d+/) || [])[0]);
  if (!Number.isFinite(n)) return null;
  return /month/.test(s) ? n * 30 : /week/.test(s) ? n * 7 : n;
}
const lakhOf = (v) => { const n = Number(String(v || '').replace(/[^\d.]/g, '')); if (!Number.isFinite(n) || !n) return null; return n > 1000 ? n / 100000 : n; };
async function search(filters, user, { limit = 50 } = {}) {
  const and = [scopeW(user)];
  if (filters.location) and.push({ OR: [{ location: { contains: filters.location } }, { preferredLocation: { contains: filters.location } }] });
  if (filters.minExp != null) and.push({ experienceYears: { gte: Number(filters.minExp) } });
  if (filters.maxExp != null) and.push({ experienceYears: { lte: Number(filters.maxExp) } });
  if (filters.education) and.push({ education: { contains: filters.education.replace(/\./g, '') } });
  const skills = (filters.skills || []).slice(0, 8);
  if (skills.length) and.push({ OR: skills.flatMap((s) => [{ skills: { contains: s } }, { technicalSkills: { contains: s } }, { currentDesignation: { contains: s } }]) });
  // the role word filters only when no skill was named; with skills it only ranks ("java developers" = java people, developers first)
  if (filters.title && !skills.length) and.push({ OR: [{ currentDesignation: { contains: filters.title } }, { skills: { contains: filters.title } }] });
  const rows = await prisma.candidate.findMany({
    where: { AND: and },
    select: { id: true, name: true, location: true, experienceYears: true, skills: true, technicalSkills: true, currentDesignation: true, currentCompany: true, noticePeriod: true, expectedSalary: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 3000,
  });
  const out = rows.filter((c) => {
    if (filters.noticeMaxDays != null) { const d = noticeDaysOf(c.noticePeriod); if (d == null || d > filters.noticeMaxDays) return false; }
    if (filters.maxSalary != null) { const l = lakhOf(c.expectedSalary); if (l != null && l > filters.maxSalary) return false; }
    return true;
  }).map((c) => {
    const hay = lower(`${c.skills} ${c.technicalSkills} ${c.currentDesignation}`);
    const hits = skills.filter((s) => hay.includes(lower(s))).length + (filters.title && lower(c.currentDesignation).includes(lower(filters.title)) ? 0.5 : 0);
    return { id: c.id, name: c.name, location: c.location, experienceYears: c.experienceYears, designation: c.currentDesignation, company: c.currentCompany, noticePeriod: c.noticePeriod, skills: csv(c.skills).slice(0, 8), hits };
  }).sort((a, b) => b.hits - a.hits || (b.experienceYears || 0) - (a.experienceYears || 0));
  return { total: out.length, rows: out.slice(0, limit), capped: rows.length >= 3000 };
}
function filterChips(f) {
  const chips = [];
  if (f.title) chips.push({ key: 'title', label: 'Role', value: f.title });
  if (f.skills && f.skills.length) chips.push({ key: 'skills', label: 'Skills', value: f.skills.join(', ') });
  if (f.location) chips.push({ key: 'location', label: 'Location', value: f.location });
  if (f.minExp != null || f.maxExp != null) chips.push({ key: 'exp', label: 'Experience', value: f.maxExp != null ? `${f.minExp != null ? f.minExp : 0}-${f.maxExp} years` : `${f.minExp}+ years` });
  if (f.noticeMaxDays != null) chips.push({ key: 'notice', label: 'Notice', value: f.noticeMaxDays === 0 ? 'Immediate' : `${f.noticeMaxDays} days or less` });
  if (f.maxSalary != null) chips.push({ key: 'salary', label: 'Expected salary', value: `up to ${f.maxSalary} lakh` });
  if (f.education) chips.push({ key: 'education', label: 'Education', value: f.education.toUpperCase() });
  return chips;
}
// the Candidates list address with the same filters (People tab)
function listLink(f) {
  const p = new URLSearchParams({ view: 'master' });
  if (f.skills && f.skills.length) p.set('skills', f.skills.join(','));
  if (f.location) p.set('location', f.location);
  if (f.minExp != null) p.set('minExp', String(f.minExp));
  if (f.maxExp != null) p.set('maxExp', String(f.maxExp));
  return `/candidates?${p.toString()}`;
}

// ---- 03.09 saved searches ----------------------------------------------------------------------------------------------------------
async function savedSearches(user) {
  const rows = await S.q('SELECT * FROM "MktSavedSearch" WHERE "userId" = ? OR "shared" = 1 ORDER BY "createdAt" DESC', user.id);
  return rows.map((r) => ({ id: r.id, name: r.name, query: r.query, filters: S.parse(r.filters, {}), alert: !!S.num(r.alert), shared: !!S.num(r.shared), mine: r.userId === user.id, ownerName: r.userName, lastRunAt: r.lastRunAt, newCount: S.num(r.newCount) }));
}
async function saveSearch(body, user) {
  const name = S.clean(body.name, 80);
  if (!name) return { error: 'Give the search a name.' };
  const query = S.clean(body.query, 300);
  const filters = body.filters && typeof body.filters === 'object' ? body.filters : (query ? await parseNl(query) : null);
  if (!filters) return { error: 'Type what to search for.' };
  const id = S.newId();
  const first = await search(filters, user, { limit: 2000 });
  await S.x('INSERT INTO "MktSavedSearch" ("id","userId","userName","name","query","filters","alert","shared","lastRunAt","seen","newCount","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?,0,?)',
    id, user.id, user.name, name, query, JSON.stringify(filters), body.alert ? 1 : 0, body.shared ? 1 : 0, S.now(), JSON.stringify(first.rows.map((r) => r.id)), S.now());
  return { id, total: first.total };
}
async function runSaved(id, user, { markSeen = true } = {}) {
  const [row] = await S.q('SELECT * FROM "MktSavedSearch" WHERE "id" = ?', id);
  if (!row || (row.userId !== user.id && !S.num(row.shared))) return { error: 'That saved search was not found.', status: 404 };
  const filters = S.parse(row.filters, {});
  const res = await search(filters, user, { limit: 2000 });
  const seen = new Set(S.parse(row.seen, []));
  const fresh = new Set(res.rows.filter((r) => !seen.has(r.id)).map((r) => r.id));
  if (markSeen && row.userId === user.id) await S.x('UPDATE "MktSavedSearch" SET "seen"=?,"lastRunAt"=?,"newCount"=0 WHERE "id"=?', JSON.stringify([...new Set([...seen, ...res.rows.map((r) => r.id)])].slice(-5000)), S.now(), id);
  return { id, name: row.name, filters, chips: filterChips(filters), total: res.total, newCount: fresh.size, rows: res.rows.slice(0, 50).map((r) => ({ ...r, isNew: fresh.has(r.id) })).sort((a, b) => Number(b.isNew) - Number(a.isNew)), link: listLink(filters) };
}
async function updateSaved(id, body, user) {
  const [row] = await S.q('SELECT * FROM "MktSavedSearch" WHERE "id" = ?', id);
  if (!row || row.userId !== user.id) return { error: 'Only the owner changes a saved search.', status: 403 };
  await S.x('UPDATE "MktSavedSearch" SET "alert"=?,"shared"=?,"name"=? WHERE "id"=?', body.alert === undefined ? S.num(row.alert) : (body.alert ? 1 : 0), body.shared === undefined ? S.num(row.shared) : (body.shared ? 1 : 0), S.clean(body.name, 80) || row.name, id);
  return { ok: true };
}
async function deleteSaved(id, user) {
  const n = await S.x('DELETE FROM "MktSavedSearch" WHERE "id" = ? AND "userId" = ?', id, user.id);
  return S.num(n) ? { ok: true } : { error: 'Only the owner deletes a saved search.', status: 403 };
}
async function savedSweep() {
  const on = await S.setting('alerts.savedSearch');
  const rows = await S.q('SELECT * FROM "MktSavedSearch" WHERE "alert" = 1');
  const { resolveIdentity } = require('../identity'); // eslint-disable-line global-require
  let told = 0;
  for (const r of rows.slice(0, 300)) {
    // eslint-disable-next-line no-await-in-loop
    const u = await resolveIdentity(r.userId).catch(() => null);
    if (!u) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const res = await search(S.parse(r.filters, {}), u, { limit: 2000 });
    const seen = new Set(S.parse(r.seen, []));
    const n = res.rows.filter((c) => !seen.has(c.id)).length;
    // eslint-disable-next-line no-await-in-loop
    await S.x('UPDATE "MktSavedSearch" SET "newCount"=? WHERE "id"=?', n, r.id);
    if (on && n > 0) {
      told += 1;
      // eslint-disable-next-line no-await-in-loop
      await require('../notify').notifyUsers([r.userId], { title: `New matches: ${r.name}`, message: `${n} new people match your saved search. Open Candidates > Hiring tools > Saved searches.`, open: '/candidates?view=tools' }).catch(() => {}); // eslint-disable-line global-require
    }
  }
  return { searches: rows.length, told };
}

// ---- 03.10 talent pools ---------------------------------------------------------------------------------------------------------------
async function pools(user) {
  const rows = await S.q('SELECT p.*, (SELECT COUNT(*) FROM "MktPoolMember" m WHERE m."poolId" = p."id") AS n FROM "MktPool" p WHERE p."ownerId" = ? OR p."shared" = 1 ORDER BY p."createdAt" DESC', user.id);
  return rows.map((r) => ({ id: r.id, name: r.name, note: r.note, shared: !!S.num(r.shared), mine: r.ownerId === user.id, ownerName: r.ownerName, members: S.num(r.n), createdAt: r.createdAt }));
}
async function poolOf(id, user) {
  const [p] = await S.q('SELECT * FROM "MktPool" WHERE "id" = ?', id);
  if (!p || (p.ownerId !== user.id && !S.num(p.shared))) return null;
  return p;
}
async function createPool(body, user) {
  const name = S.clean(body.name, 80);
  if (!name) return { error: 'Give the pool a name.' };
  const id = S.newId();
  await S.x('INSERT INTO "MktPool" ("id","name","note","ownerId","ownerName","shared","createdAt") VALUES (?,?,?,?,?,?,?)', id, name, S.clean(body.note, 300), user.id, user.name, body.shared ? 1 : 0, S.now());
  return { id, name };
}
async function updatePool(id, body, user) {
  const p = await poolOf(id, user);
  if (!p) return { error: 'Pool not found.', status: 404 };
  if (p.ownerId !== user.id) return { error: 'Only the owner changes the pool.', status: 403 };
  await S.x('UPDATE "MktPool" SET "name"=?,"note"=?,"shared"=? WHERE "id"=?', S.clean(body.name, 80) || p.name, body.note === undefined ? p.note : S.clean(body.note, 300), body.shared === undefined ? S.num(p.shared) : (body.shared ? 1 : 0), id);
  return { ok: true };
}
async function deletePool(id, user) {
  const p = await poolOf(id, user);
  if (!p || p.ownerId !== user.id) return { error: 'Only the owner deletes a pool.', status: 403 };
  await S.x('DELETE FROM "MktPoolMember" WHERE "poolId" = ?', id);
  await S.x('DELETE FROM "MktPool" WHERE "id" = ?', id);
  return { ok: true };
}
async function poolMembers(id, user) {
  const p = await poolOf(id, user);
  if (!p) return { error: 'Pool not found.', status: 404 };
  const rows = await S.q('SELECT "candidateId","addedByName","at" FROM "MktPoolMember" WHERE "poolId" = ? ORDER BY "at" DESC', id);
  const ids = rows.map((r) => r.candidateId);
  const cands = ids.length ? await prisma.candidate.findMany({ where: { AND: [scopeW(user), { id: { in: ids } }] }, select: { id: true, name: true, location: true, experienceYears: true, currentDesignation: true, skills: true, noticePeriod: true } }) : [];
  const byId = new Map(cands.map((c) => [c.id, c]));
  return { pool: { id: p.id, name: p.name, note: p.note, shared: !!S.num(p.shared), mine: p.ownerId === user.id, ownerName: p.ownerName }, rows: rows.filter((r) => byId.has(r.candidateId)).map((r) => ({ ...byId.get(r.candidateId), skills: csv(byId.get(r.candidateId).skills).slice(0, 6), addedByName: r.addedByName, at: r.at })), hidden: rows.length - cands.length };
}
async function addMembers(id, candidateIds, user) {
  const p = await poolOf(id, user);
  if (!p) return { error: 'Pool not found.', status: 404 };
  const ids = [...new Set((candidateIds || []).map(String))].slice(0, 500);
  const ok = ids.length ? await prisma.candidate.findMany({ where: { AND: [scopeW(user), { id: { in: ids } }] }, select: { id: true } }) : [];
  let added = 0;
  for (const c of ok) {
    // eslint-disable-next-line no-await-in-loop
    added += S.num(await S.x('INSERT OR IGNORE INTO "MktPoolMember" ("poolId","candidateId","addedByName","at") VALUES (?,?,?,?)', id, c.id, user.name, S.now()));
  }
  return { added, skipped: ids.length - added };
}
async function removeMembers(id, candidateIds, user) {
  const p = await poolOf(id, user);
  if (!p) return { error: 'Pool not found.', status: 404 };
  let removed = 0;
  for (const c of (candidateIds || []).slice(0, 500)) {
    // eslint-disable-next-line no-await-in-loop
    removed += S.num(await S.x('DELETE FROM "MktPoolMember" WHERE "poolId" = ? AND "candidateId" = ?', id, String(c)));
  }
  return { removed };
}
async function poolsOfCandidate(candidateId, user) {
  const rows = await S.q('SELECT p."id", p."name" FROM "MktPool" p JOIN "MktPoolMember" m ON m."poolId" = p."id" WHERE m."candidateId" = ? AND (p."ownerId" = ? OR p."shared" = 1)', candidateId, user.id);
  return rows;
}

// ---- 03.12 enrichment (own resume + own updates only) -------------------------------------------------------------------------------
const ENRICH_FIELDS = ['location', 'currentCompany', 'currentDesignation', 'education', 'experienceYears', 'noticePeriod', 'skills'];
async function enrichment(candidateId) {
  const c = await prisma.candidate.findUnique({ where: { id: candidateId } });
  if (!c) return { error: 'Not found', status: 404 };
  const res = await latestResume(candidateId);
  const parsed = S.parse(res && res.parsed, {}) || {};
  const PD = require('../candidateProfileDepth'); // eslint-disable-line global-require
  const jobs = await PD.employmentOf(candidateId).catch(() => []);
  const current = (jobs || []).find((j) => Number(j.isCurrent) === 1) || null;
  const out = [];
  const add = (field, value, from) => { if (value == null || value === '') return; out.push({ field, current: c[field] == null ? null : c[field], value, from }); };
  if (!c.location && parsed.location) add('location', parsed.location, 'resume');
  if (!c.currentCompany && current && current.company) add('currentCompany', current.company, 'career history');
  if (!c.currentDesignation && current && current.title) add('currentDesignation', current.title, 'career history');
  if (!c.education && parsed.highestEducation) add('education', parsed.highestEducation, 'resume');
  if (c.experienceYears == null && parsed.totalExperienceYears != null) add('experienceYears', Number(parsed.totalExperienceYears), 'resume');
  if (!c.noticePeriod && parsed.noticePeriod) add('noticePeriod', parsed.noticePeriod, 'resume');
  const have = new Set(csv(c.skills).map(lower));
  const more = (parsed.skills || []).map(String).filter((s) => s && !have.has(lower(s))).slice(0, 10);
  if (more.length) add('skills', [...csv(c.skills), ...more].join(', '), `resume (${more.length} more)`);
  const links = String((res && res.text) || '').match(/https?:\/\/(?:www\.)?(?:linkedin\.com\/in|github\.com)\/[A-Za-z0-9_-]+/gi) || [];
  return { proposals: out, links: [...new Set(links)].slice(0, 3), resume: res ? { fileName: res.fileName, at: res.createdAt } : null, note: 'Only the person\'s own resume and their own updates are used. Nothing is looked up outside.' };
}
async function applyEnrichment(candidateId, fields, user) {
  const c = await prisma.candidate.findUnique({ where: { id: candidateId } });
  if (!c) return { error: 'Not found', status: 404 };
  const data = {};
  Object.entries(fields || {}).forEach(([k, v]) => {
    if (!ENRICH_FIELDS.includes(k)) return;
    if (k === 'experienceYears') { const n = Number(v); if (Number.isFinite(n) && n >= 0 && n < 60) data[k] = n; return; }
    const s = S.clean(v, k === 'skills' ? 1000 : 120); if (s) data[k] = s;
  });
  if (!Object.keys(data).length) return { error: 'Nothing to apply.' };
  await prisma.candidate.update({ where: { id: candidateId }, data });
  try { require('../candidateListCache').markCandidateDirty(candidateId); } catch { /* optional */ } // eslint-disable-line global-require
  await require('../audit').logAudit({ userId: user.id, action: 'Profile enriched from own resume', entity: 'Candidate', entityId: candidateId, fromValue: JSON.stringify(Object.fromEntries(Object.keys(data).map((k) => [k, c[k]]))).slice(0, 300), toValue: JSON.stringify(data).slice(0, 300) }); // eslint-disable-line global-require
  return { updated: Object.keys(data) };
}

// ---- 03.13 stale profiles / job changes --------------------------------------------------------------------------------------------
async function staleProfiles(user, { days = null, limit = 100 } = {}) {
  const d = Number(days) || Number(await S.setting('stale.days')) || 180;
  const cutoff = new Date(Date.now() - d * 864e5);
  const rows = await prisma.candidate.findMany({
    where: { AND: [scopeW(user), { createdAt: { lt: cutoff } }, { applications: { none: { updatedAt: { gte: cutoff } } } }, { doNotContact: false }] },
    select: { id: true, name: true, location: true, currentDesignation: true, currentCompany: true, createdAt: true },
    orderBy: { createdAt: 'asc' }, take: Math.min(500, limit),
  });
  const links = rows.length ? await S.q(`SELECT "candidateId", MAX("createdAt") AS sent, MAX("usedAt") AS used FROM "MktUpdateLink" WHERE "candidateId" IN (${rows.map(() => '?').join(',')}) GROUP BY "candidateId"`, ...rows.map((r) => r.id)) : [];
  const L = new Map(links.map((l) => [l.candidateId, l]));
  const fresh = rows.filter((r) => { const l = L.get(r.id); return !(l && l.used && new Date(l.used) >= cutoff); });
  return { days: d, total: fresh.length, rows: fresh.map((r) => ({ ...r, linkSentAt: (L.get(r.id) || {}).sent || null })) };
}
async function jobChanges(user) {
  const rows = await S.q('SELECT "candidateId","usedAt","changes" FROM "MktUpdateLink" WHERE "usedAt" IS NOT NULL ORDER BY "usedAt" DESC LIMIT 300');
  const list = rows.map((r) => ({ ...r, changes: S.parse(r.changes, {}) })).filter((r) => r.changes && r.changes.currentCompany);
  const ids = list.map((r) => r.candidateId);
  const ok = ids.length ? new Map((await prisma.candidate.findMany({ where: { AND: [scopeW(user), { id: { in: ids } }] }, select: { id: true, name: true } })).map((c) => [c.id, c.name])) : new Map();
  return list.filter((r) => ok.has(r.candidateId)).map((r) => ({ candidateId: r.candidateId, name: ok.get(r.candidateId), at: r.usedAt, from: r.changes.currentCompany.from, to: r.changes.currentCompany.to }));
}

// weekly, only with alerts.staleProfile ON: one bell per recruiter with how many of their people are stale (send them the update link)
async function staleSweep() {
  if (!(await S.setting('alerts.staleProfile'))) return { off: true, told: 0 };
  const d = Number(await S.setting('stale.days')) || 180;
  const cutoff = new Date(Date.now() - d * 864e5);
  const apps = await prisma.application.findMany({ where: { ownerRecruiterId: { not: null }, updatedAt: { lt: cutoff }, candidate: { createdAt: { lt: cutoff }, doNotContact: false, applications: { none: { updatedAt: { gte: cutoff } } } } }, select: { ownerRecruiterId: true, candidateId: true }, take: 50000 });
  const by = new Map();
  apps.forEach((a) => { if (!by.has(a.ownerRecruiterId)) by.set(a.ownerRecruiterId, new Set()); by.get(a.ownerRecruiterId).add(a.candidateId); });
  let told = 0;
  for (const [uid, set] of by) {
    told += 1;
    // eslint-disable-next-line no-await-in-loop
    await require('../notify').notifyUsers([uid], { title: 'Profiles to refresh', message: `${set.size} of your people have not been updated for ${d}+ days. Send them the update link (Candidates > Hiring tools > Records to refresh).`, open: '/candidates?view=tools&tool=records' }).catch(() => {}); // eslint-disable-line global-require
  }
  return { told };
}

// ---- 03.17 profile-update link ---------------------------------------------------------------------------------------------------------
const LINK_DAYS = 14;
const SELF_FIELDS = { location: 120, preferredLocation: 200, currentCompany: 120, currentDesignation: 120, experienceYears: 0, noticePeriod: 60, expectedSalary: 60, currentSalary: 60, skills: 1000, education: 120 };
async function createLink(candidateId, user, origin) {
  const token = crypto.randomBytes(24).toString('base64url');
  const id = S.newId();
  await S.x('INSERT INTO "MktUpdateLink" ("id","candidateId","tokenHash","createdById","createdByName","createdAt","expiresAt") VALUES (?,?,?,?,?,?,?)',
    id, candidateId, S.hash(token), user.id, user.name, S.now(), new Date(Date.now() + LINK_DAYS * 864e5).toISOString());
  const base = String(origin || process.env.APP_URL || process.env.FRONTEND_URL || '').replace(/\/$/, '');
  return { id, url: `${base}/update-profile/${token}`, expiresAt: new Date(Date.now() + LINK_DAYS * 864e5).toISOString(), note: 'Send this link to the person yourself (WhatsApp / e-mail). It works once and ends in 14 days. Nothing is sent automatically.' };
}
async function linkByToken(token) {
  if (!token || String(token).length < 20) return null;
  const [row] = await S.q('SELECT * FROM "MktUpdateLink" WHERE "tokenHash" = ?', S.hash(token));
  if (!row) return null;
  if (row.usedAt) return { ...row, problem: 'This link was already used. Ask your recruiter for a new one if something else changed.' };
  if (new Date(row.expiresAt) < new Date()) return { ...row, problem: 'This link has ended. Ask your recruiter for a new one.' };
  return row;
}
async function linkView(token) {
  const row = await linkByToken(token);
  if (!row) return { error: 'This link is not valid.', status: 404 };
  if (row.problem) return { error: row.problem, status: 410 };
  const c = await prisma.candidate.findUnique({ where: { id: row.candidateId } });
  if (!c) return { error: 'This link is not valid.', status: 404 };
  const values = {};
  Object.keys(SELF_FIELDS).forEach((k) => { values[k] = c[k] == null ? '' : c[k]; });
  return { firstName: String(c.name || '').split(' ')[0], values, fields: Object.keys(SELF_FIELDS), expiresAt: row.expiresAt };
}
async function linkSubmit(token, body) {
  const row = await linkByToken(token);
  if (!row) return { error: 'This link is not valid.', status: 404 };
  if (row.problem) return { error: row.problem, status: 410 };
  const c = await prisma.candidate.findUnique({ where: { id: row.candidateId } });
  if (!c) return { error: 'This link is not valid.', status: 404 };
  const data = {}; const changes = {};
  Object.entries(SELF_FIELDS).forEach(([k, max]) => {
    if (!body || body[k] === undefined) return;
    let v;
    if (k === 'experienceYears') { const n = Number(body[k]); if (body[k] === '' || !Number.isFinite(n) || n < 0 || n > 60) return; v = n; } else { v = S.clean(body[k], max); if (!v) return; }
    if (String(c[k] == null ? '' : c[k]) !== String(v)) { data[k] = v; changes[k] = { from: c[k] == null ? null : c[k], to: v }; }
  });
  await S.x('UPDATE "MktUpdateLink" SET "usedAt"=?,"changes"=? WHERE "id"=?', S.now(), JSON.stringify(changes), row.id);
  if (!Object.keys(data).length) return { ok: true, changed: 0, message: 'Thank you. Nothing needed changing.' };
  await prisma.candidate.update({ where: { id: c.id }, data });
  try { require('../candidateListCache').markCandidateDirty(c.id); } catch { /* optional */ } // eslint-disable-line global-require
  const lines = Object.entries(changes).map(([k, v]) => `${k}: ${v.from == null ? '-' : v.from} -> ${v.to}`).join('; ');
  await prisma.candidateNote.create({ data: { candidateId: c.id, body: `Updated by ${c.name} through the profile-update link: ${lines}`.slice(0, 2000), authorName: `${c.name} (self)`, authorRole: 'CANDIDATE' } }).catch(() => {});
  await require('../audit').logAudit({ action: 'Profile updated by the candidate (update link)', entity: 'Candidate', entityId: c.id, toValue: lines.slice(0, 300), actorName: `${c.name} (self)` }); // eslint-disable-line global-require
  if (changes.currentCompany && await S.setting('alerts.staleProfile')) {
    const owners = await prisma.application.findMany({ where: { candidateId: c.id }, select: { ownerRecruiterId: true }, take: 20 });
    await require('../notify').notifyUsers([...new Set([row.createdById, ...owners.map((o) => o.ownerRecruiterId)].filter(Boolean))], { title: `Job change: ${c.name}`, message: `${c.name} now works at ${changes.currentCompany.to} (was ${changes.currentCompany.from || 'not given'}).`, open: `/candidates/${c.id}` }).catch(() => {}); // eslint-disable-line global-require
  }
  return { ok: true, changed: Object.keys(data).length, message: 'Thank you. Your details are updated.' };
}
async function linksOf(candidateId) {
  return S.q('SELECT "id","createdByName","createdAt","expiresAt","usedAt" FROM "MktUpdateLink" WHERE "candidateId" = ? ORDER BY "createdAt" DESC LIMIT 10', candidateId);
}

// ---- 03.18 document expiry ---------------------------------------------------------------------------------------------------------
async function docExpiry(candidateId) {
  const docs = await prisma.candidateDocument.findMany({ where: { candidateId, deletedAt: null }, select: { id: true, docType: true, name: true, createdAt: true } });
  const rows = docs.length ? await S.q(`SELECT * FROM "MktDocExpiry" WHERE "documentId" IN (${docs.map(() => '?').join(',')})`, ...docs.map((d) => d.id)) : [];
  const E = new Map(rows.map((r) => [r.documentId, r]));
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  return docs.map((d) => { const e = E.get(d.id); const on = e ? e.expiresOn : null; return { ...d, expiresOn: on, state: !on ? null : on < today ? 'Expired' : on <= soon ? 'Expiring soon' : 'Valid' }; });
}
async function setDocExpiry(documentId, expiresOn, user) {
  const doc = await prisma.candidateDocument.findUnique({ where: { id: documentId }, select: { id: true, candidateId: true, deletedAt: true } });
  if (!doc || doc.deletedAt) return { error: 'Document not found.', status: 404 };
  if (!expiresOn) { await S.x('DELETE FROM "MktDocExpiry" WHERE "documentId" = ?', documentId); return { ok: true, cleared: true, candidateId: doc.candidateId }; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(expiresOn)) || Number.isNaN(Date.parse(expiresOn))) return { error: 'Use a date like 2027-03-31.' };
  await S.x('INSERT INTO "MktDocExpiry" ("documentId","candidateId","expiresOn","byName","at") VALUES (?,?,?,?,?) ON CONFLICT("documentId") DO UPDATE SET "expiresOn"=excluded."expiresOn","alertedAt"=NULL,"byName"=excluded."byName","at"=excluded."at"', documentId, doc.candidateId, expiresOn, user.name, S.now());
  return { ok: true, candidateId: doc.candidateId };
}
async function expiringDocs(user, { days = 30 } = {}) {
  const until = new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
  const rows = await S.q('SELECT * FROM "MktDocExpiry" WHERE "expiresOn" <= ? ORDER BY "expiresOn" ASC LIMIT 500', until);
  if (!rows.length) return { rows: [] };
  const ok = new Map((await prisma.candidate.findMany({ where: { AND: [scopeW(user), { id: { in: [...new Set(rows.map((r) => r.candidateId))] } }] }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
  const docs = new Map((await prisma.candidateDocument.findMany({ where: { id: { in: rows.map((r) => r.documentId) }, deletedAt: null }, select: { id: true, name: true, docType: true } })).map((d) => [d.id, d]));
  const today = new Date().toISOString().slice(0, 10);
  return { rows: rows.filter((r) => ok.has(r.candidateId) && docs.has(r.documentId)).map((r) => ({ documentId: r.documentId, candidateId: r.candidateId, name: ok.get(r.candidateId), document: docs.get(r.documentId).name, docType: docs.get(r.documentId).docType, expiresOn: r.expiresOn, state: r.expiresOn < today ? 'Expired' : 'Expiring soon' })) };
}
async function docExpirySweep() {
  if (!(await S.setting('alerts.docExpiry'))) return { told: 0, off: true };
  const until = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const rows = await S.q('SELECT * FROM "MktDocExpiry" WHERE "expiresOn" <= ? AND "alertedAt" IS NULL LIMIT 300', until);
  let told = 0;
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    const apps = await prisma.application.findMany({ where: { candidateId: r.candidateId }, select: { ownerRecruiterId: true, candidate: { select: { name: true } } }, take: 10 });
    const ids = [...new Set(apps.map((a) => a.ownerRecruiterId).filter(Boolean))];
    if (ids.length) {
      told += 1;
      // eslint-disable-next-line no-await-in-loop
      await require('../notify').notifyUsers(ids, { title: 'Document expiring', message: `A document of ${apps[0].candidate.name} expires on ${r.expiresOn}. Ask for a new copy.`, open: `/candidates/${r.candidateId}?tab=documents` }).catch(() => {}); // eslint-disable-line global-require
    }
    // eslint-disable-next-line no-await-in-loop
    await S.x('UPDATE "MktDocExpiry" SET "alertedAt"=? WHERE "documentId"=?', S.now(), r.documentId);
  }
  return { told };
}

// ---- 03.20 fraud signals -----------------------------------------------------------------------------------------------------------
const normName = (s) => lower(s).replace(/[^a-z]/g, '');
const digits = (s) => String(s || '').replace(/\D/g, '').slice(-10);
const PROXY = /\bproxy\b|impersonat|different person|someone else (?:was )?(?:answer|speak|talk)|lip.?sync|not the same person|camera (?:was )?off (?:the )?whole|voice (?:did not|didn't) match|reading from (?:the )?screen|prompted by someone/i;
async function addFlag(key, candidateId, otherId, kind, detail) {
  return S.num(await S.x('INSERT OR IGNORE INTO "MktFraudFlag" ("id","key","candidateId","otherCandidateId","kind","detail","createdAt") VALUES (?,?,?,?,?,?,?)', S.newId(), key, candidateId, otherId, kind, S.clean(detail, 400), S.now()));
}
async function fraudScan() {
  let added = 0;
  // raw SQL: alternatePhone is a newer column than some generated clients know
  const people = await prisma.$queryRawUnsafe('SELECT "id","name","phone","alternatePhone","email","experienceYears","dob" FROM "Candidate"')
    .catch(() => prisma.candidate.findMany({ select: { id: true, name: true, phone: true, email: true, experienceYears: true, dob: true } }));
  const byPhone = new Map(); const byEmail = new Map();
  people.forEach((p) => {
    [p.phone, p.alternatePhone].map(digits).filter((d) => d.length === 10).forEach((d) => { if (!byPhone.has(d)) byPhone.set(d, []); byPhone.get(d).push(p); });
    const e = lower(p.email).trim(); if (e && e.includes('@')) { if (!byEmail.has(e)) byEmail.set(e, []); byEmail.get(e).push(p); }
  });
  const pairs = async (map, kind, what) => {
    for (const list of map.values()) {
      if (list.length < 2 || list.length > 6) continue; // eslint-disable-line no-continue
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          const a = list[i]; const b = list[j];
          if (a.id === b.id || normName(a.name) === normName(b.name) || !normName(a.name) || !normName(b.name)) continue; // eslint-disable-line no-continue
          const [x1, x2] = [a.id, b.id].sort();
          // eslint-disable-next-line no-await-in-loop
          added += await addFlag(`${kind}|${x1}|${x2}`, x1, x2, kind, `${what} is on two people with different names: ${a.name} and ${b.name}.`);
        }
      }
    }
  };
  await pairs(byPhone, 'Same phone, different name', 'The same phone number');
  await pairs(byEmail, 'Same email, different name', 'The same e-mail address');
  // the same file (photo / ID / resume bytes) on people with different names
  const docs = await prisma.candidateDocument.findMany({ where: { sha256: { not: null }, deletedAt: null }, select: { candidateId: true, sha256: true, docType: true } });
  const resumes = await prisma.candidateResume.findMany({ where: { sha256: { not: null }, kind: 'ORIGINAL' }, select: { candidateId: true, sha256: true } });
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  const bySha = new Map();
  [...docs.map((d) => ({ ...d, what: d.docType || 'document' })), ...resumes.map((r) => ({ ...r, what: 'resume' }))].forEach((d) => { if (!bySha.has(d.sha256)) bySha.set(d.sha256, []); bySha.get(d.sha256).push(d); });
  for (const list of bySha.values()) {
    const ids = [...new Set(list.map((d) => d.candidateId))];
    if (ids.length < 2 || ids.length > 6) continue; // eslint-disable-line no-continue
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        if (normName(nameOf.get(ids[i])) === normName(nameOf.get(ids[j]))) continue; // eslint-disable-line no-continue
        const [x1, x2] = [ids[i], ids[j]].sort();
        // eslint-disable-next-line no-await-in-loop
        added += await addFlag(`Same file|${x1}|${x2}`, x1, x2, 'Same file, different name', `The very same ${list[0].what} file is on ${nameOf.get(x1)} and ${nameOf.get(x2)}.`);
      }
    }
  }
  // experience that does not add up (career history / age)
  const PD = require('../candidateProfileDepth'); // eslint-disable-line global-require
  await PD.ensure();
  const jobs = await prisma.$queryRawUnsafe('SELECT "candidateId","company","fromMonth","toMonth","isCurrent" FROM "CandidateEmployment"').catch(() => []);
  const byCand = new Map();
  jobs.forEach((j) => { if (!byCand.has(j.candidateId)) byCand.set(j.candidateId, []); byCand.get(j.candidateId).push(j); });
  const monthNo = (m) => { const x = String(m || '').match(/^(\d{4})-(\d{2})/); return x ? Number(x[1]) * 12 + Number(x[2]) - 1 : null; };
  const nowM = new Date().getFullYear() * 12 + new Date().getMonth();
  for (const p of people) {
    const list = byCand.get(p.id) || [];
    const spans = list.map((j) => ({ c: j.company, a: monthNo(j.fromMonth), b: Number(j.isCurrent) ? nowM : monthNo(j.toMonth) })).filter((s) => s.a != null && s.b != null && s.b >= s.a);
    if (spans.length && p.experienceYears != null) {
      // the union of the job months
      const months = new Set(); spans.forEach((s) => { for (let m = s.a; m <= s.b && m - s.a < 600; m += 1) months.add(m); });
      const histYears = months.size / 12;
      if (Math.abs(histYears - p.experienceYears) >= 3) added += await addFlag(`Experience|${p.id}`, p.id, null, 'Experience does not add up', `Profile says ${p.experienceYears} years; the career history adds up to ${histYears.toFixed(1)} years.`); // eslint-disable-line no-await-in-loop
      for (let i = 0; i < spans.length; i += 1) {
        for (let j = i + 1; j < spans.length; j += 1) {
          const overlap = Math.min(spans[i].b, spans[j].b) - Math.max(spans[i].a, spans[j].a);
          if (overlap >= 6) { added += await addFlag(`Overlap|${p.id}`, p.id, null, 'Two full jobs at once', `${spans[i].c || 'A job'} and ${spans[j].c || 'another job'} overlap by ${overlap} months.`); i = spans.length; break; } // eslint-disable-line no-await-in-loop
        }
      }
    }
    const born = String(p.dob || '').match(/(19|20)\d\d/);
    if (born && p.experienceYears != null) {
      const age = new Date().getFullYear() - Number(born[0]);
      if (age > 10 && p.experienceYears > age - 16) added += await addFlag(`Age|${p.id}`, p.id, null, 'Experience longer than possible', `About ${age} years old but ${p.experienceYears} years of experience.`); // eslint-disable-line no-await-in-loop
    }
  }
  // proxy-interview words in feedback
  const fb = await prisma.interviewFeedback.findMany({ select: { overall: true, application: { select: { candidateId: true } } } });
  const pan = await prisma.interviewPanelist.findMany({ where: { overall: { not: null } }, select: { overall: true, application: { select: { candidateId: true } } } }).catch(() => []);
  const apps = await prisma.application.findMany({ where: { interviewFeedback: { not: null } }, select: { candidateId: true, interviewFeedback: true } });
  for (const r of [...fb.map((f) => ({ cid: f.application.candidateId, t: f.overall })), ...pan.map((f) => ({ cid: f.application.candidateId, t: f.overall })), ...apps.map((a) => ({ cid: a.candidateId, t: a.interviewFeedback }))]) {
    const m = String(r.t || '').match(PROXY);
    if (m) added += await addFlag(`Proxy|${r.cid}`, r.cid, null, 'Proxy-interview signal', `Interview feedback says: "...${String(r.t).slice(Math.max(0, m.index - 40), m.index + 60).trim()}..."`); // eslint-disable-line no-await-in-loop
  }
  return { added, at: S.now() };
}
async function fraudFlags(user, { status = 'Open', candidateId = null } = {}) {
  const rows = await S.q(`SELECT * FROM "MktFraudFlag" WHERE "status" = ? ${candidateId ? 'AND ("candidateId" = ? OR "otherCandidateId" = ?)' : ''} ORDER BY "createdAt" DESC LIMIT 500`, status, ...(candidateId ? [candidateId, candidateId] : []));
  const ids = [...new Set(rows.flatMap((r) => [r.candidateId, r.otherCandidateId].filter(Boolean)))];
  const ok = ids.length ? new Map((await prisma.candidate.findMany({ where: { AND: [scopeW(user), { id: { in: ids } }] }, select: { id: true, name: true } })).map((c) => [c.id, c.name])) : new Map();
  return rows.filter((r) => ok.has(r.candidateId) || (r.otherCandidateId && ok.has(r.otherCandidateId))).map((r) => ({ ...r, name: ok.get(r.candidateId) || 'Another team\'s candidate', otherName: r.otherCandidateId ? (ok.get(r.otherCandidateId) || 'Another team\'s candidate') : null }));
}
async function decideFraud(id, status, note, user) {
  if (!['Cleared', 'Confirmed'].includes(status)) return { error: 'Clear or confirm the flag.' };
  if (!S.clean(note, 300)) return { error: 'Add a short note: what did you check?' };
  const [row] = await S.q('SELECT * FROM "MktFraudFlag" WHERE "id" = ?', id);
  if (!row) return { error: 'Flag not found.', status: 404 };
  await S.x('UPDATE "MktFraudFlag" SET "status"=?,"reviewerName"=?,"reviewedAt"=?,"note"=? WHERE "id"=?', status, user.name, S.now(), S.clean(note, 300), id);
  if (status === 'Confirmed') await require('../candidateProfileDepth').addTag(row.candidateId, 'Fraud risk', user).catch(() => {}); // eslint-disable-line global-require
  return { ok: true, candidateId: row.candidateId, kind: row.kind };
}

// ---- 03.21 bulk profile review -------------------------------------------------------------------------------------------------------
// The score uses ONLY job-related facts: never the name, gender, age, photo or address (the fairness test checks this).
function reviewScore(c, job) {
  const factors = [];
  let score = 0;
  const need = csv(job.skills).map(lower);
  const have = new Set([...csv(c.skills), ...csv(c.technicalSkills)].map(lower));
  if (need.length) {
    const hit = need.filter((s) => have.has(s) || [...have].some((h) => h.includes(s) || s.includes(h)));
    const pct = hit.length / need.length;
    score += Math.round(pct * 45);
    factors.push({ factor: 'Must-have skills', detail: `${hit.length} of ${need.length}${hit.length ? ` (${hit.slice(0, 5).join(', ')})` : ''}`, points: Math.round(pct * 45) });
  } else { score += 25; factors.push({ factor: 'Must-have skills', detail: 'The job lists none', points: 25 }); }
  const range = String(job.experience || '').match(/\d+(?:\.\d+)?/g) || [];
  const lo = range[0] != null ? Number(range[0]) : null; const hi = range[1] != null ? Number(range[1]) : null;
  if (c.experienceYears == null) factors.push({ factor: 'Experience', detail: 'Not given', points: 0 });
  else if (lo == null || (c.experienceYears >= lo && (hi == null || c.experienceYears <= hi + 1))) { score += 25; factors.push({ factor: 'Experience', detail: `${c.experienceYears} years fits ${job.experience || 'the job'}`, points: 25 }); }
  else if (lo != null && c.experienceYears >= lo - 1) { score += 12; factors.push({ factor: 'Experience', detail: `${c.experienceYears} years, close to ${job.experience}`, points: 12 }); }
  else factors.push({ factor: 'Experience', detail: `${c.experienceYears} years, outside ${job.experience}`, points: 0 });
  if (!job.location || /any|remote/i.test(job.location)) { score += 10; factors.push({ factor: 'Location', detail: 'Any place', points: 10 }); }
  else if (lower(`${c.location} ${c.preferredLocation}`).includes(lower(String(job.location).split(',')[0]))) { score += 10; factors.push({ factor: 'Location', detail: `In / open to ${job.location}`, points: 10 }); }
  else factors.push({ factor: 'Location', detail: c.location ? `Lives in ${c.location}` : 'Not given', points: 0 });
  const nd = noticeDaysOf(c.noticePeriod); const nmax = noticeDaysOf(job.noticePeriodMax);
  if (nd != null && (nmax == null || nd <= nmax)) { score += 10; factors.push({ factor: 'Notice period', detail: c.noticePeriod, points: 10 }); } else factors.push({ factor: 'Notice period', detail: c.noticePeriod || 'Not given', points: 0 });
  const complete = ['currentDesignation', 'education', 'expectedSalary', 'currentSalary'].filter((k) => c[k]).length;
  score += complete * 2.5;
  factors.push({ factor: 'Profile complete', detail: `${complete} of 4 key fields`, points: complete * 2.5 });
  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, verdict: score >= 75 ? 'Strong fit' : score >= 50 ? 'Possible fit' : 'Not a fit', factors };
}
async function bulkReview(candidateIds, requirementId, user, { useAi = false } = {}) {
  const job = requirementId ? await prisma.requirement.findFirst({ where: { AND: [require('../scope').requirementWhere(user), { id: requirementId }] } }) : null; // eslint-disable-line global-require
  if (requirementId && !job) return { error: 'Requirement not found in your scope.', status: 404 };
  const ids = [...new Set((candidateIds || []).map(String))].slice(0, 50);
  if (!ids.length) return { error: 'Pick the people to review (50 at most).' };
  const cands = await prisma.candidate.findMany({ where: { AND: [scopeW(user), { id: { in: ids } }] } });
  const out = [];
  let aiUsed = 0;
  for (const c of cands) {
    const r = reviewScore(c, job || { skills: c.skills });
    let summary = `${r.verdict} (${r.score}%): ${r.factors.filter((f) => f.points > 0).map((f) => f.factor.toLowerCase()).join(', ') || 'few matching facts'}.`;
    let source = 'rules';
    if (useAi && aiUsed < 20) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const a = await require('../fastAi').chat('You review a candidate profile for a recruiter. Use ONLY the facts given. Never mention or use name, gender, age, religion, caste or photo. One or two plain sentences: strengths and the main gap.', [{ role: 'user', content: `Job: ${job ? `${job.title}; skills ${job.skills || '-'}; experience ${job.experience || '-'}; location ${job.location || '-'}` : 'general review'}\nProfile: skills ${c.skills || '-'}; experience ${c.experienceYears ?? '-'} years; designation ${c.currentDesignation || '-'}; location ${c.location || '-'}; notice ${c.noticePeriod || '-'}; education ${c.education || '-'}\nRule score: ${r.score} (${r.verdict})` }], { maxTokens: 160, temperature: 0.1, purpose: 'Profile review', fallbackToApp: false, deadlineMs: 12000 }); // eslint-disable-line global-require
        if (a && a.text) { summary = String(a.text).trim().slice(0, 400); source = 'rules+ai'; aiUsed += 1; }
      } catch { /* the rules line stands */ }
    }
    const id = S.newId();
    // eslint-disable-next-line no-await-in-loop
    await S.x('INSERT INTO "MktProfileReview" ("id","candidateId","requirementId","verdict","score","summary","factors","source","byName","at") VALUES (?,?,?,?,?,?,?,?,?,?)', id, c.id, requirementId || null, r.verdict, r.score, summary, JSON.stringify(r.factors), source, user.name, S.now());
    if (r.verdict === 'Not a fit') {
      // eslint-disable-next-line no-await-in-loop
      await require('./gov').addReview({ kind: 'AI profile review', refType: 'ProfileReview', refId: id, candidateId: c.id, summary: `${c.name}: ${summary}${job ? ` (for ${job.title})` : ''}`, aiDecision: 'Not a fit' }); // eslint-disable-line global-require
    }
    out.push({ id, candidateId: c.id, name: c.name, score: r.score, verdict: r.verdict, summary, factors: r.factors, source });
  }
  out.sort((a, b) => b.score - a.score);
  return { requirement: job ? { id: job.id, title: job.title } : null, rows: out, skipped: ids.length - cands.length };
}
async function reviewsOf(candidateId) {
  const rows = await S.q('SELECT * FROM "MktProfileReview" WHERE "candidateId" = ? ORDER BY "at" DESC LIMIT 10', candidateId);
  return rows.map((r) => ({ ...r, score: S.num(r.score), factors: S.parse(r.factors, []) }));
}

// ---- 03.15 / 09.12 formatted client resume ---------------------------------------------------------------------------------------------
async function resumeContent(candidateId, { useAi = true } = {}) {
  const c = await prisma.candidate.findUnique({ where: { id: candidateId } });
  if (!c) return null;
  const PD = require('../candidateProfileDepth'); // eslint-disable-line global-require
  const [edu, jobs, res] = await Promise.all([PD.educationOf(candidateId).catch(() => []), PD.employmentOf(candidateId).catch(() => []), latestResume(candidateId)]);
  const G = require('./gov'); // eslint-disable-line global-require
  const scrub = (s) => G.maskText(String(s || '')).text.replace(/\[(EMAIL|PHONE|ID|PAN|AADHAAR)_\d+\]/g, '').replace(/\s{2,}/g, ' ').trim();
  const skills = [...new Set([...csv(c.skills), ...csv(c.technicalSkills)])].slice(0, 20);
  const headline = [c.currentDesignation, c.experienceYears != null ? `${c.experienceYears} years` : null, c.location].filter(Boolean).join(' · ');
  let summary = [c.currentDesignation ? `${c.currentDesignation}` : 'Professional', c.experienceYears != null ? `with ${c.experienceYears} years of experience` : '', c.currentCompany ? `, currently at ${c.currentCompany}` : '', skills.length ? `. Strong in ${skills.slice(0, 5).join(', ')}` : '', c.education ? `. Education: ${c.education}` : '', '.'].join('').replace(/\.\./g, '.');
  let source = 'rules';
  if (useAi && res && res.text) {
    try {
      const a = await require('../fastAi').chat('Write a 3-sentence professional summary of this resume for a client. Facts only from the text. No name, no contact details, no age, gender, religion or photo. Plain English.', [{ role: 'user', content: String(res.text).slice(0, 5000) }], { maxTokens: 220, temperature: 0.2, purpose: 'Resume formatting', fallbackToApp: false, deadlineMs: 15000 }); // eslint-disable-line global-require
      if (a && a.text && a.text.length > 40) { summary = scrub(a.text).slice(0, 700); source = 'ai'; }
    } catch { /* rules summary */ }
  }
  const experience = (jobs || []).map((j) => ({ title: scrub(j.title || ''), company: scrub(j.company || ''), from: j.fromMonth || '', to: Number(j.isCurrent) ? 'Now' : (j.toMonth || ''), notes: scrub(j.notes || '').slice(0, 300) }));
  if (!experience.length && c.currentCompany) experience.push({ title: c.currentDesignation || '', company: c.currentCompany, from: '', to: 'Now', notes: '' });
  const education = (edu || []).map((e) => ({ degree: e.degree, specialisation: e.specialisation, institute: e.institute, year: e.year }));
  if (!education.length && c.education) education.push({ degree: c.education, specialisation: c.specialization, institute: c.institute, year: c.passingYear });
  return { ref: `CAN-${String(c.id).slice(-6).toUpperCase()}`, name: c.name, headline, summary: scrub(summary), skills, experience, education, notice: c.noticePeriod || null, languages: c.languagesKnown || null, source };
}
function resumePdf(content, { brand = 'TeamLink', showName = true } = {}) {
  const PDFDocument = require('pdfkit'); // eslint-disable-line global-require
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Candidate profile ${content.ref}`, Author: brand } });
  const chunks = [];
  doc.on('data', (b) => chunks.push(b));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  doc.rect(0, 0, doc.page.width, 64).fill('#1f3a5f');
  doc.fillColor('#ffffff').fontSize(18).text(brand, 48, 22, { continued: false });
  doc.fontSize(9).text('Candidate profile - shared in confidence. Contact through us.', 48, 44);
  doc.fillColor('#111111').moveDown(2);
  doc.y = 84;
  doc.fontSize(20).text(showName ? content.name : `Candidate ${content.ref}`);
  doc.fontSize(10).fillColor('#555555').text(`${content.headline || ''}   Ref: ${content.ref}`);
  doc.moveDown(0.8).fillColor('#111111');
  const section = (title) => { doc.moveDown(0.6).fontSize(12).fillColor('#1f3a5f').text(title.toUpperCase()); doc.moveTo(48, doc.y + 2).lineTo(doc.page.width - 48, doc.y + 2).strokeColor('#c9d3e0').stroke(); doc.moveDown(0.4).fontSize(10).fillColor('#111111'); };
  section('Summary'); doc.text(content.summary || '-', { align: 'left' });
  if (content.skills.length) { section('Key skills'); doc.text(content.skills.join('  ·  ')); }
  if (content.experience.length) {
    section('Experience');
    content.experience.forEach((e) => { doc.font('Helvetica-Bold').text(`${e.title || 'Role'}${e.company ? ` - ${e.company}` : ''}`); doc.font('Helvetica').fillColor('#555555').text([e.from, e.to].filter(Boolean).join(' to ')); doc.fillColor('#111111'); if (e.notes) doc.text(e.notes); doc.moveDown(0.3); });
  }
  if (content.education.length) { section('Education'); content.education.forEach((e) => doc.text([e.degree, e.specialisation, e.institute, e.year].filter(Boolean).join(', '))); }
  const extra = [content.notice ? `Notice period: ${content.notice}` : null, content.languages ? `Languages: ${content.languages}` : null].filter(Boolean);
  if (extra.length) { section('Other'); extra.forEach((l) => doc.text(l)); }
  doc.fontSize(8).fillColor('#888888').text(`Prepared by ${brand}. Phone, e-mail and address are withheld.`, 48, doc.page.height - 60, { align: 'center', width: doc.page.width - 96 });
  doc.end();
  return done;
}

module.exports = {
  ocrBacklog, ocrRerun, latestResume, fieldRules, saveFieldRule, deleteFieldRule, parseFields, applyFields, FIELD_METHODS,
  parseNl, search, filterChips, listLink, noticeDaysOf, savedSearches, saveSearch, runSaved, updateSaved, deleteSaved, savedSweep,
  pools, createPool, updatePool, deletePool, poolMembers, addMembers, removeMembers, poolsOfCandidate,
  enrichment, applyEnrichment, staleProfiles, staleSweep, jobChanges, createLink, linkView, linkSubmit, linksOf,
  docExpiry, setDocExpiry, expiringDocs, docExpirySweep, fraudScan, fraudFlags, decideFraud, reviewScore, bulkReview, reviewsOf,
  resumeContent, resumePdf,
};
