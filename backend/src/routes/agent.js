// ---------------------------------------------------------------------------
// /api/agent — the AI Agent tab. It PROPOSES real HRMS and ATS actions; it
// performs one only after the user presses Confirm.
//
//   GET  /api/agent/status    the model's status (drives the "AI" dot)
//   GET  /api/agent/context   UI hints: which quick actions this user can use
//   POST /api/agent/plan      { message, history, page } -> { action, params, summary, details }
//                             DECIDES, NEVER EXECUTES. Writes nothing.
//   POST /api/agent/execute   { action, params } — after Confirm only
//
// The model's output is trusted for nothing. /plan checks the action against
// the allowlist in utils/agentActions.js and every ref against lists read
// server-side with the user's own scope; /execute checks all of it again
// against lists rebuilt for the exact ids, and then replays the request
// against the app's own route with the caller's own Authorization header —
// so the route's permission checks, not the prompt, decide what happens.
// ---------------------------------------------------------------------------

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const ai = require('../utils/ai');
const { areaOf, topicOf } = require('../utils/aiFacts');
const {
  ACTIONS, ACTION_BY_NAME, ALLOWED_ACTIONS, availableActions, routeActions, buildContext, idsFromParams, planPrompt,
} = require('../utils/agentActions');
const { sanitizeHistory, limitFor } = require('./assistant');
const aiAccess = require('../utils/aiAccess');

// ACCESS (Role Catalog → AI Assistant & Agent, utils/aiAccess.js):
//   /status          needs "Ask"   (403 without — the button is hidden then)
//   /context, /plan, /execute  need "Agent" (403 without)
// /execute additionally runs the can() check of the app feature each action
// replays (aiAccess.actionPermitted) before anything happens, and audits
// every executed action "via AI Agent". A role with the Role Catalog grant
// "execute without confirm" gets its proposal carried out by /plan straight
// away — except when the request came from low-confidence speech.
const router = express.Router();
router.use(requireAuth);

const MAX_MESSAGE_CHARS = 2000;
const HISTORY_TURNS = 6;

const clarify = (summary, options = []) => ({
  action: 'clarify', params: {}, summary, options: aiAccess.cleanOptions(options),
});

// Actions this user may be offered: what the context allows AND a product
// the login actually holds (the full can() runs again at execute time).
function usableActions(ctx) {
  return availableActions(ctx).filter((a) => aiAccess.actionProductAllowed(ctx.user, a.name));
}

router.get('/status', aiAccess.requireAi('ask'), async (req, res) => {
  res.json(await ai.checkStatus());
});

router.use(aiAccess.requireAi('agent'));

router.get('/context', async (req, res) => {
  const ctx = await buildContext(req.user, req.headers.authorization);
  const actions = usableActions(ctx);
  const L = ctx.lists;
  res.json({
    hasEmployee: !!ctx.employee,
    // Things waiting on this user that the agent could act on right now.
    actionableCount: (L.leaves || []).length + (L.regs || []).length,
    pendingLeaveDecisions: (L.leaves || []).length,
    pendingRegularizationDecisions: (L.regs || []).length,
    can: Object.fromEntries(ALLOWED_ACTIONS.map((n) => [n, actions.some((a) => a.name === n)])),
    actions: actions.map((a) => ({ name: a.name, label: a.label, area: a.area })),
    chips: actions.filter((a) => a.chip).map((a) => ({ action: a.name, label: a.label, prompt: a.chip, area: a.area })),
    provider: ai.provider(),
    executeWithoutConfirm: !!req.user.ai.executeWithoutConfirm,
  });
});

// Carry out one validated proposal: the feature's can() check, the replay
// against the app's own route, the "via AI Agent" audit row.
async function runAction(req, ctx, action, checked, { autoExecuted = false } = {}) {
  const perm = await aiAccess.actionPermitted(req.user, action.name, checked.params);
  if (!perm.ok) return { status: 403, body: { error: perm.message, code: 'ai_action_denied' } };
  const result = await action.execute(ctx, checked.params);
  if (!result.ok) {
    return { status: result.status && result.status >= 400 ? result.status : 400, body: { error: result.message } };
  }
  await aiAccess.auditAgentAction(req.user, action.name, checked.summary, result.message, { autoExecuted });
  return { status: 200, body: { ok: true, message: result.message, summary: checked.summary } };
}

