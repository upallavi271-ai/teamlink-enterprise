// ---------------------------------------------------------------------------
// VENDOR INVITE / PASSWORD-RESET LINKS (2026-10-09).
//
// Nobody sets or sees a vendor's password. Admin makes a LINK; the vendor opens
// it and chooses their own password. A link is
//   * random (32 bytes), shown to the admin ONCE — only its sha256 is stored;
//   * single use — consumed atomically (UPDATE ... WHERE usedAt IS NULL), so two
//     opens can never both win;
//   * expiring — invite 72 h, reset 24 h (VENDOR_INVITE_HOURS / VENDOR_RESET_HOURS);
//   * replaced by the next one — making a new link cancels the older unused ones;
//   * dead the moment the login is switched off, deleted or its vendor is off.
// Using it sets the password, clears "must change password", signs every other
// session of that login out and starts a fresh session.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const hours = (purpose) => (purpose === 'reset' ? num(process.env.VENDOR_RESET_HOURS, 24) : num(process.env.VENDOR_INVITE_HOURS, 72));
const hashOf = (token) => crypto.createHash('sha256').update(String(token || '')).digest('hex');
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function baseUrl() {
  return String(process.env.APP_BASE_URL || 'http://localhost:5183').replace(/\/+$/, '');
}

// Cancels this login's older unused links, then makes a new one.
// Returns { token, link, expiresAt, id }. The token itself is never stored.
// `db` = a Prisma transaction client when the link must be made in the same transaction as the login itself.
// opts.hours = a shorter life for this one link (a vendor's own "forgot password" link lasts 1 hour).
async function createLink(vendorUserId, purpose, user, db = prisma, opts = {}) {
  await db.vendorLoginToken.updateMany({ where: { vendorUserId, usedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + (Number(opts.hours) > 0 ? Number(opts.hours) : hours(purpose)) * 3600000);
  const row = await db.vendorLoginToken.create({
    data: {
      vendorUserId, purpose, tokenHash: hashOf(token), expiresAt,
      createdById: user ? user.id : null, createdByName: user ? (user.name || user.email || null) : null,
    },
  });
  return { id: row.id, token, expiresAt, purpose, link: `${baseUrl()}/vendor-login?invite=${encodeURIComponent(token)}` };
}

// A usable link row (with its login + vendor), or null. Generic on purpose:
// unknown, used, cancelled, expired and switched-off all look the same.
async function findUsable(token) {
  if (!token || String(token).length < 20 || String(token).length > 200) return null;
  const presented = hashOf(token);
  const row = await prisma.vendorLoginToken.findUnique({ where: { tokenHash: presented }, include: { vendorUser: { include: { vendor: true } } } });
  // Constant-time check that the stored hash is the hash of what was presented (the lookup was by hash already).
  if (row && !safeEqual(presented, row.tokenHash)) return null;
  if (!row || row.purpose === 'preview' || row.usedAt || row.revokedAt || new Date(row.expiresAt).getTime() <= Date.now()) return null;
  const vu = row.vendorUser;
  if (!vu || vu.status !== 'Active' || vu.deletedAt || !vu.vendor || vu.vendor.isActive === false) return null;
  return row;
}

// Burns the link. true only for the ONE caller that wins the race.
async function consume(row, ip) {
  const r = await prisma.vendorLoginToken.updateMany({
    where: { id: row.id, usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date(), usedIp: ip ? String(ip).slice(0, 60) : null },
  });
  return r.count === 1;
}

module.exports = { createLink, findUsable, consume, hashOf, safeEqual, hours, baseUrl };
