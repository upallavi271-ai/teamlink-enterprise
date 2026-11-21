// ---------------------------------------------------------------------------
// /api/ats/mkt - MARKET WAVE C: communication + job-portal admin (utils/mkt/comms.js, utils/mkt/portal.js).
// Candidate tools need the right to contact the person (utils/candidateReach.mayReach: never the BDE team, never a login with
// "Candidate Contact & Salary" off); a client / candidate login has no access. Manager / Assistant Manager are VIEW ONLY.
//
//   Email check (08.11)   POST /email-check { email }            POST /candidates/:cid/email-check
//   AI draft (08.12)      POST /candidates/:cid/draft { purpose, channel, note, reply }
//   Tracking (08.04)      GET  /candidates/:cid/email-tracking
//   Sequences (08.05/06)  GET|POST /sequences  PUT /sequences/:sid   GET /candidates/:cid/sequences   POST /candidates/:cid/sequences
//                         POST /sequence-runs/:rid/stop   POST /sequence-runs/:rid/tasks/:i/done   GET /sequence-tasks
//   Call notes (08.10)    GET|POST /candidates/:cid/call-notes (json transcript or multipart recording)   POST /call-notes/:nid/:field { accept, value }
//   Mailbox (08.01)       GET|PUT|DELETE /mailbox   POST /mailbox/check   POST /candidates/:cid/mailbox-send
//   Switches (Admin)      GET|PUT /switches         PUT /calendar-app/:provider
//   Careers site (10.18)  GET|PUT /site            Alerts (10.14) GET /alerts  POST /alerts/run
//   Boards (10.07/09/10)  GET /boards  PUT /boards/:board  POST /boards/:board/pull
//   Extension (10.11)     GET|POST|DELETE /extension-key
//   SMS (10.13)           POST /jobs/:rid/sms-campaign/plan  POST /jobs/:rid/sms-campaign  GET /jobs/:rid/sms-campaigns
//   Form answers (10.03)  GET /applications/:id/form-answers   GET /candidates/:cid/links
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth, requireProduct, can } = require('../middleware/auth');
const { candidateWhere, requirementWhere, applicationWhere, matches } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const attachments = require('../utils/attachments');
const C = require('../utils/mkt/core');
const MC = require('../utils/mkt/comms');
const MP = require('../utils/mkt/portal');
const IV = require('../utils/mkt/interviews');

const router = express.Router();
router.use(requireAuth);
router.use(requireProduct('ats'));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const DENIED = { error: "This action isn't included in your role's permissions" };
const isClient = (u) => ['CLIENT', 'CANDIDATE', 'VENDOR', 'PARTNER'].some((r) => [u.role, u.atsRole].includes(r)) || require('../utils/permissions').isExternalLogin(u); // eslint-disable-line global-require
router.use((req, res, next) => (isClient(req.user) ? res.status(403).json(DENIED) : next()));
const isAdmin = (u) => ['SUPER_ADMIN', 'ADMIN'].includes(u.role);
const adminOnly = (req, res, next) => (isAdmin(req.user) ? next() : res.status(403).json({ error: 'Only an Admin changes these settings.' }));
const mayEditCand = (u) => can(u, 'ats', 'candidates', 'Candidate Master', 'edit');
const mayMessage = (u) => can(u, 'ats', 'candidates', 'Applications', 'edit');

// the candidate, in scope, and the right to contact them
async function loadCand(req, res, { write = false } = {}) {
  const reach = await require('../utils/candidateReach').mayReach(req.user, { bulkSend: false }); // eslint-disable-line global-require
  if (!reach.ok) { res.status(reach.status || 403).json({ error: reach.error }); return null; }
  const c = await prisma.candidate.findFirst({ where: { AND: [{ id: req.params.cid }, candidateWhere(req.user)] } });
  if (!c) { res.status(404).json({ error: 'Candidate not found (or not in your scope).' }); return null; }
  if (write && !(await mayMessage(req.user))) { res.status(403).json(DENIED); return null; }
  return c;
}
const latestApp = (req, cid, appId) => prisma.application.findFirst({ where: { AND: [{ candidateId: cid }, applicationWhere(req.user), ...(appId ? [{ id: String(appId) }] : [])] }, orderBy: { createdAt: 'desc' }, include: { requirement: { select: { title: true, location: true, internal: true } } } });

