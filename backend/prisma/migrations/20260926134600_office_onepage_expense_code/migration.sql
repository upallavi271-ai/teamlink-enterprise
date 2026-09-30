-- Office & Accounts one-page (2026-09-26). Hand-written and ADDITIVE: four new
-- nullable columns on OfficeExpense, one unique index, a one-off backfill of
-- the new Expense ID, and the spec's category list added where missing.
-- Nothing is renamed or removed. `prisma migrate diff` is not used because of
-- older, unrelated drift.

ALTER TABLE "OfficeExpense" ADD COLUMN "expenseCode" TEXT;
ALTER TABLE "OfficeExpense" ADD COLUMN "updatedById" TEXT;
ALTER TABLE "OfficeExpense" ADD COLUMN "reimbursedById" TEXT;
ALTER TABLE "OfficeExpense" ADD COLUMN "reimbursedAt" DATETIME;

-- Every existing expense gets its Expense ID, EXP-0001 upwards, in date order
-- (then the order it was entered).
UPDATE "OfficeExpense" SET "expenseCode" = (
  SELECT 'EXP-' || printf('%04d', t.rn)
  FROM (
    SELECT "id", ROW_NUMBER() OVER (ORDER BY COALESCE("expenseDate", ''), "createdAt", "id") AS rn
    FROM "OfficeExpense"
  ) AS t
  WHERE t."id" = "OfficeExpense"."id"
);

CREATE UNIQUE INDEX "OfficeExpense_expenseCode_key" ON "OfficeExpense"("expenseCode");

-- The spec's 13 categories. Each is added only when no category of that name
-- (in any letter case) is on the list already; the existing ones are kept
-- exactly as they are.
INSERT INTO "ExpenseCategory" ("id", "name", "isActive", "createdAt", "updatedAt")
SELECT 'ec' || lower(hex(randomblob(11))), s.n, 1,
       CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
       CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
FROM (
  SELECT 'Office Rent' AS n UNION ALL SELECT 'Electricity' UNION ALL SELECT 'Internet & Telephone'
  UNION ALL SELECT 'Travel' UNION ALL SELECT 'Food & Refreshments' UNION ALL SELECT 'Stationery'
  UNION ALL SELECT 'Software / Subscription' UNION ALL SELECT 'Marketing' UNION ALL SELECT 'Maintenance'
  UNION ALL SELECT 'Salaries / Payroll' UNION ALL SELECT 'Professional Fees' UNION ALL SELECT 'Bank Charges'
  UNION ALL SELECT 'Miscellaneous'
) AS s
WHERE NOT EXISTS (SELECT 1 FROM "ExpenseCategory" c WHERE lower(c."name") = lower(s.n));
