// ---------------------------------------------------------------------------
// EXPORT + IMPORT FOR EVERY VENDOR PORTAL - /api/vendor-portal/vendor-io/* (2026-10-19).
// Mounted INSIDE routes/vendorPortal.js: it inherits the feature flag, the rate limit, the vendor shield and the vendor wall. The wall lets a
// signed-in vendor of ANY kind reach this prefix; this file decides what the vendor's KIND (assets | idcards | telecom | finance) may use.
//
//   GET  /info                               what this login can export / import and why not (the buttons read it)
//   GET  /export/:list?format=csv|xlsx&...   the list's rows with the list's own search / filters / sort, no paging (utils/vendorExport.js)
//   GET  /import/:key/sample?format=xlsx|csv the sample file = the contract (strict headers)
//   POST /import/:key/preview?fileName=      raw file body (.xlsx / .csv, 5 MB). Checks every row with the real rules. Writes NOTHING.
//   POST /import/:key/confirm?fileName=      raw file body + header Idempotency-Key. Saves the valid rows, each in its own transaction.
//
// The company's ASSETS are never imported: they come by themselves from HRMS and Accounts (utils/assetHrmsScope.js).
// ISOLATION: the vendor and its kind come from the SESSION; a vendorId anywhere in the request is never read.
// ---------------------------------------------------------------------------
const express = require('express');
const VA = require('../utils/vendorAuth');
const VM = require('../utils/vendorModules');
const CFG = require('../config/vendorModules');
const KIND = require('../utils/vendorKind');
const IDC = require('../utils/idCardVendorPortal');
const EX = require('../utils/vendorExport');
const IMP = require('../utils/vendorImport');

