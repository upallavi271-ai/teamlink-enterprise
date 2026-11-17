// ---------------------------------------------------------------------------
// AI CALLS IN OMNI-CHANNEL > VOICE CALLING (founder 2026-11-04: "green start loo history kuda kanipinchalii").
//
// Every AI call TeamLink makes (the ATS AI Calling screen, an AI Voice campaign) is kept in the AiCall table with its outcome, summary and talk. Green Start
// (Omni-Channel) has its own Voice Calling page, so a call made from TeamLink would not show there. Here each FINISHED call is sent to Green Start's
// POST /voice/calls/import (gs-api/src/modules/voice/voice-external.ts), where it becomes an ordinary AI call of a workspace: listed on Voice Calling, opened
// with what was said, matched to the contact by phone. It is a RECORD: nothing is dialled again and no workflow starts.
//
//   which workspace  the requirement's department: "Teamlink <Department>" when Omni-Channel has it (the department split of 2026-11-02), else the first
//                    workspace of the company account
//   when             every 3 minutes, and a call is sent once; sent again only if it changed (a fingerprint of its status / outcome / talk is kept)
//   how              the same one-click sign-in TeamLink already uses to put its integrations into Omni-Channel (utils/greenStartSso.js)
// Off when Green Start is switched off (GREENSTART_ENABLED=false) or one-click sign-in is not set up; a failure is only words in status(), never a stop.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const DB = require('../calling/schema');
const SSO = require('./greenStartSso');

const apiBase = () => `http://127.0.0.1:${parseInt(process.env.GREENSTART_API_PORT, 10) || 4020}/api/v1`;
const enabled = () => String(process.env.GREENSTART_ENABLED || 'true').toLowerCase() !== 'false';
const sha = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 20);
const FINAL = ['completed', 'failed', 'busy', 'no-answer'];
const CHUNK = 40;
const DAYS = 14; // only recent calls are looked at; older ones were sent when they were new

let last = { at: null, ok: null, words: 'not run yet', sent: 0 };
let running = false;

async function call(method, path, { token, ws, body } = {}) {
  let res;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(ws ? { 'x-workspace-id': ws } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch { const e = new Error('Omni-Channel (Green Start) is not running on this server.'); e.down = true; throw e; }
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = { message: text.slice(0, 200) }; }
  if (!res.ok || (data && data.success === false)) {
    const e = new Error(String((data && (data.message || (data.error && data.error.message))) || `HTTP ${res.status}`).slice(0, 200)); e.status = res.status; throw e;
  }
  return data && typeof data === 'object' && 'success' in data && 'data' in data ? data.data : data;
}

async function signIn() {
  if (!SSO.secretSet()) throw new Error('One-click sign-in to Omni-Channel is not set up on this server.');
  const email = await SSO.ssoEmail();
  if (!SSO.EMAIL_RE.test(email)) throw new Error('The company Omni-Channel account is not picked yet.');
  const out = await call('POST', '/auth/teamlink', { body: { ticket: SSO.greenStartTicket({ email, name: 'TeamLink', externalUserId: 'teamlink-voice-history' }) } });
  if (!out || !out.accessToken) throw new Error('Omni-Channel asked for a second sign-in step for the company account.');
  return out.accessToken;
}

// a 10-digit Indian mobile -> +91...; anything else as written
const dialled = (phone) => { const d = String(phone || '').replace(/\D/g, ''); return d.length === 10 ? `+91${d}` : (d ? `+${d}` : ''); };

function turnsOf(json) {
  try { const t = JSON.parse(json || '[]'); return Array.isArray(t) ? t.map((x) => ({ who: /^(assistant|ai|bot)$/i.test(String(x.who || x.role || '')) ? 'assistant' : 'candidate', text: String(x.text || x.say || '').slice(0, 600) })).filter((x) => x.text) : []; } catch { return []; }
}

