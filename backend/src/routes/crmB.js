// ---------------------------------------------------------------------------
// /api/crm/b/* - CRM WAVE B (founder 2026-11-24 "build to 90%"): email, phone / WhatsApp / SMS, marketing, customer portal, for the CRM team.
// Mounted inside routes/crm.js AFTER its login + "is on the CRM team" gate, so every route here already has a CRM role; each function
// checks the finer rights (manager / can edit / owns the record) itself (crm/b/*.js).
//   settings     GET/PUT /settings                      the wave's Admin switches (all OFF by default), the BCC / team mailbox, the keys and snippets
//   email        /templates /signature /tracking /schedule /scheduled /mail/* /bounces /team-mail /deals/:id/doc-views /deal-files/:fid/share
//   phone        /calls/* (the office lines from the browser) /dial-lists /dial-items /sms /chats /inbox
//   marketing    /segments /landings /roi /campaign-meta /social /leads/:id/social /leads/:id/visits /journeys /events /prefs
//   portal       /portal-users /kb /resellers /reseller-deals /surveys
//   jobs         POST /run/:job (Admin): queue | mail | calls | journeys | social | surveys - the same passes the timers make
// ---------------------------------------------------------------------------
const express = require('express');
const B = require('../crm/b/schema');
const C = require('../crm/b/common');
const MAIL = require('../crm/b/mail');
const PH = require('../crm/b/phone');
const MK = require('../crm/b/marketing');
const PO = require('../crm/b/portal');

const router = express.Router();
const send = (res, out) => res.status(out.status).json(out.body);
const wrap = (fn) => async (req, res, next) => { try { return send(res, await fn(req)); } catch (e) { return next(e); } };
const ok = (body) => ({ status: 200, body });

// ---- settings ----------------------------------------------------------------------------------------------------------------
async function keys() {
  const st = await B.settings();
  const patch = {};
  if (!st.siteId) patch.siteId = `site_${C.token(12)}`;
  if (!st.hookKey) patch.hookKey = `hk_${C.token(20)}`;
  return Object.keys(patch).length ? B.saveSettings(patch) : st;
}
router.get('/settings', wrap(async (req) => {
  const st = await keys();
  const mgr = C.isManager(req.user);
  const base = C.baseUrl();
  const out = { switches: Object.fromEntries(Object.keys(B.SWITCHES).map((k) => [k, st[k]])), labels: B.SWITCHES, canSwitch: C.isAdmin(req.user), canEdit: mgr, topics: st.topics, bccAddress: st.bccAddress, teamMailbox: st.teamMailbox };
  if (mgr) {
    Object.assign(out, {
      siteId: st.siteId, hookKey: st.hookKey, base,
      snippets: {
        chat: `<script src="${base}/api/crm-public/b/w/chat.js?k=${st.siteId}" async></script>`,
        tracking: `<script src="${base}/api/crm-public/b/w/t.js?k=${st.siteId}" async></script>`,
        inboundMail: `${base}/api/crm-public/b/mail/inbound?key=${st.hookKey}`,
        bounceHook: `${base}/api/crm-public/b/mail/bounce?key=${st.hookKey}`,
        callRoute: `${base}/api/crm-public/b/call/route?key=${st.hookKey}`,
        metaAds: `${base}/api/crm-public/b/ads/meta`, googleAds: `${base}/api/crm-public/b/ads/google`,
        kb: `${base}/api/crm-public/b/kb`, gmailRedirect: `${base}/api/crm-public/b/oauth/gmail`, outlookRedirect: `${base}/api/crm-public/b/oauth/outlook`,
      },
    });
  }
  return ok(out);
}));
router.put('/settings', wrap(async (req) => {
  const b = req.body || {};
  const patch = {};
  if (b.switches && typeof b.switches === 'object') {
    if (!C.isAdmin(req.user)) return C.no('Only an Admin switches these on or off.');
    for (const k of Object.keys(B.SWITCHES)) if (typeof b.switches[k] === 'boolean') patch[k] = b.switches[k];
  }
  if (b.bccAddress !== undefined || b.teamMailbox !== undefined || b.topics !== undefined) {
    if (!C.isManager(req.user)) return C.no();
    if (b.bccAddress !== undefined) { const v = C.lower(b.bccAddress); if (v && !C.validEmail(v)) return C.S.fail(400, 'The BCC address does not look right.'); patch.bccAddress = v; }
    if (b.teamMailbox !== undefined) { const v = C.lower(b.teamMailbox); if (v && !C.validEmail(v)) return C.S.fail(400, 'The team mailbox address does not look right.'); patch.teamMailbox = v; }
    if (Array.isArray(b.topics)) patch.topics = [...new Set(b.topics.map((t) => C.clip(t, 60)).filter(Boolean))].slice(0, 12);
  }
  if (b.newHookKey === true) { if (!C.isAdmin(req.user)) return C.no('Only an Admin changes the key.'); patch.hookKey = `hk_${C.token(20)}`; }
  const st = await B.saveSettings(patch);
  await C.S.audit(req.user, 'CRM email / phone / marketing settings changed', 'AppSetting', 'crm.b', Object.entries(patch).map(([k, v]) => `${k}=${k === 'hookKey' ? 'new' : (typeof v === 'object' ? 'list' : v)}`).join(', ').slice(0, 300));
  return ok({ ok: true, switches: Object.fromEntries(Object.keys(B.SWITCHES).map((k) => [k, st[k]])) });
}));

