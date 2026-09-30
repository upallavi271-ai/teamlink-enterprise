-- Office & Expenses: business profile, vendor GSTIN master, government portal
-- links and hand-entered portal balances.
-- Hand-written and additive only (new nullable columns, new tables). No
-- existing row is touched. `prisma migrate diff` is not used because of older,
-- unrelated drift.

-- Company is the business profile: add PAN and TAN.
ALTER TABLE "Company" ADD COLUMN "pan" TEXT;
ALTER TABLE "Company" ADD COLUMN "tan" TEXT;

-- Vendor master: one GSTIN per vendor name, the fallback for a bill's own.
CREATE TABLE "OfficeVendor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "gstin" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "OfficeVendor_name_key" ON "OfficeVendor"("name");

-- Government portal launcher: the page chosen and the (editable) address.
CREATE TABLE "PortalLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "portalKey" TEXT NOT NULL,
    "selectedPage" TEXT,
    "url" TEXT,
    "pageUrls" TEXT,
    "lastEditedAt" DATETIME,
    "lastEditedBy" TEXT
);
CREATE UNIQUE INDEX "PortalLink_portalKey_key" ON "PortalLink"("portalKey");

-- Portal balances typed in by hand, per portal and period.
CREATE TABLE "PortalBalance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "portalKey" TEXT NOT NULL,
    "periodStart" TEXT NOT NULL DEFAULT '',
    "periodEnd" TEXT NOT NULL DEFAULT '',
    "enteredAmount" REAL NOT NULL,
    "enteredBy" TEXT,
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "PortalBalance_portalKey_periodStart_periodEnd_key" ON "PortalBalance"("portalKey", "periodStart", "periodEnd");
