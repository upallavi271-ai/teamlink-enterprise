// ---------------------------------------------------------------------------
// COMPANY SECURITY SETTINGS (founder 2026-11-17, "Security first": the audit's password-policy and IP allow-list gaps).
// Super Admin / Admin set them on Profile -> Security settings. Both are OFF / at today's rules until somebody changes them.
//
// PASSWORD POLICY (AppSetting security.passwordPolicy)
//   minLength 8..32 (today 8) · requireUpper · requireSymbol · expiryDays (0 = never; else the person must choose a new one
//   after that many days - the existing "Change your password now" screen) · historyCount (0..10: the last N passwords may not
//   be used again; table "PasswordHistory", bcrypt hashes only). The always-on rules in utils/passwordPolicy.js stay.
//
// IP ALLOW-LIST (AppSetting security.ipAllow)
//   { enabled, entries: ['183.82.4.247', '10.0.0.0/8', ...], exemptRoles: ['SUPER_ADMIN'] }
//   When on, a STAFF login may sign in and work only from those addresses (IPv4 exact or CIDR, IPv6 exact). Clients,
//   candidates, vendors and partners are never held (they sign in from anywhere). A Super Admin is exempt by default, so
//   the company can never be locked out; it cannot be switched on from an address that is not on the list.
//   Checked at sign-in (routes/auth.js) and on every request (middleware/auth.js), cached 30 s.
// ---------------------------------------------------------------------------
const bcrypt = require('bcryptjs');
const prisma = require('../db');

const PW_KEY = 'security.passwordPolicy';
const IP_KEY = 'security.ipAllow';
const PW_DEFAULT = { minLength: 8, requireUpper: false, requireSymbol: false, expiryDays: 0, historyCount: 0 };
const IP_DEFAULT = { enabled: false, entries: [], exemptRoles: ['SUPER_ADMIN'] };
let pw = { ...PW_DEFAULT };
let ip = { ...IP_DEFAULT };
let loadedAt = 0;

function cleanPw(v) {
  const o = { ...PW_DEFAULT, ...(v || {}) };
  return {
    minLength: Math.max(8, Math.min(32, Math.round(Number(o.minLength) || 8))),
    requireUpper: !!o.requireUpper,
    requireSymbol: !!o.requireSymbol,
    expiryDays: [0, 30, 45, 60, 90, 180, 365].includes(Number(o.expiryDays)) ? Number(o.expiryDays) : 0,
    historyCount: Math.max(0, Math.min(10, Math.round(Number(o.historyCount) || 0))),
  };
}
// ---- addresses ----
const v4 = (s) => { const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s || '').trim()); if (!m) return null; const p = m.slice(1).map(Number); return p.every((x) => x <= 255) ? ((p[0] * 256 + p[1]) * 256 + p[2]) * 256 + p[3] : null; };
const normIp = (s) => String(s || '').trim().replace(/^::ffff:/i, '').toLowerCase();
function validEntry(e) {
  const s = String(e || '').trim();
  const [addr, bits] = s.split('/');
  if (v4(addr) != null) return bits === undefined || (/^\d+$/.test(bits) && Number(bits) >= 8 && Number(bits) <= 32);
  return bits === undefined && /^[0-9a-f:]+$/i.test(addr) && addr.includes(':');
}
function ipMatches(addr, entry) {
  const a = normIp(addr);
  const [base, bits] = String(entry || '').trim().split('/');
  const av = v4(a); const bv = v4(base);
  if (av != null && bv != null) {
    const n = bits === undefined ? 32 : Number(bits);
    const span = 2 ** (32 - n);
    return Math.floor(av / span) === Math.floor(bv / span);
  }
  return a === normIp(base);
}
function cleanIp(v) {
  const o = { ...IP_DEFAULT, ...(v || {}) };
  return {
    enabled: !!o.enabled,
    entries: [...new Set((Array.isArray(o.entries) ? o.entries : String(o.entries || '').split(/[\s,]+/)).map((x) => String(x).trim()).filter(Boolean))].filter(validEntry).slice(0, 100),
    exemptRoles: (Array.isArray(o.exemptRoles) ? o.exemptRoles : ['SUPER_ADMIN']).filter((r) => ['SUPER_ADMIN', 'ADMIN'].includes(r)),
  };
}

async function refresh() {
  const rows = await prisma.appSetting.findMany({ where: { key: { in: [PW_KEY, IP_KEY] } } }).catch(() => []);
  const val = (k) => { const r = rows.find((x) => x.key === k); try { return r ? JSON.parse(r.value) : null; } catch { return null; } };
  pw = cleanPw(val(PW_KEY));
  ip = cleanIp(val(IP_KEY));
  loadedAt = Date.now();
}
async function fresh() { if (Date.now() - loadedAt > 30000) await refresh(); }
refresh().catch(() => {});

const passwordPolicy = () => ({ ...pw });
const ipAllow = () => ({ ...ip, entries: [...ip.entries] });

