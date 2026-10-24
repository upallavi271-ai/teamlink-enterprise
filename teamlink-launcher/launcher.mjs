#!/usr/bin/env node
// ---------------------------------------------------------------------------
// TEAMLINK LAUNCHER (founder, 2026-10-23). A small helper that runs on the recruiter's OWN PC.
//
//   TeamLink (in the browser) --"open Naukri with this requirement"--> the Launcher (127.0.0.1:47831, this PC only)
//   The Launcher opens YOUR Chrome (its own profile, so you stay signed in next time), at the board's page, with a small green
//   "TeamLink: fill this form" button in the corner of the page.
//   YOU sign in. YOU open "post a job". YOU press the green button: the Launcher types the saved requirement into the empty boxes it recognises.
//   YOU check it and press the board's own Post button.
//
// What it will NOT do (on purpose): sign in for you, read or save your password, press Post / Submit, overwrite what is already typed,
// open any address other than the board's own start page, or answer anything but this PC (127.0.0.1) and TeamLink's own addresses.
//
// Needs: Node 18+, Google Chrome (or Edge) installed, and `npm install` once in this folder (playwright-core only: no browser is downloaded).
//   node launcher.mjs            start it (leave the window open)
// ---------------------------------------------------------------------------
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { fillInPage } from './fill.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
function loadPlaywright() {
  for (const p of ['playwright-core', path.join(here, '..', 'backend', 'node_modules', 'playwright-core')]) {
    try { return require(p); } catch { /* try the next place */ }
  }
  throw new Error('playwright-core is not installed here. Run:  npm install   (once, in the teamlink-launcher folder)');
}