// ================================================================== 08.11 email validation (a data-quality tool: anyone in the ATS)
router.post('/email-check', wrap(async (req, res) => {
  const list = Array.isArray((req.body || {}).emails) ? req.body.emails.slice(0, 50) : [(req.body || {}).email];
  const rows = [];
  for (const e of list) rows.push(await MC.validateEmail(e)); // eslint-disable-line no-await-in-loop
  res.json(list.length === 1 ? rows[0] : { rows });
}));
router.post('/candidates/:cid/email-check', wrap(async (req, res) => {
  const c = await loadCand(req, res); if (!c) return;
  res.json(await MC.validateEmail(c.email));
}));

// ================================================================== 08.12 AI drafts (never sent from here)
router.post('/candidates/:cid/draft', wrap(async (req, res) => {
  const c = await loadCand(req, res, { write: true }); if (!c) return;
  const b = req.body || {};
  const app = await latestApp(req, c.id, b.applicationId);
  let lastMessage = txtOr(b.lastMessage);
  if (b.purpose === 'reply' && !lastMessage) {
    const m = await prisma.candidateMessage.findFirst({ where: { candidateId: c.id, status: 'RECEIVED' }, orderBy: { createdAt: 'desc' }, select: { body: true } }).catch(() => null);
    lastMessage = (m && m.body) || '';
  }
  res.json(await MC.draft({ candidate: c, application: app, user: req.user, purpose: b.purpose, channel: ['Email', 'SMS', 'WhatsApp'].includes(b.channel) ? b.channel : 'Email', lastMessage, note: txtOr(b.note) }));
}));
function txtOr(v) { return C.txt(v, 3000); }

// ================================================================== 08.04 tracking
router.get('/candidates/:cid/email-tracking', wrap(async (req, res) => {
  const c = await loadCand(req, res); if (!c) return;
  res.json({ on: await MC.trackingOn(), privacy: MC.PRIVACY, rows: await MC.trackingFor(c.id) });
}));

// ================================================================== 08.05 / 08.06 sequences
router.get('/sequences', wrap(async (req, res) => { res.json({ rows: await MC.listSequences(), channels: MC.SEQ_CHANNELS, switchOn: await C.switchOn('sequences'), canEdit: await mayMessage(req.user) }); }));
router.post('/sequences', wrap(async (req, res) => {
  if (!(await mayMessage(req.user))) return res.status(403).json(DENIED);
  const out = await MC.saveSequence(req.body || {}, req.user);
  if (out.error) return res.status(out.status).json({ error: out.error });
  await logAudit({ userId: req.user.id, action: 'Candidate sequence created', entity: 'Sequence', entityId: out.sequence.id, toValue: `${out.sequence.name}: ${out.sequence.steps.length} steps` });
  return res.status(201).json(out);
}));
router.put('/sequences/:sid', wrap(async (req, res) => {
  if (!(await mayMessage(req.user))) return res.status(403).json(DENIED);
  const out = await MC.saveSequence(req.body || {}, req.user, req.params.sid);
  if (out.error) return res.status(out.status).json({ error: out.error });
  return res.json(out);
}));
router.get('/candidates/:cid/sequences', wrap(async (req, res) => {
  const c = await loadCand(req, res); if (!c) return;
  res.json({ rows: await MC.runsFor(c.id), switchOn: await C.switchOn('sequences') });
}));
router.post('/candidates/:cid/sequences', wrap(async (req, res) => {
  const c = await loadCand(req, res, { write: true }); if (!c) return;
  const app = await latestApp(req, c.id, (req.body || {}).applicationId);
  const out = await MC.enrol({ sequenceId: (req.body || {}).sequenceId, candidate: c, application: app, user: req.user });
  if (out.error) return res.status(out.status).json({ error: out.error });
  await logAudit({ userId: req.user.id, action: 'Candidate added to a sequence', entity: 'Candidate', entityId: c.id, toValue: `${out.run.name}: ${out.run.steps.map((s) => `${s.channel} ${s.status}`).join(', ')}`.slice(0, 280) });
  return res.status(201).json(out);
}));
async function loadRun(req, res) {
  const run = await MC.runRow(req.params.rid);
  if (!run) { res.status(404).json({ error: 'Not found.' }); return null; }
  req.params.cid = run.candidateId;
  const c = await loadCand(req, res, { write: true }); if (!c) return null;
  return run;
}
router.post('/sequence-runs/:rid/stop', wrap(async (req, res) => {
  const run = await loadRun(req, res); if (!run) return;
  const out = await MC.stopRun(run.id, C.txt((req.body || {}).reason, 200) || `stopped by ${C.who(req.user)}`);
  if (out.error) return res.status(out.status).json({ error: out.error });
  return res.json(out);
}));
router.post('/sequence-runs/:rid/tasks/:i/done', wrap(async (req, res) => {
  const run = await loadRun(req, res); if (!run) return;
  const out = await MC.doneTask(run.id, req.params.i, req.user, (req.body || {}).note);
  if (out.error) return res.status(out.status).json({ error: out.error });
  return res.json(out);
}));
router.get('/sequence-tasks', wrap(async (req, res) => { res.json({ rows: await MC.myTasks(req.user) }); }));

