// ---------------------------------------------------------------------------
// PRIVACY & SECURITY (market benchmark 15.09 / IN-06 DPDP, IN-07 Aadhaar, IN-08 PAN and bank, 13.10 retention, 15.11 / IN-14 residency).
// Administration -> ATS settings -> Privacy & security. What was already built stays where it is (utils/candidatePrivacy.js: the export
// = right of access, legal hold, erasure, consent review; the consent fields on the profile). This adds:
//
//   NOTICE        the itemised privacy notice (purposes, what is kept, how long, rights, grievance officer) in English, Telugu and Hindi,
//                 versioned; public at GET /api/public/privacy-notice?lang=te so a form or a message can link it.
//   CONSENT LOG   one row per consent given / withdrawn: candidate, purpose, notice version, channel, who recorded it, when. A withdrawal
//                 also sets the profile's consent to Withdrawn (= do not contact), as the profile always did.
//   REQUESTS      the data principal's requests - access, correction, erasure, grievance, nomination - each with a due date (company
//                 setting, default 30 days), a status and the answer; "Erase" runs the existing erasure (legal hold / guarantee rules kept).
//   BREACHES      the breach register: what happened, data and people affected, the 72-hour clock for telling the Data Protection
//                 Board, and when the affected people were told.
//   ID NUMBERS    Aadhaar: checked (12 digits + Verhoeff) and ONLY THE LAST 4 KEPT. PAN: format checked, kept encrypted (utils/secrets.js),
//                 shown masked (ABXXXXX4F). Bank: account number encrypted + last 4, IFSC. The full PAN / account is opened only by a Super
//                 Admin, Admin or HR with a reason, and every opening is in the ID access log. Never part of a list or an export.
//   AADHAAR SWEEP finds full Aadhaar numbers typed into resume text and notes, and masks them to "XXXX XXXX 1234" (dry run first).
//   RETENTION     per data type: how many months, then anonymise / clear. A dry run says how many; the purge is OFF until an Admin
//                 switches it on, runs at most 200 records a time, never touches a record on legal hold or a placement still owed.
//   RESIDENCY     where the data is stored and where the backups go (India), shown on the public trust page.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../../db');
const { logAudit } = require('../audit');
const { candidateWhere, atsViewRole } = require('../scope');
const S = require('./store');

const rolesOf = (u) => [u && u.role, u && u.hrmsRole, u && u.atsRole].filter(Boolean);
const isHr = (u) => rolesOf(u).includes('HR');
const mayReveal = (u) => S.isAdmin(u) || isHr(u);
function adminOrHr(req, res, next) {
  if (req.viewAs || !(S.isAdmin(req.user) || isHr(req.user))) return res.status(403).json({ error: 'Only a Super Admin, an Admin or HR can do this.' });
  return next();
}
function adminOrHrRead(req, res, next) {
  if (!(S.isAdmin(req.user) || isHr(req.user) || atsViewRole(req.user) === 'mgmt')) return res.status(403).json({ error: 'Only a Super Admin, an Admin or HR can see this.' });
  return next();
}

