// ---------------------------------------------------------------------------
// /api/ai — the AI Assistant's backend.
//
// Three endpoints and nothing else:
//   GET  /api/ai/status   is a model configured, which tools exist, may it act
//   POST /api/ai/ask      one question, answered from this app's data
//   POST /api/ai/act      redeem ONE confirmation the user pressed in the panel
//
// The Anthropic key is never sent here and never sent back: it lives in the
// encrypted credential store and is read inside utils/aiAgent.js only.
//
// Access is the same permission engine as everything else. The guard below is
// the 'Quick Actions' dashboard feature — the floating panel IS a quick
// action — and every DATA read the agent makes is separately checked inside
// utils/aiAgentTools.js / utils/aiAgentReadTools.js against the asking user,
// and every WRITE twice, in utils/aiAgentActions.js. The guard alone is not
// the access control; it is the door, and the tools are the rooms.
//
// EVERY HANDLER IS WRAPPED. Express 4 does not catch a rejected promise from
// an async handler: it becomes an unhandled rejection, which has taken this
// process down before. Nothing below may reject.
// ---------------------------------------------------------------------------

const express = require('express');
const { requireAuth, requirePerm } = require('../middleware/auth');
const aiAgent = require('../utils/aiAgent');

const router = express.Router();
router.use(requireAuth);

const GUARD = requirePerm(null, 'dashboard', 'Quick Actions', 'view');

router.get('/status', GUARD, async (req, res, next) => {
  try {
    return res.json(await aiAgent.status(req.user));
  } catch (err) {
    return next(err);
  }
});

router.post('/ask', GUARD, async (req, res, next) => {
  try {
    const result = await aiAgent.ask({
      user: req.user,
      question: req.body.question,
      history: req.body.history,
    });
    if (result.notConfigured) {
      // 200, not an error: "no model configured" is a supported state of this
      // app, and the panel renders it as a message rather than a failure.
      return res.json({ configured: false, reason: result.reason, answer: null });
    }
    if (result.rateLimited) {
      return res.status(429).json({
        configured: true, error: result.error, retryAfter: result.retryAfter,
      });
    }
    if (!result.ok) {
      return res.status(502).json({
        configured: true, error: result.error, toolsUsed: result.toolsUsed || [],
      });
    }
    return res.json({ configured: true, ...result });
  } catch (err) {
    return next(err);
  }
});

// The confirm button on a proposed action. One token, one use. The model is
// not involved; utils/aiAgentActions.js re-runs the permission and scope
// checks before anything is written, and writes the audit row after.
router.post('/act', GUARD, async (req, res, next) => {
  try {
    const out = await aiAgent.act({ user: req.user, token: req.body && req.body.token });
    if (!out.ok) return res.status(out.status || 400).json({ ok: false, error: out.error });
    return res.json(out);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
