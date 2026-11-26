// ---------------------------------------------------------------------------
// AI MARKETING: THE FAST WRITER (2026-11-26). Owner: "why does AI Assist show 40 seconds? don't keep these all". The app's own model is one small model on this server's processor, shared with
// the WhatsApp assistant, so a few lines took 20 to 50 seconds or more. A short writing task marked `fast` (marketing/ai.js generate) now goes to Cloudflare Workers AI, the free text model, with the
// SAME account ID and token the free AI pictures already use (Administration > Integrations > AI Images, Cloudflare Workers AI): a few seconds. Nothing new to buy or to type in. With no Cloudflare
// card saved (or in the test sandbox) nothing changes: the app's own model is used as before. The text goes in the free daily allowance of 10,000 "neurons" that the pictures share (a draft is about
// 35; a picture about 104). Cloudflare states it does not train its models on what is sent. The token is only ever in the Authorization header, never logged. Fixed host.
// ---------------------------------------------------------------------------
const sandbox = require('../utils/sandbox');

const API = 'https://api.cloudflare.com/client/v4';
const MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
const LIMIT_MS = 12000; // longer than this and the caller moves on (a draft from the person's own words, or the app's own model)

const sandboxOnly = () => sandbox.isSandbox() && !sandbox.allowAi();
const config = () => require('./images').cloudflareText.config(); // eslint-disable-line global-require

async function status() {
  if (sandboxOnly()) return { ready: false, provider: 'cloudflare', model: MODEL, reason: 'The test sandbox makes no outside calls.' };
  let c;
  try { c = await config(); } catch (e) { return { ready: false, provider: 'cloudflare', model: MODEL, reason: e.message }; }
  const ready = !!(c.key && /^[a-f0-9]{32}$/i.test(c.account));
  return { ready, provider: 'cloudflare', model: MODEL.split('/').pop(), reason: ready ? '' : 'The free Cloudflare card is not saved.' };
}

// the model's words -> the object it was asked for, else the plain words as { idea } (the caller reads text in any shape)
function read(answer) {
  if (answer && typeof answer === 'object') return answer;
  const text = String(answer || '').trim();
  const body = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const found = body.match(/\{[\s\S]*\}/);
  if (found) { try { return JSON.parse(found[0]); } catch { /* see below */ } }
  const loose = body.match(/"idea"\s*:\s*"([\s\S]*?)"\s*\}\s*$/); // JSON written with real line breaks inside the words (not valid JSON): the words are still readable
  if (loose) return { idea: loose[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') };
  if (body.startsWith('{')) return null; // broken JSON is not shown to a person
  return body ? { idea: body } : null;
}

// -> the answer object; throws an AiMkError (plain words) when Cloudflare refuses, is out of its free allowance, is too slow or sends nothing
async function json(system, prompt, ms = LIMIT_MS) {
  const AI = require('./ai'); // eslint-disable-line global-require
  const c = await config();
  const j = await require('./images').cloudflareText.call(`${API}/accounts/${c.account}/ai/v1/chat/completions`, c.key, { // eslint-disable-line global-require
    model: MODEL, max_tokens: 600, temperature: 0.4, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
  }, ms);
  const choice = j && Array.isArray(j.choices) && j.choices[0];
  const answer = (choice && choice.message && choice.message.content) || (j && j.result && j.result.response) || '';
  const out = read(answer);
  if (!out) throw new AI.AiMkError('The AI did not write anything useful. Try again.', 502, 'unreadable');
  return out;
}

module.exports = { status, json, read, MODEL, LIMIT_MS };
