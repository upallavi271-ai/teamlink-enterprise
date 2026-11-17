// ---------------------------------------------------------------------------
// /api/ats-experience — Reports & Team -> "Candidate experience" and "Client health" (founder ATS audit 2026-11-17).
// The rules live in utils/atsExperience.js (surveys, complaints, escalation, apply funnel) and utils/atsExperienceReports.js
// (the reports and their scope). TeamLink logins with the ATS product only; every list is cut to the login's scope.
//
//   GET  /catalog                         what this login may do here
//   GET  /candidate-report ?from&to       NPS + average stars by month / recruiter / client / stage
//   GET  /surveys ?side=candidate|client  the surveys sent, their status and (unanswered) link
//   POST /surveys/send {applicationId, event}            send one by hand (still one per event)
//   GET  /complaints ?side&status         POST /complaints {side, applicationId|clientId, subject, details}
//   PATCH /complaints/:id {status, note, ownerId}
//   GET  /client-nps ?from&to             POST /client-surveys/quarterly {clientIds?}   GET|PUT /client-surveys/settings
//   GET|PUT /escalation-matrix/:clientId  {levels:[{level, userId, hours}]}
//   GET  /retention ?months               POST|DELETE /clients/:id/lost {reason, notes}
//   GET  /apply-funnel ?from&to           GET /export/:name ?format=xlsx|csv (&side, &months ...)
//   GET  /pick/applications ?q   /pick/clients ?q   /pick/people
// The client's own side: /api/portal/client/concerns (portalRouter below) - a client login raises and follows its concerns.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth, requireProduct } = require('../middleware/auth');
const { requireInternal } = require('../utils/permissions');
const { applicationWhere, clientWhere } = require('../utils/scope');
const { REQUIREMENT_LIVE_STATUSES } = require('../utils/atsVocab');
const { toCsv, toXlsxBook } = require('../utils/tabularExport');
const { logAudit } = require('../utils/audit');
const E = require('../utils/atsExperience');
const R = require('../utils/atsExperienceReports');

const router = express.Router();
router.use(requireAuth);
router.use(requireProduct('ats'));
router.use(requireInternal);
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error('[ats-experience]', err); // eslint-disable-line no-console
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});
const send = (res, out) => (out && out.error ? res.status(out.status || 400).json({ error: out.error }) : res.json(out));
const SETTINGS_KEY = 'client-nps-quarterly';

router.get('/catalog', wrap(async (req, res) => res.json({
  seesAllCandidates: R.seesAllCandidates(req.user), seesAllClients: R.seesAllClients(req.user), mayEditMatrix: R.mayEditMatrix(req.user),
  mayRevenue: R.mayRevenue(req.user), quarter: E.quarterOf(), candidateDueHours: E.CAND_DUE_HOURS, defaultLevelHours: E.DEFAULT_LEVEL_HOURS, statuses: E.STATUSES,
})));

// --- candidate side ---------------------------------------------------------------
router.get('/candidate-report', wrap(async (req, res) => res.json(await R.candidateReport(req.user, req.query))));
router.get('/surveys', wrap(async (req, res) => res.json(await R.surveyList(req.user, req.query, req))));
router.post('/surveys/send', wrap(async (req, res) => {
  const { applicationId, event } = req.body || {};
  if (!['interview', 'offer', 'joining'].includes(event)) return res.status(400).json({ error: 'Pick the survey: interview, offer or joining.' });
  const app = await prisma.application.findFirst({ where: { AND: [{ id: String(applicationId || '') }, applicationWhere(req.user)] }, select: { id: true } });
  if (!app) return res.status(404).json({ error: 'That application was not found in your area.' });
  const out = await E.ensureCandidateSurvey(app.id, event, { user: req.user, req });
  if (out.error) return res.status(400).json(out);
  return res.status(out.created ? 201 : 200).json(out);
}));

