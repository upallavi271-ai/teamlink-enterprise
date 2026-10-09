#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Job Portal single sign-on + sign-in sessions — API test (HRMS side).
//
//   node scripts/test-job-portal-sso.js http://127.0.0.1:4411
//
// Runs against a RUNNING, SEEDED, ISOLATED backend (never the live one) and
// reads that backend's database directly for the session rows, so start it
// and run this with the SAME environment: DATABASE_URL, JWT_SECRET and
// HRMS_SSO_SECRET. Uses the seed's role-by-role logins (password123).
// Checks: who sees "Job Portal"; the launch token (HS256, iss/aud, 60 s, jti,
// sid, no password); the back channel both ways; the 30-minute inactivity
// timeout judged on real activity (x-tl-idle-ms), not polling; Sign Out on
// the server; old tokens without a session.
// ---------------------------------------------------------------------------
require('dotenv').config();
const assert = require('assert/strict');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');

const BASE = String(process.argv[2] || process.env.TEST_BASE_URL || '').replace(/\/+$/, '');
const SECRET = process.env.HRMS_SSO_SECRET || '';
const PASSWORD = 'password123';
if (!BASE) { console.error('usage: node scripts/test-job-portal-sso.js <backend url>'); process.exit(2); }
if (/:(4010|4323)\b/.test(BASE)) { console.error('Refusing to run against a live port.'); process.exit(2); }
if (SECRET.length < 32) { console.error('HRMS_SSO_SECRET (>= 32 chars) must be set, the same as the backend under test.'); process.exit(2); }

async function call(method, path, { token, body, headers = {} } = {}) {
  const h = { 'content-type': 'application/json', ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  const r = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await r.json(); } catch { json = null; }
  return { status: r.status, body: json };
}
const login = async (email) => {
  const r = await call('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
  assert.equal(r.status, 200, `${email}: ${JSON.stringify(r.body)}`);
  return r.body;
};
const fromPortal = (claims, aud = 'teamlink-hrms-backchannel', iss = 'teamlink-job-portal') =>
  jwt.sign({ jti: crypto.randomUUID(), ...claims }, SECRET, { algorithm: 'HS256', expiresIn: 60, issuer: iss, audience: aud });
const sidOf = (token) => jwt.decode(token).sid;

let passed = 0;
async function step(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) {
    console.log(`  FAIL ${name}\n       ${err && err.message}`);
    process.exitCode = 1;
  }
}

