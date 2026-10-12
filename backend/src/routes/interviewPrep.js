// ---------------------------------------------------------------------------
// /api/ats — INTERVIEW PREPARATION: suggested questions for a client / team / AI interview, written from
// the job description, editable by the recruiter, and sent to the candidate so they can prepare.
// (utils/interviewPrep.js holds the rules; components/interviews/InterviewPrep.jsx is the card.)
//
//   GET  /interviews/:id/prep?type=            the card for this login (type = client | team | ai, else worked out)
//   PUT  /interviews/:id/prep                  { type, groups, tips, version }  edit / add / remove (recruiter, TL, STL, Admin)
//   POST /interviews/:id/prep/regenerate       { type, ai }  write it again from the job (replaces edits)
//   POST /interviews/:id/prep/send             { type, channels:['Email'], again }  to the candidate, through the normal send
//   POST /interviews/:id/prep/link             { type }  copy the candidate's page link (counts as shared)
//   GET  /jobs/:requirementId/prep?type=       the pack of a job, read only (the BDE of the client can read it)
//   GET  /public/interview-prep/:token         (public router below) the candidate's own page, no login
//
// WHO: look = anyone who may look at the interview calendar in their own area; change / send = a login that
// may schedule interviews AND is not a BDE (BDE, BDE team lead, Manager, Assistant Manager and Accounts read only).
// The payload never holds a candidate's number, address, pay, AI score or internal notes.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth, requireProduct } = require('../middleware/auth');
const { can } = require('../utils/permissions');
const scope = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const PREP = require('../utils/interviewPrep');
const { rateLimit } = require('../utils/publicRateLimit');

const DENIED = { error: "This action isn't included in your role's permissions" };
const APP_INCLUDE = { candidate: true, requirement: { include: { client: true } } };

const mayAct = async (user) => (await can(user, 'ats', 'interviews', 'Schedule Interview', 'create')) || (await can(user, 'ats', 'interviews', 'Schedule Interview', 'edit'));
const mayLook = async (user) => (await mayAct(user)) || (await can(user, 'ats', 'interviews', 'Calendar View', 'view'));
async function rights(user) {
  const vr = scope.clientViewRole(user);
  const act = await mayAct(user);
  const edit = act && !['bde', 'client', 'candidate', 'none', 'accounts'].includes(vr) && !['MANAGER', 'ASSISTANT_MANAGER'].includes(user.atsRole) && !['MANAGER', 'ASSISTANT_MANAGER'].includes(user.role);
  return { look: await mayLook(user), edit, role: vr };
}
const typeOf = (v) => (PREP.TYPES[String(v || '')] ? String(v) : '');

const router = express.Router();
router.use(requireAuth);
router.use(requireProduct('ats'));

// The interview (application) must be inside the caller's own area.
async function loadApp(req, res) {
  const app = await prisma.application.findFirst({ where: { id: req.params.id, ...scope.applicationWhere(req.user) }, include: APP_INCLUDE });
  if (app) return app;
  const exists = await prisma.application.findUnique({ where: { id: req.params.id }, select: { id: true } });
  if (exists) res.status(403).json(scope.OUT_OF_SCOPE || { error: 'This is outside your area.' }); else res.status(404).json({ error: 'Application not found' });
  return null;
}

// One dry run of the normal send for Email: the same gates as the real send. -> { state, reason }
async function emailState(user, app, pack) {
  try {
    const f = PREP.factsOf(app.requirement);
    const v = PREP.candidateView({ ...pack, type: PREP.typeFor(app, pack.type) }, app, f);
    const plan = await require('../utils/bulkMessaging').buildPlan(user, { // eslint-disable-line global-require
      audience: 'candidates', ids: [app.candidateId], channels: ['Email'], kind: 'individual', applicationId: app.id, purpose: PREP.PREP_LABEL, urgent: true,
      perChannel: { Email: { subject: PREP.emailSubject(v), body: PREP.emailText(v, null, null) } },
    });
    if (plan.error) return { state: 'blocked', reason: plan.error };
    const r = plan.plan.recipients[0];
    if (!r) return { state: 'blocked', reason: 'Nothing to send.' };
    if (r.status === 'queued') return { state: 'send', reason: null };
    if (/^No email|not a valid/i.test(r.reason || '')) return { state: 'none', reason: r.reason };
    return { state: 'blocked', reason: r.reason || 'Cannot be sent.' };
  } catch (e) { return { state: 'blocked', reason: String(e.message).slice(0, 160) }; }
}

router.get('/interviews/:id/prep', async (req, res, next) => {
  try {
    const rt = await rights(req.user);
    if (!rt.look) return res.status(403).json(DENIED);
    const app = await loadApp(req, res); if (!app) return undefined;
    const out = await PREP.appPayload(req.user, app, { type: typeOf(req.query.type), canEdit: rt.edit, canSend: rt.edit, req });
    return res.json(out);
  } catch (err) { return next(err); }
});

// How the mail would go (a dry run of the normal send: consent, switch, address) - kept apart so the card opens fast.
router.get('/interviews/:id/prep/channels', async (req, res, next) => {
  try {
    const rt = await rights(req.user);
    if (!rt.edit) return res.status(403).json({ error: rt.look ? 'Your role can read the questions but not send them.' : DENIED.error });
    const app = await loadApp(req, res); if (!app) return undefined;
    const type = PREP.typeFor(app, typeOf(req.query.type));
    const ens = await PREP.ensurePack(app.requirement, type, { user: req.user });
    const email = await emailState(req.user, app, { ...ens.pack, type });
    const ch = await require('../utils/messaging').channelStatus().catch(() => ({})); // eslint-disable-line global-require
    return res.json({ email, connected: { Email: !!(ch.Email && ch.Email.configured), WhatsApp: !!(ch.WhatsApp && ch.WhatsApp.configured), SMS: !!(ch.SMS && ch.SMS.configured) } });
  } catch (err) { return next(err); }
});

