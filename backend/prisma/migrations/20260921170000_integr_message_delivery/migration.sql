-- integr_message_delivery
--
-- Delivery bookkeeping for the real email sending worker (utils/mailWorker.js).
--
-- HAND-WRITTEN, and it must stay that way. SQLite has no ALTER COLUMN, so
-- Prisma expresses any column CHANGE as a table rebuild (create _new, copy,
-- drop, rename) — which silently drops columns other migrations added. Plain
-- ADD COLUMN only, one statement per column.
ALTER TABLE "CandidateMessage" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CandidateMessage" ADD COLUMN "lastAttemptAt" DATETIME;
ALTER TABLE "CandidateMessage" ADD COLUMN "nextAttemptAt" DATETIME;
ALTER TABLE "CandidateMessage" ADD COLUMN "lastError" TEXT;
