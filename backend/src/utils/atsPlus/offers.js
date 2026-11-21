// ---------------------------------------------------------------------------
// OFFERS: CLAUSE LIBRARY + CONDITIONAL OFFER FIELDS + BULK OFFERS (market benchmark 11.06 / 11.07). Interview Calendar -> Offers.
//
// CLAUSE LIBRARY (11.06): an Admin keeps clauses (probation, relocation, bond, night shift, notice buy-out ...). Each has CONDITIONS -
// hiring type, department, client, CTC from / to, employment type, work mode, location - and may ask for FIELDS (a relocation amount, a
// bond period) that appear on the offer only when the clause applies. Every offer letter (the preview and the one sent: routes/
// interviewsJoining.js) gets the matching clauses appended under "Terms", with {{field:key}} filled from the values typed on the offer.
//   GET /offers/clauses  POST /offers/clauses  PUT /offers/clauses/:id  DELETE /offers/clauses/:id            (edit: Super Admin / Admin)
//   GET /offers/:id/clauses        which clauses apply to this offer, the fields they need, the values typed
//   PUT /offers/:id/clause-fields  { values }   (Offers / edit, in scope)
//
// BULK OFFERS (11.07, campus / bulk hiring): many people at Selected get the offer at once. Each row goes through the SAME one-by-one
// route (POST /api/ats/offers/:id/prepare, with the caller's own login), so every check of a single offer - scope, the CTC check,
// client jobs, dates - applies to each row; the answer lists what was prepared and why a row was refused.
//   GET  /offers/bulk/candidates     people at Selected in my scope
//   POST /offers/bulk/prepare        { rows: [{ applicationId, offeredCtc?, joiningDate? }], offeredCtc?, joiningDate?, offerDate?, offerNotes?, confirmCtc? }
//   POST /offers/bulk/letters        { ids } -> each letter's text (to print or download at once)
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../../db');
const { requirePerm } = require('../../middleware/auth');
const { applicationWhere } = require('../scope');
const { hiringTypeOf } = require('../joining');
const { logAudit } = require('../audit');
const S = require('./store');

