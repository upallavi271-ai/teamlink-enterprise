// ---------------------------------------------------------------------------
// CRM WAVE A (2026-11-24, founder "Yes, build to 90%"): the tables of automation, integrations and reports. Same pattern as crm/schema.js:
// raw SQL, CREATE TABLE IF NOT EXISTS the first time anything needs them, additive only (no Prisma model, no migration).
//
//   CrmRule            an Admin's / Sales manager's own "when this happens, if these are true, do these" rule (crm/automation.js)
//   CrmRuleRun         one run of a rule on one record: done / waiting (a delay) / approval (waiting for approvers) / stopped / failed
//   CrmApproval        a multi-step approval a rule asked for: the steps, who decided each, Pending / Approved / Rejected
//   CrmWebhook         an outside address told about CRM events (signed POSTs; Zapier / Make / n8n subscribe here too) + CrmWebhookLog
//   CrmApiKey          a key an outside system uses for the CRM API (only its SHA-256 is kept; it acts as the person it belongs to)
//   CrmReport          a report somebody built (source, columns, filters, group, chart); private or shared with the CRM team
//   CrmReportSchedule  a report mailed by itself (daily / weekly / monthly) to people on the CRM team
//   CrmDashboardLayout the widgets of a person's own dashboard ('team' = the default a Sales manager sets for everybody)
//   CrmPipelineSnapshot the open pipeline of one day, per owner and stage (taken once a day; the trend reads it)
// ---------------------------------------------------------------------------
const prisma = require('../db');
const DB = require('./schema');

