-- resume_ / fit_: hide a wrong resume file, per-job minimum Fit, Admin Fit settings.
-- ADD COLUMN only + ONE NEW TABLE. No existing table is rebuilt.

-- 1. "This is the wrong file — hide it": the file and row are KEPT (audit),
--    only marked not current.
ALTER TABLE "CandidateResume" ADD COLUMN "hiddenAt" DATETIME;
ALTER TABLE "CandidateResume" ADD COLUMN "hiddenById" TEXT;
ALTER TABLE "CandidateResume" ADD COLUMN "hiddenByName" TEXT;
ALTER TABLE "CandidateResume" ADD COLUMN "hiddenReason" TEXT;

-- 2. Per-job minimum Fit % for "Eligible" (NULL = the Admin default, 50).
ALTER TABLE "Requirement" ADD COLUMN "minFit" INTEGER;

-- 3. Small key/value settings table (first key: "fit" = weights + default minimum).
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedById" TEXT,
    "updatedByName" TEXT,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
