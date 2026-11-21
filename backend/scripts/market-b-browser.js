#!/usr/bin/env node
/**
 * BROWSER SMOKE of market wave B (founder 2026-11-21): Candidates > Hiring tools, the requirement and candidate Hiring tools tabs,
 * the intake assistant, Administration > AI governance and the public profile-update page, at desktop and phone width.
 * A private sandbox server (copy of the sandbox database) + `vite preview` of frontend/dist in front of it + Edge (headless).
 *   (cd frontend && npx vite build) ; TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4571 node scripts/market-b-browser.js
 * Screenshots: MKB_SHOTS (default: the system temp folder / market-b-shots).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const FRONT = path.resolve(BACK, '..', 'frontend');
const SHOTS = process.env.MKB_SHOTS || path.join(os.tmpdir(), 'market-b-shots');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-mkb-browser-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT || 4571);
const WEB = PORT + 1;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'mkb-browser', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
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
const visible = (loc, ms = 60000) => loc.first().waitFor({ state: 'visible', timeout: ms }).then(() => true).catch(() => false);

(async () => {
  const sa = await prisma.user.create({ data: { name: `Mk admin ${RUN}`, email: `mk.admin.${RUN}@mk-test.in`, username: `mk.admin.${RUN}@mk-test.in`, passwordHash: 'x', status: 'Active', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', atsAccess: true, hrmsRole: 'NONE', passwordChangedAt: new Date(Date.now() - 3600e3) } });
  const job = await prisma.requirement.findFirst({ where: { status: 'OPEN', internal: false }, orderBy: { createdAt: 'desc' } });
  const cand = await prisma.candidate.create({ data: { name: `Mkperson Brightwater ${RUN}`, phone: `8${String(Date.now()).slice(-9)}`, email: `mk.${RUN}@mk-test.in`, skills: 'java, spring boot', experienceYears: 6, location: 'Hyderabad', noticePeriod: '30 Days' } });
  await prisma.application.create({ data: { candidateId: cand.id, requirementId: job.id, stage: 'NEW' } });

  const be = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(be);
  if (!(await waitFor(`http://localhost:${PORT}/api/health`))) { console.log('FAIL  the sandbox server did not answer (set TEST_PORT)'); await stop(1); return; }
  const web = spawn(process.execPath, [path.join(FRONT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(WEB), '--strictPort', '--host', 'localhost'], { cwd: FRONT, env: { ...process.env, API_PROXY: `http://localhost:${PORT}` }, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(web);
  if (!(await waitFor(`http://localhost:${WEB}/`))) { console.log('FAIL  the web server did not answer'); await stop(1); return; }

  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const token = jwt.sign({ ...tokenPayload(await resolveIdentity(sa.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const open = async (urlPath, { width = 1280, height = 900, auth = true } = {}) => {
    const ctx = await browser.newContext({ viewport: { width, height } });
    if (auth) await ctx.addInitScript((t) => { try { localStorage.setItem('tl_token', t); } catch (e) { /* none */ } }, token);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message || e)));
    await page.goto(`http://localhost:${WEB}${urlPath}`, { waitUntil: 'commit', timeout: 120000 });
    return { ctx, page, errors };
  };
  const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false }).catch(() => {});
  try {
    { // Candidates > Hiring tools: smart search, then a talent pool
      const { ctx, page, errors } = await open('/candidates?view=tools&tool=search');
      check('Candidates > Hiring tools opens (Smart search)', await visible(page.locator('[data-testid="mkb-nl"]')), errors);
      await page.locator('[data-testid="mkb-nl"] input').fill('java developers in hyderabad 5+ years notice 30 days');
      await page.locator('[data-testid="mkb-nl"] button[type=submit]').click();
      check('the plain-words search shows the filters it understood', await visible(page.locator('.mkb-chip', { hasText: 'Hyderabad' }), 30000) && await visible(page.locator('.mkb-chip', { hasText: '5+ years' }), 5000));
      check('...and finds the person', await visible(page.locator('[data-testid="mkb-nl"] a', { hasText: `Mkperson Brightwater ${RUN}` }), 30000));
      await shot(page, 'hiring-tools-search');
      await page.locator('[role=tab]', { hasText: 'Talent pools' }).first().click();
      await page.locator('[data-testid="mkb-pools"] input').first().fill(`Java bench ${RUN}`);
      await page.locator('[data-testid="mkb-pools"] button[type=submit]').click();
      check('a talent pool is made from the screen', await visible(page.locator('[data-testid="mkb-pools"] b', { hasText: `Java bench ${RUN}` }), 30000));
      await page.locator('[role=tab]', { hasText: 'Review queue' }).first().click();
      check('the review queue opens', await visible(page.locator('[data-testid="mkb-reviews"]'), 30000));
      check('no script errors on the Hiring tools view', errors.length === 0, errors);
      await ctx.close();
    }
    { // phone width: the same view fits the screen
      const { ctx, page } = await open('/candidates?view=tools&tool=search', { width: 390, height: 844 });
      await visible(page.locator('[data-testid="mkb-nl"]'));
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check('phone width: Hiring tools has no sideways scroll', over <= 2, over);
      await shot(page, 'hiring-tools-phone');
      await ctx.close();
    }
    { // requirement > Hiring tools
      const { ctx, page, errors } = await open(`/requirements/${job.id}?tab=tools`);
      check('requirement > Hiring tools tab opens with the screening questions', await visible(page.locator('[data-testid="mkb-screening"]'), 90000), errors);
      await page.locator('[data-testid="mkb-screening"] button', { hasText: 'Add a question' }).click();
      await page.locator('[data-testid="mkb-screening"] input[aria-label="Question 1"]').fill('Do you have a valid passport?');
      await page.locator('[data-testid="mkb-screening"] button', { hasText: 'Save questions' }).click();
      check('a screening question is saved from the screen', await visible(page.locator('.mkb-flash.good', { hasText: 'Saved' }), 30000));
      check('the always-on search shows', await visible(page.locator('[data-testid="mkb-watch"]'), 30000));
      await shot(page, 'requirement-tools');
      check('no script errors on the requirement tools', errors.length === 0, errors);
      await ctx.close();
    }
    { // candidate > Hiring tools + documents
      const { ctx, page, errors } = await open(`/candidates/${cand.id}?tab=tools`);
      check('candidate > Hiring tools tab opens', await visible(page.locator('[data-testid="mkb-cand-tools"]'), 90000), errors);
      check('it offers the client resume PDF and the update link', await visible(page.locator('button', { hasText: 'Download with an AI summary' })) && await visible(page.locator('button', { hasText: 'Make an update link' })));
      await page.locator('button', { hasText: 'Make an update link' }).click();
      const linkBox = page.locator('input[aria-label="Update link"]');
      check('an update link is made', await visible(linkBox, 30000));
      const url = await linkBox.inputValue().catch(() => '');
      await shot(page, 'candidate-tools');
      await ctx.close();
      // the public page of that link, no login
      const pub = await open(url.replace(/^https?:\/\/[^/]+/, ''), { auth: false, width: 390, height: 844 });
      check('the person opens the link without a login and sees their own details', await visible(pub.page.locator('input#up-currentCompany'), 60000));
      await pub.page.locator('input#up-currentCompany').fill('Acme Labs');
      await pub.page.locator('button[type=submit]').click();
      check('...and saves them', await visible(pub.page.locator('.mkb-flash.good'), 30000));
      check('the record has the new company', (await prisma.candidate.findUnique({ where: { id: cand.id } })).currentCompany === 'Acme Labs');
      await shot(pub.page, 'update-profile-phone');
      await pub.ctx.close();
    }
    { // Requirements: the intake assistant
      const { ctx, page, errors } = await open('/requirements');
      const btn = page.locator('button', { hasText: 'Draft from a note' });
      check('Requirements has "Draft from a note"', await visible(btn, 90000), errors);
      await btn.click();
      await page.locator('[data-testid="mkb-intake-text"]').fill('Need 2 Java developers, 4-7 years, Hyderabad, notice 30 days, spring boot, microservices');
      await page.locator('button', { hasText: 'Draft it' }).click();
      check('the assistant drafts the requirement', await visible(page.locator('[data-testid="mkb-intake-draft"] .mkb-chip', { hasText: 'Java' }), 30000));
      await page.locator('button', { hasText: 'Use this draft' }).click();
      const titleFilled = await page.waitForFunction(() => [...document.querySelectorAll('input')].some((i) => /java/i.test(i.value || '')), null, { timeout: 30000 }).then(() => true).catch(() => false);
      check('"Use this draft" opens the Add requirement form filled in', titleFilled);
      await shot(page, 'intake-form');
      await ctx.close();
    }
    { // Administration > AI governance
      const { ctx, page, errors } = await open('/admin/ai-governance');
      check('AI governance opens with the pledge and the switches', await visible(page.locator('[data-testid="mkb-pledge"]'), 90000) && await visible(page.locator('[data-testid="mkb-switches"]'), 30000), errors);
      await page.locator('[role=tab]', { hasText: 'Compliance' }).first().click();
      await page.locator('button', { hasText: 'Run the audit now' }).click();
      check('the compliance audit runs and shows its check-list', await visible(page.locator('[data-testid="mkb-audit"] .mkb-chip', { hasText: /Pass|Look/ }), 30000));
      await page.locator('[role=tab]', { hasText: 'AI calls' }).first().click();
      check('the AI call log shows', await visible(page.locator('[data-testid="mkb-calls"]'), 30000));
      await shot(page, 'ai-governance');
      check('no script errors on AI governance', errors.length === 0, errors);
      await ctx.close();
    }
  } catch (e) {
    check('the smoke ran to the end', false, String(e && e.message));
  }
  await browser.close();
  console.log(`\n${total - failed}/${total} passed (screenshots: ${SHOTS})`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
