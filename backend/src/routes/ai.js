// ---------------------------------------------------------------------------
// /api/ai — the AI Assistant's backend.
//
// Two endpoints and nothing else:
//   GET  /api/ai/status   is a model configured, and which tools exist
//   POST /api/ai/ask      one question, answered from this app's data
//
// The Anthropic key is never sent here and never sent back: it lives in the
// encrypted credential store and is read inside utils/aiAgent.js only.
//
// Access is the same permission engine as everything else. The guard below is
// the 'Quick Actions' dashboard feature — the floating panel IS a quick
// action — and every DATA read the agent makes is separately checked inside
// utils/aiAgentTools.js against the asking user. The guard alone is not the
// access control; it is the door, and the tools are the rooms.
// ---------------------------------------------------------------------------

const express = require('express');
const { requireAuth, requirePerm } = require('../middleware/auth');
const aiAgent = require('../utils/aiAgent');

const router = express.Router();
router.use(requireAuth);

router.get('/status', requirePerm(null, 'dashboard', 'Quick Actions', 'view'), async (req, res) => {
  res.json(await aiAgent.status());
});

router.post('/ask', requirePerm(null, 'dashboard', 'Quick Actions', 'view'), async (req, res) => {
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
  if (result.rateLimited) return res.status(429).json({ configured: true, error: result.error, retryAfter: result.retryAfter });
  if (!result.ok) return res.status(502).json({ configured: true, error: result.error });
  return res.json({ configured: true, ...result });
});

module.exports = router;