// --- complaints (both sides) -----------------------------------------------------------
router.get('/complaints', wrap(async (req, res) => res.json(await R.complaintList(req.user, req.query))));
router.post('/complaints', wrap(async (req, res) => {
  const b = req.body || {};
  const side = b.side === 'client' ? 'client' : 'candidate';
  if (side === 'candidate') {
    const app = await prisma.application.findFirst({ where: { AND: [{ id: String(b.applicationId || '') }, applicationWhere(req.user)] }, select: { id: true } });
    if (!app) return res.status(404).json({ error: 'Pick the candidate\'s application (in your area) the complaint is about.' });
  } else {
    const c = await prisma.client.findFirst({ where: { AND: [{ id: String(b.clientId || '') }, clientWhere(req.user)] }, select: { id: true } });
    if (!c && !R.seesAllClients(req.user)) return res.status(404).json({ error: 'Pick a client in your area.' });
  }
  const out = await E.createComplaint({ side, source: side === 'client' ? 'Logged by BDE / team' : 'Logged by recruiter / team', applicationId: b.applicationId, clientId: b.clientId, subject: b.subject, details: b.details }, req.user);
  if (out.error) return send(res, out);
  return res.status(201).json(R.shapeComplaint(out));
}));
router.patch('/complaints/:id', wrap(async (req, res) => {
  const c = await E.getComplaint(req.params.id);
  if (!c || !(await R.complaintInScope(req.user, c))) return res.status(404).json({ error: 'Complaint not found.' });
  const out = await E.updateComplaint(c.id, req.body || {}, req.user);
  if (out.error) return send(res, out);
  return res.json(R.shapeComplaint(out));
}));

// --- client side ---------------------------------------------------------------------
router.get('/client-nps', wrap(async (req, res) => res.json(await R.clientNps(req.user, req.query))));
async function activeClientIds(user) {
  const where = R.seesAllClients(user) ? {} : clientWhere(user);
  const live = await prisma.requirement.findMany({ where: { status: { in: REQUIREMENT_LIVE_STATUSES }, internal: false, client: where }, select: { clientId: true }, distinct: ['clientId'] });
  const joined = await prisma.application.findMany({ where: { joinedAt: { gte: new Date(Date.now() - 90 * E.DAY) }, requirement: { internal: false, client: where } }, select: { requirement: { select: { clientId: true } } } });
  return [...new Set([...live.map((r) => r.clientId), ...joined.map((a) => a.requirement.clientId)])];
}
router.post('/client-surveys/quarterly', wrap(async (req, res) => {
  if (!R.mayEditMatrix(req.user)) return res.status(403).json({ error: 'Only Admin, a Manager or the BDE TL sends the quarterly survey.' });
  const active = await activeClientIds(req.user);
  const asked = Array.isArray((req.body || {}).clientIds) ? req.body.clientIds.map(String) : null;
  const ids = asked ? active.filter((id) => asked.includes(id)) : active;
  const out = { quarter: E.quarterOf(), created: 0, already: 0, skipped: 0, results: [] };
  for (const id of ids.slice(0, 500)) {
    // eslint-disable-next-line no-await-in-loop
    const r = await E.ensureClientSurvey(id, 'quarterly', { user: req.user, req });
    if (r.created) out.created += 1; else if (r.existing) out.already += 1; else out.skipped += 1;
    out.results.push({ clientId: id, ...r, link: undefined });
  }
  await logAudit({ userId: req.user.id, action: 'Quarterly client survey sent', entity: 'AtsSurvey', toValue: `${out.quarter}: ${out.created} new, ${out.already} already sent` });
  return res.json(out);
}));
router.get('/client-surveys/settings', wrap(async (req, res) => {
  const row = await prisma.appSetting.findUnique({ where: { key: SETTINGS_KEY } }).catch(() => null);
  let v = {}; try { v = row ? JSON.parse(row.value) : {}; } catch { v = {}; }
  res.json({ autoQuarterly: v.autoQuarterly === true, updatedByName: row ? row.updatedByName : null, mayEdit: R.mayEditMatrix(req.user) });
}));
router.put('/client-surveys/settings', wrap(async (req, res) => {
  if (!R.mayEditMatrix(req.user)) return res.status(403).json({ error: 'Only Admin, a Manager or the BDE TL changes this.' });
  const value = JSON.stringify({ autoQuarterly: !!(req.body || {}).autoQuarterly });
  await prisma.appSetting.upsert({ where: { key: SETTINGS_KEY }, create: { key: SETTINGS_KEY, value, updatedById: req.user.id, updatedByName: req.user.name }, update: { value, updatedById: req.user.id, updatedByName: req.user.name } });
  await logAudit({ userId: req.user.id, action: 'Quarterly client survey switch changed', entity: 'AppSetting', entityId: SETTINGS_KEY, toValue: value });
  res.json({ ok: true, autoQuarterly: !!(req.body || {}).autoQuarterly });
}));

