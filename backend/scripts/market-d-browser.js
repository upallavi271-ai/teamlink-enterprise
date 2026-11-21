#!/usr/bin/env node
/**
 * BROWSER SMOKE of builder D's market-wave screens (founder 2026-11-21): Administration -> ATS settings (5 tabs), Clients -> Business development,
 * ATS Reports -> Recruiter insights, Joining -> Onboarding + the candidate's pre-boarding page, the public status / trust pages, the API docs,
 * and the Telugu switch. A private sandbox server (copy of the sandbox database) + vite preview of the built app in front of it + Edge.
 *   (cd frontend && npx vite build)  then  TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4470 node scripts/market-d-browser.js   (screenshots: docs/market-d-2026-11-21/)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const FRONT = path.resolve(BACK, '..', 'frontend');
const SHOTS = path.resolve(BACK, '..', 'docs', 'market-d-2026-11-21');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-mkd-browser-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT || 4470);
const WEB = PORT + 1;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'mkd-browser', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
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
  const mk = (tag, data, emp) => prisma.user.create({ data: { name: `Mb ${tag} ${RUN}`, email: `mb.${tag}.${RUN}@mb-test.in`, username: `mb.${tag}.${RUN}@mb-test.in`, passwordHash: 'x', status: 'Active', hrmsRole: 'NONE', atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3), ...data } })
    .then(async (u) => { if (emp) await prisma.employee.create({ data: { employeeCode: `MB-${tag}-${RUN}`, name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', department: 'IT', email: u.email, ...emp } }); return u; });
  const sa = await mk('admin', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', accountsAccess: true, accountsRole: 'SUPER_ADMIN' });
  const tl = await mk('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'IT', atsScopeDepartments: 'IT', atsScopeTeams: `Mb Team ${RUN}` }, { designation: 'TL', department: 'IT', team: `Mb Team ${RUN}` });
  const rec = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'IT', atsScopeDepartments: 'IT' }, { tl: tl.name, department: 'IT', team: `Mb Team ${RUN}` });
  const bde = await mk('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE' }, { department: 'BDE' });
  const client = await prisma.client.create({ data: { name: `Mbcorp ${RUN}`, ownerDepartment: 'IT', agreementStatus: 'ACTIVE', bdeOwner: bde.name } });
  const req = await prisma.requirement.create({ data: { title: `Mb Engineer ${RUN}`, clientId: client.id, department: 'IT', status: 'RECRUITER_ASSIGNED', tlId: tl.id, tl: tl.name, recruiterId: rec.id, reqCode: `MB-${RUN}`.toUpperCase().slice(0, 14), openings: 1 } });
  const cand = await prisma.candidate.create({ data: { name: `Mbperson Quill ${RUN}`, phone: `8${String(Date.now()).slice(-9)}`, email: `mb.${RUN}@mb-test.in`, skills: 'Kubernetes' } });
  const app = await prisma.application.create({ data: { candidateId: cand.id, requirementId: req.id, ownerRecruiterId: rec.id, stage: 'OFFER', offerStatus: 'Offer Released', joiningDate: new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10) } });

  const be = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(be);
  if (!(await waitFor(`http://localhost:${PORT}/api/health`))) { console.log('FAIL  the sandbox server did not answer (set TEST_PORT)'); await stop(1); return; }
  const web = spawn(process.execPath, [path.join(FRONT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(WEB), '--strictPort', '--host', 'localhost'], { cwd: FRONT, env: { ...process.env, API_PROXY: `http://localhost:${PORT}` }, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(web);
  if (!(await waitFor(`http://localhost:${WEB}/`))) { console.log('FAIL  the web server did not answer'); await stop(1); return; }
  const tokenOf = async (u) => jwt.sign({ ...tokenPayload(await resolveIdentity(u.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  // a pre-boarding pack to open as the candidate
  const tR = await tokenOf(rec);
  const op = await fetch(`http://localhost:${PORT}/api/ats-plus/onboarding/${app.id}/open`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tR}` }, body: JSON.stringify({ place: 'Mbcorp office, Hitec City', time: '9:30 am' }) }).then((r) => r.json());

  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const errors = [];
  const open = async (user, urlPath, viewport = { width: 1280, height: 900 }) => {
    const ctx = await browser.newContext({ viewport });
    if (user) { const token = await tokenOf(user); await ctx.addInitScript((t) => { try { localStorage.setItem('tl_token', t); } catch (e) { /* none */ } }, token); }
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${urlPath}: ${e.message}`));
    await page.goto(`http://localhost:${WEB}${urlPath}`, { waitUntil: 'commit', timeout: 120000 });
    return { ctx, page };
  };
  const seen = (page, text, timeout = 60000) => page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout }).then(() => true).catch(() => false);
  try {
    {
      const { ctx, page } = await open(sa, '/admin/ats-settings');
      check('Admin: ATS settings opens on Organisation with Branches', await seen(page, 'Report by branch'));
      await page.screenshot({ path: path.join(SHOTS, 'ats-settings-org.png'), fullPage: false });
      for (const [tab, text] of [['Forms & workflows', 'Workflow blueprints'], ['Offers & onboarding', 'Offer clause library'], ['Integrations', 'API keys'], ['Privacy & security', 'Privacy notice']]) {
        await page.getByRole('tab', { name: tab }).first().click().catch(() => null);
        check(`Admin: the "${tab}" tab draws (${text})`, await seen(page, text, 30000));
        if (tab === 'Integrations') check('Integrations: the Make a key button is there', await page.getByRole('button', { name: /Make a key/ }).first().waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false));
        await page.screenshot({ path: path.join(SHOTS, `ats-settings-${tab.split(' ')[0].toLowerCase()}.png`) });
      }
      await ctx.close();
    }
    {
      const { ctx, page } = await open(bde, '/clients/bd');
      check('BDE: Clients -> Business development opens with the pipeline', await seen(page, 'Business development pipeline'));
      check('BDE: the Business development tab sits beside Clients', await page.getByRole('tab', { name: 'Business development' }).count() > 0);
      await page.getByRole('button', { name: '+ Add a target company' }).click();
      await page.getByLabel('Company name').fill(`Mbtarget Foods ${RUN}`);
      await page.getByRole('dialog').getByRole('button', { name: 'Add', exact: true }).click().catch(async () => { await page.getByRole('button', { name: 'Add', exact: true }).last().click(); });
      check('BDE: a target company is added and listed', await seen(page, `Mbtarget Foods ${RUN}`, 30000));
      await page.screenshot({ path: path.join(SHOTS, 'clients-bd.png') });
      await ctx.close();
    }
    {
      const { ctx, page } = await open(tl, '/reports/ats?tab=coaching');
      check('TL: ATS Reports -> Recruiter insights shows the ratios', await seen(page, 'Recruiting ratios'));
      await page.locator('[role="tab"]', { hasText: /^Coaching$/ }).first().click({ timeout: 30000 }).catch((e) => console.log('   (coaching click:', String(e.message).slice(0, 120), ')'));
      check('TL: the Coaching tab draws', await seen(page, 'Coaching insights', 30000));
      await page.screenshot({ path: path.join(SHOTS, 'recruiter-insights.png') });
      await ctx.close();
    }
    {
      const { ctx, page } = await open(rec, '/ats/joining');
      await page.getByRole('tab', { name: 'Onboarding' }).first().click({ timeout: 60000 }).catch(() => null);
      check('Recruiter: Joining -> Onboarding lists the person', await seen(page, `Mbperson Quill ${RUN}`, 60000));
      await page.screenshot({ path: path.join(SHOTS, 'joining-onboarding.png') });
      await ctx.close();
    }
    {
      const { ctx, page } = await open(null, op.link || '/preboarding/none', { width: 390, height: 844 });
      check('Candidate (phone width): the pre-boarding page shows the welcome and the steps', await seen(page, 'Before your first day') && await seen(page, 'Hitec City'));
      await page.getByLabel('Language').selectOption('te');
      check('Candidate: the page switches to Telugu', await seen(page, 'మీ మొదటి రోజుకు ముందు', 20000));
      const wide = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
      check('Candidate: no sideways scroll at phone width', wide);
      await page.screenshot({ path: path.join(SHOTS, 'preboarding-phone-te.png'), fullPage: true });
      await ctx.close();
    }
    {
      const { ctx, page } = await open(null, '/status');
      check('Public: the status page draws without a login', await seen(page, 'TeamLink status') && await seen(page, 'Last 30 days'));
      await page.goto(`http://localhost:${WEB}/trust`);
      check('Public: the trust centre lists the practices and the certifications not held', await seen(page, 'How your data is protected') && await seen(page, 'Not held'));
      await page.screenshot({ path: path.join(SHOTS, 'trust.png') });
      const docs = await fetch(`http://localhost:${PORT}/api/docs`).then((r) => r.text());
      check('Public: /api/docs is the API documentation', /TeamLink ATS API/.test(docs));
      await ctx.close();
    }
    {
      const { ctx, page } = await open(rec, '/ats/dashboard');
      await page.locator('.tb-lang select').first().selectOption('hi', { timeout: 60000 }).catch((e) => console.log('   (language:', String(e.message).slice(0, 120), ')'));
      check('Recruiter: the menu switches to Hindi (Sign out, Dashboard)', await page.locator('.tb-signout', { hasText: 'साइन आउट' }).waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false) && await page.locator('.sb-item', { hasText: 'डैशबोर्ड' }).first().waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false));
      await page.screenshot({ path: path.join(SHOTS, 'menu-hindi.png') });
      await ctx.close();
    }
    check('no script error on any screen', errors.length === 0, errors.slice(0, 5));
  } finally {
    await browser.close().catch(() => {});
  }
  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.log('FAIL  crashed:', e && e.message); await stop(1); });
