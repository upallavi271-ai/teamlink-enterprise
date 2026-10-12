-- 20261009190000_vendor_master_v3  (Vendor master + invites + shared documents, 2026-10-09)
-- ADDITIVE ONLY: new nullable columns, new tables, new indexes, two triggers.
-- No existing column changes and no row is rewritten or auto-linked.
-- Rollback: rollback.sql in this folder.

-- ---- Vendor master (one master for Admin + Office & Accounts) ---------------
ALTER TABLE "OfficeVendor" ADD COLUMN "vendorCode" TEXT;          -- VEN-0001 (filled by the app / migration script)
ALTER TABLE "OfficeVendor" ADD COLUMN "companyName" TEXT;
ALTER TABLE "OfficeVendor" ADD COLUMN "pan" TEXT;
ALTER TABLE "OfficeVendor" ADD COLUMN "category" TEXT;
-- Normalised keys for the duplicate checks (upper-case alphanumerics for
-- GSTIN / PAN, trimmed lower-case email, digits-only phone). NULL when blank,
-- so SQLite's unique index allows any number of blank rows.
ALTER TABLE "OfficeVendor" ADD COLUMN "gstinKey" TEXT;
ALTER TABLE "OfficeVendor" ADD COLUMN "panKey" TEXT;
ALTER TABLE "OfficeVendor" ADD COLUMN "emailKey" TEXT;
ALTER TABLE "OfficeVendor" ADD COLUMN "phoneKey" TEXT;
ALTER TABLE "OfficeVendor" ADD COLUMN "source" TEXT;              -- Office | Admin | Migration
ALTER TABLE "OfficeVendor" ADD COLUMN "createdById" TEXT;
ALTER TABLE "OfficeVendor" ADD COLUMN "updatedById" TEXT;
ALTER TABLE "OfficeVendor" ADD COLUMN "deactivatedAt" DATETIME;
ALTER TABLE "OfficeVendor" ADD COLUMN "deactivatedById" TEXT;
ALTER TABLE "OfficeVendor" ADD COLUMN "deactivationReason" TEXT;
CREATE UNIQUE INDEX "OfficeVendor_vendorCode_key" ON "OfficeVendor"("vendorCode");
CREATE UNIQUE INDEX "OfficeVendor_gstinKey_key" ON "OfficeVendor"("gstinKey");
CREATE UNIQUE INDEX "OfficeVendor_panKey_key" ON "OfficeVendor"("panKey");
CREATE UNIQUE INDEX "OfficeVendor_emailKey_key" ON "OfficeVendor"("emailKey");
CREATE INDEX "OfficeVendor_phoneKey_idx" ON "OfficeVendor"("phoneKey");

-- ---- Expenses / bills: link by id + snapshot --------------------------------
-- vendor (text) and vendorGstin already exist and stay as the NAME / GSTIN
-- snapshot taken when the bill was booked. vendorId is plain text on purpose
-- (no foreign key): an old bill must survive anything done to the master.
ALTER TABLE "OfficeExpense" ADD COLUMN "vendorId" TEXT;
ALTER TABLE "OfficeExpense" ADD COLUMN "vendorAddress" TEXT;
ALTER TABLE "OfficeExpense" ADD COLUMN "vendorPan" TEXT;
CREATE INDEX "OfficeExpense_vendorId_idx" ON "OfficeExpense"("vendorId");

ALTER TABLE "VendorBillSubmission" ADD COLUMN "vendorNameSnap" TEXT;
ALTER TABLE "VendorBillSubmission" ADD COLUMN "vendorGstinSnap" TEXT;
ALTER TABLE "VendorBillSubmission" ADD COLUMN "vendorAddressSnap" TEXT;

-- ---- Invite / reset links (single use, expiring, only the hash is stored) ---
CREATE TABLE "VendorLoginToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vendorUserId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,                 -- invite | reset
    "tokenHash" TEXT NOT NULL,               -- sha256 of the link token
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "revokedAt" DATETIME,
    "createdById" TEXT,
    "createdByName" TEXT,
    "usedIp" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VendorLoginToken_vendorUserId_fkey" FOREIGN KEY ("vendorUserId") REFERENCES "VendorUser" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "VendorLoginToken_tokenHash_key" ON "VendorLoginToken"("tokenHash");
CREATE INDEX "VendorLoginToken_vendorUserId_idx" ON "VendorLoginToken"("vendorUserId");

-- ---- Documents shared with one vendor (not tied to an asset) ----------------
CREATE TABLE "VendorSharedDocument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vendorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "docType" TEXT NOT NULL DEFAULT 'Other',
    "name" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "file" TEXT NOT NULL,
    "note" TEXT,
    "sharedById" TEXT,
    "sharedByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" DATETIME,
    "revokedById" TEXT,
    CONSTRAINT "VendorSharedDocument_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "OfficeVendor" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "VendorSharedDocument_vendorId_idx" ON "VendorSharedDocument"("vendorId");

-- ---- Append-only vendor audit trail (DB level) ------------------------------
-- UPDATE is never allowed. DELETE is refused unless the break-glass setting
-- AppSetting key 'audit.allowPurge' = '1' exists (used only by sandbox tests).
-- The main AuditLog is NOT touched (its approval columns are updated by design).
CREATE TRIGGER "AssetAuditLog_append_only_upd" BEFORE UPDATE ON "AssetAuditLog"
BEGIN SELECT RAISE(ABORT, 'AssetAuditLog is append-only: rows cannot be changed'); END;
CREATE TRIGGER "AssetAuditLog_append_only_del" BEFORE DELETE ON "AssetAuditLog"
WHEN NOT EXISTS (SELECT 1 FROM "AppSetting" WHERE "key" = 'audit.allowPurge' AND "value" = '1')
BEGIN SELECT RAISE(ABORT, 'AssetAuditLog is append-only: rows cannot be deleted'); END;
