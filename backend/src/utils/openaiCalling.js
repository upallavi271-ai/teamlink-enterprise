// ---------------------------------------------------------------------------
// AI CALLING BRAIN ON OPENAI (founder 2026-11-24: "ai calling kosam open ai api key connect cheyali, integrations lo field add chey").
//
// The brain of a phone call (calling/brain.js) asks a language model ONCE per answer what the person meant and what to say before the next
// question. Until now that model was the Claude channel (Administration > Integrations > AI Assistant). This file adds OpenAI as the
// other choice:
//
//   * The key is typed in Administration > Integrations > "AI Calling brain (OpenAI)" and is stored ENCRYPTED by utils/integrationStore.js.
//     It never leaves this server: no response, error text or log line contains it.
//   * ONLY that field is read. There is deliberately NO fallback to an OPENAI_API_KEY in the server's .env: Green Start's AI Marketing
//     uses that variable for pictures, and a key put there for pictures must never silently move phone calls to OpenAI.
//   * When a key is saved, calls use OpenAI. When it is empty (or OpenAI refuses the key / has no credit, for 10 minutes), calls use
//     exactly what they used before. A slow or failed answer never stops a call: the brain gives back nothing and the fixed script goes on.
//
//   configured()   true when a key is saved and OpenAI has not just refused it
//   chatJson(...)  one structured-output chat answer -> the parsed JSON object (throws OpenAiError)
//   testConnection()  Integrations > Test connection: one tiny question
// ---------------------------------------------------------------------------
const { readConfig } = require('./integrationStore');

const CHANNEL = 'ai-calling-openai';
const KEY_LABEL = 'OpenAI API key';
const MODEL_LABEL = 'Model';
const DEFAULT_MODEL = 'gpt-4.1-mini'; // fast, supports structured output; the Model field can name any other chat model
const ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const CONFIG_CACHE_MS = 15000;
const REST_MS = 10 * 60 * 1000; // after "bad key" / "no credit" the calls skip OpenAI for this long

class OpenAiError extends Error {
  constructor(message, status = 0, code = '') { super(message); this.name = 'OpenAiError'; this.status = status; this.code = code; }
}

let cache = null; // { at, key, model }
let restUntil = 0;

async function settings() {
  if (cache && Date.now() - cache.at < CONFIG_CACHE_MS) return cache;
  let values = {}; let on = false;
  try { const c = await readConfig(CHANNEL); values = c.values || {}; on = !!(c.connected && c.enabled); } catch { values = {}; on = false; }
  // `on` = the channel is switched on (Save turns it on, "Turn off" / Disconnect turns it off; the saved key stays but is not used)
  cache = { at: Date.now(), key: String(values[KEY_LABEL] || '').trim(), model: String(values[MODEL_LABEL] || '').trim() || DEFAULT_MODEL, on };
  return cache;
}
function resetCache() { cache = null; restUntil = 0; }

// a key is saved, the channel is switched on, AND OpenAI has not just refused it
async function configured() {
  const s = await settings();
  return !!s.key && s.on && Date.now() >= restUntil;
}
const modelName = async () => (await settings()).model;

// never let a key (or anything shaped like one) into a message
const scrub = (t, key) => {
  let s = String(t || '');
  if (key) s = s.split(key).join('[key]');
  return s.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-…').slice(0, 300);
};

async function post(body, { timeoutMs }) {
  // TEST SANDBOX: no outside call unless TEST_ALLOW_AI=1 (utils/sandbox.js). A test copy of live data holds the REAL encrypted key and must never use it.
  const sb = require('./sandbox'); // eslint-disable-line global-require
  if (sb.isSandbox() && !sb.allowAi()) throw new OpenAiError(sb.aiRefusal(), 0, 'sandbox');
  const s = await settings();
  if (!s.key) throw new OpenAiError('No OpenAI key is saved.', 0, 'no_key');
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${s.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: s.model, ...body }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new OpenAiError(err && err.name === 'TimeoutError' ? 'OpenAI took too long to answer.' : `OpenAI could not be reached (${scrub(err && err.message, s.key)}).`, 0, 'network');
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const code = (data && data.error && (data.error.code || data.error.type)) || '';
    const detail = scrub(data && data.error && data.error.message, s.key);
    // a refused key or an empty account answers every call with an error: rest OpenAI a while instead of slowing every answer
    if (res.status === 401 || res.status === 403 || res.status === 402 || code === 'insufficient_quota') restUntil = Date.now() + REST_MS;
    throw new OpenAiError(detail || `OpenAI answered ${res.status}.`, res.status, String(code));
  }
  return { data, model: s.model };
}

// One answer in a fixed JSON shape (OpenAI "structured outputs"): -> the parsed object.
async function chatJson({ system, user, schema, name = 'answer', maxTokens = 600, timeoutMs = 2500 }) {
  const { data } = await post({
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    max_completion_tokens: maxTokens,
    response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } },
  }, { timeoutMs });
  const choice = data && data.choices && data.choices[0];
  const msg = choice && choice.message;
  if (!msg || msg.refusal || choice.finish_reason === 'length' || choice.finish_reason === 'content_filter' || typeof msg.content !== 'string') {
    throw new OpenAiError('OpenAI gave no usable answer.', 0, 'unusable');
  }
  try { return JSON.parse(msg.content); } catch { throw new OpenAiError('OpenAI answered in a shape that could not be read.', 0, 'unparsable'); }
}

// Integrations > Test connection: one tiny question with the saved key and model.
async function testConnection() {
  resetCache();
  const s = await settings();
  if (!s.key) return { ok: false, message: 'No key is saved yet. Paste an OpenAI API key (platform.openai.com > API keys).' };
  const t0 = Date.now();
  try {
    const { data, model } = await post({ messages: [{ role: 'user', content: 'Reply with the single word OK.' }], max_completion_tokens: 16 }, { timeoutMs: 15000 });
    const said = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (typeof said !== 'string') return { ok: false, message: `OpenAI (${s.model}) answered but not with text.` };
    return { ok: true, message: `OpenAI (${(data && data.model) || model}): OK in ${Date.now() - t0} ms. AI phone calls now use it.` };
  } catch (err) {
    const why = err.status === 401 ? 'OpenAI does not accept this key (401). Check it was pasted whole.'
      : err.status === 404 ? `OpenAI does not know the model "${s.model}". Change the Model field.`
        : err.code === 'insufficient_quota' || err.status === 429 ? `OpenAI says this account has no credit or is rate-limited (${err.status || err.code}).`
          : err.message;
    return { ok: false, message: why };
  }
}

module.exports = { CHANNEL, KEY_LABEL, MODEL_LABEL, DEFAULT_MODEL, OpenAiError, configured, modelName, chatJson, testConnection, resetCache };