// the finished calls of the last days with what Green Start needs, and the ones already sent unchanged left out
async function pending() {
  const since = new Date(Date.now() - DAYS * 86400000).toISOString();
  const rows = await DB.all(`SELECT a."id", a."status", a."outcome", a."summary", a."durationSec", a."startedAt", a."endedAt", a."failReason", a."transcript", a."nextAttemptAt",
      cd."name" AS candidateName, cd."phone" AS candidatePhone, r."title" AS jobTitle, r."department" AS department, p."fp" AS pushedFp
    FROM "AiCall" a LEFT JOIN "Candidate" cd ON cd."id" = a."candidateId" LEFT JOIN "Requirement" r ON r."id" = a."requirementId" LEFT JOIN "AiCallOmniPush" p ON p."callId" = a."id"
    WHERE a."status" IN ('completed','failed','busy','no-answer') AND a."nextAttemptAt" IS NULL AND a."attempts" > 0 AND a."updatedAt" >= ? AND a."candidateId" NOT LIKE 'omni:%' ORDER BY a."updatedAt" ASC LIMIT 300`, since);
  return rows.map((r) => {
    const turns = turnsOf(r.transcript);
    const item = {
      externalId: r.id, toNumber: dialled(r.candidatePhone), status: r.status, outcome: r.outcome || null,
      contactName: [r.candidateName, r.jobTitle].filter(Boolean).join(' - ') || null, summary: r.summary || null,
      durationSeconds: Number(r.durationSec) || null, startedAt: r.startedAt || null, endedAt: r.endedAt || null, failureReason: r.failReason || null, turns,
    };
    return { item, department: r.department || '', fp: sha([r.status, r.outcome, r.summary, r.endedAt, turns.length]), pushedFp: r.pushedFp };
  }).filter((x) => x.item.toNumber && x.fp !== x.pushedFp);
}

async function sync() {
  if (running) return { skipped: 'already running' };
  if (require('./sandbox').isSandbox()) return { skipped: 'sandbox' }; // eslint-disable-line global-require
  if (!enabled()) return { skipped: 'Green Start is switched off on this server' };
  running = true;
  try {
    const todo = await pending();
    if (!todo.length) { last = { at: new Date().toISOString(), ok: true, words: 'nothing new to send', sent: 0 }; return { sent: 0 }; }
    const token = await signIn();
    const list = await call('GET', '/workspaces', { token });
    const wss = (Array.isArray(list) ? list : (list && list.items) || []).map((w) => ({ id: w.id, name: String(w.name || ''), createdAt: w.createdAt || '' })).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    if (!wss.length) throw new Error('The company Omni-Channel account has no workspace yet.');
    // the department's workspace (oldest first): "Teamlink Medical" or, once Meta names the number, "Nonit Consultants · Medical dept" (utils/omniWsNames.js)
    const WS_NAMES = require('./omniWsNames'); // eslint-disable-line global-require
    const wsFor = (dept) => (dept && wss.find((w) => String(WS_NAMES.deptOfName(w.name) || '').toLowerCase() === String(dept).trim().toLowerCase())) || wss[0];
    const groups = new Map();
    todo.forEach((t) => { const w = wsFor(t.department); if (!groups.has(w.id)) groups.set(w.id, []); groups.get(w.id).push(t); });
    let sent = 0;
    for (const [ws, items] of groups) { // eslint-disable-line no-restricted-syntax
      for (let i = 0; i < items.length; i += CHUNK) {
        const part = items.slice(i, i + CHUNK);
        // eslint-disable-next-line no-await-in-loop
        await call('POST', '/voice/calls/import', { token, ws, body: { items: part.map((x) => x.item) } });
        for (const x of part) { // eslint-disable-line no-restricted-syntax
          // eslint-disable-next-line no-await-in-loop
          await DB.run('INSERT OR REPLACE INTO "AiCallOmniPush" ("callId","fp","workspaceId","pushedAt") VALUES (?,?,?,?)', x.item.externalId, x.fp, ws, new Date().toISOString());
        }
        sent += part.length;
      }
    }
    last = { at: new Date().toISOString(), ok: true, words: `${sent} AI call(s) sent to Voice Calling in Omni-Channel`, sent };
    return { sent };
  } catch (err) {
    last = { at: new Date().toISOString(), ok: false, words: String((err && err.message) || err).slice(0, 200), sent: 0 };
    return { error: last.words };
  } finally { running = false; }
}

const status = () => ({ ...last });

let timer = null;
function startSchedule() {
  if (timer || process.env.NODE_ENV === 'test') return;
  setTimeout(() => { sync().catch(() => {}); }, 120 * 1000);
  timer = setInterval(() => { sync().catch(() => {}); }, 3 * 60 * 1000);
  if (timer.unref) timer.unref();
}

module.exports = { sync, status, startSchedule, pending, dialled };
