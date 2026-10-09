// ---------------------------------------------------------------------------
// THE TEAMLINK JOB PORTAL, EMBEDDED (2026-10-05).
//
// The customer's Job Portal (job-portal-app/job_portal-main — Express +
// PostgreSQL, their own UI) is kept exactly as supplied and served from THIS
// app's address at /jobs. One start command: this backend starts the portal
// itself, keeps it running and proxies to it. Nobody opens a second port.
//
//   SUPERVISOR  start()  — on boot, adopt a portal that is already answering
//               on the internal port (a nodemon restart of this backend does
//               not stop it), else start one: job-portal-app/embed/launcher.cjs
//               → embed/host.mjs → the portal's own tools/dev-server.mjs.
//               Hidden (windowsHide), detached, logs to job-portal-app/run/
//               portal.log. Checked every 10 s; started again if it died.
//               This backend touches a heartbeat file every 5 s; when it is
//               STOPPED the portal shuts itself down cleanly ~90 s later.
//   PROXY       proxy()  — /jobs/*  → the portal (its API is /jobs/api/*).
//               /reset-password, /teamlink-sw.js, /manifest.webmanifest,
//               /icons/* → the portal (paths the portal uses at the root and
//               this app does not use). An /api/* request made FROM a /jobs
//               page (Referer) → the portal: a few of its screens call /api/…
//               with a fixed path instead of its configurable API base.
//
// THE ONLY THING ADDED TO THE PORTAL'S PAGES (configuration, not UI):
//   <script>window.TL_API_BASE='/jobs/api';</script> just before its
//   <script src="teamlink-integration.js">. TL_API_BASE is the portal's own
//   documented hook (web/teamlink-integration.js "Where the API lives").
//   Plus, on the two pages the portal serves at a fixed root path: /job/:id
//   (a shared job link) has its "/#/job/…" address rewritten to "/jobs/#/job/…",
//   and /reset-password gets <base href="/jobs/"> so its files load from /jobs/.
//
// Switch: JOB_PORTAL_EMBED (default ON outside production, OFF in production
// unless set) — never in the TEST SANDBOX. Names only, never values in logs:
//   JOB_PORTAL_PORT (4323)       internal port, bound to 127.0.0.1
//   JOB_PORTAL_PG_PORT (5434)    the embedded database's internal socket
//   JOB_PORTAL_DIR               the portal folder
//   APP_BASE_URL                 this site (the portal's links: <it>/jobs/…)
//   JOB_PORTAL_SYNC_TOKEN / JOB_PORTAL_PUSH_SECRET   the two sync secrets
//   JOBPORTAL__<NAME>            passed to the portal as <NAME> (production:
//                                JOBPORTAL__DATABASE_URL, JOBPORTAL__AUTH_SECRET,
//                                JOBPORTAL__NODE_ENV=production …)
// ---------------------------------------------------------------------------
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');

const BASE = '/jobs';
const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim());
const trimSlash = (s) => String(s || '').replace(/\/+$/, '');

const PORTAL_DIR = path.resolve(process.env.JOB_PORTAL_DIR || path.join(__dirname, '..', '..', '..', 'job-portal-app', 'job_portal-main'));
const EMBED_DIR = path.resolve(__dirname, '..', '..', '..', 'job-portal-app', 'embed');
const RUN_DIR = path.resolve(process.env.JOB_PORTAL_RUN_DIR || path.join(PORTAL_DIR, '..', 'run'));
const HEARTBEAT = path.join(RUN_DIR, 'heartbeat');
const PIDFILE = path.join(RUN_DIR, 'portal.pid.json');
const LOGFILE = path.join(RUN_DIR, 'portal.log');
const port = () => parseInt(process.env.JOB_PORTAL_PORT, 10) || 4323;
const internalUrl = () => `http://127.0.0.1:${port()}`;
const appBase = () => trimSlash(process.env.APP_BASE_URL || 'http://localhost:5183');

