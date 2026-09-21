// ---------------------------------------------------------------------------
// The AI agent — Anthropic Claude, server-side only.
//
// THE KEY NEVER LEAVES THE SERVER. It is entered in Administration →
// Integrations, encrypted at rest by utils/secrets.js, decrypted here, and
// used here. No response body, no log line and no frontend bundle contains
// it. The browser talks to /api/ai/ask; only this process talks to Anthropic.
//
// THE AGENT CANNOT SEE MORE THAN THE USER. Every data read goes through
// utils/aiAgentTools.js, which runs can() from the permission engine and
// spreads the utils/scope.js `where` fragments into the query — exactly as a
// route does. There is no service-account read and no second permission path.
//
// NOT CONFIGURED IS A FIRST-CLASS STATE. With no key, status() says so and
// ask() refuses politely. The floating panel keeps working on its rule-based
// "Do next" / queues content, which never needed a model.
//
// COST AND ABUSE. Conversation length, tool iterations, output tokens and
// requests per user per hour are all capped — see the constants below.
// ---------------------------------------------------------------------------

const AnthropicModule = require('@anthropic-ai/sdk');

const Anthropic = AnthropicModule.default || AnthropicModule;
const { readConfig } = require('./integrationStore');
const { ENV_VAR } = require('./secrets');
const { toolDefinitions, runTool } = require('./aiAgentTools');
const { scopeOf } = require('./scope');
const { atsRoleLabel } = require('./atsVocab');

const CHANNEL = 'ai-claude';

// Defaults. The Integrations screen can override the model, the answer cap and
// the per-user hourly limit; the rest are fixed because they are safety rails
// rather than configuration.
const DEFAULT_MODEL = 'claude-opus-5';
const DEFAULT_MAX_TOKENS = 1500;
const DEFAULT_PER_HOUR = 30;
// A question is one user turn. Older turns beyond this are dropped so a long
// session cannot grow the bill without bound.
const MAX_HISTORY_TURNS = 8;
const MAX_QUESTION_CHARS = 2000;
// How many times the model may call tools before it has to answer.
const MAX_TOOL_ITERATIONS = 6;
// A short burst guard on top of the hourly cap.
const PER_MINUTE = 6;

