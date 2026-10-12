-- Automatic stage messages (user, 2026-10-10): "schedule a message every time a candidate moves to the next step".
-- ADDITIVE ONLY: one new table, nothing existing is touched. The rules, the go-live time, the kill switch,
-- the per-job and per-person overrides live in AppSetting (keys "auto-messages", "auto-messages.job.<id>",
-- "auto-messages.pause.<candidateId>"), so they need no table.
--   ScheduledMessage  one row per (step change x rule): who, which step move, when it goes, how it is worded,
--                     what happened (Scheduled / Waiting approval / Sending / Sent / Failed / Cancelled / Skipped + reason).
-- DateTime columns hold epoch milliseconds (the same as every Prisma SQLite DateTime).
-- The application reads and writes this table with plain SQL, so it works before or after `prisma generate`.
-- Undo: rollback.sql.
CREATE TABLE "ScheduledMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "candidateId" TEXT NOT NULL,
    "applicationId" TEXT,
    "requirementId" TEXT,
    "stageEventId" TEXT,
    "stageFrom" TEXT,
    "stageTo" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "statusReason" TEXT,
    "sendAt" DATETIME,
    "whenMode" TEXT,
    "channelPlan" TEXT,
    "wording" TEXT NOT NULL DEFAULT 'TEMPLATE',
    "instruction" TEXT,
    "purpose" TEXT,
    "language" TEXT,
    "urgent" INTEGER NOT NULL DEFAULT 0,
    "subject" TEXT,
    "body" TEXT,
    "aiWritten" INTEGER NOT NULL DEFAULT 0,
    "aiNote" TEXT,
    "edited" INTEGER NOT NULL DEFAULT 0,
    "resultJson" TEXT,
    "sentAt" DATETIME,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "candidateName" TEXT,
    "jobTitle" TEXT,
    "department" TEXT,
    "createdByUserId" TEXT,
    "createdByName" TEXT,
    "decidedByUserId" TEXT,
    "decidedByName" TEXT,
    "decidedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX "ScheduledMessage_dedupeKey_key" ON "ScheduledMessage"("dedupeKey");
CREATE INDEX "ScheduledMessage_status_sendAt_idx" ON "ScheduledMessage"("status", "sendAt");
CREATE INDEX "ScheduledMessage_candidateId_idx" ON "ScheduledMessage"("candidateId");
CREATE INDEX "ScheduledMessage_applicationId_idx" ON "ScheduledMessage"("applicationId");
CREATE INDEX "ScheduledMessage_createdAt_idx" ON "ScheduledMessage"("createdAt");
