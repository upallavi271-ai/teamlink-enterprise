#!/usr/bin/env node
// ---------------------------------------------------------------------------
// TIMESHEET: THE TL APPROVES, THEN IT IS COMPLETED + END OF DAY FOR THE SUPER ADMIN (founder 2026-10-27). SANDBOX ONLY.
//   cd backend && npm run sandbox -- --restart --detach --no-watch && TL_API=http://localhost:4011 node scripts/task-tl-approval-test.js
// Proves: whoever gave the task (self, HR), a task marked done is "waiting for TL approval", not completed; only the person's TL
// (reporting manager) or the Super Admin approves it - HR and the person themselves cannot; then it is completed. No TL on file: the
// approve right decides (as before). The end-of-day list sorts each task (completed / waiting / partly done / not started) and the
// Super Admin gets one end-of-day message.
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('TTA');

(async () => {
  const { prisma } = Z;
  const taskIds = [];
  try {
    const day = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    const tl = await Z.mkUser('tl', { role: 'TL', hrmsRole: 'TL', hrmsAccess: true, atsRole: 'NONE', atsAccess: false }, { designation: 'TL', department: 'R&D' });
    const hr = await Z.mkUser('hr', { role: 'HR', hrmsRole: 'HR', hrmsAccess: true, atsRole: 'NONE', atsAccess: false }, { designation: 'HR Executive', department: 'HR' });
    const emp = await Z.mkUser('emp', { role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true, atsRole: 'NONE', atsAccess: false }, { designation: 'Employee', department: 'R&D' });
    const solo = await Z.mkUser('solo', { role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true, atsRole: 'NONE', atsAccess: false }, { designation: 'Employee', department: 'R&D' });
    const tlEmp = await prisma.employee.findFirst({ where: { userId: tl.id } });
    await prisma.employee.updateMany({ where: { userId: emp.id }, data: { reportingManagerId: tlEmp.id } });
    const sa = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN', status: 'Active', employee: { isNot: null } } });
    const [T, H, E, So, S] = await Promise.all([Z.mint(tl), Z.mint(hr), Z.mint(emp), Z.mint(solo), Z.mint(sa)]);
    const mk = (by, who, name, extra = {}) => prisma.task.create({ data: { name: `ZZTEST TTA ${name} ${Z.RUN}`, assigneeId: who.id, assigneeName: who.name, assignedById: by.id, assignedByName: by.name, startDate: day, endDate: day, status: 'In Progress', ...extra } });
    const self = await mk(emp, emp, 'self'); taskIds.push(self.id);
    const fromHr = await mk(hr, emp, 'from HR'); taskIds.push(fromHr.id);
    const part = await mk(emp, emp, 'partly'); taskIds.push(part.id);
    const fresh = await mk(emp, emp, 'not started', { status: 'Not Started' }); taskIds.push(fresh.id);
    const soloT = await mk(solo, solo, 'no TL'); taskIds.push(soloT.id);
    const rowOf = async (tok, id) => ((await Z.call('GET', '/api/tasks', tok)).body || []).find((t) => t.id === id);

    const c1 = await Z.call('POST', `/api/tasks/${self.id}/complete`, E, { note: 'done' });
    Z.check('T1 marking a self-given task done names the TL who approves it', c1.status === 200 && c1.body.approver === tlEmp.name, [c1.status, c1.body.approver]);
    const r1 = await rowOf(E, self.id);
    Z.check('T2 done but not approved: "Waiting for TL approval", not completed', r1 && r1.displayStatus === 'Waiting for TL approval' && /waiting for TL approval/.test(r1.completion), r1 && [r1.displayStatus, r1.completion]);
    const tlBell = await prisma.notification.findFirst({ where: { userId: tl.id, title: { contains: 'Waiting for your approval' } } });
    Z.check('T3 the TL is told it waits for their approval', !!tlBell, 'no bell');
    const selfRev = await Z.call('POST', `/api/tasks/${self.id}/review`, E, { decision: 'approve' });
    const hrRev = await Z.call('POST', `/api/tasks/${self.id}/review`, H, { decision: 'approve' });
    Z.check('T4 the person cannot approve their own task, and HR cannot approve it when the person has a TL', selfRev.status === 403 && hrRev.status === 403 && /TL/.test(hrRev.body.error || ''), [selfRev.status, hrRev.status, hrRev.body.error]);
    const rowTl = await rowOf(T, self.id); const rowHr = await rowOf(H, self.id);
    Z.check('T5 only the TL\'s list offers "Check it and approve"', rowTl && rowTl.rights.review === true && (!rowHr || rowHr.rights.review === false) && r1.rights.review === false, [rowTl && rowTl.rights, rowHr && rowHr.rights]);
    const tlRev = await Z.call('POST', `/api/tasks/${self.id}/review`, T, { decision: 'approve' });
    const r2 = await prisma.task.findUnique({ where: { id: self.id } });
    Z.check('T6 the TL approves: now it is completed', tlRev.status === 200 && r2.status === 'Completed' && r2.reviewState === 'Approved' && r2.reviewedById === tl.id, [tlRev.status, r2.reviewState]);
    await Z.call('POST', `/api/tasks/${fromHr.id}/complete`, E, {});
    const hrOwn = await Z.call('POST', `/api/tasks/${fromHr.id}/review`, H, { decision: 'approve' });
    Z.check('T7 a task HR gave: HR still cannot approve it - the TL does', hrOwn.status === 403, [hrOwn.status, hrOwn.body.error]);
    const saRev = await Z.call('POST', `/api/tasks/${fromHr.id}/review`, S, { decision: 'changes', note: 'ZZTEST TTA add the summary' });
    Z.check('T8 the Super Admin may decide too (here: sent back)', saRev.status === 200, [saRev.status, saRev.body.error]);
    await Z.call('POST', `/api/tasks/${soloT.id}/complete`, So, {});
    const soloRev = await Z.call('POST', `/api/tasks/${soloT.id}/review`, H, { decision: 'approve' });
    Z.check('T9 no TL on file: someone with the approve right (HR) approves, as before', soloRev.status === 200, [soloRev.status, soloRev.body.error]);
    // partly done: hours logged, not finished
    const hrsLog = await Z.call('POST', `/api/tasks/${part.id}/hours`, E, { hours: 2.5, date: day, note: 'ZZTEST TTA' });
    const de = await Z.call('GET', `/api/tasks/day-end?date=${day}`, S);
    const mine = (de.body.people || []).find((p) => p.userId === emp.id) || { tasks: [] };
    const st = (id) => (mine.tasks.find((t) => t.id === id) || {}).state;
    Z.check('T10 end of day: completed (TL approved), sent back, partly done (2.5 h), not started - each task its own state, with the TL named', de.status === 200 && st(self.id) === 'completed' && st(fromHr.id) === 'sentback' && st(part.id) === 'partial' && st(fresh.id) === 'notstarted' && mine.tl === tlEmp.name && /2\.5 h worked/.test((mine.tasks.find((t) => t.id === part.id) || {}).why || ''), [hrsLog.status, mine.tasks.map((t) => [t.name, t.state, t.why])]);
    const eDe = await Z.call('GET', `/api/tasks/day-end?date=${day}`, E);
    Z.check('T11 an employee sees only their own day', eDe.status === 200 && (eDe.body.people || []).every((p) => p.userId === emp.id), (eDe.body.people || []).map((p) => p.name));
    const N = require(require('path').join(Z.BACK, 'src/utils/hrmsNotify'));
    const out = await N.sendDayEnd({ now: new Date() });
    const saNote = await prisma.notification.findFirst({ where: { userId: sa.id, title: { startsWith: 'Tasks today' } }, orderBy: { createdAt: 'desc' } });
    Z.check('T12 the Super Admin gets the end-of-day message: completed / waiting for TL / partly done / in progress / not started', out.total > 0 && !!saNote && /Completed \d+ · Waiting for TL approval \d+ · Partly done \d+/.test(saNote.title), [out, saNote && saNote.title]);
    if (saNote) await prisma.notification.delete({ where: { id: saNote.id } });
  } catch (err) { Z.fail += 1; console.log('FAIL  crashed', err && err.stack ? err.stack.slice(0, 900) : err); } finally {
    try {
      await prisma.notification.deleteMany({ where: { OR: [{ title: { contains: 'ZZTEST TTA' } }, { message: { contains: 'ZZTEST TTA' } }] } });
      await prisma.employeeRecord.deleteMany({ where: { category: { in: taskIds.map((id) => `task:${id}`) } } }).catch(() => null);
      await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
    } catch (e) { console.log('cleanup', String(e.message).slice(0, 160)); }
    await Z.cleanup([(p) => p.auditLog.deleteMany({ where: { entityId: { in: taskIds.length ? taskIds : ['-'] } } })]).catch((e) => console.log('cleanup problem', String(e.message).slice(0, 160)));
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();
