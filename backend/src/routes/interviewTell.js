// ---------------------------------------------------------------------------
// /api/ats — "NOW TELL THEM" after an interview is booked / moved / cancelled, and the reminder plan.
// (utils/interviewTell.js, utils/interviewEngine.js, utils/interviewReminderPlan.js)
//
//   GET  /interviews/:id/tell?kind=          the window: candidate channels + the four parties, for THIS login
//   POST /interviews/:id/tell/send-all       { kind, again }  Mail + WhatsApp + SMS wherever connected
//   POST /interviews/:id/tell/notify         { kind, who: 'all' | [partyKey] }  bell + mail to the team
//   POST /interviews/:id/tell/copied         { kind, channel }  "I copied the words" is a contact too
//   POST /interviews/:id/tell/done           { kind }  the window was closed: settle the automatic step message
//   POST /interviews/tell/status             { applicationIds }  who of these was told (bulk scheduling summary)
//   GET  /interview-reminder-plan            who is reminded, when, how
//   PUT  /interview-reminder-plan            Super Admin / Admin / HR
//
// The candidate's own sends go through the messaging module (routes/messaging.js: /preview, /send), so
// every rule there applies; this file only decides what the window shows and keeps nobody told twice.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth, requireProduct } = require('../middleware/auth');
const { can } = require('../utils/permissions');
const { applicationWhere, OUT_OF_SCOPE } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const TELL = require('../utils/interviewTell');
const PLAN = require('../utils/interviewReminderPlan');
const ENGINE = require('../utils/interviewEngine');

const router = express.Router();
router.use(requireAuth);
router.use(requireProduct('ats'));

const mayAct = async (user) => (await can(user, 'ats', 'interviews', 'Schedule Interview', 'create')) || (await can(user, 'ats', 'interviews', 'Schedule Interview', 'edit'));
const mayLook = async (user) => (await mayAct(user)) || (await can(user, 'ats', 'interviews', 'Calendar View', 'view'));
const DENIED = { error: "This action isn't included in your role's permissions" };

// The interview must be inside the caller's own area.
async function scoped(req, res) {
  const app = await prisma.application.findFirst({ where: { id: req.params.id, ...applicationWhere(req.user) }, select: { id: true } });
  if (app) return app;
  const exists = await prisma.application.findUnique({ where: { id: req.params.id }, select: { id: true } });
  if (exists) res.status(403).json(OUT_OF_SCOPE); else res.status(404).json({ error: 'Application not found' });
  return null;
}

router.get('/interviews/:id/tell', async (req, res, next) => {
  try {
    if (!(await mayLook(req.user))) return res.status(403).json(DENIED);
    if (!(await scoped(req, res))) return undefined;
    const out = await TELL.payload(req.user, req.params.id, String(req.query.kind || ''));
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    return res.json(out);
  } catch (err) { return next(err); }
});

router.post('/interviews/:id/tell/send-all', async (req, res, next) => {
  try {
    if (!(await mayLook(req.user))) return res.status(403).json(DENIED);
    if (!(await scoped(req, res))) return undefined;
    const out = await TELL.sendAll(req.user, req.params.id, String((req.body && req.body.kind) || ''), { again: !!(req.body && req.body.again) });
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    await logAudit({ userId: req.user.id, actorName: req.user.name, action: `Interview message to the candidate on ${out.attempts.filter((a) => ['sent', 'sending'].includes(a.status)).map((a) => a.channel).join(' + ') || 'no channel'}`, entity: 'Application', entityId: req.params.id, toValue: out.attempts.map((a) => `${a.channel}: ${a.status}`).join(' · ').slice(0, 300) });
    return res.json(out);
  } catch (err) { return next(err); }
});

router.post('/interviews/:id/tell/notify', async (req, res, next) => {
  try {
    if (!(await mayAct(req.user))) return res.status(403).json(DENIED);
    if (!(await scoped(req, res))) return undefined;
    const b = req.body || {};
    const out = await TELL.notify(req.user, req.params.id, String(b.kind || ''), b.who === 'all' ? 'all' : (Array.isArray(b.who) ? b.who.map(String) : []));
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    await logAudit({ userId: req.user.id, actorName: req.user.name, action: `Interview team told (${out.kind})`, entity: 'Application', entityId: req.params.id, toValue: out.results.map((r) => r.name).join(', ').slice(0, 300) });
    return res.json(out);
  } catch (err) { return next(err); }
});

