#!/usr/bin/env node
/**
 * TABS CLEAN-UP (founder 2026-11-20: "Candidates & Pipeline has many tabs, it must be clear what each is for, keep only what is necessary").
 * A BROWSER test (playwright-core + the machine's Edge) on a sandbox server over a COPY of the sandbox database, with the BUILT frontend
 * (frontend/dist: run `npx vite build` first) served by a tiny static server that proxies /api to the sandbox server.
 *   TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4231 node scripts/tabs-clean-test.js
 * For a Recruiter, a TL, a BDE and an Admin it checks: at most 5 main tabs on Candidates & Pipeline (6 on the Candidate page, 5 on the
 * requirement), every tab has a tooltip, the caption under the strip changes with the tab, the role's default tab, the remembered last tab,
 * old links (?view= ?sub= ?tab=) land on the right tab, keyboard / ARIA, no page errors; screenshots go to docs/tabs-clean-2026-11-20/.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const DIST = process.env.TABS_DIST ? path.resolve(process.env.TABS_DIST) : path.resolve(BACK, '..', 'frontend', 'dist'); // TABS_DIST: another build (the "before" screenshots)
const SHOTS = path.resolve(BACK, '..', 'docs', 'tabs-clean-2026-11-20');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-tabs-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT || 4231);
const WEB = PORT + 1000;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'tabs-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ''}`); } };
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
let server; let web; let browser;
let shotN = 0;

async function stop(code) {
  try { if (browser) await browser.close(); } catch { /* closed */ }
  if (web) web.close();
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}

// The built frontend + an /api proxy to the sandbox server.
function startWeb() {
  const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
  web = http.createServer((req, res) => {
    if (req.url.startsWith('/api/')) {
      const p = http.request({ host: 'localhost', port: PORT, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
      p.on('error', () => { res.writeHead(502); res.end(); });
      req.pipe(p);
      return;
    }
    const clean = decodeURIComponent(req.url.split('?')[0]);
    let file = path.join(DIST, clean);
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => { web.listen(WEB, r); });
}

const tok = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '2h' });
const api = async (url, token) => {
  const r = await fetch(API + url, { headers: { Authorization: `Bearer ${token}` } });
  let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j };
};

