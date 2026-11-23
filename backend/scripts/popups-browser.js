#!/usr/bin/env node
/**
 * BROWSER SMOKE of the client-update pop-ups and the dashboard Updates & reports centre (founder 2026-11-23).
 * A client shortlists a candidate in the portal -> the pop-up appears on the recruiter's AND the BDE's screen (top right), with Open
 * and Got it; the ATS dashboard shows "Your interviews today" and the Updates & reports list. A private sandbox server (copy of the
 * sandbox database) + vite preview in front of it + Edge (playwright-core). Build the frontend first (npx vite build).
 *   TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4610 node scripts/popups-browser.js        (screenshots: <tmp>/popups-shots/)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const FRONT = path.resolve(BACK, '..', 'frontend');
const SHOTS = path.join(os.tmpdir(), 'popups-shots');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-popups-browser-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT || 4610);
const WEB = PORT + 1;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'popups-browser', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
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
  const mk = (tag, data) => prisma.user.create({ data: { name: `Pb ${tag} ${RUN}`, email: `pb.${tag}.${RUN}@pb-test.in`, username: `pb.${tag}.${RUN}@pb-test.in`, passwordHash: 'x', status: 'Active', hrmsRole: 'NONE', accountsRole: 'NONE', atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3), passwordResetRequired: false, ...data } });
  const bde = await mk('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE' });
  const tl = await mk('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'IT', atsScopeDepartments: 'IT' });
  const rec = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'IT', atsScopeDepartments: 'IT' });
  const client = await prisma.client.create({ data: { name: `Pbnova Labs ${RUN}`, ownerDepartment: 'IT', agreementStatus: 'ACTIVE', bdeOwner: bde.name } });
  const cu = await mk('client', { role: 'CLIENT', atsRole: 'CLIENT', clientId: client.id, portalType: 'REVIEWER', portalPerms: 'VIEW,AGREEMENT,REQUEST,DECIDE,INTERVIEW,FEEDBACK,OFFERS' });
  const req = await prisma.requirement.create({ data: { title: `Pbcloud Engineer ${RUN}`, clientId: client.id, department: 'IT', status: 'RECRUITER_ASSIGNED', priority: 'High', tlId: tl.id, tl: tl.name, recruiterId: rec.id, bdeId: bde.id, reqCode: `PB-${RUN}`.toUpperCase().slice(0, 14), openings: 1 } });
  const cand = await prisma.candidate.create({ data: { name: `Pbperson Shortlisted ${RUN}`, phone: `9${String(Date.now()).slice(-9)}`, email: `pb.c1.${RUN}@pb-test.in` } });
  const app = await prisma.application.create({ data: { candidateId: cand.id, requirementId: req.id, ownerRecruiterId: rec.id, stage: 'SHARED_WITH_CLIENT' } });
  // an interview later today (IST) for the "Your interviews today" list
  const istNow = new Date(Date.now() + 330 * 60000);
  const endOfDay = new Date(`${istNow.toISOString().slice(0, 10)}T23:40:00+05:30`).getTime();
  const at = new Date(Math.min(Date.now() + 2 * 3600e3, Math.max(Date.now() + 20 * 60000, endOfDay - 10 * 60000)));
  const cand2 = await prisma.candidate.create({ data: { name: `Pbperson Interview ${RUN}`, phone: `8${String(Date.now()).slice(-9)}`, email: `pb.c2.${RUN}@pb-test.in` } });
  await prisma.application.create({ data: { candidateId: cand2.id, requirementId: req.id, ownerRecruiterId: rec.id, stage: 'INTERVIEW_SCHEDULED', interviewStatus: 'SCHEDULED', interviewAt: at, interviewMode: 'Online', interviewMeetingLink: 'https://meet.example.org/pb', interviewRound: 1 } });

  const be = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(be);
  if (!(await waitFor(`http://localhost:${PORT}/api/health`))) { console.log('FAIL  the sandbox server did not answer (set TEST_PORT)'); await stop(1); return; }
  const web = spawn(process.execPath, [path.join(FRONT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(WEB), '--strictPort', '--host', 'localhost'], { cwd: FRONT, env: { ...process.env, API_PROXY: `http://localhost:${PORT}` }, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(web);
  if (!(await waitFor(`http://localhost:${WEB}/`))) { console.log('FAIL  the web server did not answer'); await stop(1); return; }

  const tokOf = async (u) => jwt.sign({ ...tokenPayload(await resolveIdentity(u.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const open = async (user, urlPath) => {
    const token = await tokOf(user);
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await ctx.addInitScript((t) => { try { localStorage.setItem('tl_token', t); } catch (e) { /* none */ } }, token);
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${WEB}${urlPath}`, { waitUntil: 'commit', timeout: 120000 });
    await page.locator('[data-testid="dash-search-bar"] input').waitFor({ state: 'visible', timeout: 90000 }).catch(() => null);
    return { ctx, page };
  };
  try {
    const R = await open(rec, '/ats/dashboard');
    const B = await open(bde, '/ats/dashboard');
    // the dashboard: Your interviews today + Updates & reports
    const today = R.page.locator('.uc-today', { hasText: cand2.name });
    check('dashboard: "Your interviews today" lists the interview (time, candidate, job, client)', await today.waitFor({ state: 'visible', timeout: 60000 }).then(() => true).catch(() => false)
      && (await today.innerText()).includes(req.title) && (await today.innerText()).includes(client.name), await R.page.locator('.uc').innerText().catch(() => ''));
    check('dashboard: the Updates & reports centre is there with the day\'s reports', await R.page.locator('.uc', { hasText: 'Updates & reports' }).locator('.uc-row', { hasText: 'Daily report' }).first().isVisible().catch(() => false));
    const ivCard = R.page.locator('.ups-today', { hasText: cand2.name });
    check('pop-up: "Your interviews today" pops up after sign-in', await ivCard.waitFor({ state: 'visible', timeout: 40000 }).then(() => true).catch(() => false));
    await R.page.screenshot({ path: path.join(SHOTS, 'recruiter-dashboard.png') });
    if (await ivCard.isVisible().catch(() => false)) await ivCard.locator('button', { hasText: 'Got it' }).click();

    // the client shortlists in the portal
    const ct = await tokOf(cu);
    const r = await fetch(`http://localhost:${PORT}/api/job-portal/client/applications/${app.id}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ct}` }, body: JSON.stringify({ decision: 'SHORTLIST', comment: 'Please book the interview' }) });
    check('the client shortlists through the portal', r.ok, r.status);
    const cardR = R.page.locator('.ups-card', { hasText: `shortlisted ${cand.name}` });
    const cardB = B.page.locator('.ups-card', { hasText: `shortlisted ${cand.name}` });
    const upR = await cardR.waitFor({ state: 'visible', timeout: 70000 }).then(() => true).catch(() => false);
    const upB = await cardB.waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false);
    check('pop-up: the recruiter sees the client update on screen (top right)', upR, await R.page.locator('.ups').innerText().catch(() => 'no stack'));
    check('pop-up: the BDE sees it too', upB);
    check('pop-up: who / what / when with Open and Got it', upR && (await cardR.innerText()).includes('(client)') && await cardR.locator('button', { hasText: 'Open' }).isVisible() && await cardR.locator('button', { hasText: 'Got it' }).isVisible());
    const box = upR ? await R.page.locator('.ups').boundingBox() : null;
    check('pop-up: the stack sits at the top right', box && box.x > 800 && box.y < 120, box);
    await R.page.screenshot({ path: path.join(SHOTS, 'recruiter-popup.png') });
    await B.page.screenshot({ path: path.join(SHOTS, 'bde-popup.png') });
    if (upR) await cardR.locator('button', { hasText: 'Got it' }).click();
    check('Got it closes the card', upR && await cardR.waitFor({ state: 'hidden', timeout: 10000 }).then(() => true).catch(() => false));
    // the dashboard list shows it (after its next look, or a reload)
    await R.page.reload({ waitUntil: 'commit' });
    const row = R.page.locator('.uc-row', { hasText: `shortlisted ${cand.name}` });
    check('dashboard: the update is in the Updates & reports list', await row.first().waitFor({ state: 'visible', timeout: 60000 }).then(() => true).catch(() => false));
    check('Got it is remembered: the card does not come back after a reload', (await R.page.locator('.ups-card', { hasText: `shortlisted ${cand.name}` }).count()) === 0);
    await R.page.locator('.uc button', { hasText: 'See all' }).click();
    const full = R.page.locator('.modal', { hasText: 'Updates & reports' });
    check('See all opens the full view with type / date / read filters', await full.waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false) && (await full.locator('select').count()) >= 2 && (await full.locator('input[type=date]').count()) === 2);
    await R.page.screenshot({ path: path.join(SHOTS, 'recruiter-full-view.png') });
    // the BDE presses Open: lands on the candidate
    if (upB) {
      await cardB.locator('button', { hasText: 'Open' }).click();
      check('Open goes to the candidate', await B.page.waitForURL(/\/candidates\//, { timeout: 20000 }).then(() => true).catch(() => false), B.page.url());
    }
    await R.ctx.close(); await B.ctx.close();
  } finally {
    await browser.close().catch(() => {});
  }
  console.log(`\n${total - failed}/${total} passed   (screenshots: ${SHOTS})`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.log('FAIL  crashed:', e && e.message); await stop(1); });
