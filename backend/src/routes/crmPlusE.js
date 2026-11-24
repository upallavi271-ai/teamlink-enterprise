// ---------------------------------------------------------------------------
// CRM WAVE E API (2026-11-24): AI, mobile, activities & follow-ups (crm/plusE.js, aiPredict.js, aiSignals.js, workPlus.js,
// calendarSync.js). Mounted at /api/crm/pluse in index.js (every path below is under /crm/pluse); nothing of the CRM API changes.
// The same gate as the CRM: a login, and a place on the CRM's own sales-team list (or Super Admin / Admin).
//
//   GET/PUT /crm/plus-settings                         the switches (Admin changes; everything automatic starts OFF)
//   GET  /crm/ai/predict/:kind(lead|deal)/:id          the learned chance (+ the reasons)      GET /crm/ai/model   POST /crm/ai/train
//   GET  /crm/ai/forecast[?ai=1]                       the AI revenue forecast (3 months)       GET /crm/ai/anomalies   unusual changes
//   GET  /crm/ai/sentiment/:kind/:id[?ai=1]            tone / intent of what the customer said
//   POST /crm/ai/extract {text}                        lead fields from a mail / signature      POST /crm/ai/card (the photo as the body)
//   POST /crm/ai/fill/:kind/:id {text}                 suggestions for a record's empty fields
//   POST /crm/ai/call-summary/:kind/:id {text, save, durationSec, outcome}
//   GET  /crm/calls/:kind/:id                          recorded browser calls to the record's numbers   POST /crm/calls/:callId/link {kind, id}
//   POST /crm/phone-call {kind, id, outcome, note, durationSec, followUp}
//   POST /crm/tasks/:id/repeat {repeat, repeatUntil}   POST /crm/tasks/:id/skip   POST /crm/tasks/:id/video {provider}   GET /crm/video/providers
//   GET  /crm/visits?from=&to=&owner=&open=1   POST /crm/visits/check-in {kind, id, lat, lng, accuracy}   POST /crm/visits/:id/check-out
//   GET  /crm/calendar/status   GET /crm/calendar/connect/:provider   GET /crm/calendar/callback/:provider (no login: the signed state)
//   POST /crm/calendar/sync   DELETE /crm/calendar/:provider   GET /crm/calendar/busy?from=&to=
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const CRM = require('../crm/service');
const P = require('../crm/plusE');
const AP = require('../crm/aiPredict');
const SIG = require('../crm/aiSignals');
const WK = require('../crm/workPlus');
const CAL = require('../crm/calendarSync');

const router = express.Router();
const send = (res, out) => res.status(out.status).json(out.body);
const gate = [requireAuth, async (req, res, next) => {
  if (!(await CRM.crmRoleFor(req.user))) return res.status(403).json({ error: 'The CRM is for the sales team. Ask an Admin to add you to the sales team (CRM settings).' });
  await P.ensure();
  return next();
}];
const wrap = (fn) => [...gate, async (req, res, next) => { try { return send(res, await fn(req)); } catch (e) { return next(e); } }];
const originOf = (req) => `${req.get('x-forwarded-proto') || req.protocol}://${req.get('x-forwarded-host') || req.get('host')}`;
const on = (v) => String(v || '') === '1';

// the provider sends the person back here after "Allow" (no TeamLink login on this request)
router.get('/calendar/callback/:provider(google|microsoft)', async (req, res, next) => {
  try { return res.redirect(302, await CAL.callback(req.params.provider, req.query || {}, { origin: originOf(req) })); } catch (e) { return next(e); }
});

router.get('/plus-settings', ...wrap((req) => P.getSettings(req.user)));
router.put('/plus-settings', ...wrap((req) => P.saveSettings(req.user, req.body || {})));