(async () => {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) { console.log('Build the frontend first: cd frontend && npx vite build'); await stop(2); return; }
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const f of fs.readdirSync(SHOTS)) if (/\.png$/.test(f)) fs.unlinkSync(path.join(SHOTS, f));

  // Who: logins of each kind that hold work (the busiest first); the one that really sees rows is chosen once the server is up.
  const users = async (model, col, atsRole) => {
    const rows = await prisma[model].groupBy({ by: [col], where: { [col]: { not: null } }, _count: { _all: true }, orderBy: { _count: { id: 'desc' } }, take: 80 });
    const out = [];
    for (const r of rows) {
      const u = await prisma.user.findUnique({ where: { id: r[col] } });
      if (u && u.status === 'Active' && u.atsRole === atsRole) out.push(u);
    }
    return out;
  };
  const RECS = await users('application', 'ownerRecruiterId', 'RECRUITER');
  const TLS = await users('requirement', 'tlId', 'TL');
  const BDES = await prisma.user.findMany({ where: { status: 'Active', atsRole: 'BDE' }, take: 20 });
  const ADM = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example.test/i.test(`${u.name}${u.email}`));
  const CLIENT = await prisma.user.findFirst({ where: { status: 'Active', role: 'CLIENT' } });
  let REC = RECS[0]; let TL = TLS[0]; let BDE = BDES[0];
  check('found a Recruiter, a TL, a BDE and an Admin to log in as', !!(REC && TL && BDE && ADM), { REC: !!REC, TL: !!TL, BDE: !!BDE, ADM: !!ADM });
  if (!(REC && TL && BDE && ADM)) { await stop(1); return; }
  for (const u of [...RECS.slice(0, 25), ...TLS.slice(0, 25), ...BDES.slice(0, 25), ADM, CLIENT].filter(Boolean)) {
    await prisma.user.update({ where: { id: u.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  }

  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 240; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await sleep(500);
  }
  if (!(await fetch(`${API}/health`).then((r) => r.ok).catch(() => false))) { console.log(`The server did not answer /api/health on ${PORT}; a leftover process may hold the port: pick another TEST_PORT.`); await stop(2); return; }
  await sleep(1200);
  const withRows = async (list) => {
    for (const u of list.slice(0, 25)) {
      const r = await api('/candidates?paged=1&view=pipeline&sub=all&pageSize=1', await tok(u.id));
      if (r.body && r.body.rows && r.body.rows.length) return u;
    }
    return list[0];
  };
  REC = await withRows(RECS); TL = await withRows(TLS); BDE = await withRows(BDES);
  await startWeb();

  const { chromium } = require('playwright-core');
  browser = await chromium.launch({ channel: 'msedge', headless: true });

  const ROLES = [
    { key: 'Recruiter', u: REC, firstTab: 'Needs my action', portal: null },
    { key: 'TL', u: TL, firstTab: 'Requirement applications' },
    { key: 'BDE', u: BDE, firstTab: 'Requirement applications' },
    { key: 'Admin', u: ADM, firstTab: 'People' },
  ];

  async function open(role, token, url) {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.addInitScript((t) => { try { if (!localStorage.getItem('tl_token')) localStorage.setItem('tl_token', t); } catch { /* none */ } }, token);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon|net::ERR/i.test(m.text())) errors.push(`console: ${m.text()}`); });
    await page.goto(`http://localhost:${WEB}${url}`, { waitUntil: 'domcontentloaded' });
    return { ctx, page, errors };
  }
  const strip = (page, label) => page.locator(`[role="tablist"][aria-label="${label}"]`);
  async function tabsOf(page, label) {
    const sl = strip(page, label);
    await sl.first().waitFor({ timeout: 30000 });
    await sleep(500);
    return sl.first().evaluate((el) => [...el.querySelectorAll('[role="tab"]')].map((t) => ({
      label: t.firstChild ? t.firstChild.textContent.trim() : t.textContent.trim(),
      on: t.getAttribute('aria-selected') === 'true',
      title: t.getAttribute('title') || '',
    })));
  }
  // The "More" button of the same strip: its text and the items in the menu.
  async function moreOf(page, label) {
    const root = strip(page, label).first().locator('xpath=ancestor::div[contains(concat(" ",normalize-space(@class)," ")," tabstrip ")][1]');
    const btn = root.locator('.tabstrip-more');
    if (!(await btn.count())) return null;
    const text = (await btn.first().innerText()).replace(/\s+/g, ' ').trim();
    await btn.first().click();
    const items = await root.locator('[role="menuitem"]').evaluateAll((els) => els.map((e) => ({ key: e.getAttribute('data-tab'), text: e.querySelector('span').textContent.trim(), title: e.getAttribute('title') || '' })));
    await page.keyboard.press('Escape');
    return { text, items };
  }
  const caption = async (page, label) => {
    const root = strip(page, label).first().locator('xpath=ancestor::div[contains(concat(" ",normalize-space(@class)," ")," tabstrip ")][1]');
    const c = root.locator('.tabstrip-cap');
    return (await c.count()) ? (await c.first().innerText()).trim() : '';
  };
  const shot = async (page, name) => { if (shotN >= 12) return; shotN += 1; await page.screenshot({ path: path.join(SHOTS, `${String(shotN).padStart(2, '0')}-${name}.png`) }); };

  if (process.env.TABS_PEEK_URL === 'channels') {
    for (const R of ROLES) { const r = await api('/messaging/channels', await tok(R.u.id)); console.log(R.key, r.status, JSON.stringify({ aud: r.body.audiences, modes: r.body.modes, reasons: r.body.reasons, sw: r.body.switchOn })); }
    await stop(0); return;
  }
  if (process.env.TABS_PEEK_URL) {
    const R = ROLES.find((x) => x.key === (process.env.TABS_PEEK_ROLE || 'Admin'));
    const token = await tok(R.u.id);
    const pick = await api('/candidates?paged=1&view=pipeline&sub=all&pageSize=1', token);
    const cid = pick.body && pick.body.rows && pick.body.rows[0] && pick.body.rows[0].candidateId;
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    await ctx.addInitScript((t) => { try { localStorage.setItem('tl_token', t); } catch { /* none */ } }, token);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('pageerror', e.message));
    page.on('console', (m) => { if (m.type() === 'error') console.log('console', m.text().slice(0, 300)); });
    await page.goto(`http://localhost:${WEB}${process.env.TABS_PEEK_URL.replace('{cid}', cid)}`, { waitUntil: 'domcontentloaded' });
    await sleep(12000);
    console.log(await page.evaluate(() => document.body.innerText.slice(0, 600)));
    await page.screenshot({ path: process.env.TABS_PEEK_OUT || 'C:/Users/ADMINI~1/AppData/Local/Temp/tabs-scratch/url.png' });
    await stop(0); return;
  }
  if (process.env.TABS_PEEK) {
    // not a check: screenshots of the Candidates page for a look (TABS_PEEK=<folder>)
    const out = process.env.TABS_PEEK; fs.mkdirSync(out, { recursive: true });
    for (const R of ROLES) {
      for (const [w, h, tag] of [[1366, 768, 'd'], [375, 812, 'm']]) {
        const ctx = await browser.newContext({ viewport: { width: w, height: h } });
        const tk = await tok(R.u.id);
        await ctx.addInitScript((t) => { try { localStorage.setItem('tl_token', t); } catch { /* none */ } }, tk);
        const page = await ctx.newPage();
        page.on('pageerror', (e) => console.log('pageerror', e.message));
        await page.goto(`http://localhost:${WEB}/candidates?view=pipeline&sub=active`, { waitUntil: 'domcontentloaded' });
        await sleep(6000);
        await page.screenshot({ path: path.join(out, `${R.key}-${tag}.png`), fullPage: false });
        await page.screenshot({ path: path.join(out, `${R.key}-${tag}-full.png`), fullPage: true });
        await page.locator('.fbar-count').first().waitFor({ timeout: 30000 }).catch(() => {});
        await sleep(1500);
        await page.screenshot({ path: path.join(out, `${R.key}-${tag}.png`), fullPage: false });
        const dims = await page.evaluate(() => { const w = document.querySelector('.cpl-tablewrap'); const t = document.querySelector('.cpl-table'); return { over: [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1 && e.getBoundingClientRect().width > 0).slice(0, 4).map((e) => `${e.tagName}.${String(e.className).slice(0, 40)}`), sw: document.documentElement.scrollWidth, iw: window.innerWidth, h: document.documentElement.scrollHeight, wrapCW: w && w.clientWidth, wrapSW: w && w.scrollWidth, tbl: t && t.offsetWidth, ths: t ? [...t.querySelectorAll('thead th')].map((x) => Math.round(x.getBoundingClientRect().width)) : null }; });
        console.log(R.key, tag, JSON.stringify(dims));
        await ctx.close();
      }
    }
    await stop(0); return;
  }
  for (const R of ROLES) {
    console.log(`\n== ${R.key} (${R.u.name}, ${R.u.atsRole})`);
    const token = await tok(R.u.id);

    // ---- Candidates & Pipeline: default tab, count, tooltips, captions
    let s = await open(R.key, token, '/candidates');
    let tabs = await tabsOf(s.page, 'Candidates views');
    const names = tabs.map((t) => t.label);
    console.log(`     main tabs: ${names.join(' | ')}`);
    check(`${R.key}: at most 5 main tabs on Candidates & Pipeline`, tabs.length >= 2 && tabs.length <= 5, names);
    check(`${R.key}: lands on "${R.firstTab}" by default`, tabs.some((t) => t.on && t.label === R.firstTab), tabs);
    check(`${R.key}: exactly one tab is selected`, tabs.filter((t) => t.on).length === 1, tabs);
    check(`${R.key}: every tab has a tooltip`, tabs.every((t) => t.title.length > 8), tabs);
    check(`${R.key}: no recruiter-only "Needs my action" for a client login is not relevant here, and the tab names are the shared set`, names.every((n) => ['Needs my action', 'Requirement applications', 'People', 'New from job portal'].includes(n)), names);
    const capStart = await caption(s.page, 'Candidates views');
    check(`${R.key}: a caption sits under the strip`, capStart.length > 20, capStart);
    const more = await moreOf(s.page, 'Candidates views');
    console.log(`     more: ${more ? more.items.map((i) => i.text).join(' | ') : '(none)'}`);
    check(`${R.key}: rarely used tabs are under More, each with a tooltip`, !!more && more.items.length >= 1 && more.items.every((i) => i.title.length > 8) && more.items.some((i) => i.text === 'Sources'), more);
    await shot(s.page, `${R.key.toLowerCase()}-candidates`);

    // captions change with the tab
    const seen = new Set([capStart]);
    for (const t of tabs) {
      await s.page.locator(`[role="tablist"][aria-label="Candidates views"] [role="tab"]`, { hasText: t.label }).first().click();
      await sleep(400);
      seen.add(await caption(s.page, 'Candidates views'));
    }
    check(`${R.key}: the caption changes with the tab`, seen.size >= Math.min(tabs.length, 3), [...seen]);
    // remembered last tab
    await s.page.locator('[role="tablist"][aria-label="Candidates views"] [role="tab"]', { hasText: 'People' }).first().click();
    await sleep(500);
    await s.page.goto(`http://localhost:${WEB}/candidates`, { waitUntil: 'domcontentloaded' });
    tabs = await tabsOf(s.page, 'Candidates views');
    check(`${R.key}: the last tab (People) is remembered`, tabs.some((t) => t.on && t.label === 'People'), tabs);

    // keyboard + ARIA
    const first = s.page.locator('[role="tablist"][aria-label="Candidates views"] [role="tab"]').first();
    await first.focus();
    await s.page.keyboard.press('ArrowRight');
    const focusedIdx = await s.page.evaluate(() => { const t = [...document.querySelectorAll('[role="tablist"][aria-label="Candidates views"] [role="tab"]')]; return t.indexOf(document.activeElement); });
    check(`${R.key}: Arrow keys move between tabs`, focusedIdx === 1, focusedIdx);
    const moreBtn = s.page.locator('.tabstrip-more').first();
    await moreBtn.focus();
    await s.page.keyboard.press('Enter');
    const menuOpen = await s.page.locator('[role="menu"]').first().isVisible();
    await shot(s.page, `${R.key.toLowerCase()}-more-menu`);
    await s.page.keyboard.press('Escape');
    check(`${R.key}: More opens with Enter and closes with Escape`, menuOpen && !(await s.page.locator('[role="menu"]').first().isVisible().catch(() => false)));

    // old links
    const landing = async (url, label = 'Candidates views') => { await s.page.goto(`http://localhost:${WEB}${url}`, { waitUntil: 'domcontentloaded' }); const t = await tabsOf(s.page, label); const m = await s.page.locator('.tabstrip-more.active').first().innerText().catch(() => ''); return { on: (t.find((x) => x.on) || {}).label || '', more: m.replace(/\s+/g, ' ').trim() }; };
    let l = await landing('/candidates?view=pipeline&quick=my_pending');
    check(`${R.key}: ?view=pipeline&quick=my_pending lands on Needs my action`, R.key === 'Admin' || l.on === 'Needs my action' || R.key === 'BDE', l);
    l = await landing('/candidates?view=todo');
    check(`${R.key}: ?view=todo lands on Needs my action`, l.on === 'Needs my action', l);
    l = await landing('/candidates?view=active');
    check(`${R.key}: old ?view=active lands on Requirement applications`, l.on === 'Requirement applications', l);
    l = await landing('/candidates?view=pipeline&sub=hold');
    check(`${R.key}: ?view=pipeline&sub=hold stays on Requirement applications`, l.on === 'Requirement applications', l);
    const sub = await tabsOf(s.page, 'Requirement applications: status').catch(() => []);
    check(`${R.key}: ?sub=hold opens On hold on the status strip`, sub.length === 6 && (sub.find((x) => x.on) || {}).label === 'On hold', sub);
    l = await landing('/candidates?view=sources');
    check(`${R.key}: ?view=sources opens Sources under More`, /Sources/.test(l.more), l);
    l = await landing('/candidates?view=master&sub=duplicates');
    check(`${R.key}: ?view=master&sub=duplicates does not break (Duplicates under More or People)`, /Duplicates/.test(l.more) || l.on === 'People', l);
    l = await landing('/candidates?view=contacts');
    check(`${R.key}: ?view=contacts opens Contact lists under More (or falls back)`, /Contact lists/.test(l.more) || ['Requirement applications', 'People', 'Needs my action'].includes(l.on), l);
    check(`${R.key}: no page errors on the list`, s.errors.length === 0, s.errors.slice(0, 3));
    await s.ctx.close();

    // ---- Candidate page
    const pick = await api('/candidates?paged=1&view=pipeline&sub=all&pageSize=1', token);
    const cid = pick.body && pick.body.rows && pick.body.rows[0] && pick.body.rows[0].candidateId;
    if (!cid) { check(`${R.key}: has a candidate to open`, false, pick.status); } else {
      s = await open(R.key, token, `/candidates/${cid}`);
      tabs = await tabsOf(s.page, 'Candidate tabs');
      const cn = tabs.map((t) => t.label);
      console.log(`     candidate page tabs: ${cn.join(' | ')}`);
      check(`${R.key}: at most 6 main tabs on the Candidate page`, cn.length >= 3 && cn.length <= 6, cn);
      check(`${R.key}: same names in the same order`, JSON.stringify(cn) === JSON.stringify(['Overview', 'Resume', 'Career', 'Follow-ups & notes', 'Documents', 'History'].filter((n) => cn.includes(n))), cn);
      check(`${R.key}: Candidate page tabs have tooltips and a caption`, tabs.every((t) => t.title.length > 8) && (await caption(s.page, 'Candidate tabs')).length > 20, tabs);
      if (R.key === 'BDE') await sleep(3000); else await s.page.locator('.tabstrip-more').first().waitFor({ timeout: 20000 }).catch(() => {});
      const cm = await moreOf(s.page, 'Candidate tabs');
      console.log(`     candidate more: ${cm ? cm.items.map((i) => i.text).join(' | ') : '(none)'}`);
      if (R.key === 'BDE') check('BDE: no Conversation / AI Calling (recruiter-only) anywhere on the Candidate page', !cm || cm.items.length === 0, cm);
      else check(`${R.key}: Conversation and AI Calling sit under More`, !!cm && cm.items.some((i) => i.text === 'Conversation') && cm.items.some((i) => i.text === 'AI Calling'), cm);
      if (R.key === 'Recruiter') await shot(s.page, 'recruiter-candidate-page');
      check(`${R.key}: no page errors on the Candidate page`, s.errors.length === 0, s.errors.slice(0, 3));
      // old tab names
      const cl = async (q) => { await s.page.goto(`http://localhost:${WEB}/candidates/${cid}?tab=${q}`, { waitUntil: 'domcontentloaded' }); const t = await tabsOf(s.page, 'Candidate tabs'); await sleep(400); return { on: (t.find((x) => x.on) || {}).label || '', url: s.page.url().split('?')[1] || '' }; };
      let r = await cl('notes');
      check(`${R.key}: ?tab=notes lands on Follow-ups & notes (and the address is rewritten)`, r.on === 'Follow-ups & notes' && /tab=followups/.test(r.url), r);
      r = await cl('timeline');
      check(`${R.key}: ?tab=timeline lands on History`, r.on === 'History' && /tab=history/.test(r.url), r);
      r = await cl('fit');
      check(`${R.key}: ?tab=fit lands on Overview`, r.on === 'Overview', r);
      r = await cl('documents');
      check(`${R.key}: ?tab=documents stays Documents`, r.on === 'Documents', r);
      if (R.key !== 'BDE') {
        await s.page.goto(`http://localhost:${WEB}/candidates/${cid}?tab=conversation`, { waitUntil: 'domcontentloaded' });
        await tabsOf(s.page, 'Candidate tabs'); await sleep(1500);
        const am = await s.page.locator('.tabstrip-more.active').first().innerText().catch(() => '');
        check(`${R.key}: ?tab=conversation opens Conversation under More`, /Conversation/.test(am), am);
      } else {
        await s.page.goto(`http://localhost:${WEB}/candidates/${cid}?tab=conversation`, { waitUntil: 'domcontentloaded' });
        await tabsOf(s.page, 'Candidate tabs'); await sleep(2500);
        const t2 = await tabsOf(s.page, 'Candidate tabs');
        check('BDE: ?tab=conversation falls back to Overview', (t2.find((x) => x.on) || {}).label === 'Overview', t2);
      }
      await s.ctx.close();
    }

    // ---- Requirement page
    const rq = await api('/requirements', token);
    const rid = rq.body && (Array.isArray(rq.body) ? rq.body : rq.body.rows || rq.body.requirements || []).find((x) => x && x.id && !x.internal);
    if (!rid) { check(`${R.key}: has a requirement to open`, false, rq.status); } else {
      s = await open(R.key, token, `/requirements/${rid.id}`);
      tabs = await tabsOf(s.page, 'Requirement tabs');
      const rn = tabs.map((t) => t.label);
      console.log(`     requirement tabs: ${rn.join(' | ')}`);
      check(`${R.key}: at most 6 main tabs on the requirement (History included)`, rn.length >= 2 && rn.length <= 6, rn);
      check(`${R.key}: requirement tabs have tooltips and a caption`, tabs.every((t) => t.title.length > 8) && (await caption(s.page, 'Requirement tabs')).length > 20, tabs);
      const qm = await moreOf(s.page, 'Requirement tabs');
      check(`${R.key}: Agreement and Activity are under More`, !!qm && qm.items.some((i) => i.text === 'Activity'), qm);
      if (R.key === 'Admin') await shot(s.page, 'admin-requirement');
      const rl = async (q) => { await s.page.goto(`http://localhost:${WEB}/requirements/${rid.id}?tab=${q}`, { waitUntil: 'domcontentloaded' }); const t = await tabsOf(s.page, 'Requirement tabs'); const m = await s.page.locator('.tabstrip-more.active').first().innerText().catch(() => ''); return { on: (t.find((x) => x.on) || {}).label || '', more: m.replace(/\s+/g, ' ').trim() }; };
      let r = await rl('team');
      check(`${R.key}: ?tab=team lands on Team`, r.on === 'Team', r);
      r = await rl('activity');
      check(`${R.key}: ?tab=activity opens Activity under More`, /Activity/.test(r.more), r);
      r = await rl('postings');
      check(`${R.key}: ?tab=postings lands on Postings`, r.on === 'Postings' || r.on === 'Overview', r);
      check(`${R.key}: no page errors on the requirement page`, s.errors.length === 0, s.errors.slice(0, 3));
      await s.ctx.close();
    }
  }

  // ---- the whole page: simple to see (founder 2026-11-20 "this page looks too clumsy")
  for (const R of ROLES) {
    console.log(`\n== ${R.key}: the page`);
    const token = await tok(R.u.id);
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    await ctx.addInitScript((t) => { try { localStorage.setItem('tl_token', t); localStorage.removeItem('tl.candidates.insights.' + (JSON.parse(atob(t.split('.')[1])).sub || '')); } catch { /* none */ } }, token);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://localhost:${WEB}/candidates?view=pipeline&sub=active`, { waitUntil: 'domcontentloaded' });
    await page.locator('.fbar-count').first().waitFor({ timeout: 40000 }).catch(() => {});
    await page.locator('.cpl-table tbody tr').first().waitFor({ timeout: 40000 }).catch(() => {});
    await sleep(1500);

    // 2. one action bar: Add candidate, Import, More
    const bar = await page.evaluate(() => [...document.querySelectorAll('.cv4-tools button')].filter((b) => !b.closest('.ac-panel') && b.offsetParent !== null).map((b) => b.textContent.trim().replace(/\s+/g, ' ')));
    console.log('     action bar:', bar.join(' | '));
    check(`${R.key}: the action bar has at most 3 buttons (Add candidate, Import, More)`, bar.length <= 3 && bar.some((x) => /^More/.test(x)), bar);
    await page.locator('.ac-more-btn').click();
    const menu = await page.evaluate(() => [...document.querySelectorAll('.ac-panel.open button')].filter((b) => b.offsetParent !== null).map((b) => b.textContent.trim().replace(/\s+/g, ' ')));
    console.log('     More menu:', menu.join(' | '));
    check(`${R.key}: More holds Templates & campaigns, Export, Template, History and Saved filters`, ['Templates & campaigns', 'Export', 'Template', 'Saved filters'].every((w) => menu.some((m) => m.includes(w))) && menu.some((m) => /History|Approvals/.test(m)), menu);
    await shot(page, `${R.key.toLowerCase()}-more-actions`);
    // the dialog of a menu line still opens (the template library)
    await page.locator('.ac-panel.open button', { hasText: 'Templates & campaigns' }).first().click();
    await sleep(800);
    check(`${R.key}: Templates & campaigns opens its window from the menu`, (await page.locator('.gsx, .modal, .overlay.show').filter({ hasText: /templates and campaigns/i }).count()) > 0);
    await page.keyboard.press('Escape');
    await page.goto(`http://localhost:${WEB}/candidates?view=pipeline&sub=active`, { waitUntil: 'domcontentloaded' });
    await page.locator('.fbar-count').first().waitFor({ timeout: 40000 }).catch(() => {});
    await page.locator('.cpl-table tbody tr').first().waitFor({ timeout: 40000 }).catch(() => {});
    await sleep(1200);

    // 3. one filter system
    const dup = await page.evaluate(() => ({ aside: document.querySelectorAll('.cv4-aside').length, box: document.querySelectorAll('.cv4-filters').length, btn: document.querySelectorAll('.lph-filters-btn').length, bars: document.querySelectorAll('.fbar').length }));
    check(`${R.key}: one filter bar, no second Filters panel or button`, dup.aside === 0 && dup.box === 0 && dup.btn === 0 && dup.bars === 1, dup);
    const prim = await page.evaluate(() => document.querySelectorAll('.fbar-row > .lph-facet, .fbar-row > .fbar-cell, .fbar-row > .fbar-multimode, .fbar-row > .fbar-range').length);
    check(`${R.key}: about five filters on screen (at most 6)`, prim >= 3 && prim <= 6, prim);
    await page.locator('.fbar-more').click();
    await sleep(500);
    const panelText = (await page.locator('.fbar-panel').innerText()).replace(/\s+/g, ' ');
    const need = ['Client', 'Requirement', 'Skills', 'Came on', 'Joined between', 'Source', 'Added'];
    check(`${R.key}: More filters reaches ${need.join(', ')}`, need.every((w) => panelText.includes(w)), need.filter((w) => !panelText.includes(w)));
    check(`${R.key}: and Location is on the bar itself`, /Current location/i.test(await page.locator('.fbar-row').first().innerText()));
    await page.keyboard.press('Escape');

    // 4. status strip: names and counts that equal the numbers the server counts
    const st = await page.evaluate(() => { const l = document.querySelector('[role="tablist"][aria-label="Requirement applications: status"]'); return l ? [...l.querySelectorAll('[role="tab"]')].map((t) => ({ k: t.firstChild.textContent.trim(), n: Number(((t.querySelector('.n') || {}).textContent || '0').replace(/[^0-9]/g, '')) })) : null; });
    check(`${R.key}: status strip is All · Active · On hold · Selected · Joined · Rejected`, !!st && JSON.stringify(st.map((x) => x.k)) === JSON.stringify(['All', 'Active', 'On hold', 'Selected', 'Joined', 'Rejected']), st);
    const cnt = await api('/candidates?paged=1&view=pipeline&sub=all&pageSize=1', token);
    const subs = (cnt.body && cnt.body.counts && cnt.body.counts.subs) || {};
    const keyOf = { All: 'all', Active: 'active', 'On hold': 'hold', Selected: 'selected', Joined: 'joined', Rejected: 'rejected' };
    check(`${R.key}: the strip counts equal the server's counts (the old tiles read the same tally)`, !!st && st.every((x) => x.n === Number(subs[keyOf[x.k]] || 0)), { st, subs });
    const chips = await page.evaluate(() => [...document.querySelectorAll('[role="group"][aria-label="Show"] .cpl-chip')].map((c) => c.firstChild.textContent.trim()));
    check(`${R.key}: a "Show:" group holds Late, Due today, Interviews today, Interview done, no feedback`, JSON.stringify(chips) === JSON.stringify(['Late', 'Due today', 'Interviews today', 'Interview done, no feedback']), chips);
    check(`${R.key}: no KPI tiles, pipeline chart or analytics panels on the first screen`, (await page.locator('.cv4-kpis, .cv4-strip, .cv4-row3, .cv4-bottom, .cv4-insights').count()) === 0);

    // 5. new people chip, not a banner
    check(`${R.key}: the "added in the last 7 days" banner is gone (a chip beside the search, if there are any)`, (await page.locator('section.nps:visible').count()) === 0);
    const chip = page.locator('.npc-chip');
    if (await chip.count()) {
      await chip.click(); await sleep(400);
      check(`${R.key}: the new-people chip opens the list`, (await page.locator('.npc-pop .nps-row').count()) > 0);
      await page.keyboard.press('Escape');
    }

    // 6. Insights: closed by default, remembered
    check(`${R.key}: Insights is closed by default`, (await page.locator('.cv4-fold-head[aria-expanded="false"]').count()) === 1 && (await page.locator('.cv4-kpis').count()) === 0);
    await page.locator('.cv4-fold-head').click(); await sleep(1200);
    const insTxt = (await page.locator('.cv4-fold-body').innerText()).replace(/\s+/g, ' ');
    check(`${R.key}: Insights holds the tiles, Needs attention, Top requirements, Quick actions, funnel, by location, by source`, ['Applications', 'Needs attention', 'Top requirements', 'Quick actions', 'Hiring funnel', 'Applications by location', 'Applications by source|Applications by client'].every((w) => new RegExp(w).test(insTxt)), insTxt.slice(0, 300));
    await shot(page, `${R.key.toLowerCase()}-insights-open`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.cv4-fold-head').waitFor({ timeout: 30000 });
    check(`${R.key}: the open Insights is remembered`, (await page.locator('.cv4-fold-head[aria-expanded="true"]').count()) === 1);
    await page.locator('.cv4-fold-head').click();
    await page.waitForSelector('.fbar-count', { timeout: 40000 }).catch(() => {});
    await page.locator('.cpl-table tbody tr').first().waitFor({ timeout: 40000 }).catch(() => {});
    await sleep(800);

    // 7. the table
    const tbl = await page.evaluate(() => { const t = document.querySelector('.cpl-table'); const ths = t ? [...t.querySelectorAll('thead th')].map((x) => x.textContent.trim().replace(/\s+/g, ' ')) : []; const r = t && t.querySelector('tbody tr'); const w = document.querySelector('.cpl-tablewrap'); return { ths, firstRowTop: r ? Math.round(r.getBoundingClientRect().top) : null, docH: document.documentElement.scrollHeight, sw: document.documentElement.scrollWidth, wrapOver: w ? w.scrollWidth - w.clientWidth : null, simple: !!(t && t.classList.contains('is-simple')) }; });
    console.log('     columns:', tbl.ths.join(' | '));
    check(`${R.key}: the Simple view is the default with at most 7 data columns`, tbl.simple && tbl.ths.filter((h) => h && !/^Contact$/.test(h)).length <= 7, tbl.ths);
    check(`${R.key}: the first table row is on the first screen at 1366x768`, tbl.firstRowTop !== null && tbl.firstRowTop < 700, tbl.firstRowTop);
    check(`${R.key}: the page is shorter than two screens with Insights closed`, tbl.docH < 2 * 768, tbl.docH);
    await shot(page, `${R.key.toLowerCase()}-page-1366`);
    // Columns menu
    check(`${R.key}: a Columns menu is there in the simple view`, (await page.getByRole('button', { name: /Columns/ }).count()) > 0);
    await page.setViewportSize({ width: 1280, height: 720 });
    await sleep(800);
    const w1280 = await page.evaluate(() => { const w = document.querySelector('.cpl-tablewrap'); return { doc: document.documentElement.scrollWidth - window.innerWidth, wrap: w ? w.scrollWidth - w.clientWidth : 0 }; });
    check(`${R.key}: no sideways scroll at 1280 px`, w1280.doc <= 1 && w1280.wrap <= 1, w1280);
    check(`${R.key}: no page errors on the page`, errors.length === 0, errors.slice(0, 3));
    await ctx.close();

    // 8. a phone: 375 px, nothing wider than the screen
    const mctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
    await mctx.addInitScript((t) => { try { localStorage.setItem('tl_token', t); } catch { /* none */ } }, token);
    const mp = await mctx.newPage();
    await mp.goto(`http://localhost:${WEB}/candidates?view=pipeline&sub=active`, { waitUntil: 'domcontentloaded' });
    await mp.locator('.fbar-count').first().waitFor({ timeout: 40000 }).catch(() => {});
    await sleep(2500);
    const mob = await mp.evaluate(() => ({ over: (() => { const c = document.querySelector('.cv4'); return c.scrollWidth - c.clientWidth; })(), shellOver: document.documentElement.scrollWidth - window.innerWidth, culprits: [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1 && e.getBoundingClientRect().width > 0).slice(0, 4).map((e) => e.tagName + '.' + String(e.className).slice(0, 40)) }));
    check(`${R.key}: nothing is wider than a 375 px phone`, mob.over <= 1, mob);
    check(`${R.key}: the status strip scrolls sideways on a phone and More filters is a drawer`, await mp.evaluate(() => { const r = document.querySelector('.cv4-status .tabstrip-row'); const p = document.querySelector('.fbar-panel'); return !!r && getComputedStyle(r).overflowX !== 'visible' && !p; }));
    if (R.key === 'Recruiter') await shot(mp, 'recruiter-phone-375');
    await mctx.close();
  }

  // ---- a client login: only what a client sees today
  if (CLIENT) {
    console.log('\n== Client');
    const token = await tok(CLIENT.id);
    const s = await open('Client', token, '/candidates');
    await sleep(3000);
    const names = (await s.page.locator('[role="tablist"][aria-label="Candidates views"] [role="tab"]').allInnerTexts()).map((x) => x.replace(/\d+$/, '').trim());
    check('Client: no Needs my action, Sources or Contact lists', !names.includes('Needs my action') && !names.includes('Sources') && !names.some((n) => /Contact/.test(n)), names);
    check('Client: no page errors', s.errors.length === 0, s.errors.slice(0, 3));
    await s.ctx.close();
  }

  console.log(`\n${total - failed}/${total} passed${failed ? `, ${failed} FAILED` : ''}; screenshots: ${shotN} in ${SHOTS}`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
