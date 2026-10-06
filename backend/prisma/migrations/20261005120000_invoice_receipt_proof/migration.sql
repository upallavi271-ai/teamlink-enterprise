-- S8 Accounts Dashboard: an invoice receipt can keep its own proof document
-- (receipt / bank proof file, or a typed bank reference / UTR). ADD COLUMN
-- only, all nullable; no data change. Files are stored by utils/attachments.js
-- exactly like OfficeExpense.proof*.
ALTER TABLE "Invoice" ADD COLUMN "proofFile" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "proofName" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "proofMime" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "proofRef" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "proofAt" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "proofBy" TEXT;
