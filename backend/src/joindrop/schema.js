// ---------------------------------------------------------------------------
// JOINING & DROP - SELF-PROVISIONING (2026-10-17).
//
// Same pattern as outreach/v3schema.js: raw-SQL tables, no Prisma model, created with CREATE TABLE IF NOT EXISTS the first time anything needs them
// (the hand-written migration 20261017190000_joining_drop holds the same statements and a rollback). Every time column is TEXT (an ISO string:
// 'YYYY-MM-DD' for a day, a full ISO time for a moment), so sorting and comparing is plain text and nothing depends on a Prisma date type.
//
//   JoiningRecord   ONE live row per application: who joined, when, where, with which client / job, the people at the time, the guarantee end;
//                   and - on the same row - the drop (date, reason, who reported it, from where) and the client's replacement decision.
//   JoiningEvent    the HISTORY. Every join, drop report, correction, client decision, replacement link, reopen is one row (who, when, old -> new).
//                   Rows are only ever added: nothing here updates or deletes an event.
//   JoinDropNotice  the delivery log: who was told what (bell / email / task / candidate message), the result in plain words, one row per
//                   person per channel per event (the unique index is the "no double email" guard).
//
// ensure() is cheap after the first call and never throws (a failure is logged and answered with false).
// ---------------------------------------------------------------------------
const prisma = require('../db');

const q = (sql, ...p) => prisma.$queryRawUnsafe(sql, ...p);
const run = (sql, ...p) => prisma.$executeRawUnsafe(sql, ...p);