function isSandbox() {
  try { return require('./sandbox').isSandbox(); } catch { return false; } // eslint-disable-line global-require
}
function enabled() {
  if (isSandbox()) return false;
  if (process.env.JOB_PORTAL_EMBED !== undefined && process.env.JOB_PORTAL_EMBED !== '') return truthy(process.env.JOB_PORTAL_EMBED);
  return process.env.NODE_ENV !== 'production';
}

// ---- supervisor ------------------------------------------------------------

const state = {
  started: false, adopted: false, pid: null, lastHealthyAt: null, lastStartAt: null,
  restarts: 0, lastError: null, failures: 0,
};

function health(timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.get(`${internalUrl()}/api/health`, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function readPid() {
  try { return JSON.parse(fs.readFileSync(PIDFILE, 'utf8')); } catch { return null; }
}
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

function beat() {
  try { fs.mkdirSync(RUN_DIR, { recursive: true }); fs.writeFileSync(HEARTBEAT, `alive ${process.pid} ${new Date().toISOString()}\n`); } catch { /* next beat */ }
}
function requestStop() {
  try { fs.writeFileSync(HEARTBEAT, `stop ${process.pid} ${new Date().toISOString()}\n`); } catch { /* ignore */ }
}

// The portal's environment: a CLEAN one. This backend's own DATABASE_URL
// (SQLite), PORT, JWT_SECRET … must never reach it.
const PASS_THROUGH = /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|HOMEDRIVE|HOMEPATH|USERPROFILE|USERNAME|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|COMMONPROGRAMFILES|COMPUTERNAME|OS|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|LANG|TZ)$/i;
function portalEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (PASS_THROUGH.test(k)) env[k] = v;
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith('JOBPORTAL__') && k.length > 11) env[k.slice(11)] = v;
  const site = appBase();
  let siteOrigin = site;
  try { siteOrigin = new URL(site).origin; } catch { /* keep */ }
  Object.assign(env, {
    JP_ROOT: PORTAL_DIR,
    JP_PORT: String(port()),
    JP_HEARTBEAT: HEARTBEAT,
    JP_PIDFILE: PIDFILE,
    JP_LOG: LOGFILE,
    PG_PORT: env.PG_PORT || process.env.JOB_PORTAL_PG_PORT || '5434',
    // The portal's links (e-mails, shares, reset) say <this site>/jobs/…
    PUBLIC_ORIGIN: env.PUBLIC_ORIGIN || `${site}${BASE}`,
    PUBLIC_SHARE_URL: env.PUBLIC_SHARE_URL || `${site}${BASE}`,
    // …and the browser's Origin header is this site's origin.
    EXTRA_ORIGINS: [env.EXTRA_ORIGINS, siteOrigin].filter(Boolean).join(','),
    // The sync: both secrets are this backend's, so they always match.
    TEAMLINK_API_URL: `http://127.0.0.1:${process.env.PORT || 4010}`,
    JOB_PORTAL_SYNC_TOKEN: process.env.JOB_PORTAL_SYNC_TOKEN || '',
    JOB_PORTAL_PUSH_SECRET: process.env.JOB_PORTAL_PUSH_SECRET || '',
    // Single sign-on from HRMS (utils/jobPortalSso.js): the same secret, this
    // site for "Back to HRMS", and the shared inactivity timeout.
    HRMS_SSO_SECRET: process.env.HRMS_SSO_SECRET || '',
    HRMS_URL: env.HRMS_URL || site,
    HRMS_API_URL: `http://127.0.0.1:${process.env.PORT || 4010}`,
    HRMS_SSO_IDLE_MINUTES: process.env.SESSION_IDLE_MINUTES || '30',
  });
  return env;
}

