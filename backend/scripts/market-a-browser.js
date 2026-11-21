#!/usr/bin/env node
/**
 * BROWSER SMOKE - market wave builder A (2026-11-21): the ATS dashboard insight cards and the Reports "Forecast, build & data" tabs.
 * A private sandbox server (copy of the sandbox database) + vite preview of the built frontend + Edge (headless).
 *   (cd frontend && npx vite build) then TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4xxx node scripts/market-a-browser.js
 * Screenshots: docs/market-a-2026-11-21/
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const FRONT = path.resolve(BACK, '..', 'frontend');
const SHOTS = path.resolve(BACK, '..', 'docs', 'market-a-2026-11-21');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-mkta-smoke-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT || 4571);
const WEB = PORT + 1;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'mkta-smoke', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };
const procs = [];
async function stop(code) {
  procs.forEach((p) => { try { p.kill(); } catch { /* gone */ } });
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const waitFor = async (url, tries = 240) => { for (let i = 0; i < tries; i += 1) { if (await fetch(url).then((r) => r.status < 500).catch(() => false)) return true; await new Promise((r) => { setTimeout(r, 500); }); } return false; }; // eslint-disable-line no-await-in-loop
const pick = async (where) => {
  const LL = require('../src/utils/leftLogin'); // eslint-disable-line global-require
  for (const u of await prisma.user.findMany({ where: { status: 'Active', ...where }, take: 30 })) {
    if (/zztest|example\.test/i.test(`${u.name}${u.email}`)) continue; // eslint-disable-line no-continue
    const id = await resolveIdentity(u.id); // eslint-disable-line no-await-in-loop
    if (id && !LL.hasLeft(id)) return u;
  }
  return null;
};

