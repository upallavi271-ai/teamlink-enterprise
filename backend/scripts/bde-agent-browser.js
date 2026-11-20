#!/usr/bin/env node
/**
 * BROWSER SMOKE of the BDE Agent (founder 2026-11-20): a BDE opens the agent from the top bar, taps a suggested question, types a question and
 * presses Enter, sees a linked answer, opens "How I got this", and the window works at phone width. A private sandbox server (copy of the sandbox
 * database) + the built frontend (vite preview) in front of it + Edge (playwright-core).
 *   TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4620 node scripts/bde-agent-browser.js     (screenshots: docs/bde-agent-2026-11-20/; build the frontend first)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const FRONT = path.resolve(BACK, '..', 'frontend');
const SHOTS = path.resolve(BACK, '..', 'docs', 'bde-agent-2026-11-20');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-bdeagent-web-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT || 4620);
const WEB = PORT + 1;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'bde-agent-web', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const L = require('../src/utils/bdeAgentLang');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };
const RUN = Date.now().toString(36).slice(-5).toUpperCase();
const procs = [];
async function stop(code) {
  procs.forEach((p) => { try { p.kill(); } catch { /* gone */ } });
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const waitFor = async (url, tries = 240) => { for (let i = 0; i < tries; i += 1) { if (await fetch(url).then((r) => r.status < 500).catch(() => false)) return true; await new Promise((r) => { setTimeout(r, 500); }); } return false; }; // eslint-disable-line no-await-in-loop

