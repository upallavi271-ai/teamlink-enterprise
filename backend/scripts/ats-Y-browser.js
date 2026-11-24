#!/usr/bin/env node
/**
 * BROWSER SMOKE of ATS wave 2 builder Y (2026-11-25): the new screens open and work in Edge.
 *   AI governance > Sourcing & AI connectors · candidate > Hiring tools (who knows whom, contacts) · IDs & consent > ID document check ·
 *   Candidates > Hiring tools > Outside search + Records to refresh (job changes) · Clients > Business development > Find companies ·
 *   the requirement's foundit row · Interview tools > Recordings & notes (notetaker, notes per scorecard question) · phone width.
 * A private sandbox server (copy of the sandbox database) + vite preview of the built frontend in front of it.
 *   (cd frontend && npx vite build) ; TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4560 node scripts/ats-Y-browser.js   (screenshots: <tmp>/ats-Y-shots)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const FRONT = path.resolve(BACK, '..', 'frontend');
const SHOTS = process.env.SHOTS_DIR || path.join(os.tmpdir(), 'ats-Y-shots');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-atsY-br-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT || 4560);
const WEB = PORT + 1;
const FAKE_STT = 'Strong on Kubernetes rollouts, I led the migration to EKS. Not sure about Terraform state locking.';
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'atsY-browser', INTEGRATION_SECRET_KEY: 'atsY-browser-key-0123456789', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`, BROWSER_CALL_FAKE_STT: FAKE_STT };
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
  const mk = (tag, data) => prisma.user.create({ data: { name: `Atyb ${tag} ${RUN}`, email: `atyb.${tag}.${RUN}@atyb-test.in`, username: `atyb.${tag}.${RUN}@atyb-test.in`, passwordHash: 'x', status: 'Active', hrmsRole: 'NONE', atsAccess: true, passwordChangedAt: new Date(Date.now() - 86400e3), ...data } });
  const sa = await mk('admin', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' });
  const client = await prisma.client.create({ data: { name: `Atyborbit ${RUN}`, ownerDepartment: 'IT', agreementStatus: 'ACTIVE' } });
  const req = await prisma.requirement.create({ data: { title: `Atybcloud Engineer ${RUN}`, clientId: client.id, department: 'IT', status: 'OPEN', reqCode: `ATB-${String(Date.now()).slice(-7)}`, openings: 1, skills: 'Kubernetes, AWS', location: 'Hyderabad', portalPublished: true, portalPublishedAt: new Date(), jobDescription: 'Run the cloud platform.' } });
  const CO = `Graphco ${RUN}`;
  const cand = await prisma.candidate.create({ data: { name: `Atybperson Quill ${RUN}`, phone: `8${String(Date.now()).slice(-9)}`, email: `atyb.${RUN}@gmail.com`, skills: 'Kubernetes', currentCompany: CO, currentDesignation: 'Cloud Engineer', dob: '1994-08-15' } });
  const mate = await prisma.candidate.create({ data: { name: `Atybmate Visible ${RUN}`, currentCompany: CO } });
  await prisma.application.create({ data: { candidateId: mate.id, requirementId: req.id, stage: 'NEW' } });
  for (const [i, t] of ['Engineer', 'Analyst', 'HR Manager'].entries()) await prisma.candidate.create({ data: { name: `Atybzen P${i} ${RUN}`, currentCompany: `Zentrix ${RUN}`, currentDesignation: t } }); // eslint-disable-line no-await-in-loop
  const app = await prisma.application.create({ data: { candidateId: cand.id, requirementId: req.id, stage: 'INTERVIEW_SCHEDULED', interviewStatus: 'SCHEDULED', interviewAt: new Date(Date.now() + 26 * 3600e3), interviewRound: 1, interviewer: sa.name, interviewMode: 'Online', interviewMeetingLink: 'https://meet.google.com/abc-defg-hij', interviewCode: `INT-${RUN}` } });

  const be = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(be);
  if (!(await waitFor(`http://localhost:${PORT}/api/health`))) { console.log('FAIL  the sandbox server did not answer (set TEST_PORT)'); await stop(1); return; }
  const web = spawn(process.execPath, [path.join(FRONT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(WEB), '--strictPort', '--host', 'localhost'], { cwd: FRONT, env: { ...process.env, API_PROXY: `http://localhost:${PORT}` }, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(web);
  if (!(await waitFor(`http://localhost:${WEB}/`))) { console.log('FAIL  the web server did not answer'); await stop(1); return; }
  const token = jwt.sign({ ...tokenPayload(await resolveIdentity(sa.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const api = async (method, url, body) => { const r = await fetch(`http://localhost:${PORT}/api${url}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined }); return r.json().catch(() => ({})); };
  await api('PUT', `/ats/mkt/jobs/${req.id}/kits/1`, { title: 'Cloud round', scale: 5, questions: [{ text: 'Explain a Kubernetes rollout you ran', type: 'rating' }, { text: 'Terraform state locking?', type: 'rating' }] });
  await api('POST', `/ats/mkt/interviews/${app.id}/recordings`, { url: 'https://drive.google.com/file/d/x/view', title: 'Meet recording', transcript: `${FAKE_STT} Communication was clear and calm across the whole call.` });
  const recs = await api('GET', `/ats/mkt/interviews/${app.id}/recordings`);
  if (recs.rows && recs.rows[0]) await api('POST', `/ats/mkt/recordings/${recs.rows[0].id}/notes`, {});
  await api('PUT', '/ats/y/settings', { key: 'prospecting', value: true });

  const { chromium } = require('playwright-core'); // eslint-disable-line global-require
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const open = async (urlPath, { width = 1280 } = {}) => {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    await ctx.addInitScript((t) => { try { localStorage.setItem('tl_token', t); } catch (e) { /* none */ } }, token);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message || e)));
    await page.goto(`http://localhost:${WEB}${urlPath}`, { waitUntil: 'commit', timeout: 120000 });
    return { ctx, page, errors };
  };
  const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true }).catch(() => {});
  try {
    {
      const { ctx, page, errors } = await open('/admin/ai-governance?tab=sourcingY');
      const box = page.locator('[data-testid="atsy-admin"]');
      check('AI governance > Sourcing & AI connectors: six switches and the connectors list', await seen(box, 60000) && (await box.locator('input[type=checkbox]').count()) === 6 && await seen(box.getByText('Naukri Resdex').first()));
      check('... "Prospecting" shows ON (switched on above), the rest OFF', (await box.locator('input[type=checkbox]:checked').count()) === 1);
      check('... no page errors', !errors.length, errors);
      await shot(page, 'admin-sourcing');
      await ctx.close();
    }
    {
      const { ctx, page, errors } = await open(`/candidates/${cand.id}?tab=tools`);
      const box = page.locator('[data-testid="atsy-cand"]');
      check('Candidate > Hiring tools: "Who knows whom" names the colleague at the same employer', await seen(box, 60000) && await seen(box.getByText(mate.name).first()));
      check('... the graph picture is drawn', await seen(box.locator('svg[role=img]').first()));
      check('... "Find contact details" is there', await seen(page.locator('[data-testid="atsy-contacts"]')));
      check('... no page errors', !errors.length, errors);
      await shot(page, 'candidate-sourcing');
      await ctx.close();
    }
    {
      const { ctx, page } = await open(`/candidates/${cand.id}`);
      const ids = page.locator('button', { hasText: 'IDs & consent' }).first();
      if (await seen(ids, 20000)) await ids.click();
      const idm = page.locator('[data-testid="atsy-idmatch"]');
      check('IDs & consent: the ID document check', await seen(idm, 30000));
      await idm.locator('button', { hasText: 'Type what the card says' }).click().catch(() => {});
      await idm.locator('textarea').fill(`INCOME TAX DEPARTMENT ${cand.name} 15/08/1994 ABCDE1234F`).catch(() => {});
      await idm.locator('button', { hasText: 'Check the typed words' }).click().catch(() => {});
      const res = page.locator('[data-testid="atsy-idmatch-result"]');
      check('... typed words checked: name and date of birth match, the PAN is masked', await seen(res, 30000) && await seen(res.getByText('ABXXXXX34F')) && !(await res.innerText()).includes('ABCDE1234F'));
      await shot(page, 'id-match');
      await ctx.close();
    }
    {
      const { ctx, page, errors } = await open('/candidates?view=tools&tool=outside');
      const box = page.locator('[data-testid="atsy-outside"]');
      check('Candidates > Hiring tools > Outside search: Resdex says it needs the founder\'s Naukri access', await seen(box, 60000) && await seen(box.getByText(/Resdex API|partner access/).first()));
      check('... the outside profiles card is there', await seen(page.locator('[data-testid="atsy-people"]')));
      check('... no page errors', !errors.length, errors);
      await shot(page, 'outside-search');
      await ctx.close();
    }
    {
      const { ctx, page } = await open('/candidates?view=tools&tool=records');
      check('Records to refresh: the job changes card with "Check now"', await seen(page.locator('[data-testid="atsy-jobchanges"]'), 60000) && await seen(page.locator('[data-testid="atsy-jobchanges"] button', { hasText: 'Check now' })));
      await ctx.close();
    }
    {
      const { ctx, page, errors } = await open('/clients/bd');
      const tab = page.locator('[role=tab]', { hasText: 'Find companies' }).first();
      const t = await seen(tab, 60000);
      if (t) await tab.click();
      const box = page.locator('[data-testid="atsy-prospecting"]');
      check('Clients > Business development > Find companies: our own data suggests the company 3 of our candidates work at', t && await seen(box, 30000) && await seen(box.getByText(`Zentrix ${RUN}`).first()));
      check('... no page errors', !errors.length, errors);
      await shot(page, 'prospecting');
      await ctx.close();
    }
    {
      const { ctx, page } = await open(`/requirements/${req.id}`);
      const box = page.locator('[data-testid="atsy-boards"]');
      check('Requirement > Where it is posted: the foundit row says what the founder must get', await seen(box, 60000) && await seen(box.getByText(/foundit/).first()));
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
      if (tv) {
        await tools.locator('.ivt-head').click();
        await tools.locator('[role=tab]', { hasText: 'Recordings' }).first().click().catch(() => {});
      }
      check('Interview tools > Recordings & notes: the notetaker (switched off) is offered', tv && await seen(tools.locator('[data-testid="atsy-notetaker"]'), 30000));
      check('... the notes per scorecard question with "Copy to my scorecard"', tv && await seen(tools.locator('[data-testid="atsy-kitmap"] button', { hasText: 'Copy to my scorecard' }), 30000));
      await shot(page, 'interview-ai');
      await ctx.close();
    }
    {
      const { ctx, page } = await open(`/candidates/${cand.id}?tab=tools`, { width: 390 });
      const box = page.locator('[data-testid="atsy-graph"]');
      const ok = await seen(box, 60000);
      const noScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
      check('phone width: the candidate\'s Hiring tools cards fit (no sideways scroll)', ok && noScroll, { ok, noScroll });
      await shot(page, 'candidate-phone');
      await ctx.close();
    }
  } finally {
    await browser.close().catch(() => {});
  }
  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.log('FAIL  crashed:', e && e.message); await stop(1); });
