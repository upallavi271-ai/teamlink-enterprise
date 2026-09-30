// ---------------------------------------------------------------------------
// THE ONE PLACE THAT TALKS TO A LANGUAGE MODEL.
//
// Everything else — the Assistant (/api/assistant) and the Agent (/api/agent)
// — calls chat(), chatJson() and checkStatus() below and never knows which
// model answered. Two providers sit behind this wrapper:
//
//   ollama  (DEFAULT) a local Ollama server. No key, no per-request cost.
//           OLLAMA_BASE_URL  default http://localhost:11434
//           OLLAMA_MODEL     default llama3.2:3b
//           OLLAMA_NUM_CTX   default 8192 — Ollama's own default context is
//                            tiny, and the FACTS block alone would overflow it
//   claude  Anthropic Claude, through the official SDK. The key is the one
//           entered in Administration → Integrations → AI Assistant, read
//           through utils/aiAgent.js agentConfig() — the same encrypted
//           credential the weekly-idea screener uses.
//
// Switch with AI_PROVIDER=ollama|claude in backend/.env (default ollama).
//
// THE KEY NEVER LEAVES THIS PROCESS. No error message, status payload or log
// line below contains it.
//
// NEVER CRASHES AT IMPORT. Nothing here touches the network until a request
// asks it to, and a model server that is down is ONE plain message
// ("Local AI is not running — start Ollama and try again"), not a raw
// ECONNREFUSED stack.
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { agentConfig, clientFor, apiError } = require('./aiAgent');

const OLLAMA_OFFLINE = 'Local AI is not running — start Ollama and try again.';
// A small CPU-only model reads a long prompt slowly — on an older laptop CPU
// llama3.2:3b evaluates roughly 7 prompt tokens a second, so the FIRST
// question of a conversation can take minutes. Ollama then keeps the prompt
// prefix cached, and follow-ups are quick. OLLAMA_TIMEOUT_MS overrides.
function chatTimeoutMs() {
  const n = Number(process.env.OLLAMA_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 10000 ? n : 600000;
}
const STATUS_TIMEOUT_MS = 3000;
const STATUS_CACHE_MS = 15000;
const CLAUDE_MAX_TOKENS = 1024;

// An error the routes can show as-is: `status` is the HTTP code to answer with.
class AiError extends Error {
  constructor(message, status = 503, code = 'unavailable') {
    super(message);
    this.name = 'AiError';
    this.status = status;
    this.code = code;
  }
}

function provider() {
  return String(process.env.AI_PROVIDER || 'ollama').trim().toLowerCase() === 'claude' ? 'claude' : 'ollama';
}

function ollamaBase() {
  return String(process.env.OLLAMA_BASE_URL || 'http://localhost:11434').trim().replace(/\/+$/, '');
}

function ollamaModel() {
  return String(process.env.OLLAMA_MODEL || 'llama3.2:3b').trim();
}

function ollamaNumCtx() {
  const n = Number(process.env.OLLAMA_NUM_CTX);
  return Number.isFinite(n) && n >= 2048 ? Math.floor(n) : 8192;
}

// History arrives already sanitised by the routes; this is the last guard,
// so a malformed turn can never reach a provider.
function cleanHistory(history) {
  return (Array.isArray(history) ? history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content }));
}

// "```json { … } ```" or prose around the object — take the object.
function parseJsonLoose(text) {
  let s = String(text == null ? '' : text).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try {
    return JSON.parse(s);
  } catch {
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try { return JSON.parse(s.slice(first, last + 1)); } catch { return null; }
    }
    return null;
  }
}

const CLARIFY_UNREADABLE = {
  action: 'clarify',
  params: {},
  summary: 'Sorry, I did not quite get that. Could you say it again, with the details (who, what and when)?',
};