function launch() {
  state.lastStartAt = new Date();
  fs.mkdirSync(RUN_DIR, { recursive: true });
  beat();
  const child = spawn(process.execPath, [path.join(EMBED_DIR, 'launcher.cjs')], {
    cwd: PORTAL_DIR,
    env: portalEnv(),
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  });
  child.on('error', (err) => { state.lastError = `could not start: ${err.message}`; });
  child.unref();
  console.log(`[job-portal] starting the embedded Job Portal on internal port ${port()} (log: ${LOGFILE})`);
}

let timer = null;
let beatTimer = null;
let checking = false;
async function check() {
  if (checking) return;
  checking = true;
  try {
    if (await health()) {
      state.lastHealthyAt = new Date();
      state.failures = 0;
      state.lastError = null;
      const p = readPid();
      state.pid = p && p.pid ? p.pid : state.pid;
      return;
    }
    state.failures += 1;
    const p = readPid();
    if (p && alive(p.pid)) {
      // Still booting (migrations, first compile) or busy: give it time.
      if (state.lastStartAt && Date.now() - state.lastStartAt.getTime() < 120000) return;
      if (state.failures < 12) return; // ~2 minutes of no answer from a live process
      state.lastError = `the portal process ${p.pid} is not answering`;
      return; // never killed by force: an embedded database must close cleanly
    }
    // Gone (crashed, or never started). Back off: 0 s, 10 s, 30 s, 60 s …
    const wait = [0, 10000, 30000, 60000][Math.min(state.restarts, 3)];
    if (state.lastStartAt && Date.now() - state.lastStartAt.getTime() < Math.max(wait, 20000)) return;
    if (state.lastStartAt) state.restarts += 1;
    launch();
  } catch (err) {
    state.lastError = err.message;
  } finally {
    checking = false;
  }
}

function start() {
  if (state.started || !enabled()) {
    if (!enabled() && !isSandbox()) console.log('[job-portal] JOB_PORTAL_EMBED is off — /jobs is not served by this backend.');
    return;
  }
  if (!fs.existsSync(path.join(PORTAL_DIR, 'tools', 'dev-server.mjs'))) {
    state.lastError = `no Job Portal in ${PORTAL_DIR}`;
    console.error(`[job-portal] ${state.lastError}`);
    return;
  }
  state.started = true;
  beat();
  beatTimer = setInterval(beat, 5000);
  beatTimer.unref();
  health().then((up) => {
    if (up) {
      state.adopted = true;
      state.lastHealthyAt = new Date();
      const p = readPid();
      state.pid = p && p.pid;
      console.log(`[job-portal] the embedded Job Portal is already running (pid ${state.pid || '?'}) — kept as it is.`);
    } else {
      check();
    }
  });
  timer = setInterval(check, 10000);
  timer.unref();
  // A real stop of this backend (Ctrl+C / SIGTERM) asks the portal to stop
  // too. A nodemon restart sends no signal on Windows, so the portal stays up.
  ['SIGINT', 'SIGTERM'].forEach((sig) => process.on(sig, () => {
    requestStop();
    if (process.listenerCount(sig) === 1) process.exit(sig === 'SIGINT' ? 130 : 143);
  }));
}

function status() {
  return {
    enabled: enabled(),
    url: `${appBase()}${BASE}/`,
    internal: internalUrl(),
    pid: state.pid,
    adopted: state.adopted,
    lastHealthyAt: state.lastHealthyAt,
    restarts: state.restarts,
    lastError: state.lastError,
    log: LOGFILE,
  };
}

// ---- proxy -----------------------------------------------------------------