(async () => {
  console.log(`Job Portal SSO — ${BASE}`);
  let rec; let recSid;

  await step('Recruiter and Admin see "Job Portal"; Employee and Accountant do not', async () => {
    rec = await login('medical1@teamlink.com');
    assert.deepEqual([rec.user.jobPortal.allowed, rec.user.jobPortal.role], [true, 'RECRUITER']);
    const adm = await login('admin@teamlink.com');
    assert.deepEqual([adm.user.jobPortal.allowed, adm.user.jobPortal.role], [true, 'ADMIN']);
    const sa = await login('superadmin@teamlink.com');
    assert.equal(sa.user.jobPortal.allowed, true);
    for (const email of ['employee@teamlink.com', 'accounts@teamlink.com', 'medicaltl@teamlink.com']) {
      const u = await login(email);
      assert.equal(u.user.jobPortal.allowed, false, email);
      const r = await call('POST', '/api/sso/job-portal/launch', { token: u.token });
      assert.equal(r.status, 403, `${email}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, 'JOB_PORTAL_DENIED');
    }
  });

  await step('every sign-in has a server-side session', async () => {
    recSid = sidOf(rec.token);
    assert.ok(recSid, 'the token carries a sid');
    const s = await prisma.authSession.findUnique({ where: { id: recSid } });
    assert.ok(s && !s.revokedAt);
    assert.equal(s.userId, rec.user.id);
  });

  await step('launch: a 60-second, single-use HS256 token in the URL fragment', async () => {
    const r = await call('POST', '/api/sso/job-portal/launch', { token: rec.token, body: { next: '#/recruiter/jobs' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const u = new URL(r.body.url);
    assert.equal(u.pathname.endsWith('/hrms-sso.html'), true, u.pathname);
    assert.equal(u.search, '', 'nothing in the query string');
    const frag = new URLSearchParams(u.hash.slice(1));
    assert.equal(frag.get('next'), '#/recruiter/jobs');
    const t = frag.get('token');
    const c = jwt.verify(t, SECRET, { algorithms: ['HS256'], issuer: 'teamlink-hrms', audience: 'teamlink-job-portal' });
    assert.equal(jwt.decode(t, { complete: true }).header.alg, 'HS256');
    assert.equal(c.exp - c.iat, 60);
    assert.deepEqual([c.sub, c.email, c.role, c.sid], [rec.user.id, 'medical1@teamlink.com', 'RECRUITER', recSid]);
    assert.ok(c.name && c.jti);
    assert.ok(!/password|passwordHash/i.test(JSON.stringify(c)), 'no password in the token');
    const again = await call('POST', '/api/sso/job-portal/launch', { token: rec.token });
    const c2 = jwt.decode(new URLSearchParams(new URL(again.body.url).hash.slice(1)).get('token'));
    assert.notEqual(c2.jti, c.jti, 'a new jti every time');
    const odd = await call('POST', '/api/sso/job-portal/launch', { token: rec.token, body: { next: 'javascript:alert(1)' } });
    assert.equal(new URLSearchParams(new URL(odd.body.url).hash.slice(1)).get('next'), null, 'an odd next is dropped');
  });

  await step('back channel: the portal asks "is this sign-in alive?"', async () => {
    const ok = await call('POST', '/api/sso/job-portal/session', { body: { token: fromPortal({ sid: recSid }) } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.active, true);
    const wrongAud = await call('POST', '/api/sso/job-portal/session', { body: { token: fromPortal({ sid: recSid }, 'teamlink-job-portal') } });
    assert.equal(wrongAud.status, 401, 'a launch-audience token is refused');
    const forged = await call('POST', '/api/sso/job-portal/session', {
      body: { token: jwt.sign({ sid: recSid }, 'x'.repeat(40), { issuer: 'teamlink-job-portal', audience: 'teamlink-hrms-backchannel', expiresIn: 60 }) },
    });
    assert.equal(forged.status, 401);
    const unknown = await call('POST', '/api/sso/job-portal/session', { body: { token: fromPortal({ sid: crypto.randomUUID() }) } });
    assert.equal(unknown.body.active, false);
  });

  await step('polling is not activity; a click is', async () => {
    const old = new Date(Date.now() - 10 * 60000);
    await prisma.authSession.update({ where: { id: recSid }, data: { lastSeenAt: old } });
    const poll = await call('GET', '/api/auth/session', { token: rec.token, headers: { 'x-tl-idle-ms': String(20 * 60000) } });
    assert.equal(poll.status, 200);
    let s = await prisma.authSession.findUnique({ where: { id: recSid } });
    assert.equal(s.lastSeenAt.getTime(), old.getTime(), 'an idle page polling does not move it');
    await call('GET', '/api/auth/session', { token: rec.token, headers: { 'x-tl-idle-ms': '0' } });
    s = await prisma.authSession.findUnique({ where: { id: recSid } });
    assert.ok(Date.now() - s.lastSeenAt.getTime() < 5000, 'a click does');
  });

  await step('the portal\'s activity keeps the shared session alive', async () => {
    await prisma.authSession.update({ where: { id: recSid }, data: { lastSeenAt: new Date(Date.now() - 31 * 60000) } });
    const r = await call('POST', '/api/sso/job-portal/session', {
      body: { token: fromPortal({ sid: recSid, lastActiveAt: new Date(Date.now() - 60000).toISOString() }) },
    });
    assert.equal(r.body.active, true, 'busy in the portal a minute ago');
    assert.equal((await call('GET', '/api/auth/me', { token: rec.token })).status, 200, 'so HRMS is still signed in');
  });

  await step('30 minutes without activity anywhere: signed out of both', async () => {
    await prisma.authSession.update({ where: { id: recSid }, data: { lastSeenAt: new Date(Date.now() - 31 * 60000) } });
    const me = await call('GET', '/api/auth/me', { token: rec.token, headers: { 'x-tl-idle-ms': '0' } });
    assert.equal(me.status, 401, 'a click after the timeout does not bring it back');
    assert.equal(me.body.code, 'SESSION_EXPIRED');
    const s = await prisma.authSession.findUnique({ where: { id: recSid } });
    assert.ok(s.revokedAt);
    const p = await call('POST', '/api/sso/job-portal/session', { body: { token: fromPortal({ sid: recSid }) } });
    assert.equal(p.body.active, false, 'the portal hears it has ended');
  });

  await step('Sign Out ends the session on the server', async () => {
    const a = await login('medical1@teamlink.com');
    assert.equal((await call('POST', '/api/auth/logout', { token: a.token })).status, 200);
    const me = await call('GET', '/api/auth/me', { token: a.token });
    assert.deepEqual([me.status, me.body.code], [401, 'SESSION_EXPIRED']);
    const p = await call('POST', '/api/sso/job-portal/session', { body: { token: fromPortal({ sid: sidOf(a.token) }) } });
    assert.equal(p.body.active, false);
  });

  await step('signing out of the Job Portal signs HRMS out', async () => {
    const a = await login('medical1@teamlink.com');
    const r = await call('POST', '/api/sso/job-portal/logout', { body: { token: fromPortal({ sid: sidOf(a.token) }) } });
    assert.deepEqual([r.status, r.body.ended], [200, 1]);
    assert.equal((await call('GET', '/api/auth/me', { token: a.token })).status, 401);
    const bad = await call('POST', '/api/sso/job-portal/logout', { body: { token: 'nope' } });
    assert.equal(bad.status, 401);
  });

  await step('a token from before sessions keeps working, but cannot open the portal', async () => {
    const legacy = jwt.sign({ id: rec.user.id, email: rec.user.email }, process.env.JWT_SECRET, { expiresIn: '1h' });
    assert.equal((await call('GET', '/api/auth/me', { token: legacy })).status, 200);
    const r = await call('POST', '/api/sso/job-portal/launch', { token: legacy });
    assert.deepEqual([r.status, r.body.code], [401, 'SESSION_EXPIRED']);
  });

  console.log(`${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
  await prisma.$disconnect();
})().catch(async (err) => { console.error(err); process.exitCode = 1; await prisma.$disconnect(); });
