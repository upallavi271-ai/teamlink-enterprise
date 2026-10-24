// ---------------------------------------------------------------------------
// OMNI-CHANNEL INTEGRATION TABLES (2026-10-17): the shared template library, app campaigns, the durable provider-event inbox and the reply links (six tables).
// Self-provisioned (CREATE TABLE IF NOT EXISTS, run on first use), exactly like outreach/v3schema.js. The same SQL is the hand-written migration
// prisma/migrations/20261017200000_omni_integration/migration.sql (tables only, additive; nothing existing is altered).
//   OmniTemplateMeta     one row per shared template that somebody changed the library details of: which apps may use it (scopes), department, approval
//   OmniTemplateVersion  the words of a template every time it was saved (version history) - for the stores that keep no history of their own
//   OmniProviderEvent    EVERY inbound provider event (WhatsApp / SMS / email reply) is written here FIRST. UNIQUE(provider, providerEventId) makes a
//                        replayed event a no-op (idempotency); outcome + attempts + lastError + nextRetryAt are the durable processing state (Sync health)
//   OmniReplyLink        a reply matched to a source record: person, which apps show it, application / job, campaign reference
//   OmniAppCampaign      a campaign made from an app screen (ATS candidates, Job Portal applicants, HRMS employees, Accounts invoice contacts)
//   OmniAppCampaignItem  one row per person and channel of such a campaign (delivery tracking)
// DateTime columns hold epoch milliseconds in DATETIME columns (the same convention as every other Omni table).
// ---------------------------------------------------------------------------
const prisma = require('../../db');

const q = (sql, ...p) => prisma.$queryRawUnsafe(sql, ...p);
const run = (sql, ...p) => prisma.$executeRawUnsafe(sql, ...p);

