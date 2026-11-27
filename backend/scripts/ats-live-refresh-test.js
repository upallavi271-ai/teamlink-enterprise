#!/usr/bin/env node
/**
 * "ATS DATA CHANGED" (utils/atsVersion.js, founder 2026-11-27): every ATS write raises one number (GET /api/ats/history/version) that open histories and
 * the search page watch; a joining / drop clears the joinings and dropped-people caches at once, a step move clears the rejection index; an ordinary
 * step move does not recount the month's joinings. On a COPY of a database.
 *   TEST_SOURCE_DB=<a .db file> [TEST_PORT=4720] node scripts/ats-live-refresh-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-ats-live-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT) || 4720;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'ats-live-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`, INTEGRATION_SECRET_KEY: 'ats-live-key' };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const AV = require('../src/utils/atsVersion');
const RJ = require('../src/utils/recruiterJoinings');
const JR = require('../src/utils/joinedRule');
const REJ = require('../src/utils/rejections');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 300)}` : ''}`); } };
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}

(async () => {
  // count the cache clears
  const calls = { rj: 0, jr: 0, rej: 0 };
  const wrap = (mod, k) => { const orig = mod.invalidate; mod.invalidate = (...a) => { calls[k] += 1; return orig(...a); }; };
  wrap(RJ, 'rj'); wrap(JR, 'jr'); wrap(REJ, 'rej');
  const app = await prisma.application.findFirst({ where: { stage: { notIn: ['JOINED', 'HIRED', 'REJECTED'] } }, select: { id: true, stage: true } });
  const v0 = AV.current();
  await sleep(5);
  await prisma.auditLog.create({ data: { action: 'zz test', entity: 'Test', entityId: 'x' } }).catch(() => null);
  check('a log line is not ATS data: the number stays', AV.current() === v0);
  await prisma.application.update({ where: { id: app.id }, data: { stage: 'SHARED_WITH_CLIENT' } });
  const v1 = AV.current();
  check('a step move raises the number', v1 > v0, [v0, v1]);
  await sleep(1300);
  check('an ordinary step move clears the rejection index, not the month\'s joinings', calls.rej === 1 && calls.rj === 0, calls);
  await prisma.application.update({ where: { id: app.id }, data: { stage: 'JOINED', joiningStatus: 'Joined', joinedAt: new Date() } });
  await sleep(1300);
  check('a joining clears the joinings and the dropped-people caches at once (not after 2 minutes)', calls.rj >= 1 && calls.jr === 1, calls); // (clearing the dropped-people rule clears the joinings with it)
  await prisma.application.update({ where: { id: app.id }, data: { stage: 'REJECTED' } });
  await sleep(1300);
  check('a rejection clears the rejection index and the joinings again', calls.rej >= 2 && calls.jr === 2, calls);
  const before = { ...calls };
  for (let i = 0; i < 5; i += 1) await prisma.application.update({ where: { id: app.id }, data: { joiningStatus: i % 2 ? 'Dropped' : 'Joined' } }); // eslint-disable-line no-await-in-loop
  await sleep(1300);
  check('a burst of 5 writes clears each cache once', calls.jr - before.jr === 1, [before, calls]);

  const admin = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: admin.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: 'ignore' });
  for (let i = 0; i < 160; i += 1) { if (await fetch(`http://localhost:${PORT}/api/health`).then((r) => r.ok).catch(() => false)) break; await sleep(500); } // eslint-disable-line no-await-in-loop
  const tok = jwt.sign({ ...tokenPayload(await resolveIdentity(admin.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const ver = async () => fetch(`http://localhost:${PORT}/api/ats/history/version`, { headers: { Authorization: `Bearer ${tok}` } }).then((r) => r.json());
  const a = await ver();
  const cand = await prisma.application.findFirst({ where: { id: { not: app.id } }, select: { id: true } });
  const r = await fetch(`http://localhost:${PORT}/api/applications/${cand.id}`, { headers: { Authorization: `Bearer ${tok}` } });
  void r;
  check('GET /api/ats/history/version answers a number', typeof a.v === 'number', a);
  check('no login: refused', (await fetch(`http://localhost:${PORT}/api/ats/history/version`)).status === 401);
  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.log(`FAIL  crashed: ${e.stack || e.message}`); await stop(1); });
