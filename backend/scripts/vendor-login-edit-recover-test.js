#!/usr/bin/env node
// ---------------------------------------------------------------------------
// "Vendor login not found." when changing the email of a vendor who has NOT activated yet (founder, 2026-10-23). SANDBOX ONLY.
//   cd backend && npm run sandbox -- --restart --detach --no-watch && TL_API=http://localhost:4011 node scripts/vendor-login-edit-recover-test.js
// A stale id is recovered through the vendor + the login name (only when exactly one login matches); every other miss says which cause it is.
// Mail is never really sent (the sandbox records it); no real vendor is touched.
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('VLR');
const bcrypt = require('bcryptjs');

(async () => {
  try {
    const { prisma } = Z;
    const admin = await Z.mkUser('admin', { role: 'ADMIN', hrmsRole: 'ADMIN', atsRole: 'ADMIN', accountsRole: 'ADMIN', hrmsAccess: true, accountsAccess: true });
    const tok = await Z.mint(admin);
    const mkVendor = (tag) => prisma.officeVendor.create({ data: { name: `ZZTEST VLR Vendor ${tag} ${Z.RUN}`, companyName: `ZZTEST VLR Company ${tag} ${Z.RUN}`, isActive: true, category: 'Internet' } });
    const v1 = await mkVendor('one'); const vNone = await mkVendor('none'); const v2 = await mkVendor('two');
    const login = (vendorId, name, email) => prisma.vendorUser.create({ data: { vendorId, name, email, passwordHash: bcrypt.hashSync('Zz-temp-1234', 10), status: 'Active', mustChangePassword: true } });
    const nameA = `ZZTEST 90${Z.RUN.slice(-8)}`;
    const a = await login(v1.id, nameA, `zz-vlr-a-${Z.RUN}@example.test`);
    const patch = (id, body) => Z.call('PATCH', `/api/vendor-logins/${id}`, tok, body, { 'Idempotency-Key': `vlr-${Math.random().toString(36).slice(2)}` });

    // 1. the normal case: not activated, right id -> the email moves, a new invitation is made
    let r = await patch(a.id, { email: `zz-vlr-b-${Z.RUN}@example.test`, vendorId: v1.id, loginName: nameA });
    let row = await prisma.vendorUser.findUnique({ where: { id: a.id } });
    Z.check('A1 a vendor that has not activated: the login email changes (200)', r.status === 200 && row.email === `zz-vlr-b-${Z.RUN}@example.test`, [r.status, r.body && r.body.error]);
    Z.check('A2 the vendor, name and id stay the same', row.vendorId === v1.id && row.name === nameA && row.id === a.id);

    // 2. a STALE id (the screen holds an id that no longer exists) + the vendor and name -> found through those
    r = await patch('cm-stale-id-that-does-not-exist', { email: `zz-vlr-c-${Z.RUN}@example.test`, vendorId: v1.id, loginName: nameA });
    row = await prisma.vendorUser.findUnique({ where: { id: a.id } });
    Z.check('B1 a stale id with the vendor + name: the right login is found and changed', r.status === 200 && row.email === `zz-vlr-c-${Z.RUN}@example.test`, [r.status, r.body && r.body.error]);

    // 3. each miss names its cause
    r = await patch('cm-nothing-known', { email: `zz-vlr-d-${Z.RUN}@example.test` });
    Z.check('C1 an unknown id and nothing else: "not on this server", code LOGIN_NOT_FOUND', r.status === 404 && r.body.code === 'LOGIN_NOT_FOUND' && !/^Vendor login not found\.$/.test(r.body.error), r.body);
    r = await patch('cm-nothing-known', { email: `zz-vlr-d-${Z.RUN}@example.test`, vendorId: 'no-such-vendor' });
    Z.check('C2 a vendor that is gone: VENDOR_NOT_FOUND', r.status === 404 && r.body.code === 'VENDOR_NOT_FOUND', r.body);
    r = await patch('cm-nothing-known', { email: `zz-vlr-d-${Z.RUN}@example.test`, vendorId: vNone.id });
    Z.check('C3 a vendor with no login: NO_LOGIN_FOR_VENDOR, says to create one', r.status === 404 && r.body.code === 'NO_LOGIN_FOR_VENDOR' && /Add login/.test(r.body.error), r.body);
    await login(v2.id, 'ZZTEST same name', `zz-vlr-e1-${Z.RUN}@example.test`); await login(v2.id, 'ZZTEST same name', `zz-vlr-e2-${Z.RUN}@example.test`);
    r = await patch('cm-nothing-known', { email: `zz-vlr-f-${Z.RUN}@example.test`, vendorId: v2.id, loginName: 'ZZTEST same name' });
    Z.check('C4 two logins with the same name: never guesses, MORE_THAN_ONE_LOGIN', r.status === 409 && r.body.code === 'MORE_THAN_ONE_LOGIN', r.body);

    // 4. rules that must still hold
    r = await patch(a.id, { email: `zz-vlr-e1-${Z.RUN}@example.test`, vendorId: v1.id });
    Z.check('D1 an email another login uses is refused (400)', r.status === 400, [r.status, r.body && r.body.error]);
    r = await patch(a.id, { email: 'not-an-email', vendorId: v1.id });
    Z.check('D2 a bad email is refused (400)', r.status === 400, r.status);
    const rec = await Z.mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' });
    r = await Z.call('PATCH', `/api/vendor-logins/${a.id}`, await Z.mint(rec), { email: `zz-vlr-g-${Z.RUN}@example.test` });
    Z.check('D3 a non-admin cannot change a vendor login email (401/403)', [401, 403].includes(r.status), r.status);
    Z.check('D4 no token or password is in any answer', !/tempPassword|passwordHash|\$2[aby]\$/.test(JSON.stringify(r.body || {})));
  } catch (e) { Z.fail += 1; console.log('FAIL  crashed', e && e.stack ? e.stack.slice(0, 700) : e); } finally {
    try {
      const { prisma } = Z;
      const vs = await prisma.officeVendor.findMany({ where: { name: { contains: `ZZTEST VLR` } }, select: { id: true } });
      const ids = vs.map((v) => v.id);
      const us = await prisma.vendorUser.findMany({ where: { vendorId: { in: ids } }, select: { id: true } });
      const uids = us.map((u) => u.id);
      for (const t of ['vendorLoginToken', 'vendorSession']) { try { await prisma[t].deleteMany({ where: { vendorUserId: { in: uids } } }); } catch { /* table or model absent */ } }
      await prisma.$executeRawUnsafe(`DELETE FROM "VendorMailLog" WHERE "vendorUserId" IN (${uids.map(() => '?').join(',') || "''"})`, ...uids).catch(() => {});
      await prisma.$executeRawUnsafe(`DELETE FROM "VendorEmailChange" WHERE "vendorUserId" IN (${uids.map(() => '?').join(',') || "''"})`, ...uids).catch(() => {});
      await prisma.assetAuditLog.deleteMany({ where: { vendorUserId: { in: uids } } }).catch(() => {});
      await prisma.vendorUser.deleteMany({ where: { id: { in: uids } } }).catch((e) => console.log('vu cleanup', String(e.message).slice(-120)));
      await prisma.officeVendor.deleteMany({ where: { id: { in: ids } } }).catch((e) => console.log('vendor cleanup', String(e.message).slice(-120)));
    } catch (e) { console.log('cleanup problem', String(e.message).slice(0, 160)); }
    await Z.cleanup().catch((e) => console.log('cleanup problem', String(e.message).slice(0, 160)));
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();
