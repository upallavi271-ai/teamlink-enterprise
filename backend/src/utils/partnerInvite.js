// ---------------------------------------------------------------------------
// PARTNER SET-PASSWORD LINKS (security fix 2026-10-13).
//
// Nobody sets, sees or is told a partner's password any more. An Admin makes a
// LINK; the partner opens it and chooses their own password - the same pattern
// as the vendor invite (utils/vendorInvite.js) and the staff set-password link.
//
// The link is STATELESS (no new table): a signed token
//     base64url({ u: partnerUserId, h: first 16 hex of sha256(current hash), e: expiry }) . HMAC
// that is
//   * single use   - it carries a fingerprint of the login's CURRENT password
//                    hash; choosing a password (or making a newer link, which
//                    swaps in a fresh unguessable hash) changes the hash, so
//                    every earlier link dies at once;
//   * expiring     - PARTNER_INVITE_HOURS (invite 72 h, reset 24 h);
//   * unforgeable  - HMAC with the partner-portal secret;
//   * not a password - the stored hash behind it is random and unguessable.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const prisma = require('../db');

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const hours = (purpose) => (purpose === 'reset' ? num(process.env.PARTNER_RESET_HOURS, 24) : num(process.env.PARTNER_INVITE_HOURS, 72));

function secret() {
  if (process.env.PARTNER_JWT_SECRET) return `${process.env.PARTNER_JWT_SECRET}:invite`;
  const base = process.env.JWT_SECRET || '';
  if (!base) throw new Error('JWT_SECRET is not set');
  return crypto.createHmac('sha256', base).update('teamlink-partner-invite-v1').digest('hex');
}
const fp = (hash) => crypto.createHash('sha256').update(String(hash || '')).digest('hex').slice(0, 16);
const sign = (payload) => crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
const baseUrl = () => String(process.env.APP_BASE_URL || 'http://localhost:5183').replace(/\/+$/, '');

// A hash nobody knows the password of (old password and any older link stop working at once).
async function unguessableHash() {
  return bcrypt.hash(crypto.randomBytes(48).toString('base64url'), 10);
}

// Replaces the login's password with an unguessable one and returns a link for it.
// purpose: 'invite' (new login) | 'reset'. Caller revokes sessions for a reset.
async function createLink(partnerUserId, purpose) {
  const hash = await unguessableHash();
  const expiresAt = new Date(Date.now() + hours(purpose) * 3600000);
  await prisma.partnerUser.update({
    where: { id: partnerUserId },
    data: { passwordHash: hash, mustChangePassword: true, tempPasswordExpiresAt: expiresAt, failedLoginAttempts: 0, lockedUntil: null },
  });
  const body = Buffer.from(JSON.stringify({ u: partnerUserId, h: fp(hash), e: expiresAt.getTime(), p: purpose === 'reset' ? 'r' : 'i' })).toString('base64url');
  const token = `${body}.${sign(body)}`;
  return { token, expiresAt, purpose, link: `${baseUrl()}/partner-login?invite=${encodeURIComponent(token)}` };
}

// The login behind a usable link, or null. Generic on purpose: forged, expired, used,
// replaced, switched off and deleted all look the same.
async function findUsable(token) {
  const t = String(token || '');
  if (t.length < 40 || t.length > 600 || !t.includes('.')) return null;
  const [body, sig] = t.split('.');
  let ok = false;
  try { ok = crypto.timingSafeEqual(Buffer.from(sig || ''), Buffer.from(sign(body))); } catch { ok = false; }
  if (!ok) return null;
  let c;
  try { c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!c || !c.u || !c.e || Number(c.e) <= Date.now()) return null;
  const pu = await prisma.partnerUser.findUnique({ where: { id: String(c.u) }, include: { partner: true } });
  if (!pu || pu.deletedAt || pu.status !== 'Active' || !pu.partner || pu.partner.status !== 'Active') return null;
  if (fp(pu.passwordHash) !== c.h) return null;
  return { partnerUser: pu, purpose: c.p === 'r' ? 'reset' : 'invite', expiresAt: new Date(Number(c.e)) };
}

module.exports = { createLink, findUsable, hours, unguessableHash, baseUrl };