router.post('/interviews/:id/tell/copied', async (req, res, next) => {
  try {
    if (!(await mayLook(req.user))) return res.status(403).json(DENIED);
    if (!(await scoped(req, res))) return undefined;
    const out = await TELL.logCopied(req.user, req.params.id, String((req.body && req.body.channel) || ''), String((req.body && req.body.kind) || ''));
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    return res.json(out);
  } catch (err) { return next(err); }
});

// The window was closed. If a person told the candidate, the automatic "Interview scheduled" step message that
// was still waiting for this interview is cancelled ("sent by hand"), so the candidate does not get it twice.
router.post('/interviews/:id/tell/done', async (req, res, next) => {
  try {
    if (!(await mayLook(req.user))) return res.status(403).json(DENIED);
    if (!(await scoped(req, res))) return undefined;
    const app = await prisma.application.findUnique({ where: { id: req.params.id }, include: { candidate: true, requirement: true } });
    const kind = TELL.kindOf(app, String((req.body && req.body.kind) || ''));
    const told = await TELL.toldSummary(app, kind);
    let settled = 0;
    if (told.told && kind === 'scheduled') settled = await ENGINE.settleStageMessage(app.id, req.user.name);
    return res.json({ ok: true, told: told.told, settled });
  } catch (err) { return next(err); }
});

// Bulk scheduling summary: which of these interviews already reached the candidate.
router.post('/interviews/tell/status', async (req, res, next) => {
  try {
    if (!(await mayLook(req.user))) return res.status(403).json(DENIED);
    const ids = [...new Set((Array.isArray(req.body && req.body.applicationIds) ? req.body.applicationIds : []).map(String))].slice(0, 200);
    const apps = ids.length ? await prisma.application.findMany({ where: { id: { in: ids }, ...applicationWhere(req.user) }, include: { candidate: { select: { id: true, name: true } } } }) : [];
    const rows = [];
    for (const a of apps) {
      // eslint-disable-next-line no-await-in-loop
      const told = await TELL.toldSummary(a, TELL.kindOf(a, 'scheduled'));
      rows.push({ applicationId: a.id, candidateId: a.candidateId, name: a.candidate.name, told: told.told, how: told.list.filter((x) => x.told).map((x) => `${x.channel}: ${x.word}`) });
    }
    return res.json({ rows });
  } catch (err) { return next(err); }
});

// ---- the reminder plan ----------------------------------------------------------------------------------------------------
const mayEditPlan = (u) => ['SUPER_ADMIN', 'ADMIN'].includes(u.role) || ['SUPER_ADMIN', 'ADMIN', 'HR'].includes(u.atsRole) || u.hrmsRole === 'HR';

router.get('/interview-reminder-plan', async (req, res, next) => {
  try {
    if (!(await mayLook(req.user)) && !mayEditPlan(req.user)) return res.status(403).json(DENIED);
    const IN = require('../utils/interviewNotices'); // eslint-disable-line global-require
    const [plan, staff, cand] = await Promise.all([PLAN.load(), IN.loadStaffSettings(), IN.loadSettings()]);
    res.json({
      plan, staff, candidateEmailsOn: cand.enabled === true, canEdit: mayEditPlan(req.user), parties: PLAN.PARTIES.map((k) => ({ key: k, label: PLAN.PARTY_WORD[k] })),
      sandbox: require('../utils/sandbox').isSandbox(), // eslint-disable-line global-require
    });
  } catch (err) { next(err); }
});

router.put('/interview-reminder-plan', async (req, res, next) => {
  try {
    if (!mayEditPlan(req.user)) return res.status(403).json({ error: 'Only a Super Admin, an Admin or HR can change the interview reminders.' });
    const out = await PLAN.save(req.body || {}, req.user);
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Interview reminder plan changed', entity: 'AppSetting', entityId: PLAN.KEY, fromValue: JSON.stringify(PLAN.clean(out.before)).slice(0, 900), toValue: JSON.stringify(PLAN.clean(out.settings)).slice(0, 900) });
    return res.json({ plan: out.settings, message: 'Saved. The new reminder plan is used from the next check (every 5 minutes).' });
  } catch (err) { return next(err); }
});

module.exports = router;
