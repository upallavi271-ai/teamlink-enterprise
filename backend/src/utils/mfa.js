// ---------------------------------------------------------------------------
// TWO-STEP SIGN-IN (founder 2026-11-17: "Security first" - the audit's two-factor gap; design in docs/SECURITY-MFA.md).
//
// An authenticator app (Google Authenticator, Microsoft Authenticator, Authy ...) gives a 6-digit code that changes every 30
// seconds. Standard TOTP (RFC 6238: HMAC-SHA1, 30 s, 6 digits), written on Node's crypto - no dependency for the maths.
//
//   * Anybody turns it on for their own login (My Profile -> Two-step sign-in): scan the QR (or type the setup key), type one
//     code to prove it works, keep the 10 one-time recovery codes shown once.
//   * Sign-in then asks for the code after the password. A recovery code works instead, once.
//   * Company rule (Super Admin / Admin): "compulsory for" a list of roles (AppSetting security.mfaRequiredRoles, default none).
//     A login of such a role that has not set it up is sent to set it up right after the password and cannot go on until done.
//   * A Super Admin resets another login's two-step (lost phone); an Admin may reset anybody but a Super Admin. Audited.
//
// Stored in its own table "UserMfa" (raw SQL, created on first use - no Prisma migration): the secret AES-256-GCM encrypted
// (key from MFA_ENC_KEY, else derived from JWT_SECRET), recovery codes as SHA-256 hashes, the last accepted time step (a code
// works once). The secret is never sent again after set-up.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');

const STEP = 30;
const DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const ISSUER = 'TeamLink';

// ---- base32 / TOTP --------------------------------------------------------------------------------------
function b32encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8; // eslint-disable-line no-bitwise
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } // eslint-disable-line no-bitwise
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]; // eslint-disable-line no-bitwise
  return out;
}
function b32decode(s) {
  const clean = String(s || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0; let value = 0; const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch); bits += 5; // eslint-disable-line no-bitwise
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } // eslint-disable-line no-bitwise
  }
  return Buffer.from(out);
}
function hotp(secretBuf, counter, digits = DIGITS, algo = 'sha1') {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac(algo, secretBuf).update(msg).digest();
  const off = h[h.length - 1] & 15; // eslint-disable-line no-bitwise
  const bin = ((h[off] & 127) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]; // eslint-disable-line no-bitwise
  return String(bin % (10 ** digits)).padStart(digits, '0');
}
const stepAt = (ms = Date.now()) => Math.floor(ms / 1000 / STEP);
const totp = (secretB32, ms = Date.now()) => hotp(b32decode(secretB32), stepAt(ms));
// The step the code belongs to (now, or one step either side for clock drift), or null. A step at or before lastStep is refused (replay).
function verifyCode(secretB32, code, { lastStep = null, ms = Date.now() } = {}) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const key = b32decode(secretB32);
  const now = stepAt(ms);
  for (const s of [now, now - 1, now + 1]) {
    if (lastStep != null && s <= lastStep) continue; // eslint-disable-line no-continue
    const want = hotp(key, s);
    if (crypto.timingSafeEqual(Buffer.from(want), Buffer.from(c))) return s;
  }
  return null;
}
const newSecret = () => b32encode(crypto.randomBytes(20));
const otpauthUri = (secretB32, account) => `otpauth://totp/${encodeURIComponent(`${ISSUER}:${account}`)}?secret=${secretB32}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`;