const router = express.Router();
const vendorOnly = VA.requireVendor();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
  if (err instanceof EX.ExportError || err instanceof IMP.ImportError) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
  return next(err);
});
const NO_DOWNLOAD = 'Your login cannot download lists. Ask the company to switch on "Download lists (Export)".';
const ASSETS_NOTE = 'Assets are added automatically from HRMS and Accounts: nothing to import.';
const rawUpload = express.raw({
  type: ['application/octet-stream', 'text/csv', 'text/plain', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  limit: '6mb',
});

// Who is this, which kind, and what do its ticks allow? Read fresh on every call (an Admin's change applies at once).
async function ctxOf(req) {
  const row = { ...req.vendor.row, vendorId: req.vendor.vendorId };
  const kind = await KIND.kindOfRow(row);
  const eff = await VM.effectiveModules(req.vendor.row);
  const tick = (mk, pk) => { const m = eff.map.get(mk); return m ? CFG.permAllowed(mk, m.permissions, pk) : null; }; // null = that module is not on
  const v = { userId: req.vendor.userId, vendorId: req.vendor.vendorId, vendorName: req.vendor.vendorName, name: req.vendor.name, canEdit: req.vendor.canEdit, canViewCost: req.vendor.canViewCost };
  let download = true;
  let importAllowed = false;
  let needs = '';
  let perms = null;
  if (kind === 'assets') { v.showAmounts = await require('../utils/assetVendorPortal').showAmountsOf(req.vendor.row); download = tick('assets', 'download') !== false; importAllowed = !!v.canEdit; needs = 'Allow editing'; }
  else if (kind === 'idcards') { perms = await IDC.permsOf(req.vendor.row); download = perms.download; importAllowed = perms.updateStatus; needs = 'Update order status'; }
  else if (kind === 'telecom') { download = tick('airtel_bills', 'download') !== false; importAllowed = tick('airtel_bills', 'sendBill') === true; needs = 'Send a bill'; }
  else { const t = tick('invoices', 'download'); download = t !== false; importAllowed = tick('invoices', 'raise') === true; needs = 'Raise / upload invoices'; }
  return { req, kind, v, perms, download, importAllowed, needs };
}

router.get('/vendor-io/info', vendorOnly, wrap(async (req, res) => {
  const c = await ctxOf(req);
  const lists = Object.entries(EX.listsOf(c.kind)).map(([key, d]) => ({ key, label: d.label }));
  res.json({
    kind: c.kind,
    export: { allowed: c.download, reason: c.download ? null : NO_DOWNLOAD, lists, max: 10000 },
    import: {
      allowed: c.importAllowed,
      reason: c.importAllowed ? null : `Your login cannot import. Ask the company to switch on "${c.needs}".`,
      items: IMP.importsOf(c.kind).map((i) => ({ key: i.key, title: i.title, help: i.help, needs: i.needs, columns: IMP.specOf(i).columns.map((x) => ({ label: x.label, required: !!x.required })) })),
      assetsNote: ASSETS_NOTE, maxRows: IMP.MAX_ROWS, maxMb: 5,
    },
  });
}));

router.get('/vendor-io/export/:list', vendorOnly, wrap(async (req, res) => {
  const c = await ctxOf(req);
  if (!c.download) return res.status(403).json({ error: NO_DOWNLOAD });
  const def = EX.listsOf(c.kind)[String(req.params.list)];
  if (!def) return res.status(404).json({ error: 'This list cannot be exported.' }); // a list of another kind answers the same as an unknown one
  const built = await EX.guarded(c.v.userId, () => EX.build(c.kind, String(req.params.list), c.v, req.query || {}, String(req.query.format || 'csv').toLowerCase()));
  await EX.audit(req, c.v, String(req.params.list), built);
  res.setHeader('Content-Type', built.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${built.filename}"`);
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Row-Count');
  res.setHeader('X-Row-Count', String(built.count));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.send(built.buffer);
}));

async function importCtx(req, res) {
  const c = await ctxOf(req);
  const key = String(req.params.key || '');
  if (!IMP.importOf(c.kind, key)) { res.status(404).json({ error: 'There is no Import for this page.', assetsNote: ASSETS_NOTE }); return null; }
  c.importKey = key;
  return c;
}
router.get('/vendor-io/import/:key/sample', vendorOnly, wrap(async (req, res) => {
  const c = await importCtx(req, res); if (!c) return undefined;
  if (!c.importAllowed) return res.status(403).json({ error: `Your login cannot import. Ask the company to switch on "${c.needs}".` });
  const s = await IMP.sampleFor(c.kind, c.importKey, String(req.query.format || 'xlsx').toLowerCase() === 'csv' ? 'csv' : 'xlsx');
  res.setHeader('Content-Disposition', `attachment; filename="${s.filename}"`);
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  res.setHeader('Content-Type', s.mime);
  return res.send(s.buffer);
}));

const bodyOf = (req) => (Buffer.isBuffer(req.body) ? req.body : null);
router.post('/vendor-io/import/:key/preview', vendorOnly, rawUpload, wrap(async (req, res) => {
  const c = await importCtx(req, res); if (!c) return undefined;
  if (!c.importAllowed) return res.status(403).json({ error: `Your login cannot import. Ask the company to switch on "${c.needs}".` });
  return res.json(await IMP.preview(c, bodyOf(req), String(req.query.fileName || 'upload')));
}));
router.post('/vendor-io/import/:key/confirm', vendorOnly, rawUpload, wrap(async (req, res) => {
  const c = await importCtx(req, res); if (!c) return undefined;
  if (!c.importAllowed) return res.status(403).json({ error: `Your login cannot import. Ask the company to switch on "${c.needs}".` });
  const out = await IMP.confirm(c, bodyOf(req), String(req.query.fileName || 'upload'), req.get('idempotency-key'));
  if (out.body && out.body.duplicateRequest) res.set('Idempotent-Replay', 'true');
  return res.status(out.status).json(out.body);
}));

// A file over the limit is a plain-words answer, not "Something went wrong".
// eslint-disable-next-line no-unused-vars
router.use('/vendor-io', (err, req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413)) return res.status(413).json({ error: 'The file is too big. The most allowed is 5 MB.' });
  console.error('[vendor-io]', err && err.message); // eslint-disable-line no-console
  return res.status(500).json({ error: String(req.path).includes('/confirm') ? 'The import could not be finished. Open the list to see what was saved. Running the same file again is safe: nothing is saved twice.' : 'The file could not be checked. Nothing was saved. Please try again.' });
});
router.all('/vendor-io/*', (req, res) => res.status(403).json({ error: 'Forbidden.' }));

module.exports = router;