// ------------------------------------------------------------------ notice
const NOTICE_KEY = 'dpdpNotice';
const PURPOSES = ['Recruitment for open jobs', 'Sharing my profile with clients', 'Messages about jobs (WhatsApp / SMS / e-mail / calls)', 'Background verification after an offer'];
const DEFAULT_NOTICE = {
  version: 1,
  officer: { name: '', email: '', phone: '' },
  retentionMonths: 24,
  text: {
    en: 'TeamLink keeps your name, contact details, resume, work history and salary details to find you suitable jobs. We use them only for: {{purposes}}. We share your profile with a client only for a job you agree to. We keep your data for {{months}} months after your last activity, then remove it. You can ask to see, correct or erase your data, withdraw consent, or raise a complaint at any time: {{officer}}. You may also complain to the Data Protection Board of India.',
    te: 'మీకు తగిన ఉద్యోగాలు వెతకడానికి TeamLink మీ పేరు, సంప్రదింపు వివరాలు, రెజ్యూమ్, పని అనుభవం మరియు జీతం వివరాలను ఉంచుతుంది. వీటిని మాత్రమే వాడుతాము: {{purposes}}. మీరు అంగీకరించిన ఉద్యోగానికి మాత్రమే మీ ప్రొఫైల్‌ను క్లయింట్‌తో పంచుకుంటాము. మీ చివరి కార్యకలాపం తర్వాత {{months}} నెలలు మీ డేటాను ఉంచి, తర్వాత తొలగిస్తాము. మీ డేటాను చూడడానికి, సరిచేయడానికి, తొలగించడానికి, అంగీకారం ఉపసంహరించుకోవడానికి లేదా ఫిర్యాదు చేయడానికి ఎప్పుడైనా సంప్రదించండి: {{officer}}. మీరు భారత డేటా ప్రొటెక్షన్ బోర్డుకు కూడా ఫిర్యాదు చేయవచ్చు.',
    hi: 'आपके लिए सही नौकरियाँ खोजने के लिए TeamLink आपका नाम, संपर्क विवरण, रिज़्यूमे, कार्य अनुभव और वेतन विवरण रखता है। हम इनका उपयोग केवल इसके लिए करते हैं: {{purposes}}। आपकी प्रोफ़ाइल किसी क्लाइंट से केवल उसी नौकरी के लिए साझा की जाती है जिसके लिए आप सहमत हों। आपकी अंतिम गतिविधि के बाद {{months}} महीने तक डेटा रखा जाता है, फिर हटा दिया जाता है। अपना डेटा देखने, सुधारने, मिटाने, सहमति वापस लेने या शिकायत के लिए कभी भी संपर्क करें: {{officer}}। आप भारत के डेटा संरक्षण बोर्ड से भी शिकायत कर सकते हैं।',
  },
  purposes: PURPOSES,
};
async function notice() { const n = await S.settings.get(NOTICE_KEY, DEFAULT_NOTICE); return { ...DEFAULT_NOTICE, ...n, text: { ...DEFAULT_NOTICE.text, ...(n.text || {}) } }; }
function renderNotice(n, lang) {
  const l = ['en', 'te', 'hi'].includes(lang) ? lang : 'en';
  const o = n.officer || {};
  const officer = [o.name, o.email, o.phone].filter(Boolean).join(', ') || 'your recruiter or the TeamLink office';
  return String(n.text[l] || n.text.en).replace(/\{\{purposes\}\}/g, (n.purposes || PURPOSES).join('; ')).replace(/\{\{months\}\}/g, String(n.retentionMonths || 24)).replace(/\{\{officer\}\}/g, officer);
}