function num(value, fallback) {
  const n = Number(String(value == null ? '' : value).trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// --- Configuration ---------------------------------------------------------
async function agentConfig() {
  const cfg = await readConfig(CHANNEL);
  const values = cfg.values || {};
  const apiKey = String(values['Anthropic API key'] || '').trim();
  const problems = [];
  if (!cfg.row) problems.push('The AI Assistant channel has never been configured.');
  else if (!apiKey) {
    problems.push(cfg.missingKey
      ? `An API key is stored but this server cannot decrypt it — ${ENV_VAR} is missing or has changed.`
      : 'No Anthropic API key has been entered.');
  }
  if (cfg.row && !cfg.row.enabled) problems.push('The channel is switched off.');
  else if (cfg.row && !cfg.connected) problems.push('The channel is disconnected — reconnect it in Administration → Integrations.');
  return {
    apiKey,
    model: String(values.Model || '').trim() || DEFAULT_MODEL,
    maxTokens: Math.min(num(values['Max answer tokens'], DEFAULT_MAX_TOKENS), 4000),
    perHour: Math.min(num(values['Questions per user per hour'], DEFAULT_PER_HOUR), 200),
    configured: problems.length === 0,
    reason: problems.join(' '),
  };
}

let cachedClient = null; // { key, client }

function clientFor(apiKey) {
  if (cachedClient && cachedClient.key === apiKey) return cachedClient.client;
  cachedClient = { key: apiKey, client: new Anthropic({ apiKey, maxRetries: 1, timeout: 60000 }) };
  return cachedClient.client;
}

function resetClient() { cachedClient = null; }

// --- Rate limiting ---------------------------------------------------------
// In memory, per process, per user. Deliberately not a table: it is a cost
// guard on a single-process app, and a restart losing it is not a problem.
const hits = new Map(); // userId -> number[] (timestamps)

function rateCheck(userId, perHour) {
  const now = Date.now();
  const list = (hits.get(userId) || []).filter((t) => now - t < 3600_000);
  const lastMinute = list.filter((t) => now - t < 60_000).length;
  if (lastMinute >= PER_MINUTE) {
    return { ok: false, retryAfter: 60, message: `Slow down — at most ${PER_MINUTE} questions a minute.` };
  }
  if (list.length >= perHour) {
    return { ok: false, retryAfter: 900, message: `You have reached this hour's limit of ${perHour} AI questions.` };
  }
  list.push(now);
  hits.set(userId, list);
  return { ok: true, used: list.length, perHour };
}

// --- Prompt ----------------------------------------------------------------
// The system prompt says what the agent is and what it must not do. It does
// NOT carry any data: every fact comes from a tool call, which is where the
// permission checks live.
function systemPrompt(user) {
  const s = scopeOf(user);
  return [
    'You are the TeamLink AI Assistant, embedded in a recruitment (ATS) and HR platform.',
    '',
    'WHO YOU ARE TALKING TO',
    `Name: ${user.name || 'a TeamLink user'}. Role: ${user.role}${user.atsRole && user.atsRole !== user.role ? ` (ATS working role: ${atsRoleLabel(user.atsRole)})` : ''}.`,
    s.global ? 'Their data scope is company-wide.' : `Their data scope is limited${s.departments.length ? ` to ${s.departments.join(', ')}` : ''}${s.clientId ? ' to their own client company' : ''}.`,
    '',
    'HOW YOU ANSWER',
    '- Answer only from the tools. You have no other knowledge of this company, its candidates, clients or requirements.',
    '- The tools already apply this user\'s permissions and data scope. If a tool refuses or returns nothing, say plainly that you cannot see that data for this user — never guess, never fill the gap from memory, and never imply the record does not exist when you were refused.',
    '- Never invent a match score, a stage name, a candidate, a client or a requirement. Match scores come from the summarise/top-matches tools and nowhere else.',
    '- When you name a candidate or requirement, include what the tool returned about it, not an embellishment.',
    '- You are read-only. You cannot change a stage, send a message, save a job description or edit any record. If asked to, say what the user should click instead.',
    '- Be brief and concrete. Short paragraphs or a short list. No preamble, no sign-off.',
    '- Plain text only — this renders in a small side panel with no Markdown support.',
  ].join('\n');
}

// --- The loop --------------------------------------------------------------
// A manual tool loop rather than the SDK tool runner: every tool call has to
// be executed against THIS user's permissions, which means the user object
// travels with the call, and the loop is where the iteration cap lives.
async function ask({ user, question, history = [] }) {
  const cfg = await agentConfig();
  if (!cfg.configured) {
    return {
      ok: false, notConfigured: true, reason: cfg.reason,
      answer: null,
    };
  }
  const q = String(question || '').trim().slice(0, MAX_QUESTION_CHARS);
  if (!q) return { ok: false, error: 'Ask a question first.' };

  const limit = rateCheck(user.id, cfg.perHour);
  if (!limit.ok) return { ok: false, rateLimited: true, retryAfter: limit.retryAfter, error: limit.message };

  // Only the plain-text turns of the prior conversation are replayed, capped
  // and trimmed. Tool traffic is not replayed: it would multiply the bill and
  // the model can call the tool again if it needs the data.
  const trimmed = (Array.isArray(history) ? history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-MAX_HISTORY_TURNS * 2)
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, MAX_QUESTION_CHARS) }));

  const messages = [...trimmed, { role: 'user', content: q }];
  const client = clientFor(cfg.apiKey);
  const tools = toolDefinitions();
  const toolsUsed = [];
  let usage = { input: 0, output: 0 };

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i += 1) {
    let response;
    try {
      // eslint-disable-next-line no-await-in-loop
      response = await client.messages.create({
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        system: systemPrompt(user),
        thinking: { type: 'adaptive' },
        output_config: { effort: 'low' },
        tools,
        messages,
      });
    } catch (err) {
      return { ok: false, error: apiError(err) };
    }
    usage = {
      input: usage.input + ((response.usage && response.usage.input_tokens) || 0),
      output: usage.output + ((response.usage && response.usage.output_tokens) || 0),
    };

    // A safety refusal is a real outcome, not an error to hide.
    if (response.stop_reason === 'refusal') {
      return { ok: false, error: 'The model declined to answer that question.' };
    }

    const toolUses = (response.content || []).filter((b) => b.type === 'tool_use');
    if (!toolUses.length) {
      const answer = (response.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      return {
        ok: true,
        answer: answer || 'I could not put an answer together for that.',
        toolsUsed,
        truncated: response.stop_reason === 'max_tokens',
        usage,
        model: cfg.model,
        rate: { used: limit.used, perHour: limit.perHour },
      };
    }

    messages.push({ role: 'assistant', content: response.content });
    const results = [];
    for (const call of toolUses) {
      // THE PERMISSION BOUNDARY. runTool -> aiAgentTools -> can() + scope.
      // eslint-disable-next-line no-await-in-loop
      const out = await runTool(user, call.name, call.input);
      toolsUsed.push({ name: call.name, denied: !!out.denied });
      results.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: JSON.stringify(out).slice(0, 24000),
        is_error: !!out.error,
      });
    }
    messages.push({ role: 'user', content: results });
  }

  return {
    ok: false,
    error: 'That question needed more lookups than the assistant is allowed to make. Try asking something narrower.',
    toolsUsed,
    usage,
  };
}

