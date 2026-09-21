-- Office & Accounts depth on OfficeExpense.
--
-- Hand-written as plain ADD COLUMNs on purpose. SQLite has no ALTER COLUMN, so
-- Prisma implements any column *change* as a table rebuild (create new_X, copy
-- a fixed column list, drop, rename) which silently drops columns added by
-- migrations it did not know about. That has already cost this codebase real
-- data once, so nothing here rebuilds a table.

ALTER TABLE "OfficeExpense" ADD COLUMN "entryKind" TEXT DEFAULT 'expense';
ALTER TABLE "OfficeExpense" ADD COLUMN "dueDate" TEXT;
ALTER TABLE "OfficeExpense" ADD COLUMN "remarks" TEXT;
ALTER TABLE "OfficeExpense" ADD COLUMN "approvedBy" TEXT;
ALTER TABLE "OfficeExpense" ADD COLUMN "gstRatePct" REAL;
ALTER TABLE "OfficeExpense" ADD COLUMN "tdsRatePct" REAL;
ALTER TABLE "OfficeExpense" ADD COLUMN "supplyType" TEXT;
ALTER TABLE "OfficeExpense" ADD COLUMN "gstTreatment" TEXT;
ALTER TABLE "OfficeExpense" ADD COLUMN "sourceState" TEXT;
ALTER TABLE "OfficeExpense" ADD COLUMN "proofName" TEXT;
ALTER TABLE "OfficeExpense" ADD COLUMN "proofMime" TEXT;
ALTER TABLE "OfficeExpense" ADD COLUMN "proofSize" INTEGER;
ALTER TABLE "OfficeExpense" ADD COLUMN "proofAt" TEXT;
ALTER TABLE "OfficeExpense" ADD COLUMN "proofBy" TEXT;
ALTER TABLE "OfficeExpense" ADD COLUMN "bankTxnId" TEXT;
