// ---------------------------------------------------------------------------
// PARTNER PORTAL SESSIONS (B7, 2026-10-06) — isolated from every staff login
// AND from the vendor portal. Same pattern as utils/vendorAuth.js, written
// separately so the two portals share no secret, table or switch.
//
//   * A partner login is a PartnerUser row, never a User. It has no role in
//     the permission matrix, so no staff route can ever grant it anything.
//   * Its token is signed with its OWN secret (derived from JWT_SECRET, or
//     PARTNER_JWT_SECRET) and carries typ 'partner' + audience
//     'partner-portal'. requireAuth cannot verify it (401), and the GLOBAL
//     guard below answers 403 before any staff router sees the request.
//   * The token is only half the credential: its jti names a PartnerSession
//     row. Every request checks that row — revoked (logout, deactivate,
//     password reset, partner paused), idle for 30 min (sliding) or older
//     than 12 h = signed out.
//   * partnerUserId / partnerId come from the session, NEVER from the request.
//   * One route prefix only: /api/partner-portal/* (deny-by-default).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const prisma = require('../db');
const PC = require('./partnerConfig');

const AUDIENCE = 'partner-portal';
const TYP = 'partner';
const TOUCH_EVERY_MS = 20 * 1000;
const PORTAL_PREFIX = '/api/partner-portal';
module.exports = {};
Object.defineProperty(module.exports, 'IDLE_MINUTES', { get: () => PC.CFG.idleMinutes, enumerable: true });
Object.defineProperty(module.exports, 'MAX_HOURS', { get: () => PC.CFG.maxHours, enumerable: true });

function secret() {
  if (process.env.PARTNER_JWT_SECRET) return process.env.PARTNER_JWT_SECRET;
  const base = process.env.JWT_SECRET || '';
  if (!base) throw new Error('JWT_SECRET is not set');
  return crypto.createHmac('sha256', base).update('teamlink-partner-portal-v1').digest('hex');
}

const bearerOf = (req) => {
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
};

function verifyPartnerToken(token) {
  if (!token) return null;
  try {
    const c = jwt.verify(token, secret(), { audience: AUDIENCE, algorithms: ['HS256'] });
    return c && c.typ === TYP && c.jti && c.puid ? c : null;
  } catch { return null; }
}

// Anything that LOOKS like a partner token (expired, forged): refuse only.
function looksLikePartnerToken(token) {
  if (!token) return false;
  try {
    const c = jwt.decode(token);
    if (!c || typeof c !== 'object') return false;
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
    return c.typ === TYP || aud.includes(AUDIENCE) || !!c.puid;
  } catch { return false; }
}

const isPortalPath = (p) => p === PORTAL_PREFIX || p.startsWith(`${PORTAL_PREFIX}/`);

function partnerShield(req, res) {
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
    if (!PC.allowedOrigins().includes(origin)) {
      res.status(403).json({ error: 'Forbidden.' });
      return true;
    }
    res.set({
      'Access-Control-Allow-Origin': origin,
      Vary: 'Origin',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
      'Access-Control-Max-Age': '600',
    });
  }
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  const set = res.setHeader.bind(res);
  res.setHeader = (k, v) => (String(k).toLowerCase() === 'access-control-allow-origin' ? res : set(k, v));
  return false;
}

// THE GLOBAL GUARD (index.js, ahead of every router): a partner session may
// reach /api/partner-portal/* and nothing else — every other API answers 403.
function partnerSessionGuard(req, res, next) {
  const p = String(req.originalUrl || req.url || '').split('?')[0];
  if (isPortalPath(p) && partnerShield(req, res)) return undefined;
  const token = bearerOf(req);
  if (!token) return next();
  if (!(verifyPartnerToken(token) || looksLikePartnerToken(token))) return next();
  if (isPortalPath(p)) return next();
  return res.status(403).json({ error: 'Forbidden. A partner login can open only the Partner Portal.', partnerPortal: true });
}

