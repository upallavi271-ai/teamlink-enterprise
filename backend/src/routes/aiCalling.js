// ---------------------------------------------------------------------------
// /api/ai-calling/*  - EXOTEL AI CALLING (the HTTP edge of backend/src/calling/*).
//
//   /admin/*          Administration > Integrations > AI Calling (settings, connection test, per-requirement switches,
//                     do-not-call list, retention). Permission: Integrations view / configure. Never returns a secret.
//   /portal/*         the SAME staff routes for the Job Portal's Recruiter side. The portal proves itself with the existing
//                     bridge secret (x-job-portal-secret) and names the signed-in portal recruiter (x-portal-user-email); that
//                     person must be a TeamLink login. Exotel credentials never leave this server.
//   everything else   staff: status, jobs, candidates, preview, calls (create / cancel / retry), history, offers, dashboard.
// A call is placed only after the person presses Confirm (confirm: true). Roles, scope, consent, hours and limits are checked
// by calling/callService.js + calling/policy.js, not here.
// ---------------------------------------------------------------------------
const express = require('express');
const jwt = require('jsonwebtoken');
const prisma = require('../db');
const { requireAuth, requireProduct } = require('../middleware/auth');
const { requirePerm } = require('../utils/permissions');
const { logAudit } = require('../utils/audit');
const { NO_KEY_MESSAGE } = require('../utils/secrets');
const { resolveIdentity, tokenPayload } = require('../utils/identity');
const { requirementWhere, applicationWhere } = require('../utils/scope');
const { stageLabel } = require('../utils/atsVocab');
const X = require('../calling/exotelConfig');
const DB = require('../calling/schema');
const settingsStore = require('../calling/settings');
const client = require('../calling/exotelClient');
const svc = require('../calling/callService');
const P = require('../calling/policy');
const S = require('../calling/scripts');
const hooks = require('../calling/hooks');
const stats = require('../calling/stats');
const reminders = require('../calling/reminders');

const router = express.Router();
const send = (res, r) => (r && r.ok === false ? res.status(r.status || 400).json({ error: r.error, code: r.code, ...(r.steps ? { steps: r.steps } : {}), ...(r.callId ? { callId: r.callId } : {}) }) : res.json(r));
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);

// ============================================================================ admin ===
const admin = express.Router();
admin.use(requireAuth);

admin.get('/config', requirePerm(null, 'administration', 'Integrations', 'view'), async (req, res) => {
  const view = await settingsStore.publicView();
  res.json({ ...view, assumptions: X.ASSUMPTIONS, languages: S.LANGS, purposes: S.PURPOSES, roleWords: settingsStore.ROLE_WORDS, voicebot: { audio: X.VOICEBOT.audio, speechService: require('../calling/voicebot').speechReady() } });
});

admin.put('/config', requirePerm(null, 'administration', 'Integrations', 'configure'), async (req, res) => {
  const values = req.body && typeof req.body.values === 'object' && req.body.values ? req.body.values : {};
  const wanted = settingsStore.normalise({ [X.F.mode]: values[X.F.mode] }).mode;
  if (wanted === 'Live') {
    const before = await settingsStore.status();
    // Live is allowed only after a successful connection test of THESE details: a changed account detail needs a new test first.
    const stored = require('../utils/integrationStore').parseValues(await require('../utils/integrationStore').integrationRow(X.CHANNEL_ID));
    // (Self-hosted (Synway): the provider, the Asterisk server, its AMI login, the trunk, the gateway and the dial format count too.)
    const changed = ['sid', 'key', 'token', 'callerId', 'appId', 'flowUrl', 'provider', 'amiHost', 'amiPort', 'amiUser', 'amiSecret', 'trunk', 'gatewayIp', 'dialFormat', 'dialContext'].some((k) => {
      const given = values[X.F[k]];
      if (given == null || String(given).trim() === '') return false; // blank = unchanged (secrets) / not sent
      return ['key', 'token', 'amiSecret'].includes(k) ? true : String(given).trim() !== String(stored[X.F[k]] || '').trim();
    });
    if (before.state !== 'Connected' || changed) {
      return res.status(400).json({ error: 'Press "Test connection" and get "Connected" before switching to Live. Use Test mode with your own phone number first.' });
    }
  }
  try {
    await settingsStore.save(values, req.user);
  } catch (err) {
    if (err && err.code === 'NO_SECRET_KEY') return res.status(400).json({ error: NO_KEY_MESSAGE });
    throw err;
  }
  const secrets = ['key', 'token', 'hook', 'amiSecret'].filter((k) => values[X.F[k]] != null && String(values[X.F[k]]).trim() !== '').map((k) => X.F[k]);
  await logAudit({ userId: req.user.id, action: 'AI calling settings saved', entity: 'Integration', entityId: X.CHANNEL_ID, toValue: `Switch: ${wanted}${secrets.length ? ` · secrets changed: ${secrets.join(', ')}` : ''}`.slice(0, 300) });
  res.json(await settingsStore.publicView());
});