// ================================================================== 08.10 call transcript -> suggestions
router.get('/candidates/:cid/call-notes', wrap(async (req, res) => {
  const c = await loadCand(req, res); if (!c) return;
  res.json({ rows: await MC.callNotesFor(c.id), fields: MC.FIELDS, speech: !!(process.env.AI_VOICE_WHISPER_URL || process.env.AI_VOICE_STT_URL) && !C.isSandbox() });
}));
router.post('/candidates/:cid/call-notes', wrap(async (req, res) => {
  const c = await loadCand(req, res, { write: true }); if (!c) return;
  let transcript = ''; let source = 'Typed / pasted'; let fileStored = null; let applicationId = null;
  if (/multipart\/form-data/i.test(String(req.headers['content-type'] || ''))) {
    let parsed;
    try { parsed = await attachments.parseMultipart(req, { maxBytes: 40 * 1048576 }); } catch (err) { return res.status(err.code === 'TOO_LARGE' ? 413 : 400).json({ error: err.code === 'TOO_LARGE' ? 'The recording is larger than 40 MB.' : 'Choose the call recording.' }); }
    transcript = C.txt(parsed.fields && parsed.fields.transcript, 200000);
    applicationId = parsed.fields && parsed.fields.applicationId;
    if (parsed.file) {
      let stored;
      try { stored = attachments.store(parsed.file, { maxBytes: 40 * 1048576, allowAudio: true }); } catch (err) { return res.status(400).json({ error: err.code === 'BAD_TYPE' ? 'Upload an audio recording (mp3, wav, m4a, ogg or webm).' : 'The recording could not be saved.' }); }
      fileStored = stored.billFile;
      if (!transcript) {
        const t = await C.transcribe(parsed.file.data, (parsed.fields && parsed.fields.lang) || 'en');
        if (t.error) return res.status(409).json({ error: t.error, needsTranscript: true });
        transcript = t.text; source = t.source;
      }
    }
  } else { transcript = C.txt((req.body || {}).transcript, 200000); applicationId = (req.body || {}).applicationId; }
  const out = await MC.extractCall({ candidate: c, transcript, source, fileStored, applicationId: applicationId || null, user: req.user });
  if (out.error) return res.status(out.status).json({ error: out.error });
  return res.status(201).json(out);
}));
router.post('/call-notes/:nid/:field', wrap(async (req, res) => {
  const n = await MC.callNote(req.params.nid);
  if (!n) return res.status(404).json({ error: 'Not found.' });
  req.params.cid = n.candidateId;
  const c = await loadCand(req, res); if (!c) return;
  if (!(await mayEditCand(req.user))) return res.status(403).json(DENIED);
  if (!MC.FIELDS[req.params.field]) return res.status(400).json({ error: 'Unknown field.' });
  const out = await MC.decideSuggestion(n.id, req.params.field, !!(req.body || {}).accept, req.user, { value: (req.body || {}).value });
  if (out.error) return res.status(out.status).json({ error: out.error });
  return res.json(out);
}));

// ================================================================== 08.01 my mailbox
router.get('/mailbox', wrap(async (req, res) => { res.json({ mailbox: await MC.mailbox(req.user.id), syncOn: await C.switchOn('inboxSync'), oauthNote: 'Gmail / Outlook sign-in (OAuth) needs the founder\'s Google / Microsoft app. Until then use an app password (Gmail: Google Account > Security > App passwords).' }); }));
router.put('/mailbox', wrap(async (req, res) => {
  const out = await MC.saveMailbox(req.user.id, req.body || {});
  if (out.error) return res.status(out.status).json({ error: out.error });
  await logAudit({ userId: req.user.id, action: 'Personal mailbox connected', entity: 'User', entityId: req.user.id, toValue: out.mailbox.address });
  return res.json(out);
}));
router.delete('/mailbox', wrap(async (req, res) => { await MC.removeMailbox(req.user.id); res.json({ ok: true }); }));
router.post('/mailbox/check', wrap(async (req, res) => {
  const out = await MC.pollMailbox(req.user.id);
  if (out.error && out.status) return res.status(out.status).json({ error: out.error });
  return res.json({ ...out, message: out.errors && out.errors.length ? `Could not read the mailbox: ${out.errors[0]}` : `Read ${out.read}, matched ${out.matched} to candidates.` });
}));
router.post('/candidates/:cid/mailbox-send', wrap(async (req, res) => {
  const c = await loadCand(req, res, { write: true }); if (!c) return;
  const b = req.body || {};
  const app = await latestApp(req, c.id, b.applicationId);
  const out = await MC.sendFromMailbox(req.user, { candidate: c, applicationId: app && app.id, subject: b.subject, text: b.text });
  if (out.error) return res.status(out.status).json({ error: out.error });
  await logAudit({ userId: req.user.id, action: 'Email sent from my mailbox', entity: 'Candidate', entityId: c.id, toValue: C.txt(b.subject, 120) });
  return res.json(out);
}));

