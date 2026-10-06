-- 20261006100000_candidate_consent_referrals_utm  (ATS-100 B5 + B6, 2026-10-06)
-- ADDITIVE ONLY: ALTER TABLE ... ADD COLUMN (nullable, or NOT NULL with a
-- default) on Candidate / Application / CandidateDocument, plus 5 NEW tables.
-- No existing row's value changes: every existing candidate keeps
-- consentStatus NULL (= "Not recorded"), doNotContact false.

-- B5.1 consent + B5.4 referred by + B6.2 campus, on the candidate
ALTER TABLE "Candidate" ADD COLUMN "consentStatus" TEXT;
ALTER TABLE "Candidate" ADD COLUMN "consentPurposes" TEXT;
ALTER TABLE "Candidate" ADD COLUMN "consentAt" DATETIME;
ALTER TABLE "Candidate" ADD COLUMN "consentSource" TEXT;
ALTER TABLE "Candidate" ADD COLUMN "consentProof" TEXT;
ALTER TABLE "Candidate" ADD COLUMN "consentWithdrawnAt" DATETIME;
ALTER TABLE "Candidate" ADD COLUMN "consentByName" TEXT;
ALTER TABLE "Candidate" ADD COLUMN "doNotContact" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Candidate" ADD COLUMN "referredByEmployeeId" TEXT;
ALTER TABLE "Candidate" ADD COLUMN "referredByName" TEXT;
ALTER TABLE "Candidate" ADD COLUMN "campusDriveId" TEXT;
CREATE INDEX "Candidate_campusDriveId_idx" ON "Candidate"("campusDriveId");

-- B6.3 UTM + B5.4 referred by + B6.1 referral + B6.2 campus, on the application
ALTER TABLE "Application" ADD COLUMN "utmSource" TEXT;
ALTER TABLE "Application" ADD COLUMN "utmMedium" TEXT;
ALTER TABLE "Application" ADD COLUMN "utmCampaign" TEXT;
ALTER TABLE "Application" ADD COLUMN "utmContent" TEXT;
ALTER TABLE "Application" ADD COLUMN "referralId" TEXT;
ALTER TABLE "Application" ADD COLUMN "referredByEmployeeId" TEXT;
ALTER TABLE "Application" ADD COLUMN "referredByName" TEXT;
ALTER TABLE "Application" ADD COLUMN "campusDriveId" TEXT;
CREATE INDEX "Application_utmCampaign_idx" ON "Application"("utmCampaign");
CREATE INDEX "Application_referralId_idx" ON "Application"("referralId");
CREATE INDEX "Application_campusDriveId_idx" ON "Application"("campusDriveId");

-- B5.3 staff Documents tab: a real file (old name-only rows keep NULLs)
ALTER TABLE "CandidateDocument" ADD COLUMN "file" TEXT;
ALTER TABLE "CandidateDocument" ADD COLUMN "fileName" TEXT;
ALTER TABLE "CandidateDocument" ADD COLUMN "mime" TEXT;
ALTER TABLE "CandidateDocument" ADD COLUMN "size" INTEGER;
ALTER TABLE "CandidateDocument" ADD COLUMN "sha256" TEXT;
ALTER TABLE "CandidateDocument" ADD COLUMN "deletedAt" DATETIME;
ALTER TABLE "CandidateDocument" ADD COLUMN "deletedById" TEXT;
ALTER TABLE "CandidateDocument" ADD COLUMN "deletedByName" TEXT;
ALTER TABLE "CandidateDocument" ADD COLUMN "deleteReason" TEXT;

-- B5.2 certifications
CREATE TABLE "CandidateCertification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "candidateId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "issuer" TEXT,
    "issuedOn" TEXT,
    "expiresOn" TEXT,
    "credentialId" TEXT,
    "file" TEXT,
    "fileName" TEXT,
    "mime" TEXT,
    "size" INTEGER,
    "sha256" TEXT,
    "source" TEXT NOT NULL DEFAULT 'Manual',
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CandidateCertification_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "CandidateCertification_candidateId_idx" ON "CandidateCertification"("candidateId");

-- B6.1 employee referral programme
CREATE TABLE "ReferralCode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "employeeId" TEXT,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ReferralCode_code_key" ON "ReferralCode"("code");
CREATE UNIQUE INDEX "ReferralCode_userId_key" ON "ReferralCode"("userId");

CREATE TABLE "CandidateReferral" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "referrerUserId" TEXT,
    "referrerEmployeeId" TEXT,
    "referrerName" TEXT NOT NULL,
    "via" TEXT NOT NULL,
    "code" TEXT,
    "candidateId" TEXT NOT NULL,
    "applicationId" TEXT,
    "requirementId" TEXT,
    "note" TEXT,
    "bonusAmount" REAL,
    "bonusStatus" TEXT,
    "bonusNote" TEXT,
    "bonusProposedById" TEXT,
    "bonusProposedByName" TEXT,
    "bonusProposedAt" DATETIME,
    "bonusDecidedById" TEXT,
    "bonusDecidedByName" TEXT,
    "bonusDecidedAt" DATETIME,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "CandidateReferral_referrerUserId_idx" ON "CandidateReferral"("referrerUserId");
CREATE INDEX "CandidateReferral_candidateId_idx" ON "CandidateReferral"("candidateId");
CREATE INDEX "CandidateReferral_applicationId_idx" ON "CandidateReferral"("applicationId");

-- B6.2 campus drives
CREATE TABLE "CampusDrive" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "collegeName" TEXT NOT NULL,
    "driveDate" TEXT NOT NULL,
    "location" TEXT,
    "requirementId" TEXT,
    "department" TEXT,
    "cost" REAL,
    "note" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "CampusDrive_driveDate_idx" ON "CampusDrive"("driveDate");

-- B6.3 campaign cost (matched to Application.utmCampaign by a lower-case key)
CREATE TABLE "SourcingCampaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" TEXT,
    "medium" TEXT,
    "cost" REAL,
    "startDate" TEXT,
    "endDate" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "SourcingCampaign_key_key" ON "SourcingCampaign"("key");
