-- Save & Post (2026-10-05): one row per job per posting source — the result of
-- the last publish / update / remove on that source (status, the board's own
-- job id + URL, when it went up, the error, attempts). The master job is
-- Requirement.id; a source never gets a second requirement.
-- ONE NEW TABLE only. No existing table is rebuilt or changed.
CREATE TABLE "RequirementPosting" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requirementId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "externalJobId" TEXT,
    "externalUrl" TEXT,
    "postedAt" DATETIME,
    "removedAt" DATETIME,
    "errorMessage" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastTriedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RequirementPosting_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "Requirement" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "RequirementPosting_requirementId_source_key" ON "RequirementPosting"("requirementId", "source");
CREATE INDEX "RequirementPosting_source_status_idx" ON "RequirementPosting"("source", "status");
