// TeamLink helper (NOT part of the Green Start zip): the "entrance" to Green Start. No dependencies, plain Node.
//
// WHY: Green Start's screens and API live at the site root (/app/..., /api/v1/...), so it cannot sit under a sub-path of the TeamLink site
//      without editing its source. It gets its own port instead (default 5190) and this small gate stands in front of it:
//
//   browser --> gate :5190 --+--> /api/*, /media/*  --> Green Start API   (127.0.0.1:4020)
//                            +--> everything else   --> Green Start screens (green-start-web\dist, served as plain files)
//
// ACCESS: every request must carry the signed cookie `tl_gs`, which TeamLink hands out (POST /api/omni-gs/session) to a signed-in login that may
//         open Green Start. The gate asks TeamLink (GET /api/omni-gs/verify on 127.0.0.1:4010) whether the cookie is good (answers cached 20 s).
//         No cookie / bad cookie = 401. TeamLink's own cookie never goes on to Green Start; only Green Start's own cookies do.
// BIND:   127.0.0.1 (and ::1) only. Nothing here is reachable from other computers.
//
// Env (all optional): GATE_PORT 5190, GS_API_PORT 4020, TEAMLINK_URL http://127.0.0.1:4010, GS_WEB_DIR <green-start-web\dist>,
//                     GATE_FRAME_ANCESTORS (extra origins that may frame the screens; default the TeamLink dev addresses).
//   LIVE SITE (2026-10-22), all off / empty by default so the PC behaves exactly as before:
//   GATE_TRUST_PROXY=1        nginx stands in front (the gate listens on 127.0.0.1 only, so only nginx can set the headers): the real visitor address
//                             (X-Forwarded-For) and protocol (X-Forwarded-Proto) are passed on to Green Start and when asking TeamLink to check the pass.
//                             Without it, Green Start is told the gate's own socket address and "http" (any value a visitor sends is thrown away).
//   GATE_TEAMLINK_PUBLIC_URL  the address of TeamLink people can click (https://teamlink.teamlinks.in): the "pass has ended" page links to it.
//   GATE_STAFF_MODE=1         staff only use the product: its own sign-up and pricing pages, new-account sign-up and payments (top-up, plan) are
//                             closed with a friendly "Not available for staff" answer. GATE_BLOCK_PAGES=/a,/b and GATE_BLOCK_API="POST /api/x,..."
//                             add more. (A single-page app: this stops typed addresses and the calls; it cannot remove a link drawn inside the app.)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.GATE_PORT) || 5190;
const API_PORT = Number(process.env.GS_API_PORT) || 4020;
const TEAMLINK = new URL(process.env.TEAMLINK_URL || 'http://127.0.0.1:4010');
const WEB = path.resolve(process.env.GS_WEB_DIR || path.join(here, '..', 'green-start-web', 'dist'));
const COOKIE = 'tl_gs';
const on = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim());
const TRUST_PROXY = on(process.env.GATE_TRUST_PROXY);
const STAFF_MODE = on(process.env.GATE_STAFF_MODE);
const TL_PUBLIC = (() => { try { const u = new URL(String(process.env.GATE_TEAMLINK_PUBLIC_URL || '').trim()); return /^https?:$/.test(u.protocol) ? u.origin : ''; } catch { return ''; } })();
// closed for staff (GATE_STAFF_MODE=1). Pages: whole sub-trees. API: "METHOD /prefix" (anything under the prefix).
const norm = (p) => { let s = String(p || ''); try { s = decodeURIComponent(s); } catch { /* keep */ } return `/${s.toLowerCase().split('/').filter(Boolean).join('/')}`; };
const BLOCK_PAGES = [...(STAFF_MODE ? ['/signup', '/pricing'] : []), ...String(process.env.GATE_BLOCK_PAGES || '').split(',')].map((s) => s.trim()).filter(Boolean).map(norm);
const BLOCK_API = [...(STAFF_MODE ? ['POST /api/v1/auth/register', 'POST /api/v1/auth/google/signup', 'POST /api/v1/billing/topups', 'POST /api/v1/billing/subscription'] : []), ...String(process.env.GATE_BLOCK_API || '').split(',')]
  .map((s) => s.trim()).filter(Boolean).map((s) => { const m = /^([A-Za-z]+)\s+(\S+)$/.exec(s); return m ? { method: m[1].toUpperCase(), prefix: norm(m[2]) } : { method: '*', prefix: norm(s) }; });
