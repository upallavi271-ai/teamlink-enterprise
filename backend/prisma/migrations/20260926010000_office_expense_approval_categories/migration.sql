-- Office & Expenses spec A: the approval lifecycle and the category table.
-- Hand-written and ADDITIVE (new columns, a new table, two indexes). The only
-- data written is the one-off mapping of existing rows onto the new status
-- and the category preload below. `prisma migrate diff` is not used because
-- of older, unrelated drift.

ALTER TABLE "OfficeExpense" ADD COLUMN "approvalStatus" TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE "OfficeExpense" ADD COLUMN "rejectionReason" TEXT;
ALTER TABLE "OfficeExpense" ADD COLUMN "createdById" TEXT;
ALTER TABLE "OfficeExpense" ADD COLUMN "approvedById" TEXT;
ALTER TABLE "OfficeExpense" ADD COLUMN "approvedAt" DATETIME;
ALTER TABLE "OfficeExpense" ADD COLUMN "rejectedById" TEXT;
ALTER TABLE "OfficeExpense" ADD COLUMN "rejectedAt" DATETIME;
ALTER TABLE "OfficeExpense" ADD COLUMN "paidById" TEXT;
ALTER TABLE "OfficeExpense" ADD COLUMN "paidAt" DATETIME;
ALTER TABLE "OfficeExpense" ADD COLUMN "updatedAt" DATETIME;

-- Existing rows. The payment status stays what it was; the approval status
-- follows from it:
--   paidStatus Paid                         -> PAID
--   paidStatus Unpaid + an approver named   -> APPROVED
--   paidStatus Unpaid, nobody named         -> PENDING
UPDATE "OfficeExpense" SET "approvalStatus" = CASE
  WHEN "paidStatus" = 'Paid' THEN 'PAID'
  WHEN "approvedBy" IS NOT NULL AND trim("approvedBy") <> '' THEN 'APPROVED'
  ELSE 'PENDING'
END;
UPDATE "OfficeExpense" SET "updatedAt" = "createdAt" WHERE "updatedAt" IS NULL;

CREATE INDEX "OfficeExpense_approvalStatus_idx" ON "OfficeExpense"("approvalStatus");
CREATE INDEX "OfficeExpense_expenseDate_idx" ON "OfficeExpense"("expenseDate");

CREATE TABLE "ExpenseCategory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "ExpenseCategory_name_key" ON "ExpenseCategory"("name");

-- The eight defaults, then every category already on an expense.
INSERT OR IGNORE INTO "ExpenseCategory" ("id", "name", "isActive", "createdAt", "updatedAt")
SELECT 'ec' || lower(hex(randomblob(11))), n, 1,
       CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
       CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
FROM (
  SELECT 'Rent' AS n UNION ALL SELECT 'Electricity' UNION ALL SELECT 'Internet'
  UNION ALL SELECT 'Office Supplies' UNION ALL SELECT 'Travel' UNION ALL SELECT 'Maintenance'
  UNION ALL SELECT 'Software/Subscriptions' UNION ALL SELECT 'Miscellaneous'
);
INSERT OR IGNORE INTO "ExpenseCategory" ("id", "name", "isActive", "createdAt", "updatedAt")
SELECT 'ec' || lower(hex(randomblob(11))), c, 1,
       CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
       CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
FROM (SELECT DISTINCT trim("category") AS c FROM "OfficeExpense" WHERE "category" IS NOT NULL AND trim("category") <> '');