// ------------------------------------------------------------------ ID numbers
function verhoeffOk(num) {
  const d = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1], [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]];
  const p = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1], [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]];
  let c = 0;
  String(num).split('').reverse().map(Number).forEach((n, i) => { c = d[c][p[i % 8][n]]; });
  return c === 0;
}
const aadhaarOk = (digits) => /^[2-9]\d{11}$/.test(digits) && verhoeffOk(digits);
const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;
const maskPan = (p) => `${p.slice(0, 2)}XXXXX${p.slice(7)}`;
function enc(v) {
  const SEC = require('../secrets'); // eslint-disable-line global-require
  if (!SEC.secretsConfigured()) return null;
  return SEC.encryptSecret(v);
}
function dec(v) { try { return require('../secrets').decryptSecret(v); } catch { return null; } } // eslint-disable-line global-require
async function storeId(candidateId, kind, raw, extra, user) {
  const v = String(raw || '').trim();
  let row;
  if (kind === 'AADHAAR') {
    const d = v.replace(/\D/g, '');
    if (!aadhaarOk(d)) return { error: 'That is not a valid Aadhaar number (12 digits, the checksum must match).' };
    row = { status: 'AADHAAR', last4: d.slice(-4), masked: `XXXX XXXX ${d.slice(-4)}`, verifiedShape: true }; // the full number is never kept
  } else if (kind === 'PAN') {
    const p = v.toUpperCase().replace(/\s/g, '');
    if (!PAN_RE.test(p)) return { error: 'A PAN is 5 letters, 4 digits and 1 letter (for example ABCDE1234F).' };
    row = { status: 'PAN', masked: maskPan(p), last4: p.slice(-4), secret: enc(p), personType: { P: 'Person', C: 'Company', H: 'HUF', F: 'Firm' }[p[3]] || 'Other' };
  } else if (kind === 'BANK') {
    const a = v.replace(/\D/g, '');
    if (a.length < 9 || a.length > 18) return { error: 'A bank account number is 9 to 18 digits.' };
    const ifsc = String((extra && extra.ifsc) || '').toUpperCase().trim();
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) return { error: 'An IFSC is 11 characters: 4 letters, 0, then 6 letters or digits.' };
    row = { status: 'BANK', masked: `XXXXXX${a.slice(-4)}`, last4: a.slice(-4), ifsc, secret: enc(a), holder: String((extra && extra.holder) || '').slice(0, 80) || null };
  } else return { error: 'Aadhaar, PAN or bank account.' };
  const cur = (await S.items.list('id-number', { refId: candidateId, status: kind }))[0];
  const saved = cur ? await S.items.update(cur.id, row) : await S.items.create('id-number', { refType: 'Candidate', refId: candidateId, ...row }, user);
  await logAudit({ userId: user && user.id, action: `${kind === 'BANK' ? 'Bank account' : kind === 'PAN' ? 'PAN' : 'Aadhaar (last 4 only)'} saved`, entity: 'Candidate', entityId: candidateId, toValue: row.masked, reason: extra && extra.via ? `via ${extra.via}` : null });
  return { ok: true, row: idView(saved) };
}
const idView = (r) => ({ id: r.id, kind: r.status, masked: r.masked, ifsc: r.ifsc || null, holder: r.holder || null, encrypted: !!r.secret, savedAt: r.updatedAt, savedBy: r.createdByName });
// a form value typed by a candidate: Aadhaar / PAN / bank go to the protected store; the form keeps only the masked words
async function protectTyped(key, label, value, { candidateId, via }) {
  const k = `${key} ${label}`.toLowerCase();
  const digits = String(value).replace(/\D/g, '');
  if (/aadhaar|aadhar|uid/.test(k) || (digits.length === 12 && aadhaarOk(digits) && /id|number/.test(k))) {
    const r = await storeId(candidateId, 'AADHAAR', value, { via }, null); return r.error ? r : { value: r.row.masked };
  }
  if (/\bpan\b/.test(k)) { const r = await storeId(candidateId, 'PAN', value, { via }, null); return r.error ? r : { value: r.row.masked }; }
  if (/bank|account/.test(k) && digits.length >= 9) return { value: `XXXXXX${digits.slice(-4)} (send the full number to HR only)` };
  // any full Aadhaar number typed into another box is masked too
  return { value: maskAadhaarIn(value).text };
}
function maskAadhaarIn(text) {
  let n = 0;
  const out = String(text || '').replace(/(?<!\d)([2-9]\d{3})[\s-]?(\d{4})[\s-]?(\d{4})(?!\d)/g, (m, a, b, c) => { const d = `${a}${b}${c}`; if (!aadhaarOk(d)) return m; n += 1; return `XXXX XXXX ${c}`; });
  return { text: out, count: n };
}
async function aadhaarSweep({ dryRun, user }) {
  const RE = /[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}/;
  const out = { resumes: 0, notes: 0, numbers: 0, dryRun };
  const resumes = await prisma.candidateResume.findMany({ where: { text: { not: null } }, select: { id: true, text: true } });
  for (const r of resumes) {
    if (!RE.test(r.text)) continue; // eslint-disable-line no-continue
    const m = maskAadhaarIn(r.text); if (!m.count) continue; // eslint-disable-line no-continue
    out.resumes += 1; out.numbers += m.count;
    if (!dryRun) await prisma.candidateResume.update({ where: { id: r.id }, data: { text: m.text } }); // eslint-disable-line no-await-in-loop
  }
  const notes = await prisma.candidateNote.findMany({ select: { id: true, body: true } });
  for (const r of notes) {
    if (!RE.test(r.body || '')) continue; // eslint-disable-line no-continue
    const m = maskAadhaarIn(r.body); if (!m.count) continue; // eslint-disable-line no-continue
    out.notes += 1; out.numbers += m.count;
    if (!dryRun) await prisma.candidateNote.update({ where: { id: r.id }, data: { body: m.text } }); // eslint-disable-line no-await-in-loop
  }
  if (!dryRun) await logAudit({ userId: user.id, action: 'Aadhaar numbers masked in resume text and notes', entity: 'Candidate', toValue: `${out.numbers} number(s) in ${out.resumes} resume(s), ${out.notes} note(s)` });
  return out;
}

