// PUBLIC client approval page data (no login): /api/public/mk-review/:token (marketing/clientReview.js).
// The token is "<id>.<signature>": the signature is an HMAC, so a link cannot be guessed; every other address answers the same plain 404. Rate limited per caller,
// never cached, never indexed. The picture / video is sent with its stored type, "nosniff" and a sandbox policy.
const express = require('express');
const { rateLimit } = require('../utils/publicRateLimit');
const R = require('../marketing/clientReview');

const router = express.Router();
const lim = rateLimit({ bucket: 'mk-review', max: 900, windowMs: 10 * 60000, message: 'Many people are using this page at once. Please wait a minute and try again.' });
const limPost = rateLimit({ bucket: 'mk-review-post', max: 20, windowMs: 10 * 60000 });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const send = (res, out) => (out && out.error ? res.status(out.status || 400).json({ error: out.error }) : res.json(out));

router.use((req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' }); next(); });
router.get('/:token', lim, wrap(async (req, res) => send(res, await R.publicView(req.params.token))));
router.get('/:token/file', lim, wrap(async (req, res, next) => {
  const f = await R.publicFile(req.params.token);
  if (!f) return res.status(404).type('text/plain').send('This link does not work any more.');
  res.set({ 'Content-Type': f.mime, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox" });
  return res.sendFile(f.path, (err) => { if (err && !res.headersSent) next(err); });
}));
router.post('/:token/decision', limPost, wrap(async (req, res) => send(res, await R.publicDecide(req.params.token, req.body || {}, require('../utils/clientIp').ipOf(req)))));

module.exports = router;
