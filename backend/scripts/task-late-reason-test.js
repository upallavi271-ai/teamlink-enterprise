#!/usr/bin/env node
// ---------------------------------------------------------------------------
// LATE TASKS: WHY + NEW DAY (founder 2026-10-27). SANDBOX ONLY.
//   cd backend && npm run sandbox -- --restart --detach --no-watch && TL_API=http://localhost:4011 node scripts/task-late-reason-test.js
// Proves: a late task asks its person for a reason; they cannot move the date themselves (even on a task they gave
// themselves); the ask needs a reason and a later day; one ask at a time; only the giver / reporting manager decides;
// No keeps it late (with the reason), Approve moves the due day; the bell tells each side.
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('TLR');

(async () => {
  const { prisma } = Z;
  const taskIds = [];
  try {
    const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
    const tl = await Z.mkUser('tl', { role: 'TL', hrmsRole: 'TL', hrmsAccess: true, atsRole: 'NONE', atsAccess: false }, { designation: 'TL', department: 'R&D' });
    const emp = await Z.mkUser('emp', { role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true, atsRole: 'NONE', atsAccess: false }, { designation: 'Employee', department: 'R&D' });
    const other = await Z.mkUser('oth', { role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true, atsRole: 'NONE', atsAccess: false }, { designation: 'Employee', department: 'R&D' });
    const tlEmp = await prisma.employee.findFirst({ where: { userId: tl.id } });
    await prisma.employee.updateMany({ where: { userId: emp.id }, data: { reportingManagerId: tlEmp.id } });
    const T = await Z.mint(tl); const E = await Z.mint(emp); const O = await Z.mint(other);
    const mk = (by, name) => prisma.task.create({ data: { name: `ZZTEST TLR ${name} ${Z.RUN}`, assigneeId: emp.id, assigneeName: emp.name, assignedById: by.id, assignedByName: by.name, startDate: day(-10), endDate: day(-3), status: 'In Progress' } });
    const given = await mk(tl, 'given'); taskIds.push(given.id);
    const self = await mk(emp, 'self'); taskIds.push(self.id);
    const rowOf = async (tok, id) => ((await Z.call('GET', '/api/tasks', tok)).body || []).find((t) => t.id === id);

    const r0 = await rowOf(E, given.id);
    Z.check('L1 a task 3 days past its due day asks its person for a reason', r0 && r0.overdue && r0.needsReason && !r0.delayPending && r0.daysLate === 3, r0 && [r0.overdue, r0.needsReason, r0.daysLate]);
    const mv = await Z.call('PUT', `/api/tasks/${self.id}`, E, { endDate: day(5) });
    Z.check('L2 on a task they gave themselves, the person cannot move a late date', mv.status === 400 && /Ask for more time/.test(mv.body.error || ''), [mv.status, mv.body.error]);
    const ex = await Z.call('POST', `/api/tasks/${self.id}/extend`, E, { endDate: day(5) });
    Z.check('L3 ...not through "Move date" either', ex.status === 400, [ex.status, ex.body.error]);

    const bad1 = await Z.call('POST', `/api/tasks/${given.id}/delay`, E, { reason: 'no', newDate: day(4) });
    const bad2 = await Z.call('POST', `/api/tasks/${given.id}/delay`, E, { reason: 'Waiting for data', newDate: day(-1) });
    const bad3 = await Z.call('POST', `/api/tasks/${given.id}/delay`, O, { reason: 'Waiting for data', newDate: day(4) });
    Z.check('L4 the ask needs a real reason, a day not in the past, and only the person it is for', bad1.status === 400 && bad2.status === 400 && [403, 404].includes(bad3.status), [bad1.status, bad2.status, bad3.status]);
    const ask = await Z.call('POST', `/api/tasks/${given.id}/delay`, E, { reason: 'Waiting for data from Accounts', newDate: day(4) });
    Z.check('L5 the ask is sent to whoever gave the task', ask.status === 201 && (ask.body.askedFrom || []).includes(tl.name), [ask.status, ask.body]);
    const again = await Z.call('POST', `/api/tasks/${given.id}/delay`, E, { reason: 'Waiting for data again', newDate: day(6) });
    Z.check('L6 one ask at a time', again.status === 409, again.status);
    const r1 = await rowOf(E, given.id);
    Z.check('L7 the row now shows the waiting ask, no longer "needs a reason"', r1.delayPending && !r1.needsReason && r1.lastDelay.newDate === day(4), [r1.delayPending, r1.needsReason]);
    const bell = await prisma.notification.findFirst({ where: { userId: tl.id, title: { contains: 'More time asked' } } });
    Z.check('L8 the giver gets it in the bell', !!bell, 'no bell entry');

    const did = r1.lastDelay.id;
    const selfDecide = await Z.call('POST', `/api/tasks/${given.id}/delay/${did}/decision`, E, { approve: true });
    Z.check('L9 the person cannot approve their own ask', selfDecide.status === 403, selfDecide.status);
    const noNote = await Z.call('POST', `/api/tasks/${given.id}/delay/${did}/decision`, T, { approve: false });
    Z.check('L10 saying no needs a reason', noNote.status === 400, noNote.status);
    const no = await Z.call('POST', `/api/tasks/${given.id}/delay/${did}/decision`, T, { approve: false, note: 'Client needs it today' });
    const r2 = await rowOf(E, given.id);
    Z.check('L11 No: the task stays late, the person must answer again and sees why', no.status === 200 && r2.overdue && r2.needsReason && r2.lastDelay.status === 'Rejected' && r2.endDate === day(-3), [no.status, r2.overdue, r2.needsReason, r2.lastDelay && r2.lastDelay.status]);
    const ask2 = await Z.call('POST', `/api/tasks/${given.id}/delay`, E, { reason: 'Data came late, need two days', newDate: day(2) });
    const yes = await Z.call('POST', `/api/tasks/${given.id}/delay/${ask2.body.delay.id}/decision`, T, { approve: true });
    const r3 = await rowOf(E, given.id);
    Z.check('L12 Approve: the due day moves and it is no longer late', yes.status === 200 && r3.endDate === day(2) && !r3.overdue && !r3.needsReason, [yes.status, r3.endDate, r3.overdue]);
    const told = await prisma.notification.findFirst({ where: { userId: emp.id, title: { contains: 'More time given' } } });
    Z.check('L13 the person is told', !!told, 'no bell entry');

    const askSelf = await Z.call('POST', `/api/tasks/${self.id}/delay`, E, { reason: 'Took the urgent client work first', newDate: day(3) });
    Z.check('L14 on a task they gave themselves, the ask goes to their reporting manager', askSelf.status === 201 && (askSelf.body.askedFrom || []).includes(tl.name), [askSelf.status, askSelf.body]);
    const rm = await Z.call('POST', `/api/tasks/${self.id}/delay/${askSelf.body.delay.id}/decision`, T, { approve: true, note: 'OK' });
    const r4 = await prisma.task.findUnique({ where: { id: self.id } });
    Z.check('L15 the reporting manager decides; the date moves', rm.status === 200 && r4.endDate === day(3), [rm.status, rm.body && rm.body.error, r4.endDate]);
    const notes = await prisma.taskComment.count({ where: { taskId: given.id } });
    Z.check('L16 every step is on the task notes', notes >= 4, notes);
  } catch (err) { Z.fail += 1; console.log('FAIL  crashed', err && err.stack ? err.stack.slice(0, 900) : err); } finally {
    try {
      await prisma.notification.deleteMany({ where: { OR: [{ title: { contains: 'ZZTEST TLR' } }, { message: { contains: 'ZZTEST TLR' } }] } });
      await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
    } catch (e) { console.log('cleanup', String(e.message).slice(0, 160)); }
    await Z.cleanup([(p) => p.auditLog.deleteMany({ where: { entityId: { in: taskIds.length ? taskIds : ['-'] } } })]).catch((e) => console.log('cleanup problem', String(e.message).slice(0, 160)));
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();
