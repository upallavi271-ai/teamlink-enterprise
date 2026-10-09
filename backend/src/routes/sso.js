// ---------------------------------------------------------------------------
// /api/sso — single sign-on to the TeamLink Job Portal (utils/jobPortalSso.js).
//
//   POST /api/sso/job-portal/launch    signed in: { next? } -> { url } — the
//                                      portal address with a 60-second,
//                                      single-use token in its fragment.
//                                      403 { code: 'JOB_PORTAL_DENIED' } for a
//                                      role without Job Portal access.
//   POST /api/sso/job-portal/session   the PORTAL, server to server: is this
//                                      sign-in still alive? { token } signed
//                                      with the shared secret, carrying sid and
//                                      the user's last activity in the portal.
//   POST /api/sso/job-portal/logout    the PORTAL, server to server: the user
//                                      signed out there — end this sign-in.
//
// Tokens are never logged or echoed. The launch is not audited here: the
// portal writes "Login (via HRMS)" in its own audit log, once per sign-in.
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const sessions = require('../utils/authSessions');
const sso = require('../utils/jobPortalSso');

const router = express.Router();

// A small fixed-window limit for the two server-to-server doors.
const hits = new Map();
function limited(req, res, next) {
  const key = req.ip || 'x';
  const now = Date.now();
  const h = hits.get(key);
  if (!h || now - h.at > 60000) { hits.set(key, { at: now, n: 1 }); return next(); }
  h.n += 1;
  if (h.n > 600) return res.status(429).json({ error: 'Too many requests' });
  if (hits.size > 5000) hits.clear();
  return next();
}

router.post('/job-portal/launch', requireAuth, async (req, res) => {
  if (req.viewAs) {
    return res.status(403).json({ error: 'Exit View as to open the Job Portal.', code: 'JOB_PORTAL_DENIED' });
  }
  if (!sso.configured()) {
    return res.status(503).json({ error: 'Opening the Job Portal from HRMS is not set up on this server.', code: 'JOB_PORTAL_NOT_CONFIGURED' });
  }
  if (!sso.jobPortalRoleFor(req.user)) {
    return res.status(403).json({ error: 'Your role does not include access to the Job Portal.', code: 'JOB_PORTAL_DENIED' });
  }
  // A token from before sign-in sessions existed has no sid: sign in again.
  if (!req.authSid) {
    return res.status(401).json({ error: 'Please sign in again to open the Job Portal.', code: 'SESSION_EXPIRED' });
  }
  const url = sso.launchUrl(req.user, req.authSid, req.body && req.body.next);
  res.set('Cache-Control', 'no-store');
  return res.json({ url });
});

router.post('/job-portal/session', limited, async (req, res, next) => {
  let claims;
  try { claims = sso.verifyFromPortal(req.body && req.body.token); } catch {
    return res.status(401).json({ error: 'Not a valid Job Portal request' });
  }
  try {
    const at = claims.lastActiveAt ? Date.parse(claims.lastActiveAt) : NaN;
    const r = await sessions.partnerCheck(claims.sid, at);
    return res.json(r.active ? { active: true, lastSeenAt: r.lastSeenAt } : { active: false });
  } catch (err) { return next(err); }
});

router.post('/job-portal/logout', limited, async (req, res, next) => {
  let claims;
  try { claims = sso.verifyFromPortal(req.body && req.body.token); } catch {
    return res.status(401).json({ error: 'Not a valid Job Portal request' });
  }
  try {
    const ended = await sessions.revoke(claims.sid, 'signed out of the Job Portal');
    return res.json({ ok: true, ended });
  } catch (err) { return next(err); }
});

module.exports = router;
