-- Omni-Channel Outreach, Phase 3 (user go 2026-10-14): campaigns, the send queue (one row per person per campaign), funnel events,
-- webhook receipts and the worker lease.
-- ADDITIVE ONLY: five new tables, nothing existing is altered (outreach_core is NOT touched). DateTime columns hold epoch milliseconds.
-- The application reads and writes these tables with plain SQL (src/outreach/*) and feature-detects them: until this migration is applied
-- the Campaigns tab says "being set up" and nothing else changes.
-- Undo: rollback.sql (DROP TABLE of the tables below).

-- a campaign: what is promoted, to whom, by which way, with which words, when
CREATE TABLE "OutreachCampaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,                 -- short opaque public code used as `cid` in links (never the row id)
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'job_promotion',
    "requirementId" TEXT,                 -- the job (job promotions only; internal campaigns have none)
    "segmentIds" TEXT,                    -- JSON array of OutreachSegment ids
    "channel" TEXT NOT NULL DEFAULT 'email',
    "templateId" TEXT,
    "templateSnapshot" TEXT,              -- JSON { name, subject, body } as it was when the send was pressed
    "status" TEXT NOT NULL DEFAULT 'draft',
    "mode" TEXT,                          -- 'rehearsal' (test mode: nothing is handed to a mail server) | 'live'; fixed when the send is pressed
    "scheduledAt" DATETIME,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "suppressDays" INTEGER,               -- the "same job again" window (days) as it was when the send was pressed
    "planSummary" TEXT,                   -- JSON counts at the moment of sending (ids and counts only)
    "testSentAt" DATETIME,
    "lastError" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL DEFAULT 0,
    CHECK ("type" IN ('job_promotion','internal')),
    CHECK ("channel" IN ('email','whatsapp','sms')),
    CHECK ("status" IN ('draft','preparing','scheduled','running','paused','done','stopped')),
    CHECK ("mode" IS NULL OR "mode" IN ('rehearsal','live')),
    -- a job promotion must name its job; an internal campaign never does
    CHECK (("type" = 'job_promotion' AND "requirementId" IS NOT NULL) OR ("type" = 'internal' AND "requirementId" IS NULL))
);
CREATE UNIQUE INDEX "OutreachCampaign_code_key" ON "OutreachCampaign"("code");
CREATE INDEX "OutreachCampaign_status_idx" ON "OutreachCampaign"("status", "scheduledAt");
CREATE INDEX "OutreachCampaign_req_idx" ON "OutreachCampaign"("requirementId");

-- one row per person per campaign: the message AND the queue entry
CREATE TABLE "OutreachMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "campaignId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "requirementId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "reason" TEXT,                        -- why it was skipped / failed (a code)
    "token" TEXT,                         -- the tracked link token (NULL for internal campaigns and skipped rows)
    "idempotencyKey" TEXT NOT NULL,       -- campaign:contact:channel; one send per key, ever
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRunAt" DATETIME NOT NULL DEFAULT 0,
    "lockedBy" TEXT,
    "lockedAt" DATETIME,
    "sendStartedAt" DATETIME,             -- set just before the mail server is called; a row stuck 'sending' WITHOUT it never reached the server
    "providerRef" TEXT,
    "error" TEXT,
    "queuedAt" DATETIME NOT NULL DEFAULT 0,
    "sentAt" DATETIME,
    "deliveredAt" DATETIME,
    "firstClickAt" DATETIME,
    "failedAt" DATETIME,
    CHECK ("status" IN ('queued','sending','sent','test_captured','delivered','failed','bounced','complained','skipped','cancelled','unknown')),
    UNIQUE ("campaignId", "contactId"),   -- one message per person per campaign, by construction
    FOREIGN KEY ("campaignId") REFERENCES "OutreachCampaign"("id")
);
CREATE UNIQUE INDEX "OutreachMessage_key_unique" ON "OutreachMessage"("idempotencyKey");
CREATE UNIQUE INDEX "OutreachMessage_token_key" ON "OutreachMessage"("token") WHERE "token" IS NOT NULL;
CREATE INDEX "OutreachMessage_run_idx" ON "OutreachMessage"("status", "nextRunAt");
CREATE INDEX "OutreachMessage_campaign_idx" ON "OutreachMessage"("campaignId", "status");
CREATE INDEX "OutreachMessage_providerRef_idx" ON "OutreachMessage"("providerRef");
CREATE INDEX "OutreachMessage_contact_req_idx" ON "OutreachMessage"("contactId", "requirementId", "sentAt");
CREATE INDEX "OutreachMessage_lock_idx" ON "OutreachMessage"("lockedAt");

-- funnel events: PII-free (ids, a type and a small detail; never a name, phone or email)
CREATE TABLE "OutreachEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventKey" TEXT NOT NULL,             -- idempotency key (type:messageId): the same event twice is one row
    "type" TEXT NOT NULL,                 -- sent | delivered | clicked | failed | skipped now; applied / ai_interview_* / qualified come with Phase 4
    "contactId" TEXT,
    "campaignId" TEXT,
    "messageId" TEXT,
    "requirementId" TEXT,
    "channel" TEXT,
    "applicationId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'outreach',
    "occurredAt" DATETIME NOT NULL DEFAULT 0,
    "receivedAt" DATETIME NOT NULL DEFAULT 0,
    "detail" TEXT
);
CREATE UNIQUE INDEX "OutreachEvent_key" ON "OutreachEvent"("eventKey");
CREATE INDEX "OutreachEvent_funnel_idx" ON "OutreachEvent"("campaignId", "type");
CREATE INDEX "OutreachEvent_contact_idx" ON "OutreachEvent"("contactId", "type", "requirementId");

-- provider webhooks: the same provider event twice changes nothing
CREATE TABLE "OutreachWebhookReceipt" (
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "receivedAt" DATETIME NOT NULL DEFAULT 0,
    PRIMARY KEY ("provider", "providerEventId")
);

-- the worker lease: only one sending loop runs at a time, across processes
CREATE TABLE "OutreachRunnerLease" (
    "name" TEXT NOT NULL PRIMARY KEY,
    "holder" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL DEFAULT 0
);
