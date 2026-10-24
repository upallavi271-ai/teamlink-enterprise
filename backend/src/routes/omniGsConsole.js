// ---------------------------------------------------------------------------
// /api/outreach/gs/console : the COMMUNICATION CONSOLE (Green Start "Direct send"). Mounted by routes/outreach.js behind login + "may use Omni-Channel".
// For the BDE team, Team Leads, Marketing, HR (staff only, when an Admin allows) and Admins (outreach/access.js maySendConsole). Every rule is in outreach/consoleSend.js.
//   GET  /options                   accounts, templates, Test mode / quiet hours / daily limit words, who may add new people
//   GET  /contacts                  the CRM Contact Selector (?q ?channel ?type ?agreed ?page ?pageSize)
//   GET  /contact-ids               every id of the people who agreed to this way (select all)
//   POST /csv                       the uploaded file (raw body, ?filename=) kept for a day -> { uploadId, rows, columns }
//   POST /preview                   what WOULD happen for this list (nothing is saved or sent)
//   POST /send                      Send now / Schedule (scheduledAt = India time "YYYY-MM-DDTHH:MM")
//   GET  /runs   /runs/:id          recent sends / one send with its per-person log (a window around the progress for long lists)
//   POST /runs/:id/stop             stop after the current message
//   GET  /runs/:id/log.csv          the log (masked for masked logins)
//   GET  /sample?channel=           a sample file
// NOTHING here sends while Test mode is on: those sends are REHEARSALS (rows written, counted as Test messages, no provider called).
// ---------------------------------------------------------------------------
const express = require('express');
const A = require('../outreach/access');
const Chrome = require('../outreach/chrome');
const CS = require('../outreach/consoleSend');

const router = express.Router();
// a small counter PER ROUTE and per login (channels/rateLimit.js shares one counter between every route, so a busy Preview would use up Send)
const limiter = ({ perMinute = 60 } = {}) => {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now(); const key = (req.user && req.user.id) || req.ip || 'anon';
    const l = (hits.get(key) || []).filter((t) => now - t < 60000);
    if (l.length >= perMinute) { res.setHeader('Retry-After', '30'); return res.status(429).json({ error: 'Too many requests in a minute. Wait a little and try again.' }); }
    l.push(now); hits.set(key, l);
    return next();
  };
};
const wrap = (fn) => async (req, res, next) => { try { await fn(req, res, next); } catch (e) { next(e); } };
const send = (res, out) => (out && out.error ? res.status(out.status || 400).json({ error: out.error, code: out.code || undefined, totals: out.totals || undefined }) : res.json(out));
const raw = express.raw({ type: () => true, limit: '6mb' });

router.use((req, res, next) => (A.maySendConsole(req.user) ? next() : res.status(403).json({ error: 'The Communication Console is for the BDE team, Team Leads, Marketing, HR and Admins.' })));
CS.start(); // the small loop that wakes scheduled sends and works through the rows (does nothing when there is nothing to do)

const deptIn = (req, v) => { const d = Chrome.deptOf(req.user, v === undefined ? req.query.dept : v); return d === null ? '' : d; };

router.get('/options', wrap(async (req, res) => res.json(await CS.options(req.user, deptIn(req)))));
router.get('/contacts', wrap(async (req, res) => send(res, await CS.contacts(req.user, { q: String(req.query.q || '').slice(0, 80), channel: String(req.query.channel || 'whatsapp'), type: req.query.type, agreed: req.query.agreed, page: Number(req.query.page) || 1, pageSize: Number(req.query.pageSize) || 20 }))));
router.get('/contact-ids', wrap(async (req, res) => send(res, await CS.contactIds(req.user, { q: String(req.query.q || '').slice(0, 80), channel: String(req.query.channel || 'whatsapp'), type: req.query.type, agreed: req.query.agreed }))));
router.post('/csv', limiter({ perMinute: 30 }), raw, wrap(async (req, res) => send(res, await CS.uploadCsv(req.user, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), String(req.query.filename || '').slice(0, 120)))));
router.post('/preview', limiter({ perMinute: 120 }), wrap(async (req, res) => send(res, await CS.preview(req.user, req.body || {}))));
router.post('/send', limiter({ perMinute: Number(process.env.OMNI_CONSOLE_SEND_LIMIT) || 20 }), wrap(async (req, res) => send(res, await CS.createRun(req.user, req.body || {}, { dept: deptIn(req, (req.body || {}).dept) }))));
router.get('/runs', wrap(async (req, res) => res.json(await CS.runs(req.user, Number(req.query.limit) || 30))));
router.get('/runs/:id', wrap(async (req, res) => send(res, await CS.getRun(req.user, req.params.id))));
router.post('/runs/:id/stop', wrap(async (req, res) => send(res, await CS.stopRun(req.user, req.params.id))));
router.get('/runs/:id/log.csv', wrap(async (req, res) => {
  const out = await CS.logCsv(req.user, req.params.id);
  if (out.error) return send(res, out);
  res.set('Content-Disposition', `attachment; filename="${out.fileName}"`);
  res.type('text/csv; charset=utf-8');
  return res.send(out.csv);
}));
router.get('/sample', wrap(async (req, res) => {
  const out = CS.sampleCsv(String(req.query.channel || 'whatsapp'));
  res.set('Content-Disposition', `attachment; filename="${out.fileName}"`);
  res.type('text/csv; charset=utf-8');
  res.send(out.csv);
}));

module.exports = router;
