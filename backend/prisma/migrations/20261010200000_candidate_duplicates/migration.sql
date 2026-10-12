-- Candidate duplicates: detect at entry, hold at the first step until resolved (user, 2026-10-10:
-- "Duplicate profiles anni first stage lone verify avvali").
-- ADDITIVE ONLY: six new tables, nothing existing is touched.
--   CandidateDupKey    the fingerprints of every candidate (phone, email, name+date of birth, resume file hash,
--                      resume-text bands, name+city / college / company), indexed so a lookup is one index read
--                      and detection never loads the 17k candidate rows.
--   CandidateDupSig    the resume-text signature (MinHash) used to confirm a "looks like the same resume" band hit.
--   CandidateDupFlag   one row per PAIR (the newer profile = candidateId, the one it resembles = matchCandidateId):
--                      level CERTAIN / LIKELY / POSSIBLE, what matched, and its life: OPEN -> resolved
--                      (NOT_DUPLICATE is remembered here so the pair is never flagged again).
--                      OPEN / MERGE_REQUESTED + CERTAIN / LIKELY hold the profile at the first step (applyStageMove).
--   CandidateMergeLog  every merge: who, what moved (ids), the donors as they were -> the undo window.
--   CandidateAlias     an old (merged-away) candidate id -> the kept one, so old links keep working.
-- DateTime columns hold epoch milliseconds (the same as every Prisma SQLite DateTime).
-- The application reads and writes these tables with plain SQL, so it works before or after `prisma generate`.
-- Undo: rollback.sql.
CREATE TABLE "CandidateDupKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "candidateId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX "CandidateDupKey_candidateId_kind_value_key" ON "CandidateDupKey"("candidateId", "kind", "value");
CREATE INDEX "CandidateDupKey_kind_value_idx" ON "CandidateDupKey"("kind", "value");

CREATE TABLE "CandidateDupSig" (
    "candidateId" TEXT NOT NULL PRIMARY KEY,
    "resumeSig" TEXT,
    "resumeSha" TEXT,
    "resumeChars" INTEGER,
    "updatedAt" DATETIME NOT NULL DEFAULT 0
);

CREATE TABLE "CandidateDupFlag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pairKey" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "matchCandidateId" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "reasons" TEXT,
    "detail" TEXT,
    "door" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "enteredById" TEXT,
    "enteredByName" TEXT,
    "requestedById" TEXT,
    "requestedByName" TEXT,
    "requestedAt" DATETIME,
    "requestMasterId" TEXT,
    "requestChoices" TEXT,
    "requestNote" TEXT,
    "resolvedById" TEXT,
    "resolvedByName" TEXT,
    "resolvedAt" DATETIME,
    "resolution" TEXT,
    "reason" TEXT,
    "mergeLogId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX "CandidateDupFlag_pairKey_key" ON "CandidateDupFlag"("pairKey");
CREATE INDEX "CandidateDupFlag_candidateId_status_idx" ON "CandidateDupFlag"("candidateId", "status");
CREATE INDEX "CandidateDupFlag_matchCandidateId_status_idx" ON "CandidateDupFlag"("matchCandidateId", "status");
CREATE INDEX "CandidateDupFlag_status_level_idx" ON "CandidateDupFlag"("status", "level");
CREATE INDEX "CandidateDupFlag_createdAt_idx" ON "CandidateDupFlag"("createdAt");

CREATE TABLE "CandidateMergeLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "masterId" TEXT NOT NULL,
    "donorIds" TEXT NOT NULL,
    "summary" TEXT,
    "kind" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DONE',
    "flagId" TEXT,
    "fieldChoices" TEXT,
    "masterBefore" TEXT,
    "snapshot" TEXT,
    "moved" TEXT,
    "performedById" TEXT,
    "performedByName" TEXT,
    "requestedById" TEXT,
    "requestedByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT 0,
    "undoUntil" DATETIME,
    "undoneAt" DATETIME,
    "undoneById" TEXT,
    "undoneByName" TEXT
);
CREATE INDEX "CandidateMergeLog_masterId_idx" ON "CandidateMergeLog"("masterId");
CREATE INDEX "CandidateMergeLog_createdAt_idx" ON "CandidateMergeLog"("createdAt");

CREATE TABLE "CandidateAlias" (
    "oldId" TEXT NOT NULL PRIMARY KEY,
    "candidateId" TEXT NOT NULL,
    "mergeLogId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT 0
);
CREATE INDEX "CandidateAlias_candidateId_idx" ON "CandidateAlias"("candidateId");
