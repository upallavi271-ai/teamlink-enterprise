#!/usr/bin/env node
/**
 * BROWSER SMOKE of the CRM money gaps (2026-11-26): on a deal's Invoice tab the payment line has Receipt / WhatsApp / email, the credit / debit
 * note and Repeat boxes are there and a credit note can be issued from the screen; Deals > Commission shows the month; Leads > Sequences lists
 * them and a lead's Follow-ups shows "Sequence"; Customer support has "SLA hours". No page errors.
 * A private sandbox server (copy of the sandbox database) + vite preview of the built frontend (run `npx vite build` in frontend first) + Edge.
 *   TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4640 [SHOTS=<folder>] node scripts/crm-money-gaps-browser.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const FRONT = path.resolve(BACK, '..', 'frontend');
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'crm-money-gaps-shots');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-crm-gaps-br-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT || 4640);
const WEB = PORT + 1;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'crm-gaps-br', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`, INTEGRATION_SECRET_KEY: 'crm-gaps-br-key', AI_PROVIDER: 'none' };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const DB = require('../src/crm/schema');

let failed = 0; let total = 0; const errors = [];
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
  await DB.ensure();
  const X = await prisma.user.create({ data: { name: `Zg Admin ${RUN}`, email: `zg.admin.${RUN}@example.test`, passwordHash: 'x', status: 'Active', role: 'SUPER_ADMIN', passwordChangedAt: new Date(Date.now() - 3600e3) } });
  const be = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(be);
  if (!(await waitFor(`http://localhost:${PORT}/api/health`))) { console.log('FAIL  the sandbox server did not answer (set TEST_PORT)'); await stop(1); return; }
  const token = jwt.sign({ ...tokenPayload(await resolveIdentity(X.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const call = async (method, url, body) => { const r = await fetch(`http://localhost:${PORT}/api${url}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined }); return r.json().catch(() => ({})); };
  const acc = (await call('POST', '/crm/accounts', { name: `Zg Customer ${RUN}`, state: 'Telangana', phone: '9876500044' })).account;
  const deal = (await call('POST', '/crm/deals', { title: `Zg Deal ${RUN}`, accountId: acc.id, value: '50000' })).deal;
  const inv = (await call('POST', `/crm/deals/${deal.id}/stage`, { stage: 'Won' })).invoice;
  await call('POST', `/crm/invoices/${inv.id}/status`, { status: 'Sent' });
  await call('POST', `/crm/invoices/${inv.id}/payments`, { amount: 20000, mode: 'UPI' });
  await call('POST', '/crm/sequences', { name: `Zg Warm ${RUN}`, steps: [{ channel: 'email', afterDays: 0, subject: 'Hi {name}', body: 'Hello {name}' }, { channel: 'task', afterDays: 2, body: 'Call them' }] });
  const lead = (await call('POST', '/crm/leads', { company: `Zg Lead ${RUN}`, contactName: 'Asha', email: `zg.${RUN}@example.test` })).lead;

  const web = spawn(process.execPath, [path.join(FRONT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(WEB), '--strictPort', '--host', 'localhost'], { cwd: FRONT, env: { ...process.env, API_PROXY: `http://localhost:${PORT}` }, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(web);
  if (!(await waitFor(`http://localhost:${WEB}/`))) { console.log('FAIL  the web server did not answer'); await stop(1); return; }
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel: 'msedge', headless: true }).catch(() => chromium.launch({ channel: 'chrome', headless: true }));
  fs.mkdirSync(SHOTS, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript((t) => { try { localStorage.setItem('tl_token', t); } catch (e) { /* none */ } }, token);
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept().catch(() => {}));
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 300)));
  const vis = (loc, t = 30000) => loc.waitFor({ state: 'visible', timeout: t }).then(() => true).catch(() => false);
  try {
    await page.goto(`http://localhost:${WEB}/crm/deals?open=deal:${deal.id}`, { waitUntil: 'commit', timeout: 120000 });
    const tab = page.locator('[role="tab"]', { hasText: 'Invoice' }).first();
    check('the deal opens with its Invoice tab', await vis(tab, 90000));
    await tab.click();
    const receipt = page.locator('button', { hasText: 'Receipt' }).first();
    check('the payment line has a Receipt button (and WhatsApp / email)', await vis(receipt) && await page.locator('button[aria-label="Send the receipt on WhatsApp"]').count() > 0 && await page.locator('button[aria-label="Email the receipt"]').count() > 0);
    check('the Credit / debit notes box is there with + Credit note', await vis(page.locator('button', { hasText: '+ Credit note' })));
    check('the Repeat box is there', await vis(page.locator('button', { hasText: 'Repeat this invoice' })));
    await page.locator('button', { hasText: '+ Credit note' }).click();
    await page.locator('input[aria-label="Value before GST"]').fill('5000');
    await page.locator('input[aria-label="Reason"]').fill('Discount agreed later');
    await page.locator('.modal-foot button', { hasText: 'Issue credit note' }).click();
    const cnRow = page.locator('b', { hasText: /^CN-\d{4}/ }).first();
    check('a credit note issued from the screen shows in the box', await vis(cnRow));
    check('the invoice shows the total after the note', await vis(page.locator('text=After credit / debit notes')));
    await page.screenshot({ path: path.join(SHOTS, 'deal-invoice-receipt-notes.png'), fullPage: true });
    await page.locator('button', { hasText: 'Repeat this invoice' }).click();
    await page.locator('.modal-foot button', { hasText: 'Save' }).click();
    check('the repeat is set from the screen (Make the next one now appears)', await vis(page.locator('button', { hasText: 'Make the next one now' })));

    await page.goto(`http://localhost:${WEB}/crm/deals`, { waitUntil: 'commit' });
    const comBtn = page.locator('button', { hasText: 'Commission' }).first();
    await vis(comBtn, 90000); await comBtn.click();
    check('Deals > Commission shows the month and the Rules button', await vis(page.locator('input#com-month')) && await vis(page.locator('button', { hasText: 'Rules' })));
    await page.locator('button', { hasText: 'Rules' }).click();
    check('Rules: the % and the repeating-invoices switch', await vis(page.locator('input[aria-label="Commission percent for everybody"]')) && await page.locator('text=Repeating invoices made by themselves').count() > 0);
    await page.screenshot({ path: path.join(SHOTS, 'commission-rules.png') });
    await page.keyboard.press('Escape');

    await page.goto(`http://localhost:${WEB}/crm/leads`, { waitUntil: 'commit' });
    const seqTab = page.locator('[role="tab"]', { hasText: 'Sequences' }).first();
    await vis(seqTab, 90000); await seqTab.click();
    check('Leads > Sequences lists the sequence with its steps', await vis(page.locator('b', { hasText: `Zg Warm ${RUN}` })) && await page.locator('text=Day 2: Follow-up').count() > 0);
    await page.screenshot({ path: path.join(SHOTS, 'leads-sequences.png') });
    await page.goto(`http://localhost:${WEB}/crm/leads?open=lead:${lead.id}`, { waitUntil: 'commit' });
    const fu = page.locator('[role="tab"]', { hasText: 'Follow-ups' }).first();
    await vis(fu, 90000); await fu.click();
    check('a lead\'s Follow-ups shows the Sequence box with "Put on it"', await vis(page.locator('select[aria-label="Sequence to put the lead on"]')));
    await page.locator('select[aria-label="Sequence to put the lead on"]').selectOption({ label: `Zg Warm ${RUN}` });
    await page.locator('button', { hasText: 'Put on it' }).click();
    check('put on the sequence from the screen', await vis(page.locator('text=/On .*Zg Warm/')));

    await page.goto(`http://localhost:${WEB}/crm/accounts?tab=tickets`, { waitUntil: 'commit' });
    check('Customers > Support tickets has the SLA hours button', await vis(page.locator('button', { hasText: 'SLA hours' }), 90000));
    check('no page errors', errors.length === 0, errors);
  } catch (e) {
    failed += 1; total += 1; console.log(`FAIL  crashed: ${e.message}`);
    await page.screenshot({ path: path.join(SHOTS, 'crash.png') }).catch(() => {});
  }
  await browser.close();
  console.log(`\n${total - failed}/${total} passed   (screenshots: ${SHOTS})`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.log(`FAIL  crashed: ${e.stack || e.message}`); await stop(1); });
