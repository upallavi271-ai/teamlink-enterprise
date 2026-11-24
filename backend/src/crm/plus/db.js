// ---------------------------------------------------------------------------
// CRM WAVE C (2026-11-24, founder "Yes, build to 90%"): Contacts & Accounts, Admin & Customisation, Data & Compliance, Leads.
// The tables and the one settings row of everything in backend/src/crm/plus/*. Same pattern as crm/schema.js: raw SQL tables with no Prisma
// model, created with CREATE TABLE IF NOT EXISTS the first time anything needs them; columns added once ("duplicate column" is the normal
// answer afterwards). ADDITIVE ONLY: nothing existing is altered or dropped.
//
//   CrmFieldDef        a custom field an Admin / Sales manager added to leads, accounts, contacts or deals (values: "customJson" on the record)
//   CrmValidationRule  a rule that blocks bad data on save (required, pattern, min / max, length, one of a list), optionally only when another field says X
//   CrmObjectDef       a record type of your own ("Branches", "Contracts" ...) with its fields; CrmObjectRecord = one record of it, linked to an account / lead / deal
//   CrmRecordFile      a file kept on a lead, an account or a contact (deals keep theirs in CrmDealFile, crm/money.js)
//   CrmDealContact     the people on a deal with their role (decision maker, influencer, billing contact ...)
//   CrmAccountTeam     the account team: people who work an account with its owner (they may read it)
//   CrmRecycle         a deleted lead / account / contact / deal with what went with it, to restore (the recycle bin)
//   CrmConsent         consent given / withdrawn per person and channel (email, SMS, WhatsApp, call), with the purpose and where it came from
//   CrmDataRequest     a data-subject request (export or erase one person's data) and what was done
//   CrmDnd             numbers on the Do-Not-Disturb list (uploaded from the NCPR / provider, or found by the provider check)
//   CrmAssignRule      who gets a new lead: by source, city, state, industry, product, or any field
//   CrmCaptureLog      every lead that came in from email, chat, Facebook / LinkedIn / Google lead forms, IndiaMART, JustDial, TradeIndia
//   CrmUsage           one row a person a day: how often they opened the CRM and changed something (the adoption report)
//
// Settings: one JSON row in AppSetting 'crm.plus' (layouts, currencies, business units, lead routing / capture switches, retention, DND, fiscal
// year, branding, language). Everything that messages people or runs by itself is OFF until an Admin turns it on.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../../db');
const CRMDB = require('../schema');