const under = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);
const blockedPage = (pathname) => BLOCK_PAGES.some((p) => under(norm(pathname), p));
const blockedApi = (method, pathname) => BLOCK_API.some((b) => (b.method === '*' || b.method === String(method).toUpperCase()) && under(norm(pathname), b.prefix));
const FRAME = `frame-ancestors 'self' ${process.env.GATE_FRAME_ANCESTORS || 'http://localhost:5183 http://127.0.0.1:5183 http://localhost:4010 http://127.0.0.1:4010'}`;
// one stored media file (see PUBLIC MEDIA in the request handler): /media/<scope>/<workspace uuid>/<random uuid>.<ext>
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const MEDIA_FILE = new RegExp(`^/media/[a-z0-9_-]{1,40}/${UUID}/${UUID}\\.[a-z0-9]{2,5}$`, 'i');
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json', '.webmanifest': 'application/manifest+json', '.xml': 'application/xml' };

const cookieOf = (req, name) => {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
};
const withoutTeamlinkCookie = (raw) => String(raw || '').split(';').map((s) => s.trim()).filter((s) => s && !s.startsWith(`${COOKIE}=`)).join('; ');

// ---- ask TeamLink whether the cookie is good --------------------------------
const seen = new Map(); // cookie value -> expiry ms (only good answers are kept)
// The visitor's real address and protocol. Behind nginx (GATE_TRUST_PROXY=1) these come from nginx's headers; otherwise from the socket (a visitor's own
// X-Forwarded-* values are never believed). Only a plain address / "http" / "https" is passed on.
function visitor(req) {
  const sock = (req.socket && req.socket.remoteAddress) || '';
  const xff = TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').trim() : '';
  const xfp = TRUST_PROXY ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() : '';
  return { ip: /^[0-9a-fA-F:., ]{1,200}$/.test(xff) ? xff : sock, proto: xfp === 'https' ? 'https' : 'http' };
}
function verify(token, req) {
  if (!token) return Promise.resolve('no');
  const hit = seen.get(token);
  if (hit && hit > Date.now()) return Promise.resolve('yes');
  const v = req ? visitor(req) : { ip: '', proto: 'http' };
  return new Promise((resolve) => {
    const r = http.request({ host: TEAMLINK.hostname, port: TEAMLINK.port, path: '/api/omni-gs/verify', method: 'GET', headers: { cookie: `${COOKIE}=${token}`, ...(v.ip ? { 'x-forwarded-for': v.ip } : {}), 'x-forwarded-proto': v.proto }, timeout: 4000 }, (res) => {
      res.resume();
      if (res.statusCode === 204) { seen.set(token, Date.now() + 20000); if (seen.size > 500) seen.clear(); resolve('yes'); }
      else if (res.statusCode === 401) { seen.delete(token); resolve('no'); }
      else resolve('down');
    });
    r.on('timeout', () => { r.destroy(); resolve('down'); });
    r.on('error', () => resolve('down'));
    r.end();
  });
}

const page = (res, code, title, body) => {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': FRAME, 'x-content-type-options': 'nosniff' });
  res.end(`<!doctype html><meta charset="utf-8"><title>Green Start</title><body style="font-family:system-ui,sans-serif;padding:32px;color:#123"><h2>${title}</h2><p>${body}</p></body>`);
};
// 401 for a page: the friendly "open it again" page, with a button back to TeamLink when GATE_TEAMLINK_PUBLIC_URL is set (the link is a plain https address, never from the request).
function passEndedPage(res) {
  const back = TL_PUBLIC ? `<p><a href="${TL_PUBLIC}/" style="display:inline-block;background:#1d9b5a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Back to TeamLink</a></p>` : '';
  return page(res, 401, 'Please open Green Start again from TeamLink',
    `Your Green Start pass is missing or has ended (it lasts 8 hours). Open TeamLink, sign in, and click <b>Open Green Start again from the Omni-Channel menu</b> (left side).</p>${back}<p style="color:#667;font-size:13px">Nothing is lost. Your Green Start work is saved.`);
}
const json = (res, code, msg) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ success: false, error: { code: 'GATE', message: msg } }));
};

// ---- the API side ----------------------------------------------------------
function forwardApi(req, res) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k.toLowerCase()) && k.toLowerCase() !== 'cookie') headers[k] = v;
  const ck = withoutTeamlinkCookie(req.headers.cookie);
  if (ck) headers.cookie = ck;
  const v = visitor(req);
  headers['x-forwarded-for'] = v.ip;
  headers['x-forwarded-proto'] = v.proto;
  const sse = /\/realtime\/stream(\?|$)/.test(req.url);
  const up = http.request({ host: '127.0.0.1', port: API_PORT, method: req.method, path: req.url, headers, timeout: sse ? 0 : 5 * 60 * 1000 }, (pres) => {
    const h = {};
    for (const [k, v] of Object.entries(pres.headers)) if (!HOP.has(k.toLowerCase())) h[k] = v;
    if (sse) { h['cache-control'] = 'no-cache, no-transform'; h['x-accel-buffering'] = 'no'; }
    res.writeHead(pres.statusCode, h);
    if (sse && res.flushHeaders) res.flushHeaders();
    pres.pipe(res);
    res.on('close', () => { if (!res.writableEnded) pres.destroy(); });
  });
  up.on('timeout', () => up.destroy(new Error('timeout')));
  up.on('error', () => (res.headersSent ? res.end() : json(res, 503, 'Green Start server is not running.')));
  req.on('aborted', () => up.destroy());
  req.pipe(up);
}

