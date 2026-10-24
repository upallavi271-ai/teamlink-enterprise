// ---------------------------------------------------------------------------
// /api/outreach (EARLY part, structure plan 2026-10-17): the answers that must work BEFORE the "ATS product + may use Omni-Channel" gate of
// routes/outreach.js, because Finance (Accounts) has no ATS product but may open Insights > Credits:
//   GET  /me                       who am I here: level, hubs, departments, credits (the one answer the whole screen is drawn from)
//   GET  /insights/credits         usage, consumption, recharges, cost (Admin and Finance)
//   POST /insights/credits/recharge  a manual recharge entry (Admin only)
// Every other route keeps the normal gate. Warms the Marketing list for the access helper on every request.
// ---------------------------------------------------------------------------
const express = require('express');
const A = require('../outreach/access');
const Cr = require('../outreach/credits');
const Ins = require('../outreach/insights');
const Chrome = require('../outreach/chrome');

const router = express.Router();
const wrap = (fn) => async (req, res, next) => { try { await fn(req, res, next); } catch (e) { next(e); } };
router.use(wrap(async (req, res, next) => { await A.warm(); next(); }));

router.get('/me', wrap(async (req, res) => {
  const base = A.me(req.user);
  if (base.level === 'none') return res.status(403).json({ error: 'Omni-Channel is for the recruitment team, HR, Accounts (credits) and Admins.' });
  const month = Cr.thisMonth();
  let credits = null;
  try {
    await Cr.ensureTables();
    const st = await Cr.settings();
    const p = await Cr.personOf(req.user.id);
    const exempt = Cr.isExempt(st, p);
    const allowance = exempt ? null : await Cr.allowanceOf(st, req.user.id);
    const used = await Cr.usedBy(req.user.id, month);
    credits = { month, exempt, allowance, used, left: exempt ? null : Math.max(0, allowance - used), enforce: st.enforce };
  } catch { credits = null; }
  return res.json({ ...base, credits });
}));
// the prototype's top bar and sidebar numbers (read only): credits pill, workspace (department) switcher, unread / approval badges
const needUse = (req, res) => { if (A.level(req.user) === 'none') { res.status(403).json({ error: 'Omni-Channel is for the recruitment team, HR, Accounts (credits) and Admins.' }); return false; } return true; };
router.get('/wallet', wrap(async (req, res) => { if (!needUse(req, res)) return undefined; return res.json(await Chrome.wallet(req.user)); }));
router.get('/workspaces', wrap(async (req, res) => { if (!needUse(req, res)) return undefined; return res.json(await Chrome.workspaces(req.user)); }));
router.get('/badges', wrap(async (req, res) => { if (!needUse(req, res)) return undefined; return res.json(await Chrome.badges(req.user)); }));
router.get('/insights/credits', wrap(async (req, res) => {
  if (!A.mayCreditsView(req.user)) return res.status(403).json({ error: 'Credits and cost are for Admins and Accounts.' });
  return res.json(await Ins.usage(req.query.month));
}));
router.post('/insights/credits/recharge', wrap(async (req, res) => {
  if (!A.isAdmin(req.user)) return res.status(403).json({ error: 'Only an Admin can add a recharge.' });
  const out = await Ins.addRecharge(req.user, req.body || {});
  return out.error ? res.status(out.status || 400).json({ error: out.error }) : res.json(out);
}));

// Administration (Green Start rebuild): Billing for everybody incl. Finance, and the organisation modal (routes/omniGsAdminEarly.js). A load problem only loses these.
try { router.use(require('./omniGsAdminEarly')); } catch (e) { console.error('[omni-gs] admin early routes not loaded:', e.message); } // eslint-disable-line global-require, no-console

module.exports = router;
