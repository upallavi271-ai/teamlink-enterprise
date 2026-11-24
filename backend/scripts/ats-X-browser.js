#!/usr/bin/env node
/**
 * BROWSER SMOKE of contract staffing (ATS wave 2, builder X): Clients & Requirements > Contract staff and the two portal tabs.
 * A private sandbox server (copy of the sandbox database) + `vite preview` of the built frontend in front of it + Edge (headless).
 * Run `npx vite build` in frontend first.
 *   TEST_SOURCE_DB=<sandbox.db> TEST_PORT=<port> node scripts/ats-X-browser.js      (screenshots: $SHOTS or <tmp>/ats-x-shots)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const FRONT = path.resolve(BACK, '..', 'frontend');
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'ats-x-shots');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-atsx-br-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT || (4300 + Math.floor(Math.random() * 490)));
const WEB = PORT + 1;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'atsx-browser', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
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
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, k) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + k); return iso(d); };
const MONDAY = (() => { const d = new Date(`${iso(new Date())}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return iso(d); })();
const START = addDays(MONDAY, -14);

(async () => {
  const mk = (tag, data) => prisma.user.create({ data: { name: `Sxb ${tag} ${RUN}`, email: `sxb.${tag}.${RUN}@sxb-test.in`, username: `sxb.${tag}.${RUN}@sxb-test.in`, passwordHash: 'x', status: 'Active', passwordChangedAt: new Date(Date.now() - 3600e3), ...data } });
  const sa = await mk('admin', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', atsAccess: true });
  const tl = await mk('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'IT', atsScopeDepartments: 'IT', atsAccess: true });
  const rec = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'IT', atsScopeDepartments: 'IT', atsAccess: true });
  const bde = await mk('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE', atsAccess: true });
  const mgr = await mk('mgr', { role: 'MANAGER', atsRole: 'MANAGER', atsDepartment: 'IT', atsScopeDepartments: 'IT', atsAccess: true });
  const client = await prisma.client.create({ data: { name: `Sxb Logistics ${RUN}`, ownerDepartment: 'IT', agreementStatus: 'ACTIVE', gst: '29ABCDE1234F1Z5', bdeOwner: bde.name } });
  const req = await prisma.requirement.create({ data: { title: `Sxb Forklift Operator ${RUN}`, clientId: client.id, department: 'IT', status: 'OPEN', internal: false, employmentType: 'Contract', jobPreference: 'Contract', tlId: tl.id, tl: tl.name, recruiterId: rec.id, bdeId: bde.id, reqCode: `SXB-${RUN}`.toUpperCase().slice(0, 14), openings: 2 } });
  const cand = await prisma.candidate.create({ data: { name: `Sxb Lakshmi ${RUN}`, phone: `7${String(Date.now()).slice(-9)}`, email: `sxb.${RUN}@sxb-cand.in`, skills: 'forklift' } });
  const app = await prisma.application.create({ data: { candidateId: cand.id, requirementId: req.id, ownerRecruiterId: rec.id, stage: 'JOINED', joiningDate: START, joinedAt: new Date(`${START}T09:00:00Z`), hiringType: 'Client Placement' } });
  await prisma.candidateDocument.create({ data: { candidateId: cand.id, docType: 'ID', name: 'PAN card' } });
  await prisma.candidateDocument.create({ data: { candidateId: cand.id, docType: 'Offer', name: 'Offer letter' } });
  const base = { passwordHash: 'x', status: 'Active', passwordChangedAt: new Date(Date.now() - 3600e3) };
  const cl = await prisma.user.create({ data: { ...base, name: `Sxb Client Login ${RUN}`, email: `sxb.cl.${RUN}@sxb-test.in`, username: `sxb.cl.${RUN}@sxb-test.in`, role: 'CLIENT', atsRole: 'CLIENT', atsAccess: true, clientId: client.id, portalType: 'REVIEWER', portalPerms: 'VIEW,DECIDE' } });
  const cu = await prisma.user.create({ data: { ...base, name: `Sxb Lakshmi Login ${RUN}`, email: `sxb.cu.${RUN}@sxb-test.in`, username: `sxb.cu.${RUN}@sxb-test.in`, role: 'CANDIDATE', atsRole: 'CANDIDATE', candidateId: cand.id } });

  const be = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(be);
  if (!(await waitFor(`http://localhost:${PORT}/api/health`))) { console.log('FAIL  the sandbox server did not answer (set TEST_PORT)'); await stop(1); return; }
  const web = spawn(process.execPath, [path.join(FRONT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(WEB), '--strictPort', '--host', 'localhost'], { cwd: FRONT, env: { ...process.env, API_PROXY: `http://localhost:${PORT}` }, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(web);
  if (!(await waitFor(`http://localhost:${WEB}/`))) { console.log('FAIL  the web server did not answer'); await stop(1); return; }
  const tokenOf = async (u) => jwt.sign({ ...tokenPayload(await resolveIdentity(u.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const api = async (u, method, url, body) => { const r = await fetch(`http://localhost:${PORT}/api${url}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${await tokenOf(u)}` }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
  // a rate, and one earlier week already approved (so Pay & bill and Billing have something)
  await api(tl, 'POST', `/ats/staffing/contractors/${app.id}/rates`, { effectiveFrom: START, unit: 'Hour', payRate: 250, billRate: 400, loadPercent: 12 });
  await api(tl, 'PUT', `/ats/staffing/contractors/${app.id}`, { poNumber: 'PO-SXB-1' });
  const w0 = await api(rec, 'PUT', `/ats/staffing/contractors/${app.id}/weeks/${START}`, { hours: [8, 8, 8, 8, 8, 0, 0], submit: true });
  await api(tl, 'POST', `/ats/staffing/timesheets/${w0.body.timesheet.id}/decision`, { approve: true });

  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const open = async (user, urlPath, viewport = { width: 1280, height: 900 }) => {
    const token = await tokenOf(user);
    const ctx = await browser.newContext({ viewport });
    await ctx.addInitScript((t) => { try { localStorage.setItem('tl_token', t); } catch (e) { /* none */ } }, token);
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${WEB}${urlPath}`, { waitUntil: 'commit', timeout: 120000 });
    return { ctx, page };
  };
  const seen = (loc, t = 60000) => loc.waitFor({ state: 'visible', timeout: t }).then(() => true).catch(() => false);
  try {
    // the contractor fills in and sends this week's hours in the candidate portal
    {
      const { ctx, page } = await open(cu, '/my-applications');
      const tab = page.locator('button[role=tab]', { hasText: 'My timesheets' });
      check('Contractor: the candidate portal has a "My timesheets" tab', await seen(tab), await page.evaluate(() => document.body.innerText.slice(0, 300)).catch(() => ''));
      await tab.click();
      const week = page.locator('[data-testid="stx-my-week"]');
      check('Contractor: the week editor with seven days', await seen(week) && (await week.locator('input[type=number]').count()) === 7);
      const prev = addDays(MONDAY, -7);
      await week.locator('select').selectOption(prev);
      for (let i = 0; i < 5; i += 1) await week.locator('input[type=number]').nth(i).fill('9'); // eslint-disable-line no-await-in-loop
      check('Contractor: the total adds up (45 h)', await seen(week.locator('b', { hasText: '45 h' }), 10000));
      await week.locator('button', { hasText: 'Send for approval' }).click();
      check('Contractor: sent for approval', await seen(page.locator('.mkb-flash.good', { hasText: 'Sent for approval' }), 20000));
      check('Contractor: the bill rate is never on the page', !(await page.locator('body').innerText()).includes('400'));
      await page.screenshot({ path: path.join(SHOTS, 'contractor-portal.png') });
      await ctx.close();
    }
    // the client approves it in the client portal
    {
      const { ctx, page } = await open(cl, '/client-portal');
      const tab = page.locator('button[role=tab]', { hasText: 'Timesheets' });
      check('Client: the client portal has a "Timesheets" tab with the waiting count', await seen(tab) && /\(1\)/.test(await tab.innerText()), await page.evaluate(() => document.body.innerText.slice(0, 300)).catch(() => ''));
      await tab.click();
      const box = page.locator('[data-testid="stx-client-ts"]');
      check('Client: the contractor\'s week is waiting, 45 h', await seen(box.locator('.stx-week', { hasText: cand.name })) && (await box.innerText()).includes('45 h'));
      check('Client: no pay rate or margin on the page', !/margin|pay rate/i.test(await box.innerText()));
      await box.locator('button', { hasText: 'Approve' }).first().click();
      check('Client: approved', await seen(page.locator('.mkb-flash.good', { hasText: 'Approved' }), 20000));
      await page.screenshot({ path: path.join(SHOTS, 'client-portal.png') });
      await ctx.close();
    }
    // the TL: tab under Clients & Requirements, contractors with margin, shifts, billing
    {
      const { ctx, page } = await open(tl, '/ats/contract-staff');
      check('TL: Contract staff opens as a tab of Clients & Requirements (no new sidebar item)', await seen(page.locator('[data-testid="stx-page"]')) && await seen(page.locator('.module-tabs [role=tab]', { hasText: 'Contract staff' })));
      const row = page.locator('[data-testid="stx-contractors"] tr', { hasText: cand.name });
      check('TL: the contractor row shows bill rate, pay rate and margin', await seen(row) && /₹400\/hour/.test(await row.innerText()) && /₹250/.test(await row.innerText()) && /%/.test(await row.innerText()), await row.innerText().catch(() => ''));
      await row.locator('button', { hasText: 'Open' }).click();
      check('TL: the contractor panel shows the contract and the rate history', await seen(page.locator('[data-testid="stx-contractor"] td', { hasText: START })));
      await page.screenshot({ path: path.join(SHOTS, 'tl-contractors.png') });
      await page.locator('.stx [role=tab]', { hasText: 'Shifts' }).click();
      const book = page.locator('[data-testid="stx-book"]');
      await seen(book);
      await book.locator('select').first().selectOption(app.id);
      await book.locator('input[type=date]').fill(addDays(MONDAY, 2));
      await book.locator('input[placeholder="Picker, nurse …"]').fill('Forklift');
      await book.locator('button', { hasText: 'Book' }).click();
      check('TL: a shift is booked from the form and shows in the week calendar', await seen(page.locator('.stx-shift', { hasText: '09:00-18:00' }), 20000));
      await page.screenshot({ path: path.join(SHOTS, 'tl-shifts.png') });
      await page.locator('.stx [role=tab]', { hasText: 'Billing' }).click();
      const chk = page.locator('[data-testid="stx-check"] tr', { hasText: cand.name });
      check('TL: the check before billing says Ready', await seen(chk) && /Ready/.test(await chk.innerText()), await chk.innerText().catch(() => ''));
      const make = page.locator('[data-testid="stx-unbilled"] button', { hasText: 'Make batch' });
      check('TL: two approved weeks wait to be billed', await seen(make) && /\b2\b/.test(await page.locator('[data-testid="stx-unbilled"] tbody tr').first().innerText()));
      await make.click();
      check('TL: the batch is made with an STF number', await seen(page.locator('.mkb-flash.good', { hasText: /Batch STF-\d{4}-\d{4} made/ }), 20000));
      const brow = page.locator('[data-testid="stx-batches"] tbody tr').first();
      check('TL: the batch row has the files, Send and a disabled "Post into Accounts"', await seen(brow) && (await brow.locator('button', { hasText: 'Tally XML' }).count()) === 1 && await brow.locator('button', { hasText: 'Post into Accounts' }).isDisabled());
      check('TL: the Accounts boundary is said on the page', /founder decision/.test(await page.locator('[data-testid="stx-batches"]').innerText()));
      await page.screenshot({ path: path.join(SHOTS, 'tl-billing.png'), fullPage: true });
      await page.locator('.stx button', { hasText: 'More' }).first().click();
      await page.locator('[role=menuitem]', { hasText: 'VMS' }).click();
      check('TL: the VMS tab says it is not set up yet (needs the founder\'s supplier account)', await seen(page.locator('[data-testid="stx-vms"]', { hasText: 'needs founder credentials' })));
      await ctx.close();
    }
    // the BDE: the bill side only
    {
      const { ctx, page } = await open(bde, '/ats/contract-staff');
      const t = page.locator('[data-testid="stx-contractors"]');
      check('BDE: sees the contractor with the bill rate but no pay rate or margin column', await seen(t.locator('tr', { hasText: cand.name })) && !/Pay rate|Margin/.test(await t.locator('thead').innerText()));
      await ctx.close();
    }
    // the Manager: view only; the Admin: settings all OFF
    {
      const { ctx, page } = await open(mgr, '/ats/contract-staff?tab=timesheets');
      check('Manager: the page says view only and offers no week editor', await seen(page.locator('text=Your login is view only here.')) && (await page.locator('[data-testid="stx-enter"]').count()) === 0);
      await ctx.close();
      const a = await open(sa, '/ats/contract-staff?tab=settings');
      const s = a.page.locator('[data-testid="stx-settings"]');
      check('Admin: the settings list every switch, and the ones that tell people or automate are Off', await seen(s.locator('li', { hasText: 'Timesheet reminders' })) && (await s.locator('li', { hasText: 'Timesheet reminders' }).innerText()).includes('Off') && (await s.locator('li', { hasText: 'VMS sync every 30 minutes' }).innerText()).includes('Off'));
      await a.page.screenshot({ path: path.join(SHOTS, 'admin-settings.png'), fullPage: true });
      await a.ctx.close();
    }
    // phone width
    {
      const { ctx, page } = await open(tl, '/ats/contract-staff?tab=timesheets', { width: 390, height: 844 });
      await seen(page.locator('[data-testid="stx-timesheets"]'));
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check('Phone width: the page does not scroll sideways (tables scroll inside their box)', wide <= 2, wide);
      await page.screenshot({ path: path.join(SHOTS, 'phone-timesheets.png'), fullPage: true });
      await ctx.close();
    }
  } finally {
    await browser.close().catch(() => {});
  }
  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.log('FAIL  crashed:', e && e.message); console.log(`\n${total - failed}/${total + 1} passed`); await stop(1); });
