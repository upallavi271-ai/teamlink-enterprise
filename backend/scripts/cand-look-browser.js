#!/usr/bin/env node
/**
 * CANDIDATES & PIPELINE, THE NEW LOOK (founder 2026-11-21: "make this page look more attractive"). Screenshots only, in a real
 * browser. SANDBOX ONLY: a private backend on a COPY of the sandbox database, the BUILT frontend through `vite preview`
 * (API_PROXY to that backend) and the machine's Edge through playwright-core. Modelled on tabs-clean-browser.js.
 *   cd frontend && npx vite build        (first)
 *   CAND_SHOTS=before CAND_DIST=<a build of origin/main> TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4612 node scripts/cand-look-browser.js
 *   CAND_SHOTS=after TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4612 node scripts/cand-look-browser.js
 * Writes docs/cand-look-2026-11-21/<phase>-<role>-<desktop|phone>[-insights].png for a Super Admin, a TL and a Recruiter,
 * at 1440 px and 375 px, with Insights closed (the default) and opened. Prints the page height and any sideways scroll.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const FRONT = path.resolve(BACK, '..', 'frontend');
const DIST = process.env.CAND_DIST ? path.resolve(process.env.CAND_DIST) : path.join(FRONT, 'dist');
const SHOTS = path.resolve(BACK, '..', 'docs', 'cand-look-2026-11-21');
const PHASE = process.env.CAND_SHOTS || 'after';
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-candlook-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT || 4612);
const WEB = Number(process.env.TEST_WEB_PORT || PORT + 1000);
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'cand-look', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const procs = [];
let browser;
async function stop(code) {
  try { if (browser) await browser.close(); } catch { /* closed */ }
  procs.forEach((p) => { try { p.kill(); } catch { /* gone */ } });
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const waitFor = async (url, tries = 600) => { for (let i = 0; i < tries; i += 1) { if (await fetch(url).then((r) => r.status < 500).catch(() => false)) return true; await sleep(500); } return false; }; // eslint-disable-line no-await-in-loop
const tok = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '3h' });
const api = async (url, token) => {
  const r = await fetch(API + url, { headers: { Authorization: `Bearer ${token}` } });
  let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j };
};

