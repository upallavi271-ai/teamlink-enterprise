-- 20261005140000_asset_accounts_fields  (Accounts spec S2, 2026-10-05)
-- ADDITIVE ONLY: new nullable / defaulted columns on "Asset" + a new "AssetRepair" table.
-- No existing column is changed, no data is touched.

-- S2.1 asset fields HRMS still lacks (purchaseCost / purchaseDate / category /
-- location / assignedTo already exist).
ALTER TABLE "Asset" ADD COLUMN "vendor" TEXT;
ALTER TABLE "Asset" ADD COLUMN "invoiceNo" TEXT;
ALTER TABLE "Asset" ADD COLUMN "gstPaid" REAL;
ALTER TABLE "Asset" ADD COLUMN "paidVia" TEXT;              -- Bank | Cash | Payable (credit side of the purchase JE)
ALTER TABLE "Asset" ADD COLUMN "paidBankAccountId" TEXT;    -- BankAccount.id when paidVia = Bank (optional)
ALTER TABLE "Asset" ADD COLUMN "usefulLifeYears" REAL;
ALTER TABLE "Asset" ADD COLUMN "depreciationMethod" TEXT;   -- SL | WDV
ALTER TABLE "Asset" ADD COLUMN "depreciationRate" REAL;     -- % a year
ALTER TABLE "Asset" ADD COLUMN "salvageValue" REAL;
-- Sold / Written off (status stays a free string; these describe the disposal)
ALTER TABLE "Asset" ADD COLUMN "disposalDate" TEXT;         -- YYYY-MM-DD
ALTER TABLE "Asset" ADD COLUMN "disposalAmount" REAL;       -- sale proceeds (0 for a write-off)
ALTER TABLE "Asset" ADD COLUMN "disposalPaidVia" TEXT;      -- Bank | Cash (sale proceeds)
ALTER TABLE "Asset" ADD COLUMN "disposalNote" TEXT;

-- S2.2 the repair / maintenance log (today repairs are JSON entries in Asset.history).
CREATE TABLE "AssetRepair" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repairNo" TEXT NOT NULL,                 -- Repair ID, auto (RP-00001)
    "assetId" TEXT NOT NULL,
    "dateReported" TEXT,                      -- YYYY-MM-DD
    "issue" TEXT,
    "repairType" TEXT NOT NULL DEFAULT 'Repair',   -- Repair | Service | AMC | Replacement of part
    "vendor" TEXT,                            -- vendor / service centre
    "repairDate" TEXT,                        -- YYYY-MM-DD
    "cost" REAL NOT NULL DEFAULT 0,
    "gstPaid" REAL NOT NULL DEFAULT 0,
    "invoiceNo" TEXT,
    "paidVia" TEXT,                           -- Bank | Cash | Payable
    "paidBankAccountId" TEXT,
    "underWarranty" BOOLEAN NOT NULL DEFAULT false,
    "capitalise" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'Reported',     -- Reported | In Repair | Completed | Cancelled
    "reportedById" TEXT,
    "reportedByName" TEXT,
    "notes" TEXT,
    "slip" TEXT,                              -- JSON {file,name,type,size} of the vendor slip (as in history today)
    "legacyEntryId" TEXT,                     -- the Asset.history entry id it was copied from (backfill), else null
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AssetRepair_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AssetRepair_repairNo_key" ON "AssetRepair"("repairNo");
CREATE UNIQUE INDEX "AssetRepair_legacyEntryId_key" ON "AssetRepair"("legacyEntryId");
CREATE INDEX "AssetRepair_assetId_idx" ON "AssetRepair"("assetId");
CREATE INDEX "AssetRepair_status_idx" ON "AssetRepair"("status");
