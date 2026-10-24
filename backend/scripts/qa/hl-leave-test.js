const H = require('./hl');
const { prisma, ok, get, post, patch, put, today, addDays } = H;
(async () => {
  try {
    await prisma.integration.upsert({ where: { id: 'hrms-notify' }, update: { values: JSON.stringify({ emailsOn: true }) }, create: { id: 'hrms-notify', enabled: true, state: 'Internal', values: JSON.stringify({ emailsOn: true }) } });
    const tl = await H.persona('TL', { hrmsRole: 'TL', atsRole: 'TL' });
    const tl2 = await H.persona('TL2', { hrmsRole: 'TL', atsRole: 'TL', team: 'OTHER', dept: 'ZZTEST-Other' });
    const stl = await H.persona('STL', { hrmsRole: 'STL', atsRole: 'STL' });
    const hr = await H.persona('HR', { role: 'HR', hrmsRole: 'HR', atsRole: 'HR' });
    const emp = await H.persona('EMP', { tlName: tl.u.name, stlName: stl.u.name });
    const leaver = await H.persona('LEAVER', { empStatus: 'Exited', tlName: tl.u.name });
    console.log('chain TL=', tl.u.name);

    // 1. apply -> first approver gets bell + email once
    const from = addDays(today, 12);
    let r = await post(emp, '/leave', { type: 'Casual Leave', fromDate: from, toDate: from, reason: 'Wedding' });
    ok(r.s === 201, 'apply leave 201 ' + r.s + ' ' + JSON.stringify(r.j).slice(0, 120));
    const leaveId = r.j.id;
    await new Promise((x) => setTimeout(x, 1500));
    const steps = await prisma.approvalStep.findMany({ where: { recordId: leaveId }, orderBy: { seq: 'asc' } });
    const cur = steps.find((s) => s.status === 'Pending');
    console.log('  pending step owner:', cur && cur.approverName);
    const first = cur ? cur.approverUserId : null;
    const bells = await prisma.notification.findMany({ where: { userId: first, channel: 'In-App', title: { startsWith: 'Leave request' } } });
    const mails = await prisma.notification.findMany({ where: { userId: first, channel: 'Email', title: { startsWith: 'Leave request' } } });
    ok(bells.length === 1, 'TL got exactly 1 bell (' + bells.length + ')');
    ok(mails.length === 1, 'TL got exactly 1 email row (' + mails.length + ') status=' + (mails[0] && mails[0].status));
    ok(bells[0] && /applied for Casual Leave/.test(bells[0].message) && !/Wedding/.test(bells[0].message), 'message has no reason text');
    ok(first === tl.u.id, 'first approver is the employee\'s TL');
    console.log('   msg:', bells[0] && bells[0].message.replace(/\n/g, ' | '));

    // 2. duplicates refused
    r = await post(emp, '/leave', { type: 'Casual Leave', fromDate: from, toDate: from, reason: 'again' });
    ok(r.s === 409 && /already have Casual Leave on these dates \(Pending\)/.test(r.j.error), 'duplicate refused: ' + (r.j.error || ''));
    r = await post(emp, '/leave', { type: 'Casual Leave', fromDate: addDays(from, -1), toDate: addDays(from, 1), reason: 'overlap' });
    ok(r.s === 409, 'overlapping same type refused');

    // 3. wrong people
    r = await patch(emp, `/leave/${leaveId}/decision`, { status: 'Approved', comment: 'self' });
    ok(r.s === 403 || r.s === 401, 'employee cannot approve own (' + r.s + ')');
    r = await patch(tl2, `/leave/${leaveId}/decision`, { status: 'Approved', comment: 'x' });
    ok(r.s === 403, 'other-team TL refused (' + r.s + ')');
    r = await patch(stl, `/leave/${leaveId}/decision`, { status: 'Approved', comment: 'x' });
    ok(r.s === 403, 'STL out of turn refused (' + r.s + ')');
    r = await patch(tl, `/leave/${leaveId}/decision`, { status: 'Rejected' });
    ok(r.s === 400, 'reject without reason refused (' + r.s + ')');

    // 4. workflow card: early logout + reassign targets
    r = await get(tl, `/leave/${leaveId}/workflow`);
    ok(r.s === 200 && r.j.earlyLogout && r.j.earlyLogout.snapshot === true, 'workflow shows early-logout snapshot: ' + (r.j.earlyLogout && r.j.earlyLogout.text));
    ok(r.j.reassign && r.j.reassign.allowed && r.j.reassign.targets.length > 0, 'reassign targets: ' + (r.j.reassign && r.j.reassign.targets.map((t) => t.name + '/' + t.department).join(', ')));
    r = await get(emp, `/leave/${leaveId}/workflow`);
    ok(r.s === 200 && r.j.earlyLogout, 'applicant sees own early-logout block');
    const peer = await H.persona('PEER');
    r = await get(peer, `/leave/${leaveId}/workflow`);
    ok(r.s === 403, 'plain colleague cannot open it (' + r.s + ')');

    // 5. reassign to HR (no reason)
    r = await post(tl, `/leave/${leaveId}/reassign`, { toUserId: hr.u.id });
    ok(r.s === 200, 'reassign without reason ok ' + r.s + ' ' + JSON.stringify(r.j).slice(0, 100));
    await new Promise((x) => setTimeout(x, 1000));
    const hb = await prisma.notification.count({ where: { userId: hr.u.id, channel: 'In-App', title: { startsWith: 'Leave request handed to you' } } });
    const hm = await prisma.notification.count({ where: { userId: hr.u.id, channel: 'Email', title: { startsWith: 'Leave request handed to you' } } });
    const tb = await prisma.notification.count({ where: { userId: emp.u.id, title: 'Your leave request is with someone else now' } });
    ok(hb === 1 && hm === 1, 'new approver bell+mail (' + hb + '/' + hm + ')'); ok(tb === 1, 'employee told it moved');
    r = await post(tl, `/leave/${leaveId}/reassign`, { toUserId: stl.u.id });
    ok(r.s === 403, 'old owner cannot reassign again (' + r.s + ')');

    // 6. leaver pending & genuine counts
    const lv = await prisma.leaveRequest.create({ data: { employeeId: leaver.e.id, type: 'Casual Leave', fromDate: addDays(today, 3), toDate: addDays(today, 3), days: 1, status: 'Pending' } });
    const genuine = require('C:/Users/user/Desktop/All_Projects/teamlink-enterprise/backend/src/utils/leaveGenuine');
    const b = await genuine.pendingBuckets({ employeeIds: [leaver.e.id, emp.e.id] });
    ok(b.leaver.length === 1 && b.genuine.length === 1, 'buckets: leaver 1, genuine 1 (' + b.leaver.length + '/' + b.genuine.length + ')');
    // old pending
    const old = await prisma.leaveRequest.create({ data: { employeeId: emp.e.id, type: 'Sick Leave', fromDate: addDays(today, -200), toDate: addDays(today, -200), days: 1, status: 'Pending' } });
    const b2 = await genuine.pendingBuckets({ employeeIds: [emp.e.id] });
    ok(b2.old.length === 1, 'old pending detected');
    // four views agree on genuine count
    const mineList = await get(emp, '/leave?genuine=1');
    const tlList = await get(tl, '/leave?genuine=1');
    const hrList = await get(hr, '/leave?genuine=1');
    const cnt = (j) => j.filter((x) => x.status === 'Pending' && [emp.e.id].includes(x.employeeId)).length;
    ok(cnt(mineList.j) === 1 && cnt(tlList.j) === 1 && cnt(hrList.j) === 1, `employee/TL/HR lists agree on genuine pending (${cnt(mineList.j)}/${cnt(tlList.j)}/${cnt(hrList.j)})`);
    const dash = await get(hr, '/hrms/dashboard');
    console.log('   dash status', dash.s, dash.j && dash.j.pendingTasks && JSON.stringify(dash.j.pendingTasks).slice(0, 200));
    await prisma.leaveRequest.deleteMany({ where: { id: { in: [lv.id, old.id] } } });
  } catch (e) { console.error('ERR', e); H.ok(false, 'exception ' + e.message); } finally {
    console.log('cleanup', JSON.stringify(await H.cleanup()));
    console.log(JSON.stringify(H.summary()));
    process.exit(0);
  }
})();
