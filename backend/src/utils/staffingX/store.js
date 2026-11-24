// ---------------------------------------------------------------------------
// CONTRACT STAFFING ON THE ATS SIDE (ATS wave 2, builder X, founder 2026-11-25: "push ATS to 95+").
// The tables and switches of utils/staffingX/*.js: raw SQL, created on first use (the recycleBin.js pattern), never a Prisma migration.
//
//   StfContract   one row per placed contractor (an Application at JOINED / HIRED): dates, PO, approver, hours a week, how they are paid
//   StfRate       pay rate / bill rate history with the date each one starts (a timesheet uses the rate of its week)
//   StfTimesheet  one week of hours per contractor: Draft > Submitted > Approved / Rejected; the money is worked out on approval
//   StfShift      shifts booked (or open) for temp staff, with conflict checks
//   StfBatch      an invoice-READY batch of approved timesheets for one client: an export file and an optional signed push.
//                 It is NOT an invoice in Accounts: posting into Accounts needs a founder decision (nothing here touches Accounts).
//   StfVmsJob / StfVmsSub / StfVmsLog   the VMS connector's jobs pulled in, candidates sent, and every call made
//
// Every switch that tells people something or automates work starts OFF (the founder turns it on).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../../db');

const TABLES = [
  'CREATE TABLE IF NOT EXISTS "StfSetting" ("key" TEXT PRIMARY KEY, "value" TEXT, "byId" TEXT, "byName" TEXT, "at" TEXT)',
  `CREATE TABLE IF NOT EXISTS "StfContract" ("applicationId" TEXT PRIMARY KEY, "candidateId" TEXT, "requirementId" TEXT, "clientId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Active', "startOn" TEXT, "endOn" TEXT, "poNumber" TEXT, "costCentre" TEXT, "approverName" TEXT,
    "weeklyHours" REAL, "payType" TEXT, "vmsWorkerId" TEXT, "notes" TEXT, "byName" TEXT, "at" TEXT)`,
  `CREATE TABLE IF NOT EXISTS "StfRate" ("id" TEXT PRIMARY KEY, "applicationId" TEXT NOT NULL, "effectiveFrom" TEXT NOT NULL, "unit" TEXT NOT NULL,
    "payRate" REAL, "billRate" REAL, "otPay" REAL, "otBill" REAL, "loadPercent" REAL, "currency" TEXT, "reason" TEXT, "byName" TEXT, "at" TEXT)`,
  'CREATE INDEX IF NOT EXISTS "StfRate_app" ON "StfRate" ("applicationId", "effectiveFrom")',
  `CREATE TABLE IF NOT EXISTS "StfTimesheet" ("id" TEXT PRIMARY KEY, "applicationId" TEXT NOT NULL, "clientId" TEXT, "weekStart" TEXT NOT NULL,
    "hours" TEXT NOT NULL, "note" TEXT, "status" TEXT NOT NULL DEFAULT 'Draft', "totalHours" REAL, "regHours" REAL, "otHours" REAL, "daysWorked" INTEGER,
    "submittedByKind" TEXT, "submittedById" TEXT, "submittedByName" TEXT, "submittedAt" TEXT,
    "decidedByKind" TEXT, "decidedById" TEXT, "decidedByName" TEXT, "decidedAt" TEXT, "rejectReason" TEXT,
    "rateId" TEXT, "payAmount" REAL, "costAmount" REAL, "billAmount" REAL, "batchId" TEXT, "createdAt" TEXT, "updatedAt" TEXT,
    UNIQUE ("applicationId", "weekStart"))`,
  'CREATE INDEX IF NOT EXISTS "StfTimesheet_status" ON "StfTimesheet" ("status", "weekStart")',
  `CREATE TABLE IF NOT EXISTS "StfShift" ("id" TEXT PRIMARY KEY, "applicationId" TEXT, "clientId" TEXT NOT NULL, "requirementId" TEXT, "day" TEXT NOT NULL,
    "start" TEXT NOT NULL, "end" TEXT NOT NULL, "role" TEXT, "location" TEXT, "status" TEXT NOT NULL DEFAULT 'Open', "note" TEXT,
    "notifiedAt" TEXT, "byName" TEXT, "at" TEXT)`,
  'CREATE INDEX IF NOT EXISTS "StfShift_day" ON "StfShift" ("day")',
  `CREATE TABLE IF NOT EXISTS "StfBatch" ("id" TEXT PRIMARY KEY, "number" TEXT UNIQUE, "clientId" TEXT NOT NULL, "clientName" TEXT, "fromWeek" TEXT, "toWeek" TEXT,
    "lines" INTEGER, "hours" REAL, "billTotal" REAL, "payTotal" REAL, "costTotal" REAL, "gstPercent" REAL, "gstAmount" REAL, "grandTotal" REAL,
    "status" TEXT NOT NULL DEFAULT 'Ready', "override" TEXT, "pushedAt" TEXT, "pushResult" TEXT, "byId" TEXT, "byName" TEXT, "at" TEXT)`,
  `CREATE TABLE IF NOT EXISTS "StfVmsJob" ("id" TEXT PRIMARY KEY, "system" TEXT NOT NULL, "externalId" TEXT NOT NULL, "title" TEXT, "clientName" TEXT,
    "location" TEXT, "openings" INTEGER, "maxBillRate" REAL, "startOn" TEXT, "endOn" TEXT, "description" TEXT, "skills" TEXT, "vmsStatus" TEXT,
    "requirementId" TEXT, "clientId" TEXT, "state" TEXT NOT NULL DEFAULT 'New', "firstSeenAt" TEXT, "lastSeenAt" TEXT, "importedByName" TEXT, "importedAt" TEXT,
    UNIQUE ("system", "externalId"))`,
  `CREATE TABLE IF NOT EXISTS "StfVmsSub" ("id" TEXT PRIMARY KEY, "system" TEXT NOT NULL, "applicationId" TEXT NOT NULL, "vmsJobId" TEXT NOT NULL,
    "externalId" TEXT, "billRate" REAL, "vmsStatus" TEXT, "plainStatus" TEXT, "sentByName" TEXT, "sentAt" TEXT, "checkedAt" TEXT, "error" TEXT,
    UNIQUE ("applicationId", "vmsJobId"))`,
  `CREATE TABLE IF NOT EXISTS "StfVmsLog" ("id" TEXT PRIMARY KEY, "at" TEXT NOT NULL, "system" TEXT, "action" TEXT, "ok" INTEGER, "status" INTEGER,
    "detail" TEXT, "byName" TEXT)`,
];

