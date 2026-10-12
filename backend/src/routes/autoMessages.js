// ---------------------------------------------------------------------------
// /api/auto-messages - AUTOMATIC STAGE MESSAGES (rules, scheduled list, approvals).
//
//   GET  /rules                 the rules + settings + channel readiness + AI state    any staff login (read)
//   PUT  /rules                 { killSwitch?, quiet?, caps?, ai?, rules: {STAGE: {...}} }   Super Admin / Admin / HR
//   POST /preview               { stage, rule?, applicationId?, useAi? } -> real sample, nothing is written
//   GET  /samples?stage=        a few real people to preview with (in the caller's area)
//   GET  /scheduled             the list (scope-limited) with filters + cascading counts
//   GET  /summary               N waiting for an OK, N going out soon (the bell)
//   POST /scheduled/:id/send-now | /approve | /cancel | /edit
//   POST /people/:candidateId/pause     { paused, reason }
//   GET/PUT /jobs/:requirementId        a job's own setting (follow the rules / off / approve first)
//   POST /run                   send what is due now (Admin / HR; the sweep does this every minute)
//   GET  /history               who changed what
//
// Nobody here is ever shown a candidate's phone or e-mail. Scope is the same as the candidate lists.
// ---------------------------------------------------------------------------

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const R = require('../utils/autoMessageRules');
const AM = require('../utils/autoMessages');
const W = require('../utils/autoMessageWriter');
const prisma = require('../db');

const router = express.Router();
router.use(requireAuth);

const staffOnly = (req, res, next) => (R.canView(req.user) ? next() : res.status(403).json({ error: 'Not available to this login.' }));
router.use(staffOnly);
const needReady = async (res) => {
  if (await AM.supported()) return true;
  res.status(503).json({ error: 'Automatic messages are being set up on this server. Messages go the old way until then.' });
  return false;
};
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const WHERE = {
  Email: 'Administration > Integrations > Connections > Email (SMTP)',
  WhatsApp: 'Administration > Integrations > Connections > WhatsApp Business',
  SMS: 'Administration > Integrations > Connections > SMS Gateway',
};
const TODO = {
  Email: 'Add your mail server and sender address, then press Save & Connect.',
  WhatsApp: 'Needs a WhatsApp Business account from Meta. Add the phone number id and token, and get your message templates approved.',
  SMS: 'Needs an SMS provider account (MSG91 or Fast2SMS) and your registered (DLT) templates.',
};

async function channelInfo() {
  // eslint-disable-next-line global-require
  const st = await require('../utils/messaging').channelStatus().catch(() => ({}));
  return R.CHANNELS.map((c) => ({
    channel: c, connected: !!(st[c] && st[c].configured), detail: st[c] && st[c].detail || null,
    todo: st[c] && st[c].configured ? null : `Not connected: ${TODO[c]} Open ${WHERE[c]}.`,
    freeText: c === 'Email' ? 'Email can carry any wording, including AI-written text.' : (c === 'WhatsApp'
      ? 'WhatsApp can only start a chat with a template Meta approved. AI wording works only in the 24 hours after the person writes to us.'
      : 'SMS needs a registered (DLT) template, so the template wording is always used.'),
  }));
}

router.get('/rules', wrap(async (req, res) => {
  const settings = await R.loadSettings({ fresh: true });
  const ready = await AM.supported();
  // eslint-disable-next-line global-require
  const T = require('../utils/messageTemplates');
  const tpls = T.supported() ? await T.list({ audience: 'candidate', activeOnly: true }).catch(() => []) : [];
  const byPurpose = new Map();
  tpls.forEach((t) => {
    const e = byPurpose.get(t.purpose) || { purpose: t.purpose, label: t.purposeLabel, channels: {} };
    if (!e.channels[t.channel] || t.isDefault) e.channels[t.channel] = { id: t.id, name: t.name, version: t.version, subject: t.subject };
    byPurpose.set(t.purpose, e);
  });
  const ai = await W.aiReady();
  const jobs = await R.jobOverrides();
  const jobIds = Object.keys(jobs);
  const jobRows = jobIds.length ? await prisma.requirement.findMany({ where: { id: { in: jobIds } }, select: { id: true, title: true, department: true } }) : [];
  const paused = await R.pausedIds();
  const pausedRows = paused.length ? await prisma.candidate.findMany({ where: { id: { in: paused } }, select: { id: true, name: true } }) : [];
  const { rules, ...plain } = settings;
  res.json({
    ready,
    started: R.started(settings),
    canManage: R.canManage(req.user),
    canAct: R.canAct(req.user),
    settings: plain,
    rules: R.allRules(settings),
    channels: await channelInfo(),
    ai: { available: ai.available, reason: ai.reason, provider: ai.provider },
    templates: [...byPurpose.values()],
    jobs: jobRows.map((j) => ({ ...j, mode: jobs[j.id].mode, note: jobs[j.id].note || '', by: jobs[j.id].byName || null })),
    pausedPeople: pausedRows,
    words: {
      when: { now: 'Right away', delay: 'After some minutes', working: 'Next working hour (09:00 IST)', approval: 'Wait for the recruiter to say OK first' },
    },
  });
}));

