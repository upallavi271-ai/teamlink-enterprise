// ---------------------------------------------------------------------------
// AI MARKETING: THE ONE SHARED AI LAYER for every marketing module (Omni-Channel > AI Marketing).
//   * Capability slots: text | image | video | audio. Only TEXT is built today (it wraps utils/ai.js: local Ollama, or Claude with the key an Admin entered
//     in Administration > Integrations > AI Assistant). image / video / audio say "not connected yet"; a later module registers a provider with register().
//   * TEXT providers: 'model' (utils/ai.js) and 'demo' (an offline sample writer, used ONLY in the test sandbox, where all AI calls are blocked). The demo
//     writer is clearly marked in every answer and in the screens. On live the demo writer is never used: if no real model is ready the screen says so.
//   * Every call is logged (table OmniMkAiUsage: who, module, task, provider, size, time, ok / error) and limited: a per-person daily limit and an optional
//     company monthly limit (Admin sets both in AI Marketing > AI usage). Nothing here sends or publishes anything.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const S = require('../outreach/store');
const sandbox = require('../utils/sandbox');
const Cfg = require('./settings');

class AiMkError extends Error {
  constructor(message, status = 400, code = 'ai_marketing') { super(message); this.name = 'AiMkError'; this.status = status; this.code = code; }
}

// ---- usage table ----------------------------------------------------------------------------------------------------------
const USAGE = 'OmniMkAiUsage';
const DDL = [
  `CREATE TABLE IF NOT EXISTS "${USAGE}" ("id" TEXT NOT NULL PRIMARY KEY, "at" DATETIME NOT NULL DEFAULT 0, "userId" TEXT, "userName" TEXT, "module" TEXT NOT NULL, "task" TEXT NOT NULL, "provider" TEXT, "model" TEXT, "ok" INTEGER NOT NULL DEFAULT 1, "inChars" INTEGER NOT NULL DEFAULT 0, "outChars" INTEGER NOT NULL DEFAULT 0, "ms" INTEGER NOT NULL DEFAULT 0, "error" TEXT, "department" TEXT, "itemId" TEXT)`,
  `CREATE INDEX IF NOT EXISTS "${USAGE}_at" ON "${USAGE}"("at")`,
  `CREATE INDEX IF NOT EXISTS "${USAGE}_user" ON "${USAGE}"("userId", "at")`,
];
let okAt = 0;
async function ensure() {
  if (okAt && Date.now() - okAt < 600000) return true;
  try { for (const sql of DDL) await S.run(sql); okAt = Date.now(); return true; } catch (e) { console.error('[omni-mk] usage schema:', e.message); return false; } // eslint-disable-line no-await-in-loop, no-console
}

// ---- providers ------------------------------------------------------------------------------------------------------------
const providers = { text: [], image: [], video: [], audio: [] };
function register(capability, provider) {
  if (!providers[capability] || !provider || !provider.id) return false;
  providers[capability] = providers[capability].filter((p) => p.id !== provider.id).concat(provider);
  return true;
}
const sandboxOnly = () => sandbox.isSandbox() && !sandbox.allowAi();

// the real model (utils/ai.js): Ollama or Claude
register('text', {
  id: 'model',
  usable: () => !sandboxOnly(),
  async status() {
    const aiLib = require('../utils/ai'); // eslint-disable-line global-require
    try {
      const st = await aiLib.checkStatus();
      return { ready: !!st.available, provider: st.provider || aiLib.provider(), model: st.model || null, reason: st.available ? '' : (st.reason || 'The AI model is not ready.') };
    } catch (e) { return { ready: false, provider: 'model', model: null, reason: e.message || 'The AI model is not ready.' }; }
  },
  async json(system, prompt) {
    const aiLib = require('../utils/ai'); // eslint-disable-line global-require
    let out;
    try { out = await aiLib.chatJson(system, [{ role: 'user', content: prompt }], { maxTokens: 4000 }); } catch (e) { throw new AiMkError(e.message || 'The AI model did not answer.', e.status || 503, e.code || 'unavailable'); }
    // utils/ai.js answers an unreadable reply with the assistant's "clarify" object instead of throwing. No marketing prompt asks for an `action`,
    // so that object here means the model's words could not be read: a failed call (logged as failed, not counted against the daily limit).
    if (!out || (out.action === 'clarify' && Object.keys(out).every((k) => ['action', 'params', 'summary'].includes(k)))) {
      throw new AiMkError('The AI answer could not be read. Try again: if it keeps happening, make the brief shorter.', 502, 'unreadable');
    }
    return out;
  },
  async text(system, prompt) {
    const aiLib = require('../utils/ai'); // eslint-disable-line global-require
    try { return String(await aiLib.chat(system, [{ role: 'user', content: prompt }]) || ''); } catch (e) { throw new AiMkError(e.message || 'The AI model did not answer.', e.status || 503, e.code || 'unavailable'); }
  },
});
// the offline sample writer: SANDBOX ONLY. The module that asks passes `demo(input)` so the sample is made from the same request.
register('text', {
  id: 'demo',
  usable: () => sandboxOnly(),
  async status() { return { ready: true, provider: 'demo', model: 'sample writer (test sandbox)', reason: '' }; },
});
for (const c of ['image', 'video', 'audio']) {
  register(c, { id: 'none', usable: () => true, async status() { return { ready: false, provider: null, model: null, reason: 'Not connected yet. This part of the AI Marketing OS is not built.' }; } });
}

