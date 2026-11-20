#!/usr/bin/env node
/**
 * BROWSER SMOKE of the dashboard's 'Report of your team' (founder 2026-11-20): only a TL has the card, a recruiter has none, the Super Admin has the
 * 'Overall report' button. View opens a person's report: the candidates they added and every follow-up with its text. A private sandbox server (copy of the sandbox database) + the Vite dev server in front of it + Edge.
 *   TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4301 node scripts/team-report-smoke.js     (screenshots: docs/team-report-2026-11-20/)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const FRONT = path.resolve(BACK, '..', 'frontend');
const SHOTS = path.resolve(BACK, '..', 'docs', 'team-report-2026-11-20');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-trs-smoke-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT || 4301);
const WEB = PORT + 1;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'trs-smoke', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
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
  const mk = (tag, data, emp) => prisma.user.create({ data: { name: `Tz ${tag} ${RUN}`, email: `tz.${tag}.${RUN}@tz-test.in`, username: `tz.${tag}.${RUN}@tz-test.in`, passwordHash: 'x', status: 'Active', hrmsRole: 'NONE', ...data } })
    .then(async (u) => { if (emp) await prisma.employee.create({ data: { employeeCode: `TZ-${tag}-${RUN}`, name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', department: 'IT', email: u.email, ...emp } }); return u; });
  const sa = await mk('admin', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', accountsAccess: true, accountsRole: 'SUPER_ADMIN' });
  const tl = await mk('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'IT', atsScopeDepartments: 'IT', atsScopeTeams: `Tz Team ${RUN}` }, { designation: 'TL', department: 'IT', team: `Tz Team ${RUN}` });
  const rec = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'IT', atsScopeDepartments: 'IT' }, { tl: tl.name, department: 'IT', team: `Tz Team ${RUN}` });
  const client = await prisma.client.create({ data: { name: `Tzorbit Systems ${RUN}`, ownerDepartment: 'IT', agreementStatus: 'ACTIVE' } });
  const req = await prisma.requirement.create({ data: { title: `Tzcloud Engineer ${RUN}`, clientId: client.id, department: 'IT', status: 'RECRUITER_ASSIGNED', tlId: tl.id, tl: tl.name, recruiterId: rec.id, reqCode: `TZ-${RUN}`.toUpperCase().slice(0, 14), openings: 1 } });
  const cand = await prisma.candidate.create({ data: { name: `Tzperson Quillfeather ${RUN}`, phone: `8${String(Date.now()).slice(-9)}`, email: `tz.${RUN}@tz-test.in`, skills: 'Kubernetes' } });
  const app = await prisma.application.create({ data: { candidateId: cand.id, requirementId: req.id, ownerRecruiterId: rec.id, stage: 'NEW' } });
  const WROTE = `Called, will confirm the interview slot tomorrow ${RUN}`;
  await prisma.applicationFollowUp.create({ data: { applicationId: app.id, candidateId: cand.id, requirementId: req.id, ownerUserId: rec.id, ownerName: rec.name, ownerRole: 'Recruiter', purpose: 'Interview confirmation', notes: WROTE, nextAction: WROTE, contactMode: 'Call', lastContactedAt: new Date(), createdByName: rec.name, createdById: rec.id } });

  const be = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(be);
  if (!(await waitFor(`http://localhost:${PORT}/api/health`))) { console.log('FAIL  the sandbox server did not answer (set TEST_PORT)'); await stop(1); return; }
  const web = spawn(process.execPath, [path.join(FRONT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(WEB), '--strictPort', '--host', 'localhost'], { cwd: FRONT, env: { ...process.env, API_PROXY: `http://localhost:${PORT}` }, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(web);
  if (!(await waitFor(`http://localhost:${WEB}/`))) { console.log('FAIL  the web server did not answer'); await stop(1); return; }

  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const open = async (user, urlPath) => {
    const token = jwt.sign({ ...tokenPayload(await resolveIdentity(user.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript((t) => { try { localStorage.setItem('tl_token', t); } catch (e) { /* none */ } }, token);
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${WEB}${urlPath}`, { waitUntil: 'commit', timeout: 120000 });
    await page.locator('[data-testid="dash-search-bar"] input').waitFor({ state: 'visible', timeout: 60000 }).catch(() => null);
    return { ctx, page };
  };
  try {
    // TL: the card, one row per recruiter, View
    {
      const { ctx, page } = await open(tl, '/ats/dashboard');
      const card = page.locator('.trc', { hasText: 'Report of your team' });
      const up = await card.waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false);
      check('TL: the dashboard has "Report of your team"', up, await page.evaluate(() => document.body.innerText.slice(0, 300)).catch(() => ''));
      if (up) {
        const row = card.locator('tr', { hasText: rec.name });
        await row.waitFor({ state: 'visible', timeout: 30000 }).catch(() => null);
        check('TL: the card has one row for their recruiter, with a View button', await row.locator('button', { hasText: 'View' }).isVisible().catch(() => false));
        check('TL: Today / Yesterday / This week / This month and two date boxes are there', (await card.locator('button', { hasText: /^(Today|Yesterday|This week|This month)$/ }).count()) === 4 && (await card.locator('input[type=date]').count()) === 2);
        await page.screenshot({ path: path.join(SHOTS, 'tl-card.png') });
        await row.locator('button', { hasText: 'View' }).click();
        const panel = page.locator('.trd-panel');
        const pv = await panel.waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false);
        check('TL: View opens that recruiter\'s report in a side panel', pv);
        if (pv) {
          await panel.locator('td', { hasText: `Tzperson Quillfeather ${RUN}` }).first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => null);
          const t = await panel.innerText();
          check('TL: the panel lists the candidate they added', t.includes(`Tzperson Quillfeather ${RUN}`) && /Candidates added/.test(t), t.slice(0, 300));
          await panel.locator('td', { hasText: WROTE }).first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => null);
          check('TL: ...and the follow-up with the text that was written', (await panel.innerText()).includes(WROTE));
          await page.screenshot({ path: path.join(SHOTS, 'tl-view-panel.png') });
          await page.keyboard.press('Escape');
          check('TL: Escape closes the panel', await panel.waitFor({ state: 'detached', timeout: 5000 }).then(() => true).catch(() => false));
        }
      }
      await ctx.close();
    }
    // Recruiter: no card at all
    {
      const { ctx, page } = await open(rec, '/ats/dashboard');
      await page.waitForTimeout(4000);
      check('Recruiter: no team report card and no Overall report button', (await page.locator('.trc').count()) === 0 && (await page.locator('button', { hasText: 'Overall report' }).count()) === 0);
      await ctx.close();
    }
    // Super Admin: only the Overall report button
    {
      const { ctx, page } = await open(sa, '/ats/dashboard');
      const btn = page.locator('button', { hasText: 'Overall report' });
      const there = await btn.waitFor({ state: 'visible', timeout: 90000 }).then(() => true).catch(() => false);
      check('Admin: the dashboard has an Overall report button, and no team card of its own', there && (await page.locator('.trc', { hasText: 'Report of your team' }).count()) === 0);
      if (there) {
        await btn.click();
        const panel = page.locator('.trd-panel', { hasText: 'Overall report' });
        const ok = await panel.locator('tr', { hasText: rec.name }).waitFor({ state: 'visible', timeout: 90000 }).then(() => true).catch(() => false);
        check('Admin: the Overall report lists everybody, with their TL', ok && (await panel.innerText()).includes(tl.name), (await panel.innerText().catch(() => '')).slice(0, 400));
        await page.screenshot({ path: path.join(SHOTS, 'admin-overall.png') });
        if (ok) {
          await panel.locator('tr', { hasText: rec.name }).locator('button', { hasText: 'View' }).click();
          const v = await page.locator('.trd-panel', { hasText: 'Candidates added' }).first().waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false);
          check('Admin: View on a person opens that person\'s report', v);
        }
      }
      await ctx.close();
    }
  } finally {
    await browser.close().catch(() => {});
  }
  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.log('FAIL  crashed:', e && e.message); await stop(1); });
