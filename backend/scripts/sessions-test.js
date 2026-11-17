#!/usr/bin/env node
/**
 * SIGNED-IN DEVICES + IDLE SIGN-OUT (utils/sessions.js, routes/sessions.js, middleware/auth.js) - founder 2026-11-17 "Security first".
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4068.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/sessions-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-sess-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = 4068;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'sess-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };
const call = async (method, url, body, token, ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0') => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', 'User-Agent': ua, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j };
};
const PW = 'Zz!Sess-Test-2026';
const P = process.pid;
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}

(async () => {
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const U = await prisma.user.create({ data: { name: 'ZZ sess user', email: `zz.sess.${P}@zz-sess-test.in`, username: `zz.sess.${P}@zz-sess-test.in`, passwordHash: await bcrypt.hash(PW, 10), status: 'Active', role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3) } });
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1100); });
  const tAdmin = jwt.sign({ ...tokenPayload(await resolveIdentity(adminRow.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });

  const a = await call('POST', '/auth/login', { email: U.email, password: PW }, null, 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0');
  const b = await call('POST', '/auth/login', { email: U.email, password: PW }, null, 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile');
  const c = await call('POST', '/auth/login', { email: U.email, password: PW }, null, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1');
  const tA = a.body.token; const tB = b.body.token; const tC = c.body.token;
  check('each sign-in carries its own device id', !!jwt.decode(tA).sid && jwt.decode(tA).sid !== jwt.decode(tB).sid);
  check('the session payload carries the idle setting', a.body.user && a.body.user.security && a.body.user.security.idleMinutes === 0, a.body.user && a.body.user.security);
  const l = await call('GET', '/auth/sessions', null, tA);
  const open = (l.body.sessions || []).filter((s) => s.open);
  check('my devices: three open, named, this one marked', open.length === 3 && open.some((s) => s.current && s.device === 'Chrome on Windows') && open.some((s) => s.device === 'Chrome on Android') && open.some((s) => /iPhone/.test(s.device)), open);
  const bRow = open.find((s) => s.device === 'Chrome on Android');
  check('sign one device out', (await call('POST', `/auth/sessions/${bRow.id}/end`, null, tA)).status === 200);
  const rb = await call('GET', '/auth/me', null, tB);
  check('that device is signed out at its next click, with a plain reason', rb.status === 401 && rb.body.code === 'SESSION_ENDED', rb.body);
  check('the others keep working', (await call('GET', '/auth/me', null, tA)).status === 200 && (await call('GET', '/auth/me', null, tC)).status === 200);
  check('nobody else\'s device can be signed out', (await call('POST', `/auth/sessions/${jwt.decode(tAdmin).sid || 'x'}/end`, null, tA)).status === 404);
  const eo = await call('POST', '/auth/sessions/end-others', null, tA);
  check('sign out all other devices', eo.status === 200 && eo.body.ended === 1 && (await call('GET', '/auth/me', null, tC)).status === 401 && (await call('GET', '/auth/me', null, tA)).status === 200, eo.body);
  const lo = await call('POST', '/auth/logout', null, tA);
  check('sign out ends this device on the server too', lo.status === 200 && (await call('GET', '/auth/me', null, tA)).status === 401);
  const hist = (await call('GET', `/auth/sessions/user/${U.id}`, null, tAdmin)).body.sessions || [];
  check('the history says how each ended', ['signed out', 'signed out from another device'].every((r) => hist.some((h) => h.ended === r)), hist.map((h) => h.ended));

  // admin
  const d = await call('POST', '/auth/login', { email: U.email, password: PW });
  const dSid = jwt.decode(d.body.token).sid;
  check('a non-admin cannot open someone\'s devices', (await call('GET', `/auth/sessions/user/${adminRow.id}`, null, d.body.token)).status === 403);
  check('the admin signs a device out', (await call('POST', `/auth/sessions/user/${U.id}/${dSid}/end`, null, tAdmin)).status === 200);
  const rd = await call('GET', '/auth/me', null, d.body.token);
  check('...and it is told an administrator did it', rd.status === 401 && /administrator/.test(rd.body.error), rd.body);
  check('audited', !!(await prisma.auditLog.findFirst({ where: { entityId: U.id, action: 'Device signed out by an administrator' } })));

  // idle
  check('only an admin sets the idle sign-out', (await call('PUT', '/auth/security/idle', { minutes: 30 }, d.body.token)).status === 401
    || (await call('PUT', '/auth/security/idle', { minutes: 30 }, (await call('POST', '/auth/login', { email: U.email, password: PW })).body.token)).status === 403);
  const si = await call('PUT', '/auth/security/idle', { minutes: 30 }, tAdmin);
  check('the admin sets 30 minutes', si.status === 200 && si.body.minutes === 30);
  const e = await call('POST', '/auth/login', { email: U.email, password: PW });
  check('a new sign-in is told the idle minutes', e.body.user.security.idleMinutes === 30, e.body.user.security);
  await prisma.$executeRawUnsafe('UPDATE "UserSession" SET "lastSeenAt" = ? WHERE "id" = ?', new Date(Date.now() - 31 * 60000).toISOString(), jwt.decode(e.body.token).sid);
  await new Promise((r) => { setTimeout(r, 21000); }); // the server's 20-second cache
  const re = await call('GET', '/auth/me', null, e.body.token);
  check('a session idle longer than that is refused by the server', re.status === 401 && re.body.code === 'SESSION_IDLE', re.body);
  check('an old token without a device id still works (nobody thrown out by the release)', (await call('GET', '/auth/me', null, jwt.sign({ ...tokenPayload(await resolveIdentity(U.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' }))).status === 200);
  // admin "sign this login out" ends every device in the list too
  const f = await call('POST', '/auth/login', { email: U.email, password: PW });
  await require('../src/utils/loginAccounts').revokeSessions(U.id);
  const after = (await call('GET', `/auth/sessions/user/${U.id}`, null, tAdmin)).body.sessions || [];
  check('"sign this login out" marks every device ended by an administrator', after.filter((s) => s.open).length === 0 && after.some((s) => s.id === jwt.decode(f.body.token).sid && s.ended === 'admin'));

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (err) => { console.error(err); await stop(1); });
