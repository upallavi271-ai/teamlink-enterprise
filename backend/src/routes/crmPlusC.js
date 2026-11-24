// ---------------------------------------------------------------------------
// CRM WAVE C API (2026-11-24) - mounted INSIDE routes/crm.js (so the CRM login check has run), under /api/crm/plusc. The rules are in
// backend/src/crm/plusc/*.js:
//   GET  /plusc/setup                         custom fields, rules, layouts, record types, currencies, units, year, branding (every CRM screen reads it)
//   GET|POST /plusc/fields  DELETE /plus/fields/:id          GET|POST /plus/rules  DELETE /plus/rules/:id          PUT /plus/layouts/:kind
//   GET|POST /plusc/objects  GET|POST /plus/objects/:id/records  PUT|DELETE /plus/object-records/:rid
//   GET  /plusc/record/:kind/:id               the "More" tab: tags, custom values, parent / children, unit, currency, linked record types
//   GET  /plusc/tags?kind=   GET|POST /plus/files/:kind/:id   GET|DELETE /plus/file/:fid
//   GET|POST /plusc/deal-contacts/:dealId  DELETE /plus/deal-contacts/:dealId/:contactId
//   GET|POST /plusc/team/:accountId  DELETE /plus/team/:accountId/:userId   GET /plus/hierarchy/:id   GET /plus/org-chart/:id
//   GET  /plusc/health[/:accountId]   GET /plus/search?q=   POST /plus/enrich/:accountId[/apply]
//   GET  /plusc/bin  POST /plus/bin/:id/restore  DELETE /plus/bin/:id   GET|PUT /plus/retention  POST /plus/retention/run
//   GET  /plusc/duplicates?kind=  GET /plus/merge?kind=&keepId=&mergeId=  POST /plus/merge   POST /plus/bulk   POST /plus/import/:kind (the file)
//   GET|POST /plusc/consent/:kind/:id   GET|POST /plus/dsr  GET /plus/dsr/:id/export  POST /plus/dsr/:id/erase
//   GET|PUT /plusc/dnd  POST /plus/dnd/upload (the file)  GET /plus/dnd/check?phone=  POST /plus/dnd/clear   GET /plus/privacy
//   GET|POST /plusc/assign-rules  DELETE /plus/assign-rules/:id  PUT /plus/assign-rules/switch  POST /plus/assign-rules/test
//   GET|PUT /plusc/capture  POST /plus/capture/key  POST /plus/capture/pull/:source  GET /plus/capture/snippet
//   GET|PUT /plusc/prefs  GET|POST /plus/prefs/logo   GET|POST /plus/package   GET /plus/adoption?days=
// ---------------------------------------------------------------------------
const express = require('express');
const P = require('../crm/plusc/db');
const F = require('../crm/plusc/fields');
const R = require('../crm/plusc/records');
const D = require('../crm/plusc/dataCare');
const L = require('../crm/plusc/leadIn');
const A = require('../crm/plusc/admin');

const router = express.Router();
const send = (res, out) => res.status(out.status).json(out.body);
const wrap = (fn) => async (req, res, next) => { try { return send(res, await fn(req)); } catch (e) { return next(e); } };
const raw = express.raw({ type: () => true, limit: '8mb' });
const bufOf = (req) => (Buffer.isBuffer(req.body) ? req.body : null);
const fileOut = (fn) => async (req, res, next) => {
  try {
    const out = await fn(req);
    if (!out.path) return send(res, out);
    res.set('Content-Type', out.mime || 'application/octet-stream');
    if (out.name) res.set('Content-Disposition', `attachment; filename="${String(out.name).replace(/["\r\n]/g, '')}"`);
    res.set('X-Content-Type-Options', 'nosniff');
    return res.sendFile(out.path);
  } catch (e) { return next(e); }
};
const jsonFile = (fn) => async (req, res, next) => {
  try {
    const out = await fn(req);
    if (!out.json) return send(res, out);
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${out.name}"`);
    return res.send(out.json);
  } catch (e) { return next(e); }
};
P.ensure().catch(() => null); // the wave C tables, once, at start