// the company's extra rules for a new password (sync: utils/passwordPolicy.js strengthError calls it)
function extraStrengthError(password) {
  const p = String(password || '');
  if (p.length < pw.minLength) return `Choose a password of at least ${pw.minLength} characters.`;
  if (pw.requireUpper && (!/[A-Z]/.test(p) || !/[a-z]/.test(p))) return 'Use at least one capital letter and one small letter.';
  if (pw.requireSymbol && !/[^A-Za-z0-9]/.test(p)) return 'Use at least one symbol, like ! @ # or -.';
  return null;
}
// the last N passwords may not come back (history + the current one)
async function ensureHistory() {
  await prisma.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS "PasswordHistory" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "userId" TEXT NOT NULL, "hash" TEXT NOT NULL, "at" TEXT NOT NULL)');
}
async function reuseError(user, password) {
  await fresh();
  if (!pw.historyCount || !user) return null;
  await ensureHistory();
  const rows = await prisma.$queryRawUnsafe('SELECT "hash" FROM "PasswordHistory" WHERE "userId" = ? ORDER BY "id" DESC LIMIT ?', String(user.id), pw.historyCount);
  const hashes = [user.passwordHash, ...rows.map((r) => r.hash)].filter(Boolean).slice(0, pw.historyCount);
  for (const h of hashes) {
    // eslint-disable-next-line no-await-in-loop
    if (await bcrypt.compare(String(password), h)) return `Choose a password you have not used for your last ${pw.historyCount} passwords.`;
  }
  return null;
}
// called with the OLD hash once a new password is saved
async function remember(userId, oldHash) {
  if (!userId || !oldHash) return;
  await ensureHistory();
  await prisma.$executeRawUnsafe('INSERT INTO "PasswordHistory" ("userId","hash","at") VALUES (?,?,?)', String(userId), String(oldHash), new Date().toISOString());
  await prisma.$executeRawUnsafe('DELETE FROM "PasswordHistory" WHERE "userId" = ? AND "id" NOT IN (SELECT "id" FROM "PasswordHistory" WHERE "userId" = ? ORDER BY "id" DESC LIMIT 10)', String(userId), String(userId));
}
// expired? (utils/seedPasswords.js mustChange -> the "Change your password now" screen)
function expired(passwordChangedAt, role) {
  if (!pw.expiryDays || !passwordChangedAt || ['CLIENT', 'CANDIDATE'].includes(role)) return false;
  return Date.now() - new Date(passwordChangedAt).getTime() > pw.expiryDays * 86400000;
}

// ---- IP allow-list check ----
const rolesOf = (u) => [u && u.role, u && u.hrmsRole, u && u.atsRole, u && u.accountsRole].filter(Boolean);
async function ipRefusal(user, addr) {
  await fresh();
  if (!ip.enabled || !ip.entries.length || !user) return null;
  const roles = rolesOf(user);
  if (roles.some((r) => ['CLIENT', 'CANDIDATE'].includes(r)) || user.portalType) return null;
  if (roles.some((r) => ip.exemptRoles.includes(r))) return null;
  if (ip.entries.some((e) => ipMatches(addr, e))) return null;
  return { code: 'IP_NOT_ALLOWED', error: `TeamLink can be opened only from the office network. Your address (${normIp(addr) || 'unknown'}) is not on the company's list. Ask your administrator.` };
}

async function setPasswordPolicy(v) {
  const clean = cleanPw(v);
  await prisma.appSetting.upsert({ where: { key: PW_KEY }, create: { key: PW_KEY, value: JSON.stringify(clean) }, update: { value: JSON.stringify(clean) } });
  await refresh();
  return clean;
}
async function setIpAllow(v, { adminIp, adminRoles = [] } = {}) {
  const clean = cleanIp(v);
  const bad = (Array.isArray(v && v.entries) ? v.entries : String((v && v.entries) || '').split(/[\s,]+/)).map((x) => String(x).trim()).filter(Boolean).filter((x) => !validEntry(x));
  if (bad.length) return { error: `These are not addresses: ${bad.slice(0, 5).join(', ')}. Use 183.82.4.247 or 183.82.4.0/24.` };
  if (clean.enabled && !clean.entries.length) return { error: 'Add at least one address before switching it on.' };
  if (clean.enabled && !adminRoles.some((r) => clean.exemptRoles.includes(r)) && !clean.entries.some((e) => ipMatches(adminIp, e))) {
    return { error: `Your own address (${normIp(adminIp)}) is not on the list, so switching it on would lock you out. Add it first.` };
  }
  await prisma.appSetting.upsert({ where: { key: IP_KEY }, create: { key: IP_KEY, value: JSON.stringify(clean) }, update: { value: JSON.stringify(clean) } });
  await refresh();
  return { value: clean };
}

module.exports = {
  passwordPolicy, ipAllow, extraStrengthError, reuseError, remember, expired, ipRefusal, setPasswordPolicy, setIpAllow,
  refresh, ipMatches, validEntry, normIp, PW_DEFAULT,
};
