// ---------------------------------------------------------------------------
// /api/messaging/reach — the bulk Call / Message (SMS) / WhatsApp / Email buttons
// of ATS > Candidates & Pipeline (utils/candidateReach.js). Mounted by
// routes/messaging.js, which already requires a login.
//
//   POST /check        { channel, ids }  who can be reached, who not, and why
//   POST /compose      { channel, ids, purposeKey, language, perChannel }  the message for everyone
//   POST /send         same body + confirmPeople  -> the ordinary bulk job (max 200)
//   GET  /result/:id   a finished send with a plain word per person
//   POST /device-log   { candidateId, channel, text } opened in the sender's own app
//   POST /call-queue   { items: [{ id, applicationId }] }  the people to dial in order
//   POST /call-log     { candidateId, outcome, note, callBackOn }  how one call went
//
// A role that does not see candidate numbers (BDE, BDE TL, Accounts) gets 403 on every one.
// ---------------------------------------------------------------------------

const express = require('express');
const R = require('../utils/candidateReach');
const access = require('../utils/contactAccess');

const router = express.Router();

const handle = (fn) => async (req, res, next) => {
  try {
    const r = await fn(req);
    if (r.error) return res.status(r.status || 400).json({ error: r.error, ...(r.people !== undefined ? { people: r.people } : {}) });
    return res.status(r.created ? 202 : 200).json(r.out);
  } catch (err) { return next(err); }
};

router.post('/check', handle((req) => R.check(req.user, req.body)));
router.post('/compose', handle((req) => R.compose(req.user, req.body)));
router.post('/send', handle(async (req) => { const r = await R.send(req.user, req.body); return r.error ? r : { ...r, created: true }; }));
router.post('/device-log', handle((req) => R.deviceLog(req.user, req.body)));
router.post('/call-queue', handle((req) => R.callQueue(req.user, req.body)));
router.post('/call-log', handle((req) => R.callLog(req.user, req.body)));
router.get('/result/:id', handle(async (req) => {
  const g = await R.mayReach(req.user, { bulkSend: false });
  if (!g.ok) return g;
  return R.resultOf(req.user, req.params.id, (await access.ruleFor(req.user, 'candidates')).mode === 'masked');
}));

module.exports = router;