// customising
router.get('/plusc/setup', wrap(async () => ({ status: 200, body: await F.setup() })));
router.get('/plusc/fields', wrap(async (req) => ({ status: 200, body: { fields: await F.defs(F.KINDS.includes(req.query.kind) ? req.query.kind : null, { all: String(req.query.all || '') === '1' }) } })));
router.post('/plusc/fields', wrap((req) => F.saveField(req.user, req.body || {})));
router.delete('/plusc/fields/:id', wrap((req) => F.removeField(req.user, req.params.id)));
router.get('/plusc/rules', wrap(async (req) => ({ status: 200, body: { rules: await F.rules(F.KINDS.includes(req.query.kind) ? req.query.kind : null) } })));
router.post('/plusc/rules', wrap((req) => F.saveRule(req.user, req.body || {})));
router.delete('/plusc/rules/:id', wrap((req) => F.removeRule(req.user, req.params.id)));
router.put('/plusc/layouts/:kind', wrap((req) => F.saveLayout(req.user, req.params.kind, req.body || {})));
router.get('/plusc/objects', wrap(async (req) => ({ status: 200, body: { objects: await F.objects({ all: String(req.query.all || '') === '1' }) } })));
router.post('/plusc/objects', wrap((req) => F.saveObject(req.user, req.body || {})));
router.get('/plusc/objects/:id/records', wrap((req) => F.objectRecords(req.user, req.params.id, req.query || {})));
router.post('/plusc/objects/:id/records', wrap((req) => F.saveObjectRecord(req.user, req.params.id, req.body || {})));
router.put('/plusc/object-records/:rid', wrap((req) => F.saveObjectRecord(req.user, (req.body || {}).objectId, req.body || {}, req.params.rid)));
router.delete('/plusc/object-records/:rid', wrap((req) => F.removeObjectRecord(req.user, req.params.rid)));

// on the records
const KIND = (k) => (['lead', 'account', 'contact', 'deal'].includes(k) ? k : null);
router.get('/plusc/record/:kind/:id', wrap((req) => R.extras(req.user, KIND(req.params.kind), req.params.id)));
router.get('/plusc/tags', wrap((req) => R.allTags(req.user, KIND(req.query.kind))));
router.get('/plusc/files/:kind/:id', wrap((req) => R.files(req.user, KIND(req.params.kind), req.params.id)));
router.post('/plusc/files/:kind/:id', wrap((req) => R.uploadFile(req.user, KIND(req.params.kind), req.params.id, req)));
router.get('/plusc/file/:fid', fileOut((req) => R.fileDownload(req.user, req.params.fid)));
router.delete('/plusc/file/:fid', wrap((req) => R.deleteFile(req.user, req.params.fid)));
router.get('/plusc/deal-contacts/:dealId', wrap((req) => R.dealContacts(req.user, req.params.dealId)));
router.post('/plusc/deal-contacts/:dealId', wrap((req) => R.addDealContact(req.user, req.params.dealId, req.body || {})));
router.delete('/plusc/deal-contacts/:dealId/:contactId', wrap((req) => R.removeDealContact(req.user, req.params.dealId, req.params.contactId)));
router.get('/plusc/team/:accountId', wrap((req) => R.team(req.user, req.params.accountId)));
router.post('/plusc/team/:accountId', wrap((req) => R.addTeam(req.user, req.params.accountId, req.body || {})));
router.delete('/plusc/team/:accountId/:userId', wrap((req) => R.removeTeam(req.user, req.params.accountId, req.params.userId)));
router.get('/plusc/hierarchy/:accountId', wrap((req) => R.hierarchy(req.user, req.params.accountId)));
router.get('/plusc/org-chart/:accountId', wrap((req) => R.orgChart(req.user, req.params.accountId)));
router.get('/plusc/health', wrap((req) => R.healthList(req.user, { band: String(req.query.band || ''), all: String(req.query.all || '') })));
router.get('/plusc/health/:accountId', wrap((req) => R.health(req.user, req.params.accountId)));
router.get('/plusc/search', wrap((req) => R.search(req.user, req.query.q)));
router.post('/plusc/enrich/:accountId', wrap((req) => R.enrich(req.user, req.params.accountId)));
router.post('/plusc/enrich/:accountId/apply', wrap((req) => R.applyEnrich(req.user, req.params.accountId, req.body || {})));

// the data
router.get('/plusc/bin', wrap((req) => D.bin(req.user, req.query || {})));
router.post('/plusc/bin/:id/restore', wrap((req) => D.restore(req.user, req.params.id)));
router.delete('/plusc/bin/:id', wrap((req) => D.purge(req.user, req.params.id)));
router.get('/plusc/retention', wrap((req) => D.retentionGet(req.user)));
router.put('/plusc/retention', wrap((req) => D.retentionSave(req.user, req.body || {})));
router.post('/plusc/retention/run', wrap((req) => D.retentionRunNow(req.user)));
router.get('/plusc/duplicates', wrap((req) => D.duplicates(req.user, String(req.query.kind || ''))));
router.get('/plusc/merge', wrap((req) => D.mergePreview(req.user, String(req.query.kind || ''), String(req.query.keepId || ''), String(req.query.mergeId || ''))));
router.post('/plusc/merge', wrap((req) => D.merge(req.user, req.body || {})));
router.post('/plusc/bulk', wrap((req) => D.bulk(req.user, req.body || {})));
router.post('/plusc/import/:kind', raw, wrap((req) => D.importRecords(req.user, String(req.params.kind || '').replace(/s$/, ''), bufOf(req), {
  dryRun: String(req.query.dryRun || '') === '1', fileName: String(req.query.name || ''), createAccounts: String(req.query.createAccounts || '') === '1',
  map: (() => { try { return req.query.map ? JSON.parse(String(req.query.map)) : null; } catch { return null; } })(),
})));
router.get('/plusc/consent/:kind/:id', wrap((req) => D.consentGet(req.user, KIND(req.params.kind), req.params.id)));
router.post('/plusc/consent/:kind/:id', wrap((req) => D.consentSet(req.user, KIND(req.params.kind), req.params.id, req.body || {})));
router.get('/plusc/dsr', wrap((req) => D.dsrList(req.user)));
router.post('/plusc/dsr', wrap((req) => D.dsrCreate(req.user, req.body || {})));
router.get('/plusc/dsr/:id/export', jsonFile((req) => D.dsrExport(req.user, req.params.id)));
router.post('/plusc/dsr/:id/erase', wrap((req) => D.dsrErase(req.user, req.params.id, req.body || {})));
router.get('/plusc/dnd', wrap((req) => D.dndGet(req.user)));
router.put('/plusc/dnd', wrap((req) => D.dndSave(req.user, req.body || {})));
router.post('/plusc/dnd/upload', raw, wrap((req) => D.dndUpload(req.user, bufOf(req), { replace: String(req.query.replace || '') === '1' })));
router.get('/plusc/dnd/check', wrap((req) => D.dndCheck(req.user, req.query.phone)));
router.post('/plusc/dnd/clear', wrap((req) => D.dndClear(req.user, (req.body || {}).phone)));
router.get('/plusc/privacy', wrap((req) => D.privacySummary(req.user)));

