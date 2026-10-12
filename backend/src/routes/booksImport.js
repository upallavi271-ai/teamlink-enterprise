// ---------------------------------------------------------------------------
// ACCOUNTS -> JOURNAL / LEDGER IMPORT. Mounted by routes/journal.js at
// /api/accounts/books-import. See utils/booksImport.js for the rules.
//
//   GET  /:kind/sample?format=xlsx|csv   the downloadable template (journal | ledger)
//   POST /:kind/preview?fileName=        body = the file (octet-stream) -> rows, row errors, entries
//   POST /:kind/check                    body = JSON text {rows, options} -> the same, for edited rows
//   POST /:kind/commit                   body = JSON text {rows, options, fileName} -> books them
//
// JSON travels as text/octet-stream so the app-wide 100 KB JSON limit does not
// cut a big file's rows. Access: Accounts roles and Super Admin / Admin only -
// Journal & Ledger / create (view-only roles never hold it) AND an Accounts role.
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { can, DENIED, roleForProduct, SET } = require('../utils/permissions');
const B = require('../utils/booksImport');

const router = express.Router();
const FEATURE = 'Journal & Ledger';
const raw = express.raw({ type: () => true, limit: '20mb' });

async function allowed(req, res, next) {
  try {
    const role = roleForProduct(req.user, 'accounts');
    const desk = SET.ACCOUNTS.includes(role);
    if (desk && await can(req.user, 'accounts', 'accounts', FEATURE, 'create')) return next();
    return res.status(403).json(DENIED);
  } catch (err) { return next(err); }
}
const kindOk = (req, res, next) => (['journal', 'ledger'].includes(req.params.kind) ? next() : res.status(404).json({ error: 'Unknown import' }));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
  if (err instanceof B.ImportError) return res.status(err.status).json({ error: err.message });
  return next(err);
});
const optionsOf = (o) => ({ createAccounts: !!(o && o.createAccounts), plugDifference: !!(o && o.plugDifference) });
function jsonBody(req) {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new B.ImportError(400, 'Nothing was sent.');
  try { const j = JSON.parse(req.body.toString('utf8')); if (!j || typeof j !== 'object') throw new Error('x'); return j; } catch { throw new B.ImportError(400, 'The rows could not be read.'); }
}

router.get('/:kind/sample', requireAuth, allowed, kindOk, wrap(async (req, res) => {
  const f = await B.sampleFile(req.params.kind, req.query.format === 'csv' ? 'csv' : 'xlsx');
  res.setHeader('Content-Type', f.type);
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.kind === 'journal' ? 'journal' : 'opening-balances'}-import-sample.${f.ext}"`);
  res.send(f.buffer);
}));

router.post('/:kind/preview', requireAuth, allowed, kindOk, raw, wrap(async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new B.ImportError(400, 'Choose the filled-in file (.xlsx or .csv).');
  const fileName = String(req.query.fileName || 'upload.xlsx').slice(0, 200);
  const parsed = B.parseFile(req.params.kind, req.body, fileName);
  const out = await B.validate(req.params.kind, parsed.rows, optionsOf({ createAccounts: req.query.createAccounts === '1', plugDifference: req.query.plugDifference === '1' }));
  out.fileName = fileName;
  out.sheet = parsed.sheet;
  out.summary.sampleSkipped = parsed.sampleSkipped;
  res.json(out);
}));

router.post('/:kind/check', requireAuth, allowed, kindOk, raw, wrap(async (req, res) => {
  const j = jsonBody(req);
  const out = await B.validate(req.params.kind, j.rows, optionsOf(j.options));
  res.json(out);
}));

router.post('/:kind/commit', requireAuth, allowed, kindOk, raw, wrap(async (req, res) => {
  const j = jsonBody(req);
  const result = await B.commit(req.params.kind, j.rows, optionsOf(j.options), { id: req.user.id, name: req.user.name }, { fileName: j.fileName ? String(j.fileName).slice(0, 200) : null, req });
  // 200 when everything was booked or safely skipped; 207 when some entries failed (never "success" on a failure).
  res.status(result.ok ? 200 : 207).json(result);
}));

module.exports = router;