// ---- email -------------------------------------------------------------------------------------------------------------------
router.get('/templates', wrap((req) => MAIL.templates(req.user, req.query || {})));
router.post('/templates', wrap((req) => MAIL.saveTemplate(req.user, null, req.body || {})));
router.put('/templates/:id', wrap((req) => MAIL.saveTemplate(req.user, req.params.id, req.body || {})));
router.delete('/templates/:id', wrap((req) => MAIL.removeTemplate(req.user, req.params.id)));
router.post('/templates/:id/render', wrap((req) => MAIL.renderTemplate(req.user, req.params.id, { kind: (req.body || {}).kind, recordId: (req.body || {}).id })));
router.get('/signature', wrap((req) => MAIL.getSignature(req.user)));
router.put('/signature', wrap((req) => MAIL.saveSignature(req.user, req.body || {})));
router.get('/tracking/:kind/:id', wrap((req) => MAIL.trackingFor(req.user, req.params.kind, req.params.id)));
router.post('/schedule', wrap((req) => MAIL.schedule(req.user, req.body || {})));
router.get('/scheduled', wrap((req) => MAIL.scheduled(req.user)));
router.post('/scheduled/:id/cancel', wrap((req) => MAIL.cancelScheduled(req.user, req.params.id)));
router.get('/mail/accounts', wrap((req) => MAIL.mailAccounts(req.user)));
router.get('/mail/connect/:provider', wrap((req) => MAIL.connectUrl(req.user, req.params.provider)));
router.delete('/mail/accounts/:provider', wrap((req) => MAIL.disconnect(req.user, req.params.provider)));
router.get('/bounces', wrap((req) => MAIL.bounces(req.user)));
router.post('/bounces/unsuppress', wrap((req) => MAIL.unsuppress(req.user, req.body || {})));
router.get('/team-mail', wrap((req) => MAIL.teamInbox(req.user, req.query || {})));
router.post('/team-mail/:id', wrap((req) => MAIL.teamMailAct(req.user, req.params.id, req.body || {})));
router.get('/deals/:id/doc-views', wrap((req) => MAIL.docViews(req.user, req.params.id)));
router.post('/deal-files/:fid/share', wrap((req) => MAIL.shareFile(req.user, req.params.fid)));

