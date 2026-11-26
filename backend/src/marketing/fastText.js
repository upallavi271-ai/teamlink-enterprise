// ---------------------------------------------------------------------------
// AI MARKETING: THE FAST WRITER (2026-11-26). Owner: "why does AI Assist show 40 seconds? don't keep these all", then "yes, switch them" for the other writing buttons. The app's own model is one
// small model on this server's processor, shared with the WhatsApp assistant, so a few lines took 20 to 50 seconds or more. A writing task marked `fast` (marketing/ai.js generate) goes to
// Cloudflare Workers AI, the free text model, with the SAME account ID and token the free AI pictures already use (Administration > Integrations > AI Images, Cloudflare Workers AI): a few seconds.
// Nothing new to buy or to type in. With no Cloudflare card saved (or in the test sandbox) nothing changes: the app's own model is used as before. Writing and pictures share the free daily
// allowance of 10,000 "neurons" (a picture is about 104), so writing may use at most HALF of it; after that the app's own model writes until the next day (05:30 India time).
// Cloudflare states it does not train its models on what is sent. The token is only ever in the Authorization header, never logged. Fixed host.
// ---------------------------------------------------------------------------
const sandbox = require('../utils/sandbox');

const API = 'https://api.cloudflare.com/client/v4';
const MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
const SHORT = MODEL.split('/').pop();
const LIMIT_MS = 12000; // a short task: longer than this and the caller moves on (a draft from the person's own words, or the app's own model)
// neurons per million tokens for this model (Cloudflare's price list, November 2026)
const IN_RATE = 24545; const OUT_RATE = 77273;
const SHARE = 5000; // the most writing may use in one of Cloudflare's days (they start at 00:00 UTC); the rest stays for pictures

const sandboxOnly = () => sandbox.isSandbox() && !sandbox.allowAi();
const config = () => require('./images').cloudflareText.config(); // eslint-disable-line global-require

// an estimate from the usage log (letters sent and received by this model today), 3 letters to a token to be on the safe side
async function usedToday(now = Date.now()) {
  const S = require('../outreach/store'); // eslint-disable-line global-require
  try {
    const row = (await S.q('SELECT SUM(inChars) AS i, SUM(outChars) AS o FROM "OmniMkAiUsage" WHERE provider = ? AND model = ? AND at >= ?', 'cloudflare', SHORT, Math.floor(now / 86400000) * 86400000))[0] || {};
    return Math.round(((S.num(row.i) / 3) * IN_RATE + (S.num(row.o) / 3) * OUT_RATE) / 1e6);
  } catch { return 0; }
}

async function status() {
  const no = (reason) => ({ ready: false, provider: 'cloudflare', model: SHORT, reason });
  if (sandboxOnly()) return no('The test sandbox makes no outside calls.');
  let c;
  try { c = await config(); } catch (e) { return no(e.message); }
  if (!c.key || !/^[a-f0-9]{32}$/i.test(c.account)) return no('The free Cloudflare card is not saved.');
  if ((await usedToday()) >= SHARE) return no('Writing has used its half of the free daily allowance; the rest is kept for pictures.');
  return { ready: true, provider: 'cloudflare', model: SHORT, reason: '' };
}

// line breaks and tabs written inside a quoted string, and a comma before a closing bracket: the usual ways a model's JSON is not quite JSON
function repair(text) {
  let out = ''; let inside = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inside) {
      if (ch === '\\') { out += ch + (text[i + 1] || ''); i += 1; continue; }
      if (ch === '"') inside = false;
      out += ch === '\n' ? '\\n' : ch === '\r' ? '' : ch === '\t' ? '\\t' : ch;
      continue;
    }
    if (ch === '"') inside = true;
    if (ch === ',' && /^\s*[}\]]/.test(text.slice(i + 1))) continue;
    out += ch;
  }
  return out;
}
// the model's words -> the object it was asked for. plain: the key that may take plain words when the task's answer is one piece of text; otherwise words that are not the object are no answer
function read(answer, plain = '') {
  if (answer && typeof answer === 'object') return answer;
  const body = String(answer || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const found = body.match(/\{[\s\S]*\}/);
  if (found) {
    for (const t of [found[0], repair(found[0])]) { try { return JSON.parse(t); } catch { /* the next way */ } }
  }
  if (!plain || !body || body.startsWith('{')) return null; // broken JSON is never shown to a person
  return { [plain]: body };
}

// -> the answer object; throws an AiMkError (plain words) when Cloudflare refuses, is out of its free allowance, is too slow or sends nothing usable
async function json(system, prompt, { ms = LIMIT_MS, maxTokens = 600, plain = '' } = {}) {
  const AI = require('./ai'); // eslint-disable-line global-require
  const c = await config();
  const j = await require('./images').cloudflareText.call(`${API}/accounts/${c.account}/ai/v1/chat/completions`, c.key, { // eslint-disable-line global-require
    model: MODEL, max_tokens: maxTokens, temperature: 0.4, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
  }, ms);
  const choice = j && Array.isArray(j.choices) && j.choices[0];
  const answer = (choice && choice.message && choice.message.content) || (j && j.result && j.result.response) || '';
  const out = read(answer, plain);
  if (!out) throw new AI.AiMkError('The AI did not write anything useful. Try again.', 502, 'unreadable');
  return out;
}

module.exports = { status, json, read, usedToday, MODEL, LIMIT_MS, SHARE };
