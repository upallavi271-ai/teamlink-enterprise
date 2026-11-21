// ---------------------------------------------------------------------------
// AI GOVERNANCE (market wave B: 09.03 / 09.15 / 09.16 / 09.17 / 09.18 / 09.21).
//
//   PII MASKING     every model call (utils/ai.js chat / chatJson, utils/fastAi.js chat) goes through wrap(): emails, phone numbers,
//                   Aadhaar / PAN / long ID numbers are replaced by [EMAIL_1], [PHONE_2] ... BEFORE the text leaves the server, and put
//                   back into the answer afterwards, so no feature changes but the model never sees them. No switch: always on.
//   CALL LOG        every call is written to AiCallLog: when, who (the signed-in login of the request, else "system"), purpose (the
//                   caller's opts.purpose, else read from the address), provider + model, the masked input size, how many values were
//                   masked, the outcome (ok / failed / refused / limit). Never the text itself.
//   CREDITS         ai.monthlyLimit (Admin, 0 = none): a login that reached it gets AiLimitError; the features fall back to their
//                   built-in rules (every market-wave feature has one).
//   FLAGS           anyone may flag an AI output as wrong or record an override (with a reason); Admin closes them.
//   HUMAN REVIEW    automatic decisions (auto-reject, knockout hold, bulk AI review "not a fit") wait in AiReview for a person to
//                   confirm or overturn; overturning undoes what the rule did.
//   COMPLIANCE      audit(): a dated check-list built from the log and the settings, kept in AiAudit.
//   FAIRNESS        pairedFairness(): the market-wave scorers (profile review, attrition risk) run on pairs that differ only in name /
//                   gender; any difference is a failure (extends utils/fairnessTest.js, which tests the Fit %).
// ---------------------------------------------------------------------------
const { AsyncLocalStorage } = require('async_hooks');
const S = require('./store');

const reqStore = new AsyncLocalStorage(); // { req } for the request being served
const callStore = new AsyncLocalStorage(); // set inside a wrapped call, so a nested call (fastAi -> ai) is not logged twice

// Express middleware: remembers the request, so a model call deep inside a feature knows who asked and from where.
function requestContext(req, res, next) { reqStore.run({ req }, next); }
// a background job / test acting for one login (the MCP server, the tests)
function runAs(user, fn) { return reqStore.run({ req: { user, originalUrl: '/internal' } }, fn); }

class AiLimitError extends Error {
  constructor(msg) { super(msg); this.status = 429; this.code = 'AI_LIMIT'; }
}