(async () => {
  const T = L.todayIst();
  const bde = await prisma.user.create({ data: { name: `Anitha Bw${RUN}`, email: `bw.a.${RUN.toLowerCase()}@bw-test.in`, username: `bw.a.${RUN.toLowerCase()}@bw-test.in`, passwordHash: 'x', status: 'Active', hrmsRole: 'NONE', atsAccess: true, role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', passwordChangedAt: new Date(Date.now() - 3600e3) } });
  const client = await prisma.client.create({ data: { name: 'Kovida Heartcare Hospital', bdeOwner: bde.name, ownerDepartment: 'Medical', status: 'Active', agreementStatus: 'ACTIVE', agreementEnd: L.addDays(T, 20), clientCode: `BW${RUN}` } });
  const req = await prisma.requirement.create({ data: { title: 'Staff Nurse ICU', clientId: client.id, bdeId: bde.id, status: 'OPEN', openings: 3, department: 'Medical', reqCode: `BW${RUN}-1` } });
  const cand = await prisma.candidate.create({ data: { name: 'Lakshmi Prasanna', phone: `98${String(Date.now()).slice(-8)}`, email: `lp.${RUN.toLowerCase()}@bw-cand-test.in` } });
  await prisma.application.create({ data: { candidateId: cand.id, requirementId: req.id, stage: 'INTERVIEW_SCHEDULED', interviewAt: new Date(`${T}T15:00:00+05:30`), interviewStatus: 'SCHEDULED', hiringType: 'Client Placement' } });

  if (!fs.existsSync(path.join(FRONT, 'dist', 'index.html'))) { console.log('FAIL  build the frontend first (npx vite build)'); await stop(1); return; }
  const be = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(be);
  if (!(await waitFor(`http://localhost:${PORT}/api/health`))) { console.log(`FAIL  the sandbox server did not answer on ${PORT} (set TEST_PORT)`); await stop(1); return; }
  const web = spawn(process.execPath, [path.join(FRONT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(WEB), '--strictPort', '--host', 'localhost'], { cwd: FRONT, env: { ...process.env, API_PROXY: `http://localhost:${PORT}` }, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(web);
  if (!(await waitFor(`http://localhost:${WEB}/`))) { console.log('FAIL  the web server did not answer'); await stop(1); return; }

  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const token = jwt.sign({ ...tokenPayload(await resolveIdentity(bde.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const openAs = async (viewport) => {
    const ctx = await browser.newContext({ viewport });
    await ctx.addInitScript((t) => { try { localStorage.setItem('tl_token', t); } catch (e) { /* none */ } }, token);
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${WEB}/ats/dashboard`, { waitUntil: 'commit', timeout: 120000 });
    return { ctx, page };
  };
  try {
    const { ctx, page } = await openAs({ width: 1280, height: 900 });
    const pill = page.locator('[data-testid="bde-agent-pill"]');
    const pillUp = await pill.waitFor({ state: 'visible', timeout: 90000 }).then(() => true).catch(() => false);
    check('the BDE sees the "BDE Agent" button in the top bar', pillUp);
    if (pillUp) {
      await pill.click();
      const panel = page.locator('[data-testid="bde-agent-panel"]');
      check('the agent window opens', await panel.waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false));
      const chip = panel.locator('.bde-agent-chip', { hasText: "Today's interviews" });
      check('suggested question chips are there (by role)', await chip.waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false) && await panel.locator('.bde-agent-chip', { hasText: 'My target this month' }).waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false));
      await page.screenshot({ path: path.join(SHOTS, '1-open-with-chips.png') });
      const t0 = Date.now();
      await chip.click();
      const thinking = await panel.locator('.bde-agent-typing').isVisible().catch(() => false);
      const ans1 = panel.locator('.bde-agent-msg.ai .bde-agent-title', { hasText: '1 interview today' });
      const a1 = await ans1.waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false);
      check(`the chip answers "1 interview today" (${Date.now() - t0} ms${thinking ? ', "Thinking" showed first' : ''})`, a1);
      const link1 = panel.locator('.bde-agent-link', { hasText: 'Lakshmi Prasanna' });
      check('...with the candidate named as a link to their history', await link1.count() === 1 && /\/ats\/history\/candidate\//.test(await link1.getAttribute('href') || ''));
      const body1 = await panel.innerText();
      check('...and no candidate phone or e-mail anywhere in the window', !body1.includes(cand.phone) && !body1.includes(cand.email));
      await page.screenshot({ path: path.join(SHOTS, '2-chip-answer.png') });
      const input = panel.locator('input[aria-label="Question for the BDE Agent"]');
      await input.fill('Tell me about kovida heartcare');
      await input.press('Enter');
      const ans2 = panel.locator('.bde-agent-msg.ai .bde-agent-title', { hasText: 'Kovida Heartcare Hospital' });
      check('a typed question + Enter: the client answer comes back', await ans2.waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false));
      const clientLink = panel.locator('.bde-agent-msg.ai').last().locator('.bde-agent-link', { hasText: 'Kovida Heartcare Hospital' }).first();
      check('...with a link to the client page', (await clientLink.getAttribute('href').catch(() => '')) === `/clients/${client.id}`);
      await panel.locator('.bde-agent-msg.ai').last().locator('.bde-agent-tool', { hasText: 'How I got this' }).click();
      check('"How I got this" shows the facts used', await panel.locator('.bde-agent-msg.ai').last().locator('.bde-agent-facts li').first().isVisible().catch(() => false));
      check('Copy is offered on every answer', await panel.locator('.bde-agent-msg.ai').last().locator('.bde-agent-tool', { hasText: 'Copy' }).count() === 1);
      await page.screenshot({ path: path.join(SHOTS, '3-typed-answer-how.png') });
      await input.fill('ee roju interviews enni');
      await input.press('Enter');
      check('Telugu in English letters is understood', await panel.locator('.bde-agent-msg.ai .bde-agent-title', { hasText: 'ee roju' }).last().waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false));
      // the history link opens the drawer over the page
      await panel.locator('.bde-agent-msg.ai').nth(0).locator('.bde-agent-link', { hasText: 'Lakshmi Prasanna' }).click();
      check('a candidate link opens their history (side drawer, the agent keeps its chat)', await page.waitForURL(/open=candidate/, { timeout: 15000 }).then(() => true).catch(() => false));
      await page.locator('.hxd-wrap', { hasText: 'Staff Nurse ICU' }).first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => null);
      await page.screenshot({ path: path.join(SHOTS, '4-history-drawer.png') });
      // reload: the last questions are kept
      await page.goto(`http://localhost:${WEB}/ats/dashboard`, { waitUntil: 'commit' });
      await page.locator('[data-testid="bde-agent-pill"]').click({ timeout: 90000 });
      check('the last questions and answers are kept after a reload', await page.locator('[data-testid="bde-agent-panel"] .bde-agent-msg.me', { hasText: 'Tell me about kovida heartcare' }).waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false));
    }
    await ctx.close();
    // phone width
    const ph = await openAs({ width: 390, height: 820 });
    const pp = ph.page.locator('[data-testid="bde-agent-pill"]');
    if (await pp.waitFor({ state: 'visible', timeout: 90000 }).then(() => true).catch(() => false)) {
      await pp.click();
      const panel = ph.page.locator('[data-testid="bde-agent-panel"]');
      await panel.waitFor({ state: 'visible', timeout: 20000 });
      await panel.locator('.bde-agent-chip', { hasText: 'Overdue invoices' }).click();
      await panel.locator('.bde-agent-msg.ai .bde-agent-title').last().waitFor({ state: 'visible', timeout: 20000 }).catch(() => null);
      const box = await panel.boundingBox();
      const wide = await ph.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      check('phone width: the window fits the screen (no sideways scroll)', !!box && box.x >= 0 && box.x + box.width <= 390 && !wide, box);
      await ph.page.screenshot({ path: path.join(SHOTS, '5-phone.png') });
    } else check('phone width: the BDE Agent button is in the top bar', false);
    await ph.ctx.close();
  } finally {
    await browser.close().catch(() => {});
  }
  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.log('FAIL  crashed:', e && e.message); await stop(1); });