async function clientInScope(user, clientId) {
  if (R.seesAllClients(user)) return prisma.client.findUnique({ where: { id: clientId }, select: { id: true, name: true } });
  return prisma.client.findFirst({ where: { AND: [{ id: clientId }, clientWhere(user)] }, select: { id: true, name: true } });
}
router.get('/escalation-matrix/:clientId', wrap(async (req, res) => {
  const c = await clientInScope(req.user, req.params.clientId);
  if (!c) return res.status(404).json({ error: 'Client not found.' });
  res.json({ client: c.name, mayEdit: R.mayEditMatrix(req.user), ...(await E.matrixFor(c.id)) });
}));
router.put('/escalation-matrix/:clientId', wrap(async (req, res) => {
  if (!R.mayEditMatrix(req.user)) return res.status(403).json({ error: 'Only Admin, a Manager or the BDE TL changes the escalation matrix.' });
  const c = await clientInScope(req.user, req.params.clientId);
  if (!c) return res.status(404).json({ error: 'Client not found.' });
  const out = await E.saveMatrix(c.id, (req.body || {}).levels, req.user);
  if (out.error) return send(res, out);
  await logAudit({ userId: req.user.id, action: 'Client escalation matrix saved', entity: 'Client', entityId: c.id, toValue: out.levels.map((l) => `L${l.level}: ${l.name || '—'} ${l.hours}h`).join(' · ') });
  return res.json({ client: c.name, mayEdit: true, ...out });
}));
router.get('/retention', wrap(async (req, res) => res.json(await R.retention(req.user, req.query))));
router.post('/clients/:id/lost', wrap(async (req, res) => send(res, await R.markLost(req.user, req.params.id, req.body || {}))));
router.delete('/clients/:id/lost', wrap(async (req, res) => send(res, await R.clearLost(req.user, req.params.id))));

// --- job portal apply funnel -------------------------------------------------------
router.get('/apply-funnel', wrap(async (req, res) => res.json(await R.applyFunnel(req.user, req.query))));

// --- downloads -----------------------------------------------------------------------
router.get('/export/:name', wrap(async (req, res) => {
  const sheets = await R.exportSheets(req.user, req.params.name, req.query);
  if (!sheets) return res.status(404).json({ error: 'Unknown report.' });
  const format = req.query.format === 'csv' ? 'csv' : 'xlsx';
  const base = `teamlink-${req.params.name}-${new Date().toISOString().slice(0, 10)}`;
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: `ATS report exported (${format.toUpperCase()})`, entity: 'AtsReport', entityId: req.params.name, toValue: `${sheets.reduce((n, s) => n + s.rows.length, 0)} row(s)` });
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.csv"`);
    return res.send(`﻿${sheets.map((s) => `${s.name}\r\n${toCsv(s.headers, s.rows)}`).join('\r\n\r\n')}`);
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${base}.xlsx"`);
  return res.send(toXlsxBook(sheets.map((s) => ({ ...s, name: s.name.slice(0, 31) }))));
}));

