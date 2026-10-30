#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE EMPLOYEE CANCELS THEIR OWN LEAVE (founder 2026-10-30). SANDBOX ONLY.
//   cd backend && npm run sandbox -- --restart --detach --no-watch && TL_API=http://localhost:4011 node scripts/leave-self-cancel-test.js
// Proves: only the person's own leave; Pending and not-yet-started Approved leave are cancelled at once (open approval steps
// closed, the days go back); a started leave goes to HR as "Cancellation Requested"; a rejected one cannot be cancelled; the list
// says who may cancel, and the history keeps who / when / why (request fields, decision line, audit row).
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('LSC');

(async () => {
  const { prisma } = Z;
  const leaveIds = [];
  let empRow = null;
  try {
    const day = (n) => new Date(Date.now() + 330 * 60000 + n * 86400000).toISOString().slice(0, 10);
    const emp = await Z.mkUser('emp', { role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true, atsRole: 'NONE', atsAccess: false }, { designation: 'Employee', department: 'R&D' });
    const other = await Z.mkUser('oth', { role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true, atsRole: 'NONE', atsAccess: false }, { designation: 'Employee', department: 'R&D' });
    empRow = await prisma.employee.findFirst({ where: { userId: emp.id } });
    const E = await Z.mint(emp); const O = await Z.mint(other);
    const type = `ZZTEST LSC ${Z.RUN}`;
    await prisma.leaveBalance.create({ data: { employeeId: empRow.id, type, total: 10, taken: 3 } });
    const mk = async (status, from, to, days) => {
      const l = await prisma.leaveRequest.create({ data: { employeeId: empRow.id, type, fromDate: from, toDate: to, days, status, reason: `ZZTEST LSC ${status}` } });
      leaveIds.push(l.id); return l;
    };
    const pending = await mk('Pending', day(5), day(5), 1);
    const approvedLater = await mk('Approved', day(8), day(9), 2);
    const approvedStarted = await mk('Approved', day(-1), day(1), 3);
    const rejected = await mk('Rejected', day(3), day(3), 1);

    const list0 = (await Z.call('GET', '/api/leave', E)).body || [];
    const row = (id) => list0.find((r) => r.id === id) || {};
    Z.check('C1 the list marks the person\'s own requests and which they may cancel',
      row(pending.id).mine === true && row(pending.id).canSelfCancel === true && row(approvedLater.id).canSelfCancel === true
      && row(approvedStarted.id).canSelfCancel === false && row(rejected.id).canSelfCancel === false,
      [row(pending.id).mine, row(pending.id).canSelfCancel, row(approvedLater.id).canSelfCancel, row(approvedStarted.id).canSelfCancel]);
    const stepsBefore = await prisma.approvalStep.count({ where: { workflow: 'leave', recordId: pending.id, status: { in: ['Pending', 'Waiting'] } } });

    const notMine = await Z.call('POST', `/api/leave/${pending.id}/cancel`, O, { reason: 'x' });
    Z.check('C2 nobody else can cancel it', notMine.status === 403, notMine.status);

    const c1 = await Z.call('POST', `/api/leave/${pending.id}/cancel`, E, { reason: 'Plan changed' });
    const p1 = await prisma.leaveRequest.findUnique({ where: { id: pending.id } });
    const stepsAfter = await prisma.approvalStep.count({ where: { workflow: 'leave', recordId: pending.id, status: { in: ['Pending', 'Waiting'] } } });
    Z.check('C3 a pending leave is cancelled at once, with who / when / why kept', c1.status === 200 && p1.status === 'Cancelled' && p1.cancelledBy && p1.cancelledAt && p1.cancelReason === 'Plan changed', [c1.status, p1.status, p1.cancelledBy, p1.cancelReason]);
    Z.check('C4 its approval steps still open are closed (nobody waits on it)', stepsBefore > 0 && stepsAfter === 0, [stepsBefore, stepsAfter]);

    const c2 = await Z.call('POST', `/api/leave/${approvedLater.id}/cancel`, E, {});
    const p2 = await prisma.leaveRequest.findUnique({ where: { id: approvedLater.id } });
    const bal = await prisma.leaveBalance.findUnique({ where: { employeeId_type: { employeeId: empRow.id, type } } });
    Z.check('C5 an approved leave that has not started is cancelled at once and its 2 days go back', c2.status === 200 && p2.status === 'Cancelled' && bal.taken === 1, [c2.status, p2.status, bal.taken]);

    const c3 = await Z.call('POST', `/api/leave/${approvedStarted.id}/cancel`, E, { reason: 'Came back early' });
    const p3 = await prisma.leaveRequest.findUnique({ where: { id: approvedStarted.id } });
    const bal2 = await prisma.leaveBalance.findUnique({ where: { employeeId_type: { employeeId: empRow.id, type } } });
    Z.check('C6 a leave that already started goes to HR as Cancellation Requested; no days move yet', c3.status === 200 && p3.status === 'Cancellation Requested' && bal2.taken === 1 && /HR/.test(c3.body.message || ''), [c3.status, p3.status, bal2.taken]);

    const c4 = await Z.call('POST', `/api/leave/${rejected.id}/cancel`, E, {});
    Z.check('C7 a rejected leave cannot be cancelled', c4.status === 400, c4.status);
    const again = await Z.call('POST', `/api/leave/${pending.id}/cancel`, E, {});
    Z.check('C8 a cancelled leave cannot be cancelled again', again.status === 400, again.status);

    const list1 = (await Z.call('GET', '/api/leave', E)).body || [];
    const r1 = list1.find((r) => r.id === pending.id) || {};
    Z.check('C9 the history line says the employee cancelled it, when, and why', r1.status === 'Cancelled' && /cancelled by the employee/.test((r1.decision || {}).by || '') && (r1.decision || {}).at && (r1.decision || {}).comment === 'Plan changed', r1.decision);
    const audit = await prisma.auditLog.count({ where: { entityId: { in: [pending.id, approvedLater.id] }, action: 'Leave cancelled by the employee' } });
    const auditReq = await prisma.auditLog.count({ where: { entityId: approvedStarted.id, action: 'Leave cancellation requested' } });
    Z.check('C10 every cancel is in the audit trail', audit === 2 && auditReq === 1, [audit, auditReq]);
  } catch (err) { Z.fail += 1; console.log('FAIL  crashed', err && err.stack ? err.stack.slice(0, 900) : err); } finally {
    try {
      await prisma.approvalStep.deleteMany({ where: { workflow: 'leave', recordId: { in: leaveIds.length ? leaveIds : ['-'] } } });
      await prisma.auditLog.deleteMany({ where: { entityId: { in: leaveIds.length ? leaveIds : ['-'] } } });
      await prisma.leaveRequest.deleteMany({ where: { id: { in: leaveIds } } });
      if (empRow) await prisma.leaveBalance.deleteMany({ where: { employeeId: empRow.id } });
    } catch (e) { console.log('cleanup', String(e.message).slice(0, 160)); }
    await Z.cleanup().catch((e) => console.log('cleanup problem', String(e.message).slice(0, 160)));
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();
