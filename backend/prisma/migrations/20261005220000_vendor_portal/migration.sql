-- 20261005220000_vendor_portal  (P3 Vendor Login + Vendor Asset Portal + vendor bills, 2026-10-05)
-- ADDITIVE ONLY: 4 nullable columns on "Asset" + 6 new tables. No existing
-- column is changed, no row is touched. Asset.vendor (free text) stays.

-- Asset -> vendor master. SQLite allows ADD COLUMN ... REFERENCES when the
-- default is NULL; existing rows get NULL (nothing is auto-linked).
ALTER TABLE "Asset" ADD COLUMN "vendorId" TEXT REFERENCES "OfficeVendor" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Asset" ADD COLUMN "serialNumber" TEXT;
ALTER TABLE "Asset" ADD COLUMN "amcUntil" TEXT;          -- YYYY-MM-DD
ALTER TABLE "Asset" ADD COLUMN "serviceRemarks" TEXT;
CREATE INDEX "Asset_vendorId_idx" ON "Asset"("vendorId");

CREATE TABLE "VendorUser" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "canEdit" BOOLEAN NOT NULL DEFAULT false,
    "canViewCost" BOOLEAN NOT NULL DEFAULT false,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT true,
    "passwordChangedAt" DATETIME,
    "lastLoginAt" DATETIME,
    "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" DATETIME,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "VendorUser_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "OfficeVendor" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "VendorUser_email_key" ON "VendorUser"("email");
CREATE INDEX "VendorUser_vendorId_idx" ON "VendorUser"("vendorId");

CREATE TABLE "VendorAssetAccess" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vendorUserId" TEXT NOT NULL,
    "assetId" TEXT,
    "category" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VendorAssetAccess_vendorUserId_fkey" FOREIGN KEY ("vendorUserId") REFERENCES "VendorUser" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "VendorAssetAccess_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "VendorAssetAccess_vendorUserId_assetId_key" ON "VendorAssetAccess"("vendorUserId", "assetId");
CREATE UNIQUE INDEX "VendorAssetAccess_vendorUserId_category_key" ON "VendorAssetAccess"("vendorUserId", "category");
CREATE INDEX "VendorAssetAccess_assetId_idx" ON "VendorAssetAccess"("assetId");

CREATE TABLE "VendorSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vendorUserId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "revokedReason" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    CONSTRAINT "VendorSession_vendorUserId_fkey" FOREIGN KEY ("vendorUserId") REFERENCES "VendorUser" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "VendorSession_vendorUserId_idx" ON "VendorSession"("vendorUserId");

CREATE TABLE "AssetAuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "assetId" TEXT,
    "vendorId" TEXT,
    "vendorUserId" TEXT,
    "changedById" TEXT,
    "actorName" TEXT,
    "role" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "field" TEXT,
    "oldValue" TEXT,
    "newValue" TEXT,
    "billId" TEXT,
    "documentName" TEXT,
    "status" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "AssetAuditLog_assetId_idx" ON "AssetAuditLog"("assetId");
CREATE INDEX "AssetAuditLog_vendorUserId_idx" ON "AssetAuditLog"("vendorUserId");
CREATE INDEX "AssetAuditLog_createdAt_idx" ON "AssetAuditLog"("createdAt");

CREATE TABLE "AssetDocument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "assetId" TEXT NOT NULL,
    "docType" TEXT NOT NULL DEFAULT 'Other',
    "name" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "file" TEXT NOT NULL,
    "vendorId" TEXT,
    "vendorUserId" TEXT,
    "uploadedById" TEXT,
    "uploadedByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AssetDocument_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "AssetDocument_assetId_idx" ON "AssetDocument"("assetId");

CREATE TABLE "VendorBillSubmission" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "billCode" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "vendorUserId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "assetCode" TEXT,
    "assetName" TEXT,
    "billNumber" TEXT NOT NULL,
    "billDate" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "gst" REAL NOT NULL DEFAULT 0,
    "tds" REAL NOT NULL DEFAULT 0,
    "total" REAL NOT NULL,
    "remarks" TEXT,
    "documentFile" TEXT,
    "documentName" TEXT,
    "documentMime" TEXT,
    "documentSize" INTEGER,
    "supportingDocs" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
    "rejectionReason" TEXT,
    "reviewRemarks" TEXT,
    "submittedByName" TEXT,
    "submittedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedById" TEXT,
    "verifiedAt" DATETIME,
    "reviewedById" TEXT,
    "reviewedByName" TEXT,
    "reviewedAt" DATETIME,
    "expenseId" TEXT,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "VendorBillSubmission_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "OfficeVendor" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "VendorBillSubmission_vendorUserId_fkey" FOREIGN KEY ("vendorUserId") REFERENCES "VendorUser" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "VendorBillSubmission_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "VendorBillSubmission_billCode_key" ON "VendorBillSubmission"("billCode");
CREATE UNIQUE INDEX "VendorBillSubmission_expenseId_key" ON "VendorBillSubmission"("expenseId");
CREATE INDEX "VendorBillSubmission_vendorId_idx" ON "VendorBillSubmission"("vendorId");
CREATE INDEX "VendorBillSubmission_assetId_idx" ON "VendorBillSubmission"("assetId");
CREATE INDEX "VendorBillSubmission_status_idx" ON "VendorBillSubmission"("status");
