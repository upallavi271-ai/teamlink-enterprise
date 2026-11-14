// ---------------------------------------------------------------------------
// GENERAL API RATE LIMIT (security fix 2026-10-13).
//
// One in-memory, fixed-window limiter in front of every /api route:
//   * a signed-in staff login (token verified): 600 requests / minute, per LOGIN
//     (an office behind one shared address is not throttled as one person);
//   * anyone else (no token, a bad token, a vendor / partner portal token): 120 / minute per IP;
//   * stricter, per login (or per IP when anonymous):
//       sign-in            20 / minute per IP      (the 5-wrong-passwords lockout still applies on top)
//       password reset     10 / minute per IP
//       exports            30 / minute
//       bulk send / broadcast 20 / minute
// Over the limit: HTTP 429 with a plain sentence and a Retry-After header.
// Skipped: /api/health, non-/api paths (static files, the /jobs proxy, the biometric device),
// OPTIONS, and the whole sandbox unless TL_RATE_LIMIT_IN_TEST=1 (the shared test sandbox is hammered by test
// scripts on purpose; the limiter itself is covered by unit tests in scripts/security-fixes-test.js).
// Limits can be tuned with API_RATE_USER_MAX, API_RATE_IP_MAX, API_RATE_WINDOW_MS; API_RATE_LIMIT=0 switches it off.
// ---------------------------------------------------------------------------
const jwt = require('jsonwebtoken');

const STRICT = [
  // Employee Monitoring agents (routes/monitoring.js): counted per PC, not per office address (one office = one address)
  { name: 'monitor-register', re: /^\/api\/monitoring\/devices\/register\/?$/i, methods: ['POST'], max: 10, byIp: true },
  { name: 'monitor-live', re: /^\/api\/monitoring\/live\/?$/i, methods: ['POST'], max: 60 }, // at most one every 2 seconds, from the PC itself
  { name: 'monitor-agent', re: /^\/api\/monitoring\/(activity|heartbeat|consent)\/?$/i, methods: ['POST'], max: 30 },
  { name: 'login', re: /^\/api\/auth\/login(\/choose)?\/?$/i, methods: ['POST'], max: 20, byIp: true },
  { name: 'reset', re: /^\/api\/auth\/(forgot-password|reset-password)(\/|$)/i, methods: ['POST'], max: 10, byIp: true },
  { name: 'export', re: /(\/export([./]|$)|\/export-|\.(xlsx|csv|pdf)$|\/download-all|\/zip$)/i, methods: ['GET', 'POST'], max: 30 },
  { name: 'bulk', re: /(\/bulk[-/]|\/bulk$|\/send-all|\/broadcast|\/send-bulk|\/message-these)/i, methods: ['POST'], max: 20 },
];

function makeLimiter(opts = {}) {
  const now = opts.now || Date.now;
  const userMax = Number(opts.userMax) || 600;
  const ipMax = Number(opts.ipMax) || 120;
  const windowMs = Number(opts.windowMs) || 60000;
  const hits = new Map(); // key -> { start, count }
  let lastSweep = now();

  function hit(key, max) {
    const t = now();
    if (t - lastSweep > windowMs) { lastSweep = t; hits.forEach((v, k) => { if (t - v.start > windowMs) hits.delete(k); }); }
    let row = hits.get(key);
    if (!row || t - row.start >= windowMs) { row = { start: t, count: 0 }; hits.set(key, row); }
    row.count += 1;
    if (row.count > max) return Math.max(1, Math.ceil((row.start + windowMs - t) / 1000));
    return 0;
  }

  // who: { userId|null, ip }. Returns { retryAfter, bucket } when over a limit, else null.
  function check({ method, path, userId, ip }) {
    const m = String(method || 'GET').toUpperCase();
    const p = String(path || '').split('?')[0];
    for (const s of STRICT) {
      if (s.re.test(p) && s.methods.includes(m)) {
        const who = s.byIp || !userId ? `ip:${ip}` : `u:${userId}`;
        const r = hit(`${s.name}|${who}`, s.max);
        if (r) return { retryAfter: r, bucket: s.name };
      }
    }
    const r = userId ? hit(`all|u:${userId}`, userMax) : hit(`all|ip:${ip}`, ipMax);
    return r ? { retryAfter: r, bucket: userId ? 'user' : 'ip' } : null;
  }
  return { check, reset: () => hits.clear() };
}

const limiter = makeLimiter({
  userMax: process.env.API_RATE_USER_MAX, ipMax: process.env.API_RATE_IP_MAX, windowMs: process.env.API_RATE_WINDOW_MS,
});

function userIdOf(req) {
  const h = String(req.headers.authorization || '');
  // a monitoring agent is counted as its own PC (the token's hash), so a whole office behind one address is not one caller
  if (h.startsWith('Device ') && h.length > 40) return `dev:${require('crypto').createHash('sha256').update(h.slice(7).trim()).digest('hex').slice(0, 24)}`; // eslint-disable-line global-require
  if (!h.startsWith('Bearer ')) return null;
  try {
    const c = jwt.verify(h.slice(7).trim(), process.env.JWT_SECRET);
    return c && c.id ? String(c.id) : null;
  } catch { return null; }
}

function enabled() {
  if (/^(0|false|no|off)$/i.test(String(process.env.API_RATE_LIMIT || ''))) return false;
  if (require('./sandbox').isSandbox() && !/^(1|true|yes)$/i.test(String(process.env.TL_RATE_LIMIT_IN_TEST || ''))) return false; // eslint-disable-line global-require
  return true;
}

function apiRateLimit(req, res, next) {
  if (req.method === 'OPTIONS' || !enabled()) return next();
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  if (!/^\/api(\/|$)/i.test(path) || /^\/api\/health\/?$/i.test(path)) return next();
  // The CLIENT pages of AI Marketing (a client's private project / approval link and the public "Our work" page) are opened by people who are not signed in, often on a shared
  // phone or office connection. They have their own per-caller limits (routes/mkProjectPublic.js, mkClientReviewPublic.js, mkWorkPublic.js), so they are not also counted in the
  // general 120-a-minute-per-address bucket, which made a client see "Too many requests" on a link that was fine (2026-11-14).
  if (/^\/api\/public\/mk-(project|review|work)(\/|$)/i.test(path)) return next();
  const ip = require('./clientIp').ipOf(req); // eslint-disable-line global-require
  const over = limiter.check({ method: req.method, path, userId: userIdOf(req), ip });
  if (!over) return next();
  res.set('Retry-After', String(over.retryAfter));
  return res.status(429).json({
    error: `Too many requests. Please wait ${over.retryAfter} second${over.retryAfter === 1 ? '' : 's'} and try again.`,
    retryAfter: over.retryAfter,
  });
}

module.exports = { apiRateLimit, makeLimiter, STRICT, limiter };
