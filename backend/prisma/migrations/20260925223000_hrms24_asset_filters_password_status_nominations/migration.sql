-- hrms24: asset report filters, password status, recognition nominations.
-- Hand-written, ADDITIVE ONLY (ADD COLUMN / CREATE TABLE / CREATE INDEX).

-- §6 Asset report filters
ALTER TABLE "Asset" ADD COLUMN "assetType" TEXT;
ALTER TABLE "Asset" ADD COLUMN "location" TEXT;
ALTER TABLE "Asset" ADD COLUMN "assignedAt" DATETIME;
ALTER TABLE "Asset" ADD COLUMN "assignedById" TEXT;
ALTER TABLE "Asset" ADD COLUMN "assignedByName" TEXT;
ALTER TABLE "Asset" ADD COLUMN "returnedAt" DATETIME;

-- §12 Password status (never the password itself)
ALTER TABLE "User" ADD COLUMN "passwordChangedAt" DATETIME;
ALTER TABLE "User" ADD COLUMN "passwordResetRequired" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "failedLoginCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "lockedUntil" DATETIME;

-- §13 Rewards & Recognition nominations
CREATE TABLE "RecognitionNomination" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nomineeId" TEXT NOT NULL,
    "nomineeCode" TEXT,
    "nomineeName" TEXT NOT NULL,
    "nomineeDepartment" TEXT,
    "nomineeDesignation" TEXT,
    "recognitionType" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "achievements" TEXT,
    "nominationDate" TEXT NOT NULL,
    "comments" TEXT,
    "recommendedReward" TEXT,
    "docFile" TEXT,
    "docName" TEXT,
    "docMime" TEXT,
    "docSize" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'Pending Review',
    "nominatedById" TEXT NOT NULL,
    "nominatedByName" TEXT NOT NULL,
    "reviewerId" TEXT,
    "reviewerName" TEXT,
    "decision" TEXT,
    "remarks" TEXT,
    "reviewedAt" DATETIME,
    "awardedAt" DATETIME,
    "awardedById" TEXT,
    "awardedByName" TEXT,
    "awardRecordId" TEXT,
    "history" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "RecognitionNomination_nomineeId_idx" ON "RecognitionNomination"("nomineeId");
CREATE INDEX "RecognitionNomination_status_idx" ON "RecognitionNomination"("status");