const KIND = 'offer-clause';
const list = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter(Boolean).slice(0, 50);
const lc = (s) => String(s || '').toLowerCase().trim();
function cleanClause(b) {
  const title = String(b.title || '').trim();
  const text = String(b.text || '').trim();
  if (title.length < 3) return { error: 'Name the clause.' };
  if (text.length < 10) return { error: 'Write the clause text.' };
  const c = b.conditions || {};
  const num = (v) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
  const fields = (Array.isArray(b.fields) ? b.fields : []).slice(0, 8).map((f) => ({ key: String(f.key || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 30), label: String(f.label || '').slice(0, 80), required: !!f.required })).filter((f) => f.key && f.label);
  return {
    value: {
      title: title.slice(0, 120), text: text.slice(0, 4000), status: b.active === false ? 'OFF' : 'ON', order: Number(b.order) || 0, fields,
      conditions: { hiringTypes: list(c.hiringTypes), departments: list(c.departments), clientIds: list(c.clientIds), employmentTypes: list(c.employmentTypes), workModes: list(c.workModes), locations: list(c.locations), minCtc: num(c.minCtc), maxCtc: num(c.maxCtc), always: !!c.always },
    },
  };
}
// does this clause apply to this offer? -> null | the reasons it applies
function matches(cl, app) {
  const c = cl.conditions || {}; const r = app.requirement || {};
  const why = [];
  const inList = (vals, v, label) => { if (!vals || !vals.length) return true; const ok = vals.map(lc).includes(lc(v)); if (ok) why.push(`${label}: ${v}`); return ok; };
  if (!inList(c.hiringTypes, hiringTypeOf(app, r), 'hiring type')) return null;
  if (!inList(c.departments, r.department, 'department')) return null;
  if (!inList(c.clientIds, r.clientId, 'client')) return null;
  if (!inList(c.employmentTypes, r.employmentType, 'employment type')) return null;
  if (!inList(c.workModes, r.workMode, 'work mode')) return null;
  if (c.locations && c.locations.length) { const loc = lc(r.location); const ok = c.locations.some((l) => loc.includes(lc(l))); if (!ok) return null; why.push(`location: ${r.location}`); }
  const ctc = Number(app.offeredCtc) || 0;
  if (c.minCtc !== null && c.minCtc !== undefined) { if (!(ctc >= c.minCtc)) return null; why.push(`CTC from ${c.minCtc}`); }
  if (c.maxCtc !== null && c.maxCtc !== undefined) { if (!(ctc > 0 && ctc <= c.maxCtc)) return null; why.push(`CTC up to ${c.maxCtc}`); }
  const anyCond = ['hiringTypes', 'departments', 'clientIds', 'employmentTypes', 'workModes', 'locations'].some((k) => (c[k] || []).length) || c.minCtc != null || c.maxCtc != null;
  if (!anyCond && !c.always) return null; // a clause with no condition is used only when marked "every offer"
  return why.length ? why : ['every offer'];
}
async function clausesFor(app) {
  const all = (await S.items.list(KIND, { status: 'ON' }, { order: 'asc' })).sort((a, b) => (a.order || 0) - (b.order || 0));
  const [vals] = await S.items.list('offer-fields', { refId: app.id });
  const values = (vals && vals.values) || {};
  const used = [];
  all.forEach((cl) => { const why = matches(cl, app); if (why) used.push({ id: cl.id, title: cl.title, text: cl.text, why, fields: cl.fields || [] }); });
  const fields = [];
  used.forEach((u) => u.fields.forEach((f) => { if (!fields.some((x) => x.key === f.key)) fields.push({ ...f, clause: u.title, value: values[f.key] || '' }); }));
  return { used, fields, values, missing: fields.filter((f) => f.required && !String(values[f.key] || '').trim()).map((f) => f.label) };
}
async function appendClauses(app, text) {
  try {
    const { used, values } = await clausesFor(app);
    if (!used.length) return { text, used: [] };
    const fill = (t) => String(t).replace(/\{\{\s*field:([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => (values[k] ? String(values[k]) : '____')).replace(/\{\{\s*name\s*\}\}/g, (app.candidate && app.candidate.name) || '');
    const block = `\n\nTerms\n${used.map((u, i) => `${i + 1}. ${u.title}: ${fill(u.text)}`).join('\n')}`;
    return { text: `${text}${block}`, used: used.map((u) => ({ id: u.id, title: u.title, why: u.why })) };
  } catch (e) {
    return { text, used: [] };
  }
}

// ------------------------------------------------------------------ internal call: the one-by-one offer routes, with the caller's login
async function self(req, method, path, body) {
  const port = process.env.PORT || 4000;
  const r = await fetch(`http://127.0.0.1:${port}/api/ats${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: req.headers.authorization || '' }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ }
  return { status: r.status, body: j || {} };
}

const router = express.Router();
const view = requirePerm('ats', 'interviews', 'Offers', 'view');
const edit = requirePerm('ats', 'interviews', 'Offers', 'edit');
const send = (res, r) => res.status(r.status || 200).json(r);
async function scopedApp(req, res) {
  const app = await prisma.application.findFirst({ where: { id: req.params.id, ...applicationWhere(req.user) }, include: { candidate: { select: { id: true, name: true } }, requirement: { select: { id: true, title: true, clientId: true, department: true, employmentType: true, workMode: true, location: true, hiringType: true, internal: true } } } });
  if (!app) res.status(404).json({ error: 'That offer is not in your list.' });
  return app;
}

router.get('/offers/clauses', view, S.wrap(async (req, res) => res.json({ rows: (await S.items.list(KIND, {}, { order: 'asc' })).sort((a, b) => (a.order || 0) - (b.order || 0)), canEdit: S.isAdmin(req.user) && !req.viewAs })));
router.post('/offers/clauses', S.adminOnly, S.wrap(async (req, res) => {
  const c = cleanClause(req.body || {}); if (c.error) return res.status(400).json(c);
  const row = await S.items.create(KIND, c.value, req.user);
  await logAudit({ userId: req.user.id, action: 'Offer clause added', entity: 'OfferClause', entityId: row.id, toValue: row.title });
  res.status(201).json(row);
}));
router.put('/offers/clauses/:id', S.adminOnly, S.wrap(async (req, res) => {
  const cur = await S.items.get(req.params.id, KIND); if (!cur) return res.status(404).json({ error: 'Clause not found.' });
  const c = cleanClause({ ...cur, active: cur.status !== 'OFF', ...(req.body || {}) }); if (c.error) return res.status(400).json(c);
  await logAudit({ userId: req.user.id, action: 'Offer clause changed', entity: 'OfferClause', entityId: cur.id, fromValue: cur.text.slice(0, 300), toValue: c.value.text.slice(0, 300) });
  res.json(await S.items.update(cur.id, c.value));
}));
router.delete('/offers/clauses/:id', S.adminOnly, S.wrap(async (req, res) => {
  const cur = await S.items.get(req.params.id, KIND); if (!cur) return res.status(404).json({ error: 'Clause not found.' });
  await S.items.update(cur.id, { status: 'OFF' }); // switched off, never deleted: a sent letter can be traced to it
  await logAudit({ userId: req.user.id, action: 'Offer clause switched off', entity: 'OfferClause', entityId: cur.id, toValue: cur.title });
  res.json({ ok: true });
}));
router.get('/offers/:id/clauses', view, S.wrap(async (req, res) => { const app = await scopedApp(req, res); if (app) res.json(await clausesFor(app)); }));
router.put('/offers/:id/clause-fields', edit, S.wrap(async (req, res) => {
  const app = await scopedApp(req, res); if (!app) return;
  const { fields } = await clausesFor(app);
  const raw = (req.body || {}).values || {};
  const values = {}; fields.forEach((f) => { if (raw[f.key] !== undefined) values[f.key] = String(raw[f.key]).slice(0, 300); });
  const [cur] = await S.items.list('offer-fields', { refId: app.id });
  if (cur) await S.items.update(cur.id, { values: { ...(cur.values || {}), ...values } });
  else await S.items.create('offer-fields', { refType: 'Application', refId: app.id, values }, req.user);
  await logAudit({ userId: req.user.id, action: 'Offer clause fields saved', entity: 'Application', entityId: app.id, toValue: Object.keys(values).join(', ') });
  res.json(await clausesFor(app));
}));

router.get('/offers/bulk/candidates', view, S.wrap(async (req, res) => {
  const apps = await prisma.application.findMany({
    where: { AND: [applicationWhere(req.user), { OR: [{ stage: 'SELECTED' }, { offerStatus: 'Offer Declined' }] }] },
    select: { id: true, stage: true, offerStatus: true, offeredCtc: true, joiningDate: true, candidate: { select: { name: true } }, requirement: { select: { title: true, internal: true, client: { select: { name: true } } } } },
    orderBy: { updatedAt: 'desc' }, take: 1000,
  });
  res.json({ rows: apps.map((a) => ({ id: a.id, name: a.candidate && a.candidate.name, job: a.requirement && a.requirement.title, client: a.requirement && (a.requirement.internal ? 'TeamLink (internal)' : a.requirement.client && a.requirement.client.name), stage: a.stage, offerStatus: a.offerStatus, offeredCtc: a.offeredCtc, joiningDate: a.joiningDate })) });
}));
router.post('/offers/bulk/prepare', edit, S.wrap(async (req, res) => {
  const b = req.body || {};
  const rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, 200);
  if (!rows.length) return res.status(400).json({ error: 'Pick the people to offer.' });
  const out = [];
  for (const r of rows) {
    const body = { offeredCtc: r.offeredCtc ?? b.offeredCtc, joiningDate: r.joiningDate || b.joiningDate || undefined, offerDate: b.offerDate || undefined, offerNotes: b.offerNotes || undefined, confirmCtc: b.confirmCtc };
    const x = await self(req, 'POST', `/offers/${encodeURIComponent(String(r.applicationId))}/prepare`, body); // eslint-disable-line no-await-in-loop
    out.push({ applicationId: r.applicationId, ok: x.status === 200, status: x.status, message: x.body.message || x.body.error || null, name: (x.body.candidate && x.body.candidate.name) || null });
  }
  const ok = out.filter((x) => x.ok).length;
  await logAudit({ userId: req.user.id, action: 'Bulk offers prepared', entity: 'Application', entityId: out.filter((x) => x.ok).map((x) => x.applicationId).slice(0, 5).join(','), toValue: `${ok} of ${out.length} prepared` });
  res.json({ prepared: ok, refused: out.length - ok, rows: out, message: `${ok} offer(s) prepared and waiting for approval${out.length - ok ? `, ${out.length - ok} not (see each row)` : ''}.` });
}));
router.post('/offers/bulk/letters', view, S.wrap(async (req, res) => {
  const ids = (Array.isArray((req.body || {}).ids) ? req.body.ids : []).slice(0, 200).map(String);
  const out = [];
  for (const id of ids) {
    const x = await self(req, 'GET', `/offers/${encodeURIComponent(id)}/letter`); // eslint-disable-line no-await-in-loop
    out.push({ applicationId: id, ok: x.status === 200, text: x.body.text || null, error: x.status === 200 ? null : (x.body.error || 'Not available') });
  }
  res.json({ rows: out });
}));

module.exports = { router, appendClauses, clausesFor, matches };
