// ---------------------------------------------------------------------------
// WEB HARDENING (security review, Batch 1, 2026-10-09) - headers + CORS, no
// new dependency (helmet / express-rate-limit are not installed).
//
// HEADERS (every response this server answers, after the /jobs proxy so the
// customer's embedded Job Portal keeps its own headers):
//   X-Content-Type-Options: nosniff
//   X-Frame-Options: SAMEORIGIN         (PDF / preview iframes are same-origin blobs)
//   Referrer-Policy: strict-origin-when-cross-origin
//   Permissions-Policy: camera=(), microphone=(self), geolocation=()   (the AI voice button needs the mic)
//   Cross-Origin-Opener-Policy: same-origin-allow-popups
//   Strict-Transport-Security: only when NODE_ENV=production AND the request arrived over https
//   Content-Security-Policy-Report-Only on /api responses only (default-src 'none';
//     frame-ancestors 'self'): REPORT-ONLY, it can never block anything. HTML pages this server
//     hands out (the Omnichannel app) get no CSP at all.
//   X-Powered-By removed.
//
// CORS (replaces the old open `cors()`): a browser page on another origin may READ an answer only if
//   * the path is a PUBLIC one third parties use (careers / job feeds / apply forms / offer + agreement
//     signing links / public portal sign-in / health) - these stay open to any origin, as before; or
//   * its origin is in CORS_ORIGINS (comma list); or
//   * it is this site itself (Origin host == Host header); or
//   * NODE_ENV is not production AND the origin is localhost / 127.0.0.1 / [::1] / a private LAN address
//     (the Vite dev server, a phone on the same Wi-Fi).
//   In production the list is CORS_ORIGINS, falling back to APP_BASE_URL; with neither, only the site
//   itself (same origin) works. Requests with no Origin header (server to server, curl, the sandbox
//   tests, the biometric device) are never affected: CORS is a browser rule.
// ---------------------------------------------------------------------------
const cors = require('cors');
const { isHttps, trustProxySetting, PRIVATE } = require('./clientIp');

const prod = () => process.env.NODE_ENV === 'production';
const strip = (o) => String(o || '').trim().replace(/\/+$/, '');

function configuredOrigins() {
  const list = String(process.env.CORS_ORIGINS || '').split(',').map(strip).filter(Boolean);
  if (list.length) return list;
  if (prod()) { const base = strip(process.env.APP_BASE_URL); return base ? [base] : []; }
  return [];
}

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const LAN_ORIGIN = /^https?:\/\/(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/;

// Public paths (third parties embed / pull these): stay open to every origin.
const PUBLIC_PATH = /^\/(api\/(public|offer-link|health)(\/|$)|api\/portal\/public(\/|$)|api\/agreement\/token\/|sitemap\.xml$|robots\.txt$)/i;

function originAllowed(req, origin) {
  const o = strip(origin);
  if (!o) return true;
  if (configuredOrigins().includes(o)) return true;
  try { if (new URL(o).host === String(req.headers.host || '')) return true; } catch { /* malformed Origin */ }
  if (!prod() && (LOCAL_ORIGIN.test(o) || LAN_ORIGIN.test(o))) return true;
  return false;
}

function corsMiddleware() {
  return cors((req, cb) => {
    const p = String(req.originalUrl || req.url || '').split('?')[0];
    if (PUBLIC_PATH.test(p)) return cb(null, { origin: '*' });
    return cb(null, { origin: originAllowed(req, req.headers.origin) ? (req.headers.origin || false) : false });
  });
}

function securityHeaders(req, res, next) {
  // Never weaken a stricter header an earlier guard already set (the vendor / partner portal shields
  // send X-Frame-Options DENY, Referrer-Policy no-referrer ...): only fill in what is missing.
  const put = (k, v) => { if (!res.getHeader(k)) res.setHeader(k, v); };
  put('X-Content-Type-Options', 'nosniff');
  put('X-Frame-Options', 'SAMEORIGIN');
  put('Referrer-Policy', 'strict-origin-when-cross-origin');
  put('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
  put('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  if (/^\/api(\/|$)/i.test(String(req.originalUrl || req.url || ''))) {
    put('Content-Security-Policy-Report-Only', "default-src 'none'; frame-ancestors 'self'");
  }
  if (prod() && isHttps(req)) put('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

// Called once from index.js right after the app is created.
function configureApp(app) {
  app.disable('x-powered-by');
  const tp = trustProxySetting();
  if (tp !== undefined) app.set('trust proxy', tp);
}

module.exports = { securityHeaders, corsMiddleware, configureApp, originAllowed, configuredOrigins, PUBLIC_PATH, PRIVATE };
