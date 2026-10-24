-- NAUKRI -> SHINE BY-HAND WORKFLOW (2026-10-15): one row per (job, platform) holding where the recruiter is in the workflow.
-- ADDITIVE ONLY: one new table. The application also creates it itself (CREATE TABLE IF NOT EXISTS, jobFlow/service.js) because the running
-- backend holds the SQLite lock. Times are DATETIME columns holding epoch milliseconds. Undo: rollback.sql.
CREATE TABLE IF NOT EXISTS "JobPostFlow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requirementId" TEXT NOT NULL,
    "clientId" TEXT,
    "recruiterId" TEXT,
    "userId" TEXT,
    "userName" TEXT,
    "platform" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "externalJobId" TEXT,
    "portalUrl" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "lastError" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "meta" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS "JobPostFlow_req_platform_key" ON "JobPostFlow"("requirementId", "platform");
CREATE INDEX IF NOT EXISTS "JobPostFlow_status_idx" ON "JobPostFlow"("status");
