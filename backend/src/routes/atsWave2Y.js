// ---------------------------------------------------------------------------
// /api/ats/y - ATS WAVE 2, builder Y (founder 2026-11-25 "push ATS to 95+"): AI / data / sourcing (utils/atsY/*.js).
// Staff logins with the ATS only (a client / candidate login: 403). Manager / Assistant Manager: VIEW ONLY (every change refused).
// BDE: no candidate contact details, IDs, salary, Resdex or outside look-ups (atsPrivacyGuard strips contact fields too).
//
//   Switches       GET|PUT /settings                           (Admin; the connectors' state)
//   07.11 / 07.13  GET /speech   GET|POST /interviews/:id/notetaker   POST /notetaker/:botId/refresh|stop
//   10.08 / IN-02  GET /resdex/status  POST /resdex/search  POST /resdex/import  GET /resdex/log
//   10.07 / 10.09  GET /boards   GET|POST|DELETE /jobs/:rid/foundit
//   10.10          GET /rsc   POST /rsc/check   POST /rsc/jobs/:rid   POST /rsc/candidates/:id
//   09.04          GET /candidates/:id/graph   POST /outside/search   POST /outside/add
//   09.06          GET /candidates/:id/contacts?outside=1   POST /candidates/:id/contacts
//   03.12          POST /candidates/:id/enrich-outside   POST /candidates/:id/enrich-outside/apply
//   03.13          GET /job-changes   POST /job-changes/scan   POST /job-changes/:id   GET /candidates/:id/job-changes
//   06.05          GET /prospecting   POST /prospecting/outside   POST /prospecting/add   POST /prospecting/contact
//   15.14          GET|POST /candidates/:id/id-match            (multipart file | { documentId } | { text })
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth, requireProduct, can } = require('../middleware/auth');
const { atsPrivacyGuard, privacyFlagsFor } = require('../utils/clientRedact');
const scope = require('../utils/scope');
const C = require('../utils/atsY/core');
const NT = require('../utils/atsY/notetaker');
const RX = require('../utils/atsY/resdex');
const BD = require('../utils/atsY/boards');
const PP = require('../utils/atsY/people');
const JW = require('../utils/atsY/jobWatch');
const PR = require('../utils/atsY/prospect');
const ID = require('../utils/atsY/idDocMatch');

const router = express.Router();
router.use(requireAuth, requireProduct('ats'), atsPrivacyGuard);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const send = (res, out, ok = 200) => (out && out.error ? res.status(out.status || 400).json({ error: out.error, ...(out.needsFounder ? { needsFounder: true } : {}), ...(out.switchedOff ? { switchedOff: out.switchedOff } : {}), ...(out.needsText ? { needsText: true } : {}), ...(out.code ? { code: out.code } : {}) }) : res.status(ok).json(out));
const VIEW_ONLY = { error: 'Your ATS login is view only: you can look, not change.' };
const NOT_BDE = { error: 'This is not part of the BDE view.' };

router.use((req, res, next) => (C.isStaff(req.user) ? next() : res.status(403).json({ error: 'These ATS tools are for TeamLink staff.' })));
const act = (req, res, next) => (C.isMgmt(req.user) || req.viewAs ? res.status(403).json(VIEW_ONLY) : next());
const notBde = (req, res, next) => (C.isBde(req.user) ? res.status(403).json(NOT_BDE) : next());
const admin = (req, res, next) => (C.isAdmin(req.user) && !req.viewAs ? next() : res.status(403).json({ error: 'Only a Super Admin or an Admin changes this.' }));
const lead = (req, res, next) => (['admin', 'tl', 'stl', 'mgmt'].includes(C.viewRole(req.user)) ? next() : res.status(403).json({ error: 'This is for team leads and above.' }));
const contactOk = (req, res, next) => (privacyFlagsFor(req.user) ? res.status(403).json({ error: 'Contact details are not part of your view.' }) : next());
const mayAdd = async (req, res, next) => ((await can(req.user, 'ats', 'candidates', 'Add Candidate', 'create')) ? next() : res.status(403).json({ error: "Adding candidates isn't included in your role's permissions." }));

