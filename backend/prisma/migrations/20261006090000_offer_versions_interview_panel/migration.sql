-- B3 + B4 (2026-10-06): offer letter versions + e-sign link, interview panel.
-- ADDITIVE ONLY: two new tables. No column added to an existing table
-- (the Application back-references are virtual Prisma relations).
-- Folder name: 20261006090000_offer_versions_interview_panel

CREATE TABLE "OfferVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "applicationId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Sent',
    "letterText" TEXT NOT NULL,
    "offeredCtc" REAL,
    "offerDate" TEXT,
    "joiningDate" TEXT,
    "expiresAt" DATETIME,
    "tokenHash" TEXT,
    "linkCreatedAt" DATETIME,
    "linkStoppedAt" DATETIME,
    "viewedAt" DATETIME,
    "otpHash" TEXT,
    "otpExpiresAt" DATETIME,
    "otpAttempts" INTEGER NOT NULL DEFAULT 0,
    "otpSends" INTEGER NOT NULL DEFAULT 0,
    "otpSentTo" TEXT,
    "otpVerifiedAt" DATETIME,
    "signMethod" TEXT,
    "signFile" TEXT,
    "signedName" TEXT,
    "signedAt" DATETIME,
    "signedIp" TEXT,
    "signedUserAgent" TEXT,
    "declinedAt" DATETIME,
    "declineReason" TEXT,
    "expiredAt" DATETIME,
    "pdfFile" TEXT,
    "pdfSha256" TEXT,
    "esignProvider" TEXT,
    "esignTxnId" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OfferVersion_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "OfferVersion_tokenHash_key" ON "OfferVersion"("tokenHash");
CREATE UNIQUE INDEX "OfferVersion_applicationId_version_key" ON "OfferVersion"("applicationId", "version");
CREATE INDEX "OfferVersion_status_expiresAt_idx" ON "OfferVersion"("status", "expiresAt");

CREATE TABLE "InterviewPanelist" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "applicationId" TEXT NOT NULL,
    "round" INTEGER NOT NULL DEFAULT 1,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "technical" INTEGER,
    "communication" INTEGER,
    "experience" INTEGER,
    "roleFit" INTEGER,
    "overall" TEXT,
    "recommendation" TEXT,
    "feedbackAt" DATETIME,
    "feedbackById" TEXT,
    "feedbackByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "InterviewPanelist_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "InterviewPanelist_applicationId_round_idx" ON "InterviewPanelist"("applicationId", "round");
CREATE INDEX "InterviewPanelist_userId_idx" ON "InterviewPanelist"("userId");
