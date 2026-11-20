// ---------------------------------------------------------------------------
// /api/job-flow : the Naukri -> Shine BY-HAND workflow of the Post step (jobFlow/service.js, rules in jobFlow/logic.js).
//   GET  /jobs/:id                          where the recruiter is for this job (restores the screen after a refresh)
//   POST /jobs/:id/:platform/:event         platform naukri | shine ; event start | opened | await | confirm | opening | complete | fail | action | retry | unconfirm
//                                           body { code, message, url, externalJobId, standalone }
// Nothing here contacts Naukri or Shine. Same people as Save & Post (jobPublish/access.js mayPost); every step is audited.
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth, requireProduct } = require('../middleware/auth');
const access = require('../jobPublish/access');
const Flow = require('../jobFlow/service');

const router = express.Router();
router.use(requireAuth);
router.use(requireProduct('ats'));
router.use((req, res, next) => (access.isClientLogin(req.user) ? res.status(403).json({ error: 'This is internal to TeamLink.' }) : next()));
const wrap = (fn) => async (req, res, next) => { try { await fn(req, res, next); } catch (e) { next(e); } };
const EVENTS = ['start', 'opened', 'await', 'confirm', 'opening', 'complete', 'fail', 'action', 'retry', 'unconfirm'];
const send = (res, out) => { const { status, ...rest } = out; return res.status(out.error ? (status || 400) : 200).json(rest); };

router.get('/jobs/:id', wrap(async (req, res) => send(res, await Flow.get().state(req.user, req.params.id))));
router.post('/jobs/:id/:platform/:event', wrap(async (req, res) => {
  if (!EVENTS.includes(req.params.event)) return res.status(404).json({ error: 'Unknown step.' });
  // Naukri / Shine by hand: a new job is started only once its TL has ticked who receives the responses (utils/responseRecipients.js)
  if (['start', 'opening'].includes(req.params.event)) {
    const r = await require('../db').requirement.findUnique({ where: { id: String(req.params.id) } }); // eslint-disable-line global-require
    const stop = r && access.inScope(req.user, r) ? await require('../utils/responseRecipients').postingRefusal(r) : null; // eslint-disable-line global-require
    if (stop) return res.status(409).json(stop);
  }
  return send(res, await Flow.get().act(req.user, req.params.id, req.params.platform, req.params.event, req.body || {}));
}));

module.exports = router;
