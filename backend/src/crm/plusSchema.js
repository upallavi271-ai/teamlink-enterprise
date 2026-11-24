// ---------------------------------------------------------------------------
// CRM WAVE D (founder 2026-11-24: "Yes, build to 90%") - THE TABLES AND SETTINGS OF THE DEALS / QUOTES / TEAMWORK ADDITIONS.
// Same pattern as crm/schema.js: raw SQL, CREATE TABLE IF NOT EXISTS, ADDITIVE ONLY (a column is added once, "duplicate column" is the
// normal answer afterwards). Nothing here touches HRMS or Accounts tables.
//
//   CrmDealStageLog   every stage a deal stood on: entered / left, who moved it (time in stage, velocity)
//   CrmDealLine       product lines on a deal: product + plan, qty, unit price, line discount, billing period
//   CrmDealSplit      who shares the credit of a deal, and how many percent each
//   CrmForecast       a salesperson's forecast for a month (commit / best case) and the manager's adjustment
//   CrmContract       a sales order or a contract made from a deal: dates, renewal date, status
//   CrmComment        a comment / chat line on a lead, deal or account, with the teammates it @mentions
//   CrmFieldHistory   one changed field: record, field, from, to, who, when
//   CrmPayLink        a payment link made for a CRM invoice (Razorpay) and what became of it
//   CrmConsent        a DPDP consent / notice record for a lead or contact (given, withdrawn), with its source
// The settings (pipelines, price books, CPQ rules, quote templates, field security, territories, sub-teams, IP list, payment link,
// privacy notice ...) are JSON rows in AppSetting under 'crm.plus.<name>', read with a 15 s cache.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const DB = require('./schema');