const CONFIG_TAG = `<script>window.TL_API_BASE=${JSON.stringify(`${BASE}/api`)};</script>`;
const INTEGRATION_TAG = '<script src="teamlink-integration.js"></script>';
const CHARSET = '<meta charset="UTF-8">';
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function inject(html, kind) {
  let out = html;
  const at = out.indexOf(INTEGRATION_TAG);
  if (at >= 0) out = `${out.slice(0, at)}${CONFIG_TAG}\n${out.slice(at)}`;
  const head = out.indexOf(CHARSET);
  if (kind === 'reset' && head >= 0) {
    const cut = head + CHARSET.length;
    out = `${out.slice(0, cut)}\n<base href="${BASE}/">${out.slice(cut)}`;
  }
  if (kind === 'job' && head >= 0) {
    // The portal's share page turns its address into "/#/job/<id>" (or
    // "/?ref=…#/job/<id>") first thing in <head>; under /jobs it must be
    // "/jobs/#/job/<id>". Only that one script, right after the charset tag.
    const zone = out.slice(head, head + 6000)
      .replace(`history.replaceState(null,'',"/`, `history.replaceState(null,'',"${BASE}/`)
      .replace('location.replace("/', `location.replace("${BASE}/`);
    out = out.slice(0, head) + zone + out.slice(head + 6000);
  }
  return out;
}

const gzCache = new Map();
function sendHtml(req, res, status, headers, html) {
  const body = Buffer.from(html, 'utf8');
  const etag = `W/"tl-${crypto.createHash('sha1').update(body).digest('hex').slice(0, 20)}"`;
  const h = { ...headers };
  ['content-length', 'content-encoding', 'etag', 'last-modified', 'vary'].forEach((k) => delete h[k]);
  h['cache-control'] = 'no-cache';
  h.etag = etag;
  h.vary = 'accept-encoding';
  if (status === 200 && req.headers['if-none-match'] === etag) { res.writeHead(304, h); res.end(); return; }
  let payload = body;
  if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || '')) && body.length > 1024) {
    let gz = gzCache.get(etag);
    if (!gz) {
      gz = zlib.gzipSync(body, { level: 6 });
      if (gzCache.size > 20) gzCache.clear();
      gzCache.set(etag, gz);
    }
    payload = gz;
    h['content-encoding'] = 'gzip';
  }
  h['content-length'] = String(payload.length);
  res.writeHead(status, h);
  res.end(req.method === 'HEAD' ? undefined : payload);
}

function unavailable(res, wantsHtml) {
  if (res.headersSent) { res.destroy(); return; }
  if (wantsHtml) {
    res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'retry-after': '5', 'cache-control': 'no-store' });
    res.end('<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>TeamLink Jobs</title>'
      + '<body style="font-family:system-ui,sans-serif;padding:40px;color:#123"><h2>The job portal is starting…</h2>'
      + '<p>This page will open by itself in a few seconds.</p></body>');
    return;
  }
  res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '5' });
  res.end(JSON.stringify({ error: { code: 'PORTAL_UNAVAILABLE', message: 'The job portal is starting. Please try again in a few seconds.' } }));
}