// ================================================================== Admin: switches + calendar app keys
router.get('/switches', wrap(async (req, res) => {
  const s = await C.settings();
  const cal = {};
  for (const p of Object.keys(IV.PROVIDERS)) { const k = await IV.appKeys(p); cal[p] = { label: IV.PROVIDERS[p].label, clientId: k.clientId, saved: k.saved, tenant: p === 'microsoft' ? k.tenant : undefined }; } // eslint-disable-line no-await-in-loop
  res.json({ switches: s.switches, labels: C.SWITCHES, calendarApp: cal, trackingPrivacy: MC.PRIVACY, canEdit: isAdmin(req.user), redirect: { google: `${C.publicBase(req)}/api/public/mkt/cal-oauth/google/callback`, microsoft: `${C.publicBase(req)}/api/public/mkt/cal-oauth/microsoft/callback` } });
}));
router.put('/switches', adminOnly, wrap(async (req, res) => {
  const s = await C.settings();
  const next = { ...s.switches };
  Object.keys(C.SWITCHES).forEach((k) => { if ((req.body || {})[k] !== undefined) next[k] = !!req.body[k]; });
  await C.saveSettings({ switches: next }, req.user);
  const changed = Object.keys(next).filter((k) => next[k] !== s.switches[k]);
  if (changed.length) await logAudit({ userId: req.user.id, action: 'ATS add-on switches changed', entity: 'AppSetting', entityId: 'ats.market.settings', toValue: changed.map((k) => `${k}: ${next[k] ? 'ON' : 'OFF'}`).join(', ') });
  return res.json({ switches: next });
}));
router.put('/calendar-app/:provider', adminOnly, wrap(async (req, res) => {
  const p = req.params.provider;
  if (!IV.PROVIDERS[p]) return res.status(404).json({ error: 'Unknown calendar.' });
  const s = await C.settings();
  const all = { ...(s.raw.calendarApp || {}) };
  const cur = { ...(all[p] || {}) };
  const b = req.body || {};
  if (b.clientId !== undefined) cur.clientId = C.txt(b.clientId, 200);
  if (b.tenant !== undefined) cur.tenant = C.txt(b.tenant, 80) || 'common';
  try { if (b.secret) cur.secretEnc = C.enc(String(b.secret)); } catch (e) { return res.status(400).json({ error: e.message }); }
  all[p] = cur;
  await C.saveSettings({ calendarApp: all }, req.user);
  await logAudit({ userId: req.user.id, action: `Calendar app keys saved (${p})`, entity: 'AppSetting', entityId: 'ats.market.settings' });
  return res.json({ ok: true, saved: !!(cur.clientId && cur.secretEnc) });
}));

