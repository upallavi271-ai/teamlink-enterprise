#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ASSETS VENDOR PORTAL - STAGE B (master prompt 27 Oct 2026, §B6.7). SANDBOX ONLY.
//   cd backend && npm run sandbox -- --restart --detach --no-watch && TL_API=http://localhost:4011 node scripts/asset-vendor-portal-stageb-test.js
// Proves: exactly four modules (server, /me, screen) and the old Orders / Repair History addresses redirect; every asset of the vendor shows
// once, WITH the ones employees hold, never a SIM card; the row and the detail say who has it (name, employee ID, designation, department)
// or "Unassigned"; an HRMS reassignment A -> B shows B now and A in the history on the vendor's next request (no copy, no sync job); the
// 227 reconciliation counts HRMS, SIM cards (Airtel portal), what the vendor sees and why the rest is not shown; no e-mail / phone leaks.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const Z = require('./lib/zzfix')('AVB');

const bcrypt = require(path.join(Z.BACK, 'node_modules/bcryptjs'));

(async () => {
  const { prisma } = Z;
  const made = { assets: [], vendors: [] };
  const raw = (sql, ...p) => prisma.$queryRawUnsafe(sql, ...p);
  try {
    const sa = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN', status: 'Active', employee: { isNot: null } } });
    const S = await Z.mint(sa);
    // two employees (A and B) in HRMS
    const ua = await Z.mkUser('a', { role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true }, { designation: 'Employee', department: 'Education', employeeCode: `ZZAVB-A-${Z.RUN}` });
    const ub = await Z.mkUser('b', { role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true }, { designation: 'TL', department: 'Medical', employeeCode: `ZZAVB-B-${Z.RUN}` });
    const ea = await prisma.employee.findFirst({ where: { userId: ua.id } });
    const eb = await prisma.employee.findFirst({ where: { userId: ub.id } });
    // the vendor: "Other" category with the Assets module ticked = an Assets portal vendor (no automatic category rule, so no clash with real vendors)
    const v = await prisma.officeVendor.create({ data: { name: `ZZTEST AVB Vendor ${Z.RUN}`, companyName: `ZZTEST AVB Co ${Z.RUN}`, isActive: true, category: 'Other' } });
    made.vendors.push(v.id);
    const pw = `Zz!${Z.RUN}avb9`;
    const vu = await prisma.vendorUser.create({ data: { vendorId: v.id, name: 'ZZTEST AVB contact', email: `zz-avb-${Z.RUN}@example.test`, passwordHash: bcrypt.hashSync(pw, 10), status: 'Active', mustChangePassword: false, passwordChangedAt: new Date(), canEdit: true, canViewCost: false } });
    const now = Date.now();
    await raw('INSERT INTO "VendorLoginModule" ("id","vendorUserId","moduleKey","permissionsJson","createdAt","updatedAt") VALUES (?,?,?,?,?,?)', `zzavb${vu.id}`.slice(0, 40), vu.id, 'assets', '{}', now, now);
    const mk = async (tag, data) => { const a = await prisma.asset.create({ data: { assetCode: `ZZAVB-${Z.RUN}-${tag}`, name: `ZZTEST AVB ${tag}`, ...data } }); made.assets.push(a.id); return a; };
    const free = await mk('free', { category: 'Laptop', status: 'Available', serialNumber: `SN-AVB-${Z.RUN}` });
    const held = await mk('held', { category: 'Mouse', status: 'Assigned', assignedToId: ea.id, assignedAt: new Date('2026-10-01T05:00:00Z'), assignedByName: 'ZZTEST HR' });
    const sim = await mk('sim', { category: 'SIM Card', status: 'Available' });
    const grant = await Z.call('PUT', `/api/vendor-logins/asset-grants/${v.id}`, S, { assetIds: [free.id, held.id, sim.id], categories: [] });
    const login = await Z.call('POST', '/api/vendor-portal/login', null, { email: vu.email, password: pw });
    const V = login.body && login.body.token;
    Z.check('F0 fixture: Admin grants three assets and the vendor signs in', grant.status === 200 && !!V, [grant.status, grant.body && grant.body.error, login.status]);
    const VP = (p) => Z.call('GET', `/api/vendor-portal${p}`, V);

    // 1-2. four modules, old addresses redirect
    const me = await VP('/me');
    const CFG = require(path.join(Z.BACK, 'src/config/vendorModules'));
    Z.check('B1 exactly four modules: Dashboard, Assets, Repairs & HRMS Tickets, Invoices & Payments (server and /me)', me.body.kind === 'assets' && me.body.nav.map((n) => n.label).join() === 'Dashboard,Assets,Repairs & HRMS Tickets,Invoices & Payments' && CFG.ASSET_PORTAL_NAV.length === 4, me.body.nav);
    const app = fs.readFileSync(path.join(Z.BACK, '..', 'frontend/src/App.jsx'), 'utf8');
    Z.check('B2 the old Orders and Repair History addresses redirect to their tab (no 404, no dashboard bounce)', /asset-portal\/orders" element=\{<Navigate to="\/vendor\/asset-portal\/invoices\?tab=orders"/.test(app) && /asset-portal\/history" element=\{<Navigate to="\/vendor\/asset-portal\/repairs\?tab=history"/.test(app));

    // 3-6. every asset once, held ones too, never a SIM; who has it
    const all = await VP('/asset-portal/assets?view=all&pageSize=100');
    const ids = (all.body.rows || []).map((r) => r.id);
    Z.check('B3 every granted asset shows once - the one an employee holds too - and the SIM card never', ids.includes(free.id) && ids.includes(held.id) && !ids.includes(sim.id) && new Set(ids).size === ids.length, ids);
    const rowHeld = all.body.rows.find((r) => r.id === held.id); const rowFree = all.body.rows.find((r) => r.id === free.id);
    Z.check('B4 the held asset says who has it: name, employee ID, designation, department, since when', rowHeld && rowHeld.assignment === 'Assigned' && rowHeld.holder && rowHeld.holder.name === ea.name && rowHeld.holder.employeeCode === ea.employeeCode && rowHeld.holder.designation === 'Employee' && rowHeld.holder.department === 'Education' && /^2026-10-01/.test(rowHeld.assignedAt || ''), rowHeld);
    Z.check('B5 the free asset says Unassigned (no person)', rowFree && rowFree.assignment === 'Unassigned' && rowFree.holder === null, rowFree);
    Z.check('B6 tabs: All / With employees / In stock / Under repair are counted', all.body.tabs && all.body.tabs.all === 2 && all.body.tabs.assigned === 1 && all.body.tabs.available === 1, all.body.tabs);
    const byName = await VP(`/asset-portal/assets?view=all&q=${encodeURIComponent(ea.employeeCode)}`);
    Z.check('B7 search by employee ID finds the asset that person holds', byName.body.rows.length === 1 && byName.body.rows[0].id === held.id, byName.body.rows.map((r) => r.assetCode));
    const byDept = await VP('/asset-portal/assets?view=all&department=Education');
    Z.check('B8 filter by department', byDept.body.rows.every((r) => (r.holder && r.holder.department) === 'Education' || r.department === 'Education') && byDept.body.rows.some((r) => r.id === held.id), byDept.body.rows.map((r) => r.assetCode));
    const simOpen = await VP(`/asset-portal/assets/${sim.id}`);
    Z.check('B9 the SIM card cannot be opened in the Assets portal (it lives in the Airtel Bills portal)', simOpen.status === 403 || simOpen.status === 404, simOpen.status);

    // 7-8. an HRMS reassignment A -> B, live
    const r1 = await Z.call('PATCH', `/api/asset-inventory/${free.id}/assign`, S, { employeeId: ea.id });
    const r2 = await Z.call('PATCH', `/api/asset-inventory/${free.id}/return`, S, { note: 'ZZTEST AVB' }).catch(() => ({ status: 0 }));
    const r3 = await Z.call('PATCH', `/api/asset-inventory/${free.id}/assign`, S, { employeeId: eb.id });
    const det = await VP(`/asset-portal/assets/${free.id}`);
    const hist = (det.body.assignment && det.body.assignment.history) || [];
    Z.check('B10 HRMS assigns it to A and then to B: on the vendor\'s next request B is the holder', [200, 201].includes(r1.status) && [200, 201].includes(r3.status) && det.status === 200 && det.body.assignment.current && det.body.assignment.current.name === eb.name && det.body.assignment.current.designation === 'TL', [r1.status, r2.status, r3.status, det.body.assignment && det.body.assignment.current]);
    Z.check('B11 A stays in the assignment history (oldest first, with dates); nothing is invented', hist.some((h) => h.text.includes(ea.name)) && hist.some((h) => h.text.includes(eb.name)) && hist.findIndex((h) => h.text.includes(ea.name)) < hist.findIndex((h) => h.text.includes(eb.name)) && hist.every((h) => !!h.at), hist);
    const leak = JSON.stringify([all.body, det.body]);
    Z.check('B12 no e-mail address or phone number of an employee reaches the vendor', !leak.includes(ua.email) && !leak.includes(ub.email) && !/"phone"/.test(leak), 'leak');

    // the 227 reconciliation (Admin)
    const rec = await Z.call('GET', `/api/vendor-logins/asset-grants/${v.id}/reconciliation`, S);
    const dbTotal = await prisma.asset.count();
    const dbSims = await prisma.asset.count({ where: { category: { contains: 'SIM' } } });
    Z.check('B13 reconciliation: HRMS total = the database count, expected 227 and the difference, SIM cards counted for the Airtel portal', rec.status === 200 && rec.body.hrmsTotal === dbTotal && rec.body.expected === 227 && rec.body.differenceFromExpected === dbTotal - 227 && rec.body.simCards === dbSims && rec.body.hardware === dbTotal - dbSims, [rec.status, rec.body.hrmsTotal, dbTotal, rec.body.simCards, dbSims]);
    Z.check('B14 reconciliation: what this vendor sees = the portal list (2, with employees 2 after the reassignment), every HRMS record listed with a reason when not shown', rec.body.vendorVisible === 2 && rec.body.visible.assigned === 2 && rec.body.records.length === dbTotal && rec.body.records.filter((x) => !x.inPortal).every((x) => !!x.reason) && rec.body.records.find((x) => x.id === sim.id).reason.includes('Airtel'), [rec.body.vendorVisible, rec.body.visible]);
    const recNo = await Z.call('GET', `/api/vendor-logins/asset-grants/${v.id}/reconciliation`, await Z.mint(ua));
    Z.check('B15 an employee cannot read the reconciliation (403)', recNo.status === 403, recNo.status);
  } catch (err) { Z.fail += 1; console.log('FAIL  crashed', err && err.stack ? err.stack.slice(0, 900) : err); } finally {
    try {
      const inList = (a) => a.map(() => '?').join(',') || "''";
      await prisma.$executeRawUnsafe(`DELETE FROM "VendorAssetGrant" WHERE "vendorId" IN (${inList(made.vendors)})`, ...made.vendors).catch(() => {});
      await prisma.$executeRawUnsafe(`DELETE FROM "VendorLoginModule" WHERE "vendorUserId" IN (SELECT "id" FROM "VendorUser" WHERE "vendorId" IN (${inList(made.vendors)}))`, ...made.vendors).catch(() => {});
      await prisma.assetAuditLog.deleteMany({ where: { OR: [{ assetId: { in: made.assets } }, { vendorId: { in: made.vendors } }] } }).catch(() => {});
      await prisma.vendorSession.deleteMany({ where: { vendorUser: { vendorId: { in: made.vendors } } } }).catch(() => {});
      await prisma.vendorUser.deleteMany({ where: { vendorId: { in: made.vendors } } }).catch(() => {});
      await prisma.asset.deleteMany({ where: { id: { in: made.assets } } }).catch(() => {});
      await prisma.officeVendor.deleteMany({ where: { id: { in: made.vendors } } }).catch(() => {});
      await prisma.auditLog.deleteMany({ where: { entityId: { in: made.assets } } }).catch(() => {});
    } catch (e) { console.log('cleanup', String(e.message).slice(0, 160)); }
    await Z.cleanup().catch((e) => console.log('cleanup problem', String(e.message).slice(0, 160)));
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();
