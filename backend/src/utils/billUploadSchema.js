// ---------------------------------------------------------------------------
// VENDOR BILL UPLOADS - SELF-PROVISIONING TABLES (2026-10-21). Same pattern as assetVendorSchema.js: raw-SQL tables with no Prisma model
// (no `prisma generate`), CREATE ... IF NOT EXISTS the first time the feature needs them. ADDITIVE ONLY: nothing existing is altered.
// The migration 20261021120000_vendor_bill_upload holds the same statements and a rollback.
//
//   VendorBillUpload       one bill a vendor uploaded (a photo / scan / PDF of up to 5 pages), its status, what was read from it, the checks
//                          (flags), the review and the links to what it became (VendorBillSubmission, OfficeExpense). A replaced upload stays
//                          (status SUPERSEDED); the new one points back (supersedes) and carries version + 1.
//   VendorBillUploadLine   the rows of the bill's table (replaced as a whole whenever a person corrects them; every change is in the events).
//   VendorBillUploadEvent  the history: who, when, what, old -> new. APPEND-ONLY at database level (UPDATE refused; DELETE refused unless the
//                          same break-glass setting the asset audit trail uses is on).
// Duplicate guards in the database itself (partial UNIQUE indexes): one approved bill per (vendor, invoice number, total); one approved bill
// per repair; one upload per submission and per expense; one upload per (vendor, Idempotency-Key).
// ---------------------------------------------------------------------------
const prisma = require('../db');