(async () => {
  const sa = await pick({ role: 'SUPER_ADMIN' });
  const tl = await pick({ role: 'TL', atsRole: 'TL', atsDepartment: 'Education' });
  for (const u of [sa, tl]) await prisma.user.update({ where: { id: u.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } }); // eslint-disable-line no-await-in-loop
  const be = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(be);
  if (!(await waitFor(`http://localhost:${PORT}/api/health`))) { console.log('FAIL  the sandbox server did not answer (set TEST_PORT)'); await stop(1); return; }
  const web = spawn(process.execPath, [path.join(FRONT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(WEB), '--strictPort', '--host', 'localhost'], { cwd: FRONT, env: { ...process.env, API_PROXY: `http://localhost:${PORT}` }, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(web);
  if (!(await waitFor(`http://localhost:${WEB}/`))) { console.log('FAIL  the web server did not answer'); await stop(1); return; }

  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const open = async (user, urlPath, viewport = { width: 1366, height: 900 }) => {
    const token = jwt.sign({ ...tokenPayload(await resolveIdentity(user.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
    const ctx = await browser.newContext({ viewport });
    await ctx.addInitScript((t) => { try { localStorage.setItem('tl_token', t); } catch (e) { /* none */ } }, token);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://localhost:${WEB}${urlPath}`, { waitUntil: 'commit', timeout: 120000 });
    return { ctx, page, errors };
  };
  const seen = (page, text, timeout = 90000) => page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout }).then(() => true).catch(() => false);
  try {
    // ---- the dashboard cards (admin)
    {
      const { ctx, page, errors } = await open(sa, '/ats/dashboard');
      const up = await seen(page, 'Closest to fill');
      check('dashboard: Closest to fill card', up, (await page.evaluate(() => document.body.innerText.slice(0, 400)).catch(() => '')));
      check('dashboard: Time to fill, Pipeline forecast, Leaderboard, Plan my day and Ask for a chart cards', (await seen(page, 'Pipeline forecast', 20000)) && (await seen(page, 'Leaderboard', 5000)) && (await seen(page, 'Plan my day', 5000)) && (await seen(page, 'Ask for a chart', 5000)) && (await seen(page, 'usual days to fill', 5000)));
      await page.locator('button', { hasText: /^Plan my day$/ }).first().click();
      check('dashboard: Plan my day makes a ranked plan', await page.getByText(/Ranked by|Nothing is due/).first().waitFor({ state: 'visible', timeout: 60000 }).then(() => true).catch(() => false));
      const ask = page.locator('.ins-ask').first();
      await ask.locator('input').fill('joinings by client this year');
      await ask.locator('button[type=submit]').click();
      check('dashboard: Ask for a chart draws the chart for the question', await seen(page, 'Joinings by client, this year', 60000));
      await page.screenshot({ path: path.join(SHOTS, 'dashboard-insights.png'), fullPage: true });
      check('dashboard: no page errors', errors.length === 0, errors);
      await ctx.close();
    }
    // ---- the reports home + each tab (admin)
    {
      const { ctx, page, errors } = await open(sa, '/reports/ats');
      check('reports home: the "Forecast, build & data" group with the BI feed and compliance cards', (await seen(page, 'Forecast, build & data')) && (await seen(page, 'BI feed', 5000)) && (await seen(page, 'Compliance (DPDP)', 5000)) && (await seen(page, 'Backdoor hires', 5000)) && (await seen(page, 'Quality of hire', 5000)));
      const tabs = [
        ['ttfjob', 'By requirement'], ['openings', 'Each opening'], ['readiness', 'Next step'], ['forecast', 'Expected joinings'], ['bottlenecks', 'Waiting now, by step'],
        ['askchart', 'Joinings by client this year'], ['schedules', 'Tell me when'], ['backdoor', 'People checked'], ['qoh', 'Average rating'], ['compliance', 'Digital Personal Data Protection Act'], ['bifeed', 'Connect Power BI'],
      ];
      for (const [t, text] of tabs) {
        await page.goto(`http://localhost:${WEB}/reports/ats?tab=${t}`, { waitUntil: 'commit' }); // eslint-disable-line no-await-in-loop
        const ok = await seen(page, text, 90000); // eslint-disable-line no-await-in-loop
        check(`tab ${t}: shows "${text}"`, ok, ok ? undefined : (await page.evaluate(() => document.body.innerText.slice(0, 300)).catch(() => ''))); // eslint-disable-line no-await-in-loop
        if (['forecast', 'backdoor', 'compliance'].includes(t)) await page.screenshot({ path: path.join(SHOTS, `tab-${t}.png`), fullPage: true }); // eslint-disable-line no-await-in-loop
      }
      // the builder: run, save, appears in My reports
      await page.goto(`http://localhost:${WEB}/reports/ats?tab=builder`, { waitUntil: 'commit' });
      await seen(page, 'Report on');
      await page.locator('button', { hasText: 'Run report' }).click();
      check('builder: Run report shows the rows', await page.getByText(/row\(s\)/).first().waitFor({ state: 'visible', timeout: 60000 }).then(() => true).catch(() => false));
      await page.locator('input[aria-label="Report name"]').fill('Smoke report');
      await page.locator('.ins-save button', { hasText: 'Save' }).click();
      check('builder: Save puts it under My reports', await seen(page, 'Saved. Find it', 20000));
      await page.screenshot({ path: path.join(SHOTS, 'tab-builder.png'), fullPage: true });
      check('reports: no page errors', errors.length === 0, errors);
      await ctx.close();
    }
    // ---- a TL: no BI / compliance card; phone width works
    {
      const { ctx, page } = await open(tl, '/reports/ats');
      const up = await seen(page, 'Forecast, build & data');
      check('TL: sees Forecast, build & data', up);
      check('TL: but no BI feed and no Compliance card', up && !(await page.getByText('BI feed', { exact: true }).count()) && !(await page.getByText('Compliance (DPDP)', { exact: true }).count()));
      await ctx.close();
    }
    {
      const { ctx, page } = await open(tl, '/reports/ats?tab=builder', { width: 390, height: 800 });
      await seen(page, 'Report on');
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check('phone width: the builder fits (no sideways scroll of the page)', wide <= 2, wide);
      await page.screenshot({ path: path.join(SHOTS, 'phone-builder.png'), fullPage: true });
      await ctx.close();
    }
  } finally {
    await browser.close().catch(() => {});
  }
  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.log('FAIL  crashed:', e && e.message); await stop(1); });
