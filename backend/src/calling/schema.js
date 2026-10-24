// ---------------------------------------------------------------------------
// EXOTEL AI CALLING - SELF-PROVISIONING TABLES (2026-10-22).
//
// Same pattern as utils/vendorMailSchema.js: raw SQL tables with no Prisma model (no `prisma generate`, no migrate),
// created with CREATE TABLE IF NOT EXISTS the first time anything needs them. The hand-written migration
// 20261022100000_ai_calling holds the SAME statements and a rollback.sql. Every time column is TEXT (an ISO moment).
// ADDITIVE ONLY: nothing existing is altered.
//
//   AiCall             one row per call (the thing the recruiter confirmed). Retries are attempts of the same row.
//   AiCallEvent        every provider event + every started attempt (idempotency: eventKey is UNIQUE)
//   AiCallOffer        "offer an AI call" after a stage change to Shortlisted or an interview booking
//   AiCallJobSetting   per-job automation switches (an Admin ticks them)
//   AiCallSuppression  numbers never to be called by AI (opt-out / DND)
//   AiCallCampaign     a bulk run (name, purpose, job, who)
//   AiCallPref         the candidate's saved language for calls
// ---------------------------------------------------------------------------
const prisma = require('../db');

const DDL = [
  `CREATE TABLE IF NOT EXISTS "AiCall" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mode" TEXT NOT NULL DEFAULT 'live',
    "purpose" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "applicationId" TEXT,
    "candidateId" TEXT NOT NULL,
    "requirementId" TEXT,
    "campaignId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "scheduleVersion" TEXT,
    "slot" TEXT,
    "language" TEXT,
    "scriptJson" TEXT,
    "initiatedById" TEXT,
    "initiatedByName" TEXT,
    "initiatedVia" TEXT,
    "toMask" TEXT,
    "confirmedAt" TEXT,
    "confirmedById" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "nextAttemptAt" TEXT,
    "lastAttemptAt" TEXT,
    "callSid" TEXT,
    "providerStatus" TEXT,
    "startedAt" TEXT,
    "endedAt" TEXT,
    "durationSec" INTEGER,
    "outcome" TEXT,
    "outcomePending" INTEGER NOT NULL DEFAULT 0,
    "interest" TEXT,
    "answersJson" TEXT,
    "summary" TEXT,
    "transcript" TEXT,
    "botStateJson" TEXT,
    "recordingUrl" TEXT,
    "rescheduleWish" TEXT,
    "humanFollowUp" INTEGER NOT NULL DEFAULT 0,
    "nextAction" TEXT,
    "followUpDate" TEXT,
    "stageAtCall" TEXT,
    "failReason" TEXT,
    "waitReason" TEXT,
    "written" TEXT,
    "purgeAt" TEXT,
    "deletedAt" TEXT,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL
  )`,
  // ONE live call per (candidate, job, campaign, purpose, schedule version, reminder slot). A CANCELLED call frees the key.
  'CREATE UNIQUE INDEX IF NOT EXISTS "AiCall_dedupe" ON "AiCall"("dedupeKey") WHERE "status" <> \'cancelled\'',
  'CREATE INDEX IF NOT EXISTS "AiCall_cand" ON "AiCall"("candidateId", "createdAt")',
  'CREATE INDEX IF NOT EXISTS "AiCall_app" ON "AiCall"("applicationId", "createdAt")',
  'CREATE INDEX IF NOT EXISTS "AiCall_req" ON "AiCall"("requirementId", "createdAt")',
  'CREATE INDEX IF NOT EXISTS "AiCall_sid" ON "AiCall"("callSid")',
  'CREATE INDEX IF NOT EXISTS "AiCall_status" ON "AiCall"("status", "nextAttemptAt")',
  `CREATE TABLE IF NOT EXISTS "AiCallEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "callId" TEXT,
    "callSid" TEXT,
    "eventKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'provider',
    "status" TEXT,
    "payload" TEXT,
    "applied" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "receivedAt" TEXT NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "AiCallEvent_key" ON "AiCallEvent"("eventKey")',
  'CREATE INDEX IF NOT EXISTS "AiCallEvent_call" ON "AiCallEvent"("callId", "receivedAt")',
  'CREATE INDEX IF NOT EXISTS "AiCallEvent_kind" ON "AiCallEvent"("kind", "receivedAt")',
  `CREATE TABLE IF NOT EXISTS "AiCallOffer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "applicationId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "requirementId" TEXT,
    "kind" TEXT NOT NULL,
    "scheduleVersion" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "offeredToId" TEXT,
    "offeredToName" TEXT,
    "callId" TEXT,
    "createdAt" TEXT NOT NULL,
    "decidedAt" TEXT,
    "decidedByName" TEXT
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "AiCallOffer_one" ON "AiCallOffer"("applicationId", "kind", COALESCE("scheduleVersion", \'\'))',
  'CREATE INDEX IF NOT EXISTS "AiCallOffer_status" ON "AiCallOffer"("status", "createdAt")',
  `CREATE TABLE IF NOT EXISTS "AiCallJobSetting" (
    "requirementId" TEXT NOT NULL PRIMARY KEY,
    "enabled" INTEGER NOT NULL DEFAULT 1,
    "autoShortlist" INTEGER NOT NULL DEFAULT 0,
    "autoInterview" INTEGER NOT NULL DEFAULT 0,
    "autoReminders" INTEGER NOT NULL DEFAULT 0,
    "updatedById" TEXT,
    "updatedByName" TEXT,
    "updatedAt" TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "AiCallSuppression" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "phone" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TEXT NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "AiCallSuppression_one" ON "AiCallSuppression"("phone", "kind")',
  `CREATE TABLE IF NOT EXISTS "AiCallCampaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "requirementId" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "total" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "AiCallPref" (
    "candidateId" TEXT NOT NULL PRIMARY KEY,
    "language" TEXT NOT NULL,
    "source" TEXT,
    "updatedAt" TEXT NOT NULL
  )`,
];

let done = null;
function ensure() {
  if (done) return done;
  done = (async () => {
    for (const sql of DDL) await prisma.$executeRawUnsafe(sql); // eslint-disable-line no-await-in-loop
    return true;
  })().catch((err) => { done = null; console.error('[ai-calling] schema:', err.message); return false; }); // eslint-disable-line no-console
  return done;
}

// For tests: forget the cached answer.
const reset = () => { done = null; };

// Plain helpers shared by every module (raw SQL, no Prisma model).
const nowIso = () => new Date().toISOString();
// Prisma returns SQLite INTEGERs as BigInt, which JSON cannot carry: every number is turned back into a plain Number here.
const plain = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]));
async function all(sql, ...params) { await ensure(); return (await prisma.$queryRawUnsafe(sql, ...params)).map(plain); }
async function one(sql, ...params) { const r = await all(sql, ...params); return r[0] || null; }
async function run(sql, ...params) { await ensure(); return prisma.$executeRawUnsafe(sql, ...params); }

module.exports = { DDL, ensure, reset, nowIso, all, one, run };