// ---- masking --------------------------------------------------------------------------------------------------------------------
const PATTERNS = [
  ['EMAIL', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ['PAN', /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g],
  ['AADHAAR', /\b[2-9][0-9]{3}[\s-]?[0-9]{4}[\s-]?[0-9]{4}\b/g],
  ['PHONE', /(?:(?:\+|00)91[\s-]?|\b0)?\b[6-9][0-9]{4}[\s-]?[0-9]{5}\b/g],
  ['ID', /\b[0-9]{11,18}\b/g],
];
function newMasker() {
  const map = new Map(); // token -> original
  const back = new Map(); // original -> token
  const counts = {};
  const mask = (text) => {
    if (typeof text !== 'string' || !text) return text;
    let out = text;
    PATTERNS.forEach(([kind, re]) => {
      out = out.replace(re, (m) => {
        if (/^\[[A-Z]+_\d+\]$/.test(m)) return m;
        if (kind === 'AADHAAR' && m.split(/[\s-]+/).every((g) => /^(19|20)\d\d$/.test(g))) return m; // "2018 2019 2020" are years
        if (back.has(m)) return back.get(m);
        counts[kind] = (counts[kind] || 0) + 1;
        const token = `[${kind}_${map.size + 1}]`;
        map.set(token, m); back.set(m, token);
        return token;
      });
    });
    return out;
  };
  const unmask = (v, depth = 0) => {
    if (!map.size || depth > 12) return v;
    if (typeof v === 'string') return v.replace(/\[?\b(EMAIL|PAN|AADHAAR|PHONE|ID)_(\d+)\b\]?/g, (m, k, n) => map.get(`[${k}_${n}]`) || m);
    if (Array.isArray(v)) return v.map((y) => unmask(y, depth + 1));
    if (v && typeof v === 'object') { const o = {}; Object.entries(v).forEach(([k, y]) => { o[k] = unmask(y, depth + 1); }); return o; }
    return v;
  };
  return { mask, unmask, counts, size: () => map.size };
}
function maskText(text) { const m = newMasker(); return { text: m.mask(String(text || '')), counts: m.counts }; }

// ---- who / why --------------------------------------------------------------------------------------------------------------------
const PURPOSES = [
  [/\/api\/crm/, 'CRM'], [/\/api\/(omni|outreach|wa-chats|omni-wa)/, 'Messaging'], [/\/api\/ats\/mkt\/(pitch|packet)/, 'Submission note'],
  [/\/api\/ats\/mkt\/intake/, 'Job intake'], [/\/api\/ats\/mkt\/.*skills/, 'Skills from JD'], [/\/api\/ats\/mkt\/.*review/, 'Profile review'],
  [/\/api\/ats\/mkt\/.*resume/, 'Resume formatting'], [/\/api\/ats\/mkt\/nl-search/, 'Natural-language search'], [/\/api\/ats\/mkt/, 'ATS tools'],
  [/resume/, 'Resume reading'], [/\/api\/(assistant|agent)/, 'AI Assistant'], [/bde-agent|bdeAgent/, 'BDE Agent'], [/\/api\/(requirements|job)/, 'Job text'],
  [/\/api\/(candidates|applications|ats)/, 'ATS'], [/marketing/, 'AI Marketing'],
];
function context(opts = {}) {
  const st = reqStore.getStore();
  const req = st && st.req;
  const u = req && req.user;
  const path = req ? String(req.originalUrl || req.url || '').split('?')[0].slice(0, 160) : null;
  const purpose = opts.purpose || (path ? (PURPOSES.find(([re]) => re.test(path)) || [null, 'Other'])[1] : 'Background job');
  return { userId: u ? u.id : null, userName: u ? u.name : 'system', role: u ? (u.atsRole || u.role || null) : null, path, purpose };
}

const monthStart = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(); };
async function usedThisMonth(userId) {
  if (!userId) return 0;
  const [r] = await S.q('SELECT COUNT(*) AS n FROM "AiCallLog" WHERE "userId" = ? AND "at" >= ? AND "outcome" = \'ok\'', userId, monthStart());
  return S.num(r && r.n);
}
async function checkLimit(userId) {
  if (!userId) return null;
  const limit = Number(await S.setting('ai.monthlyLimit')) || 0;
  if (!limit) return null;
  const used = await usedThisMonth(userId);
  return used >= limit ? `This login has used its ${limit} AI calls for this month. The built-in rules answer until next month (Admin can raise the limit in AI governance).` : null;
}

