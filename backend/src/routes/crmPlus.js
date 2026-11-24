// ---------------------------------------------------------------------------
// CRM WAVE D API (2026-11-24) - mounted INSIDE routes/crm.js (so the CRM access check runs first), every path under /api/crm/plus.
// The rules live in crm/pipelines.js, crm/catalog.js, crm/collab.js, crm/payLink.js and crm/consent.js. This router also:
//   - keeps the CRM closed outside the office addresses when the Admin turned the IP restriction on (crm/collab.js ipAllowed)
//   - takes the fields hidden from a person's CRM role out of every CRM answer (field-level security)
//   - adds "since when on this stage" to the deal list (time in stage on the board)
//
//   GET  /plus/config                                pipelines, my hidden / read-only fields, territories, teams, switches
//   PUT  /plus/pipelines                             POST /plus/deals/bulk {ids, set}
//   GET  /plus/deals/:id/stages   POST .../checklist {stage, item, done}   POST .../pipeline {pipelineId, stage}
//   GET|PUT /plus/deals/:id/lines  POST .../bundle {bundleId}   GET|PUT .../splits   POST .../renewal   GET .../quotes   POST .../contracts
//   GET  /plus/recurring   PUT /plus/renewal-settings   GET /plus/analysis   GET|POST /plus/forecast   PUT /plus/forecast/adjust
//   GET|PUT /plus/pricebooks  GET|PUT /plus/cpq  GET|PUT /plus/quote-settings  POST /plus/proposals/:id/approval|revise
//   GET  /plus/contracts   PUT /plus/contracts/:id   GET /plus/invoices/export?format=tally|zoho&from=&to=
//   GET  /plus/invoices/:id/pay   POST /plus/invoices/:id/pay-link   POST /plus/pay-links/:id/refresh   GET|PUT /plus/paylink-settings
//   GET|POST /plus/comments/:kind/:id   DELETE /plus/comments/:cid   GET|PUT /plus/collab-settings   GET /plus/approvals
//   GET|PUT /plus/fieldsec   GET /plus/history/:kind/:id   GET|PUT /plus/territories   POST /plus/territories/apply   POST /plus/territory/:kind/:id
//   GET|PUT /plus/teams   GET|PUT /plus/access   GET /plus/transfer/preview   POST /plus/transfer   POST /plus/bulk-owner
//   GET|POST /plus/consent/:kind/:id   GET .../export   POST .../erase   GET|PUT /plus/privacy
// ---------------------------------------------------------------------------
const express = require('express');
const S = require('../crm/service');
const P = require('../crm/plusSchema');
const PL = require('../crm/pipelines');
const CA = require('../crm/catalog');
const CO = require('../crm/collab');
const PAY = require('../crm/payLink');
const CON = require('../crm/consent');

const router = express.Router();
const send = (res, out) => res.status(out.status).json(out.body);
const wrap = (fn) => async (req, res, next) => { try { return send(res, await fn(req)); } catch (e) { return next(e); } };

router.use(async (req, res, next) => {
  try {
    await P.ensure();
    // the settings the sync checks read (sub-team scope, field security, pipelines) are fresh for this request
    await Promise.all([P.getCfg('teams', { teams: [] }), P.getCfg('fieldsec', {}), P.getCfg('pipelines', null)]);
    if (!(await CO.ipAllowed(req))) return res.status(403).json({ error: `The CRM can be opened only from the office network (your address ${CO.ipOf(req)} is not on the list). Ask an Admin.` });
  } catch (e) { return next(e); }
  // every CRM answer: hidden fields out; the deal list gets "on this stage since"
  const orig = res.json.bind(res);
  res.json = (body) => {
    (async () => {
      let b = CO.stripBody(req.user, req.path, body);
      if (req.method === 'GET' && /^\/deals\/?$/.test(req.path) && b && Array.isArray(b.rows)) {
        const since = await PL.stageSince(b.rows.map((x) => x.id));
        b = { ...b, rows: b.rows.map((x) => ({ ...x, stageSince: since[x.id] || x.createdAt })) };
      }
      return b;
    })().then((b) => orig(b)).catch(() => orig(body));
    return res;
  };
  return next();
});

