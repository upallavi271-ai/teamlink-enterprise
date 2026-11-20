// ---------------------------------------------------------------------------
// MANUAL BROWSER CALLING - SELF-PROVISIONING TABLES (2026-11-20). Same pattern as calling/schema.js: raw SQL, CREATE TABLE IF NOT EXISTS,
// the hand-written migration 20261120100000_browser_calls holds the SAME statements + rollback.sql. ADDITIVE ONLY. Times are ISO TEXT.
//   BrowserCallSetting    key/value (mode Off|Test|Live, test numbers, allowed login kinds)
//   BrowserCallExtension  one SIP extension per TeamLink login (password stored encrypted, rotated per softphone session)
//   BrowserCall           one row per call, filled from REAL Asterisk (AMI) events
//   BrowserCallEvent      the raw Asterisk events of a call (audit)
// ---------------------------------------------------------------------------
const prisma = require('../db');

const DDL = [
  `CREATE TABLE IF NOT EXISTS "BrowserCallSetting" ("key" TEXT NOT NULL PRIMARY KEY, "value" TEXT, "updatedAt" TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS "BrowserCallExtension" (
    "id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "extension" TEXT NOT NULL, "secretEnc" TEXT NOT NULL,
    "active" INTEGER NOT NULL DEFAULT 1, "rotatedAt" TEXT, "expiresAt" TEXT, "createdAt" TEXT NOT NULL)`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "BrowserCallExtension_user" ON "BrowserCallExtension"("userId")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "BrowserCallExtension_ext" ON "BrowserCallExtension"("extension")',
  `CREATE TABLE IF NOT EXISTS "BrowserCall" (
    "id" TEXT NOT NULL PRIMARY KEY, "token" TEXT NOT NULL, "asteriskUniqueId" TEXT, "asteriskLinkedId" TEXT,
    "candidateId" TEXT NOT NULL, "applicationId" TEXT, "userId" TEXT NOT NULL, "userName" TEXT,
    "toNumber" TEXT NOT NULL, "extension" TEXT NOT NULL, "direction" TEXT NOT NULL DEFAULT 'outbound', "mode" TEXT,
    "status" TEXT NOT NULL DEFAULT 'initiated', "startAt" TEXT NOT NULL, "answerAt" TEXT, "endAt" TEXT,
    "durationSec" INTEGER, "talkSec" INTEGER, "hangupCause" INTEGER, "hangupReason" TEXT, "dialStatus" TEXT,
    "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL)`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "BrowserCall_token" ON "BrowserCall"("token")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "BrowserCall_uid" ON "BrowserCall"("asteriskUniqueId") WHERE "asteriskUniqueId" IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS "BrowserCall_cand" ON "BrowserCall"("candidateId", "startAt")',
  'CREATE INDEX IF NOT EXISTS "BrowserCall_user" ON "BrowserCall"("userId", "startAt")',
  `CREATE TABLE IF NOT EXISTS "BrowserCallEvent" (
    "id" TEXT NOT NULL PRIMARY KEY, "callId" TEXT, "uniqueId" TEXT, "event" TEXT NOT NULL, "payload" TEXT, "at" TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS "BrowserCallEvent_call" ON "BrowserCallEvent"("callId", "at")',
];

let ready = null;
function ensure() {
  if (!ready) {
    ready = (async () => { for (const sql of DDL) await prisma.$executeRawUnsafe(sql); })().catch((e) => { ready = null; throw e; }); // eslint-disable-line no-await-in-loop
  }
  return ready;
}
const plain = (r) => { const o = {}; for (const [k, v] of Object.entries(r)) o[k] = typeof v === 'bigint' ? Number(v) : v; return o; };
async function all(sql, ...p) { await ensure(); return (await prisma.$queryRawUnsafe(sql, ...p)).map(plain); }
async function one(sql, ...p) { return (await all(sql, ...p))[0] || null; }
async function run(sql, ...p) { await ensure(); return prisma.$executeRawUnsafe(sql, ...p); }
const nowIso = () => new Date().toISOString();

module.exports = { DDL, ensure, all, one, run, nowIso };
