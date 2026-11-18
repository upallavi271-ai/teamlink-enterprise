// ---------------------------------------------------------------------------
// FAST AI (2026-11-18) — quick answers for the CRM Agent, the CRM Meeting Agent and the BDE Agent.
//
// The app's own provider (utils/ai.js) is the local Ollama model or Claude. Ollama on a CPU takes minutes for a first question, and Claude
// costs money, so the three agents ask a FREE, FAST hosted model first, in this order, and move to the next one on a rate limit, an error
// or a slow answer:
//
//   1. Groq        free plan, no card, very fast (OpenAI-compatible)      console.groq.com  > API Keys
//   2. Gemini      Google AI Studio free tier (Flash models)              aistudio.google.com > Get API key
//   3. OpenRouter  the ":free" models                                     openrouter.ai > Keys
//   4. the app's own provider (utils/ai.js: Ollama or Claude), so an agent still answers when no key is saved.
//
// The keys are typed in Administration → Integrations → "Fast AI (free · Groq / Gemini / OpenRouter)" and are stored encrypted by
// utils/integrationStore.js; GROQ_API_KEY / GEMINI_API_KEY / OPENROUTER_API_KEY in backend/.env work too. A key never leaves this process:
// no error message, response or log line contains it.
//
// ACCURACY is the caller's job and is done the same way in all three agents: the model only ever sees a FACTS block built from the
// asking user's own scoped data, is told to answer from it alone, and runs at a low temperature.
// ---------------------------------------------------------------------------

const { readConfig } = require('./integrationStore');

const CHANNEL = 'ai-fast';
const CONFIG_CACHE_MS = 15000;

const PROVIDERS = [
  { id: 'groq', name: 'Groq', url: 'https://api.groq.com/openai/v1/chat/completions', keyLabel: 'Groq API key', modelLabel: 'Groq model', env: 'GROQ_API_KEY', model: 'llama-3.3-70b-versatile', backupModel: 'llama-3.1-8b-instant' },
  { id: 'gemini', name: 'Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', keyLabel: 'Gemini API key', modelLabel: 'Gemini model', env: 'GEMINI_API_KEY', model: 'gemini-2.5-flash' },
  { id: 'openrouter', name: 'OpenRouter', url: 'https://openrouter.ai/api/v1/chat/completions', keyLabel: 'OpenRouter API key', modelLabel: 'OpenRouter model', env: 'OPENROUTER_API_KEY', model: 'meta-llama/llama-3.3-70b-instruct:free' },
];

let cache = null; // { at, list }
// A provider that answered 429 / 401 rests for a while instead of being asked (and failing) on every question.
const resting = new Map(); // id -> until (ms)

async function providerList() {
  if (cache && Date.now() - cache.at < CONFIG_CACHE_MS) return cache.list;
  let values = {};
  try { values = (await readConfig(CHANNEL)).values || {}; } catch { values = {}; }
  const list = PROVIDERS.map((p) => {
    const key = String(values[p.keyLabel] || process.env[p.env] || '').trim();
    const model = String(values[p.modelLabel] || '').trim() || p.model;
    return { ...p, key, model };
  }).filter((p) => p.key);
  cache = { at: Date.now(), list };
  return list;
}

function resetCache() { cache = null; resting.clear(); }

