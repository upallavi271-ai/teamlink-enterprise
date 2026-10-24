// ---------------------------------------------------------------------------
// OMNI-CHANNEL OUTREACH: the store. Plain SQL over the Outreach* tables (migration 20261014100000_outreach_core), feature-detected
// like utils/conversations.js: until the migration is applied ready() is false and the screens say "being set up".
//   settings   AppSetting 'outreach.settings'   { master, emailTestMode (DEFAULT ON), emailDailyCap, fromName, replyTo }
//   industries AppSetting 'outreach.industries' [{ name, department }]  Medical, BDE, Education, Manufacturing + whatever Admin adds
// Outreach is an OUTREACH LAYER ONLY: it never creates an ATS candidate.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');

const q = (sql, ...p) => prisma.$queryRawUnsafe(sql, ...p);
const run = (sql, ...p) => prisma.$executeRawUnsafe(sql, ...p);
const num = (v) => (typeof v === 'bigint' ? Number(v) : (v == null ? 0 : Number(v)));
const ms = (v) => { if (v == null) return null; if (v instanceof Date) return v.getTime(); const n = typeof v === 'bigint' ? Number(v) : v; return typeof n === 'number' ? n : (Date.parse(n) || null); };
const iso = (v) => { const t = ms(v); return t ? new Date(t).toISOString() : null; };
const newId = (p) => `${p}${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}`;
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

// ---- the tables exist? --------------------------------------------------------
const TABLES = ['OutreachContact', 'OutreachContactTag', 'OutreachContactChannel', 'OutreachConsentEvent', 'OutreachSuppression', 'OutreachImport', 'OutreachSegment', 'OutreachTemplate', 'OutreachSendLog'];
let readyAt = 0;
let readyVal = false;
async function ready() {
  const age = Date.now() - readyAt;
  if (readyAt && age < (readyVal ? 60000 : 3000)) return readyVal;
  try {
    const t = await q(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${TABLES.map(() => '?').join(',')})`, ...TABLES);
    readyVal = t.length === TABLES.length;
  } catch { readyVal = false; }
  readyAt = Date.now();
  return readyVal;
}
function resetReady() { readyAt = 0; }
// the Phase 3 tables (campaigns, queue, events): a separate check so Phase 1-2 keeps working before that migration is applied
const P3_TABLES = ['OutreachCampaign', 'OutreachMessage', 'OutreachEvent', 'OutreachWebhookReceipt', 'OutreachRunnerLease'];
let p3At = 0;
let p3Val = false;
async function campaignsReady() {
  const age = Date.now() - p3At;
  if (p3At && age < (p3Val ? 60000 : 3000)) return p3Val;
  try {
    const t = await q(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${P3_TABLES.map(() => '?').join(',')})`, ...P3_TABLES);
    p3Val = t.length === P3_TABLES.length && (await ready());
  } catch { p3Val = false; }
  p3At = Date.now();
  return p3Val;
}