export const VERSION = '1.0.0';
export const PORT = Number(process.env.TL_LAUNCHER_PORT) || 47831;
const TEST = process.env.TL_LAUNCHER_TEST === '1';
export const BOARDS = {
  naukri: { name: 'Naukri', url: 'https://www.naukri.com/recruit/login' },
  shine: { name: 'Shine', url: 'https://recruiter.shine.com/' },
  linkedin: { name: 'LinkedIn', url: 'https://www.linkedin.com/talent/post-a-job' },
  indeed: { name: 'Indeed', url: 'https://employers.indeed.com/' },
};
const ORIGINS = [
  'https://teamlink.teamlinks.in', 'http://localhost:5183', 'http://127.0.0.1:5183', 'http://localhost:4010', 'http://127.0.0.1:4010',
  ...String(process.env.TL_LAUNCHER_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
];

const sessions = new Map(); // board -> { context, fields }
export const __sessions = sessions;

const profileDir = (board) => path.join(process.env.TL_LAUNCHER_HOME || path.join(os.homedir(), '.teamlink-launcher'), board);
const say = (m) => console.log(`${new Date().toLocaleTimeString()}  ${m}`);

// the green button, put on every page of the Launcher's browser
const BUTTON = `(() => {
  if (window.top !== window || document.getElementById('__tl_launcher')) return;
  const mount = () => {
    if (document.getElementById('__tl_launcher') || !document.body) return;
    const box = document.createElement('div');
    box.id = '__tl_launcher';
    box.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483647;font:13px system-ui,sans-serif;background:#fff;border:1px solid #1fa855;border-radius:10px;padding:8px 10px;box-shadow:0 4px 18px rgba(0,0,0,.2);max-width:300px';
    box.innerHTML = '<div style="font-weight:700;color:#14633f">TeamLink Launcher</div><button id="__tl_go" style="margin-top:6px;background:#1fa855;color:#fff;border:0;border-radius:8px;padding:7px 12px;font-weight:700;cursor:pointer">Fill this form from TeamLink</button><div id="__tl_msg" style="margin-top:6px;color:#334"></div>';
    document.body.appendChild(box);
    document.getElementById('__tl_go').addEventListener('click', async () => {
      const m = document.getElementById('__tl_msg');
      m.textContent = 'Filling...';
      try { const r = await window.__tlLauncherFill(); m.innerHTML = r.message; } catch (e) { m.textContent = 'Could not fill: ' + (e && e.message || e); }
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
  setInterval(mount, 2500); // single-page sites replace the page body
})();`;

async function fillAllFrames(page, fields) {
  const filled = [];
  let leftSets = [];
  for (const frame of page.frames()) {
    // eslint-disable-next-line no-await-in-loop
    const r = await frame.evaluate(fillInPage, fields.filter((f) => !filled.includes(f.label))).catch(() => null);
    if (r) { filled.push(...r.filled); leftSets.push(r.left); }
  }
  const left = fields.map((f) => f.label).filter((l) => !filled.includes(l));
  leftSets = null;
  return { filled, left };
}
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
function words(r) {
  if (!r.filled.length) return 'Nothing matched on this page. Open the "post a job" form first, then press the button again. Or use the Copy buttons in TeamLink.';
  return `Filled: <b>${esc(r.filled.join(', '))}</b>.${r.left.length ? ` Not filled (copy these from TeamLink): ${esc(r.left.join(', '))}.` : ''} Check everything, then press the site's own Post button.`;
}

async function openBoard(board, fields) {
  const b = BOARDS[board];
  if (!b) throw Object.assign(new Error('That job board is not known to the Launcher.'), { status: 400 });
  let s = sessions.get(board);
  if (s) { try { if (!s.context.pages().length && !s.context.browser()) throw new Error('closed'); } catch { sessions.delete(board); s = null; } }
  if (!s) {
    const { chromium } = loadPlaywright();
    const dir = profileDir(board);
    fs.mkdirSync(dir, { recursive: true });
    const base = { headless: TEST || process.env.TL_LAUNCHER_HEADLESS === '1', viewport: null, args: ['--start-maximized', '--no-first-run'] };
    let context = null;
    const exe = process.env.TL_LAUNCHER_CHROME_PATH;
    const tries = exe ? [{ executablePath: exe }] : [{ channel: 'chrome' }, { channel: 'msedge' }];
    let lastErr = null;
    for (const t of tries) {
      try { context = await chromium.launchPersistentContext(dir, { ...base, ...t }); break; } catch (e) { lastErr = e; }
    }
    if (!context) throw Object.assign(new Error('Google Chrome (or Edge) could not be opened on this PC. Install Chrome, or close the window of this board that is already open.'), { status: 500, detail: lastErr && lastErr.message });
    s = { context, fields: [] };
    context.on('close', () => sessions.delete(board));
    await context.exposeBinding('__tlLauncherFill', async ({ page }) => {
      const cur = sessions.get(board);
      const r = await fillAllFrames(page, (cur && cur.fields) || []);
      say(`${b.name}: filled ${r.filled.length} box(es)${r.left.length ? `, left ${r.left.length}` : ''}`);
      return { ...r, message: words(r) };
    });
    await context.addInitScript(BUTTON);
    sessions.set(board, s);
  }
  s.fields = (Array.isArray(fields) ? fields : []).filter((f) => f && f.label && String(f.value || '').trim()).map((f) => ({ label: String(f.label), value: String(f.value) }));
  const page = s.context.pages()[0] || await s.context.newPage();
  const start = TEST && process.env.TL_LAUNCHER_TEST_URL ? process.env.TL_LAUNCHER_TEST_URL : b.url;
  if (!page.url() || page.url() === 'about:blank') await page.goto(start, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
  try { await page.bringToFront(); } catch { /* headless */ }
  return { board: b.name, boxes: s.fields.length };
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin) {
    if (!ORIGINS.includes(origin)) return false;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Private-Network', 'true'); // Chrome asks this when an https page talks to this PC
  }
  return true;
}
const json = (res, code, body) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve, reject) => {
  let n = 0; const parts = [];
  req.on('data', (c) => { n += c.length; if (n > 300000) { reject(Object.assign(new Error('Too much data.'), { status: 413 })); req.destroy(); } else parts.push(c); });
  req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch { reject(Object.assign(new Error('Not valid JSON.'), { status: 400 })); } });
});

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      if (!cors(req, res)) return json(res, 403, { ok: false, error: 'This address is not allowed to use the Launcher.' });
      if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/ping') return json(res, 200, { ok: true, app: 'teamlink-launcher', version: VERSION, boards: Object.keys(BOARDS) });
      if (req.method === 'POST' && url.pathname === '/open') {
        const body = await readBody(req);
        const r = await openBoard(String(body.board || '').toLowerCase(), body.fields);
        return json(res, 200, { ok: true, ...r, message: `${r.board} is open. Sign in, open "post a job", then press the green "Fill this form from TeamLink" button in the corner of the page.` });
      }
      if (TEST && req.method === 'POST' && url.pathname === '/_test/fill') {
        const body = await readBody(req);
        const s = sessions.get(String(body.board || '').toLowerCase());
        if (!s) return json(res, 404, { ok: false, error: 'not open' });
        const r = await fillAllFrames(s.context.pages()[0], s.fields);
        return json(res, 200, { ok: true, ...r });
      }
      return json(res, 404, { ok: false, error: 'Not found' });
    } catch (e) {
      return json(res, e.status || 500, { ok: false, error: e.message || 'The Launcher had a problem.' });
    }
  });
}

export async function closeAll() { for (const s of sessions.values()) { try { await s.context.close(); } catch { /* gone */ } } sessions.clear(); }

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const server = createServer();
  server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `The Launcher is already running (port ${PORT}).` : e.message); process.exit(1); });
  server.listen(PORT, '127.0.0.1', () => {
    console.log('============================================================');
    console.log(` TeamLink Launcher ${VERSION} is running on this PC (127.0.0.1:${PORT}).`);
    console.log(' Leave this window open. In TeamLink press "Open <board> with the Launcher".');
    console.log(' It never signs in for you and never presses Post. Close this window to stop it.');
    console.log('============================================================');
  });
  process.on('SIGINT', async () => { await closeAll(); process.exit(0); });
}
