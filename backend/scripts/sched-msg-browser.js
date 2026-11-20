#!/usr/bin/env node
/**
 * BROWSER SMOKE of the candidate profile's "Schedule a message" tab (founder 2026-11-20): a recruiter opens a candidate, opens the tab, picks a ready message,
 * sees the live preview with the name filled, schedules it, sees it under Scheduled, edits it, cancels it (it moves to Cancelled), gets a clear error for a
 * time outside the sending hours with a "Use ..." button; the BDE side sees only numbers; the page fits a phone. A private sandbox server (copy of the sandbox
 * database) + the Vite preview in front of it + Edge.   Build the frontend first (npx vite build).
 *   TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4351 node scripts/sched-msg-browser.js     (screenshots: docs/sched-msg-2026-11-20/)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const FRONT = path.resolve(BACK, '..', 'frontend');
const SHOTS = path.resolve(BACK, '..', 'docs', 'sched-msg-2026-11-20');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-schedmsg-smoke-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const dbx = new DatabaseSync(COPY);
dbx.exec("DELETE FROM \"IntegrationEvent\" WHERE \"integrationId\" IN ('email', 'whatsapp', 'whatsapp-qr', 'sms', 'sms-android', 'telephony')");
dbx.exec("DELETE FROM \"Integration\" WHERE \"id\" IN ('email', 'whatsapp', 'whatsapp-qr', 'sms', 'sms-android', 'telephony')");
dbx.close();
const PORT = Number(process.env.TEST_PORT || 4351);
const WEB = PORT + 1;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'sm-smoke', INTEGRATION_SECRET_KEY: 'zz-sm-smoke-integration-key', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const { writeValues } = require('../src/utils/integrationStore');
const CAT = require('../src/utils/adminCatalog');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 500)}` : ''}`); } };
const RUN = Date.now().toString(36);
const procs = [];
async function stop(code) {
  procs.forEach((p) => { try { p.kill(); } catch { /* gone */ } });
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const waitFor = async (url, tries = 240) => { for (let i = 0; i < tries; i += 1) { if (await fetch(url).then((r) => r.status < 500).catch(() => false)) return true; await new Promise((r) => { setTimeout(r, 500); }); } return false; }; // eslint-disable-line no-await-in-loop
const setRow = async (id, fields) => {
  const w = await writeValues(id, fields);
  await prisma.integration.upsert({ where: { id }, create: { id, values: JSON.stringify(w.values), enabled: true, connected: true, state: 'Connected' }, update: { values: JSON.stringify(w.values), enabled: true, connected: true, state: 'Connected' } });
};

