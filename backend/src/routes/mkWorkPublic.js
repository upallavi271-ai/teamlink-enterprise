// PUBLIC "OUR WORK" data (no login): /api/public/mk-work (marketing/projects.js publicWork). The track record (numbers over all finished client projects, no names) and the
// portfolio: only projects the team marked "the client agrees we show this work", anonymous unless the team ticked the client's name. Files are served by a signed key
// and only while the project is marked to be shown. Rate limited per caller, never indexed.
const express = require('express');
const { rateLimit } = require('../utils/publicRateLimit');
const P = require('../marketing/projects');

const router = express.Router();
const lim = rateLimit({ bucket: 'mk-work', max: 900, windowMs: 10 * 60000, message: 'Many people are using this page at once. Please wait a minute and try again.' });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use((req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' }); next(); });
router.get('/', lim, wrap(async (req, res) => res.json(await P.publicWork())));
router.get('/file/:key', lim, wrap(async (req, res, next) => {
  const f = await P.publicWorkFile(req.params.key);
  if (!f) return res.status(404).type('text/plain').send('Not available.');
  res.set({ 'Content-Type': f.mime, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox" });
  return res.sendFile(f.path, (err) => { if (err && !res.headersSent) next(err); });
}));

module.exports = router;
