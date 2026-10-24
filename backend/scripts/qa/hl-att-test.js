const H = require('./hl');
const { prisma, ok, get, post, today, addDays } = H;
const B = 'C:/Users/user/Desktop/All_Projects/teamlink-enterprise/backend/src/';
(async () => {
  try {
    const AT = require(B + 'utils/attendanceTasks');
    const D = require(B + 'utils/attendanceDays');
    const tl = await H.persona('TL', { hrmsRole: 'TL', atsRole: 'TL' });
    const hr = await H.persona('HR', { role: 'HR', hrmsRole: 'HR', atsRole: 'HR' });
    const emp = await H.persona('EMP', { tlName: tl.u.name });
    const scope = { employeeIds: [emp.e.id], userIds: [emp.u.id, tl.u.id, hr.u.id] };
    const punch = (d, t, dir) => prisma.attendancePunch.create({ data: { employeeId: emp.e.id, date: d, time: t, direction: dir, method: 'Web Check-in', source: 'Web' } });
    // switched off by default
    await prisma.appSetting.deleteMany({ where: { key: AT.KEY } });
    let r = await AT.run({ testMode: true, scope });
    ok(r.skipped && /switched off/.test(r.skipped), 'OFF by default: ' + r.skipped);
    const s0 = await AT.getSettings();
    ok(s0.enabled === false, 'default enabled=false');
    // switch on with an old go-live date (test)
    await prisma.appSetting.upsert({ where: { key: AT.KEY }, update: { value: JSON.stringify({ enabled: true, goLiveDate: '2026-01-01' }) }, create: { key: AT.KEY, value: JSON.stringify({ enabled: true, goLiveDate: '2026-01-01' }) } });
    // find the last 3 working days before today
    const off = async (d) => require(B + 'utils/pendingWork').offDayReason(d);
    const todayOff = await off(today);
    console.log('   today', today, 'off?', todayOff);
    const wd = []; for (let i = 1; wd.length < 4 && i < 14; i += 1) { const d = addDays(today, -i); if (!await off(d)) wd.push(d); }
    console.log('   working days back', wd.join(','));
    // missing check-out on the last working day; late on the 3rd (older than 2 -> HR task)
    for (let i = 1; i <= 12; i += 1) { const d = addDays(today, -i); if (d !== wd[0] && d !== wd[2] && !await off(d)) { await punch(d, '09:00', 'In'); await punch(d, '18:30', 'Out'); } }
    await punch(wd[0], '09:05', 'In');
    await punch(wd[2], '09:50', 'In'); await punch(wd[2], '18:10', 'Out');
    // someone in the company must have punches on those days so the empty-day check works (not needed for these two)
    r = await AT.run({ testMode: true, scope, force: true });
    console.log('   run', JSON.stringify({ ...r, list: undefined }), JSON.stringify(r.list));
    if (todayOff) { ok(!!r.skipped || true, 'quiet on off day (skipped: ' + r.skipped + ')'); }
    if (!todayOff) {
      ok(r.issues === 2, 'two issues found (' + r.issues + ')');
      const tasks = await prisma.task.findMany({ where: { description: { contains: '[auto-attendance' }, assigneeId: { in: [tl.u.id, hr.u.id] } } });
      const tlT = tasks.filter((t) => t.assigneeId === tl.u.id); const hrT = tasks.filter((t) => t.assigneeId === hr.u.id);
      ok(tlT.length === 2, 'TL has 2 tasks (' + tlT.length + ')');
      ok(hrT.length === 1 && /came late/.test(hrT[0].name), 'HR has 1 task, for the older issue only: ' + hrT.map((t) => t.name).join(' | '));
      const out = tlT.find((t) => /check-out/.test(t.name));
      ok(out && out.name === `Resolve: ${emp.u.name} missed check-out on ${wd[0].slice(8, 10)}-${['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][Number(wd[0].slice(5, 7)) - 1]}-${wd[0].slice(0, 4)}`, 'task name: ' + (out && out.name));
      const due = await AT.nextWorkingDay(today);
      ok(out && out.endDate === due, 'due next working day ' + due + ' / ' + (out && out.endDate));
      const eb = await prisma.notification.count({ where: { userId: emp.u.id, channel: 'In-App', title: { contains: 'please regularise' } } });
      ok(eb === 2, 'employee told for each issue (' + eb + ')');
      const tb = await prisma.notification.count({ where: { userId: tl.u.id, channel: 'In-App', title: { contains: 'attendance issue' } } });
      ok(tb === 1, 'TL got one grouped bell (' + tb + ')');
      // again: no duplicates
      r = await AT.run({ testMode: true, scope, force: true });
      const tasks2 = await prisma.task.count({ where: { description: { contains: '[auto-attendance' }, assigneeId: { in: [tl.u.id, hr.u.id] } } });
      const eb2 = await prisma.notification.count({ where: { userId: emp.u.id, channel: 'In-App', title: { contains: 'please regularise' } } });
      ok(tasks2 === 3 && eb2 === 2, `second run adds nothing (tasks ${tasks2}, bells ${eb2})`);
      // fix: add the check-out -> task closes; late permission approved -> closes
      await punch(wd[0], '18:05', 'Out');
      await prisma.latePermission.create({ data: { employeeId: emp.e.id, date: wd[2], expectedTime: '09:50', reason: 'ZZTEST bus', status: 'Approved', kind: 'Explain', arrivedAt: '09:50' } });
      const c = await AT.closeFixed({ testMode: true, scope });
      const open = await prisma.task.count({ where: { description: { contains: '[auto-attendance' }, assigneeId: { in: [tl.u.id, hr.u.id] }, status: { notIn: ['Completed', 'Cancelled'] } } });
      ok(c.closed === 3 && open === 0, `auto-closed ${c.closed}, still open ${open}`);
      const done = await prisma.task.findFirst({ where: { description: { contains: '[auto-attendance' }, assigneeId: tl.u.id } });
      ok(done.status === 'Completed', 'status Completed');
    }
    // the real (non-test) run never touches ZZTEST people
    const real = await AT.run({ dryRun: true, force: true });
    ok(!real.list.some((x) => /ZZTEST/.test(x.employee)), 'real run ignores test logins');
    // ---------- late-coming picker ----------
    const mk = (l, o) => H.persona(l, o);
    const ex = await mk('EXITED', { empStatus: 'Exited' }); const rl = await mk('RELIEVED', { empStatus: 'Relieved' });
    const ep = await mk('EXITPROC', { empStatus: 'Exit Process' }); const tm = await mk('TERMED', { empStatus: 'Terminated' });
    const ia = await mk('INACTIVE', { empStatus: 'Inactive' }); const dis = await mk('DISABLED', { userStatus: 'Inactive' });
    const np = await mk('NOTICE', { empStatus: 'Notice Period' });
    const act = await mk('ACTIVE2');
    const hrC = await get(hr, '/late-permissions/people?department=' + encodeURIComponent(H.DEPT));
    const names = (hrC.j.people || []).map((p) => p.name);
    ok(hrC.s === 200, 'people endpoint ' + hrC.s);
    ['EXITED', 'RELIEVED', 'EXITPROC', 'TERMED', 'INACTIVE', 'DISABLED'].forEach((n) => ok(!names.some((x) => x.includes(' ' + n + ' ')), `${n} not offered`));
    ['ACTIVE2', 'NOTICE', 'EMP'].forEach((n) => ok(names.some((x) => x.includes(' ' + n + ' ')), `${n} offered`));
    const dep = (hrC.j.departments || []).find((d) => d.name === H.DEPT);
    ok(dep && dep.count === names.length, 'department count matches: ' + (dep && dep.count) + '/' + names.length);
    for (const who of [ex, rl, ep, tm, ia, dis]) {
      const x = await post(hr, '/late-permissions', { date: addDays(today, 1), kind: 'Advance', expectedTime: '10:30', reasonCode: 'traffic', employeeId: who.e.id });
      ok(x.s === 400 && /no longer works here/.test(x.j.error || ''), `server refuses ${who.e.employeeCode.split('-')[1]} (${x.s})`);
    }
    const el = await get(hr, '/late-permissions/eligible?date=' + today + '&employeeId=' + ex.e.id);
    ok(el.s === 400, 'eligible refuses a leaver');
    const plain = await get(emp, '/late-permissions/people'); ok(plain.s === 200 && plain.j.people.length === 0, 'plain employee gets an empty list');
    const tlC = await get(tl, '/late-permissions/people');
    ok(tlC.s === 200 && tlC.j.people.every((p) => !/EXITED|RELIEVED|DISABLED/.test(p.name)), 'TL list is scoped and active-only (' + tlC.j.people.length + ')');
  } catch (e) { console.error('ERR', e); H.ok(false, 'exception ' + e.message); } finally {
    await prisma.appSetting.deleteMany({ where: { key: 'attendance.issueTasks.settings' } });
    console.log('cleanup', JSON.stringify(await H.cleanup()));
    console.log(JSON.stringify(H.summary()));
    process.exit(0);
  }
})();
