// ---------------------------------------------------------------------------
// ONBOARDING (market benchmark 11.09 / 11.10 / 11.11 / 11.18) - Interview Calendar -> Joining -> "Onboarding", Administration -> ATS
// settings -> Offers & onboarding (the checklists), and the candidate's own PRE-BOARDING page (public link, no login).
//
//   11.10 CHECKLISTS BY CLIENT AND JOB TYPE  an Admin keeps joining checklists; each is for a client (or any client) and a job type
//         (employment type / hiring type / department, or any). Each item says who does it (Candidate / HR / Recruiter / Client), whether
//         a document is uploaded, and whether that document has an EXPIRY (a licence, a medical fitness, a visa ...). The most specific
//         checklist is picked for a person (client + job type, then client, then job type, then the default).
//   11.09 PRE-BOARDING PORTAL  the recruiter opens a pack for a person at Offer / Joining and shares one link: the candidate sees the
//         welcome note, their checklist, uploads the documents (stored as the candidate's Joining documents, utils/candidateDocStore.js)
//         and fills the short forms. Aadhaar typed on a form keeps only the last 4 digits; a PAN is kept encrypted (utils/atsPlus/privacy.js).
//   11.18 ONBOARDING TASKS + WELCOME   the HR / recruiter / client tasks of the same checklist, ticked inside TeamLink; the welcome note
//         (first day, time, place, whom to meet) shown on the pre-boarding page.
//   11.11 COMPLIANCE DOCUMENTS + CREDENTIAL CHECKS   every required document is reviewed (Verified / Sent back); credentials with an expiry
//         (pack items and the candidate's certifications) are listed when they expire within N days or have expired.
//
// The link carries a random token; only its SHA-256 is stored. "New link" makes a new one (the old one stops). Nothing is sent from here:
// the recruiter copies the link into their own message (the usual WhatsApp / mail screens).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const express = require('express');
const prisma = require('../../db');
const { requirePerm } = require('../../middleware/auth');
const { applicationWhere, candidateWhere } = require('../scope');
const { logAudit } = require('../audit');
const { hiringTypeOf } = require('../joining');
const S = require('./store');

const TPL = 'onb-template'; const PACK = 'onb-pack';
const WHO = ['Candidate', 'HR', 'Recruiter', 'Client'];
const TYPES = ['task', 'doc', 'form'];
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const lc = (s) => String(s || '').toLowerCase().trim();

const DEFAULT_ITEMS = [
  { key: 'offer_accept', label: 'Accept the offer letter', who: 'Candidate', type: 'task' },
  { key: 'photo_id', label: 'Upload a photo ID (Aadhaar with only the last 4 digits visible, or PAN / passport)', who: 'Candidate', type: 'doc', docType: 'ID' },
  { key: 'education', label: 'Upload your highest education certificate', who: 'Candidate', type: 'doc', docType: 'Certificate' },
  { key: 'relieving', label: 'Upload the relieving letter / resignation acceptance of your last job', who: 'Candidate', type: 'doc', docType: 'Joining' },
  { key: 'details', label: 'Your joining details', who: 'Candidate', type: 'form', fields: [{ key: 'address', label: 'Current address' }, { key: 'emergency', label: 'Emergency contact (name and phone)' }, { key: 'pan', label: 'PAN (for payroll)' }] },
  { key: 'bgv', label: 'Start the background check', who: 'HR', type: 'task' },
  { key: 'client_docs', label: 'Send the joining documents to the client', who: 'Recruiter', type: 'task' },
  { key: 'day_one', label: 'Confirm the first-day reporting time and place with the client', who: 'Recruiter', type: 'task' },
];

