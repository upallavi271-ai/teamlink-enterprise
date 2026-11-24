#!/usr/bin/env node
/**
 * BROWSER SMOKE of CRM wave B (2026-11-24): the new screens are TABS inside the five CRM items (Follow-ups > Inbox / Dialer, Leads > Marketing,
 * Accounts & Contacts > Customer portal, a record's "Web & engagement", the contact window's SMS tab, the settings section) and the customer
 * portal page /crm-portal with its own login; desktop and phone width (no sideways scroll). A private sandbox server (copy of the sandbox
 * database) + vite preview in front of it + Edge. Build the frontend first (npx vite build).
 *   TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4xxx node scripts/crm-B-browser.js      (screenshots: SHOTS or the temp folder)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const FRONT = path.resolve(BACK, '..', 'frontend');
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), `crm-b-shots-${process.pid}`);
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-crm-b-smoke-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const dbx = new DatabaseSync(COPY);
dbx.exec('DELETE FROM "AppSetting" WHERE "key" IN (\'crm.settings\', \'crm.b\')');
dbx.close();
const PORT = Number(process.env.TEST_PORT || 4541);
const WEB = PORT + 1;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'crm-b-smoke', APP_BASE_URL: `http://localhost:${WEB}`, FRONTEND_URL: `http://localhost:${WEB}`, DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
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

(async () => {
  const sa = await prisma.user.create({ data: { name: `Cb admin ${RUN}`, email: `cb.admin.${RUN}@cb-test.in`, username: `cb.admin.${RUN}@cb-test.in`, passwordHash: 'x', status: 'Active', hrmsRole: 'NONE', role: 'SUPER_ADMIN', passwordChangedAt: new Date(Date.now() - 3600e3) } });
  const be = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(be);
  if (!(await waitFor(`http://localhost:${PORT}/api/health`))) { console.log('FAIL  the sandbox server did not answer (set TEST_PORT)'); await stop(1); return; }
  const web = spawn(process.execPath, [path.join(FRONT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(WEB), '--strictPort', '--host', 'localhost'], { cwd: FRONT, env: { ...process.env, API_PROXY: `http://localhost:${PORT}` }, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(web);
  if (!(await waitFor(`http://localhost:${WEB}/`))) { console.log('FAIL  the web server did not answer'); await stop(1); return; }
  const token = jwt.sign({ ...tokenPayload(await resolveIdentity(sa.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const api = async (method, url, body) => { const r = await fetch(`http://localhost:${PORT}/api${url}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined }); return r.json().catch(() => ({})); };
  await (api('POST', '/crm/leads', { company: `Cb Smoke Co ${RUN}`, contactName: 'Smita', phone: '9876511111', email: `smita.${RUN}@cb-test.in`, force: true }));
  await (api('POST', '/crm/accounts', { name: `Cb Account ${RUN}`, force: true }));
  await api('POST', '/crm/b/segments', { name: `Cb segment ${RUN}`, audience: 'leads', filters: {} });

  const { chromium } = require('playwright-core');
  // Edge first (as the other smokes); on a machine where headless Edge will not start, Chrome (the same engine)
  const browser = await chromium.launch({ channel: 'msedge', headless: true }).catch(() => { console.log('  (Edge did not start here: using Chrome)'); return chromium.launch({ channel: 'chrome', headless: true }); });
  fs.mkdirSync(SHOTS, { recursive: true });
  const errors = [];
  const open = async (urlPath, { width = 1280, height = 900, auth = true } = {}) => {
    const ctx = await browser.newContext({ viewport: { width, height } });
    if (auth) await ctx.addInitScript((t) => { try { localStorage.setItem('tl_token', t); } catch (e) { /* none */ } }, token);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e.message || e).slice(0, 200)));
    await page.goto(`http://localhost:${WEB}${urlPath}`, { waitUntil: 'commit', timeout: 120000 });
    return { ctx, page };
  };
  const tab = (page, name) => page.locator('[role=tab]', { hasText: name }).first();
  const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2);
  try {
    // Follow-ups > Inbox and Dialer
    {
      const { ctx, page } = await open('/crm/followups');
      const ib = tab(page, 'Inbox');
      check('Follow-ups has an Inbox tab', await ib.waitFor({ state: 'visible', timeout: 60000 }).then(() => true).catch(() => false));
      await ib.click();
      check('Inbox: Conversations, Website chat, Team mailbox, Scheduled, My mail settings', await page.locator('button[role=tab]', { hasText: 'Team mailbox' }).waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false) && await page.locator('button[role=tab]', { hasText: 'My mail settings' }).isVisible());
      await page.locator('button[role=tab]', { hasText: 'My mail settings' }).click();
      check('My mail settings: signature, mailbox, templates', await page.locator('text=My email signature').waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false) && await page.locator('text=Templates').first().isVisible());
      await page.screenshot({ path: path.join(SHOTS, 'inbox-mymail.png') });
      await tab(page, 'Dialer').click();
      check('Follow-ups > Dialer: "Make the list"', await page.locator('button', { hasText: 'Make the list' }).waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false));
      check('the follow-up filters are hidden on the Dialer', (await page.locator('[aria-label="From"]').count()) === 0);
      await ctx.close();
    }
    // Leads > Marketing
    {
      const { ctx, page } = await open('/crm/leads?tab=marketing');
      check('Leads > Marketing: the sub tabs (Segments ... Ad leads)', await page.locator('button[role=tab]', { hasText: 'Ad leads' }).waitFor({ state: 'visible', timeout: 60000 }).then(() => true).catch(() => false));
      check('the saved segment is listed', await page.locator('td', { hasText: `Cb segment ${RUN}` }).waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false));
      for (const t of ['Journeys', 'Landing pages', 'Events', 'Campaign results', 'Social', 'Website']) {
        await page.locator('button[role=tab]', { hasText: t }).click(); // eslint-disable-line no-await-in-loop
        await page.waitForTimeout(400); // eslint-disable-line no-await-in-loop
      }
      check('Website: the chat bubble and tracker snippets to paste', await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 20000 }).then(async () => /crm-public\/b\/w\/chat\.js/.test(await page.locator('textarea').first().inputValue())).catch(() => false));
      await page.screenshot({ path: path.join(SHOTS, 'marketing-website.png') });
      await ctx.close();
    }
    // Accounts > Customer portal
    {
      const { ctx, page } = await open('/crm/accounts?tab=portal');
      check('Accounts & Contacts > Customer portal: logins, help articles, partners, surveys', await page.locator('button[role=tab]', { hasText: 'Surveys (NPS / CSAT)' }).waitFor({ state: 'visible', timeout: 60000 }).then(() => true).catch(() => false));
      check('it says the portal is switched off', await page.locator('text=is switched').first().isVisible().catch(() => false));
      await page.locator('button[role=tab]', { hasText: 'Help articles' }).click();
      check('Help articles: "+ Article"', await page.locator('button', { hasText: '+ Article' }).waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false));
      await ctx.close();
    }
    // a record: Web & engagement; the contact window: SMS tab; the settings section
    {
      const { ctx, page } = await open('/crm/leads');
      const rowName = page.locator('td', { hasText: `Cb Smoke Co ${RUN}` }).first();
      await rowName.waitFor({ state: 'visible', timeout: 60000 }).catch(() => null);
      await rowName.click().catch(() => null);
      const eng = page.locator('.modal [role=tab]', { hasText: 'Web & engagement' });
      const engUp = await eng.waitFor({ state: 'visible', timeout: 60000 }).then(() => true).catch(() => false);
      if (!engUp) await page.screenshot({ path: path.join(SHOTS, 'record-debug.png') });
      check('a lead record has the "Web & engagement" tab', engUp, engUp ? undefined : (await page.evaluate(() => document.body.innerText.slice(0, 600)).catch(() => '')));
      await eng.click();
      check('it shows emails opened, office-line calls, pages viewed, social profiles and the survey buttons', await page.locator('text=Emails opened').waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false)
        && await page.locator('text=Calls on the office line').isVisible() && await page.locator('text=Pages viewed on the website').isVisible() && await page.locator('button', { hasText: 'Send NPS survey' }).isVisible());
      await page.screenshot({ path: path.join(SHOTS, 'record-engage.png') });
      await ctx.close();
    }
    {
      const { ctx, page } = await open('/crm/accounts');
      const accName = page.locator('td', { hasText: `Cb Account ${RUN}` }).first();
      await accName.waitFor({ state: 'visible', timeout: 60000 }).catch(() => null);
      await accName.click().catch(() => null);
      const eng = page.locator('.modal [role=tab]', { hasText: 'Web & engagement' });
      await eng.waitFor({ state: 'visible', timeout: 60000 }).catch(() => null);
      await eng.click().catch(() => null);
      check('an account record offers "Invite to the portal"', await page.locator('button', { hasText: 'Invite to the portal' }).waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false));
      await ctx.close();
    }
    {
      const { ctx, page } = await open('/crm/dashboard');
      const set = page.locator('button', { hasText: 'Settings' }).first();
      await set.waitFor({ state: 'visible', timeout: 60000 }).catch(() => null);
      await set.click().catch(() => null);
      check('CRM settings has the "Email, phone, marketing and portal" switches, all Off', await page.locator('text=Email, phone, marketing and portal').waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false) && (await page.locator('.modal .status', { hasText: /^On$/ }).count()) === 0);
      await page.screenshot({ path: path.join(SHOTS, 'settings-switches.png') });
      await ctx.close();
    }
    // the portal page: its own login, works at phone width
    {
      const { ctx, page } = await open('/crm-portal', { width: 390, height: 800, auth: false });
      check('/crm-portal opens its own sign-in (customer / partner)', await page.locator('h1', { hasText: 'Sign in' }).waitFor({ state: 'visible', timeout: 60000 }).then(() => true).catch(() => false) && await page.locator('select#pt').isVisible());
      check('the portal sign-in fits a phone (no sideways scroll)', await noSideScroll(page));
      await page.fill('#pe', `nobody.${RUN}@cb-test.in`); await page.fill('#pp', 'Wrong1234');
      await page.locator('button[type=submit]').click();
      check('a sign-in while the portal is off says it is not open yet', await page.locator('text=not open yet').waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false));
      await page.screenshot({ path: path.join(SHOTS, 'portal-phone.png') });
      await ctx.close();
    }
    // phone width inside the CRM
    {
      const { ctx, page } = await open('/crm/followups', { width: 390, height: 820 });
      await tab(page, 'Inbox').waitFor({ state: 'visible', timeout: 60000 }).catch(() => null);
      await tab(page, 'Inbox').click().catch(() => null);
      await page.waitForTimeout(800);
      check('Follow-ups > Inbox fits a phone', await noSideScroll(page));
      await ctx.close();
      const m = await open('/crm/leads?tab=marketing', { width: 390, height: 820 });
      await m.page.locator('button[role=tab]', { hasText: 'Segments' }).waitFor({ state: 'visible', timeout: 60000 }).catch(() => null);
      check('Leads > Marketing fits a phone', await noSideScroll(m.page));
      await m.page.screenshot({ path: path.join(SHOTS, 'marketing-phone.png') });
      await m.ctx.close();
    }
    check('no script errors on any page', errors.length === 0, errors);
    // the CRM menu still has five items
    {
      const { ctx, page } = await open('/crm/dashboard');
      await page.waitForTimeout(1500);
      const items = await page.evaluate(() => [...document.querySelectorAll('a[href^="/crm/"]')].map((a) => a.getAttribute('href').split('?')[0]).filter((h, i, s) => s.indexOf(h) === i && /^\/crm\/(dashboard|leads|followups|deals|accounts|inbox|marketing|portal)$/.test(h)));
      check('the CRM menu still has its five items and no new one', items.length <= 5 && !items.some((h) => /inbox|marketing|portal/.test(h)), items);
      await ctx.close();
    }
  } catch (e) { check('the smoke ran to the end', false, e.message); }
  await browser.close();
  console.log(`\nScreenshots: ${SHOTS}`);
  console.log(`${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
