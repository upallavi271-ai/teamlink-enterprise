-- Add Client in 9 sections (2026-10-05): the client fields the new form keeps
-- that had no column yet, and one table for the client's documents.
-- ADDITIVE ONLY: nullable columns on "Client" (ALTER TABLE ADD COLUMN, no table
-- rebuild) + one new table "ClientDocument". Nothing existing is changed.
-- Folder name: 20261005170000_client_profile_sections

-- 1. Basic details
ALTER TABLE "Client" ADD COLUMN "companyType" TEXT;
ALTER TABLE "Client" ADD COLUMN "companyEmail" TEXT;
-- 2. Primary contact
ALTER TABLE "Client" ADD COLUMN "contactAltPhone" TEXT;
-- 3. Ownership
ALTER TABLE "Client" ADD COLUMN "secondaryBde" TEXT;
ALTER TABLE "Client" ADD COLUMN "clientSource" TEXT;
-- 4. Commercial
ALTER TABLE "Client" ADD COLUMN "feeType" TEXT;
ALTER TABLE "Client" ADD COLUMN "feeAmount" REAL;
ALTER TABLE "Client" ADD COLUMN "gstApplicable" TEXT;
ALTER TABLE "Client" ADD COLUMN "tdsApplicable" TEXT;
ALTER TABLE "Client" ADD COLUMN "replacementTerms" TEXT;
-- 5. Agreement
ALTER TABLE "Client" ADD COLUMN "specialTerms" TEXT;
-- 6. Tax & billing
ALTER TABLE "Client" ADD COLUMN "billingAddress" TEXT;
ALTER TABLE "Client" ADD COLUMN "billingSameAsAddress" BOOLEAN;
ALTER TABLE "Client" ADD COLUMN "billingEmail" TEXT;
ALTER TABLE "Client" ADD COLUMN "invoiceEmail" TEXT;
-- 7. Payment details (how the client pays US). The optional bank account is
-- stored ENCRYPTED (utils/secrets.js) + its last 4 digits for display.
ALTER TABLE "Client" ADD COLUMN "paymentMethod" TEXT;
ALTER TABLE "Client" ADD COLUMN "paymentBankName" TEXT;
ALTER TABLE "Client" ADD COLUMN "paymentUpi" TEXT;
ALTER TABLE "Client" ADD COLUMN "paymentReferenceNote" TEXT;
ALTER TABLE "Client" ADD COLUMN "bankAccountHolder" TEXT;
ALTER TABLE "Client" ADD COLUMN "bankAccountNoEnc" TEXT;
ALTER TABLE "Client" ADD COLUMN "bankAccountLast4" TEXT;
ALTER TABLE "Client" ADD COLUMN "bankIfsc" TEXT;
-- 9. Internal notes (never shown to the client)
ALTER TABLE "Client" ADD COLUMN "internalNotes" TEXT;
ALTER TABLE "Client" ADD COLUMN "specialInstructions" TEXT;
ALTER TABLE "Client" ADD COLUMN "recruitmentInstructions" TEXT;
ALTER TABLE "Client" ADD COLUMN "internalRemarks" TEXT;

-- 8. Documents
CREATE TABLE "ClientDocument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'OTHER',
    "name" TEXT NOT NULL,
    "fileStored" TEXT NOT NULL,
    "fileName" TEXT,
    "fileMime" TEXT,
    "fileSize" INTEGER,
    "expiryDate" TEXT,
    "pending" BOOLEAN NOT NULL DEFAULT false,
    "uploadedById" TEXT,
    "uploadedByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ClientDocument_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ClientDocument_clientId_idx" ON "ClientDocument"("clientId");
