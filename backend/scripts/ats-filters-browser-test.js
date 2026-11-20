#!/usr/bin/env node
/**
 * ATS FILTERS in a REAL BROWSER (founder 2026-11-20: checkboxes in every filter). SANDBOX ONLY: a private backend on a COPY of the sandbox
 * database + the Vite dev server (API_PROXY) + Microsoft Edge through playwright-core. Ticks two options of the Candidates "Current location"
 * dropdown and of the Team page "Location" dropdown and checks that the rows change, the chip says both names and the count equals the API's.
 *   TEST_SOURCE_DB=<sandbox.db> node scripts/ats-filters-browser-test.js      (ports: BROWSER_API_PORT 4187, BROWSER_WEB_PORT 5191)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const FRONT = path.resolve(BACK, '..', 'frontend');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-fbrowser-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const API_PORT = Number(process.env.BROWSER_API_PORT || 4187);
const WEB_PORT = Number(process.env.BROWSER_WEB_PORT || 5191);
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(API_PORT), JWT_SECRET: 'fbrowser', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 500)}` : ''}`); } };
const procs = [];
async function stop(code) {
  procs.forEach((p) => { try { p.kill(); } catch { /* gone */ } });
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const waitFor = async (url, tries = 240) => { for (let i = 0; i < tries; i += 1) { if (await fetch(url).then((r) => r.ok || r.status < 500).catch(() => false)) return true; await new Promise((r) => { setTimeout(r, 500); }); } return false; };

