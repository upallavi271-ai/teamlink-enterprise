-- 20261006140000_partners (B7: agency / freelancer partners). ADDITIVE ONLY.
-- New nullable columns on Candidate / Application, five new tables, indexes.
-- No existing column changes, no rows rewritten. Rollback: rollback.sql.

-- Candidate: first-submitter ownership.
ALTER TABLE "Candidate" ADD COLUMN "ownerPartnerId" TEXT;
ALTER TABLE "Candidate" ADD COLUMN "ownerUntil" DATETIME;
ALTER TABLE "Candidate" ADD COLUMN "ownerSubmissionId" TEXT;
CREATE INDEX "Candidate_ownerPartnerId_idx" ON "Candidate"("ownerPartnerId");

-- Application: the partner submission it came from.
ALTER TABLE "Application" ADD COLUMN "partnerId" TEXT;
ALTER TABLE "Application" ADD COLUMN "partnerSubmissionId" TEXT;
CREATE INDEX "Application_partnerId_idx" ON "Application"("partnerId");

-- Partner master.
CREATE TABLE "Partner" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "code" TEXT,
  "type" TEXT NOT NULL DEFAULT 'Agency',
  "name" TEXT NOT NULL,
  "contactName" TEXT,
  "email" TEXT,
  "phone" TEXT,
  "gstin" TEXT,
  "pan" TEXT,
  "gstRegistered" BOOLEAN NOT NULL DEFAULT false,
  "tdsSection" TEXT DEFAULT '194J',
  "tdsPercent" REAL NOT NULL DEFAULT 10,
  "feeType" TEXT NOT NULL DEFAULT 'PERCENT',
  "feePercent" REAL,
  "feeFixed" REAL,
  "paymentTermsDays" INTEGER NOT NULL DEFAULT 30,
  "guaranteeDays" INTEGER NOT NULL DEFAULT 90,
  "ownershipDays" INTEGER NOT NULL DEFAULT 365,
  "departments" TEXT,
  "specialisations" TEXT,
  "showClientName" BOOLEAN NOT NULL DEFAULT false,
  "agreementFile" TEXT,
  "agreementName" TEXT,
  "agreementMime" TEXT,
  "agreementSize" INTEGER,
  "agreementFrom" TEXT,
  "agreementTo" TEXT,
  "status" TEXT NOT NULL DEFAULT 'Active',
  "notes" TEXT,
  "createdById" TEXT,
  "createdByName" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "Partner_code_key" ON "Partner"("code");
CREATE INDEX "Partner_status_idx" ON "Partner"("status");

-- Partner logins.
CREATE TABLE "PartnerUser" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "partnerId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Active',
  "mustChangePassword" BOOLEAN NOT NULL DEFAULT true,
  "passwordChangedAt" DATETIME,
  "lastLoginAt" DATETIME,
  "lastLoginIp" TEXT,
  "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
  "lockedUntil" DATETIME,
  "tempPasswordExpiresAt" DATETIME,
  "deletedAt" DATETIME,
  "passwordHistory" TEXT NOT NULL DEFAULT '[]',
  "createdById" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "PartnerUser_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PartnerUser_email_key" ON "PartnerUser"("email");
CREATE INDEX "PartnerUser_partnerId_idx" ON "PartnerUser"("partnerId");

