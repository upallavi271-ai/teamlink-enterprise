#!/usr/bin/env node
/**
 * TAMPER-EVIDENT AUDIT (utils/auditSeal.js) + WHO VIEWED (utils/readLog.js) - founder 2026-11-17 "Security first".
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4070.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/audit-seal-readlog-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-seal-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = 4070;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'seal-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const AS = require('../src/utils/auditSeal');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };
const call = async (method, url, body, token) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j };
};
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}

(async () => {
  // seal everything there is (the sandbox copy), in pieces like the live server does
  const n0 = await prisma.auditLog.count();
  await prisma.auditLog.updateMany({ where: { createdAt: { gt: new Date(Date.now() - 10000) } }, data: { createdAt: new Date(Date.now() - 20000) } });
  let r; let rounds = 0;
  do { r = await AS.seal({ max: 5000, batch: 700 }); rounds += 1; } while (r.sealed > 0 && rounds < 400);
  const [cnt] = await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "AuditSeal"');
  check('every audit row is sealed, in batches', Number(cnt.n) === n0, { sealed: Number(cnt.n), rows: n0, rounds });
  const v1 = await AS.verify();
  check('the untouched chain verifies', v1.ok && v1.checked === n0, v1);
  check('a second seal adds nothing', (await AS.seal()).sealed === 0);
  // tamper: change one sealed row
  const victim = await prisma.auditLog.findFirst({ orderBy: { createdAt: 'asc' }, skip: Math.floor(n0 / 2) });
  await prisma.auditLog.update({ where: { id: victim.id }, data: { toValue: `${victim.toValue || ''} (edited)` } });
  const v2 = await AS.verify();
  check('a changed row is caught, and named', !v2.ok && v2.brokenAt.auditId === victim.id && /changed/.test(v2.brokenAt.why), v2);
  await prisma.auditLog.update({ where: { id: victim.id }, data: { toValue: victim.toValue } });
  check('put back, it verifies again', (await AS.verify()).ok);
  // tamper: delete one
  const gone = await prisma.auditLog.findFirst({ orderBy: { createdAt: 'desc' }, skip: 3 });
  await prisma.auditLog.delete({ where: { id: gone.id } });
  const v3 = await AS.verify({ last: 50 });
  check('a deleted row is caught (quick check of the newest rows)', !v3.ok && /deleted/.test(v3.brokenAt.why), v3);

  // who viewed
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const cand = await prisma.candidate.findFirst({ select: { id: true, name: true } });
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((x) => x.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res) => { setTimeout(res, 500); });
  }
  await new Promise((res) => { setTimeout(res, 1100); });
  const tA = jwt.sign({ ...tokenPayload(await resolveIdentity(adminRow.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const g = await call('GET', `/candidates/${cand.id}`, null, tA);
  await call('GET', `/candidates/${cand.id}`, null, tA);
  await new Promise((res) => { setTimeout(res, 600); });
  const rl = await call('GET', `/admin/read-log?entityId=${cand.id}`, null, tA);
  check('opening a candidate profile is recorded once (repeat within 10 minutes is one view)', g.status === 200 && rl.status === 200 && rl.body.total === 1 && rl.body.rows[0].recordName === cand.name && rl.body.rows[0].what === 'Candidate profile', rl.body);
  await call('GET', '/candidates/does-not-exist-123', null, tA);
  await new Promise((res) => { setTimeout(res, 400); });
  check('a refused / missing record is not recorded as a view', (await call('GET', '/admin/read-log?entityId=does-not-exist-123', null, tA)).body.total === 0);
  const csv = await fetch(`${API}/admin/read-log?format=csv&entityId=${cand.id}`, { headers: { Authorization: `Bearer ${tA}` } });
  check('the who-viewed list downloads as CSV', csv.ok && /When,Who,Opened/.test(await csv.text()));
  const vr = await call('POST', '/admin/audit/verify', null, tA);
  check('Audit Logs -> Check for tampering answers through the API', vr.status === 200 && typeof vr.body.ok === 'boolean' && vr.body.sealed > 0, vr.body);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (err) => { console.error(err); await stop(1); });