async function candOf(req, res) {
  const c = await prisma.candidate.findFirst({ where: { AND: [scope.candidateWhere(req.user), { id: req.params.id }] }, select: { id: true, name: true } });
  if (!c) res.status(404).json({ error: 'Candidate not found (or not in your scope).' });
  return c;
}
async function jobOf(req, res) {
  const r = await prisma.requirement.findFirst({ where: { AND: [scope.requirementWhere(req.user), { id: req.params.rid }] } });
  if (!r) res.status(404).json({ error: 'Requirement not found (or not in your scope).' });
  return r;
}
const mayEditJob = async (u) => {
  if (C.isAdmin(u)) return true;
  if (C.isMgmt(u) || C.isBde(u)) return false;
  if (['TL', 'STL'].includes(require('../utils/permissions').stageRoleOf(u))) return true; // eslint-disable-line global-require
  return (await can(u, 'ats', 'requirements', 'Requirement Detail', 'edit')) || can(u, 'ats', 'requirements', 'Job Posting', 'edit');
};
// an interview: in this person's ATS scope, or they sit on its panel; never the BDE team
async function appOf(req, res, id = req.params.id) {
  if (C.isBde(req.user)) { res.status(403).json({ error: 'The BDE team does not open interview recordings.' }); return null; }
  const include = { candidate: { select: { name: true } }, requirement: true };
  let app = await prisma.application.findFirst({ where: { AND: [{ id }, scope.applicationWhere(req.user)] }, include });
  if (!app) {
    const onPanel = await prisma.interviewPanelist.findFirst({ where: { applicationId: id, userId: req.user.id } }).catch(() => null);
    if (onPanel) { app = await prisma.application.findUnique({ where: { id }, include }); if (app) app.viaPanel = true; }
  }
  if (!app) { res.status(404).json({ error: 'Interview not found (or not in your scope).' }); return null; }
  return app;
}
const mayFeedback = async (u, app) => app.viaPanel || can(u, 'ats', 'interviews', 'Interview Feedback', 'create');

// ================================================================== switches + connectors
router.get('/settings', wrap(async (req, res) => {
  if (!C.isAdmin(req.user) && !C.isMgmt(req.user)) return res.status(403).json({ error: 'Only a Super Admin or an Admin sees these settings.' });
  const s = await C.settings();
  const [speech, resdex, people, rsc, fd, bot] = await Promise.all([require('../utils/atsY/speech').status(), RX.status(), PP.outsideState(), BD.rscStatus(), BD.foundit.config(), NT.state('__none__')]); // eslint-disable-line global-require
  const ocr = await require('../utils/resumeOcr').status().catch(() => ({ available: false })); // eslint-disable-line global-require
  return res.json({
    switches: s.switches, labels: C.SWITCHES, mayEdit: C.isAdmin(req.user) && !req.viewAs,
    connectors: [
      { id: 'speech', label: 'Speech to text (interview voice feedback, recordings)', state: speech.ready ? `Working: ${speech.engine}` : 'Not set up', why: speech.why || null },
      { id: 'ocr', label: 'Scanned resumes / ID pictures (OCR)', state: ocr.available ? `Installed (${(ocr.languages || []).join(', ') || 'eng'})` : 'Not installed on this server', why: ocr.available ? null : 'Install tesseract-ocr (+ tel, hin) and poppler-utils on the server: docs/OCR-SETUP.md. Until then scanned files say so and can be typed in.' },
      { id: 'ats-meeting-bot', label: 'AI interview notetaker (meeting bot)', state: bot.ready ? 'Account details saved' : 'Needs founder credentials', why: bot.hint },
      { id: 'naukri-resdex', label: 'Naukri Resdex', state: resdex.ready ? `Account details saved (${resdex.usedToday}/${resdex.dailyLimit} downloads today)` : 'Needs founder credentials', why: resdex.hint },
      { id: 'foundit', label: 'foundit posting', state: fd.ready ? 'Account details saved' : 'Needs founder credentials', why: fd.ready ? null : fd.hint },
      { id: 'linkedin-rsc', label: 'LinkedIn RSC / Apply Connect', state: rsc.ready ? 'Account details saved' : 'Needs founder credentials (LinkedIn partner approval)', why: rsc.hint },
      { id: 'people-data', label: 'People & company data provider', state: people.ready ? `Account details saved (${people.usedThisMonth}/${people.monthlyLimit} look-ups this month)` : 'Needs founder credentials', why: people.hint },
    ],
  });
}));
router.put('/settings', admin, wrap(async (req, res) => {
  const { key, value } = req.body || {};
  const before = (await C.settings()).switches[key];
  const out = await C.saveSwitch(key, value, req.user);
  if (!out.error) await C.logAudit({ userId: req.user.id, action: `ATS setting: ${C.SWITCHES[key]}`, entity: 'AtsYSetting', entityId: key, fromValue: String(!!before), toValue: String(!!value) });
  return send(res, out);
}));