function pick(capability) {
  const list = providers[capability] || [];
  return list.find((p) => p.usable()) || list[0] || null;
}
async function status() {
  const out = {};
  for (const c of Object.keys(providers)) {
    const p = pick(c);
    const st = p ? await p.status() : { ready: false, provider: null, model: null, reason: 'Not connected yet.' }; // eslint-disable-line no-await-in-loop
    out[c] = { ready: !!st.ready, provider: st.provider || (p && p.id) || null, model: st.model || null, reason: st.reason || '', demo: !!(p && p.id === 'demo') };
  }
  return out;
}

// ---- limits ---------------------------------------------------------------------------------------------------------------
const IST = 19800000;
function monthStart(now = Date.now()) { const d = new Date(now + IST); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - IST; }
function dayStart(now = Date.now()) { const d = new Date(now + IST); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - IST; }
const minuteHits = new Map(); // userId -> [timestamps]
async function checkLimits(user) {
  const set = await Cfg.getSettings();
  const now = Date.now();
  const hits = (minuteHits.get(user.id) || []).filter((t) => now - t < 60000);
  if (hits.length >= 8) throw new AiMkError('Too many AI requests in one minute. Wait a moment and try again.', 429, 'rate');
  hits.push(now); minuteHits.set(user.id, hits);
  if (set.aiDailyPerUser === 0) throw new AiMkError('AI is switched off for everybody (the daily limit per person is 0). An Admin can change it in AI Marketing > AI usage.', 403, 'off');
  const day = await S.q(`SELECT COUNT(*) AS n FROM "${USAGE}" WHERE userId = ? AND at >= ? AND ok = 1`, user.id, dayStart(now));
  if (S.num(day[0] && day[0].n) >= set.aiDailyPerUser) throw new AiMkError(`You have used your ${set.aiDailyPerUser} AI requests for today. They reset at midnight (India time), or an Admin can raise the limit.`, 429, 'daily');
  if (set.aiMonthlyCap > 0) {
    const mo = await S.q(`SELECT COUNT(*) AS n FROM "${USAGE}" WHERE at >= ? AND ok = 1`, monthStart(now));
    if (S.num(mo[0] && mo[0].n) >= set.aiMonthlyCap) throw new AiMkError('The company AI limit for this month is used up. An Admin can raise it in AI Marketing > AI usage.', 429, 'monthly');
  }
  return set;
}
async function logUsage({ user, module, task, provider, model, ok, inChars, outChars, ms, error, department, itemId }) {
  try {
    await S.run(`INSERT INTO "${USAGE}" (id, at, userId, userName, module, task, provider, model, ok, inChars, outChars, ms, error, department, itemId) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      S.newId('au'), Date.now(), user ? user.id : null, user ? S.clip(user.name, 80) : null, module, task, provider || null, model || null, ok ? 1 : 0, inChars || 0, outChars || 0, ms || 0, error ? S.clip(error, 300) : null, department ? S.clip(department, 60) : null, itemId || null);
  } catch (e) { console.error('[omni-mk] usage log:', e.message); } // eslint-disable-line no-console
}

// ---- the one call every marketing module makes -----------------------------------------------------------------------------
// generate({ user, module, task, system, prompt, json, demo, department, itemId })
//   json: true  -> answer is an object (the model must answer JSON);  false -> plain text
//   demo: () => object|string  the sample answer for the sandbox (same shape as the model answer)
// -> { result, provider, model, demo, ms }   (throws AiMkError with a plain-English message; every call, ok or not, is logged)
async function generate({ user, module, task, system, prompt, json = true, demo, department, itemId }) {
  await ensure();
  await checkLimits(user);
  const p = pick('text');
  const st = p ? await p.status() : { ready: false, reason: 'No AI provider is set up.' };
  const inChars = String(system || '').length + String(prompt || '').length;
  if (!p || !st.ready) {
    const why = (st && st.reason) || 'The AI model is not ready.';
    await logUsage({ user, module, task, provider: p && p.id, ok: false, inChars, error: why, department, itemId });
    throw new AiMkError(`AI is not ready: ${why}`, 503, 'not_ready');
  }
  const t0 = Date.now();
  try {
    let result;
    if (p.id === 'demo') {
      if (typeof demo !== 'function') throw new AiMkError('This task has no sample answer in the test sandbox.', 501, 'no_demo');
      result = await demo();
    } else if (json) result = await p.json(system, prompt);
    else result = await p.text(system, prompt);
    const ms = Date.now() - t0;
    const outChars = typeof result === 'string' ? result.length : JSON.stringify(result || {}).length;
    await logUsage({ user, module, task, provider: st.provider || p.id, model: st.model, ok: true, inChars, outChars, ms, department, itemId });
    return { result, provider: st.provider || p.id, model: st.model || null, demo: p.id === 'demo', ms };
  } catch (e) {
    const ms = Date.now() - t0;
    const err = e instanceof AiMkError ? e : new AiMkError(e.message || 'The AI did not answer.', e.status || 503, e.code || 'failed');
    await logUsage({ user, module, task, provider: st.provider || p.id, model: st.model, ok: false, inChars, ms, error: err.message, department, itemId });
    throw err;
  }
}

// ---- reading the log ------------------------------------------------------------------------------------------------------
// scope: 'all' (Admin) or a user id (everybody else sees only their own lines)
async function summary({ scopeUserId = null } = {}) {
  await ensure();
  const where = scopeUserId ? 'AND userId = ?' : '';
  const args = scopeUserId ? [scopeUserId] : [];
  const m0 = monthStart();
  const d0 = dayStart();
  const one = async (sql, ...a) => S.num(((await S.q(sql, ...a))[0] || {}).n);
  const month = await one(`SELECT COUNT(*) AS n FROM "${USAGE}" WHERE at >= ? AND ok = 1 ${where}`, m0, ...args);
  const today = await one(`SELECT COUNT(*) AS n FROM "${USAGE}" WHERE at >= ? AND ok = 1 ${where}`, d0, ...args);
  const failed = await one(`SELECT COUNT(*) AS n FROM "${USAGE}" WHERE at >= ? AND ok = 0 ${where}`, m0, ...args);
  const byModule = (await S.q(`SELECT module, task, COUNT(*) AS n, SUM(outChars) AS chars FROM "${USAGE}" WHERE at >= ? AND ok = 1 ${where} GROUP BY module, task ORDER BY n DESC`, m0, ...args)).map((r) => ({ module: r.module, task: r.task, calls: S.num(r.n), chars: S.num(r.chars) }));
  const byPerson = scopeUserId ? [] : (await S.q(`SELECT userId, userName, COUNT(*) AS n FROM "${USAGE}" WHERE at >= ? AND ok = 1 GROUP BY userId, userName ORDER BY n DESC LIMIT 20`, m0)).map((r) => ({ userId: r.userId, name: r.userName || '—', calls: S.num(r.n) }));
  return { month, today, failed, byModule, byPerson };
}
async function recent({ scopeUserId = null, limit = 50 } = {}) {
  await ensure();
  const rows = scopeUserId
    ? await S.q(`SELECT * FROM "${USAGE}" WHERE userId = ? ORDER BY at DESC LIMIT ?`, scopeUserId, limit)
    : await S.q(`SELECT * FROM "${USAGE}" ORDER BY at DESC LIMIT ?`, limit);
  return rows.map((r) => ({ id: r.id, at: S.iso(r.at), userName: r.userName || '—', module: r.module, task: r.task, provider: r.provider || '', model: r.model || '', ok: S.num(r.ok) === 1, chars: S.num(r.outChars), ms: S.num(r.ms), error: r.error || '' }));
}

module.exports = { AiMkError, ensure, register, status, generate, summary, recent, monthStart, dayStart, newKey: () => crypto.randomBytes(4).toString('hex') };
