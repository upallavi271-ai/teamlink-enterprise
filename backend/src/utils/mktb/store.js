// ---------------------------------------------------------------------------
// MARKET WAVE B (founder 2026-11-21: "the whole ATS must be 90 to 99 percent complete compared with the market").
// The tables and switches of the features in utils/mktb/*.js: raw SQL, created on first use (the recycleBin.js pattern),
// never a Prisma migration. Every switch that tells people something or automates work starts OFF (the founder turns it on).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../../db');

const TABLES = [
  'CREATE TABLE IF NOT EXISTS "MktSetting" ("key" TEXT PRIMARY KEY, "value" TEXT, "byName" TEXT, "at" TEXT)',
  `CREATE TABLE IF NOT EXISTS "AiCallLog" ("id" TEXT PRIMARY KEY, "at" TEXT NOT NULL, "userId" TEXT, "userName" TEXT, "role" TEXT, "purpose" TEXT,
    "path" TEXT, "channel" TEXT, "provider" TEXT, "model" TEXT, "inChars" INTEGER, "outChars" INTEGER, "masked" INTEGER, "maskedKinds" TEXT,
    "ms" INTEGER, "outcome" TEXT, "error" TEXT)`,
  'CREATE INDEX IF NOT EXISTS "AiCallLog_at" ON "AiCallLog" ("at")',
  'CREATE INDEX IF NOT EXISTS "AiCallLog_user" ON "AiCallLog" ("userId", "at")',
  `CREATE TABLE IF NOT EXISTS "AiFlag" ("id" TEXT PRIMARY KEY, "at" TEXT NOT NULL, "userId" TEXT, "userName" TEXT, "feature" TEXT, "refType" TEXT,
    "refId" TEXT, "kind" TEXT, "reason" TEXT, "output" TEXT, "corrected" TEXT, "status" TEXT DEFAULT 'Open', "closedByName" TEXT, "closedAt" TEXT)`,
  `CREATE TABLE IF NOT EXISTS "AiReview" ("id" TEXT PRIMARY KEY, "at" TEXT NOT NULL, "kind" TEXT, "refType" TEXT, "refId" TEXT, "candidateId" TEXT,
    "applicationId" TEXT, "summary" TEXT, "aiDecision" TEXT, "status" TEXT NOT NULL DEFAULT 'Pending', "reviewerId" TEXT, "reviewerName" TEXT,
    "reviewedAt" TEXT, "note" TEXT, "undo" TEXT)`,
  'CREATE INDEX IF NOT EXISTS "AiReview_status" ON "AiReview" ("status", "at")',
  'CREATE TABLE IF NOT EXISTS "AiAudit" ("id" TEXT PRIMARY KEY, "at" TEXT NOT NULL, "byName" TEXT, "score" INTEGER, "result" TEXT)',
  `CREATE TABLE IF NOT EXISTS "MktClientPipeline" ("clientId" TEXT NOT NULL, "stage" TEXT NOT NULL, "enabled" INTEGER NOT NULL DEFAULT 1,
    "approverRole" TEXT, "byName" TEXT, "at" TEXT, PRIMARY KEY ("clientId", "stage"))`,
  'CREATE TABLE IF NOT EXISTS "MktClientProcess" ("clientId" TEXT PRIMARY KEY, "rounds" TEXT, "notes" TEXT, "byName" TEXT, "at" TEXT)',
  'CREATE TABLE IF NOT EXISTS "MktScreenQ" ("requirementId" TEXT PRIMARY KEY, "questions" TEXT, "action" TEXT, "byName" TEXT, "at" TEXT)',
  `CREATE TABLE IF NOT EXISTS "MktScreenAnswer" ("applicationId" TEXT PRIMARY KEY, "requirementId" TEXT, "candidateId" TEXT, "answers" TEXT,
    "failed" TEXT, "source" TEXT, "byName" TEXT, "at" TEXT)`,
  `CREATE TABLE IF NOT EXISTS "MktJobWatch" ("requirementId" TEXT PRIMARY KEY, "on" INTEGER NOT NULL DEFAULT 1, "lastRunAt" TEXT, "seen" TEXT,
    "newIds" TEXT, "total" INTEGER, "byName" TEXT)`,
  `CREATE TABLE IF NOT EXISTS "MktPostingRule" ("id" TEXT PRIMARY KEY, "name" TEXT, "department" TEXT, "clientId" TEXT, "employmentType" TEXT,
    "sources" TEXT, "active" INTEGER NOT NULL DEFAULT 1, "byName" TEXT, "at" TEXT)`,
  `CREATE TABLE IF NOT EXISTS "MktFieldRule" ("id" TEXT PRIMARY KEY, "fieldId" TEXT NOT NULL, "method" TEXT NOT NULL, "pattern" TEXT,
    "active" INTEGER NOT NULL DEFAULT 1, "byName" TEXT, "at" TEXT)`,
  `CREATE TABLE IF NOT EXISTS "MktSavedSearch" ("id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "userName" TEXT, "name" TEXT NOT NULL, "query" TEXT,
    "filters" TEXT, "alert" INTEGER NOT NULL DEFAULT 0, "shared" INTEGER NOT NULL DEFAULT 0, "lastRunAt" TEXT, "seen" TEXT, "newCount" INTEGER DEFAULT 0,
    "createdAt" TEXT)`,
  `CREATE TABLE IF NOT EXISTS "MktPool" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "note" TEXT, "ownerId" TEXT, "ownerName" TEXT,
    "shared" INTEGER NOT NULL DEFAULT 0, "createdAt" TEXT)`,
  `CREATE TABLE IF NOT EXISTS "MktPoolMember" ("poolId" TEXT NOT NULL, "candidateId" TEXT NOT NULL, "addedByName" TEXT, "at" TEXT,
    PRIMARY KEY ("poolId", "candidateId"))`,
  `CREATE TABLE IF NOT EXISTS "MktUpdateLink" ("id" TEXT PRIMARY KEY, "candidateId" TEXT NOT NULL, "tokenHash" TEXT NOT NULL, "createdById" TEXT,
    "createdByName" TEXT, "createdAt" TEXT, "expiresAt" TEXT, "usedAt" TEXT, "changes" TEXT)`,
  'CREATE INDEX IF NOT EXISTS "MktUpdateLink_hash" ON "MktUpdateLink" ("tokenHash")',
  `CREATE TABLE IF NOT EXISTS "MktDocExpiry" ("documentId" TEXT PRIMARY KEY, "candidateId" TEXT NOT NULL, "expiresOn" TEXT NOT NULL,
    "alertedAt" TEXT, "byName" TEXT, "at" TEXT)`,
  `CREATE TABLE IF NOT EXISTS "MktFraudFlag" ("id" TEXT PRIMARY KEY, "key" TEXT UNIQUE, "candidateId" TEXT NOT NULL, "otherCandidateId" TEXT,
    "kind" TEXT NOT NULL, "detail" TEXT, "status" TEXT NOT NULL DEFAULT 'Open', "reviewerName" TEXT, "reviewedAt" TEXT, "note" TEXT, "createdAt" TEXT)`,
  `CREATE TABLE IF NOT EXISTS "MktProfileReview" ("id" TEXT PRIMARY KEY, "candidateId" TEXT NOT NULL, "requirementId" TEXT, "verdict" TEXT,
    "score" INTEGER, "summary" TEXT, "factors" TEXT, "source" TEXT, "byName" TEXT, "at" TEXT)`,
  `CREATE TABLE IF NOT EXISTS "MktPitch" ("id" TEXT PRIMARY KEY, "applicationId" TEXT NOT NULL, "text" TEXT, "source" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Draft', "byName" TEXT, "at" TEXT, "approvedByName" TEXT, "approvedAt" TEXT)`,
  `CREATE TABLE IF NOT EXISTS "MktAutoRule" ("id" TEXT PRIMARY KEY, "scope" TEXT NOT NULL, "kind" TEXT NOT NULL, "value" TEXT,
    "active" INTEGER NOT NULL DEFAULT 1, "byName" TEXT, "at" TEXT)`,
  `CREATE TABLE IF NOT EXISTS "MktPlacement" ("applicationId" TEXT PRIMARY KEY, "status" TEXT NOT NULL, "requestedByName" TEXT, "requestedAt" TEXT,
    "decidedByName" TEXT, "decidedAt" TEXT, "note" TEXT)`,
  `CREATE TABLE IF NOT EXISTS "MktConversion" ("applicationId" TEXT PRIMARY KEY, "dueOn" TEXT, "convertedOn" TEXT, "newCtc" REAL, "fee" REAL,
    "status" TEXT NOT NULL DEFAULT 'Contract', "note" TEXT, "byName" TEXT, "at" TEXT)`,
  `CREATE TABLE IF NOT EXISTS "MktAgentRun" ("id" TEXT PRIMARY KEY, "kind" TEXT NOT NULL, "requirementId" TEXT, "status" TEXT NOT NULL,
    "steps" TEXT, "byId" TEXT, "byName" TEXT, "at" TEXT, "finishedAt" TEXT)`,
  `CREATE TABLE IF NOT EXISTS "MktAgentAction" ("id" TEXT PRIMARY KEY, "runId" TEXT NOT NULL, "kind" TEXT NOT NULL, "refType" TEXT, "refId" TEXT,
    "title" TEXT, "payload" TEXT, "status" TEXT NOT NULL DEFAULT 'Proposed', "decidedByName" TEXT, "decidedAt" TEXT, "result" TEXT)`,
  'CREATE INDEX IF NOT EXISTS "MktAgentAction_run" ON "MktAgentAction" ("runId")',
  `CREATE TABLE IF NOT EXISTS "MktWorkflow" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "trigger" TEXT NOT NULL, "cond" TEXT, "action" TEXT NOT NULL,
    "active" INTEGER NOT NULL DEFAULT 0, "byName" TEXT, "at" TEXT, "runs" INTEGER DEFAULT 0, "lastRunAt" TEXT)`,
  `CREATE TABLE IF NOT EXISTS "MktWorkflowLog" ("id" TEXT PRIMARY KEY, "workflowId" TEXT, "at" TEXT, "refId" TEXT, "dryRun" INTEGER,
    "outcome" TEXT, UNIQUE ("workflowId", "refId", "dryRun"))`,
  `CREATE TABLE IF NOT EXISTS "MktMcpToken" ("id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "userName" TEXT, "label" TEXT, "tokenHash" TEXT NOT NULL,
    "createdAt" TEXT, "lastUsedAt" TEXT, "revokedAt" TEXT)`,
  'CREATE TABLE IF NOT EXISTS "MktHealthRun" ("id" TEXT PRIMARY KEY, "at" TEXT, "byName" TEXT, "result" TEXT, "fixed" INTEGER DEFAULT 0)',
];

