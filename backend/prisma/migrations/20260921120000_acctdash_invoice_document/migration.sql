-- Accounts: the printable tax invoice's letterhead, place-of-supply and bank
-- notes. Plain ADD COLUMNs only — SQLite has no ALTER COLUMN, and a table
-- rebuild here would silently drop columns added by migrations Prisma does not
-- know about (this already happened once on Invoice).
ALTER TABLE "Company" ADD COLUMN "legalName" TEXT;
ALTER TABLE "Company" ADD COLUMN "tagline" TEXT;
ALTER TABLE "Company" ADD COLUMN "gstin" TEXT;
ALTER TABLE "Company" ADD COLUMN "sac" TEXT;
ALTER TABLE "Company" ADD COLUMN "city" TEXT;
ALTER TABLE "Company" ADD COLUMN "state" TEXT;
ALTER TABLE "Company" ADD COLUMN "pin" TEXT;
ALTER TABLE "Company" ADD COLUMN "logoUrl" TEXT;
ALTER TABLE "Company" ADD COLUMN "bankName" TEXT;
ALTER TABLE "Company" ADD COLUMN "accountName" TEXT;
ALTER TABLE "Company" ADD COLUMN "accountNumber" TEXT;
ALTER TABLE "Company" ADD COLUMN "ifsc" TEXT;
ALTER TABLE "Company" ADD COLUMN "branch" TEXT;
ALTER TABLE "Company" ADD COLUMN "accountType" TEXT;
ALTER TABLE "Company" ADD COLUMN "upi" TEXT;
ALTER TABLE "Company" ADD COLUMN "invoiceTerms" TEXT;
