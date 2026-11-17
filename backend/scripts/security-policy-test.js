#!/usr/bin/env node
/**
 * PASSWORD POLICY + IP ALLOW-LIST (utils/securityPolicy.js) - founder 2026-11-17 "Security first".
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4069.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/security-policy-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-secpol-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = 4069;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'secpol-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const SP = require('../src/utils/securityPolicy');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };
const call = async (method, url, body, token) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j };
};
const P = process.pid;
const PW = 'Zz-Policy-2026x';
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}

(async () => {
  check('IPv4 exact and CIDR matching', SP.ipMatches('183.82.4.247', '183.82.4.247') && SP.ipMatches('183.82.4.9', '183.82.4.0/24') && !SP.ipMatches('183.82.5.9', '183.82.4.0/24') && SP.ipMatches('::ffff:10.1.2.3', '10.0.0.0/8'));
  check('entries are checked', SP.validEntry('10.0.0.0/8') && SP.validEntry('::1') && !SP.validEntry('hello') && !SP.validEntry('10.0.0.0/4') && !SP.validEntry('300.1.1.1'));

  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const U = await prisma.user.create({ data: { name: 'ZZ policy user', email: `zz.pol.${P}@zz-pol-test.in`, username: `zz.pol.${P}@zz-pol-test.in`, passwordHash: await bcrypt.hash(PW, 10), status: 'Active', role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3) } });
  const AD = await prisma.user.create({ data: { name: 'ZZ policy admin', email: `zz.poladm.${P}@zz-pol-test.in`, username: `zz.poladm.${P}@zz-pol-test.in`, passwordHash: await bcrypt.hash(PW, 10), status: 'Active', role: 'ADMIN', hrmsRole: 'ADMIN', atsRole: 'ADMIN', hrmsAccess: true, atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3) } });
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1100); });
  const tok = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const tSuper = await tok(adminRow.id);
  const tAdm = await tok(AD.id);
  let tU = (await call('POST', '/auth/login', { email: U.email, password: PW })).body.token;

  check('a staff member cannot open the settings', (await call('GET', '/auth/security/policy', null, tU)).status === 403);
  const g = await call('GET', '/auth/security/policy', null, tSuper);
  check('defaults are today\'s rules and the list is off', g.status === 200 && g.body.password.minLength === 8 && !g.body.password.requireSymbol && g.body.ipAllow.enabled === false, g.body);

  const s1 = await call('PUT', '/auth/security/password-policy', { minLength: 12, requireUpper: true, requireSymbol: true, historyCount: 3, expiryDays: 30 }, tSuper);
  check('the admin tightens the password policy', s1.status === 200 && s1.body.password.minLength === 12 && s1.body.password.historyCount === 3, s1.body);
  const weak = await call('POST', '/auth/change-password', { currentPassword: PW, newPassword: 'abcdefgh1234' }, tU);
  check('a password without capital / symbol is refused with the reason', weak.status === 400 && /capital/.test(weak.body.error), weak.body);
  const NEW1 = 'Strong-Pass-2026-a';
  const c1 = await call('POST', '/auth/change-password', { currentPassword: PW, newPassword: NEW1 }, tU);
  check('a password that meets the policy is taken', c1.status === 200, c1.body);
  tU = c1.body.token;
  const NEW2 = 'Strong-Pass-2026-b';
  const c2 = await call('POST', '/auth/change-password', { currentPassword: NEW1, newPassword: NEW2 }, tU);
  tU = c2.body.token;
  const back = await call('POST', '/auth/change-password', { currentPassword: NEW2, newPassword: PW }, tU);
  check('one of the last 3 passwords cannot come back', back.status === 400 && /last 3/.test(back.body.error), back.body);
  // expiry
  await prisma.user.update({ where: { id: U.id }, data: { passwordChangedAt: new Date(Date.now() - 40 * 86400000) } });
  require('../src/utils/seedPasswords').forget && require('../src/utils/seedPasswords').forget(U.id);
  await new Promise((r) => { setTimeout(r, 31000); }); // the server's caches
  const ex = await call('GET', '/employees?limit=1', null, tU);
  check('a password older than 30 days must be changed before anything else', ex.status === 403 && ex.body.code === 'PASSWORD_CHANGE_REQUIRED', ex.body);
  await call('PUT', '/auth/security/password-policy', { minLength: 8, requireUpper: false, requireSymbol: false, historyCount: 0, expiryDays: 0 }, tSuper);
  await prisma.user.update({ where: { id: U.id }, data: { passwordChangedAt: new Date() } });

  // IP allow-list
  const me = g.body.yourIp;
  const badE = await call('PUT', '/auth/security/ip-allow', { enabled: true, entries: ['not-an-ip'] }, tSuper);
  check('a wrong entry is refused', badE.status === 400 && /not addresses/.test(badE.body.error), badE.body);
  const lockout = await call('PUT', '/auth/security/ip-allow', { enabled: true, entries: ['10.9.9.9'] }, tAdm);
  check('an Admin cannot switch it on without their own address (no lock-out)', lockout.status === 400 && /lock you out/.test(lockout.body.error), lockout.body);
  const on = await call('PUT', '/auth/security/ip-allow', { enabled: true, entries: ['10.9.9.9'] }, tSuper);
  check('a Super Admin (always exempt) switches it on', on.status === 200 && on.body.ipAllow.enabled === true, on.body);
  await new Promise((r) => { setTimeout(r, 1000); });
  const li = await call('POST', '/auth/login', { email: U.email, password: (await prisma.user.findUnique({ where: { id: U.id } })) && NEW2 });
  check('staff from another address cannot sign in, with a plain reason', li.status === 403 && li.body.code === 'IP_NOT_ALLOWED', li.body);
  const mid = await call('GET', '/auth/me', null, tU);
  check('...and an open session stops working', mid.status === 403 && mid.body.code === 'IP_NOT_ALLOWED', mid.body);
  check('the Super Admin keeps working', (await call('GET', '/auth/me', null, tSuper)).status === 200);
  check('the refusal is audited', !!(await prisma.auditLog.findFirst({ where: { entityId: U.id, action: 'Sign-in refused (address not on the company list)' } })));
  const add = await call('PUT', '/auth/security/ip-allow', { enabled: true, entries: ['10.9.9.9', me, '127.0.0.1', '::1'] }, tSuper);
  check('adding the address lets them in', add.status === 200 && (await call('POST', '/auth/login', { email: U.email, password: NEW2 })).status === 200, add.body);
  await call('PUT', '/auth/security/ip-allow', { enabled: false, entries: [] }, tSuper);
  check('changes are audited', (await prisma.auditLog.count({ where: { action: { in: ['Password policy changed', 'IP allow-list changed'] } } })) >= 4);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (err) => { console.error(err); await stop(1); });