// ================================================================== 07.11 / 07.13
router.get('/speech', wrap(async (req, res) => res.json(await require('../utils/atsY/speech').status()))); // eslint-disable-line global-require
router.get('/interviews/:id/notetaker', wrap(async (req, res) => { const app = await appOf(req, res); if (!app) return undefined; return res.json({ ...(await NT.state(app.id)), meetingLink: app.interviewMeetingLink || null, canSend: !C.isMgmt(req.user) && await mayFeedback(req.user, app) }); }));
router.post('/interviews/:id/notetaker', act, wrap(async (req, res) => {
  const app = await appOf(req, res); if (!app) return undefined;
  if (!(await mayFeedback(req.user, app))) return res.status(403).json({ error: "This action isn't included in your role's permissions" });
  const b = req.body || {};
  const round = Number.isInteger(Number(b.round)) && Number(b.round) >= 1 ? Number(b.round) : (app.interviewRound || 1);
  const out = await NT.sendBot(app, round, b.meetingUrl, req.user);
  if (!out.error) await C.logAudit({ userId: req.user.id, action: `Interview notetaker sent (round ${round})`, entity: 'Application', entityId: app.id });
  return send(res, out, 201);
}));
async function botOf(req, res) {
  const row = await NT.botRow(req.params.botId);
  if (!row) { res.status(404).json({ error: 'Not found.' }); return null; }
  const app = await appOf(req, res, row.applicationId); if (!app) return null;
  return row;
}
router.post('/notetaker/:botId/refresh', wrap(async (req, res) => { const row = await botOf(req, res); if (!row) return undefined; return send(res, await NT.refresh(row, req.user)); }));
router.post('/notetaker/:botId/stop', act, wrap(async (req, res) => { const row = await botOf(req, res); if (!row) return undefined; return send(res, await NT.stop(row)); }));

// ================================================================== 10.08 / IN-02 Resdex
router.get('/resdex/status', notBde, wrap(async (req, res) => res.json(await RX.status())));
router.post('/resdex/search', act, notBde, mayAdd, wrap(async (req, res) => send(res, await RX.search(req.user, req.body || {}))));
router.post('/resdex/import', act, notBde, mayAdd, wrap(async (req, res) => send(res, await RX.bringIn(req.user, (req.body || {}).resdexId, req.body || {}), 201)));
router.get('/resdex/log', lead, wrap(async (req, res) => res.json({ rows: await RX.log({ limit: req.query.limit }) })));