// --- pickers -----------------------------------------------------------------------------
router.get('/pick/applications', wrap(async (req, res) => {
  const t = String(req.query.q || '').trim().slice(0, 60);
  if (t.length < 2) return res.json({ rows: [] });
  const rows = await prisma.application.findMany({
    where: { AND: [applicationWhere(req.user), { candidate: { OR: [{ name: { contains: t } }, { phone: { contains: t } }, { email: { contains: t } }] } }] },
    take: 20, orderBy: { updatedAt: 'desc' },
    select: { id: true, stage: true, candidate: { select: { name: true } }, requirement: { select: { title: true, internal: true, client: { select: { name: true } } } } },
  });
  res.json({ rows: rows.map((a) => ({ id: a.id, label: `${a.candidate.name} · ${a.requirement.title}${a.requirement.internal ? '' : ` · ${a.requirement.client.name}`}`, stage: a.stage })) });
}));
router.get('/pick/clients', wrap(async (req, res) => {
  const t = String(req.query.q || '').trim().slice(0, 60);
  const where = { AND: [R.seesAllClients(req.user) ? {} : clientWhere(req.user), { OR: [{ clientType: null }, { clientType: { not: 'Internal' } }] }, ...(t ? [{ name: { contains: t } }] : [])] };
  const rows = await prisma.client.findMany({ where, take: 50, orderBy: { name: 'asc' }, select: { id: true, name: true } });
  res.json({ rows });
}));
router.get('/pick/people', wrap(async (req, res) => {
  const rows = await prisma.user.findMany({ where: { status: 'Active', atsAccess: true, NOT: { role: { in: ['CLIENT', 'CANDIDATE', 'VENDOR'] } } }, take: 500, orderBy: { name: 'asc' }, select: { id: true, name: true, atsRole: true } });
  res.json({ rows });
}));

// ---------------------------------------------------------------------------
// The client portal side (mounted at /api/portal/client/concerns): a client login raises a concern and follows it. No staff names.
// ---------------------------------------------------------------------------
const portalRouter = express.Router();
portalRouter.use(requireAuth);
const isClientLogin = (u) => !!u && (u.role === 'CLIENT' || u.atsRole === 'CLIENT') && !!u.clientId;
portalRouter.use((req, res, next) => (isClientLogin(req.user) ? next() : res.status(403).json({ error: 'For client logins only.' })));
const forClient = (c) => ({ id: c.id, subject: c.subject, details: c.details, status: c.status, level: c.level, raisedOn: c.createdAt, resolvedOn: c.resolvedAt, resolution: c.resolution });
portalRouter.get('/', wrap(async (req, res) => {
  await E.runEscalations().catch(() => null);
  const rows = await E.q('SELECT * FROM "AtsComplaint" WHERE "side" = \'client\' AND "clientId" = ? ORDER BY "id" DESC LIMIT 200', req.user.clientId);
  res.json({ rows: rows.map(forClient) });
}));
portalRouter.post('/', wrap(async (req, res) => {
  const b = req.body || {};
  const out = await E.createComplaint({ side: 'client', source: 'Client portal', clientId: req.user.clientId, personName: req.user.name, subject: b.subject, details: b.details }, req.user);
  if (out.error) return send(res, out);
  return res.status(201).json(forClient(out));
}));

// The sweep (real server only; index.js): late complaints move up, and the quarterly client survey when its switch is on.
let timer = null;
async function sweepOnce({ now = Date.now() } = {}) {
  const out = await E.runEscalations({ now });
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: SETTINGS_KEY } });
    const v = row ? JSON.parse(row.value) : {};
    const ist = new Date(now + 330 * 60000);
    const dayOfQuarter = Math.floor((ist - Date.UTC(ist.getUTCFullYear(), Math.floor(ist.getUTCMonth() / 3) * 3, 1)) / E.DAY);
    if (v.autoQuarterly === true && dayOfQuarter < 15) {
      const live = await prisma.requirement.findMany({ where: { status: { in: REQUIREMENT_LIVE_STATUSES }, internal: false }, select: { clientId: true }, distinct: ['clientId'] });
      for (const r of live) await E.ensureClientSurvey(r.clientId, 'quarterly', {}); // eslint-disable-line no-await-in-loop
    }
  } catch (e) { console.error('[ats-experience] quarterly:', e.message); } // eslint-disable-line no-console
  return out;
}
function startSweep() {
  if (timer || require('../utils/sandbox').isSandbox()) return; // eslint-disable-line global-require
  timer = setInterval(() => { sweepOnce().catch((e) => console.error('[ats-experience] sweep:', e.message)); }, 15 * 60000); // eslint-disable-line no-console
  timer.unref();
}

module.exports = router;
module.exports.portalRouter = portalRouter;
module.exports.startSweep = startSweep;
module.exports.sweepOnce = sweepOnce;
