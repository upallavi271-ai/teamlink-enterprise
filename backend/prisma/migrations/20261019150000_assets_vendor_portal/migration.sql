-- Assets Vendor Portal (2026-10-19): ADDITIVE ONLY. The same statements utils/assetVendorSchema.js runs by itself the first time the portal needs them
-- (CREATE ... IF NOT EXISTS, so applying this by hand and the runtime provisioning never conflict). Nothing existing is altered.
-- The repair history is append-only at database level (same break-glass setting as the asset audit trail: AppSetting audit.allowPurge = 1).

CREATE TABLE IF NOT EXISTS "AssetVendorInfo" (
  "assetId" TEXT NOT NULL PRIMARY KEY,
  "brand" TEXT,
  "model" TEXT,
  "condition" TEXT,
  "updatedByName" TEXT,
  "updatedVendorId" TEXT,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "AssetRepairVendor" (
  "repairId" TEXT NOT NULL PRIMARY KEY,
  "assetId" TEXT NOT NULL,
  "vendorId" TEXT NOT NULL,
  "stage" TEXT,
  "estimateCost" REAL,
  "estimateGst" REAL,
  "estimateAt" TEXT,
  "expectedDate" TEXT,
  "returnedDate" TEXT,
  "vendorRemarks" TEXT,
  "invoiceFile" TEXT,
  "invoiceName" TEXT,
  "invoiceMime" TEXT,
  "invoiceSize" INTEGER,
  "invoiceAt" TEXT,
  "invoiceHash" TEXT,
  "lastByName" TEXT,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS "AssetRepairVendor_vendor" ON "AssetRepairVendor"("vendorId");

CREATE INDEX IF NOT EXISTS "AssetRepairVendor_asset" ON "AssetRepairVendor"("assetId");

CREATE TABLE IF NOT EXISTS "AssetRepairEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "repairId" TEXT NOT NULL,
  "assetId" TEXT NOT NULL,
  "vendorId" TEXT,
  "vendorUserId" TEXT,
  "kind" TEXT NOT NULL,
  "field" TEXT,
  "fromValue" TEXT,
  "toValue" TEXT,
  "note" TEXT,
  "actorKind" TEXT NOT NULL DEFAULT 'Vendor',
  "actorName" TEXT,
  "createdAt" TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS "AssetRepairEvent_repair" ON "AssetRepairEvent"("repairId", "createdAt");

CREATE INDEX IF NOT EXISTS "AssetRepairEvent_asset" ON "AssetRepairEvent"("assetId", "createdAt");

CREATE TABLE IF NOT EXISTS "AssetRepairBill" (
  "billId" TEXT NOT NULL PRIMARY KEY,
  "repairId" TEXT NOT NULL,
  "assetId" TEXT NOT NULL,
  "vendorId" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS "AssetRepairBill_repair" ON "AssetRepairBill"("repairId");

CREATE TRIGGER IF NOT EXISTS "AssetRepairEvent_append_only_upd" BEFORE UPDATE ON "AssetRepairEvent"
 BEGIN SELECT RAISE(ABORT, 'AssetRepairEvent is append-only: rows cannot be changed'); END;

CREATE TRIGGER IF NOT EXISTS "AssetRepairEvent_append_only_del" BEFORE DELETE ON "AssetRepairEvent"
 WHEN NOT EXISTS (SELECT 1 FROM "AppSetting" WHERE "key" = 'audit.allowPurge' AND "value" = '1')
 BEGIN SELECT RAISE(ABORT, 'AssetRepairEvent is append-only: rows cannot be deleted'); END;
