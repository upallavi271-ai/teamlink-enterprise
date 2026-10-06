-- 20261005235500_credit_notes (B2: credit / debit notes). ADDITIVE ONLY.
ALTER TABLE "Invoice" ADD COLUMN "creditedAmount" REAL NOT NULL DEFAULT 0;
ALTER TABLE "Invoice" ADD COLUMN "debitedAmount" REAL NOT NULL DEFAULT 0;
CREATE TABLE "CreditNote" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "kind" TEXT NOT NULL DEFAULT 'credit',
  "number" TEXT,
  "invoiceId" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "applicationId" TEXT,
  "noteDate" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "reasonText" TEXT,
  "amount" REAL NOT NULL,
  "gstType" TEXT NOT NULL DEFAULT 'NONE',
  "gstPercent" REAL NOT NULL DEFAULT 0,
  "cgst" REAL NOT NULL DEFAULT 0,
  "sgst" REAL NOT NULL DEFAULT 0,
  "igst" REAL NOT NULL DEFAULT 0,
  "gst" REAL NOT NULL DEFAULT 0,
  "tdsPercent" REAL NOT NULL DEFAULT 0,
  "tdsBase" TEXT NOT NULL DEFAULT 'base',
  "tds" REAL NOT NULL DEFAULT 0,
  "net" REAL NOT NULL,
  "applied" REAL NOT NULL DEFAULT 0,
  "refundDue" REAL NOT NULL DEFAULT 0,
  "refundPaidOn" TEXT,
  "refundRef" TEXT,
  "refundPaidBy" TEXT,
  "status" TEXT NOT NULL DEFAULT 'Draft',
  "createdById" TEXT,
  "createdByName" TEXT,
  "approvedById" TEXT,
  "approvedByName" TEXT,
  "issuedAt" DATETIME,
  "cancelledAt" DATETIME,
  "cancelledByName" TEXT,
  "cancelReason" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "CreditNote_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CreditNote_number_key" ON "CreditNote"("number");
CREATE INDEX "CreditNote_invoiceId_idx" ON "CreditNote"("invoiceId");
CREATE INDEX "CreditNote_status_idx" ON "CreditNote"("status");
CREATE INDEX "CreditNote_applicationId_idx" ON "CreditNote"("applicationId");