router.put('/rules', wrap(async (req, res) => {
  if (!R.canManage(req.user)) return res.status(403).json({ error: 'Only a Super Admin, Admin or HR can change the automatic messages.' });
  // "AI writes it" needs a connected AI. Without one the control is disabled on the screen; the server says why too.
  const cur0 = await R.loadSettings({ fresh: true });
  const wantsAi = Object.entries((req.body || {}).rules || {}).some(([stage, r]) => r && r.wording === 'AI' && R.effectiveRule(stage, cur0).wording !== 'AI');
  if (wantsAi) {
    const ai = await W.aiReady();
    if (!ai.available) return res.status(409).json({ error: `"AI writes it" cannot be switched on yet: ${ai.reason || 'no AI is connected'}. The template wording is used until then.` });
  }
  const out = await R.saveSettings(req.user, req.body || {});
  if (out.error) return res.status(out.status || 400).json({ error: out.error });
  const { rules, ...plain } = out.settings;
  res.json({
    ok: true, started: R.started(out.settings), changed: out.changed, justStarted: out.started, settings: plain, rules: R.allRules(out.settings),
    message: out.started ? 'Saved. Automatic messages now run from this moment. Nobody who moved earlier gets a message.' : (out.changed ? 'Saved.' : 'Nothing changed.'),
  });
}));

router.get('/history', wrap(async (req, res) => {
  res.json({ rows: await R.history(40) });
}));

router.post('/preview', wrap(async (req, res) => {
  const b = req.body || {};
  const out = await AM.preview(req.user, { stage: b.stage, rule: b.rule, applicationId: b.applicationId, useAi: b.useAi === true });
  if (out.error) return res.status(out.status || 400).json({ error: out.error });
  res.json(out);
}));

router.get('/samples', wrap(async (req, res) => {
  res.json({ rows: await AM.sampleApplications(req.user, String(req.query.stage || '')) });
}));

router.get('/scheduled', wrap(async (req, res) => {
  if (!(await needReady(res))) return undefined;
  const f = {};
  ['stage', 'status', 'channel', 'department', 'from', 'to', 'q', 'candidateId', 'applicationId', 'page', 'pageSize', 'days'].forEach((k) => { if (req.query[k] !== undefined && req.query[k] !== '') f[k] = String(req.query[k]); });
  return res.json({ ...(await AM.list(req.user, f)), canAct: R.canAct(req.user) });
}));

router.get('/summary', wrap(async (req, res) => {
  res.json(await AM.summary(req.user));
}));

const act = (fn) => wrap(async (req, res) => {
  if (!(await needReady(res))) return undefined;
  const out = await fn(req);
  if (out.error) return res.status(out.status || 400).json({ error: out.error });
  return res.json(out);
});
router.post('/scheduled/:id/send-now', act((req) => AM.sendNow(req.user, req.params.id)));
router.post('/scheduled/:id/approve', act((req) => AM.approve(req.user, req.params.id)));
router.post('/scheduled/:id/cancel', act((req) => AM.cancel(req.user, req.params.id, (req.body || {}).reason)));
router.post('/scheduled/:id/edit', act((req) => AM.edit(req.user, req.params.id, req.body || {})));
router.post('/people/:candidateId/pause', act((req) => AM.pausePerson(req.user, req.params.candidateId, (req.body || {}).paused !== false, (req.body || {}).reason)));

router.get('/people/:candidateId', wrap(async (req, res) => {
  // eslint-disable-next-line global-require
  const scope = require('../utils/scope');
  const ok = scope.atsScopeOf(req.user).global || (await prisma.candidate.count({ where: { AND: [scope.candidateWhere(req.user), { id: req.params.candidateId }] } })) > 0;
  if (!ok) return res.status(404).json({ error: 'No such person, or outside your area.' });
  const p = await R.pauseOf(req.params.candidateId);
  return res.json({ paused: !!p, reason: p ? p.reason || '' : '', by: p ? p.byName || null : null, canAct: R.canAct(req.user) });
}));

async function jobInScope(user, id) {
  // eslint-disable-next-line global-require
  const scope = require('../utils/scope');
  return scope.atsScopeOf(user).global || (await prisma.requirement.count({ where: { AND: [scope.requirementWhere(user), { id }] } })) > 0;
}
router.get('/jobs/:requirementId', wrap(async (req, res) => {
  if (!(await jobInScope(req.user, req.params.requirementId))) return res.status(404).json({ error: 'No such job, or outside your area.' });
  const o = await R.jobOverride(req.params.requirementId);
  return res.json({ mode: o ? o.mode : 'inherit', note: o ? o.note || '' : '', by: o ? o.byName || null : null, canSet: R.canAct(req.user) });
}));
router.put('/jobs/:requirementId', wrap(async (req, res) => {
  if (!R.canAct(req.user)) return res.status(403).json({ error: 'Only the recruiter, the team lead, HR or an Admin can change this.' });
  if (!(await jobInScope(req.user, req.params.requirementId))) return res.status(404).json({ error: 'No such job, or outside your area.' });
  const out = await R.setJobOverride(req.user, req.params.requirementId, (req.body || {}).mode, (req.body || {}).note);
  if (out.error) return res.status(out.status || 400).json({ error: out.error });
  return res.json(out);
}));

router.post('/run', wrap(async (req, res) => {
  if (!R.canManage(req.user)) return res.status(403).json({ error: 'Only a Super Admin, Admin or HR can do this.' });
  if (!(await needReady(res))) return undefined;
  return res.json(await AM.processDue({ limit: Number((req.body || {}).limit) || 50 }));
}));

router.get('/daily-summary', wrap(async (req, res) => {
  const s = await AM.dailySummary();
  const { rows, ...rest } = s;
  res.json({ ...rest, line: AM.summaryLine(s) });
}));

module.exports = router;
