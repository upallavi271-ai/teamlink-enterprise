// ---------------------------------------------------------------------------
// PHONE ALERTS — the person's own switch (utils/webPush.js has the how and the why).
//
//   GET  /api/push/config        { supported, publicKey, devices }   what this browser needs to subscribe, and how many of MY phones are on
//   POST /api/push/subscribe     { subscription }                    switch alerts on for this phone
//   POST /api/push/unsubscribe   { endpoint }                        switch them off (also called on sign-out)
//   POST /api/push/test                                              send MYSELF one test alert
//
// Only the person themselves can do any of this: a "View as" / "Act as" session is refused, so an admin looking at somebody's account can
// never register their own phone on that person's alerts (or the other way round).
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const push = require('../utils/webPush');

const router = express.Router();
router.use(requireAuth);

const notYou = (req, res, next) => {
  if (req.viewAs || req.actingAs) return res.status(403).json({ error: 'Phone alerts can only be switched on or off by the person themselves, not while viewing or acting as them.' });
  return next();
};

router.get('/config', async (req, res, next) => {
  try {
    const key = push.available() ? await push.publicKey() : null;
    res.json({ supported: !!key, publicKey: key, devices: key ? await push.devicesOf(req.user.id) : 0 });
  } catch (err) { next(err); }
});

router.post('/subscribe', notYou, async (req, res, next) => {
  try {
    if (!push.available() || !(await push.publicKey())) return res.status(503).json({ error: 'Phone alerts are not available on this server yet.' });
    const r = await push.subscribe(req.user.id, req.body && req.body.subscription, req.get('user-agent'));
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json({ ok: true, devices: await push.devicesOf(req.user.id) });
  } catch (err) { next(err); }
});

router.post('/unsubscribe', notYou, async (req, res, next) => {
  try {
    const removed = await push.unsubscribe(req.user.id, req.body && req.body.endpoint);
    res.json({ ok: true, removed, devices: await push.devicesOf(req.user.id) });
  } catch (err) { next(err); }
});

router.post('/test', notYou, async (req, res, next) => {
  try {
    if (!(await push.devicesOf(req.user.id))) return res.status(409).json({ error: 'No phone has alerts switched on for you yet.' });
    const r = await push.sendToUser(req.user.id, {
      title: 'Phone alerts are on',
      body: 'This is a test. You will get leave decisions, approvals and follow-ups like this one.',
      url: '/admin/notifications',
      tag: 'tl-test',
    });
    res.json({ ok: r.sent > 0, ...r });
  } catch (err) { next(err); }
});

module.exports = router;
