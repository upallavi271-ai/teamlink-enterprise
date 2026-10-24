-- JOB DISTRIBUTION (2026-10-14): the "Distribute" tab on a job: Posting Kit (ready text + tracked link per platform),
-- "Mark as posted" tracker, expiry reminders and the take-down checklist. See docs/job-publishing/DISTRIBUTE.md.
-- ADDITIVE ONLY: two new tables, nothing existing is touched. Telegram and Facebook reuse the job-publish engine tables.
--   DistPlatform  the admin-editable list of places a job can be posted (name, kind auto/semi/manual, post URL, text limits).
--                 Seeded with the defaults by the application on first use (no rows are required here).
--   DistPosting   one row per (job, platform) a PERSON marked as posted by hand: link, date, who, expiry, notes, the
--                 edited text, and the take-down checklist state. "Not posted" has no row.
-- DateTime columns hold epoch milliseconds (the same as every Prisma SQLite DateTime). The application reads and writes
-- these tables with plain SQL, so it works before or after prisma generate.
-- Undo: rollback.sql.
CREATE TABLE "DistPlatform" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'semi',
    "medium" TEXT NOT NULL DEFAULT 'job_board',
    "format" TEXT NOT NULL DEFAULT 'jd',
    "postUrl" TEXT,
    "maxChars" INTEGER,
    "maxTitle" INTEGER,
    "formatHint" TEXT,
    "includeSalary" INTEGER NOT NULL DEFAULT 1,
    "expiryDays" INTEGER,
    "active" INTEGER NOT NULL DEFAULT 1,
    "builtin" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 100,
    "updatedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL DEFAULT 0
);

CREATE TABLE "DistPosting" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requirementId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'POSTED',
    "postUrl" TEXT,
    "postedAt" DATETIME,
    "postedById" TEXT,
    "postedByName" TEXT,
    "expiresAt" DATETIME,
    "notes" TEXT,
    "textOverride" TEXT,
    "reminderSentAt" DATETIME,
    "expiryTaskId" TEXT,
    "takedownState" TEXT NOT NULL DEFAULT 'NONE',
    "takedownTaskId" TEXT,
    "takedownAskedAt" DATETIME,
    "takedownDoneAt" DATETIME,
    "takedownDoneByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL DEFAULT 0,
    CONSTRAINT "DistPosting_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "Requirement" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "DistPosting_requirementId_platform_key" ON "DistPosting"("requirementId", "platform");
CREATE INDEX "DistPosting_platform_state_idx" ON "DistPosting"("platform", "state");
CREATE INDEX "DistPosting_expiresAt_idx" ON "DistPosting"("expiresAt");