(async () => {
  const mk = (tag, data) => prisma.user.create({ data: { name: `Sx ${tag} ${RUN}`, email: `sx.${tag}.${RUN}@sx-test.in`, username: `sx.${tag}.${RUN}@sx-test.in`, passwordHash: 'x', status: 'Active', hrmsRole: 'NONE', atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3), ...data } });
  const tl = await mk('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' });
  const rec = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' });
  const bde = await mk('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Medical' });
  const client = await prisma.client.create({ data: { name: `Sx Hospital ${RUN}`, location: 'Hyderabad', ownerDepartment: 'Medical', bdeOwner: bde.name, clientType: 'Client' } });
  const req = await prisma.requirement.create({ data: { title: `Sx Staff Nurse ${RUN}`, clientId: client.id, status: 'OPEN', department: 'Medical', recruiterId: rec.id, tlId: tl.id, bdeId: bde.id, openings: 2, skills: 'Nursing', experience: '2-5', location: 'Hyderabad' } });
  const cand = await prisma.candidate.create({ data: { name: `Sxperson Quillfeather ${RUN}`, phone: `9${String(Date.now()).slice(-9)}`, email: `sx.${RUN}@sx-cand.in`, skills: 'Nursing' } });
  await prisma.application.create({ data: { candidateId: cand.id, requirementId: req.id, ownerRecruiterId: rec.id, stage: 'WITH_BDE' } });
  await setRow('email', { 'SMTP host': 'smtp.zz-test.invalid', Port: '587', 'Encryption (SSL / STARTTLS / None)': 'STARTTLS', Username: 'zz', 'Password / app key': 'zz-pass', 'From address': 'hr@zz-test.invalid', 'Default from name': 'TeamLink' });
  await setRow('whatsapp', { [CAT.WA_FIELDS.phoneId]: '1234567890', [CAT.WA_FIELDS.token]: 'zz-test-token', [CAT.WA_FIELDS.display]: '+91 90000 00001', [CAT.WA_FIELDS.bulkTpl]: 'zz_general' });
  await setRow('sms', { [CAT.SMS_FIELDS.provider]: 'MSG91', [CAT.SMS_FIELDS.key]: 'zz-key', [CAT.SMS_FIELDS.bulkTpl]: 'zzflow' });

  const be = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(be);
  if (!(await waitFor(`http://localhost:${PORT}/api/health`))) { console.log('FAIL  the sandbox server did not answer (set TEST_PORT)'); await stop(1); return; }
  const web = spawn(process.execPath, [path.join(FRONT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(WEB), '--strictPort', '--host', 'localhost'], { cwd: FRONT, env: { ...process.env, API_PROXY: `http://localhost:${PORT}` }, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(web);
  if (!(await waitFor(`http://localhost:${WEB}/`))) { console.log('FAIL  the web server did not answer'); await stop(1); return; }

  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const open = async (user, urlPath, viewport = { width: 1280, height: 1000 }) => {
    const token = jwt.sign({ ...tokenPayload(await resolveIdentity(user.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
    const ctx = await browser.newContext({ viewport });
    await ctx.addInitScript((t) => { try { localStorage.setItem('tl_token', t); } catch (e) { /* none */ } }, token);
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${WEB}${urlPath}`, { waitUntil: 'commit', timeout: 120000 });
    return { ctx, page };
  };
  // 2026-11-20 (tabs clean-up): "Schedule a message" sits under the Candidate page's "More" menu (five main tabs on screen).
  const tabOpen = async (page) => {
    const strip = page.locator('[role="tablist"][aria-label="Candidate tabs"]').first();
    await strip.waitFor({ state: 'visible', timeout: 90000 }).catch(() => null);
    let tab = page.getByRole('tab', { name: /Schedule a message/ });
    if (!(await tab.count())) {
      const more = page.locator('.tabstrip-more').first();
      if (await more.waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false)) await more.click();
      tab = page.getByRole('menuitem', { name: /Schedule a message/ });
    }
    const there = await tab.first().waitFor({ state: 'visible', timeout: 60000 }).then(() => true).catch(() => false);
    if (there) { await tab.first().click(); await page.locator('textarea[aria-label="Message"]').waitFor({ state: 'visible', timeout: 30000 }).catch(() => null); }
    return there;
  };
  try {
    {
      const { ctx, page } = await open(rec, `/candidates/${cand.id}`);
      page.on('dialog', (dlg) => dlg.accept().catch(() => {}));
      const there = await tabOpen(page);
      check('Recruiter: the candidate profile has a "Schedule a message" tab, and it opens', there, await page.evaluate(() => document.body.innerText.slice(0, 200)).catch(() => ''));
      const area = page.locator('textarea[aria-label="Message"]');
      check('the form shows the three ways (WhatsApp, SMS, Email) and the four quick times', (await page.locator('.sm-ways button').count()) === 3 && (await page.getByRole('button', { name: 'In 1 hour' }).count()) === 1 && (await page.getByRole('button', { name: 'Today 5 PM' }).count()) === 1 && (await page.getByRole('button', { name: 'Tomorrow 10 AM' }).count()) === 1 && (await page.getByRole('button', { name: 'Pick date and time' }).count()) === 1);
      await page.screenshot({ path: path.join(SHOTS, '1-empty-form.png'), fullPage: true });

      // a ready message -> the live preview has the first name filled
      await page.getByRole('button', { name: 'Follow-up call-back' }).click();
      const text = await area.inputValue();
      const prev = page.locator('[aria-label="Preview"]');
      await prev.waitFor({ state: 'visible', timeout: 10000 }).catch(() => null);
      const pt = (await prev.innerText().catch(() => '')) || '';
      check('a ready message fills the box, and the preview shows the first name instead of {name} and the STOP line', /\{name\}/.test(text) && /Hi Sxperson,/.test(pt) && !/\{name\}/.test(pt) && /Reply STOP/.test(pt), [text, pt]);
      check('the character count is shown', /\d+ \/ 1000/.test(await page.locator('.sm-count').innerText()));

      // outside the hours: a clear error and a "Use ..." button
      await page.getByRole('button', { name: 'Pick date and time' }).click();
      const tomorrow = await page.locator('input[type="date"][aria-label="Date"]').inputValue();
      await page.locator('input[type="time"][aria-label="Time"]').fill('03:00');
      await page.getByRole('button', { name: 'Schedule message' }).click();
      const alertTxt = await page.locator('[role="alert"]').innerText({ timeout: 15000 }).catch(() => '');
      check('a time at 03:00 shows the clear error with the allowed hours', /between 07:00 and 20:00/.test(alertTxt), alertTxt);
      const useBtn = page.getByRole('button', { name: /^Use / });
      check('...and a "Use <nearest time>" button', (await useBtn.count()) === 1);
      await page.screenshot({ path: path.join(SHOTS, '2-hours-error.png'), fullPage: true });
      await useBtn.click();
      check('pressing it puts 07:00 in the time box', (await page.locator('input[type="time"][aria-label="Time"]').inputValue()) === '07:00');

      // schedule for tomorrow 10 AM with the quick button
      await page.getByRole('button', { name: 'Tomorrow 10 AM' }).click();
      await page.getByRole('button', { name: 'Schedule message' }).click();
      const planned = page.locator('[data-testid="sm-row-planned"]');
      const sched = await planned.first().waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false);
      check('Schedule message: it appears under Scheduled, with its time and the words', sched && /10:00 am/.test(await planned.first().innerText()) && /call me back/i.test(await planned.first().innerText()), await page.locator('[data-testid="sm-lists"]').innerText().catch(() => ''));
      check('a confirmation says when it goes', /Scheduled\. It goes/.test(await page.locator('[role="status"]').innerText().catch(() => '')));
      check('the form is empty again and the list header counts 1 waiting', (await area.inputValue()) === '' && /1 waiting/.test(await page.locator('[data-testid="sm-lists"]').innerText()));
      await page.screenshot({ path: path.join(SHOTS, '3-scheduled.png'), fullPage: true });

      // edit
      await planned.first().getByRole('button', { name: 'Edit' }).click();
      check('Edit puts the message back in the form', /call me back/i.test(await area.inputValue()) && /Change a scheduled message/.test(await page.locator('body').innerText()));
      await area.fill('Hi {name}, please call me tomorrow morning. - {recruiter}');
      await page.getByRole('button', { name: 'Save changes' }).click();
      await page.locator('[data-testid="sm-row-planned"]', { hasText: 'tomorrow morning' }).waitFor({ state: 'visible', timeout: 15000 }).catch(() => null);
      check('Save changes: the list shows the new words', (await page.locator('[data-testid="sm-row-planned"]', { hasText: 'tomorrow morning' }).count()) === 1);

      // a second message by email, then cancel the first
      await page.getByRole('button', { name: 'Email' }).first().click();
      await page.locator('input[aria-label="Subject"]').fill('Please call me');
      await area.fill('Hello {name}, please send your documents.');
      await page.getByRole('button', { name: 'Tomorrow 10 AM' }).click();
      await page.getByRole('button', { name: 'Schedule message' }).click();
      await page.locator('[data-testid="sm-row-planned"]', { hasText: 'send your documents' }).waitFor({ state: 'visible', timeout: 15000 }).catch(() => null);
      check('an email message with a subject is scheduled too (2 waiting)', (await page.locator('[data-testid="sm-row-planned"]').count()) === 2 && /Subject: Please call me/.test(await page.locator('[data-testid="sm-lists"]').innerText()));
      await page.locator('[data-testid="sm-row-planned"]', { hasText: 'tomorrow morning' }).getByRole('button', { name: 'Cancel' }).click();
      const cancelled = await page.locator('[data-testid="sm-row-cancelled"]').first().waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
      check('Cancel: the message moves to Cancelled and the other one stays waiting', cancelled && (await page.locator('[data-testid="sm-row-planned"]').count()) === 1 && /Cancelled \(1\)/.test(await page.locator('[data-testid="sm-lists"]').innerText()));
      await page.screenshot({ path: path.join(SHOTS, '4-cancelled.png'), fullPage: true });
      // it is really in the database
      const rows = await prisma.$queryRawUnsafe('SELECT "status","channel" FROM "ScheduledReminder" WHERE "kind" = \'custom\' AND "candidateId" = ? ORDER BY "createdAt"', cand.id);
      check('the database agrees: one cancelled WhatsApp, one planned Email', rows.length === 2 && rows[0].status === 'cancelled' && rows[0].channel === 'WhatsApp' && rows[1].status === 'planned' && rows[1].channel === 'Email', rows);
      await ctx.close();
    }
    // phone width
    {
      const { ctx, page } = await open(rec, `/candidates/${cand.id}?tab=scheduled`, { width: 390, height: 844 });
      await page.locator('textarea[aria-label="Message"]').waitFor({ state: 'visible', timeout: 90000 }).catch(() => null);
      await page.waitForTimeout(800);
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check('on a phone the tab opens from its link and nothing scrolls sideways', (await page.locator('textarea[aria-label="Message"]').count()) === 1 && wide <= 2, wide);
      await page.screenshot({ path: path.join(SHOTS, '5-phone.png'), fullPage: true });
      await ctx.close();
    }
    // the BDE side: numbers only
    {
      const { ctx, page } = await open(bde, `/candidates/${cand.id}?tab=scheduled`);
      const t = await page.getByText('Only the number of messages is shown').waitFor({ state: 'visible', timeout: 90000 }).then(() => true).catch(() => false);
      const body = await page.locator('body').innerText();
      check('BDE side: only the numbers, no words and no form', t && /1 waiting/.test(body) && !/send your documents/.test(body) && (await page.locator('textarea[aria-label="Message"]').count()) === 0, body.slice(0, 300));
      await page.screenshot({ path: path.join(SHOTS, '6-bde-count.png') });
      await ctx.close();
    }
  } finally {
    await browser.close().catch(() => {});
  }
  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.log('FAIL  crashed:', e && e.message); await stop(1); });
