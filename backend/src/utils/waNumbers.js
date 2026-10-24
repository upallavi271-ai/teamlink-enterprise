// ---------------------------------------------------------------------------
// MANY WHATSAPP NUMBERS (2026-10-21) - the Meta WhatsApp Cloud API, one company, several business numbers.
//
// META FACTS THIS FILE FOLLOWS
//   * One WhatsApp Business Account (WABA) can hold several phone numbers. Every number has its OWN phone_number_id: that id is what
//     POST /{phone_number_id}/messages uses, and it is the only thing that decides which number a message leaves from.
//   * Message TEMPLATES belong to the WABA, not to a number: all numbers of one WABA share them. A number of another WABA cannot use them.
//   * Every webhook call carries entry[].changes[].value.metadata.phone_number_id (+ display_phone_number), so an inbound message or a delivery
//     report can be tied to the right number. One Meta app has ONE app secret (the X-Hub-Signature-256 key) and ONE webhook URL for all of its
//     numbers; numbers of another app have another secret / verify token. So a number may carry its own app secret / verify token, and falls back
//     to the shared ones (the old WhatsApp Business form) when it has none.
//   * One system-user access token with whatsapp_business_messaging + whatsapp_business_management can serve every number of a WABA: a number
//     may "use the shared token" (the old form's token) or carry its own, stored encrypted.
//
// THE OLD SINGLE CONNECTION KEEPS WORKING, UNCHANGED
//   While the WaNumber table has NO rows (or does not exist yet) nothing here is active: every function answers "legacy" and the callers use
//   utils/whatsappCloud.js exactly as before. The existing connection (Administration > Integrations > WhatsApp Business) shows in the list as
//   "Main number (default)"; one click ("Move it into the list", or simply adding a second number) writes ONE row that still reads its
//   credentials from the old form - nothing is copied, nothing breaks. Tables are created only when an Admin presses a button (ensure()), never on a read.
//
// WHO MAY SEND FROM WHICH NUMBER (resolveSender, the one choke point; utils/whatsappCloud.js and channels/cloud.js call it)
//   a) the person chose a number: it must be one they are authorised for (else 403 NUMBER_NOT_ALLOWED) - nothing reaches Meta
//   b) else a chat that already exists with this person continues on ITS number (WhatsApp's 24-hour session belongs to one number)
//   c) else the person's one authorised number; with several: their department's number, then the default if they may use it
//   d) nobody assigned: 409 NO_WHATSAPP_NUMBER, nothing is sent
//   e) automatic messages (OTP, agreement links, reminders, notices: no person) use "System messages use" or the default number
//   f) a number that is switched off / not set up is never silently replaced; the Admin may tick "use the default number when the assigned one is down"
//   Admin / Super Admin may use every number unless the Admin switches that off.
// Secrets: tokens / app secrets / verify tokens are encrypted (utils/secrets.js, INTEGRATION_SECRET_KEY) in AppSetting 'wa.num.sec.<id>' and are
// returned by NO function that shapes a response.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const core = require('./messagingCore');
const SEC = require('./secrets');
const { logAudit } = require('./audit');

const q = (sql, ...p) => prisma.$queryRawUnsafe(sql, ...p);
const run = (sql, ...p) => prisma.$executeRawUnsafe(sql, ...p);
const wa = () => require('./whatsappCloud'); // eslint-disable-line global-require
const nowIso = () => new Date().toISOString();
const newId = (p) => `${p}_${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}`;
const num = (v) => (typeof v === 'bigint' ? Number(v) : (v == null ? 0 : Number(v)));
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const digitsOf = (v) => String(v || '').replace(/\D/g, '');
const SEC_PREFIX = 'wa.num.sec.';
const SETTINGS_KEY = 'wa.numbers.settings';
const UNKNOWN_PROVIDER = 'whatsapp.unknown-number';