// ------------------------------------------------------------------ retention
const RET_KEY = 'retention';
const RET_TYPES = {
  inactiveCandidates: { label: 'Candidates with no activity (anonymised: name, phone, e-mail, resume and documents removed)', action: 'Anonymise', months: 24 },
  aiCallRecords: { label: 'AI call transcripts and recording links', action: 'Clear', months: 6 },
  messageBodies: { label: 'Text of messages sent to candidates (the row stays, the words go)', action: 'Clear', months: 24 },
  callTranscripts: { label: 'Typed call transcripts', action: 'Delete', months: 12 },
};
async function retention() {
  const s = await S.settings.get(RET_KEY, { enabled: false, rules: {} });
  const rules = {};
  Object.entries(RET_TYPES).forEach(([k, t]) => { const r = (s.rules || {})[k] || {}; rules[k] = { on: !!r.on, months: Math.max(1, Math.min(240, Number(r.months) || t.months)), label: t.label, action: t.action }; });
  return { enabled: !!s.enabled, rules, lastRun: s.lastRun || null };
}
const cutoffOf = (m) => new Date(Date.now() - m * 30.44 * 86400000);
async function retentionCandidates(months) {
  const cut = cutoffOf(months);
  const c = await prisma.candidate.findMany({ where: { createdAt: { lt: cut }, NOT: { name: { startsWith: 'Erased' } }, applications: { none: { updatedAt: { gte: cut } } }, messages: { none: { createdAt: { gte: cut } } }, notes: { none: { createdAt: { gte: cut } } } }, select: { id: true }, take: 5000 }).catch(() => []);
  return c.map((x) => x.id);
}
async function runRetention({ dryRun, user }) {
  const set = await retention();
  const out = { dryRun, enabled: set.enabled, results: [] };
  const P = require('../candidatePrivacy'); // eslint-disable-line global-require
  for (const [k, r] of Object.entries(set.rules)) {
    if (!r.on) { out.results.push({ type: k, label: r.label, on: false }); continue; } // eslint-disable-line no-continue
    const cut = cutoffOf(r.months).toISOString();
    let count = 0; let done = 0; let skipped = 0;
    if (k === 'inactiveCandidates') {
      const ids = await retentionCandidates(r.months); count = ids.length; // eslint-disable-line no-await-in-loop
      if (!dryRun) {
        for (const id of ids.slice(0, 200)) {
          const why = await P.erasureBlock(id); // eslint-disable-line no-await-in-loop
          if (why) { skipped += 1; continue; } // eslint-disable-line no-continue
          const e = await P.erase(id, { reason: `Retention rule: no activity for ${r.months} months`, user }); // eslint-disable-line no-await-in-loop
          if (e && !e.error) done += 1; else skipped += 1;
        }
      }
    } else if (k === 'aiCallRecords') {
      const rows = await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "AiCall" WHERE "createdAt" < ? AND ("transcript" IS NOT NULL OR "recordingUrl" IS NOT NULL)', cut).catch(() => [{ n: 0 }]); // eslint-disable-line no-await-in-loop
      count = Number(rows[0].n) || 0;
      if (!dryRun && count) done = Number(await prisma.$executeRawUnsafe('UPDATE "AiCall" SET "transcript" = NULL, "recordingUrl" = NULL WHERE "createdAt" < ? AND ("transcript" IS NOT NULL OR "recordingUrl" IS NOT NULL)', cut).catch(() => 0)); // eslint-disable-line no-await-in-loop
    } else if (k === 'messageBodies') {
      count = await prisma.candidateMessage.count({ where: { createdAt: { lt: new Date(cut) }, body: { not: null } } }); // eslint-disable-line no-await-in-loop
      if (!dryRun && count) done = (await prisma.candidateMessage.updateMany({ where: { createdAt: { lt: new Date(cut) }, body: { not: null } }, data: { body: null } })).count; // eslint-disable-line no-await-in-loop
    } else if (k === 'callTranscripts') {
      const rows = (await S.items.list('call-transcript', {}, { limit: 20000 })).filter((t) => t.updatedAt < cut); // eslint-disable-line no-await-in-loop
      count = rows.length;
      if (!dryRun) { for (const t of rows) { await S.items.remove(t.id); done += 1; } } // eslint-disable-line no-await-in-loop
    }
    out.results.push({ type: k, label: r.label, on: true, months: r.months, action: r.action, count, done, skipped });
  }
  if (!dryRun) {
    await S.settings.set(RET_KEY, { ...(await S.settings.get(RET_KEY, {})), lastRun: { at: new Date().toISOString(), by: user ? user.name : 'automatic', results: out.results } }, user);
    await logAudit({ userId: user && user.id, action: 'Data retention run', entity: 'AtsPlusSetting', entityId: RET_KEY, toValue: out.results.filter((x) => x.on).map((x) => `${x.type}: ${x.done}`).join(', ').slice(0, 300) });
  }
  return out;
}
let retTimer = null;
function startRetention() {
  if (retTimer || S.sandbox()) return;
  retTimer = setInterval(async () => { try { const s = await retention(); if (s.enabled) await runRetention({ dryRun: false, user: null }); } catch (e) { console.error('[retention]', e.message); } }, 24 * 3600e3);
  if (retTimer.unref) retTimer.unref();
}

