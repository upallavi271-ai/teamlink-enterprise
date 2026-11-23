// ---------------------------------------------------------------------------
// /api/ats-updates - the client-update pop-ups, "Your interviews today", the Updates & Reports centre, the settings and
// the automatic screening (utils/atsUpdates.js, utils/autoScreen.js). Every list is the caller's OWN rows.
//   GET  /popups                         unseen client-update pop-ups          POST /popups/seen { ids, opened }
//   GET  /interviews-today               today's interviews I am part of       POST /interviews-today/seen
//   GET  /feed?type&from&to&read&limit   every notification + report for me    POST /read { ids }   POST /read-all { type, from, to }
//   GET  /report-file/:scheduleId        my copy of a scheduled report (Excel)
//   GET  /me  PUT /me                    my mute-mail (and, for an Admin, "do not send me client updates")
//   GET  /settings  PUT /settings        Admin: per event type pop-up / mail, digest minutes, interview mails
//   POST /digests/run  POST /interview-mails/run   Admin: run the sweeps now (the sweep also runs every 5 minutes)
//   GET  /screen/settings  PUT /screen/settings       Admin default for "Auto-screen new applications"
//   GET  /screen/jobs/:rid  PUT /screen/jobs/:rid     one job's auto-screen switch and "act on the result" (its TL / Admin)
//   GET  /screen/applications/:id  POST /screen/applications/:id/run   the result on one application (in scope)
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../middleware/auth');
const U = require('../utils/atsUpdates');
const AS = require('../utils/autoScreen');
const S = require('../utils/scope');

const router = express.Router();
router.use(requireAuth);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isAdmin = (u) => S.atsViewRole(u) === 'admin';
const adminOnly = (req, res, next) => (isAdmin(req.user) ? next() : res.status(403).json({ error: 'Only a Super Admin or Admin can change this.' }));
const internal = (req, res, next) => ([req.user.role, req.user.atsRole].some((r) => ['CLIENT', 'CANDIDATE'].includes(r)) ? res.status(403).json({ error: 'Not part of your access.' }) : next());
router.use(internal);

router.get('/popups', wrap(async (req, res) => res.json(await U.popupsFor(req.user.id))));
router.post('/popups/seen', wrap(async (req, res) => res.json({ ok: true, count: await U.seen(req.user.id, (req.body || {}).ids, { opened: (req.body || {}).opened === true }) })));

router.get('/interviews-today', wrap(async (req, res) => res.json(await U.interviewsToday(req.user))));
router.post('/interviews-today/seen', wrap(async (req, res) => { await U.markRead(req.user.id, [`iv-today|${U.istDay()}`]); res.json({ ok: true }); }));

router.get('/feed', wrap(async (req, res) => res.json(await U.feed(req.user, req.query || {}))));
router.post('/read', wrap(async (req, res) => res.json({ ok: true, count: await U.markItems(req.user, (req.body || {}).ids) })));
router.post('/read-all', wrap(async (req, res) => res.json({ ok: true, count: await U.markAll(req.user, req.body || {}) })));

// my own copy of a scheduled report (built in MY scope, like the mail)
router.get('/report-file/:id', wrap(async (req, res) => {
  const rows = await prisma.$queryRawUnsafe('SELECT * FROM "AtsReportSchedule" WHERE "id" = ?', req.params.id).catch(() => []);
  const s = rows[0];
  if (!s || !String(s.recipientIds || '').split(',').includes(req.user.id) || s.kind !== 'report') return res.status(404).json({ error: 'That report is not yours, or it is gone.' });
  const SCH = require('../utils/insights/schedules'); // eslint-disable-line global-require
  const who = await require('../utils/insights/core').identityOf(req.user.id); // eslint-disable-line global-require
  const mail = who ? await SCH.reportMail(who, s.reportId, s.userName).catch(() => null) : null;
  const file = mail && mail.attachments && mail.attachments[0];
  if (!file) return res.status(404).json({ error: 'You cannot open that report now.' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${String(file.filename).replace(/[^\w.-]/g, '')}"`);
  return res.send(file.content);
}));

router.get('/me', wrap(async (req, res) => res.json({ ...(await U.prefOf(req.user.id)), admin: isAdmin(req.user) })));
router.put('/me', wrap(async (req, res) => res.json(await U.savePref(req.user, req.body || {}))));

router.get('/settings', adminOnly, wrap(async (req, res) => res.json({ settings: await U.settings(), types: U.TYPES })));
router.put('/settings', adminOnly, wrap(async (req, res) => res.json({ settings: await U.saveSettings(req.user, req.body || {}), types: U.TYPES })));
router.post('/digests/run', adminOnly, wrap(async (req, res) => res.json({ sent: await U.flushDigests({ force: (req.body || {}).force === true }) })));
router.post('/interview-mails/run', adminOnly, wrap(async (req, res) => res.json(await U.sweepInterviewMails({ dryRun: (req.body || {}).dryRun === true }))));

// ---- automatic screening
router.get('/screen/settings', wrap(async (req, res) => res.json({ ...(await AS.settings()), canEdit: isAdmin(req.user) })));
router.put('/screen/settings', adminOnly, wrap(async (req, res) => res.json(await AS.saveSettings(req.user, req.body || {}))));
async function jobInScope(req, res) {
  const r = await prisma.requirement.findFirst({ where: { AND: [{ id: req.params.rid }, S.requirementWhere(req.user)] }, select: { id: true, title: true, tlId: true, stlId: true, department: true } });
  if (!r) { res.status(404).json({ error: 'Requirement not found, or outside your access.' }); return null; }
  return r;
}
router.get('/screen/jobs/:rid', wrap(async (req, res) => {
  const r = await jobInScope(req, res);
  if (!r) return null;
  return res.json({ ...(await AS.jobSetting(r.id)), canEdit: await AS.mayEdit(req.user, r), autoRejectOn: await AS.autoRejectOn() });
}));
router.put('/screen/jobs/:rid', wrap(async (req, res) => {
  const r = await jobInScope(req, res);
  if (!r) return null;
  if (!(await AS.mayEdit(req.user, r))) return res.status(403).json({ error: "Only this job's team lead, a manager or an Admin can change auto-screening." });
  return res.json(await AS.saveJob(req.user, r, req.body || {}));
}));
async function appInScope(req, res) {
  const a = await prisma.application.findFirst({ where: { AND: [{ id: req.params.id }, S.applicationWhere(req.user)] }, select: { id: true, requirementId: true } });
  if (!a) { res.status(404).json({ error: 'Application not found, or outside your access.' }); return null; }
  return a;
}
router.get('/screen/applications/:id', wrap(async (req, res) => {
  const a = await appInScope(req, res);
  if (!a) return null;
  return res.json({ result: await AS.resultOf(a.id) });
}));
router.post('/screen/applications/:id/run', wrap(async (req, res) => {
  const a = await appInScope(req, res);
  if (!a) return null;
  if ((!isAdmin(req.user) && [req.user.role, req.user.atsRole].includes('BDE')) || S.isBdeTl(req.user) || ['bde', 'client', 'candidate'].includes(S.atsViewRole(req.user))) return res.status(403).json({ error: 'Screening is for the recruiting team.' });
  return res.json({ result: await AS.screen(a.id, { force: true, actor: req.user }) });
}));

module.exports = router;
