#!/usr/bin/env node
/**
 * BROWSER SMOKE of the dashboard search bar (founder 2026-11-20): the big bar is on the dashboards of a Recruiter, a TL and an Admin, and typing opens
 * the dropdown with the person's candidate. A private sandbox server (copy of the sandbox database) + the Vite dev server in front of it + Edge.
 *   TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4301 node scripts/ats-dashboard-search-smoke.js     (screenshots: docs/dash-search-2026-11-20/)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const FRONT = path.resolve(BACK, '..', 'frontend');
const SHOTS = path.resolve(BACK, '..', 'docs', 'dash-search-2026-11-20');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-dash-smoke-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT || 4301);
const WEB = PORT + 1;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'dash-smoke', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
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
  const mk = (tag, data, emp) => prisma.user.create({ data: { name: `Hz ${tag} ${RUN}`, email: `hz.${tag}.${RUN}@hz-test.in`, username: `hz.${tag}.${RUN}@hz-test.in`, passwordHash: 'x', status: 'Active', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3), ...data } })
    .then(async (u) => { if (emp) await prisma.employee.create({ data: { employeeCode: `HZ-${tag}-${RUN}`, name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', department: 'IT', email: u.email, ...emp } }); return u; });
  const sa = await mk('admin', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', accountsAccess: true, accountsRole: 'SUPER_ADMIN' });
  const tl = await mk('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'IT', atsScopeDepartments: 'IT', atsScopeTeams: `Hz Team ${RUN}` }, { designation: 'TL', department: 'IT', team: `Hz Team ${RUN}` });
  const rec = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'IT', atsScopeDepartments: 'IT' }, { tl: tl.name, department: 'IT', team: `Hz Team ${RUN}` });
  const client = await prisma.client.create({ data: { name: `Hzorbit Systems ${RUN}`, ownerDepartment: 'IT', agreementStatus: 'ACTIVE' } });
  const req = await prisma.requirement.create({ data: { title: `Hzcloud Engineer ${RUN}`, clientId: client.id, department: 'IT', status: 'RECRUITER_ASSIGNED', tlId: tl.id, tl: tl.name, recruiterId: rec.id, reqCode: `HZ-${RUN}`.toUpperCase() } });
  const cand = await prisma.candidate.create({ data: { name: `Hzperson Quillfeather ${RUN}`, phone: `8${String(Date.now()).slice(-9)}`, email: `hz.${RUN}@hz-test.in`, skills: 'Kubernetes' } });
  await prisma.application.create({ data: { candidateId: cand.id, requirementId: req.id, ownerRecruiterId: rec.id, stage: 'SHARED_WITH_CLIENT' } });

  const be = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(be);
  if (!(await waitFor(`http://localhost:${PORT}/api/health`))) { console.log('FAIL  the sandbox server did not answer (set TEST_PORT)'); await stop(1); return; }
  const web = spawn(process.execPath, [path.join(FRONT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(WEB), '--strictPort', '--host', 'localhost'], { cwd: FRONT, env: { ...process.env, API_PROXY: `http://localhost:${PORT}` }, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(web);
  if (!(await waitFor(`http://localhost:${WEB}/`))) { console.log('FAIL  the web server did not answer'); await stop(1); return; }

  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  try {
    for (const [label, user, urlPath, shot] of [['Recruiter', rec, '/ats/dashboard', 'recruiter-dashboard-search.png'], ['TL', tl, '/ats/dashboard', null], ['Admin', sa, '/', 'admin-dashboard-search.png']]) {
      const token = jwt.sign({ ...tokenPayload(await resolveIdentity(user.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' }); // eslint-disable-line no-await-in-loop
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } }); // eslint-disable-line no-await-in-loop
      await ctx.addInitScript((t) => { try { localStorage.setItem('tl_token', t); localStorage.setItem('tl_recent_searches', '[]'); } catch (e) { /* none */ } }, token); // eslint-disable-line no-await-in-loop
      const page = await ctx.newPage(); // eslint-disable-line no-await-in-loop
      await page.goto(`http://localhost:${WEB}${urlPath}`, { waitUntil: 'commit', timeout: 120000 }); // eslint-disable-line no-await-in-loop
      const errs = []; page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160))); page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });
      const bar = page.locator('[data-testid="dash-search-bar"] input');
      const seen = await bar.waitFor({ state: 'visible', timeout: 45000 }).then(() => true).catch(() => false); // eslint-disable-line no-await-in-loop
      check(`${label}: the big search bar is on the dashboard`, seen, seen ? undefined : { url: page.url(), text: (await page.evaluate(() => document.body.innerText.slice(0, 200)).catch(() => '')), errs: errs.slice(0, 4) });
      if (seen) {
        const ph = await bar.getAttribute('placeholder'); // eslint-disable-line no-await-in-loop
        check(`${label}: the bar says what it searches`, /Search anything/.test(ph || ''), ph);
        const box = await bar.boundingBox(); // eslint-disable-line no-await-in-loop
        check(`${label}: the bar is prominent (wide) and near the top of the page`, box && box.width > 500 && box.y < 260, box);
        await bar.click(); // eslint-disable-line no-await-in-loop
        await bar.type('quillfeather', { delay: 30 }); // eslint-disable-line no-await-in-loop
        const row = page.locator('.sr-panel .sr-row', { hasText: `Hzperson Quillfeather ${RUN}` }).first();
        const shown = await row.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false); // eslint-disable-line no-await-in-loop
        check(`${label}: typing opens the dropdown with the candidate`, shown);
        if (shot) await page.screenshot({ path: path.join(SHOTS, shot) }); // eslint-disable-line no-await-in-loop
        if (shown) {
          await row.click(); // eslint-disable-line no-await-in-loop
          const drawerUp = await page.locator('[data-testid="history-drawer-body"]').waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false); // eslint-disable-line no-await-in-loop
          check(`${label}: clicking the result opens the candidate's complete history in the drawer, over the dashboard`, drawerUp && decodeURIComponent(page.url()).includes(`open=candidate:${cand.id}`) && (await page.locator('[data-testid="dash-search-bar"] input').count()) === 1, page.url()); // eslint-disable-line no-await-in-loop
        }
      }
      await ctx.close(); // eslint-disable-line no-await-in-loop
    }

    // ---- THE HISTORY OPENS IN PLACE (drawer over the results page; the page underneath does not move)
    {
      const token = jwt.sign({ ...tokenPayload(await resolveIdentity(sa.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 420 } });
      await ctx.addInitScript((t) => { try { localStorage.setItem('tl_token', t); } catch (e) { /* none */ } }, token);
      const page = await ctx.newPage();
      await page.goto(`http://localhost:${WEB}/ats/search?q=hz`, { waitUntil: 'commit', timeout: 120000 });
      const list = page.locator('[data-testid="results-list"]');
      const there = await list.waitFor({ state: 'visible', timeout: 120000 }).then(() => true).catch(() => false);
      check('results page: the History groups are listed directly under the box', there);
      if (there) {
        const titles = await page.locator('[data-testid="results-list"] .sr-gtitle').allTextContents();
        check('results page: People, Clients, Requirements, Candidates come first, in that order', ['People', 'Clients', 'Requirements', 'Candidates'].every((t) => titles.includes(t)) && titles.indexOf('People') < titles.indexOf('Clients') && titles.indexOf('Clients') < titles.indexOf('Requirements') && titles.indexOf('Requirements') < titles.indexOf('Candidates'), titles);
        check('results page: the record lists (interviews, invoices ...) are collapsed below, not drawn', !titles.some((t) => /Interviews|Invoices|Other/.test(t)), titles);
        const snap = () => page.evaluate(() => { let n = window.scrollY; document.querySelectorAll('*').forEach((el) => { if (el.scrollTop > 0 && !el.closest('.hxd-wrap')) n += el.scrollTop; }); return n; });
        const row = page.locator('[data-testid="results-list"] .sr-row', { hasText: `Hzperson Quillfeather ${RUN}` }).first();
        await row.locator('a.btn-primary').scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        const before = await snap();
        await row.locator('a.btn-primary').click();
        const drawer = page.locator('[data-testid="history-drawer-body"]');
        const opened = await drawer.waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false);
        check('clicking a History result opens it in a drawer, in place', opened);
        check('the address holds ?q=...&open=candidate:<id>', /[?&]q=hz/.test(page.url()) && decodeURIComponent(page.url()).includes(`open=candidate:${cand.id}`), page.url());
        const dbox = await page.locator('.hxd-panel').boundingBox();
        check('the drawer is about 80% of the width and full height', dbox && dbox.width > 0.7 * 1280 && dbox.width < 0.9 * 1280 && dbox.height >= 400, dbox);
        check('the results list is still in the page underneath, and the scroll position did not move', (await list.count()) === 1 && Math.abs((await snap()) - before) <= 1, [before, await snap()]);
        await page.locator('.hxd-body', { hasText: 'applications' }).first().waitFor({ state: 'visible', timeout: 60000 }).catch(() => null);
        const body = await page.locator('.hxd-body').innerText();
        check('the drawer shows the candidate\'s complete history', /Hzperson Quillfeather/.test(body) && /applications/i.test(body), body.slice(0, 200));
        await page.screenshot({ path: path.join(SHOTS, 'history-drawer-over-results.png') });
        await page.keyboard.press('Escape');
        const closedEsc = await drawer.waitFor({ state: 'detached', timeout: 10000 }).then(() => true).catch(() => false);
        check('Esc closes the drawer; the results and the query are still there', closedEsc && !page.url().includes('open=') && /q=hz/.test(page.url()) && (await list.count()) === 1, page.url());
        await row.locator('a.btn-primary').click();
        await drawer.waitFor({ state: 'visible', timeout: 30000 });
        await page.goBack();
        const closedBack = await drawer.waitFor({ state: 'detached', timeout: 10000 }).then(() => true).catch(() => false);
        check('the browser Back button closes the drawer and stays on the results page', closedBack && /\/ats\/search\?q=hz/.test(page.url()) && !page.url().includes('open='), page.url());
        await row.locator('a.btn-primary').click();
        await drawer.waitFor({ state: 'visible', timeout: 30000 });
        await page.reload({ waitUntil: 'commit', timeout: 120000 });
        const restored = await page.locator('[data-testid="history-drawer-body"]').waitFor({ state: 'visible', timeout: 120000 }).then(() => true).catch(() => false);
        const listBack = await page.locator('[data-testid="results-list"]').waitFor({ state: 'attached', timeout: 60000 }).then(() => true).catch(() => false);
        check('Refresh restores the query, the results and the open drawer', restored && listBack && /q=hz/.test(page.url()) && decodeURIComponent(page.url()).includes(`open=candidate:${cand.id}`), page.url());
        await page.keyboard.press('Escape');
        await page.locator('.hxd-wrap').waitFor({ state: 'detached', timeout: 10000 }).catch(() => null);
        const newTab = ctx.waitForEvent('page', { timeout: 15000 }).catch(() => null);
        await row.locator('a.sr-name').click({ modifiers: ['Control'] });
        const tab = await newTab;
        check('Ctrl-click opens the full History page in a new tab', !!tab && /\/ats\/history\/candidate\//.test(tab.url()), tab && tab.url());
        await page.locator('input[aria-label="Search"]').click();
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        const kbd = await page.locator('[data-testid="history-drawer-body"]').waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false);
        check('keyboard: Down then Enter opens the first result in the drawer', kbd);
        await page.keyboard.press('Escape');
        // a client search lists the client's candidates (never "Candidates (0)"), and the filter bar is on the page
        await page.goto(`http://localhost:${WEB}/ats/search?q=hzorbit`, { waitUntil: 'commit', timeout: 120000 });
        const tabs = page.locator('.srp-tabs');
        const tabsUp = await tabs.waitFor({ state: 'visible', timeout: 120000 }).then(() => true).catch(() => false);
        const tabText = tabsUp ? await tabs.innerText() : '';
        check('a client search shows its candidates in the Candidates tab (not 0)', /Candidates \(([1-9]\d*)\)/.test(tabText), tabText);
        check('the shared filter bar is on the results page', (await page.locator('.fbar').count()) === 1);
        const viaText = await page.locator('[data-testid="results-list"]').innerText().catch(() => '');
        check('each candidate row says why it matched ("via client ...")', /via client Hzorbit/i.test(viaText), viaText.slice(0, 300));
      }
      await ctx.close();
      const pctx = await browser.newContext({ viewport: { width: 375, height: 700 } });
      await pctx.addInitScript((t) => { try { localStorage.setItem('tl_token', t); } catch (e) { /* none */ } }, token);
      const mp = await pctx.newPage();
      await mp.goto(`http://localhost:${WEB}/ats/search?q=hz&open=candidate:${cand.id}`, { waitUntil: 'commit', timeout: 120000 });
      const mdrawer = await mp.locator('.hxd-panel').waitFor({ state: 'visible', timeout: 120000 }).then(() => true).catch(() => false);
      const mbox = mdrawer ? await mp.locator('.hxd-panel').boundingBox() : null;
      check('phone (375 px): the drawer is full screen with a Back arrow', mbox && mbox.width >= 374 && (await mp.locator('.hxd-back-arrow').isVisible()), mbox);
      await pctx.close();
    }

    // a phone-width page has no sideways scroll with the bar on it
    const phone = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const token = jwt.sign({ ...tokenPayload(await resolveIdentity(rec.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
    await phone.addInitScript((t) => { try { localStorage.setItem('tl_token', t); } catch (e) { /* none */ } }, token);
    const pp = await phone.newPage();
    await pp.goto(`http://localhost:${WEB}/ats/dashboard`, { waitUntil: 'commit', timeout: 120000 });
    await pp.locator('[data-testid="dash-search-bar"] input').waitFor({ state: 'visible', timeout: 120000 }).catch(() => null);
    const overflow = await pp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('phone width (375 px): the page with the bar has no sideways scroll', overflow <= 1, overflow);
  } catch (e) { failed += 1; total += 1; console.log('FAIL  crashed', e && e.stack ? e.stack.slice(0, 700) : e); }
  await browser.close().catch(() => {});
  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
