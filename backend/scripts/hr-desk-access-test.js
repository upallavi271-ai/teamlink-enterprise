#!/usr/bin/env node
// ---------------------------------------------------------------------------
// HR DESK ACCESS (founder, 2026-10-24): (1) HR holds LOCK / UNLOCK and the other employee-record actions; (2) WhatsApp to EMPLOYEES from HRMS is for the
// Super Admin / Admin and HR only. SANDBOX ONLY.
//   cd backend && npm run sandbox -- --restart --detach --no-watch && TL_API=http://localhost:4011 node scripts/hr-desk-access-test.js
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('HRD');

(async () => {
  try {
    const { prisma } = Z;
    const hr = await Z.mkUser('hr', { role: 'EMPLOYEE', hrmsRole: 'HR', hrmsAccess: true, atsRole: 'NONE', atsAccess: false }, { designation: 'HR Executive', department: 'HR' });
    const tl = await Z.mkUser('tl', { role: 'TL', hrmsRole: 'TL', hrmsAccess: true, atsRole: 'TL', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' }, { designation: 'TL', department: 'Medical' });
    const adm = await Z.mkUser('adm', { role: 'ADMIN', hrmsRole: 'ADMIN', atsRole: 'ADMIN', hrmsAccess: true }, { designation: 'Admin', department: 'Admin' });
    const worker = await Z.mkUser('worker', { role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true }, { designation: 'Executive', department: 'Medical' });
    const wEmp = await prisma.employee.findFirst({ where: { userId: worker.id } });
    await prisma.employee.update({ where: { id: wEmp.id }, data: { phone: '9876543210', email: `zz-hrd-worker-${Z.RUN}@example.test` } });
    const hrEmp = await prisma.employee.findFirst({ where: { userId: hr.id } });
    const hTok = await Z.mint(hr); const tTok = await Z.mint(tl); const aTok = await Z.mint(adm);

    // ---- 1. lock / unlock and the other record actions --------------------------------------------------------------------------------
    const list = await Z.call('GET', '/api/employees/management', hTok);
    Z.check('A0 HR reads Employee Management', list.status === 200, list.status);
    Z.check('A1 HR holds the configure + assign rights (the buttons are drawn)', list.body && list.body.caps && list.body.caps.configure === true && list.body.caps.assign === true, list.body && list.body.caps);
    const before = await prisma.employee.findUnique({ where: { id: wEmp.id } });
    const t1 = await Z.call('PATCH', `/api/employees/${wEmp.id}/toggle-lock`, hTok, { hours: 24, reason: 'ZZTEST HRD' });
    const mid = await prisma.employee.findUnique({ where: { id: wEmp.id } });
    const t2 = await Z.call('PATCH', `/api/employees/${wEmp.id}/toggle-lock`, hTok, {});
    const after = await prisma.employee.findUnique({ where: { id: wEmp.id } });
    Z.check('B1 HR locks / unlocks a profile directly (200, the lock flips both ways)', t1.status === 200 && t2.status === 200 && mid.isLocked !== before.isLocked && after.isLocked !== mid.isLocked, [t1.status, t2.status, before.isLocked, mid.isLocked, after.isLocked]);
    const p1 = await Z.call('PATCH', `/api/employees/${wEmp.id}/toggle-pause`, hTok, {});
    Z.check('B2 HR pauses an employee record (200)', p1.status === 200, [p1.status, p1.text.slice(0, 150)]);
    await Z.call('PATCH', `/api/employees/${wEmp.id}/toggle-pause`, hTok, {});
    const tr = await Z.call('PATCH', `/api/employees/${wEmp.id}/toggle-lock`, tTok, {});
    Z.check('B3 a Team Lead still cannot lock / unlock (403)', tr.status === 403, tr.status);
    const del = await Z.call('DELETE', `/api/employees/${wEmp.id}`, hTok);
    Z.check('B4 deleting an employee stays Super Admin / Admin only (HR gets 403)', del.status === 403, del.status);
    // privilege guards that came with the wider rights
    const own = await Z.call('PUT', `/api/employees/management/${hrEmp.id}/scope`, hTok, { atsScopeDepartments: 'Medical' });
    Z.check('B5 HR cannot widen its OWN access scope (403)', own.status === 403 && /own access scope/.test(own.text), [own.status, own.text.slice(0, 150)]);
    const link = await Z.call('PUT', `/api/employees/${wEmp.id}/link-user`, hTok, { userId: adm.id });
    Z.check('B6 HR cannot link an Admin login to an employee (403)', link.status === 403 || link.status === 409, [link.status, link.text.slice(0, 150)]);

    // ---- 2. WhatsApp to employees --------------------------------------------------------------------------------------------------------
    const body = { audience: 'employees', ids: [wEmp.id], channels: ['WhatsApp'], body: 'Hello {{name}}, office is closed tomorrow.' };
    const hp = await Z.call('POST', '/api/messaging/preview', hTok, body);
    Z.check('C1 HR may prepare a WhatsApp message to an employee (not refused as "Super Admin and HR only")', !/for the Super Admin and HR/.test(hp.text) && hp.status !== 403, [hp.status, hp.text.slice(0, 200)]);
    const ap = await Z.call('POST', '/api/messaging/preview', aTok, body);
    Z.check('C2 an Admin may too', !/for the Super Admin and HR/.test(ap.text) && ap.status !== 403, [ap.status, ap.text.slice(0, 200)]);
    const tp = await Z.call('POST', '/api/messaging/preview', tTok, body);
    Z.check('C3 a Team Lead is refused WhatsApp to employees (403)', tp.status === 403, [tp.status, tp.text.slice(0, 200)]);
    const wp = await Z.call('POST', '/api/messaging/preview', await Z.mint(worker), body);
    Z.check('C4 an ordinary employee is refused (403)', wp.status === 403, wp.status);
    const mail = await Z.call('POST', '/api/messaging/preview', tTok, { ...body, channels: ['Email'], subject: 'Hi' });
    Z.check('C5 the other channels keep their own rules (a TL is not blocked by the WhatsApp rule on Email)', !/for the Super Admin and HR/.test(mail.text), [mail.status, mail.text.slice(0, 160)]);
    const dl = await Z.call('POST', '/api/messaging/device-log', tTok, { audience: 'employees', channel: 'WhatsApp', id: wEmp.id, purpose: 'x' });
    Z.check('C6 opening WhatsApp in a TL\'s own app for an employee is refused too (403)', dl.status === 403 && /for the Super Admin and HR/.test(dl.text), [dl.status, dl.text.slice(0, 150)]);
  } catch (e) { Z.fail += 1; console.log('FAIL  crashed', e && e.stack ? e.stack.slice(0, 900) : e); } finally {
    await Z.cleanup().catch((e) => console.log('cleanup problem', String(e.message).slice(0, 160)));
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();