// ---- the screens (plain files + single-page-app fallback) -------------------
function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD' }); return res.end(); }
  if (!fs.existsSync(path.join(WEB, 'index.html'))) return page(res, 503, 'Green Start is not built yet', 'Run start-green-start.cmd in the green-start-app\\run folder; it builds the screens once.');
  let rel;
  try { rel = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400); return res.end(); }
  if (rel.includes('\0')) { res.writeHead(400); return res.end(); }
  let file = path.join(WEB, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (file !== WEB && !file.startsWith(WEB + path.sep)) { res.writeHead(403); return res.end(); }
  let st = null;
  try { st = fs.statSync(file); if (st.isDirectory()) { file = path.join(file, 'index.html'); st = fs.statSync(file); } } catch { st = null; }
  if (!st || !st.isFile()) {
    if (/\.[a-z0-9]{1,6}$/i.test(rel) && !/\.html?$/i.test(rel)) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    file = path.join(WEB, 'index.html'); st = fs.statSync(file);
  }
  const ext = path.extname(file).toLowerCase();
  const headers = { 'content-type': MIME[ext] || 'application/octet-stream', 'content-length': st.size, 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' };
  headers['cache-control'] = /\/assets\/.+-[A-Za-z0-9_-]{6,}\.[a-z0-9]+$/.test(file.replace(/\\/g, '/')) ? 'private, max-age=31536000, immutable' : 'no-cache';
  if (ext === '.html') headers['content-security-policy'] = FRAME;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  return fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const pathname = (req.url || '/').split('?')[0];
  if (pathname === '/__gate/health') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end('{"ok":true}'); }
  const isApi = pathname.startsWith('/api/') || pathname.startsWith('/media/');
  // PUBLIC MEDIA (founder 2026-10-31, asked and approved: "media public cheyyi"): a Facebook post with an image failed "Missing or invalid
  // image file" - Facebook, Instagram and LinkedIn download a post's image / video from its address themselves and carry no TeamLink pass.
  // Only a plain read of ONE stored media file passes without the pass: GET / HEAD of /media/<scope>/<workspace uuid>/<random uuid>.<ext>
  // (unguessable names, gs-api storage newKey; no folder listing). Every other address still needs the pass.
  if ((req.method === 'GET' || req.method === 'HEAD') && MEDIA_FILE.test(pathname)) return forwardApi(req, res);
  const ok = await verify(cookieOf(req, COOKIE), req);
  if (ok === 'down') return isApi ? json(res, 503, 'TeamLink is not answering, so the entrance cannot check your pass.') : page(res, 503, 'TeamLink is not answering', 'The entrance could not check your pass. Open Omni-Channel again in a minute.');
  if (ok !== 'yes') {
    // No pass, a wrong pass, or a pass that has run out (it lasts 8 hours on the live site). Plain words, and a way back.
    return isApi ? json(res, 401, 'Your Green Start pass is missing or has ended. Open Green Start again from the Omni-Channel menu in TeamLink.')
      : passEndedPage(res);
  }
  if (BLOCK_PAGES.length || BLOCK_API.length) {
    if (isApi ? blockedApi(req.method, pathname) : blockedPage(pathname)) {
      return isApi ? json(res, 403, 'Not available for staff. Please ask your Admin.')
        : page(res, 403, 'Not available for staff', 'This part of Green Start (sign-up, pricing and payments) is not used by staff. Please ask your Admin if you need it.');
    }
  }
  return isApi ? forwardApi(req, res) : serveStatic(req, res);
});
server.headersTimeout = 30000;
server.on('clientError', (e, sock) => { try { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { /* gone */ } });
server.listen(PORT, '127.0.0.1', () => console.log(`Green Start entrance on http://localhost:${PORT}/  (API 127.0.0.1:${API_PORT}, screens ${WEB})`));
// the same on IPv6 loopback, because "localhost" may resolve to ::1 first; harmless if it is not available
const server6 = http.createServer(server.listeners('request')[0]);
server6.on('error', () => {});
server6.listen(PORT, '::1');