const owner = '"ownerId" TEXT, "ownerName" TEXT, "createdById" TEXT, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL';
const DDL = [
  `CREATE TABLE IF NOT EXISTS "CrmDealStageLog" ("id" TEXT NOT NULL PRIMARY KEY, "dealId" TEXT NOT NULL, "pipelineId" TEXT, "stage" TEXT NOT NULL,
    "enteredAt" TEXT NOT NULL, "leftAt" TEXT, "byId" TEXT, "byName" TEXT)`,
  'CREATE INDEX IF NOT EXISTS "CrmDealStageLog_deal" ON "CrmDealStageLog"("dealId", "enteredAt")',
  `CREATE TABLE IF NOT EXISTS "CrmDealLine" ("id" TEXT NOT NULL PRIMARY KEY, "dealId" TEXT NOT NULL, "productKey" TEXT, "plan" TEXT, "name" TEXT NOT NULL,
    "qty" REAL NOT NULL DEFAULT 1, "unitPrice" REAL NOT NULL DEFAULT 0, "listPrice" REAL, "discountPercent" REAL NOT NULL DEFAULT 0, "billing" TEXT NOT NULL DEFAULT 'One-time',
    "bundle" TEXT, "rule" TEXT, "sort" INTEGER NOT NULL DEFAULT 0, "createdAt" TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS "CrmDealLine_deal" ON "CrmDealLine"("dealId", "sort")',
  `CREATE TABLE IF NOT EXISTS "CrmDealSplit" ("id" TEXT NOT NULL PRIMARY KEY, "dealId" TEXT NOT NULL, "userId" TEXT NOT NULL, "name" TEXT, "percent" REAL NOT NULL,
    "role" TEXT, "createdAt" TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS "CrmDealSplit_deal" ON "CrmDealSplit"("dealId")',
  `CREATE TABLE IF NOT EXISTS "CrmForecast" ("id" TEXT NOT NULL PRIMARY KEY, "ownerId" TEXT NOT NULL, "ownerName" TEXT, "month" TEXT NOT NULL,
    "commit" REAL, "bestCase" REAL, "note" TEXT, "submittedAt" TEXT,
    "managerCommit" REAL, "managerBestCase" REAL, "managerNote" TEXT, "adjustedByName" TEXT, "adjustedAt" TEXT, "updatedAt" TEXT NOT NULL)`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "CrmForecast_owner_month" ON "CrmForecast"("ownerId", "month")',
  `CREATE TABLE IF NOT EXISTS "CrmContract" ("id" TEXT NOT NULL PRIMARY KEY, "code" TEXT, "kind" TEXT NOT NULL DEFAULT 'Contract', "dealId" TEXT, "accountId" TEXT, "accountName" TEXT,
    "title" TEXT NOT NULL, "startDate" TEXT, "endDate" TEXT, "renewalDate" TEXT, "value" REAL NOT NULL DEFAULT 0, "billing" TEXT, "status" TEXT NOT NULL DEFAULT 'Draft',
    "terms" TEXT, "linesJson" TEXT, "signedOn" TEXT, "poNumber" TEXT, "renewalTaskId" TEXT, ${owner}, "createdByName" TEXT)`,
  'CREATE INDEX IF NOT EXISTS "CrmContract_deal" ON "CrmContract"("dealId")',
  'CREATE INDEX IF NOT EXISTS "CrmContract_renewal" ON "CrmContract"("status", "renewalDate")',
  `CREATE TABLE IF NOT EXISTS "CrmComment" ("id" TEXT NOT NULL PRIMARY KEY, "kind" TEXT NOT NULL, "recordId" TEXT NOT NULL, "body" TEXT NOT NULL, "mentionsJson" TEXT,
    "byId" TEXT, "byName" TEXT, "createdAt" TEXT NOT NULL, "editedAt" TEXT)`,
  'CREATE INDEX IF NOT EXISTS "CrmComment_record" ON "CrmComment"("kind", "recordId", "createdAt")',
  `CREATE TABLE IF NOT EXISTS "CrmFieldHistory" ("id" TEXT NOT NULL PRIMARY KEY, "kind" TEXT NOT NULL, "recordId" TEXT NOT NULL, "field" TEXT NOT NULL,
    "fromValue" TEXT, "toValue" TEXT, "byId" TEXT, "byName" TEXT, "at" TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS "CrmFieldHistory_record" ON "CrmFieldHistory"("kind", "recordId", "at")',
  `CREATE TABLE IF NOT EXISTS "CrmPayLink" ("id" TEXT NOT NULL PRIMARY KEY, "invoiceId" TEXT NOT NULL, "provider" TEXT NOT NULL, "providerId" TEXT, "url" TEXT,
    "amount" REAL NOT NULL, "status" TEXT NOT NULL DEFAULT 'created', "paymentId" TEXT, "paidAmount" REAL, "paidAt" TEXT, "method" TEXT,
    "createdById" TEXT, "createdByName" TEXT, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS "CrmPayLink_invoice" ON "CrmPayLink"("invoiceId")',
  'CREATE INDEX IF NOT EXISTS "CrmPayLink_provider" ON "CrmPayLink"("providerId")',
  `CREATE TABLE IF NOT EXISTS "CrmConsent" ("id" TEXT NOT NULL PRIMARY KEY, "kind" TEXT NOT NULL, "recordId" TEXT NOT NULL, "purpose" TEXT NOT NULL,
    "status" TEXT NOT NULL, "channel" TEXT, "source" TEXT, "noticeVersion" TEXT, "note" TEXT, "ip" TEXT, "byId" TEXT, "byName" TEXT, "at" TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS "CrmConsent_record" ON "CrmConsent"("kind", "recordId", "at")',
];
const COLUMNS = [
  // the deal: which pipeline, the ticks of its stage checklists, forecast category, recurring billing, renewal links, price book
  ['CrmDeal', 'pipelineId', 'TEXT'], ['CrmDeal', 'checklistJson', 'TEXT'], ['CrmDeal', 'forecastCategory', 'TEXT'],
  ['CrmDeal', 'billing', 'TEXT'], ['CrmDeal', 'termMonths', 'INTEGER'], ['CrmDeal', 'renewalOfId', 'TEXT'], ['CrmDeal', 'renewalDealId', 'TEXT'],
  ['CrmDeal', 'priceBookId', 'TEXT'],
  // territories on the records they are worked out for
  ['CrmAccount', 'territoryId', 'TEXT'], ['CrmLead', 'territoryId', 'TEXT'],
  // quote templates, versions and the quote's own approval
  ['CrmProposal', 'templateId', 'TEXT'], ['CrmProposal', 'version', 'INTEGER'], ['CrmProposal', 'revisionOf', 'TEXT'],
  ['CrmProposal', 'approvalStatus', 'TEXT'], ['CrmProposal', 'approvalByName', 'TEXT'], ['CrmProposal', 'approvalAt', 'TEXT'], ['CrmProposal', 'approvalNote', 'TEXT'],
  ['CrmProposal', 'discountPercent', 'REAL'], ['CrmProposal', 'totalAmount', 'REAL'],
];

let READY = null;
function ensure() {
  if (!READY) {
    READY = (async () => {
      await DB.ensure();
      for (const sql of DDL) await prisma.$executeRawUnsafe(sql); // eslint-disable-line no-await-in-loop
      for (const [t, c, type] of COLUMNS) {
        // eslint-disable-next-line no-await-in-loop
        await prisma.$executeRawUnsafe(`ALTER TABLE "${t}" ADD COLUMN "${c}" ${type}`).catch((e) => { if (!/duplicate column/i.test(e.message)) throw e; });
      }
      return true;
    })().catch((e) => { READY = null; console.error('[crm-plus] schema:', e.message); return false; }); // eslint-disable-line no-console
  }
  return READY;
}
async function all(sql, ...params) { await ensure(); return DB.all(sql, ...params); }
async function one(sql, ...params) { const r = await all(sql, ...params); return r[0] || null; }
async function run(sql, ...params) { await ensure(); return DB.run(sql, ...params); }

// ---- settings rows: AppSetting 'crm.plus.<name>' (JSON), 15 s cache ------------------------------------------------------
const cache = new Map();
async function getCfg(name, defaults) {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < 15000) return hit.value;
  const row = await prisma.appSetting.findUnique({ where: { key: `crm.plus.${name}` } }).catch(() => null);
  let v = null;
  try { v = row ? JSON.parse(row.value) : null; } catch { v = null; }
  const value = v == null ? (typeof defaults === 'function' ? defaults() : defaults) : v;
  cache.set(name, { at: Date.now(), value });
  return value;
}
async function setCfg(name, value) {
  const s = JSON.stringify(value);
  await prisma.appSetting.upsert({ where: { key: `crm.plus.${name}` }, create: { key: `crm.plus.${name}`, value: s }, update: { value: s } });
  cache.set(name, { at: Date.now(), value });
  return value;
}
const cachedCfg = (name, fallback) => { const hit = cache.get(name); return hit ? hit.value : fallback; };
const parse = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; } };

module.exports = { ensure, all, one, run, getCfg, setCfg, cachedCfg, parse, DDL, COLUMNS };
