// ---------------------------------------------------------------------------
// /api/bi/v1/<feed>.json | .csv - the read-only BI feed (utils/insights/bi.js). No login: an Admin-made API key
// (X-API-Key header, Bearer, or ?key=). Rate limited per key, never cached, no candidate contact data.
// ---------------------------------------------------------------------------
const express = require('express');
const BI = require('../utils/insights/bi');
const { toCsv } = require('../utils/tabularExport');

const router = express.Router();
router.get('/v1', (req, res) => res.json({
  feeds: BI.FEEDS.map((f) => ({ feed: f, json: `/api/bi/v1/${f}.json`, csv: `/api/bi/v1/${f}.csv` })),
  auth: 'X-API-Key header, or ?key=',
  limit: `${BI.LIMIT} calls an hour per key`,
}));
router.get('/v1/:feed', async (req, res, next) => {
  try {
    const m = /^([a-z]+)(?:\.(json|csv))?$/.exec(String(req.params.feed || ''));
    if (!m || !BI.FEEDS.includes(m[1])) return res.status(404).json({ error: `Unknown feed. Use one of: ${BI.FEEDS.join(', ')}.` });
    const ok = await BI.check(req);
    res.setHeader('Cache-Control', 'no-store');
    if (ok.error) {
      if (ok.retry) res.setHeader('Retry-After', String(ok.retry));
      return res.status(ok.status).json({ error: ok.error });
    }
    if (!ok.feeds.includes(m[1])) return res.status(403).json({ error: 'This key is not allowed to read that feed.' });
    const data = await BI.feed(m[1]);
    if (m[2] === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `inline; filename="teamlink-${m[1]}.csv"`);
      return res.send(`﻿${toCsv(data.headers, data.rows)}`);
    }
    return res.json({
      feed: m[1], generatedAt: new Date().toISOString(), count: data.rows.length,
      rows: data.rows.map((r) => Object.fromEntries(data.headers.map((h, i) => [h, r[i]]))),
    });
  } catch (e) { return next(e); }
});
module.exports = router;
