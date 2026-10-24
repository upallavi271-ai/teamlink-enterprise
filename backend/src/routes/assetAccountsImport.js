// ---------------------------------------------------------------------------
// ACCOUNTS - Fixed Assets - IMPORT (the "Import" button of the four sections).
// Mounted by routes/assetAccounts.js at /api/accounts/fixed-assets/import.
// The work is in utils/fixedAssetImport.js (read its header first).
//
//   GET  /sample?section=assets|repairs&format=xlsx|csv   the sample file (the contract)
//   POST /preview?section=&source=hrms|file&fileName=     reads and checks, WRITES NOTHING
//   POST /confirm?section=&source=&fileName=              needs header Idempotency-Key; writes
//        source=hrms: JSON body { items?: [keys shown in the preview] }
//        source=file: the raw file body (.xlsx / .csv, 5 MB at most)
//
// Access: the same right as the Post button - Accounts > Journal & Ledger > create.
// Anyone else gets 403 here, whatever the screen shows.
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { can, DENIED } = require('../utils/permissions');
const F = require('../utils/fixedAssetImport');

const router = express.Router();
const FEATURE = 'Journal & Ledger';

const rawUpload = express.raw({
  type: ['application/octet-stream', 'text/csv', 'text/plain', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  limit: '6mb',
});

const guard = [requireAuth, async (req, res, next) => {
  try {
    if (await can(req.user, 'accounts', 'accounts', FEATURE, 'create')) return next();
    return res.status(403).json(DENIED);
  } catch (err) { return next(err); }
}];

const ask = (req) => ({
  section: String(req.query.section || ''),
  source: String(req.query.source || ''),
  fileName: String(req.query.fileName || 'upload'),
  buffer: Buffer.isBuffer(req.body) ? req.body : null,
});

// An async handler that throws would be an unhandled rejection in Express 4: every failure goes to next().
function fail(res, err, next) {
  if (err instanceof F.ImportError) return res.status(err.status).json({ error: err.message, ...(err.headerMismatch ? { headerMismatch: err.headerMismatch } : {}) });
  return next(err);
}

router.get('/sample', ...guard, async (req, res, next) => {
  try {
    const format = String(req.query.format || 'xlsx').toLowerCase() === 'csv' ? 'csv' : 'xlsx';
    const section = String(req.query.section || '');
    const buf = await F.sampleFor(section, format);
    res.setHeader('Content-Disposition', `attachment; filename="fixed-assets-${section}-import-sample.${format}"`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return res.send(buf);
  } catch (err) { return fail(res, err, next); }
});

router.post('/preview', ...guard, rawUpload, async (req, res, next) => {
  try {
    return res.json({ preview: true, ...(await F.runPreview(ask(req))) });
  } catch (err) { return fail(res, err, next); }
});

router.post('/confirm', ...guard, rawUpload, async (req, res, next) => {
  try {
    const a = ask(req);
    const items = !a.buffer && req.body && Array.isArray(req.body.items) ? req.body.items.slice(0, 5000) : null;
    const out = await F.runConfirm({
      ...a, user: req.user, idempotencyKey: req.get('idempotency-key'), items,
    });
    return res.status(out.status).json(out.body);
  } catch (err) { return fail(res, err, next); }
});

// A file over the limit is a plain-words answer, not "Something went wrong".
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413)) return res.status(413).json({ error: 'The file is too big. The most allowed is 5 MB.' });
  console.error(err); // eslint-disable-line no-console
  return res.status(500).json({ error: req.path === '/confirm' ? 'The import could not be finished. Open the table to see what was saved. Running Import again is safe - nothing is added twice.' : 'The file could not be checked. Nothing was saved. Please try again.' });
});

module.exports = router;
