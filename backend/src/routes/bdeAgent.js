// THE BDE AGENT (utils/bdeAgent.js): a quick, accurate, read-only assistant for BDE, BDE TL, Super Admin and Developer logins.
//   GET  /api/bde-agent/overview   the counts the panel shows, the question chips for this login, and whether an AI is ready
//   POST /api/bde-agent/ask        { question, history: [{ role: 'user'|'assistant', content }], fresh } ->
//                                  { text, answers: [{ intent, count, title, lines, items: [{ label, sub, to, history, record }], more, facts }],
//                                    facts, source: 'code' | 'model', provider, ms }
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const BA = require('../utils/bdeAgent');

const router = express.Router();
router.use(requireAuth);
router.use((req, res, next) => {
  if (!BA.isBdeAgentUser(req.user)) return res.status(403).json({ error: 'The BDE Agent is for BDE logins only.' });
  return next();
});

// plenty for a person typing (the answers in code cost almost nothing; the model has its own, smaller limit in utils/bdeAgent.js)
const hits = new Map();
function limit(req, res, next) {
  const now = Date.now();
  const list = (hits.get(req.user.id) || []).filter((t) => now - t < 60000);
  if (list.length >= 90) return res.status(429).json({ error: 'Too many questions in a minute. Wait a moment and ask again.' });
  list.push(now);
  hits.set(req.user.id, list);
  return next();
}

const wrap = (fn) => async (req, res) => {
  try {
    const out = await fn(req);
    res.status(out.status || 200).json(out.body);
  } catch (err) {
    console.error('[bde-agent]', err); // eslint-disable-line no-console
    res.status(500).json({ error: 'The BDE Agent could not answer right now.' });
  }
};

router.get('/overview', wrap((req) => BA.overview(req.user)));
router.post('/ask', limit, wrap((req) => BA.ask(req.user, req.body || {})));

module.exports = router;
