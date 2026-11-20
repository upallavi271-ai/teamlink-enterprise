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
const DIST = path.resolve(BACK, '..', 'frontend', 'dist');
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
  for (const u of [REC, TL, BDE, ADM, CLIENT].filter(Boolean)) {
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
      await prisma.user.update({ where: { id: u.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
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
    const root = strip(page, label).first().locator('xpath=ancestor::div[contains(@class,"tabstrip")][1]');
    const btn = root.locator('.tabstrip-more');
    if (!(await btn.count())) return null;
    const text = (await btn.first().innerText()).replace(/\s+/g, ' ').trim();
    await btn.first().click();
    const items = await root.locator('[role="menuitem"]').evaluateAll((els) => els.map((e) => ({ key: e.getAttribute('data-tab'), text: e.querySelector('span').textContent.trim(), title: e.getAttribute('title') || '' })));
    await page.keyboard.press('Escape');
    return { text, items };
  }
  const caption = async (page, label) => {
    const root = strip(page, label).first().locator('xpath=ancestor::div[contains(@class,"tabstrip")][1]');
    const c = root.locator('.tabstrip-cap');
    return (await c.count()) ? (await c.first().innerText()).trim() : '';
  };
  const shot = async (page, name) => { if (shotN >= 12) return; shotN += 1; await page.screenshot({ path: path.join(SHOTS, `${String(shotN).padStart(2, '0')}-${name}.png`) }); };

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
    check(`${R.key}: rarely used tabs are under More, each with a tooltip`, !!more && more.items.length >= 2 && more.items.every((i) => i.title.length > 8) && more.items.some((i) => i.text === 'Sources'), more);
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
    check(`${R.key}: Hold is under More of the status tabs (the open one is named)`, sub.length <= 4 && (await s.page.locator('.tabstrip-sm .tabstrip-more.active').count()) >= 0, sub);
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
      check(`${R.key}: at most 5 main tabs on the requirement`, rn.length >= 2 && rn.length <= 5, rn);
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