let READY = null;
function ensure() {
  if (!READY) {
    READY = (async () => {
      for (const sql of TABLES) await prisma.$executeRawUnsafe(sql); // eslint-disable-line no-await-in-loop
    })().catch((e) => { READY = null; throw e; });
  }
  return READY;
}

const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID();
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const parse = (s, d = null) => { if (s == null || s === '') return d; try { return JSON.parse(s); } catch { return d; } };
const clean = (v, max = 300) => { const s = String(v == null ? '' : v).replace(/<[^>]*>/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim(); return s ? s.slice(0, max) : null; };
const q = (sql, ...args) => ensure().then(() => prisma.$queryRawUnsafe(sql, ...args));
const x = (sql, ...args) => ensure().then(() => prisma.$executeRawUnsafe(sql, ...args));
const num = (v) => (typeof v === 'bigint' ? Number(v) : Number(v || 0));

// ---- the switches -------------------------------------------------------------------------------------------------------------
// type: bool | number. Every switch that reaches real people or automates work starts OFF.
const SWITCHES = {
  'autoReject.on': { type: 'bool', def: false, label: 'Auto-reject by rules', note: 'When ON, the rules below reject matching new applications automatically. Every one also goes to the human review queue, where it can be undone.' },
  'workflows.on': { type: 'bool', def: false, label: 'Workflow automations', note: 'When ON, the active "when X then Y" rules run every 2 minutes. Use Dry run first.' },
  'dataHealth.schedule': { type: 'bool', def: false, label: 'Nightly data-health check', note: 'When ON, the data-health check runs once a night and keeps the counts. With auto-fix it also tidies the safe things.' },
  'dataHealth.autofix': { type: 'bool', def: false, label: 'Data-health auto-fix', note: 'When ON, the nightly check also trims spaces in names, tidies city names and lowercases emails. Nothing else is changed.' },
  'alerts.savedSearch': { type: 'bool', def: false, label: 'Saved-search alerts', note: 'When ON, the owner of a saved search with alerts ticked gets a bell when new people match (checked every 6 hours).' },
  'alerts.jobWatch': { type: 'bool', def: false, label: 'Always-on job search alerts', note: 'When ON, the recruiter and TL of a job get a bell when new matching people appear (checked every 6 hours).' },
  'alerts.docExpiry': { type: 'bool', def: false, label: 'Document expiry alerts', note: 'When ON, the owner recruiter gets a bell 30 days before a candidate document expires (once per document).' },
  'alerts.staleProfile': { type: 'bool', def: false, label: 'Stale profile reminders', note: 'When ON, recruiters get one bell a week listing their people whose profile is older than the stale limit, with a reminder to send the update link.' },
  'placementApproval.on': { type: 'bool', def: false, label: 'Placement approval', note: 'When ON, every new joining waits for an Admin or BDE TL to approve the placement (fee, CTC, guarantee) in Candidates > Hiring tools. Invoices are not touched.' },
  'mcp.on': { type: 'bool', def: false, label: 'MCP server (read-only)', note: 'When ON, an AI tool holding one of your MCP tokens can read your own scoped ATS data (search people, read a requirement). It can never change anything.' },
  'feedbackBlind.on': { type: 'bool', def: true, label: 'Feedback blinding', note: 'An interviewer on a panel does not see the other panelists\' scores until they have submitted their own.' },
  'ai.monthlyLimit': { type: 'number', def: 0, label: 'AI calls per login per month', note: '0 = no limit. When a login reaches the limit, its AI features answer from the built-in rules until next month.' },
  'stale.days': { type: 'number', def: 180, label: 'A profile is stale after (days)', note: 'Used by the stale-profile list and reminders.' },
};
let cache = null; let cachedAt = 0;
async function settings({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cachedAt < 10000) return cache;
  const rows = await q('SELECT "key","value" FROM "MktSetting"');
  const out = {};
  Object.entries(SWITCHES).forEach(([k, d]) => { out[k] = d.def; });
  rows.forEach((r) => {
    const d = SWITCHES[r.key];
    if (!d) { out[r.key] = r.value; return; }
    out[r.key] = d.type === 'bool' ? r.value === '1' : Number(r.value) || 0;
  });
  cache = out; cachedAt = Date.now();
  return out;
}
async function setting(key) { return (await settings())[key]; }
async function saveSetting(key, value, byName) {
  const d = SWITCHES[key];
  const v = d ? (d.type === 'bool' ? (value === true || value === 1 || value === '1' || value === 'true' ? '1' : '0') : String(Math.max(0, Number(value) || 0))) : String(value == null ? '' : value).slice(0, 4000);
  await x('INSERT INTO "MktSetting" ("key","value","byName","at") VALUES (?,?,?,?) ON CONFLICT("key") DO UPDATE SET "value"=excluded."value","byName"=excluded."byName","at"=excluded."at"', key, v, byName || null, now());
  cache = null;
  return (await settings({ fresh: true }))[key];
}
function switchList(values) {
  return Object.entries(SWITCHES).map(([key, d]) => ({ key, ...d, value: values[key] }));
}

module.exports = { ensure, now, newId, hash, parse, clean, q, x, num, SWITCHES, settings, setting, saveSetting, switchList };
