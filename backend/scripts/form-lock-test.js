#!/usr/bin/env node
// ---------------------------------------------------------------------------
// HR LOCKS / UNLOCKS THE EMPLOYEE FORM (founder 2026-10-26: "hr ki lock and unlock option evvu employee management lo employee form ni").
// SANDBOX ONLY.
//   cd backend && npm run sandbox -- --restart --detach --no-watch && TL_API=http://localhost:4011 node scripts/form-lock-test.js
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('FLK');

(async () => {
  const { prisma } = Z;
  try {
    const mk = (tag, role, dept) => Z.mkUser(tag, { role, hrmsRole: role, hrmsAccess: true, atsRole: 'NONE', atsAccess: false }, { designation: 'Executive', department: dept });
    const hr = await mk('hr', 'HR', 'HR');
    const emp = await mk('emp', 'EMPLOYEE', 'Medical');
    const other = await mk('other', 'EMPLOYEE', 'Medical');
    const e = await prisma.employee.findFirst({ where: { userId: emp.id } });
    await prisma.employee.update({ where: { id: e.id }, data: { isLocked: false } });
    const hTok = await Z.mint(hr); const oTok = await Z.mint(other);
    const mg = await Z.call('GET', '/api/employees/management', hTok);
    Z.check('F1 HR may lock / unlock forms (the screen shows the buttons)', mg.status === 200 && mg.body.caps && mg.body.caps.configure === true, [mg.status, mg.body && mg.body.caps]);
    const bad = await Z.call('PATCH', `/api/employees/${e.id}/toggle-lock`, oTok, {});
    Z.check('F2 an ordinary employee cannot lock somebody\'s form (403)', bad.status === 403, bad.status);
    const l = await Z.call('PATCH', `/api/employees/${e.id}/toggle-lock`, hTok, {});
    const a = await prisma.employee.findUnique({ where: { id: e.id } });
    Z.check('F3 HR locks the employee form', l.status === 200 && a.isLocked === true, [l.status, a.isLocked]);
    const u = await Z.call('PATCH', `/api/employees/${e.id}/toggle-lock`, hTok, { hours: 24, reason: 'ZZTEST FLK fix the address' });
    const b = await prisma.employee.findUnique({ where: { id: e.id } });
    const hrs = b.unlockExpiresAt ? (new Date(b.unlockExpiresAt) - Date.now()) / 3600000 : 0;
    Z.check('F4 HR unlocks it for 24 hours', u.status === 200 && b.isLocked === false && hrs > 23 && hrs <= 24.1, [u.status, b.isLocked, hrs]);
    const aud = await prisma.auditLog.count({ where: { entityId: e.id, action: { in: ['Profile locked by HR', 'Profile unlocked by HR for 24h'] } } });
    Z.check('F5 both are written down with who did it', aud === 2, aud);
  } catch (err) { Z.fail += 1; console.log('FAIL  crashed', err && err.stack ? err.stack.slice(0, 900) : err); } finally {
    await Z.cleanup([(p) => p.auditLog.deleteMany({ where: { reason: { contains: 'ZZTEST FLK' } } })]).catch((err) => console.log('cleanup problem', String(err.message).slice(0, 160)));
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();
