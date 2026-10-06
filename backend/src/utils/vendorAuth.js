// ---------------------------------------------------------------------------
// VENDOR PORTAL SESSIONS (P3 2026-10-05, v2 2026-10-06) — isolated from every
// staff login.
//
//   * A vendor login is a VendorUser row, never a User. It has no role in the
//     permission matrix, so no staff route can ever grant it anything.
//   * Its token is signed with a DIFFERENT secret (derived from JWT_SECRET, or
//     VENDOR_JWT_SECRET) and carries typ 'vendor' + audience 'vendor-portal'.
//     A staff route's requireAuth cannot even verify it (401), and the GLOBAL
//     guard below answers 403 before any staff router sees the request.
//   * The token is only half the credential: its jti names a VendorSession
//     row. Every request checks that row — revoked (logout, deactivate,
//     password reset, vendor switched off), idle for VENDOR_IDLE_MINUTES (30,
//     sliding) or older than VENDOR_SESSION_MAX_HOURS (12) = signed out.
//   * vendorUserId / vendorId come from the session, NEVER from the request.
//   * One route prefix only: /api/vendor-portal/* (deny-by-default). There
//     are no cookies (Bearer header only), so CSRF does not apply; the vendor
//     routes get their own security headers and a CORS rule limited to the
//     app's own origins (VENDOR_PORTAL_ORIGINS) — the global CORS is untouched.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const prisma = require('../db');
const VC = require('./vendorConfig');

const AUDIENCE = 'vendor-portal';
const TYP = 'vendor';
const TOUCH_EVERY_MS = 20 * 1000; // lastSeenAt is written at most every 20 s
const PORTAL_PREFIX = '/api/vendor-portal';
// Kept as getters so env changes (tests) apply without a restart.
module.exports = {};
Object.defineProperty(module.exports, 'IDLE_MINUTES', { get: () => VC.CFG.idleMinutes, enumerable: true });
Object.defineProperty(module.exports, 'MAX_HOURS', { get: () => VC.CFG.maxHours, enumerable: true });

function secret() {
  if (process.env.VENDOR_JWT_SECRET) return process.env.VENDOR_JWT_SECRET;
  const base = process.env.JWT_SECRET || '';
  if (!base) throw new Error('JWT_SECRET is not set');
  return crypto.createHmac('sha256', base).update('teamlink-vendor-portal-v1').digest('hex');
}

const bearerOf = (req) => {
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
};

// Verified vendor claims, or null. Never throws.
function verifyVendorToken(token) {
  if (!token) return null;
  try {
    const c = jwt.verify(token, secret(), { audience: AUDIENCE, algorithms: ['HS256'] });
    return c && c.typ === TYP && c.jti && c.vuid ? c : null;
  } catch { return null; }
}

// Anything that LOOKS like a vendor token, verified or not (an expired one,
// one with a forged signature). Used only to refuse, never to admit.
function looksLikeVendorToken(token) {
  if (!token) return false;
  try {
    const c = jwt.decode(token);
    if (!c || typeof c !== 'object') return false;
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
    return c.typ === TYP || aud.includes(AUDIENCE) || !!c.vuid;
  } catch { return false; }
}

const isPortalPath = (p) => p === PORTAL_PREFIX || p.startsWith(`${PORTAL_PREFIX}/`);

// Security headers + CORS for the vendor routes only. Requests from a browser
// origin that is not the app's own are refused; preflights are answered here
// (ahead of the global cors()), so the vendor API never says "any origin".
function vendorShield(req, res) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
  });
  if (process.env.NODE_ENV === 'production') res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  const origin = String(req.headers.origin || '').replace(/\/+$/, '');
  if (origin) {
    if (!VC.allowedOrigins().includes(origin)) {
      res.status(403).json({ error: 'Forbidden.' });
      return true;
    }
    res.set({
      'Access-Control-Allow-Origin': origin,
      Vary: 'Origin',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
      'Access-Control-Max-Age': '600',
    });
  }
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  // The global cors() runs later and would add "*": keep ours.
  const set = res.setHeader.bind(res);
  res.setHeader = (k, v) => (String(k).toLowerCase() === 'access-control-allow-origin' ? res : set(k, v));
  return false;
}

// THE GLOBAL GUARD (index.js, ahead of every router): a vendor session may
// reach /api/vendor-portal/* and nothing else on this server — every other
// API, page proxy or static path answers 403. Vendor paths get the shield.
function vendorSessionGuard(req, res, next) {
  const p = String(req.originalUrl || req.url || '').split('?')[0];
  if (isPortalPath(p) && vendorShield(req, res)) return undefined;
  const token = bearerOf(req);
  if (!token) return next();
  if (!(verifyVendorToken(token) || looksLikeVendorToken(token))) return next();
  if (isPortalPath(p)) return next();
  return res.status(403).json({ error: 'Forbidden. A vendor login can open only the Vendor Portal.', vendorPortal: true });
}