function forward(req, res, upstreamPath, { kind = null, prefix = false } = {}) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k.toLowerCase())) headers[k] = v;
  const transform = !!kind && (req.method === 'GET' || req.method === 'HEAD');
  if (transform) {
    headers['accept-encoding'] = 'identity';
    delete headers['if-none-match'];
    delete headers['if-modified-since'];
  }
  // The visitor's address for the portal's per-IP limits: as a front proxy
  // (nginx, on this machine) already stated it, else the socket's.
  const fwdFor = (req.socket && req.socket.remoteAddress) || '';
  const loopback = /^(::1|127\.|::ffff:127\.)/.test(fwdFor);
  if (!(headers['x-forwarded-for'] && loopback)) {
    headers['x-forwarded-for'] = headers['x-forwarded-for'] ? `${headers['x-forwarded-for']}, ${fwdFor}` : fwdFor;
  }
  headers['x-forwarded-proto'] = headers['x-forwarded-proto'] || (req.socket && req.socket.encrypted ? 'https' : 'http');
  headers['x-forwarded-host'] = headers['x-forwarded-host'] || req.headers.host;
  if (prefix) headers['x-forwarded-prefix'] = BASE;

  const up = http.request({
    host: '127.0.0.1', port: port(), method: req.method, path: upstreamPath, headers, timeout: 5 * 60 * 1000,
  }, (pres) => {
    const h = {};
    for (const [k, v] of Object.entries(pres.headers)) if (!HOP.has(k.toLowerCase())) h[k] = v;
    // A redirect inside the portal stays inside /jobs.
    if (prefix && typeof h.location === 'string' && /^\/(?!\/)/.test(h.location) && !h.location.startsWith(`${BASE}/`)) {
      h.location = BASE + h.location;
    }
    const isHtml = /^text\/html/i.test(String(pres.headers['content-type'] || ''));
    if (transform && isHtml && !pres.headers['content-encoding']) {
      const chunks = [];
      pres.on('data', (c) => chunks.push(c));
      pres.on('end', () => sendHtml(req, res, pres.statusCode, h, inject(Buffer.concat(chunks).toString('utf8'), kind)));
      pres.on('error', () => unavailable(res, true));
      return;
    }
    res.writeHead(pres.statusCode, h);
    pres.pipe(res);
  });
  up.on('timeout', () => up.destroy(new Error('timeout')));
  up.on('error', () => unavailable(res, /text\/html/.test(String(req.headers.accept || ''))));
  req.pipe(up);
}

// Is this request made by a page of the portal (Referer on this host, under
// /jobs or the portal's /reset-password page)?
function fromPortalPage(req) {
  const ref = req.headers.referer || req.headers.referrer;
  if (!ref) return false;
  try {
    const u = new URL(ref);
    // This site, however the request reached us: its own Host, a proxy's
    // X-Forwarded-Host, or APP_BASE_URL (the Vite dev server rewrites Host
    // to the backend's when it proxies /api).
    const hosts = [req.headers.host, req.headers['x-forwarded-host']];
    try { hosts.push(new URL(appBase()).host); } catch { /* not a URL */ }
    if (!hosts.filter(Boolean).includes(u.host)) return false;
    return u.pathname === BASE || u.pathname.startsWith(`${BASE}/`) || u.pathname === '/reset-password';
  } catch { return false; }
}

const ROOT_PATHS = /^\/(teamlink-sw\.js|manifest\.webmanifest|icons\/.+)$/;

// Mounted ahead of every body parser (the request body is streamed through).
function proxy() {
  return (req, res, next) => {
    if (!enabled()) return next();
    const url = req.url || '/';
    const [pathname, query] = [url.split('?')[0], url.includes('?') ? url.slice(url.indexOf('?')) : ''];

    if (pathname === BASE) return res.redirect(301, `${BASE}/${query}`);
    if (pathname.startsWith(`${BASE}/`)) {
      const inner = url.slice(BASE.length) || '/';
      const innerPath = pathname.slice(BASE.length) || '/';
      // The reset link the portal mails is <site>/jobs/reset-password?token=…;
      // the portal's page only works at the root path /reset-password.
      if (innerPath === '/reset-password') return res.redirect(302, `/reset-password${query}`);
      let kind = null;
      if (innerPath === '/' || innerPath === '/index.html' || /\.html$/i.test(innerPath)) kind = 'page';
      else if (/^\/job\/[^/]+\/?$/.test(innerPath)) kind = 'job';
      return forward(req, res, inner, { kind, prefix: true });
    }
    if (pathname === '/reset-password') return forward(req, res, url, { kind: 'reset' });
    if (ROOT_PATHS.test(pathname)) return forward(req, res, url);
    if (pathname.startsWith('/api/') && fromPortalPage(req)) return forward(req, res, url);
    return next();
  };
}

module.exports = {
  start, status, proxy, enabled, requestStop, internalUrl, health,
  // for tests
  _inject: inject, _portalEnv: portalEnv, BASE, RUN_DIR, PIDFILE, HEARTBEAT, LOGFILE,
};
