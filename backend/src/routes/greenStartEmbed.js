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

// ---- OPEN GREEN START WITHOUT ITS LOGIN PAGE (founder 2026-10-26: "login page remove cheyyu, direct ga omnichannel open cheyyi";
// asked, he chose ONE company account for everybody) ------------------------------------------------------------------------
// Green Start's own one-click sign-in from TeamLink (green-start-app/docs/integrations/TEAMLINK_SSO.md): a signed, single-use,
// 60-second ticket for the company's Green Start account. Needs GREENSTART_SSO_SECRET here (the same value as Green Start's
// TEAMLINK_SSO_SECRET) and the company account's email (Admin sets it below; GREENSTART_SSO_EMAIL as the default). Missing either
// = the frame shows Green Start's own login page, exactly as before. Every open is an audit row with who opened it.
const prisma = require('../db');
const { SSO_EMAIL_KEY, EMAIL_RE, ssoEmail, greenStartTicket } = require('../utils/greenStartSso');

router.post('/sso-ticket', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const secret = String(process.env.GREENSTART_SSO_SECRET || '');
  if (secret.length < 32) return res.json({ ticket: null, reason: 'One-click sign-in is not set up on this server (GREENSTART_SSO_SECRET).' });
  const email = await ssoEmail();
  if (!EMAIL_RE.test(email)) return res.json({ ticket: null, reason: 'An Admin has not picked the company Green Start account yet (Omni-Channel → Manage).' });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Opened Omni-Channel (Green Start) with the company account', entity: 'GreenStart', toValue: email }).catch(() => {});
  return res.json({ ticket: greenStartTicket({ email, name: 'TeamLink', externalUserId: req.user.id }), next: '/app' });
});
router.get('/sso-settings', adminOnly, async (req, res) => {
  res.json({ email: await ssoEmail(), secretSet: String(process.env.GREENSTART_SSO_SECRET || '').length >= 32 });
});
router.put('/sso-settings', adminOnly, async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: 'That is not an email address.' });
  const value = JSON.stringify(email);
  await prisma.appSetting.upsert({ where: { key: SSO_EMAIL_KEY }, create: { key: SSO_EMAIL_KEY, value }, update: { value } });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Omni-Channel company Green Start account set', entity: 'AppSetting', entityId: SSO_EMAIL_KEY, toValue: email || '(none - login page)' });
  res.json({ email });
});

router.post('/session', (req, res) => {
  if (!G.enabled()) return res.status(404).json({ error: 'Green Start is switched off on this server (GREENSTART_ENABLED).' });
  G.issueCookies(req, res, String(req.user.id || req.user.userId || 'u').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'u');
  return res.set('Cache-Control', 'no-store').json({ ok: true, port: G.gatePort() });
});

module.exports = router;