// The connection test is READ-ONLY: it asks Exotel about the account. It places NO call and never uses a candidate.
admin.post('/test-connection', requirePerm(null, 'administration', 'Integrations', 'configure'), async (req, res) => {
  const s = await settingsStore.load({ fresh: true });
  let r;
  if (s.provider === 'synway') {
    // Self-hosted (Synway): log in to Asterisk AMI and read the setup (no Originate, no call) - calling/local/ami.js
    if (!s.hasRow || !s.amiHost || !s.amiUser || !s.amiSecret) r = { ok: false, message: 'Not configured: fill in the Asterisk server address, AMI user name and AMI secret first.', checks: [] };
    else r = await require('../calling/local/ami').testConnection(s); // eslint-disable-line global-require
  } else if (!s.hasRow || !s.sid || !s.key || !s.token) r = { ok: false, message: 'Not configured: fill in the Account SID, API key and API token first.', checks: [] };
  else r = await client.testConnection(s);
  await settingsStore.writeTest({ ok: r.ok, at: new Date().toISOString(), message: clip(r.message, 400), checks: (r.checks || []).slice(0, 8), fingerprint: s.fingerprint }, req.user);
  await logAudit({ userId: req.user.id, action: 'AI calling connection test', entity: 'Integration', entityId: X.CHANNEL_ID, toValue: r.ok ? 'Connected (no call placed)' : 'Failed' });
  settingsStore.dropCache();
  res.json({ ok: r.ok, message: r.message, checks: r.checks, status: await settingsStore.status() });
});

admin.get('/assumptions', requirePerm(null, 'administration', 'Integrations', 'view'), (req, res) => res.json({ rows: X.ASSUMPTIONS }));

admin.get('/job-settings', requirePerm(null, 'administration', 'Integrations', 'view'), async (req, res) => {
  const rows = await DB.all('SELECT * FROM "AiCallJobSetting" ORDER BY "updatedAt" DESC LIMIT 300');
  const reqs = await prisma.requirement.findMany({ where: { id: { in: rows.map((r) => r.requirementId) } }, select: { id: true, title: true, status: true } });
  const m = new Map(reqs.map((r) => [r.id, r]));
  res.json({ rows: rows.map((r) => ({ requirementId: r.requirementId, title: (m.get(r.requirementId) || {}).title || '', enabled: !!r.enabled, autoShortlist: !!r.autoShortlist, autoInterview: !!r.autoInterview, autoReminders: !!r.autoReminders, updatedByName: r.updatedByName, updatedAt: r.updatedAt })) });
});
admin.get('/job-settings/:requirementId', requirePerm(null, 'administration', 'Integrations', 'view'), async (req, res) => {
  const r = await svc.jobSetting(req.params.requirementId);
  res.json({ requirementId: req.params.requirementId, enabled: r ? !!r.enabled : true, autoShortlist: r ? !!r.autoShortlist : false, autoInterview: r ? !!r.autoInterview : false, autoReminders: r ? !!r.autoReminders : false });
});
admin.put('/job-settings/:requirementId', requirePerm(null, 'administration', 'Integrations', 'configure'), async (req, res) => {
  const job = await prisma.requirement.findUnique({ where: { id: req.params.requirementId }, select: { id: true, title: true } });
  if (!job) return res.status(404).json({ error: 'Requirement not found.' });
  const b = req.body || {};
  const cur = await svc.jobSetting(job.id);
  const flag = (k, d) => (b[k] === undefined ? d : (b[k] ? 1 : 0));
  const next = {
    enabled: flag('enabled', cur ? cur.enabled : 1), autoShortlist: flag('autoShortlist', cur ? cur.autoShortlist : 0), autoInterview: flag('autoInterview', cur ? cur.autoInterview : 0), autoReminders: flag('autoReminders', cur ? cur.autoReminders : 0),
  };
  await DB.run('INSERT OR REPLACE INTO "AiCallJobSetting" ("requirementId","enabled","autoShortlist","autoInterview","autoReminders","updatedById","updatedByName","updatedAt") VALUES (?,?,?,?,?,?,?,?)',
    job.id, next.enabled, next.autoShortlist, next.autoInterview, next.autoReminders, req.user.id, req.user.name, new Date().toISOString());
  await logAudit({ userId: req.user.id, action: 'AI calling requirement settings changed', entity: 'Requirement', entityId: job.id, toValue: `on:${next.enabled} shortlist:${next.autoShortlist} interview:${next.autoInterview} reminders:${next.autoReminders}` });
  res.json({ requirementId: job.id, title: job.title, enabled: !!next.enabled, autoShortlist: !!next.autoShortlist, autoInterview: !!next.autoInterview, autoReminders: !!next.autoReminders });
});

