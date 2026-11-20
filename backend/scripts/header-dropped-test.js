#!/usr/bin/env node
/**
 * The candidate page header after a drop (founder 2026-11-18: the row said Dropped, the badge stayed Joined and the
 * month count showed 0 dropped). The label may only say Dropped when the Joining & Drop record says so; a drop recorded there sets the label;
 * withdrawing the drop clears it; a drop cannot be unlabelled while it is recorded.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> TEST_PORT=4212 node scripts/drop-label-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-hdrdrop-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT) || 4212;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'hdrdrop-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const JD = require('../src/joindrop/core');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 500)}` : ''}`); } };
const call = async (method, url, body, token) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j };
};
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const ist = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);

(async () => {
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const apps = await prisma.application.findMany({ where: { stage: 'JOINED' }, include: { requirement: true }, take: 60 });
  const app = apps.find((a) => a.requirement && !a.requirement.internal);
  if (!app) { console.log('no joined client application in the sandbox copy'); await stop(2); return; }
  await prisma.application.update({ where: { id: app.id }, data: { rollStatus: null, joiningStatus: 'Joined', joiningDate: '2026-08-11' } });
  await JD.ready();
  await JD.recordJoined({ applicationId: app.id, backfill: true, quiet: true });
  const rec = await JD.byApplication(app.id);
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1100); });
  const tA = jwt.sign({ ...tokenPayload(await resolveIdentity(adminRow.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const page = async () => {
    const r = await call('GET', `/candidates/${app.candidateId}`, null, tA);
    const a = r.body && (r.body.applications || []).find((x) => x.id === app.id);
    return { status: r.status, a };
  };

  const p0 = await page();
  check('0 before any drop the page says Joined and sends people to the usual next step', p0.status === 200 && p0.a && p0.a.stageLabel === 'Joined' && !p0.a.left, p0.a && { l: p0.a.stageLabel, left: p0.a.left });

  // a bare "Dropped" label with no record (what Purna sir's dropdown made before)
  await prisma.application.update({ where: { id: app.id }, data: { rollStatus: 'Dropped' } });
  const p1 = await page();
  check('1 a bare Dropped label: the page says Dropped and asks for the day and the reason', p1.a && p1.a.left === true && p1.a.dropRecorded === false && p1.a.stageLabel === 'Dropped' && /Record the drop/.test(p1.a.nextAction), p1.a && { l: p1.a.stageLabel, left: p1.a.left, rec: p1.a.dropRecorded, na: p1.a.nextAction });
  await prisma.application.update({ where: { id: app.id }, data: { rollStatus: null } });

  const meta = await call('GET', '/join-drop/meta', null, tA);
  const reason = meta.body && meta.body.reasons && meta.body.reasons[0];
  const d = await call('POST', `/join-drop/${rec.id}/drop`, { droppedOn: ist(), reason, reasonDetail: 'header test' }, tA);
  check('2 the real drop is recorded', d.status === 200 && d.body && d.body.ok, d);
  const p2 = await page();
  const a2 = p2.a || {};
  check('3 the step shows Dropped, not Joined', a2.stageLabel === 'Dropped' && a2.stageGroupLabel === 'Dropped' && a2.stageDetailLabel === 'Dropped', { l: a2.stageLabel, g: a2.stageGroupLabel });
  check('4 the page carries the drop day, the reason and that it is recorded', a2.left === true && a2.dropRecorded === true && a2.leftOn === ist() && a2.leftReason === reason, { on: a2.leftOn, r: a2.leftReason });
  check('5 Next step is not "Raise Invoice / Track Guarantee" any more', a2.nextAction && !/Raise Invoice|Track Guarantee/i.test(a2.nextAction), a2.nextAction);
  check('6 no owner, no due date, nothing late', !a2.nextActionOwnerName && !a2.dueDate && a2.overdue === false && !a2.owner, { o: a2.nextActionOwnerName, d: a2.dueDate });
  check('7 the stage itself stays Joined (billing and the guarantee read it)', a2.stage === 'JOINED' || a2.stage === 'HIRED', a2.stage);

  const r = await call('POST', `/join-drop/${rec.id}/reopen`, { reason: 'reported by mistake in the test' }, tA);
  check('8 withdrawing the drop works', r.status === 200, r);
  const p3 = await page();
  check('9 after the withdrawal the page says Joined again with its usual next step', p3.a && p3.a.stageLabel === 'Joined' && !p3.a.left, p3.a && { l: p3.a.stageLabel, left: p3.a.left });

  console.log(`
${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (err) => { console.error(err); await stop(1); });