function cleanItems(items) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).slice(0, 40).map((it, i) => {
    const label = String(it.label || '').trim().slice(0, 200);
    let key = String(it.key || label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || `item_${i + 1}`;
    while (seen.has(key)) key = `${key}_${i}`;
    seen.add(key);
    return {
      key, label, who: WHO.includes(it.who) ? it.who : 'Candidate', type: TYPES.includes(it.type) ? it.type : 'task', required: it.required !== false,
      docType: ['ID', 'Certificate', 'Joining', 'Offer', 'Resume'].includes(it.docType) ? it.docType : 'Joining', expires: !!it.expires,
      dueDays: Number.isFinite(Number(it.dueDays)) ? Math.max(-60, Math.min(60, Math.round(Number(it.dueDays)))) : null,
      fields: it.type === 'form' ? (Array.isArray(it.fields) ? it.fields : []).slice(0, 10).map((f) => ({ key: String(f.key || f.label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30), label: String(f.label || '').slice(0, 80) })).filter((f) => f.key && f.label) : undefined,
    };
  }).filter((it) => it.label);
}
async function templates() { return S.items.list(TPL, {}, { order: 'asc' }); }
// the most specific checklist for this person
async function pickTemplate(app) {
  const r = app.requirement || {};
  const jt = [r.employmentType, hiringTypeOf(app, r), r.department].map(lc).filter(Boolean);
  const all = (await templates()).filter((t) => t.status !== 'OFF');
  const fits = (t) => (!t.clientId || t.clientId === r.clientId) && (!t.jobType || jt.includes(lc(t.jobType)));
  const rank = (t) => (t.clientId ? 2 : 0) + (t.jobType ? 1 : 0);
  const best = all.filter(fits).sort((a, b) => rank(b) - rank(a))[0];
  if (best) return { id: best.id, title: best.title, items: best.items, welcome: best.welcome || null, why: [best.clientId ? 'this client' : null, best.jobType ? `job type ${best.jobType}` : null].filter(Boolean).join(' + ') || 'the default checklist' };
  return { id: null, title: 'Standard joining checklist', items: cleanItems(DEFAULT_ITEMS), welcome: null, why: 'the built-in checklist (no checklist saved yet)' };
}

function packView(p, { internal = true } = {}) {
  const items = (p.items || []).map((it) => ({ ...it, ...(p.state && p.state[it.key] ? p.state[it.key] : { status: 'OPEN' }) }));
  const req = items.filter((it) => it.required);
  const done = req.filter((it) => ['DONE', 'VERIFIED', 'WAIVED'].includes(it.status)).length;
  const base = { id: p.id, applicationId: p.refId, title: p.title, welcome: p.welcome || null, joiningDate: p.joiningDate || null, items, progress: { done, of: req.length, pct: req.length ? Math.round((done * 100) / req.length) : 100 }, linkActive: !!p.tokenHash && !p.closedAt, closedAt: p.closedAt || null };
  if (!internal) {
    base.items = items.filter((it) => it.who === 'Candidate').map((it) => ({ key: it.key, label: it.label, type: it.type, required: it.required, status: it.status, fields: it.fields, values: it.type === 'form' ? Object.fromEntries(Object.entries(it.values || {}).map(([k, v]) => [k, v])) : undefined, note: it.note || null, expires: it.expires }));
    delete base.applicationId;
  } else { base.why = p.why; base.createdByName = p.createdByName; }
  return base;
}

async function scopedApp(req, res) {
  const app = await prisma.application.findFirst({ where: { id: req.params.id, ...applicationWhere(req.user) }, include: { candidate: { select: { id: true, name: true } }, requirement: { select: { id: true, title: true, clientId: true, department: true, employmentType: true, hiringType: true, internal: true, location: true, client: { select: { name: true } } } } } });
  if (!app) res.status(404).json({ error: 'That person is not in your list.' });
  return app;
}
async function packOf(appId) { const [p] = await S.items.list(PACK, { refId: appId }); return p || null; }

// ------------------------------------------------------------------ staff routes (/api/ats-plus)
const router = express.Router();
const view = requirePerm('ats', 'interviews', 'Joining', 'view');
const edit = requirePerm('ats', 'interviews', 'Joining', 'edit');

router.get('/onboarding/templates', view, S.wrap(async (req, res) => res.json({ rows: await templates(), defaults: cleanItems(DEFAULT_ITEMS), who: WHO, types: TYPES, canEdit: S.isAdmin(req.user) && !req.viewAs })));
async function saveTpl(req, res, cur) {
  const b = req.body || {};
  const title = String(b.title || (cur && cur.title) || '').trim();
  if (title.length < 3) return res.status(400).json({ error: 'Name the checklist.' });
  const items = cleanItems(b.items || (cur && cur.items));
  if (!items.length) return res.status(400).json({ error: 'Add at least one item.' });
  const v = { title: title.slice(0, 120), items, clientId: b.clientId || null, jobType: String(b.jobType || '').trim().slice(0, 60) || null, status: b.active === false ? 'OFF' : 'ON', welcome: String(b.welcome || '').slice(0, 3000) || null };
  const row = cur ? await S.items.update(cur.id, v) : await S.items.create(TPL, v, req.user);
  await logAudit({ userId: req.user.id, action: cur ? 'Joining checklist changed' : 'Joining checklist added', entity: 'OnboardingChecklist', entityId: row.id, toValue: `${row.title}: ${items.length} items` });
  return res.status(cur ? 200 : 201).json(row);
}
router.post('/onboarding/templates', S.adminOnly, S.wrap(async (req, res) => saveTpl(req, res, null)));
router.put('/onboarding/templates/:id', S.adminOnly, S.wrap(async (req, res) => { const cur = await S.items.get(req.params.id, TPL); if (!cur) return res.status(404).json({ error: 'Not found.' }); return saveTpl(req, res, cur); }));

