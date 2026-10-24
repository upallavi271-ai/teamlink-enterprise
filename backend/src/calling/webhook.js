// ---------------------------------------------------------------------------
// /api/webhooks/exotel-ai/*  - Exotel (and the speech service) CALL US here. Public, no login: each request proves itself.
//
//   POST|GET /status                      Exotel's call status callback.
//        proof: ?key=<webhook secret>  OR  header X-TeamLink-Signature = hex HMAC-SHA256(raw body, webhook secret)
//               (+ optional X-TeamLink-Timestamp, older than 10 minutes = replay), and, when the Admin saved IP addresses, the
//               sender must be one of them. Wrong / missing proof -> 401, nothing stored.
//        A repeat of the same event is ignored; an older status never undoes a newer one; an unknown call is stored, not applied.
//   POST /voicebot/:token/turn            the words the candidate said (text) -> the next sentence. token = signed per call.
//
// Mounted BEFORE the general /api/webhooks router (index.js). Brings its own body parser to keep the raw bytes for the HMAC.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const express = require('express');
const X = require('./exotelConfig');
const settingsStore = require('./settings');
const svc = require('./callService');
const voicebot = require('./voicebot');

const router = express.Router();
const keep = (req, _res, buf) => { req.rawBody = buf; };
router.use(express.json({ limit: '256kb', verify: keep }));
router.use(express.urlencoded({ extended: false, limit: '256kb', verify: keep }));

const safeEq = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};
const ipOf = (req) => String(req.ip || (req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');

// returns null when the request proves itself, else a short reason (never the secret)
async function proof(req) {
  const s = await settingsStore.load();
  if (!s.hook) return 'The webhook is not set up (no webhook secret saved).';
  if (s.hookIps.length && !s.hookIps.includes(ipOf(req))) return 'This sender is not on the allowed address list.';
  const sig = req.get(X.WEBHOOK.signatureHeader);
  if (sig) {
    const want = crypto.createHmac('sha256', s.hook).update(req.rawBody || Buffer.from('')).digest('hex');
    if (!safeEq(sig, want)) return 'Bad signature.';
    const ts = Number(req.get(X.WEBHOOK.timestampHeader));
    if (Number.isFinite(ts) && ts > 0 && Math.abs(Date.now() / 1000 - ts) > X.WEBHOOK.maxAgeSeconds) return 'The request is too old.';
    return null;
  }
  if (safeEq(req.query[X.WEBHOOK.keyParam], s.hook)) return null;
  return 'Bad key.';
}

router.all('/status', async (req, res) => {
  try {
    const bad = await proof(req);
    if (bad) return res.status(401).json({ error: 'Not allowed' });
    const body = req.method === 'GET' ? req.query : req.body;
    const items = (Array.isArray(body) ? body : [body]).filter((x) => x && typeof x === 'object').slice(0, 20);
    const out = [];
    for (const it of items) out.push(await svc.applyProviderEvent(it)); // eslint-disable-line no-await-in-loop
    return res.status(200).json({ ok: true, results: out.map((o) => ({ duplicate: !!o.duplicate, unknown: !!o.unknown, ignored: o.ignored || null, applied: o.applied || null })) });
  } catch (err) {
    console.error('[ai-calling] webhook:', err && err.message); // eslint-disable-line no-console
    return res.status(200).json({ ok: true }); // never make Exotel retry a bug of ours for ever
  }
});

router.post('/voicebot/:token/turn', async (req, res) => {
  try {
    const out = await voicebot.handleTurn(req.params.token, req.body);
    return res.status(out.status).json(out.body);
  } catch (err) {
    console.error('[ai-calling] voicebot turn:', err && err.message); // eslint-disable-line no-console
    return res.status(500).json({ error: 'Something went wrong' });
  }
});

module.exports = router;
