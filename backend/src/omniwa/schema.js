// ---------------------------------------------------------------------------
// OMNI-CHANNEL > WHATSAPP WITH THE AI AGENT: the NEW tables (self-provisioned like crm/schema.js and outreach/bots.js: no existing table is altered).
// What the app already had stays where it is, so a message never lives in two truths:
//   whatsapp_accounts  = the existing WaNumber list (utils/waNumbers.js, tokens encrypted)        messages to a candidate = the existing CandidateMessage
//   opt-outs of bulk   = the existing msg.optout + OutreachSuppression, OmniWaOptOut is the one list of who asked to stop on WhatsApp and when
// New here:
//   OmniWaConv       one row per phone number: AI / human state, job, campaign, owner, what the AI collected (memory is keyed by the number)
//   OmniWaMessage    every WhatsApp message the agent saw or sent, and every promotion: candidate, job, campaign, template, recruiter, status.
//                    A number with no candidate (a lead) has its messages ONLY here. UNIQUE provider id = one message is handled once.
//   OmniWaCampaign   one row per bulk promotion
//   OmniWaAiConfig   the Admin's AI settings (one row)        OmniWaKnowledge  the FAQ entries (numberId empty = every number)        OmniWaOptOut  STOP / unsubscribe
//   OmniWaAiProfile  one WhatsApp number's own switch, instructions and fallback (no row = the default settings)
//   OmniWaAiRun      one row per AI run: input, tool calls, output, errors
// Times are epoch milliseconds in BIGINT columns (Prisma raw reads cannot take them from an INTEGER column).
// ---------------------------------------------------------------------------
const S = require('../outreach/store');

