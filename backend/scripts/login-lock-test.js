#!/usr/bin/env node
// ---------------------------------------------------------------------------
// HR LOCK / UNLOCK A LOGIN (founder 2026-10-25: "HR must have a lock & unlock option"). SANDBOX ONLY.
//   cd backend && npm run sandbox -- --restart --detach --no-watch && TL_API=http://localhost:4011 node scripts/login-lock-test.js
// ---------------------------------------------------------------------------
const bcrypt = require('bcryptjs');
const Z = require('./lib/zzfix')('LCK');

(async () => {
  const { prisma } = Z;
  try {
    const PW = `Zz-${Z.RUN}-Lock-Pass-55!`;
    const mk = (tag, role, dept) => Z.mkUser(tag, { role, hrmsRole: role, hrmsAccess: true, atsRole: 'NONE', atsAccess: false, passwordChangedAt: new Date(Date.now() - 86400000), passwordHash: bcrypt.hashSync(PW, 10) }, { designation: 'Executive', department: dept });
    const hr = await mk('hr', 'HR', 'HR');
    const emp = await mk('emp', 'EMPLOYEE', 'Medical');
    const other = await mk('other', 'EMPLOYEE', 'Medical');
    const sa = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN', status: 'Active', employee: { isNot: null } } });
    const saEmp = sa && await prisma.employee.findFirst({ where: { userId: sa.id } });
    const eEmp = await prisma.employee.findFirst({ where: { userId: emp.id } });
    const hrEmp = await prisma.employee.findFirst({ where: { userId: hr.id } });
    const hTok = await Z.mint(hr); const oTok = await Z.mint(other);
    const login = (u) => Z.call('POST', '/api/auth/login', null, { email: u.email, password: PW });
    const lockIt = (tok, id, lock, reason) => Z.call('POST', `/api/employees/management/${id}/login-lock`, tok, { lock, reason });

    const s0 = await login(emp);
    const eTok = s0.body && s0.body.token;
    Z.check('K1 the employee can sign in before', s0.status === 200 && !!eTok, s0.status);
    const bad = await lockIt(oTok, eEmp.id, true);
    Z.check('K2 an ordinary employee cannot lock somebody\'s login (403)', bad.status === 403, bad.status);
    const l = await lockIt(hTok, eEmp.id, true, 'ZZTEST LCK left the laptop open');
    Z.check('K3 HR locks the login (200) and it reads "Locked"', l.status === 200 && l.body.row && l.body.row.loginStatus === 'Locked', [l.status, l.text.slice(0, 200)]);
    const me = await Z.call('GET', '/api/auth/me', eTok);
    Z.check('K4 the person is signed out at once (their open session stops working)', me.status === 401 || me.status === 403, me.status);
    const s1 = await login(emp);
    Z.check('K5 they cannot sign in while locked, and are told to ask HR', s1.status === 403 && /locked by HR/i.test(s1.body && s1.body.error), [s1.status, s1.text.slice(0, 160)]);
    const again = await lockIt(hTok, eEmp.id, true);
    Z.check('K6 locking a locked login again is a plain 409', again.status === 409, again.status);
    const u = await lockIt(hTok, eEmp.id, false, 'ZZTEST LCK back at the desk');
    const s2 = await login(emp);
    Z.check('K7 HR unlocks it and the person signs in again', u.status === 200 && u.body.row.loginStatus === 'Active' && s2.status === 200, [u.status, s2.status]);
    // a wrong-password lock (time lock) is cleared by Unlock too
    await prisma.user.update({ where: { id: emp.id }, data: { lockedUntil: new Date(Date.now() + 30 * 60000), failedLoginCount: 0 } });
    const s3 = await login(emp);
    const u2 = await lockIt(hTok, eEmp.id, false);
    const s4 = await login(emp);
    Z.check('K8 a lock from too many wrong passwords is cleared by Unlock at once (no 30-minute wait)', s3.status === 423 && u2.status === 200 && s4.status === 200, [s3.status, u2.status, s4.status]);
    const self = await lockIt(hTok, hrEmp.id, true);
    Z.check('K9 HR cannot lock their own login (409)', self.status === 409, self.status);
    if (saEmp) {
      const top = await lockIt(hTok, saEmp.id, true);
      Z.check('K10 HR cannot lock the Super Admin (403)', top.status === 403, top.status);
    }
    const aud = await prisma.auditLog.findMany({ where: { entityId: emp.id, action: { in: ['Login locked by HR', 'Login unlocked by HR'] } } });
    Z.check('K11 every lock / unlock is written down with who and why', aud.length >= 3 && aud.some((a) => /left the laptop/.test(a.reason || '')), aud.map((a) => a.action));
  } catch (e) { Z.fail += 1; console.log('FAIL  crashed', e && e.stack ? e.stack.slice(0, 900) : e); } finally {
    await Z.cleanup([(p) => p.auditLog.deleteMany({ where: { reason: { contains: 'ZZTEST LCK' } } })]).catch((e) => console.log('cleanup problem', String(e.message).slice(0, 160)));
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();
