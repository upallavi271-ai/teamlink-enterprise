#!/usr/bin/env node
// ---------------------------------------------------------------------------
// "No employee record is linked to this login" on My Attendance (founder, 2026-10-23). SANDBOX ONLY.
//   cd backend && npm run sandbox -- --restart --detach --no-watch && TL_API=http://localhost:4011 node scripts/own-employee-link-test.js
// A login with no Employee.userId link finds its employee by the SAME e-mail (exactly one, not linked elsewhere), links it once, audited.
// Never by name; two matches or an employee already linked to another login are left alone with a clear message.
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('OEL');

(async () => {
  try {
    const { prisma } = Z;
    const OE = require(require('path').join(Z.BACK, 'src/utils/ownEmployee'));
    const day = new Date().toISOString().slice(0, 10);
    const mkEmp = (tag, email, userId = null) => prisma.employee.create({ data: { employeeCode: `ZZTEST-OEL-${tag}-${Z.RUN}`.slice(0, 40), name: `ZZTEST OEL ${tag} ${Z.RUN}`, email, userId, designation: 'Employee', employmentStatus: 'Active', department: 'HR' } }).then((e) => { Z.made.emps.push(e.id); return e; });

    // 1. no link, one employee with the same e-mail (different letter case) -> linked
    const u1 = await Z.mkUser('one', { role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true });
    const e1 = await mkEmp('one', u1.email.toUpperCase());
    const t1 = await Z.mint(u1);
    let r = await Z.call('GET', '/api/attendance?mine=1', t1);
    const after = await prisma.employee.findUnique({ where: { id: e1.id } });
    Z.check('A1 My Attendance answers 200 for a login with no link but the same e-mail', r.status === 200, [r.status, r.body && r.body.error]);
    Z.check('A2 the employee is now linked to that login (once, for good)', after.userId === u1.id, after.userId);
    const aud = await prisma.auditLog.count({ where: { entity: 'Employee', entityId: e1.id, action: { contains: 'linked to its employee' } } });
    Z.check('A3 the link is on the audit trail', aud === 1, aud);
    r = await Z.call('GET', '/api/attendance?mine=1', t1);
    Z.check('A4 asking again changes nothing (still one audit row)', r.status === 200 && (await prisma.auditLog.count({ where: { entity: 'Employee', entityId: e1.id, action: { contains: 'linked to its employee' } } })) === 1);

    // 2. nothing to match -> the clear message, no guessing by name
    const u2 = await Z.mkUser('two', { role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true });
    await prisma.employee.create({ data: { employeeCode: `ZZTEST-OEL-two-${Z.RUN}`.slice(0, 40), name: u2.name, email: `other-${Z.RUN}@example.test`, designation: 'Employee', employmentStatus: 'Active', department: 'HR' } }).then((e) => Z.made.emps.push(e.id));
    Z.check('B1 same NAME, different e-mail: not linked (never guesses by name)', (await OE.ownEmployeeOf(u2)) === null);
    const t2 = await Z.mint(u2);
    r = await Z.call('POST', '/api/attendance/punches', t2, { direction: 'in' });
    Z.check('B2 the message says what to do (ask HR to link it)', /ask HR to link/i.test(JSON.stringify(r.body || {})) || r.status !== 404, [r.status, r.body]);

    // 3. two employees with the same e-mail -> left alone
    const u3 = await Z.mkUser('three', { role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true });
    await mkEmp('three-a', u3.email); await mkEmp('three-b', u3.email);
    Z.check('C1 two employees with this e-mail: nothing is linked', (await OE.ownEmployeeOf(u3)) === null);

    // 4. the employee already belongs to ANOTHER login -> not taken over
    const u4 = await Z.mkUser('four', { role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true });
    const owner = await Z.mkUser('owner', { role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true });
    const e4 = await mkEmp('four', u4.email, owner.id);
    Z.check('D1 an employee linked to another login is never taken over', (await OE.ownEmployeeOf(u4)) === null && (await prisma.employee.findUnique({ where: { id: e4.id } })).userId === owner.id);

    // 5. a login with no e-mail match at all and an already linked login still work
    Z.check('E1 an already linked login still resolves to its own employee', (await OE.ownEmployeeOf(owner)).id === e4.id);
    Z.check('E2 null user is safe', (await OE.ownEmployeeOf(null)) === null);
    void day;
  } catch (e) { Z.fail += 1; console.log('FAIL  crashed', e && e.stack ? e.stack.slice(0, 700) : e); } finally {
    try { await Z.prisma.auditLog.deleteMany({ where: { entity: 'Employee', action: { contains: 'linked to its employee' }, toValue: { contains: 'example.test' } } }); } catch { /* ignore */ }
    await Z.cleanup().catch((e) => console.log('cleanup problem', String(e.message).slice(0, 160)));
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();
