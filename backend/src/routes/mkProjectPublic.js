// PUBLIC client project page data (no login): /api/public/mk-project/:token (marketing/projects.js).
// The token is "<id>.<signature>" (an HMAC): a link cannot be guessed and every other address answers the same plain 404. One link covers the whole project:
// the request form, the progress, the options to choose from, the final result. Rate limited per caller, never cached, never indexed. Options are served by
// option id (never an item id or a file path), with their stored type, "nosniff" and a sandbox policy.
const express = require('express');
const { rateLimit } = require('../utils/publicRateLimit');
const P = require('../marketing/projects');

const router = express.Router();
const lim = rateLimit({ bucket: 'mk-project', max: 300, windowMs: 10 * 60000 });
const limPost = rateLimit({ bucket: 'mk-project-post', max: 20, windowMs: 10 * 60000 });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const send = (res, out) => (out && out.error ? res.status(out.status || 400).json({ error: out.error }) : res.json(out));
const ip = (req) => require('../utils/clientIp').ipOf(req); // eslint-disable-line global-require

router.use((req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' }); next(); });
router.get('/:token', lim, wrap(async (req, res) => send(res, await P.publicView(req.params.token))));
router.get('/:token/option/:optionId', lim, wrap(async (req, res, next) => {
  const f = await P.publicOptionFile(req.params.token, req.params.optionId);
  if (!f) return res.status(404).type('text/plain').send('This link does not work any more.');
  res.set({ 'Content-Type': f.mime, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox" });
  return res.sendFile(f.path, (err) => { if (err && !res.headersSent) next(err); });
}));
router.post('/:token/request', limPost, wrap(async (req, res) => send(res, await P.publicSubmitRequest(req.params.token, req.body || {}))));
router.post('/:token/choose', limPost, wrap(async (req, res) => send(res, await P.publicChoose(req.params.token, req.body || {}, ip(req)))));
router.post('/:token/changes', limPost, wrap(async (req, res) => send(res, await P.publicChanges(req.params.token, req.body || {}, ip(req)))));

module.exports = router;
