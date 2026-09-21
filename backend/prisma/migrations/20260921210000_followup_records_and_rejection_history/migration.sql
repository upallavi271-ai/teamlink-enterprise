-- followup_: application follow-ups + the full Rejected / Hold record.
--
-- HAND-WRITTEN, AND ADDITIVE ONLY.
--
-- SQLite has no ALTER COLUMN, so Prisma implements any column *change* as a
-- table rebuild: create a shadow table from the current schema, copy, drop,
-- rename. That silently drops every column an earlier migration added but the
-- shadow definition does not carry, and it has already cost this database once.
-- Nothing below rebuilds a table. Exactly two shapes are used:
--   CREATE TABLE  for the one new table
--   ALTER TABLE … ADD COLUMN  for the six new columns
-- Every added column is nullable with no default, which is the only form
-- SQLite accepts on an ADD COLUMN against a populated table without a rewrite.

-- ---------------------------------------------------------------------------
-- 1. ApplicationStageEvent — the rest of the Rejected / Hold record.
--    candidate, previous stage, who, their role, comment and timestamp were
--    already stored. These six add: the requirement and client as they stood
--    at the time, which SIDE the decision came from, the reason category and
--    the detailed reason.
-- ---------------------------------------------------------------------------
ALTER TABLE "ApplicationStageEvent" ADD COLUMN "requirementId" TEXT;
ALTER TABLE "ApplicationStageEvent" ADD COLUMN "requirementTitle" TEXT;
ALTER TABLE "ApplicationStageEvent" ADD COLUMN "clientId" TEXT;
ALTER TABLE "ApplicationStageEvent" ADD COLUMN "clientName" TEXT;
ALTER TABLE "ApplicationStageEvent" ADD COLUMN "actorSide" TEXT;
ALTER TABLE "ApplicationStageEvent" ADD COLUMN "reasonCategory" TEXT;
ALTER TABLE "ApplicationStageEvent" ADD COLUMN "reasonDetail" TEXT;

-- ---------------------------------------------------------------------------
-- 2. ApplicationFollowUp — one row per follow-up commitment on one
--    APPLICATION. No column is added to Application or to Candidate: the
--    relation is carried entirely by applicationId on this side, so the
--    candidate master stays free of application-level data.
--
--    There is no `status` column on purpose. Upcoming / Due Today / Overdue
--    is derived from dueDate at read time; only completion, which is an event
--    somebody caused, is stored.
-- ---------------------------------------------------------------------------
CREATE TABLE "ApplicationFollowUp" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "applicationId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "requirementId" TEXT,
    "ownerUserId" TEXT,
    "ownerName" TEXT,
    "ownerRole" TEXT,
    "tlUserId" TEXT,
    "tlName" TEXT,
    "bdeUserId" TEXT,
    "bdeName" TEXT,
    "lastContactedAt" DATETIME,
    "contactMode" TEXT,
    "nextAction" TEXT,
    "dueDate" TEXT,
    "nextFollowUpAt" TEXT,
    "notes" TEXT,
    "completedAt" DATETIME,
    "completedById" TEXT,
    "completedNote" TEXT,
    "escalatedTlAt" DATETIME,
    "escalatedAdminAt" DATETIME,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ApplicationFollowUp_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ApplicationFollowUp_applicationId_idx" ON "ApplicationFollowUp"("applicationId");
CREATE INDEX "ApplicationFollowUp_candidateId_idx" ON "ApplicationFollowUp"("candidateId");
CREATE INDEX "ApplicationFollowUp_ownerUserId_idx" ON "ApplicationFollowUp"("ownerUserId");
CREATE INDEX "ApplicationFollowUp_dueDate_idx" ON "ApplicationFollowUp"("dueDate");
