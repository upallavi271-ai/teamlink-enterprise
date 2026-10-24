-- Duplicate jobs (requirements) — detect, prevent at creation, merge (user, 2026-10-13: "Req lo duplicates unte remove cheyyu").
-- ADDITIVE ONLY: three new small tables, nothing existing is touched. Detection itself needs no table (a job is compared with the
-- other jobs of the SAME client on the fly); these hold what people DECIDED and what a merge did.
--   JobDupDecision  a pair somebody marked "Not a duplicate" (or "Create anyway: different job"): never offered again.
--   JobMergeLog     every merge: who, which job was kept / merged away, the merged-away job as it was, the id of every row that moved
--                   -> the undo window (7 days).
--   JobAlias        a merged-away job (its id and its code) -> the kept job, so old links / codes still open the kept job.
-- DateTime columns hold epoch milliseconds (the same as every Prisma SQLite DateTime). The application reads and writes these
-- tables with plain SQL, so it works before or after `prisma generate`; without the tables detection and the creation card still
-- work, only "Not a duplicate" memory, merge and undo wait for this migration.
-- Undo: rollback.sql.
CREATE TABLE "JobDupDecision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pairKey" TEXT NOT NULL,
    "jobAId" TEXT NOT NULL,
    "jobBId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'NOT_DUPLICATE',
    "reason" TEXT,
    "door" TEXT,
    "decidedById" TEXT,
    "decidedByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX "JobDupDecision_pairKey_key" ON "JobDupDecision"("pairKey");

CREATE TABLE "JobMergeLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "keptId" TEXT NOT NULL,
    "extraId" TEXT NOT NULL,
    "clientId" TEXT,
    "keptCode" TEXT,
    "extraCode" TEXT,
    "summary" TEXT,
    "level" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DONE',
    "openingsRule" TEXT,
    "keptBefore" TEXT,
    "extraBefore" TEXT,
    "moved" TEXT,
    "performedById" TEXT,
    "performedByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT 0,
    "undoUntil" DATETIME NOT NULL DEFAULT 0,
    "undoneAt" DATETIME,
    "undoneById" TEXT,
    "undoneByName" TEXT
);
CREATE INDEX "JobMergeLog_keptId_idx" ON "JobMergeLog"("keptId");
CREATE INDEX "JobMergeLog_extraId_idx" ON "JobMergeLog"("extraId");
CREATE INDEX "JobMergeLog_clientId_idx" ON "JobMergeLog"("clientId");

CREATE TABLE "JobAlias" (
    "oldId" TEXT NOT NULL PRIMARY KEY,
    "oldCode" TEXT,
    "keptId" TEXT NOT NULL,
    "mergeLogId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT 0
);
CREATE INDEX "JobAlias_keptId_idx" ON "JobAlias"("keptId");
CREATE INDEX "JobAlias_oldCode_idx" ON "JobAlias"("oldCode");