router.get('/onboarding/:id', view, S.wrap(async (req, res) => {
  const app = await scopedApp(req, res); if (!app) return;
  const p = await packOf(app.id);
  res.json({ pack: p ? packView(p) : null, suggested: p ? null : await pickTemplate(app), candidate: app.candidate.name, job: app.requirement.title });
}));
router.post('/onboarding/:id/open', edit, S.wrap(async (req, res) => {
  const app = await scopedApp(req, res); if (!app) return;
  if (!['OFFER', 'SELECTED', 'JOINED', 'HIRED'].includes(app.stage) && !app.offerStatus) return res.status(409).json({ error: 'Onboarding starts once the person is Selected or has an offer.' });
  let p = await packOf(app.id);
  const token = crypto.randomBytes(24).toString('base64url');
  const b = req.body || {};
  const welcome = {
    text: String(b.welcomeText || '').slice(0, 3000) || null, firstDay: DAY.test(String(b.firstDay || '')) ? b.firstDay : (app.joiningDate || null),
    time: String(b.time || '').slice(0, 40) || null, place: String(b.place || '').slice(0, 300) || null, meet: String(b.meet || '').slice(0, 120) || null,
  };
  if (!p) {
    const t = await pickTemplate(app);
    if (!welcome.text) welcome.text = t.welcome || `Welcome to ${app.requirement.internal ? 'TeamLink' : (app.requirement.client && app.requirement.client.name) || 'your new team'}! Please finish the steps below before your first day.`;
    p = await S.items.create(PACK, { refType: 'Application', refId: app.id, title: t.title, templateId: t.id, why: t.why, items: t.items, state: {}, welcome, joiningDate: app.joiningDate || null, candidateId: app.candidateId, tokenHash: sha(token), status: 'OPEN' }, req.user);
    await logAudit({ userId: req.user.id, action: 'Pre-boarding opened', entity: 'Application', entityId: app.id, toValue: `${t.title} (${t.why})` });
  } else {
    p = await S.items.update(p.id, { tokenHash: sha(token), closedAt: null, status: 'OPEN', ...(b.welcomeText || b.firstDay || b.place ? { welcome: { ...(p.welcome || {}), ...Object.fromEntries(Object.entries(welcome).filter(([, v]) => v)) } } : {}) });
    await logAudit({ userId: req.user.id, action: 'Pre-boarding link made again (the old link stops)', entity: 'Application', entityId: app.id });
  }
  res.json({ pack: packView(p), link: `/preboarding/${token}`, message: 'Copy the link and send it to the person (WhatsApp or mail). Making a new link stops the old one.' });
}));
router.post('/onboarding/:id/items/:key', edit, S.wrap(async (req, res) => {
  const app = await scopedApp(req, res); if (!app) return;
  const p = await packOf(app.id); if (!p) return res.status(404).json({ error: 'Open the onboarding first.' });
  const it = (p.items || []).find((x) => x.key === req.params.key); if (!it) return res.status(404).json({ error: 'No such item.' });
  const b = req.body || {}; const st = String(b.status || '');
  if (!['OPEN', 'DONE', 'VERIFIED', 'SENT_BACK', 'WAIVED'].includes(st)) return res.status(400).json({ error: 'Pick a status.' });
  if (['SENT_BACK', 'WAIVED'].includes(st) && String(b.note || '').trim().length < 3) return res.status(400).json({ error: 'Say why.' });
  if (st === 'VERIFIED' && it.type === 'doc' && !(p.state && p.state[it.key] && p.state[it.key].docId)) return res.status(409).json({ error: 'Nothing was uploaded for this item yet.' });
  const cur = (p.state && p.state[it.key]) || {};
  const expiresOn = it.expires ? (DAY.test(String(b.expiresOn || '')) ? b.expiresOn : cur.expiresOn || null) : null;
  if (it.expires && st === 'VERIFIED' && !expiresOn) return res.status(400).json({ error: 'This document has an expiry: type the expiry date.' });
  const state = { ...(p.state || {}), [it.key]: { ...cur, status: st, note: String(b.note || '').slice(0, 300) || null, by: req.user.name, at: new Date().toISOString(), ...(it.expires ? { expiresOn } : {}) } };
  const out = await S.items.update(p.id, { state });
  await logAudit({ userId: req.user.id, action: `Onboarding item ${st.toLowerCase().replace('_', ' ')}`, entity: 'Application', entityId: app.id, toValue: it.label.slice(0, 120), reason: b.note || null });
  res.json({ pack: packView(out) });
}));
router.post('/onboarding/:id/close', edit, S.wrap(async (req, res) => {
  const app = await scopedApp(req, res); if (!app) return;
  const p = await packOf(app.id); if (!p) return res.status(404).json({ error: 'No onboarding here.' });
  const out = await S.items.update(p.id, { tokenHash: null, closedAt: new Date().toISOString(), status: 'CLOSED' });
  await logAudit({ userId: req.user.id, action: 'Pre-boarding closed (link stopped)', entity: 'Application', entityId: app.id });
  res.json({ pack: packView(out) });
}));
// every open onboarding in my scope, with its progress
router.get('/onboarding', view, S.wrap(async (req, res) => {
  const packs = await S.items.list(PACK, {}, { limit: 3000 });
  const apps = packs.length ? await prisma.application.findMany({ where: { AND: [applicationWhere(req.user), { id: { in: packs.map((p) => p.refId) } }] }, select: { id: true, stage: true, joiningDate: true, candidate: { select: { name: true } }, requirement: { select: { title: true, client: { select: { name: true } } } } } }) : [];
  const byId = new Map(apps.map((a) => [a.id, a]));
  res.json({ rows: packs.filter((p) => byId.has(p.refId)).map((p) => { const a = byId.get(p.refId); const v = packView(p); return { applicationId: a.id, name: a.candidate.name, job: a.requirement.title, client: a.requirement.client && a.requirement.client.name, joiningDate: a.joiningDate, stage: a.stage, progress: v.progress, waiting: v.items.filter((i) => i.status === 'SUBMITTED').length, linkActive: v.linkActive }; }) });
}));
// 11.11 credentials that expire
router.get('/onboarding-compliance', view, S.wrap(async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  const limit = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const rows = [];
  const packs = await S.items.list(PACK, {}, { limit: 3000 });
  const apps = packs.length ? await prisma.application.findMany({ where: { AND: [applicationWhere(req.user), { id: { in: packs.map((p) => p.refId) } }] }, select: { id: true, candidate: { select: { id: true, name: true } }, requirement: { select: { title: true } } } }) : [];
  const byId = new Map(apps.map((a) => [a.id, a]));
  packs.filter((p) => byId.has(p.refId)).forEach((p) => (p.items || []).filter((i) => i.expires).forEach((i) => {
    const s = (p.state || {})[i.key] || {}; const a = byId.get(p.refId);
    if (s.expiresOn && s.expiresOn <= limit) rows.push({ source: 'Joining document', candidateId: a.candidate.id, name: a.candidate.name, job: a.requirement.title, what: i.label, expiresOn: s.expiresOn, expired: s.expiresOn < today, applicationId: a.id });
    if (!s.expiresOn && i.required) rows.push({ source: 'Joining document', candidateId: a.candidate.id, name: a.candidate.name, job: a.requirement.title, what: i.label, expiresOn: null, missing: true, applicationId: a.id });
  }));
  const certs = await prisma.candidateCertification.findMany({ where: { expiresOn: { not: null, lte: limit }, candidate: candidateWhere(req.user) }, select: { name: true, issuer: true, expiresOn: true, candidate: { select: { id: true, name: true } } }, take: 2000 }).catch(() => []);
  certs.forEach((c) => rows.push({ source: 'Certification', candidateId: c.candidate.id, name: c.candidate.name, what: [c.name, c.issuer].filter(Boolean).join(' · '), expiresOn: c.expiresOn, expired: c.expiresOn < today }));
  rows.sort((a, b) => String(a.expiresOn || '0').localeCompare(String(b.expiresOn || '0')));
  res.json({ days, rows, expired: rows.filter((r) => r.expired).length, soon: rows.filter((r) => r.expiresOn && !r.expired).length, missing: rows.filter((r) => r.missing).length });
}));

