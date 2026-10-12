-- ROLLBACK for 20261009120000_bank_recon_sync (run only after a backup; SQLite >= 3.35).
-- Prisma does not run this file. Apply with the sqlite3 shell or node, then
-- delete the migration folder's row from _prisma_migrations.
DROP TABLE IF EXISTS "InvoiceAdjustment";
DROP INDEX IF EXISTS "BankTransaction_bankAccountId_externalId_key";
DROP INDEX IF EXISTS "BankTransaction_importBatch_idx";
DROP INDEX IF EXISTS "BankTransaction_reference_idx";
DROP INDEX IF EXISTS "BankImport_sourceHash_idx";
ALTER TABLE "BankTransaction" DROP COLUMN "valueDate";
ALTER TABLE "BankTransaction" DROP COLUMN "externalId";
ALTER TABLE "BankTransaction" DROP COLUMN "sourceLine";
ALTER TABLE "BankTransaction" DROP COLUMN "sourceRow";
ALTER TABLE "BankTransaction" DROP COLUMN "reviewReason";
ALTER TABLE "BankTransaction" DROP COLUMN "reversalOfId";
ALTER TABLE "BankImport" DROP COLUMN "sourceHash";
ALTER TABLE "BankImport" DROP COLUMN "openingBalance";
ALTER TABLE "BankImport" DROP COLUMN "closingBalance";
ALTER TABLE "BankImport" DROP COLUMN "balanceCheck";
ALTER TABLE "BankImport" DROP COLUMN "failedRows";
ALTER TABLE "BankImport" DROP COLUMN "summary";
ALTER TABLE "BankImport" DROP COLUMN "status";
ALTER TABLE "BankRule" DROP COLUMN "createdById";
ALTER TABLE "BankRule" DROP COLUMN "createdByName";
ALTER TABLE "BankRule" DROP COLUMN "source";
ALTER TABLE "InvoicePayment" DROP COLUMN "dateSource";
ALTER TABLE "Invoice" DROP COLUMN "adjustedAmount";
ALTER TABLE "OfficeExpense" DROP COLUMN "paymentDate";