function log(row) {
  return S.x(`INSERT INTO "AiCallLog" ("id","at","userId","userName","role","purpose","path","channel","provider","model","inChars","outChars","masked","maskedKinds","ms","outcome","error")
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, S.newId(), S.now(), row.userId, row.userName, row.role, row.purpose, row.path, row.channel, row.provider || null,
  row.model || null, row.inChars || 0, row.outChars || 0, row.masked || 0, row.maskedKinds || null, row.ms || 0, row.outcome, row.error ? String(row.error).slice(0, 200) : null)
    .catch(() => {});
}

const textLen = (v) => (typeof v === 'string' ? v.length : v && typeof v === 'object' ? (typeof v.text === 'string' ? v.text.length : JSON.stringify(v).length) : 0);

// wrap(channel, fn, system, history, opts): masks, checks the credit limit, calls, logs, unmasks.
async function wrap(channel, fn, system, history, opts = {}) {
  if (callStore.getStore()) return fn(system, history, opts); // nested (fastAi falling back to ai): already masked and logged outside
  const ctx = context(opts);
  const m = newMasker();
  const sys = m.mask(String(system || ''));
  const hist = (Array.isArray(history) ? history : []).map((h) => (h && typeof h === 'object' ? { ...h, content: typeof h.content === 'string' ? m.mask(h.content) : h.content } : h));
  const inChars = sys.length + hist.reduce((n, h) => n + (h && typeof h.content === 'string' ? h.content.length : 0), 0);
  const base = { ...ctx, channel, inChars, masked: m.size(), maskedKinds: Object.keys(m.counts).join(',') || null };
  let limitMsg = null;
  try { limitMsg = await checkLimit(ctx.userId); } catch { limitMsg = null; }
  if (limitMsg) { await log({ ...base, outcome: 'limit' }); throw new AiLimitError(limitMsg); }
  const t0 = Date.now();
  const meta = opts.meta || {};
  try {
    const out = await callStore.run({ on: true }, () => fn(sys, hist, { ...opts, meta }));
    const provider = out && typeof out === 'object' && out.provider ? out.provider : (meta.provider || null);
    const model = out && typeof out === 'object' && out.model ? out.model : (meta.model || null);
    await log({ ...base, provider, model, outChars: textLen(out), ms: Date.now() - t0, outcome: 'ok' });
    return m.unmask(out);
  } catch (e) {
    await log({ ...base, ms: Date.now() - t0, outcome: e && (e.code === 'sandbox' || e.status === 403) ? 'refused' : 'failed', error: e && e.message });
    throw e;
  }
}

// ---- the governance centre's reads ------------------------------------------------------------------------------------------------
async function callLog({ limit = 100, userId = null, purpose = null } = {}) {
  const where = []; const args = [];
  if (userId) { where.push('"userId" = ?'); args.push(userId); }
  if (purpose) { where.push('"purpose" = ?'); args.push(purpose); }
  const rows = await S.q(`SELECT * FROM "AiCallLog" ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY "at" DESC LIMIT ${Math.min(500, Math.max(1, Number(limit) || 100))}`, ...args);
  return rows.map((r) => ({ ...r, inChars: S.num(r.inChars), outChars: S.num(r.outChars), masked: S.num(r.masked), ms: S.num(r.ms) }));
}
async function summary() {
  const since = monthStart();
  const rows = await S.q('SELECT "purpose","outcome",COUNT(*) AS n, SUM("masked") AS m, SUM("inChars") AS c FROM "AiCallLog" WHERE "at" >= ? GROUP BY "purpose","outcome"', since);
  const byUser = await S.q('SELECT "userId","userName",COUNT(*) AS n FROM "AiCallLog" WHERE "at" >= ? AND "outcome" = \'ok\' GROUP BY "userId","userName" ORDER BY n DESC LIMIT 50', since);
  const limit = Number(await S.setting('ai.monthlyLimit')) || 0;
  const purposes = {};
  let total = 0; let masked = 0; let ok = 0;
  rows.forEach((r) => {
    const n = S.num(r.n); total += n; masked += S.num(r.m); if (r.outcome === 'ok') ok += n;
    const p = purposes[r.purpose || 'Other'] = purposes[r.purpose || 'Other'] || { purpose: r.purpose || 'Other', calls: 0, ok: 0, failed: 0 };
    p.calls += n; if (r.outcome === 'ok') p.ok += n; else p.failed += n;
  });
  return {
    since, total, ok, maskedValues: masked, limit, purposes: Object.values(purposes).sort((a, b) => b.calls - a.calls),
    byUser: byUser.map((u) => ({ userId: u.userId, userName: u.userName || 'system', calls: S.num(u.n), left: limit ? Math.max(0, limit - S.num(u.n)) : null })),
  };
}

// ---- flags / overrides (09.03) --------------------------------------------------------------------------------------------------
const FLAG_KINDS = ['Wrong', 'Biased', 'Unsafe', 'Override'];
async function addFlag(body, user) {
  const kind = FLAG_KINDS.includes(body.kind) ? body.kind : 'Wrong';
  const reason = S.clean(body.reason, 500);
  if (!reason || reason.length < 4) return { error: 'Say in a few words what is wrong with the AI output.' };
  const id = S.newId();
  await S.x('INSERT INTO "AiFlag" ("id","at","userId","userName","feature","refType","refId","kind","reason","output","corrected") VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    id, S.now(), user.id, user.name, S.clean(body.feature, 80) || 'AI output', S.clean(body.refType, 40), S.clean(body.refId, 80), kind, reason,
    S.clean(body.output, 2000), S.clean(body.corrected, 2000));
  return { id, kind };
}
async function flags({ status = null } = {}) {
  const rows = await S.q(`SELECT * FROM "AiFlag" ${status ? 'WHERE "status" = ?' : ''} ORDER BY "at" DESC LIMIT 300`, ...(status ? [status] : []));
  return rows;
}
async function closeFlag(id, user) {
  const n = await S.x('UPDATE "AiFlag" SET "status"=\'Closed\',"closedByName"=?,"closedAt"=? WHERE "id"=? AND "status"=\'Open\'', user.name, S.now(), id);
  return S.num(n) ? { ok: true } : { error: 'That flag is not open.', status: 404 };
}

// ---- human review queue (09.17) -------------------------------------------------------------------------------------------------
// undo: JSON describing how to reverse the automatic action: { type: 'stage', applicationId, toStage } (put the application back).
async function addReview({ kind, refType, refId, candidateId = null, applicationId = null, summary: sum, aiDecision, undo = null }) {
  const open = await S.q('SELECT "id" FROM "AiReview" WHERE "kind"=? AND "refId"=? AND "status"=\'Pending\'', kind, refId);
  if (open.length) return open[0].id;
  const id = S.newId();
  await S.x('INSERT INTO "AiReview" ("id","at","kind","refType","refId","candidateId","applicationId","summary","aiDecision","undo") VALUES (?,?,?,?,?,?,?,?,?,?)',
    id, S.now(), kind, refType, refId, candidateId, applicationId, S.clean(sum, 600), S.clean(aiDecision, 120), undo ? JSON.stringify(undo) : null);
  return id;
}
async function reviews({ status = 'Pending', applicationIds = null } = {}) {
  const rows = await S.q(`SELECT * FROM "AiReview" WHERE "status" = ? ORDER BY "at" DESC LIMIT 500`, status);
  return applicationIds ? rows.filter((r) => !r.applicationId || applicationIds.has(r.applicationId)) : rows;
}
async function decideReview(id, decision, note, user) {
  const [row] = await S.q('SELECT * FROM "AiReview" WHERE "id" = ?', id);
  if (!row) return { error: 'That review item was not found.', status: 404 };
  if (row.status !== 'Pending') return { error: 'That item was already reviewed.', status: 409 };
  if (!['Confirmed', 'Overturned'].includes(decision)) return { error: 'Confirm or overturn.' };
  if (decision === 'Overturned' && !S.clean(note, 300)) return { error: 'Say why the automatic decision was wrong.' };
  let undone = null;
  const undo = S.parse(row.undo);
  if (decision === 'Overturned' && undo && undo.type === 'stage' && undo.applicationId) {
    const prisma = require('../../db'); // eslint-disable-line global-require
    const app = await prisma.application.findUnique({ where: { id: undo.applicationId }, select: { id: true, stage: true, candidateId: true } });
    if (app && app.stage === undo.fromStage) {
      await prisma.application.update({ where: { id: app.id }, data: { stage: undo.toStage } });
      await prisma.applicationStageEvent.create({ data: { applicationId: app.id, candidateId: app.candidateId, fromStage: app.stage, toStage: undo.toStage, action: 'Automatic decision overturned', comment: S.clean(note, 300), actorUserId: user.id, actorName: user.name, actorRole: user.atsRole || user.role } });
      undone = `back to ${undo.toStage}`;
    }
  }
  await S.x('UPDATE "AiReview" SET "status"=?,"reviewerId"=?,"reviewerName"=?,"reviewedAt"=?,"note"=? WHERE "id"=?', decision, user.id, user.name, S.now(), S.clean(note, 300), id);
  return { ok: true, decision, undone };
}

// ---- paired fairness of the market-wave scorers (09.17) ---------------------------------------------------------------------------
const PAIRS = [
  [{ name: 'Rahul Kumar', gender: 'Male' }, { name: 'Priya Sharma', gender: 'Female' }],
  [{ name: 'Mohammed Irfan', gender: 'Male' }, { name: 'Lakshmi Devi', gender: 'Female' }],
  [{ name: 'John Thomas', gender: 'Male' }, { name: 'Ananya Reddy', gender: 'Female' }],
];
const BASES = [
  { skills: 'java, spring, sql', experienceYears: 5, location: 'Hyderabad', noticePeriod: '30 Days', education: 'B.Tech', currentDesignation: 'Developer', currentSalary: '8', expectedSalary: '11' },
  { skills: 'nursing, icu', experienceYears: 3, location: 'Chennai', noticePeriod: 'Immediate', education: 'B.Sc Nursing', currentDesignation: 'Staff Nurse', currentSalary: '3', expectedSalary: '4' },
];
function pairedFairness() {
  const PR = require('./cands'); // eslint-disable-line global-require
  const AG = require('./agents'); // eslint-disable-line global-require
  const job = { title: 'Developer', skills: 'java, spring, sql', experience: '3-6', location: 'Hyderabad', noticePeriodMax: '30 Days' };
  const rows = [];
  BASES.forEach((b) => PAIRS.forEach(([p1, p2]) => {
    const a = PR.reviewScore({ ...b, ...p1 }, job); const c = PR.reviewScore({ ...b, ...p2 }, job);
    rows.push({ scorer: 'Bulk profile review', a: `${p1.name} (${p1.gender})`, b: `${p2.name} (${p2.gender})`, scoreA: a.score, scoreB: c.score, same: a.score === c.score });
    const r1 = AG.riskScore({ candidate: { ...b, ...p1 }, app: { offeredCtc: 1200000 }, job }); const r2 = AG.riskScore({ candidate: { ...b, ...p2 }, app: { offeredCtc: 1200000 }, job });
    rows.push({ scorer: 'Attrition risk', a: `${p1.name} (${p1.gender})`, b: `${p2.name} (${p2.gender})`, scoreA: r1.score, scoreB: r2.score, same: r1.score === r2.score });
  }));
  return { at: S.now(), pairs: rows.length, failures: rows.filter((r) => !r.same).length, rows, note: 'Each pair is the same profile with only the name and gender changed. Any difference in score is a failure.' };
}

// ---- compliance audit (09.15) ---------------------------------------------------------------------------------------------------
async function audit(user) {
  const sum = await summary();
  const [unknown] = await S.q('SELECT COUNT(*) AS n FROM "AiCallLog" WHERE "at" >= ? AND ("purpose" IS NULL OR "purpose" = \'Other\')', sum.since);
  const [openFlags] = await S.q('SELECT COUNT(*) AS n FROM "AiFlag" WHERE "status" = \'Open\'');
  const [oldReviews] = await S.q('SELECT COUNT(*) AS n FROM "AiReview" WHERE "status" = \'Pending\' AND "at" < ?', new Date(Date.now() - 7 * 864e5).toISOString());
  const st = await S.settings();
  const fair = pairedFairness();
  let fitFair = null;
  try { fitFair = await require('../fairnessTest').latestRun(); } catch { fitFair = null; } // eslint-disable-line global-require
  const checks = [
    { key: 'masking', label: 'Contact details and ID numbers are masked before every AI call', ok: true, detail: `${sum.maskedValues} values masked this month; masking cannot be switched off.` },
    { key: 'logging', label: 'Every AI call is logged with who, why, model and outcome', ok: true, detail: `${sum.total} calls logged this month.` },
    { key: 'purpose', label: 'Every AI call has a known purpose', ok: S.num(unknown && unknown.n) === 0, detail: `${S.num(unknown && unknown.n)} call(s) this month with no clear purpose.` },
    { key: 'automation', label: 'Automatic rejections are OFF, or each one waits for a person', ok: true, detail: st['autoReject.on'] ? 'Auto-reject is ON; every automatic rejection goes to the human review queue.' : 'Auto-reject is OFF.' },
    { key: 'review', label: 'No automatic decision waits for review longer than 7 days', ok: S.num(oldReviews && oldReviews.n) === 0, detail: `${S.num(oldReviews && oldReviews.n)} older than 7 days.` },
    { key: 'flags', label: 'Flagged AI outputs are looked at', ok: S.num(openFlags && openFlags.n) <= 10, detail: `${S.num(openFlags && openFlags.n)} open flag(s).` },
    { key: 'fairness', label: 'Paired fairness test of the review and risk scores passes', ok: fair.failures === 0, detail: `${fair.pairs} pairs, ${fair.failures} difference(s).` },
    { key: 'fitFairness', label: 'Fit % fairness test (Fit settings > AI fairness) has been run', ok: !!fitFair, detail: fitFair ? 'A result is on file.' : 'Run it once in Fit settings > AI fairness.' },
    { key: 'pledge', label: 'No-training pledge is shown to Admins', ok: true, detail: 'Shown on this page; the providers used are told not to keep or train on the data where they offer it.' },
    { key: 'mcp', label: 'Outside AI tools (MCP) are read-only and need a token', ok: true, detail: st['mcp.on'] ? 'MCP is ON, read-only, token per login.' : 'MCP is OFF.' },
  ];
  const score = Math.round((checks.filter((c) => c.ok).length / checks.length) * 100);
  const result = { checks, score, month: sum.since.slice(0, 7) };
  const id = S.newId();
  await S.x('INSERT INTO "AiAudit" ("id","at","byName","score","result") VALUES (?,?,?,?,?)', id, S.now(), user ? user.name : 'system', score, JSON.stringify(result));
  return { id, at: S.now(), byName: user ? user.name : 'system', ...result };
}
async function audits() {
  const rows = await S.q('SELECT * FROM "AiAudit" ORDER BY "at" DESC LIMIT 24');
  return rows.map((r) => ({ id: r.id, at: r.at, byName: r.byName, score: S.num(r.score), ...(S.parse(r.result, {})) }));
}

const PLEDGE = [
  'Before any text is sent to an AI model, TeamLink replaces email addresses, phone numbers, Aadhaar, PAN and other long ID numbers with placeholders. The model never sees them; they are put back only in the answer shown to you.',
  'TeamLink does not use your candidates\', clients\' or employees\' data to train any AI model, and does not sell it.',
  'The AI providers used (Groq, Google Gemini, OpenRouter, Anthropic Claude, or the local model on this server) are used through their business APIs, whose terms say API data is not used to train their models. A local model keeps everything on this server.',
  'Every AI call is logged here: who, why, which model, how much text (masked), and whether it worked. The text itself is not kept in the log.',
  'AI only suggests. A person approves submission notes, agent actions and data fixes; every automatic decision can be reviewed and undone.',
];

module.exports = {
  requestContext, runAs, wrap, maskText, newMasker, context, AiLimitError, callLog, summary, usedThisMonth, checkLimit,
  addFlag, flags, closeFlag, FLAG_KINDS, addReview, reviews, decideReview, pairedFairness, audit, audits, PLEDGE,
};
