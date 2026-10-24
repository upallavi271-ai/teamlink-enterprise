// Forgot-password / password-change alert tests. SANDBOX ONLY (4011 + sandbox.db).
const path = require('path');
const BACK = 'C:/Users/user/Desktop/All_Projects/teamlink-enterprise/backend';
const SCRATCH = require('os').tmpdir();
process.env.DATABASE_URL = `file:${BACK}/prisma/sandbox.db`;
require('dotenv').config({ path: `${BACK}/.env` });
process.env.DATABASE_URL = `file:${BACK}/prisma/sandbox.db`;
const API = 'http://localhost:4011/api';
const fs = require('fs'); const os = require('os'); const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client'); const bcrypt = require('bcryptjs'); const jwt = require('jsonwebtoken');
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
const OUTBOX = path.join(os.homedir(), '.teamlink-sandbox', 'mail-outbox');
let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) pass += 1; else { fail += 1; console.log('  FAIL', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = Date.now().toString(36);
const mk = (n) => `zztest.${n}.${RUN}@example.test`;
let ipn = 0; const nextIp = () => `10.77.${(Date.now() % 200) + 1}.${((ipn += 1) % 250) + 1}`;
async function call(method, url, body, { token, ip } = {}) {
  const r = await fetch(API + url, { method, headers: { 'content-type': 'application/json', 'x-forwarded-for': ip || nextIp(), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ }
  return { s: r.status, j, h: r.headers };
}
const mints = (u) => jwt.sign({ id: u.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
const mails = () => (fs.existsSync(OUTBOX) ? fs.readdirSync(OUTBOX).filter((f) => f.endsWith('.json')).map((f) => ({ f, ...JSON.parse(fs.readFileSync(path.join(OUTBOX, f), 'utf8')) })) : []);
const clearMails = () => { if (fs.existsSync(OUTBOX)) fs.readdirSync(OUTBOX).forEach((f) => { try { fs.unlinkSync(path.join(OUTBOX, f)); } catch { /* */ } }); };
async function waitMail(to, kind, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const m = mails().find((x) => x.to === to && (!kind || x.kind === kind)); if (m) return m; await sleep(250); } return null; }
const tokenOf = (m) => (m.text.match(/token=([a-f0-9]{64})/) || [])[1];
const created = { users: [] };
let MINE = new Set();
async function mkUser(name, role, extra = {}) {
  const pw = `Zz${crypto.randomBytes(6).toString('hex')}9`; // generated per run, never reused
  const u = await prisma.user.create({ data: { name, email: mk(name.split(' ').pop().toLowerCase()), passwordHash: await bcrypt.hash(pw, 10), role, hrmsAccess: true, hrmsRole: role, passwordChangedAt: new Date(Date.now() - 86400000), ...extra } });
  created.users.push(u.id); return { ...u, pw };
}

(async () => {
  console.log('sandbox DB:', process.env.DATABASE_URL);
  if (!/sandbox\.db$/.test(process.env.DATABASE_URL)) throw new Error('not sandbox');
  clearMails();
  const sa = await mkUser('ZZTEST SuperA', 'SUPER_ADMIN');
  const sa2 = await mkUser('ZZTEST SuperB', 'SUPER_ADMIN');
  const ad = await mkUser('ZZTEST AdminC', 'ADMIN');
  const emp = await mkUser('ZZTEST Worker', 'EMPLOYEE');
  const emp2 = await mkUser('ZZTEST Other', 'EMPLOYEE');
  const off = await mkUser('ZZTEST Gone', 'EMPLOYEE', { status: 'Inactive' });
  const tEmp = mints(emp);
  MINE = new Set([sa, sa2, ad, emp, emp2, off].map((u) => u.id)); // sandbox also holds other agents' ZZTEST admins
  const myMails = (kind) => mails().filter((m) => m.kind === kind && [sa, sa2, ad, emp, emp2].some((u) => u.email === m.to));
  await prisma.appSetting.deleteMany({ where: { key: 'security.passwordAlert' } });

  console.log('1 neutral answer');
  await call('POST', '/auth/forgot-password', { email: `warm.${RUN}@example.test` }); await sleep(1000);
  const dReal = []; const dFake = []; let r1; let r2;
  for (let i = 0; i < 3; i += 1) {
    let t = Date.now(); r1 = await call('POST', '/auth/forgot-password', { email: i === 0 ? emp.email : emp2.email }); dReal.push(Date.now() - t);
    await sleep(3000);
    t = Date.now(); r2 = await call('POST', '/auth/forgot-password', { email: `nobody${i}.${RUN}@example.test` }); dFake.push(Date.now() - t);
    await sleep(3000);
  }
  const med = (l) => [...l].sort((x, y) => x - y)[1];
  ok(r1.s === 200 && r2.s === 200, 'both 200');
  ok(JSON.stringify(r1.j) === JSON.stringify(r2.j), 'identical body');
  console.log('  timing real', dReal, 'unknown', dFake, '(machine is loaded by other agents; the answer is sent BEFORE the mail work, by design)');
  ok(Math.max(...dReal, ...dFake) < 6000, 'both answer promptly');
  const r3 = await call('POST', '/auth/forgot-password', { email: off.email });
  ok(JSON.stringify(r3.j) === JSON.stringify(r1.j), 'inactive account same body');
  const bad = await call('POST', '/auth/forgot-password', { email: 'not-an-email' });
  ok(bad.s === 400, 'malformed email 400');

  console.log('2 email');
  const m1 = await waitMail(emp.email, 'password-reset');
  ok(!!m1, 'reset mail captured');
  const tok1 = m1 && tokenOf(m1);
  ok(tok1 && /^[a-f0-9]{64}$/.test(tok1), '32-byte token in link');
  ok(m1.text.includes('/new-password?token='), 'link goes to /new-password');
  ok(/Reset my password/.test(m1.html), 'button text');
  ok(/30 minutes/.test(m1.text) && /Didn't ask for this\? Ignore this email/.test(m1.text), 'expiry + ignore line');
  ok(!m1.text.includes(emp.pw) && !m1.html.includes(emp.pw) && !m1.text.includes(emp.name) && !m1.html.includes(emp.email), 'no password / name / email in mail');
  ok(/cid:teamlink-logo|>TeamLink</.test(m1.html), 'brand header');
  ok(!mails().some((m) => m.to === `nobody.${RUN}@example.test` || m.to === off.email), 'nothing built for unknown / inactive');
  fs.writeFileSync(path.join(SCRATCH, 'pw-reset-mail.html'), m1.html.replace('cid:teamlink-logo', 'file:///C:/Users/user/Desktop/All_Projects/teamlink-enterprise/frontend/src/assets/teamlink-full-logo.png'));

  console.log('3 token storage');
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const rowH = await prisma.appSetting.findUnique({ where: { key: `pwreset:t:${sha(tok1)}` } });
  ok(!!rowH, 'row by hash');
  const all = await prisma.appSetting.findMany({ where: { key: { startsWith: 'pwreset:' } } });
  ok(!all.some((r) => r.key.includes(tok1) || r.value.includes(tok1)), 'raw token not stored');
  const chk = await call('GET', `/auth/reset-password/check?token=${tok1}`);
  ok(chk.s === 200 && chk.j.minutesLeft <= 30 && chk.j.minutesLeft >= 29, 'check ok ~30 min');
  ok(!JSON.stringify(chk.j).includes('@'), 'check leaks no email');

  clearMails();
  await call('POST', '/auth/forgot-password', { email: emp.email });
  const m2 = await waitMail(emp.email, 'password-reset'); const tok2 = tokenOf(m2);
  ok(tok2 && tok2 !== tok1, 'second token differs');
  const old = await call('GET', `/auth/reset-password/check?token=${tok1}`);
  ok(old.s === 410 && old.j.code === 'superseded', 'older link superseded');

  const kT2 = `pwreset:t:${sha(tok2)}`; const row2 = await prisma.appSetting.findUnique({ where: { key: kT2 } });
  const rec2 = JSON.parse(row2.value);
  await prisma.appSetting.update({ where: { key: kT2 }, data: { value: JSON.stringify({ ...rec2, expiresAt: new Date(Date.now() - 1000).toISOString() }) } });
  const ex = await call('GET', `/auth/reset-password/check?token=${tok2}`);
  ok(ex.s === 410 && ex.j.code === 'expired', 'expired link refused');
  const exr = await call('POST', '/auth/reset-password', { token: tok2, password: 'Brand-New-Pass-77' });
  ok(exr.s === 410 && exr.j.code === 'expired', 'expired link cannot reset');
  clearMails();
  const rs = await call('POST', '/auth/reset-password/resend', { token: tok2 });
  ok(rs.s === 200, 'resend ok');
  const m3 = await waitMail(emp.email, 'password-reset'); const tok3 = m3 && tokenOf(m3);
  ok(tok3, 'resend mail captured');
  ok((await call('POST', '/auth/reset-password/resend', { token: 'f'.repeat(64) })).j.message === rs.j.message, 'resend of unknown token is neutral too');

  console.log('4 reset');
  const sessionBefore = mints(emp);
  ok((await call('GET', '/auth/me', null, { token: sessionBefore })).s === 200, 'session works before');
  await sleep(1100); // JWT iat has 1 s precision
  clearMails();
  for (const [pw, label] of [['short1', 'too short'], ['password123', 'common'], ['abcdefghij', 'no number'], [`Zztest-2026-ab`, 'contains name']]) {
    const w = await call('POST', '/auth/reset-password', { token: tok3, password: pw });
    ok(w.s === 400, `policy refuses ${label}`);
  }
  ok((await call('POST', '/auth/reset-password', { token: tok3, password: 'Valid-pass-4455', confirmPassword: 'other' })).s === 400, 'mismatch refused');
  ok((await call('POST', '/auth/reset-password', { token: tok3, password: emp.pw })).j?.code === 'same', 'same as old refused');
  ok((await call('GET', `/auth/reset-password/check?token=${tok3}`)).s === 200, 'weak tries did not burn the link');
  await prisma.user.update({ where: { id: emp.id }, data: { failedLoginCount: 3, lockedUntil: new Date(Date.now() + 600000) } });
  const NEW = `Nw${crypto.randomBytes(5).toString('hex')}-Z9`;
  const done = await call('POST', '/auth/reset-password', { token: tok3, password: NEW, confirmPassword: NEW });
  ok(done.s === 200, 'reset ok');
  const again = await call('POST', '/auth/reset-password', { token: tok3, password: `${NEW}x` });
  ok(again.s === 410 && again.j.code === 'used', 'reuse rejected');
  const fresh = await prisma.user.findUnique({ where: { id: emp.id } });
  ok(fresh.failedLoginCount === 0 && !fresh.lockedUntil, 'lockout counters reset');
  ok(fresh.passwordChangedAt > new Date(Date.now() - 20000), 'passwordChangedAt stamped');
  ok(!(await bcrypt.compare(emp.pw, fresh.passwordHash)) && (await bcrypt.compare(NEW, fresh.passwordHash)), 'hash changed');
  ok((await call('GET', '/auth/me', null, { token: sessionBefore })).j?.code === 'PASSWORD_CHANGED', 'older session ended');
  const lo = await call('POST', '/auth/login', { email: emp.email, password: emp.pw });
  ok(lo.s === 401, 'old password fails');
  const ln = await call('POST', '/auth/login', { email: emp.email, password: NEW });
  ok(ln.s === 200 && ln.j.token, 'new password logs in');
  ok((await call('GET', '/auth/me', null, { token: ln.j.token })).s === 200, 'new session works');

  console.log('5 alerts');
  await sleep(1200);
  const notes = await prisma.notification.findMany({ where: { title: { startsWith: 'Password changed:' } } });
  const forEmp = notes.filter((n) => n.title.includes('ZZTEST Worker') && MINE.has(n.userId));
  const rcp = new Set(forEmp.map((n) => n.userId));
  ok(rcp.has(sa.id) && rcp.has(sa2.id) && rcp.has(ad.id), 'SuperA, SuperB, AdminC told');
  ok(!rcp.has(emp.id) && !rcp.has(emp2.id), 'not the actor, not normal users');
  ok(forEmp.length === 3, `exactly one each (got ${forEmp.length})`);
  const n0 = forEmp[0];
  ok(/ZZTEST Worker \(Employee\) changed their password on .* using the reset link\. If this was not them, open Users and block the login\./.test(n0.message), `message wording: ${n0.message.split('\n')[0]}`);
  ok(n0.message.includes(`Open: /admin/users?block=${emp.id}`), 'deep link');
  ok(![NEW, emp.pw].some((p) => forEmp.some((n) => (n.message + n.title).includes(p))), 'notification has no password');
  const am = myMails('password-alert');
  ok(am.length === 3 && [sa, sa2, ad].every((u) => am.some((m) => m.to === u.email)), 'alert mail to 3 admins');
  ok(am.every((m) => !(m.text + m.html).includes(NEW) && !(m.text + m.html).includes(emp.pw)), 'alert mails carry no password');
  ok(am.every((m) => /Block this login/.test(m.html) && /block=/.test(m.text)), 'alert mail has block button');
  ok(!myMails('password-alert').some((m) => m.to === emp.email), 'actor not mailed');
  if (am[0]) fs.writeFileSync(path.join(SCRATCH, 'pw-alert-mail.html'), am[0].html.replace('cid:teamlink-logo', 'file:///C:/Users/user/Desktop/All_Projects/teamlink-enterprise/frontend/src/assets/teamlink-full-logo.png'));

  clearMails();
  const SANEW = `Sa${crypto.randomBytes(5).toString('hex')}-Q8`;
  const tSaFresh = mints(sa);
  await sleep(1100);
  const cp = await call('POST', '/auth/change-password', { currentPassword: sa.pw, newPassword: SANEW, confirmPassword: SANEW }, { token: tSaFresh });
  ok(cp.s === 200 && cp.j.token, 'change-password ok + fresh token');
  ok((await call('GET', '/auth/me', null, { token: cp.j.token })).s === 200, 'fresh token works');
  ok((await call('GET', '/auth/me', null, { token: tSaFresh })).j?.code === 'PASSWORD_CHANGED', 'old token ended');
  await sleep(1000);
  const saNotes = await prisma.notification.findMany({ where: { title: 'Password changed: ZZTEST SuperA', userId: { in: [...MINE] } } });
  const sr = new Set(saNotes.map((n) => n.userId));
  ok(sr.has(sa2.id) && sr.has(ad.id) && !sr.has(sa.id) && saNotes.length === 2, 'other SA + Admin told, not self');
  ok(saNotes[0] && /using My Profile/.test(saNotes[0].message), 'method My Profile');
  ok((await call('POST', '/auth/change-password', { currentPassword: 'wrong-pass-1', newPassword: `${SANEW}x` }, { token: cp.j.token })).s === 400, 'wrong current refused');

  console.log('6 setting');
  const tAd = mints(ad);
  const g = await call('GET', '/admin/password-alert-setting', null, { token: tAd });
  ok(g.s === 200 && g.j.roles.includes('ADMIN') && g.j.canEdit === false, 'admin can read, not edit');
  ok((await call('PUT', '/admin/password-alert-setting', { roles: ['SUPER_ADMIN'] }, { token: tAd })).s === 403, 'admin cannot edit');
  ok((await call('GET', '/admin/password-alert-setting', null, { token: tEmp })).s !== 200, 'employee cannot read');
  const tSa2 = mints(sa2);
  const put = await call('PUT', '/admin/password-alert-setting', { roles: ['SUPER_ADMIN'], email: false }, { token: tSa2 });
  ok(put.s === 200 && put.j.roles.join() === 'SUPER_ADMIN' && put.j.email === false, 'SA saved setting');
  clearMails();
  await prisma.notification.deleteMany({ where: { title: { startsWith: 'Password changed:' } } });
  await call('POST', '/auth/forgot-password', { email: emp2.email });
  const m4 = await waitMail(emp2.email, 'password-reset'); const tok4 = tokenOf(m4);
  const N2 = `Ot${crypto.randomBytes(5).toString('hex')}-K3`;
  ok((await call('POST', '/auth/reset-password', { token: tok4, password: N2 })).s === 200, 'second reset');
  await sleep(1200);
  const n2 = await prisma.notification.findMany({ where: { title: 'Password changed: ZZTEST Other', userId: { in: [...MINE] } } });
  ok(n2.length === 2 && n2.every((n) => [sa.id, sa2.id].includes(n.userId)), 'only Super Admins told now');
  ok(myMails('password-alert').length === 0, 'email switched off honoured');
  await call('PUT', '/admin/password-alert-setting', { roles: ['SUPER_ADMIN', 'ADMIN'], email: true }, { token: tSa2 });

  console.log('7 admin link');
  const tAdFresh = mints(ad);
  ok((await call('POST', `/admin/users/${emp.id}/reset-link`, null, { token: mints(emp2) })).s !== 200, 'employee cannot make link');
  ok((await call('POST', `/admin/users/${sa2.id}/reset-link`, null, { token: tAdFresh })).s === 403, 'Admin cannot make link for Super Admin');
  ok((await call('POST', `/admin/users/${ad.id}/reset-link`, null, { token: tAdFresh })).s === 400, 'not for yourself');
  ok((await call('POST', `/admin/users/${off.id}/reset-link`, null, { token: tAdFresh })).s === 409, 'not for a switched-off login');
  clearMails();
  const lk = await call('POST', `/admin/users/${emp.id}/reset-link`, null, { token: tAdFresh });
  ok(lk.s === 200 && lk.j.link.includes('/new-password?token=') && lk.j.minutes === 60, 'link made');
  ok(!mails().length, 'link shown on screen, nothing mailed');
  const atok = lk.j.link.split('token=')[1];
  ok(!(await prisma.appSetting.findMany({ where: { key: { startsWith: 'pwreset:' } } })).some((r) => r.value.includes(atok) || r.key.includes(atok)), 'admin token stored hashed');
  const aud = await prisma.auditLog.findFirst({ where: { action: 'Reset link made for ZZTEST Worker' } });
  ok(aud && aud.userId === ad.id && !JSON.stringify(aud).includes(atok), 'admin link audited, no token');
  const N3 = `Ad${crypto.randomBytes(5).toString('hex')}-L5`;
  ok((await call('POST', '/auth/reset-password', { token: atok, password: N3 })).s === 200, 'person used admin link');
  await sleep(1200);
  const n3 = await prisma.notification.findMany({ where: { title: 'Password changed: ZZTEST Worker', createdAt: { gt: new Date(Date.now() - 20000) } } });
  ok(n3.length >= 1 && n3.every((n) => n.userId !== ad.id) && /Done by ZZTEST AdminC/.test(n3[0].message), 'admin-link alert, generator not told, names the Admin');

  await prisma.notification.deleteMany({ where: { title: { startsWith: 'Password changed:' } } });
  const tr = await call('POST', `/admin/users/${emp2.id}/reset-password`, { password: `Ty${crypto.randomBytes(5).toString('hex')}-P2` }, { token: mints(sa2) });
  ok(tr.s === 200, 'admin typed reset');
  await sleep(1000);
  const n4 = await prisma.notification.findMany({ where: { title: 'Password changed: ZZTEST Other' } });
  ok(n4.length >= 1 && n4.every((n) => n.userId !== sa2.id) && /an Admin reset/.test(n4[0].message), 'admin reset alert');

  console.log('8 rate limits');
  const rl = `zztest.rl.${RUN}@example.test`; const codes = [];
  for (let i = 0; i < 7; i += 1) codes.push((await call('POST', '/auth/forgot-password', { email: rl })).s);
  ok(codes.slice(0, 5).every((c) => c === 200) && codes[5] === 429 && codes[6] === 429, `per-email limit ${codes}`);
  const rlr = await call('POST', '/auth/forgot-password', { email: rl });
  ok(/Too many tries/.test(rlr.j.error) && rlr.h.get('retry-after'), 'plain message + Retry-After');
  const sameIp = `10.250.${(Date.now() % 250) + 1}.9`; const c2 = [];
  for (let i = 0; i < 22; i += 1) c2.push((await call('POST', '/auth/forgot-password', { email: `zztest.ip${i}.${RUN}@example.test` }, { ip: sameIp })).s);
  ok(c2[19] === 200 && c2[20] === 429, `per-IP limit ${c2.join(',')}`);

  console.log('9 email off');
  const integ = await prisma.integration.findUnique({ where: { id: 'email' } });
  if (integ) {
    await prisma.integration.update({ where: { id: 'email' }, data: { enabled: false } });
    const a = await call('POST', '/auth/forgot-password', { email: emp2.email }); const b = await call('POST', '/auth/forgot-password', { email: `ghost.${RUN}@example.test` });
    ok(a.s === 503 && b.s === 503 && JSON.stringify(a.j) === JSON.stringify(b.j) && /could not send the email right now/i.test(a.j.error), 'honest, same for real/unknown');
    await prisma.integration.update({ where: { id: 'email' }, data: { enabled: integ.enabled } });
  } else console.log('  (no email integration row; skipped)');

  console.log('10 audit');
  const audits = await prisma.auditLog.findMany({ where: { OR: [{ action: { startsWith: 'Password reset' } }, { action: { startsWith: 'Password changed' } }, { action: { startsWith: 'Reset link' } }], createdAt: { gt: new Date(Date.now() - 900000) } } });
  const acts = new Set(audits.map((a) => a.action));
  ok(acts.has('Password reset requested') && acts.has('Password reset requested - no such account') && acts.has('Password changed using a reset link') && acts.has('Password changed (self-service)') && acts.has('Password reset request refused - too many tries'), `audit actions: ${[...acts].join(' | ')}`);
  ok(audits.every((a) => ![tok1, tok2, tok3, tok4, atok, NEW, N2, N3, SANEW].some((t) => JSON.stringify(a).includes(t))), 'no token / password in audit');
  ok(audits.some((a) => /IP /.test(a.reason || '')), 'IP recorded');

  const ids = created.users;
  await prisma.notification.deleteMany({ where: { OR: [{ userId: { in: ids } }, { message: { contains: 'ZZTEST' } }] } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { entityId: { in: ids } }, { reason: { contains: 'zztest' } }, { action: { contains: 'ZZTEST' } }] } });
  await prisma.appSetting.deleteMany({ where: { OR: [{ key: { startsWith: 'pwreset:' } }, { key: 'security.passwordAlert' }] } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  clearMails();
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('CRASH', e); await prisma.$disconnect(); process.exit(2); });
