#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ADMIN VASU COUNTS AS AN EMPLOYEE (founder, 2026-10-23): headcount, daily attendance, own attendance visible to the Admin, leave, payroll.
// SANDBOX ONLY.  cd backend && npm run sandbox -- --restart --detach --no-watch && TL_API=http://localhost:4011 node scripts/super-admin-counts-test.js
// A Super Admin login WITH an employee record is in the employee lists / rolls; the ROLE stays a system role for security (nobody can be "viewed as" a
// Super Admin; a Super Admin role cannot be given through an employee import).
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('SAC');
const path = require('path');

(async () => {
  try {
    const SA = require(path.join(Z.BACK, 'src/utils/systemAccounts'));
    const { prisma } = Z;
    Z.check('A1 the founder counts as an employee by default', SA.COUNTS_AS_EMPLOYEE === true && SA.EXCLUDED_ROLES.length === 0, [SA.COUNTS_AS_EMPLOYEE, SA.EXCLUDED_ROLES]);

    const sa = await Z.mkUser('sa', { role: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', accountsRole: 'SUPER_ADMIN', hrmsAccess: true, atsAccess: true, accountsAccess: true }, { designation: 'Founder' });
    const emp = await prisma.employee.findFirst({ where: { userId: sa.id } });
    const admin = await Z.mkUser('adm', { role: 'ADMIN', hrmsRole: 'ADMIN', atsRole: 'ADMIN', hrmsAccess: true });
    const aTok = await Z.mint(admin); const sTok = await Z.mint(sa);

    // ---- the lists and rolls -----------------------------------------------------------------------------------------------------------
    const inFilter = await prisma.employee.count({ where: SA.withoutSystemAccounts({ id: emp.id }) });
    Z.check('B1 the Super Admin employee passes the "not a system account" filter every list, roll and headcount uses', inFilter === 1, inFilter);
    const ids = await SA.systemEmployeeIds();
    Z.check('B2 and is not in the set of employees to leave out', !ids.has(emp.id), [...ids].length);
    const list = (await Z.call('GET', '/api/employees/management', aTok)).body;
    Z.check('B3 Employee Management lists the founder (headcount)', !!((list && list.rows) || []).find((r) => r.id === emp.id), (list && list.rows || []).length);
    Z.check('B4 the attendance roll of an Admin includes the founder', (await (async () => {
      const day = new Date().toISOString().slice(0, 10);
      const r = await Z.call('GET', `/api/attendance/report?from=${day}&to=${day}`, aTok);
      return JSON.stringify(r.body || {}).includes(emp.id) || JSON.stringify(r.body || {}).includes(emp.name);
    })()), 'not in the report');

    // ---- own attendance and requests are open to the founder ---------------------------------------------------------------------
    const sys = await SA.systemRequesterError(emp, 'leave');
    Z.check('C1 the founder may raise leave / regularization (no "system account" refusal)', sys === null, sys);
    const mine = await Z.call('GET', '/api/attendance?mine=1', sTok);
    Z.check('C2 the founder reads own attendance (200)', mine.status === 200, mine.status);

    // ---- what must NOT change: the security uses of the role -------------------------------------------------------------------------
    Z.check('D1 the ROLE test still says Super Admin is a system account (view-as, imports)', SA.isStrictSystemAccount({ role: 'SUPER_ADMIN' }) === true && SA.isStrictSystemAccount({ role: 'ADMIN' }) === false && SA.SYSTEM_ACCOUNT_ROLES.includes('SUPER_ADMIN'));
    const sa2 = await Z.mkUser('sa2', { role: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', hrmsAccess: true });
    const va = await Z.call('POST', `/api/admin/view-as/${sa2.id}`, sTok, {});
    Z.check('D2 a Super Admin still cannot "view as" another Super Admin (403)', va.status === 403 && /Super Admin login cannot be viewed as/.test(JSON.stringify(va.body || {})), [va.status, va.body]);
  } catch (e) { Z.fail += 1; console.log('FAIL  crashed', e && e.stack ? e.stack.slice(0, 700) : e); } finally {
    await Z.cleanup().catch((e) => console.log('cleanup problem', String(e.message).slice(0, 160)));
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();
