#!/usr/bin/env node
/**
 * BROWSER SMOKE of ViciDial "click to dial" (2026-11-24): the Admin fills the "ViciDial (office dialer)" card in Administration > Integrations >
 * Connections (server = a LOCAL STUB standing in for ViciDial, API user, password, On) and sets the recruiter's agent ID; the recruiter opens a
 * candidate, picks "ViciDial" in "Call using" and presses Call: a popup opens to the stub with function=external_dial, the right agent_user and
 * the candidate's number, and closes by itself; the recruiter saves "Connected" and the call history shows "ViciDial · requested by <name>".
 * With pop-ups blocked the call bar says "Allow pop-ups for <this site>" with the link to click once.
 * The office ViciDial is NEVER contacted: the only "ViciDial" here is the stub on 127.0.0.1.
 * A private sandbox server (copy of the sandbox database) + `vite preview` of the built frontend in front of it + Edge (playwright-core).
 * Build first: (cd frontend && npx vite build). Run:
 *   TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4531 node scripts/vicidial-click-browser.js     (screenshots: <tmp>/vicidial-shots-*)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const FRONT = path.resolve(BACK, '..', 'frontend');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-vici-smoke-${process.pid}.db`);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vicidial-shots-'));
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT || 4531);
const WEB = PORT + 1;
const env = {
  ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'vici-smoke', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`,
  INTEGRATION_SECRET_KEY: 'vici-smoke-key', BROWSER_CALL_AMI_USER: '', BROWSER_CALL_AMI_SECRET: '', AI_VOICE_AMI_USER: '', AI_VOICE_AMI_SECRET: '',
};
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };
const RUN = Date.now().toString(36);
const procs = []; let stub;
async function stop(code) {
  procs.forEach((p) => { try { p.kill(); } catch { /* gone */ } });
  if (stub) stub.close();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const waitFor = async (url, tries = 240) => { for (let i = 0; i < tries; i += 1) { if (await fetch(url).then((r) => r.status < 500).catch(() => false)) return true; await new Promise((r) => { setTimeout(r, 500); }); } return false; }; // eslint-disable-line no-await-in-loop
const PASS = `Smk-${RUN}-pw`;