// the quick-wins tables (campaign notes, import row results): a separate check, so everything else works before that migration is applied
const QW_TABLES = ['OutreachCampaignNote', 'OutreachImportRow'];
let qwAt = 0;
let qwVal = false;
async function quickReady() {
  const age = Date.now() - qwAt;
  if (qwAt && age < (qwVal ? 60000 : 3000)) return qwVal;
  try {
    const t = await q(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${QW_TABLES.map(() => '?').join(',')})`, ...QW_TABLES);
    qwVal = t.length === QW_TABLES.length;
  } catch { qwVal = false; }
  qwAt = Date.now();
  return qwVal;
}

// ---- keys (one derivation, separate labels: link tokens, unsubscribe tokens, address hashes) ----------
function keyFor(label) {
  const ikm = process.env.OUTREACH_LINK_KEY || process.env.INTEGRATION_SECRET_KEY || process.env.JWT_SECRET;
  if (!ikm) { const e = new Error('No secret key is configured for Outreach tokens (set INTEGRATION_SECRET_KEY).'); e.code = 'NO_SECRET_KEY'; throw e; }
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(String(ikm)), Buffer.from('teamlink.outreach'), Buffer.from(label), 32));
}
// the do-not-contact registry holds this, never the address
function hashAddress(kind, value) {
  const v = kind === 'phone' ? String(value || '').replace(/\D/g, '').slice(-10) : String(value || '').trim().toLowerCase();
  if (!v) return null;
  return crypto.createHmac('sha256', keyFor('outreach.hash.v1')).update(`${kind}|${v}`).digest('hex');
}

// ---- settings ---------------------------------------------------------------------------
// Phase 3 adds: master = the "Outreach sending" switch (default OFF: nothing is sent, not even a rehearsal, until an Admin switches it on),
// suppressDays = do not message the same person about the SAME job again within N days, emailPerMinute = the sending speed,
// internalHrMaySend = the HR desk may send internal campaigns (default off).
// 2026-10-14 (layout pass): quietHours (OFF by default, see quiet.js) and the sender details shown on previews (From email, WhatsApp number, SMS sender ID + DLT entity ID; see sender.js).
const DEFAULT_SETTINGS = { master: false, emailTestMode: true, emailDailyCap: 50, fromName: '', replyTo: '', suppressDays: 7, emailPerMinute: 30, waDailyCap: 250, smsDailyCap: 500, waPerMinute: 30, smsPerMinute: 60, internalHrMaySend: false, fromEmail: '', whatsappNumber: '', smsSenderId: '', smsDltEntityId: '', quietHours: { enabled: false, start: '21:00', end: '08:00', applyInternal: false } };
const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
async function getKey(key, d = null) {
  const row = await prisma.appSetting.findUnique({ where: { key } }).catch(() => null);
  return row ? parse(row.value, d) : d;
}
async function putKey(key, value, user) {
  const v = JSON.stringify(value);
  const who = user ? { updatedById: user.id, updatedByName: user.name } : {};
  await prisma.appSetting.upsert({ where: { key }, create: { key, value: v, ...who }, update: { value: v, ...who } });
  return value;
}
const whole = (v, d, max) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : d; };
async function settings() {
  const s = await getKey('outreach.settings', {});
  const cap = Math.floor(Number(s.emailDailyCap));
  return {
    ...DEFAULT_SETTINGS, ...s,
    // test mode is ON unless an Admin has explicitly switched it off
    emailTestMode: s.emailTestMode === false ? false : true,
    master: s.master === true,
    internalHrMaySend: s.internalHrMaySend === true,
    quietHours: require('./quiet').normalize(s.quietHours), // eslint-disable-line global-require
    suppressDays: Number.isFinite(Math.floor(Number(s.suppressDays))) && Math.floor(Number(s.suppressDays)) >= 0 ? Math.min(Math.floor(Number(s.suppressDays)), 365) : DEFAULT_SETTINGS.suppressDays,
    emailPerMinute: Number.isFinite(Math.floor(Number(s.emailPerMinute))) && Math.floor(Number(s.emailPerMinute)) > 0 ? Math.min(Math.floor(Number(s.emailPerMinute)), 600) : DEFAULT_SETTINGS.emailPerMinute,
    emailDailyCap: Number.isFinite(cap) && cap >= 0 ? Math.min(cap, 100000) : DEFAULT_SETTINGS.emailDailyCap,
    // v3: WhatsApp and SMS campaigns have their own day limit and speed (the Email ones above are unchanged)
    waDailyCap: whole(s.waDailyCap, DEFAULT_SETTINGS.waDailyCap, 100000), smsDailyCap: whole(s.smsDailyCap, DEFAULT_SETTINGS.smsDailyCap, 100000),
    waPerMinute: Math.max(1, whole(s.waPerMinute, DEFAULT_SETTINGS.waPerMinute, 600)), smsPerMinute: Math.max(1, whole(s.smsPerMinute, DEFAULT_SETTINGS.smsPerMinute, 600)),
  };
}
const saveSettings = (s, user) => putKey('outreach.settings', s, user);

// ---- industries (segment kinds) -------------------------------------------------------------
const DEFAULT_INDUSTRIES = [
  { name: 'Medical', department: 'Medical' },
  { name: 'BDE', department: 'BDE' },
  { name: 'Education', department: 'Education' },
  { name: 'Manufacturing', department: 'Manufacturing' },
];
async function industries() {
  const list = await getKey('outreach.industries', null);
  return Array.isArray(list) && list.length ? list : DEFAULT_INDUSTRIES;
}
async function addIndustry(name, department, user) {
  const n = clip(name, 40);
  if (n.length < 2) return { error: 'Type the name of the kind (at least 2 letters).', status: 400 };
  const list = await industries();
  if (list.some((i) => i.name.toLowerCase() === n.toLowerCase())) return { error: `"${n}" is already in the list.`, status: 409 };
  const next = [...list, { name: n, department: clip(department, 40) || n }];
  await putKey('outreach.industries', next, user);
  return { industries: next };
}
// the canonical (listed) name for what a file says ("medical " -> "Medical"); null when it is not listed
async function canonicalIndustry(raw, list) {
  const l = list || (await industries());
  const t = String(raw || '').trim().toLowerCase();
  const hit = l.find((i) => i.name.toLowerCase() === t);
  return hit ? hit.name : null;
}

class OutreachError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

module.exports = {
  q, run, num, ms, iso, newId, clip, ready, resetReady, campaignsReady, quickReady, keyFor, hashAddress, getKey, putKey, settings, saveSettings, DEFAULT_SETTINGS,
  industries, addIndustry, canonicalIndustry, DEFAULT_INDUSTRIES, OutreachError, parse,
};
