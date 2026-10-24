// ---------------------------------------------------------------------------
// /api/omni-gs : the small TeamLink side of Green Start (utils/greenStartEmbed.js; Green Start itself lives in green-start-app/).
//   GET  /status   per-part state (database, Redis, server, worker, entrance) and the state words, from utils/greenStartSupervisor.js
//   POST /start /stop /restart /backup, GET /log   Admin / Super Admin only, rate limited, each press is an audit row
//   POST /session  signs this browser in to the Green Start gate (one signed HttpOnly cookie, 2 hours).
// Needs a normal TeamLink login AND the Omni-Channel permission AND a role that may see real contact details (outreach/access.js mayGreenStart).
// Reads nothing from the TeamLink database; the only write is the audit row of an Admin's button press. (GET /verify, used by the gate, is answered in utils/greenStartEmbed.js proxy(), ahead of this.)
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const A = require('../outreach/access');
const G = require('../utils/greenStartEmbed');
const Sup = require('../utils/greenStartSupervisor');
const { makeLimiter } = require('../utils/apiRateLimit');
const { logAudit } = require('../utils/audit');
const clientIp = require('../utils/clientIp');

const router = express.Router();
router.use(requireAuth);
router.use(async (req, res, next) => {
  try { await A.warm(); } catch { /* keep the last list */ }
  if (!A.mayGreenStart(req.user)) return res.status(403).json({ error: 'Green Start is for Admin, Manager, Team Lead and HR logins.' });
  return next();
});

router.get('/status', async (req, res) => {
  try {
    const st = await G.status();
    res.set('Cache-Control', 'no-store').json({ ...st, canControl: A.isAdmin(req.user) });
  } catch { res.status(500).json({ error: 'Could not check Green Start.' }); }
});

// ---- Admin / Super Admin only: Start, Stop, Restart, Show log, Backup now ------------------------------------------------------------
// Rate limited (GREENSTART_CONTROL_RATE per minute per login, default 6) and every press is written to the audit trail.
const limiter = makeLimiter({ userMax: Number(process.env.GREENSTART_CONTROL_RATE) || 6, windowMs: 60000 });
const adminOnly = (req, res, next) => (A.isAdmin(req.user) ? next() : res.status(403).json({ error: 'Only an Admin or Super Admin can do this.' }));
function limited(req, res, next) {
  const over = limiter.check({ method: req.method, path: '/omni-gs-control', userId: String(req.user.id || 'u'), ip: clientIp.ipOf(req) });
  if (!over) return next();
  res.set('Retry-After', String(over.retryAfter));
  return res.status(429).json({ error: `Too many button presses. Please wait ${over.retryAfter} second${over.retryAfter === 1 ? '' : 's'}.`, retryAfter: over.retryAfter });
}
const WORDS = { start: 'Start', stop: 'Stop', restart: 'Restart', backup: 'Backup now' };
Object.keys(WORDS).forEach((action) => {
  router.post(`/${action}`, adminOnly, limited, async (req, res) => {
    let r;
    try { r = await Sup.control(action); } catch (e) { r = { ok: false, error: 'Something went wrong.' }; }
    await logAudit({
      userId: req.user.id, actorName: req.user.name, action: `Green Start: ${WORDS[action]}`, entity: 'GreenStart', entityId: 'supervisor',
      toValue: r.ok ? (r.message || r.file || 'done') : String(r.error || 'refused').slice(0, 200),
    });
    return res.status(r.ok ? 200 : 409).set('Cache-Control', 'no-store').json(r);
  });
});
router.get('/log', adminOnly, limited, (req, res) => {
  const part = String(req.query.part || 'supervisor').toLowerCase();
  const out = Sup.readLog(part, Number(req.query.lines) || 80);
  if (out.error) return res.status(400).json({ error: out.error });
  return res.set('Cache-Control', 'no-store').json(out); // lines are scrubbed: no emails, tokens, passwords, keys
});

router.post('/session', (req, res) => {
  if (!G.enabled()) return res.status(404).json({ error: 'Green Start is switched off on this server (GREENSTART_ENABLED).' });
  G.issueCookies(req, res, String(req.user.id || req.user.userId || 'u').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'u');
  return res.set('Cache-Control', 'no-store').json({ ok: true, port: G.gatePort() });
});

module.exports = router;
