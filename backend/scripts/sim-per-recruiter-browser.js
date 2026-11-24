#!/usr/bin/env node
/**
 * BROWSER SMOKE of ONE SIM NUMBER PER RECRUITER (founder 2026-11-25): the Admin sees "SIM numbers" in Omni-Channel > AI Voice > Browser calling,
 * adds port 1 with its SIM number and gives it to a recruiter; the recruiter's call bar shows "Your calling number: <SIM>"; an incoming call on
 * that SIM pops up with the candidate's name, their current requirement and a masked number, and Answer / Decline work.
 * HOW THE INCOMING CALL IS SIMULATED: there is no phone system here, so the test (1) writes the call row the phone system's AMI event would
 * have written (direction inbound, token in<digits>) and (2) rings the page through the CallProvider's incoming handler, exposed as
 * window.__tlSoftphone.incoming(invitation), with a fake SIP.js Invitation: { remoteIdentity.uri.user = token, stateChange.addListener,
 * accept(), reject(), bye() } - accept() reports "Established", reject() / bye() report "Terminated", exactly the SIP.js session states.
 * A private sandbox server (copy of the sandbox database) + `vite preview` of the built frontend + Edge (playwright-core).
 * Build first: (cd frontend && npx vite build). Run:
 *   TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4631 node scripts/sim-per-recruiter-browser.js     (screenshots: <tmp>/sim-shots-*)
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const FRONT = path.resolve(BACK, '..', 'frontend');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-sim-smoke-${process.pid}.db`);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-shots-'));
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT || 4631);
const WEB = PORT + 1;
const env = {
  ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'sim-smoke', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`,
  INTEGRATION_SECRET_KEY: 'sim-smoke-key', UPLOAD_DIR: path.join(TMP, 'uploads'), BROWSER_CALL_LINES_PJSIP_FILE: path.join(TMP, 'no-pbx', 'x.conf'), BROWSER_CALL_LINES_DIALPLAN_FILE: path.join(TMP, 'no-pbx', 'y.conf'),
  BROWSER_CALL_AMI_USER: '', BROWSER_CALL_AMI_SECRET: '', AI_VOICE_AMI_USER: '', AI_VOICE_AMI_SECRET: '', BROWSER_CALL_WSS_URL: '',
};
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

// the fake SIP.js Invitation the page is rung with (runs inside the page)
function ringPage(token) {
  const listeners = [];
  const inv = {
    remoteIdentity: { uri: { user: token } }, state: 'Initial', calls: [],
    stateChange: { addListener: (fn) => listeners.push(fn) },
    set(st) { inv.state = st; listeners.forEach((fn) => fn(st)); },
    accept() { inv.calls.push('accept'); setTimeout(() => inv.set('Established'), 50); return Promise.resolve(); },
    reject(o) { inv.calls.push(`reject ${(o && o.statusCode) || ''}`.trim()); setTimeout(() => inv.set('Terminated'), 50); return Promise.resolve(); },
    bye() { inv.calls.push('bye'); setTimeout(() => inv.set('Terminated'), 50); return Promise.resolve(); },
  };
  window.__fakeInv = inv;
  window.__tlSoftphone.incoming(inv);
  return true;
}

(async () => {
  const mk = (tag, data) => prisma.user.create({ data: { name: `Sz ${tag} ${RUN}`, email: `sz.${tag}.${RUN}@sz-test.in`, username: `sz.${tag}.${RUN}@sz-test.in`, passwordHash: 'x', status: 'Active', hrmsRole: 'NONE', atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3), ...data } });
  const sa = await mk('admin', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' });
  const tl = await mk('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'IT', atsScopeDepartments: 'IT' });
  const rec = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'IT', atsScopeDepartments: 'IT' });
  const phone = `9${String(Date.now()).slice(-9)}`;
  const SIM = `8${String(Date.now() + 7).slice(-9)}`;
  const cand = await prisma.candidate.create({ data: { name: `Szperson Marigold ${RUN}`, phone, email: `sz.${RUN}@sz-test.in` } });
  const client = await prisma.client.create({ data: { name: `Szclient ${RUN}`, ownerDepartment: 'IT', agreementStatus: 'ACTIVE' } });
  const req = await prisma.requirement.create({ data: { title: `Szjava Developer ${RUN}`, clientId: client.id, department: 'IT', status: 'RECRUITER_ASSIGNED', tlId: tl.id, tl: tl.name, recruiterId: rec.id, reqCode: `SZ-${RUN}`.toUpperCase().slice(0, 14), openings: 1 } });
  const app = await prisma.application.create({ data: { candidateId: cand.id, requirementId: req.id, ownerRecruiterId: rec.id, stage: 'NEW' } });

  const be = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(be);
  if (!(await waitFor(`http://localhost:${PORT}/api/health`))) { console.log('FAIL  the sandbox server did not answer (set TEST_PORT)'); await stop(1); return; }
  const tokFor = async (u) => jwt.sign({ ...tokenPayload(await resolveIdentity(u.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const tA = await tokFor(sa); const tR = await tokFor(rec);
  const api = (m, u, b, t = tA) => fetch(`http://localhost:${PORT}/api${u}`, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json());
  await api('PUT', '/browser-calling/admin/config', { mode: 'Test', testNumbers: phone, kinds: ['admin', 'tl', 'recruiter', 'hr'] });
  await api('POST', '/browser-calling/admin/lines', { name: `Sz Dinstar ${RUN}`, type: 'ip', connect: 'ip', host: '203.0.113.45' }); // a second line, so the call bar's ▾ "pick the line" is there

  const web = spawn(process.execPath, [path.join(FRONT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(WEB), '--strictPort', '--host', 'localhost'], { cwd: FRONT, env: { ...process.env, API_PROXY: `http://localhost:${PORT}` }, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(web);
  if (!(await waitFor(`http://localhost:${WEB}/`))) { console.log('FAIL  the web server did not answer'); await stop(1); return; }

  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel: process.env.TEST_BROWSER || 'msedge', headless: true });
  const open = async (token) => {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await ctx.addInitScript((t) => { try { localStorage.setItem('tl_token', t); } catch (e) { /* none */ } }, token);
    ctx.on('dialog', (d) => d.accept().catch(() => {}));
    return { ctx, page: await ctx.newPage() };
  };
  try {
    // 1. Admin: the SIM numbers section; add port 1 and give it to the recruiter
    {
      const { ctx, page } = await open(tA);
      await page.goto(`http://localhost:${WEB}/omni-channel-native/campaigns/aivoice`, { waitUntil: 'commit', timeout: 120000 });
      const tab = page.locator('button', { hasText: /^Browser calling$/ }).first();
      const tabUp = await tab.waitFor({ state: 'visible', timeout: 90000 }).then(() => true).catch(() => false);
      if (tabUp) await tab.click();
      const sec = page.locator('[data-testid="sim-numbers"]');
      const secUp = await sec.waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false);
      check('Admin: Browser calling has the "SIM numbers" section (no new sidebar item), Port prefix routing Off', secUp && (await sec.innerText()).includes('SIM numbers') && await sec.locator('[data-testid="sim-routing"] button.btn-primary', { hasText: 'Off' }).isVisible(), secUp ? (await sec.innerText()).slice(0, 300) : await page.evaluate(() => document.body.innerText.slice(0, 300)));
      if (secUp) {
        await sec.locator('button', { hasText: '+ Add a SIM port' }).click();
        const form = sec.locator('[data-testid="sim-form"]');
        await form.waitFor({ state: 'visible', timeout: 10000 });
        await form.locator('input[aria-label="SIM number"]').fill(SIM);
        await form.locator('select[aria-label="Operator"]').selectOption('Airtel');
        const opts = await form.locator('select[aria-label="Given to"] option').allInnerTexts();
        check('Admin: "Given to" lists the recruiter but never a BDE / Manager', opts.some((o) => o.includes(rec.name)), opts);
        await form.locator('select[aria-label="Given to"]').selectOption({ label: opts.find((o) => o.includes(rec.name)) });
        await form.locator('button', { hasText: 'Save SIM port' }).click();
        const row = sec.locator('[data-testid="sim-row-01"]');
        const rowUp = await row.waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false);
        const rt = rowUp ? await row.innerText() : '';
        check('Admin: port 01 is in the list with the SIM number, operator, dial prefix 01# and "SIM number" matching', rowUp && rt.includes(SIM) && rt.includes('Airtel') && rt.includes('01#') && rt.includes('SIM number'), rt);
        check('Admin: the port is given to the recruiter (with their browser extension)', rowUp && (await row.locator('select').inputValue()) === rec.id && /Browser extension \d+/.test(rt));
        await sec.locator('[data-testid="sim-routing"] button', { hasText: /^On$/ }).click();
        const onUp = await sec.locator('[data-testid="sim-routing"] button.btn-primary', { hasText: 'On' }).waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
        check('Admin: Port prefix routing can be switched On', onUp);
        await sec.locator('input[aria-label="Called number to check"]').fill(SIM);
        await sec.locator('button', { hasText: /^Check$/ }).click();
        const chk = await sec.locator('[data-testid="sim-check"]').innerText().catch(() => '');
        check('Admin: "Check a called number" says a call to the SIM rings the recruiter on port 01', chk.includes(rec.name) && chk.includes('port 01'), chk);
        await sec.locator('button', { hasText: 'Show the phone system text' }).click();
        const pv = await sec.locator('[data-testid="sim-preview"]').innerText().catch(() => '');
        check('Admin: the phone system text shows [tl-from-gateway] and the p01 route', pv.includes('[tl-from-gateway]') && pv.includes(`exten => ${SIM},1,Goto(tl-sim-ring,p01,1)`) && pv.includes('Dial(PJSIP/01#${ARG1}@teamlink-gw,45)'), pv.slice(0, 300));
        await page.screenshot({ path: path.join(TMP, 'sim-numbers.png'), fullPage: true });
      }
      await ctx.close();
    }
    // 2. Recruiter: "Your calling number" in the call bar; an incoming call pops up; Answer and Decline
    {
      const { ctx, page } = await open(tR);
      await page.goto(`http://localhost:${WEB}/candidates/${cand.id}`, { waitUntil: 'commit', timeout: 120000 });
      const pick = page.locator('button[aria-label="Pick the line to call on"]').first();
      const pickUp = await pick.waitFor({ state: 'visible', timeout: 90000 }).then(() => true).catch(() => false);
      check('recruiter: the candidate profile has Call with the ▾ line picker', pickUp, await page.evaluate(() => document.body.innerText.slice(0, 300)).catch(() => ''));
      const bar = page.locator('[data-testid="call-bar"]');
      if (pickUp) {
        await pick.click();
        await bar.waitFor({ state: 'visible', timeout: 10000 }).catch(() => null);
        const mine = await bar.locator('[data-testid="my-sim-number"]').innerText().catch(() => '');
        check('call bar: "Your calling number: <the recruiter\'s SIM>" (read-only) on the office Synway line', mine.includes(`Your calling number: ${SIM}`), mine);
        await page.screenshot({ path: path.join(TMP, 'call-bar-your-number.png') });
        await bar.locator('select[aria-label="Call using"]').selectOption({ index: 1 }).catch(() => null);
        check('call bar: on another line it is not shown (that line has its own number)', (await bar.locator('[data-testid="my-sim-number"]').count()) === 0);
        await bar.locator('select[aria-label="Call using"]').selectOption({ index: 0 }).catch(() => null);
        await bar.locator('button', { hasText: 'Cancel' }).click();
      }
      // the row the phone system's AMI event writes for an incoming call on port 1 (browsercall/sims.js onInboundStart)
      const S = require('../src/browsercall/schema');
      const ring = async () => {
        const u = `${Math.floor(Date.now() / 1000)}.${Math.floor(Math.random() * 1000)}`; const token = `in${u.replace(/\D/g, '')}`;
        const ext = (await S.one('SELECT "extension" FROM "BrowserCallExtension" WHERE "userId"=?', rec.id)).extension; const now = new Date().toISOString();
        await S.run('INSERT INTO "BrowserCall" ("id","token","asteriskUniqueId","candidateId","applicationId","userId","userName","toNumber","extension","direction","mode","status","startAt","createdAt","updatedAt","lineId","lineName","recordingStatus") VALUES (?,?,?,?,?,?,?,?,?,\'inbound\',\'Test\',\'ringing\',?,?,?,\'default\',\'Office Synway (SIM) · port 01\',\'pending\')',
          crypto.randomUUID(), token, u, cand.id, app.id, rec.id, rec.name, phone, ext, now, now, now);
        await page.waitForFunction(() => !!window.__tlSoftphone, null, { timeout: 30000 });
        await page.evaluate(ringPage, token);
        return token;
      };
      await ring();
      const pop = page.locator('[data-testid="incoming-call"]');
      const popUp = await pop.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
      await pop.locator('[data-testid="incoming-name"]', { hasText: cand.name }).waitFor({ state: 'visible', timeout: 15000 }).catch(() => null);
      const pt = popUp ? await pop.innerText() : '';
      const masked = `${phone.slice(0, 2)}XXXXXX${phone.slice(-2)}`;
      check('incoming: a ringing popup with the candidate\'s name, current requirement and the masked number', popUp && pt.includes(cand.name) && pt.includes(`Szjava Developer ${RUN}`) && pt.includes(masked) && !pt.includes(phone), pt);
      check('incoming: it has Answer and Decline, and says it came in on the SIM port', popUp && await pop.locator('button', { hasText: 'Answer' }).isVisible() && await pop.locator('button', { hasText: 'Decline' }).isVisible() && /port 01/.test(pt));
      await page.screenshot({ path: path.join(TMP, 'incoming-popup.png') });
      if (popUp) {
        await pop.locator('button', { hasText: 'Answer' }).click();
        const conn = await bar.locator('text=Connected').waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
        const bt = conn ? await bar.innerText() : '';
        check('Answer: the same call bar, Connected, with Mute / Hold / Hang up, marked Incoming', conn && /Incoming/.test(bt) && /Mute/.test(bt) && /Hold/.test(bt) && /Hang up/.test(bt) && (await page.evaluate(() => window.__fakeInv.calls.join(','))) === 'accept', bt);
        await page.screenshot({ path: path.join(TMP, 'incoming-answered.png') });
        await bar.locator('button', { hasText: 'Hang up' }).click();
        const ended = await bar.locator('text=Ended').waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
        check('Hang up ends it (bye) and the bar says Ended', ended && (await page.evaluate(() => window.__fakeInv.calls.join(','))) === 'accept,bye');
        await bar.locator('button', { hasText: 'Close' }).click().catch(() => null);
      }
      await ring();
      const pop2 = await pop.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
      if (pop2) {
        await pop.locator('button', { hasText: 'Decline' }).click();
        const missed = await bar.locator('text=Missed').first().waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
        check('Decline rejects it (486 Busy) and the bar says Missed (it is in the history as missed)', missed && (await page.evaluate(() => window.__fakeInv.calls.join(','))) === 'reject 486', await bar.innerText().catch(() => ''));
      } else check('a second incoming call pops up again', false);
      await ctx.close();
    }
  } catch (e) { check(`no error in the browser run (${e.message.slice(0, 160)})`, false); }
  await browser.close();
  console.log(`\nscreenshots: ${TMP}\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
