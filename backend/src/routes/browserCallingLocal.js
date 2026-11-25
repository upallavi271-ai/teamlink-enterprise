// ---------------------------------------------------------------------------
// /api/browser-calling-local/*  - asked ONLY by the phone system (Asterisk) running on this same machine, while an incoming call from the
// office Synway rings: who should it ring? Answers plain text "<extension>|<backup extension>" (browsercall/sims.js inboundRoute).
// Refused unless the request comes straight from 127.0.0.1 / ::1 with no proxy header (nginx always adds one, so nothing from outside gets in).
// The answer holds only browser extension numbers, never a name, a phone number or a candidate.
// ---------------------------------------------------------------------------
const express = require('express');
const SIMS = require('../browsercall/sims');

const router = express.Router();
const LOOP = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const local = (req) => LOOP.has(String((req.socket && req.socket.remoteAddress) || '')) && !req.get('x-forwarded-for') && !req.get('x-real-ip');

router.get('/inbound-route', async (req, res) => {
  if (!local(req)) return res.status(403).type('text').send('');
  try {
    const out = await SIMS.inboundRoute(String((req.query && req.query.from) || '').slice(0, 30));
    res.set('Cache-Control', 'no-store');
    return res.type('text').send(out);
  } catch (e) {
    console.error('[browser-call] inbound route:', e.message);
    return res.type('text').send('|'); // nobody: the dialplan hangs up as before
  }
});

module.exports = router;
