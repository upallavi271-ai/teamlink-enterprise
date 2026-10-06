-- 20261006120000_vendor_portal_v2  (Vendor Portal spec v2, 2026-10-06)
-- ADDITIVE ONLY: new nullable / defaulted columns, new indexes, two CHECK
-- triggers. No existing column changes, no rows rewritten. Rollback:
-- rollback.js (scratchpad vendorportal/migration-v2).

-- Vendor master: switched-off vendors block all their vendor logins.
ALTER TABLE "OfficeVendor" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;

-- Vendor logins.
ALTER TABLE "VendorUser" ADD COLUMN "tempPasswordExpiresAt" DATETIME;
ALTER TABLE "VendorUser" ADD COLUMN "lastLoginIp" TEXT;
ALTER TABLE "VendorUser" ADD COLUMN "deletedAt" DATETIME;
ALTER TABLE "VendorUser" ADD COLUMN "passwordHistory" TEXT NOT NULL DEFAULT '[]';

-- Audit: IP + user agent.
ALTER TABLE "AssetAuditLog" ADD COLUMN "ip" TEXT;
ALTER TABLE "AssetAuditLog" ADD COLUMN "userAgent" TEXT;
CREATE INDEX "AssetAuditLog_action_idx" ON "AssetAuditLog"("action");

-- Documents: visible_to_vendor (default false; vendor uploads set true).
ALTER TABLE "AssetDocument" ADD COLUMN "visibleToVendor" BOOLEAN NOT NULL DEFAULT false;

-- Bill submissions.
ALTER TABLE "VendorBillSubmission" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'Vendor Portal';
ALTER TABLE "VendorBillSubmission" ADD COLUMN "parentSubmissionId" TEXT;
ALTER TABLE "VendorBillSubmission" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "VendorBillSubmission" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "VendorBillSubmission" ADD COLUMN "withdrawnAt" DATETIME;
ALTER TABLE "VendorBillSubmission" ADD COLUMN "billNumberKey" TEXT;
ALTER TABLE "VendorBillSubmission" ADD COLUMN "originalValues" TEXT;
CREATE UNIQUE INDEX "VendorBillSubmission_vendorUserId_idempotencyKey_key" ON "VendorBillSubmission"("vendorUserId", "idempotencyKey");
CREATE INDEX "VendorBillSubmission_vendorId_billNumberKey_idx" ON "VendorBillSubmission"("vendorId", "billNumberKey");
CREATE INDEX "VendorBillSubmission_parentSubmissionId_idx" ON "VendorBillSubmission"("parentSubmissionId");

-- Asset access: exactly one of assetId / category per row (SQLite cannot add
-- a CHECK to an existing table, so two triggers enforce it; the app checks too).
CREATE TRIGGER "VendorAssetAccess_one_target_ins" BEFORE INSERT ON "VendorAssetAccess"
WHEN (NEW."assetId" IS NULL) = (NEW."category" IS NULL)
BEGIN SELECT RAISE(ABORT, 'VendorAssetAccess: set exactly one of assetId or category'); END;
CREATE TRIGGER "VendorAssetAccess_one_target_upd" BEFORE UPDATE ON "VendorAssetAccess"
WHEN (NEW."assetId" IS NULL) = (NEW."category" IS NULL)
BEGIN SELECT RAISE(ABORT, 'VendorAssetAccess: set exactly one of assetId or category'); END;