// ================================================================== 10.07 / 10.09 / 10.10 boards
router.get('/boards', wrap(async (req, res) => {
  const JC = require('../utils/jobConnectors'); // eslint-disable-line global-require
  const [naukri, shine] = await Promise.all([JC.boardStatus('naukri').catch(() => null), JC.boardStatus('shine').catch(() => null)]);
  const fd = await BD.foundit.config();
  const boardsIn = await require('../utils/mkt/portal').boardsView(req).catch(() => []); // eslint-disable-line global-require
  return res.json({
    posting: [
      { id: 'naukri', label: 'Naukri (Amplify)', ready: !!(naukri && naukri.ready), word: naukri && naukri.word, hint: naukri && naukri.hint },
      { id: 'shine', label: 'Shine', ready: !!(shine && shine.ready), word: shine && shine.word, hint: shine && shine.hint },
      { id: 'foundit', label: 'foundit', ready: !!fd.ready, word: fd.ready ? 'Account details saved' : 'Not connected', hint: fd.ready ? null : fd.hint },
    ],
    applicationsIn: boardsIn.map((b) => ({ id: b.id, label: b.label, ready: b.ready, webhookUrl: b.webhookUrl, lastPullAt: b.lastPullAt })),
    rsc: await BD.rscStatus(),
  });
}));
router.get('/jobs/:rid/foundit', wrap(async (req, res) => { const r = await jobOf(req, res); if (!r) return undefined; return res.json({ ...(await BD.founditState(r.id)), canPost: !req.viewAs && await mayEditJob(req.user) }); }));
router.post('/jobs/:rid/foundit', act, wrap(async (req, res) => { const r = await jobOf(req, res); if (!r) return undefined; if (!(await mayEditJob(req.user))) return res.status(403).json({ error: 'Posting jobs is for whoever edits the requirement, the TL and above.' }); return send(res, await BD.founditPublish(r, req.user)); }));
router.delete('/jobs/:rid/foundit', act, wrap(async (req, res) => { const r = await jobOf(req, res); if (!r) return undefined; if (!(await mayEditJob(req.user))) return res.status(403).json({ error: 'Posting jobs is for whoever edits the requirement, the TL and above.' }); return send(res, await BD.founditRemove(r, req.user)); }));
router.get('/rsc', wrap(async (req, res) => res.json(await BD.rscStatus())));
router.post('/rsc/check', admin, wrap(async (req, res) => send(res, await BD.rscCheck())));
router.post('/rsc/jobs/:rid', act, wrap(async (req, res) => { const r = await jobOf(req, res); if (!r) return undefined; if (!(await mayEditJob(req.user))) return res.status(403).json({ error: 'Only whoever edits the requirement, the TL and above send it to LinkedIn.' }); return send(res, await BD.rscSyncJob(r, req.user)); }));
router.post('/rsc/candidates/:id', act, notBde, wrap(async (req, res) => { const c = await candOf(req, res); if (!c) return undefined; return send(res, await BD.rscSyncCandidate(c.id, req.user)); }));

// ================================================================== 09.04 / 09.06 / 03.12 people data
router.get('/candidates/:id/graph', wrap(async (req, res) => { const c = await candOf(req, res); if (!c) return undefined; return send(res, await PP.graph(req.user, c.id)); }));
router.post('/outside/search', act, notBde, wrap(async (req, res) => send(res, await PP.searchOutside(req.user, req.body || {}))));
router.post('/outside/add', act, notBde, mayAdd, wrap(async (req, res) => send(res, await PP.addFromOutside(req.user, (req.body || {}).person, (req.body || {}).requirementId, (req.body || {}).overrideReason), 201)));
router.get('/candidates/:id/contacts', notBde, contactOk, wrap(async (req, res) => { const c = await candOf(req, res); if (!c) return undefined; return send(res, await PP.findContacts(req.user, c.id, { outside: req.query.outside === '1' && !C.isMgmt(req.user) })); }));
router.post('/candidates/:id/contacts', act, notBde, contactOk, wrap(async (req, res) => { const c = await candOf(req, res); if (!c) return undefined; return send(res, await PP.saveContact(req.user, c.id, req.body || {})); }));
router.post('/candidates/:id/enrich-outside', act, notBde, wrap(async (req, res) => { const c = await candOf(req, res); if (!c) return undefined; return send(res, await PP.enrichOutside(req.user, c.id)); }));
router.post('/candidates/:id/enrich-outside/apply', act, notBde, wrap(async (req, res) => { const c = await candOf(req, res); if (!c) return undefined; return send(res, await PP.applyOutside(req.user, c.id, (req.body || {}).fields, (req.body || {}).provider)); }));

