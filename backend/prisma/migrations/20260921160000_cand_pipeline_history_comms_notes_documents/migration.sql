-- cand_: Candidate pipeline history, communications, notes and documents.
--
-- HAND-WRITTEN ON PURPOSE. This migration only CREATEs new tables and indexes.
-- There is no ALTER TABLE and no table rebuild: SQLite has no ALTER COLUMN, so
-- Prisma implements any column change as a CREATE/COPY/DROP/RENAME rebuild,
-- which silently drops columns other migrations added. That has already caused
-- a real data-loss bug in this repo, so nothing here touches an existing table.

-- Pipeline History: one row per stage transition (Who / When / Action / Comment).
CREATE TABLE "ApplicationStageEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "applicationId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "fromStage" TEXT,
    "toStage" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "comment" TEXT,
    "actorUserId" TEXT,
    "actorName" TEXT,
    "actorRole" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApplicationStageEvent_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ApplicationStageEvent_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ApplicationStageEvent_candidateId_idx" ON "ApplicationStageEvent"("candidateId");
CREATE INDEX "ApplicationStageEvent_applicationId_idx" ON "ApplicationStageEvent"("applicationId");

-- Candidate communications. A record and a trigger, NOT a delivery receipt:
-- no provider is wired in, so `status` stays NOT_SENT_NO_PROVIDER and
-- `sentAt` / `providerRef` stay null until a real integration fills them.
CREATE TABLE "CandidateMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "candidateId" TEXT NOT NULL,
    "applicationId" TEXT,
    "channel" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "templateLabel" TEXT,
    "trigger" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NOT_SENT_NO_PROVIDER',
    "statusDetail" TEXT,
    "senderUserId" TEXT,
    "senderEmployeeId" TEXT,
    "senderName" TEXT,
    "senderEmail" TEXT,
    "senderSourceNote" TEXT,
    "stageFrom" TEXT,
    "stageTo" TEXT,
    "providerRef" TEXT,
    "sentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CandidateMessage_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "CandidateMessage_candidateId_idx" ON "CandidateMessage"("candidateId");

-- Internal recruiter / TL notes. Never served to a CLIENT or CANDIDATE login.
CREATE TABLE "CandidateNote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "candidateId" TEXT NOT NULL,
    "applicationId" TEXT,
    "body" TEXT NOT NULL,
    "authorUserId" TEXT,
    "authorName" TEXT,
    "authorRole" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CandidateNote_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "CandidateNote_candidateId_idx" ON "CandidateNote"("candidateId");

-- Resume / ID / Certificates / Offer / Joining documents.
CREATE TABLE "CandidateDocument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "candidateId" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "note" TEXT,
    "internalOnly" BOOLEAN NOT NULL DEFAULT false,
    "uploadedByUserId" TEXT,
    "uploadedByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CandidateDocument_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "CandidateDocument_candidateId_idx" ON "CandidateDocument"("candidateId");