admin.get('/suppressions', requirePerm(null, 'administration', 'Integrations', 'view'), async (req, res) => {
  const rows = await DB.all('SELECT "id","kind","source","note","createdByName","createdAt","phone" FROM "AiCallSuppression" ORDER BY "createdAt" DESC LIMIT 500');
  res.json({ rows: rows.map((r) => ({ id: r.id, kind: r.kind, source: r.source, note: r.note, createdByName: r.createdByName, createdAt: r.createdAt, phoneMask: `••••••${String(r.phone).slice(-4)}` })) });
});
admin.post('/suppressions', requirePerm(null, 'administration', 'Integrations', 'configure'), async (req, res) => {
  const m = require('../utils/messagingCore').normalizeMobile(req.body && req.body.phone);
  const kind = req.body && req.body.kind === 'optout' ? 'optout' : 'dnd';
  if (!m.ok) return res.status(400).json({ error: m.reason });
  await DB.run('INSERT OR IGNORE INTO "AiCallSuppression" ("id","phone","kind","source","note","createdById","createdByName","createdAt") VALUES (?,?,?,?,?,?,?,?)',
    svc.newId('aisup'), P.phoneKey(m.e164), kind, 'admin', clip(req.body.note, 200), req.user.id, req.user.name, new Date().toISOString());
  await logAudit({ userId: req.user.id, action: kind === 'dnd' ? 'AI calling: number marked DND' : 'AI calling: number marked do-not-call', entity: 'Integration', entityId: X.CHANNEL_ID, toValue: `••••${m.e164.slice(-4)}` });
  res.json({ ok: true });
});
admin.delete('/suppressions/:id', requirePerm(null, 'administration', 'Integrations', 'configure'), async (req, res) => {
  await DB.run('DELETE FROM "AiCallSuppression" WHERE "id" = ?', req.params.id);
  await logAudit({ userId: req.user.id, action: 'AI calling: do-not-call entry removed', entity: 'Integration', entityId: X.CHANNEL_ID, toValue: req.params.id });
  res.json({ ok: true });
});

admin.post('/purge', requirePerm(null, 'administration', 'Integrations', 'configure'), async (req, res) => {
  const summary = { purged: 0 };
  await reminders.purge(svc.now(), summary);
  res.json({ ok: true, ...summary });
});
admin.delete('/calls/:id/transcript', requirePerm(null, 'administration', 'Integrations', 'configure'), async (req, res) => {
  const row = await svc.getCall(req.params.id);
  if (!row) return res.status(404).json({ error: 'Call not found.' });
  await svc.setRow(row.id, { transcript: null, recordingUrl: null, purgeAt: null, deletedAt: new Date().toISOString() });
  await logAudit({ userId: req.user.id, action: 'AI call transcript / recording deleted', entity: 'Application', entityId: row.applicationId, toValue: row.id });
  res.json({ ok: true });
});
admin.get('/events', requirePerm(null, 'administration', 'Integrations', 'view'), async (req, res) => {
  const rows = await DB.all('SELECT "kind","status","applied","note","receivedAt","callSid" FROM "AiCallEvent" WHERE "kind" <> \'attempt\' ORDER BY "receivedAt" DESC LIMIT 100');
  res.json({ rows });
});
router.use('/admin', admin);

