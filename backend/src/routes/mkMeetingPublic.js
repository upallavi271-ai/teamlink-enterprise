// PUBLIC plans meeting (no login): /api/public/mk-meeting (marketing/meeting.js).
//   GET  /:token         the language, the first name, the brand colours, the first-ten spots left and the real proof numbers (when there is enough real work)
//   POST /               a page opened without a link starts an anonymous session -> { token, ... }
//   POST /:token/event   { type: start | slide | ask | choice | handover, ... }: what the client does, saved for the team
//   GET  /voice/status   { en, te, hi }: where the server can speak (marketing/meetingVoice.js: the free Piper voices)
//   GET  /voice?lang=te&t=<one of the meeting's own sentences>   audio/wav (nothing else can be spoken)
// The token is "<id>.<signature>" (an HMAC), so a link cannot be guessed; every other address answers the same plain 404. Rate limited per caller, never cached, never indexed.
const express = require('express');
const { rateLimit } = require('../utils/publicRateLimit');
const M = require('../marketing/meeting');
const Voice = require('../marketing/meetingVoice');

const router = express.Router();
const lim = rateLimit({ bucket: 'mk-meeting', max: 600, windowMs: 10 * 60000, message: 'Many people are using this page at once. Please wait a minute and try again.' });
const limStart = rateLimit({ bucket: 'mk-meeting-start', max: 60, windowMs: 10 * 60000, message: 'Please wait a few minutes and try again.' });
const limPost = rateLimit({ bucket: 'mk-meeting-post', max: 400, windowMs: 10 * 60000 });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const send = (res, out) => (out && out.error ? res.status(out.status || 400).json({ error: out.error }) : res.json(out));

router.use((req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' }); next(); });
const limVoice = rateLimit({ bucket: 'mk-meeting-voice', max: 900, windowMs: 10 * 60000, message: 'Please wait a minute and try again.' });
// a sound file the browser's audio element can play: whole, or the byte range a phone asks for (iPhones always ask by range)
function sendWav(req, res, wav) {
  res.set({ 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400' });
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (m && (m[1] || m[2])) {
    const a = m[1] === '' ? Math.max(0, wav.length - Number(m[2])) : Number(m[1]);
    const b = m[1] === '' || m[2] === '' ? wav.length - 1 : Math.min(Number(m[2]), wav.length - 1);
    if (a > b || a >= wav.length) { res.status(416).set('Content-Range', `bytes */${wav.length}`); return res.end(); }
    res.status(206).set({ 'Content-Range': `bytes ${a}-${b}/${wav.length}`, 'Content-Length': String(b - a + 1) });
    return res.end(wav.subarray(a, b + 1));
  }
  res.set('Content-Length', String(wav.length));
  return res.end(wav);
}
router.get('/voice/status', lim, (req, res) => res.json(Voice.status()));
router.get('/voice', limVoice, wrap(async (req, res) => {
  const out = await Voice.speak(String(req.query.lang || ''), String(req.query.t || ''));
  return out.error ? res.status(out.status || 400).json({ error: out.error }) : sendWav(req, res, out.wav);
}));
router.post('/', limStart, wrap(async (req, res) => res.json(await M.publicStart((req.body || {}).language))));
router.get('/:token', lim, wrap(async (req, res) => send(res, await M.publicView(req.params.token))));
router.post('/:token/event', limPost, wrap(async (req, res) => send(res, await M.publicEvent(req.params.token, req.body || {}))));

module.exports = router;
