#!/usr/bin/env node
/**
 * BROWSER SMOKE of ATS wave 2 Z (Edge, headless): the branch switch on Requirements / Clients (05.11), the ATS in Telugu and Hindi (13.06),
 * the App catalogue and its Set up link (14.03), the boards in the catalogue (14.15), Google / Microsoft 365 calendars + contacts (07.01 / 14.05),
 * the vendor connectors (14.09 / 14.10), the Phone app card (15.13), the Region & SLA evidence (15.11 / 15.16), the catalogue at phone width.
 * A private sandbox server (copy of the sandbox database) + `vite preview` of the built frontend in front of it + Edge.
 *   (cd frontend && npx vite build)   then   TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4652 node scripts/ats-Z-browser.js   (screenshots: docs/ats-wave2-Z/)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const FRONT = path.resolve(BACK, '..', 'frontend');
const SHOTS = path.resolve(BACK, '..', 'docs', 'ats-wave2-Z');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-ats-z-br-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT || 4652);
const WEB = PORT + 1;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'ats-z-browser', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`, INTEGRATION_SECRET_KEY: 'ats-z-browser-secret-key-0123456789' };
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
  if (!fs.existsSync(path.join(FRONT, 'dist', 'index.html'))) { console.log('FAIL  build the frontend first: (cd frontend && npx vite build)'); await stop(1); return; }
  const mk = (tag, data) => prisma.user.create({ data: { name: `Zb ${tag} ${RUN}`, email: `zb.${tag}.${RUN}@zb-test.in`, username: `zb.${tag}.${RUN}@zb-test.in`, passwordHash: 'x', status: 'Active', hrmsRole: 'NONE', atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3), ...data } });
  const sa = await mk('admin', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', atsAccess: true });
  const c1 = await prisma.client.create({ data: { name: `Zbhyd Clinics ${RUN}`, ownerDepartment: 'IT', agreementStatus: 'ACTIVE' } });
  const c2 = await prisma.client.create({ data: { name: `Zbpune Motors ${RUN}`, ownerDepartment: 'IT', agreementStatus: 'ACTIVE' } });
  const r1 = await prisma.requirement.create({ data: { title: `Zbhyd Nurse ${RUN}`, clientId: c1.id, department: 'IT', status: 'OPEN', reqCode: `ZBH-${RUN}`.toUpperCase().slice(0, 14), openings: 1 } });
  await prisma.requirement.create({ data: { title: `Zbpune Fitter ${RUN}`, clientId: c2.id, department: 'IT', status: 'OPEN', reqCode: `ZBP-${RUN}`.toUpperCase().slice(0, 14), openings: 1 } });

  const be = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(be);
  if (!(await waitFor(`http://localhost:${PORT}/api/health`))) { console.log('FAIL  the sandbox server did not answer (set TEST_PORT)'); await stop(1); return; }
  const web = spawn(process.execPath, [path.join(FRONT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(WEB), '--strictPort', '--host', 'localhost'], { cwd: FRONT, env: { ...process.env, API_PROXY: `http://localhost:${PORT}` }, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(web);
  if (!(await waitFor(`http://localhost:${WEB}/`))) { console.log('FAIL  the web server did not answer'); await stop(1); return; }
  const token = jwt.sign({ ...tokenPayload(await resolveIdentity(sa.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const api = (method, url, body) => fetch(`http://localhost:${PORT}/api${url}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
  const HYD = `Zb Hyderabad ${RUN}`;
  const prev = await api('GET', '/ats-plus/branches');
  await api('PUT', '/ats-plus/branches', { branches: [...(prev.branches || []), { name: HYD, city: 'Hyderabad' }, { name: `Zb Pune ${RUN}`, city: 'Pune' }] });
  await api('POST', '/ats-plus/branches/assign', { entity: 'Client', ids: [c1.id], branch: HYD });

  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const open = async (urlPath, { lang = 'en', width = 1280 } = {}) => {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    await ctx.addInitScript(([t, l]) => { try { localStorage.setItem('tl_token', t); localStorage.setItem('tl_lang', l); if (!sessionStorage.getItem('zb-init')) { localStorage.removeItem('tl_ats_branch'); sessionStorage.setItem('zb-init', '1'); } } catch (e) { /* none */ } }, [token, lang]);
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${WEB}${urlPath}`, { waitUntil: 'commit', timeout: 120000 });
    return { ctx, page };
  };
  const seen = (page, sel, ms = 60000) => page.locator(sel).first().waitFor({ state: 'visible', timeout: ms }).then(() => true).catch(() => false);
  try {
    // ---- 05.11 the branch switch on Requirements and Clients
    {
      const { ctx, page } = await open('/requirements');
      const up = await seen(page, '[data-testid="branch-switch"] select');
      check('05.11 Requirements: the branch switch is on the list', up);
      if (up) {
        await page.locator('[data-testid="branch-switch"] select').selectOption(HYD);
        const note = await seen(page, '[data-testid="branch-switch-note"]', 20000);
        // the list and its panels follow the switch: only Hyderabad's job / client is named (the rows, Top clients), never Pune's
        for (let i = 0; i < 180 && !/Zbhyd (Nurse|Clinics)/.test(await page.locator('body').innerText()); i += 1) await page.waitForTimeout(500); // eslint-disable-line no-await-in-loop
        const body = await page.locator('body').innerText();
        check('05.11 picking Hyderabad: only that branch\'s job / client is shown (Pune\'s is not)', note && (body.includes(`Zbhyd Nurse ${RUN}`) || body.includes(`Zbhyd Clinics ${RUN}`)) && !body.includes(`Zbpune Fitter ${RUN}`) && !body.includes(`Zbpune Motors ${RUN}`), body.slice(-600));
        await page.screenshot({ path: path.join(SHOTS, 'branch-switch-requirements.png') });
        await page.goto(`http://localhost:${WEB}/clients`, { waitUntil: 'commit' });
        const cup = await seen(page, '[data-testid="branch-switch"] select');
        await page.locator(`text=Zbhyd Clinics ${RUN}`).first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => null);
        const cb = await page.locator('body').innerText();
        const kept = await page.locator('[data-testid="branch-switch"] select').inputValue().catch(() => '');
        check('05.11 Clients: the same working branch follows the person (kept), only its client listed', cup && kept === HYD && cb.includes(`Zbhyd Clinics ${RUN}`) && !cb.includes(`Zbpune Motors ${RUN}`), { kept });
      }
      await ctx.close();
    }
    // ---- 13.06 Telugu and Hindi
    {
      const { ctx, page } = await open('/candidates', { lang: 'te' });
      const h = await page.locator('h1', { hasText: 'అభ్యర్థులు & పైప్‌లైన్' }).first().waitFor({ state: 'visible', timeout: 60000 }).then(() => true).catch(() => false);
      check('13.06 Telugu: the Candidates & Pipeline heading is in Telugu', h, await page.locator('h1').first().innerText().catch(() => ''));
      const btn = await page.locator('button', { hasText: '+ అభ్యర్థిని జోడించు' }).count();
      await page.locator('text=/త్వరిత చర్యలు|అభ్యర్థుల పైప్‌లైన్|దిగుమతి/').first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => null);
      const exp = (await page.locator('body').innerText()).match(/త్వరిత చర్యలు|అభ్యర్థుల పైప్‌లైన్|దిగుమతి|ఎగుమతి/g) || [];
      check('13.06 Telugu: the Add candidate button and the panels and tools of the page are in Telugu', btn >= 1 && exp.length >= 1, { btn, exp });
      await page.screenshot({ path: path.join(SHOTS, 'telugu-candidates.png') });
      await page.goto(`http://localhost:${WEB}/ats/calendar`, { waitUntil: 'commit' });
      const cal = await page.locator('h1', { hasText: 'ఇంటర్వ్యూ క్యాలెండర్' }).first().waitFor({ state: 'visible', timeout: 60000 }).then(() => true).catch(() => false);
      check('13.06 Telugu: Interview Calendar heading in Telugu', cal);
      await ctx.close();
      const h2 = await open('/requirements', { lang: 'hi' });
      const add = await h2.page.locator('button', { hasText: '+ आवश्यकता जोड़ें' }).first().waitFor({ state: 'visible', timeout: 60000 }).then(() => true).catch(() => false);
      const txt = await h2.page.locator('body').innerText();
      check('13.06 Hindi: Requirements shows the Hindi Add button, and a status / filter word in Hindi', add && /(फ़िल्टर|खुला|सभी)/.test(txt), txt.slice(0, 300));
      await h2.page.screenshot({ path: path.join(SHOTS, 'hindi-requirements.png') });
      await h2.ctx.close();
    }
    // ---- 14.03 App catalogue + Set up link
    {
      const { ctx, page } = await open('/admin/ats-settings?tab=integrations');
      const up = await seen(page, '[data-testid="app-card"]');
      const n = await page.locator('[data-testid="app-card"]').count();
      check('14.03 ATS settings > Integrations opens on the App catalogue: 20+ apps with a status', up && n >= 20, n);
      await page.screenshot({ path: path.join(SHOTS, 'app-catalogue.png') });
      const card = page.locator('[data-testid="app-card"][data-app="ats-bgv"]');
      const st = await card.innerText().catch(() => '');
      check('14.03 the BGV vendor card says Not set up and needs a founder account', /Not set up/.test(st) && /needs founder account/.test(st), st);
      await card.locator('a', { hasText: 'Set up' }).click();
      const modal = await page.locator('text=Background verification vendor (ATS)').first().waitFor({ state: 'visible', timeout: 60000 }).then(() => true).catch(() => false);
      check('14.03 Set up opens Administration > Integrations with that card\'s Configure window', modal && page.url().includes('channel=ats-bgv'), page.url());
      await ctx.close();
    }
    // ---- 14.15 boards, 07.01 / 14.05 workspace, 14.09 vendors
    {
      const { ctx, page } = await open('/admin/ats-settings?tab=integrations');
      await seen(page, '[data-testid="app-card"][data-app="board-apps"]');
      const boards = await page.locator('[data-testid="app-card"][data-app="board-apps"], [data-testid="app-card"][data-app="foundit"], [data-testid="app-card"][data-app="naukri"]').count();
      check('14.15 the catalogue shows the boards (Naukri, foundit) and the applications-in, each with its status', boards === 3, boards);
      await page.goto(`http://localhost:${WEB}/admin/ats-settings?tab=integrations&sub=workspace`, { waitUntil: 'commit' });
      const cals = await page.locator('h3', { hasText: 'Calendars' }).first().waitFor({ state: 'visible', timeout: 60000 }).then(() => true).catch(() => false);
      const sw = await page.locator('[data-testid="calendar-switch"]').innerText().catch(() => '');
      check('07.01 / 14.05 Google / Microsoft 365: my calendars, the booking switch (OFF) and the contacts picker', cals && /OFF/.test(sw) && (await page.locator('h3', { hasText: 'Contacts' }).count()) === 1, sw);
      await page.screenshot({ path: path.join(SHOTS, 'workspace.png') });
      await page.goto(`http://localhost:${WEB}/admin/ats-settings?tab=integrations&sub=vendors`, { waitUntil: 'commit' });
      const v = await page.locator('h3', { hasText: 'Vendor connectors' }).first().waitFor({ state: 'visible', timeout: 60000 }).then(() => true).catch(() => false);
      await page.locator('text=Not set up - needs founder credentials').first().waitFor({ state: 'visible', timeout: 60000 }).catch(() => null);
      check('14.09 / 14.10 Checks & tests: both vendor connectors with their status', v && /needs founder credentials/.test(await page.locator('body').innerText()), null);
      await ctx.close();
    }
    // ---- 15.13 phone app, 15.11 evidence
    {
      const { ctx, page } = await open('/admin/ats-settings?tab=org');
      const p = await seen(page, '[data-testid="phone-app-status"]');
      check('15.13 Organisation: the Phone app card shows 4 ATS shortcuts and the store status', p && /ATS shortcuts: 4/.test(await page.locator('[data-testid="phone-app-status"]').innerText()));
      await page.goto(`http://localhost:${WEB}/admin/ats-settings?tab=privacy`, { waitUntil: 'commit' });
      const more = page.locator('button', { hasText: /^More/ }).last();
      await more.waitFor({ state: 'visible', timeout: 60000 }).catch(() => null);
      await more.click().catch(() => null);
      await page.locator('[role="menuitem"], button', { hasText: 'Region & SLA evidence' }).first().click().catch(() => null);
      const ev = await page.locator('h3', { hasText: 'Data region: stated and seen' }).first().waitFor({ state: 'visible', timeout: 60000 }).then(() => true).catch(() => false);
      check('15.11 / 15.16 Privacy & security > Region & SLA evidence: stated vs seen, the months, the documents', ev && (await page.locator('h3', { hasText: 'Uptime against the target, month by month' }).count()) === 1 && (await page.locator('button', { hasText: 'Download the evidence pack' }).count()) === 1);
      await page.screenshot({ path: path.join(SHOTS, 'evidence.png'), fullPage: true });
      await ctx.close();
    }
    // ---- phone width
    {
      const { ctx, page } = await open('/admin/ats-settings?tab=integrations', { width: 390 });
      await seen(page, '[data-testid="app-card"]');
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check('phone width (390 px): the App catalogue does not scroll sideways', over <= 2, over);
      await page.screenshot({ path: path.join(SHOTS, 'app-catalogue-phone.png') });
      await ctx.close();
    }
  } catch (e) { check('the smoke ran without an error', false, e.stack); }
  await browser.close();
  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); console.log(`\n${total - failed}/${total + 1} passed`); await stop(1); });
