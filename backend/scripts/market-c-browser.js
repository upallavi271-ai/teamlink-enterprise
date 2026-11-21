#!/usr/bin/env node
/**
 * BROWSER SMOKE of market wave C (2026-11-21): the main new screens open and work in Edge.
 *   Step timing > Add-on switches · requirement > Kits & tests · candidate > Outreach tools (AI draft) · the interview panel's
 *   Interview tools · Integrations > Job portals > Careers site · the public /site, /site/job (Telugu, apply form), /book, /test.
 * A private sandbox server (copy of the sandbox database) + vite preview of the built frontend in front of it.
 *   (cd frontend && npx vite build) ; TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4640 node scripts/market-c-browser.js   (screenshots: docs/market-c-2026-11-21/)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const FRONT = path.resolve(BACK, '..', 'frontend');
const SHOTS = path.resolve(BACK, '..', 'docs', 'market-c-2026-11-21');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-mktc-br-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT || 4640);
const WEB = PORT + 1;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'mktc-browser', INTEGRATION_SECRET_KEY: 'mktc-browser-key', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
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
const seen = (loc, ms = 30000) => loc.waitFor({ state: 'visible', timeout: ms }).then(() => true).catch(() => false);

(async () => {
  const mk = (tag, data) => prisma.user.create({ data: { name: `Mkb ${tag} ${RUN}`, email: `mkb.${tag}.${RUN}@mkb-test.in`, username: `mkb.${tag}.${RUN}@mkb-test.in`, passwordHash: 'x', status: 'Active', hrmsRole: 'NONE', atsAccess: true, passwordChangedAt: new Date(Date.now() - 86400e3), ...data } });
  const sa = await mk('admin', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' });
  const client = await prisma.client.create({ data: { name: `Mkborbit ${RUN}`, ownerDepartment: 'IT', agreementStatus: 'ACTIVE' } });
  const req = await prisma.requirement.create({ data: { title: `Mkbcloud Engineer ${RUN}`, clientId: client.id, department: 'IT', status: 'OPEN', reqCode: `MKB-${String(Date.now()).slice(-7)}`, openings: 1, skills: 'Kubernetes, AWS', location: 'Hyderabad', portalPublished: true, portalPublishedAt: new Date(), jobDescription: 'Run the cloud platform.' } });
  const cand = await prisma.candidate.create({ data: { name: `Mkbperson Quill ${RUN}`, phone: `8${String(Date.now()).slice(-9)}`, email: `mkb.${RUN}@gmail.com`, skills: 'Kubernetes' } });
  const app = await prisma.application.create({ data: { candidateId: cand.id, requirementId: req.id, stage: 'INTERVIEW_SCHEDULED', interviewStatus: 'SCHEDULED', interviewAt: new Date(Date.now() + 26 * 3600e3), interviewRound: 1, interviewer: sa.name, interviewMode: 'Online', interviewCode: `INT-${RUN}` } });

  const be = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(be);
  if (!(await waitFor(`http://localhost:${PORT}/api/health`))) { console.log('FAIL  the sandbox server did not answer (set TEST_PORT)'); await stop(1); return; }
  const web = spawn(process.execPath, [path.join(FRONT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(WEB), '--strictPort', '--host', 'localhost'], { cwd: FRONT, env: { ...process.env, API_PROXY: `http://localhost:${PORT}` }, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(web);
  if (!(await waitFor(`http://localhost:${WEB}/`))) { console.log('FAIL  the web server did not answer'); await stop(1); return; }
  const token = jwt.sign({ ...tokenPayload(await resolveIdentity(sa.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const api = async (method, url, body) => { const r = await fetch(`http://localhost:${PORT}/api${url}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined }); return r.json().catch(() => ({})); };
  // the switches and the data the public pages need
  await api('PUT', '/ats/mkt/switches', { selfScheduling: true, assessments: true, jobAlerts: true });
  await api('PUT', `/ats/mkt/jobs/${req.id}/settings`, { selfBook: true, fields: [{ label: 'Do you have a two-wheeler?', type: 'yesno', required: true }] });
  await api('PUT', '/ats/mkt/site', { published: true, brand: { name: `Mkb Hiring ${RUN}`, color: '#0a7d4f' }, hero: { title: `We hire ${RUN}` }, sections: ['hero', 'jobs', 'alerts', 'contact'] });
  const sb = await api('POST', `/ats/mkt/interviews/${app.id}/self-book`, { slots: [new Date(Date.now() + 3 * 86400e3).toISOString()] });
  const test = await api('POST', `/ats/mkt/jobs/${req.id}/assessments`, { title: 'Cloud basics', questions: [{ type: 'mcq', text: 'kubectl applies a', options: ['manifest', 'invoice'], answer: 0 }] });
  const sent = await api('POST', `/ats/mkt/interviews/${app.id}/assessments/${test.assessment && test.assessment.id}/send`, {});

  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const open = async (urlPath, { auth = true, width = 1280 } = {}) => {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    if (auth) await ctx.addInitScript((t) => { try { localStorage.setItem('tl_token', t); } catch (e) { /* none */ } }, token);
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${WEB}${urlPath}`, { waitUntil: 'commit', timeout: 120000 });
    return { ctx, page };
  };
  try {
    {
      const { ctx, page } = await open('/admin/step-timing');
      const card = page.locator('[data-testid="addon-switches"]');
      check('Step timing: the Add-on switches card, every add-on with its switch', await seen(card, 60000) && (await card.locator('input[type=checkbox]').count()) >= 8);
      await page.screenshot({ path: path.join(SHOTS, 'addon-switches.png') }).catch(() => {});
      await ctx.close();
    }
    {
      const { ctx, page } = await open(`/requirements/${req.id}?tab=kits`);
      const kits = page.locator('[data-testid="job-kits"]');
      check('Requirement: the Kits & tests tab shows the ready-made round-1 kit', await seen(kits, 60000) && await seen(kits.locator('b', { hasText: 'Round 1' }).first()));
      await kits.locator('button[role=tab]', { hasText: 'Tests' }).first().click().catch(() => kits.getByText('Tests', { exact: true }).first().click());
      check('... and its Tests sub-tab lists the test', await seen(kits.getByText('Cloud basics').first()));
      await page.screenshot({ path: path.join(SHOTS, 'requirement-kits.png') }).catch(() => {});
      await ctx.close();
    }
    {
      const { ctx, page } = await open(`/candidates/${cand.id}?tab=outreach`);
      const box = page.locator('[data-testid="outreach-tools"]');
      check('Candidate: the Outreach tools tab opens', await seen(box, 60000));
      await box.locator('button', { hasText: 'Draft it' }).click().catch(() => {});
      const ta = box.locator('textarea[aria-label="Message"]');
      check('... "Draft it" writes a draft with their first name (template when the AI is off)', await seen(ta) && /Mkbperson/.test(await ta.inputValue().catch(() => '')));
      await page.screenshot({ path: path.join(SHOTS, 'candidate-outreach.png') }).catch(() => {});
      await ctx.close();
    }
    {
      const { ctx, page } = await open('/ats/calendar');
      const row = page.getByText(cand.name).first();
      const up = await seen(row, 60000);
      if (up) await row.click().catch(() => {});
      await page.locator('button', { hasText: 'View details' }).first().click({ timeout: 20000 }).catch(() => {});
      const tools = page.locator('[data-testid="interview-tools"]');
      const tv = await seen(tools, 30000);
      check('Interview Calendar: the interview panel has Interview tools', up && tv, { up, tv });
      if (tv) {
        await tools.locator('.ivt-head').click();
        check('... the scorecard opens with the kit questions', await seen(tools.locator('.ivt-qs li').first()));
      }
      await page.screenshot({ path: path.join(SHOTS, 'interview-tools.png') }).catch(() => {});
      await ctx.close();
    }
    {
      const { ctx, page } = await open('/admin/integrations?tab=jobportals&sub=site');
      check('Integrations > Job portals > Careers site: the site builder', await seen(page.locator('[data-testid="careers-site-admin"]'), 60000));
      await ctx.close();
    }
    {
      const { ctx, page } = await open('/site', { auth: false, width: 390 });
      check('Public /site at phone width: the banner and the job', await seen(page.getByText(`We hire ${RUN}`), 60000) && await seen(page.getByText(req.title).first()));
      const noScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
      check('... no sideways scrolling on a phone', noScroll);
      await page.screenshot({ path: path.join(SHOTS, 'site-phone.png'), fullPage: true }).catch(() => {});
      await page.getByText(req.title).first().click();
      const jobOk = await seen(page.locator('form.mkp-form'), 30000) && await seen(page.getByText('Do you have a two-wheeler?'));
      check('... the job page with the apply form and the job\'s own question', jobOk, jobOk ? undefined : { url: page.url(), text: (await page.evaluate(() => document.body.innerText).catch(() => '')).slice(0, 300) });
      await page.locator('.mkp-langs button', { hasText: 'తెలుగు' }).click();
      check('... Telugu labels', await seen(page.locator('h2', { hasText: 'ఇప్పుడే దరఖాస్తు చేయండి' })));
      await page.screenshot({ path: path.join(SHOTS, 'site-job-te.png'), fullPage: true }).catch(() => {});
      await ctx.close();
    }
    {
      const { ctx, page } = await open(`/book/${sb.token}`, { auth: false, width: 390 });
      check('Public /book: the candidate sees the time to pick', await seen(page.locator('.mkp-slot').first(), 60000) && await seen(page.locator('button', { hasText: 'Book this time' })));
      await ctx.close();
    }
    {
      const { ctx, page } = await open(`/test/${sent.token}`, { auth: false, width: 390 });
      const start = page.locator('button', { hasText: 'Start the test' });
      check('Public /test: the start screen', await seen(start, 60000));
      await start.click();
      check('... the question with its choices', await seen(page.getByText('kubectl applies a')) && (await page.locator('.mkp-opt').count()) === 2);
      await ctx.close();
    }
  } finally {
    await browser.close().catch(() => {});
  }
  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.log('FAIL  crashed:', e && e.message); await stop(1); });
