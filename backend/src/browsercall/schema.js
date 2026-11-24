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
  // ONE SIM NUMBER PER RECRUITER (2026-11-25, browsercall/sims.js): the Synway GSM ports in use, each given to at most one person (and a person
  // has at most one). dialPrefix = what the gateway's IP->GSM rule picks the port by; matchBy number|tag = how an incoming call finds its port.
  `CREATE TABLE IF NOT EXISTS "BrowserCallSim" (
    "id" TEXT NOT NULL PRIMARY KEY, "port" INTEGER NOT NULL, "simNumber" TEXT, "operator" TEXT, "active" INTEGER NOT NULL DEFAULT 1,
    "userId" TEXT, "dialPrefix" TEXT NOT NULL, "matchBy" TEXT NOT NULL DEFAULT 'number', "tag" TEXT NOT NULL, "note" TEXT,
    "createdById" TEXT, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL)`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "BrowserCallSim_port" ON "BrowserCallSim"("port")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "BrowserCallSim_number" ON "BrowserCallSim"("simNumber")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "BrowserCallSim_tag" ON "BrowserCallSim"("tag")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "BrowserCallSim_user" ON "BrowserCallSim"("userId") WHERE "userId" IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS "BrowserCall_dir" ON "BrowserCall"("direction", "status", "startAt")',
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
  // AFTER-CALL NOTES of a call on the Android phone (2026-11-24, browsercall/phoneLink.js): what the recruiter writes down after the call
  'ALTER TABLE "BrowserCall" ADD COLUMN "remarks" TEXT',
  'ALTER TABLE "BrowserCall" ADD COLUMN "nextAction" TEXT',
  'ALTER TABLE "BrowserCall" ADD COLUMN "followUpAt" TEXT',
  'ALTER TABLE "BrowserCall" ADD COLUMN "outcome" TEXT',
  // BRIDGE through the Android phone (2026-11-24, browsercall/phoneLink.js): the browser calls the phone on the office line, the phone answers by
  // itself, dials the candidate from its own SIM and merges the two calls. bridgeStatus: arming | armed | answered | dialing | connected | merged | ended | failed
  'ALTER TABLE "BrowserCall" ADD COLUMN "bridgeDeviceId" TEXT',
  'ALTER TABLE "BrowserCall" ADD COLUMN "bridgeStatus" TEXT',
  'ALTER TABLE "BrowserCall" ADD COLUMN "bridgeTalkSec" INTEGER',
  'ALTER TABLE "BrowserCall" ADD COLUMN "bridgeNote" TEXT',
  'ALTER TABLE "BrowserCall" ADD COLUMN "bridgeTrace" TEXT',
];

// 2026-11-24 (founder: "16 sims - edu 4, team 4, medical 4, mfg 4"): a port can be given to a recruiter before its SIM's number is known
// (it is matched by its port tag then). Tables made before this have "simNumber" NOT NULL: rebuild that one table once, rows kept.
async function simNumberOptional() {
  const cols = await prisma.$queryRawUnsafe('PRAGMA table_info("BrowserCallSim")');
  const c = cols.find((x) => x.name === 'simNumber');
  if (!c || !Number(c.notnull)) return;
  const make = DDL.find((s) => s.includes('CREATE TABLE IF NOT EXISTS "BrowserCallSim"')).replace('"BrowserCallSim" (', '"BrowserCallSim_new" (');
  const idx = DDL.filter((s) => s.includes('INDEX IF NOT EXISTS "BrowserCallSim_'));
  const list = '"id","port","simNumber","operator","active","userId","dialPrefix","matchBy","tag","note","createdById","createdAt","updatedAt"';
  await prisma.$transaction([
    prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "BrowserCallSim_new"'),
    prisma.$executeRawUnsafe(make),
    prisma.$executeRawUnsafe(`INSERT INTO "BrowserCallSim_new" (${list}) SELECT ${list} FROM "BrowserCallSim"`),
    prisma.$executeRawUnsafe('DROP TABLE "BrowserCallSim"'),
    prisma.$executeRawUnsafe('ALTER TABLE "BrowserCallSim_new" RENAME TO "BrowserCallSim"'),
    ...idx.map((s) => prisma.$executeRawUnsafe(s)),
  ]);
}

let ready = null;
function ensure() {
  if (!ready) {
    ready = (async () => {
      for (const sql of DDL) await prisma.$executeRawUnsafe(sql); // eslint-disable-line no-await-in-loop
      await simNumberOptional();
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