const DDL = [
  `CREATE TABLE IF NOT EXISTS "JoiningRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "applicationId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "candidateName" TEXT,
    "requirementId" TEXT,
    "jobTitle" TEXT,
    "jobCode" TEXT,
    "clientId" TEXT,
    "clientName" TEXT,
    "department" TEXT,
    "hiringType" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Joined',
    "joinedOn" TEXT,
    "location" TEXT,
    "designation" TEXT,
    "offeredCtc" REAL,
    "employmentType" TEXT,
    "reportingPerson" TEXT,
    "reportingContact" TEXT,
    "recruiterUserId" TEXT, "recruiterName" TEXT,
    "tlUserId" TEXT, "tlName" TEXT,
    "bdeUserId" TEXT, "bdeName" TEXT,
    "seat" TEXT,
    "guaranteeDays" INTEGER,
    "guaranteeStartOn" TEXT,
    "guaranteeEndsOn" TEXT,
    "guaranteeSource" TEXT,
    "replacementTaskId" TEXT,
    "replacementTaskState" TEXT,
    "replacementTaskCancelReason" TEXT,
    "replacementTaskCancelledByName" TEXT,
    "replacementTaskCancelledAt" TEXT,
    "notes" TEXT,
    "recordedById" TEXT, "recordedByName" TEXT, "recordedByRole" TEXT, "recordedVia" TEXT,
    "backfilled" INTEGER NOT NULL DEFAULT 0,
    "droppedOn" TEXT,
    "lastWorkingDay" TEXT,
    "dropReason" TEXT,
    "dropReasonDetail" TEXT,
    "dropReportedById" TEXT, "dropReportedByName" TEXT, "dropReportedByRole" TEXT, "dropReportedFrom" TEXT, "dropReportedAt" TEXT,
    "dropWithinGuarantee" INTEGER,
    "dropDaysSinceJoining" INTEGER,
    "dropAfterIncentive" INTEGER NOT NULL DEFAULT 0,
    "replacementDecision" TEXT,
    "replacementComment" TEXT,
    "replacementExpectedOn" TEXT,
    "replacementProfileNotes" TEXT,
    "replacementDecidedAt" TEXT, "replacementDecidedById" TEXT, "replacementDecidedByName" TEXT,
    "replacementOnBehalf" INTEGER NOT NULL DEFAULT 0,
    "replacementStatus" TEXT,
    "replacementApplicationId" TEXT,
    "replacementLinkedAt" TEXT,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "JoiningRecord_application" ON "JoiningRecord"("applicationId")',
  'CREATE INDEX IF NOT EXISTS "JoiningRecord_candidate" ON "JoiningRecord"("candidateId")',
  'CREATE INDEX IF NOT EXISTS "JoiningRecord_client" ON "JoiningRecord"("clientId", "status")',
  'CREATE INDEX IF NOT EXISTS "JoiningRecord_joined" ON "JoiningRecord"("joinedOn")',
  'CREATE INDEX IF NOT EXISTS "JoiningRecord_status" ON "JoiningRecord"("status", "droppedOn")',
  `CREATE TABLE IF NOT EXISTS "JoiningEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recordId" TEXT NOT NULL,
    "applicationId" TEXT,
    "candidateId" TEXT,
    "at" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "byId" TEXT, "byName" TEXT, "byRole" TEXT,
    "fromWhere" TEXT,
    "onBehalf" INTEGER NOT NULL DEFAULT 0,
    "summary" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "note" TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS "JoiningEvent_record" ON "JoiningEvent"("recordId", "at")',
  'CREATE INDEX IF NOT EXISTS "JoiningEvent_candidate" ON "JoiningEvent"("candidateId", "at")',
  `CREATE TABLE IF NOT EXISTS "JoinDropNotice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recordId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "party" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "recipientKey" TEXT NOT NULL,
    "recipientName" TEXT,
    "recipientEmail" TEXT,
    "userId" TEXT,
    "status" TEXT,
    "detail" TEXT,
    "createdAt" TEXT NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "JoinDropNotice_once" ON "JoinDropNotice"("eventId", "channel", "recipientKey")',
  'CREATE INDEX IF NOT EXISTS "JoinDropNotice_record" ON "JoinDropNotice"("recordId", "createdAt")',
];

// Columns added after the first build: a table that already exists gets them with a guarded ALTER (SQLite has no ADD COLUMN IF NOT EXISTS).
const COLUMNS = [
  ['JoiningRecord', 'guaranteeStartOn', 'TEXT'], ['JoiningRecord', 'guaranteeSource', 'TEXT'], ['JoiningRecord', 'replacementTaskId', 'TEXT'],
  ['JoiningRecord', 'replacementTaskState', 'TEXT'], ['JoiningRecord', 'replacementTaskCancelReason', 'TEXT'],
  ['JoiningRecord', 'replacementTaskCancelledByName', 'TEXT'], ['JoiningRecord', 'replacementTaskCancelledAt', 'TEXT'],
];

let okAt = 0;
let ensuring = null;
async function ensure() {
  if (okAt && Date.now() - okAt < 600000) return true;
  if (!ensuring) {
    ensuring = (async () => {
      try {
        for (const sql of DDL) await run(sql); // eslint-disable-line no-await-in-loop
        const have = {};
        for (const [t, c, type] of COLUMNS) {
          if (!(t in have)) have[t] = await q(`PRAGMA table_info("${t}")`); // eslint-disable-line no-await-in-loop
          if (have[t].length && !have[t].some((x) => x.name === c)) { await run(`ALTER TABLE "${t}" ADD COLUMN "${c}" ${type}`); have[t].push({ name: c }); } // eslint-disable-line no-await-in-loop
        }
        okAt = Date.now();
        return true;
      } catch (e) { console.error('[join-drop] schema:', e.message); return false; } // eslint-disable-line no-console
      finally { ensuring = null; }
    })();
  }
  return ensuring;
}

// A raw row -> plain JS (SQLite integers come back as BigInt).
function plain(row) {
  if (!row) return row;
  const o = {};
  Object.keys(row).forEach((k) => { o[k] = typeof row[k] === 'bigint' ? Number(row[k]) : row[k]; });
  return o;
}
const rows = async (sql, ...p) => (await q(sql, ...p)).map(plain);
const one = async (sql, ...p) => (await rows(sql, ...p))[0] || null;

module.exports = { ensure, q, run, rows, one, plain, DDL };
