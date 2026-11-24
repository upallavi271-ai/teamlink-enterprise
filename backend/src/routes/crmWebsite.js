// ---------------------------------------------------------------------------
// POST /api/crm/leads/public - a lead from the company's website (founder 2026-11-06). No login: the API key from CRM settings is the pass, in the x-api-key header or as
// api_key in the form. Any website may post here, so this has its own open CORS and is mounted before the app's own (index.js). At most 30 tries an hour from one address.
// JSON or a plain HTML form. crm/sales.js capture() does the rest.
// ---------------------------------------------------------------------------
const express = require('express');

const router = express.Router();
const LIMIT = 30;
const HOUR = 3600000;
const seen = new Map(); // ip -> { n, at }

function limited(ip) {
  const now = Date.now();
  if (seen.size > 5000) seen.clear();
  const e = seen.get(ip);
  if (!e || now - e.at > HOUR) { seen.set(ip, { n: 1, at: now }); return false; }
  e.n += 1;
  return e.n > LIMIT;
}

router.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});
router.post('/', express.json({ limit: '32kb' }), express.urlencoded({ extended: false, limit: '32kb' }), async (req, res, next) => {
  try {
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    if (limited(ip)) return res.status(429).json({ error: 'Too many tries. Please try again later.' });
    const out = await require('../crm/sales').capture(req.body || {}, req.get('x-api-key')); // eslint-disable-line global-require
    // the form sent consent=1 (the person ticked "I agree" under the privacy notice): a DPDP consent record on the new lead (crm/consent.js)
    if (out.status === 200 && out.body && out.body.id) await require('../crm/consent').fromWebsite(out.body, req.body || {}, ip).catch(() => null); // eslint-disable-line global-require
    return res.status(out.status).json(out.body);
  } catch (e) { return next(e); }
});

module.exports = router;
