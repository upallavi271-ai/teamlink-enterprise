#!/usr/bin/env node
/**
 * BROWSER SMOKE of "Who receives the responses" (founder 2026-11-20): the Education Team A TL opens a job, presses Post, sees the
 * assigned recruiters ticked by default, ticks 2 recipients, goes on to "Where do you want to post?", posts on our Job Portal, and
 * then sees "Responses go to: ..." on the job's Team tab. A private sandbox server (copy of the sandbox database) + vite preview + Edge.
 *   TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4520 node scripts/resp-recipients-smoke.js   (needs a fresh `npx vite build` in frontend)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const FRONT = path.resolve(BACK, '..', 'frontend');
const SHOTS = path.join(os.tmpdir(), 'resp-recipients-smoke');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-rr-smoke-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT || 4520);
const WEB = PORT + 1;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'rr-smoke', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 500)}` : ''}`); } };
const procs = [];
async function stop(code) {
  procs.forEach((p) => { try { p.kill(); } catch { /* gone */ } });
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const waitFor = async (url, tries = 240) => { for (let i = 0; i < tries; i += 1) { if (await fetch(url).then((r) => r.status < 500).catch(() => false)) return true; await new Promise((r) => { setTimeout(r, 500); }); } return false; }; // eslint-disable-line no-await-in-loop
const P = process.pid;
const ID = { tlA: 'cmudx9z15001u25ry8ib01xiu', sneha: 'cmudx9yc2001925rygfytrgza', sony: 'cmvkrfwtm00t21003yozy4f5v', vennela: 'cmvkriyej00ty1003ewqludkm' };

