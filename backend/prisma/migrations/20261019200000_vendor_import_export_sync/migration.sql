-- 20261019200000_vendor_import_export_sync - (1) AssetComplaint: an asset complaint raised in HRMS (the ticket itself is the existing EmployeeRecord,
-- type ASSET); when HR / the manager approves a REPAIR complaint, ONE AssetRepair is made for it (repairId is UNIQUE, so never twice) and the
-- Assets Vendor Portal shows it as "Awaiting repair" (utils/assetComplaints.js). (2) VendorImportRun: one row per confirmed vendor Import
-- (vendorUserId + idemKey UNIQUE = the same Idempotency-Key never does the work twice). ADDITIVE ONLY (nothing existing is altered).
-- The server also creates both tables by itself the first time they are needed (utils/assetVendorSchema.js), with the same statements.
-- Admin's "hide this from the vendor" choices reuse the existing VendorAssetGrant table (kind exclude_asset / exclude_category); the
-- vendor-category -> asset-category map is the existing AppSetting row "vendor.assetCategoryMap" (no new table).
CREATE TABLE IF NOT EXISTS "AssetComplaint" (
  "ticketId" TEXT NOT NULL PRIMARY KEY,
  "ticketRef" TEXT NOT NULL,
  "assetId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "issue" TEXT,
  "employeeId" TEXT NOT NULL,
  "raisedAt" TEXT NOT NULL,
  "decision" TEXT,
  "decidedById" TEXT,
  "decidedByName" TEXT,
  "decidedRole" TEXT,
  "decidedAt" TEXT,
  "decisionNote" TEXT,
  "repairId" TEXT,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "AssetComplaint_ref" ON "AssetComplaint"("ticketRef");
CREATE UNIQUE INDEX IF NOT EXISTS "AssetComplaint_repair" ON "AssetComplaint"("repairId") WHERE "repairId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "AssetComplaint_asset" ON "AssetComplaint"("assetId");

CREATE TABLE IF NOT EXISTS "VendorImportRun" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "vendorId" TEXT NOT NULL,
  "vendorUserId" TEXT NOT NULL,
  "idemKey" TEXT NOT NULL,
  "importKey" TEXT NOT NULL,
  "fileName" TEXT,
  "fileHash" TEXT,
  "state" TEXT NOT NULL,
  "status" INTEGER,
  "resultJson" TEXT,
  "createdAt" TEXT NOT NULL,
  "finishedAt" TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS "VendorImportRun_idem" ON "VendorImportRun"("vendorUserId", "idemKey");
CREATE INDEX IF NOT EXISTS "VendorImportRun_vendor" ON "VendorImportRun"("vendorId", "createdAt");