// The provider's own words, without the key. The SDK never puts the key in an
// error message, but the message is trimmed and the request body is not
// echoed, so nothing from the prompt escapes either.
function apiError(err) {
  if (!err) return 'The model did not answer.';
  if (err instanceof Anthropic.AuthenticationError) return 'Anthropic rejected the API key (401). Check the key in Administration → Integrations.';
  if (err instanceof Anthropic.RateLimitError) return 'Anthropic is rate-limiting this API key (429). Try again shortly.';
  if (err instanceof Anthropic.NotFoundError) return 'Anthropic does not recognise that model id (404). Check the Model field in Integrations.';
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the Anthropic API from this server.';
  const status = err.status ? `${err.status} ` : '';
  const message = String((err.error && err.error.error && err.error.error.message) || err.message || err).slice(0, 300);
  return `Anthropic API error ${status}— ${message}`.replace(/\s+/g, ' ').trim();
}

// What /api/ai/status and the Integrations screen show.
async function status() {
  const cfg = await agentConfig();
  return {
    configured: cfg.configured,
    reason: cfg.configured ? null : cfg.reason,
    model: cfg.configured ? cfg.model : null,
    maxTokens: cfg.maxTokens,
    perHour: cfg.perHour,
    tools: toolDefinitions().map((t) => t.name),
  };
}

// The Integrations "Test" button: a one-token round trip that proves the key
// and the model id, and reports the provider's real error otherwise.
async function testConnection() {
  const cfg = await agentConfig();
  if (!cfg.configured) return { ok: false, notConfigured: true, error: cfg.reason };
  try {
    const r = await clientFor(cfg.apiKey).messages.create({
      model: cfg.model,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
    });
    const text = (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
    return { ok: true, model: cfg.model, reply: text.slice(0, 100) };
  } catch (err) {
    return { ok: false, error: apiError(err) };
  }
}

module.exports = {
  CHANNEL, ask, status, testConnection, resetClient, agentConfig,
  // clientFor / rateCheck / apiError are exported so that other server-side AI
  // features (today: the weekly-idea screener in utils/ideaAi.js) reuse the
  // same key handling, the same cached client and the SAME per-user hourly
  // budget rather than opening a second one.
  clientFor, rateCheck, apiError,
  MAX_HISTORY_TURNS, MAX_TOOL_ITERATIONS,
};
