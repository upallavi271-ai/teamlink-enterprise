#!/usr/bin/env node
/**
 * BROWSER SMOKE of CRM wave D (2026-11-24), modelled on team-report-smoke.js: a private sandbox server (copy of the sandbox database) + vite
 * preview of the built frontend (run `npx vite build` in frontend first) + Edge (playwright-core). Checks the new screens open and work:
 * the pipeline picker and days-in-stage on the Deals board, the Approvals / Analysis / Contracts views, a deal's Products / Team chat /
 * History tabs, bulk edit in the list, a lead's Consent tab, the new parts of CRM settings, and a deal record at phone width with no page
 * that scrolls sideways. Screenshots go to the temp folder (zz-crm-D-shots).
 *   TEST_SOURCE_DB=<sandbox.db> TEST_PORT=<port> node scripts/crm-D-browser.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const FRONT = path.resolve(BACK, '..', 'frontend');
const SHOTS = path.join(os.tmpdir(), 'zz-crm-D-shots');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-crm-D-browser-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const dbx = new DatabaseSync(COPY);
dbx.exec("DELETE FROM \"AppSetting\" WHERE \"key\" LIKE 'crm.plus.%'");
dbx.close();
const PORT = Number(process.env.TEST_PORT || 4571);
const WEB = PORT + 1;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'crm-D-browser', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };
const RUN = Date.now().toString(36);
const procs = [];
async function stop(code) {
  procs.forEach((p) => { try { p.kill(); } catch { /* gone */ } });
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const waitFor = async (url, tries = 240) => { for (let i = 0; i < tries; i += 1) { if (await fetch(url).then((r) => r.status < 500).catch(() => false)) return true; await new Promise((r) => { setTimeout(r, 500); }); } return false; }; // eslint-disable-line no-await-in-loop
const tokenOf = async (u) => jwt.sign({ ...tokenPayload(await resolveIdentity(u.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
const call = async (method, url, body, token) => { const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };

(async () => {
  const mk = (tag, data) => prisma.user.create({ data: { name: `Zd ${tag} ${RUN}`, email: `zd.${tag}.${RUN}@example.test`, passwordHash: 'x', status: 'Active', passwordChangedAt: new Date(Date.now() - 3600e3), ...data } });
  const X = await mk('admin', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' });
  const A = await mk('rep', { role: 'EMPLOYEE' });
  const M = await mk('mgr', { role: 'EMPLOYEE' });
  const be = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(be);
  if (!(await waitFor(`${API}/health`))) { console.log('FAIL  the sandbox server did not answer (set TEST_PORT)'); await stop(1); return; }
  const web = spawn(process.execPath, [path.join(FRONT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(WEB), '--strictPort', '--host', 'localhost'], { cwd: FRONT, env: { ...process.env, API_PROXY: `http://localhost:${PORT}` }, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(web);
  if (!(await waitFor(`http://localhost:${WEB}/`))) { console.log('FAIL  the web server did not answer'); await stop(1); return; }

  // the data: a sales team, a second pipeline, a deal with product lines and a comment, a lead
  const tX = await tokenOf(X); const tA = await tokenOf(A);
  await call('PUT', '/crm/settings', { salesTeam: [{ userId: A.id, name: A.name, role: 'rep', rights: { create: true, edit: true, export: true } }, { userId: M.id, name: M.name, role: 'manager' }] }, tX);
  await new Promise((r) => { setTimeout(r, 300); });
  const cfg = (await call('GET', '/crm/plus/config', null, tX)).body;
  await call('PUT', '/crm/plus/pipelines', { pipelines: [{ id: 'default', name: 'Sales pipeline', stages: cfg.pipelines[0].stages }, { id: 'products', name: 'Products', stages: [{ name: 'Enquiry' }, { name: 'Demo' }, { name: 'Quote' }] }] }, tX);
  const acc = (await call('POST', '/crm/accounts', { name: `Zd Acme ${RUN}`, state: 'Karnataka', city: 'Bengaluru' }, tA)).body.account;
  const deal = (await call('POST', '/crm/deals', { title: `Zd Licences ${RUN}`, accountId: acc.id, billing: 'Monthly' }, tA)).body.deal;
  const deal2 = (await call('POST', '/crm/deals', { title: `Zd Second ${RUN}`, accountId: acc.id, value: 1000 }, tA)).body.deal;
  await call('PUT', `/crm/plus/deals/${deal.id}/lines`, { lines: [{ productKey: 'HRMS', plan: 'Growth', name: 'HRMS - Growth', qty: 30, unitPrice: 99, billing: 'Monthly' }] }, tA);
  await call('POST', `/crm/plus/comments/deal/${deal.id}`, { body: `@${M.name} please look`, mentions: [M.id] }, tA);
  const lead = (await call('POST', '/crm/leads', { company: `Zd Lead ${RUN}`, contactName: 'Asha', phone: `98${String(Date.now()).slice(-8)}` }, tA)).body.lead;
  check('setup through the API (team, a second pipeline, a deal with lines, a comment, a lead)', !!(acc && deal && deal2 && lead), { acc: !!acc, deal: !!deal, lead: !!lead });

  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const open = async (token, urlPath, viewport = { width: 1280, height: 900 }) => {
    const ctx = await browser.newContext({ viewport });
    await ctx.addInitScript((t) => { try { localStorage.setItem('tl_token', t); } catch (e) { /* none */ } }, token);
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${WEB}${urlPath}`, { waitUntil: 'commit', timeout: 120000 });
    return { ctx, page };
  };
  const visible = (loc, timeout = 45000) => loc.first().waitFor({ state: 'visible', timeout }).then(() => true).catch(() => false);
  try {
    {
      const { ctx, page } = await open(tA, '/crm/deals');
      const board = await visible(page.locator('h1', { hasText: 'Deals' }), 90000);
      check('the Deals page opens', board);
      const pick = page.locator('select[aria-label="Pipeline"]');
      check('the board has a pipeline picker (two pipelines)', await visible(pick) && (await pick.locator('option').count()) === 2);
      check('a deal card says how many days it is in its stage', await visible(page.locator('.crm-card', { hasText: `Zd Licences ${RUN}` }).locator('text=/days in this stage/')));
      await pick.selectOption('products');
      check('choosing the Products pipeline shows its own stages', await visible(page.locator('.crm-col-head', { hasText: 'Enquiry' })) && (await page.locator('.crm-col-head', { hasText: 'Prospecting' }).count()) === 0);
      await page.locator('button', { hasText: /^List$/ }).click();
      const tick = page.locator(`input[aria-label="Tick Zd Second ${RUN}"]`);
      check('the list has tick boxes', await visible(tick));
      await tick.check();
      check('ticking a deal shows the bulk edit bar', await visible(page.locator('text=1 ticked')));
      await page.locator('input[aria-label="Probability"]').fill('35');
      await Promise.all([page.waitForResponse((r) => r.url().includes('/crm/plus/deals/bulk'), { timeout: 30000 }).catch(() => null), page.locator('button', { hasText: /^Apply$/ }).click()]);
      await page.waitForTimeout(400);
      const d2 = (await call('GET', `/crm/deals/${deal2.id}`, null, tA)).body.deal;
      check('Apply changes the ticked deal', d2.probability === 35, d2.probability);
      await page.locator('button', { hasText: /^Approvals/ }).click();
      check('Deals > Approvals opens (one inbox)', await visible(page.locator('text=Where I was mentioned')));
      await page.locator('button', { hasText: /^Analysis$/ }).click();
      check('Deals > Analysis shows win rate, cycle and velocity', await visible(page.locator('text=Pipeline velocity')) && await visible(page.locator('text=Win rate')));
      check('...the forecast and the recurring revenue', await visible(page.locator('.section-label', { hasText: 'Forecast' })) && await visible(page.locator('.section-label', { hasText: 'Recurring revenue' })));
      await page.locator('button', { hasText: /^Contracts$/ }).click();
      check('Deals > Contracts opens', await visible(page.locator('text=No sales orders or contracts yet')));
      await page.screenshot({ path: path.join(SHOTS, 'deals-contracts.png') });
      // the deal record
      await page.locator('button', { hasText: /^List$/ }).click();
      await page.locator('td', { hasText: `Zd Licences ${RUN}` }).first().click();
      const rec = await visible(page.locator('.crm-rec-title', { hasText: `Zd Licences ${RUN}` }), 60000);
      if (!rec || process.env.TEST_DEBUG) { await page.screenshot({ path: path.join(SHOTS, 'deal-open-debug.png') }); console.log((await page.evaluate(() => document.body.innerText)).slice(0, 1500)); }
      check('a deal opens with the new tabs (Products, Team chat, History)', rec && await visible(page.locator('.tab', { hasText: /^Products$/ })) && await visible(page.locator('.tab', { hasText: 'Team chat' })) && await visible(page.locator('.tab', { hasText: /^History$/ })));
      await page.locator('.tab', { hasText: /^Products$/ }).click();
      check('Products shows the line, the price book and the MRR', await visible(page.locator('input[aria-label="Description"]')) && await visible(page.locator('text=/MRR/')));
      await page.locator('.tab', { hasText: 'Team chat' }).click();
      check('Team chat shows the comment and the split', await visible(page.locator('text=please look')) && await visible(page.locator('text=Who shares the credit')));
      await page.locator('textarea[aria-label="Comment"]').fill('@Zd');
      check('typing @ offers teammates to mention', await visible(page.locator('button', { hasText: `@${M.name}` })));
      await page.locator('button', { hasText: `@${M.name}` }).click();
      await page.locator('textarea[aria-label="Comment"]').type('join Friday');
      await page.locator('button', { hasText: /^Send$/ }).click();
      check('sending posts it in the room', await visible(page.locator('text=join Friday')));
      await page.locator('.tab', { hasText: /^History$/ }).click();
      check('History shows the stages with days and the field changes', await visible(page.locator('.section-label', { hasText: /^Stages$/ })) && await visible(page.locator('.section-label', { hasText: 'Field changes' })));
      await page.locator('.tab', { hasText: 'Proposals' }).click();
      check('Proposals has quotes from templates with versions', await visible(page.locator('text=Quotes and versions')));
      await page.locator('.tab', { hasText: 'Invoice & orders' }).click();
      check('Invoice & orders has the contracts box', await visible(page.locator('text=Sales orders & contracts')));
      await page.screenshot({ path: path.join(SHOTS, 'deal-record.png') });
      // a lead's consent tab
      await page.keyboard.press('Escape');
      await page.goto(`http://localhost:${WEB}/crm/leads`, { waitUntil: 'commit' });
      await visible(page.locator('text=' + `Zd Lead ${RUN}`), 60000);
      await page.locator(`text=Zd Lead ${RUN}`).first().click();
      await visible(page.locator('.crm-rec-title', { hasText: `Zd Lead ${RUN}` }), 60000);
      await page.locator('.tab', { hasText: /^Consent$/ }).click();
      check('a lead has the Consent tab (DPDP) with the public notice link', await visible(page.locator('text=Consent now')) && await visible(page.locator('a', { hasText: 'open the public page' })));
      await ctx.close();
    }
    {
      const { ctx, page } = await open(tX, '/crm/dashboard');
      const gear = page.locator('button', { hasText: 'Settings' });
      check('the Admin opens CRM settings', await visible(gear, 90000));
      await gear.first().click();
      const part = page.locator('.section-label', { hasText: 'Deals, quotes, teams and security' });
      check('CRM settings has the new part with its tabs', await visible(part));
      check('Pipelines: the two pipelines with Save', await visible(page.locator('button', { hasText: 'Save pipelines' })) && (await page.locator('input[aria-label="Pipeline name"]').count()) === 2);
      for (const [tab, text] of [['Prices & CPQ', 'Save price books'], ['Quotes', 'Save quotes'], ['Teams & territories', 'Save territories'], ['Security', 'Save field security'], ['Payments', 'Online payment for CRM invoices'], ['Privacy (DPDP)', 'Save notice'], ['Mentions & renewals', 'Make the renewal deal by itself']]) {
        // eslint-disable-next-line no-await-in-loop
        await page.locator('.tab', { hasText: tab }).click();
        // eslint-disable-next-line no-await-in-loop
        check(`settings > ${tab} opens`, await visible(page.locator(`text=${text}`), 20000));
      }
      await page.screenshot({ path: path.join(SHOTS, 'settings.png') });
      await ctx.close();
    }
    {
      const { ctx, page } = await open(tA, '/crm/deals', { width: 375, height: 812 });
      await visible(page.locator('h1', { hasText: 'Deals' }), 90000);
      await page.locator('button', { hasText: /^List$/ }).click();
      await page.locator('td', { hasText: `Zd Licences ${RUN}` }).first().click();
      await visible(page.locator('.crm-rec-title', { hasText: `Zd Licences ${RUN}` }), 90000);
      const wide0 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      const culprits = await page.evaluate(() => [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 2 && getComputedStyle(el).position !== 'fixed').slice(0, 8).map((el) => `${el.tagName}.${String(el.className).slice(0, 40)} ${Math.round(el.getBoundingClientRect().right)}`));
      if (process.env.TEST_DEBUG_WIDTH) console.log('overview overflow', wide0, JSON.stringify(culprits));
      await page.locator('.tab', { hasText: /^Products$/ }).click();
      await visible(page.locator('input[aria-label="Description"]'));
      if (process.env.TEST_DEBUG_WIDTH) console.log('products overflow', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 2).slice(0, 12).map((el) => `${el.tagName}.${String(el.className).slice(0, 40)} ${Math.round(el.getBoundingClientRect().right)}`))));
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check('phone width: the deal\'s Products tab does not make the page scroll sideways', wide <= 2, wide);
      await page.locator('.tab', { hasText: 'Team chat' }).click();
      await visible(page.locator('text=please look'));
      const wide2 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check('phone width: nor does the team chat', wide2 <= 2, wide2);
      await page.screenshot({ path: path.join(SHOTS, 'phone-deal.png') });
      await ctx.close();
    }
  } catch (e) { check(`no crash (${e.message})`, false); }
  await browser.close().catch(() => {});
  console.log(`\n${total - failed}/${total} passed   (screenshots: ${SHOTS})`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
