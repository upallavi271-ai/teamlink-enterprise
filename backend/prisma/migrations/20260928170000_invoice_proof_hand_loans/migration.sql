-- Accounts: invoice proof, bank-panel bills and hand loans. Additive only —
-- every new column is nullable or defaulted, no existing row is changed.

-- The Form 16A file behind an invoice's TDS certificate (utils/attachments.js
-- stored name + display name + MIME). Null = no file uploaded.
ALTER TABLE "Invoice" ADD COLUMN "tdsCertFile" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "tdsCertName" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "tdsCertMime" TEXT;

-- A receipt recorded by hand that a bank statement line was later linked to as
-- its proof. Undoing that link must never delete the receipt itself.
ALTER TABLE "InvoicePayment" ADD COLUMN "bankLinked" BOOLEAN NOT NULL DEFAULT false;

-- The office bill the Match / Categorise panel created from this line, and the
-- existing bills it settled (JSON: [{id, approvalStatus, paidStatus}]) so an
-- undo can put them back exactly.
ALTER TABLE "BankTransaction" ADD COLUMN "createdBillId" TEXT;
ALTER TABLE "BankTransaction" ADD COLUMN "billLinks" TEXT;

-- Hand loans (Bank & Reconciliation). Money taken from a person, and the bank
-- lines that prove the taking and every repayment.
CREATE TABLE "HandLoan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "lender" TEXT,
    "amount" REAL NOT NULL,
    "dateTaken" TEXT NOT NULL,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "HandLoanLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "loanId" TEXT NOT NULL,
    "bankTxnId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "reference" TEXT,
    "description" TEXT,
    "auto" BOOLEAN NOT NULL DEFAULT false,
    "linkedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HandLoanLink_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "HandLoan" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "HandLoanLink_bankTxnId_key" ON "HandLoanLink"("bankTxnId");
CREATE INDEX "HandLoanLink_loanId_idx" ON "HandLoanLink"("loanId");