// leads in
router.get('/plusc/assign-rules', wrap((req) => L.rulesList(req.user)));
router.post('/plusc/assign-rules', wrap((req) => L.ruleSave(req.user, req.body || {})));
router.put('/plusc/assign-rules/switch', wrap((req) => L.rulesSwitch(req.user, (req.body || {}).on === true)));
router.post('/plusc/assign-rules/test', wrap((req) => L.ruleTest(req.user, req.body || {})));
router.delete('/plusc/assign-rules/:id', wrap((req) => L.ruleRemove(req.user, req.params.id)));
router.get('/plusc/capture', wrap((req) => L.captureGet(req.user)));
router.put('/plusc/capture', wrap((req) => L.captureSave(req.user, req.body || {})));
router.post('/plusc/capture/key', wrap((req) => L.captureNewKey(req.user)));
router.post('/plusc/capture/pull/:source', wrap((req) => L.pullNow(req.user, req.params.source)));
router.get('/plusc/capture/snippet', wrap(async (req) => {
  const out = await L.captureGet(req.user);
  if (out.status !== 200) return out;
  const base = String(process.env.APP_BASE_URL || '').replace(/\/+$/, '') || `${req.protocol}://${req.get('host')}`;
  return { status: 200, body: { base, snippet: L.chatSnippet(base, out.body.key), urls: Object.fromEntries(['webhook', 'email', 'chat', 'linkedin', 'google', 'justdial', 'indiamart'].map((s) => [s, `${base}/api/crm/capture/${s}?key=${out.body.key}`])), facebook: `${base}/api/crm/capture/facebook` } };
}));

// admin
router.get('/plusc/prefs', wrap((req) => A.prefsGet(req.user)));
router.put('/plusc/prefs', wrap((req) => A.prefsSave(req.user, req.body || {})));
router.post('/plusc/prefs/logo', wrap((req) => A.uploadLogo(req.user, req)));
router.get('/plusc/prefs/logo', fileOut((req) => A.logoFile(req.user)));
router.get('/plusc/package', jsonFile((req) => A.packageOut(req.user)));
router.post('/plusc/package', raw, wrap((req) => {
  let pkg = null; try { pkg = JSON.parse(bufOf(req).toString('utf8')); } catch { pkg = null; }
  return A.packageIn(req.user, { package: pkg, dryRun: String(req.query.apply || '') !== '1' });
}));
router.get('/plusc/adoption', wrap((req) => A.adoption(req.user, { days: req.query.days })));

// every CRM request counts for the adoption report (routes/crm.js puts this right after the CRM login check)
function track(req, res, next) {
  A.track(req.user, { method: req.method, path: req.path }).catch(() => null);
  // the wave C settings are read here (10 s cache), so the sync readers - the financial year of a report, the logo on a PDF - are current
  P.config().then(() => next(), () => next());
}

// the jobs that run by themselves - each does nothing until switched on in CRM settings
if (!process.env.TEST_MODE && process.env.NODE_ENV !== 'test') {
  setInterval(() => { L.tick().catch(() => null); }, 5 * 60 * 1000).unref(); // IndiaMART / TradeIndia pull (only the portals switched on, every N minutes)
  setInterval(() => {
    const h = new Date(Date.now() + 5.5 * 3600 * 1000).getUTCHours();
    if (h === 2) D.retentionRun().catch((e) => console.error('[crm] retention:', e.message)); // eslint-disable-line no-console
  }, 30 * 60 * 1000).unref();
}

module.exports = { router, track };