function cleanHistory(history) {
  return (Array.isArray(history) ? history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
}

class FastAiError extends Error {
  constructor(message, status = 503) { super(message); this.name = 'FastAiError'; this.status = status; }
}

async function callProvider(p, model, system, history, { maxTokens, temperature, json, timeoutMs }) {
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${p.key}` };
  if (p.id === 'openrouter') { headers['HTTP-Referer'] = 'https://teamlink.teamlinks.in'; headers['X-Title'] = 'TeamLink'; }
  const body = {
    model,
    temperature,
    max_tokens: maxTokens,
    messages: [{ role: 'system', content: system }, ...cleanHistory(history)],
    ...(json ? { response_format: { type: 'json_object' } } : {}),
  };
  const res = await fetch(p.url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`${p.name} ${res.status}`);
    err.status = res.status;
    err.detail = String((data && data.error && (data.error.message || data.error)) || '').slice(0, 200).replace(/(gsk_|AIza|sk-or-)[A-Za-z0-9_-]+/g, '[key]');
    throw err;
  }
  const text = String((((data.choices || [])[0] || {}).message || {}).content || '').trim();
  if (!text) { const err = new Error(`${p.name} empty answer`); err.status = 502; throw err; }
  return text;
}

// chat(system, history, opts) -> { text, provider, model, ms }
// opts: maxTokens (default 700), temperature (default 0.1), json (ask for one JSON object), timeoutMs per provider (default 20 s),
//       fallbackToApp (default true): when every free provider fails, ask utils/ai.js (Ollama / Claude).
async function chat(system, history, opts = {}) {
  if (require('./viewAs').isViewingAs()) throw new FastAiError('The AI agents are switched off while you are viewing as someone (read-only).', 403); // eslint-disable-line global-require
  const maxTokens = Math.min(Math.max(Number(opts.maxTokens) || 700, 64), 4000);
  const temperature = opts.temperature != null ? Number(opts.temperature) : 0.1;
  const timeoutMs = Number(opts.timeoutMs) || 20000;
  const tried = [];
  const list = await providerList();
  for (const p of list) {
    if ((resting.get(p.id) || 0) > Date.now()) { tried.push(`${p.name}: resting`); continue; }
    const models = [p.model, ...(p.backupModel && p.backupModel !== p.model ? [p.backupModel] : [])];
    for (const model of models) {
      const t0 = Date.now();
      try {
        const text = await callProvider(p, model, system, history, { maxTokens, temperature, json: !!opts.json, timeoutMs });
        return { text, provider: p.name, model, ms: Date.now() - t0 };
      } catch (err) {
        tried.push(`${p.name}/${model}: ${err.status || (err.name === 'TimeoutError' ? 'timeout' : 'error')}`);
        if (err.status === 401 || err.status === 403) { resting.set(p.id, Date.now() + 10 * 60000); break; } // a bad key: the other model will not help
        if (err.status === 429) { resting.set(p.id, Date.now() + 60000); break; }
        // 400 / 404 (model name not offered any more) or 5xx / timeout: try the backup model, then the next provider
      }
    }
  }
  if (opts.fallbackToApp === false) throw new FastAiError(`No fast AI answered (${tried.join('; ') || 'no key saved'}).`);
  const ai = require('./ai'); // eslint-disable-line global-require
  const t0 = Date.now();
  const meta = {};
  try {
    const text = await ai.chat(system, cleanHistory(history), { meta, maxTokens, timeoutMs: Number(opts.appTimeoutMs) || 120000, waitMs: 5000 });
    return { text, provider: meta.provider === 'claude' ? 'Claude' : 'Local AI', model: meta.model || null, ms: Date.now() - t0 };
  } catch (err) {
    const none = !list.length;
    throw new FastAiError(none
      ? `No AI is set up yet. Add a free Groq key in Administration → Integrations → Fast AI (takes a minute: console.groq.com → API Keys). ${err.message || ''}`.trim()
      : `The AI could not answer right now (${tried.join('; ')}). ${err.message || ''}`.trim(), err.status || 503);
  }
}

async function status() {
  const list = await providerList();
  const app = await require('./ai').checkStatus().catch(() => ({ available: false })); // eslint-disable-line global-require
  return {
    fast: list.map((p) => ({ provider: p.name, model: p.model, resting: (resting.get(p.id) || 0) > Date.now() })),
    fastReady: list.length > 0,
    appProvider: app && app.available ? (app.provider === 'claude' ? 'Claude' : 'Local AI') : null,
    ready: list.length > 0 || !!(app && app.available),
  };
}

// Integrations → Test connection: one tiny question to each saved provider.
async function testConnection() {
  resetCache();
  const list = await providerList();
  if (!list.length) return { ok: false, message: 'No key saved yet. Paste a free Groq key (console.groq.com → API Keys).' };
  const lines = [];
  let ok = false;
  for (const p of list) {
    const t0 = Date.now();
    try {
      await callProvider(p, p.model, 'Reply with the single word OK.', [{ role: 'user', content: 'Say OK' }], { maxTokens: 5, temperature: 0, json: false, timeoutMs: 15000 });
      ok = true;
      lines.push(`${p.name} (${p.model}): OK in ${Date.now() - t0} ms`);
    } catch (err) {
      lines.push(`${p.name} (${p.model}): failed — ${err.status || err.name}${err.detail ? ` ${err.detail}` : ''}`);
    }
  }
  return { ok, message: lines.join(' · ') };
}

module.exports = { chat, status, testConnection, resetCache, FastAiError, CHANNEL, PROVIDERS };
