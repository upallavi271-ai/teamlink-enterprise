-- Interviews & Joining: Offers, Joining, Internal Hiring and the Hiring Type fork.
--
-- HAND-WRITTEN ON PURPOSE. SQLite has no ALTER COLUMN, so Prisma implements any
-- column *change* as a table rebuild (create new, copy, drop, rename) — and a
-- rebuild generated against one branch's schema silently drops the columns
-- another migration added. That has already bitten the Invoice table in this
-- repo once. Everything below is therefore plain ADD COLUMN / CREATE TABLE:
-- nothing is rebuilt, nothing is dropped, no existing column is touched.

-- Hiring Type, stored rather than guessed. Backfilled from Requirement.internal.
ALTER TABLE "Requirement" ADD COLUMN "hiringType" TEXT;
UPDATE "Requirement" SET "hiringType" = CASE WHEN "internal" = 1 THEN 'TeamLink Internal Hire' ELSE 'Client Placement' END;

-- Offers / Joining / Internal Hiring state on the application.
ALTER TABLE "Application" ADD COLUMN "hiringType" TEXT;
ALTER TABLE "Application" ADD COLUMN "offerStatus" TEXT;
ALTER TABLE "Application" ADD COLUMN "offerDate" TEXT;
ALTER TABLE "Application" ADD COLUMN "offerNotes" TEXT;
ALTER TABLE "Application" ADD COLUMN "offerAcceptedAt" DATETIME;
ALTER TABLE "Application" ADD COLUMN "documentsStatus" TEXT;
ALTER TABLE "Application" ADD COLUMN "joiningStatus" TEXT;
ALTER TABLE "Application" ADD COLUMN "joinedAt" DATETIME;
ALTER TABLE "Application" ADD COLUMN "billingStatus" TEXT;
ALTER TABLE "Application" ADD COLUMN "hrmsEmployeeId" TEXT;

UPDATE "Application"
   SET "hiringType" = (
     SELECT CASE WHEN r."internal" = 1 THEN 'TeamLink Internal Hire' ELSE 'Client Placement' END
       FROM "Requirement" r WHERE r."id" = "Application"."requirementId"
   );

-- Internal feedback and client feedback are two separate records on one
-- interview; the unique key is what keeps them from collapsing into each other.
CREATE TABLE "InterviewFeedback" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "applicationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "technical" INTEGER,
    "communication" INTEGER,
    "experience" INTEGER,
    "roleFit" INTEGER,
    "overall" TEXT NOT NULL,
    "recommendation" TEXT NOT NULL,
    "submittedById" TEXT,
    "submittedBy" TEXT,
    "clientId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "InterviewFeedback_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "InterviewFeedback_applicationId_kind_key" ON "InterviewFeedback"("applicationId", "kind");
