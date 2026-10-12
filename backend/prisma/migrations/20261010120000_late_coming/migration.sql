-- Late coming (user, 2026-10-10): the existing LatePermission table also carries the "Tell why I was late" request
-- (after the day) - one table, one approval chain. ADDITIVE ONLY: five nullable / defaulted columns.
-- Undo: rollback.sql (SQLite 3.35+ DROP COLUMN).
ALTER TABLE "LatePermission" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'Advance';
ALTER TABLE "LatePermission" ADD COLUMN "reasonCode" TEXT;
ALTER TABLE "LatePermission" ADD COLUMN "arrivedAt" TEXT;
ALTER TABLE "LatePermission" ADD COLUMN "attachmentFile" TEXT;
ALTER TABLE "LatePermission" ADD COLUMN "attachmentName" TEXT;
