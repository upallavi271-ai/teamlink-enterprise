// ---------------------------------------------------------------------------
// The Anthropic Claude channel — credentials, client and cost guard.
//
// This file no longer runs a conversation. The AI Assistant and Agent talk to
// a model through utils/ai.js, which uses the local Ollama server by default
// and Claude when AI_PROVIDER=claude; utils/ideaAi.js (the weekly-idea
// screener) calls Claude directly. Both get their key, their client and their
// per-user budget from here, so there is exactly one place that reads the
// credential.
//
// THE KEY NEVER LEAVES THE SERVER. It is entered in Administration →
// Integrations, encrypted at rest by utils/secrets.js, decrypted here, and
// used here. No response body, no log line and no frontend bundle contains
// it.
//
// NOT CONFIGURED IS A FIRST-CLASS STATE. With no key (or a key this server
// cannot decrypt) agentConfig() says so in plain words and never throws.
// ---------------------------------------------------------------------------

const AnthropicModule = require('@anthropic-ai/sdk');

const Anthropic = AnthropicModule.default || AnthropicModule;
const { readConfig } = require('./integrationStore');
const { ENV_VAR } = require('./secrets');

const CHANNEL = 'ai-claude';

// Defaults. The Integrations screen can override the model, the answer cap and
// the per-user hourly limit; the burst guard is fixed because it is a safety
// rail rather than configuration.
const DEFAULT_MODEL = 'claude-opus-5';
const DEFAULT_MAX_TOKENS = 1500;
const DEFAULT_PER_HOUR = 30;
// A short burst guard on top of the hourly cap.
const PER_MINUTE = 6;

function num(value, fallback) {
  const n = Number(String(value == null ? '' : value).trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// --- Configuration ---------------------------------------------------------
// Never throws. A credential store that cannot be read is an UNCONFIGURED
// channel, not a 500.
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
      configured: false,
      reason: `The AI configuration could not be read: ${String((err && err.message) || err).slice(0, 200)}`,
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
    configured: problems.length === 0,
    reason: problems.join(' '),
  };
}

let cachedClient = null; // { key, client }

function clientFor(apiKey) {
  // TEST SANDBOX: no Anthropic call unless TEST_ALLOW_AI=1 (utils/sandbox.js).
  const sb = require('./sandbox');
  if (sb.isSandbox() && !sb.allowAi()) {
    return { messages: { create: async () => { throw new Error(sb.aiRefusal()); } } };
  }
  if (cachedClient && cachedClient.key === apiKey) return cachedClient.client;
  cachedClient = { key: apiKey, client: withCreditHold(apiKey, new Anthropic({ apiKey, maxRetries: 1, timeout: 120000 })) };
  return cachedClient.client;
}

// --- Out of credits ----------------------------------------------------------
// Anthropic answers 400 "Your credit balance is too low…" when the ACCOUNT has
// no prepaid credits — the key itself is fine. Once that answer comes back,
// further calls with the same key fail at once with the same plain message for
// CREDIT_HOLD_MS instead of each one making another doomed round trip (every
// weekly idea, every assistant question). The Integrations "Test" button
// always clears the hold first, so it is the live check after buying credits.
// Only a hash of the key is kept here.
const CREDIT_HOLD_MS = 10 * 60 * 1000;
const NO_CREDITS = 'The Anthropic account has no API credits left (Anthropic: "credit balance is too low"). The API key is fine — buy credits at console.anthropic.com → Plans & Billing, then press Test on Administration → Integrations → AI Assistant.';
let creditHold = null; // { keyHash, until }
const holdHash = (key) => require('crypto').createHash('sha256').update(String(key)).digest('hex');

function isCreditError(err) {
  if (!err || (err.status !== 400 && err.status !== 402)) return false;
  const msg = String((err.error && err.error.error && err.error.error.message) || err.message || '');
  return /credit balance is too low|purchase credits/i.test(msg);
}

function creditHeld(apiKey) {
  return !!(creditHold && creditHold.keyHash === holdHash(apiKey) && Date.now() < creditHold.until);
}

function clearCreditHold() { creditHold = null; }

function withCreditHold(apiKey, client) {
  return {
    messages: {
      create: async (...args) => {
        if (creditHeld(apiKey)) {
          const err = new Error(NO_CREDITS);
          err.status = 400;
          err.creditHold = true;
          throw err;
        }
        try {
          const r = await client.messages.create(...args);
          creditHold = null;
          return r;
        } catch (err) {
          if (isCreditError(err)) creditHold = { keyHash: holdHash(apiKey), until: Date.now() + CREDIT_HOLD_MS };
          throw err;
        }
      },
    },
  };
}

function resetClient() { cachedClient = null; }

// --- Rate limiting ---------------------------------------------------------
// In memory, per process, per user. Deliberately not a table: it is a cost
// guard on a single-process app, and a restart losing it is not a problem.
const hits = new Map(); // userId -> number[] (timestamps)

function resetRateLimits() { hits.clear(); }

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

// The provider's own words, without the key. The SDK never puts the key in an
// error message, but the message is trimmed and the request body is not
// echoed, so nothing from the prompt escapes either.
function apiError(err) {
  if (!err) return 'The model did not answer.';
  // Each error class is checked for existence first: `instanceof undefined`
  // would THROW from inside the error handler.
  const is = (Klass) => typeof Klass === 'function' && err instanceof Klass;
  if (err.creditHold || isCreditError(err)) return NO_CREDITS;
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

// The Integrations "Test" button: a one-token round trip that proves the key
// and the model id, and reports the provider's real error otherwise.
async function testConnection() {
  const cfg = await agentConfig();
  if (!cfg.configured) return { ok: false, notConfigured: true, error: cfg.reason };
  // Test is the live check after buying credits — never answered from the hold.
  clearCreditHold();
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
  CHANNEL, agentConfig, testConnection, resetClient,
  // clientFor / rateCheck / apiError are shared with utils/ai.js and
  // utils/ideaAi.js, so every AI feature uses the same key handling, the same
  // cached client and the SAME per-user hourly budget.
  clientFor, rateCheck, resetRateLimits, apiError,
  // Out-of-credits hold (additive): utils/ai.js greys the status dot with it.
  creditHeld, clearCreditHold, NO_CREDITS,
};