// --- Ollama ----------------------------------------------------------------
// A plain node:http POST rather than fetch(): fetch (undici) gives up on any
// response whose headers take longer than five minutes, and with stream:false
// Ollama sends no headers until the whole answer is ready. This waits exactly
// as long as chatTimeoutMs() says, and no longer.
function postJson(url, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = Buffer.from(JSON.stringify(payload));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      headers: { 'content-type': 'application/json', 'content-length': body.length },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let data = {};
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { data = {}; }
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data });
      });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => {
      const err = new Error('timeout');
      err.name = 'TimeoutError';
      req.destroy(err);
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function ollamaChat(systemPrompt, history, { json = false } = {}) {
  const model = ollamaModel();
  let res;
  try {
    res = await postJson(`${ollamaBase()}/api/chat`, {
      model,
      stream: false,
      ...(json ? { format: 'json' } : {}),
      // Low temperature: these answers are read off a facts block, and the
      // agent's plan is a JSON object, not prose. Nothing here wants flair.
      options: { num_ctx: ollamaNumCtx(), temperature: json ? 0 : 0.2 },
      keep_alive: '30m',
      messages: [{ role: 'system', content: systemPrompt }, ...cleanHistory(history)],
    }, chatTimeoutMs());
  } catch (err) {
    if (err && err.name === 'TimeoutError') {
      throw new AiError('The local AI took too long to answer. Try again — a follow-up is much quicker than the first question.', 504, 'timeout');
    }
    // ECONNREFUSED and friends: the server is not there.
    throw new AiError(OLLAMA_OFFLINE, 503, 'offline');
  }
  const { data } = res;
  if (!res.ok) {
    const msg = String((data && data.error) || '');
    if (res.status === 404 || /not found/i.test(msg)) {
      throw new AiError(`The local AI model "${model}" is not installed. Run: ollama pull ${model}`, 503, 'model_missing');
    }
    throw new AiError(`The local AI could not answer (${res.status}${msg ? `: ${msg.slice(0, 200)}` : ''}).`, 502, 'provider');
  }
  return String((data && data.message && data.message.content) || '').trim();
}

async function ollamaStatus() {
  const model = ollamaModel();
  try {
    const res = await fetch(`${ollamaBase()}/api/tags`, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
    if (!res.ok) return { provider: 'ollama', available: false, modelPulled: false, model, reason: OLLAMA_OFFLINE };
    const data = await res.json().catch(() => ({}));
    const names = ((data && data.models) || []).map((m) => String(m.name || m.model || ''));
    // "llama3.2:3b" is listed as itself; a bare "llama3.2" is listed as ":latest".
    const wanted = model.includes(':') ? [model] : [model, `${model}:latest`];
    const modelPulled = names.some((n) => wanted.includes(n));
    return {
      provider: 'ollama',
      available: true,
      modelPulled,
      model,
      reason: modelPulled ? null : `The model "${model}" is not installed yet. Run: ollama pull ${model}`,
    };
  } catch {
    return { provider: 'ollama', available: false, modelPulled: false, model, reason: OLLAMA_OFFLINE };
  }
}

// --- Claude ------------------------------------------------------------------
// The Messages API wants the conversation to start with the user and to
// alternate; the sanitised history can break either rule, so fold it.
function claudeMessages(history) {
  const out = [];
  cleanHistory(history).forEach((m) => {
    if (!out.length && m.role !== 'user') return;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content = `${last.content}\n\n${m.content}`;
    else out.push({ role: m.role, content: m.content });
  });
  return out;
}

// A key Anthropic has refused (401) is remembered by fingerprint, so the
// status dot goes grey and later questions get "not configured" at once
// instead of another failed round trip. Re-entering the key changes the
// fingerprint and clears it. Only the hash is kept, never the key.
let rejectedKeyHash = null;
const keyHash = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');
const KEY_REJECTED = 'Anthropic rejected the stored API key — re-enter it in Administration → Integrations → AI Assistant.';

async function claudeConfig() {
  const cfg = await agentConfig();
  if (!cfg.configured) {
    throw new AiError(
      `Claude is not configured${cfg.reason ? ` — ${cfg.reason}` : '.'} Add the Anthropic API key in Administration → Integrations → AI Assistant, or set AI_PROVIDER=ollama.`,
      503,
      'not_configured',
    );
  }
  if (rejectedKeyHash && rejectedKeyHash === keyHash(cfg.apiKey)) {
    throw new AiError(`Claude is not configured — ${KEY_REJECTED}`, 503, 'not_configured');
  }
  return cfg;
}

async function claudeChat(systemPrompt, history, { json = false } = {}) {
  const cfg = await claudeConfig();
  const messages = claudeMessages(history);
  if (!messages.length) throw new AiError('Ask a question first.', 400, 'empty');
  const system = json
    ? `${systemPrompt}\n\nRespond with a single JSON object and nothing else — no prose, no code fence.`
    : systemPrompt;
  let response;
  try {
    response = await clientFor(cfg.apiKey).messages.create({
      model: cfg.model,
      max_tokens: Math.min(cfg.maxTokens || CLAUDE_MAX_TOKENS, 4000),
      system,
      messages,
    });
  } catch (err) {
    if (err && err.status === 401) {
      rejectedKeyHash = keyHash(cfg.apiKey);
      statusCache = null;
      throw new AiError(`Claude is not configured — ${KEY_REJECTED}`, 503, 'not_configured');
    }
    // apiError() words the provider's failure without the key or the prompt.
    throw new AiError(apiError(err), 502, 'provider');
  }
  if (response && response.stop_reason === 'refusal') {
    throw new AiError('The model declined to answer that.', 502, 'refusal');
  }
  return ((response && response.content) || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

async function claudeStatus() {
  // Configuration only — no network round trip, so a tab polling the status
  // dot never costs a token. The Integrations "Test" button does the live check.
  let cfg;
  try {
    cfg = await agentConfig();
  } catch {
    cfg = { configured: false, reason: 'The Claude configuration could not be read.' };
  }
  if (cfg.configured && rejectedKeyHash && rejectedKeyHash === keyHash(cfg.apiKey)) {
    cfg = { ...cfg, configured: false, reason: KEY_REJECTED };
  }
  return {
    provider: 'claude',
    available: !!cfg.configured,
    modelPulled: !!cfg.configured,
    model: cfg.model || 'claude-opus-5',
    reason: cfg.configured ? null : `Claude is not configured. ${cfg.reason || ''} Add the Anthropic API key in Administration → Integrations → AI Assistant.`.trim(),
  };
}

// --- The public surface ------------------------------------------------------

// Super Admin "View as" is read-only and must not spend model tokens
// (utils/viewAs.js). Lazy require: no load-order coupling.
function refuseWhileViewingAs() {
  if (require('./viewAs').isViewingAs()) {
    throw new AiError('The AI Assistant is switched off while you are viewing as someone (read-only).', 403, 'view_as');
  }
}

// Plain text reply.
async function chat(systemPrompt, history) {
  refuseWhileViewingAs();
  return provider() === 'claude'
    ? claudeChat(systemPrompt, history)
    : ollamaChat(systemPrompt, history);
}

// Parsed JSON. An unreadable reply is a clarify result, never a throw — the
// agent route validates whatever comes back against its allowlist anyway.
async function chatJson(systemPrompt, history) {
  refuseWhileViewingAs();
  const text = provider() === 'claude'
    ? await claudeChat(systemPrompt, history, { json: true })
    : await ollamaChat(systemPrompt, history, { json: true });
  const parsed = parseJsonLoose(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...CLARIFY_UNREADABLE };
  return parsed;
}

// { provider, available, modelPulled, model, reason } — cached, because every
// open tab polls it for the status dot.
let statusCache = null; // { at, provider, value }
async function checkStatus() {
  const which = provider();
  if (statusCache && statusCache.provider === which && Date.now() - statusCache.at < STATUS_CACHE_MS) {
    return statusCache.value;
  }
  const value = which === 'claude' ? await claudeStatus() : await ollamaStatus();
  statusCache = { at: Date.now(), provider: which, value };
  return value;
}

function resetStatusCache() { statusCache = null; }

module.exports = {
  chat, chatJson, checkStatus, resetStatusCache, provider, parseJsonLoose, AiError, OLLAMA_OFFLINE,
};
