// ---------------------------------------------------------------------------
// The HTTP face of the AI Agent registry. Mounted by routes/agent.js AFTER its
// requireAi('agent') gate, so every route here already needs the Role Catalog
// "Agent" grant; routes/assistant.js mounts the read-only Ask half.
//
//   POST /api/agent/do       { message, frame?, choices?, voice? } -> runs steps 1-7
//                            (and 8-11 when no Confirm is needed)
//   POST /api/agent/confirm  { pendingId }  -> runs the STORED parameters, once
//   POST /api/agent/cancel   { pendingId }
//   GET  /api/agent/tools    what the registry holds, and what THIS user may do
//   GET  /api/agent/pending  this user's open Confirm cards
// ---------------------------------------------------------------------------

const express = require('express');
const pipeline = require('./pipeline');
const registry = require('./registry');
const confirmations = require('./confirmations');
const perm = require('./permissions');
const llm = require('./intent/llm');
const aiAccess = require('../utils/aiAccess');
const sandbox = require('../utils/sandbox');

const MAX_MESSAGE_CHARS = 2000;
const MAX_FRAME_BYTES = 20000;

// The frame the screen sends back is a convenience, never a source of trust:
// everything in it is re-resolved and re-checked. Keep it a small plain object.
function cleanFrame(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  let s;
  try { s = JSON.stringify(raw); } catch { return null; }
  if (s.length > MAX_FRAME_BYTES) return null;
  const f = JSON.parse(s);
  if (f.tool != null && (typeof f.tool !== 'string' || !registry.getTool(f.tool))) f.tool = null;
  if (f.need != null && typeof f.need !== 'string') f.need = null;
  if (!f.slots || typeof f.slots !== 'object') f.slots = {};
  return { tool: f.tool || null, need: f.need || null, slots: f.slots, choices: cleanChoices(f.choices), text: typeof f.text === 'string' ? f.text.slice(0, MAX_MESSAGE_CHARS) : '', redirected: !!f.redirected };
}

function cleanChoices(raw) {
  const out = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    Object.entries(raw).slice(0, 12).forEach(([k, v]) => {
      if (/^[a-zA-Z_]{1,24}$/.test(k) && (typeof v === 'string' || typeof v === 'number')) out[k] = String(v).slice(0, 120);
    });
  }
  if (out.__tool && !registry.getTool(out.__tool)) delete out.__tool;
  return out;
}

const agentRouter = express.Router();

agentRouter.post('/do', async (req, res, next) => {
  try {
    const body = req.body || {};
    const message = String(body.message || '').trim().slice(0, MAX_MESSAGE_CHARS);
    const frame = cleanFrame(body.frame);
    const choices = cleanChoices(body.choices);
    if (!message && !(frame && (Object.keys(choices).length || frame.tool))) {
      return res.status(400).json({ error: 'Tell the agent what to do first.' });
    }
    const voice = aiAccess.voiceOf(body);
    if (voice && !req.user.ai.voice) {
      return res.status(403).json({ error: 'Your role cannot use voice input with the AI Agent. Type the request instead.', code: 'ai_voice_denied' });
    }
    const model = await llm.make().catch(() => null);
    const out = await pipeline.run({
      user: req.user, auth: req.headers.authorization, message, frame, choices, voice, viewAs: !!req.viewAs, llm: model,
    });
    return res.json(out);
  } catch (err) {
    return next(err);
  }
});

agentRouter.post('/confirm', async (req, res, next) => {
  try {
    const out = await pipeline.confirm({
      user: req.user, auth: req.headers.authorization, pendingId: String((req.body && req.body.pendingId) || ''), viewAs: !!req.viewAs,
    });
    const status = out.kind === 'denied' && out.code === 'other_user' ? 403 : (out.kind === 'expired' && out.code === 'expired' ? 410 : 200);
    return res.status(status).json(out);
  } catch (err) {
    return next(err);
  }
});

agentRouter.post('/cancel', (req, res) => {
  const out = pipeline.cancel({ user: req.user, pendingId: String((req.body && req.body.pendingId) || '') });
  res.status(out.kind === 'denied' ? 403 : 200).json(out);
});

agentRouter.get('/pending', (req, res) => {
  res.json({ pending: confirmations.listFor(req.user), ttlMinutes: Math.round(confirmations.ttl() / 60000) });
});

agentRouter.get('/tools', async (req, res, next) => {
  try {
    const rows = [];
    for (const tool of registry.allTools()) {
      // eslint-disable-next-line no-await-in-loop
      const g = await perm.checkTool(req.user, tool, { viewAs: !!req.viewAs });
      rows.push({ ...registry.describe(tool), allowed: g.ok, why: g.ok ? null : g.message });
    }
    res.json({ tools: rows, you: perm.roleWords(req.user) });
  } catch (err) { next(err); }
});

// TEST SANDBOX ONLY: expire a pending card at once, so the 10-minute rule can be tested.
if (sandbox.isSandbox()) {
  agentRouter.post('/_test/expire', (req, res) => {
    const id = String((req.body && req.body.pendingId) || '');
    const rec = confirmations.get(id);
    if (!rec || rec.userId !== req.user.id) return res.status(404).json({ error: 'No such pending action for you.' });
    confirmations._expireNow(id);
    return res.json({ ok: true });
  });
}

module.exports = { agentRouter, cleanFrame, cleanChoices };