// ---- the one read the screens make with /crm/me ---------------------------------------------------------------------
router.get('/plus/config', wrap(async (req) => {
  const u = req.user;
  const fs = {}; ['lead', 'deal', 'account', 'contact'].forEach((k) => { fs[k] = CO.rulesFor(u, k); });
  const ter = await CO.territories();
  const tm = await CO.teams();
  return S.okBody({
    ...(await PL.config()), fieldRules: fs, fields: CO.FIELDS, territories: ter.territories, teams: tm.teams, managedIds: CO.managedIds(u.id),
    payments: { enabled: (await PAY.settings()).enabled }, privacy: { purposes: (await CON.settings()).purposes, channels: CON.CHANNELS }, contractKinds: CA.CONTRACT_KINDS, contractStatuses: CA.CONTRACT_STATUSES,
  });
}));

// ---- deals & pipeline ----------------------------------------------------------------------------------------------------
router.put('/plus/pipelines', wrap((req) => PL.savePipelines(req.user, req.body || {})));
router.post('/plus/deals/bulk', wrap((req) => PL.bulk(req.user, req.body || {})));
router.get('/plus/deals/:id/stages', wrap((req) => PL.history(req.user, req.params.id)));
router.post('/plus/deals/:id/checklist', wrap((req) => PL.tick(req.user, req.params.id, req.body || {})));
router.post('/plus/deals/:id/pipeline', wrap((req) => PL.changePipeline(req.user, req.params.id, req.body || {})));
router.get('/plus/deals/:id/splits', wrap((req) => PL.splits(req.user, req.params.id)));
router.put('/plus/deals/:id/splits', wrap((req) => PL.saveSplits(req.user, req.params.id, req.body || {})));
router.post('/plus/deals/:id/renewal', wrap((req) => PL.renewal(req.user, req.params.id)));
router.get('/plus/recurring', wrap((req) => PL.recurring(req.user)));
router.put('/plus/renewal-settings', wrap((req) => PL.saveRenewalSettings(req.user, req.body || {})));
router.post('/plus/renewals/run', wrap(async (req) => (S.mayAssign(S.roleOf(req.user)) ? S.okBody(await PL.renewalTick()) : S.fail(403, 'Only a Sales manager or an Admin.'))));
router.get('/plus/analysis', wrap((req) => PL.analysis(req.user, { pipeline: String(req.query.pipeline || ''), from: String(req.query.from || ''), to: String(req.query.to || '') })));
router.get('/plus/forecast', wrap((req) => PL.forecast(req.user, { month: String(req.query.month || '') })));
router.post('/plus/forecast', wrap((req) => PL.submitForecast(req.user, req.body || {})));
router.put('/plus/forecast/adjust', wrap((req) => PL.adjustForecast(req.user, req.body || {})));

// ---- products, quotes, orders ------------------------------------------------------------------------------------------
router.get('/plus/catalogue', wrap(async () => S.okBody({ catalogue: await CA.catalogue() })));
router.get('/plus/pricebooks', wrap(async () => S.okBody({ books: await CA.priceBooks(), catalogue: await CA.catalogue() })));
router.put('/plus/pricebooks', wrap((req) => CA.savePriceBooks(req.user, req.body || {})));
router.get('/plus/cpq', wrap(async () => S.okBody({ cpq: await CA.cpq(), catalogue: await CA.catalogue() })));
router.put('/plus/cpq', wrap((req) => CA.saveCpq(req.user, req.body || {})));
router.get('/plus/deals/:id/lines', wrap((req) => CA.lines(req.user, req.params.id)));
router.put('/plus/deals/:id/lines', wrap((req) => CA.saveLines(req.user, req.params.id, req.body || {})));
router.post('/plus/deals/:id/bundle', wrap((req) => CA.addBundle(req.user, req.params.id, req.body || {})));
router.get('/plus/quote-settings', wrap(async () => S.okBody(await CA.quoteSettings())));
router.put('/plus/quote-settings', wrap((req) => CA.saveQuoteSettings(req.user, req.body || {})));
router.get('/plus/deals/:id/quotes', wrap((req) => CA.quotesOfDeal(req.user, req.params.id)));
router.post('/plus/proposals/:id/approval', wrap((req) => CA.decideQuote(req.user, req.params.id, req.body || {})));
router.post('/plus/proposals/:id/revise', wrap((req) => CA.reviseQuote(req.user, req.params.id)));
router.get('/plus/contracts', wrap((req) => CA.contracts(req.user, { status: String(req.query.status || ''), dealId: req.query.dealId ? String(req.query.dealId) : '' })));
router.post('/plus/deals/:id/contracts', wrap((req) => CA.createContract(req.user, req.params.id, req.body || {})));
router.put('/plus/contracts/:id', wrap((req) => CA.updateContract(req.user, req.params.id, req.body || {})));
router.get('/plus/invoices/export', async (req, res, next) => {
  try {
    const out = await CA.exportInvoices(req.user, { format: String(req.query.format || ''), from: String(req.query.from || ''), to: String(req.query.to || '') });
    if (!out.file) return send(res, out);
    res.set('Content-Type', out.type);
    res.set('Content-Disposition', `attachment; filename="${out.name}"`);
    return res.send(out.file);
  } catch (e) { return next(e); }
});
router.get('/plus/invoices/:id/pay', wrap((req) => PAY.links(req.user, req.params.id)));
router.post('/plus/invoices/:id/pay-link', wrap((req) => PAY.createLink(req.user, req.params.id)));
router.post('/plus/pay-links/:id/refresh', wrap((req) => PAY.refresh(req.user, req.params.id)));
router.get('/plus/paylink-settings', wrap((req) => PAY.status(req.user, req)));
router.put('/plus/paylink-settings', wrap((req) => PAY.saveSettings(req.user, req.body || {})));