router.get('/ai/predict/:kind(lead|deal)/:id', ...wrap((req) => AP.predict(req.user, req.params.kind, req.params.id)));
router.get('/ai/model', ...wrap((req) => AP.status(req.user)));
router.post('/ai/train', ...wrap((req) => AP.retrain(req.user)));
router.get('/ai/forecast', ...wrap((req) => AP.forecast(req.user, { ai: on(req.query.ai) })));
router.get('/ai/anomalies', ...wrap((req) => SIG.anomalies(req.user)));
router.get('/ai/sentiment/:kind(lead|deal|account)/:id', ...wrap((req) => SIG.sentiment(req.user, req.params.kind, req.params.id, { ai: on(req.query.ai) })));
router.post('/ai/extract', ...wrap((req) => SIG.extract(req.user, req.body || {})));
router.post('/ai/card', express.raw({ type: () => true, limit: '8mb' }), ...wrap((req) => SIG.card(req.user, Buffer.isBuffer(req.body) ? req.body : null)));
router.post('/ai/fill/:kind(lead|deal|account|contact)/:id', ...wrap((req) => SIG.fillSuggest(req.user, req.params.kind, req.params.id, req.body || {})));
router.post('/ai/call-summary/:kind(lead|deal|account)/:id', ...wrap((req) => SIG.callSummary(req.user, req.params.kind, req.params.id, req.body || {})));

router.get('/calls/:kind(lead|deal|account)/:id', ...wrap((req) => SIG.recordedCalls(req.user, req.params.kind, req.params.id)));
router.post('/calls/:callId/link', ...wrap((req) => SIG.linkCall(req.user, req.params.callId, req.body || {})));
router.post('/phone-call', ...wrap((req) => WK.phoneCall(req.user, req.body || {})));

router.post('/tasks/:id/repeat', ...wrap((req) => WK.setRepeat(req.user, req.params.id, req.body || {})));
router.post('/tasks/:id/skip', ...wrap((req) => WK.skipOne(req.user, req.params.id)));
router.post('/tasks/:id/video', ...wrap((req) => WK.videoMeeting(req.user, req.params.id, req.body || {})));
router.get('/video/providers', ...wrap((req) => WK.providers(req.user)));

router.get('/visits', ...wrap((req) => WK.visits(req.user, { from: req.query.from, to: req.query.to, owner: req.query.owner, open: on(req.query.open) })));
router.post('/visits/check-in', ...wrap((req) => WK.checkIn(req.user, req.body || {})));
router.post('/visits/:id/check-out', ...wrap((req) => WK.checkOut(req.user, req.params.id, req.body || {})));

router.get('/calendar/status', ...wrap((req) => CAL.status(req.user, { origin: originOf(req) })));
router.get('/calendar/connect/:provider(google|microsoft)', ...wrap((req) => CAL.connectUrl(req.user, req.params.provider, { origin: originOf(req) })));
router.post('/calendar/sync', ...wrap((req) => CAL.syncNow(req.user)));
router.get('/calendar/busy', ...wrap((req) => CAL.busy(req.user, { from: req.query.from, to: req.query.to })));
router.delete('/calendar/:provider(google|microsoft)', ...wrap((req) => CAL.disconnect(req.user, req.params.provider)));

// the timed parts: each does nothing until its Admin switch is on (crm/plusE.js)
if (!process.env.TEST_MODE && process.env.NODE_ENV !== 'test') {
  setInterval(() => {
    CAL.tick().catch((e) => console.error('[crm plus] calendar:', e.message)); // eslint-disable-line no-console
    SIG.autoLinkCalls().catch((e) => console.error('[crm plus] calls:', e.message)); // eslint-disable-line no-console
  }, 10 * 60 * 1000).unref();
  setInterval(() => {
    const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
    if (ist.getUTCDay() === 1 && ist.getUTCHours() === 10) SIG.alertManagers().catch((e) => console.error('[crm plus] anomalies:', e.message)); // eslint-disable-line no-console
  }, 15 * 60 * 1000).unref();
}

module.exports = router;