// ---- the tables (created only by an Admin action: ensure()) ------------------------------------------------------------
const DDL = [
  `CREATE TABLE IF NOT EXISTS "WaNumber" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "label" TEXT NOT NULL,
    "displayNumber" TEXT NOT NULL,
    "displayDigits" TEXT NOT NULL,
    "phoneNumberId" TEXT NOT NULL,
    "wabaId" TEXT,
    "credSource" TEXT NOT NULL DEFAULT 'own',
    "tokenMode" TEXT NOT NULL DEFAULT 'own',
    "language" TEXT,
    "tplLink" TEXT,
    "tplOtp" TEXT,
    "tplBulk" TEXT,
    "active" INTEGER NOT NULL DEFAULT 1,
    "isDefault" INTEGER NOT NULL DEFAULT 0,
    "statusCode" TEXT NOT NULL DEFAULT 'unchecked',
    "statusText" TEXT,
    "checkedAt" TEXT,
    "qualityRating" TEXT,
    "verifiedName" TEXT,
    "webhookNote" TEXT,
    "removedAt" TEXT,
    "removedByName" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "WaNumber_phoneid" ON "WaNumber"("phoneNumberId") WHERE "removedAt" IS NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS "WaNumber_digits" ON "WaNumber"("displayDigits") WHERE "removedAt" IS NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS "WaNumber_one_default" ON "WaNumber"("isDefault") WHERE "isDefault" = 1 AND "removedAt" IS NULL',
  `CREATE TABLE IF NOT EXISTS "WaNumberAccess" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "numberId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "refLabel" TEXT,
    "grantedById" TEXT,
    "grantedByName" TEXT,
    "grantedAt" TEXT NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "WaNumberAccess_one" ON "WaNumberAccess"("numberId", "kind", "refId")',
  'CREATE INDEX IF NOT EXISTS "WaNumberAccess_ref" ON "WaNumberAccess"("kind", "refId")',
  `CREATE TABLE IF NOT EXISTS "WaThread" (
    "numberId" TEXT NOT NULL,
    "contact" TEXT NOT NULL,
    "personType" TEXT,
    "personId" TEXT,
    "personName" TEXT,
    "lastInboundAt" TEXT,
    "lastOutboundAt" TEXT,
    "lastMessageAt" TEXT NOT NULL,
    "inboundCount" INTEGER NOT NULL DEFAULT 0,
    "outboundCount" INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY ("numberId", "contact")
  )`,
  'CREATE INDEX IF NOT EXISTS "WaThread_contact" ON "WaThread"("contact", "lastMessageAt")',
  'CREATE INDEX IF NOT EXISTS "WaThread_person" ON "WaThread"("personType", "personId")',
  `CREATE TABLE IF NOT EXISTS "WaMessageMap" (
    "providerRef" TEXT NOT NULL PRIMARY KEY,
    "numberId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "contact" TEXT,
    "personType" TEXT,
    "personId" TEXT,
    "createdAt" TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS "WaMessageMap_number" ON "WaMessageMap"("numberId", "createdAt")',
  'CREATE INDEX IF NOT EXISTS "WaMessageMap_person" ON "WaMessageMap"("personType", "personId")',
];
const DDL_COUNT = DDL.length;

let ensured = null;
function ensure() {
  if (ensured) return ensured;
  ensured = (async () => {
    for (const sql of DDL) await run(sql); // eslint-disable-line no-await-in-loop
    tableCache = { at: 0, val: false }; bust();
    return true;
  })().catch((e) => { ensured = null; console.error('[wa-numbers] ensure:', e.message); throw e; }); // eslint-disable-line no-console
  return ensured;
}

// ---- read-only detection (never creates anything) ------------------------------------------------------------------------
let tableCache = { at: 0, val: false };
let cache = null; // { at, rows, access }
function bust() { cache = null; tableCache = { at: 0, val: false }; settingsCache = null; }
async function tableReady() {
  const age = Date.now() - tableCache.at;
  if (tableCache.at && age < (tableCache.val ? 60000 : 5000)) return tableCache.val;
  let ok = false;
  try {
    const t = await q("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('WaNumber','WaNumberAccess','WaThread','WaMessageMap')");
    ok = t.length === 4;
  } catch { ok = false; }
  tableCache = { at: Date.now(), val: ok };
  return ok;
}
// 30 seconds at most between a change and every request seeing it (save() calls bust(), so a save is seen at once in this process).
async function load() {
  if (cache && Date.now() - cache.at < 30000) return cache;
  if (!(await tableReady())) { cache = { at: Date.now(), rows: [], access: [] }; return cache; }
  const rows = await syncLegacyRow((await q('SELECT * FROM "WaNumber" WHERE "removedAt" IS NULL ORDER BY "createdAt", "id"')).map(norm));
  const access = rows.length ? await q('SELECT * FROM "WaNumberAccess" WHERE "numberId" IN (SELECT "id" FROM "WaNumber" WHERE "removedAt" IS NULL)') : [];
  cache = { at: Date.now(), rows, access };
  return cache;
}
// The Main number reads its connection from the old WhatsApp Business form. When an Admin changes the Phone number ID / number / account there,
// the list row follows (so replies for the new id are still routed to the Main number). Never throws.
async function syncLegacyRow(rows) {
  const lr = rows.find((r) => r.credSource === 'legacy');
  if (!lr) return rows;
  try {
    const legacy = await wa().legacyConfig();
    if (!legacy.phoneId) return rows;
    const display = cleanE164(legacy.display) || lr.displayNumber;
    const changed = legacy.phoneId !== String(lr.phoneNumberId) || (legacy.wabaId || '') !== (lr.wabaId || '') || digitsOf(display) !== lr.displayDigits;
    if (!changed) return rows;
    if (rows.some((r) => r.id !== lr.id && (String(r.phoneNumberId) === legacy.phoneId || r.displayDigits === digitsOf(display)))) return rows; // another row already has it: leave as is
    await run('UPDATE "WaNumber" SET "phoneNumberId" = ?, "wabaId" = ?, "displayNumber" = ?, "displayDigits" = ?, "statusCode" = ?, "statusText" = ?, "updatedAt" = ? WHERE "id" = ?',
      legacy.phoneId, legacy.wabaId || null, display, digitsOf(display), 'unchecked', 'The connection details were changed in the WhatsApp Business form: check the connection.', nowIso(), lr.id);
    return rows.map((r) => (r.id === lr.id ? { ...r, phoneNumberId: legacy.phoneId, wabaId: legacy.wabaId || null, displayNumber: display, displayDigits: digitsOf(display), statusCode: 'unchecked', statusText: 'The connection details were changed in the WhatsApp Business form: check the connection.' } : r));
  } catch { return rows; }
}
function norm(r) {
  return { ...r, active: !!num(r.active), isDefault: !!num(r.isDefault) };
}
async function hasNumbers() { return (await load()).rows.length > 0; }
async function listRows() { return (await load()).rows; }
async function getRow(id) { return (await load()).rows.find((r) => r.id === String(id || '')) || null; }
async function accessOf(numberId) { return (await load()).access.filter((a) => a.numberId === numberId); }
async function getRowFresh(id) {
  if (!(await tableReady())) return null;
  const r = (await q('SELECT * FROM "WaNumber" WHERE "id" = ? AND "removedAt" IS NULL', String(id || '')))[0];
  return r ? norm(r) : null;
}

// ---- company settings -----------------------------------------------------------------------------------------------------
let settingsCache = null;
const SETTINGS_DEFAULT = { systemNumberId: null, fallbackToDefault: false, adminsAllNumbers: true };
async function settings() {
  if (settingsCache && Date.now() - settingsCache.at < 30000) return settingsCache.val;
  let val = { ...SETTINGS_DEFAULT };
  try {
    const r = await prisma.appSetting.findUnique({ where: { key: SETTINGS_KEY } });
    if (r && r.value) val = { ...SETTINGS_DEFAULT, ...JSON.parse(r.value) };
  } catch { /* defaults */ }
  settingsCache = { at: Date.now(), val };
  return val;
}
async function saveSettings(user, b) {
  await ensure();
  const cur = await settings();
  const next = { ...cur };
  if (b.systemNumberId !== undefined) {
    if (b.systemNumberId) {
      const r = await getRowFresh(b.systemNumberId);
      if (!r || !r.active) return { error: 'Choose a number that is switched on.', status: 400 };
      next.systemNumberId = r.id;
    } else next.systemNumberId = null;
  }
  if (b.fallbackToDefault !== undefined) next.fallbackToDefault = b.fallbackToDefault === true;
  if (b.adminsAllNumbers !== undefined) next.adminsAllNumbers = b.adminsAllNumbers !== false;
  const v = JSON.stringify(next);
  await prisma.appSetting.upsert({ where: { key: SETTINGS_KEY }, create: { key: SETTINGS_KEY, value: v, updatedById: user.id, updatedByName: user.name }, update: { value: v, updatedById: user.id, updatedByName: user.name } });
  bust();
  const names = async (id) => { const r = id ? await getRowFresh(id) : null; return r ? r.label : 'the default number'; };
  await logAudit({ userId: user.id, actorName: user.name, action: 'WhatsApp numbers: company settings changed', entity: 'WaNumber', entityId: 'settings', fromValue: `System messages: ${await names(cur.systemNumberId)}; fall back: ${cur.fallbackToDefault ? 'yes' : 'no'}; admins all numbers: ${cur.adminsAllNumbers ? 'yes' : 'no'}`, toValue: `System messages: ${await names(next.systemNumberId)}; fall back: ${next.fallbackToDefault ? 'yes' : 'no'}; admins all numbers: ${next.adminsAllNumbers ? 'yes' : 'no'}` });
  return { ok: true, settings: next };
}

// ---- secrets (encrypted, server side only) ---------------------------------------------------------------------------------------
async function readSecrets(id) {
  const out = { token: '', appSecret: '', verifyToken: '', missingKey: false, has: { token: false, appSecret: false, verifyToken: false } };
  try {
    const r = await prisma.appSetting.findUnique({ where: { key: `${SEC_PREFIX}${id}` } });
    if (!r || !r.value) return out;
    const stored = JSON.parse(r.value);
    for (const k of ['token', 'appSecret', 'verifyToken']) {
      if (!stored[k]) continue; // eslint-disable-line no-continue
      out.has[k] = true;
      const plain = SEC.decryptSecret(stored[k]);
      if (plain === null) out.missingKey = true; else out[k] = plain;
    }
  } catch { /* none */ }
  return out;
}
// patch: undefined = keep, null = clear, string = set (encrypted)
async function writeSecrets(id, patch) {
  let stored = {};
  try { const r = await prisma.appSetting.findUnique({ where: { key: `${SEC_PREFIX}${id}` } }); if (r && r.value) stored = JSON.parse(r.value); } catch { stored = {}; }
  for (const k of ['token', 'appSecret', 'verifyToken']) {
    if (patch[k] === undefined) continue; // eslint-disable-line no-continue
    stored[k] = patch[k] === null || patch[k] === '' ? '' : SEC.encryptSecret(String(patch[k]).trim());
  }
  const v = JSON.stringify(stored);
  await prisma.appSetting.upsert({ where: { key: `${SEC_PREFIX}${id}` }, create: { key: `${SEC_PREFIX}${id}`, value: v }, update: { value: v } });
}
async function dropSecrets(id) { await prisma.appSetting.delete({ where: { key: `${SEC_PREFIX}${id}` } }).catch(() => {}); }

// ---- a number's connection details for the sender (same shape as whatsappConfig) ------------------------------------------
// Backend only. `token` must never reach a response.
async function configOf(ref) {
  const row = typeof ref === 'string' ? await getRow(ref) : ref;
  if (!row || row.removedAt) return null;
  const legacy = await wa().legacyConfig();
  const sec = await readSecrets(row.id);
  const problems = [];
  let cfg;
  if (row.credSource === 'legacy') {
    cfg = { ...legacy };
    // the old form says whether the connection is on; the list can switch the number off in addition
    if (!row.active) problems.push('This number is switched off.');
    cfg = { ...cfg, problems: [...legacy.problems, ...problems] };
  } else {
    const shared = row.tokenMode === 'shared';
    const token = shared ? legacy.token : sec.token;
    if (!row.phoneNumberId) problems.push('No Phone number ID.');
    if (sec.missingKey && !shared) problems.push('A token is stored but this server cannot decrypt it (INTEGRATION_SECRET_KEY missing or changed).');
    else if (!token) problems.push(shared ? 'The shared token is not saved yet (Administration > Integrations > WhatsApp Business).' : 'No access token for this number.');
    if (!row.active) problems.push('This number is switched off.');
    cfg = {
      phoneId: row.phoneNumberId,
      wabaId: row.wabaId || (shared ? legacy.wabaId : ''),
      display: row.displayNumber,
      token,
      appSecret: sec.appSecret || legacy.appSecret,
      verifyToken: sec.verifyToken || legacy.verifyToken,
      language: row.language || legacy.language || 'en',
      templates: { link: row.tplLink || legacy.templates.link, otp: row.tplOtp || legacy.templates.otp, bulk: row.tplBulk || legacy.templates.bulk },
      base: legacy.base,
      testMode: legacy.testMode,
      configured: problems.length === 0,
      problems,
      reason: problems.join(' '),
    };
  }
  cfg.configured = cfg.problems.length === 0;
  cfg.reason = cfg.problems.join(' ');
  cfg.numberId = row.id;
  cfg.label = row.label;
  cfg.isDefault = row.isDefault;
  return cfg;
}
async function defaultRow() {
  const rows = await listRows();
  return rows.find((r) => r.isDefault) || null;
}
async function defaultConfig() {
  const d = await defaultRow();
  return d ? configOf(d) : null;
}

// ---- who a person is, for access checks ---------------------------------------------------------------------------------------------
const canon = (name) => {
  try { return String(require('./bdeDesk').canonicalDepartment(name) || name || '').trim().toLowerCase(); } catch { return String(name || '').trim().toLowerCase(); } // eslint-disable-line global-require
};
function departmentsOfUser(u) {
  const out = new Set();
  const add = (v) => { const c = canon(v); if (c) out.add(c); };
  if (!u) return out;
  [u.department, u.team, u.atsDepartment].forEach(add);
  csv(u.atsScopeDepartments).forEach(add);
  csv(u.atsScopeTeams).forEach(add);
  (Array.isArray(u.atsBdeDeskDepartments) ? u.atsBdeDeskDepartments : []).forEach(add);
  if (u.atsPositionScope && Array.isArray(u.atsPositionScope.departments)) u.atsPositionScope.departments.forEach(add);
  return out;
}
const EXTERNAL_ROLES = ['CLIENT', 'CANDIDATE', 'VENDOR', 'PARTNER'];
function rolesOfUser(u) {
  const out = new Set();
  if (!u) return out;
  [u.role, u.atsRole, u.hrmsRole, u.accountsRole].forEach((r) => { const v = String(r || '').toUpperCase(); if (v && v !== 'NONE') out.add(v); });
  const sr = u.scopeRoles || {};
  Object.values(sr).forEach((r) => { const v = String(r || '').toUpperCase(); if (v && v !== 'NONE') out.add(v); });
  return out;
}
const isAdminLike = (u) => !!u && !u.viewAs && [u.role, u.atsRole, u.hrmsRole].some((r) => ['SUPER_ADMIN', 'ADMIN'].includes(r));

// Does this login hold access to this number?  (Admin ticks: department, person, role.)
function holdsAccess(u, accessRows) {
  if (!u || !accessRows.length) return false;
  const depts = departmentsOfUser(u);
  const roles = rolesOfUser(u);
  const staff = ![...roles].some((r) => EXTERNAL_ROLES.includes(r));
  return accessRows.some((a) => {
    if (a.kind === 'USER') return a.refId === u.id;
    if (a.kind === 'DEPARTMENT') return depts.has(canon(a.refId));
    if (a.kind === 'ROLE') return a.refId === '*' ? staff : roles.has(String(a.refId).toUpperCase());
    return false;
  });
}

// The numbers this login may send from (active ones only unless includeOff).
async function authorisedRows(user, { includeOff = false } = {}) {
  const { rows, access } = await load();
  const st = await settings();
  const all = isAdminLike(user) && st.adminsAllNumbers !== false;
  return rows.filter((r) => (includeOff || r.active) && (all || holdsAccess(user, access.filter((a) => a.numberId === r.id))));
}
async function mayUse(user, numberId) {
  const r = await getRow(numberId);
  if (!r) return false;
  return (await authorisedRows(user, { includeOff: true })).some((x) => x.id === r.id);
}
async function identityOf(userId) {
  if (!userId) return null;
  const hit = idCache.get(userId);
  if (hit && Date.now() - hit.at < 30000) return hit.u;
  let u = null;
  try { u = await require('./identity').resolveIdentity(userId); } catch { u = null; } // eslint-disable-line global-require
  idCache.set(userId, { at: Date.now(), u });
  if (idCache.size > 400) idCache.clear();
  return u;
}
const idCache = new Map();

// ---- the plain words used when a message is refused ---------------------------------------------------------------------------------
const WORDS = {
  NO_NUMBER: 'No WhatsApp number is assigned to you yet. Ask the Admin (Integrations > WhatsApp > Assign).',
  NOT_ALLOWED: 'You are not allowed to send from this number.',
  NOT_FOUND: 'That WhatsApp number was not found. Pick one from the list.',
  OFF: (r) => `The WhatsApp number "${r.label}" is switched off. Ask the Admin to switch it on, or pick another number.`,
  DOWN: (r, why) => `The WhatsApp number "${r.label}" cannot send right now${why ? `: ${why}` : ''}. The message was not sent from any other number.`,
  NONE_AT_ALL: 'WhatsApp is not set up yet. An Admin connects it in Administration > Integrations > WhatsApp.',
};

// resolveSender: who sends from which number.
//   { user | userId, requestedNumberId, to, department, automatic, purpose }
//   -> { legacy: true }                                        no numbers added yet: the old single connection is used as before
//   -> { ok: true, number, cfg, reason, picked }
//   -> { ok: false, status, code, error, notConfigured? }
async function resolveSender(opts = {}) {
  if (!(await hasNumbers())) return { legacy: true };
  const st = await settings();
  const { rows } = await load();
  let user = opts.user || null;
  if (!user && opts.userId) user = await identityOf(opts.userId);
  const human = !!user && !opts.automatic;

  const usable = async (row) => {
    const cfg = await configOf(row);
    if (!row.active) return { ok: false, off: true, row, cfg };
    if (!cfg || !cfg.configured) return { ok: false, row, cfg, why: cfg ? cfg.reason : 'not set up' };
    return { ok: true, row, cfg };
  };
  const fallback = async (row, why, forUser) => {
    if (!st.fallbackToDefault) return null;
    const d = await defaultRow();
    if (!d || d.id === row.id) return null;
    if (forUser && !(await mayUse(forUser, d.id))) return null;
    const u = await usable(d);
    return u.ok ? { ok: true, number: d, cfg: u.cfg, reason: `Sent from the default number because "${row.label}" was not available (${why}).`, picked: 'fallback', fellBackFrom: row.id } : null;
  };
  const refuseUnusable = async (u, forUser) => {
    const fb = await fallback(u.row, u.off ? 'switched off' : (u.why || 'not connected'), forUser);
    if (fb) return fb;
    return { ok: false, status: 409, code: 'NUMBER_DOWN', error: u.off ? WORDS.OFF(u.row) : WORDS.DOWN(u.row, u.why), notConfigured: !u.off, numberId: u.row.id };
  };

  // --- automatic (no person) -----------------------------------------------------------------------------------------------------------
  if (!human) {
    let row = opts.requestedNumberId ? rows.find((r) => r.id === opts.requestedNumberId) : null;
    if (!row && st.systemNumberId) row = rows.find((r) => r.id === st.systemNumberId && r.active) || null;
    if (!row && opts.department) {
      const dept = canon(opts.department);
      const { access } = await load();
      row = rows.find((r) => r.active && access.some((a) => a.numberId === r.id && a.kind === 'DEPARTMENT' && canon(a.refId) === dept) && !access.some((a) => a.numberId === r.id && a.kind === 'DEPARTMENT' && canon(a.refId) !== dept)) || null; // a number that belongs to just that department
    }
    if (!row) row = (await defaultRow()) || rows.find((r) => r.active) || null;
    if (!row) return { ok: false, status: 409, code: 'NOT_CONFIGURED', error: WORDS.NONE_AT_ALL, notConfigured: true };
    const u = await usable(row);
    if (!u.ok) return refuseUnusable(u, null);
    return { ok: true, number: row, cfg: u.cfg, reason: 'System message', picked: 'system' };
  }

  // --- a person --------------------------------------------------------------------------------------------------------------------------------
  const mine = await authorisedRows(user, { includeOff: true });
  const activeMine = mine.filter((r) => r.active);
  // a) the person chose
  if (opts.requestedNumberId) {
    const row = rows.find((r) => r.id === String(opts.requestedNumberId));
    if (!row) return { ok: false, status: 404, code: 'NUMBER_NOT_FOUND', error: WORDS.NOT_FOUND };
    if (!mine.some((r) => r.id === row.id)) return { ok: false, status: 403, code: 'NUMBER_NOT_ALLOWED', error: WORDS.NOT_ALLOWED };
    const u = await usable(row);
    if (!u.ok) return refuseUnusable(u, user);
    return { ok: true, number: row, cfg: u.cfg, reason: 'Chosen by the sender', picked: 'chosen' };
  }
  if (!mine.length) return { ok: false, status: 409, code: 'NO_WHATSAPP_NUMBER', error: WORDS.NO_NUMBER };
  // b) an existing chat with this person continues on its number
  if (opts.to) {
    const threads = await threadsOfContact(opts.to);
    for (const t of threads) {
      const row = mine.find((r) => r.id === t.numberId);
      if (!row) continue; // eslint-disable-line no-continue
      const u = await usable(row); // eslint-disable-line no-await-in-loop
      if (u.ok) return { ok: true, number: row, cfg: u.cfg, reason: 'This chat already runs on this number', picked: 'thread' };
      return refuseUnusable(u, user); // eslint-disable-line no-await-in-loop
    }
  }
  // c) the person's own number
  if (!activeMine.length) {
    const u = await usable(mine[0]);
    return refuseUnusable(u, user);
  }
  let pick = null; let how = 'only';
  if (activeMine.length === 1) pick = activeMine[0];
  else {
    const { access } = await load();
    const wanted = opts.department ? [canon(opts.department)] : [...departmentsOfUser(user)];
    // the number given to the person by name, then their department's, then the default
    const direct = activeMine.filter((r) => access.some((a) => a.numberId === r.id && a.kind === 'USER' && a.refId === user.id));
    const byDept = activeMine.filter((r) => access.some((a) => a.numberId === r.id && a.kind === 'DEPARTMENT' && wanted.includes(canon(a.refId))));
    const def = activeMine.find((r) => r.isDefault);
    if (direct.length === 1) { pick = direct[0]; how = 'direct'; } else if (byDept.length) { pick = byDept[0]; how = 'department'; } else if (def) { pick = def; how = 'default'; } else { pick = [...activeMine].sort((a, b) => a.label.localeCompare(b.label))[0]; how = 'first'; }
  }
  const u = await usable(pick);
  if (!u.ok) return refuseUnusable(u, user);
  return { ok: true, number: pick, cfg: u.cfg, reason: how === 'only' ? 'Your number' : `Picked for you (${how})`, picked: how };
}

// Can ANY number of the list send? (the channel is "ready" when one can)  -> { ok, count, reason }
async function anyUsable() {
  const rows = (await listRows()).filter((r) => r.active);
  let n = 0; let reason = '';
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    const c = await configOf(r);
    if (c && c.configured) n += 1; else if (!reason) reason = c ? c.reason : '';
  }
  return { ok: n > 0, count: n, reason: n ? '' : (reason || 'No WhatsApp number is switched on and set up.') };
}

// For plans (bulk jobs, campaigns): the same rules without a contact. -> { legacy } | { ok, number } | { ok:false, ... }
async function planNumber(user, { requestedNumberId, department, automatic, to } = {}) {
  return resolveSender({ user, requestedNumberId, department, automatic, to });
}

// A campaign / job made earlier: is its number still usable for this person?  -> { ok } | { ok:false, error }
async function recheck(numberId, userId, { automatic = false } = {}) {
  if (!numberId) return { ok: true, legacy: true };
  const r = await resolveSender({ userId, requestedNumberId: numberId, automatic: automatic || !userId });
  if (r.legacy) return { ok: true, legacy: true };
  return r.ok ? { ok: true, number: r.number } : { ok: false, error: r.error, code: r.code };
}

// ---- chats and message ids per number --------------------------------------------------------------------------------------------------
async function threadsOfContact(to) {
  try {
    if (!(await tableReady())) return [];
    const d = require('./messageDelivery').digitsOf(to); // eslint-disable-line global-require
    if (!d) return [];
    return await q('SELECT * FROM "WaThread" WHERE "contact" = ? ORDER BY "lastMessageAt" DESC LIMIT 10', d);
  } catch { return []; }
}
async function touchThread({ numberId, contact, dir, person, at }) {
  if (!numberId || !contact) return;
  const when = (at instanceof Date ? at : new Date(at || Date.now())).toISOString();
  const inb = dir === 'IN';
  await run(
    `INSERT INTO "WaThread" ("numberId","contact","personType","personId","personName","lastInboundAt","lastOutboundAt","lastMessageAt","inboundCount","outboundCount") VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT("numberId","contact") DO UPDATE SET "lastMessageAt" = excluded."lastMessageAt",
       "lastInboundAt" = COALESCE(excluded."lastInboundAt", "WaThread"."lastInboundAt"), "lastOutboundAt" = COALESCE(excluded."lastOutboundAt", "WaThread"."lastOutboundAt"),
       "personType" = COALESCE(excluded."personType", "WaThread"."personType"), "personId" = COALESCE(excluded."personId", "WaThread"."personId"), "personName" = COALESCE(excluded."personName", "WaThread"."personName"),
       "inboundCount" = "WaThread"."inboundCount" + excluded."inboundCount", "outboundCount" = "WaThread"."outboundCount" + excluded."outboundCount"`,
    numberId, contact, (person && person.type) || null, (person && person.id) || null, (person && person.name) || null,
    inb ? when : null, inb ? null : when, when, inb ? 1 : 0, inb ? 0 : 1,
  );
}
// A message went out / came in on this number. Never throws.
async function noteMessage({ numberId, to, providerRef, dir, person, at }) {
  try {
    if (!numberId || !(await tableReady())) return;
    const contact = require('./messageDelivery').digitsOf(to); // eslint-disable-line global-require
    await touchThread({ numberId, contact, dir, person, at });
    if (providerRef) {
      await run('INSERT OR IGNORE INTO "WaMessageMap" ("providerRef","numberId","direction","contact","personType","personId","createdAt") VALUES (?,?,?,?,?,?,?)',
        String(providerRef).slice(0, 200), numberId, dir, contact, (person && person.type) || null, (person && person.id) || null, nowIso());
    }
  } catch (e) { console.error('[wa-numbers] noteMessage:', e.message); } // eslint-disable-line no-console
}
// the person a chat belongs to became known (after the reply was matched). Never throws.
async function tagThread(numberId, contactDigits, person) {
  try {
    if (!numberId || !person || !(await tableReady())) return;
    await run('UPDATE "WaThread" SET "personType" = COALESCE("personType", ?), "personId" = COALESCE("personId", ?), "personName" = COALESCE("personName", ?) WHERE "numberId" = ? AND "contact" = ?', person.type || null, person.id || null, person.name || null, numberId, String(contactDigits || ''));
    await run('UPDATE "WaMessageMap" SET "personType" = COALESCE("personType", ?), "personId" = COALESCE("personId", ?) WHERE "numberId" = ? AND "contact" = ? AND "personId" IS NULL', person.type || null, person.id || null, numberId, String(contactDigits || ''));
  } catch { /* a courtesy */ }
}
async function numberOfMessage(providerRef) {
  try {
    if (!providerRef || !(await tableReady())) return null;
    const r = (await q('SELECT "numberId" FROM "WaMessageMap" WHERE "providerRef" = ?', String(providerRef)))[0];
    return r ? r.numberId : null;
  } catch { return null; }
}
async function numbersOfMessages(refs) {
  const out = new Map();
  try {
    const list = [...new Set((refs || []).filter(Boolean).map(String))];
    if (!list.length || !(await tableReady())) return out;
    for (let i = 0; i < list.length; i += 400) {
      const part = list.slice(i, i + 400);
      // eslint-disable-next-line no-await-in-loop
      (await q(`SELECT "providerRef","numberId" FROM "WaMessageMap" WHERE "providerRef" IN (${part.map(() => '?').join(',')})`, ...part)).forEach((r) => out.set(r.providerRef, r.numberId));
    }
  } catch { /* none */ }
  return out;
}
// The 24-hour customer window belongs to ONE number (the number the person wrote to).
async function windowOpenOn(numberId, to) {
  try {
    if (!numberId) return null;
    const d = require('./messageDelivery').digitsOf(to); // eslint-disable-line global-require
    const r = (await q('SELECT "lastInboundAt" FROM "WaThread" WHERE "numberId" = ? AND "contact" = ?', numberId, d))[0];
    return !!(r && r.lastInboundAt && Date.now() - new Date(r.lastInboundAt).getTime() < 24 * 3600 * 1000);
  } catch { return null; }
}
async function openWindowsOn(numberId) {
  const out = new Set();
  try {
    if (!numberId || !(await tableReady())) return out;
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    (await q('SELECT "contact" FROM "WaThread" WHERE "numberId" = ? AND "lastInboundAt" > ?', numberId, since)).forEach((r) => out.add(r.contact));
  } catch { /* none */ }
  return out;
}
// The 24-hour window of a number. The Main number (still reading the old form) also honours the window the old code recorded.
async function windowOpenFor(number, to) {
  if (!number) return null;
  const own = await windowOpenOn(number.id, to);
  if (own) return true;
  if (number.credSource === 'legacy') return require('./messageDelivery').windowOpen(to); // eslint-disable-line global-require
  return !!own;
}
async function openWindowsFor(number) {
  if (!number) return null;
  const set = await openWindowsOn(number.id);
  if (number.credSource === 'legacy') (await require('./messageDelivery').openWindows()).forEach((d) => set.add(d)); // eslint-disable-line global-require
  return set;
}
// "Can a plain-text message go to this person without a template right now?" for a message TeamLink sends by itself: the window of the number system messages use.
async function windowOpenSystem(to) {
  const delivery = require('./messageDelivery'); // eslint-disable-line global-require
  try {
    if (!(await hasNumbers())) return delivery.windowOpen(to);
    const r = await resolveSender({ automatic: true, to });
    return r.ok ? !!(await windowOpenFor(r.number, to)) : false;
  } catch { return delivery.windowOpen(to); }
}
// Which numbers may this login see conversations of?  'ALL' (admin) | Set of number ids.
async function visibleNumberIds(user) {
  if (!(await hasNumbers())) return 'ALL';
  const st = await settings();
  if (isAdminLike(user) && st.adminsAllNumbers !== false) return 'ALL';
  return new Set((await authorisedRows(user, { includeOff: true })).map((r) => r.id));
}

// Rows of messages (candidate log, conversation timeline ...): a WhatsApp message that went through a number this login may not see is left out;
// the others carry the number's name. Without a list of numbers nothing changes. Never throws.
async function filterRows(user, rows, { channel = (r) => r.channel, ref = (r) => r.providerRef } = {}) {
  try {
    if (!rows || !rows.length || !(await hasNumbers())) return rows;
    const wa = rows.filter((r) => channel(r) === 'WhatsApp' && ref(r));
    if (!wa.length) return rows;
    const map = await numbersOfMessages(wa.map(ref));
    if (!map.size) return rows;
    const vis = await visibleNumberIds(user);
    const labels = await labelsOf();
    return rows.filter((r) => {
      if (channel(r) !== 'WhatsApp') return true;
      const nid = map.get(ref(r));
      return !nid || vis === 'ALL' || vis.has(nid);
    }).map((r) => {
      const nid = channel(r) === 'WhatsApp' ? map.get(ref(r)) : null;
      return nid ? { ...r, waNumber: labels.get(nid) || { id: nid, label: 'A removed number', displayNumber: '' } } : r;
    });
  } catch { return rows; }
}
// The WhatsApp numbers each person has a chat on:  Map "TYPE:id" -> [{ id, label, displayNumber }]
async function threadNumbers(items) {
  const out = new Map();
  try {
    if (!items || !items.length || !(await hasNumbers())) return out;
    const labels = await labelsOf();
    const ids = [...new Set(items.map((i) => String(i.personId)))];
    for (let i = 0; i < ids.length; i += 300) {
      const part = ids.slice(i, i + 300);
      // eslint-disable-next-line no-await-in-loop
      const rows = await q(`SELECT "personType","personId","numberId" FROM "WaThread" WHERE "personId" IN (${part.map(() => '?').join(',')})`, ...part);
      rows.forEach((r) => {
        const k = `${r.personType}:${r.personId}`;
        const l = labels.get(r.numberId) || { id: r.numberId, label: 'A removed number', displayNumber: '' };
        const arr = out.get(k) || [];
        if (!arr.some((x) => x.id === l.id)) arr.push(l);
        out.set(k, arr);
      });
    }
  } catch { /* none */ }
  return out;
}
// People whose ONLY WhatsApp chats are on numbers this login may not see (the last message was a WhatsApp one): hidden from the Inbox list.
async function hiddenPersons(user, items) {
  const hide = new Set();
  try {
    if (!items || !items.length || !(await hasNumbers())) return hide;
    const vis = await visibleNumberIds(user);
    if (vis === 'ALL') return hide;
    const map = await threadNumbers(items.filter((i) => i.channel === 'WhatsApp'));
    items.forEach((i) => {
      if (i.channel !== 'WhatsApp') return;
      const k = `${i.personType}:${i.personId}`;
      const nums = map.get(k);
      if (nums && nums.length && !nums.some((n) => vis.has(n.id))) hide.add(k);
    });
  } catch { /* none */ }
  return hide;
}

// ---- inbound routing helpers (the webhook) --------------------------------------------------------------------------------------------------
async function rowByPhoneId(phoneNumberId) {
  const id = String(phoneNumberId || '').trim();
  if (!id) return null;
  return (await listRows()).find((r) => String(r.phoneNumberId) === id) || null;
}
// every verify token that may be used in Meta's one-time check (a number's own, or the shared one)
async function verifyTokens() {
  const out = [];
  const legacy = await wa().legacyConfig().catch(() => null);
  if (legacy && legacy.verifyToken) out.push(legacy.verifyToken);
  for (const r of await listRows()) {
    if (!r.active) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const s = await readSecrets(r.id);
    if (s.verifyToken) out.push(s.verifyToken);
  }
  return out;
}
// The app secret that signs a call for this number (its own, else the shared one).
async function appSecretOf(row) {
  if (row.credSource === 'legacy') return (await wa().legacyConfig()).appSecret || '';
  const s = await readSecrets(row.id);
  return s.appSecret || (await wa().legacyConfig()).appSecret || '';
}
async function allAppSecrets() {
  const out = new Set();
  const legacy = await wa().legacyConfig().catch(() => null);
  if (legacy && legacy.appSecret) out.add(legacy.appSecret);
  for (const r of await listRows()) {
    // eslint-disable-next-line no-await-in-loop
    const s = await readSecrets(r.id);
    if (s.appSecret) out.add(s.appSecret);
  }
  return [...out];
}
// A call for a phone_number_id nobody added: kept as an "unknown number" event, never routed to any number.
async function noteUnknown({ phoneNumberId, display, kind, ref }) {
  try {
    const R = require('../outreach/omni/replyRouter'); // eslint-disable-line global-require
    const ev = await R.begin({ provider: UNKNOWN_PROVIDER, id: `${phoneNumberId}:${kind}:${ref || crypto.randomBytes(6).toString('hex')}`, channel: 'WhatsApp', kind: 'unknown_number', text: '', name: String(display || '').slice(0, 40) });
    if (ev && ev.id && !ev.duplicate) {
      const S = require('../outreach/store'); // eslint-disable-line global-require
      await S.run('UPDATE "OmniProviderEvent" SET outcome = ?, reason = ?, processedAt = ? WHERE id = ?', 'ignored', `Unknown number: Phone number ID ${String(phoneNumberId).slice(0, 40)} is not added in Integrations > WhatsApp.`, Date.now(), ev.id);
    }
  } catch (e) { console.error('[wa-numbers] unknown:', e.message); } // eslint-disable-line no-console
}
async function unknownCount() {
  try {
    const S = require('../outreach/store'); // eslint-disable-line global-require
    const r = (await S.q('SELECT COUNT(*) n FROM "OmniProviderEvent" WHERE provider = ?', UNKNOWN_PROVIDER))[0];
    return num(r && r.n);
  } catch { return 0; }
}

// ---- checking a number with Meta -------------------------------------------------------------------------------------------------------------
const FIELDS_FULL = 'display_phone_number,verified_name,quality_rating,code_verification_status,name_status,status,messaging_limit_tier,platform_type';
const FIELDS_MIN = 'display_phone_number,verified_name,quality_rating';
// Pure: what Meta said -> { code, text, quality, verifiedName }.  (code: connected | verification_required | disconnected)
function statusFromMeta(j, typedDigits) {
  const out = { quality: j.quality_rating || '', verifiedName: j.verified_name || '' };
  const cv = String(j.code_verification_status || '').toUpperCase();
  const ns = String(j.name_status || '').toUpperCase();
  const st = String(j.status || '').toUpperCase();
  const metaDigits = digitsOf(j.display_phone_number);
  if (typedDigits && metaDigits && metaDigits.slice(-10) !== String(typedDigits).slice(-10)) {
    return { ...out, code: 'disconnected', text: `This Phone number ID belongs to ${j.display_phone_number}, not the number you typed. Check the Phone number ID.` };
  }
  if (cv && cv !== 'VERIFIED') return { ...out, code: 'verification_required', text: 'Meta has not verified this number yet. In Meta (WhatsApp > Phone numbers) ask for the code, then enter it to verify the number.' };
  if (['PENDING', 'UNVERIFIED', 'NOT_VERIFIED'].includes(st)) return { ...out, code: 'verification_required', text: 'Meta says this number is not registered yet. Finish adding and verifying it in Meta (WhatsApp > Phone numbers).' };
  if (st && !['CONNECTED', 'ACTIVE'].includes(st)) {
    const why = { BANNED: 'WhatsApp banned this number.', DELETED: 'This number was deleted in Meta.', MIGRATED: 'This number was moved to another account.', RESTRICTED: 'Meta restricted this number.', RATE_LIMITED: 'Meta is limiting this number for now.', FLAGGED: 'Meta flagged this number (quality).', DISCONNECTED: 'Meta says this number is disconnected.' }[st] || `Meta says the number status is ${st.toLowerCase()}.`;
    return { ...out, code: 'disconnected', text: why };
  }
  if (ns && ['PENDING_REVIEW', 'DECLINED', 'EXPIRED'].includes(ns)) {
    return { ...out, code: ns === 'DECLINED' ? 'verification_required' : 'connected', text: ns === 'DECLINED' ? 'Meta declined the display name of this number. Fix the name in Meta.' : `Connected. The display name is still being reviewed by Meta.${j.verified_name ? ` (${j.verified_name})` : ''}` };
  }
  return { ...out, code: 'connected', text: `Connected${j.verified_name ? ` as ${j.verified_name}` : ''}${j.quality_rating ? ` · quality ${String(j.quality_rating).toLowerCase()}` : ''}.` };
}

const hits = new Map(); // number id -> [timestamps] of Reconnect presses
const RECONNECT_LIMIT = Number(process.env.WA_RECONNECT_PER_HOUR || 6);
function reconnectAllowed(id) {
  const now = Date.now();
  const arr = (hits.get(id) || []).filter((t) => now - t < 3600000);
  if (arr.length >= RECONNECT_LIMIT) { hits.set(id, arr); return false; }
  arr.push(now); hits.set(id, arr);
  return true;
}

const tagOf = (t) => (t ? crypto.createHash('sha256').update(String(t)).digest('hex').slice(0, 8) : '');
// A number that keeps its OWN token which Meta rejected, while the token saved in the WhatsApp Business form does work for it: say so (nothing is switched by itself).
async function sharedTokenHint(row, cfg) {
  try {
    if (!row || row.credSource === 'legacy' || row.tokenMode === 'shared') return '';
    const legacy = await wa().legacyConfig();
    if (!legacy.token || tagOf(legacy.token) === tagOf(cfg.token)) return '';
    const r = await graphGet({ ...cfg, token: legacy.token }, `${encodeURIComponent(cfg.phoneId)}?fields=display_phone_number`);
    return r.ok && r.json && (r.json.display_phone_number || r.json.id)
      ? 'This number uses its own saved token, which Meta rejected. The newer token saved in the WhatsApp Business form works for this number: edit the number and choose "The shared token".'
      : '';
  } catch { return ''; }
}
// What Meta says about the token itself (type, never / expiry day). Read-only, never throws, never returns the token.
async function tokenNote(cfg) {
  try {
    const r = await graphGet(cfg, `debug_token?input_token=${encodeURIComponent(cfg.token)}`);
    const d = r.ok && r.json && r.json.data;
    if (!d || d.is_valid === false) return '';
    if (d.expires_at === 0) return 'Token: never expires.';
    if (d.expires_at) return `Token expires on ${new Date(d.expires_at * 1000).toISOString().slice(0, 10)}.`;
    return '';
  } catch { return ''; }
}
async function graphGet(cfg, path) {
  return core.httpJson(`${cfg.base}/${wa().VERSION}/${path}`, { headers: { authorization: `Bearer ${cfg.token}` } });
}
async function graphPost(cfg, path, body) {
  return core.httpJson(`${cfg.base}/${wa().VERSION}/${path}`, { method: 'POST', headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
}

// Ask Meta about one number (a read; nothing is sent to anybody). subscribe: also look at / create the webhook subscription of the WABA.
// Writes the answer on the row (the chip) and returns { code, text, quality, checkedAt }.
async function check(ref, { subscribe = false, user = null, quiet = false } = {}) {
  const row = typeof ref === 'string' ? await getRowFresh(ref) : ref;
  if (!row) return { ok: false, error: WORDS.NOT_FOUND, status: 404 };
  const cfg = await configOf(row);
  let res;
  let authFailed = false;
  const simulated = wa().simulated(cfg);
  if (!cfg.configured) {
    const off = !row.active;
    res = { code: off ? 'switched_off' : 'disconnected', text: off ? 'Switched off by the Admin.' : `Not set up: ${cfg.reason}` };
  } else if (simulated) {
    res = { code: 'test_mode', text: 'Test mode: Meta is not asked on this server, so no real status can be shown.' };
  } else {
    let r = await graphGet(cfg, `${encodeURIComponent(cfg.phoneId)}?fields=${FIELDS_FULL}`);
    const metaErr = r.json && r.json.error;
    if (!r.ok && metaErr && Number(metaErr.code) === 100 && /field|nonexist|does not exist|unsupported/i.test(String(metaErr.message || ''))) r = await graphGet(cfg, `${encodeURIComponent(cfg.phoneId)}?fields=${FIELDS_MIN}`);
    if (r.ok && r.json && (r.json.display_phone_number || r.json.id)) {
      res = statusFromMeta(r.json, row.displayDigits);
      if (res.code === 'connected') { const tn = await tokenNote(cfg); if (tn) res = { ...res, text: `${res.text} ${tn}` }; }
      // is the number really inside the WhatsApp Business Account that was typed?
      if (res.code === 'connected' && cfg.wabaId) {
        const wl = await graphGet(cfg, `${encodeURIComponent(cfg.wabaId)}/phone_numbers?fields=id,display_phone_number`);
        if (wl.ok && wl.json && Array.isArray(wl.json.data) && !wl.json.data.some((d) => String(d.id) === String(cfg.phoneId))) {
          res = { ...res, code: 'disconnected', text: 'Meta does not list this Phone number ID in that WhatsApp Business Account. Check both ids.' };
        }
      }
    } else {
      const f = wa().failure(r);
      authFailed = Number(f.code) === 190 || f.status === 401;
      res = { code: 'disconnected', text: `Meta did not accept the connection. ${f.error}` };
      if (authFailed) { const hint = await sharedTokenHint(row, cfg); if (hint) res.text += ` ${hint}`; }
    }
    if (subscribe && cfg.wabaId && res.code !== 'disconnected') {
      const note = await ensureSubscribed(cfg);
      res.webhookNote = note;
    }
  }
  const checkedAt = nowIso();
  await run('UPDATE "WaNumber" SET "statusCode" = ?, "statusText" = ?, "checkedAt" = ?, "qualityRating" = ?, "verifiedName" = ?, "webhookNote" = COALESCE(?, "webhookNote"), "updatedAt" = ? WHERE "id" = ?',
    res.code, clip(res.text, 500), checkedAt, res.quality || null, res.verifiedName || null, res.webhookNote ? clip(res.webhookNote, 300) : null, nowIso(), row.id);
  bust();
  if (!quiet && user) {
    await logAudit({ userId: user.id, actorName: user.name, action: subscribe ? 'WhatsApp number reconnected (checked with Meta)' : 'WhatsApp number checked with Meta', entity: 'WaNumber', entityId: row.id, fromValue: row.statusCode, toValue: `${row.label}: ${res.code}` });
  }
  return { ok: true, authFailed, code: res.code, text: res.text, quality: res.quality || '', verifiedName: res.verifiedName || '', checkedAt, webhookNote: res.webhookNote || '' };
}
// Meta accepted a real message from this number: a red "Disconnected" chip left over from an old token is no longer true.
async function noteSendOk(numberId) {
  try {
    if (!numberId || !(await tableReady())) return;
    const r = await getRowFresh(numberId);
    if (!r || r.statusCode !== 'disconnected') return;
    await run('UPDATE "WaNumber" SET "statusCode" = ?, "statusText" = ?, "checkedAt" = ?, "updatedAt" = ? WHERE "id" = ?', 'connected', 'Connected. Meta accepted a message from this number just now.', nowIso(), nowIso(), numberId);
    bust();
  } catch { /* the chip is a courtesy */ }
}
// The token in the WhatsApp Business form (Configure) was just saved. Every number that reads it (the Main number and every number on
// "the shared token") is asked at Meta at once, so the chips show the real answer. A number with its OWN token keeps it: it is listed, with
// whether the new token would work for it, so nothing stays silently on an old token.
async function afterLegacyTokenChange(user) {
  const out = { checked: [], ownToken: [], noList: false };
  if (!(await tableReady())) { out.noList = true; return out; }
  const rows = (await q('SELECT * FROM "WaNumber" WHERE "removedAt" IS NULL ORDER BY "createdAt", "id"')).map(norm);
  bust();
  const legacy = await wa().legacyConfig();
  for (const r of rows) {
    if (r.credSource === 'legacy' || r.tokenMode === 'shared') {
      const c = await check(r, { user, quiet: false }).catch((e) => ({ ok: false, code: 'unchecked', text: String(e.message).slice(0, 120), authFailed: false }));
      out.checked.push({ id: r.id, label: r.label, code: c.code, text: c.text, authFailed: !!c.authFailed, main: r.credSource === 'legacy' });
    } else {
      const cfg = await configOf(r).catch(() => null);
      let legacyWorks = null;
      if (cfg && legacy.token && tagOf(legacy.token) !== tagOf(cfg.token) && !wa().simulated(cfg)) {
        const t = await graphGet({ ...cfg, token: legacy.token }, `${encodeURIComponent(cfg.phoneId)}?fields=display_phone_number`).catch(() => null);
        legacyWorks = !!(t && t.ok && t.json && (t.json.display_phone_number || t.json.id));
      }
      out.ownToken.push({ id: r.id, label: r.label, sameToken: !!(cfg && legacy.token && tagOf(legacy.token) === tagOf(cfg.token)), legacyWorks });
    }
  }
  return out;
}
// A real send failed in a way that says the number / token is not usable: the chip turns red at once (not only at the next check).
async function noteSendFailure(numberId, f) {
  try {
    const code = Number(f && f.code);
    if (![190, 200, 100, 131031, 133010, 131005].includes(code) && !(f && f.status === 401)) return;
    if (!(await tableReady())) return;
    await run('UPDATE "WaNumber" SET "statusCode" = ?, "statusText" = ?, "checkedAt" = ?, "updatedAt" = ? WHERE "id" = ?', 'disconnected', clip(`Meta refused a message: ${f.error}`, 500), nowIso(), nowIso(), numberId);
    bust();
  } catch { /* the chip is a courtesy */ }
}
async function ensureSubscribed(cfg) {
  try {
    const g = await graphGet(cfg, `${encodeURIComponent(cfg.wabaId)}/subscribed_apps`);
    if (g.ok && g.json && Array.isArray(g.json.data) && g.json.data.length) return 'Webhook: Meta already sends this account\'s messages to TeamLink.';
    if (!g.ok) return `Webhook: could not check the subscription (${wa().failure(g).error.slice(0, 160)}).`;
    const p = await graphPost(cfg, `${encodeURIComponent(cfg.wabaId)}/subscribed_apps`, {});
    if (p.ok && p.json && p.json.success !== false) return 'Webhook: TeamLink was subscribed to this account\'s messages just now.';
    return `Webhook: could not subscribe (${wa().failure(p).error.slice(0, 160)}). In Meta, open the app > WhatsApp > Configuration and subscribe to "messages".`;
  } catch (e) { return `Webhook: could not check (${String(e.message).slice(0, 100)}).`; }
}

// ---- validation -----------------------------------------------------------------------------------------------------------------------------------------
function cleanE164(raw) {
  const t = String(raw || '').replace(/[\s\-().]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(t)) return null;
  return t;
}
function validate(b, { editing = false, legacyRow = false } = {}) {
  const v = {};
  const bad = (error) => ({ error, status: 400 });
  if (!editing || b.label !== undefined) {
    const label = clip(b.label, 60);
    if (label.length < 2) return bad('Give this number a short name, like "Education desk".');
    v.label = label;
  }
  if (!legacyRow && (!editing || b.displayNumber !== undefined)) {
    const d = cleanE164(b.displayNumber);
    if (!d) return bad('Enter the number with country code, like +91 98xxxxxxx.');
    v.displayNumber = d; v.displayDigits = digitsOf(d);
  }
  if (!legacyRow && (!editing || b.phoneNumberId !== undefined)) {
    const p = String(b.phoneNumberId || '').trim();
    if (!/^\d{6,25}$/.test(p)) return bad('The Phone number ID is only digits (for example 104512345678901). Copy it from Meta > WhatsApp > API Setup.');
    v.phoneNumberId = p;
  }
  if (!legacyRow && b.wabaId !== undefined) {
    const w = String(b.wabaId || '').trim();
    if (w && !/^\d{6,25}$/.test(w)) return bad('The WhatsApp Business Account ID is only digits. Copy it from Meta > WhatsApp > API Setup.');
    v.wabaId = w || null;
  }
  if (b.language !== undefined) {
    const l = String(b.language || '').trim();
    if (l && !/^[a-z]{2,3}([_-][A-Za-z]{2})?$/.test(l)) return bad('The language code looks like "en" or "en_US".');
    v.language = l || null;
  }
  for (const [k, col] of [['tplLink', 'tplLink'], ['tplOtp', 'tplOtp'], ['tplBulk', 'tplBulk']]) {
    if (b[k] !== undefined) {
      const t = String(b[k] || '').trim();
      if (t && !/^[a-z0-9_]{1,512}$/.test(t)) return bad('A template name uses small letters, numbers and _ only (for example welcome_message).');
      v[col] = t || null;
    }
  }
  if (!legacyRow && b.tokenMode !== undefined) {
    if (!['own', 'shared'].includes(b.tokenMode)) return bad('Choose "its own token" or "the shared token".');
    v.tokenMode = b.tokenMode;
  }
  for (const k of ['token', 'appSecret', 'verifyToken']) {
    if (!legacyRow && b[k] !== undefined && b[k] !== null && String(b[k]).trim() !== '') {
      const s = String(b[k]).trim();
      if (/\s/.test(s)) return bad(`That ${k === 'token' ? 'access token' : k === 'appSecret' ? 'app secret' : 'verify token'} has spaces in it. Copy it again without spaces.`);
      if (k === 'token' && s !== '-' && s.length < 16) return bad('That access token looks too short. Copy the whole token from Meta.');
    }
  }
  return { v };
}
const secretPatch = (b) => {
  const p = {};
  for (const k of ['token', 'appSecret', 'verifyToken']) {
    if (b[k] === undefined || b[k] === null || String(b[k]).trim() === '') continue; // eslint-disable-line no-continue
    p[k] = String(b[k]).trim() === '-' ? null : String(b[k]).trim();
  }
  return p;
};
async function duplicateOf(v, exceptId) {
  const rows = await listRows();
  if (v.phoneNumberId) {
    const d = rows.find((r) => r.id !== exceptId && String(r.phoneNumberId) === v.phoneNumberId);
    if (d) return `This Phone number ID is already added as "${d.label}".`;
  }
  if (v.displayDigits) {
    const d = rows.find((r) => r.id !== exceptId && r.displayDigits === v.displayDigits);
    if (d) return `This WhatsApp number is already added as "${d.label}".`;
  }
  return null;
}

// ---- admin actions ---------------------------------------------------------------------------------------------------------------------------------------
async function nameOfAccess(a) { return a.kind === 'DEPARTMENT' ? `${a.refId} (department)` : a.kind === 'ROLE' ? (a.refId === '*' ? 'Everyone (as before)' : `${a.refId} (role)`) : `${a.refLabel || a.refId}`; }

async function importMain(user) {
  await ensure();
  const rows = await listRows();
  const have = rows.find((r) => r.credSource === 'legacy');
  if (have) return { row: have, already: true };
  const legacy = await wa().legacyConfig();
  if (!legacy.phoneId) return { error: 'The main WhatsApp number is not set up yet (Administration > Integrations > Connections > WhatsApp Business), so there is nothing to move.', status: 409 };
  const dup = rows.find((r) => String(r.phoneNumberId) === legacy.phoneId);
  if (dup) return { error: `This Phone number ID is already added as "${dup.label}".`, status: 409 };
  const id = newId('wan');
  const t = nowIso();
  const display = cleanE164(legacy.display) || (legacy.display ? `+${digitsOf(legacy.display)}` : `+${digitsOf(legacy.phoneId)}`);
  const anyDefault = rows.some((r) => r.isDefault);
  await run('INSERT INTO "WaNumber" ("id","label","displayNumber","displayDigits","phoneNumberId","wabaId","credSource","tokenMode","active","isDefault","statusCode","createdById","createdByName","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id, 'Main number', display, digitsOf(display), legacy.phoneId, legacy.wabaId || null, 'legacy', 'own', 1, anyDefault ? 0 : 1, 'unchecked', user.id, user.name, t, t);
  // everybody who could send before still can: the Admin narrows it later
  await run('INSERT OR IGNORE INTO "WaNumberAccess" ("id","numberId","kind","refId","refLabel","grantedById","grantedByName","grantedAt") VALUES (?,?,?,?,?,?,?,?)', newId('wac'), id, 'ROLE', '*', 'Everyone', user.id, user.name, t);
  bust();
  await logAudit({ userId: user.id, actorName: user.name, action: 'WhatsApp main number moved into the numbers list', entity: 'WaNumber', entityId: id, toValue: `Main number ${display}; credentials stay in the WhatsApp Business form; everyone who could send before still can` });
  return { row: await getRowFresh(id), already: false };
}

async function create(user, b) {
  await ensure();
  const vv = validate(b || {});
  if (vv.error) return vv;
  const v = vv.v;
  const rowsNow = await listRows();
  const legacy = await wa().legacyConfig();
  if (!rowsNow.length && legacy.phoneId) { // adding the first extra number: the main one joins the list first, so nobody loses it
    const m = await importMain(user);
    if (m.error) return m;
  }
  const dup = await duplicateOf(v, null);
  if (dup) return { error: dup, status: 409 };
  const tokenMode = v.tokenMode || 'own';
  const patch = secretPatch(b);
  if (tokenMode === 'own' && !patch.token) return { error: 'Paste the access token of this number (or choose "the shared token").', status: 400 };
  if (tokenMode === 'shared' && !legacy.token) return { error: 'No shared token is saved yet. Paste this number\'s own token, or save one in Administration > Integrations > WhatsApp Business first.', status: 400 };
  const id = newId('wan');
  const t = nowIso();
  const first = !(await listRows()).some((r) => r.active && r.isDefault);
  try {
    if (patch.token !== undefined || patch.appSecret !== undefined || patch.verifyToken !== undefined) {
      const sp = { ...patch };
      if (tokenMode === 'shared') delete sp.token;
      await writeSecrets(id, sp);
    }
  } catch (e) { if (e.code === 'NO_SECRET_KEY') return { error: e.message, status: 400 }; throw e; }
  try {
    await run('INSERT INTO "WaNumber" ("id","label","displayNumber","displayDigits","phoneNumberId","wabaId","credSource","tokenMode","language","tplLink","tplOtp","tplBulk","active","isDefault","statusCode","createdById","createdByName","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, v.label, v.displayNumber, v.displayDigits, v.phoneNumberId, v.wabaId || null, 'own', tokenMode, v.language || null, v.tplLink || null, v.tplOtp || null, v.tplBulk || null, 1, 0, 'unchecked', user.id, user.name, t, t);
  } catch (e) {
    await dropSecrets(id);
    if (/UNIQUE/i.test(String(e.message))) return { error: 'This number or Phone number ID is already added.', status: 409 };
    throw e;
  }
  bust();
  await logAudit({ userId: user.id, actorName: user.name, action: 'WhatsApp number added', entity: 'WaNumber', entityId: id, toValue: `${v.label} (${v.displayNumber}); token: ${tokenMode === 'shared' ? 'shared' : 'its own'}` });
  if (b.makeDefault === true || first) await setDefault(user, id, { quiet: !b.makeDefault });
  if (b.access) await setAccess(user, id, b.access, { quiet: false });
  let status = null;
  if (b.check !== false) status = await check(id, { user, subscribe: false }).catch(() => null);
  return { row: await getRowFresh(id), status };
}

async function update(user, id, b) {
  const row = await getRowFresh(id);
  if (!row) return { error: WORDS.NOT_FOUND, status: 404 };
  const legacyRow = row.credSource === 'legacy';
  if (legacyRow) {
    for (const k of ['displayNumber', 'phoneNumberId', 'wabaId', 'token', 'appSecret', 'verifyToken', 'tokenMode']) {
      if (b[k] !== undefined && b[k] !== '' && b[k] !== null) return { error: 'The Main number\'s connection details are kept in the WhatsApp Business form (Connections tab). Change them there.', status: 400 };
    }
  }
  const vv = validate(b || {}, { editing: true, legacyRow });
  if (vv.error) return vv;
  const v = vv.v;
  const dup = await duplicateOf(v, id);
  if (dup) return { error: dup, status: 409 };
  const patch = legacyRow ? {} : secretPatch(b);
  if (v.tokenMode === 'shared') {
    const legacy = await wa().legacyConfig();
    if (!legacy.token) return { error: 'No shared token is saved yet. Paste this number\'s own token, or save one in Administration > Integrations > WhatsApp Business first.', status: 400 };
  }
  if (v.tokenMode === 'own' && row.tokenMode === 'shared' && !patch.token) {
    const s = await readSecrets(id);
    if (!s.has.token) return { error: 'Paste the access token of this number (or keep "the shared token").', status: 400 };
  }
  try { if (Object.keys(patch).length) await writeSecrets(id, patch); } catch (e) { if (e.code === 'NO_SECRET_KEY') return { error: e.message, status: 400 }; throw e; }
  const sets = []; const vals = []; const changed = [];
  const cols = ['label', 'displayNumber', 'displayDigits', 'phoneNumberId', 'wabaId', 'language', 'tplLink', 'tplOtp', 'tplBulk', 'tokenMode'];
  cols.forEach((c) => {
    if (v[c] === undefined) return;
    if (String(v[c] == null ? '' : v[c]) === String(row[c] == null ? '' : row[c])) return;
    sets.push(`"${c}" = ?`); vals.push(v[c]);
    if (!['displayDigits'].includes(c)) changed.push(`${c}: ${row[c] == null ? '' : row[c]} -> ${v[c] == null ? '' : v[c]}`);
  });
  const secretsChanged = Object.keys(patch).map((k) => (k === 'token' ? 'access token' : k === 'appSecret' ? 'app secret' : 'verify token'));
  if (sets.length) {
    sets.push('"updatedAt" = ?'); vals.push(nowIso());
    try { await run(`UPDATE "WaNumber" SET ${sets.join(', ')} WHERE "id" = ?`, ...vals, id); } catch (e) {
      if (/UNIQUE/i.test(String(e.message))) return { error: 'This number or Phone number ID is already added.', status: 409 };
      throw e;
    }
  }
  bust();
  // a changed id / token means the old check no longer describes this number
  if ((v.phoneNumberId && v.phoneNumberId !== row.phoneNumberId) || secretsChanged.includes('access token') || v.tokenMode) {
    await run('UPDATE "WaNumber" SET "statusCode" = ?, "statusText" = ?, "updatedAt" = ? WHERE "id" = ?', 'unchecked', 'Details changed: check the connection.', nowIso(), id);
    bust();
  }
  if (sets.length || secretsChanged.length) {
    await logAudit({ userId: user.id, actorName: user.name, action: 'WhatsApp number edited', entity: 'WaNumber', entityId: id, fromValue: row.label, toValue: `${[...changed, ...(secretsChanged.length ? [`${secretsChanged.join(', ')} replaced (value not shown)`] : [])].join('; ')}`.slice(0, 480) });
  }
  if (b.makeDefault === true && !row.isDefault) await setDefault(user, id);
  let status = null;
  if (b.check !== false && (sets.length || secretsChanged.length)) status = await check(id, { user }).catch(() => null);
  return { row: await getRowFresh(id), status };
}

async function setDefault(user, id, { quiet = false } = {}) {
  const row = await getRowFresh(id);
  if (!row) return { error: WORDS.NOT_FOUND, status: 404 };
  if (!row.active) return { error: 'Switch this number on before making it the default.', status: 409 };
  if (row.isDefault) return { ok: true, row };
  const before = await defaultRow();
  // one transaction: the unique index allows only one default, so the old flag is cleared in the same step
  await prisma.$transaction([
    prisma.$executeRawUnsafe('UPDATE "WaNumber" SET "isDefault" = 0, "updatedAt" = ? WHERE "isDefault" = 1 AND "removedAt" IS NULL', nowIso()),
    prisma.$executeRawUnsafe('UPDATE "WaNumber" SET "isDefault" = 1, "updatedAt" = ? WHERE "id" = ? AND "removedAt" IS NULL AND "active" = 1', nowIso(), id),
  ]);
  bust();
  if (!quiet) await logAudit({ userId: user.id, actorName: user.name, action: 'WhatsApp default number changed', entity: 'WaNumber', entityId: id, fromValue: before ? before.label : '(none)', toValue: row.label });
  return { ok: true, row: await getRowFresh(id) };
}

async function setActive(user, id, on) {
  const row = await getRowFresh(id);
  if (!row) return { error: WORDS.NOT_FOUND, status: 404 };
  if (on === row.active) return { ok: true, row };
  if (!on && row.isDefault && (await listRows()).some((r) => r.id !== id && r.active)) {
    return { error: 'This is the default number. Make another number the default first, then switch this one off.', status: 409 };
  }
  const st = await settings();
  if (!on && st.systemNumberId === id) return { error: 'System messages (OTP, reminders, agreement links) use this number. Choose another number for them first.', status: 409 };
  await run('UPDATE "WaNumber" SET "active" = ?, "updatedAt" = ? WHERE "id" = ?', on ? 1 : 0, nowIso(), id);
  bust();
  await logAudit({ userId: user.id, actorName: user.name, action: on ? 'WhatsApp number switched on' : 'WhatsApp number deactivated', entity: 'WaNumber', entityId: id, fromValue: on ? 'off' : 'on', toValue: `${row.label} (${row.displayNumber})` });
  if (on) await check(id, { user, quiet: true }).catch(() => {});
  return { ok: true, row: await getRowFresh(id) };
}

async function historyCount(id) {
  const m = num(((await q('SELECT COUNT(*) n FROM "WaMessageMap" WHERE "numberId" = ?', id))[0] || {}).n);
  const t = num(((await q('SELECT COUNT(*) n FROM "WaThread" WHERE "numberId" = ?', id))[0] || {}).n);
  return { messages: m, chats: t };
}
async function remove(user, id) {
  const row = await getRowFresh(id);
  if (!row) return { error: WORDS.NOT_FOUND, status: 404 };
  if (row.credSource === 'legacy') return { error: 'The Main number is set up in the WhatsApp Business form. You can switch it off here, but it cannot be removed from the list.', status: 409 };
  if (row.isDefault) return { error: 'This is the default number. Make another number the default first.', status: 409 };
  const st = await settings();
  if (st.systemNumberId === id) return { error: 'System messages use this number. Choose another number for them first.', status: 409 };
  const h = await historyCount(id);
  if (h.messages > 0 || h.chats > 0) return { error: `This number has ${h.messages} message${h.messages === 1 ? '' : 's'} in ${h.chats} chat${h.chats === 1 ? '' : 's'}. It cannot be removed, only switched off (the history stays).`, status: 409, history: h };
  await run('UPDATE "WaNumber" SET "removedAt" = ?, "removedByName" = ?, "active" = 0, "isDefault" = 0, "updatedAt" = ? WHERE "id" = ?', nowIso(), user.name, nowIso(), id);
  await run('DELETE FROM "WaNumberAccess" WHERE "numberId" = ?', id);
  await dropSecrets(id);
  bust();
  await logAudit({ userId: user.id, actorName: user.name, action: 'WhatsApp number removed', entity: 'WaNumber', entityId: id, toValue: `${row.label} (${row.displayNumber})` });
  return { ok: true };
}

const ASSIGNABLE_ROLES = [
  ['RECRUITER', 'Recruiters'], ['TL', 'Team leaders'], ['STL', 'Senior team leaders'], ['BDE', 'BDE team'], ['HR', 'HR'],
  ['MANAGER', 'Managers'], ['ASSISTANT_MANAGER', 'Assistant managers'], ['ACCOUNTANT', 'Accounts'], ['EMPLOYEE', 'Employees'],
];
// EVERY department there is (founder, 2026-10-23: "whom to give a number is the Admin's choice: no restrictions like this"). The Department list (active or not),
// every department an employee or a login really has (IT, Recruitment ...), and any department already ticked on a number - so a tick that was saved
// earlier is never refused, and the picker shows every department with its people.
async function departmentsMaster() {
  const names = new Map();
  const add = (n) => { const t = String(n || '').trim(); if (t && !names.has(t.toLowerCase())) names.set(t.toLowerCase(), t); };
  (await prisma.department.findMany({ select: { name: true } }).catch(() => [])).forEach((d) => add(d.name));
  (await prisma.employee.findMany({ where: { department: { not: null } }, distinct: ['department'], select: { department: true } }).catch(() => [])).forEach((e) => add(e.department));
  (await prisma.user.findMany({ where: { atsDepartment: { not: null } }, distinct: ['atsDepartment'], select: { atsDepartment: true } }).catch(() => [])).forEach((u) => add(u.atsDepartment));
  try { (await q('SELECT DISTINCT "refId" FROM "WaNumberAccess" WHERE "kind" = ?', 'DEPARTMENT')).forEach((r) => add(r.refId)); } catch { /* no access table yet */ }
  return [...names.values()].sort((a, b) => a.localeCompare(b));
}
// b: { departments: [name], userIds: [id], roles: [code], everyone: bool }
async function setAccess(user, id, b, { quiet = false } = {}) {
  const row = await getRowFresh(id);
  if (!row) return { error: WORDS.NOT_FOUND, status: 404 };
  const master = await departmentsMaster();
  const depts = [];
  for (const d of (Array.isArray(b.departments) ? b.departments : [])) {
    const typed = clip(d, 60);
    if (!typed) continue; // eslint-disable-line no-continue
    const hit = master.find((m) => m.toLowerCase() === typed.toLowerCase()) || typed; // a department that is not on the list yet is still accepted
    if (!depts.includes(hit)) depts.push(hit);
  }
  const ids = [...new Set((Array.isArray(b.userIds) ? b.userIds : []).map(String).filter(Boolean))];
  const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids }, status: 'Active' }, select: { id: true, name: true } }) : [];
  // a person who is gone or no longer active is simply left out (the rest is saved): nobody is refused for one stale name
  const roles = [];
  for (const r of (Array.isArray(b.roles) ? b.roles : [])) {
    const code = String(r).trim().toUpperCase();
    if (!code) continue; // eslint-disable-line no-continue
    if (!roles.includes(code)) roles.push(code);
  }
  const want = [
    ...depts.map((d) => ({ kind: 'DEPARTMENT', refId: d, refLabel: d })),
    ...users.map((u) => ({ kind: 'USER', refId: u.id, refLabel: u.name })),
    ...roles.map((r) => ({ kind: 'ROLE', refId: r, refLabel: (ASSIGNABLE_ROLES.find(([c]) => c === r) || [])[1] || r })),
    ...(b.everyone === true ? [{ kind: 'ROLE', refId: '*', refLabel: 'Everyone' }] : []),
  ];
  const have = await q('SELECT * FROM "WaNumberAccess" WHERE "numberId" = ?', id);
  const key = (a) => `${a.kind}|${a.refId}`;
  const haveKeys = new Set(have.map(key)); const wantKeys = new Set(want.map(key));
  const added = want.filter((a) => !haveKeys.has(key(a)));
  const removed = have.filter((a) => !wantKeys.has(key(a)));
  const t = nowIso();
  const ops = [];
  removed.forEach((a) => ops.push(prisma.$executeRawUnsafe('DELETE FROM "WaNumberAccess" WHERE "id" = ?', a.id)));
  added.forEach((a) => ops.push(prisma.$executeRawUnsafe('INSERT OR IGNORE INTO "WaNumberAccess" ("id","numberId","kind","refId","refLabel","grantedById","grantedByName","grantedAt") VALUES (?,?,?,?,?,?,?,?)', newId('wac'), id, a.kind, a.refId, a.refLabel, user.id, user.name, t)));
  if (ops.length) await prisma.$transaction(ops);
  bust(); idCache.clear();
  if (!quiet && (added.length || removed.length)) {
    const w = (list) => list.map((a) => (a.kind === 'DEPARTMENT' ? `${a.refId} (department)` : a.kind === 'ROLE' ? (a.refId === '*' ? 'Everyone' : `${a.refLabel || a.refId} (role)`) : `${a.refLabel || a.refId}`)).join(', ') || '-';
    await logAudit({ userId: user.id, actorName: user.name, action: 'WhatsApp number assignment changed', entity: 'WaNumber', entityId: id, fromValue: `${row.label}: removed ${w(removed)}`.slice(0, 480), toValue: `${row.label}: added ${w(added)}`.slice(0, 480) });
  }
  return { ok: true, added: added.length, removed: removed.length, row: await getRowFresh(id) };
}

// ---- the shapes the browser sees (never a secret) ---------------------------------------------------------------------------------------------------
const CHIP = {
  connected: { label: 'Connected', tone: 'green' },
  verification_required: { label: 'Verification Required', tone: 'amber' },
  disconnected: { label: 'Disconnected', tone: 'red' },
  switched_off: { label: 'Switched off', tone: 'grey' },
  test_mode: { label: 'Test mode', tone: 'blue' },
  unchecked: { label: 'Not checked yet', tone: 'grey' },
};
function chipOf(row) {
  const code = !row.active ? 'switched_off' : (row.statusCode || 'unchecked');
  const c = CHIP[code] || CHIP.unchecked;
  return { code, label: c.label, tone: c.tone, text: !row.active ? 'Switched off by the Admin.' : (row.statusText || ''), checkedAt: row.checkedAt || null, quality: row.qualityRating || '', verifiedName: row.verifiedName || '', webhookNote: row.webhookNote || '' };
}
async function shapeRows(rows, access) {
  const userIds = [...new Set(access.filter((a) => a.kind === 'USER').map((a) => a.refId))];
  const names = userIds.length ? new Map((await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, status: true } })).map((u) => [u.id, u])) : new Map();
  const legacy = await wa().legacyConfig().catch(() => null);
  const formRow = await prisma.integration.findUnique({ where: { id: 'whatsapp' } }).catch(() => null);
  const out = [];
  for (const r of rows) {
    const acc = access.filter((a) => a.numberId === r.id);
    const sec = r.credSource === 'legacy' ? null : await readSecrets(r.id);
    const secRow = r.credSource === 'legacy' || r.tokenMode === 'shared' ? null : await prisma.appSetting.findUnique({ where: { key: `${SEC_PREFIX}${r.id}` } }).catch(() => null);
    const useForm = r.credSource === 'legacy' || r.tokenMode === 'shared';
    out.push({
      id: r.id, label: r.label, displayNumber: r.displayNumber, phoneNumberId: r.phoneNumberId, wabaId: r.wabaId || '',
      isMain: r.credSource === 'legacy', isDefault: r.isDefault, active: r.active,
      tokenMode: r.tokenMode, tokenSaved: r.credSource === 'legacy' ? !!(legacy && legacy.token) : (r.tokenMode === 'shared' ? !!(legacy && legacy.token) : !!(sec && sec.has.token)),
      tokenSource: useForm ? (r.credSource === 'legacy' ? 'The WhatsApp Business form' : 'The shared token (WhatsApp Business form)') : "This number's own token",
      tokenTag: useForm ? tagOf(legacy && legacy.token) : tagOf(sec && sec.token),
      tokenSavedAt: useForm ? ((formRow && formRow.updatedAt) || null) : ((secRow && secRow.updatedAt) || null),
      appSecretOwn: !!(sec && sec.has.appSecret), verifyTokenOwn: !!(sec && sec.has.verifyToken),
      language: r.language || '', tplLink: r.tplLink || '', tplOtp: r.tplOtp || '', tplBulk: r.tplBulk || '',
      departments: acc.filter((a) => a.kind === 'DEPARTMENT').map((a) => a.refId),
      roles: acc.filter((a) => a.kind === 'ROLE' && a.refId !== '*').map((a) => ({ code: a.refId, label: a.refLabel || a.refId })),
      everyone: acc.some((a) => a.kind === 'ROLE' && a.refId === '*'),
      users: acc.filter((a) => a.kind === 'USER').map((a) => ({ id: a.refId, name: (names.get(a.refId) || {}).name || a.refLabel || 'Unknown', inactive: !!(names.get(a.refId) && names.get(a.refId).status !== 'Active') })),
      notAssigned: acc.length === 0,
      status: chipOf(r), createdAt: r.createdAt, createdByName: r.createdByName || '',
    });
  }
  return out;
}

// The Admin's list. The old connection is shown as "Main number (default)" until it is moved into the list.
async function adminList() {
  const ready = await tableReady();
  const { rows, access } = ready ? await load() : { rows: [], access: [] };
  const numbers = await shapeRows(rows, access);
  const legacy = await wa().legacyConfig().catch(() => null);
  const legacyListed = rows.some((r) => r.credSource === 'legacy');
  const st = await settings();
  const counts = { connected: 0, verification_required: 0, disconnected: 0, switched_off: 0, test_mode: 0, unchecked: 0 };
  numbers.forEach((n) => { counts[n.status.code] = (counts[n.status.code] || 0) + 1; });
  const virtualMain = !legacyListed && legacy && legacy.phoneId ? {
    id: 'legacy', virtual: true, label: 'Main number', displayNumber: legacy.display || '', phoneNumberId: legacy.phoneId, wabaId: legacy.wabaId || '', isMain: true, isDefault: rows.length === 0, active: !!legacy.configured,
    tokenSaved: !!legacy.token, departments: [], roles: [], everyone: true, users: [], notAssigned: false,
    status: { code: legacy.configured ? 'unchecked' : 'disconnected', label: legacy.configured ? 'Connected (single number)' : 'Not set up', tone: legacy.configured ? 'green' : 'red', text: legacy.configured ? 'This is the number everyone uses today. Press "Move it into the list" to manage it here.' : legacy.reason, checkedAt: null },
  } : null;
  return {
    numbers: virtualMain ? [virtualMain, ...numbers] : numbers,
    listed: rows.length > 0,
    counts, unknownMessages: await unknownCount(),
    settings: st,
    roles: ASSIGNABLE_ROLES.map(([code, label]) => ({ code, label })),
    departments: await departmentsMaster(),
    webhookPath: '/api/webhooks/whatsapp',
    webhookUrl: `${String(process.env.APP_BASE_URL || '').replace(/\/+$/, '')}/api/webhooks/whatsapp`,
    sharedTokenSaved: !!(legacy && legacy.token), sharedAppSecretSaved: !!(legacy && legacy.appSecret),
    reconnectLimitPerHour: RECONNECT_LIMIT,
  };
}

// People for the Assign window (type-to-search checkbox list).
async function people() {
  const emps = await prisma.employee.findMany({ where: { userId: { not: null }, employmentStatus: 'Active' }, select: { userId: true, name: true, designation: true, department: true, employeeCode: true }, orderBy: { name: 'asc' }, take: 2000 });
  const users = await prisma.user.findMany({ where: { id: { in: emps.map((e) => e.userId) }, status: 'Active' }, select: { id: true, role: true } });
  const ok = new Set(users.filter((u) => !EXTERNAL_ROLES.includes(u.role)).map((u) => u.id));
  return emps.filter((e) => ok.has(e.userId)).map((e) => ({ userId: e.userId, name: e.name, designation: e.designation || '', department: e.department || '', code: e.employeeCode || '' }));
}
// departments with how many people sit in each (for the checkbox list)
async function departmentCounts() {
  const master = await departmentsMaster();
  const emps = await prisma.employee.findMany({ where: { userId: { not: null }, employmentStatus: 'Active' }, select: { department: true } });
  const by = {};
  emps.forEach((e) => { const k = canon(e.department); if (k) by[k] = (by[k] || 0) + 1; });
  return master.map((name) => ({ name, people: by[canon(name)] || 0 }));
}
// "N people can send from this number" (an estimate from the saved department / person / role ticks)
async function effectivePeople(id) {
  const row = await getRowFresh(id);
  if (!row) return null;
  const acc = await q('SELECT * FROM "WaNumberAccess" WHERE "numberId" = ?', id);
  const st = await settings();
  const rows = await prisma.user.findMany({ where: { status: 'Active', role: { notIn: EXTERNAL_ROLES } }, select: { id: true, name: true, role: true, atsRole: true, hrmsRole: true, accountsRole: true, atsDepartment: true, atsScopeDepartments: true, atsScopeTeams: true } });
  const emps = await prisma.employee.findMany({ where: { userId: { in: rows.map((r) => r.id) } }, select: { userId: true, department: true, team: true, designation: true } });
  const eBy = new Map(emps.map((e) => [e.userId, e]));
  const out = [];
  rows.forEach((u) => {
    const e = eBy.get(u.id) || {};
    const probe = { id: u.id, role: u.role, atsRole: u.atsRole, hrmsRole: u.hrmsRole, accountsRole: u.accountsRole, department: e.department, team: e.team, atsDepartment: u.atsDepartment, atsScopeDepartments: u.atsScopeDepartments, atsScopeTeams: u.atsScopeTeams };
    const admin = isAdminLike(probe) && st.adminsAllNumbers !== false;
    if (holdsAccess(probe, acc)) out.push({ id: u.id, name: u.name, designation: e.designation || '', department: e.department || '', via: 'assigned' });
    else if (admin) out.push({ id: u.id, name: u.name, designation: e.designation || '', department: e.department || '', via: 'admin' });
  });
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { count: out.length, assigned: out.filter((x) => x.via === 'assigned').length, people: out.slice(0, 300) };
}

// What a normal login gets: the numbers it may use (label + number, nothing about credentials).
async function myNumbers(user) {
  if (!(await hasNumbers())) return { legacy: true, numbers: [], defaultId: null, canSend: true };
  const mine = await authorisedRows(user, { includeOff: true });
  const out = [];
  for (const r of mine) {
    const cfg = await configOf(r); // eslint-disable-line no-await-in-loop
    out.push({ id: r.id, label: r.label, displayNumber: r.displayNumber, isDefault: r.isDefault, usable: !!(r.active && cfg && cfg.configured), reason: !r.active ? 'Switched off by the Admin.' : (cfg && cfg.configured ? '' : (cfg ? cfg.reason : '')), status: chipOf(r).label });
  }
  const pick = await resolveSender({ user }).catch(() => null);
  return {
    legacy: false, numbers: out,
    defaultId: pick && pick.ok ? pick.number.id : null,
    canSend: out.some((n) => n.usable),
    message: out.length ? (out.some((n) => n.usable) ? '' : 'The WhatsApp numbers assigned to you are switched off or not connected. Ask the Admin.') : WORDS.NO_NUMBER,
  };
}

// The text added to a sent message's "via" line, and the number a message used (for timelines).
async function labelsOf(ids) {
  const rows = await listRows();
  const m = new Map();
  rows.forEach((r) => m.set(r.id, { id: r.id, label: r.label, displayNumber: r.displayNumber }));
  return m;
}

module.exports = {
  ensure, tableReady, hasNumbers, listRows, getRow, getRowFresh, bust, DDL_COUNT,
  settings, saveSettings, accessOf,
  configOf, defaultRow, defaultConfig,
  resolveSender, planNumber, recheck, authorisedRows, mayUse, visibleNumberIds, holdsAccess, departmentsOfUser, rolesOfUser, isAdminLike,
  filterRows, threadNumbers, hiddenPersons, noteMessage, tagThread, numberOfMessage, numbersOfMessages, threadsOfContact, windowOpenOn, openWindowsOn, windowOpenFor, openWindowsFor, windowOpenSystem, anyUsable,
  rowByPhoneId, verifyTokens, appSecretOf, allAppSecrets, noteUnknown, unknownCount,
  statusFromMeta, check, noteSendOk, afterLegacyTokenChange, tagOf, reconnectAllowed, reconnectLimit: () => RECONNECT_LIMIT, noteSendFailure,
  importMain, create, update, setDefault, setActive, remove, setAccess, historyCount,
  adminList, people, departmentCounts, effectivePeople, myNumbers, labelsOf, chipOf, validate, cleanE164,
  ASSIGNABLE_ROLES, WORDS, CHIP, UNKNOWN_PROVIDER, DDL,
};
