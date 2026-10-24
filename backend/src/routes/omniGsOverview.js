// ---------------------------------------------------------------------------
// /api/outreach/gs/overview : the Omni-Channel DASHBOARD (Green Start "Command center") and the "How it works" strip. Read only.
// Mounted by routes/outreach.js behind login + "may use Omni-Channel". Every number is held to what this login may see and to ?dept=.
//   GET  /                          the dashboard: KPI cards, chart, channel health, recent campaigns, insights, popup details   (?range=30d|7d|year)
//   GET  /flow                      the 10-step strip with a real count and hint per step
//   GET  /responses?campaignId=     the numbers behind a campaign's "Responses" popup
//   POST /insights/:key/dismiss     hide one insight for 7 days (this person only)
// ---------------------------------------------------------------------------
const express = require('express');
const A = require('../outreach/access');
const Chrome = require('../outreach/chrome');
const Ov = require('../outreach/overview');
const Flow = require('../outreach/flow');

const router = express.Router();
const wrap = (fn) => async (req, res, next) => { try { await fn(req, res, next); } catch (e) { next(e); } };
const deny = (res, why) => res.status(403).json({ error: why });
const send = (res, out) => (out && out.error ? res.status(out.status || 400).json({ error: out.error }) : res.json(out));
router.use((req, res, next) => (A.hubsFor(req.user).dashboard ? next() : deny(res, 'There is no dashboard for your login.')));

router.get('/', wrap(async (req, res) => {
  const dept = Chrome.deptOf(req.user, req.query.dept); // '' = all, a name, or null = not allowed (shown as nothing)
  res.json(await Ov.command(req.user, { range: String(req.query.range || '30d'), dept }));
}));
router.get('/flow', wrap(async (req, res) => {
  const dept = Chrome.deptOf(req.user, req.query.dept);
  res.json(await Flow.flow(req.user, { dept }));
}));
router.get('/responses', wrap(async (req, res) => send(res, await Ov.responsesFor(req.user, String(req.query.campaignId || '')))));
router.post('/insights/:key/dismiss', wrap(async (req, res) => send(res, await Ov.dismissInsight(req.user, req.params.key))));

module.exports = router;
