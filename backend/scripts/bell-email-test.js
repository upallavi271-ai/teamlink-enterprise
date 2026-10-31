#!/usr/bin/env node
// ---------------------------------------------------------------------------
// EVERY BELL IS EMAILED TOO (founder 2026-10-30: "entire application lo ey work pending lo vunna, em ayina, mail vellali")
// COPY DATABASE ONLY, never dev.db. No real email: a stand-in mailer records what would go.
//
//   cd backend && npm run sandbox -- --restart --detach --no-watch
//   TL_TEST_DB=<absolute path of prisma/sandbox.db> node scripts/bell-email-test.js
//
// 1. emails OFF: nothing is emailed
// 2. emails ON: a new bell (any screen) is emailed to its person, with "Open: /path" as a full link
// 3. a bell that already has its own email is not emailed twice; the same title twice in a day = one email
// 4. a bell made before emails were switched on is not emailed (no flood); a bell younger than a minute waits
// 5. a person with no email address gets an honest "Not sent: no email address" line
// ---------------------------------------------------------------------------
const path = require('path');

const BACK = path.resolve(__dirname, '..');
const DB = process.env.TL_TEST_DB;
if (!DB || /dev\.db$/i.test(DB)) { console.error('Refusing: set TL_TEST_DB to the absolute path of a COPY database (never dev.db).'); process.exit(2); }
process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}`;
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}`;
process.env.TEST_MODE = '1';
process.env.APP_BASE_URL = 'https://teamlink.example.test';
const prisma = require(path.join(BACK, 'src/db'));
const HN = require(path.join(BACK, 'src/utils/hrmsNotify'));

const RUN = Date.now().toString(36);
let pass = 0; let fail = 0;
function check(name, ok, detail) {
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail != null ? `  -> ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400)}` : ''}`);
}

(async () => {
  const sent = [];
  const mailer = async (m) => { sent.push(m); return { ok: true }; };
  const made = [];
  let oldStore = null;
  try {
    oldStore = await prisma.integration.findUnique({ where: { id: HN.STORE_ID } });
    const base = { passwordHash: 'x', status: 'Active', role: 'EMPLOYEE' };
    const a = await prisma.user.create({ data: { ...base, name: `ZZTEST Bell A ${RUN}`, email: `zz-bell-a-${RUN}@teamlink.in`, username: `zz-bell-a-${RUN}` } });
    const b = await prisma.user.create({ data: { ...base, name: `ZZTEST Bell B ${RUN}`, email: '', username: `zz-bell-b-${RUN}` } });
    made.push(a.id, b.id);
    const scope = { userIds: [a.id, b.id] };
    const now = new Date();
    const ago = (min) => new Date(now.getTime() - min * 60000);
    const bell = (userId, title, at, message = 'x') => prisma.notification.create({ data: { userId, title, message, channel: 'In-App', createdAt: at } });

    // emails switched on 30 minutes ago
    await prisma.integration.upsert({ where: { id: HN.STORE_ID }, update: { values: JSON.stringify({ ...(oldStore && oldStore.values ? JSON.parse(oldStore.values) : {}), emailsOn: false }) }, create: { id: HN.STORE_ID, enabled: true, state: 'Internal', values: JSON.stringify({ emailsOn: false }) } });
    await bell(a.id, `ZZ Interview tomorrow ${RUN}`, ago(10), 'Your interview is tomorrow.\nOpen: /ats/interviews');
    let o = await HN.bellsToEmail({ now, mailer, testMode: true, scope });
    check('B1 emails OFF: nothing is emailed', sent.length === 0 && o.sent === 0, o);

    const s = await HN.getSettings();
    await prisma.integration.update({ where: { id: HN.STORE_ID }, data: { values: JSON.stringify({ ...s, emailsOn: true, emailsOnAt: ago(30).toISOString() }) } });
    await bell(a.id, `ZZ Old note ${RUN}`, ago(45)); // before the switch-on
    await bell(a.id, `ZZ Too new ${RUN}`, new Date(now.getTime() - 10 * 1000)); // 10 seconds old
    const own = await bell(a.id, `ZZ Leave approved ${RUN}`, ago(8));
    await prisma.notification.create({ data: { userId: a.id, title: own.title, channel: 'Email', recipient: a.email, status: 'Sent', read: true, createdAt: ago(8) } }); // the screen sent its own email
    await bell(a.id, `ZZ Task due ${RUN}`, ago(6)); await bell(a.id, `ZZ Task due ${RUN}`, ago(5)); // same title twice
    await bell(b.id, `ZZ For B ${RUN}`, ago(4));
    o = await HN.bellsToEmail({ now, mailer, testMode: true, scope });
    const subj = sent.map((m) => m.subject);
    check('B2 emails ON: a new bell is emailed to its person', sent.some((m) => m.to === a.email && /Interview tomorrow/.test(m.subject)), subj);
    check('B3 "Open: /path" becomes a full link in the email', sent.some((m) => /Open: https:\/\/teamlink\.example\.test\/ats\/interviews/.test(m.text)), sent.map((m) => m.text));
    check('B4 a bell that already had its own email is not emailed twice', !subj.some((x) => /Leave approved/.test(x)), subj);
    check('B5 the same title twice in a day = one email', subj.filter((x) => /Task due/.test(x)).length === 1, subj);
    check('B6 a bell from before emails were switched on is not emailed (no flood)', !subj.some((x) => /Old note/.test(x)), subj);
    check('B7 a bell younger than a minute waits (its screen may still send its own email)', !subj.some((x) => /Too new/.test(x)), subj);
    const noAddr = await prisma.notification.findFirst({ where: { userId: b.id, channel: 'Email' } });
    check('B8 no email address: an honest "Not sent: no email address" line, nothing sent', noAddr && noAddr.status === HN.NO_ADDRESS && !sent.some((m) => !m.to), noAddr && noAddr.status);
    const logged = await prisma.notification.count({ where: { userId: a.id, channel: 'Email', status: 'Sent' } });
    const before = sent.length;
    o = await HN.bellsToEmail({ now, mailer, testMode: true, scope });
    check('B9 the next sweep sends nothing again (each email is written down)', sent.length === before && logged >= 3, [sent.length, before, logged]);
  } catch (e) {
    check('no error', false, e.stack || e.message);
  } finally {
    await prisma.notification.deleteMany({ where: { userId: { in: made } } }).catch(() => null);
    await prisma.user.deleteMany({ where: { id: { in: made } } }).catch((e) => console.log('cleanup:', e.message));
    if (oldStore) await prisma.integration.update({ where: { id: HN.STORE_ID }, data: { values: oldStore.values } }).catch(() => null);
    else await prisma.integration.deleteMany({ where: { id: HN.STORE_ID } }).catch(() => null);
    console.log(`\n${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