// ---- encryption of the secret ----------------------------------------------------------------------------
function keyBuf() {
  const base = process.env.MFA_ENC_KEY || `${process.env.JWT_SECRET || 'teamlink'}:mfa-secret-v1`;
  return crypto.createHash('sha256').update(base).digest();
}
function seal(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyBuf(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['m1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}
function open(sealed) {
  try {
    const [v, iv, tag, ct] = String(sealed || '').split(':');
    if (v !== 'm1') return null;
    const d = crypto.createDecipheriv('aes-256-gcm', keyBuf(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  } catch { return null; }
}

// ---- recovery codes --------------------------------------------------------------------------------------
const hashCode = (code) => crypto.createHash('sha256').update(`mfa-recovery:${String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '')}`).digest('hex');
function newRecoveryCodes(n = 10) {
  const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: n }, () => {
    const raw = Array.from(crypto.randomBytes(10), (b) => alpha[b % alpha.length]).join('');
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

// ---- storage ---------------------------------------------------------------------------------------------
let READY = null;
function ensure() {
  if (!READY) {
    READY = prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "UserMfa" (
      "userId" TEXT PRIMARY KEY, "secretEnc" TEXT, "enabledAt" TEXT, "recovery" TEXT, "lastStep" INTEGER,
      "pendingEnc" TEXT, "pendingAt" TEXT, "updatedAt" TEXT)`).catch((e) => { READY = null; throw e; });
  }
  return READY;
}
async function rowOf(userId) {
  await ensure();
  const rows = await prisma.$queryRawUnsafe('SELECT * FROM "UserMfa" WHERE "userId" = ?', String(userId));
  return rows[0] || null;
}
async function save(userId, patch) {
  await ensure();
  const cur = (await rowOf(userId)) || { userId: String(userId) };
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  await prisma.$executeRawUnsafe(
    `INSERT INTO "UserMfa" ("userId","secretEnc","enabledAt","recovery","lastStep","pendingEnc","pendingAt","updatedAt") VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT("userId") DO UPDATE SET "secretEnc"=excluded."secretEnc","enabledAt"=excluded."enabledAt","recovery"=excluded."recovery",
     "lastStep"=excluded."lastStep","pendingEnc"=excluded."pendingEnc","pendingAt"=excluded."pendingAt","updatedAt"=excluded."updatedAt"`,
    next.userId, next.secretEnc || null, next.enabledAt || null, next.recovery || null, next.lastStep == null ? null : Number(next.lastStep),
    next.pendingEnc || null, next.pendingAt || null, next.updatedAt,
  );
  return next;
}
const recoveryList = (row) => { try { const a = JSON.parse(row && row.recovery); return Array.isArray(a) ? a : []; } catch { return []; } };

async function statusOf(userId) {
  const row = await rowOf(userId);
  return { enabled: !!(row && row.enabledAt && row.secretEnc), enabledAt: (row && row.enabledAt) || null, recoveryLeft: recoveryList(row).length };
}
const isOn = async (userId) => (await statusOf(userId)).enabled;

// Set-up step 1: a new secret, kept as "pending" until a code proves the phone has it (10 minutes).
async function start(userId, account) {
  const secret = newSecret();
  await save(userId, { pendingEnc: seal(secret), pendingAt: new Date().toISOString() });
  const uri = otpauthUri(secret, account);
  let qrSvg = null;
  try { qrSvg = await require('qrcode').toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }); } catch { qrSvg = null; } // eslint-disable-line global-require
  return { secret: secret.replace(/(.{4})/g, '$1 ').trim(), otpauth: uri, qrSvg };
}
// Set-up step 2: the code from the app turns it on and returns the recovery codes (once).
async function confirm(userId, code) {
  const row = await rowOf(userId);
  if (!row || !row.pendingEnc) return { ok: false, error: 'Start the set-up again: press "Turn on".' };
  if (Date.now() - new Date(row.pendingAt).getTime() > 10 * 60000) return { ok: false, error: 'The set-up took longer than 10 minutes. Press "Turn on" again.' };
  const secret = open(row.pendingEnc);
  const step = secret && verifyCode(secret, code);
  if (step == null) return { ok: false, error: 'That code is not right. Type the 6-digit code your app shows now.' };
  const codes = newRecoveryCodes();
  await save(userId, { secretEnc: seal(secret), enabledAt: new Date().toISOString(), recovery: JSON.stringify(codes.map(hashCode)), lastStep: step, pendingEnc: null, pendingAt: null });
  return { ok: true, recoveryCodes: codes };
}
// At sign-in: a 6-digit code (once per step) or a recovery code (once).
async function check(userId, { code, recoveryCode } = {}) {
  const row = await rowOf(userId);
  if (!row || !row.enabledAt || !row.secretEnc) return { ok: false, error: 'Two-step sign-in is not set up for this login.' };
  if (recoveryCode) {
    const h = hashCode(recoveryCode);
    const list = recoveryList(row);
    if (!list.includes(h)) return { ok: false, error: 'That recovery code is not right, or it was used before.' };
    await save(userId, { recovery: JSON.stringify(list.filter((x) => x !== h)) });
    return { ok: true, used: 'recovery', recoveryLeft: list.length - 1 };
  }
  const secret = open(row.secretEnc);
  if (!secret) return { ok: false, error: 'Two-step sign-in cannot be read. Ask an administrator to reset it.' };
  const step = verifyCode(secret, code, { lastStep: row.lastStep });
  if (step == null) return { ok: false, error: 'That code is not right. Type the 6-digit code your app shows now.' };
  await save(userId, { lastStep: step });
  return { ok: true, used: 'code' };
}
async function newRecovery(userId) {
  const codes = newRecoveryCodes();
  await save(userId, { recovery: JSON.stringify(codes.map(hashCode)) });
  return codes;
}
async function turnOff(userId) {
  await ensure();
  await prisma.$executeRawUnsafe('DELETE FROM "UserMfa" WHERE "userId" = ?', String(userId));
}

// ---- the company rule ------------------------------------------------------------------------------------
const POLICY_KEY = 'security.mfaRequiredRoles';
const POLICY_ROLES = ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'HR', 'STL', 'TL', 'BDE', 'ACCOUNTANT', 'RECRUITER', 'EMPLOYEE'];
async function requiredRoles() {
  const row = await prisma.appSetting.findUnique({ where: { key: POLICY_KEY } }).catch(() => null);
  try { const a = JSON.parse(row && row.value); return Array.isArray(a) ? a.filter((r) => POLICY_ROLES.includes(r)) : []; } catch { return []; }
}
async function setRequiredRoles(list) {
  const clean = [...new Set((Array.isArray(list) ? list : []).map(String).filter((r) => POLICY_ROLES.includes(r)))];
  await prisma.appSetting.upsert({ where: { key: POLICY_KEY }, create: { key: POLICY_KEY, value: JSON.stringify(clean) }, update: { value: JSON.stringify(clean) } });
  return clean;
}
// Does the company rule cover this login (any of its roles)? Clients and candidates are never covered.
async function requiredFor(user) {
  const roles = await requiredRoles();
  if (!roles.length || !user) return false;
  const held = [user.role, user.hrmsRole, user.atsRole, user.accountsRole].filter(Boolean);
  if (held.some((r) => ['CLIENT', 'CANDIDATE'].includes(r)) && !held.some((r) => roles.includes(r) && !['CLIENT', 'CANDIDATE'].includes(r))) return false;
  return held.some((r) => roles.includes(r));
}

// ---- the 5-minute ticket between the password and the code -----------------------------------------------
// Signed with its OWN key, so it can never pass as a session token (middleware/auth.js verifies with JWT_SECRET alone).
const jwt = require('jsonwebtoken');
const ticketKey = () => `${process.env.JWT_SECRET || 'teamlink'}:mfa-ticket-v1`;
const fp = (hash) => crypto.createHash('sha256').update(String(hash || '')).digest('hex').slice(0, 16);
function makeTicket(user, purpose) {
  return jwt.sign({ t: 'mfa', u: user.id, p: purpose, f: fp(user.passwordHash) }, ticketKey(), { expiresIn: purpose === 'enrol' ? '15m' : '5m' });
}
function readTicket(ticket, purpose) {
  try {
    const c = jwt.verify(String(ticket || ''), ticketKey());
    if (c.t !== 'mfa' || (purpose && c.p !== purpose)) return null;
    return c;
  } catch { return null; }
}

module.exports = {
  // maths (exported for the known-answer tests)
  b32encode, b32decode, hotp, totp, verifyCode, stepAt, otpauthUri,
  ensure, statusOf, isOn, start, confirm, check, newRecovery, turnOff,
  POLICY_ROLES, requiredRoles, setRequiredRoles, requiredFor,
  makeTicket, readTicket, fp,
};
