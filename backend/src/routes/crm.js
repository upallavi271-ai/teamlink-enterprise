// ---------------------------------------------------------------------------
// THE SALES CRM API (founder 2026-11-02) - the rules and data are in crm/service.js. Mounted at /api/crm in index.js; the
// screen says "The CRM could not be opened" when this mount is missing on a server (a copy without this file was deployed).
//
//   GET    /crm/me                         my CRM role, the owner list, the pick lists (stages, sources ...)
//   GET    /crm/dashboard[?mine=1]         pipeline, won / lost this month, follow-ups due, lead sources, closing soon
//   GET    /crm/leads|accounts|contacts|deals[?q=&status=&kind=&owner=&accountId=]
//   POST   /crm/leads|accounts|contacts|deals          {fields, ownerId?, force?}   (409 + duplicates when already in TeamLink)
//   GET    /crm/leads|accounts|contacts|deals/:id      the record with its timeline and follow-ups
//   PUT    /crm/leads|accounts|contacts|deals/:id      {fields, ownerId?}
//   POST   /crm/leads/:id/convert          {dealTitle, openings, avgCtc, feePercent, value, expectedClose, createDeal, accountId}
//   POST   /crm/deals/:id/stage            {stage, lostReason}
//   POST   /crm/deals/:id/client           {clientId}   after "Add as client" in ATS > Clients
//   GET    /crm/client-options             TeamLink clients I may add as an account;  POST /crm/accounts/from-client {clientId}
//   POST   /crm/duplicates                 {company, phone, email}
//   POST   /crm/activities                 {kind, subject, note, at, leadId|dealId|accountId|contactId, followUp: {title, dueDate, dueTime}}
//   GET    /crm/tasks?when=overdue|today|upcoming|open|done[&mine=1]
//   POST   /crm/tasks                      {title, dueDate, dueTime, leadId|dealId|accountId, ownerId?}
//   POST   /crm/tasks/:id/done             {note}
//   GET/POST /crm/tickets   GET/PUT /crm/tickets/:id   POST /crm/tickets/:id/comments {body, toCustomer, to}   (support)
//   GET/POST /crm/campaigns  POST /crm/campaigns/preview  GET/PUT /crm/campaigns/:id  POST .../test {to}  .../send  .../cancel
//   POST   /crm/opt-out {channel, value}    GET /crm/ai/insight/:kind/:id    POST /crm/ai/summary|draft/:kind/:id    POST /crm/ai/ask
//   GET    /crm/overview?period=month|last_month|quarter|year[&mine=1]   the dashboard cards, funnel, today, recent deals, flow
//   GET    /crm/activities?kind=&from=&to=&owner=&q=   every call / meeting / email / WhatsApp / note in one list
//   GET    /crm/reports?month=YYYY-MM      BDE performance vs target, forecast, funnel, deals going cold
//   PUT    /crm/targets {month, ownerId, amount, deals}     PUT /crm/settings {sources, lostReasons, stageProbability, staleDays}
//   POST   /crm/leads/bulk {ids, ownerId|status|rating}     POST /crm/leads/import?name=&ownerId=&dryRun=1 (the file as the body)
//   GET    /crm/export/leads|deals|accounts|contacts|activities|tasks   (CSV)
//   GET/POST /crm/deals/:id/proposals    GET /crm/proposals/:id/pdf    POST /crm/proposals/:id/send {to, message}   /status {status}
//   DELETE /crm/:kind/:id                  Admin / BDE TL (a BDE: their own activity / follow-up)
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const CRM = require('../crm/service');
const X = require('../crm/extra');
const SUP = require('../crm/support');
const CMP = require('../crm/campaigns');
const AI = require('../crm/ai');
const SALES = require('../crm/sales');
const AUTO = require('../crm/autopilot');

const router = express.Router();
router.use(requireAuth);
router.use(async (req, res, next) => {
  if (!(await CRM.crmRoleFor(req.user))) return res.status(403).json({ error: 'The CRM is for the sales team. Ask an Admin to add you to the sales team (CRM settings).' });
  return next();
});

const send = (res, out) => res.status(out.status).json(out.body);
const wrap = (fn) => async (req, res, next) => { try { return send(res, await fn(req)); } catch (e) { return next(e); } };
const KIND = { leads: 'lead', accounts: 'account', contacts: 'contact', deals: 'deal' };
const kindOf = (req) => KIND[req.params.kind];

router.get('/me', wrap((req) => CRM.me(req.user)));
router.get('/dashboard', wrap((req) => CRM.dashboard(req.user, { mine: String(req.query.mine || '') === '1' })));
router.post('/duplicates', wrap(async (req) => ({ status: 200, body: { duplicates: await CRM.duplicatesOf(req.body || {}, { exceptLeadId: req.body && req.body.exceptLeadId }) } })));