// ------------------------------------------------------------------ the candidate's page: /api/public/preboarding/:token
const pub = express.Router();
const { rateLimit } = require('../publicRateLimit');
pub.use(rateLimit({ bucket: 'preboarding', max: 120, windowMs: 10 * 60000 }));
const TOKEN = /^[A-Za-z0-9_-]{20,60}$/;
async function byToken(req, res) {
  const t = String(req.params.token || '');
  if (!TOKEN.test(t)) { res.status(404).json({ error: 'This link does not work. Ask your recruiter for a new one.' }); return null; }
  const [p] = await S.items.list(PACK, {}, { limit: 20000 }).then((all) => all.filter((x) => x.tokenHash === sha(t)));
  if (!p || p.closedAt) { res.status(404).json({ error: 'This link does not work any more. Ask your recruiter for a new one.' }); return null; }
  return p;
}
pub.get('/:token', S.wrap(async (req, res) => {
  const p = await byToken(req, res); if (!p) return;
  const app = await prisma.application.findUnique({ where: { id: p.refId }, select: { joiningDate: true, candidate: { select: { name: true } }, requirement: { select: { title: true, location: true } } } });
  res.json({ ...packView(p, { internal: false }), firstName: String((app && app.candidate.name) || '').split(/\s+/)[0], job: app && app.requirement.title, location: app && app.requirement.location, joiningDate: (app && app.joiningDate) || p.joiningDate || null });
}));
pub.post('/:token/items/:key/done', S.wrap(async (req, res) => {
  const p = await byToken(req, res); if (!p) return;
  const it = (p.items || []).find((x) => x.key === req.params.key && x.who === 'Candidate');
  if (!it) return res.status(404).json({ error: 'No such step.' });
  if (it.type === 'doc') return res.status(400).json({ error: 'Upload the document for this step.' });
  const cur = (p.state || {})[it.key] || {};
  let values = cur.values || {};
  if (it.type === 'form') {
    const raw = (req.body || {}).values || {};
    const PV = require('./privacy'); // eslint-disable-line global-require
    values = {};
    for (const f of it.fields || []) {
      const v = String(raw[f.key] || '').trim().slice(0, 500);
      if (!v) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      const safe = await PV.protectTyped(f.key, f.label, v, { candidateId: p.candidateId, via: 'pre-boarding form' });
      if (safe.error) return res.status(400).json({ error: `${f.label}: ${safe.error}` });
      values[f.key] = safe.value;
    }
    if (!Object.keys(values).length) return res.status(400).json({ error: 'Fill the form first.' });
  }
  const state = { ...(p.state || {}), [it.key]: { ...cur, status: 'SUBMITTED', values, at: new Date().toISOString(), by: 'Candidate' } };
  await S.items.update(p.id, { state });
  await logAudit({ action: 'Pre-boarding step done by the candidate', entity: 'Application', entityId: p.refId, toValue: it.label.slice(0, 120) });
  res.json({ ok: true, message: 'Thank you. Your recruiter will check it.' });
}));
pub.post('/:token/items/:key/upload', S.wrap(async (req, res) => {
  const p = await byToken(req, res); if (!p) return;
  const it = (p.items || []).find((x) => x.key === req.params.key && x.who === 'Candidate' && x.type === 'doc');
  if (!it) return res.status(404).json({ error: 'No such step.' });
  const docs = require('../candidateDocStore'); // eslint-disable-line global-require
  let parsed; let stored;
  try { parsed = await docs.parseDocUpload(req); stored = docs.storeDocFile(parsed.file); } catch (e) { return res.status(400).json({ error: (e && e.message && !/ENOENT|EACCES/.test(e.message)) ? docs.DOC_MESSAGE || 'Upload a PDF, JPG, PNG or DOCX of up to 10 MB.' : 'The file could not be saved.' }); }
  const doc = await prisma.candidateDocument.create({ data: { candidateId: p.candidateId, docType: it.docType || 'Joining', name: it.label.slice(0, 160), note: 'Uploaded by the candidate on the pre-boarding page', internalOnly: it.docType === 'ID', uploadedByName: 'Candidate (pre-boarding)', file: stored.stored, fileName: stored.fileName, mime: stored.mime, size: stored.size, sha256: stored.sha256 } });
  const cur = (p.state || {})[it.key] || {};
  await S.items.update(p.id, { state: { ...(p.state || {}), [it.key]: { ...cur, status: 'SUBMITTED', docId: doc.id, fileName: stored.fileName, at: new Date().toISOString(), by: 'Candidate' } } });
  await logAudit({ action: 'Pre-boarding document uploaded by the candidate', entity: 'Candidate', entityId: p.candidateId, toValue: `${it.label.slice(0, 100)} · ${stored.fileName}` });
  res.status(201).json({ ok: true, message: 'Uploaded. Your recruiter will check it.' });
}));

module.exports = { router, publicRouter: pub, pickTemplate, packOf, packView, DEFAULT_ITEMS };