(async () => {
  await prisma.user.updateMany({ where: { id: { in: Object.values(ID) } }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const be = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(be);
  if (!(await waitFor(`http://localhost:${PORT}/api/health`))) { console.log('FAIL  the sandbox server did not answer (set TEST_PORT)'); await stop(1); return; }
  await new Promise((r) => { setTimeout(r, 1500); });
  // a new job (after the feature went live), assigned to Sneha + D Sony, not posted yet
  const job = await prisma.requirement.create({
    data: {
      title: `Rs Chemistry Lecturer ${P}`, reqCode: `RS-${P}`, clientId: 'cmucmvef200spb6d2qsw8kcxf', department: 'Education', tlId: ID.tlA, tl: 'D.Leela Usha Sri',
      recruiterId: ID.sneha, recruiterIds: ID.sony, status: 'RECRUITER_ASSIGNED', postingSources: 'None', location: 'Hyderabad', openings: 1,
      description: 'Teach chemistry to intermediate students.', jobDescription: 'Teach chemistry to intermediate students in Hyderabad. Two years of teaching needed.', experience: '2-5 yrs', skills: 'Chemistry, Teaching',
    },
  });
  const web = spawn(process.execPath, [path.join(FRONT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(WEB), '--strictPort', '--host', 'localhost'], { cwd: FRONT, env: { ...process.env, API_PROXY: `http://localhost:${PORT}` }, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(web);
  if (!(await waitFor(`http://localhost:${WEB}/`))) { console.log('FAIL  the web server did not answer'); await stop(1); return; }

  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const token = jwt.sign({ ...tokenPayload(await resolveIdentity(ID.tlA)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript((t) => { try { localStorage.setItem('tl_token', t); } catch (e) { /* none */ } }, token);
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept().catch(() => {}));
  try {
    await page.goto(`http://localhost:${WEB}/requirements/${job.id}`, { waitUntil: 'commit', timeout: 120000 });
    // the Post window: from the job's "Post this requirement" button, else from the Postings tab
    let opened = false;
    const postBtn = page.locator('button', { hasText: 'Post this requirement' }).first();
    if (await postBtn.waitFor({ state: 'visible', timeout: 60000 }).then(() => true).catch(() => false)) { await postBtn.click(); opened = true; }
    if (!opened) {
      const any = page.locator('#pt-others, .pw-handbtns').locator('..').locator('button', { hasText: /^Post/ }).first();
      if (await any.isVisible().catch(() => false)) { await any.click(); opened = true; }
    }
    const step = page.locator('[data-testid="post-recipients"]');
    const up = await step.waitFor({ state: 'visible', timeout: 60000 }).then(() => true).catch(() => false);
    check('TL: Post opens "Who receives the responses" first', opened && up && (await step.innerText()).includes('Who receives the responses'), (await page.evaluate(() => document.body.innerText.slice(0, 600)).catch(() => '')));
    if (up) {
      const box = (name) => step.locator(`input[aria-label="Responses to ${name}"]`);
      check('TL: the assigned recruiters are ticked by default (Sneha, D Sony), N Vennela is not', await box('Sneha Bharghavi Bapanapalli').isChecked() && await box('D Sony').isChecked() && !(await box('N Vennela').isChecked()));
      check('TL: "All assigned recruiters" quick pick is there', await step.locator('button', { hasText: 'All assigned recruiters' }).isVisible());
      check('TL: the assigned recruiters are shown apart (they work and source the job)', (await step.innerText()).includes('Assigned recruiters'));
      await step.locator('button', { hasText: 'Clear' }).click();
      await step.locator('button', { hasText: /^Next/ }).click();
      check('TL: Next with nobody ticked is refused with a clear message', await step.locator('[role="alert"]', { hasText: 'Tick at least one recruiter' }).isVisible().catch(() => false));
      await box('Sneha Bharghavi Bapanapalli').check();
      await box('N Vennela').check();
      await page.screenshot({ path: path.join(SHOTS, 'post-recipients.png') });
      await step.locator('button', { hasText: /^Next/ }).click();
      const where = page.locator('h3', { hasText: 'Where do you want to post?' });
      const w = await where.waitFor({ state: 'visible', timeout: 60000 }).then(() => true).catch(() => false);
      check('TL: after ticking 2 recipients the window goes on to "Where do you want to post?" and says where the responses go', w && /Responses go to: (N Vennela, Sneha Bharghavi Bapanapalli|Sneha Bharghavi Bapanapalli, N Vennela)/.test(await page.locator('.modal').innerText()), (await page.locator('.modal').innerText().catch(() => '')).slice(0, 400));
      const saved = await prisma.$queryRawUnsafe('SELECT "userIds" FROM "RequirementResponseRecipient" WHERE "requirementId" = ?', job.id).catch(() => []);
      check('the two recipients are saved on the job', saved.length === 1 && JSON.parse(saved[0].userIds).sort().join() === [ID.sneha, ID.vennela].sort().join(), saved);
      if (w) {
        // post on our own Job Portal
        const tile = page.locator('.pw-pick', { hasText: 'Job Portal' }).first();
        await tile.locator('input[type=checkbox]').check().catch(async () => { await tile.click(); });
        await page.locator('button', { hasText: /^Post selected/ }).click();
        const postNow = page.locator('.pw-card button.btn-primary', { hasText: /^Post$/ }).first();
        if (await postNow.waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false)) await postNow.click();
        await page.waitForTimeout(5000);
        const posting = await prisma.requirement.findUnique({ where: { id: job.id }, select: { postingSources: true } });
        check('TL: the job is sent to our Job Portal (no "choose who receives the responses" refusal)', /TeamLink Job Portal/.test(posting.postingSources || '') && !(await page.evaluate(() => /Choose who receives the responses first/.test(document.body.innerText))), posting);
        await page.screenshot({ path: path.join(SHOTS, 'posted.png') });
      }
      await page.keyboard.press('Escape').catch(() => {});
    }
    // the job's Team tab
    await page.goto(`http://localhost:${WEB}/requirements/${job.id}?tab=recruiter`, { waitUntil: 'commit', timeout: 120000 });
    const card = page.locator('[data-testid="responses-go-to"]');
    const cu = await card.waitFor({ state: 'visible', timeout: 60000 }).then(() => true).catch(() => false);
    await card.locator('.kv', { hasText: 'Responses go to' }).locator('text=N Vennela').waitFor({ state: 'visible', timeout: 20000 }).catch(() => null);
    const t = cu ? await card.innerText() : '';
    check('TL: the Team tab shows "Assigned recruiters" and "Responses go to: Sneha, N Vennela" with Change', cu && /Assigned recruiters/.test(t) && /Responses go to/.test(t) && t.includes('N Vennela') && t.includes('Sneha Bharghavi Bapanapalli') && /Change/.test(t), t.slice(0, 400));
    await page.screenshot({ path: path.join(SHOTS, 'team-tab.png') });
    if (cu) {
      await card.locator('button', { hasText: 'Change' }).click();
      const m = page.locator('.modal [data-testid="post-recipients"]');
      const mu = await m.waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false);
      if (mu) {
        await m.locator('input[aria-label="Responses to D Sony"]').check();
        check('TL: changing asks for a reason', await m.locator('input[placeholder*="on leave"]').isVisible());
        await m.locator('input[placeholder*="on leave"]').fill('D Sony joins for the walk-in drive');
        const answer = page.waitForResponse((r) => r.url().includes('/response-recipients') && r.request().method() === 'PUT', { timeout: 30000 }).catch(() => null);
        await m.locator('button', { hasText: /^Save$/ }).click();
        const res = await answer;
        check('TL: Change saves (PUT answers 200)', !!res && res.status() === 200, res ? [res.status(), await res.text().catch(() => '')] : (await m.innerText().catch(() => 'no modal')).slice(0, 300));
        await page.locator('.modal [data-testid="post-recipients"]').waitFor({ state: 'detached', timeout: 30000 }).catch(() => null);
        await card.locator('text=walk-in drive').first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => null);
        const t2 = await card.innerText();
        check('TL: the change is saved with its reason and listed under Changes', /D Sony/.test(t2.split('Responses go to')[1] || '') && /walk-in drive/.test(t2), t2.slice(0, 500));
      } else check('TL: Change opens the tick list', false);
    }
  } catch (e) {
    check(`no browser error (${e.message})`, false);
  } finally {
    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
  }
  console.log(`\n${total - failed}/${total} passed (screenshots: ${SHOTS})`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
