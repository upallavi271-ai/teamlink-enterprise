// ---------------------------------------------------------------------------
// THE CANDIDATE'S FREE AI LINK - public, by token, no login (2026-10-28, calling/webTalk.js).
// Mounted at /api/talk. The page (frontend /talk/:token) does speech-to-text and text-to-speech in the candidate's own
// browser; only text comes here. Rate-limited per IP (utils/publicRateLimit.js).
//
//   GET  /:token        the first look: first name, language, finished or not (nothing about the job)
//   POST /:token/turn   { event: 'start', language? } | { event: 'language', language } | { event: 'stop' } | { text }
//                       -> { say, done, language }
// ---------------------------------------------------------------------------
const express = require('express');
const W = require('../calling/webTalk');
const { rateLimit } = require('../utils/publicRateLimit');

const router = express.Router();
router.use(rateLimit({ bucket: 'ai-talk', max: 300, windowMs: 10 * 60000 }));
const send = (res, r) => (r && r.ok === false ? res.status(r.status || 400).json({ error: r.error }) : res.json(r));

router.get('/:token', async (req, res) => {
  send(res, await W.open(req.params.token));
});

router.post('/:token/turn', async (req, res) => {
  const b = req.body || {};
  send(res, await W.turn(req.params.token, {
    event: ['start', 'stop', 'language'].includes(b.event) ? b.event : undefined,
    language: typeof b.language === 'string' ? b.language.slice(0, 20) : undefined,
    text: typeof b.text === 'string' ? b.text : undefined,
  }));
});

module.exports = router;