const DDL = [
  `CREATE TABLE IF NOT EXISTS "OmniTemplateMeta" ("templateKey" TEXT NOT NULL PRIMARY KEY, "scopes" TEXT, "department" TEXT, "approval" TEXT NOT NULL DEFAULT 'approved', "approvalNote" TEXT,
    "requestedById" TEXT, "requestedByName" TEXT, "requestedAt" DATETIME, "decidedById" TEXT, "decidedByName" TEXT, "decidedAt" DATETIME, "updatedAt" DATETIME NOT NULL DEFAULT 0, "updatedByName" TEXT)`,
  `CREATE TABLE IF NOT EXISTS "OmniTemplateVersion" ("id" TEXT NOT NULL PRIMARY KEY, "templateKey" TEXT NOT NULL, "version" INTEGER NOT NULL, "name" TEXT, "channel" TEXT, "subject" TEXT, "body" TEXT,
    "scopes" TEXT, "department" TEXT, "approval" TEXT, "changeNote" TEXT, "byId" TEXT, "byName" TEXT, "at" DATETIME NOT NULL DEFAULT 0)`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "OmniTemplateVersion_key" ON "OmniTemplateVersion"("templateKey", "version")',
  `CREATE TABLE IF NOT EXISTS "OmniProviderEvent" ("id" TEXT NOT NULL PRIMARY KEY, "provider" TEXT NOT NULL, "providerEventId" TEXT NOT NULL, "kind" TEXT NOT NULL DEFAULT 'inbound', "channel" TEXT,
    "fromKey" TEXT, "fromName" TEXT, "bodyText" TEXT, "outcome" TEXT NOT NULL DEFAULT 'received', "reason" TEXT, "attempts" INTEGER NOT NULL DEFAULT 0, "duplicates" INTEGER NOT NULL DEFAULT 0, "lastError" TEXT,
    "nextRetryAt" DATETIME, "receivedAt" DATETIME NOT NULL DEFAULT 0, "processedAt" DATETIME, "matchType" TEXT, "matchId" TEXT, "apps" TEXT, "campaignRef" TEXT, "visibleDepts" TEXT, "possible" TEXT,
    "resolvedAt" DATETIME, "resolvedById" TEXT, "resolvedByName" TEXT, "resolution" TEXT, "payload" TEXT)`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "OmniProviderEvent_event" ON "OmniProviderEvent"("provider", "providerEventId")',
  'CREATE INDEX IF NOT EXISTS "OmniProviderEvent_outcome" ON "OmniProviderEvent"("outcome", "receivedAt")',
  `CREATE TABLE IF NOT EXISTS "OmniReplyLink" ("id" TEXT NOT NULL PRIMARY KEY, "eventId" TEXT NOT NULL, "personType" TEXT NOT NULL, "personId" TEXT NOT NULL, "personName" TEXT, "apps" TEXT, "applicationId" TEXT,
    "requirementId" TEXT, "campaignKind" TEXT, "campaignRef" TEXT, "campaignName" TEXT, "channel" TEXT, "snippet" TEXT, "createdAt" DATETIME NOT NULL DEFAULT 0)`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "OmniReplyLink_one" ON "OmniReplyLink"("eventId", "personType", "personId")',
  'CREATE INDEX IF NOT EXISTS "OmniReplyLink_person" ON "OmniReplyLink"("personType", "personId", "createdAt")',
  `CREATE TABLE IF NOT EXISTS "OmniAppCampaign" ("id" TEXT NOT NULL PRIMARY KEY, "app" TEXT NOT NULL, "name" TEXT NOT NULL, "audience" TEXT NOT NULL, "channels" TEXT NOT NULL, "purposeKey" TEXT, "templateKey" TEXT,
    "templateName" TEXT, "language" TEXT, "request" TEXT, "refs" TEXT, "peopleCount" INTEGER NOT NULL DEFAULT 0, "department" TEXT, "status" TEXT NOT NULL DEFAULT 'not_sent', "approval" TEXT, "approvalNote" TEXT,
    "approvalById" TEXT, "approvalByName" TEXT, "approvalAt" DATETIME, "scheduledAt" DATETIME, "startedAt" DATETIME, "finishedAt" DATETIME, "mode" TEXT, "jobId" TEXT, "totals" TEXT, "createdById" TEXT,
    "createdByName" TEXT, "createdAt" DATETIME NOT NULL DEFAULT 0, "updatedAt" DATETIME NOT NULL DEFAULT 0, "meta" TEXT)`,
  'CREATE INDEX IF NOT EXISTS "OmniAppCampaign_user" ON "OmniAppCampaign"("createdById", "createdAt")',
  'CREATE INDEX IF NOT EXISTS "OmniAppCampaign_status" ON "OmniAppCampaign"("status", "scheduledAt")',
  `CREATE TABLE IF NOT EXISTS "OmniAppCampaignItem" ("id" TEXT NOT NULL PRIMARY KEY, "campaignId" TEXT NOT NULL, "entityId" TEXT NOT NULL, "name" TEXT, "channel" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'queued',
    "reason" TEXT, "providerRef" TEXT, "attempts" INTEGER NOT NULL DEFAULT 0, "sentAt" DATETIME, "deliveredAt" DATETIME, "failedAt" DATETIME, "repliedAt" DATETIME, "applicationId" TEXT)`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "OmniAppCampaignItem_one" ON "OmniAppCampaignItem"("campaignId", "entityId", "channel")',
];

let okAt = 0; let ensuring = null;
async function ensure() {
  if (okAt && Date.now() - okAt < 600000) return true;
  if (!ensuring) {
    ensuring = (async () => {
      try {
        for (const sql of DDL) await run(sql); // eslint-disable-line no-await-in-loop
        okAt = Date.now();
        return true;
      } catch (e) { console.error('[omni-integration] schema:', e.message); return false; } // eslint-disable-line no-console
      finally { ensuring = null; }
    })();
  }
  return ensuring;
}
function reset() { okAt = 0; }

module.exports = { ensure, reset, DDL, q, run };