const DDL = [
  `CREATE TABLE IF NOT EXISTS "VendorBillUpload" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "vendorUserId" TEXT,
    "uploadedByName" TEXT,
    "repairId" TEXT,
    "assetId" TEXT,
    "status" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'vendor-portal',
    "rootId" TEXT,
    "supersedes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "filesJson" TEXT NOT NULL DEFAULT '[]',
    "fileCount" INTEGER NOT NULL DEFAULT 0,
    "contentHash" TEXT,
    "remarks" TEXT,
    "idemKey" TEXT,
    "invoiceNo" TEXT,
    "invoiceNoKey" TEXT,
    "invoiceDate" TEXT,
    "serviceDate" TEXT,
    "assetRef" TEXT,
    "vendorNameOnBill" TEXT,
    "subtotal" REAL,
    "gst" REAL,
    "cgst" REAL,
    "sgst" REAL,
    "igst" REAL,
    "total" REAL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "workDescription" TEXT,
    "docType" TEXT,
    "rawJson" TEXT,
    "metaJson" TEXT,
    "flagsJson" TEXT NOT NULL DEFAULT '[]',
    "acksJson" TEXT NOT NULL DEFAULT '[]',
    "aiNotes" TEXT,
    "aiProvider" TEXT,
    "aiModel" TEXT,
    "aiAttempts" INTEGER NOT NULL DEFAULT 0,
    "aiReads" INTEGER NOT NULL DEFAULT 0,
    "aiRunId" TEXT,
    "aiStartedAt" TEXT,
    "aiFinishedAt" TEXT,
    "aiError" TEXT,
    "aiUsageJson" TEXT,
    "sentBackNote" TEXT,
    "sentBackAt" TEXT,
    "reviewerId" TEXT,
    "reviewerName" TEXT,
    "reviewedAt" TEXT,
    "reviewNote" TEXT,
    "rejectionReason" TEXT,
    "approvedAt" TEXT,
    "approvedById" TEXT,
    "approvedByName" TEXT,
    "duplicateClearedById" TEXT,
    "duplicateClearedAt" TEXT,
    "category" TEXT,
    "paymentMode" TEXT,
    "dueDate" TEXT,
    "syncStartedAt" TEXT,
    "syncedAt" TEXT,
    "syncError" TEXT,
    "submissionId" TEXT,
    "expenseId" TEXT,
    "notifiedAt" TEXT,
    "vendorSeenStatus" TEXT,
    "uploadedAt" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "VendorBillUpload_code" ON "VendorBillUpload"("code")',
  'CREATE INDEX IF NOT EXISTS "VendorBillUpload_vendor" ON "VendorBillUpload"("vendorId", "status")',
  'CREATE INDEX IF NOT EXISTS "VendorBillUpload_vendor_time" ON "VendorBillUpload"("vendorId", "uploadedAt")',
  'CREATE INDEX IF NOT EXISTS "VendorBillUpload_repair" ON "VendorBillUpload"("repairId")',
  'CREATE INDEX IF NOT EXISTS "VendorBillUpload_asset" ON "VendorBillUpload"("assetId")',
  'CREATE INDEX IF NOT EXISTS "VendorBillUpload_hash" ON "VendorBillUpload"("vendorId", "contentHash")',
  'CREATE INDEX IF NOT EXISTS "VendorBillUpload_invoice" ON "VendorBillUpload"("vendorId", "invoiceNoKey")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "VendorBillUpload_idem" ON "VendorBillUpload"("vendorId", "idemKey") WHERE "idemKey" IS NOT NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS "VendorBillUpload_submission" ON "VendorBillUpload"("submissionId") WHERE "submissionId" IS NOT NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS "VendorBillUpload_expense" ON "VendorBillUpload"("expenseId") WHERE "expenseId" IS NOT NULL',
  `CREATE UNIQUE INDEX IF NOT EXISTS "VendorBillUpload_one_approved_invoice" ON "VendorBillUpload"("vendorId", "invoiceNoKey", "total")
   WHERE "status" IN ('APPROVED','SYNCED') AND "invoiceNoKey" IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "VendorBillUpload_one_approved_repair" ON "VendorBillUpload"("repairId")
   WHERE "status" IN ('APPROVED','SYNCED') AND "repairId" IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS "VendorBillUploadLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "uploadId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "description" TEXT,
    "quantity" REAL,
    "rate" REAL,
    "amount" REAL,
    "confidence" REAL,
    "unclear" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "edited" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TEXT NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "VendorBillUploadLine_no" ON "VendorBillUploadLine"("uploadId", "lineNo")',
  `CREATE TABLE IF NOT EXISTS "VendorBillUploadEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "uploadId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "field" TEXT,
    "fromValue" TEXT,
    "toValue" TEXT,
    "note" TEXT,
    "actorKind" TEXT NOT NULL,
    "actorName" TEXT,
    "actorId" TEXT,
    "visibleToVendor" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS "VendorBillUploadEvent_upload" ON "VendorBillUploadEvent"("uploadId", "createdAt")',
  'CREATE INDEX IF NOT EXISTS "VendorBillUploadEvent_vendor_kind" ON "VendorBillUploadEvent"("vendorId", "kind", "createdAt")',
  `CREATE TRIGGER IF NOT EXISTS "VendorBillUploadEvent_append_only_upd" BEFORE UPDATE ON "VendorBillUploadEvent"
   BEGIN SELECT RAISE(ABORT, 'VendorBillUploadEvent is append-only: rows cannot be changed'); END`,
  `CREATE TRIGGER IF NOT EXISTS "VendorBillUploadEvent_append_only_del" BEFORE DELETE ON "VendorBillUploadEvent"
   WHEN NOT EXISTS (SELECT 1 FROM "AppSetting" WHERE "key" = 'audit.allowPurge' AND "value" = '1')
   BEGIN SELECT RAISE(ABORT, 'VendorBillUploadEvent is append-only: rows cannot be deleted'); END`,
];

let done = null;
function ensure() {
  if (done) return done;
  done = (async () => {
    for (const sql of DDL) await prisma.$executeRawUnsafe(sql); // eslint-disable-line no-await-in-loop
    return true;
  })().catch((err) => { done = null; console.error('[vendor-bill-upload] schema:', err.message); return false; }); // eslint-disable-line no-console
  return done;
}
const reset = () => { done = null; };

module.exports = { ensure, reset, DDL };