let READY = null;
function ensure() {
  if (!READY) {
    READY = (async () => {
      for (const sql of TABLES) await prisma.$executeRawUnsafe(sql); // eslint-disable-line no-await-in-loop
    })().catch((e) => { READY = null; throw e; });
  }
  return READY;
}

const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID();
const parse = (s, d = null) => { if (s == null || s === '') return d; try { return JSON.parse(s); } catch { return d; } };
const clean = (v, max = 300) => { const s = String(v == null ? '' : v).replace(/<[^>]*>/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim(); return s ? s.slice(0, max) : null; };
const q = (sql, ...args) => ensure().then(() => prisma.$queryRawUnsafe(sql, ...args));
const x = (sql, ...args) => ensure().then(() => prisma.$executeRawUnsafe(sql, ...args));
const num = (v) => (typeof v === 'bigint' ? Number(v) : Number(v || 0));
const money = (v) => Math.round((Number(v) || 0) * 100) / 100;
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const n = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const inList = (sql, list) => sql.replace('(?)', `(${list.map(() => '?').join(',') || 'NULL'})`);
const isSandbox = () => require('../sandbox').isSandbox(); // eslint-disable-line global-require

// Monday of the week a date falls in (YYYY-MM-DD, UTC)
function mondayOf(v) {
  const d = new Date(`${String(v || '').slice(0, 10) || new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
function addDays(day, k) { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); }

// ---- the switches (Contract staff > Settings; Super Admin / Admin) ------------------------------------------------------------
const SWITCHES = {
  'timesheets.reminders': { type: 'bool', def: false, label: 'Timesheet reminders', note: 'When ON, every Monday each active contractor with no timesheet for last week gets a bell in their portal, and so does their recruiter. OFF: nobody is reminded.' },
  'timesheets.notifyApprovers': { type: 'bool', def: false, label: 'Bell to the approver when a timesheet comes in', note: 'When ON, the client logins that approve (or the team lead of the job) get a bell when a week is submitted. OFF: they see it in their list.' },
  'approval.mode': { type: 'choice', def: 'client_or_tl', choices: [['client_or_tl', 'The client or a TeamLink team lead'], ['client', 'The client only'], ['tl', 'A TeamLink team lead only']], label: 'Who approves timesheets', note: 'The person who entered a timesheet can never approve it.' },
  'shifts.notify': { type: 'bool', def: false, label: 'Tell contractors about their shifts', note: 'When ON, booking or cancelling a shift puts a bell in the contractor\'s portal and their recruiter\'s. OFF: nobody is told.' },
  'week.hours': { type: 'number', def: 48, label: 'Standard hours a week', note: 'Hours above this in one week are overtime (a contractor can have their own number).' },
  'margin.min': { type: 'number', def: 10, label: 'Lowest healthy margin (%)', note: 'The billing check warns when a placement earns less than this share of the bill.' },
  'billing.homeGstin': { type: 'text', def: '', label: 'Our GSTIN (for CGST + SGST or IGST)', note: "The company's own GSTIN. With it, the export splits the GST by state; without it, the GST is one line and the accounts team picks the type." },
  'billing.sac': { type: 'text', def: '998513', label: 'SAC code on the billing lines', note: 'The GST service code for contract staffing (998513 unless your accountant says otherwise).' },
  'vms.sync': { type: 'bool', def: false, label: 'VMS sync every 30 minutes', note: 'When ON, new jobs are read from the VMS and the status of every candidate sent is checked every 30 minutes. OFF: only the "Read jobs now" and "Check status" buttons do it.' },
  'vms.autoImport': { type: 'bool', def: false, label: 'VMS jobs become requirement requests by themselves', note: 'When ON (with VMS sync), a new VMS job for a known client is filed as a requirement request for its BDE, the same way a client portal request is. OFF: a person presses "File as requirement request".' },
  'accounting.autoPush': { type: 'bool', def: false, label: 'Send each new billing batch to the accounting address', note: 'When ON, every new invoice-ready batch is sent to the address in Administration > Integrations > Accounting push. OFF: a person presses "Send". Nothing is ever written into TeamLink Accounts.' },
};
let cache = null; let cachedAt = 0;
async function settings({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cachedAt < 5000) return cache;
  const rows = await q('SELECT "key","value","byId" FROM "StfSetting"');
  const out = {};
  Object.entries(SWITCHES).forEach(([k, d]) => { out[k] = d.def; });
  rows.forEach((r) => {
    const d = SWITCHES[r.key];
    if (!d) { out[r.key] = r.value; return; }
    out[r.key] = d.type === 'bool' ? r.value === '1' : d.type === 'number' ? Number(r.value) || 0 : r.value;
    if (r.byId) out[`${r.key}.byId`] = r.byId;
  });
  cache = out; cachedAt = Date.now();
  return out;
}
async function setting(key) { return (await settings())[key]; }
async function saveSetting(key, value, user) {
  const d = SWITCHES[key];
  let v;
  if (!d) v = String(value == null ? '' : value).slice(0, 4000);
  else if (d.type === 'bool') v = value === true || value === 1 || value === '1' || value === 'true' ? '1' : '0';
  else if (d.type === 'number') v = String(Math.max(0, Math.min(1000, Number(value) || 0)));
  else if (d.type === 'text') v = clean(value, 60) || '';
  else if (d.type === 'choice') { if (!d.choices.some(([k]) => k === value)) return { error: 'Pick one of the choices.' }; v = String(value); }
  await x('INSERT INTO "StfSetting" ("key","value","byId","byName","at") VALUES (?,?,?,?,?) ON CONFLICT("key") DO UPDATE SET "value"=excluded."value","byId"=excluded."byId","byName"=excluded."byName","at"=excluded."at"',
    key, v, user ? user.id : null, user ? user.name : null, now());
  cache = null;
  return { value: (await settings({ fresh: true }))[key] };
}
const switchList = (values) => Object.entries(SWITCHES).map(([key, d]) => ({ key, ...d, value: values[key] }));

// file helpers (the same rules as the other ATS exports): XML text escaped; a CSV text cell that starts like a formula is made harmless
function xml(v) {
  // eslint-disable-next-line no-control-regex
  return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function csvCell(v, isText = true) {
  let s = v == null ? '' : String(v);
  if (isText && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function vmsLog(system, action, ok, status, detail, byName) {
  await x('INSERT INTO "StfVmsLog" ("id","at","system","action","ok","status","detail","byName") VALUES (?,?,?,?,?,?,?,?)',
    newId(), now(), system || null, action, ok ? 1 : 0, status || 0, clean(detail, 400), byName || null).catch(() => {});
}

module.exports = {
  ensure, now, newId, parse, clean, q, x, num, money, isDate, n, inList, isSandbox, mondayOf, addDays,
  SWITCHES, settings, setting, saveSetting, switchList, vmsLog, xml, csvCell,
};
