#!/usr/bin/env node
/**
 * BROWSER SMOKE of CRM wave C (2026-11-24): an Admin opens an account - the More tab (tags, files, parent company, team, org chart, health,
 * fill from the web) and the Privacy tab (consent per channel); Accounts & Contacts has More records / Customer health / Data care; CRM settings
 * has "Customise the CRM"; the Dashboard has Adoption; TeamLink's search box finds CRM records; phone width has no sideways scroll.
 * A private sandbox server (copy of the sandbox database) + vite preview in front of it + Edge. Build the frontend first (npx vite build).
 *   TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4571 node scripts/crm-C-browser.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const FRONT = path.resolve(BACK, '..', 'frontend');
const SHOTS = path.join(os.tmpdir(), 'crm-C-shots');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-crmC-smoke-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT || 4571);
const WEB = PORT + 1;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'crmC-smoke', INTEGRATION_SECRET_KEY: 'crm-c-smoke-key', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
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
const visible = (loc, ms = 30000) => loc.first().waitFor({ state: 'visible', timeout: ms }).then(() => true).catch(() => false);

(async () => {
  const sa = await prisma.user.create({ data: { name: `Cz Admin ${RUN}`, email: `cz.admin.${RUN}@cz-test.in`, username: `cz.admin.${RUN}@cz-test.in`, passwordHash: 'x', status: 'Active', hrmsRole: 'NONE', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3) } });
  const token = jwt.sign({ ...tokenPayload(await resolveIdentity(sa.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const be = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(be);
  if (!(await waitFor(`http://localhost:${PORT}/api/health`))) { console.log('FAIL  the sandbox server did not answer (set TEST_PORT)'); await stop(1); return; }
  const api = async (method, url, body) => { const r = await fetch(`http://localhost:${PORT}/api${url}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  // the data the screens show
  await api('POST', '/crm/plusc/fields', { kind: 'account', label: 'Employees band', type: 'select', options: '1-50\n51-200\n200+' });
  const parent = await api('POST', '/crm/accounts', { name: `Czparent Holdings ${RUN}`, phone: `9${String(Date.now()).slice(-9)}` });
  const acc = await api('POST', '/crm/accounts', { name: `Czorbit Systems ${RUN}`, website: 'czorbit-example.in', email: `hello@czorbit-example.in`, tags: 'VIP, Expo', parentId: parent.body.account.id, custom: { cf_employees_band: '51-200' }, phone: `8${String(Date.now()).slice(-9)}` });
  const accountId = acc.body.account && acc.body.account.id;
  await api('POST', '/crm/contacts', { name: `Czperson Rao ${RUN}`, accountId, phone: `7${String(Date.now()).slice(-9)}`, email: `cz.person.${RUN}@czorbit-example.in` });
  await api('POST', '/crm/plusc/objects', { name: 'Branch', linkTo: 'account', fields: [{ label: 'City', type: 'text' }] });
  check('setup: an account with a parent, tags and a custom value', acc.status === 200 && !!accountId, acc.body);

  const web = spawn(process.execPath, [path.join(FRONT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(WEB), '--strictPort', '--host', 'localhost'], { cwd: FRONT, env: { ...process.env, API_PROXY: `http://localhost:${PORT}` }, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(web);
  if (!(await waitFor(`http://localhost:${WEB}/`))) { console.log('FAIL  the web server did not answer'); await stop(1); return; }

  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const open = async (urlPath, viewport = { width: 1280, height: 900 }) => {
    const ctx = await browser.newContext({ viewport });
    await ctx.addInitScript((t) => { try { localStorage.setItem('tl_token', t); } catch (e) { /* none */ } }, token);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('   page error:', String(e.message || e).slice(0, 300)));
    page.on('dialog', (d) => d.accept().catch(() => {}));
    await page.goto(`http://localhost:${WEB}${urlPath}`, { waitUntil: 'commit', timeout: 120000 });
    return { ctx, page };
  };
  try {
    {
      const { ctx, page } = await open('/crm/accounts');
      await page.locator('tr', { hasText: `Czorbit Systems ${RUN}` }).first().click({ timeout: 60000 }).catch(() => null);
      const rec = page.locator('.modal', { hasText: `Czorbit Systems ${RUN}` });
      const recUp = await visible(rec, 60000);
      check('the account record opens', recUp, recUp ? undefined : await page.evaluate(() => document.body.innerText.slice(0, 600)).catch(() => ''));
      if (!recUp) await page.screenshot({ path: path.join(SHOTS, 'open-fail.png') });
      check('it shows its tags', await visible(rec.locator('.status', { hasText: 'VIP' })));
      await rec.locator('[role=tab]', { hasText: /^More$/ }).click();
      check('More: the custom value is shown', await visible(rec.locator('text=Employees band')) && await visible(rec.locator('text=51-200')));
      check('More: parent company and subsidiaries, with the parent', await visible(rec.locator('.section-label', { hasText: 'Parent company and subsidiaries' })) && await visible(rec.locator('text=Czparent Holdings')));
      check('More: account team, org chart, customer health, fill from the web, files', await visible(rec.locator('.section-label', { hasText: 'Account team' })) && await visible(rec.locator('.section-label', { hasText: /^Org chart/ })) && await visible(rec.locator('.section-label', { hasText: 'Customer health' })) && await visible(rec.locator('.section-label', { hasText: 'Company details from the web' })) && await visible(rec.locator('.section-label', { hasText: /^Files/ })));
      await rec.locator('button', { hasText: 'Fill from the web' }).click();
      check('"Fill from the web" offers what it found (a stub site on the test server)', await visible(rec.locator('button', { hasText: 'Fill in the ticked' })));
      await rec.locator('input[type=file]').first().setInputFiles({ name: `card-${RUN}.png`, mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') });
      check('a file is uploaded onto the account', await visible(rec.locator('b', { hasText: `card-${RUN}.png` })));
      await page.screenshot({ path: path.join(SHOTS, 'account-more.png'), fullPage: true });
      await rec.locator('[role=tab]', { hasText: /^Privacy$/ }).click();
      check('Privacy: the consent table per channel', await visible(rec.locator('td', { hasText: 'WhatsApp' })) && await visible(rec.locator('.section-label', { hasText: 'Do-Not-Disturb' })));
      await rec.locator('tr', { hasText: 'Email' }).locator('button', { hasText: 'Withdrawn' }).click();
      await page.locator('.modal-foot button', { hasText: 'Save' }).last().click();
      check('withdrawing email consent shows Withdrawn', await visible(rec.locator('tr', { hasText: 'Email' }).locator('.status', { hasText: 'Withdrawn' })));
      check('the record has a Merge button', await rec.locator('button', { hasText: 'Merge…' }).isVisible());
      await page.screenshot({ path: path.join(SHOTS, 'account-privacy.png') });
      await ctx.close();
    }
    {
      const { ctx, page } = await open('/crm/accounts');
      check('Accounts & Contacts has the More records, Customer health and Data care tabs', await visible(page.locator('[role=tab]', { hasText: 'Data care' }), 60000) && await page.locator('[role=tab]', { hasText: 'More records' }).isVisible() && await page.locator('[role=tab]', { hasText: 'Customer health' }).isVisible());
      await page.locator('[role=tab]', { hasText: 'More records' }).click();
      check('More records lists the Branch record type', await visible(page.locator('button', { hasText: '+ Branch' })));
      await page.locator('[role=tab]', { hasText: 'Customer health' }).click();
      check('Customer health has its filter buttons', await visible(page.locator('button', { hasText: /^At risk/ })));
      await page.locator('[role=tab]', { hasText: 'Data care' }).click();
      check('Data care: recycle bin, duplicates, import, mass changes, data requests', await visible(page.locator('[role=tab]', { hasText: 'Recycle bin' })) && await page.locator('[role=tab]', { hasText: 'Mass changes' }).isVisible() && await page.locator('[role=tab]', { hasText: 'Data requests' }).isVisible());
      await page.locator('[role=tab]', { hasText: 'Mass changes' }).click();
      check('Mass changes lists records to tick', await visible(page.locator('input[aria-label="Tick all"]')));
      await page.screenshot({ path: path.join(SHOTS, 'data-care.png') });
      await ctx.close();
    }
    {
      const { ctx, page } = await open('/crm/dashboard');
      const set = page.locator('button', { hasText: 'Settings' });
      check('the dashboard opens', await visible(set, 60000));
      await set.first().click();
      const cust = page.locator('.section-label', { hasText: 'Customise the CRM' });
      await cust.scrollIntoViewIfNeeded().catch(() => null);
      check('CRM settings has "Customise the CRM" with its parts', await visible(cust) && await page.locator('[role=tab]', { hasText: 'Lead routing' }).isVisible() && await page.locator('[role=tab]', { hasText: 'Lead capture' }).isVisible());
      await page.locator('[role=tab]', { hasText: 'Lead capture' }).click();
      check('Lead capture lists the sources, each off', await visible(page.locator('label', { hasText: 'IndiaMART' })) && !(await page.locator('label', { hasText: 'Website chat box' }).locator('input').isChecked()));
      await page.locator('[role=tab]', { hasText: 'Layouts' }).click();
      check('Layouts shows the form fields with their switches', await visible(page.locator('label', { hasText: 'read-only for salespeople' })));
      await page.screenshot({ path: path.join(SHOTS, 'customise.png') });
      await page.locator('.close-x').first().click();
      await page.locator('[role=tab]', { hasText: 'Adoption' }).click();
      check('Dashboard > Adoption shows the people', await visible(page.locator('th', { hasText: 'Days used' })));
      await ctx.close();
    }
    {
      const { ctx, page } = await open('/ats/dashboard');
      const box = page.locator('input[role=combobox]').first();
      if (await visible(box, 60000)) {
        await box.fill(`Czorbit Systems ${RUN}`);
        check('TeamLink\'s search box finds the CRM account', await visible(page.locator('.sr-gtitle', { hasText: 'CRM accounts' })));
        await page.screenshot({ path: path.join(SHOTS, 'search.png') });
      } else check('TeamLink\'s search box finds the CRM account', false, 'no search box on the dashboard');
      await ctx.close();
    }
    {
      const { ctx, page } = await open('/crm/accounts', { width: 390, height: 844 });
      await page.locator('tr', { hasText: `Czorbit Systems ${RUN}` }).first().click({ timeout: 60000 }).catch(() => null);
      const rec = page.locator('.modal', { hasText: `Czorbit Systems ${RUN}` });
      await visible(rec, 60000);
      await rec.locator('[role=tab]', { hasText: /^More$/ }).click();
      await visible(rec.locator('.section-label', { hasText: 'Account team' }));
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check('phone width: the More tab has no sideways scroll of the page', wide <= 2, wide);
      await page.screenshot({ path: path.join(SHOTS, 'phone-more.png'), fullPage: true });
      await ctx.close();
    }
  } catch (e) { check('the smoke ran to the end', false, e.message); }
  await browser.close().catch(() => {});
  console.log(`\nscreenshots: ${SHOTS}`);
  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
