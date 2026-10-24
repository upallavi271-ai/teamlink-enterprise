// ---------------------------------------------------------------------------
// ADMINISTRATION, the part that must work BEFORE the "ATS product + may use Omni-Channel" gate (Finance / Accounts has no ATS product but opens
// Billing, and the top-bar organisation modal is drawn for everybody who may open Omni-Channel at all). Mounted in routes/outreachEarly.js (so these
// paths are /api/outreach/billing/... and /api/outreach/org/...) and again in omniGsAdmin.js (so /api/outreach/gs/admin/billing/... works too).
//   GET  /billing/summary?month=      "Your credits" for everyone but Finance; the company view (usage, balance, recharges, rules) for Admin and Finance
//   GET  /billing/usage.csv?month=    Admin and Finance (audited)
//   GET  /org/overview                the Organization Workspace modal rows (the departments this login may open)
//   POST /org                         Create Organization (Admin): a department NAME added to the Omni-Channel list
// ---------------------------------------------------------------------------
const express = require('express');
const A = require('../outreach/access');
const Ad = require('../outreach/adminApi');

const router = express.Router();
const wrap = (fn) => async (req, res, next) => { try { await fn(req, res, next); } catch (e) { next(e); } };
const gate = (req, res, next) => (A.level(req.user) === 'none' ? res.status(403).json({ error: 'Omni-Channel is for the recruitment team, HR, Accounts (credits) and Admins.' }) : next());
const send = (res, out) => (out && out.error ? res.status(out.status || 400).json({ error: out.error }) : res.json(out));

router.get('/billing/summary', gate, wrap(async (req, res) => res.json(await Ad.billing(req.user, req.query.month))));
router.get('/billing/usage.csv', gate, wrap(async (req, res) => {
  if (!A.mayCreditsView(req.user)) return res.status(403).json({ error: 'Credits and cost are for Admins and Accounts.' });
  const out = await Ad.usageCsv(req.user, req.query.month);
  res.set('Content-Disposition', `attachment; filename="omni-usage-${out.month}.csv"`);
  res.type('text/csv; charset=utf-8');
  return res.send(out.csv);
}));
router.get('/org/overview', gate, wrap(async (req, res) => res.json(await Ad.orgOverview(req.user, req.query.month))));
router.post('/org', gate, wrap(async (req, res) => send(res, await Ad.createOrg(req.user, (req.body || {}).name))));

module.exports = router;
