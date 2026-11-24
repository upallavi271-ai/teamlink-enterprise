// ---------------------------------------------------------------------------
// CRM WAVE B (founder 2026-11-24 "build to 90%"): EMAIL, PHONE / WHATSAPP / SMS, MARKETING, CUSTOMER PORTAL - the tables.
// Same pattern as crm/schema.js: raw SQL, CREATE TABLE IF NOT EXISTS the first time anything needs them, ADDITIVE ONLY (a few guarded
// ADD COLUMNs on CRM tables). Times are ISO TEXT. The Admin switches of this wave live in AppSetting 'crm.b' (all OFF by default).
//
//   EMAIL      CrmMailTemplate (one-to-one templates), CrmMailSignature (per person), CrmMailTrack (opens / clicks of one mail),
//              CrmMailQueue (send later), CrmMailLog (every mail read from a mailbox, read once), CrmTeamMail (the shared team inbox),
//              CrmMailBounce (bounces), CrmMailAccount (a person's Gmail / Outlook connection), CrmDocView (a sent document opened)
//   PHONE      CrmDialList + CrmDialItem (power dialer), CrmChat + CrmChatMsg (website chat)
//   MARKETING  CrmMktSegment, CrmLanding, CrmWebVisit, CrmJourney + CrmJourneyRun, CrmSocialPost, CrmMktEvent + CrmMktEventReg, CrmMailPref
//   PORTAL     CrmPortalUser + CrmPortalSession, CrmKbArticle, CrmReseller + CrmResellerDeal, CrmSurveyAsk
// ---------------------------------------------------------------------------
const prisma = require('../../db');

