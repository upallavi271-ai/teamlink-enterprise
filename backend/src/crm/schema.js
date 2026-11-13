// ---------------------------------------------------------------------------
// THE SALES CRM - SELF-PROVISIONING TABLES (founder 2026-11-02: "oka sales dhani kosam, crm lo em em vundalo ... take the
// actual official crm"; then "3 to 4 modules chaalu ... ahh 3 to 4 modules lo ney, motham crm cover ayyeylaaga chudu").
//
// Same pattern as calling/schema.js: raw SQL tables with no Prisma model (no `prisma generate`, no migrate), created with
// CREATE TABLE IF NOT EXISTS the first time anything needs them. ADDITIVE ONLY: nothing existing is altered. Every time
// column is TEXT (an ISO moment); a due date is YYYY-MM-DD (India date).
//
//   CrmLead      a company / person we may sell to, before it is qualified (New, Contacted, Qualified, Junk, Converted)
//   CrmAccount   a company we sell to (Prospect), or one that became a TeamLink client (Client, clientId = ATS Client.id)
//   CrmContact   a person at an account (decision maker, HR, influencer ...)
//   CrmDeal      one sales opportunity on the pipeline (stage, value, probability, expected close; Won / Lost + reason)
//   CrmActivity  a call, meeting, email, WhatsApp or note on a lead / account / deal (the timeline)
//   CrmTask      a follow-up with a due date (bell + email reminder to the owner the day it is due, once)
//   CrmTarget    a BDE's target for a month (won value, and optionally a number of deals) - set by the BDE TL / Admin
//   CrmProposal  a proposal (fee terms, positions) made from a deal: PDF, emailed to the client, Accepted / Declined
//   CrmTicket    a customer support ticket (priority, SLA due time, status, assignee) + CrmTicketComment (its thread)
//   CrmCampaign  an email / WhatsApp campaign to filtered leads or contacts + CrmCampaignRecipient (one row a person)
//   CrmOptOut    an email / phone that asked for no more campaign messages (unsubscribe link, or marked by hand)
// ---------------------------------------------------------------------------
const prisma = require('../db');

const owner = `"ownerId" TEXT, "ownerName" TEXT, "createdById" TEXT, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL`;

