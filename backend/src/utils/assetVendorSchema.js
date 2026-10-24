// ---------------------------------------------------------------------------
// ASSETS VENDOR PORTAL - SELF-PROVISIONING TABLES (2026-10-19).
//
// Same pattern as vendorMailSchema.js: raw-SQL tables with no Prisma model (no `prisma generate` needed), created with
// CREATE TABLE IF NOT EXISTS the first time the Assets Vendor Portal needs them. ADDITIVE ONLY: nothing existing is altered.
// The hand-written migration 20261019150000_assets_vendor_portal holds the same statements and a rollback.
//
//   AssetVendorInfo      what the company's Asset table does not hold: brand, model, condition of ONE asset (assetId is the
//                        primary key = one row per asset, never a second asset). Written by a vendor who may edit.
//   AssetRepairVendor    the vendor's side of ONE existing AssetRepair (repairId is the primary key = one link per repair, so a
//                        repair can never be linked twice): the vendor id, the finer repair stage (awaiting / sent / under repair /
//                        completed / returned), the ESTIMATE (the HRMS repair row has no estimate field), expected / returned dates,
//                        the latest vendor remark and the invoice file. The FINAL cost, GST, invoice no. and the vendor name are
//                        written into the existing AssetRepair row itself - that is what Accounts reads.
//   AssetRepairBill      which vendor invoice (VendorBillSubmission = the existing Accounts review queue) was sent for which repair. billId is the
//                        primary key: one bill belongs to one repair. The payment state itself is NEVER stored here: it is read live from the
//                        Accounts bill (OfficeExpense) and the bank line, through utils/expensePaymentState.js.
//   AssetRepairEvent     the repair history: one row per change (who, when, field, old -> new). APPEND-ONLY at database level
//                        (UPDATE is refused; DELETE is refused unless the same break-glass setting the asset audit trail uses is on).
//
// ensure() is cheap after the first call. It never throws: a failure is logged and answered with false.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const DDL = [
  `CREATE TABLE IF NOT EXISTS "AssetVendorInfo" (
    "assetId" TEXT NOT NULL PRIMARY KEY,
    "brand" TEXT,
    "model" TEXT,
    "condition" TEXT,
    "updatedByName" TEXT,
    "updatedVendorId" TEXT,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "AssetRepairVendor" (
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
  )`,
  'CREATE INDEX IF NOT EXISTS "AssetRepairVendor_vendor" ON "AssetRepairVendor"("vendorId")',
  'CREATE INDEX IF NOT EXISTS "AssetRepairVendor_asset" ON "AssetRepairVendor"("assetId")',
  `CREATE TABLE IF NOT EXISTS "AssetRepairEvent" (
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
  )`,
  'CREATE INDEX IF NOT EXISTS "AssetRepairEvent_repair" ON "AssetRepairEvent"("repairId", "createdAt")',
  'CREATE INDEX IF NOT EXISTS "AssetRepairEvent_asset" ON "AssetRepairEvent"("assetId", "createdAt")',
  `CREATE TABLE IF NOT EXISTS "AssetRepairBill" (
    "billId" TEXT NOT NULL PRIMARY KEY,
    "repairId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS "AssetRepairBill_repair" ON "AssetRepairBill"("repairId")',
  // 2026-10-19 (HRMS assets): what Admin chose to show ONE vendor - a single HRMS asset or a whole category (utils/assetHrmsScope.js).
  // grantKey = 'a:<assetId>' or 'c:<category lower-case>' and UNIQUE with the vendor, so the same thing can never be granted twice.
  `CREATE TABLE IF NOT EXISTS "VendorAssetGrant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vendorId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "assetId" TEXT,
    "category" TEXT,
    "grantKey" TEXT NOT NULL,
    "grantedById" TEXT,
    "grantedByName" TEXT,
    "grantedAt" TEXT NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "VendorAssetGrant_key" ON "VendorAssetGrant"("vendorId", "grantKey")',
  'CREATE INDEX IF NOT EXISTS "VendorAssetGrant_asset" ON "VendorAssetGrant"("assetId")',
  // 2026-10-19 (HRMS repair complaints): one row per asset COMPLAINT raised in HRMS (the ticket itself is the existing EmployeeRecord, type ASSET).
  // ticketId is the primary key and repairId is UNIQUE when set, so one ticket can never make two repairs (utils/assetComplaints.js).
  `CREATE TABLE IF NOT EXISTS "AssetComplaint" (
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
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "AssetComplaint_ref" ON "AssetComplaint"("ticketRef")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "AssetComplaint_repair" ON "AssetComplaint"("repairId") WHERE "repairId" IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS "AssetComplaint_asset" ON "AssetComplaint"("assetId")',
  // 2026-10-19 (vendor Import): one row per CONFIRMED import a vendor login ran. (vendorUserId, idemKey) is UNIQUE: the same Idempotency-Key
  // can only ever do the work once; a second request gets the first answer back. Holds counts and the per-row report, never the file.
  `CREATE TABLE IF NOT EXISTS "VendorImportRun" (
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
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "VendorImportRun_idem" ON "VendorImportRun"("vendorUserId", "idemKey")',
  'CREATE INDEX IF NOT EXISTS "VendorImportRun_vendor" ON "VendorImportRun"("vendorId", "createdAt")',
  `CREATE TRIGGER IF NOT EXISTS "AssetRepairEvent_append_only_upd" BEFORE UPDATE ON "AssetRepairEvent"
   BEGIN SELECT RAISE(ABORT, 'AssetRepairEvent is append-only: rows cannot be changed'); END`,
  `CREATE TRIGGER IF NOT EXISTS "AssetRepairEvent_append_only_del" BEFORE DELETE ON "AssetRepairEvent"
   WHEN NOT EXISTS (SELECT 1 FROM "AppSetting" WHERE "key" = 'audit.allowPurge' AND "value" = '1')
   BEGIN SELECT RAISE(ABORT, 'AssetRepairEvent is append-only: rows cannot be deleted'); END`,
];

let done = null;
function ensure() {
  if (done) return done;
  done = (async () => {
    for (const sql of DDL) await prisma.$executeRawUnsafe(sql); // eslint-disable-line no-await-in-loop
    return true;
  })().catch((err) => { done = null; console.error('[assets-vendor-portal] schema:', err.message); return false; });
  return done;
}

// For tests: forget the cached answer.
const reset = () => { done = null; };

module.exports = { ensure, reset, DDL };
