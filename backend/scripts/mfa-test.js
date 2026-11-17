#!/usr/bin/env node
/**
 * TWO-STEP SIGN-IN (utils/mfa.js, routes/mfa.js, routes/auth.js finishSignIn) - founder 2026-11-17 "Security first".
 * RFC 6238 known answers, set-up, sign-in with the code, replay refused, recovery code once, the ticket is no session,
 * wrong codes lock the login, the company rule forces set-up, admin reset, turning it off needs password + code.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4067.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/mfa-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-mfa-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = 4067;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'mfa-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const MFA = require('../src/utils/mfa');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };
const call = async (method, url, body, token) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j };
};
const PW = 'Zz!Mfa-Test-2026';
const P = process.pid;
const mkUser = async (tag, data = {}) => prisma.user.create({ data: { name: `ZZ mfa ${tag}`, email: `zz.mfa.${tag}.${P}@zz-mfa-test.in`, username: `zz.mfa.${tag}.${P}@zz-mfa-test.in`, passwordHash: await bcrypt.hash(PW, 10), status: 'Active', role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3), ...data } });
const tokenOf = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
const key = (s) => String(s).replace(/\s/g, '');
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}

(async () => {
  // RFC 6238 appendix B (SHA1, 8 digits, secret "12345678901234567890")
  const rfc = Buffer.from('12345678901234567890');
  const vec = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037']];
  check('RFC 6238 known answers', vec.every(([t, want]) => MFA.hotp(rfc, Math.floor(t / 30), 8) === want), vec.map(([t]) => MFA.hotp(rfc, Math.floor(t / 30), 8)));
  check('base32 round trip', MFA.b32decode(MFA.b32encode(rfc)).equals(rfc));
  const s0 = MFA.b32encode(Buffer.from('abcdefghij0123456789'));
  const now = Date.now();
  check('a code from 30 s ago is still accepted (clock drift), 2 minutes ago is not', MFA.verifyCode(s0, MFA.totp(s0, now - 30000), { ms: now }) != null && MFA.verifyCode(s0, MFA.totp(s0, now - 120000), { ms: now }) == null);

  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const A = await mkUser('a');
  const B = await mkUser('b');
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1100); });
  const tAdmin = await tokenOf(adminRow.id);

  const l0 = await call('POST', '/auth/login', { email: A.email, password: PW });
  check('without two-step, sign-in is as before (token at once)', l0.status === 200 && !!l0.body.token && !l0.body.mfaRequired, l0.body);
  const tA = l0.body.token;
  check('set-up needs the current password', (await call('POST', '/auth/mfa/start', { password: 'wrong' }, tA)).status === 400);
  const st = await call('POST', '/auth/mfa/start', { password: PW }, tA);
  check('set-up gives a QR, an otpauth link and a setup key', st.status === 200 && /<svg/.test(st.body.qrSvg || '') && /^otpauth:\/\/totp\//.test(st.body.otpauth) && key(st.body.secret).length === 32, { ...st.body, qrSvg: !!st.body.qrSvg });
  const secret = key(st.body.secret);
  check('a wrong code does not turn it on', (await call('POST', '/auth/mfa/confirm', { code: '000000' }, tA)).status === 400);
  const cf = await call('POST', '/auth/mfa/confirm', { code: MFA.totp(secret) }, tA);
  check('the right code turns it on and shows 10 recovery codes once', cf.status === 200 && Array.isArray(cf.body.recoveryCodes) && cf.body.recoveryCodes.length === 10, cf.body);
  const recovery = cf.body.recoveryCodes || [];
  const s1 = await call('GET', '/auth/mfa/status', null, tA);
  check('status says on, and never shows the secret again', s1.body.enabled === true && s1.body.recoveryLeft === 10 && !JSON.stringify(s1.body).includes(secret), s1.body);
  check('the secret is stored encrypted', !JSON.stringify(await prisma.$queryRawUnsafe('SELECT * FROM "UserMfa" WHERE "userId" = ?', A.id)).includes(secret));

  const l1 = await call('POST', '/auth/login', { email: A.email, password: PW });
  check('with two-step on, the right password gives a ticket, not a session', l1.status === 200 && l1.body.mfaRequired === true && !!l1.body.mfaTicket && !l1.body.token, l1.body);
  check('the ticket cannot be used as a session', (await call('GET', '/auth/me', null, l1.body.mfaTicket)).status === 401);
  const wrong = await call('POST', '/auth/mfa/verify', { mfaTicket: l1.body.mfaTicket, code: '123456' });
  check('a wrong code is refused', wrong.status === 401, wrong.body);
  const nextCode = MFA.totp(secret, Date.now() + 30000); // the step after the one used at set-up
  const v1 = await call('POST', '/auth/mfa/verify', { mfaTicket: l1.body.mfaTicket, code: nextCode });
  check('the right code opens the session', v1.status === 200 && !!v1.body.token && !!v1.body.user, v1.body);
  const l2 = await call('POST', '/auth/login', { email: A.email, password: PW });
  check('the same code again is refused (replay)', (await call('POST', '/auth/mfa/verify', { mfaTicket: l2.body.mfaTicket, code: nextCode })).status === 401);
  const rv = await call('POST', '/auth/mfa/verify', { mfaTicket: l2.body.mfaTicket, recoveryCode: recovery[0].toLowerCase() });
  check('a recovery code works (any case) and says how many are left', rv.status === 200 && !!rv.body.token && rv.body.recoveryLeft === 9, rv.body);
  const l3 = await call('POST', '/auth/login', { email: A.email, password: PW });
  check('a recovery code works only once', (await call('POST', '/auth/mfa/verify', { mfaTicket: l3.body.mfaTicket, recoveryCode: recovery[0] })).status === 401);
  check('a forged ticket is refused', (await call('POST', '/auth/mfa/verify', { mfaTicket: jwt.sign({ t: 'mfa', u: A.id, p: 'verify', f: 'x' }, 'mfa-test'), code: MFA.totp(secret) })).status === 401);
  // wrong codes lock the login (5 tries in all, the 2 above count too)
  let last = null;
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const lx = await call('POST', '/auth/login', { email: A.email, password: PW });
    if (lx.status === 423) { last = lx; break; }
    // eslint-disable-next-line no-await-in-loop
    last = await call('POST', '/auth/mfa/verify', { mfaTicket: lx.body.mfaTicket, code: '111111' });
  }
  const locked = await prisma.user.findUnique({ where: { id: A.id } });
  check('wrong codes lock the login like wrong passwords', !!locked.lockedUntil && new Date(locked.lockedUntil) > new Date(), { lockedUntil: locked.lockedUntil, last: last && last.status });
  check('every wrong code is audited', (await prisma.auditLog.count({ where: { entityId: A.id, action: 'Failed sign-in (wrong two-step code)' } })) >= 3);
  await prisma.user.update({ where: { id: A.id }, data: { lockedUntil: null, failedLoginCount: 0 } });

  // the company rule
  check('only an administrator may change the rule', (await call('PUT', '/auth/mfa/policy', { roles: ['EMPLOYEE'] }, tA)).status === 403);
  const pol = await call('PUT', '/auth/mfa/policy', { roles: ['EMPLOYEE', 'NOT_A_ROLE'] }, tAdmin);
  check('the admin sets "compulsory for Employee" (unknown roles dropped)', pol.status === 200 && JSON.stringify(pol.body.roles) === '["EMPLOYEE"]', pol.body);
  const lb = await call('POST', '/auth/login', { email: B.email, password: PW });
  check('a covered login without two-step must set it up before any session', lb.status === 200 && lb.body.mfaEnrolRequired === true && !lb.body.token, lb.body);
  const es = await call('POST', '/auth/mfa/enrol/start', { mfaTicket: lb.body.mfaTicket });
  check('set-up at sign-in gives the QR', es.status === 200 && /<svg/.test(es.body.qrSvg || ''));
  const ec = await call('POST', '/auth/mfa/enrol/confirm', { mfaTicket: lb.body.mfaTicket, code: MFA.totp(key(es.body.secret)) });
  check('the code finishes set-up and signs in, with recovery codes', ec.status === 200 && !!ec.body.token && (ec.body.recoveryCodes || []).length === 10, { ...ec.body, user: !!ec.body.user });
  const tB = ec.body.token;
  check('a covered login cannot turn it off', (await call('POST', '/auth/mfa/disable', { password: PW, code: MFA.totp(key(es.body.secret), Date.now() + 30000) }, tB)).status === 409);
  await call('PUT', '/auth/mfa/policy', { roles: [] }, tAdmin);

  // admin reset (lost phone)
  check('a non-admin cannot reset someone', (await call('POST', `/auth/mfa/reset/${A.id}`, {}, tB)).status === 403);
  const rs = await call('POST', `/auth/mfa/reset/${B.id}`, { reason: 'Lost phone' }, tAdmin);
  check('the admin resets it', rs.status === 200 && !(await MFA.isOn(B.id)), rs.body);
  check('the reset signs that login out everywhere', (await call('GET', '/auth/me', null, tB)).status === 401);
  check('the reset is audited', !!(await prisma.auditLog.findFirst({ where: { entityId: B.id, action: 'Two-step sign-in reset by an administrator' } })));
  const lb2 = await call('POST', '/auth/login', { email: B.email, password: PW });
  check('after the reset (rule off) the password alone signs in', lb2.status === 200 && !!lb2.body.token, lb2.body);

  // turning it off
  const tA2 = (await call('POST', '/auth/mfa/verify', { mfaTicket: (await call('POST', '/auth/login', { email: A.email, password: PW })).body.mfaTicket, recoveryCode: recovery[1] })).body.token;
  check('turning it off needs the password', (await call('POST', '/auth/mfa/disable', { password: 'nope', code: MFA.totp(secret, Date.now() + 30000) }, tA2)).status === 400);
  const off = await call('POST', '/auth/mfa/disable', { password: PW, recoveryCode: recovery[2] }, tA2);
  check('password + a code turns it off', off.status === 200 && !(await MFA.isOn(A.id)), off.body);
  check('turning on / off is audited', (await prisma.auditLog.count({ where: { entityId: A.id, action: { in: ['Two-step sign-in turned on', 'Two-step sign-in turned off'] } } })) === 2);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
