// PUBLIC plans meeting (no login): /api/public/mk-meeting (marketing/meeting.js).
//   GET  /:token         the language, the first name, the brand colours, the first-ten spots left and the real proof numbers (when there is enough real work)
//   POST /               a page opened without a link starts an anonymous session -> { token, ... }
//   POST /:token/event   { type: start | slide | ask | choice | handover, ... }: what the client does, saved for the team
// The token is "<id>.<signature>" (an HMAC), so a link cannot be guessed; every other address answers the same plain 404. Rate limited per caller, never cached, never indexed.
const express = require('express');
const { rateLimit } = require('../utils/publicRateLimit');
const M = require('../marketing/meeting');

const router = express.Router();
const lim = rateLimit({ bucket: 'mk-meeting', max: 600, windowMs: 10 * 60000, message: 'Many people are using this page at once. Please wait a minute and try again.' });
const limStart = rateLimit({ bucket: 'mk-meeting-start', max: 60, windowMs: 10 * 60000, message: 'Please wait a few minutes and try again.' });
const limPost = rateLimit({ bucket: 'mk-meeting-post', max: 400, windowMs: 10 * 60000 });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const send = (res, out) => (out && out.error ? res.status(out.status || 400).json({ error: out.error }) : res.json(out));

router.use((req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' }); next(); });
router.post('/', limStart, wrap(async (req, res) => res.json(await M.publicStart((req.body || {}).language))));
router.get('/:token', lim, wrap(async (req, res) => send(res, await M.publicView(req.params.token))));
router.post('/:token/event', limPost, wrap(async (req, res) => send(res, await M.publicEvent(req.params.token, req.body || {}))));

module.exports = router;
