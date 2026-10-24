// ---------------------------------------------------------------------------
// GREEN START (the founder's own Omni-Channel product) opened from the TeamLink sidebar entry "Omni-Channel".
//
// REWRITTEN 2026-10-21. Green Start (folder green-start-app/, unmodified source) cannot live under a sub-path of this site:
// its pages and its API are hard-wired to the site root (/app/..., /api/v1/...), and /api here is TeamLink's own API. So it gets
// its OWN address, a small "gate" in front of it (green-start-app/run/gate.mjs, default port 5190). The gate lets a request through
// only when the browser holds the signed cookie issued here, and asks THIS server to check that cookie
// (GET /api/omni-gs/verify). Nothing about Green Start is served by the TeamLink port any more.
//
//   POST /api/omni-gs/session  (normal TeamLink login + the Omni-Channel permission, routes/greenStartEmbed.js)
//                              sets the signed, HttpOnly, 2-hour cookie `tl_gs` (Path=/; cookies ignore the port, so the gate sees it)
//   GET  /api/omni-gs/verify   answered HERE, ahead of every other middleware: 204 = cookie good, 401 = no / bad / expired cookie
//   GET  /api/omni-gs/status   (routes/greenStartEmbed.js) per-part state: database, Redis, server, worker, entrance + the 5 states (supervisor)
//   POST /api/omni-gs/start|stop|restart|backup, GET /api/omni-gs/log   Admin / Super Admin only (routes/greenStartEmbed.js)
//
// The old /omni-gs and /omni-gs-api paths of this server are gone (they belonged to the earlier modified copy greenstart-app/).
// SWITCH: GREENSTART_ENABLED=false turns the whole thing off (default ON; the gate itself only exists when it is started).
// Env (names only): GREENSTART_ENABLED, GREENSTART_GATE_PORT (5190), GREENSTART_API_PORT (4020), GREENSTART_REDIS_PORT (6379),
//          GREENSTART_PG_PORT (5436), GREENSTART_WEB_DIR.
// LIVE SITE (2026-10-22): GREENSTART_COOKIE_DOMAIN (.teamlinks.in: the pass reaches greenstart.teamlinks.in; then also Secure and 8 hours),
//          GREENSTART_COOKIE_SECURE (1 = always Secure), GREENSTART_COOKIE_HOURS (1 to 24), GREENSTART_SUPERVISE (false = a separate service
//          runs Green Start; utils/greenStartSupervisor.js then starts nothing). The pass is ONLY a door pass: own name, own signature made from
//          a separate key; it is not the TeamLink login and opens nothing in TeamLink.
// Green Start has its OWN data (contacts, templates, campaigns, inbox) and its OWN WhatsApp connection; nothing is shared with TeamLink.
// ---------------------------------------------------------------------------
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COOKIE = 'tl_gs';
const falsy = (v) => /^(0|false|no|off)$/i.test(String(v || '').trim());
const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim());
// COOKIE DOMAIN (live site): GREENSTART_COOKIE_DOMAIN=.teamlinks.in makes the browser send the pass to every *.teamlinks.in address, so it also reaches
// greenstart.teamlinks.in. Empty (the PC, localhost) = no Domain attribute at all, exactly as before. A value that is not a plain domain name is ignored.
const cookieDomain = () => {
  const d = String(process.env.GREENSTART_COOKIE_DOMAIN || '').trim();
  return /^\.?[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(d) ? d : '';
};
// LIFETIME: 2 hours on the PC (as before); 8 hours (one working day) as soon as a cookie domain is set (the live site). GREENSTART_COOKIE_HOURS (1 to 24) overrides both.
const ttlS = () => {
  const h = Number(process.env.GREENSTART_COOKIE_HOURS);
  if (process.env.GREENSTART_COOKIE_HOURS && Number.isFinite(h) && h >= 1 && h <= 24) return Math.round(h * 3600);
  return (cookieDomain() ? 8 : 2) * 60 * 60;
};
const enabled = () => !falsy(process.env.GREENSTART_ENABLED);
const gatePort = () => parseInt(process.env.GREENSTART_GATE_PORT, 10) || 5190;
const apiPort = () => parseInt(process.env.GREENSTART_API_PORT, 10) || 4020;
const redisPort = () => parseInt(process.env.GREENSTART_REDIS_PORT, 10) || 6379;
const pgPort = () => parseInt(process.env.GREENSTART_PG_PORT, 10) || 5436;
const APP_DIR = path.resolve(__dirname, '..', '..', '..', 'green-start-app');
const webDir = () => path.resolve(process.env.GREENSTART_WEB_DIR || path.join(APP_DIR, 'green-start-web', 'dist'));

// ---- the signed cookie -------------------------------------------------------
const secret = () => crypto.createHash('sha256').update(`greenstart-gate:${process.env.JWT_SECRET || 'dev'}`).digest();
const sign = (v) => crypto.createHmac('sha256', secret()).update(v).digest('base64url');
function makeToken(userId) {
  const exp = Math.floor(Date.now() / 1000) + ttlS();
  const body = `${userId}.${exp}`;
  return `${body}.${sign(body)}`;
}
function validToken(t) {
  const m = /^([A-Za-z0-9_-]{1,64})\.(\d{9,12})\.([A-Za-z0-9_-]{20,64})$/.exec(String(t || ''));
  if (!m) return false;
  const given = Buffer.from(m[3]);
  const want = Buffer.from(sign(`${m[1]}.${m[2]}`));
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return false;
  return Number(m[2]) > Math.floor(Date.now() / 1000);
}
function readCookie(req, name) {
  const h = String(req.headers.cookie || '');
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}
// Is this request really an https one? The live nginx in front of TeamLink does NOT send X-Forwarded-Proto, so req.secure alone is not enough:
// also true when GREENSTART_COOKIE_SECURE=1, when a cookie Domain is set (the live site is https only), when the browser says the page it comes
// from (Origin / Referer) is https, or when the proxy or the socket says so.
function isHttpsRequest(req) {
  if (truthy(process.env.GREENSTART_COOKIE_SECURE)) return true;
  if (cookieDomain()) return true;
  if (req.secure || (req.socket && req.socket.encrypted)) return true;
  const h = req.headers || {};
  if (String(h['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https') return true;
  return /^https:\/\//i.test(String(h.origin || '')) || /^https:\/\//i.test(String(h.referer || ''));
}
function cookieAttrs(req) {
  return `Path=/; HttpOnly; SameSite=Lax${isHttpsRequest(req) ? '; Secure' : ''}`;
}
function issueCookies(req, res, userId) {
  const tok = makeToken(userId);
  const attrs = cookieAttrs(req);
  const domain = cookieDomain();
  const list = [`${COOKIE}=${tok}; ${attrs}; Max-Age=${ttlS()}${domain ? `; Domain=${domain}` : ''}`];
  // With a Domain, also expire an older host-only copy (same name) so the browser never sends two different tl_gs values.
  if (domain) list.push(`${COOKIE}=; ${attrs}; Max-Age=0`);
  res.setHeader('Set-Cookie', list.length === 1 ? list[0] : list);
}
// Takes the pass away again (with and without Domain). Not wired to anything by default.
function clearCookies(req, res) {
  const attrs = cookieAttrs(req);
  const domain = cookieDomain();
  const list = [`${COOKIE}=; ${attrs}; Max-Age=0`];
  if (domain) list.push(`${COOKIE}=; ${attrs}; Max-Age=0; Domain=${domain}`);
  res.setHeader('Set-Cookie', list);
}

// ---- status (for the Omni-Channel page) -------------------------------------
function tcp(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => { try { s.destroy(); } catch { /* gone */ } resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}
function apiHealth(timeoutMs = 1500) {
  return new Promise((resolve) => {
    try {
      const r = http.get({ host: '127.0.0.1', port: apiPort(), path: '/api/v1/health', timeout: timeoutMs }, (res) => { res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 300); });
      r.on('timeout', () => { r.destroy(); resolve(false); });
      r.on('error', () => resolve(false));
    } catch { resolve(false); } // the test sandbox refuses ports it does not know
  });
}
async function status() {
  const built = fs.existsSync(path.join(webDir(), 'index.html'));
  const port = gatePort();
  if (!enabled()) return { enabled: false, built, port, gate: false, api: false, redis: false, db: false, supervised: false, state: 'off', stateText: 'Switched off' };
  // When the supervisor (utils/greenStartSupervisor.js) looks after Green Start it knows every part, the state and the next step.
  const sup = await require('./greenStartSupervisor').snapshot(); // eslint-disable-line global-require
  if (sup.supervised) {
    const P = sup.parts;
    return { enabled: true, built, port, gate: P.gate.ok, api: P.api.ok, redis: P.redis.ok, db: P.db.ok, worker: P.worker.ok, ...sup };
  }
  const [gate, api, redis, db] = await Promise.all([tcp(port), apiHealth(), tcp(redisPort()), tcp(pgPort())]);
  // GREENSTART_SUPERVISE=false: a separate service runs Green Start; say so, and only report the simple port / health checks above.
  if (sup.external) return { enabled: true, built, port, gate, api, redis, db, supervised: false, external: true, state: sup.state, stateText: sup.stateText };
  return { enabled: true, built, port, gate, api, redis, db, supervised: false };
}

// Mounted ahead of the body parsers and the other middleware (backend/src/index.js): it answers ONLY the gate's cookie check.
function proxy() {
  return (req, res, next) => {
    if (req.method !== 'GET' || (req.url || '').split('?')[0] !== '/api/omni-gs/verify') return next();
    const ok = enabled() && validToken(readCookie(req, COOKIE));
    res.writeHead(ok ? 204 : 401, { 'cache-control': 'no-store' });
    return res.end();
  };
}

module.exports = { proxy, enabled, status, issueCookies, clearCookies, validToken, makeToken, gatePort, COOKIE, cookieDomain, ttlS, isHttpsRequest };