(async () => {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) { console.log(`Build the frontend first (no ${DIST}/index.html): cd frontend && npx vite build`); await stop(2); return; }
  fs.mkdirSync(SHOTS, { recursive: true });

  const users = async (model, col, atsRole) => {
    const rows = await prisma[model].groupBy({ by: [col], where: { [col]: { not: null } }, _count: { _all: true }, orderBy: { _count: { id: 'desc' } }, take: 80 });
    const out = [];
    for (const r of rows) {
      const u = await prisma.user.findUnique({ where: { id: r[col] } }); // eslint-disable-line no-await-in-loop
      if (u && u.status === 'Active' && u.atsRole === atsRole) out.push(u);
    }
    return out;
  };
  const RECS = await users('application', 'ownerRecruiterId', 'RECRUITER');
  const TLS = await users('requirement', 'tlId', 'TL');
  const ADM = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example.test/i.test(`${u.name}${u.email}`));
  for (const u of [...RECS.slice(0, 25), ...TLS.slice(0, 25), ADM].filter(Boolean)) {
    await prisma.user.update({ where: { id: u.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } }); // eslint-disable-line no-await-in-loop
  }

  procs.push(spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' }));
  if (!(await waitFor(`${API}/health`))) { console.log(`The server did not answer /api/health on ${PORT}: pick another TEST_PORT.`); await stop(2); return; }
  const webArgs = [path.join(FRONT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(WEB), '--strictPort', '--host', 'localhost', '--outDir', DIST];
  procs.push(spawn(process.execPath, webArgs, { cwd: FRONT, env: { ...process.env, API_PROXY: `http://localhost:${PORT}` }, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' }));
  if (!(await waitFor(`http://localhost:${WEB}/`))) { console.log(`vite preview did not answer on ${WEB}`); await stop(2); return; }
  await sleep(1000);
  const withRows = async (list) => {
    for (const u of list.slice(0, 25)) {
      const r = await api('/candidates?paged=1&view=pipeline&sub=active&pageSize=1', await tok(u.id)); // eslint-disable-line no-await-in-loop
      if (r.body && r.body.rows && r.body.rows.length) return u;
    }
    return list[0];
  };
  const REC = await withRows(RECS); const TL = await withRows(TLS);
  if (!(REC && TL && ADM)) { console.log('No Recruiter, TL or Super Admin to log in as'); await stop(1); return; }

  const { chromium } = require('playwright-core');
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const W = `http://localhost:${WEB}`;
  const ONLY = process.env.CAND_ROLES ? process.env.CAND_ROLES.split(',') : null; // a quicker run for one role (while styling)
  const WHO = [['superadmin', ADM], ['tl', TL], ['recruiter', REC]].filter(([k]) => !ONLY || ONLY.includes(k));
  for (const f of fs.readdirSync(SHOTS)) if (f.startsWith(`${PHASE}-`) && f.endsWith('.png') && WHO.some(([k]) => f.startsWith(`${PHASE}-${k}-`))) fs.unlinkSync(path.join(SHOTS, f));
  let errors = 0;
  for (const [key, u] of WHO) {
    const token = await tok(u.id); // eslint-disable-line no-await-in-loop
    for (const [w, h, tag] of [[1440, 900, 'desktop'], [375, 812, 'phone']]) {
      for (const ins of [false, true]) {
        const ctx = await browser.newContext({ viewport: { width: w, height: h } }); // eslint-disable-line no-await-in-loop
        ctx.setDefaultTimeout(60000); ctx.setDefaultNavigationTimeout(120000);
        await ctx.addInitScript((t) => { try { if (!localStorage.getItem('tl_token')) localStorage.setItem('tl_token', t); } catch { /* none */ } }, token); // eslint-disable-line no-await-in-loop
        const page = await ctx.newPage(); // eslint-disable-line no-await-in-loop
        const errs = [];
        page.on('pageerror', (e) => errs.push(e.message));
        await page.goto(`${W}/candidates?view=pipeline&sub=active`, { waitUntil: 'domcontentloaded' }); // eslint-disable-line no-await-in-loop
        await page.locator('.fbar-count').first().waitFor({ timeout: 60000 }).catch(() => {}); // eslint-disable-line no-await-in-loop
        await page.locator('.cpl-table tbody tr, .ak-empty, .empty').first().waitFor({ timeout: 60000 }).catch(() => {}); // eslint-disable-line no-await-in-loop
        await sleep(2500); // eslint-disable-line no-await-in-loop
        if (ins) {
          await page.locator('.cv4-fold-head').first().click(); // eslint-disable-line no-await-in-loop
          await page.locator('.cv4-kpis').first().waitFor({ timeout: 30000 }).catch(() => {}); // eslint-disable-line no-await-in-loop
          await sleep(3500); // eslint-disable-line no-await-in-loop
        }
        const name = `${PHASE}-${key}-${tag}${ins ? '-insights' : ''}.png`;
        await page.screenshot({ path: path.join(SHOTS, name), fullPage: true }); // eslint-disable-line no-await-in-loop
        const dims = await page.evaluate(() => ({ h: document.documentElement.scrollHeight, over: document.documentElement.scrollWidth - window.innerWidth })); // eslint-disable-line no-await-in-loop
        console.log(`  shot ${name}  page height ${dims.h}px, sideways ${dims.over}px${errs.length ? `, page errors: ${errs.slice(0, 2).join(' | ')}` : ''}`);
        errors += errs.length;
        await ctx.close(); // eslint-disable-line no-await-in-loop
      }
    }
  }
  console.log(errors ? `${errors} page error(s)` : 'no page errors');
  await stop(errors ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
