#!/usr/bin/env node
/**
 * BROWSER SMOKE of CRM wave E (2026-11-24): the learned score and the mood in a lead's AI box, the Calls tab, check in / out with the
 * phone's location, a repeating follow-up, "Scan card / paste" filling the lead form, the Visits and Calendar tabs, the AI forecast and the
 * unusual changes on the dashboard, the Admin-only switches in CRM settings, phone width, and the offline copy + send queue.
 * A private sandbox server (copy of the sandbox database) + vite preview of the built frontend (run `npx vite build` in frontend first) + Edge.
 *   TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4620 node scripts/crm-E-browser.js     (screenshots: docs/crm-wave-E-2026-11-24/)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const FRONT = path.resolve(BACK, '..', 'frontend');
const SHOTS = path.resolve(BACK, '..', 'docs', 'crm-wave-E-2026-11-24');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-crmE-smoke-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT || 4620);
const WEB = PORT + 1;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'crmE-smoke', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`, INTEGRATION_SECRET_KEY: 'crmE-smoke-key', GROQ_API_KEY: '', GEMINI_API_KEY: '', OPENROUTER_API_KEY: '', AI_PROVIDER: 'none' };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const DB = require('../src/crm/schema');

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
const id = (p) => `${p}_zzs${Math.random().toString(36).slice(2, 12)}`;
const ins = async (table, row) => { const cols = Object.keys(row); await DB.run(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => row[c])); };
const ymd = (offset) => new Date(Date.now() + 5.5 * 3600000 + offset * 86400000).toISOString().slice(0, 10);

(async () => {
  await DB.ensure();
  await require('../src/crm/plusE').ensure();
  const mk = (tag, role) => prisma.user.create({ data: { name: `Zs ${tag} ${RUN}`, email: `zs.${tag}.${RUN}@example.test`, passwordHash: 'x', status: 'Active', role, passwordChangedAt: new Date(Date.now() - 3600e3) } });
  const A = await mk('rep', 'EMPLOYEE'); const M = await mk('mgr', 'EMPLOYEE'); const X = await mk('admin', 'SUPER_ADMIN');
  const SETTINGS = require('../src/crm/settings');
  await SETTINGS.load({ fresh: true });
  await SETTINGS.save({ salesTeam: [{ userId: A.id, name: A.name, role: 'rep', rights: { create: true, edit: true, delete: false, import: false, export: false, reports: false } }, { userId: M.id, name: M.name, role: 'manager' }] });
  const now = new Date().toISOString();
  for (let i = 0; i < 30; i += 1) {
    const good = i < 16; const lid = id('lead');
    // eslint-disable-next-line no-await-in-loop
    await ins('CrmLead', { id: lid, company: `Zs Hist ${i} ${RUN}`, contactName: good ? 'P' : null, phone: good ? `90100${String(10000 + i)}` : null, source: good ? 'Referral' : 'Import', rating: good ? 'Hot' : 'Cold', status: good ? 'Converted' : 'Junk', stage: good ? 'Won' : 'Lost', ownerId: A.id, ownerName: A.name, createdAt: now, updatedAt: now });
    // eslint-disable-next-line no-await-in-loop
    if (good) await ins('CrmActivity', { id: id('act'), kind: 'whatsapp', subject: 'Replied on WhatsApp', note: 'yes', at: now, leadId: lid, byId: A.id, byName: A.name, createdAt: now });
  }
  const LEAD = `Zs Smoke Lead ${RUN}`;
  const leadId = id('lead');
  await ins('CrmLead', { id: leadId, company: LEAD, contactName: 'Asha Rao', phone: '9876512345', email: `asha.${RUN}@zs.test`, source: 'Referral', rating: 'Hot', status: 'Contacted', stage: 'Contacted', ownerId: A.id, ownerName: A.name, createdAt: now, updatedAt: now });
  await ins('CrmActivity', { id: id('act'), kind: 'whatsapp', subject: 'Replied on WhatsApp', note: 'Great, please send the proposal', at: now, leadId, byId: A.id, byName: A.name, createdAt: now });
  const taskId = id('task');
  await ins('CrmTask', { id: taskId, title: `Zs call back ${RUN}`, dueDate: ymd(0), status: 'Open', type: 'Call', priority: 'Medium', leadId, ownerId: A.id, ownerName: A.name, createdAt: now, updatedAt: now });
  // 8 normal weeks of calls, then a quiet last week (the unusual change)
  const monday = (() => { const d = new Date(`${ymd(0)}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d; })();
  for (let w = 2; w <= 9; w += 1) for (let k = 0; k < 8; k += 1) { const at = new Date(monday.getTime() - w * 7 * 86400000 + 2 * 86400000 + k * 3600000).toISOString(); await ins('CrmActivity', { id: id('act'), kind: 'call', subject: 'Weekly call', note: 'x', at, leadId, byId: A.id, byName: A.name, createdAt: at }); } // eslint-disable-line no-await-in-loop

  const be = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(be);
  if (!(await waitFor(`http://localhost:${PORT}/api/health`))) { console.log('FAIL  the sandbox server did not answer (set TEST_PORT)'); await stop(1); return; }
  const web = spawn(process.execPath, [path.join(FRONT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(WEB), '--strictPort', '--host', 'localhost'], { cwd: FRONT, env: { ...process.env, API_PROXY: `http://localhost:${PORT}` }, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(web);
  if (!(await waitFor(`http://localhost:${WEB}/`))) { console.log('FAIL  the web server did not answer'); await stop(1); return; }

  const { chromium } = require('playwright-core');
  // Edge as the other smokes; when Edge cannot start (it was half-way through an update on the build machine, 2026-11-24) Chrome is used and said so
  const browser = await chromium.launch({ channel: 'msedge', headless: true }).catch(async (e) => { console.log(`  (Edge did not start: ${String(e.message).split('\n')[0]} - using Chrome)`); return chromium.launch({ channel: 'chrome', headless: true }); });
  fs.mkdirSync(SHOTS, { recursive: true });
  const open = async (user, urlPath, opts = {}) => {
    const token = jwt.sign({ ...tokenPayload(await resolveIdentity(user.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
    const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1280, height: 900 }, permissions: ['geolocation'], geolocation: { latitude: 17.4486, longitude: 78.3908, accuracy: 20 } });
    await ctx.addInitScript((t) => { try { localStorage.setItem('tl_token', t); } catch (e) { /* none */ } }, token);
    const page = await ctx.newPage();
    page.on('dialog', (d) => d.accept().catch(() => {}));
    page.on('pageerror', (e) => console.log(`  (page error: ${String(e.message).slice(0, 300)})`));
    if (process.env.TEST_DEBUG) page.on('console', (m) => { if (m.type() === 'error') console.log(`  (console: ${m.text().slice(0, 200)})`); });
    await page.goto(`http://localhost:${WEB}${urlPath}`, { waitUntil: 'commit', timeout: 120000 });
    return { ctx, page };
  };
  const vis = (loc, t = 30000) => loc.waitFor({ state: 'visible', timeout: t }).then(() => true).catch(() => false);
  // a lead opens from its row in the Leads list (the way a person opens it)
  const openLead = async (page, name) => {
    await vis(page.locator('input[aria-label="Search leads"]'), 90000);
    await page.locator('input[aria-label="Search leads"]').fill(name);
    const row = page.locator('tr.row-link', { hasText: name }).first();
    await vis(row, 30000);
    await row.click();
  };
  try {
    // ---- the salesperson: a lead's record -------------------------------------------------------------------------------------
    {
      const { ctx, page } = await open(A, '/crm/leads');
      await openLead(page, LEAD);
      const pred = page.locator('[data-testid="crm-ai-predict"]');
      const up = await vis(pred, 90000);
      const ptxt = up ? await pred.innerText() : '';
      if (!up) { await page.screenshot({ path: path.join(SHOTS, 'debug-lead.png') }); console.log(`  (page: ${(await page.evaluate(() => document.body.innerText).catch(() => '')).slice(0, 400).replace(/\n/g, ' | ')})`); }
      check('09.01: the lead\'s AI box shows the learned chance with its reasons', up && /\d+%/.test(ptxt) && /learned from \d+ closed leads/.test(ptxt) && /▲/.test(ptxt), ptxt);
      const mood = page.locator('[data-testid="crm-mood"]');
      check('09.10: the customer mood chip is on the record (Positive)', await vis(mood) && /Customer mood: Positive/.test(await mood.innerText()), await mood.innerText().catch(() => ''));
      await page.screenshot({ path: path.join(SHOTS, 'lead-ai-box.png') });
      // check in / out
      await page.locator('button', { hasText: '📍 Check in' }).click();
      const outBtn = page.locator('button', { hasText: '📍 Check out' });
      check('05.12: "Check in" with the phone\'s location turns into "Check out"', await vis(outBtn));
      await outBtn.click();
      const modal = page.locator('.modal', { has: page.locator('h3', { hasText: 'Check out of' }) }).last();
      await vis(modal);
      await modal.locator('button', { hasText: 'Meeting held' }).click();
      await modal.locator('textarea[aria-label="What happened at the visit"]').fill('Met the HR head at their office');
      await modal.locator('.modal-foot button', { hasText: 'Check out' }).click();
      check('05.12: check out with the outcome: the toast says how long', await vis(page.locator('.toast', { hasText: /Checked out: \d+ min/ })));
      // a repeating follow-up from the record's overview
      const rec = page.locator('.modal.xwide');
      await rec.locator('select[aria-label="Repeat"]').selectOption('weekly');
      await rec.locator('input[placeholder="New follow-up"]').fill(`Zs weekly ${RUN}`);
      await rec.locator('button', { hasText: /^Add$/ }).click();
      check('05.08: a follow-up set to repeat every week shows "🔁 Every week" with skip / stop', await vis(rec.locator('.crmx-repeat', { hasText: 'Every week' })) && await rec.locator('.crmx-repeat button', { hasText: 'stop repeating' }).count() > 0);
      // the Calls tab
      await rec.locator('.tab', { hasText: /^Calls$/ }).click();
      check('09.05: the Calls tab lists recorded calls and has "Summarise a call"', await vis(rec.locator('.section-label', { hasText: 'Summarise a call' })) && await rec.locator('text=Recorded calls to this customer').count() === 1);
      await rec.locator('textarea[aria-label="What was said on the call"]').fill('Spoke to Asha. They are interested in 5 developers. I will send the proposal tomorrow.');
      await rec.locator('button', { hasText: '✨ Summarise' }).click();
      check('09.05: "Summarise" gives a summary and a next step (code, no AI key)', await vis(rec.locator('text=Next:')), await rec.innerText().catch(() => ''));
      await page.screenshot({ path: path.join(SHOTS, 'lead-calls-tab.png') });
      await ctx.close();
    }
    // ---- the salesperson: Leads page, scan / paste ------------------------------------------------------------------------------
    {
      const { ctx, page } = await open(A, '/crm/leads');
      const btn = page.locator('button', { hasText: '📇 Scan card / paste' });
      check('09.12 / 14.04: the Leads page has "Scan card / paste"', await vis(btn, 90000));
      await btn.click();
      await page.locator('textarea[aria-label="Mail or card text"]').fill('Regards,\nPriya Menon\nTalent Acquisition Manager\nZzsoft Solutions Pvt Ltd\n+91 99887 76655 | priya.menon@zzsoft.co.in\nBengaluru');
      await page.locator('button', { hasText: 'Fill the lead form' }).click();
      let values = [];
      for (let i = 0; i < 40 && !values.some((v) => /Zzsoft/.test(v)); i += 1) { await page.waitForTimeout(500); values = await page.locator('.modal input').evaluateAll((els) => els.map((e) => e.value)); } // eslint-disable-line no-await-in-loop
      check('...the lead form opens filled: company, person, phone, email', values.some((v) => /Zzsoft Solutions/.test(v)) && values.includes('Priya Menon') && values.includes('9988776655') && values.includes('priya.menon@zzsoft.co.in'), values);
      await page.screenshot({ path: path.join(SHOTS, 'lead-from-paste.png') });
      await ctx.close();
    }
    // ---- the salesperson: Follow-ups (Visits, Calendar) and the offline copy -----------------------------------------------------
    {
      const { ctx, page } = await open(A, '/crm/followups');
      const tabs = page.locator('.tabs .tab');
      await vis(page.locator('h1', { hasText: 'Follow-ups' }), 90000);
      await page.locator('td', { hasText: `Zs call back ${RUN}` }).first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => null);
      await tabs.filter({ hasText: /^Visits/ }).click();
      check('05.12: Follow-ups > Visits lists today\'s visit at the lead', await vis(page.locator('[data-testid="crm-visits"] td', { hasText: LEAD })));
      await tabs.filter({ hasText: /^Calendar/ }).click();
      check('05.04: Follow-ups > Calendar has the Google / Outlook join card (off until the Admin turns it on)', await vis(page.locator('[data-testid="crm-calendar-sync"]', { hasText: 'Calendar sync is off' })));
      await tabs.filter({ hasText: /^Needs action/ }).click();
      await vis(page.locator('td', { hasText: `Zs call back ${RUN}` }).first());
      await tabs.filter({ hasText: /^Upcoming/ }).click();
      await page.waitForTimeout(1200);
      await tabs.filter({ hasText: /^Needs action/ }).click();
      await vis(page.locator('td', { hasText: `Zs call back ${RUN}` }).first());
      // no signal: the kept copy, and "Done" is queued
      await ctx.setOffline(true);
      await tabs.filter({ hasText: /^Upcoming/ }).click();
      await page.waitForTimeout(800);
      await tabs.filter({ hasText: /^Needs action/ }).click();
      const bar = page.locator('[data-testid="crm-offline-bar"]');
      check('14.03: with no signal the list still opens from the copy, and the bar says "You are offline"', await vis(bar) && /You are offline/.test(await bar.innerText()) && await vis(page.locator('td', { hasText: `Zs call back ${RUN}` }).first()), await bar.innerText().catch(() => ''));
      const row = page.locator('tr', { hasText: `Zs call back ${RUN}` }).first();
      await row.locator('input[type=checkbox]').click(); // opens "Done" (the box itself stays unticked)
      const dd = page.locator('.modal', { has: page.locator('h3', { hasText: 'Done:' }) }).last();
      await vis(dd);
      await dd.locator('button', { hasText: 'Spoke' }).first().click();
      await dd.locator('.modal-foot button', { hasText: 'Save' }).click();
      check('14.03: "Done" with no signal is kept: "1 change waiting to be sent"', await vis(bar.filter({ hasText: '1 change waiting' })), await bar.innerText().catch(() => ''));
      await page.screenshot({ path: path.join(SHOTS, 'offline-bar.png') });
      await ctx.setOffline(false);
      let doneOnServer = false;
      for (let i = 0; i < 20 && !doneOnServer; i += 1) { await page.waitForTimeout(500); doneOnServer = !!(await DB.one('SELECT "id" FROM "CrmTask" WHERE "id" = ? AND "status" = \'Done\'', taskId)); } // eslint-disable-line no-await-in-loop
      check('14.03: back online, the queued "Done" reaches the server by itself', doneOnServer);
      await ctx.close();
    }
    // ---- phone width -------------------------------------------------------------------------------------------------------------
    {
      const { ctx, page } = await open(A, '/crm/leads', { viewport: { width: 375, height: 812 } });
      await openLead(page, LEAD);
      await vis(page.locator('[data-testid="crm-ai-predict"]'), 90000);
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check('phone width (375 px): the lead record with the new AI box has no sideways page scroll', wide <= 2, wide);
      await page.screenshot({ path: path.join(SHOTS, 'phone-lead.png') });
      await page.goto(`http://localhost:${WEB}/crm/followups`, { waitUntil: 'commit' });
      await vis(page.locator('h1', { hasText: 'Follow-ups' }), 60000);
      await page.waitForTimeout(1500);
      const wide2 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check('phone width: Follow-ups (with the Visits tab) has no sideways page scroll', wide2 <= 2, wide2);
      await ctx.close();
    }
    // ---- the Sales manager: dashboard and settings ------------------------------------------------------------------------------
    {
      const { ctx, page } = await open(M, '/crm/dashboard');
      check('09.13: the manager\'s dashboard shows "Unusual changes last week"', await vis(page.locator('[data-testid="crm-anomalies"]'), 90000) && /fell/.test(await page.locator('[data-testid="crm-anomalies"]').innerText()), await page.locator('[data-testid="crm-anomalies"]').innerText().catch(() => ''));
      await page.locator('.tabs .tab', { hasText: 'Forecast & funnel' }).click();
      const fc = page.locator('[data-testid="crm-ai-forecast"]');
      check('09.07: Forecast & funnel opens with the AI forecast (3 months, likely / low-high, by stage % to compare)', await vis(fc) && /AI forecast/.test(await fc.innerText()) && /by stage %/.test(await fc.innerText()));
      await page.screenshot({ path: path.join(SHOTS, 'dashboard-forecast.png') });
      await page.locator('button', { hasText: '⚙ Settings' }).click();
      const ps = page.locator('[data-testid="crm-plus-settings"]');
      check('CRM settings: the wave E switches are there and a Sales manager cannot change them', await vis(ps) && /Only an Admin turns these on or off/.test(await ps.innerText()) && await ps.locator('input[type=checkbox]:not([disabled])').count() === 0);
      await ctx.close();
    }
    // ---- the Admin turns calendar sync on ---------------------------------------------------------------------------------------
    {
      const { ctx, page } = await open(X, '/crm/dashboard');
      await vis(page.locator('button', { hasText: '⚙ Settings' }), 90000);
      await page.locator('button', { hasText: '⚙ Settings' }).click();
      const ps = page.locator('[data-testid="crm-plus-settings"]');
      await vis(ps);
      const box = ps.locator('label', { hasText: 'Calendar sync' }).locator('input');
      check('the Admin sees the switches OFF and can turn calendar sync on', !(await box.isChecked()) && !(await box.isDisabled()));
      await box.click(); // saved on the server first, then ticked
      check('...it is saved', await vis(page.locator('.toast', { hasText: 'Saved.' })));
      check('...and the redirect addresses for the Google / Microsoft app are shown', /\/api\/crm\/pluse\/calendar\/callback\/google/.test(await ps.innerText()));
      await ctx.close();
    }
  } finally {
    await browser.close().catch(() => {});
  }
  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.log('FAIL  crashed:', e && e.stack); await stop(1); });
