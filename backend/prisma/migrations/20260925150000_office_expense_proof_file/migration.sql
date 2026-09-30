-- Office & Expenses: the stored proof file behind an expense's proofName.
-- Hand-written and additive only (one new nullable column). No existing row
-- is touched. `prisma migrate diff` is not used because of older, unrelated
-- drift.
ALTER TABLE "OfficeExpense" ADD COLUMN "proofFile" TEXT;