router.put('/interviews/:id/prep', async (req, res, next) => {
  try {
    const rt = await rights(req.user);
    if (!rt.edit) return res.status(403).json({ error: rt.look ? 'You can read these questions but not change them.' : DENIED.error });
    const app = await loadApp(req, res); if (!app) return undefined;
    const b = req.body || {};
    const type = PREP.typeFor(app, typeOf(b.type));
    await PREP.ensurePack(app.requirement, type, { user: req.user });
    const out = await PREP.editPack(app.requirement, type, b, req.user, b.version ? String(b.version) : null);
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    if (out.changed) await logAudit({ userId: req.user.id, actorName: req.user.name, action: `Interview preparation edited (${PREP.TYPES[type]})`, entity: 'Requirement', entityId: app.requirementId, toValue: `${out.pack.version}` });
    const payload = await PREP.appPayload(req.user, app, { type, canEdit: true, canSend: true, req });
    return res.json({ ...payload, saved: out.changed ? 'Saved. The candidate gets this version.' : 'Nothing changed.', warnings: out.warnings });
  } catch (err) { return next(err); }
});

router.post('/interviews/:id/prep/regenerate', async (req, res, next) => {
  try {
    const rt = await rights(req.user);
    if (!rt.edit) return res.status(403).json({ error: rt.look ? 'You can read these questions but not change them.' : DENIED.error });
    const app = await loadApp(req, res); if (!app) return undefined;
    const b = req.body || {};
    const type = PREP.typeFor(app, typeOf(b.type));
    const out = await PREP.ensurePack(app.requirement, type, { user: req.user, regenerate: true, useAi: b.ai !== false });
    await logAudit({ userId: req.user.id, actorName: req.user.name, action: `Interview preparation written again (${PREP.TYPES[type]})`, entity: 'Requirement', entityId: app.requirementId, toValue: out.pack.source === 'ai' ? 'AI' : 'template' });
    const payload = await PREP.appPayload(req.user, app, { type, canEdit: true, canSend: true, req });
    return res.json({ ...payload, saved: out.pack.source === 'ai' ? 'Written again by AI. Please read it before you send it.' : `Written again from the job (template).${out.pack.aiNote ? ` ${out.pack.aiNote}` : ''}` });
  } catch (err) { return next(err); }
});

router.post('/interviews/:id/prep/send', async (req, res, next) => {
  try {
    const rt = await rights(req.user);
    if (!rt.edit) return res.status(403).json({ error: rt.look ? 'Your role can read the questions but not send them.' : DENIED.error });
    const app = await loadApp(req, res); if (!app) return undefined;
    const b = req.body || {};
    const out = await PREP.send(req.user, app, { type: typeOf(b.type), channels: Array.isArray(b.channels) ? b.channels.map(String) : ['Email'], again: !!b.again, req });
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    await logAudit({ userId: req.user.id, actorName: req.user.name, action: `Interview preparation sent to the candidate (${out.attempts.filter((a) => ['sent', 'sending'].includes(a.status)).map((a) => a.channel).join(' + ') || 'not sent'})`, entity: 'Application', entityId: app.id, toValue: out.attempts.map((a) => `${a.channel}: ${a.status}`).join(' · ').slice(0, 300) });
    return res.json(out);
  } catch (err) { return next(err); }
});

router.post('/interviews/:id/prep/link', async (req, res, next) => {
  try {
    const rt = await rights(req.user);
    if (!rt.edit) return res.status(403).json({ error: rt.look ? 'Your role can read the questions but not share them.' : DENIED.error });
    const app = await loadApp(req, res); if (!app) return undefined;
    const out = await PREP.markLinkShared(req.user, app, { type: typeOf(req.body && req.body.type), req });
    await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Interview preparation link copied', entity: 'Application', entityId: app.id });
    return res.json(out);
  } catch (err) { return next(err); }
});

// The pack of one JOB (read only): a BDE reads the questions for the jobs of their clients.
router.get('/jobs/:requirementId/prep', async (req, res, next) => {
  try {
    const rt = await rights(req.user);
    if (!rt.look) return res.status(403).json(DENIED);
    const r = await prisma.requirement.findFirst({ where: { id: req.params.requirementId, ...scope.requirementWhere(req.user) }, include: { client: true } });
    if (!r) return res.status(404).json({ error: 'Job not found' });
    const type = typeOf(req.query.type) || (r.internal ? 'team' : 'client');
    const out = await PREP.ensurePack(r, type, { user: req.user });
    return res.json({ requirementId: r.id, job: r.title, type, types: Object.entries(PREP.TYPES).map(([key, label]) => ({ key, label })), pack: PREP.packView(out.pack, out.f), stale: out.stale, canEdit: false });
  } catch (err) { return next(err); }
});

// ---- the candidate's own page (no login; the link holds a signed key) -------------------------------------------------
const pub = express.Router();
pub.use(rateLimit({ bucket: 'interview-prep', max: 90, windowMs: 10 * 60000 }));
pub.get('/:token', async (req, res, next) => {
  try {
    const out = await PREP.publicView(req.params.token);
    if (out.error) return res.status(out.status || 404).json({ error: out.error });
    res.set('Cache-Control', 'no-store');
    return res.json(out.view);
  } catch (err) { return next(err); }
});

module.exports = router;
module.exports.publicRouter = pub;
