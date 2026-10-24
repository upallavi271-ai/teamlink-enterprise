// ---------------------------------------------------------------------------
// POST /api/public/outreach/webhook/email : delivery / bounce / complaint events from the mail provider (a stub for now).
// No login; the request proves itself with a signature over the RAW body (outreach/webhook.js). Mounted BEFORE the global JSON parser so the
// raw bytes are available. A bad / stale / missing signature is 401 and nothing is read. The same provider event twice is one change.
// ---------------------------------------------------------------------------
const express = require('express');
const { rateLimit } = require('../utils/publicRateLimit');
const W = require('../outreach/webhook');
const S = require('../outreach/store');

const router = express.Router();
const lim = rateLimit({ bucket: 'outreach-webhook', max: 600, windowMs: 60000 });
router.post('/email', lim, express.raw({ type: () => true, limit: '1mb' }), async (req, res, next) => {
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const v = W.verify(req.headers, raw);
    if (!v.ok) return res.status(401).json({ ok: false, error: 'Signature not accepted.' });
    if (!(await S.campaignsReady())) return res.status(503).json({ ok: false, error: 'Not ready.' });
    let body = null;
    try { body = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ ok: false, error: 'Body is not JSON.' }); }
    return res.json({ ok: true, ...(await W.apply(body)) });
  } catch (e) { return next(e); }
});

module.exports = router;