const DDL = [
  `CREATE TABLE IF NOT EXISTS "CrmRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "on" INTEGER NOT NULL DEFAULT 0,
    "trigger" TEXT NOT NULL,
    "kind" TEXT,
    "conditionsJson" TEXT, "matchAll" INTEGER NOT NULL DEFAULT 1,
    "actionsJson" TEXT, "timeJson" TEXT, "graphJson" TEXT, "notes" TEXT,
    "runs" INTEGER NOT NULL DEFAULT 0, "lastRunAt" TEXT,
    "createdById" TEXT, "createdByName" TEXT, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "CrmRuleRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ruleId" TEXT NOT NULL, "ruleName" TEXT,
    "event" TEXT, "kind" TEXT, "entityId" TEXT, "entityName" TEXT,
    "status" TEXT NOT NULL, "step" INTEGER NOT NULL DEFAULT 0, "dueAt" TEXT, "anchor" TEXT,
    "log" TEXT, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS "CrmRuleRun_due" ON "CrmRuleRun"("status", "dueAt")',
  'CREATE INDEX IF NOT EXISTS "CrmRuleRun_anchor" ON "CrmRuleRun"("ruleId", "entityId", "anchor")',
  `CREATE TABLE IF NOT EXISTS "CrmApproval" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ruleId" TEXT, "ruleName" TEXT, "runId" TEXT,
    "kind" TEXT NOT NULL, "entityId" TEXT NOT NULL, "entityName" TEXT,
    "title" TEXT NOT NULL, "stepsJson" TEXT NOT NULL, "step" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'Pending', "gate" TEXT,
    "createdAt" TEXT NOT NULL, "decidedAt" TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS "CrmApproval_entity" ON "CrmApproval"("kind", "entityId", "status")',
  `CREATE TABLE IF NOT EXISTS "CrmWebhook" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "url" TEXT NOT NULL, "secret" TEXT, "events" TEXT NOT NULL DEFAULT '*',
    "on" INTEGER NOT NULL DEFAULT 1, "includeContact" INTEGER NOT NULL DEFAULT 0, "source" TEXT, "label" TEXT,
    "createdById" TEXT, "createdByName" TEXT, "createdAt" TEXT NOT NULL,
    "lastStatus" TEXT, "lastAt" TEXT, "fails" INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS "CrmWebhookLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hookId" TEXT, "target" TEXT, "event" TEXT, "ok" INTEGER NOT NULL DEFAULT 0, "code" INTEGER, "error" TEXT, "attempt" INTEGER NOT NULL DEFAULT 1, "at" TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS "CrmWebhookLog_at" ON "CrmWebhookLog"("at")',
  `CREATE TABLE IF NOT EXISTS "CrmApiKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL, "userName" TEXT, "label" TEXT, "prefix" TEXT, "keyHash" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'read', "ips" TEXT,
    "createdById" TEXT, "createdByName" TEXT, "createdAt" TEXT NOT NULL, "lastUsedAt" TEXT, "revokedAt" TEXT, "uses" INTEGER NOT NULL DEFAULT 0
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "CrmApiKey_hash" ON "CrmApiKey"("keyHash")',
  `CREATE TABLE IF NOT EXISTS "CrmReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL, "source" TEXT NOT NULL, "specJson" TEXT NOT NULL,
    "ownerId" TEXT, "ownerName" TEXT, "shared" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "CrmReportSchedule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reportId" TEXT NOT NULL, "name" TEXT,
    "frequency" TEXT NOT NULL, "day" INTEGER, "time" TEXT NOT NULL,
    "recipientsJson" TEXT NOT NULL, "on" INTEGER NOT NULL DEFAULT 1,
    "ownerId" TEXT, "ownerName" TEXT, "lastSentAt" TEXT, "lastResult" TEXT, "nextAt" TEXT,
    "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "CrmDashboardLayout" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "widgetsJson" TEXT NOT NULL, "updatedAt" TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "CrmPipelineSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "day" TEXT NOT NULL, "ownerId" TEXT, "ownerName" TEXT, "stage" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0, "value" REAL NOT NULL DEFAULT 0, "weighted" REAL NOT NULL DEFAULT 0,
    "takenAt" TEXT NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "CrmPipelineSnapshot_day" ON "CrmPipelineSnapshot"("day", "ownerId", "stage")',
];

let done = null;
function ensure() {
  if (done) return done;
  done = (async () => {
    await DB.ensure();
    for (const sql of DDL) await prisma.$executeRawUnsafe(sql); // eslint-disable-line no-await-in-loop
    return true;
  })().catch((err) => { done = null; console.error('[crm] wave tables:', err.message); return false; }); // eslint-disable-line no-console
  return done;
}
const plain = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]));
async function all(sql, ...params) { await ensure(); return (await prisma.$queryRawUnsafe(sql, ...params)).map(plain); }
async function one(sql, ...params) { const r = await all(sql, ...params); return r[0] || null; }
async function run(sql, ...params) { await ensure(); return prisma.$executeRawUnsafe(sql, ...params); }
async function insert(table, row) {
  const cols = Object.keys(row);
  await run(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => row[c]));
  return one(`SELECT * FROM "${table}" WHERE "id" = ?`, row.id);
}
async function update(table, id, data, key = 'id') {
  const cols = Object.keys(data);
  if (cols.length) await run(`UPDATE "${table}" SET ${cols.map((c) => `"${c}" = ?`).join(', ')} WHERE "${key}" = ?`, ...cols.map((c) => data[c]), id);
  return one(`SELECT * FROM "${table}" WHERE "${key}" = ?`, id);
}
const parse = (s, fb) => { try { const v = JSON.parse(s); return v == null ? fb : v; } catch { return fb; } };

// ---- the switches (one AppSetting row, crm.wave): everything that reaches outside or works by itself starts OFF ---------------------------
const KEY = 'crm.wave';
const SWITCH_DEFAULTS = {
  rulesOn: false, // the admins' own rules run (each rule has its own on / off too)
  scriptsOn: false, // a rule may run a small script (Admin-written)
  webhooksOn: false, // CRM events are POSTed to the outside addresses
  chatOn: false, // CRM events are posted to Slack / Teams
  slackEvents: ['deal.won', 'lead.created'],
  teamsEvents: ['deal.won'],
  apiOn: false, // the CRM API answers keys
  mcpCrm: false, // outside AI tools (the MCP server) may read CRM data
  mcpWrite: false, // ... and add notes / follow-ups
  schedulesOn: false, // scheduled reports are mailed by themselves
  repsSeeBoard: false, // salespeople see the whole leaderboard (names and points), not only their own rank
  calendarFeed: false, // follow-ups as a calendar feed (Google Calendar / Outlook subscribe to a private link)
};
let cache = null; let cachedAt = 0;
async function switches({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cachedAt < 10000) return cache;
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } }).catch(() => null);
  const raw = row ? parse(row.value, {}) : {};
  const out = { ...SWITCH_DEFAULTS };
  for (const k of Object.keys(SWITCH_DEFAULTS)) {
    if (k in raw) out[k] = Array.isArray(SWITCH_DEFAULTS[k]) ? (Array.isArray(raw[k]) ? raw[k].map(String).slice(0, 40) : SWITCH_DEFAULTS[k]) : raw[k] === true;
  }
  out.feedSalt = typeof raw.feedSalt === 'string' && raw.feedSalt ? raw.feedSalt : null;
  cache = out; cachedAt = Date.now();
  return out;
}
async function saveSwitches(patch) {
  const cur = await switches({ fresh: true });
  const next = { ...cur };
  for (const k of Object.keys(SWITCH_DEFAULTS)) {
    if (!(k in (patch || {}))) continue;
    next[k] = Array.isArray(SWITCH_DEFAULTS[k]) ? (Array.isArray(patch[k]) ? patch[k].map(String).slice(0, 40) : cur[k]) : patch[k] === true;
  }
  if (patch && typeof patch.feedSalt === 'string') next.feedSalt = patch.feedSalt;
  await prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: JSON.stringify(next) }, update: { value: JSON.stringify(next) } });
  cache = next; cachedAt = Date.now();
  return next;
}

module.exports = { ensure, all, one, run, insert, update, parse, switches, saveSwitches, SWITCH_DEFAULTS };