const who = '"byId" TEXT, "byName" TEXT, "createdAt" TEXT NOT NULL, "updatedAt" TEXT';
const DDL = [
  `CREATE TABLE IF NOT EXISTS "CrmMailTemplate" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "channel" TEXT NOT NULL DEFAULT 'email', "subject" TEXT, "body" TEXT NOT NULL,
    "shared" INTEGER NOT NULL DEFAULT 0, "ownerId" TEXT, "uses" INTEGER NOT NULL DEFAULT 0, ${who})`,
  `CREATE TABLE IF NOT EXISTS "CrmMailSignature" ("userId" TEXT NOT NULL PRIMARY KEY, "text" TEXT, "updatedAt" TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS "CrmMailTrack" ("token" TEXT NOT NULL PRIMARY KEY, "activityId" TEXT, "kind" TEXT, "recordId" TEXT, "campaignId" TEXT, "toAddr" TEXT, "subject" TEXT, "links" TEXT,
    "sentAt" TEXT NOT NULL, "openCount" INTEGER NOT NULL DEFAULT 0, "firstOpenAt" TEXT, "lastOpenAt" TEXT, "clickCount" INTEGER NOT NULL DEFAULT 0, "firstClickAt" TEXT, "lastClickAt" TEXT, "byId" TEXT)`,
  'CREATE INDEX IF NOT EXISTS "CrmMailTrack_rec" ON "CrmMailTrack"("kind", "recordId")',
  'CREATE INDEX IF NOT EXISTS "CrmMailTrack_act" ON "CrmMailTrack"("activityId")',
  `CREATE TABLE IF NOT EXISTS "CrmMailQueue" ("id" TEXT NOT NULL PRIMARY KEY, "what" TEXT NOT NULL DEFAULT 'message', "kind" TEXT, "recordId" TEXT, "channel" TEXT NOT NULL, "toAddr" TEXT, "subject" TEXT, "body" TEXT,
    "sendAt" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'Waiting', "result" TEXT, "sentAt" TEXT, ${who})`,
  'CREATE INDEX IF NOT EXISTS "CrmMailQueue_due" ON "CrmMailQueue"("status", "sendAt")',
  `CREATE TABLE IF NOT EXISTS "CrmMailLog" ("messageId" TEXT NOT NULL PRIMARY KEY, "source" TEXT, "mailbox" TEXT, "direction" TEXT, "fromAddr" TEXT, "toAddrs" TEXT, "subject" TEXT, "at" TEXT,
    "kind" TEXT, "recordId" TEXT, "activityId" TEXT, "result" TEXT, "createdAt" TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS "CrmTeamMail" ("id" TEXT NOT NULL PRIMARY KEY, "messageId" TEXT, "mailbox" TEXT, "fromAddr" TEXT, "fromName" TEXT, "subject" TEXT, "text" TEXT, "at" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Open', "assigneeId" TEXT, "assigneeName" TEXT, "kind" TEXT, "recordId" TEXT, "repliedAt" TEXT, "repliedBy" TEXT, "createdAt" TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS "CrmTeamMail_status" ON "CrmTeamMail"("status", "at")',
  `CREATE TABLE IF NOT EXISTS "CrmMailBounce" ("id" TEXT NOT NULL PRIMARY KEY, "email" TEXT NOT NULL, "type" TEXT NOT NULL, "code" TEXT, "reason" TEXT, "source" TEXT, "at" TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS "CrmMailBounce_email" ON "CrmMailBounce"("email")',
  `CREATE TABLE IF NOT EXISTS "CrmMailAccount" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "provider" TEXT NOT NULL, "email" TEXT, "refreshEnc" TEXT, "accessToken" TEXT, "expiresAt" TEXT,
    "cursor" TEXT, "lastSyncAt" TEXT, "lastResult" TEXT, "status" TEXT NOT NULL DEFAULT 'Connected', "createdAt" TEXT NOT NULL, "updatedAt" TEXT)`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "CrmMailAccount_user" ON "CrmMailAccount"("userId", "provider")',
  `CREATE TABLE IF NOT EXISTS "CrmDocView" ("id" TEXT NOT NULL PRIMARY KEY, "docKind" TEXT NOT NULL, "docId" TEXT NOT NULL, "dealId" TEXT, "what" TEXT, "ip" TEXT, "ua" TEXT, "at" TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS "CrmDocView_doc" ON "CrmDocView"("docKind", "docId")',
  // phone
  `CREATE TABLE IF NOT EXISTS "CrmDialList" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "ownerId" TEXT NOT NULL, "ownerName" TEXT, "status" TEXT NOT NULL DEFAULT 'Open', "total" INTEGER NOT NULL DEFAULT 0, "done" INTEGER NOT NULL DEFAULT 0, ${who})`,
  `CREATE TABLE IF NOT EXISTS "CrmDialItem" ("id" TEXT NOT NULL PRIMARY KEY, "listId" TEXT NOT NULL, "pos" INTEGER NOT NULL, "kind" TEXT NOT NULL, "recordId" TEXT NOT NULL, "name" TEXT, "company" TEXT, "phone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Waiting', "outcome" TEXT, "note" TEXT, "calledAt" TEXT)`,
  'CREATE INDEX IF NOT EXISTS "CrmDialItem_list" ON "CrmDialItem"("listId", "status", "pos")',
  `CREATE TABLE IF NOT EXISTS "CrmChat" ("id" TEXT NOT NULL PRIMARY KEY, "token" TEXT NOT NULL, "visitorId" TEXT, "name" TEXT, "email" TEXT, "phone" TEXT, "pageUrl" TEXT, "status" TEXT NOT NULL DEFAULT 'Open',
    "leadId" TEXT, "assigneeId" TEXT, "assigneeName" TEXT, "unread" INTEGER NOT NULL DEFAULT 0, "lastAt" TEXT, "createdAt" TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS "CrmChat_status" ON "CrmChat"("status", "lastAt")',
  `CREATE TABLE IF NOT EXISTS "CrmChatMsg" ("id" TEXT NOT NULL PRIMARY KEY, "chatId" TEXT NOT NULL, "side" TEXT NOT NULL, "body" TEXT NOT NULL, "byId" TEXT, "byName" TEXT, "at" TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS "CrmChatMsg_chat" ON "CrmChatMsg"("chatId", "at")',
  // marketing
  `CREATE TABLE IF NOT EXISTS "CrmMktSegment" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "audience" TEXT NOT NULL, "filtersJson" TEXT NOT NULL, "ownerId" TEXT, "lastCount" INTEGER, "lastCountAt" TEXT, ${who})`,
  `CREATE TABLE IF NOT EXISTS "CrmLanding" ("id" TEXT NOT NULL PRIMARY KEY, "slug" TEXT NOT NULL, "kind" TEXT NOT NULL DEFAULT 'page', "title" TEXT NOT NULL, "headline" TEXT, "body" TEXT, "button" TEXT, "fieldsJson" TEXT,
    "thanks" TEXT, "campaign" TEXT, "color" TEXT, "status" TEXT NOT NULL DEFAULT 'Draft', "views" INTEGER NOT NULL DEFAULT 0, "submits" INTEGER NOT NULL DEFAULT 0, ${who})`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "CrmLanding_slug" ON "CrmLanding"("slug")',
  `CREATE TABLE IF NOT EXISTS "CrmWebVisit" ("id" TEXT NOT NULL PRIMARY KEY, "visitorId" TEXT NOT NULL, "leadId" TEXT, "url" TEXT, "title" TEXT, "referrer" TEXT, "utmSource" TEXT, "utmCampaign" TEXT, "at" TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS "CrmWebVisit_visitor" ON "CrmWebVisit"("visitorId", "at")',
  'CREATE INDEX IF NOT EXISTS "CrmWebVisit_lead" ON "CrmWebVisit"("leadId", "at")',
  `CREATE TABLE IF NOT EXISTS "CrmJourney" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "trigger" TEXT NOT NULL, "segmentId" TEXT, "source" TEXT, "stepsJson" TEXT NOT NULL, "on" INTEGER NOT NULL DEFAULT 0,
    "armedAt" TEXT, "enrolled" INTEGER NOT NULL DEFAULT 0, ${who})`,
  `CREATE TABLE IF NOT EXISTS "CrmJourneyRun" ("id" TEXT NOT NULL PRIMARY KEY, "journeyId" TEXT NOT NULL, "kind" TEXT NOT NULL, "recordId" TEXT NOT NULL, "step" INTEGER NOT NULL DEFAULT 0, "nextAt" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Running', "log" TEXT, "createdAt" TEXT NOT NULL, "updatedAt" TEXT)`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "CrmJourneyRun_one" ON "CrmJourneyRun"("journeyId", "kind", "recordId")',
  'CREATE INDEX IF NOT EXISTS "CrmJourneyRun_due" ON "CrmJourneyRun"("status", "nextAt")',
  `CREATE TABLE IF NOT EXISTS "CrmSocialPost" ("id" TEXT NOT NULL PRIMARY KEY, "channel" TEXT NOT NULL, "text" TEXT NOT NULL, "link" TEXT, "status" TEXT NOT NULL DEFAULT 'Draft', "ref" TEXT, "error" TEXT, "postAt" TEXT, "postedAt" TEXT, ${who})`,
  `CREATE TABLE IF NOT EXISTS "CrmMktEvent" ("id" TEXT NOT NULL PRIMARY KEY, "slug" TEXT NOT NULL, "title" TEXT NOT NULL, "kind" TEXT NOT NULL DEFAULT 'Webinar', "startsAt" TEXT NOT NULL, "endsAt" TEXT, "place" TEXT, "link" TEXT,
    "capacity" INTEGER, "description" TEXT, "status" TEXT NOT NULL DEFAULT 'Open', ${who})`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "CrmMktEvent_slug" ON "CrmMktEvent"("slug")',
  `CREATE TABLE IF NOT EXISTS "CrmMktEventReg" ("id" TEXT NOT NULL PRIMARY KEY, "eventId" TEXT NOT NULL, "name" TEXT, "email" TEXT, "phone" TEXT, "company" TEXT, "leadId" TEXT, "status" TEXT NOT NULL DEFAULT 'Registered', "at" TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS "CrmMktEventReg_event" ON "CrmMktEventReg"("eventId")',
  `CREATE TABLE IF NOT EXISTS "CrmMailPref" ("email" TEXT NOT NULL PRIMARY KEY, "topicsJson" TEXT, "channelsJson" TEXT, "updatedAt" TEXT NOT NULL)`,
  // portal
  `CREATE TABLE IF NOT EXISTS "CrmPortalUser" ("id" TEXT NOT NULL PRIMARY KEY, "type" TEXT NOT NULL DEFAULT 'customer', "accountId" TEXT, "contactId" TEXT, "resellerId" TEXT, "email" TEXT NOT NULL, "name" TEXT,
    "passwordHash" TEXT, "inviteHash" TEXT, "inviteUntil" TEXT, "status" TEXT NOT NULL DEFAULT 'Invited', "lastLoginAt" TEXT, ${who})`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "CrmPortalUser_email" ON "CrmPortalUser"("email", "type")',
  `CREATE TABLE IF NOT EXISTS "CrmPortalSession" ("tokenHash" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "expiresAt" TEXT NOT NULL, "createdAt" TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS "CrmKbArticle" ("id" TEXT NOT NULL PRIMARY KEY, "title" TEXT NOT NULL, "category" TEXT, "body" TEXT NOT NULL, "published" INTEGER NOT NULL DEFAULT 0, "views" INTEGER NOT NULL DEFAULT 0,
    "helpfulYes" INTEGER NOT NULL DEFAULT 0, "helpfulNo" INTEGER NOT NULL DEFAULT 0, ${who})`,
  `CREATE TABLE IF NOT EXISTS "CrmReseller" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "contactName" TEXT, "email" TEXT, "phone" TEXT, "city" TEXT, "commissionPercent" REAL, "status" TEXT NOT NULL DEFAULT 'Active', "ownerId" TEXT, "ownerName" TEXT, ${who})`,
  `CREATE TABLE IF NOT EXISTS "CrmResellerDeal" ("id" TEXT NOT NULL PRIMARY KEY, "resellerId" TEXT NOT NULL, "company" TEXT NOT NULL, "contactName" TEXT, "phone" TEXT, "email" TEXT, "value" REAL, "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Submitted', "reason" TEXT, "leadId" TEXT, "decidedById" TEXT, "decidedAt" TEXT, "createdAt" TEXT NOT NULL, "updatedAt" TEXT)`,
  'CREATE INDEX IF NOT EXISTS "CrmResellerDeal_r" ON "CrmResellerDeal"("resellerId", "status")',
  `CREATE TABLE IF NOT EXISTS "CrmSurveyAsk" ("id" TEXT NOT NULL PRIMARY KEY, "token" TEXT NOT NULL, "type" TEXT NOT NULL, "about" TEXT, "kind" TEXT, "recordId" TEXT, "accountId" TEXT, "email" TEXT, "name" TEXT,
    "score" INTEGER, "comment" TEXT, "sentAt" TEXT, "answeredAt" TEXT, "byId" TEXT, "byName" TEXT, "createdAt" TEXT NOT NULL)`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "CrmSurveyAsk_token" ON "CrmSurveyAsk"("token")',
];
// columns on CRM tables (guarded: "duplicate column" means it is already there)
const COLUMNS = [
  ['CrmCampaign', 'cost', 'REAL'], ['CrmCampaign', 'topic', 'TEXT'], ['CrmCampaign', 'code', 'TEXT'],
  ['CrmLead', 'campaignId', 'TEXT'], ['CrmLead', 'visitorId', 'TEXT'],
  ['CrmLead', 'linkedinUrl', 'TEXT'], ['CrmLead', 'twitterUrl', 'TEXT'], ['CrmLead', 'facebookUrl', 'TEXT'],
  ['CrmContact', 'linkedinUrl', 'TEXT'],
  ['CrmTicket', 'portalUserId', 'TEXT'],
];

let done = null;
function ensure() {
  if (done) return done;
  done = (async () => {
    await require('../schema').ensure(); // eslint-disable-line global-require
    for (const sql of DDL) await prisma.$executeRawUnsafe(sql); // eslint-disable-line no-await-in-loop
    for (const [t, c, type] of COLUMNS) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.$executeRawUnsafe(`ALTER TABLE "${t}" ADD COLUMN "${c}" ${type}`).catch((e) => { if (!/duplicate column/i.test(e.message)) throw e; });
    }
    return true;
  })().catch((err) => { done = null; console.error('[crm b] schema:', err.message); return false; }); // eslint-disable-line no-console
  return done;
}
const nowIso = () => new Date().toISOString();
const plain = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]));
async function all(sql, ...params) { await ensure(); return (await prisma.$queryRawUnsafe(sql, ...params)).map(plain); }
async function one(sql, ...params) { const r = await all(sql, ...params); return r[0] || null; }
async function run(sql, ...params) { await ensure(); return prisma.$executeRawUnsafe(sql, ...params); }

