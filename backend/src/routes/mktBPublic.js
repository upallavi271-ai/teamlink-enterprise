// ---------------------------------------------------------------------------
// MARKET WAVE B - the doors without a TeamLink login:
//   /api/public/mkt/profile/:token        GET / POST   the candidate's own profile-update link (03.17; utils/mktb/cands.js)
//   /api/public/mkt/jobs/:id/screening    GET          the screening questions of a public job (02.10), never the knockout answers
//   /api/mcp                              POST         the read-only MCP server (09.14; utils/mktb/mcp.js), its own token auth
// Rate limited per address (utils/publicRateLimit.js).
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { rateLimit } = require('../utils/publicRateLimit');
const C = require('../utils/mktb/cands');
const J = require('../utils/mktb/jobs');
const MCP = require('../utils/mktb/mcp');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const send = (res, out) => (out && out.error ? res.status(out.status || 400).json({ error: out.error }) : res.json(out));

const publicRouter = express.Router();
const limit = rateLimit({ bucket: 'mkt-public', max: 60, windowMs: 10 * 60000 });
publicRouter.get('/profile/:token', limit, wrap(async (req, res) => send(res, await C.linkView(req.params.token))));
publicRouter.post('/profile/:token', limit, wrap(async (req, res) => send(res, await C.linkSubmit(req.params.token, req.body || {}))));
publicRouter.get('/jobs/:id/screening', limit, wrap(async (req, res) => {
  const job = await prisma.requirement.findFirst({ where: { OR: [{ id: String(req.params.id) }, { reqCode: String(req.params.id) }], portalPublished: true }, select: { id: true } });
  if (!job) return res.status(404).json({ error: 'This job is not on the portal.' });
  return res.json({ questions: await J.publicQuestions(job.id) });
}));

const mcpRouter = express.Router();
mcpRouter.post('/', rateLimit({ bucket: 'mcp', max: 300, windowMs: 10 * 60000 }), wrap(MCP.handle));
mcpRouter.get('/', (req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Use POST with a JSON-RPC message (MCP streamable HTTP).' }));

module.exports = { publicRouter, mcpRouter };
