// ---------------------------------------------------------------------------
// KAVYA - SELF-PROVISIONING TABLES. Same pattern as calling/schema.js: raw SQL, no Prisma model (no `prisma generate`, no migrate),
// CREATE TABLE IF NOT EXISTS the first time anything needs them. ADDITIVE ONLY: nothing existing is altered.
//
//   KavyaRun    one batch of candidates given to Kavya for ONE requirement (who started it, from which screen, the Kavya job id, status)
//   KavyaCall   one finished call of a run, copied from Kavya's results (outcome, language, seconds, interview slot, reason, area, distance)
// ---------------------------------------------------------------------------
const prisma = require('../../db');

const DDL = [
  `CREATE TABLE IF NOT EXISTS "KavyaRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL DEFAULT 'ats',
    "requirementId" TEXT,
    "title" TEXT NOT NULL DEFAULT '',
    "kavyaJobId" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "total" INTEGER NOT NULL DEFAULT 0,
    "peopleJson" TEXT NOT NULL DEFAULT '[]',
    "skippedJson" TEXT NOT NULL DEFAULT '[]',
    "note" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TEXT NOT NULL,
    "lastSyncAt" TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS "KavyaRun_status" ON "KavyaRun"("status", "createdAt")',
  `CREATE TABLE IF NOT EXISTS "KavyaCall" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "kavyaCallId" INTEGER NOT NULL,
    "applicationId" TEXT,
    "candidateId" TEXT,
    "phone" TEXT,
    "name" TEXT,
    "outcome" TEXT,
    "language" TEXT,
    "seconds" INTEGER,
    "slot" TEXT,
    "reasonType" TEXT,
    "reason" TEXT,
    "area" TEXT,
    "distanceKm" TEXT,
    "answersJson" TEXT,
    "calledAt" TEXT,
    "createdAt" TEXT NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "KavyaCall_unique" ON "KavyaCall"("runId", "kavyaCallId")',
  'CREATE INDEX IF NOT EXISTS "KavyaCall_run" ON "KavyaCall"("runId")',
];

let done = null;
function ensure() {
  if (done) return done;
  done = (async () => {
    for (const sql of DDL) await prisma.$executeRawUnsafe(sql); // eslint-disable-line no-await-in-loop
    return true;
  })().catch((err) => { done = null; console.error('[kavya] schema:', err.message); return false; }); // eslint-disable-line no-console
  return done;
}
const reset = () => { done = null; };
const nowIso = () => new Date().toISOString();
const plain = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]));
async function all(sql, ...params) { await ensure(); return (await prisma.$queryRawUnsafe(sql, ...params)).map(plain); }
async function one(sql, ...params) { const r = await all(sql, ...params); return r[0] || null; }
async function run(sql, ...params) { await ensure(); return prisma.$executeRawUnsafe(sql, ...params); }

module.exports = { DDL, ensure, reset, nowIso, all, one, run };
