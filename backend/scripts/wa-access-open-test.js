#!/usr/bin/env node
// WHO MAY SEND FROM A WHATSAPP NUMBER: no restrictions on the Admin's choice (founder, 2026-10-23). SANDBOX ONLY.
//   TL_API=http://localhost:4011 node scripts/wa-access-open-test.js
const Z = require('./lib/zzfix')('WAO');
(async () => {
  try {
    const { prisma } = Z;
    const admin = await Z.mkUser('adm', { role: 'ADMIN', hrmsRole: 'ADMIN', atsRole: 'ADMIN', hrmsAccess: true });
    const tok = await Z.mint(admin);
    const ts = Date.now().toString().slice(-9);
    const made = await Z.call('POST', '/api/wa-numbers', tok, { label: `ZZTEST WAO ${Z.RUN}`, displayNumber: `+9196${ts}`, phoneNumberId: `${ts}0001`, tokenMode: 'own', token: `ZZTESTTOKEN-${Z.RUN}-${'x'.repeat(30)}`, check: false });
    const id = made.body && made.body.id;
    Z.check('0 a test number is added', !!id, [made.status, made.body && made.body.error]);
    const deps = (await Z.call('GET', '/api/wa-numbers/departments', tok)).body.departments.map((d) => d.name);
    Z.check('A1 the picker lists every department, IT and Recruitment included', ['IT', 'Recruitment', 'HR', 'Medical'].every((n) => deps.includes(n)), deps);
    let r = await Z.call('PUT', `/api/wa-numbers/${id}/access`, tok, { departments: ['IT', 'HR', 'A Brand New Department'], userIds: [], roles: [] });
    Z.check('B1 "IT" and a department that is not on any list are accepted (no "is not a department")', r.status === 200, [r.status, r.body && r.body.error]);
    r = await Z.call('PUT', `/api/wa-numbers/${id}/access`, tok, { departments: ['IT'], userIds: ['a-person-who-is-gone'], roles: ['ADMIN', 'SOMETHING_ELSE'] });
    Z.check('B2 a stale person and any role are not refused: the rest is saved', r.status === 200, [r.status, r.body && r.body.error]);
    const rows = await prisma.$queryRawUnsafe('SELECT "kind","refId" FROM "WaNumberAccess" WHERE "numberId" = ?', id);
    Z.check('B3 what was ticked is what is saved (IT department, two roles)', rows.some((x) => x.kind === 'DEPARTMENT' && x.refId === 'IT') && rows.filter((x) => x.kind === 'ROLE').length === 2, rows);
    const rec = await Z.mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' });
    r = await Z.call('PUT', `/api/wa-numbers/${id}/access`, await Z.mint(rec), { departments: ['IT'] });
    Z.check('C1 only an Admin can change it (a recruiter is refused)', [401, 403].includes(r.status), r.status);
    await prisma.$executeRawUnsafe('DELETE FROM "WaNumberAccess" WHERE "numberId" = ?', id).catch(() => {});
    await prisma.$executeRawUnsafe('DELETE FROM "WaNumber" WHERE "id" = ?', id).catch(() => {});
    await prisma.appSetting.delete({ where: { key: `wa.num.sec.${id}` } }).catch(() => {});
  } catch (e) { Z.fail += 1; console.log('FAIL  crashed', e && e.stack ? e.stack.slice(0, 600) : e); } finally {
    await Z.prisma.$executeRawUnsafe('DELETE FROM "WaNumber" WHERE "label" LIKE ?', 'ZZTEST WAO %').catch(() => {});
    await Z.cleanup().catch((e) => console.log('cleanup problem', String(e.message).slice(0, 160)));
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();