(async () => {
  const admin = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: admin.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  procs.push(spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' }));
  procs.push(spawn(process.execPath, [path.join(FRONT, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(WEB_PORT), '--strictPort'], { cwd: FRONT, env: { ...process.env, API_PROXY: `http://localhost:${API_PORT}` }, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' }));
  check('the sandbox backend answers', await waitFor(`http://localhost:${API_PORT}/api/health`));
  check('the web app answers', await waitFor(`http://localhost:${WEB_PORT}/`));
  const token = jwt.sign({ ...tokenPayload(await resolveIdentity(admin.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const api = async (url) => { const r = await fetch(`http://localhost:${API_PORT}/api${url}`, { headers: { Authorization: `Bearer ${token}` } }); return r.json(); };
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addInitScript((t) => { try { localStorage.setItem('tl_token', t); } catch { /* none */ } }, token);
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`console: ${m.text().slice(0, 200)}`); });
  const tick = async (labelStart, n) => {
    const btn = page.locator('.msel-btn', { hasText: new RegExp(`^${labelStart}:`) }).first();
    await btn.waitFor();
    await btn.click();
    const items = page.locator('.msel-pop .msel-item');
    await items.first().waitFor();
    const got = [];
    for (let i = 0; i < n; i += 1) {
      const it = items.nth(i);
      const name = (await it.locator('.msel-name').innerText()).trim();
      const count = Number(String(await it.locator('.msel-n').innerText()).replace(/\D/g, '')) || 0;
      got.push({ name, count });
      await it.locator('input[type=checkbox]').check();
    }
    await page.waitForTimeout(1200); // the ticks apply after 300 ms
    await page.keyboard.press('Escape');
    return got;
  };
  try {
    // the Vite dev server optimises its libraries on the first visit ("504 Outdated Optimize Dep"): visit until the page draws
    for (let i = 0; i < 6; i += 1) {
      await page.goto(`http://localhost:${WEB_PORT}/candidates?view=pipeline&sub=all`).catch(() => {});
      await page.waitForTimeout(i === 0 ? 20000 : 10000);
      const drawn = await page.locator('body').innerText().then((t) => t.trim().length > 40).catch(() => false);
      if (drawn) break;
    }
    // ---- Candidates: Current location, two options
    await page.goto(`http://localhost:${WEB_PORT}/candidates?view=pipeline&sub=all`);
    const before = await page.locator('.fbar-count').first().innerText();
    const two = await tick('Current location', 2);
    const names = two.map((x) => x.name);
    await page.locator('.fbar .filter-chips-chip', { hasText: 'Current location' }).first().waitFor();
    const chip = await page.locator('.fbar .filter-chips-chip', { hasText: 'Current location' }).first().innerText();
    check('Candidates: the chip names both ticked locations', names.every((n) => chip.includes(n)), { chip, names });
    const after = await page.locator('.fbar-count').first().innerText();
    const uiN = Number(String(after).replace(/\D/g, ''));
    check('Candidates: the row count changed after ticking two locations', after !== before && uiN > 0, { before, after });
    const apiRes = await api(`/candidates?${new URLSearchParams({ paged: '1', view: 'pipeline', sub: 'all', locCur: names.join(',') })}`);
    check('Candidates: the count on screen equals the API\'s total for the two values', apiRes.total === uiN, { api: apiRes.total, ui: uiN });
    check('Candidates: the URL keeps both values', decodeURIComponent(page.url()).includes(`locCur=${names.join(',')}`), page.url());
    // clearing one option by unticking
    await page.locator('.msel-btn', { hasText: /^Current location:/ }).first().click();
    await page.locator('.msel-pop .msel-item input[type=checkbox]').first().uncheck();
    await page.waitForTimeout(1200);
    const one = Number(String(await page.locator('.fbar-count').first().innerText()).replace(/\D/g, ''));
    const apiOne = await api(`/candidates?${new URLSearchParams({ paged: '1', view: 'pipeline', sub: 'all', locCur: names[1] })}`);
    check('Candidates: unticking one option leaves the other one\'s rows', apiOne.total === one, { api: apiOne.total, ui: one });
    await page.keyboard.press('Escape');

    // ---- Team page: a filter of the shared bar, two options (HR status, or Location when the data has two places)
    await page.goto(`http://localhost:${WEB_PORT}/ats/team`);
    await page.locator('.fbar-team').first().waitFor();
    let label = null;
    for (const l of ['Location', 'HR status', 'Seat']) {
      const b = page.locator('.fbar-team .msel-btn', { hasText: new RegExp(`^${l}:`) });
      if (await b.count()) { await b.first().click(); const n = await page.locator('.msel-pop .msel-item').count(); await page.keyboard.press('Escape'); if (n >= 2) { label = l; break; } }
    }
    check('Team: the shared bar offers a filter with two or more options', !!label, label);
    if (label) {
      const rowsBefore = await page.locator('table.pw-table tbody tr').count();
      const t = await tick(label, 2);
      await page.locator('.fbar-team .filter-chips-chip', { hasText: label }).first().waitFor();
      const tc = await page.locator('.fbar-team .filter-chips-chip', { hasText: label }).first().innerText();
      check('Team: the chip names both ticked options', t.every((x) => tc.includes(x.name)), { tc, t });
      const rowsAfter = await page.locator('table.pw-table tbody tr').count();
      check('Team: the rows follow the two ticked options (no more than before, at least one)', rowsAfter >= 1 && rowsAfter <= rowsBefore, { rowsBefore, rowsAfter });
    }
    // ---- a phone: the dropdown is a sheet from the bottom
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(`http://localhost:${WEB_PORT}/candidates?view=pipeline&sub=all`);
    await page.locator('.msel-btn', { hasText: /^Current location:/ }).first().click();
    const box = await page.locator('.msel-pop').first().boundingBox();
    check('Phone: the checkbox panel is a bottom sheet across the screen', box && box.width >= 360 && box.y + box.height >= 780, box);
  } catch (e) {
    let seen = '';
    try { seen = `${page.url()} :: ${(await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 300)}`; await page.screenshot({ path: path.join(os.tmpdir(), 'ats-filters-browser-fail.png') }); } catch { /* none */ }
    check(`the browser run finished (${String(e.message).slice(0, 200)})`, false, `${seen} ## ${pageErrors.slice(0, 4).join(' | ')}`);
  }
  await browser.close().catch(() => {});
  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