// ---- teamwork & security --------------------------------------------------------------------------------------------
router.get('/plus/comments/:kind(lead|deal|account)/:id', wrap((req) => CO.comments(req.user, req.params.kind, req.params.id, { after: req.query.after })));
router.post('/plus/comments/:kind(lead|deal|account)/:id', wrap((req) => CO.addComment(req.user, req.params.kind, req.params.id, req.body || {})));
router.delete('/plus/comments/:cid', wrap((req) => CO.deleteComment(req.user, req.params.cid)));
router.get('/plus/collab-settings', wrap(async () => S.okBody(await CO.collabSettings())));
router.put('/plus/collab-settings', wrap((req) => CO.saveCollab(req.user, req.body || {})));
router.get('/plus/approvals', wrap((req) => CO.approvals(req.user)));
router.get('/plus/fieldsec', wrap(async () => S.okBody({ ...(await CO.fieldSec()), fields: CO.FIELDS })));
router.put('/plus/fieldsec', wrap((req) => CO.saveFieldSec(req.user, req.body || {})));
router.get('/plus/history/:kind(lead|deal|account|contact)/:id', wrap((req) => CO.fieldHistory(req.user, req.params.kind, req.params.id)));
router.get('/plus/territories', wrap((req) => CO.territoryReport(req.user)));
router.put('/plus/territories', wrap((req) => CO.saveTerritories(req.user, req.body || {})));
router.post('/plus/territories/apply', wrap((req) => CO.applyTerritories(req.user, req.body || {})));
router.post('/plus/territory/:kind(lead|account)/:id', wrap((req) => CO.setTerritory(req.user, req.params.kind, req.params.id, req.body || {})));
router.get('/plus/teams', wrap(async () => S.okBody({ ...(await CO.teams()), people: await S.ownerOptions() })));
router.put('/plus/teams', wrap((req) => CO.saveTeams(req.user, req.body || {})));
router.get('/plus/access', wrap(async (req) => S.okBody({ ...(await CO.access()), yourIp: CO.ipOf(req), canChange: S.roleOf(req.user) === 'admin' })));
router.put('/plus/access', wrap((req) => CO.saveAccess(req.user, req.body || {}, req)));
router.get('/plus/transfer/preview', wrap((req) => CO.transferPreview(req.user, { fromId: String(req.query.fromId || '') })));
router.post('/plus/transfer', wrap((req) => CO.transfer(req.user, req.body || {})));
router.post('/plus/bulk-owner', wrap((req) => CO.bulkOwner(req.user, req.body || {})));
router.get('/plus/consent/:kind(lead|contact)/:id', wrap((req) => CON.list(req.user, req.params.kind, req.params.id)));
router.post('/plus/consent/:kind(lead|contact)/:id', wrap((req) => CON.record(req.user, req.params.kind, req.params.id, req.body || {})));
router.get('/plus/consent/:kind(lead|contact)/:id/export', wrap((req) => CON.exportData(req.user, req.params.kind, req.params.id)));
router.post('/plus/consent/:kind(lead|contact)/:id/erase', wrap((req) => CON.erase(req.user, req.params.kind, req.params.id, req.body || {})));
router.get('/plus/privacy', wrap(async () => S.okBody(await CON.settings())));
router.put('/plus/privacy', wrap((req) => CON.saveSettings(req.user, req.body || {})));

// renewal deals made by themselves - only when an Admin turned it on (CRM settings > Renewals); every 6 hours
if (!process.env.TEST_MODE && process.env.NODE_ENV !== 'test') {
  setInterval(() => { PL.renewalTick().catch((e) => console.error('[crm-plus] renewals:', e.message)); }, 6 * 3600 * 1000).unref(); // eslint-disable-line no-console
}

module.exports = router;
