#!/usr/bin/env node
// ---------------------------------------------------------------------------
// WHERE A LEAVE APPROVAL STOPS (founder 2026-10-26: "TL ki 2 day leave approvals untai; once TL approve chesthe HR, Super Admin malli
// approve cheyyakkarledu kani chain lo kanipinchali"; a leave TL and HR approved showed Pending). SANDBOX ONLY.
//   cd backend && npm run sandbox -- --restart --detach --no-watch && TL_API=http://localhost:4011 node scripts/leave-chain-stop-test.js
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('LCS');

(async () => {
  const { prisma } = Z;
  const leaveIds = [];
  try {
    const mk = (tag, role) => Z.mkUser(tag, { role, hrmsRole: role, hrmsAccess: true, atsRole: 'NONE', atsAccess: false }, { designation: 'Executive', department: 'R&D' });
    const tl = await mk('tl', 'TL');
    const hr = await mk('hr', 'HR');
    const sa = await mk('sa', 'SUPER_ADMIN');
    const emp = await mk('emp', 'EMPLOYEE');
    const e = await prisma.employee.findFirst({ where: { userId: emp.id } });
    const T = { tl: await Z.mint(tl), hr: await Z.mint(hr) };
    // a request with the chain TL -> HR -> Super Admin, all required (as the default ladder has them)
    const mkLeave = async (days, from, to, tlState) => {
      const lv = await prisma.leaveRequest.create({ data: { employeeId: e.id, type: 'Casual', fromDate: from, toDate: to, days, status: 'Pending', reason: 'ZZTEST LCS' } });
      leaveIds.push(lv.id);
      const step = (level, seq, user, status) => ({ workflow: 'leave', recordId: lv.id, level, seq, mode: 'required', approverUserId: user.id, approverName: user.name, status, activatedAt: status === 'Pending' ? new Date() : null });
      await prisma.approvalStep.createMany({ data: [
        { workflow: 'leave', recordId: lv.id, level: 'EMPLOYEE', seq: 0, mode: 'applicant', approverUserId: emp.id, approverName: emp.name, status: 'Applied' },
        step('TL', 1, tl, tlState),
        step('HR', 5, hr, tlState === 'Approved' ? 'Pending' : 'Waiting'),
        step('SUPER_ADMIN', 6, sa, 'Waiting'),
      ] });
      return lv;
    };
    const stepsOf = async (id) => Object.fromEntries((await prisma.approvalStep.findMany({ where: { recordId: id } })).map((s) => [s.level, s.status]));

    // 1. one day: the TL's approval grants it; HR and Super Admin only see it
    const a = await mkLeave(1, '2026-11-16', '2026-11-16', 'Pending');
    const r1 = await Z.call('PATCH', `/api/leave/${a.id}/decision`, T.tl, { status: 'Approved', comment: 'ZZTEST LCS fine' });
    const a1 = await prisma.leaveRequest.findUnique({ where: { id: a.id } });
    const s1 = await stepsOf(a.id);
    Z.check('C1 a 1-day leave the TL approves is Approved at once', r1.status === 200 && a1.status === 'Approved', [r1.status, r1.text.slice(0, 200), a1.status]);
    Z.check('C2 HR and Super Admin stay in the chain as Visibility (seen, not needed)', s1.TL === 'Approved' && s1.HR === 'Visibility' && s1.SUPER_ADMIN === 'Visibility', s1);

    // 2. more days, TL already approved, HR approves: Approved, the Super Admin only sees it
    const b = await mkLeave(3, '2026-11-18', '2026-11-20', 'Approved');
    const r2 = await Z.call('PATCH', `/api/leave/${b.id}/decision`, T.hr, { status: 'Approved', comment: 'ZZTEST LCS ok', approvalReason: undefined });
    let b1 = await prisma.leaveRequest.findUnique({ where: { id: b.id } });
    if (r2.status === 400 && r2.body && r2.body.reasons) {
      await Z.call('PATCH', `/api/leave/${b.id}/decision`, T.hr, { status: 'Approved', comment: 'ZZTEST LCS ok', approvalReason: r2.body.reasons[0] });
      b1 = await prisma.leaveRequest.findUnique({ where: { id: b.id } });
    }
    const s2 = await stepsOf(b.id);
    Z.check('C3 TL and HR approved: the leave is Approved, not Pending', b1.status === 'Approved', [r2.status, r2.text.slice(0, 200), b1.status]);
    Z.check('C4 the Super Admin is shown in the chain as Visibility', s2.HR === 'Approved' && s2.SUPER_ADMIN === 'Visibility', s2);

    // 3. over the TL limit: the TL approves and it goes straight to HR (still Pending); HR approves -> Approved
    const c = await mkLeave(3, '2026-11-23', '2026-11-25', 'Pending');
    const r3 = await Z.call('PATCH', `/api/leave/${c.id}/decision`, T.tl, { status: 'Approved', comment: 'ZZTEST LCS' });
    const c1 = await prisma.leaveRequest.findUnique({ where: { id: c.id } });
    const s3 = await stepsOf(c.id);
    Z.check('C5 a 3-day leave: the TL approves, it moves to HR and stays Pending (not granted by the TL)', r3.status === 200 && c1.status === 'Pending' && s3.TL === 'Approved' && s3.HR === 'Pending', [r3.status, r3.text.slice(0, 160), c1.status, s3]);
    const r4 = await Z.call('PATCH', `/api/leave/${c.id}/decision`, T.hr, { status: 'Approved', comment: 'ZZTEST LCS ok' });
    let c2 = await prisma.leaveRequest.findUnique({ where: { id: c.id } });
    if (r4.status === 400 && r4.body && r4.body.reasons) { await Z.call('PATCH', `/api/leave/${c.id}/decision`, T.hr, { status: 'Approved', comment: 'ZZTEST LCS ok', approvalReason: r4.body.reasons[0] }); c2 = await prisma.leaveRequest.findUnique({ where: { id: c.id } }); }
    const s4 = await stepsOf(c.id);
    Z.check('C6 then HR approves it: Approved, the Super Admin shown as Visibility', c2.status === 'Approved' && s4.SUPER_ADMIN === 'Visibility', [r4.status, c2.status, s4]);
  } catch (err) { Z.fail += 1; console.log('FAIL  crashed', err && err.stack ? err.stack.slice(0, 900) : err); } finally {
    try {
      await prisma.approvalStep.deleteMany({ where: { recordId: { in: leaveIds } } });
      const emps = Z.made.emps;
      for (const m of ['leaveCharge', 'leaveBalance']) { try { await prisma[m].deleteMany({ where: { employeeId: { in: emps } } }); } catch { /* not every table */ } } // eslint-disable-line no-await-in-loop
      await prisma.leaveRequest.deleteMany({ where: { id: { in: leaveIds } } });
    } catch (e) { console.log('cleanup', String(e.message).slice(0, 160)); }
    await Z.cleanup([(p) => p.auditLog.deleteMany({ where: { OR: [{ entityId: { in: leaveIds } }, { reason: { contains: 'ZZTEST LCS' } }] } })]).catch((e) => console.log('cleanup problem', String(e.message).slice(0, 160)));
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();