// ================================================================== 03.13 job changes
router.get('/job-changes', wrap(async (req, res) => res.json({ rows: await JW.list(req.user, { status: ['New', 'Applied', 'Dismissed', 'all'].includes(req.query.status) ? req.query.status : 'New' }), alerts: await C.switchOn('jobChangeAlerts') })));
router.post('/job-changes/scan', lead, act, wrap(async (req, res) => { const out = await JW.sweep(); await C.logAudit({ userId: req.user.id, action: 'Job changes checked now', entity: 'AtsYJobChange', entityId: 'scan', toValue: String(out.found) }); return res.json(out); }));
router.post('/job-changes/:id', act, notBde, wrap(async (req, res) => send(res, await JW.decide(req.user, req.params.id, String((req.body || {}).decision || '')))));
router.get('/candidates/:id/job-changes', wrap(async (req, res) => { const c = await candOf(req, res); if (!c) return undefined; return res.json({ rows: await JW.ofCandidate(c.id) }); }));

// ================================================================== 06.05 prospecting
const bdOnly = (write) => (req, res, next) => { const a = PR.access(req.user); if (!a) return res.status(403).json({ error: 'Prospecting is for the BDE team.' }); if (write && (!a.write || req.viewAs)) return res.status(403).json({ error: 'You can see prospecting but not change it.' }); return next(); };
router.get('/prospecting', bdOnly(false), wrap(async (req, res) => send(res, await PR.suggestions(req.user, { limit: req.query.limit }))));
router.post('/prospecting/outside', bdOnly(true), wrap(async (req, res) => send(res, await PR.outside(req.user, req.body || {}))));
router.post('/prospecting/add', bdOnly(true), wrap(async (req, res) => send(res, await PR.add(req.user, req.body || {}), 201)));
router.post('/prospecting/contact', bdOnly(true), wrap(async (req, res) => send(res, await PR.contact(req.user, String((req.body || {}).prospectId || ''), String((req.body || {}).campaignId || '')))));

// ================================================================== 15.14 ID document match
router.get('/candidates/:id/id-match', notBde, wrap(async (req, res) => { const c = await candOf(req, res); if (!c) return undefined; return res.json({ documents: await ID.documents(c.id), history: await ID.history(c.id), canRun: !C.isMgmt(req.user) && !req.viewAs }); }));
router.post('/candidates/:id/id-match', act, notBde, wrap(async (req, res) => {
  const c = await candOf(req, res); if (!c) return undefined;
  let buffer = null; let body = req.body || {};
  if (/multipart\/form-data/i.test(String(req.headers['content-type'] || ''))) {
    let parsed;
    try { parsed = await require('../utils/attachments').parseMultipart(req, { maxBytes: 10 * 1024 * 1024 }); } catch (e) { return res.status(e.code === 'TOO_LARGE' ? 413 : 400).json({ error: e.code === 'TOO_LARGE' ? 'The ID file is larger than 10 MB.' : 'Choose the ID document.' }); } // eslint-disable-line global-require
    buffer = parsed.file ? parsed.file.data : null; body = parsed.fields || {};
  }
  return send(res, await ID.match(req.user, c.id, { buffer, documentId: body.documentId, typed: body.text }), 201);
}));

router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[atsY]', err && err.message); // eslint-disable-line no-console
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

module.exports = router;