const DDL = [
  `CREATE TABLE IF NOT EXISTS "OmniWaConv" ("id" TEXT NOT NULL PRIMARY KEY, "e164" TEXT NOT NULL, "personType" TEXT NOT NULL DEFAULT 'CANDIDATE', "candidateId" TEXT, "leadContactId" TEXT, "name" TEXT,
    "numberId" TEXT, "requirementId" TEXT, "campaignId" TEXT, "campaignName" TEXT, "ownerUserId" TEXT, "ownerName" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'ai', "state" TEXT NOT NULL DEFAULT 'active', "handoffReason" TEXT, "pausedByName" TEXT, "aiTurns" INTEGER NOT NULL DEFAULT 0, "collected" TEXT NOT NULL DEFAULT '{}',
    "promoAt" BIGINT, "aiStartedAt" BIGINT, "lastAiAt" BIGINT, "lastInboundAt" BIGINT, "lastText" TEXT, "unread" INTEGER NOT NULL DEFAULT 0, "pendingAt" BIGINT, "runningAt" BIGINT, "fallbackAt" BIGINT,
    "resumedAt" BIGINT, "createdAt" BIGINT NOT NULL, "updatedAt" BIGINT NOT NULL)`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "OmniWaConv_e164" ON "OmniWaConv"("e164")',
  'CREATE INDEX IF NOT EXISTS "OmniWaConv_candidate" ON "OmniWaConv"("candidateId")',
  'CREATE INDEX IF NOT EXISTS "OmniWaConv_pending" ON "OmniWaConv"("pendingAt")',
  `CREATE TABLE IF NOT EXISTS "OmniWaMessage" ("id" TEXT NOT NULL PRIMARY KEY, "e164" TEXT NOT NULL, "convId" TEXT, "direction" TEXT NOT NULL, "body" TEXT, "template" TEXT, "status" TEXT, "statusDetail" TEXT,
    "providerMessageId" TEXT, "aiGenerated" INTEGER NOT NULL DEFAULT 0, "candidateId" TEXT, "requirementId" TEXT, "campaignId" TEXT, "senderUserId" TEXT, "senderName" TEXT, "numberId" TEXT,
    "consumedAt" BIGINT, "at" BIGINT NOT NULL, "createdAt" BIGINT NOT NULL)`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "OmniWaMessage_provider" ON "OmniWaMessage"("providerMessageId") WHERE "providerMessageId" IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS "OmniWaMessage_phone" ON "OmniWaMessage"("e164", "at")',
  'CREATE INDEX IF NOT EXISTS "OmniWaMessage_campaign" ON "OmniWaMessage"("campaignId")',
  `CREATE TABLE IF NOT EXISTS "OmniWaCampaign" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT, "requirementId" TEXT, "template" TEXT, "senderUserId" TEXT, "senderName" TEXT, "numberId" TEXT, "createdAt" BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS "OmniWaAiConfig" ("id" TEXT NOT NULL PRIMARY KEY, "enabled" INTEGER NOT NULL DEFAULT 0, "model" TEXT, "systemPrompt" TEXT, "hoursOn" INTEGER NOT NULL DEFAULT 0, "hoursFrom" TEXT, "hoursTo" TEXT,
    "fallbackMessage" TEXT, "maxTurns" INTEGER NOT NULL DEFAULT 12, "memoryCount" INTEGER NOT NULL DEFAULT 12, "debounceSeconds" INTEGER NOT NULL DEFAULT 10, "promoDays" INTEGER NOT NULL DEFAULT 7, "testNumbers" TEXT,
    "updatedByName" TEXT, "updatedAt" BIGINT)`,
  `CREATE TABLE IF NOT EXISTS "OmniWaKnowledge" ("id" TEXT NOT NULL PRIMARY KEY, "question" TEXT NOT NULL, "answer" TEXT NOT NULL, "active" INTEGER NOT NULL DEFAULT 1, "updatedByName" TEXT, "createdAt" BIGINT NOT NULL, "updatedAt" BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS "OmniWaAiProfile" ("numberId" TEXT NOT NULL PRIMARY KEY, "enabled" INTEGER NOT NULL DEFAULT 1, "systemPrompt" TEXT, "fallbackMessage" TEXT, "updatedByName" TEXT, "updatedAt" BIGINT)`,
  `CREATE TABLE IF NOT EXISTS "OmniWaOptOut" ("e164" TEXT NOT NULL PRIMARY KEY, "candidateId" TEXT, "source" TEXT, "text" TEXT, "at" BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS "OmniWaAiRun" ("id" TEXT NOT NULL PRIMARY KEY, "convId" TEXT, "e164" TEXT, "input" TEXT, "toolCalls" TEXT, "output" TEXT, "outcome" TEXT, "error" TEXT, "model" TEXT, "ms" INTEGER, "at" BIGINT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS "OmniWaAiRun_at" ON "OmniWaAiRun"("at")',
  // the marketing assistant's follow-ups (omniwa/followup.js): one row per draft; status approval | ready | sent | skipped | stopped | failed
  `CREATE TABLE IF NOT EXISTS "OmniWaFollowUp" ("id" TEXT NOT NULL PRIMARY KEY, "convId" TEXT NOT NULL, "e164" TEXT NOT NULL, "crmLeadId" TEXT, "step" INTEGER NOT NULL, "status" TEXT NOT NULL, "mode" TEXT, "body" TEXT,
    "templateName" TEXT, "vars" TEXT, "dueAt" BIGINT NOT NULL, "reason" TEXT, "error" TEXT, "decidedByName" TEXT, "decidedAt" BIGINT, "sentAt" BIGINT, "providerMessageId" TEXT, "createdAt" BIGINT NOT NULL, "updatedAt" BIGINT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS "OmniWaFollowUp_status" ON "OmniWaFollowUp"("status", "dueAt")',
  'CREATE INDEX IF NOT EXISTS "OmniWaFollowUp_conv" ON "OmniWaFollowUp"("convId")',
  // the marketing assistant's promotion campaigns (omniwa/campaign.js): a campaign and the exact words each person gets; status ready | scheduled | sending | done | cancelled
  `CREATE TABLE IF NOT EXISTS "OmniWaMktCampaign" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "templateId" TEXT, "templateName" TEXT NOT NULL, "language" TEXT, "templateBody" TEXT, "varMap" TEXT, "audience" TEXT, "numberId" TEXT,
    "status" TEXT NOT NULL, "scheduledAt" BIGINT, "note" TEXT, "createdById" TEXT, "createdByName" TEXT, "approvedByName" TEXT, "approvedAt" BIGINT, "startedAt" BIGINT, "finishedAt" BIGINT, "createdAt" BIGINT NOT NULL, "updatedAt" BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS "OmniWaMktRecipient" ("id" TEXT NOT NULL PRIMARY KEY, "campaignId" TEXT NOT NULL, "crmLeadId" TEXT, "e164" TEXT NOT NULL, "name" TEXT, "vars" TEXT, "body" TEXT, "status" TEXT NOT NULL, "reason" TEXT,
    "providerMessageId" TEXT, "sentAt" BIGINT, "createdAt" BIGINT NOT NULL, "updatedAt" BIGINT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS "OmniWaMktRecipient_campaign" ON "OmniWaMktRecipient"("campaignId", "status")',
  'CREATE INDEX IF NOT EXISTS "OmniWaMktRecipient_phone" ON "OmniWaMktRecipient"("e164", "sentAt")',
];

let ready = null;
function ensure() {
  if (!ready) {
    ready = (async () => {
      for (const sql of DDL) await S.run(sql); // eslint-disable-line no-await-in-loop
      const cols = await S.q('SELECT name FROM pragma_table_info(\'OmniWaKnowledge\')');
      // the table went live before entries could belong to one number (numberId) or to a kind of knowledge (category: company, services, products, pricing, hours,
      // contact, policies, faq, website; confirmedAt = when a person last saved a pricing entry). Added, never changed: old rows read as category NULL = faq.
      for (const [name, type] of [['numberId', 'TEXT'], ['category', 'TEXT'], ['confirmedAt', 'BIGINT']]) {
        if (!cols.some((c) => c.name === name)) await S.run(`ALTER TABLE "OmniWaKnowledge" ADD COLUMN "${name}" ${type}`); // eslint-disable-line no-await-in-loop
      }
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

module.exports = { ensure };
