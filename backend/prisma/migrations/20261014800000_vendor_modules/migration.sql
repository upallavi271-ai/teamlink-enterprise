-- 20261014800000_vendor_modules  (Vendor Management: category-aware, config-driven vendor portal, 2026-10-14)
-- ADDITIVE ONLY: new tables + indexes. No existing table or column is altered and no row is rewritten.
-- A vendor login with NO row in VendorLoginModule keeps today's behaviour (Assets + Bills + Documents + Profile).
-- The application reads / writes these tables with plain SQL and feature-detects them (no prisma generate needed);
-- until this migration is applied the new vendor modules answer "not set up yet" and everything old works as before.
-- Times are DATETIME columns holding epoch milliseconds (like every Prisma SQLite DateTime).
-- Undo: rollback.sql in this folder.

-- Which modules one vendor login sees + that module's permission ticks (JSON {"canEdit":true,...}).
CREATE TABLE "VendorLoginModule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vendorUserId" TEXT NOT NULL,
    "moduleKey" TEXT NOT NULL,
    "permissionsJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX "VendorLoginModule_vendorUserId_moduleKey_key" ON "VendorLoginModule"("vendorUserId", "moduleKey");
CREATE INDEX "VendorLoginModule_moduleKey_idx" ON "VendorLoginModule"("moduleKey");

-- ID CARDS vendor ------------------------------------------------------------
-- status: New -> Received -> Printing -> Ready -> Delivered (the vendor moves it, one step at a time).
CREATE TABLE "IdCardOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderCode" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'New',
    "note" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "vendorRemarks" TEXT,
    "challanFile" TEXT,
    "challanName" TEXT,
    "challanMime" TEXT,
    "challanSize" INTEGER,
    "receivedAt" DATETIME,
    "printingAt" DATETIME,
    "readyAt" DATETIME,
    "deliveredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX "IdCardOrder_orderCode_key" ON "IdCardOrder"("orderCode");
CREATE INDEX "IdCardOrder_vendorId_idx" ON "IdCardOrder"("vendorId", "status");

CREATE TABLE "IdCardOrderLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "employeeCode" TEXT,
    "employeeName" TEXT NOT NULL,
    "designation" TEXT,
    "department" TEXT,
    "bloodGroup" TEXT,
    "photoDocId" TEXT,
    "cardType" TEXT NOT NULL DEFAULT 'New',
    "createdAt" DATETIME NOT NULL DEFAULT 0
);
CREATE INDEX "IdCardOrderLine_orderId_idx" ON "IdCardOrderLine"("orderId");
CREATE INDEX "IdCardOrderLine_employeeId_idx" ON "IdCardOrderLine"("employeeId");

CREATE TABLE "IdCardOrderEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "actorKind" TEXT NOT NULL DEFAULT 'Staff',
    "actorName" TEXT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT 0
);
CREATE INDEX "IdCardOrderEvent_orderId_idx" ON "IdCardOrderEvent"("orderId");

-- AIRTEL / TELECOM vendor -----------------------------------------------------
-- A company number. assetId = the Asset row (category SIM Card) it was imported from, if any.
CREATE TABLE "SimConnection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vendorId" TEXT NOT NULL,
    "mobileNumber" TEXT NOT NULL,
    "simSerial" TEXT,
    "plan" TEXT,
    "employeeId" TEXT,
    "employeeName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "assetId" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX "SimConnection_vendorId_mobileNumber_key" ON "SimConnection"("vendorId", "mobileNumber");
CREATE INDEX "SimConnection_assetId_idx" ON "SimConnection"("assetId");

-- kind: new connection | replacement SIM | port-out | plan change. status: Open -> In progress -> Done | Rejected.
CREATE TABLE "SimRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requestCode" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "simId" TEXT,
    "kind" TEXT NOT NULL,
    "details" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Open',
    "vendorNote" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX "SimRequest_requestCode_key" ON "SimRequest"("requestCode");
CREATE INDEX "SimRequest_vendorId_idx" ON "SimRequest"("vendorId", "status");

-- INVOICES / MONTHLY BILLS / RECEIPTS for vendors that are not tied to an asset ----------------
-- (VendorBillSubmission needs an asset, so these vendors cannot use it.) kind: invoice | monthly_bill | receipt.
-- status: Submitted -> Approved -> Paid, or Rejected. Payment fields are filled by Accounts.
CREATE TABLE "VendorModuleBill" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "billCode" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "vendorUserId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'invoice',
    "orderId" TEXT,
    "billNumber" TEXT,
    "billNumberKey" TEXT,
    "billDate" TEXT,
    "period" TEXT,
    "dueDate" TEXT,
    "quantity" REAL,
    "rate" REAL,
    "amount" REAL NOT NULL DEFAULT 0,
    "gst" REAL NOT NULL DEFAULT 0,
    "total" REAL NOT NULL DEFAULT 0,
    "lines" TEXT NOT NULL DEFAULT '[]',
    "remarks" TEXT,
    "documentFile" TEXT,
    "documentName" TEXT,
    "documentMime" TEXT,
    "documentSize" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'Submitted',
    "rejectionReason" TEXT,
    "reviewRemarks" TEXT,
    "reviewedById" TEXT,
    "reviewedByName" TEXT,
    "reviewedAt" DATETIME,
    "paidOn" TEXT,
    "paidAmount" REAL,
    "paymentRef" TEXT,
    "paymentMode" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX "VendorModuleBill_billCode_key" ON "VendorModuleBill"("billCode");
CREATE UNIQUE INDEX "VendorModuleBill_idem_key" ON "VendorModuleBill"("vendorUserId", "idempotencyKey");
CREATE INDEX "VendorModuleBill_vendorId_idx" ON "VendorModuleBill"("vendorId", "kind", "status");
CREATE INDEX "VendorModuleBill_orderId_idx" ON "VendorModuleBill"("orderId");