-- Partner sessions (server side; the token's jti).
CREATE TABLE "PartnerSession" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "partnerUserId" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" DATETIME NOT NULL,
  "revokedAt" DATETIME,
  "revokedReason" TEXT,
  "ip" TEXT,
  "userAgent" TEXT,
  CONSTRAINT "PartnerSession_partnerUserId_fkey" FOREIGN KEY ("partnerUserId") REFERENCES "PartnerUser" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "PartnerSession_partnerUserId_idx" ON "PartnerSession"("partnerUserId");

-- Which partner sees which job.
CREATE TABLE "PartnerJobShare" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "partnerId" TEXT NOT NULL,
  "requirementId" TEXT NOT NULL,
  "sharedById" TEXT,
  "sharedByName" TEXT,
  "sharedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" DATETIME,
  "revokedByName" TEXT,
  "showClientName" BOOLEAN NOT NULL DEFAULT false,
  "note" TEXT,
  CONSTRAINT "PartnerJobShare_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PartnerJobShare_partnerId_requirementId_key" ON "PartnerJobShare"("partnerId", "requirementId");
CREATE INDEX "PartnerJobShare_requirementId_idx" ON "PartnerJobShare"("requirementId");

-- Submissions.
CREATE TABLE "PartnerSubmission" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "code" TEXT,
  "partnerId" TEXT NOT NULL,
  "partnerUserId" TEXT NOT NULL,
  "requirementId" TEXT NOT NULL,
  "candidateId" TEXT,
  "applicationId" TEXT,
  "name" TEXT NOT NULL,
  "phone" TEXT,
  "email" TEXT,
  "currentCtc" REAL,
  "expectedCtc" REAL,
  "noticePeriod" TEXT,
  "location" TEXT,
  "skills" TEXT,
  "note" TEXT,
  "resumeFile" TEXT,
  "resumeName" TEXT,
  "resumeMime" TEXT,
  "resumeSize" INTEGER,
  "consentTicked" BOOLEAN NOT NULL DEFAULT false,
  "status" TEXT NOT NULL DEFAULT 'Submitted',
  "duplicateReason" TEXT,
  "duplicateOfCandidateId" TEXT,
  "statusAt" DATETIME,
  "statusNote" TEXT,
  "submittedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ip" TEXT,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "PartnerSubmission_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PartnerSubmission_partnerUserId_fkey" FOREIGN KEY ("partnerUserId") REFERENCES "PartnerUser" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PartnerSubmission_code_key" ON "PartnerSubmission"("code");
CREATE UNIQUE INDEX "PartnerSubmission_applicationId_key" ON "PartnerSubmission"("applicationId");
CREATE INDEX "PartnerSubmission_partnerId_idx" ON "PartnerSubmission"("partnerId");
CREATE INDEX "PartnerSubmission_requirementId_idx" ON "PartnerSubmission"("requirementId");
CREATE INDEX "PartnerSubmission_candidateId_idx" ON "PartnerSubmission"("candidateId");
CREATE INDEX "PartnerSubmission_status_idx" ON "PartnerSubmission"("status");

-- Payouts.
CREATE TABLE "PartnerPayout" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "number" TEXT,
  "kind" TEXT NOT NULL DEFAULT 'PAYOUT',
  "parentPayoutId" TEXT,
  "partnerId" TEXT NOT NULL,
  "submissionId" TEXT,
  "applicationId" TEXT NOT NULL,
  "invoiceId" TEXT,
  "candidateName" TEXT,
  "requirementTitle" TEXT,
  "clientName" TEXT,
  "joinedOn" TEXT,
  "ctc" REAL,
  "feeType" TEXT,
  "feePercent" REAL,
  "feeFixed" REAL,
  "fee" REAL NOT NULL,
  "gstPercent" REAL NOT NULL DEFAULT 0,
  "gst" REAL NOT NULL DEFAULT 0,
  "tdsSection" TEXT,
  "tdsPercent" REAL NOT NULL DEFAULT 0,
  "tds" REAL NOT NULL DEFAULT 0,
  "net" REAL NOT NULL,
  "holdUntil" TEXT,
  "status" TEXT NOT NULL DEFAULT 'Draft',
  "preparedById" TEXT,
  "preparedByName" TEXT,
  "approvedById" TEXT,
  "approvedByName" TEXT,
  "approvedAt" DATETIME,
  "paidOn" TEXT,
  "paidRef" TEXT,
  "paidMode" TEXT,
  "paidById" TEXT,
  "paidByName" TEXT,
  "paidAt" DATETIME,
  "bankTxnId" TEXT,
  "expenseId" TEXT,
  "cancelledAt" DATETIME,
  "cancelledByName" TEXT,
  "cancelReason" TEXT,
  "partnerInvoiceNumber" TEXT,
  "partnerInvoiceDate" TEXT,
  "partnerInvoiceFile" TEXT,
  "partnerInvoiceName" TEXT,
  "partnerInvoiceMime" TEXT,
  "partnerInvoiceSize" INTEGER,
  "notes" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "PartnerPayout_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PartnerPayout_number_key" ON "PartnerPayout"("number");
CREATE UNIQUE INDEX "PartnerPayout_expenseId_key" ON "PartnerPayout"("expenseId");
CREATE INDEX "PartnerPayout_partnerId_idx" ON "PartnerPayout"("partnerId");
CREATE INDEX "PartnerPayout_applicationId_idx" ON "PartnerPayout"("applicationId");
CREATE INDEX "PartnerPayout_invoiceId_idx" ON "PartnerPayout"("invoiceId");
CREATE INDEX "PartnerPayout_status_idx" ON "PartnerPayout"("status");