// ---- the Admin switches of this wave (all OFF by default: nothing new messages people or runs by itself until the founder turns it on)
const SWITCH_KEY = 'crm.b';
const SWITCHES = {
  mailTracking: 'Email open and click tracking (a 1-pixel image and links through TeamLink)',
  sendLater: 'Send later: scheduled emails, WhatsApp and campaigns go out at their time',
  mailSync: 'Read the connected mailboxes every 5 minutes: log mail on the records (BCC too), the team inbox, bounces',
  chatWidget: 'Website chat: the chat bubble on the company website answers visitors',
  webTracking: 'Website visit tracking: the pages a lead viewed on the company website',
  journeys: 'Nurture journeys: the switched-on journeys send their steps by themselves',
  socialPosting: 'Social posts: scheduled posts go to the company Facebook Page / LinkedIn by themselves',
  adsLeads: 'Ad leads: Facebook / Instagram lead ads and Google Ads lead forms come in as leads',
  inboundRouting: 'Incoming calls: a known caller is put through to the owner of their lead',
  portal: 'Customer and partner portal: customers and partners can sign in at /crm-portal',
  surveysAuto: 'Surveys after a sale / a closed ticket go by themselves',
};
const DEFAULTS = Object.fromEntries(Object.keys(SWITCHES).map((k) => [k, false]));
let cache = null; let cacheAt = 0;
async function settings() {
  if (cache && Date.now() - cacheAt < 3000) return cache;
  const row = await prisma.appSetting.findUnique({ where: { key: SWITCH_KEY } }).catch(() => null);
  let v = {}; try { v = row ? JSON.parse(row.value) : {}; } catch { v = {}; }
  cache = { ...DEFAULTS, ...Object.fromEntries(Object.keys(SWITCHES).map((k) => [k, v[k] === true])), bccAddress: typeof v.bccAddress === 'string' ? v.bccAddress : '', teamMailbox: typeof v.teamMailbox === 'string' ? v.teamMailbox : '', siteId: typeof v.siteId === 'string' ? v.siteId : '', hookKey: typeof v.hookKey === 'string' ? v.hookKey : '', topics: Array.isArray(v.topics) && v.topics.length ? v.topics.slice(0, 12) : ['Product news', 'Offers', 'Events and webinars', 'Hiring tips'] };
  cacheAt = Date.now();
  return cache;
}
async function saveSettings(next) {
  const cur = await settings();
  const v = { ...cur, ...next };
  await prisma.appSetting.upsert({ where: { key: SWITCH_KEY }, create: { key: SWITCH_KEY, value: JSON.stringify(v) }, update: { value: JSON.stringify(v) } });
  cache = null;
  return settings();
}
const on = async (k) => !!(await settings())[k];

module.exports = { ensure, all, one, run, nowIso, settings, saveSettings, on, SWITCHES };