router.get('/tasks', wrap(async (req) => {
  await CRM.remind({ userId: req.user.id }).catch(() => 0);
  return { status: 200, body: { tasks: await CRM.tasks(req.user, { when: String(req.query.when || 'open'), mine: String(req.query.mine || '') === '1', all: String(req.query.all || '') === '1', from: req.query.from, to: req.query.to, owner: req.query.owner }) } };
}));
router.post('/tasks', wrap((req) => CRM.addTask(req.user, req.body || {})));
router.post('/tasks/:id/done', wrap((req) => CRM.finishTask(req.user, req.params.id, req.body && req.body.note)));
router.post('/tasks/:id/cancel', wrap((req) => SALES.cancelTask(req.user, req.params.id)));
// the lead pipeline, the website form and the on-screen reminders (crm/sales.js)
router.post('/leads/:id/stage', wrap((req) => SALES.moveLead(req.user, req.params.id, req.body || {})));
router.get('/website', wrap((req) => SALES.websiteGet(req.user)));
router.put('/website', wrap((req) => SALES.websiteSave(req.user, req.body || {})));
router.post('/website/key', wrap((req) => SALES.websiteNewKey(req.user)));
router.get('/reminders/live', wrap((req) => SALES.liveReminders(req.user)));
// the CRM running by itself (crm/autopilot.js)
router.get('/autopilot', wrap((req) => AUTO.get(req.user)));
router.put('/autopilot', wrap((req) => AUTO.save(req.user, req.body || {})));
// the AI sales assistant: answers leads who write back (crm/salesAgent.js)
router.get('/sales-ai', wrap((req) => require('../crm/salesAgent').get(req.user))); // eslint-disable-line global-require
router.put('/sales-ai', wrap((req) => require('../crm/salesAgent').save(req.user, req.body || {}))); // eslint-disable-line global-require
router.post('/leads/:id/auto', wrap((req) => AUTO.pauseLead(req.user, req.params.id, !!(req.body && req.body.paused))));
router.post('/activities', wrap((req) => CRM.addActivity(req.user, req.body || {})));

// the full CRM (crm/extra.js): reports, targets, settings, import, bulk, export, proposals
// Sample data to try the CRM (crm/sample.js): status / load / remove - a sales manager or Admin
router.get('/sample', wrap((req) => require('../crm/sample').status(req.user))); // eslint-disable-line global-require
router.post('/sample', wrap((req) => require('../crm/sample').load(req.user))); // eslint-disable-line global-require
router.delete('/sample', wrap((req) => require('../crm/sample').remove(req.user))); // eslint-disable-line global-require
// Customer support (crm/support.js)
router.get('/tickets', wrap((req) => SUP.list(req.user, req.query || {})));
router.post('/tickets', wrap((req) => SUP.create(req.user, req.body || {})));
router.get('/tickets/:id', wrap((req) => SUP.detail(req.user, req.params.id)));
router.put('/tickets/:id', wrap((req) => SUP.edit(req.user, req.params.id, req.body || {})));
router.post('/tickets/:id/comments', wrap((req) => SUP.comment(req.user, req.params.id, req.body || {})));
// Campaigns (crm/campaigns.js)
router.get('/campaigns', wrap((req) => CMP.list(req.user)));
router.post('/campaigns/preview', wrap((req) => CMP.preview(req.user, req.body || {})));
router.post('/campaigns', wrap((req) => CMP.save(req.user, null, req.body || {})));
router.get('/campaigns/:id', wrap((req) => CMP.detail(req.user, req.params.id)));
router.put('/campaigns/:id', wrap((req) => CMP.save(req.user, req.params.id, req.body || {})));
router.post('/campaigns/:id/test', wrap((req) => CMP.testSend(req.user, req.params.id, req.body || {})));
router.post('/campaigns/:id/send', wrap((req) => CMP.sendNow(req.user, req.params.id)));
router.post('/campaigns/:id/cancel', wrap((req) => CMP.cancel(req.user, req.params.id)));
router.post('/opt-out', wrap((req) => CMP.markOptOut(req.user, req.body || {})));
// AI assistant (crm/ai.js)
router.get('/ai/insight/:kind/:id', wrap((req) => AI.insight(req.user, req.params.kind, req.params.id)));
router.post('/ai/summary/:kind/:id', wrap((req) => AI.summary(req.user, req.params.kind, req.params.id)));
router.post('/ai/draft/:kind/:id', wrap((req) => AI.draftEmail(req.user, req.params.kind, req.params.id, req.body || {})));
router.post('/ai/ask', wrap((req) => AI.ask(req.user, req.body || {})));
router.get('/overview', wrap((req) => X.overview(req.user, { period: String(req.query.period || ''), mine: String(req.query.mine || '') === '1' })));
router.get('/activities', wrap((req) => X.activities(req.user, req.query || {})));
router.get('/reports', wrap((req) => X.reports(req.user, { month: String(req.query.month || '') })));
router.put('/targets', wrap((req) => X.setTarget(req.user, req.body || {})));
router.put('/settings', wrap((req) => X.saveSettings(req.user, req.body || {})));
router.get('/people', wrap((req) => X.people(req.user, String(req.query.q || ''))));
router.post('/leads/bulk', wrap((req) => X.bulkLeads(req.user, req.body || {})));
const rawUpload = express.raw({ type: () => true, limit: '8mb' }); // the Excel / CSV file itself (the JSON parser stops at 100 kb)
router.post('/leads/import', rawUpload, wrap((req) => X.importLeads(req.user, Buffer.isBuffer(req.body) ? req.body : null, {
  fileName: String(req.query.name || ''), ownerId: String(req.query.ownerId || ''), source: String(req.query.source || ''), dryRun: String(req.query.dryRun || '') === '1',
})));
router.get('/export/:kind', async (req, res, next) => {
  try {
    const out = await X.exportCsv(req.user, req.params.kind);
    if (!out.csv) return send(res, out);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${out.name}"`);
    return res.send(out.csv);
  } catch (e) { return next(e); }
});
router.get('/deals/:id/proposals', wrap((req) => X.proposalDefaults(req.user, req.params.id)));
router.post('/deals/:id/proposals', wrap((req) => X.createProposal(req.user, req.params.id, req.body || {})));
router.get('/proposals/:id/pdf', async (req, res, next) => {
  try {
    const out = await X.proposalPdf(req.user, req.params.id);
    if (!out.pdf) return send(res, out);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `inline; filename="${out.name}"`);
    return res.send(out.pdf);
  } catch (e) { return next(e); }
});
router.post('/proposals/:id/send', wrap((req) => X.sendProposal(req.user, req.params.id, req.body || {})));
router.post('/proposals/:id/status', wrap((req) => X.decideProposal(req.user, req.params.id, req.body || {})));
router.post('/leads/:id/convert', wrap((req) => CRM.convertLead(req.user, req.params.id, req.body || {})));
router.post('/deals/:id/stage', wrap((req) => CRM.moveDeal(req.user, req.params.id, req.body || {})));
// Approve / reject a deal's over-limit discount (Sales manager / Admin) — founder 2026-11-13
router.post('/deals/:id/approval', wrap((req) => CRM.decideDeal(req.user, req.params.id, req.body || {})));

