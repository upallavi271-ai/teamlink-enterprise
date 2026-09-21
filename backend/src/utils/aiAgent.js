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
const {
  isAction, writeToolDefinitions, proposeAction, executeAction, actionsEnabled,
} = require('./aiAgentActions');
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

// What counts as "yes" in the Integrations text field that arms write actions.
const AFFIRMATIVE = /^(yes|y|true|on|enabled?|allow)$/i;

function num(value, fallback) {
  const n = Number(String(value == null ? '' : value).trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// --- Configuration ---------------------------------------------------------
// Never throws. A credential store that cannot be read is an UNCONFIGURED
// assistant, not a 500 — and before this guard a failure here rejected inside
// an async Express handler, which Express 4 does not catch.
async function agentConfig() {
  let cfg;
  try {
    cfg = await readConfig(CHANNEL);
  } catch (err) {
    return {
      apiKey: '',
      model: DEFAULT_MODEL,
      maxTokens: DEFAULT_MAX_TOKENS,
      perHour: DEFAULT_PER_HOUR,
      actionsEnabled: false,
      configured: false,
      reason: `The assistant's configuration could not be read: ${String((err && err.message) || err).slice(0, 200)}`,
    };
  }
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
    // WRITE ACTIONS ARE OFF UNLESS AN ADMINISTRATOR TURNS THEM ON. The field
    // is a plain yes/no on the Integrations card; anything that is not an
    // affirmative leaves the assistant read-only.
    actionsEnabled: AFFIRMATIVE.test(String(values['Allow the assistant to act (with confirmation)'] || '').trim()),
    configured: problems.length === 0,
    reason: problems.join(' '),
  };
}

let cachedClient = null; // { key, client }

function clientFor(apiKey) {
  if (cachedClient && cachedClient.key === apiKey) return cachedClient.client;
  // 120s, not 60s: adaptive thinking plus a tool round trip on a large
  // requirement was the one case the old timeout could clip.
  cachedClient = { key: apiKey, client: new Anthropic({ apiKey, maxRetries: 1, timeout: 120000 }) };
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
function systemPrompt(user, { canAct } = {}) {
  const s = scopeOf(user);
  const today = new Date().toISOString().slice(0, 10);
  return [
    'You are the TeamLink AI Assistant, embedded in a recruitment (ATS), HR and accounts platform.',
    '',
    'WHO YOU ARE TALKING TO',
    `Name: ${user.name || 'a TeamLink user'}. Role: ${user.role}${user.atsRole && user.atsRole !== user.role ? ` (ATS working role: ${atsRoleLabel(user.atsRole)})` : ''}.`,
    s.global ? 'Their data scope is company-wide.' : `Their data scope is limited${s.departments.length ? ` to ${s.departments.join(', ')}` : ''}${s.clientId ? ' to their own client company' : ''}.`,
    `Today is ${today}.`,
    '',
    'WORKING THROUGH A QUESTION',
    '- Answer only from the tools. You have no other knowledge of this company, its people, candidates, clients, invoices or requirements.',
    '- Chain tools when one answer needs several. Find the record first, then read it: search_requirements or search_candidates gives you the id that get_requirement, summarise_candidate_against_requirement or an action needs. Do not ask the user for an id you can look up.',
    '- Call several tools in one turn when they do not depend on each other.',
    '- The tools already apply this user\'s permissions and data scope. If a tool refuses or returns nothing, say plainly that you cannot see that data for this user — never guess, never fill the gap from memory, and never imply the record does not exist when you were refused.',
    '- Never invent a match score, a stage name, a candidate, a client, a figure or a requirement. Match scores come from the summarise/top-matches tools and nowhere else; money figures come from the accounts tools and nowhere else.',
    '- A tool that returns notApplicable (for example, a login with no employee record asking about payslips) is not a refusal. Say what it says.',
    '',
    'WHAT YOU CAN ANSWER ABOUT',
    '- Recruitment: requirements, candidates, the pipeline, matches, clients, interviews, offers and joinings.',
    '- The signed-in person\'s own HR facts: their profile status, attendance, leave balance, payslips and tasks.',
    '- Accounts, for a login that has them: invoices, receivables, what is overdue.',
    '',
    canAct
      ? [
        'ACTING',
        '- You may PROPOSE a small number of changes: moving a candidate on, scheduling an interview, creating a task.',
        '- Calling one of those tools changes NOTHING. It queues a confirm card in the panel. The user presses Confirm and the app performs it, re-checking their permissions at that moment.',
        '- After proposing, say in one line what you have queued and that they must press Confirm. Then stop. Do not call the same action tool twice, and never claim something has been done.',
        '- Never propose an action the user did not ask for, and never fill in a date, a stage or a person they did not give you. Ask instead.',
        '- Everything else is still read-only: you cannot send a message, save a job description, approve leave or change an invoice. Say what the user should click.',
      ].join('\n')
      : [
        'ACTING',
        '- You are read-only. You cannot change a stage, schedule an interview, create a task, send a message, save a job description or edit any record. If asked to, say what the user should click instead.',
      ].join('\n'),
    '',
    'STYLE',
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

  // The tool surface for THIS user. Read tools are the same for everyone (each
  // one checks its own permission and refuses honestly). Write tools are added
  // only when an administrator has armed them AND this user could actually
  // perform them, so the model is never told about a door it cannot open.
  const canAct = actionsEnabled(cfg);
  let writeTools = [];
  if (canAct) {
    try {
      writeTools = await writeToolDefinitions(user);
    } catch {
      writeTools = [];
    }
  }
  const tools = [...toolDefinitions(), ...writeTools];
  const system = systemPrompt(user, { canAct: canAct && writeTools.length > 0 });
  const toolsUsed = [];
  const pendingActions = [];
  let usage = { input: 0, output: 0 };

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i += 1) {
    let response;
    try {
      // Not streamed on purpose: the answer is capped at 4000 tokens and runs
      // at low-to-medium effort, so it comfortably fits one request, and a
      // non-streamed call keeps the tool inputs fully validated by the SDK
      // rather than making this loop responsible for truncated JSON.
      // eslint-disable-next-line no-await-in-loop
      response = await client.messages.create({
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        system,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
        tools,
        messages,
      });
    } catch (err) {
      return { ok: false, error: apiError(err), toolsUsed, pendingActions };
    }
    // A provider that answers with something this SDK version does not shape
    // as a message must not take the loop down.
    if (!response || !Array.isArray(response.content)) {
      return { ok: false, error: 'The model returned a response this server could not read.', toolsUsed, pendingActions };
    }
    usage = {
      input: usage.input + ((response.usage && response.usage.input_tokens) || 0),
      output: usage.output + ((response.usage && response.usage.output_tokens) || 0),
    };

    // A safety refusal is a real outcome, not an error to hide.
    if (response.stop_reason === 'refusal') {
      const why = response.stop_details && response.stop_details.category
        ? ` (${response.stop_details.category})`
        : '';
      return { ok: false, error: `The model declined to answer that question${why}.`, toolsUsed, pendingActions };
    }

    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    if (!toolUses.length) {
      const answer = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      return {
        ok: true,
        answer: answer || (pendingActions.length
          ? 'I have queued that for your confirmation — see the card below.'
          : 'I could not put an answer together for that.'),
        toolsUsed,
        pendingActions,
        truncated: response.stop_reason === 'max_tokens',
        usage,
        model: cfg.model,
        rate: { used: limit.used, perHour: limit.perHour },
      };
    }

    messages.push({ role: 'assistant', content: response.content });
    const results = [];
    for (const call of toolUses) {
      // THE PERMISSION BOUNDARY.
      //   a read  -> runTool       -> aiAgentTools / aiAgentReadTools -> can() + scope
      //   a write -> proposeAction -> aiAgentActions                  -> can() + scope,
      //              and even then only a PROPOSAL: the write itself happens in
      //              act() below, after the user confirms, behind a second check.
      let out;
      if (isAction(call.name)) {
        // eslint-disable-next-line no-await-in-loop
        out = canAct
          ? await proposeAction(user, call.name, call.input)
          : { denied: true, message: 'Refused: this assistant is read-only. An administrator has not enabled actions.' };
        if (out && out.proposed) {
          pendingActions.push({
            token: out.confirmToken,
            action: out.action,
            summary: out.summary,
            details: out.details,
          });
          // The token is the browser's to hold; the model never needs it and
          // is not given it.
          out = { ...out, confirmToken: undefined };
        }
      } else {
        // eslint-disable-next-line no-await-in-loop
        out = await runTool(user, call.name, call.input);
      }
      if (!out || typeof out !== 'object') out = { error: 'That lookup returned nothing usable.' };
      toolsUsed.push({
        name: call.name,
        denied: !!out.denied,
        proposed: !!out.proposed,
        write: isAction(call.name),
      });
      let content;
      try {
        content = JSON.stringify(out).slice(0, 24000);
      } catch {
        content = JSON.stringify({ error: 'That result could not be serialised.' });
      }
      results.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content,
        is_error: !!out.error,
      });
    }
    messages.push({ role: 'user', content: results });
  }

  return {
    ok: false,
    error: 'That question needed more lookups than the assistant is allowed to make. Try asking something narrower.',
    toolsUsed,
    pendingActions,
    usage,
  };
}