// ============================================================================ staff ===
const staff = express.Router();
staff.use(requireAuth);
staff.use(requireProduct('ats'));

staff.get('/status', async (req, res) => {
  const s = await settingsStore.load();
  const st = await settingsStore.status(s);
  const call = P.roleAllows(req.user, s);
  const bulk = P.roleAllows(req.user, s, true);
  const view = call || await svc.viewOnly(req.user);
  const isAdmin = ['SUPER_ADMIN', 'ADMIN'].includes(String(req.user.role || '').toUpperCase()) || ['SUPER_ADMIN', 'ADMIN'].includes(String(req.user.atsRole || '').toUpperCase());
  res.json({
    mode: s.mode, state: st.state, ready: s.configured && s.mode !== 'Off', canCall: call, canBulk: bulk, canView: view, isAdmin,
    languages: s.languages, purposes: S.PURPOSES, hours: { from: s.hoursFrom, to: s.hoursTo, outside: s.outside }, maxBulk: s.maxBulk,
    notice: s.mode === 'Off' ? 'AI calling is switched off. An Admin turns it on in Administration > Integrations > AI Calling.'
      : (!s.configured ? 'AI calling is not set up yet. An Admin finishes the setup in Administration > Integrations > AI Calling.' : null),
    steps: isAdmin ? s.problems : [],
    testMode: s.mode === 'Test',
    recording: s.recording || s.keepTranscripts,
    phoneAi: (({ ready, mode }) => ({ ready, mode }))(require('../calling/voice/sipCall').readiness()), // eslint-disable-line global-require
  });
});

staff.get('/jobs', async (req, res) => {
  const s = await settingsStore.load();
  if (!P.roleAllows(req.user, s) && !(await svc.viewOnly(req.user))) return res.status(403).json({ error: 'Your role is not allowed to use AI calling.' });
  const rows = await prisma.requirement.findMany({
    where: { AND: [requirementWhere(req.user), { status: 'OPEN' }] },
    select: { id: true, title: true, location: true, openings: true, department: true },
    orderBy: { createdAt: 'desc' },
    take: 300,
  });
  res.json({ rows });
});

staff.get('/candidates', async (req, res) => {
  const s = await settingsStore.load();
  const purpose = S.PURPOSES.includes(req.query.purpose) ? req.query.purpose : 'Screening';
  const acc = await svc.accessVerdict(req.user, null, s);
  if (!acc.ok) return send(res, acc);
  const requirementId = clip(req.query.requirementId, 60);
  if (!requirementId) return res.status(400).json({ error: 'Pick a requirement first.' });
  const apps = await prisma.application.findMany({
    where: { AND: [{ requirementId }, applicationWhere(req.user)] },
    include: { candidate: true, requirement: { select: { id: true, title: true, status: true } } },
    orderBy: { createdAt: 'desc' },
    take: 300,
  });
  const jset = await svc.jobSetting(requirementId);
  const last = await DB.all('SELECT "applicationId","status","outcome","purpose","createdAt" FROM "AiCall" WHERE "requirementId" = ? ORDER BY "createdAt" DESC LIMIT 1000', requirementId);
  const lastBy = new Map();
  last.forEach((l) => { const k = `${l.applicationId}|${l.purpose}`; if (!lastBy.has(k)) lastBy.set(k, l); });
  const t = svc.now();
  const rows = [];
  for (const a of apps) { // eslint-disable-line no-restricted-syntax
    // eslint-disable-next-line no-await-in-loop
    const v = await P.personVerdict({ candidate: a.candidate, app: a, requirement: a.requirement, purpose, s, now: t, jobSetting: jset });
    const l = lastBy.get(`${a.id}|${purpose}`);
    rows.push({
      applicationId: a.id, candidateId: a.candidate.id, name: a.candidate.name, phone: a.candidate.phone, jobTitle: a.requirement.title, stage: a.stage, stageLabel: stageLabel(a.stage),
      callable: v.ok && !l, reason: v.ok ? (l ? `Already has a ${l.status} call for this purpose` : null) : v.reason, code: v.ok ? (l ? 'duplicate' : null) : v.code,
      interviewAt: a.interviewAt, last: l ? { status: l.status, outcome: l.outcome, at: l.createdAt } : null,
    });
  }
  res.json({ rows, purpose });
});

