// ---------------------------------------------------------------------------
// CRM WAVE E (2026-11-24, founder "Yes, build to 90%"): AI, mobile, activities & follow-ups. The shared base of
//   crm/aiPredict.js    the learned lead score / deal win chance (09.01, 09.02) and the AI revenue forecast (09.07)
//   crm/aiSignals.js    sentiment / intent (09.10), fields read from a mail / card / call (09.12, 14.04), unusual changes (09.13),
//                       call summaries and the recorded browser calls of a lead (09.05)
//   crm/workPlus.js     repeating follow-ups (05.08), a video meeting per booking (05.11), field visits with location (05.12),
//                       the phone call with its measured length (14.05)
//   crm/calendarSync.js Google / Microsoft calendars both ways (05.04)
//
// Same pattern as crm/schema.js: raw SQL tables created the first time anything needs them; columns added once ("duplicate column" is
// the normal answer afterwards). ADDITIVE ONLY. The switches live in one AppSetting row ('crm.plus'): everything that writes by itself or
// connects an outside account is OFF until an Admin turns it on.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const DB = require('./schema');
const S = require('./service');

const DDL = [
  // a learned model (logistic regression over the CRM's own closed leads / deals): weights, the feature scales, how good it was
  `CREATE TABLE IF NOT EXISTS "CrmModel" (
    "kind" TEXT NOT NULL PRIMARY KEY,
    "json" TEXT NOT NULL,
    "samples" INTEGER NOT NULL DEFAULT 0,
    "trainedAt" TEXT NOT NULL
  )`,
  // a field visit: checked in (where, when) at a lead / deal / account, checked out (where, what came of it)
  `CREATE TABLE IF NOT EXISTS "CrmVisit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL, "userName" TEXT,
    "recordKind" TEXT NOT NULL, "recordId" TEXT NOT NULL, "recordName" TEXT,
    "leadId" TEXT, "dealId" TEXT, "accountId" TEXT,
    "inAt" TEXT NOT NULL, "inLat" REAL, "inLng" REAL, "inAcc" REAL,
    "outAt" TEXT, "outLat" REAL, "outLng" REAL, "outAcc" REAL,
    "outcome" TEXT, "note" TEXT, "activityId" TEXT,
    "createdAt" TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS "CrmVisit_user" ON "CrmVisit"("userId", "inAt")',
  'CREATE INDEX IF NOT EXISTS "CrmVisit_record" ON "CrmVisit"("recordId")',
  // a person's calendar (Google / Microsoft) joined to the CRM: tokens encrypted (utils/secrets.js), never sent to the browser
  `CREATE TABLE IF NOT EXISTS "CrmCalendarLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL, "provider" TEXT NOT NULL,
    "email" TEXT, "accessEnc" TEXT, "refreshEnc" TEXT, "expiresAt" TEXT,
    "calendarId" TEXT, "syncedAt" TEXT, "lastError" TEXT,
    "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "CrmCalendarLink_one" ON "CrmCalendarLink"("userId", "provider")',
  // one calendar event: made from a CRM follow-up (direction 'out', taskId) or read from the person's calendar (direction 'in')
  `CREATE TABLE IF NOT EXISTS "CrmCalendarEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL, "provider" TEXT NOT NULL, "eventId" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'out', "taskId" TEXT,
    "title" TEXT, "startAt" TEXT, "endAt" TEXT, "attendees" TEXT, "leadId" TEXT, "contactId" TEXT,
    "remoteUpdated" TEXT, "deleted" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "CrmCalendarEvent_one" ON "CrmCalendarEvent"("userId", "provider", "eventId")',
  'CREATE INDEX IF NOT EXISTS "CrmCalendarEvent_task" ON "CrmCalendarEvent"("taskId")',
];
const COLUMNS = [
  // a repeating follow-up: daily | weekdays | weekly | fortnightly | monthly | quarterly, until a date; the next one points back
  ['CrmTask', 'repeatRule', 'TEXT'], ['CrmTask', 'repeatUntil', 'TEXT'], ['CrmTask', 'repeatFromId', 'TEXT'],
  // the video meeting made for a Meeting follow-up (Zoom / Google Meet / Microsoft Teams)
  ['CrmTask', 'meetingUrl', 'TEXT'], ['CrmTask', 'meetingProvider', 'TEXT'], ['CrmTask', 'meetingRef', 'TEXT'],
  // a timeline line made from a call: how long it was (seconds)
  ['CrmActivity', 'durationSec', 'INTEGER'],
];

let ready = null;
function ensure() {
  if (ready) return ready;
  ready = (async () => {
    await DB.ensure();
    for (const sql of DDL) await prisma.$executeRawUnsafe(sql); // eslint-disable-line no-await-in-loop
    for (const [t, c, type] of COLUMNS) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.$executeRawUnsafe(`ALTER TABLE "${t}" ADD COLUMN "${c}" ${type}`).catch((e) => { if (!/duplicate column/i.test(e.message)) throw e; });
    }
    return true;
  })().catch((err) => { ready = null; console.error('[crm plus] schema:', err.message); return false; }); // eslint-disable-line no-console
  return ready;
}
async function all(sql, ...p) { await ensure(); return DB.all(sql, ...p); }
async function one(sql, ...p) { const r = await all(sql, ...p); return r[0] || null; }
async function run(sql, ...p) { await ensure(); return DB.run(sql, ...p); }

// ---- the switches ------------------------------------------------------------------------------------------------------------
const KEY = 'crm.plus';
const DEFAULTS = {
  calendarSync: false, // people may join their Google / Microsoft calendar; follow-ups go there and moves come back (every 10 minutes)
  autoLinkCalls: false, // a recorded browser call to a CRM phone number is written on that lead's timeline by itself
  anomalyAlerts: false, // Monday 10:00: a bell to the Sales managers when the team's numbers changed unusually last week
  offlineCopy: true, // the phone keeps a copy of the CRM lists the person opened, to read without signal (pure screen feature)
  visitNeedsLocation: false, // a field visit check-in must share the phone's location
  videoProvider: '', // the default for "Create video meeting": zoom | meet | teams ('' = ask)
  meetingMinutes: 30,
};
let cache = null; let cacheAt = 0;
async function settings({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cacheAt < 15000) return cache;
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } }).catch(() => null);
  let raw = {};
  try { raw = row ? JSON.parse(row.value) : {}; } catch { raw = {}; }
  cache = normalize(raw); cacheAt = Date.now();
  return cache;
}
function normalize(raw = {}) {
  const b = (k) => (raw[k] === undefined ? DEFAULTS[k] : raw[k] === true || raw[k] === 'true' || raw[k] === 1);
  const mins = Number(raw.meetingMinutes);
  return {
    calendarSync: b('calendarSync'), autoLinkCalls: b('autoLinkCalls'), anomalyAlerts: b('anomalyAlerts'), offlineCopy: b('offlineCopy'), visitNeedsLocation: b('visitNeedsLocation'),
    videoProvider: ['zoom', 'meet', 'teams'].includes(raw.videoProvider) ? raw.videoProvider : '',
    meetingMinutes: [15, 30, 45, 60, 90].includes(mins) ? mins : DEFAULTS.meetingMinutes,
  };
}
const SWITCH_WORDS = { calendarSync: 'Calendar sync', autoLinkCalls: 'Recorded calls written on the timeline by themselves', anomalyAlerts: 'Weekly unusual-change alert', offlineCopy: 'Offline copy on the phone', visitNeedsLocation: 'Visits need the location' };
async function getSettings(user) {
  const r = S.roleOf(user);
  if (!r) return S.fail(403, 'No CRM access.');
  return S.okBody({ settings: await settings(), canChange: r === 'admin', canSee: r === 'admin' || r === 'tl' });
}
// Only a Super Admin / Admin turns these on or off (founder rule: anything automatic is the Admin's switch).
async function saveSettings(user, body = {}) {
  if (S.roleOf(user) !== 'admin') return S.fail(403, 'Only an Admin changes these switches.');
  const cur = await settings({ fresh: true });
  const next = normalize({ ...cur, ...body });
  await prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: JSON.stringify(next) }, update: { value: JSON.stringify(next) } });
  cache = next; cacheAt = Date.now();
  Object.keys(SWITCH_WORDS).filter((k) => cur[k] !== next[k]).forEach((k) => S.audit(user, `CRM: ${SWITCH_WORDS[k]} turned ${next[k] ? 'on' : 'off'}`, 'AppSetting', KEY, String(next[k])));
  return S.okBody({ settings: next });
}

// ---- small shared helpers ----------------------------------------------------------------------------------------------------
const TABLE = { lead: 'CrmLead', deal: 'CrmDeal', account: 'CrmAccount', contact: 'CrmContact' };
const NAME = { lead: 'company', deal: 'title', account: 'name', contact: 'name' };
const last10 = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; };
// a record this login may read ({ row } | { error })
async function readable(user, kind, id) {
  if (!TABLE[kind]) return { error: S.fail(404, 'Nothing to read here.') };
  const row = await S.getRow(kind, String(id || ''));
  if (!S.canSeeRow(user, S.roleOf(user), row)) return { error: S.fail(404, 'That record is not there, or it is not yours.') };
  return { row };
}
async function editable(user, kind, id) {
  if (!TABLE[kind]) return { error: S.fail(404, 'Nothing to change here.') };
  const row = await S.getRow(kind, String(id || ''));
  if (!S.canEditRow(user, S.roleOf(user), row)) return { error: S.fail(404, 'That record is not there, or it is not yours.') };
  return { row };
}
// every phone number of a record (the lead's, its contacts', the account's), as the last 10 digits
async function phonesOf(kind, row) {
  const out = new Set([last10(row.phone)]);
  const accountId = kind === 'account' ? row.id : row.accountId;
  if (accountId) {
    const acc = kind === 'account' ? row : await DB.one('SELECT "phone" FROM "CrmAccount" WHERE "id" = ?', accountId).catch(() => null);
    if (acc) out.add(last10(acc.phone));
    (await DB.all('SELECT "phone" FROM "CrmContact" WHERE "accountId" = ?', accountId).catch(() => [])).forEach((c) => out.add(last10(c.phone)));
  }
  if (kind === 'deal' && row.contactId) { const c = await DB.one('SELECT "phone" FROM "CrmContact" WHERE "id" = ?', row.contactId).catch(() => null); if (c) out.add(last10(c.phone)); }
  if (kind === 'contact') out.add(last10(row.phone));
  out.delete('');
  return [...out];
}

module.exports = { ensure, all, one, run, settings, getSettings, saveSettings, DEFAULTS, TABLE, NAME, last10, readable, editable, phonesOf };
