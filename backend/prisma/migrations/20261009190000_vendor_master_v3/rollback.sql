-- Rollback of 20261009190000_vendor_master_v3. Run only if no app code from this
-- change is running. Needs SQLite 3.35+ (DROP COLUMN) - Prisma 5.22's engine has it.
-- NOTE: this DROPS the new tables (invite tokens, shared-document rows) and the
-- new columns (vendor codes, PAN, keys, snapshots). Take a backup first.
DROP TRIGGER IF EXISTS "AssetAuditLog_append_only_upd";
DROP TRIGGER IF EXISTS "AssetAuditLog_append_only_del";
DROP TABLE IF EXISTS "VendorSharedDocument";
DROP TABLE IF EXISTS "VendorLoginToken";
ALTER TABLE "VendorBillSubmission" DROP COLUMN "vendorNameSnap";
ALTER TABLE "VendorBillSubmission" DROP COLUMN "vendorGstinSnap";
ALTER TABLE "VendorBillSubmission" DROP COLUMN "vendorAddressSnap";
DROP INDEX IF EXISTS "OfficeExpense_vendorId_idx";
ALTER TABLE "OfficeExpense" DROP COLUMN "vendorId";
ALTER TABLE "OfficeExpense" DROP COLUMN "vendorAddress";
ALTER TABLE "OfficeExpense" DROP COLUMN "vendorPan";
DROP INDEX IF EXISTS "OfficeVendor_vendorCode_key";
DROP INDEX IF EXISTS "OfficeVendor_gstinKey_key";
DROP INDEX IF EXISTS "OfficeVendor_panKey_key";
DROP INDEX IF EXISTS "OfficeVendor_emailKey_key";
DROP INDEX IF EXISTS "OfficeVendor_phoneKey_idx";
ALTER TABLE "OfficeVendor" DROP COLUMN "vendorCode";
ALTER TABLE "OfficeVendor" DROP COLUMN "companyName";
ALTER TABLE "OfficeVendor" DROP COLUMN "pan";
ALTER TABLE "OfficeVendor" DROP COLUMN "category";
ALTER TABLE "OfficeVendor" DROP COLUMN "gstinKey";
ALTER TABLE "OfficeVendor" DROP COLUMN "panKey";
ALTER TABLE "OfficeVendor" DROP COLUMN "emailKey";
ALTER TABLE "OfficeVendor" DROP COLUMN "phoneKey";
ALTER TABLE "OfficeVendor" DROP COLUMN "source";
ALTER TABLE "OfficeVendor" DROP COLUMN "createdById";
ALTER TABLE "OfficeVendor" DROP COLUMN "updatedById";
ALTER TABLE "OfficeVendor" DROP COLUMN "deactivatedAt";
ALTER TABLE "OfficeVendor" DROP COLUMN "deactivatedById";
ALTER TABLE "OfficeVendor" DROP COLUMN "deactivationReason";
-- (Prisma _prisma_migrations row: delete it by hand if the migration was recorded.)
