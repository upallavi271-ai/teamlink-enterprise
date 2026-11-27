// ---------------------------------------------------------------------------
// /api/portal/client/posts : AI MARKETING for a CLIENT LOGIN on the phone (2026-11-25). The signed-in client person sees the posts TeamLink made for THEIR company, approves or rejects each one,
// and reads which social accounts TeamLink manages for them (read only). Everything is a thin door onto marketing/clientReview.js (the same approval the private link and the WhatsApp buttons
// use), see marketing/clientPhone.js.
//   GET  /            the posts waiting for the client, and the ones already answered / posted
//   GET  /accounts    the company's social accounts and what is waiting / posting / posted on each
//   GET  /dashboard?month=YYYY-MM   the dashboard: numbers, posts by platform and by day, the plan and what is delivered, the accounts, what waits for the client
//   GET  /leads?month=YYYY-MM   the company's own enquiries, only where the team switched that on (marketing/clientLeads.js)
//   GET  /:id         one post: the picture / video / words, the accounts and exact words it will be posted with
//   POST /:id/decision  { decision: 'approve' | 'reject', comment, allowPosting, planKey }   a rejection needs a reason; the name is the login's own
// Behind login (requireAuth) + the client wall (utils/externalPortalAuth.js allows /api/portal/client/*) + the "Approve our creative work" tick, and ONLY the login's own company's rows.
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const CT = require('../utils/clientPortalTypes');
const Phone = require('../marketing/clientPhone');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const send = (res, out) => (out && out.error ? res.status(out.status || 400).json({ error: out.error }) : res.json(out));
const guard = (req, res, next) => {
  const u = req.user;
  if (!Phone.isClientUser(u)) return res.status(403).json({ error: 'This is for client logins.' });
  if (!CT.hasCap(u, 'CREATIVE')) return res.status(403).json({ error: 'Social media posts are not part of your access yet: ask your TeamLink contact to add them.' });
  return next();
};
router.use((req, res, next) => { res.set({ 'Cache-Control': 'no-store' }); next(); });
router.use(requireAuth, guard);
router.get('/', wrap(async (req, res) => send(res, await Phone.list(req.user))));
router.get('/accounts', wrap(async (req, res) => send(res, await Phone.accounts(req.user))));
router.get('/dashboard', wrap(async (req, res) => send(res, await Phone.dashboard(req.user, req.query.month)))); // the client's dashboard for one month (2026-11-25)
router.get('/leads', wrap(async (req, res) => {
  const company = await Phone.companyOf(req.user);
  if (!company) return res.status(404).json({ error: 'Your company record was not found: contact TeamLink.' });
  return send(res, await require('../marketing/clientLeads').forClientLogin(company, req.query.month)); // eslint-disable-line global-require
}));
router.get('/:id', wrap(async (req, res) => send(res, await Phone.view(req.user, req.params.id))));
router.post('/:id/decision', wrap(async (req, res) => send(res, await Phone.decide(req.user, req.params.id, req.body || {}))));
router.post('/:id/allow-posting', wrap(async (req, res) => send(res, await Phone.allowPosting(req.user, req.params.id, req.body || {}))));

module.exports = router;