const DDL = [
  `CREATE TABLE IF NOT EXISTS "CrmFieldDef" (
    "id" TEXT NOT NULL PRIMARY KEY, "kind" TEXT NOT NULL, "key" TEXT NOT NULL, "label" TEXT NOT NULL, "type" TEXT NOT NULL DEFAULT 'text',
    "optionsJson" TEXT, "required" INTEGER NOT NULL DEFAULT 0, "sensitive" INTEGER NOT NULL DEFAULT 0, "section" TEXT, "position" INTEGER NOT NULL DEFAULT 0,
    "helpText" TEXT, "active" INTEGER NOT NULL DEFAULT 1, "createdById" TEXT, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "CrmFieldDef_key" ON "CrmFieldDef"("kind", "key")',
  `CREATE TABLE IF NOT EXISTS "CrmValidationRule" (
    "id" TEXT NOT NULL PRIMARY KEY, "kind" TEXT NOT NULL, "field" TEXT NOT NULL, "op" TEXT NOT NULL, "value" TEXT, "message" TEXT,
    "whenField" TEXT, "whenValue" TEXT, "active" INTEGER NOT NULL DEFAULT 1, "createdById" TEXT, "createdAt" TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "CrmObjectDef" (
    "id" TEXT NOT NULL PRIMARY KEY, "key" TEXT NOT NULL, "name" TEXT NOT NULL, "plural" TEXT, "linkTo" TEXT, "fieldsJson" TEXT NOT NULL,
    "active" INTEGER NOT NULL DEFAULT 1, "createdById" TEXT, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "CrmObjectDef_key" ON "CrmObjectDef"("key")',
  `CREATE TABLE IF NOT EXISTS "CrmObjectRecord" (
    "id" TEXT NOT NULL PRIMARY KEY, "objectId" TEXT NOT NULL, "name" TEXT NOT NULL, "valuesJson" TEXT,
    "accountId" TEXT, "leadId" TEXT, "dealId" TEXT, "contactId" TEXT,
    "ownerId" TEXT, "ownerName" TEXT, "createdById" TEXT, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS "CrmObjectRecord_object" ON "CrmObjectRecord"("objectId", "updatedAt")',
  'CREATE INDEX IF NOT EXISTS "CrmObjectRecord_account" ON "CrmObjectRecord"("accountId")',
  `CREATE TABLE IF NOT EXISTS "CrmRecordFile" (
    "id" TEXT NOT NULL PRIMARY KEY, "kind" TEXT NOT NULL, "recordId" TEXT NOT NULL, "category" TEXT,
    "name" TEXT NOT NULL, "mime" TEXT NOT NULL, "size" INTEGER NOT NULL DEFAULT 0, "stored" TEXT NOT NULL,
    "createdById" TEXT, "createdByName" TEXT, "createdAt" TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS "CrmRecordFile_rec" ON "CrmRecordFile"("kind", "recordId")',
  `CREATE TABLE IF NOT EXISTS "CrmDealContact" (
    "id" TEXT NOT NULL PRIMARY KEY, "dealId" TEXT NOT NULL, "contactId" TEXT NOT NULL, "role" TEXT, "primary" INTEGER NOT NULL DEFAULT 0, "createdAt" TEXT NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "CrmDealContact_one" ON "CrmDealContact"("dealId", "contactId")',
  `CREATE TABLE IF NOT EXISTS "CrmAccountTeam" (
    "id" TEXT NOT NULL PRIMARY KEY, "accountId" TEXT NOT NULL, "userId" TEXT NOT NULL, "userName" TEXT, "role" TEXT, "createdById" TEXT, "createdAt" TEXT NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "CrmAccountTeam_one" ON "CrmAccountTeam"("accountId", "userId")',
  'CREATE INDEX IF NOT EXISTS "CrmAccountTeam_user" ON "CrmAccountTeam"("userId")',
  `CREATE TABLE IF NOT EXISTS "CrmRecycle" (
    "id" TEXT NOT NULL PRIMARY KEY, "kind" TEXT NOT NULL, "recordId" TEXT NOT NULL, "name" TEXT, "rowJson" TEXT NOT NULL, "extraJson" TEXT,
    "ownerId" TEXT, "deletedById" TEXT, "deletedByName" TEXT, "deletedAt" TEXT NOT NULL, "restoredAt" TEXT, "why" TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS "CrmRecycle_at" ON "CrmRecycle"("restoredAt", "deletedAt")',
  `CREATE TABLE IF NOT EXISTS "CrmConsent" (
    "id" TEXT NOT NULL PRIMARY KEY, "value" TEXT NOT NULL, "channel" TEXT NOT NULL, "status" TEXT NOT NULL, "purpose" TEXT, "source" TEXT, "note" TEXT,
    "kind" TEXT, "recordId" TEXT, "byId" TEXT, "byName" TEXT, "at" TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS "CrmConsent_value" ON "CrmConsent"("value", "channel", "at")',
  `CREATE TABLE IF NOT EXISTS "CrmDataRequest" (
    "id" TEXT NOT NULL PRIMARY KEY, "type" TEXT NOT NULL, "person" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'Open', "note" TEXT, "detail" TEXT,
    "byId" TEXT, "byName" TEXT, "createdAt" TEXT NOT NULL, "doneAt" TEXT, "dueBy" TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS "CrmDnd" ("value" TEXT NOT NULL PRIMARY KEY, "source" TEXT, "category" TEXT, "addedAt" TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS "CrmAssignRule" (
    "id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "position" INTEGER NOT NULL DEFAULT 0, "active" INTEGER NOT NULL DEFAULT 1,
    "matchJson" TEXT NOT NULL, "ownerIdsJson" TEXT NOT NULL, "lastOwnerId" TEXT, "hits" INTEGER NOT NULL DEFAULT 0, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "CrmCaptureLog" (
    "id" TEXT NOT NULL PRIMARY KEY, "source" TEXT NOT NULL, "status" TEXT NOT NULL, "detail" TEXT, "leadId" TEXT, "externalId" TEXT, "at" TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS "CrmCaptureLog_at" ON "CrmCaptureLog"("at")',
  'CREATE INDEX IF NOT EXISTS "CrmCaptureLog_ext" ON "CrmCaptureLog"("source", "externalId")',
  `CREATE TABLE IF NOT EXISTS "CrmUsage" (
    "userId" TEXT NOT NULL, "day" TEXT NOT NULL, "userName" TEXT, "opens" INTEGER NOT NULL DEFAULT 0, "reads" INTEGER NOT NULL DEFAULT 0, "changes" INTEGER NOT NULL DEFAULT 0,
    "firstAt" TEXT, "lastAt" TEXT, PRIMARY KEY ("userId", "day")
  )`,
];
const COLUMNS = [
  ['CrmLead', 'customJson', 'TEXT'], ['CrmAccount', 'customJson', 'TEXT'], ['CrmContact', 'customJson', 'TEXT'], ['CrmDeal', 'customJson', 'TEXT'],
  ['CrmLead', 'tags', 'TEXT'], ['CrmContact', 'tags', 'TEXT'], ['CrmDeal', 'tags', 'TEXT'],
  ['CrmAccount', 'parentId', 'TEXT'], ['CrmContact', 'reportsToId', 'TEXT'],
  ['CrmDeal', 'currency', 'TEXT'], ['CrmDeal', 'fxRate', 'REAL'], ['CrmDeal', 'amountForeign', 'REAL'],
  ['CrmLead', 'unitId', 'TEXT'], ['CrmAccount', 'unitId', 'TEXT'], ['CrmDeal', 'unitId', 'TEXT'],
  ['CrmAccount', 'enrichedAt', 'TEXT'], ['CrmAccount', 'social', 'TEXT'], ['CrmAccount', 'employees', 'TEXT'],
];
const INDEXES = [
  'CREATE INDEX IF NOT EXISTS "CrmAccount_parent" ON "CrmAccount"("parentId")',
];

let done = null;
function ensure() {
  if (done) return done;
  done = (async () => {
    await CRMDB.ensure();
    for (const sql of DDL) await prisma.$executeRawUnsafe(sql); // eslint-disable-line no-await-in-loop
    for (const [t, c, type] of COLUMNS) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.$executeRawUnsafe(`ALTER TABLE "${t}" ADD COLUMN "${c}" ${type}`).catch((e) => { if (!/duplicate column/i.test(e.message)) throw e; });
    }
    for (const sql of INDEXES) await prisma.$executeRawUnsafe(sql); // eslint-disable-line no-await-in-loop
    return true;
  })().catch((err) => { done = null; console.error('[crm plus] schema:', err.message); return false; }); // eslint-disable-line no-console
  return done;
}
const READY = () => ensure();
const plain = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]));
async function all(sql, ...params) { await ensure(); return (await prisma.$queryRawUnsafe(sql, ...params)).map(plain); }
async function one(sql, ...params) { const r = await all(sql, ...params); return r[0] || null; }
async function run(sql, ...params) { await ensure(); return prisma.$executeRawUnsafe(sql, ...params); }
const nowIso = () => new Date().toISOString();
const newId = (p) => `${p}_${crypto.randomBytes(9).toString('hex')}`;
const parse = (s, fb) => { try { const v = s ? JSON.parse(s) : fb; return v == null ? fb : v; } catch { return fb; } };

// ---- the settings row ---------------------------------------------------------------------------------------
const KEY = 'crm.plus';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const CAPTURE_SOURCES = ['webhook', 'email', 'chat', 'facebook', 'linkedin', 'google', 'justdial'];
const PULL_SOURCES = ['indiamart', 'tradeindia'];
const DEFAULTS = {
  layouts: {}, // { lead: { sections: [{ name, fields: [key] }], hidden: { rep: [key], viewer: [key] }, readOnly: { rep: [key] } } }
  baseCurrency: 'INR',
  currencies: [{ code: 'USD', symbol: '$', rate: 84 }, { code: 'EUR', symbol: '€', rate: 90 }, { code: 'GBP', symbol: '£', rate: 106 }, { code: 'AED', symbol: 'AED ', rate: 22.9 }],
  units: [], // business units: { id, name, gstin, address, state, email, phone, bank }
  unitsOn: false,
  assignRulesOn: false,
  capture: { key: '', on: {}, pull: {}, pullMinutes: 15, lastPull: {} },
  retention: { on: false, binDays: 30, junkLeadDays: 0, lostLeadDays: 0, activityDays: 0, lastRunAt: null, lastResult: null },
  dnd: { blockCalls: true, providerOn: false },
  consent: { requireForCampaigns: false },
  fiscal: { startMonth: 4, holidays: [] }, // startMonth 1-12 (April = the Indian financial year)
  branding: { color: '#1b2a4a', logo: null, tagline: '' },
  locale: { numbers: 'en-IN' },
  enrich: { on: true },
};
function cleanConfig(raw = {}) {
  const r = raw || {};
  const d = DEFAULTS;
  const s = (v, n = 120) => String(v == null ? '' : v).trim().slice(0, n);
  const currencies = (Array.isArray(r.currencies) ? r.currencies : d.currencies).map((c) => ({ code: s(c && c.code, 3).toUpperCase(), symbol: s(c && c.symbol, 6) || s(c && c.code, 3).toUpperCase(), rate: Number(c && c.rate) }))
    .filter((c) => /^[A-Z]{3}$/.test(c.code) && c.code !== 'INR' && Number.isFinite(c.rate) && c.rate > 0 && c.rate < 100000).slice(0, 30);
  const units = (Array.isArray(r.units) ? r.units : []).map((u) => ({ id: s(u && u.id, 40) || newId('unit'), name: s(u && u.name, 120), gstin: s(u && u.gstin, 20).toUpperCase(), address: s(u && u.address, 400), state: s(u && u.state, 60), email: s(u && u.email, 120), phone: s(u && u.phone, 30), bank: s(u && u.bank, 400) }))
    .filter((u) => u.name).slice(0, 20);
  const cap = r.capture || {};
  const on = {}; CAPTURE_SOURCES.forEach((k) => { on[k] = !!(cap.on && cap.on[k] === true); });
  const pull = {}; PULL_SOURCES.forEach((k) => { pull[k] = !!(cap.pull && cap.pull[k] === true); });
  const ret = r.retention || {};
  const days = (v, max = 3650) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 && n <= max ? n : 0; };
  const fy = r.fiscal || {};
  const sm = Math.round(Number(fy.startMonth));
  const holidays = (Array.isArray(fy.holidays) ? fy.holidays : []).map((h) => ({ date: s(h && h.date, 10), name: s(h && h.name, 80) })).filter((h) => /^\d{4}-\d{2}-\d{2}$/.test(h.date)).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 200);
  const br = r.branding || {};
  const layouts = {};
  ['lead', 'account', 'contact', 'deal'].forEach((k) => {
    const L = (r.layouts || {})[k];
    if (!L || typeof L !== 'object') return;
    const keyList = (a) => [...new Set((Array.isArray(a) ? a : []).map((x) => s(x, 60)).filter(Boolean))].slice(0, 120);
    layouts[k] = {
      sections: (Array.isArray(L.sections) ? L.sections : []).map((x) => ({ name: s(x && x.name, 60) || 'Details', fields: keyList(x && x.fields) })).filter((x) => x.fields.length).slice(0, 12),
      hidden: { rep: keyList(L.hidden && L.hidden.rep), viewer: keyList(L.hidden && L.hidden.viewer), manager: keyList(L.hidden && L.hidden.manager) },
      readOnly: { rep: keyList(L.readOnly && L.readOnly.rep) },
    };
  });
  return {
    layouts,
    baseCurrency: 'INR',
    currencies,
    units,
    unitsOn: r.unitsOn === true,
    assignRulesOn: r.assignRulesOn === true,
    capture: { key: s(cap.key, 80), on, pull, pullMinutes: [5, 15, 30, 60, 180].includes(Number(cap.pullMinutes)) ? Number(cap.pullMinutes) : 15, lastPull: typeof cap.lastPull === 'object' && cap.lastPull ? cap.lastPull : {} },
    retention: { on: ret.on === true, binDays: days(ret.binDays == null ? 30 : ret.binDays) || 30, junkLeadDays: days(ret.junkLeadDays), lostLeadDays: days(ret.lostLeadDays), activityDays: days(ret.activityDays, 36500), lastRunAt: ret.lastRunAt || null, lastResult: ret.lastResult || null },
    dnd: { blockCalls: !(r.dnd && r.dnd.blockCalls === false), providerOn: !!(r.dnd && r.dnd.providerOn === true) },
    consent: { requireForCampaigns: !!(r.consent && r.consent.requireForCampaigns === true) },
    fiscal: { startMonth: sm >= 1 && sm <= 12 ? sm : 4, holidays },
    branding: { color: /^#[0-9a-f]{6}$/i.test(String(br.color || '')) ? br.color : DEFAULTS.branding.color, logo: br.logo && typeof br.logo === 'object' ? { stored: s(br.logo.stored, 300), mime: s(br.logo.mime, 60), name: s(br.logo.name, 120) } : null, tagline: s(br.tagline, 120) },
    locale: { numbers: ['en-IN', 'en-US', 'en-GB'].includes(r.locale && r.locale.numbers) ? r.locale.numbers : 'en-IN' },
    enrich: { on: !(r.enrich && r.enrich.on === false) },
  };
}
let cached = null; let cachedAt = 0;
async function config({ fresh = false } = {}) {
  if (!fresh && cached && Date.now() - cachedAt < 10000) return cached;
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } }).catch(() => null);
  cached = cleanConfig(parse(row && row.value, {}));
  cachedAt = Date.now();
  return cached;
}
async function saveConfig(patch) {
  const was = await config({ fresh: true });
  const next = cleanConfig({ ...was, ...(patch || {}) });
  const value = JSON.stringify(next);
  await prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
  cached = next; cachedAt = Date.now();
  return next;
}
const current = () => cached || cleanConfig({});

module.exports = { ensure, READY, all, one, run, nowIso, newId, parse, config, saveConfig, current, cleanConfig, DEFAULTS, MONTHS, CAPTURE_SOURCES, PULL_SOURCES };