router.get('/:kind(leads|accounts|contacts|deals)', wrap(async (req) => ({ status: 200, body: { rows: await CRM.list(req.user, kindOf(req), req.query || {}) } })));
router.post('/:kind(leads|accounts|contacts|deals)', wrap((req) => CRM.create(req.user, kindOf(req), req.body || {})));
router.get('/:kind(leads|accounts|contacts|deals)/:id', wrap((req) => CRM.detail(req.user, kindOf(req), req.params.id)));
router.put('/:kind(leads|accounts|contacts|deals)/:id', wrap((req) => CRM.edit(req.user, kindOf(req), req.params.id, req.body || {})));
router.delete('/:kind(lead|account|contact|deal|activity|task)/:id', wrap((req) => CRM.remove(req.user, req.params.kind, req.params.id)));

// Campaigns that were sending when the server restarted carry on (30 s after start).
if (!process.env.TEST_MODE) setTimeout(() => CMP.resume().catch(() => {}), 30000).unref();

// Follow-up reminders for everybody, once an hour between 9 am and 8 pm India time (a bell notice + one email a day per owner).
if (!process.env.TEST_MODE && process.env.NODE_ENV !== 'test') {
  setInterval(() => {
    const h = new Date(Date.now() + 5.5 * 3600 * 1000).getUTCHours();
    if (h >= 9 && h < 20) CRM.remind().catch((e) => console.error('[crm] reminders:', e.message)); // eslint-disable-line no-console
  }, 60 * 60 * 1000).unref();
  // the timed reminders: every minute, each sent once (crm/sales.js)
  setInterval(() => { SALES.runDue().catch((e) => console.error('[crm] timed reminders:', e.message)); }, 60 * 1000).unref(); // eslint-disable-line no-console
  // the automatic follow-through: does nothing until it is turned on (crm/autopilot.js)
  setInterval(() => { AUTO.tick().catch((e) => console.error('[crm] autopilot:', e.message)); }, 60 * 1000).unref(); // eslint-disable-line no-console
  // nothing else reads the mailbox by itself: mail replies have to be seen for a sequence to stop (only while it is on)
  setInterval(() => { AUTO.checkMailbox().catch((e) => console.error('[crm] mailbox:', e.message)); }, 5 * 60 * 1000).unref(); // eslint-disable-line no-console
}

module.exports = router;
