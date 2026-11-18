#!/usr/bin/env node
/**
 * "Dropped" in the Status / Roll status dropdown must be a REAL drop (founder 2026-11-18: the row said Dropped, the badge stayed Joined and the
 * month count showed 0 dropped). The label may only say Dropped when the Joining & Drop record says so; a drop recorded there sets the label;
 * withdrawing the drop clears it; a drop cannot be unlabelled while it is recorded.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> TEST_PORT=4170 node scripts/drop-label-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-droplabel-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT) || 4170;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'droplabel-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
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
  // a joined client placement with its Joining & Drop record
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
  const roll = (v) => call('PATCH', `/ats/applications/${app.id}/roll-status`, { rollStatus: v }, tA);
  const rollOf = async () => (await prisma.application.findUnique({ where: { id: app.id }, select: { rollStatus: true } })).rollStatus;

  check('0 the joined record exists and is Joined', !!rec && rec.status === 'Joined', rec && rec.status);
  const a = await roll('Dropped');
  check('1 choosing Dropped without a drop record is refused and points to the drop window', a.status === 409 && a.body && a.body.needsDrop === true && /day and the reason/i.test(a.body.error), a);
  check('2 the label did not change', (await rollOf()) === null);
  const b = await roll('Full time');
  check('3 other labels still save', b.status === 200 && (await rollOf()) === 'Full time', b);

  const meta = await call('GET', '/join-drop/meta', null, tA);
  const reason = meta.body && meta.body.reasons && meta.body.reasons[0];
  const d = await call('POST', `/join-drop/${rec.id}/drop`, { droppedOn: ist(), reason, reasonDetail: 'test of the drop label' }, tA);
  check('4 the real drop is recorded', d.status === 200 && d.body && d.body.ok, d);
  check('5 the record says Dropped', (await JD.byApplication(app.id)).status === 'Dropped');
  check('6 the Status label follows the record', (await rollOf()) === 'Dropped');

  const c = await roll('Dropped');
  check('7 choosing Dropped again is fine when the drop is recorded', c.status === 200, c);
  const e = await roll('On Roll');
  check('8 a recorded drop cannot be relabelled; it points to "Withdraw the drop"', e.status === 409 && e.body && e.body.needsReopen === true, e);
  const e2 = await roll('');
  check('9 nor cleared', e2.status === 409 && (await rollOf()) === 'Dropped', e2);

  const r = await call('POST', `/join-drop/${rec.id}/reopen`, { reason: 'reported by mistake in the test' }, tA);
  check('10 withdrawing the drop works', r.status === 200, r);
  check('11 the record is Joined again', (await JD.byApplication(app.id)).status === 'Joined');
  check('12 and the Dropped label is cleared', (await rollOf()) === null);
  const f = await roll('On Roll');
  check('13 labels save again after the drop was withdrawn', f.status === 200 && (await rollOf()) === 'On Roll', f);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (err) => { console.error(err); await stop(1); });
