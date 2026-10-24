-- 20261019180000_vendor_asset_grants - what Admin chose to show ONE asset vendor in the Assets Vendor Portal: a single HRMS asset, or a whole
-- asset category (utils/assetHrmsScope.js). ADDITIVE ONLY (nothing existing is altered). The server also creates this table by itself the first
-- time the portal needs it (utils/assetVendorSchema.js), with the same statements.
CREATE TABLE IF NOT EXISTS "VendorAssetGrant" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "vendorId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "assetId" TEXT,
  "category" TEXT,
  "grantKey" TEXT NOT NULL,
  "grantedById" TEXT,
  "grantedByName" TEXT,
  "grantedAt" TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "VendorAssetGrant_key" ON "VendorAssetGrant"("vendorId", "grantKey");

CREATE INDEX IF NOT EXISTS "VendorAssetGrant_asset" ON "VendorAssetGrant"("assetId");