// ================================================================== 10.18 careers site, 10.14 alerts (Admin)
router.get('/site', wrap(async (req, res) => {
  const s = await C.settings();
  res.json({ site: s.site, sections: MP.SECTIONS, preview: await MP.publicSite({ preview: true }), canEdit: isAdmin(req.user), url: `${C.publicBase(req)}/site` });
}));
router.put('/site', adminOnly, wrap(async (req, res) => {
  const v = MP.cleanSite(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  await C.saveSettings({ site: v.value }, req.user);
  await logAudit({ userId: req.user.id, action: `Careers site saved${v.value.published ? ' (published)' : ' (draft)'}`, entity: 'AppSetting', entityId: 'ats.market.settings' });
  return res.json({ site: v.value });
}));
router.get('/alerts', adminOnly, wrap(async (req, res) => { res.json({ ...(await MP.alertStats()), switchOn: await C.switchOn('jobAlerts') }); }));
router.post('/alerts/run', adminOnly, wrap(async (req, res) => {
  const out = await MP.runAlerts(req);
  if (out.off) return res.status(409).json({ error: C.SWITCH_OFF('jobAlerts') });
  return res.json({ ...out, message: `${out.mails} alert email(s) for ${out.people} subscriber(s).` });
}));

// ================================================================== 10.07 / 10.09 / 10.10 boards (Admin)
router.get('/boards', adminOnly, wrap(async (req, res) => { res.json({ rows: await MP.boardsView(req), linkedinFeed: `${C.publicBase(req)}/api/public/mkt/feeds/linkedin.xml` }); }));
router.put('/boards/:board', adminOnly, wrap(async (req, res) => {
  const out = await MP.saveBoard(req.params.board, req.body || {}, req.user);
  if (out.error) return res.status(out.status).json({ error: out.error });
  await logAudit({ userId: req.user.id, action: `Job board application sync settings saved (${req.params.board})`, entity: 'AppSetting', entityId: 'ats.market.settings' });
  return res.json({ ok: true, rows: await MP.boardsView(req) });
}));
router.post('/boards/:board/pull', adminOnly, wrap(async (req, res) => {
  const out = await MP.pullBoard(req.params.board, req.user);
  if (out.error) return res.status(out.status).json(out);
  return res.json(out);
}));

// ================================================================== 10.11 browser extension key (each person their own)
router.get('/extension-key', wrap(async (req, res) => { res.json({ key: await MP.extKeyInfo(req.user.id), mayAdd: await can(req.user, 'ats', 'candidates', 'Add Candidate', 'create') }); }));
router.post('/extension-key', wrap(async (req, res) => {
  if (!(await can(req.user, 'ats', 'candidates', 'Add Candidate', 'create'))) return res.status(403).json({ error: 'Your role cannot add candidates, so it has no extension key.' });
  const key = await MP.newExtKey(req.user.id);
  await logAudit({ userId: req.user.id, action: 'Browser extension key made', entity: 'User', entityId: req.user.id, toValue: `...${key.slice(-4)}` });
  res.status(201).json({ key, note: 'Copy it now: it is shown once. Paste it in the TeamLink extension\'s settings.' });
}));
router.delete('/extension-key', wrap(async (req, res) => { await MP.dropExtKey(req.user.id); res.json({ ok: true }); }));

// ================================================================== 10.13 SMS job campaign
async function loadJob(req, res) {
  const r = await prisma.requirement.findUnique({ where: { id: req.params.rid } });
  if (!r || !matches(r, requirementWhere(req.user))) { res.status(404).json({ error: 'Requirement not found (or not in your scope).' }); return null; }
  return r;
}
router.post('/jobs/:rid/sms-campaign/plan', wrap(async (req, res) => {
  const r = await loadJob(req, res); if (!r) return;
  const g = await require('../utils/candidateReach').mayReach(req.user, { bulkSend: true }); // eslint-disable-line global-require
  if (!g.ok) return res.status(g.status).json({ error: g.error });
  const a = await MP.audience(req.user, r, req.body || {});
  res.json({ count: a.rows.length, optedOut: a.optedOut, badNumber: a.badNumber, sample: a.rows.slice(0, 8).map((x) => x.name), text: MP.smsText(r, (req.body || {}).text, req), switchOn: await C.switchOn('smsMarketing') });
}));
router.post('/jobs/:rid/sms-campaign', wrap(async (req, res) => {
  const r = await loadJob(req, res); if (!r) return;
  if (!(await mayMessage(req.user))) return res.status(403).json(DENIED);
  const out = await MP.startCampaign(req.user, r, req.body || {}, req);
  if (out.error) return res.status(out.status).json({ error: out.error });
  await logAudit({ userId: req.user.id, action: 'SMS job campaign started', entity: 'Requirement', entityId: r.id, toValue: `${out.total} people: ${out.text.slice(0, 120)}` });
  return res.status(201).json(out);
}));
router.get('/jobs/:rid/sms-campaigns', wrap(async (req, res) => {
  const r = await loadJob(req, res); if (!r) return;
  res.json({ rows: await MP.campaignsOf(r.id), switchOn: await C.switchOn('smsMarketing') });
}));

// ================================================================== answers + links on the candidate's pages
router.get('/applications/:id/form-answers', wrap(async (req, res) => {
  const a = await prisma.application.findFirst({ where: { AND: [{ id: req.params.id }, applicationWhere(req.user)] }, select: { id: true } });
  if (!a) return res.status(404).json({ error: 'Not found.' });
  res.json({ answers: await MP.answersOf(a.id) });
}));
router.get('/candidates/:cid/links', wrap(async (req, res) => {
  const c = await prisma.candidate.findFirst({ where: { AND: [{ id: req.params.cid }, candidateWhere(req.user)] }, select: { id: true } });
  if (!c) return res.status(404).json({ error: 'Not found.' });
  res.json({ rows: await MP.linksOf(c.id) });
}));

module.exports = router;
