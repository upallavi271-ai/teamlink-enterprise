-- Omni-Channel Outreach, Phase 1 + 2 (user, 2026-10-14): contacts, segments, imports, consent / opt-out ledger, suppression, templates, send log.
-- ADDITIVE ONLY: nine new tables, nothing existing is altered. Campaign / queue / event tables follow in a later migration (Phase 3).
-- DateTime columns hold epoch milliseconds (the same as every Prisma SQLite DateTime). The application reads and writes these tables with
-- plain SQL (src/outreach/*), so it works with or without `prisma generate`; until this migration is applied the Omni-Channel screens say
-- "being set up" and nothing else changes.
-- Undo: rollback.sql (DROP TABLE of the tables below).
CREATE TABLE "OutreachContact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contactType" TEXT NOT NULL DEFAULT 'candidate_lead',
    "name" TEXT,
    "phoneE164" TEXT,
    "email" TEXT,
    "phoneKey" TEXT,
    "emailKey" TEXT,
    "company" TEXT,
    "city" TEXT,
    "skills" TEXT,
    "experience" TEXT,
    "source" TEXT,
    "importId" TEXT,
    "ownerUserId" TEXT,
    "department" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "consentSource" TEXT,
    "consentAt" DATETIME,
    "unsubscribedAt" DATETIME,
    "linkedApplicantId" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL DEFAULT 0,
    "deletedAt" DATETIME,
    CHECK ("contactType" IN ('candidate_lead','internal')),
    CHECK ("status" IN ('active','deleted'))
);
CREATE INDEX "OutreachContact_phoneKey_idx" ON "OutreachContact"("phoneKey");
CREATE INDEX "OutreachContact_emailKey_idx" ON "OutreachContact"("emailKey");
CREATE INDEX "OutreachContact_type_status_idx" ON "OutreachContact"("contactType","status");
CREATE INDEX "OutreachContact_import_idx" ON "OutreachContact"("importId");
-- one live contact per phone and per email: duplicate detection is backed by the database, not only by the import screen
CREATE UNIQUE INDEX "OutreachContact_phone_live" ON "OutreachContact"("phoneKey") WHERE "phoneKey" IS NOT NULL AND "status" = 'active';
CREATE UNIQUE INDEX "OutreachContact_email_live" ON "OutreachContact"("emailKey") WHERE "emailKey" IS NOT NULL AND "status" = 'active';

CREATE TABLE "OutreachContactTag" (
    "contactId" TEXT NOT NULL,
    "industry" TEXT NOT NULL,
    PRIMARY KEY ("contactId","industry"),
    FOREIGN KEY ("contactId") REFERENCES "OutreachContact"("id") ON DELETE CASCADE
);
CREATE INDEX "OutreachContactTag_industry_idx" ON "OutreachContactTag"("industry");

CREATE TABLE "OutreachContactChannel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contactId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "address" TEXT,
    "optIn" TEXT NOT NULL DEFAULT 'unknown',
    "optInAt" DATETIME,
    "optInSource" TEXT,
    "optInEvidence" TEXT,
    "optOutAt" DATETIME,
    "optOutReason" TEXT,
    "health" TEXT NOT NULL DEFAULT 'ok',
    "lastBounceAt" DATETIME,
    CHECK ("channel" IN ('email','whatsapp','sms')),
    CHECK ("optIn" IN ('unknown','opted_in','opted_out')),
    UNIQUE ("contactId","channel"),
    FOREIGN KEY ("contactId") REFERENCES "OutreachContact"("id") ON DELETE CASCADE
);

-- append-only consent / opt-out history: never updated, never removed (it holds a hash, not the address)
CREATE TABLE "OutreachConsentEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contactId" TEXT,
    "addressHash" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "source" TEXT,
    "evidence" TEXT,
    "textVersion" TEXT,
    "byUserId" TEXT,
    "at" DATETIME NOT NULL DEFAULT 0
);
CREATE INDEX "OutreachConsentEvent_hash_idx" ON "OutreachConsentEvent"("addressHash","channel");
CREATE INDEX "OutreachConsentEvent_contact_idx" ON "OutreachConsentEvent"("contactId");

-- do-not-contact registry by HASH (sha256 of the normalised address + a server pepper): survives erasure of the contact
CREATE TABLE "OutreachSuppression" (
    "addressHash" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "at" DATETIME NOT NULL DEFAULT 0,
    "source" TEXT,
    PRIMARY KEY ("addressHash","channel")
);

CREATE TABLE "OutreachImport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fileName" TEXT,
    "sha256" TEXT,
    "mapping" TEXT,
    "contactType" TEXT NOT NULL DEFAULT 'candidate_lead',
    "dupMode" TEXT,
    "basis" TEXT,
    "basisConfirmedById" TEXT,
    "basisConfirmedAt" DATETIME,
    "source" TEXT,
    "industries" TEXT,
    "total" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "duplicates" INTEGER NOT NULL DEFAULT 0,
    "invalid" INTEGER NOT NULL DEFAULT 0,
    "optedOut" INTEGER NOT NULL DEFAULT 0,
    "undoLog" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT 0,
    "undoneAt" DATETIME,
    "undoneById" TEXT,
    CHECK ("contactType" IN ('candidate_lead','internal'))
);

CREATE TABLE "OutreachSegment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "industry" TEXT,
    "filterRules" TEXT NOT NULL DEFAULT '{}',
    "contactType" TEXT NOT NULL DEFAULT 'candidate_lead',
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL DEFAULT 0,
    "deletedAt" DATETIME,
    CHECK ("contactType" IN ('candidate_lead','internal'))
);

CREATE TABLE "OutreachTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "audience" TEXT NOT NULL DEFAULT 'candidate_lead',
    "promotional" INTEGER NOT NULL DEFAULT 1,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "waTemplateName" TEXT,
    "waLanguage" TEXT,
    "waApprovalStatus" TEXT,
    "dltTemplateId" TEXT,
    "senderId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL DEFAULT 0,
    CHECK ("channel" IN ('email','whatsapp','sms')),
    CHECK ("audience" IN ('candidate_lead','internal'))
);

-- one row per message the channel adapters handled (sent, test-captured, refused): PII-safe (masked address only)
CREATE TABLE "OutreachSendLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "channel" TEXT NOT NULL,
    "contactId" TEXT,
    "toMasked" TEXT,
    "status" TEXT NOT NULL,
    "mode" TEXT,
    "reason" TEXT,
    "providerId" TEXT,
    "subject" TEXT,
    "headers" TEXT,
    "at" DATETIME NOT NULL DEFAULT 0
);
CREATE INDEX "OutreachSendLog_day_idx" ON "OutreachSendLog"("channel","status","at");
