-- portal_: Job Portal workspace inside Jobs / Requirements.
--
-- HAND-WRITTEN, and ADD COLUMN only. SQLite has no ALTER COLUMN, so Prisma
-- implements any column CHANGE as a table rebuild (create _new, copy, drop,
-- rename) — and that rebuild is generated from the CURRENT schema.prisma, so
-- it silently drops columns other migrations added afterwards. That has
-- already cost this codebase a real bug. Every statement below is a plain
-- ADD COLUMN with a constant default; nothing is rebuilt, renamed or dropped.

-- Requirement: whether this requirement is PUBLISHED to the job portal, and
-- who published it when. Distinct from `status` (is it live?) and from
-- `portalSyncStatus` (has the posting been pushed out since it changed?).
ALTER TABLE "Requirement" ADD COLUMN "portalPublished" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Requirement" ADD COLUMN "portalPublishedAt" DATETIME;
ALTER TABLE "Requirement" ADD COLUMN "portalPublishedBy" TEXT;
ALTER TABLE "Requirement" ADD COLUMN "portalUnpublishedAt" DATETIME;

-- Application: the record of a portal application being admitted into the ATS
-- pipeline by a named person at a named time.
ALTER TABLE "Application" ADD COLUMN "portalImportedAt" DATETIME;
ALTER TABLE "Application" ADD COLUMN "portalImportedBy" TEXT;

-- Backfill. Every requirement that is LIVE today is already being offered on
-- this app's public job feed (GET /api/public/jobs lists exactly these), so
-- recording it as published states what is already true rather than quietly
-- taking it off the careers list. Requirements that are Draft, On Hold or
-- Closed stay unpublished, which is also already true of them.
UPDATE "Requirement"
   SET "portalPublished" = true,
       "portalPublishedAt" = CURRENT_TIMESTAMP
 WHERE "status" IN ('OPEN', 'RECRUITER_ASSIGNED', 'SOURCING', 'CANDIDATES_AVAILABLE');
