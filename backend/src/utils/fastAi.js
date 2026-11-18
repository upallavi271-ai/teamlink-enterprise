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

// THE MODEL NAMES CHANGE (2026-11-18: the live CRM Agent fell back to the local AI): when the saved / default model is refused (400 / 404),
// the provider's own model list (GET <base>/models) is read and the first of these that it offers is used, else any chat model it offers.
const PREFERRED = {
  groq: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'meta-llama/llama-4-maverick-17b-128e-instruct', 'qwen/qwen3-32b', 'moonshotai/kimi-k2-instruct', 'openai/gpt-oss-20b', 'meta-llama/llama-4-scout-17b-16e-instruct', 'llama-3.1-8b-instant'],
  gemini: ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'],
  openrouter: ['meta-llama/llama-3.3-70b-instruct:free', 'openai/gpt-oss-120b:free', 'qwen/qwen3-235b-a22b:free', 'google/gemini-2.0-flash-exp:free'],
};
const NOT_CHAT = /whisper|tts|guard|embed|playai|distil|orpheus|image|vision-preview|audio|transcri|moderation|compound/i;
const modelLists = new Map(); // provider id -> { at, ids }
async function availableModels(p) {
  const hit = modelLists.get(p.id);
  if (hit && Date.now() - hit.at < 6 * 3600000) return hit.ids;
  const base = p.url.replace(/\/chat\/completions$/, '');
  const res = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${p.key}` }, signal: AbortSignal.timeout(10000) });
  const data = await res.json().catch(() => ({}));
  const ids = ((data && data.data) || []).map((m) => String(m.id || '').replace(/^models\//, '')).filter(Boolean);
  if (ids.length) modelLists.set(p.id, { at: Date.now(), ids });
  return ids;
}
async function pickModel(p, tried) {
  let ids = [];
  try { ids = await availableModels(p); } catch { return null; }
  const pref = (PREFERRED[p.id] || []).find((m) => ids.includes(m) && !tried.includes(m));
  if (pref) return pref;
  const any = ids.filter((m) => !NOT_CHAT.test(m) && !tried.includes(m) && (p.id !== 'openrouter' || m.endsWith(':free')));
  return any[0] || null;
}

let cache = null; // { at, list }
// A provider that answered 429 / 401 rests for a while instead of being asked (and failing) on every question.
const resting = new Map(); // id -> until (ms)
const workingModel = new Map(); // id -> the model that last answered (asked first next time)
const lastErrors = new Map(); // id -> { at, model, status, detail } for the Integrations test and the status

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
    err.retryAfter = Number(res.headers.get('retry-after')) || 0; // seconds (Groq says how long the free limit needs)
    err.detail = String((data && data.error && (data.error.message || data.error)) || '').slice(0, 200).replace(/(gsk_|AIza|sk-or-)[A-Za-z0-9_-]+/g, '[key]');
    throw err;
  }
  const text = String((((data.choices || [])[0] || {}).message || {}).content || '').trim();
  if (!text) { const err = new Error(`${p.name} empty answer`); err.status = 502; throw err; }
  return text;
}

// chat(system, history, opts) -> { text, provider, model, ms, note }
// opts: maxTokens (default 700), temperature (default 0.1), json (ask for one JSON object), timeoutMs per try (default 20 s),
//       fallbackToApp (default true): when every free provider fails, ask utils/ai.js (Ollama / Claude) with the time that is left,
//       deadlineMs (default 40 s): the WHOLE call, tries, waits and fallback together - the web server gives up at 60 s and shows a
//       bare "took too long", so the agents always answer (or say plainly why not) before that.
// A free-plan limit (429): the wait the provider names (at most 8 s) and one more try, then the provider's smaller backup model (its own
// limit bucket), then the next provider. Only then does the provider rest, for as long as it asked.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function chat(system, history, opts = {}) {
  if (require('./viewAs').isViewingAs()) throw new FastAiError('The AI agents are switched off while you are viewing as someone (read-only).', 403); // eslint-disable-line global-require
  const maxTokens = Math.min(Math.max(Number(opts.maxTokens) || 700, 64), 4000);
  const temperature = opts.temperature != null ? Number(opts.temperature) : 0.1;
  const timeoutMs = Number(opts.timeoutMs) || 20000;
  const deadline = Date.now() + (Number(opts.deadlineMs) || 40000);
  const left = () => deadline - Date.now();
  const tried = [];
  const list = await providerList();
  for (const p of list) {
    if ((resting.get(p.id) || 0) > Date.now()) {
      const wait = resting.get(p.id) - Date.now();
      if (wait <= 8000 && left() > wait + 12000) await sleep(wait + 100); // a short rest: wait it out rather than fall to a slow model
      else { tried.push(`${p.name}: resting`); continue; } // eslint-disable-line no-continue
    }
    if (left() < 4000) break;
    const usedModels = [];
    let model = (workingModel.get(p.id)) || p.model;
    let waited = false;
    for (let attempt = 0; attempt < 4 && model && left() >= 4000; attempt += 1) {
      if (!usedModels.includes(model)) usedModels.push(model);
      const t0 = Date.now();
      try {
        const text = await callProvider(p, model, system, history, { maxTokens, temperature, json: !!opts.json, timeoutMs: Math.min(timeoutMs, left()) });
        workingModel.set(p.id, model);
        return { text, provider: p.name, model, ms: Date.now() - t0, note: tried.length ? tried.join(', ') : '' };
      } catch (err) {
        tried.push(`${p.name} ${err.status || (err.name === 'TimeoutError' ? 'timeout' : 'error')}`);
        lastErrors.set(p.id, { at: Date.now(), model, status: err.status || err.name, detail: err.detail || '' });
        if (err.status === 401 || err.status === 403) { resting.set(p.id, Date.now() + 10 * 60000); break; } // a bad key: another model will not help
        if (err.status === 429) {
          const ra = Math.min(Math.max(err.retryAfter || 0, 0), 60);
          if (!waited && ra > 0 && ra <= 8 && left() > ra * 1000 + 8000) { waited = true; await sleep(ra * 1000 + 200); continue; } // eslint-disable-line no-continue
          const backup = p.backupModel && !usedModels.includes(p.backupModel) ? p.backupModel : null;
          if (backup) { model = backup; continue; } // eslint-disable-line no-continue
          resting.set(p.id, Date.now() + Math.max(ra, 10) * 1000);
          break;
        }
        if (workingModel.get(p.id) === model) workingModel.delete(p.id);
        // 400 / 404 = the model name is not offered (any more): ask the provider which models it has; 5xx / timeout: its backup model
        if (err.status === 400 || err.status === 404) model = await pickModel(p, usedModels);
        else model = p.backupModel && !usedModels.includes(p.backupModel) ? p.backupModel : null;
      }
    }
  }
  const note = tried.length ? tried.join(', ') : (list.length ? '' : 'no fast AI key');
  if (opts.fallbackToApp === false) throw new FastAiError(`No fast AI answered (${tried.join('; ') || 'no key saved'}).`);
  // the app's own AI (Ollama / Claude) only with the time that is left; a slow local model must never run into the web server's 60 s
  if (left() < 12000) {
    throw new FastAiError(`The free AI is busy right now (${tried.join(', ') || 'no answer'}), and the local AI would be too slow. Wait about a minute and ask again, or ask a shorter question.`, 503);
  }
  const ai = require('./ai'); // eslint-disable-line global-require
  const t0 = Date.now();
  const meta = {};
  try {
    const text = await ai.chat(system, cleanHistory(history), { meta, maxTokens, timeoutMs: Math.min(Number(opts.appTimeoutMs) || 120000, left() - 2000), waitMs: 3000 });
    // why the free fast AI did not answer, shown small under the answer ("Groq 401" = the key, "Groq 429" = busy, no note = no key saved)
    return { text, provider: meta.provider === 'claude' ? 'Claude' : 'Local AI', model: meta.model || null, ms: Date.now() - t0, note };
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
    const usedModels = [];
    let model = p.model;
    let done = false;
    for (let attempt = 0; attempt < 3 && model && !done; attempt += 1) {
      usedModels.push(model);
      const t0 = Date.now();
      try {
        await callProvider(p, model, 'Reply with the single word OK.', [{ role: 'user', content: 'Say OK' }], { maxTokens: 5, temperature: 0, json: false, timeoutMs: 15000 });
        ok = true; done = true;
        workingModel.set(p.id, model);
        lines.push(`${p.name} (${model}): OK in ${Date.now() - t0} ms${model !== p.model ? ` - "${p.model}" is not offered any more, ${model} is used instead` : ''}`);
      } catch (err) {
        if ((err.status === 400 || err.status === 404) && attempt < 2) { model = await pickModel(p, usedModels); if (model) continue; } // eslint-disable-line no-continue
        lines.push(`${p.name} (${model}): failed — ${err.status || err.name}${err.detail ? ` ${err.detail}` : ''}`);
        done = true;
      }
    }
  }
  return { ok, message: lines.join(' · ') };
}

// true when at least one free fast AI key is saved (the resume parser's AI pass runs only then, utils/resumeParse.js)
async function hasKey() { return (await providerList()).length > 0; }

module.exports = { chat, status, testConnection, resetCache, hasKey, FastAiError, CHANNEL, PROVIDERS };