staff.post('/preview', async (req, res) => {
  const b = req.body || {};
  send(res, await svc.preview(req.user, { applicationId: clip(b.applicationId, 60), purpose: b.purpose, language: b.language, fields: b.fields }));
});

// FREE AI LINK (2026-10-28, calling/webTalk.js): a link + a ready WhatsApp message instead of a phone call. Nothing is sent
// from the server; the recruiter sends the message from their own WhatsApp.
staff.post('/web-link', async (req, res) => {
  const b = req.body || {};
  const base = require('../utils/offerLink').publicBase(req); // eslint-disable-line global-require
  send(res, await require('../calling/webTalk').createLink(req.user, { applicationId: clip(b.applicationId, 60), purpose: clip(b.purpose, 40), language: clip(b.language, 20) }, base)); // eslint-disable-line global-require
});

// AI PHONE CALL with free voices through our own SIP line (2026-10-28, calling/voice/sipCall.js). Only the SIP minutes cost.
staff.post('/phone-call', async (req, res) => {
  const b = req.body || {};
  if (b.confirm !== true) return res.status(400).json({ error: 'Please confirm the call first. No call is placed without your confirmation.' });
  send(res, await require('../calling/voice/sipCall').place(req.user, { applicationId: clip(b.applicationId, 60), purpose: clip(b.purpose, 40), language: clip(b.language, 20), fields: b.fields })); // eslint-disable-line global-require
});

staff.post('/calls', async (req, res) => {
  const b = req.body || {};
  const r = await svc.createCalls(req.user, {
    items: (Array.isArray(b.applicationIds) ? b.applicationIds : [b.applicationId]).filter(Boolean).slice(0, 1000).map((x) => ({ applicationId: clip(x, 60) })),
    purpose: b.purpose, language: b.language, fields: b.fields, confirm: b.confirm === true, campaignName: clip(b.campaignName, 80), via: req.aiCallingVia || 'recruiter',
  });
  if (!r.ok) return send(res, r);
  // one candidate: a refusal is an error the person must read; several: the list says which ones
  if (r.results.length === 1 && !r.results[0].ok) {
    const x = r.results[0];
    return res.status(x.httpStatus || (x.code === 'duplicate' ? 409 : 403)).json({ error: x.error, code: x.code, callId: x.callId || undefined, ...(x.steps ? { steps: x.steps } : {}) });
  }
  return res.json(r);
});