// ---- phone, SMS, chat, inbox -----------------------------------------------------------------------------------------------
router.get('/calls/status', wrap((req) => PH.callStatus(req.user)));
router.post('/calls/session', wrap(async (req) => { const out = await PH.callSession(req.user); return out; }));
router.post('/calls', require('../channels/rateLimit').limiter(), wrap((req) => PH.placeCall(req.user, req.body || {})));
router.get('/calls/of/:kind/:id', wrap(async (req) => { await PH.syncCalls().catch(() => null); return PH.callsOf(req.user, req.params.kind, req.params.id); }));
router.get('/calls/:id/transcript', wrap((req) => PH.transcriptOf(req.user, req.params.id)));
router.get('/calls/:id/recording', async (req, res, next) => {
  try {
    const out = await PH.recordingFile(req.user, req.params.id);
    if (!out.path) return send(res, out);
    res.set('Cache-Control', 'private, no-store');
    res.type(out.mime);
    return res.sendFile(out.path);
  } catch (e) { return next(e); }
});
router.post('/calls/upload', express.raw({ type: () => true, limit: '21mb' }), wrap((req) => PH.transcribeUpload(req.user, { kind: String(req.query.kind || ''), id: String(req.query.id || ''), name: String(req.query.name || '') }, Buffer.isBuffer(req.body) ? req.body : null)));
router.get('/dial-lists', wrap((req) => PH.dialLists(req.user)));
router.post('/dial-lists', wrap((req) => PH.createDialList(req.user, req.body || {})));
router.get('/dial-lists/:id', wrap((req) => PH.dialList(req.user, req.params.id)));
router.post('/dial-items/:id', wrap((req) => PH.dialOutcome(req.user, req.params.id, req.body || {})));
router.get('/sms/ready', wrap(() => PH.smsReady()));
router.post('/sms', require('../channels/rateLimit').limiter(), wrap((req) => PH.sendSms(req.user, req.body || {})));
router.get('/chats', wrap((req) => PH.chats(req.user, req.query || {})));
router.get('/chats/:id', wrap((req) => PH.chatDetail(req.user, req.params.id)));
router.post('/chats/:id', wrap((req) => PH.chatAct(req.user, req.params.id, req.body || {})));
router.get('/inbox', wrap((req) => PH.inbox(req.user, req.query || {})));

// ---- marketing -----------------------------------------------------------------------------------------------------------------
router.get('/segments', wrap((req) => MK.segments(req.user)));
router.post('/segments', wrap((req) => MK.saveSegment(req.user, null, req.body || {})));
router.post('/segments/preview', wrap((req) => MK.segmentPreview(req.user, req.body || {})));
router.put('/segments/:id', wrap((req) => MK.saveSegment(req.user, req.params.id, req.body || {})));
router.delete('/segments/:id', wrap((req) => MK.removeSegment(req.user, req.params.id)));
router.get('/segments/:id/audience.csv', async (req, res, next) => {
  try {
    const out = await MK.audienceFile(req.user, req.params.id);
    if (!out.csv) return send(res, out);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${out.name}"`);
    return res.send(out.csv);
  } catch (e) { return next(e); }
});
router.get('/landings', wrap(() => MK.landings()));
router.post('/landings', wrap((req) => MK.saveLanding(req.user, null, req.body || {})));
router.put('/landings/:id', wrap((req) => MK.saveLanding(req.user, req.params.id, req.body || {})));
router.delete('/landings/:id', wrap((req) => MK.removeLanding(req.user, req.params.id)));
router.get('/roi', wrap((req) => MK.roi(req.user)));
router.put('/campaign-meta/:id', wrap((req) => MK.setCampaignMeta(req.user, req.params.id, req.body || {})));
router.get('/social', wrap((req) => MK.socialPosts(req.user)));
router.post('/social', wrap((req) => MK.saveSocialPost(req.user, null, req.body || {})));
router.put('/social/:id', wrap((req) => MK.saveSocialPost(req.user, req.params.id, req.body || {})));
router.post('/social/:id/post', wrap((req) => MK.postNow(req.user, req.params.id)));
router.put('/leads/:id/social', wrap((req) => MK.saveSocialLinks(req.user, req.params.id, req.body || {})));
router.get('/leads/:id/visits', wrap((req) => MK.visitsOf(req.user, req.params.id)));
router.get('/journeys', wrap(() => MK.journeys()));
router.post('/journeys', wrap((req) => MK.saveJourney(req.user, null, req.body || {})));
router.put('/journeys/:id', wrap((req) => MK.saveJourney(req.user, req.params.id, req.body || {})));
router.post('/journeys/:id/on', wrap((req) => MK.setJourneyOn(req.user, req.params.id, !!(req.body || {}).on)));
router.delete('/journeys/:id', wrap((req) => MK.removeJourney(req.user, req.params.id)));
router.get('/journeys/:id/runs', wrap((req) => MK.journeyRuns(req.user, req.params.id)));
router.get('/events', wrap(() => MK.events()));
router.post('/events', wrap((req) => MK.saveEvent(req.user, null, req.body || {})));
router.put('/events/:id', wrap((req) => MK.saveEvent(req.user, req.params.id, req.body || {})));
router.get('/events/:id/registrations', wrap((req) => MK.eventRegs(req.user, req.params.id)));
router.post('/event-regs/:id', wrap((req) => MK.markAttendance(req.user, req.params.id, req.body || {})));
router.get('/prefs', wrap(async (req) => {
  const e = C.lower(req.query.email);
  const rec = await C.recordByEmail(e);
  if (!rec || !(await C.visible(req.user, rec.kind, rec.id))) return C.S.fail(404, 'This person is not one of your records.');
  return ok({ prefs: await MK.prefsOf(e), link: MK.prefsLink(e) });
}));

