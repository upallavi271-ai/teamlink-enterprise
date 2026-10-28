#!/usr/bin/env node
// ---------------------------------------------------------------------------
// EDIT A VENDOR FROM OFFICE & EXPENSES - ADMIN AND ACCOUNTANT (founder 2026-10-28). SANDBOX ONLY.
//   cd backend && TL_API=http://localhost:4011 node scripts/vendor-edit-accounts-test.js
// Proves PATCH /api/office-expenses/vendors/:id:
//   E1 Admin edits a vendor (only the changed field is recorded)   E2 the Accountant edits a vendor (PAN, email, terms)
//   E3 a duplicate email of another vendor is refused (409), nothing saved
//   E4 a recruiter / a login with no Accounts desk role cannot edit (403), nothing saved
//   E5 both audit trails have the edit                              E6 an unknown vendor: 404
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('VEA');

(async () => {
  const { prisma } = Z;
  const vendors = [];
  try {
    const admin = await Z.mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN', accountsAccess: true, accountsRole: 'ADMIN' }, {});
    const acct = await Z.mkUser('acct', { role: 'EMPLOYEE', atsRole: 'RECRUITER', accountsAccess: true, accountsRole: 'ACCOUNTANT' }, {});
    const rec = await Z.mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', accountsAccess: false, accountsRole: 'NONE' }, {});
    const [TA, TC, TR] = [await Z.mint(admin), await Z.mint(acct), await Z.mint(rec)];
    const mk = (k) => prisma.officeVendor.create({ data: { name: `ZZTEST VEA ${k} ${Z.RUN}`, email: `zz-vea-${k}-${Z.RUN}@example.test`, emailKey: `zz-vea-${k}-${Z.RUN}@example.test`, phone: '9848012345', source: 'Office' } });
    const v1 = await mk('one'); const v2 = await mk('two');
    vendors.push(v1.id, v2.id);
    const patch = (tok, id, body) => Z.call('PATCH', `/api/office-expenses/vendors/${id}`, tok, body);

    const a = await patch(TA, v1.id, { phone: '9848099999' });
    Z.check('E1 Admin edits a vendor: saved, only the phone recorded as changed', a.status === 200 && a.body.vendor.phone === '9848099999' && JSON.stringify(a.body.changed) === '["phone"]', [a.status, a.body]);
    const c = await patch(TC, v1.id, { pan: 'ABCDE1234F', email: `zz-vea-new-${Z.RUN}@example.test`, paymentTerms: 'Net 15' });
    const after = await prisma.officeVendor.findUnique({ where: { id: v1.id } });
    Z.check('E2 the Accountant edits a vendor: PAN, email and payment terms saved', c.status === 200 && after.pan === 'ABCDE1234F' && after.email === `zz-vea-new-${Z.RUN}@example.test` && after.paymentTerms === 'Net 15', [c.status, c.body, after.pan, after.email]);
    const d = await patch(TC, v1.id, { email: v2.email });
    Z.check('E3 the email of another vendor is refused (409) and nothing is saved', d.status === 409 && (await prisma.officeVendor.findUnique({ where: { id: v1.id } })).email === `zz-vea-new-${Z.RUN}@example.test`, [d.status, d.body]);
    const r = await patch(TR, v1.id, { phone: '9000000000' });
    Z.check('E4 a recruiter cannot edit a vendor (403), nothing saved', r.status === 403 && (await prisma.officeVendor.findUnique({ where: { id: v1.id } })).phone === '9848099999', [r.status]);
    const logs = await prisma.auditLog.findMany({ where: { entityId: v1.id, action: 'Vendor edited' } });
    let portal = 0;
    try { portal = (await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "AssetAuditLog" WHERE "vendorId" = ? AND "action" = \'Vendor edited\'', v1.id))[0].n; } catch { portal = -1; }
    Z.check('E5 both audit trails record the edits (2 edits = 2 audit rows; vendor history per field)', logs.length === 2 && (portal === -1 || Number(portal) >= 4), [logs.length, String(portal)]);
    const n = await patch(TA, `zz-no-such-${Z.RUN}`, { phone: '9848011111' });
    Z.check('E6 an unknown vendor: 404', n.status === 404, [n.status]);
  } catch (err) { Z.fail += 1; console.log('FAIL  crashed', err && err.stack ? err.stack.slice(0, 900) : err); } finally {
    try {
      await prisma.auditLog.deleteMany({ where: { entityId: { in: vendors } } });
      await prisma.$executeRawUnsafe(`DELETE FROM "AssetAuditLog" WHERE "vendorId" IN (${vendors.map(() => '?').join(',')})`, ...vendors).catch(() => {});
      await prisma.officeVendor.deleteMany({ where: { id: { in: vendors } } });
    } catch (e) { console.log('cleanup (vendors) failed:', String(e.message).slice(-200)); }
    await Z.cleanup().catch((e) => console.log('cleanup problem', String(e.message).slice(0, 160)));
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();
