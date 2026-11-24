// ---------------------------------------------------------------------------
// /api/crm/capture/<source> - leads from outside, no login (crm/plus/leadIn.js does the work). Mounted in index.js BEFORE the site-wide JSON
// parser and CORS: the chat box on the company website posts from another site, and Meta's signature is checked on the raw body.
//   POST /webhook|email|chat|linkedin|google|justdial|indiamart?key=<CRM capture key>   (or the x-api-key header; Google sends google_key)
//   GET  /facebook   Meta's subscribe check (hub.verify_token)      POST /facebook   the lead-ads webhook (X-Hub-Signature-256)
// Every source is OFF until a Sales manager / Admin switches it on (CRM settings > Customise > Lead capture). At most 120 posts an hour
// from one address.
// ---------------------------------------------------------------------------
const express = require('express');

const router = express.Router();
const LIMIT = 120;
const HOUR = 3600000;
const seen = new Map();
function limited(ip) {
  const now = Date.now();
  if (seen.size > 5000) seen.clear();
  const e = seen.get(ip);
  if (!e || now - e.at > HOUR) { seen.set(ip, { n: 1, at: now }); return false; }
  e.n += 1;
  return e.n > LIMIT;
}
const L = () => require('../crm/plus/leadIn'); // eslint-disable-line global-require

router.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  if (req.method === 'POST' && limited(ip)) return res.status(429).json({ error: 'Too many tries. Please try again later.' });
  return next();
});

router.get('/facebook', async (req, res, next) => {
  try { const out = await L().facebookVerify(req.query || {}); return res.status(out.status).type('text/plain').send(out.text); } catch (e) { return next(e); }
});
router.post('/facebook', express.raw({ type: () => true, limit: '256kb' }), async (req, res, next) => {
  try {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    let parsed = {}; try { parsed = JSON.parse(rawBody.toString('utf8') || '{}'); } catch { parsed = {}; }
    const out = await L().facebookLead(rawBody, req.get('x-hub-signature-256'), parsed);
    return res.status(out.status).json(out.body);
  } catch (e) { return next(e); }
});
router.post('/:source', express.json({ limit: '256kb' }), express.urlencoded({ extended: false, limit: '256kb' }), async (req, res, next) => {
  try {
    const out = await L().inbound(String(req.params.source || ''), req.body || {}, req.get('x-api-key') || String(req.query.key || ''));
    // JustDial expects the word RECEIVED back
    if (req.params.source === 'justdial' && out.status === 200) return res.type('text/plain').send('RECEIVED');
    return res.status(out.status).json(out.body);
  } catch (e) { return next(e); }
});

module.exports = router;
