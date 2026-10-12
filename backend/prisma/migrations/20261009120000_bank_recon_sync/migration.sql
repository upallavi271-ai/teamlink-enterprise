-- Bank sync / reconciliation / invoice allocation / actual payment dates.
-- ADDITIVE ONLY: new nullable columns (or columns with a default), one new
-- table, new indexes. No existing row is rewritten and no existing column is
-- dropped or retyped. Every existing line keeps date = the statement date.
-- Undo: rollback.sql in this folder (drops exactly what is added here; the
-- values held in the new columns are lost, nothing else).

-- BankTransaction: value date, the bank's own id, the source row, review reason, reversal link.
ALTER TABLE "BankTransaction" ADD COLUMN "valueDate" TEXT;
ALTER TABLE "BankTransaction" ADD COLUMN "externalId" TEXT;
ALTER TABLE "BankTransaction" ADD COLUMN "sourceLine" INTEGER;
ALTER TABLE "BankTransaction" ADD COLUMN "sourceRow" TEXT;
ALTER TABLE "BankTransaction" ADD COLUMN "reviewReason" TEXT;
ALTER TABLE "BankTransaction" ADD COLUMN "reversalOfId" TEXT;
-- NULL externalId values never collide in SQLite, so lines without a bank id are unaffected.
CREATE UNIQUE INDEX "BankTransaction_bankAccountId_externalId_key" ON "BankTransaction"("bankAccountId", "externalId");
CREATE INDEX "BankTransaction_importBatch_idx" ON "BankTransaction"("importBatch");
CREATE INDEX "BankTransaction_reference_idx" ON "BankTransaction"("reference");

-- BankImport: what the importer found.
ALTER TABLE "BankImport" ADD COLUMN "sourceHash" TEXT;
ALTER TABLE "BankImport" ADD COLUMN "openingBalance" REAL;
ALTER TABLE "BankImport" ADD COLUMN "closingBalance" REAL;
ALTER TABLE "BankImport" ADD COLUMN "balanceCheck" TEXT;
ALTER TABLE "BankImport" ADD COLUMN "failedRows" TEXT;
ALTER TABLE "BankImport" ADD COLUMN "summary" TEXT;
ALTER TABLE "BankImport" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'Done';
CREATE INDEX "BankImport_sourceHash_idx" ON "BankImport"("sourceHash");

-- BankRule: who confirmed a narration mapping.
ALTER TABLE "BankRule" ADD COLUMN "createdById" TEXT;
ALTER TABLE "BankRule" ADD COLUMN "createdByName" TEXT;
ALTER TABLE "BankRule" ADD COLUMN "source" TEXT;

-- InvoicePayment: where the payment date came from.
ALTER TABLE "InvoicePayment" ADD COLUMN "dateSource" TEXT;

-- Invoice: approved adjustments total (0 on every existing invoice).
ALTER TABLE "Invoice" ADD COLUMN "adjustedAmount" REAL NOT NULL DEFAULT 0;

-- OfficeExpense: the actual payment date.
ALTER TABLE "OfficeExpense" ADD COLUMN "paymentDate" TEXT;

-- InvoiceAdjustment: maker-checker adjustments.
CREATE TABLE "InvoiceAdjustment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "invoiceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "reason" TEXT NOT NULL,
    "bankTxnId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "requestedById" TEXT,
    "requestedBy" TEXT,
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" TEXT,
    "decidedBy" TEXT,
    "decidedAt" DATETIME,
    "decisionNote" TEXT,
    CONSTRAINT "InvoiceAdjustment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "InvoiceAdjustment_invoiceId_idx" ON "InvoiceAdjustment"("invoiceId");
CREATE INDEX "InvoiceAdjustment_status_idx" ON "InvoiceAdjustment"("status");