// ------------------------------------------------------------------ residency
const RES_KEY = 'residency';
const DEFAULT_RES = { region: 'India', provider: '', city: '', backupLocation: 'India', backupProvider: '', processors: 'E-mail: the company mailbox provider; WhatsApp: Meta (Cloud API); SMS: the DLT-registered SMS provider; AI: Groq / Google Gemini / OpenRouter (no candidate contact details or IDs are sent)', confirmedBy: null, confirmedAt: null };
async function residency() { return S.settings.get(RES_KEY, DEFAULT_RES); }

// ------------------------------------------------------------------ routes
const router = express.Router();
const due = (days) => new Date(Date.now() + days * 86400000).toISOString();
async function candidateInScope(user, id) { return prisma.candidate.findFirst({ where: { AND: [{ id: String(id) }, candidateWhere(user)] }, select: { id: true, name: true } }); }

router.get('/privacy/notice', S.internal, S.wrap(async (req, res) => { const n = await notice(); res.json({ ...n, rendered: { en: renderNotice(n, 'en'), te: renderNotice(n, 'te'), hi: renderNotice(n, 'hi') }, canEdit: S.isAdmin(req.user) && !req.viewAs }); }));
router.put('/privacy/notice', S.adminOnly, S.wrap(async (req, res) => {
  const b = req.body || {}; const cur = await notice();
  const text = { ...cur.text }; ['en', 'te', 'hi'].forEach((l) => { if (b.text && typeof b.text[l] === 'string' && b.text[l].trim().length >= 40) text[l] = b.text[l].trim().slice(0, 6000); });
  const next = { version: (cur.version || 1) + 1, text, purposes: Array.isArray(b.purposes) && b.purposes.length ? b.purposes.map((p) => String(p).slice(0, 120)).slice(0, 10) : cur.purposes, retentionMonths: Math.max(1, Math.min(240, Number(b.retentionMonths) || cur.retentionMonths)), officer: { ...cur.officer, ...(b.officer || {}) } };
  await S.settings.set(NOTICE_KEY, next, req.user);
  await logAudit({ userId: req.user.id, action: `Privacy notice saved (version ${next.version})`, entity: 'AtsPlusSetting', entityId: NOTICE_KEY });
  res.json(next);
}));
router.get('/privacy/consents', S.internal, S.wrap(async (req, res) => {
  const cid = String(req.query.candidateId || '');
  if (cid) { if (!(await candidateInScope(req.user, cid))) return res.status(404).json({ error: 'Not in your list.' }); return res.json({ rows: await S.items.list('consent', { refId: cid }) }); }
  if (!(S.isAdmin(req.user) || isHr(req.user))) return res.status(403).json({ error: 'Pick a candidate.' });
  res.json({ rows: await S.items.list('consent', {}, { limit: 500 }) });
}));
router.post('/privacy/consents', S.writer, S.wrap(async (req, res) => {
  const b = req.body || {};
  const c = await candidateInScope(req.user, b.candidateId); if (!c) return res.status(404).json({ error: 'Not in your list.' });
  const status = b.status === 'WITHDRAWN' ? 'WITHDRAWN' : 'GIVEN';
  const n = await notice();
  const purposes = (Array.isArray(b.purposes) && b.purposes.length ? b.purposes : n.purposes).map((p) => String(p).slice(0, 120)).slice(0, 10);
  const channel = ['form', 'whatsapp', 'email', 'call', 'in person', 'portal'].includes(b.channel) ? b.channel : 'call';
  if (status === 'WITHDRAWN' && String(b.reason || '').trim().length < 3) return res.status(400).json({ error: 'Write how the person asked to withdraw (for example, "replied STOP on WhatsApp").' });
  const row = await S.items.create('consent', { refType: 'Candidate', refId: c.id, status, purposes, noticeVersion: n.version, channel, reason: String(b.reason || '').slice(0, 300) || null, lang: ['en', 'te', 'hi'].includes(b.lang) ? b.lang : 'en' }, req.user);
  await prisma.candidate.update({ where: { id: c.id }, data: status === 'GIVEN' ? { consentStatus: 'GIVEN', consentPurposes: purposes.join(', ').slice(0, 500), consentAt: new Date(), consentSource: 'recruiter', consentProof: `notice v${n.version} · ${channel}`, consentByName: req.user.name, consentWithdrawnAt: null } : { consentStatus: 'WITHDRAWN', consentWithdrawnAt: new Date(), consentByName: req.user.name } }).catch(() => null);
  await logAudit({ userId: req.user.id, action: status === 'GIVEN' ? 'Consent recorded' : 'Consent withdrawn (do not contact)', entity: 'Candidate', entityId: c.id, toValue: `notice v${n.version} · ${channel}`, reason: row.reason });
  res.status(201).json(row);
}));
// data principal requests
const DSR_TYPES = { ACCESS: 'See my data', CORRECTION: 'Correct my data', ERASURE: 'Erase my data', GRIEVANCE: 'A complaint', NOMINATION: 'Name a nominee' };
router.get('/privacy/requests', adminOrHrRead, S.wrap(async (req, res) => {
  const rows = await S.items.list('dsr', {}, { limit: 2000 });
  const now = new Date().toISOString();
  res.json({ types: DSR_TYPES, rows: rows.map((r) => ({ ...r, overdue: !['DONE', 'REJECTED'].includes(r.status) && r.dueAt < now })), dueDays: (await S.settings.get('dsr', { dueDays: 30 })).dueDays });
}));
router.post('/privacy/requests', adminOrHr, S.wrap(async (req, res) => {
  const b = req.body || {};
  if (!DSR_TYPES[b.type]) return res.status(400).json({ error: 'Pick the kind of request.' });
  const who = String(b.requester || '').trim();
  if (who.length < 2) return res.status(400).json({ error: 'Who asked (name and how to reach them).' });
  let cand = null; if (b.candidateId) { cand = await candidateInScope(req.user, b.candidateId); if (!cand) return res.status(404).json({ error: 'That candidate is not there.' }); }
  const days = (await S.settings.get('dsr', { dueDays: 30 })).dueDays;
  const row = await S.items.create('dsr', { title: DSR_TYPES[b.type], status: 'OPEN', refType: 'Candidate', refId: cand ? cand.id : null, type: b.type, requester: who.slice(0, 200), details: String(b.details || '').slice(0, 2000), receivedVia: String(b.via || 'e-mail').slice(0, 40), dueAt: due(days), candidateName: cand ? cand.name : null, log: [] }, req.user);
  await logAudit({ userId: req.user.id, action: `Data request logged: ${DSR_TYPES[b.type]}`, entity: 'DataRequest', entityId: row.id, toValue: who.slice(0, 120) });
  res.status(201).json(row);
}));
router.post('/privacy/requests/:id', adminOrHr, S.wrap(async (req, res) => {
  const r = await S.items.get(req.params.id, 'dsr'); if (!r) return res.status(404).json({ error: 'Not found.' });
  const b = req.body || {};
  const st = String(b.status || '');
  if (!['IN_PROGRESS', 'DONE', 'REJECTED'].includes(st)) return res.status(400).json({ error: 'In progress, Done or Rejected.' });
  const answer = String(b.answer || '').trim();
  if (st !== 'IN_PROGRESS' && answer.length < 5) return res.status(400).json({ error: 'Write the answer given to the person.' });
  let erased = null;
  if (st === 'DONE' && r.type === 'ERASURE' && b.erase) {
    if (!S.isAdmin(req.user)) return res.status(403).json({ error: 'Only a Super Admin or an Admin erases.' });
    if (!r.refId) return res.status(400).json({ error: 'Link the candidate first.' });
    erased = await require('../candidatePrivacy').erase(r.refId, { reason: `Data request ${r.id}: ${answer}`, user: req.user }); // eslint-disable-line global-require
    if (erased && erased.error) return res.status(409).json({ error: erased.error });
  }
  const out = await S.items.update(r.id, { status: st, answer: answer || r.answer || null, closedAt: st === 'IN_PROGRESS' ? null : new Date().toISOString(), log: [...(r.log || []), { at: new Date().toISOString(), by: req.user.name, status: st, answer: answer || null }], erased: !!(erased && !erased.error) });
  await logAudit({ userId: req.user.id, action: `Data request ${st.toLowerCase().replace('_', ' ')}`, entity: 'DataRequest', entityId: r.id, toValue: answer.slice(0, 200) || st });
  res.json(out);
}));
// breaches
router.get('/privacy/breaches', adminOrHrRead, S.wrap(async (req, res) => {
  const rows = await S.items.list('breach', {}, { limit: 500 });
  res.json({ rows: rows.map((r) => ({ ...r, boardDueAt: new Date(new Date(r.discoveredAt).getTime() + 72 * 3600e3).toISOString(), boardLate: !r.boardNotifiedAt && Date.now() > new Date(r.discoveredAt).getTime() + 72 * 3600e3 })) });
}));
router.post('/privacy/breaches', S.adminOnly, S.wrap(async (req, res) => {
  const b = req.body || {};
  const what = String(b.what || '').trim();
  if (what.length < 10) return res.status(400).json({ error: 'Describe what happened.' });
  const discoveredAt = b.discoveredAt && !Number.isNaN(new Date(b.discoveredAt).getTime()) ? new Date(b.discoveredAt).toISOString() : new Date().toISOString();
  const row = await S.items.create('breach', { title: what.slice(0, 120), what: what.slice(0, 4000), status: 'OPEN', discoveredAt, dataTypes: String(b.dataTypes || '').slice(0, 300), people: Math.max(0, Number(b.people) || 0), severity: ['Low', 'Medium', 'High'].includes(b.severity) ? b.severity : 'Medium', actions: [] }, req.user);
  await logAudit({ userId: req.user.id, action: 'Personal data breach logged', entity: 'Breach', entityId: row.id, toValue: row.title });
  res.status(201).json(row);
}));
router.post('/privacy/breaches/:id', S.adminOnly, S.wrap(async (req, res) => {
  const r = await S.items.get(req.params.id, 'breach'); if (!r) return res.status(404).json({ error: 'Not found.' });
  const b = req.body || {}; const patch = {};
  if (b.boardNotified) patch.boardNotifiedAt = new Date().toISOString();
  if (b.peopleNotified) patch.peopleNotifiedAt = new Date().toISOString();
  if (b.close) { patch.status = 'CLOSED'; patch.closedAt = new Date().toISOString(); }
  if (b.action) patch.actions = [...(r.actions || []), { at: new Date().toISOString(), by: req.user.name, text: String(b.action).slice(0, 1000) }];
  await logAudit({ userId: req.user.id, action: 'Breach register updated', entity: 'Breach', entityId: r.id, toValue: Object.keys(patch).join(', ') });
  res.json(await S.items.update(r.id, patch));
}));
// ID numbers
router.get('/privacy/candidates/:id/ids', S.internal, S.wrap(async (req, res) => {
  if (['bde', 'client', 'candidate'].includes(atsViewRole(req.user))) return res.status(403).json({ error: 'ID numbers are not part of your view.' });
  const c = await candidateInScope(req.user, req.params.id); if (!c) return res.status(404).json({ error: 'Not in your list.' });
  res.json({ rows: (await S.items.list('id-number', { refId: c.id })).map(idView), canReveal: mayReveal(req.user) && !req.viewAs });
}));
router.post('/privacy/candidates/:id/ids', S.writer, S.wrap(async (req, res) => {
  if (atsViewRole(req.user) === 'bde') return res.status(403).json({ error: 'ID numbers are not part of your view.' });
  const c = await candidateInScope(req.user, req.params.id); if (!c) return res.status(404).json({ error: 'Not in your list.' });
  const b = req.body || {};
  const out = await storeId(c.id, String(b.kind || '').toUpperCase(), b.value, { ifsc: b.ifsc, holder: b.holder }, req.user);
  return out.error ? res.status(400).json(out) : res.status(201).json(out.row);
}));
router.post('/privacy/ids/:rowId/reveal', adminOrHr, S.wrap(async (req, res) => {
  const r = await S.items.get(req.params.rowId, 'id-number'); if (!r) return res.status(404).json({ error: 'Not found.' });
  const reason = String((req.body || {}).reason || '').trim();
  if (reason.length < 5) return res.status(400).json({ error: 'Write why you need the full number (it is logged).' });
  if (r.status === 'AADHAAR') return res.status(409).json({ error: 'The full Aadhaar number is never kept: only the last 4 digits.' });
  const full = r.secret ? dec(r.secret) : null;
  await S.items.create('id-view', { refType: 'Candidate', refId: r.refId, status: r.status, reason: reason.slice(0, 300), shown: !!full }, req.user);
  await logAudit({ userId: req.user.id, action: `Full ${r.status === 'PAN' ? 'PAN' : 'bank account number'} opened`, entity: 'Candidate', entityId: r.refId, reason: reason.slice(0, 300) });
  if (!full) return res.status(409).json({ error: 'The full number was not kept (no encryption key was set when it was saved). Ask the person again.' });
  res.json({ value: full, note: 'Shown once. It is not on any list or export.' });
}));
router.get('/privacy/id-views', adminOrHrRead, S.wrap(async (req, res) => res.json({ rows: await S.items.list('id-view', {}, { limit: 500 }) })));
router.post('/privacy/aadhaar-sweep', S.adminOnly, S.wrap(async (req, res) => res.json(await aadhaarSweep({ dryRun: !!(req.body || {}).dryRun, user: req.user }))));
// retention
router.get('/privacy/retention', adminOrHrRead, S.wrap(async (req, res) => res.json({ ...(await retention()), canEdit: S.isAdmin(req.user) && !req.viewAs })));
router.put('/privacy/retention', S.adminOnly, S.wrap(async (req, res) => {
  const b = req.body || {}; const cur = await retention();
  const rules = {}; Object.keys(RET_TYPES).forEach((k) => { const r = (b.rules || {})[k] || cur.rules[k]; rules[k] = { on: !!r.on, months: Math.max(1, Math.min(240, Number(r.months) || cur.rules[k].months)) }; });
  const raw = await S.settings.get(RET_KEY, {});
  const next = { ...raw, enabled: 'enabled' in b ? !!b.enabled : cur.enabled, rules };
  await S.settings.set(RET_KEY, next, req.user);
  await logAudit({ userId: req.user.id, action: `Data retention ${next.enabled ? 'switched ON' : 'saved (OFF)'}`, entity: 'AtsPlusSetting', entityId: RET_KEY, toValue: JSON.stringify(rules).slice(0, 300) });
  res.json(await retention());
}));
router.post('/privacy/retention/run', S.adminOnly, S.wrap(async (req, res) => {
  const b = req.body || {};
  if (b.dryRun) return res.json(await runRetention({ dryRun: true, user: req.user }));
  const set = await retention();
  if (!set.enabled) return res.status(409).json({ error: 'Retention is switched OFF. Switch it on first (the dry run works while OFF).' });
  if (b.confirm !== 'PURGE') return res.status(400).json({ error: 'Type PURGE to confirm. Anonymised records cannot be brought back.' });
  res.json(await runRetention({ dryRun: false, user: req.user }));
}));
// residency
router.get('/privacy/residency', S.internal, S.wrap(async (req, res) => res.json({ ...(await residency()), canEdit: S.isAdmin(req.user) && !req.viewAs })));
router.put('/privacy/residency', S.adminOnly, S.wrap(async (req, res) => {
  const b = req.body || {}; const cur = await residency();
  const next = { ...cur };
  ['region', 'provider', 'city', 'backupLocation', 'backupProvider', 'processors'].forEach((k) => { if (k in b) next[k] = String(b[k] || '').slice(0, k === 'processors' ? 2000 : 120); });
  if (b.confirm) { next.confirmedBy = req.user.name; next.confirmedAt = new Date().toISOString(); }
  await S.settings.set(RES_KEY, next, req.user);
  await logAudit({ userId: req.user.id, action: 'Data residency statement saved', entity: 'AtsPlusSetting', entityId: RES_KEY, toValue: `${next.region} / backups ${next.backupLocation}` });
  res.json(next);
}));

module.exports = { router, notice, renderNotice, residency, protectTyped, storeId, maskAadhaarIn, aadhaarOk, runRetention, retention, startRetention };
