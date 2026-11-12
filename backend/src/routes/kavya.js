// ---------------------------------------------------------------------------
// /api/kavya/*  - KAVYA, the Telugu / Hindi / English AI caller (backend/src/calling/kavya/*).
//
//   GET  /status              is Kavya connected, the Off / Test / Live switch of AI Calling, may this login call
//   POST /runs                { applicationIds: [...], source: 'ats' | 'portal' | 'omni', extras?: { interviewMode, languagesRequired }, start?: true }
//                             hands candidates of ONE requirement to Kavya (the AI Calling roles / consent / DND / test-number rules apply first)
//   GET  /runs                my runs (an Admin sees all)
//   GET  /runs/:id            one run + what Kavya has finished so far (pulls the newest results first)
//   POST /runs/:id/pause|start
// The Kavya API key stays on this server. The same /api/ai-calling/jobs and /candidates lists pick the people (same scope rules).
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth, requireProduct } = require('../middleware/auth');
const kavya = require('../calling/kavya/service');

const router = express.Router();
router.use(requireAuth);
router.use(requireProduct('ats'));

const send = (res, r) => (r && r.ok === false ? res.status(r.status || 400).json({ error: r.error, code: r.code, ...(r.skipped ? { skipped: r.skipped } : {}) }) : res.json(r));
const guard = (fn) => async (req, res) => {
  try { return await fn(req, res); } catch (err) {
    console.error('[kavya]', err); // eslint-disable-line no-console
    return res.status(500).json({ error: 'Kavya could not do that. Please try again.' });
  }
};

router.get('/status', guard(async (req, res) => res.json(await kavya.status(req.user))));
// The engine switch: 'kavya' = Kavya takes every Screening / Job Match call of AI Calling (default), 'old' = the old engine again. Admins only.
router.post('/engine', guard(async (req, res) => {
  if (!['SUPER_ADMIN', 'ADMIN'].includes(String((req.user && req.user.role) || '').toUpperCase())) return res.status(403).json({ error: 'Only an Admin can switch the calling engine.' });
  const value = await require('../calling/kavya/engine').setEngine(req.body && req.body.engine); // eslint-disable-line global-require
  await require('../utils/audit').logAudit({ userId: req.user.id, action: 'Kavya engine switch', entity: 'KavyaSetting', entityId: 'engine', toValue: value }); // eslint-disable-line global-require
  return res.json({ ok: true, engine: value });
}));
router.post('/runs', guard(async (req, res) => send(res, await kavya.createRuns(req.user, req.body || {}))));
router.get('/runs', guard(async (req, res) => send(res, await kavya.listRuns(req.user))));
router.get('/runs/:id', guard(async (req, res) => send(res, await kavya.runDetail(req.user, req.params.id))));
router.post('/runs/:id/pause', guard(async (req, res) => send(res, await kavya.control(req.user, req.params.id, 'pause'))));
router.post('/runs/:id/start', guard(async (req, res) => send(res, await kavya.control(req.user, req.params.id, 'start'))));

module.exports = router;