async function createSession(vendorUser, req) {
  const now = new Date();
  const meta = VC.requestMeta(req);
  const s = await prisma.vendorSession.create({
    data: {
      vendorUserId: vendorUser.id,
      expiresAt: new Date(now.getTime() + VC.CFG.maxHours * 3600000),
      lastSeenAt: now,
      ip: meta.ip,
      userAgent: meta.userAgent ? meta.userAgent.slice(0, 200) : null,
    },
  });
  const token = jwt.sign(
    { typ: TYP, vuid: vendorUser.id, vid: vendorUser.vendorId },
    secret(),
    { audience: AUDIENCE, jwtid: s.id, expiresIn: `${VC.CFG.maxHours}h`, algorithm: 'HS256' },
  );
  return { token, session: s };
}

async function revokeSessions(vendorUserId, reason, exceptId) {
  return prisma.vendorSession.updateMany({
    where: { vendorUserId, revokedAt: null, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
    data: { revokedAt: new Date(), revokedReason: String(reason || 'revoked').slice(0, 60) },
  });
}
// Every session of every login of one vendor (vendor master switched off).
async function revokeVendorSessions(vendorId, reason) {
  const users = await prisma.vendorUser.findMany({ where: { vendorId }, select: { id: true } });
  return prisma.vendorSession.updateMany({
    where: { vendorUserId: { in: users.map((u) => u.id) }, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: String(reason || 'vendor switched off').slice(0, 60) },
  });
}

const SIGNED_OUT = 'Your session has ended. Please sign in again.';
const out = (res, extra = {}) => res.status(401).json({ error: SIGNED_OUT, vendorSignedOut: true, ...extra });

// requireVendor — every /api/vendor-portal route except login / status.
// Resolves the vendor login from the SESSION and puts it on req.vendor.
function requireVendor({ allowPasswordChange = false } = {}) {
  return async (req, res, next) => {
    try {
      const claims = verifyVendorToken(bearerOf(req));
      if (!claims) return out(res);
      const s = await prisma.vendorSession.findUnique({ where: { id: claims.jti } });
      const now = Date.now();
      if (!s || s.vendorUserId !== claims.vuid || s.revokedAt) return out(res);
      if (new Date(s.expiresAt).getTime() <= now) return out(res, { expired: true });
      if (now - new Date(s.lastSeenAt).getTime() > VC.CFG.idleMinutes * 60000) {
        await prisma.vendorSession.update({ where: { id: s.id }, data: { revokedAt: new Date(), revokedReason: 'idle' } });
        return res.status(401).json({
          error: `Your session expired after ${VC.CFG.idleMinutes} minutes without activity. Please sign in again.`,
          vendorSignedOut: true, idle: true,
        });
      }
      const vu = await prisma.vendorUser.findUnique({ where: { id: s.vendorUserId }, include: { vendor: true } });
      if (!vu || vu.status !== 'Active' || vu.deletedAt || !vu.vendor || vu.vendor.isActive === false) {
        await revokeSessions(s.vendorUserId, 'inactive');
        return out(res);
      }
      if (vu.mustChangePassword && !allowPasswordChange) {
        return res.status(403).json({ error: 'Please set a new password first.', mustChangePassword: true });
      }
      if (now - new Date(s.lastSeenAt).getTime() > TOUCH_EVERY_MS) {
        await prisma.vendorSession.update({ where: { id: s.id }, data: { lastSeenAt: new Date() } });
      }
      req.vendor = {
        userId: vu.id, vendorId: vu.vendorId, vendorName: vu.vendor ? vu.vendor.name : '', name: vu.name,
        email: vu.email, canEdit: !!vu.canEdit, canViewCost: !!vu.canViewCost,
        mustChangePassword: !!vu.mustChangePassword, sessionId: s.id, row: vu,
      };
      return next();
    } catch (err) { return next(err); }
  };
}

// Statuses that take an asset off the books — an archived asset leaves the
// portal at once (spec v2 §5).
const ARCHIVED = ['Retired', 'Sold', 'Written off'];

// The assets one vendor login may see: (asset.vendorId = the session vendor)
// AND (a specific access row OR a category access row for the asset's
// category), and not archived. Read fresh on every request — no cache, so a
// removed access row, a re-assigned asset or a new asset in an assigned
// category take effect on the next call.
async function vendorAssetWhere(vendor) {
  const access = await prisma.vendorAssetAccess.findMany({ where: { vendorUserId: vendor.userId } });
  const ids = access.map((a) => a.assetId).filter(Boolean);
  const cats = access.map((a) => a.category).filter(Boolean);
  const or = [];
  if (ids.length) or.push({ id: { in: ids } });
  if (cats.length) or.push({ category: { in: cats } });
  if (!or.length) return { id: '__none__' };
  return { AND: [{ vendorId: vendor.vendorId }, { OR: or }, { NOT: { status: { in: ARCHIVED } } }] };
}

Object.assign(module.exports, {
  AUDIENCE, PORTAL_PREFIX, ARCHIVED,
  verifyVendorToken, looksLikeVendorToken, vendorSessionGuard, createSession, revokeSessions, revokeVendorSessions,
  requireVendor, vendorAssetWhere, bearerOf,
});
