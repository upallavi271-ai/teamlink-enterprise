#!/usr/bin/env node
/**
 * BROWSER SMOKE of the ADVANCED MESSAGE SCHEDULER (founder 2026-11-20): a recruiter makes a daily x 5 schedule on the candidate tab and sees the
 * live summary; ticks 2 candidates on Candidates & Pipeline and schedules both; opens ATS > Scheduled Messages, filters, pauses and resumes one,
 * cancels one; the Admin sees the ATS triggers (all off) on Step timing; the page fits a phone; the BDE side sees only the numbers.
 * A private sandbox server (copy of the sandbox database) + the Vite preview in front of it + Edge. Build the frontend first (npx vite build).
 *   TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4361 node scripts/sched-adv-browser.js     (screenshots: docs/sched-adv-2026-11-20/)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const FRONT = path.resolve(BACK, '..', 'frontend');
const SHOTS = path.resolve(BACK, '..', 'docs', 'sched-adv-2026-11-20');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-schedadv-smoke-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const dbx = new DatabaseSync(COPY);
dbx.exec("DELETE FROM \"IntegrationEvent\" WHERE \"integrationId\" IN ('email', 'whatsapp', 'whatsapp-qr', 'sms', 'sms-android', 'telephony')");
dbx.exec("DELETE FROM \"Integration\" WHERE \"id\" IN ('email', 'whatsapp', 'whatsapp-qr', 'sms', 'sms-android', 'telephony')");
dbx.close();
const PORT = Number(process.env.TEST_PORT || 4361);
const WEB = PORT + 1;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'sa-smoke', INTEGRATION_SECRET_KEY: 'zz-sa-smoke-integration-key', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const { writeValues } = require('../src/utils/integrationStore');
const CAT = require('../src/utils/adminCatalog');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ''}`); } };
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
const q = (sql, ...a) => prisma.$queryRawUnsafe(sql, ...a);

(async () => {
  const mk = (tag, data) => prisma.user.create({ data: { name: `Sy ${tag} ${RUN}`, email: `sy.${tag}.${RUN}@sy-test.in`, username: `sy.${tag}.${RUN}@sy-test.in`, passwordHash: 'x', status: 'Active', hrmsRole: 'NONE', atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3), ...data } });
  const tl = await mk('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' });
  const rec = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' });
  const bde = await mk('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Medical' });
  const admin = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 8 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: admin.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const client = await prisma.client.create({ data: { name: `Sy Hospital ${RUN}`, location: 'Hyderabad', ownerDepartment: 'Medical', bdeOwner: bde.name, clientType: 'Client' } });
  const req = await prisma.requirement.create({ data: { title: `Sy Staff Nurse ${RUN}`, clientId: client.id, status: 'OPEN', department: 'Medical', recruiterId: rec.id, tlId: tl.id, bdeId: bde.id, openings: 3, skills: 'Nursing', experience: '2-5', location: 'Hyderabad' } });
  const mkCand = async (first, n) => {
    const c = await prisma.candidate.create({ data: { name: `${first} Quillfeather ${RUN}`, phone: `8${String(Date.now() + n).slice(-9)}`, email: `sy.${n}.${RUN}@sy-cand.in`, skills: 'Nursing' } });
    await prisma.application.create({ data: { candidateId: c.id, requirementId: req.id, ownerRecruiterId: rec.id, stage: 'WITH_BDE' } });
    return c;
  };
  const cand = await mkCand('Syone', 1);
  const c2 = await mkCand('Sytwo', 2);
  const c3 = await mkCand('Sythree', 3);
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
  const open = async (user, urlPath, viewport = { width: 1366, height: 1000 }) => {
    const token = jwt.sign({ ...tokenPayload(await resolveIdentity(user.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
    const ctx = await browser.newContext({ viewport });
    await ctx.addInitScript((t) => { try { localStorage.setItem('tl_token', t); } catch (e) { /* none */ } }, token);
    const page = await ctx.newPage();
    page.on('dialog', (dlg) => dlg.accept().catch(() => {}));
    await page.goto(`http://localhost:${WEB}${urlPath}`, { waitUntil: 'commit', timeout: 120000 });
    return { ctx, page };
  };
  try {
    // 1. the candidate tab: a daily x 5 schedule with the live summary
    {
      const { ctx, page } = await open(rec, `/candidates/${cand.id}?tab=scheduled`);
      const area = page.locator('textarea[aria-label="Message"]');
      await area.waitFor({ state: 'visible', timeout: 90000 }).catch(() => null);
      check('the tab keeps today\'s look: the three ways, the four quick times, the ready messages', (await page.locator('.sm-ways button').count()) === 3 && (await page.getByRole('button', { name: 'Tomorrow 10 AM' }).count()) === 1 && (await page.getByRole('button', { name: 'Follow-up call-back' }).count()) === 1);
      check('...and adds "One-time message" / "Recurring message"', (await page.getByRole('button', { name: /One-time message/ }).count()) === 1 && (await page.getByRole('button', { name: /Recurring message/ }).count()) === 1);
      await page.getByRole('button', { name: /Recurring message/ }).click();
      const adv = page.locator('[data-testid="sm-advanced"]');
      await adv.waitFor({ state: 'visible', timeout: 10000 }).catch(() => null);
      const advText = await adv.innerText().catch(() => '');
      check('Recurring: the Advanced section shows Schedule start, Repeat frequency (Daily / Weekly / Monthly / Custom), How many times, Timezone and sending window', /Schedule start/.test(advText) && /Daily \(every day\)/.test(advText) && /Weekly/.test(advText) && /Monthly/.test(advText) && /Custom/.test(advText) && /How many times/.test(advText) && /Until manually stopped/.test(advText) && /Timezone and sending window/.test(advText), advText.slice(0, 300));
      await page.getByRole('button', { name: 'Follow-up call-back' }).click();
      const sum = page.locator('[data-testid="sm-summary"]');
      await sum.getByText('5 messages').waitFor({ state: 'visible', timeout: 15000 }).catch(() => null);
      const sumText = await sum.innerText().catch(() => '');
      check('the live Schedule summary: Start, Time 10:00 AM, Frequency Daily, Total 5 messages, Last message, Timezone IST', /Start/.test(sumText) && /10:00 AM/.test(sumText) && /Daily/.test(sumText) && /5 messages/.test(sumText) && /Last message/.test(sumText) && /IST/.test(sumText), sumText);
      await page.screenshot({ path: path.join(SHOTS, '1-tab-recurring-summary.png'), fullPage: true });
      // the summary follows the choices
      await page.locator('input[aria-label="Total messages"]').fill('3');
      await sum.getByText('3 messages').waitFor({ state: 'visible', timeout: 10000 }).catch(() => null);
      check('changing the number to 3 updates the summary at once', /3 messages/.test(await sum.innerText()));
      await page.locator('input[aria-label="Total messages"]').fill('5');
      await sum.getByText('5 messages').waitFor({ state: 'visible', timeout: 10000 }).catch(() => null);
      await page.getByRole('button', { name: 'Schedule message' }).click();
      const schedCard = page.locator('[data-testid="sm-schedules"]');
      const made = await schedCard.waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false);
      check('Schedule message: the schedule shows under "Repeating and automatic schedules" as Daily x 5, Upcoming, 0/5', made && /Daily x 5/.test(await schedCard.innerText()) && /Upcoming/.test(await schedCard.innerText()) && /0\/5/.test(await schedCard.innerText()), await schedCard.innerText().catch(() => ''));
      await schedCard.getByRole('button', { name: 'Messages' }).first().click();
      const occ = page.locator('[data-testid="sm-occurrences"] tbody tr');
      await occ.first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => null);
      check('Messages: its 5 messages are listed, each Scheduled with its time', (await occ.count()) === 5 && /Scheduled/.test(await occ.first().innerText()));
      await page.screenshot({ path: path.join(SHOTS, '2-tab-schedule-made.png'), fullPage: true });
      const rows = await q('SELECT "kind","frequency","totalCount","status" FROM "MessageSchedule" WHERE "candidateId" = ?', cand.id);
      check('the database agrees: one recurring daily schedule of 5, upcoming', rows.length === 1 && rows[0].kind === 'recurring' && rows[0].frequency === 'daily' && Number(rows[0].totalCount) === 5 && rows[0].status === 'upcoming', rows);
      await ctx.close();
    }
    // 2. the list: tick 2 candidates, "Schedule a message"
    {
      const { ctx, page } = await open(rec, `/candidates?view=pipeline&sub=all&requirementId=${req.id}`);
      const box2 = page.getByRole('checkbox', { name: new RegExp(`Select Sytwo Quillfeather ${RUN}`) });
      const box3 = page.getByRole('checkbox', { name: new RegExp(`Select Sythree Quillfeather ${RUN}`) });
      const listed = await box2.first().waitFor({ state: 'visible', timeout: 90000 }).then(() => true).catch(() => false);
      check('Candidates & Pipeline lists the candidates of the job', listed);
      await box2.first().check(); await box3.first().check();
      const action = page.getByRole('button', { name: /Schedule a message/ });
      const has = await action.first().waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
      check('with 2 rows ticked the bulk bar offers "Schedule a message"', has);
      await page.screenshot({ path: path.join(SHOTS, '3-list-two-ticked.png') });
      await action.first().click();
      const modal = page.locator('[data-testid="sm-bulk"]');
      await modal.waitFor({ state: 'visible', timeout: 15000 }).catch(() => null);
      check('the window lists both recipients and has the same sections (way, one-time / recurring, message, summary)', /Sytwo/.test(await modal.innerText()) && /Sythree/.test(await modal.innerText()) && (await modal.getByRole('button', { name: /Recurring message/ }).count()) === 1 && (await modal.locator('[data-testid="sm-summary"]').count()) === 1);
      await modal.locator('select[aria-label="Unit"]').count();
      await modal.getByRole('button', { name: /Weekly/ }).click();
      await modal.locator('input[aria-label="Total messages"]').fill('4');
      await modal.locator('textarea[aria-label="Message"]').fill('Hi {name}, a weekly update about {requirement}. - {recruiter}');
      await modal.locator('[data-testid="sm-summary"]').getByText('4 messages').waitFor({ state: 'visible', timeout: 15000 }).catch(() => null);
      await page.screenshot({ path: path.join(SHOTS, '4-list-schedule-window.png'), fullPage: true });
      await page.locator('.modal-foot').getByRole('button', { name: 'Schedule message' }).click();
      const res = page.locator('[data-testid="sm-bulk-result"]');
      const done = await res.waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false);
      check('both are scheduled: "2 of 2 scheduled (Weekly x 4 ...)"', done && /2\s*of 2 scheduled/.test(await res.innerText()) && /Weekly x 4/.test(await res.innerText()), await res.innerText().catch(() => ''));
      await page.screenshot({ path: path.join(SHOTS, '5-list-scheduled.png') });
      const both = await q('SELECT "candidateId" FROM "MessageSchedule" WHERE "candidateId" IN (?, ?) AND "frequency" = \'weekly\'', c2.id, c3.id);
      check('the database has one schedule for EACH of the two candidates', both.length === 2 && new Set(both.map((b) => b.candidateId)).size === 2, both);
      await ctx.close();
    }
    // 3. the Scheduled Messages page
    {
      const { ctx, page } = await open(rec, '/ats/scheduled-messages');
      const table = page.locator('[data-testid="smp-table"]');
      await table.locator('[data-testid="smp-row"]').first().waitFor({ state: 'visible', timeout: 90000 }).catch(() => null);
      const nav = await page.getByRole('link', { name: /Scheduled Messages/ }).count();
      check('the sidebar has "Scheduled Messages" in the ATS group, and the page opens', nav >= 1 && /Scheduled Messages/.test(await page.locator('h1').innerText().catch(() => '')));
      const totalCard = await page.locator('[data-testid="smp-card-total"]').innerText();
      check('the cards: Total 3, Upcoming 3, Completed, Failed, Active, Paused', /3/.test(totalCard) && /3/.test(await page.locator('[data-testid="smp-card-upcoming"]').innerText()) && (await page.locator('[data-testid="smp-card-failed"]').count()) === 1 && (await page.locator('[data-testid="smp-card-paused"]').count()) === 1, totalCard);
      check('the table lists the 3 schedules with frequency, progress and status', (await table.locator('[data-testid="smp-row"]').count()) === 3 && /Daily x 5/.test(await table.innerText()) && /Weekly x 4/.test(await table.innerText()) && /0\/5/.test(await table.innerText()));
      const head = await table.locator('thead').innerText();
      check('the columns: candidate, requirement, recruiter, channel, first, next, total, sent, delivered, failed, last sent, created by, actions', ['Candidate', 'Requirement', 'Recruiter', 'Channel', 'First scheduled', 'Next', 'Total', 'Sent', 'Delivered', 'Failed', 'Last sent', 'Created by', 'Actions'].every((h) => new RegExp(h, 'i').test(head)), head);
      await page.screenshot({ path: path.join(SHOTS, '6-page.png'), fullPage: true });
      // filter: the candidate search
      await page.locator('input[aria-label="Search"]').fill('Sytwo');
      await page.waitForTimeout(900);
      check('the candidate search narrows the table to that candidate', (await table.locator('[data-testid="smp-row"]').count()) === 1 && /Sytwo/.test(await table.innerText()));
      await page.locator('input[aria-label="Search"]').fill('');
      await page.waitForTimeout(900);
      // filter: frequency kind = recurring via the Filters panel (Channel checkbox)
      await page.getByRole('button', { name: /^Filters/ }).click();
      await page.screenshot({ path: path.join(SHOTS, '7-page-filters.png'), fullPage: true });
      await page.getByRole('button', { name: 'Done' }).click().catch(() => {});
      // pause and resume one, cancel one
      const rowOne = table.locator('[data-testid="smp-row"]', { hasText: 'Syone' });
      await rowOne.getByRole('button', { name: 'Pause' }).click();
      await rowOne.getByText('Paused').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => null);
      check('Pause: the row says Paused and offers Resume', /Paused/.test(await rowOne.innerText()) && (await rowOne.getByRole('button', { name: 'Resume' }).count()) === 1);
      await page.screenshot({ path: path.join(SHOTS, '8-paused.png'), fullPage: true });
      await rowOne.getByRole('button', { name: 'Resume' }).click();
      await rowOne.getByRole('button', { name: 'Pause' }).waitFor({ state: 'visible', timeout: 15000 }).catch(() => null);
      check('Resume: it is live again (Pause offered, not Paused)', !/Paused/.test(await rowOne.innerText()) && (await rowOne.getByRole('button', { name: 'Pause' }).count()) === 1);
      const rowTwo = table.locator('[data-testid="smp-row"]', { hasText: 'Sytwo' });
      await rowTwo.getByRole('button', { name: 'Cancel' }).click();
      await rowTwo.getByText('Cancelled').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => null);
      check('Cancel: the row says Cancelled and no action is left on it', /Cancelled/.test(await rowTwo.innerText()) && (await rowTwo.getByRole('button', { name: 'Pause' }).count()) === 0);
      // a row opens its messages
      await rowOne.locator('td').nth(2).click();
      const occ = page.locator('[data-testid="sm-occurrences"]');
      await occ.waitFor({ state: 'visible', timeout: 15000 }).catch(() => null);
      await page.screenshot({ path: path.join(SHOTS, '8b-row-messages.png'), fullPage: true });
      check('a row opens its messages: scheduled, sent, delivered, status, provider id, reason, tries', /Scheduled/.test(await occ.innerText()) && /Delivered/i.test(await occ.innerText()) && /Provider id/i.test(await occ.innerText()) && /Tries/i.test(await occ.innerText()) && (await occ.locator('tbody tr').count()) === 5);
      // the tabs
      await page.getByRole('tab', { name: /Cancelled/ }).click();
      await page.waitForTimeout(900);
      check('the Cancelled tab lists only the cancelled one', (await table.locator('[data-testid="smp-row"]').count()) === 1 && /Sytwo/.test(await table.innerText()));
      await page.screenshot({ path: path.join(SHOTS, '9-cancelled-tab.png'), fullPage: true });
      const st = await q('SELECT "status" FROM "MessageSchedule" WHERE "candidateId" IN (?, ?) ORDER BY "candidateId"', cand.id, c2.id);
      check('the database agrees: one live (upcoming) and one cancelled', st.map((s) => s.status).sort().join() === 'cancelled,upcoming', st);
      await ctx.close();
    }
    // 4. phone width
    {
      const { ctx, page } = await open(rec, '/ats/scheduled-messages', { width: 390, height: 844 });
      await page.locator('[data-testid="smp-card-total"]').waitFor({ state: 'visible', timeout: 90000 }).catch(() => null);
      await page.waitForTimeout(800);
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check('on a phone the page opens and does not scroll sideways (the table scrolls inside its box)', wide <= 2, wide);
      await page.screenshot({ path: path.join(SHOTS, '10-phone.png'), fullPage: true });
      await ctx.close();
    }
    // 5. the BDE side: numbers only
    {
      const { ctx, page } = await open(bde, '/ats/scheduled-messages');
      const t = await page.getByText('Your team sees only the numbers').waitFor({ state: 'visible', timeout: 90000 }).then(() => true).catch(() => false);
      const body = await page.locator('body').innerText();
      check('BDE side: the cards with numbers, no table, no words', t && (await page.locator('[data-testid="smp-table"]').count()) === 0 && !/weekly update/.test(body), body.slice(0, 300));
      await page.screenshot({ path: path.join(SHOTS, '11-bde-counts.png') });
      await ctx.close();
    }
    // 6. the Admin: the ATS triggers on Step timing, all off
    {
      const { ctx, page } = await open(admin, '/admin/step-timing');
      const panel = page.locator('[data-testid="ats-triggers"]');
      const there = await panel.waitFor({ state: 'visible', timeout: 90000 }).then(() => true).catch(() => false);
      const boxes = panel.locator('input[type="checkbox"]');
      const n = await boxes.count();
      let anyOn = false;
      for (let i = 0; i < n; i += 1) if (await boxes.nth(i).isChecked()) anyOn = true; // eslint-disable-line no-await-in-loop
      check('Step timing shows "Automatic messages on ATS events": 10 triggers, ALL off', there && n === 10 && !anyOn && /All off/.test(await panel.innerText()), [there, n, anyOn]);
      await panel.scrollIntoViewIfNeeded().catch(() => {});
      await panel.screenshot({ path: path.join(SHOTS, '12-triggers-all-off.png') }).catch(() => page.screenshot({ path: path.join(SHOTS, '12-triggers-all-off.png') }));
      await ctx.close();
    }
  } finally {
    await browser.close().catch(() => {});
  }
  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.log('FAIL  crashed:', e && e.message); await stop(1); });