async function createSession(partnerUser, req) {
  const now = new Date();
  const meta = PC.requestMeta(req);
  const s = await prisma.partnerSession.create({
    data: {
      partnerUserId: partnerUser.id,
      expiresAt: new Date(now.getTime() + PC.CFG.maxHours * 3600000),
      lastSeenAt: now,
      ip: meta.ip,
      userAgent: meta.userAgent ? meta.userAgent.slice(0, 200) : null,
    },
  });
  const token = jwt.sign(
    { typ: TYP, puid: partnerUser.id, pid: partnerUser.partnerId },
    secret(),
    { audience: AUDIENCE, jwtid: s.id, expiresIn: `${PC.CFG.maxHours}h`, algorithm: 'HS256' },
  );
  return { token, session: s };
}

async function revokeSessions(partnerUserId, reason, exceptId) {
  return prisma.partnerSession.updateMany({
    where: { partnerUserId, revokedAt: null, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
    data: { revokedAt: new Date(), revokedReason: String(reason || 'revoked').slice(0, 60) },
  });
}
async function revokePartnerSessions(partnerId, reason) {
  const users = await prisma.partnerUser.findMany({ where: { partnerId }, select: { id: true } });
  return prisma.partnerSession.updateMany({
    where: { partnerUserId: { in: users.map((u) => u.id) }, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: String(reason || 'partner paused').slice(0, 60) },
  });
}

const SIGNED_OUT = 'Your session has ended. Please sign in again.';
const out = (res, extra = {}) => res.status(401).json({ error: SIGNED_OUT, partnerSignedOut: true, ...extra });

// requirePartner — every /api/partner-portal route except login.
function requirePartner({ allowPasswordChange = false } = {}) {
  return async (req, res, next) => {
    try {
      const claims = verifyPartnerToken(bearerOf(req));
      if (!claims) return out(res);
      const s = await prisma.partnerSession.findUnique({ where: { id: claims.jti } });
      const now = Date.now();
      if (!s || s.partnerUserId !== claims.puid || s.revokedAt) return out(res);
      if (new Date(s.expiresAt).getTime() <= now) return out(res, { expired: true });
      if (now - new Date(s.lastSeenAt).getTime() > PC.CFG.idleMinutes * 60000) {
        await prisma.partnerSession.update({ where: { id: s.id }, data: { revokedAt: new Date(), revokedReason: 'idle' } });
        return res.status(401).json({
          error: `Your session expired after ${PC.CFG.idleMinutes} minutes without activity. Please sign in again.`,
          partnerSignedOut: true, idle: true,
        });
      }
      const pu = await prisma.partnerUser.findUnique({ where: { id: s.partnerUserId }, include: { partner: true } });
      if (!pu || pu.status !== 'Active' || pu.deletedAt || !pu.partner || pu.partner.status !== 'Active') {
        await revokeSessions(s.partnerUserId, 'inactive');
        return out(res);
      }
      if (pu.mustChangePassword && !allowPasswordChange) {
        return res.status(403).json({ error: 'Please set a new password first.', mustChangePassword: true });
      }
      if (now - new Date(s.lastSeenAt).getTime() > TOUCH_EVERY_MS) {
        await prisma.partnerSession.update({ where: { id: s.id }, data: { lastSeenAt: new Date() } });
      }
      req.partner = {
        userId: pu.id, partnerId: pu.partnerId, partnerName: pu.partner.name, name: pu.name, email: pu.email,
        mustChangePassword: !!pu.mustChangePassword, sessionId: s.id, row: pu, partner: pu.partner,
      };
      return next();
    } catch (err) { return next(err); }
  };
}

Object.assign(module.exports, {
  AUDIENCE, PORTAL_PREFIX,
  verifyPartnerToken, looksLikePartnerToken, partnerSessionGuard, createSession, revokeSessions, revokePartnerSessions,
  requirePartner, bearerOf,
});