const DDL = [
  `CREATE TABLE IF NOT EXISTS "CrmLead" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "company" TEXT NOT NULL,
    "contactName" TEXT, "designation" TEXT, "phone" TEXT, "email" TEXT,
    "industry" TEXT, "city" TEXT, "source" TEXT,
    "status" TEXT NOT NULL DEFAULT 'New',
    "notes" TEXT,
    "accountId" TEXT, "contactId" TEXT, "dealId" TEXT, "convertedAt" TEXT,
    ${owner}
  )`,
  'CREATE INDEX IF NOT EXISTS "CrmLead_owner" ON "CrmLead"("ownerId", "status")',
  `CREATE TABLE IF NOT EXISTS "CrmAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "industry" TEXT, "city" TEXT, "website" TEXT, "phone" TEXT, "email" TEXT, "source" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'Prospect',
    "clientId" TEXT,
    "notes" TEXT,
    ${owner}
  )`,
  'CREATE INDEX IF NOT EXISTS "CrmAccount_owner" ON "CrmAccount"("ownerId")',
  `CREATE TABLE IF NOT EXISTS "CrmContact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT,
    "name" TEXT NOT NULL,
    "designation" TEXT, "role" TEXT, "phone" TEXT, "email" TEXT, "notes" TEXT,
    ${owner}
  )`,
  'CREATE INDEX IF NOT EXISTS "CrmContact_account" ON "CrmContact"("accountId")',
  `CREATE TABLE IF NOT EXISTS "CrmDeal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "accountId" TEXT, "contactId" TEXT, "leadId" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'Prospecting',
    "openings" INTEGER, "avgCtc" REAL, "feePercent" REAL, "value" REAL NOT NULL DEFAULT 0,
    "probability" INTEGER NOT NULL DEFAULT 10,
    "expectedClose" TEXT,
    "lostReason" TEXT, "wonAt" TEXT, "lostAt" TEXT,
    "clientId" TEXT,
    "notes" TEXT,
    ${owner}
  )`,
  'CREATE INDEX IF NOT EXISTS "CrmDeal_owner" ON "CrmDeal"("ownerId", "stage")',
  'CREATE INDEX IF NOT EXISTS "CrmDeal_account" ON "CrmDeal"("accountId")',
  `CREATE TABLE IF NOT EXISTS "CrmActivity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "subject" TEXT, "note" TEXT,
    "at" TEXT NOT NULL,
    "leadId" TEXT, "accountId" TEXT, "dealId" TEXT, "contactId" TEXT,
    "byId" TEXT, "byName" TEXT,
    "createdAt" TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS "CrmActivity_lead" ON "CrmActivity"("leadId")',
  'CREATE INDEX IF NOT EXISTS "CrmActivity_account" ON "CrmActivity"("accountId")',
  'CREATE INDEX IF NOT EXISTS "CrmActivity_deal" ON "CrmActivity"("dealId")',
  `CREATE TABLE IF NOT EXISTS "CrmTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "dueDate" TEXT NOT NULL, "dueTime" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Open',
    "leadId" TEXT, "accountId" TEXT, "dealId" TEXT,
    "doneAt" TEXT, "doneNote" TEXT, "remindedOn" TEXT,
    ${owner}
  )`,
  'CREATE INDEX IF NOT EXISTS "CrmTask_owner" ON "CrmTask"("ownerId", "status", "dueDate")',
  // (2026-11-02, the full CRM) monthly targets per BDE, and proposals sent from a deal
  `CREATE TABLE IF NOT EXISTS "CrmTarget" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL, "ownerName" TEXT,
    "month" TEXT NOT NULL,
    "amount" REAL NOT NULL DEFAULT 0, "deals" INTEGER,
    "setById" TEXT, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "CrmTarget_owner_month" ON "CrmTarget"("ownerId", "month")',
  `CREATE TABLE IF NOT EXISTS "CrmProposal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "number" TEXT NOT NULL,
    "dealId" TEXT NOT NULL, "accountId" TEXT,
    "dataJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "sentAt" TEXT, "sentTo" TEXT, "decidedAt" TEXT,
    "createdById" TEXT, "createdByName" TEXT, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS "CrmProposal_deal" ON "CrmProposal"("dealId")',
  // (2026-11-02, Campaigns / Customer Support from the reference) support tickets with their thread; campaigns with their
  // recipients; people who asked for no more campaign messages
  `CREATE TABLE IF NOT EXISTS "CrmTicket" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "number" TEXT NOT NULL,
    "subject" TEXT NOT NULL, "description" TEXT,
    "accountId" TEXT, "contactId" TEXT,
    "category" TEXT, "channel" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'Medium',
    "status" TEXT NOT NULL DEFAULT 'Open',
    "dueAt" TEXT, "firstReplyAt" TEXT, "resolvedAt" TEXT, "closedAt" TEXT,
    ${owner}
  )`,
  'CREATE INDEX IF NOT EXISTS "CrmTicket_status" ON "CrmTicket"("status", "dueAt")',
  'CREATE INDEX IF NOT EXISTS "CrmTicket_account" ON "CrmTicket"("accountId")',
  `CREATE TABLE IF NOT EXISTS "CrmTicketComment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticketId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "internal" INTEGER NOT NULL DEFAULT 1,
    "emailedTo" TEXT,
    "byId" TEXT, "byName" TEXT, "createdAt" TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS "CrmTicketComment_ticket" ON "CrmTicketComment"("ticketId")',
  `CREATE TABLE IF NOT EXISTS "CrmCampaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "subject" TEXT, "body" TEXT NOT NULL,
    "waTemplate" TEXT, "waLanguage" TEXT,
    "audienceJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "total" INTEGER NOT NULL DEFAULT 0, "sent" INTEGER NOT NULL DEFAULT 0, "failed" INTEGER NOT NULL DEFAULT 0, "skipped" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TEXT, "finishedAt" TEXT,
    ${owner}
  )`,
  `CREATE TABLE IF NOT EXISTS "CrmCampaignRecipient" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "campaignId" TEXT NOT NULL,
    "kind" TEXT NOT NULL, "recordId" TEXT NOT NULL,
    "name" TEXT, "company" TEXT, "toAddr" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "error" TEXT, "sentAt" TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS "CrmCampaignRecipient_campaign" ON "CrmCampaignRecipient"("campaignId", "status")',
  `CREATE TABLE IF NOT EXISTS "CrmOptOut" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "reason" TEXT, "byId" TEXT, "createdAt" TEXT NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "CrmOptOut_value" ON "CrmOptOut"("value", "channel")',
  // one step of the automatic follow-through for one lead: waiting, sending, calling, sent, failed, skipped, stopped (crm/autopilot.js)
  `CREATE TABLE IF NOT EXISTS "CrmAutoStep" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recordId" TEXT NOT NULL, "stepId" TEXT NOT NULL,
    "dueAt" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'waiting',
    "result" TEXT, "callId" TEXT, "sentAt" TEXT, "createdAt" TEXT NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "CrmAutoStep_one" ON "CrmAutoStep"("recordId", "stepId")',
  'CREATE INDEX IF NOT EXISTS "CrmAutoStep_due" ON "CrmAutoStep"("status", "dueAt")',
];
// Columns added after the first release: added once, "duplicate column" is the normal answer afterwards.
const COLUMNS = [
  ['CrmLead', 'rating', 'TEXT'],
  ['CrmDeal', 'nextStep', 'TEXT'],
  // the lead pipeline, website leads and timed reminders (2026-11-06, crm/sales.js)
  ['CrmLead', 'stage', 'TEXT'], ['CrmLead', 'expectedValue', 'REAL'], ['CrmLead', 'lostReason', 'TEXT'],
  ['CrmLead', 'utmSource', 'TEXT'], ['CrmLead', 'utmMedium', 'TEXT'], ['CrmLead', 'utmCampaign', 'TEXT'], ['CrmLead', 'pageUrl', 'TEXT'],
  ['CrmTask', 'type', 'TEXT'], ['CrmTask', 'notifyApp', 'INTEGER'], ['CrmTask', 'notifyWhatsapp', 'INTEGER'], ['CrmTask', 'notifySms', 'INTEGER'], ['CrmTask', 'notifyLead', 'INTEGER'],
  ['CrmTask', 'remindBefore', 'INTEGER'], ['CrmTask', 'reminderSentAt', 'TEXT'], ['CrmTask', 'reminderNote', 'TEXT'],
  ['CrmLead', 'autoPaused', 'INTEGER'], // somebody pressed Stop on the automatic follow-through (crm/autopilot.js)
  // Deal commercials + discount approval (founder 2026-11-13, the 5-module CRM blueprint)
  ['CrmDeal', 'discountPercent', 'REAL'], ['CrmDeal', 'finalValue', 'REAL'],
  ['CrmDeal', 'approvalStatus', 'TEXT'], ['CrmDeal', 'approvalByName', 'TEXT'], ['CrmDeal', 'approvalAt', 'TEXT'], ['CrmDeal', 'approvalNote', 'TEXT'],
];
const INDEXES = [
  'CREATE INDEX IF NOT EXISTS "CrmLead_phone" ON "CrmLead"("phone")', 'CREATE INDEX IF NOT EXISTS "CrmLead_email" ON "CrmLead"("email")', 'CREATE INDEX IF NOT EXISTS "CrmLead_stage" ON "CrmLead"("stage")',
  'CREATE INDEX IF NOT EXISTS "CrmTask_reminder" ON "CrmTask"("status", "reminderSentAt", "dueDate")',
];

let done = null;
function ensure() {
  if (done) return done;
  done = (async () => {
    for (const sql of DDL) await prisma.$executeRawUnsafe(sql); // eslint-disable-line no-await-in-loop
    for (const [t, c, type] of COLUMNS) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.$executeRawUnsafe(`ALTER TABLE "${t}" ADD COLUMN "${c}" ${type}`).catch((e) => { if (!/duplicate column/i.test(e.message)) throw e; });
    }
    for (const sql of INDEXES) await prisma.$executeRawUnsafe(sql); // eslint-disable-line no-await-in-loop
    return true;
  })().catch((err) => { done = null; console.error('[crm] schema:', err.message); return false; }); // eslint-disable-line no-console
  return done;
}

const nowIso = () => new Date().toISOString();
const plain = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]));
async function all(sql, ...params) { await ensure(); return (await prisma.$queryRawUnsafe(sql, ...params)).map(plain); }
async function one(sql, ...params) { const r = await all(sql, ...params); return r[0] || null; }
async function run(sql, ...params) { await ensure(); return prisma.$executeRawUnsafe(sql, ...params); }

module.exports = { DDL, ensure, nowIso, all, one, run };