(async () => {
  const hits = [];
  stub = http.createServer((req, res) => { if (req.url === '/favicon.ico') { res.writeHead(404); res.end(); return; } hits.push(req.url); res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('SUCCESS: external_dial function set - stub'); });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const STUB = `http://127.0.0.1:${stub.address().port}`;

  const mk = (tag, data) => prisma.user.create({ data: { name: `Vz ${tag} ${RUN}`, email: `vz.${tag}.${RUN}@vz-test.in`, username: `vz.${tag}.${RUN}@vz-test.in`, passwordHash: 'x', status: 'Active', hrmsRole: 'NONE', atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3), ...data } });
  const sa = await mk('admin', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' });
  const tl = await mk('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'IT', atsScopeDepartments: 'IT' });
  const rec = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'IT', atsScopeDepartments: 'IT' });
  const phone = `9${String(Date.now()).slice(-9)}`;
  const cand = await prisma.candidate.create({ data: { name: `Vzperson Marigold ${RUN}`, phone, email: `vz.${RUN}@vz-test.in` } });
  const client = await prisma.client.create({ data: { name: `Vz Client ${RUN}`, ownerDepartment: 'IT', agreementStatus: 'ACTIVE' } });
  const req = await prisma.requirement.create({ data: { title: `Vz Job ${RUN}`, clientId: client.id, department: 'IT', status: 'RECRUITER_ASSIGNED', tlId: tl.id, tl: tl.name, recruiterId: rec.id, reqCode: `VZ-${RUN}`.slice(0, 14), openings: 1 } });
  await prisma.application.create({ data: { candidateId: cand.id, requirementId: req.id, ownerRecruiterId: rec.id, stage: 'NEW' } });

  const be = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(be);
  if (!(await waitFor(`http://localhost:${PORT}/api/health`))) { console.log('FAIL  the sandbox server did not answer (set TEST_PORT)'); await stop(1); return; }
  const tok = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const tA = await tok(sa.id); const tR = await tok(rec.id);
  const api = (m, u, b) => fetch(`http://localhost:${PORT}/api${u}`, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tA}` }, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json());
  await api('PUT', '/browser-calling/admin/config', { mode: 'Test', testNumbers: phone, kinds: ['admin', 'tl', 'recruiter', 'hr'] });

  const web = spawn(process.execPath, [path.join(FRONT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(WEB), '--strictPort', '--host', 'localhost'], { cwd: FRONT, env: { ...process.env, API_PROXY: `http://localhost:${PORT}` }, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(web);
  if (!(await waitFor(`http://localhost:${WEB}/`))) { console.log('FAIL  the web server did not answer'); await stop(1); return; }

  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const newCtx = async (t) => { const c = await browser.newContext({ viewport: { width: 1360, height: 900 } }); await c.addInitScript((x) => { try { localStorage.setItem('tl_token', x); } catch (e) { /* none */ } }, t); c.on('dialog', (d) => d.accept().catch(() => {})); return c; };
  try {
    // 1. the Admin fills the card
    const actx = await newCtx(tA);
    const ap = await actx.newPage();
    await ap.goto(`http://localhost:${WEB}/admin/integrations?tab=connections`, { waitUntil: 'commit', timeout: 120000 });
    const card = ap.locator('[data-testid="vicidial-card"]');
    const cardUp = await card.waitFor({ state: 'visible', timeout: 90000 }).then(() => true).catch(() => false);
    check('Admin: Integrations > Connections has the "ViciDial (office dialer)" card, Off', cardUp && /ViciDial \(office dialer\)/.test(await card.innerText()) && /Off/.test(await card.locator('[data-testid="vici-switch"]').innerText()), cardUp ? '' : await ap.evaluate(() => document.body.innerText.slice(0, 300)).catch(() => ''));
    if (cardUp) {
      check('Admin: the card says the API user needs only the agent-API permission (external_dial)', /external_dial/.test(await card.innerText()));
      const recRow = card.locator('tr', { hasText: rec.name });
      check('Admin: the recruiter is listed with "not set"', /not set/.test(await recRow.innerText().catch(() => '')));
      await card.locator('input[aria-label="ViciDial server address"]').fill(STUB);
      await card.locator('input[aria-label="ViciDial API user"]').fill('teamlinkapi');
      await card.locator('input[aria-label="ViciDial API password"]').fill(PASS);
      await card.locator('button', { hasText: /^Save$/ }).first().click();
      await card.locator('input[aria-label="ViciDial API password"][placeholder*="stored"]').waitFor({ state: 'visible', timeout: 15000 }).catch(() => null);
      check('Admin: saved; the password box is empty and says "stored"', (await card.locator('input[aria-label="ViciDial API password"]').inputValue()) === '' && /stored/.test(await card.locator('input[aria-label="ViciDial API password"]').getAttribute('placeholder')));
      check('Admin: the page never shows the password', !(await ap.content()).includes(PASS));
      await card.locator('[data-testid="vici-switch"] button', { hasText: /^On$/ }).click();
      const onUp = await card.locator('[data-testid="vici-switch"] .status', { hasText: 'On' }).waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
      check('Admin: switched On', onUp, await card.innerText());
      await recRow.locator(`input[aria-label="ViciDial agent ID of ${rec.name}"]`).fill('1012');
      await recRow.locator('button', { hasText: 'Save' }).click();
      const agUp = await recRow.locator('b', { hasText: '1012' }).waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
      check('Admin: the recruiter\'s agent ID 1012 is saved and shown', agUp, await recRow.innerText().catch(() => ''));
      await ap.screenshot({ path: path.join(TMP, 'vicidial-card.png'), fullPage: true });
    }
    await actx.close();

    // 2. the recruiter calls on ViciDial
    const rctx = await newCtx(tR);
    const page = await rctx.newPage();
    await page.goto(`http://localhost:${WEB}/candidates/${cand.id}`, { waitUntil: 'commit', timeout: 120000 });
    const pick = page.locator('button[aria-label="Pick the line to call on"]').first();
    const pickUp = await pick.waitFor({ state: 'visible', timeout: 90000 }).then(() => true).catch(() => false);
    check('recruiter: the candidate\'s Call has the ▾ to pick the line', pickUp, await page.evaluate(() => document.body.innerText.slice(0, 300)).catch(() => ''));
    if (pickUp) {
      await pick.click();
      const bar = page.locator('[data-testid="call-bar"]');
      await bar.waitFor({ state: 'visible', timeout: 10000 }).catch(() => null);
      const sel = bar.locator('select[aria-label="Call using"]');
      const opts = await sel.locator('option').allInnerTexts().catch(() => []);
      check('call bar: "Call using" has ViciDial, pickable', opts.some((o) => /^ViciDial · on your ViciDial agent screen/.test(o)), opts);
      await sel.selectOption('vicidial');
      const li = await bar.locator('text=be logged in there').first().waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
      check('call bar: picking ViciDial says to be logged in to the agent screen', li, await bar.innerText().catch(() => ''));
      await page.screenshot({ path: path.join(TMP, 'call-using-vicidial.png') });
      const before = hits.length;
      const [popup] = await Promise.all([
        page.waitForEvent('popup', { timeout: 15000 }),
        bar.locator('button', { hasText: 'Call' }).first().click(),
      ]);
      await popup.waitForURL(/\/agc\/api\.php\?/, { timeout: 15000 }).catch(() => null);
      const pu = (() => { try { return new URL(popup.url()); } catch { return null; } })();
      check('Call: a popup opens to the stand-in ViciDial /agc/api.php', !!pu && pu.origin === STUB && pu.pathname === '/agc/api.php', popup.url().replace(/pass=[^&]*/, 'pass=•••'));
      check('the popup asks for function=external_dial, agent_user 1012 and the candidate\'s number', pu && pu.searchParams.get('function') === 'external_dial' && pu.searchParams.get('agent_user') === '1012' && pu.searchParams.get('value') === phone && pu.searchParams.get('user') === 'teamlinkapi' && pu.searchParams.get('phone_code') === '91');
      const t0 = Date.now();
      const closed = await popup.waitForEvent('close', { timeout: 12000 }).then(() => true).catch(() => popup.isClosed());
      check(`the popup closes by itself (after ${Math.round((Date.now() - t0) / 100) / 10} s)`, closed);
      check('the stand-in ViciDial received exactly that dial', hits.length > before && /function=external_dial/.test(hits[hits.length - 1]) && hits[hits.length - 1].includes(`value=${phone}`));
      const sent = await bar.locator('[data-testid="vici-sent"]').waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
      check('call bar: "Sent to ViciDial", recorded in ViciDial', sent && /Sent to ViciDial/.test(await bar.innerText()) && /recorded in ViciDial/i.test(await bar.innerText()));
      check('the recruiter\'s page never shows the password', !(await page.evaluate(() => document.body.innerText)).includes(PASS));
      await page.screenshot({ path: path.join(TMP, 'vicidial-sent.png') });
      await bar.locator('button', { hasText: /^Connected$/ }).click();
      await bar.locator('input[aria-label="Note"]').fill(`Spoke ${RUN}`);
      await bar.locator('button', { hasText: /^Save$/ }).click();
      const saved = await bar.locator('text=Saved').first().waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
      check('call bar: the outcome is saved', saved, await bar.innerText().catch(() => ''));
      await bar.locator('button', { hasText: 'Close' }).click();
      // the history
      await page.locator('button, a', { hasText: /^(Activity )?History$/ }).first().click().catch(() => null);
      const hist = page.locator('[data-testid="call-history"]');
      const hUp = await hist.waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false);
      if (hUp) await hist.locator('[data-testid="vici-line"]').first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => null);
      const ht = hUp ? await hist.innerText() : '';
      check('history: "ViciDial · requested by <recruiter>", Connected + note, "Recorded in ViciDial"', ht.includes(`ViciDial · requested by ${rec.name}`) && ht.includes(`Connected · Spoke ${RUN}`) && ht.includes('Recorded in ViciDial'), ht.slice(0, 500));
      await page.screenshot({ path: path.join(TMP, 'vicidial-history.png'), fullPage: true });

      // 3. pop-ups blocked: the plain message with the link
      await page.evaluate(() => { window.open = () => null; });
      await pick.click();
      await bar.waitFor({ state: 'visible', timeout: 10000 }).catch(() => null);
      await bar.locator('select[aria-label="Call using"]').selectOption('vicidial').catch(() => null);
      await bar.locator('button', { hasText: 'Call' }).first().click();
      const blk = await page.locator('[data-testid="vici-blocked"]').waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
      const bt = blk ? await page.locator('[data-testid="vici-blocked"]').innerText() : '';
      check('pop-ups blocked: "Allow pop-ups for localhost" with the link to click once', blk && /Allow pop-ups for localhost/.test(bt) && /Dial on ViciDial/.test(bt), bt || await bar.innerText().catch(() => ''));
      await page.screenshot({ path: path.join(TMP, 'vicidial-blocked.png') });
    }
    await rctx.close();
  } catch (e) { check(`no error in the browser run (${e.message.slice(0, 200)})`, false); }
  await browser.close();
  check('every "ViciDial" request went to the local stand-in only', hits.length >= 1 && hits.every((h) => h.startsWith('/agc/api.php?')));
  console.log(`\nscreenshots: ${TMP}\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