// --- Confirming an action --------------------------------------------------
// POST /api/ai/act lands here. The model is not involved: the user pressed
// Confirm on a card, and this redeems that one token. Every permission and
// scope check runs again inside executeAction().
async function act({ user, token }) {
  const cfg = await agentConfig();
  if (!cfg.configured) return { ok: false, status: 409, error: cfg.reason };
  if (!actionsEnabled(cfg)) {
    return {
      ok: false,
      status: 403,
      error: 'The assistant is read-only. An administrator has not enabled actions in Administration → Integrations.',
    };
  }
  return executeAction(user, token);
}

// The provider's own words, without the key. The SDK never puts the key in an
// error message, but the message is trimmed and the request body is not
// echoed, so nothing from the prompt escapes either.
function apiError(err) {
  if (!err) return 'The model did not answer.';
  // `Anthropic.AuthenticationError` and friends are statics on the default
  // export. If a future SDK moves them, `instanceof undefined` would THROW
  // from inside the error handler — which is how an API failure turns into a
  // process exit — so each one is checked for existence first and the status
  // code below is the fallback either way.
  const is = (Klass) => typeof Klass === 'function' && err instanceof Klass;
  if (is(Anthropic.AuthenticationError) || err.status === 401) return 'Anthropic rejected the API key (401). Check the key in Administration → Integrations.';
  if (is(Anthropic.PermissionDeniedError) || err.status === 403) return 'Anthropic refused this request (403). The key may not have access to that model.';
  if (is(Anthropic.RateLimitError) || err.status === 429) return 'Anthropic is rate-limiting this API key (429). Try again shortly.';
  if (is(Anthropic.NotFoundError) || err.status === 404) return 'Anthropic does not recognise that model id (404). Check the Model field in Integrations.';
  if (is(Anthropic.APIConnectionTimeoutError)) return 'The Anthropic API did not answer in time. Try a narrower question.';
  if (is(Anthropic.APIConnectionError)) return 'Could not reach the Anthropic API from this server.';
  const status = err.status ? `${err.status} ` : '';
  const message = String((err.error && err.error.error && err.error.error.message) || err.message || err).slice(0, 300);
  return `Anthropic API error ${status}— ${message}`.replace(/\s+/g, ' ').trim();
}

// What /api/ai/status and the Integrations screen show.
async function status(user) {
  const cfg = await agentConfig();
  const canAct = actionsEnabled(cfg);
  let actions = [];
  if (canAct && user) {
    // Only the actions THIS user could perform, so the panel's footer tells
    // them the truth rather than the licence.
    try {
      actions = (await writeToolDefinitions(user)).map((t) => t.name);
    } catch {
      actions = [];
    }
  }
  return {
    configured: cfg.configured,
    reason: cfg.configured ? null : cfg.reason,
    model: cfg.configured ? cfg.model : null,
    maxTokens: cfg.maxTokens,
    perHour: cfg.perHour,
    tools: toolDefinitions().map((t) => t.name),
    actionsEnabled: canAct,
    actions,
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
  CHANNEL, ask, act, status, testConnection, resetClient, agentConfig,
  // clientFor / rateCheck / apiError are exported so that other server-side AI
  // features (today: the weekly-idea screener in utils/ideaAi.js) reuse the
  // same key handling, the same cached client and the SAME per-user hourly
  // budget rather than opening a second one.
  clientFor, rateCheck, apiError,
  MAX_HISTORY_TURNS, MAX_TOOL_ITERATIONS,
};
