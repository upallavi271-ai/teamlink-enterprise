// ---------------------------------------------------------------------------
// OMNI-CHANNEL v3 > BOTS (Bot Builder + WhatsApp Bot Data), mounted at /api/outreach/gs/bots.  The engine is outreach/bots.js (read its header for
// exactly when a bot can send for real). Nothing in this file sends a message.
//   GET    /flows                    the flows (with this month's numbers) + the live state
//   POST   /flows   PUT /flows/:id   make / change a flow          POST /flows/:id/on  /off       DELETE /flows/:id
//   POST   /flows/:id/try            try a message on a flow (nothing is sent, nothing is logged)
//   GET    /data                     WhatsApp Bot Data: the three numbers, the trigger table, recent sessions, people waiting for a person
//   GET    /switch   PUT /switch     the Admin switch "Bot auto-replies" (default OFF)
// ---------------------------------------------------------------------------
const express = require('express');
const A = require('../outreach/access');
const Bots = require('../outreach/bots');
const Chrome = require('../outreach/chrome');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const send = (res, out) => (out && out.error ? res.status(out.status || 400).json({ error: out.error }) : res.json(out));

router.use((req, res, next) => (Bots.seesBots(req.user) ? next() : res.status(403).json({ error: 'The bot is not for your login.' })));

router.get('/flows', wrap(async (req, res) => {
  const dept = Chrome.deptOf(req.user, req.query.dept);
  if (dept === null) return res.json({ flows: [], canManage: Bots.mayManage(req.user), state: await Bots.liveState(), canSwitch: A.isAdmin(req.user) });
  return send(res, await Bots.list(req.user, dept));
}));
router.post('/flows', wrap(async (req, res) => send(res, await Bots.save(req.user, null, req.body || {}))));
router.put('/flows/:id', wrap(async (req, res) => send(res, await Bots.save(req.user, req.params.id, req.body || {}))));
router.post('/flows/:id/on', wrap(async (req, res) => send(res, await Bots.toggle(req.user, req.params.id, true))));
router.post('/flows/:id/off', wrap(async (req, res) => send(res, await Bots.toggle(req.user, req.params.id, false))));
router.post('/flows/:id/try', wrap(async (req, res) => send(res, await Bots.simulate(req.user, req.params.id, (req.body || {}).text))));
router.delete('/flows/:id', wrap(async (req, res) => send(res, await Bots.remove(req.user, req.params.id))));

router.get('/data', wrap(async (req, res) => {
  const dept = Chrome.deptOf(req.user, req.query.dept);
  if (dept === null) return res.json({ state: await Bots.liveState(), canSwitch: A.isAdmin(req.user), canManage: Bots.mayManage(req.user), kpis: { handled: 0, resolvedPct: null, handoffPct: null, rehearsed: 0 }, rules: [], sessions: [], waiting: [] });
  return send(res, await Bots.data(req.user, dept));
}));

router.get('/switch', wrap(async (req, res) => res.json({ ...(await Bots.getSwitch()), canSwitch: A.isAdmin(req.user), state: await Bots.liveState() })));
router.put('/switch', wrap(async (req, res) => {
  const out = await Bots.setSwitch(req.user, (req.body || {}).enabled === true);
  if (out.error) return send(res, out);
  return res.json({ ...out, state: await Bots.liveState() });
}));

router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[omni-gs-bots]', err && err.message); // eslint-disable-line no-console
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

module.exports = router;
