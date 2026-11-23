#!/usr/bin/env node
/**
 * BROWSER SMOKE of PHONE LINES + CALL HISTORY (founder 2026-11-23): the Admin adds a line by IP address in Omni-Channel > AI Voice >
 * Browser calling > Phone lines and sees it in the list; on a candidate the call bar shows "Call using" with that line; the candidate's
 * call history shows a recorded call with its talk time, Play (it plays) and the summary.
 * A private sandbox server (copy of the sandbox database) + `vite preview` of the built frontend in front of it + Edge (playwright-core).
 * Build first: (cd frontend && npx vite build). Run:
 *   TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4531 node scripts/phone-lines-browser.js     (screenshots: <tmp>/phone-lines-shots-*)
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
const COPY = path.join(os.tmpdir(), `zz-pl-smoke-${process.pid}.db`);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-lines-shots-'));
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT || 4531);
const WEB = PORT + 1;
const env = {
  ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'pl-smoke', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`,
  INTEGRATION_SECRET_KEY: 'pl-smoke-key', UPLOAD_DIR: path.join(TMP, 'uploads'), BROWSER_CALL_LINES_PJSIP_FILE: path.join(TMP, 'no-pbx', 'x.conf'), BROWSER_CALL_LINES_DIALPLAN_FILE: path.join(TMP, 'no-pbx', 'y.conf'),
  BROWSER_CALL_AMI_USER: '', BROWSER_CALL_AMI_SECRET: '', AI_VOICE_AMI_USER: '', AI_VOICE_AMI_SECRET: '',
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
const wav = (sec) => { const rate = 8000; const n = rate * sec; const b = Buffer.alloc(44 + n * 2); b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40); for (let i = 0; i < n; i += 1) b.writeInt16LE(Math.round(6000 * Math.sin(i / 5)), 44 + i * 2); return b; };

(async () => {
  const sa = await prisma.user.create({ data: { name: `Pz admin ${RUN}`, email: `pz.admin.${RUN}@pz-test.in`, username: `pz.admin.${RUN}@pz-test.in`, passwordHash: 'x', status: 'Active', hrmsRole: 'NONE', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3) } });
  const phone = `9${String(Date.now()).slice(-9)}`;
  const cand = await prisma.candidate.create({ data: { name: `Pzperson Larkspur ${RUN}`, phone, email: `pz.${RUN}@pz-test.in` } });

  const be = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(be);
  if (!(await waitFor(`http://localhost:${PORT}/api/health`))) { console.log('FAIL  the sandbox server did not answer (set TEST_PORT)'); await stop(1); return; }
  const token = jwt.sign({ ...tokenPayload(await resolveIdentity(sa.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const api = (m, u, b) => fetch(`http://localhost:${PORT}/api${u}`, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json());
  await api('PUT', '/browser-calling/admin/config', { mode: 'Test', testNumbers: phone, kinds: ['admin', 'tl', 'recruiter', 'hr'] });
  // a recorded, transcribed, summarised call on this candidate (what the after-call job leaves behind)
  const S = require('../src/browsercall/schema');
  const callId = crypto.randomUUID();
  const dir = path.join(env.UPLOAD_DIR, 'call-recordings'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${callId}.wav`), wav(3));
  const t0 = new Date(Date.now() - 3600e3); const ta = new Date(t0.getTime() + 9000); const te = new Date(ta.getTime() + 222000);
  const SUM = `Discussed: Wants a Java role near Hitec City ${RUN}. Interest: Interested. Notice period: 30 days. Next step: will send the resume today.`;
  await S.run('INSERT INTO "BrowserCall" ("id","token","candidateId","userId","userName","toNumber","extension","direction","status","startAt","answerAt","endAt","durationSec","talkSec","createdAt","updatedAt","lineId","lineName","recordingStatus","recordingPath","recordingBytes","recordingSec","transcript","transcriptSource","summary","summaryText","summarySource","processedAt") VALUES (?,?,?,?,?,?,\'7001\',\'outbound\',\'completed\',?,?,?,231,222,?,?,\'default\',\'Office Synway (SIM)\',\'done\',?,?,3,?,\'Test\',?,?,\'Test\',?)',
    callId, crypto.randomBytes(12).toString('hex'), cand.id, sa.id, sa.name, phone, t0.toISOString(), ta.toISOString(), te.toISOString(), t0.toISOString(), te.toISOString(), `${callId}.wav`, 48044, `Recruiter: hello. Candidate: I am looking for Java ${RUN}.`, JSON.stringify({ discussed: 'x' }), SUM, te.toISOString());

  const web = spawn(process.execPath, [path.join(FRONT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(WEB), '--strictPort', '--host', 'localhost'], { cwd: FRONT, env: { ...process.env, API_PROXY: `http://localhost:${PORT}` }, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(web);
  if (!(await waitFor(`http://localhost:${WEB}/`))) { console.log('FAIL  the web server did not answer'); await stop(1); return; }

  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await ctx.addInitScript((t) => { try { localStorage.setItem('tl_token', t); } catch (e) { /* none */ } }, token);
  ctx.on('dialog', (d) => d.accept().catch(() => {}));
  const page = await ctx.newPage();
  const LINE = `Vici smoke ${RUN}`;
  try {
    // 1. the Admin adds a line by IP address and sees it in the list
    await page.goto(`http://localhost:${WEB}/omni-channel-native/campaigns/aivoice`, { waitUntil: 'commit', timeout: 120000 });
    const tab = page.locator('button', { hasText: /^Browser calling$/ }).first();
    const tabUp = await tab.waitFor({ state: 'visible', timeout: 90000 }).then(() => true).catch(() => false);
    check('Admin: Omni-Channel > AI Voice has the Browser calling tab', tabUp, await page.evaluate(() => document.body.innerText.slice(0, 300)).catch(() => ''));
    if (tabUp) await tab.click();
    const sec = page.locator('[data-testid="phone-lines"]');
    const secUp = await sec.waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false);
    check('Admin: the Phone lines section is there, with the built-in Office Synway (SIM)', secUp && (await sec.innerText()).includes('Office Synway (SIM)'));
    check('Admin: the "Record calls" switch is there and On', await page.locator('[data-testid="record-switch"] button.btn-primary', { hasText: 'On' }).isVisible().catch(() => false));
    if (secUp) {
      await sec.locator('button', { hasText: '+ Add a line' }).click();
      const form = page.locator('[data-testid="line-form"]');
      await form.waitFor({ state: 'visible', timeout: 10000 });
      await form.locator('select[aria-label="Kind of line"]').selectOption('vicidial');
      check('Admin: the help text for ViciDial says which carrier settings to use', /Admin > Carriers/.test(await form.innerText()));
      await form.locator('input[aria-label="Line name"]').fill(LINE);
      await form.locator('label', { hasText: 'We send calls to its IP address' }).locator('input').check();
      await form.locator('input[aria-label="IP address"]').fill('203.0.113.44');
      await form.locator('input[aria-label="Prefix"]').fill('9');
      await form.locator('button', { hasText: 'Save line' }).click();
      const row = sec.locator('tr', { hasText: LINE });
      const rowUp = await row.waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false);
      check('Admin: the new IP line is in the list (address, port, prefix)', rowUp && /203\.0\.113\.44:5060 UDP/.test(await row.innerText()) && /Prefix 9/.test(await row.innerText()), rowUp ? await row.innerText() : await sec.innerText());
      check('Admin: the screen says this server is not the phone system (nothing written to Asterisk here)', /not the phone system/.test(await sec.innerText()));
      await page.screenshot({ path: path.join(TMP, 'phone-lines.png'), fullPage: true });
    }
    // 2. the call bar shows "Call using" with the line
    await page.goto(`http://localhost:${WEB}/candidates/${cand.id}`, { waitUntil: 'commit', timeout: 120000 });
    const pick = page.locator('button[aria-label="Pick the line to call on"]').first();
    const pickUp = await pick.waitFor({ state: 'visible', timeout: 90000 }).then(() => true).catch(() => false);
    check('candidate profile: Call has the small ▾ to pick the line (more than one line)', pickUp, await page.evaluate(() => document.body.innerText.slice(0, 400)).catch(() => ''));
    if (pickUp) {
      await pick.click();
      const bar = page.locator('[data-testid="call-bar"]');
      await bar.waitFor({ state: 'visible', timeout: 10000 }).catch(() => null);
      const opts = await bar.locator('select[aria-label="Call using"] option').allInnerTexts().catch(() => []);
      check('call bar: "Call using" lists the Office Synway and the new line', opts.some((o) => o.includes('Office Synway (SIM)')) && opts.some((o) => o.includes(LINE)), opts);
      await bar.locator('select[aria-label="Call using"]').selectOption({ label: opts.find((o) => o.includes(LINE)) || opts[0] }).catch(() => null);
      await page.screenshot({ path: path.join(TMP, 'call-using.png') });
      await bar.locator('button', { hasText: 'Cancel' }).click();
      check('call bar: Cancel closes it', (await bar.count()) === 0);
      check('the choice is remembered on this computer', (await page.evaluate(() => localStorage.getItem('tl_browser_call_line'))) !== null);
    }
    // 3. the call history: talk time, Play, the summary
    await page.locator('button, a', { hasText: /^(Activity )?History$/ }).first().click().catch(() => null);
    const hist = page.locator('[data-testid="call-history"]');
    const hUp = await hist.waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false);
    if (hUp) await hist.locator('[data-testid="talk-time"]').first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => null);
    const ht = hUp ? await hist.innerText() : '';
    check('history: the recorded call shows who called, the line, talk time 3:42 and the summary', hUp && ht.includes(sa.name) && ht.includes('Office Synway (SIM)') && ht.includes('3:42') && ht.includes(`Hitec City ${RUN}`), ht.slice(0, 500));
    const play = hist.locator('button', { hasText: 'Play' }).first();
    if (await play.isVisible().catch(() => false)) {
      await play.click();
      const au = await hist.locator('[data-testid="call-audio"]').waitFor({ state: 'attached', timeout: 15000 }).then(() => true).catch(() => false);
      const dur = au ? await hist.locator('[data-testid="call-audio"]').evaluate((a) => new Promise((r) => { if (a.readyState >= 1) r(a.duration); else { a.onloadedmetadata = () => r(a.duration); setTimeout(() => r(a.duration), 5000); } })) : 0;
      check('history: Play fetches the recording with the login and plays it (3 s)', au && Math.round(dur) === 3, dur);
    } else check('history: Play is there', false);
    await hist.locator('button', { hasText: 'Show full conversation' }).first().click().catch(() => null);
    const conv = await hist.locator('text=I am looking for Java').first().waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
    check('history: "Show full conversation" opens the transcript', conv);
    await page.screenshot({ path: path.join(TMP, 'call-history.png'), fullPage: true });
  } catch (e) { check(`no error in the browser run (${e.message.slice(0, 160)})`, false); }
  await browser.close();
  console.log(`\nscreenshots: ${TMP}\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