router.post('/plan', async (req, res) => {
  const message = String((req.body && req.body.message) || '').trim().slice(0, MAX_MESSAGE_CHARS);
  if (!message) return res.status(400).json({ error: 'Tell the agent what to do first.' });
  const voice = aiAccess.voiceOf(req.body);
  if (voice && !req.user.ai.voice) {
    return res.status(403).json({ error: 'Your role cannot use voice input with the AI Agent. Type the request instead.', code: 'ai_voice_denied' });
  }
  const lowVoice = aiAccess.isLowConfidence(voice);

  const limit = await limitFor(req.user);
  if (!limit.ok) return res.status(429).json({ error: limit.message, retryAfter: limit.retryAfter });

  const history = sanitizeHistory(req.body && req.body.history, HISTORY_TURNS);
  const ctx = await buildContext(req.user, req.headers.authorization, { message, history });
  const usable = usableActions(ctx);
  if (!usable.length) {
    return res.json(clarify('There is nothing the agent can do for your login yet — your role has none of the supported actions.'));
  }
  const canList = usable.map((a) => a.label.toLowerCase()).join(', ');
  // What is the message about? If it is plainly about something this login
  // cannot do at all (a TL asking to post an announcement), say so without
  // asking the model — faster, and nothing for it to get wrong.
  const intent = routeActions(ACTIONS, [message]);
  if (intent.length < ACTIONS.length && !intent.some((a) => usable.includes(a))) {
    return res.json(clarify(`Your role cannot ${intent.map((a) => a.label.toLowerCase()).join(' or ')}, so I can't prepare that. What I can do: ${canList}.`));
  }
  // Only the families the conversation is about go into the prompt.
  let actions = routeActions(usable, [message, ...history.filter((m) => m.role === 'user').slice(-2).map((m) => m.content)]);
  // The REQUEST's area orders the list (HRMS / ATS / Accounts actions first);
  // the page decides only when the request does not say.
  const area = topicOf(message) || areaOf(req.body && req.body.page);
  if (area === 'ats' || area === 'hrms' || area === 'accounts') {
    actions = [...actions.filter((a) => a.area === area), ...actions.filter((a) => a.area !== area)];
  }

  let out;
  try {
    const note = aiAccess.voicePromptNote(voice);
    out = await ai.chatJson(note ? [planPrompt(ctx, actions), '', note].join(String.fromCharCode(10)) : planPrompt(ctx, actions), [...history, { role: 'user', content: message }]);
  } catch (err) {
    if (err instanceof ai.AiError) return res.status(err.status).json({ error: err.message, code: err.code });
    throw err;
  }

  const name = String((out && out.action) || '').trim();
  if (name === 'clarify' || !name) {
    const q = String((out && out.summary) || '').trim().slice(0, 500);
    const opts = Array.isArray(out && out.options) ? out.options : [];
    return res.json(clarify(q || 'Could you tell me a bit more about what you want done?', opts));
  }
  // THE ALLOWLIST. A name the app does not know is never passed on.
  if (!ALLOWED_ACTIONS.includes(name)) {
    return res.json(clarify(`That is not something I can do from here. I can: ${canList}.`));
  }
  // Known, but not this user's — fail safely, and say so.
  const action = usable.find((a) => a.name === name);
  if (!action) {
    return res.json(clarify(`Your role cannot ${ACTION_BY_NAME[name].label.toLowerCase()} right now, so I can't prepare that. What I can do: ${canList}.`));
  }
  // Small models sometimes put the fields beside "params" instead of in it.
  const raw = out.params && typeof out.params === 'object' && !Array.isArray(out.params)
    ? out.params
    : Object.fromEntries(Object.entries(out).filter(([k]) => !['action', 'summary'].includes(k)));
  const checked = action.validate(ctx, raw);
  if (checked.clarify) return res.json(clarify(checked.clarify));
  const proposal = {
    action: name,
    params: checked.params,
    // The server's own wording of what Confirm will do — built from the
    // validated params, not the model's prose.
    summary: checked.summary,
    details: checked.details,
    // Spoken with low confidence: the card says what was heard, and it is
    // never carried out without Confirm, whatever the role's grant.
    ...(voice ? { heard: { text: message, confidence: voice.confidence, lang: voice.lang, low: lowVoice } } : {}),
  };
  // Role Catalog "execute without confirm": carry it out now — but never on
  // low-confidence speech (that always waits for Confirm).
  if (req.user.ai.executeWithoutConfirm && !lowVoice) {
    const done = await runAction(req, ctx, action, checked, { autoExecuted: true });
    return res.json({
      ...proposal, executed: true, ok: done.status === 200, message: done.body.message || done.body.error,
    });
  }
  return res.json(proposal);
});

router.post('/execute', async (req, res) => {
  const name = String((req.body && req.body.action) || '').trim();
  const params = req.body && req.body.params && typeof req.body.params === 'object' ? req.body.params : {};
  if (!ALLOWED_ACTIONS.includes(name)) return res.status(400).json({ error: 'Unknown action.' });

  // Rebuilt from scratch for the exact ids being executed: the same lists and
  // the same checks /plan used, so an edited request body buys nothing.
  const ctx = await buildContext(req.user, req.headers.authorization, { ids: idsFromParams(params) });
  const action = ACTION_BY_NAME[name];
  if (!action.available(ctx)) {
    return res.status(403).json({ error: `Not available to your login right now: ${action.label.toLowerCase()}. Nothing was changed.` });
  }
  const checked = action.validate(ctx, params);
  if (checked.clarify) return res.status(409).json({ error: checked.clarify });

  const done = await runAction(req, ctx, action, checked);
  return res.status(done.status).json(done.body);
});

module.exports = router;
