#!/usr/bin/env node
/**
 * TABS CLEAN-UP + THE SIMPLE CANDIDATES PAGE, in a real browser (founder 2026-11-20: "give clear tabs", and on the Candidates &
 * Pipeline page "this page is too clumsy, make it simple to see"). SANDBOX ONLY: a private backend on a COPY of the sandbox database,
 * the BUILT frontend through `vite preview` (API_PROXY to that backend) and the machine's Edge through playwright-core.
 *   cd frontend && npx vite build        (first)
 *   TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4531 node scripts/tabs-clean-browser.js
 * Screenshots only (no checks), into docs/tabs-clean-2026-11-20/:
 *   TABS_SHOTS=before TABS_DIST=<a build of origin/main> ... node scripts/tabs-clean-browser.js      -> before-*.png
 *   TABS_SHOTS=after ... node scripts/tabs-clean-browser.js                                         -> after-*.png
 * Checks, for a Recruiter, a TL, a BDE and a Super Admin (and a client login):
 *   - every ATS tab strip shows at most 5 main tabs, each with a tooltip, a caption line under it, and "More" opens / picks a tab
 *   - old links (?view= ?sub= ?tab=) open the right tab (also when that tab is under More)
 *   - Candidates & Pipeline: one action bar, one status strip with Show chips, one filter bar (checkbox filters, kept in the address),
 *     Insights closed, Simple view (default) with at most 7 columns and a Full view with every column
 *   - at 375 px nothing is wider than the screen; no page errors
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const FRONT = path.resolve(BACK, '..', 'frontend');
const DIST = process.env.TABS_DIST ? path.resolve(process.env.TABS_DIST) : path.join(FRONT, 'dist');
const SHOTS = path.resolve(BACK, '..', 'docs', 'tabs-clean-2026-11-20');
const PHASE = process.env.TABS_SHOTS || ''; // '' = checks; 'before' / 'after' = screenshots only
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-tabsb-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT || 4531);
const WEB = Number(process.env.TEST_WEB_PORT || PORT + 1000);
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'tabs-browser', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 700)}` : ''}`); } };
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

  // ---- who: logins of each kind that hold work (the busiest first)
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
  const BDES = await prisma.user.findMany({ where: { status: 'Active', atsRole: 'BDE' }, take: 20 });
  const ADM = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example.test/i.test(`${u.name}${u.email}`));
  const CLIENT = await prisma.user.findFirst({ where: { status: 'Active', role: 'CLIENT' } });
  for (const u of [...RECS.slice(0, 25), ...TLS.slice(0, 25), ...BDES.slice(0, 25), ADM, CLIENT].filter(Boolean)) {
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
      const r = await api('/candidates?paged=1&view=pipeline&sub=all&pageSize=1', await tok(u.id)); // eslint-disable-line no-await-in-loop
      if (r.body && r.body.rows && r.body.rows.length) return u;
    }
    return list[0];
  };
  const REC = await withRows(RECS); const TL = await withRows(TLS); const BDE = await withRows(BDES);
  check('found a Recruiter, a TL, a BDE and a Super Admin to log in as', !!(REC && TL && BDE && ADM), { REC: !!REC, TL: !!TL, BDE: !!BDE, ADM: !!ADM });
  if (!(REC && TL && BDE && ADM)) { await stop(1); return; }

  const { chromium } = require('playwright-core');
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const W = `http://localhost:${WEB}`;
  async function open(token, url, viewport = { width: 1366, height: 768 }) {
    const ctx = await browser.newContext({ viewport });
    ctx.setDefaultTimeout(60000); ctx.setDefaultNavigationTimeout(120000); // a busy machine answers slowly
    await ctx.addInitScript((t) => { try { if (!localStorage.getItem('tl_token')) localStorage.setItem('tl_token', t); } catch { /* none */ } }, token);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon|net::ERR|status of 4\d\d/i.test(m.text())) errors.push(`console: ${m.text().slice(0, 200)}`); });
    await page.goto(W + url, { waitUntil: 'domcontentloaded' });
    return { ctx, page, errors };
  }
  const settle = async (page) => {
    await page.locator('.fbar-count').first().waitFor({ timeout: 60000 }).catch(() => {});
    await page.locator('.cpl-table tbody tr, .ak-empty, .empty').first().waitFor({ timeout: 60000 }).catch(() => {});
    await sleep(1200);
  };

  // ===================================================================== screenshots only
  if (PHASE) {
    for (const f of fs.readdirSync(SHOTS)) if (f.startsWith(`${PHASE}-`) && f.endsWith('.png')) fs.unlinkSync(path.join(SHOTS, f));
    for (const [key, u] of [['superadmin', ADM], ['tl', TL], ['recruiter', REC]]) {
      const token = await tok(u.id); // eslint-disable-line no-await-in-loop
      for (const [w, h, tag] of [[1366, 768, ''], [375, 812, '-phone']]) {
        const s = await open(token, '/candidates?view=pipeline&sub=active', { width: w, height: h }); // eslint-disable-line no-await-in-loop
        await settle(s.page); await sleep(2500); // eslint-disable-line no-await-in-loop
        await s.page.screenshot({ path: path.join(SHOTS, `${PHASE}-${key}-candidates${tag}.png`), fullPage: true }); // eslint-disable-line no-await-in-loop
        const dims = await s.page.evaluate(() => ({ h: document.documentElement.scrollHeight, over: document.documentElement.scrollWidth - window.innerWidth })); // eslint-disable-line no-await-in-loop
        console.log(`  shot ${PHASE}-${key}-candidates${tag}.png  page height ${dims.h}px, sideways ${dims.over}px`);
        await s.ctx.close(); // eslint-disable-line no-await-in-loop
      }
    }
    await stop(0); return;
  }

  // ===================================================================== helpers for a tab strip
  const strip = (page, label) => page.locator(`[role="tablist"][aria-label="${label}"]`).first();
  const rootOf = (page, label) => strip(page, label).locator('xpath=ancestor::div[contains(concat(" ",normalize-space(@class)," ")," tabstrip ")][1]');
  async function info(page, label) {
    await strip(page, label).waitFor({ timeout: 60000 });
    await sleep(500);
    const tabs = await strip(page, label).evaluate((el) => [...el.querySelectorAll('[role="tab"]')].map((t) => ({
      label: (t.firstChild ? t.firstChild.textContent : t.textContent).trim(), on: t.getAttribute('aria-selected') === 'true', title: t.getAttribute('title') || '',
    })));
    const root = rootOf(page, label);
    const cap = root.locator('.tabstrip-cap');
    const caption = (await cap.count()) ? (await cap.first().innerText()).trim() : '';
    const mb = root.locator('.tabstrip-more');
    const moreText = (await mb.count()) ? (await mb.first().innerText()).replace(/\s+/g, ' ').trim() : '';
    const moreOn = (await mb.count()) ? await mb.first().evaluate((b) => b.classList.contains('active')) : false;
    return { tabs, caption, moreText, moreOn, on: (tabs.find((t) => t.on) || {}).label || (moreOn ? moreText.replace(/^More:\s*/, '').replace(/\s*[▾\d]+$/, '').trim() : '') };
  }
  async function moreItems(page, label) {
    const root = rootOf(page, label);
    const btn = root.locator('.tabstrip-more');
    if (!(await btn.count())) return null;
    await btn.first().click();
    const items = await root.locator('[role="menuitem"]').evaluateAll((els) => els.map((e) => ({ key: e.getAttribute('data-tab'), text: e.querySelector('span').textContent.trim(), title: e.getAttribute('title') || '' })));
    await page.keyboard.press('Escape');
    await sleep(200);
    check('Escape closes the More menu', (await root.locator('[role="menu"]').count()) === 0);
    return items;
  }
  // the common rule for one strip: at most 5 main tabs, a tooltip on each, a caption line
  async function stripRule(who, page, label, { min = 2, needMore = false } = {}) {
    const s = await info(page, label);
    const names = s.tabs.map((t) => t.label);
    check(`${who}: "${label}" shows at most 5 main tabs (${names.join(' | ')})`, s.tabs.length >= min && s.tabs.length <= 5, names);
    check(`${who}: "${label}" every tab has a tooltip`, s.tabs.every((t) => t.title.length > 8), s.tabs);
    check(`${who}: "${label}" has a caption line under the strip`, s.caption.length > 15, s.caption);
    const more = s.moreText ? await moreItems(page, label) : null;
    if (needMore) check(`${who}: "${label}" has a More menu, each item with a tooltip`, !!more && more.length >= 1 && more.every((i) => i.title.length > 8), more);
    return { ...s, names, more };
  }
  // pick a More item; the More button then names it and the caption follows
  async function pickMore(who, page, label, text) {
    const root = rootOf(page, label);
    if (!(await root.locator('[role="menu"]').count())) await root.locator('.tabstrip-more').first().click();
    await root.locator('[role="menuitem"]', { hasText: text }).first().click();
    await sleep(1200);
    const s = await info(page, label);
    check(`${who}: "${label}" More > ${text} opens it (the More button names it, the caption follows)`, s.moreOn && s.moreText.includes(text) && s.caption.length > 15, { more: s.moreText, cap: s.caption });
    return s;
  }
  const landing = async (page, url, label) => { await page.goto(W + url, { waitUntil: 'domcontentloaded' }); return info(page, label); };

  const ROLES = [
    { key: 'Recruiter', u: REC, first: 'Needs my action' },
    { key: 'TL', u: TL, first: 'Requirement applications' },
    { key: 'BDE', u: BDE, first: 'Requirement applications' },
    { key: 'Super Admin', u: ADM, first: 'People' },
  ];

  for (const R of ROLES) {
    console.log(`\n== ${R.key}`);
    const token = await tok(R.u.id); // eslint-disable-line no-await-in-loop
    try { // one role's slip is reported, the other roles still run

    // ---------------------------------------------------------------- Candidates & Pipeline: the tab strip
    let s = await open(token, '/candidates'); // eslint-disable-line no-await-in-loop
    let st = await stripRule(R.key, s.page, 'Candidates views', { needMore: true }); // eslint-disable-line no-await-in-loop
    check(`${R.key}: lands on "${R.first}"`, st.on === R.first, st.on);
    check(`${R.key}: Sources and Duplicates (or Contact lists) wait under More`, !!st.more && st.more.some((i) => i.text === 'Sources'), st.more);
    await pickMore(R.key, s.page, 'Candidates views', 'Sources'); // eslint-disable-line no-await-in-loop
    check(`${R.key}: picking Sources writes ?view=sources`, /[?&]view=sources/.test(s.page.url()), s.page.url());
    // old links
    let l = await landing(s.page, '/candidates?view=todo', 'Candidates views'); // eslint-disable-line no-await-in-loop
    check(`${R.key}: ?view=todo opens Needs my action`, l.on === 'Needs my action', l.on);
    l = await landing(s.page, '/candidates?view=active', 'Candidates views'); // eslint-disable-line no-await-in-loop
    check(`${R.key}: old ?view=active opens Requirement applications`, l.on === 'Requirement applications', l.on);
    l = await landing(s.page, '/candidates?view=pipeline&sub=hold', 'Candidates views'); // eslint-disable-line no-await-in-loop
    const sub = await info(s.page, 'Requirement applications: status').catch(() => ({ tabs: [] })); // eslint-disable-line no-await-in-loop
    check(`${R.key}: ?sub=hold opens On hold on the status strip`, (sub.tabs.find((t) => t.on) || {}).label === 'On hold', sub.tabs);
    l = await landing(s.page, '/candidates?view=sources', 'Candidates views'); // eslint-disable-line no-await-in-loop
    check(`${R.key}: ?view=sources opens Sources (under More)`, l.moreOn && /Sources/.test(l.moreText), l);
    check(`${R.key}: no page errors on Candidates & Pipeline`, s.errors.length === 0, s.errors.slice(0, 3));
    await s.ctx.close(); // eslint-disable-line no-await-in-loop

    // ---------------------------------------------------------------- the simple page
    s = await open(token, '/candidates?view=pipeline&sub=active'); // eslint-disable-line no-await-in-loop
    await settle(s.page); // eslint-disable-line no-await-in-loop
    const p = s.page;
    const bar = await p.evaluate(() => [...document.querySelectorAll('.cv4-tools button')].filter((b) => !b.closest('.ac-panel') && b.offsetParent !== null).map((b) => b.textContent.trim().replace(/\s+/g, ' ')));
    check(`${R.key}: ONE action bar: at most 3 buttons (${bar.join(' | ')})`, bar.length <= 3 && bar.some((x) => /^More/.test(x)), bar);
    await p.locator('.ac-more-btn').click();
    const menu = await p.evaluate(() => [...document.querySelectorAll('.ac-panel.open button')].filter((b) => b.offsetParent !== null).map((b) => b.textContent.trim().replace(/\s+/g, ' ')));
    check(`${R.key}: the action More holds Export, Template, Saved filters, Templates & campaigns, History`, ['Export', 'Template', 'Saved filters', 'Templates & campaigns'].every((w) => menu.some((m) => m.includes(w))) && menu.some((m) => /History|Approvals/.test(m)), menu);
    await p.keyboard.press('Escape'); await p.locator('body').click({ position: { x: 5, y: 300 } }).catch(() => {});
    const one = await p.evaluate(() => ({ bars: document.querySelectorAll('.fbar').length, aside: document.querySelectorAll('.cv4-aside, .cv4-filters').length, oldBtn: document.querySelectorAll('.lph-filters-btn').length, status: document.querySelectorAll('[role="tablist"][aria-label="Requirement applications: status"]').length }));
    check(`${R.key}: ONE filter bar (no second Filters panel), ONE status strip`, one.bars === 1 && one.aside === 0 && one.oldBtn === 0 && one.status === 1, one);
    const showChips = await p.evaluate(() => [...document.querySelectorAll('[role="group"][aria-label="Show"] .cpl-chip')].map((c) => c.firstChild.textContent.trim()));
    check(`${R.key}: the status strip has Show chips (Late, Due today, Interviews today ...)`, showChips.includes('Late') && showChips.includes('Due today'), showChips);
    check(`${R.key}: Insights is closed by default`, (await p.locator('.cv4-fold-head[aria-expanded="false"]').count()) === 1 && (await p.locator('.cv4-kpis').count()) === 0);
    // Simple view / Full view
    const cols = async () => p.evaluate(() => { const t = document.querySelector('.cpl-table'); return { simple: !!(t && t.classList.contains('is-simple')), ths: t ? [...t.querySelectorAll('thead th')].map((x) => x.textContent.trim().replace(/[▲▼↕?]/g, '').trim()).filter((h) => h && h !== 'Contact') : [] }; });
    const simple = await cols();
    check(`${R.key}: Simple view is the default with at most 7 columns (${simple.ths.join(' | ')})`, simple.simple && simple.ths.length >= 4 && simple.ths.length <= 7, simple);
    await p.getByRole('button', { name: 'Full view' }).first().click();
    await sleep(1200);
    const full = await cols();
    check(`${R.key}: Full view shows every column of the old table (more than the simple one)`, !full.simple && full.ths.length > simple.ths.length && full.ths.some((h) => /Skills|CTC|Salary fit/.test(h)), full.ths);
    check(`${R.key}: the Columns menu is there in the Full view`, (await p.getByRole('button', { name: /Columns/ }).count()) > 0);
    await p.getByRole('button', { name: 'Simple view' }).first().click();
    await sleep(800);
    check(`${R.key}: back to the Simple view`, (await cols()).simple);
    // a checkbox filter: the rows follow and the address keeps it
    const fb = p.locator('.fbar-row .msel-btn').first();
    const fLabel = ((await fb.innerText().catch(() => '')) || '').split(':')[0].trim();
    const before = (await p.locator('.fbar-count').first().innerText().catch(() => '')).trim();
    await fb.click();
    const item = p.locator('.msel-pop .msel-item').first();
    const hasItem = await item.waitFor({ timeout: 30000 }).then(() => true).catch(() => false);
    if (hasItem) {
      const name = (await item.locator('.msel-name').innerText()).trim();
      await item.locator('input[type=checkbox]').check();
      await sleep(1800);
      await p.keyboard.press('Escape');
      const after = (await p.locator('.fbar-count').first().innerText().catch(() => '')).trim();
      const url1 = decodeURIComponent(p.url());
      check(`${R.key}: ticking "${name}" in ${fLabel} puts it in the address and a chip`, url1.includes(name) && (await p.locator('.fbar .filter-chips-chip').count()) > 0, { url1, before, after });
      await p.reload({ waitUntil: 'domcontentloaded' });
      await settle(p);
      const again = (await p.locator('.fbar-count').first().innerText().catch(() => '')).trim();
      check(`${R.key}: after a reload the filter is still on (same count, chip still there)`, again === after && (await p.locator('.fbar .filter-chips-chip').count()) > 0, { after, again });
    } else check(`${R.key}: a filter of the bar has options to tick`, false, fLabel);
    // More filters reaches the old panel's filters, as checkbox lists
    await p.locator('.fbar-more').first().click();
    await sleep(600);
    const panel = (await p.locator('.fbar-panel').innerText().catch(() => '')).replace(/\s+/g, ' ');
    check(`${R.key}: More filters holds Client, Requirement, Source, Came on, Follow-up`, ['Client', 'Requirement', 'Came on', 'Follow-up'].every((w) => panel.includes(w)), panel.slice(0, 300));
    check(`${R.key}: Follow-up and Hiring type are checkbox lists there`, (await p.locator('.fbar-panel .msel-btn', { hasText: /^Follow-up/ }).count()) > 0, panel.slice(0, 200));
    await p.keyboard.press('Escape');
    check(`${R.key}: no page errors on the simple page`, s.errors.length === 0, s.errors.slice(0, 3));
    await s.ctx.close(); // eslint-disable-line no-await-in-loop

    // ---------------------------------------------------------------- Candidate page
    const pick = await api('/candidates?paged=1&view=pipeline&sub=all&pageSize=1', token); // eslint-disable-line no-await-in-loop
    const cid = pick.body && pick.body.rows && pick.body.rows[0] && pick.body.rows[0].candidateId;
    if (!cid) check(`${R.key}: has a candidate to open`, false, pick.status);
    else {
      s = await open(token, `/candidates/${cid}`); // eslint-disable-line no-await-in-loop
      await s.page.locator('.tabstrip-more').first().waitFor({ timeout: 30000 }).catch(() => {}); // eslint-disable-line no-await-in-loop
      st = await stripRule(R.key, s.page, 'Candidate tabs', { needMore: true }); // eslint-disable-line no-await-in-loop
      check(`${R.key}: Candidate page tabs: Overview, Resume, Follow-ups & notes, Documents, History`, JSON.stringify(st.names) === JSON.stringify(['Overview', 'Resume', 'Follow-ups & notes', 'Documents', 'History']), st.names);
      const mt = (st.more || []).map((i) => i.text);
      check(`${R.key}: More holds Career and Schedule a message${R.key === 'BDE' ? '' : ', Conversation and AI Calling'}`, mt.includes('Career') && mt.includes('Schedule a message') && (R.key === 'BDE' ? !mt.includes('Conversation') : (mt.includes('Conversation') && mt.includes('AI Calling'))), mt);
      await pickMore(R.key, s.page, 'Candidate tabs', 'Career'); // eslint-disable-line no-await-in-loop
      const cl = async (q) => landing(s.page, `/candidates/${cid}?tab=${q}`, 'Candidate tabs');
      l = await cl('notes'); // eslint-disable-line no-await-in-loop
      check(`${R.key}: ?tab=notes opens Follow-ups & notes`, l.on === 'Follow-ups & notes', l.on);
      l = await cl('timeline'); // eslint-disable-line no-await-in-loop
      check(`${R.key}: ?tab=timeline opens History`, l.on === 'History', l.on);
      l = await cl('fit'); // eslint-disable-line no-await-in-loop
      check(`${R.key}: ?tab=fit opens Overview`, l.on === 'Overview', l.on);
      l = await cl('career'); await sleep(1200); l = await info(s.page, 'Candidate tabs'); // eslint-disable-line no-await-in-loop
      check(`${R.key}: ?tab=career opens Career under More`, l.moreOn && /Career/.test(l.moreText), l.moreText);
      l = await cl('scheduled'); await sleep(1200); l = await info(s.page, 'Candidate tabs'); // eslint-disable-line no-await-in-loop
      check(`${R.key}: ?tab=scheduled opens Schedule a message under More`, l.moreOn && /Schedule a message/.test(l.moreText), l.moreText);
      check(`${R.key}: no page errors on the Candidate page`, s.errors.length === 0, s.errors.slice(0, 3));
      await s.ctx.close(); // eslint-disable-line no-await-in-loop
    }

    // ---------------------------------------------------------------- Requirement page
    const rq = await api('/requirements', token); // eslint-disable-line no-await-in-loop
    const rid = rq.body && (Array.isArray(rq.body) ? rq.body : rq.body.rows || rq.body.requirements || []).find((x) => x && x.id && !x.internal);
    if (!rid) check(`${R.key}: has a requirement to open`, false, rq.status);
    else {
      s = await open(token, `/requirements/${rid.id}`); // eslint-disable-line no-await-in-loop
      st = await stripRule(R.key, s.page, 'Requirement tabs', { needMore: true }); // eslint-disable-line no-await-in-loop
      check(`${R.key}: History and Activity are under More on the requirement`, (st.more || []).some((i) => i.text === 'History') && (st.more || []).some((i) => i.text === 'Activity'), st.more);
      l = await landing(s.page, `/requirements/${rid.id}?tab=team`, 'Requirement tabs'); // eslint-disable-line no-await-in-loop
      check(`${R.key}: ?tab=team opens Team`, l.on === 'Team', l.on);
      l = await landing(s.page, `/requirements/${rid.id}?tab=history`, 'Requirement tabs'); // eslint-disable-line no-await-in-loop
      check(`${R.key}: ?tab=history (search, history links) opens History under More`, l.moreOn && /History/.test(l.moreText), l.moreText);
      l = await landing(s.page, `/requirements/${rid.id}?tab=postings`, 'Requirement tabs'); // eslint-disable-line no-await-in-loop
      check(`${R.key}: ?tab=postings opens Postings`, l.on === 'Postings' || l.on === 'Overview', l.on);
      check(`${R.key}: no page errors on the requirement page`, s.errors.length === 0, s.errors.slice(0, 3));
      await s.ctx.close(); // eslint-disable-line no-await-in-loop
    }

    // ---------------------------------------------------------------- a phone
    for (const url of ['/candidates?view=pipeline&sub=active', ...(cid ? [`/candidates/${cid}`] : []), ...(rid ? [`/requirements/${rid.id}`] : [])]) {
      const m = await open(token, url, { width: 375, height: 812 }); // eslint-disable-line no-await-in-loop
      await m.page.locator('.tabstrip').first().waitFor({ timeout: 60000 }).catch(() => {}); // eslint-disable-line no-await-in-loop
      await sleep(3500); // eslint-disable-line no-await-in-loop
      const d = await m.page.evaluate(() => { // eslint-disable-line no-await-in-loop
        const ts = document.querySelector('.tabstrip');
        const r = ts ? ts.getBoundingClientRect() : null;
        return {
          over: document.documentElement.scrollWidth - window.innerWidth,
          gutterL: r ? Math.round(r.left) : null,
          gutterR: r ? Math.round(window.innerWidth - r.right) : null,
          culprits: [...document.querySelectorAll('body *')].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.right > window.innerWidth + 1 && !e.closest('.tbl-wrap, .tabstrip-row, .cv4-status'); }).slice(0, 4).map((e) => `${e.tagName}.${String(e.className).slice(0, 40)}`),
        };
      });
      check(`${R.key}: 375 px ${url.split('?')[0]}: no sideways page scroll, 16 px gutters`, d.over <= 1 && d.gutterL >= 12 && d.gutterL <= 24, d);
      await m.ctx.close(); // eslint-disable-line no-await-in-loop
    }
    } catch (e) { check(`${R.key}: the run finished (${String(e.message).split('\n')[0].slice(0, 160)})`, false); }
  }

  // ---------------------------------------------------------------- the other ATS screens (Super Admin sees every tab)
  console.log('\n== the other ATS screens (Super Admin, then a TL and a Recruiter)');
  for (const [who, u] of [['Super Admin', ADM], ['TL', TL], ['Recruiter', REC]]) {
    const token = await tok(u.id); // eslint-disable-line no-await-in-loop
    const s = await open(token, '/requirements'); // eslint-disable-line no-await-in-loop
    try {
    const screens = [
      ['/requirements', 'Clients & Requirements'], ['/requirements', 'Requirements'],
      ['/ats/team', 'Reports & Team'], ['/ats/team', 'Section'],
      ['/ats/calendar', 'Interview Calendar'], ['/ats/offers', 'Offer step'], ['/ats/joining', 'Joining screens'],
      ['/candidates?view=job-portal', 'Job portal screening'],
    ];
    for (const [url, label] of screens) {
      await s.page.goto(W + url, { waitUntil: 'domcontentloaded' }); // eslint-disable-line no-await-in-loop
      const there = await strip(s.page, label).waitFor({ timeout: 45000 }).then(() => true).catch(() => false); // eslint-disable-line no-await-in-loop
      if (!there) { console.log(`  --  ${who}: ${url} has no "${label}" strip for this login (one tab or none)`); continue; } // eslint-disable-line no-continue
      await stripRule(`${who} ${url}`, s.page, label, { min: 1 }); // eslint-disable-line no-await-in-loop
    }
    if (who === 'Super Admin') {
      // a route tab under More (Reports & Team > More > Data quality) and back
      await s.page.goto(`${W}/ats/team`, { waitUntil: 'domcontentloaded' });
      const rt = await info(s.page, 'Reports & Team');
      if (rt.moreText) {
        const items = await moreItems(s.page, 'Reports & Team');
        const t = items && items[0];
        if (t) {
          await pickMore(who, s.page, 'Reports & Team', t.text);
          check(`${who}: the Reports & Team More item opens its own address (${t.key})`, s.page.url().includes(t.key), s.page.url());
        }
      }
      // the client page: five tabs, History under More, ?tab=history opens it
      const cl = await api('/clients?pageSize=5', token);
      const list = cl.body && (Array.isArray(cl.body) ? cl.body : cl.body.rows || cl.body.clients || []);
      const c0 = (list || []).find((x) => x && x.id);
      if (c0) {
        await s.page.goto(`${W}/clients/${c0.id}`, { waitUntil: 'domcontentloaded' });
        const cs = await stripRule(who, s.page, 'Client tabs', { needMore: true });
        check(`${who}: the client page keeps History under More`, (cs.more || []).some((i) => i.text === 'History'), cs.more);
        const h = await landing(s.page, `/clients/${c0.id}?tab=history`, 'Client tabs');
        check(`${who}: /clients/:id?tab=history opens History under More`, h.moreOn && /History/.test(h.moreText), h.moreText);
        const o = await landing(s.page, `/clients/${c0.id}?tab=contacts`, 'Client tabs');
        check(`${who}: old /clients/:id?tab=contacts opens Details & Agreement`, /^Details/.test(o.on), o.on);
      } else check(`${who}: has a client to open`, false, cl.status);
    }
    } catch (e) { check(`${who}: the other screens run finished (${String(e.message).split('\n')[0].slice(0, 160)})`, false); }
    check(`${who}: no page errors on the other ATS screens`, s.errors.length === 0, s.errors.slice(0, 3));
    await s.ctx.close(); // eslint-disable-line no-await-in-loop
  }

  // ---------------------------------------------------------------- a client login: only what a client sees today
  if (CLIENT) {
    console.log('\n== Client');
    const s = await open(await tok(CLIENT.id), '/candidates');
    await sleep(4000);
    const names = (await s.page.locator('[role="tablist"][aria-label="Candidates views"] [role="tab"]').allInnerTexts()).map((x) => x.replace(/\d+$/, '').trim());
    check('Client: no Needs my action, Sources or Contact lists', !names.includes('Needs my action') && !names.includes('Sources') && !names.some((n) => /Contact/.test(n)), names);
    check('Client: no page errors', s.errors.length === 0, s.errors.slice(0, 3));
    await s.ctx.close();
  }

  console.log(`\n${total - failed}/${total} passed${failed ? `, ${failed} FAILED` : ''}`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
