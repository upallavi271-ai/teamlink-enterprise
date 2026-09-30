-- Office & Accounts: the edit-expense form's remaining fields.
-- Hand-written and additive only (six new nullable columns). No existing row
-- is touched. `prisma migrate diff` is not used because of older, unrelated
-- drift.
ALTER TABLE "OfficeExpense" ADD COLUMN "expenseAccount" TEXT;
ALTER TABLE "OfficeExpense" ADD COLUMN "hsnSac" TEXT;
ALTER TABLE "OfficeExpense" ADD COLUMN "destState" TEXT;
ALTER TABLE "OfficeExpense" ADD COLUMN "reverseCharge" BOOLEAN;
ALTER TABLE "OfficeExpense" ADD COLUMN "billableClient" TEXT;
ALTER TABLE "OfficeExpense" ADD COLUMN "reportingTags" TEXT;
