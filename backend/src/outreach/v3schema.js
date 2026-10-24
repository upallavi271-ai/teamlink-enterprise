// ---------------------------------------------------------------------------
// OMNI-CHANNEL v3 SELF-PROVISIONING (2026-10-17, "WhiteStart as the base"). Same pattern as credits.js / sequences.js:
//   * new tables:  CREATE TABLE IF NOT EXISTS (OmniLibrary, OmniForm, OmniFormSubmission)
//   * new columns: PRAGMA table_info first, ALTER TABLE ... ADD COLUMN only when missing (SQLite has no ADD COLUMN IF NOT EXISTS), each guarded
//     by "the table exists" so a database without the Outreach tables is left alone.
//     OutreachContact   language, preferredChannel, notes, lastReplyAt, customValues
//     OutreachCampaign  meta (JSON: goal, department, libraryIds, varMap, ...), approval, perMinute
//     OutreachMessage   repliedAt, callMinutes
//     OutreachSegment   refreshedAt
//     OutreachTemplate  category
// The hand-written migration (20261017100000_omni_v3_library_forms) holds the TABLES only (ALTERs would fail with "duplicate column" when the
// app has already added them); the column list above is in its header and in its rollback note. ensure() is cheap after the first call and never throws.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const q = (sql, ...p) => prisma.$queryRawUnsafe(sql, ...p);
const run = (sql, ...p) => prisma.$executeRawUnsafe(sql, ...p);

const DDL = [
  'CREATE TABLE IF NOT EXISTS "OmniLibrary" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "kind" TEXT NOT NULL DEFAULT \'file\', "mime" TEXT, "size" INTEGER NOT NULL DEFAULT 0, "stored" TEXT, "linkUrl" TEXT, "token" TEXT, "department" TEXT, "note" TEXT, "createdById" TEXT, "createdByName" TEXT, "createdAt" DATETIME NOT NULL DEFAULT 0, "deletedAt" DATETIME)',
  'CREATE UNIQUE INDEX IF NOT EXISTS "OmniLibrary_token" ON "OmniLibrary"("token")',
  'CREATE TABLE IF NOT EXISTS "OmniForm" ("id" TEXT NOT NULL PRIMARY KEY, "token" TEXT NOT NULL, "name" TEXT NOT NULL, "department" TEXT, "industry" TEXT, "fields" TEXT NOT NULL DEFAULT \'[]\', "channels" TEXT NOT NULL DEFAULT \'["whatsapp","email"]\', "consentText" TEXT NOT NULL, "thanks" TEXT, "status" TEXT NOT NULL DEFAULT \'on\', "createdById" TEXT, "createdByName" TEXT, "createdAt" DATETIME NOT NULL DEFAULT 0, "updatedAt" DATETIME NOT NULL DEFAULT 0, "deletedAt" DATETIME)',
  'CREATE UNIQUE INDEX IF NOT EXISTS "OmniForm_token" ON "OmniForm"("token")',
  'CREATE TABLE IF NOT EXISTS "OmniFormSubmission" ("id" TEXT NOT NULL PRIMARY KEY, "formId" TEXT NOT NULL, "contactId" TEXT, "result" TEXT NOT NULL, "at" DATETIME NOT NULL DEFAULT 0)',
  'CREATE INDEX IF NOT EXISTS "OmniFormSubmission_form" ON "OmniFormSubmission"("formId", "at")',
];
const COLUMNS = [
  ['OutreachContact', 'language', 'TEXT'], ['OutreachContact', 'preferredChannel', 'TEXT'], ['OutreachContact', 'notes', 'TEXT'], ['OutreachContact', 'lastReplyAt', 'DATETIME'], ['OutreachContact', 'customValues', 'TEXT'],
  ['OutreachCampaign', 'meta', 'TEXT'], ['OutreachCampaign', 'approval', 'TEXT'], ['OutreachCampaign', 'perMinute', 'INTEGER'], ['OutreachCampaign', 'kind', 'TEXT'],
  ['OutreachMessage', 'repliedAt', 'DATETIME'], ['OutreachMessage', 'callMinutes', 'INTEGER'], ['OutreachMessage', 'readAt', 'DATETIME'],
  ['OutreachSegment', 'refreshedAt', 'DATETIME'],
  ['OutreachTemplate', 'category', 'TEXT'], ['OutreachTemplate', 'extra', 'TEXT'],
];

// An earlier build declared the millisecond time columns as INTEGER, which Prisma's raw reads refuse once a real time is in them (this codebase keeps
// milliseconds in DATETIME columns). While nothing is stored yet, make them again with the right type: a table with no rows is dropped (it is re-created
// below), a column with no values is dropped (it is re-added below). Anything that already holds data is never touched.
const TIME_TABLES = ['OmniLibrary', 'OmniForm', 'OmniFormSubmission'];
const TIME_COLUMNS = COLUMNS.filter(([, , type]) => type === 'DATETIME');
async function repairTimeColumns() {
  for (const t of TIME_TABLES) {
    const info = await q(`PRAGMA table_info("${t}")`);
    if (info.length && info.some((c) => ['createdAt', 'updatedAt', 'deletedAt', 'at'].includes(c.name) && String(c.type).toUpperCase() === 'INTEGER')) {
      const n = Number((await q(`SELECT COUNT(*) n FROM "${t}"`))[0].n);
      if (n === 0) await run(`DROP TABLE "${t}"`);
    }
  }
  for (const [t, c] of TIME_COLUMNS) {
    const info = await q(`PRAGMA table_info("${t}")`);
    const col = info.find((x) => x.name === c);
    if (col && String(col.type).toUpperCase() === 'INTEGER') {
      const n = Number((await q(`SELECT COUNT(*) n FROM "${t}" WHERE "${c}" IS NOT NULL`))[0].n);
      if (n === 0) await run(`ALTER TABLE "${t}" DROP COLUMN "${c}"`);
    }
  }
}

let okAt = 0; let ensuring = null;
async function ensure() {
  if (okAt && Date.now() - okAt < 600000) return true;
  if (!ensuring) {
    ensuring = (async () => {
      try {
        await repairTimeColumns();
        for (const sql of DDL) await run(sql); // eslint-disable-line no-await-in-loop
        const have = {};
        for (const [t, c, type] of COLUMNS) {
          if (!(t in have)) { // eslint-disable-next-line no-await-in-loop
            have[t] = await q(`PRAGMA table_info("${t}")`);
          }
          const cols = have[t];
          if (cols.length && !cols.some((x) => x.name === c)) { await run(`ALTER TABLE "${t}" ADD COLUMN "${c}" ${type}`); cols.push({ name: c }); } // eslint-disable-line no-await-in-loop
        }
        okAt = Date.now();
        return true;
      } catch (e) { console.error('[omni-v3] schema:', e.message); return false; } // eslint-disable-line no-console
      finally { ensuring = null; }
    })();
  }
  return ensuring;
}
// for a test that builds its own database
function reset() { okAt = 0; }

module.exports = { ensure, reset, DDL, COLUMNS };
