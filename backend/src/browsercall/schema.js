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
  // PHONE LINES (2026-11-23): the lines a manual call can go out on besides the built-in office Synway (teamlink-gw). browsercall/lines.js.
  // Secrets (the password a device registers with, or the far end's password) are encrypted (utils/secrets) and never sent back to the browser.
  `CREATE TABLE IF NOT EXISTS "BrowserCallLine" (
    "id" TEXT NOT NULL PRIMARY KEY, "shortId" TEXT NOT NULL, "name" TEXT NOT NULL, "type" TEXT NOT NULL, "connect" TEXT NOT NULL,
    "host" TEXT, "port" INTEGER, "transport" TEXT NOT NULL DEFAULT 'udp', "username" TEXT, "secretEnc" TEXT,
    "acceptFromIpOnly" INTEGER NOT NULL DEFAULT 0, "dialFormat" TEXT NOT NULL DEFAULT '10', "prefix" TEXT, "callerId" TEXT,
    "maxCalls" INTEGER NOT NULL DEFAULT 4, "kinds" TEXT, "active" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL)`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "BrowserCallLine_short" ON "BrowserCallLine"("shortId")',
];
// columns added later to existing tables (guarded: "duplicate column" means it is already there)
const ALTERS = [
  'ALTER TABLE "BrowserCall" ADD COLUMN "lineId" TEXT',
  'ALTER TABLE "BrowserCall" ADD COLUMN "lineName" TEXT',
  // RECORDING + TRANSCRIPT + SUMMARY (2026-11-23, browsercall/recording.js). recordingStatus: off | pending | processing | done | missing | failed | none | deleted
  'ALTER TABLE "BrowserCall" ADD COLUMN "recordingStatus" TEXT',
  'ALTER TABLE "BrowserCall" ADD COLUMN "recordingPath" TEXT',
  'ALTER TABLE "BrowserCall" ADD COLUMN "recordingBytes" INTEGER',
  'ALTER TABLE "BrowserCall" ADD COLUMN "recordingSec" INTEGER',
  'ALTER TABLE "BrowserCall" ADD COLUMN "recordingNote" TEXT',
  'ALTER TABLE "BrowserCall" ADD COLUMN "recordingDeletedAt" TEXT',
  'ALTER TABLE "BrowserCall" ADD COLUMN "transcript" TEXT',
  'ALTER TABLE "BrowserCall" ADD COLUMN "transcriptSource" TEXT',
  'ALTER TABLE "BrowserCall" ADD COLUMN "summary" TEXT',
  'ALTER TABLE "BrowserCall" ADD COLUMN "summaryText" TEXT',
  'ALTER TABLE "BrowserCall" ADD COLUMN "summarySource" TEXT',
  'ALTER TABLE "BrowserCall" ADD COLUMN "processedAt" TEXT',
  'ALTER TABLE "BrowserCall" ADD COLUMN "processTries" INTEGER',
];

let ready = null;
function ensure() {
  if (!ready) {
    ready = (async () => {
      for (const sql of DDL) await prisma.$executeRawUnsafe(sql); // eslint-disable-line no-await-in-loop
      for (const sql of ALTERS) {
        // eslint-disable-next-line no-await-in-loop
        try { await prisma.$executeRawUnsafe(sql); } catch (e) { if (!/duplicate column/i.test(String(e && e.message))) throw e; }
      }
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
const plain = (r) => { const o = {}; for (const [k, v] of Object.entries(r)) o[k] = typeof v === 'bigint' ? Number(v) : v; return o; };
async function all(sql, ...p) { await ensure(); return (await prisma.$queryRawUnsafe(sql, ...p)).map(plain); }
async function one(sql, ...p) { return (await all(sql, ...p))[0] || null; }
async function run(sql, ...p) { await ensure(); return prisma.$executeRawUnsafe(sql, ...p); }
const nowIso = () => new Date().toISOString();

module.exports = { DDL, ensure, all, one, run, nowIso };
