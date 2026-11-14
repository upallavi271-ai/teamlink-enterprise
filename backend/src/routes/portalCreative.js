// ---------------------------------------------------------------------------
// /api/portal/client/creative : AI Marketing inside the CLIENT PORTAL (2026-11-14). A client person signs in to TeamLink (their own login), opens "Creative work", sees the videos / pictures
// TeamLink made for THEIR company, chooses the one they like (that choice is the approval) and starts a new creative request from their own account.
//   GET  /    the projects of the signed-in company, each with its private page token (handed out only here, only to a login of that company)
//   POST /    start a new request (opens the same request form as the private link); a request started and not sent is reused
// The page the client works in is components/omni/marketing/ClientProjectPage.jsx, which talks to the token-keyed public routes (routes/mkProjectPublic.js).
// Behind login (requireAuth) + the client wall (utils/externalPortalAuth.js allows /api/portal/client/*) + the "Approve our creative work and send us requests" tick.
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const CT = require('../utils/clientPortalTypes');
const P = require('../marketing/projects');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const send = (res, out) => (out && out.error ? res.status(out.status || 400).json({ error: out.error }) : res.json(out));
const guard = (req, res, next) => {
  const u = req.user;
  if (!u || !(u.role === 'CLIENT' || u.atsRole === 'CLIENT') || !u.clientId) return res.status(403).json({ error: 'This is for client logins.' });
  if (!CT.hasCap(u, 'CREATIVE')) return res.status(403).json({ error: 'Creative work is not part of your access yet: ask your TeamLink contact to add it.' });
  return next();
};
router.use((req, res, next) => { res.set({ 'Cache-Control': 'no-store' }); next(); });
router.get('/', requireAuth, guard, wrap(async (req, res) => send(res, await P.portalList(req.user))));
router.post('/', requireAuth, guard, wrap(async (req, res) => send(res, await P.portalStart(req.user))));

module.exports = router;
