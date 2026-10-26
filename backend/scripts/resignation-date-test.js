#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE RESIGNATION DATE IS THE DAY THEY RESIGNED, NOT THE DAY A SCREEN OPENED (founder 2026-10-26). SANDBOX ONLY.
//   cd backend && npm run sandbox -- --restart --detach --no-watch && TL_API=http://localhost:4011 node scripts/resignation-date-test.js
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('RSD');

(async () => {
  const { prisma } = Z;
  let recId = null;
  try {
    const exitFlow = require('../src/utils/exitFlow'); // eslint-disable-line global-require
    const hr = await Z.mkUser('hr', { role: 'HR', hrmsRole: 'HR', hrmsAccess: true, atsRole: 'NONE', atsAccess: false }, { designation: 'HR Executive', department: 'HR' });
    const emp = await Z.mkUser('emp', { role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true, atsRole: 'NONE', atsAccess: false }, { designation: 'Executive', department: 'R&D', employmentStatus: 'Notice Period', dateOfJoining: new Date('2025-01-01') });
    const other = await Z.mkUser('other', { role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true, atsRole: 'NONE', atsAccess: false }, { designation: 'Executive', department: 'R&D' });
    const e = await prisma.employee.findFirst({ where: { userId: emp.id } });
    const live = await exitFlow.ensureExitRecord(e, { id: hr.id, name: hr.name });
    recId = live.record.id;
    const d0 = await prisma.resignationDetail.findUnique({ where: { recordId: recId } });
    const today = new Date().toISOString().slice(0, 10);
    Z.check('R1 a person on notice with no resignation on file: the resignation date is NOT today, it is "not set"', d0 && d0.resignationDate === '' && d0.resignationDate !== today && !live.record.date, d0 && [d0.resignationDate, live.record.date]);
    const days = d0.noticePeriodDays;
    const H = await Z.mint(hr);
    const put = await Z.call('PUT', `/api/resignations/exit/${recId}/dates`, H, { resignationDate: '2026-10-01', reason: 'ZZTEST RSD actual resignation date' });
    const r1 = await prisma.employeeRecord.findUnique({ where: { id: recId } });
    const d1 = await prisma.resignationDetail.findUnique({ where: { recordId: recId } });
    const want = exitFlow.noticeEnd('2026-10-01', days);
    Z.check(`R2 HR enters the real resignation date; the last working day follows = resigned on + ${days} notice days`, put.status === 200 && d1.resignationDate === '2026-10-01' && r1.date === want, [put.status, (put.body && put.body.error) || '', d1.resignationDate, r1.date, want]);
    const no = await Z.call('PUT', `/api/resignations/exit/${recId}/dates`, await Z.mint(other), { resignationDate: '2026-09-20', reason: 'ZZTEST RSD' });
    Z.check('R3 an ordinary employee cannot edit the dates (403)', no.status === 403, no.status);
  } catch (err) { Z.fail += 1; console.log('FAIL  crashed', err && err.stack ? err.stack.slice(0, 900) : err); } finally {
    try {
      if (recId) {
        await prisma.approvalStep.deleteMany({ where: { recordId: recId } });
        await prisma.resignationDetail.deleteMany({ where: { recordId: recId } });
        await prisma.employeeRecord.deleteMany({ where: { id: recId } });
      }
      await prisma.employeeRecord.deleteMany({ where: { employeeId: { in: Z.made.emps } } });
    } catch (e) { console.log('cleanup', String(e.message).slice(0, 160)); }
    await Z.cleanup([(p) => p.auditLog.deleteMany({ where: { OR: [{ entityId: recId || '-' }, { reason: { contains: 'ZZTEST RSD' } }] } })]).catch((e) => console.log('cleanup problem', String(e.message).slice(0, 160)));
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();