// ---- portal ------------------------------------------------------------------------------------------------------------------
router.get('/portal-users', wrap((req) => PO.portalUsers(req.user, req.query || {})));
router.post('/portal-users', wrap((req) => PO.invite(req.user, req.body || {})));
router.delete('/portal-users/:id', wrap((req) => PO.removeUser(req.user, req.params.id)));
router.get('/kb', wrap((req) => PO.kbList(req.user)));
router.post('/kb', wrap((req) => PO.kbSave(req.user, null, req.body || {})));
router.put('/kb/:id', wrap((req) => PO.kbSave(req.user, req.params.id, req.body || {})));
router.delete('/kb/:id', wrap((req) => PO.kbRemove(req.user, req.params.id)));
router.get('/resellers', wrap((req) => PO.resellers(req.user)));
router.post('/resellers', wrap((req) => PO.saveReseller(req.user, null, req.body || {})));
router.put('/resellers/:id', wrap((req) => PO.saveReseller(req.user, req.params.id, req.body || {})));
router.post('/reseller-deals/:id', wrap((req) => PO.decideDeal(req.user, req.params.id, req.body || {})));
router.post('/surveys', wrap((req) => PO.sendSurvey(req.user, req.body || {})));
router.get('/surveys', wrap((req) => PO.surveyResults(req.user, req.query || {})));

// ---- the timed passes, run by hand (Admin) -----------------------------------------------------------------------------------
const JOBS = { queue: () => MAIL.runQueue(), mail: () => MAIL.syncAll(), calls: () => PH.syncCalls(), journeys: () => MK.runJourneys(), social: () => MK.runSocial(), surveys: () => PO.runSurveys() };
router.post('/run/:job', wrap(async (req) => {
  if (!C.isAdmin(req.user)) return C.no('Only an Admin runs this by hand.');
  const fn = JOBS[req.params.job];
  if (!fn) return C.S.fail(404, 'No such job.');
  return ok({ ok: true, result: await fn() });
}));

// every minute: send-later, call results, journeys, social posts, surveys; every 5 minutes: the mailboxes. Each does nothing while its switch is off.
if (!process.env.TEST_MODE && process.env.NODE_ENV !== 'test') {
  const quiet = (name) => (e) => console.error(`[crm b] ${name}:`, e.message); // eslint-disable-line no-console
  setInterval(() => {
    MAIL.runQueue().catch(quiet('send later'));
    PH.syncCalls().catch(quiet('calls'));
    MK.runJourneys().catch(quiet('journeys'));
    MK.runSocial().catch(quiet('social'));
    PO.runSurveys().catch(quiet('surveys'));
  }, 60 * 1000).unref();
  setInterval(() => { MAIL.syncAll().catch(quiet('mailboxes')); }, 5 * 60 * 1000).unref();
}

module.exports = router;
