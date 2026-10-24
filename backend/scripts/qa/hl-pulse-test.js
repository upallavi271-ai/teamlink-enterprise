const H = require('./hl');
const { prisma, ok, get, post, put, addDays, today } = H;
const B = 'C:/Users/user/Desktop/All_Projects/teamlink-enterprise/backend/src/';
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const pd = (iso) => `${iso.slice(8, 10)}-${MON[Number(iso.slice(5, 7)) - 1]}-${iso.slice(0, 4)}`;
const HEAD = 'Employee ID,Employee Name,Department,Work Location,Date Of Application,Leave Type,Leave From,Leave To,Half Day,Duration,Reason,Comments,Compensatory Off Dates,Compensatory Off Days,Approver,Approver Comments,Approved Date,Medical Certificate View,Medical Certificate Download,Status';
const row = (code, name, type, from, to, status, { half = '', dur = 1, approver = 'Boss Person', appr = '' } = {}) => `${code},${name},Dept,Hyderabad,${pd(from)},${type},${pd(from)},${pd(to)},${half},${dur},Some reason,"",,,${approver},,${appr ? pd(appr) : ''},,,${status}`;
async function raw(p, path, text) { return H.call(p, 'POST', path, Buffer.from(text, 'utf8'), true); }
(async () => {
  try {
    const hr = await H.persona('HR', { role: 'HR', hrmsRole: 'HR', atsRole: 'HR' });
    const tl = await H.persona('TL', { hrmsRole: 'TL', atsRole: 'TL' });
    const emp = await H.persona('EMP', { tlName: tl.u.name });
    const emp2 = await H.persona('EMP2', { tlName: tl.u.name });
    const mkLeave = (e, from, to, o = {}) => prisma.leaveRequest.create({ data: { employeeId: e.e.id, type: 'Casual Leave', fromDate: from, toDate: to, days: 1, status: 'Pending', ...o } });
    const d1 = addDays(today, 5); const d2 = addDays(today, 8); const d3 = addDays(today, 20); const d4 = addDays(today, 30);
    const L1 = await mkLeave(emp, d1, d1);           // Pulse says Approved -> update
    const L2 = await mkLeave(emp, d2, d2);           // Pulse says Pending -> unchanged
    const L3 = await mkLeave(emp2, d4, d4, { createdAt: new Date(Date.now() - 20 * 86400000) }); // not in Pulse -> only in TeamLink
    for (const L of [L1, L2, L3]) { const e = L.employeeId === emp.e.id ? emp : emp2; await require(B + 'utils/approvalWorkflow').start({ workflow: 'leave', recordId: L.id, employee: e.e, applicantUserId: e.e.userId, applicantName: e.e.name }); }
    const csv = [HEAD,
      row(emp.e.employeeCode, 'x', 'Casual Leave', d1, d1, 'Approved', { approver: 'Vasudeva Rao Chitturi', appr: today }),
      row(emp.e.employeeCode, 'x', 'Casual Leave', d2, d2, 'Pending'),
      row(emp.e.employeeCode, 'x', 'Sick Leave', d3, d3, 'Rejected', { appr: today }),   // not ours -> create
      row(emp2.e.employeeCode, 'y', 'Casual Leave', addDays(today, 40), addDays(today, 40), 'Cancelled'), // create (employee present)
      row(emp.e.employeeCode, 'x', 'Sick Leave', d3, d3, 'Rejected', { appr: today }),   // twice
      row('NOPE999', 'z', 'Casual Leave', d1, d1, 'Approved'),
      row(emp.e.employeeCode, 'x', 'Casual Leave', d1, d1, 'Weird')].join('\n');
    const noPerm = await raw(tl, '/leave/pulse/preview', csv);
    ok(noPerm.s === 403, 'TL cannot use the sync (' + noPerm.s + ')');
    const pv = await raw(hr, '/leave/pulse/preview', csv);
    ok(pv.s === 200, 'preview ' + pv.s + ' ' + JSON.stringify(pv.j).slice(0, 150));
    console.log('   preview counts', JSON.stringify(pv.j.counts));
    ok(pv.j.counts.updated === 1 && pv.j.counts.created === 2 && pv.j.counts.unchanged === 1, 'plan: 1 updated, 2 created, 1 unchanged');
    ok(pv.j.counts.skipped === 3, 'skipped 3 (twice, unknown employee, bad status): ' + pv.j.counts.skipped);
    ok(pv.j.only.length === 1 && pv.j.only[0].leaveId === L3.id, 'only-in-TeamLink flags the old pending one');
    const before = await prisma.leaveRequest.findUnique({ where: { id: L1.id } });
    ok(before.status === 'Pending', 'preview changed nothing');
    const ap = await raw(hr, '/leave/pulse/apply', csv);
    ok(ap.s === 200 && ap.j.counts.updated === 1 && ap.j.counts.created === 2, 'apply ' + ap.s + ' ' + JSON.stringify(ap.j.counts));
    const after = await prisma.leaveRequest.findUnique({ where: { id: L1.id } });
    ok(after.status === 'Approved' && /Vasudeva Rao Chitturi \(Pulse\)/.test(after.decidedBy), 'L1 Approved by Pulse approver: ' + after.decidedBy);
    const steps = await prisma.approvalStep.findMany({ where: { recordId: L1.id } });
    ok(!steps.some((s) => ['Pending', 'Waiting'].includes(s.status)), 'chain steps closed');
    const still = await prisma.leaveRequest.findUnique({ where: { id: L2.id } }); ok(still.status === 'Pending', 'L2 still pending (open in Pulse too)');
    const l3 = await prisma.leaveRequest.findUnique({ where: { id: L3.id } }); ok(l3.status === 'Pending', 'L3 never changed or deleted');
    const created = await prisma.leaveRequest.findMany({ where: { employeeId: { in: [emp.e.id, emp2.e.id] }, id: { notIn: [L1.id, L2.id, L3.id] } } });
    ok(created.length === 2 && created.every((c) => ['Rejected', 'Cancelled'].includes(c.status)), 'created rows as decided: ' + created.map((c) => c.status).join(','));
    const lst = await get(hr, '/leave');
    const src = lst.j.filter((x) => created.some((c) => c.id === x.id)).map((x) => x.source);
    ok(src.length === 2 && src.every((x) => x === 'Pulse sync'), 'created rows marked Source=Pulse sync');
    const mailRows = await prisma.notification.count({ where: { userId: { in: [emp.u.id, emp2.u.id] }, title: { contains: 'Leave' } } });
    ok(mailRows === 0, 'employees were not notified (' + mailRows + ')');
    const sum = await prisma.notification.count({ where: { userId: hr.u.id, title: 'Leave synced with Pulse' } }); ok(sum === 1, 'one summary bell to the syncing HR');
    const audits = await prisma.auditLog.count({ where: { entityId: { in: [L1.id, ...created.map((c) => c.id)] }, action: { startsWith: 'Leave' } } });
    ok(audits >= 3, 'audit rows for each change (' + audits + ')');
    const csvRes = await H.call(hr, 'GET', `/leave/pulse/result/${ap.j.syncId}.csv`); ok(csvRes.s === 200 && /Updated/.test(String(csvRes.j)), 'result CSV downloadable');
    // idempotent
    const ap2 = await raw(hr, '/leave/pulse/apply', csv);
    ok(ap2.j.counts.updated === 0 && ap2.j.counts.created === 0 && ap2.j.counts.unchanged === 4, 're-import idempotent: ' + JSON.stringify(ap2.j.counts));
    // status line
    const st = await get(hr, '/leave/pulse/status'); ok(st.s === 200 && st.j.last && st.j.last.by, 'last synced line: ' + (st.j.last && st.j.last.by));
    // undo the FIRST sync? last is the idempotent one (nothing to undo); undo it then undo again is refused
    const u0 = await post(hr, '/leave/pulse/undo'); ok(u0.s === 200 && u0.j.reverted === 0 && u0.j.removed === 0, 'undo of the no-change sync is harmless');
    // new sync to test undo of real changes
    const csv2 = [HEAD, row(emp.e.employeeCode, 'x', 'Casual Leave', d2, d2, 'Approved', { approver: 'Boss', appr: today }), row(emp.e.employeeCode, 'x', 'Planned Leave', addDays(today, 50), addDays(today, 50), 'Approved')].join('\n');
    const ap3 = await raw(hr, '/leave/pulse/apply', csv2); ok(ap3.j.counts.updated === 1 && ap3.j.counts.created === 1, 'second sync ' + JSON.stringify(ap3.j.counts));
    const un = await post(hr, '/leave/pulse/undo'); ok(un.s === 200 && un.j.reverted === 1 && un.j.removed === 1, 'undo: ' + JSON.stringify(un.j));
    const back = await prisma.leaveRequest.findUnique({ where: { id: L2.id } }); ok(back.status === 'Pending', 'L2 back to Pending after undo');
    const stp = await prisma.approvalStep.findMany({ where: { recordId: L2.id, status: 'Pending' } }); ok(stp.length === 1, 'its chain is open again');
    const un2 = await post(hr, '/leave/pulse/undo'); ok(un2.s === 409, 'undo twice refused (' + un2.s + ')');
    // old pending list + close
    const old = await mkLeave(emp, addDays(today, -300), addDays(today, -300));
    const op = await get(hr, '/leave/pulse/old-pending'); ok(op.s === 200 && op.j.rows.some((r) => r.id === old.id && r.kind === 'old'), 'old-pending lists the old request');
    const bad = await post(hr, `/leave/pulse/old-pending/${old.id}/close`, { action: 'reject' }); ok(bad.s === 400, 'close needs a reason');
    const cl = await post(hr, `/leave/pulse/old-pending/${old.id}/close`, { action: 'reject', reason: 'ZZTEST stale' }); ok(cl.s === 200, 'closed as Rejected (stale)');
    const o2 = await prisma.leaveRequest.findUnique({ where: { id: old.id } }); ok(o2.status === 'Rejected' && /Closed as stale/.test(o2.rejectReason), 'status Rejected + reason');
    const tlOld = await get(tl, '/leave/pulse/old-pending'); ok(tlOld.s === 403, 'TL cannot see old-pending list');
    const dup = await get(hr, '/leave/pulse/duplicates'); ok(dup.s === 200, 'duplicates scan ok (' + dup.j.groups + ' groups company-wide)');
    // pending counts equal for the four views
    const g = (j, id) => j.filter((x) => x.status === 'Pending' && x.employeeId === id).length;
    const [a, b, c2, d] = await Promise.all([get(emp, '/leave?genuine=1'), get(tl, '/leave?genuine=1'), get(hr, '/leave?genuine=1'), get(hr, '/hrms/dashboard')]);
    ok(g(a.j, emp.e.id) === g(b.j, emp.e.id) && g(b.j, emp.e.id) === g(c2.j, emp.e.id) && g(a.j, emp.e.id) === 1, 'employee / TL / HR lists show the same pending count (' + [a, b, c2].map((x) => g(x.j, emp.e.id)).join('/') + ')');
    ok(d.s === 200 && typeof d.j.pendingTasks.leaveApprovals === 'number', 'dashboard tile reads genuine count ' + (d.j.pendingTasks && d.j.pendingTasks.leaveApprovals));
    const tile = await get(hr, '/hrms/dashboard/tile?tile=taskLeave');
    console.log('   tile status', tile.s, tile.j && tile.j.rows && tile.j.rows.length, 'dashboard tile figure', d.j.pendingTasks.leaveApprovals);
  } catch (e) { console.error('ERR', e); H.ok(false, 'exception ' + e.message); } finally {
    console.log('cleanup', JSON.stringify(await H.cleanup()));
    console.log(JSON.stringify(H.summary()));
    process.exit(0);
  }
})();
