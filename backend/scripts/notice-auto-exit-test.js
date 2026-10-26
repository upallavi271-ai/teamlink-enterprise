#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE NOTICE PERIOD: THE DAY COUNT AND THE AUTOMATIC EXIT (founder, 2026-10-23). SANDBOX ONLY.
//   cd backend && npm run sandbox -- --restart --detach --no-watch && TL_API=http://localhost:4011 node scripts/notice-auto-exit-test.js
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('NAE');
const path = require('path');

(async () => {
  try {
    const NA = require(path.join(Z.BACK, 'src/utils/noticeAutoExit'));
    const exitFlow = require(path.join(Z.BACK, 'src/utils/exitFlow'));
    const seatRelease = require(path.join(Z.BACK, 'src/utils/seatRelease'));
    const { prisma } = Z;
    const today = require(path.join(Z.BACK, 'src/utils/positions')).today();
    const add = NA.addDays;

    // ---- 1. the pure count -----------------------------------------------------------------------------------------------------------
    let p = NA.progressOf({ from: '2026-10-01', last: '2026-11-15', today: '2026-10-13' });
    Z.check('P1 45-day notice, 12 days in: day 12 of 45, 33 days left', p && p.total === 45 && p.day === 12 && p.left === 33 && p.state === 'serving', p);
    p = NA.progressOf({ from: '2026-10-01', last: '2026-11-15', today: '2026-10-01' });
    Z.check('P2 the resignation day itself: day 0, all 45 left', p.day === 0 && p.left === 45, p);
    p = NA.progressOf({ from: '2026-10-01', last: '2026-11-15', today: '2026-11-15' });
    Z.check('P3 on the last working day: last-day, 0 left', p.state === 'last-day' && p.left === 0 && p.day === 45, p);
    p = NA.progressOf({ from: '2026-10-01', last: '2026-11-15', today: '2026-11-16' });
    Z.check('P4 the day after: over', p.state === 'over' && p.left === 0, p);
    Z.check('P5 no dates -> no count', NA.progressOf({ from: null, last: '2026-11-15' }) === null);

    // ---- 2. people on notice, in the sandbox database -------------------------------------------------------------------------------
    const mk = async (tag, { lwd, status = 'Notice Period', recStatus = 'Notice Period', from }) => {
      const u = await Z.mkUser(tag, { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' }, { designation: 'Employee' });
      const emp = await prisma.employee.findFirst({ where: { userId: u.id } });
      await prisma.employee.update({ where: { id: emp.id }, data: { employmentStatus: status, offboardingStatus: 'Serving Notice' } });
      const rec = await prisma.employeeRecord.create({ data: { type: 'RESIGNATION', employeeId: emp.id, title: 'ZZTEST notice', status: recStatus, date: lwd, raisedBy: 'ZZTEST NAE' } });
      await prisma.resignationDetail.create({ data: { recordId: rec.id, employeeId: emp.id, employeeName: emp.name, resignationDate: from, resignationTime: '10:00', source: 'ZZTEST', requestedLastWorkingDate: lwd, approvedLastWorkingDate: lwd, reason: 'Other', reasonOther: 'ZZTEST', noticePeriodDays: 45, submittedByName: 'ZZTEST NAE' } });
      return { u, emp, rec };
    };
    const over = await mk('over', { lwd: add(today, -1), from: add(today, -46) }); // served 45 days, last day was yesterday
    const lastDay = await mk('lastday', { lwd: today, from: add(today, -45) }); // today IS the last day
    const mid = await mk('mid', { lwd: add(today, 33), from: add(today, -12) });
    const pend = await mk('pend', { lwd: add(today, -3), recStatus: 'Pending Approval', status: 'Exit Process', from: add(today, -48) });
    // a seat for the person whose notice is over, to see the seat end too
    const seat = await prisma.position.findFirst({ where: { active: true } });
    let seatRow = null;
    if (seat) seatRow = await prisma.positionAssignment.create({ data: { positionId: seat.id, employeeId: over.emp.id, fromDate: add(today, -200), toDate: null } });

    // ---- 3. the sweep -----------------------------------------------------------------------------------------------------------------
    const dry = await NA.autoExitDue({ dry: true });
    Z.check('S0 a dry run names who would go and changes nothing', dry.relieved.some((r) => r.id === over.emp.id) && (await prisma.employee.findUnique({ where: { id: over.emp.id } })).employmentStatus === 'Notice Period', dry);
    const run = await NA.autoExitDue();
    const after = async (e) => prisma.employee.findUnique({ where: { id: e.emp.id } });
    Z.check('S1 notice over (last day was yesterday): Relieved by itself', (await after(over)).employmentStatus === 'Relieved', run);
    Z.check('S2 the exit record is closed as Relieved', (await prisma.employeeRecord.findUnique({ where: { id: over.rec.id } })).status === 'Relieved');
    Z.check('S3 the full & final settlement request is open, with the last working day', !!(await prisma.fnfRequest.findFirst({ where: { employeeId: over.emp.id, status: 'Pending' } })));
    Z.check('S4 the audit trail says it was automatic', !!(await prisma.auditLog.findFirst({ where: { entityId: over.rec.id, action: { startsWith: 'Resignation Relieved' } } })));
    await seatRelease.sweepDueExits({ backlog: true });
    if (seatRow) Z.check('S5 the seat ends too', !!(await prisma.positionAssignment.findUnique({ where: { id: seatRow.id } })).toDate);
    Z.check('S6 on the LAST working day itself nobody is relieved yet', (await after(lastDay)).employmentStatus === 'Notice Period');
    Z.check('S7 a person with days still to serve stays on notice', (await after(mid)).employmentStatus === 'Notice Period');
    Z.check('S8 an exit still waiting for approval is NOT finished automatically, it is listed', run.waiting.some((w) => w.id === pend.emp.id) && !['Relieved', 'Exited'].includes((await after(pend)).employmentStatus), run.waiting);
    const again = await NA.autoExitDue();
    Z.check('S9 running it again changes nothing (no second settlement request)', again.relieved.length === 0 && (await prisma.fnfRequest.count({ where: { employeeId: over.emp.id } })) === 1, again);

    // ---- 4. the day count the screens show ---------------------------------------------------------------------------------------------
    const su = await Z.mkUser('sa', { role: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', hrmsAccess: true });
    const tok = await Z.mint(su);
    const list = (await Z.call('GET', '/api/employees/management', tok)).body;
    const row = ((list && list.rows) || []).find((r) => r.id === mid.emp.id);
    Z.check('L1 the employee list carries the count for somebody on notice: day 12 of 45, 33 left', row && row.notice && row.notice.day === 12 && row.notice.total === 45 && row.notice.left === 33, row && row.notice);
    const one = (await Z.call('GET', `/api/employees/${mid.emp.id}`, tok)).body;
    Z.check('L2 so does the one-employee read (the profile)', one && one.notice && one.notice.day === 12 && one.notice.left === 33, one && one.notice);
    const active = ((list && list.rows) || []).find((r) => r.employmentStatus === 'Active');
    Z.check('L3 an active employee has no count', active && active.notice === null, active && active.notice);

    // ---- 5. put on notice by status alone: a real last working day (45 days from today) --------------------------------------------------
    const bare = await Z.mkUser('bare', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' }, { designation: 'Employee' });
    const bareEmp = await prisma.employee.findFirst({ where: { userId: bare.id } });
    await prisma.employee.update({ where: { id: bareEmp.id }, data: { employmentStatus: 'Notice Period' } });
    await exitFlow.ensureExitRecord(bareEmp, { id: su.id, name: su.name }, {});
    const got = (await NA.progressFor([bareEmp.id])).get(bareEmp.id);
    // founder 2026-10-26 (replaces the 10-23 "count from today"): with no resignation on file the resignation date is NOT invented as today;
    // HR / the Super Admin enter the real one and the last working day follows. Until then there is no day count and no automatic exit.
    const det = await prisma.resignationDetail.findFirst({ where: { employeeId: bareEmp.id } });
    Z.check('N1 notice by status alone: no made-up resignation date (not today); waits for HR to enter the real one', det && det.resignationDate === '' && !(got && got.day != null && got.left != null && got.left > 0 && got.total === 45 && got.day === 0), [det && det.resignationDate, got]);
  } catch (e) { Z.fail += 1; console.log('FAIL  crashed', e && e.stack ? e.stack.slice(0, 800) : e); } finally {
    // the rows this test made on people, BEFORE the people are removed (foreign keys)
    try {
      const ids = (await Z.prisma.employee.findMany({ where: { name: { contains: 'ZZTEST NAE' } }, select: { id: true } })).map((x) => x.id);
      await Z.prisma.fnfRequest.deleteMany({ where: { employeeId: { in: ids } } });
      await Z.prisma.resignationDetail.deleteMany({ where: { employeeId: { in: ids } } });
      await Z.prisma.employeeRecord.deleteMany({ where: { employeeId: { in: ids } } });
      await Z.prisma.positionAssignment.deleteMany({ where: { employeeId: { in: ids } } });
    } catch (e) { console.log('pre-cleanup problem', String(e.message).slice(0, 160)); }
    await Z.cleanup().catch((e) => console.log('cleanup problem', String(e.message).slice(0, 200)));
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();
