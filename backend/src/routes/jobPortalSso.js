// /api/sso/job-portal: open the Job Portal already signed in with the TeamLink login (utils/jobPortalSso.js has the whole picture).
const express = require('express');
const jwt = require('jsonwebtoken');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const sso = require('../utils/jobPortalSso');

const router = express.Router();
const NEXT_RE = /^#\/(recruiter|admin)(\/[A-Za-z0-9_\-/]*)?(\?[A-Za-z0-9_\-=&%.+]*)?$/;

// Server to server, from the portal: is the TeamLink sign-in behind this portal session still good?
router.post('/session', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const c = sso.verify(req.body && req.body.token, sso.AUD_FROM_PORTAL);
  if (!c || !c.sid) return res.status(401).json({ error: 'Not a valid Job Portal request.' });
  const active = await sso.signInIsLive(c.sid);
  // TeamLink does not track clicks: a live sign-in counts as active now, so the portal ends its session with the TeamLink sign-in.
  return res.json(active ? { active: true, lastSeenAt: new Date().toISOString() } : { active: false });
});
// The portal logged out. TeamLink sign-ins live in the browser: nothing to end here.
router.post('/logout', (req, res) => {
  const c = sso.verify(req.body && req.body.token, sso.AUD_FROM_PORTAL);
  if (!c) return res.status(401).json({ error: 'Not a valid Job Portal request.' });
  return res.json({ ok: true });
});

router.use(requireAuth);

const claimsOf = (req) => {
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') ? jwt.decode(h.slice(7)) || {} : {}; // already verified by requireAuth
};

router.post('/launch', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const claims = claimsOf(req);
  if (claims.viewAs || claims.actAs) return res.status(403).json({ error: 'The Job Portal opens only for your own login, not while viewing as someone else.', code: 'NO_ACCESS' });
  if (!sso.portalRoleOf(req.user)) return res.status(403).json({ error: 'The Job Portal staff pages are for Admins, Recruiters and TLs.', code: 'NO_ACCESS' });
  if (!req.user.email) return res.status(409).json({ error: 'Your login has no email address, and the Job Portal finds your account by email.', code: 'NO_EMAIL' });
  if (!sso.secret()) return res.status(503).json({ error: 'Opening the Job Portal from TeamLink is not set up on this server.' });
  const next = NEXT_RE.test(String((req.body && req.body.next) || '')) ? req.body.next : '';
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Opened the Job Portal (signed in from TeamLink)', entity: 'JobPortal' }).catch(() => {});
  const token = sso.launchToken(req.user, claims);
  return res.json({ url: `/jobs/hrms-sso.html#token=${encodeURIComponent(token)}${next ? `&next=${encodeURIComponent(next)}` : ''}` });
});

// TeamLink Sign Out: the portal ends the sessions it opened for this sign-in.
router.post('/signout', async (req, res) => {
  const ok = await sso.tellPortalSignedOut(sso.sidOf(req.user, claimsOf(req)));
  res.json({ ok });
});

module.exports = router;