staff.get('/calls', async (req, res) => send(res, await svc.list(req.user, req.query)));
staff.get('/calls/:id', async (req, res) => send(res, await svc.detail(req.user, req.params.id)));
staff.post('/calls/:id/cancel', async (req, res) => send(res, await svc.cancel(req.user, req.params.id)));
staff.post('/calls/:id/retry', async (req, res) => send(res, await svc.retry(req.user, req.params.id)));
staff.get('/history', async (req, res) => send(res, await svc.history(req.user, { candidateId: clip(req.query.candidateId, 60) || undefined, applicationId: clip(req.query.applicationId, 60) || undefined })));
staff.get('/offers', async (req, res) => send(res, await hooks.listOffers(req.user, { applicationId: clip(req.query.applicationId, 60) || undefined, status: clip(req.query.status || 'pending', 20) })));
staff.post('/offers/:id/accept', async (req, res) => send(res, await hooks.decide(req.user, req.params.id, true, req.body || {})));
staff.post('/offers/:id/dismiss', async (req, res) => send(res, await hooks.decide(req.user, req.params.id, false, req.body || {})));
staff.get('/dashboard', async (req, res) => send(res, await stats.dashboard(req.user, req.query)));
// CALL-BACK REMINDERS (calling/callbacks.js) - the applications in the login's scope only
const CB = require('../calling/callbacks');
const KB = require('../calling/knowledge');
staff.get('/callbacks', async (req, res) => res.json({ ok: true, rows: await CB.list(req.user, { status: clip(req.query.status || 'open', 20) }) }));
staff.get('/callbacks/for-application/:id', async (req, res) => {
  const r = await CB.forApplication(clip(req.params.id, 60));
  const rows = r ? (await CB.list(req.user, { status: 'open' })).filter((x) => x.id === r.id) : [];
  res.json({ ok: true, row: rows[0] || null });
});
// Call back: AI (the same AI calling, the same checks: consent, Do-not-call, test numbers, hours) or "I called by hand"
staff.post('/callbacks/:id/call', async (req, res) => send(res, await CB.callNow(req.user, req.params.id)));
staff.post('/callbacks/:id/done', async (req, res) => send(res, await CB.setStatus(req.user, req.params.id, 'done', { how: clip((req.body || {}).how, 60) || 'Called by hand' })));
staff.post('/callbacks/:id/cancel', async (req, res) => send(res, await CB.setStatus(req.user, req.params.id, 'cancelled', { how: 'Cancelled' })));
staff.post('/callbacks/:id/move', async (req, res) => send(res, await CB.setStatus(req.user, req.params.id, 'move', { dueAtIst: clip((req.body || {}).dueAt, 20) })));
// QUESTIONS THE AI COULD NOT ANSWER (calling/knowledge.js) - answered ones are used on the next calls of that requirement
staff.get('/questions', async (req, res) => res.json({ ok: true, rows: await KB.list(req.user, { status: clip(req.query.status || 'pending', 20), requirementId: clip(req.query.requirementId, 60) || undefined }) }));
staff.post('/questions/:id/answer', async (req, res) => {
  const r = await KB.answer(req.user, clip(req.params.id, 60), { answer: (req.body || {}).answer, dismiss: !!(req.body || {}).dismiss });
  if (!r) return res.status(404).json({ error: 'That question was not found.' });
  if (r.error) return res.status(400).json({ error: r.error });
  return res.json({ ok: true, row: r });
});
staff.get('/campaigns', async (req, res) => {
  const rows = await DB.all('SELECT * FROM "AiCallCampaign" ORDER BY "createdAt" DESC LIMIT 100');
  res.json({ rows: rows.map((r) => ({ id: r.id, name: r.name, purpose: r.purpose, requirementId: r.requirementId, total: r.total, createdByName: r.createdByName, createdAt: r.createdAt })) });
});

// ============================================================ the Job Portal's door ===
// The portal sends the existing bridge secret and the e-mail of the signed-in portal recruiter. The recruiter must be a TeamLink
// login; from then on the request is an ordinary TeamLink request by THAT person (same roles, same scope, same rules).
async function portalDoor(req, res, next) {
  try {
    const bridge = require('../utils/jobPortalBridge'); // eslint-disable-line global-require
    if (!bridge.secretMatches(req.get('x-job-portal-secret'))) return res.status(401).json({ error: 'Invalid or missing job portal secret' });
    const email = clip(req.get('x-portal-user-email'), 200).trim().toLowerCase();
    if (!email) return res.status(403).json({ error: 'The portal did not say who is signed in.' });
    const s = await settingsStore.load();
    const users = await prisma.user.findMany({ where: { email: { in: [email, clip(req.get('x-portal-user-email'), 200).trim()] }, status: 'Active' }, select: { id: true } });
    let pick = null;
    for (const u of users) { // eslint-disable-line no-restricted-syntax
      const idn = await resolveIdentity(u.id); // eslint-disable-line no-await-in-loop
      if (idn && (idn.products || {}).ats && P.roleAllows(idn, s)) { pick = idn; break; }
    }
    if (!pick) return res.status(403).json({ error: 'This portal login is not linked to a TeamLink recruiter login that may place AI calls.' });
    req.headers.authorization = `Bearer ${jwt.sign(tokenPayload(pick), process.env.JWT_SECRET, { expiresIn: '2m' })}`;
    req.aiCallingVia = 'portal';
    return next();
  } catch (err) { return next(err); }
}
router.use('/portal', portalDoor, staff);
router.use('/', staff);

module.exports = router;
