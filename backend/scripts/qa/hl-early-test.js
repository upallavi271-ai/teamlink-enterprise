const H = require('./hl');
const { prisma, ok, get, post, today, addDays } = H;
const B = 'C:/Users/user/Desktop/All_Projects/teamlink-enterprise/backend/src/';
(async () => {
  const holidayIds = [];
  try {
    const E = require(B + 'utils/earlyLogoutCheck');
    const emp = await H.persona('EMP');
    const punch = (d, t, dir) => prisma.attendancePunch.create({ data: { employeeId: emp.e.id, date: d, time: t, direction: dir, method: 'Web Check-in', source: 'Web' } });
    const day = (n) => addDays('2026-09-14', n); // Mon 14 Sep 2026; -1 Sun, -2 Sat, -3 Fri, -4 Thu
    const sat = day(-2); const fri = day(-3); const thu = day(-4);
    // (a) left early on Saturday (Sunday skipped)
    await punch(sat, '09:00', 'In'); await punch(sat, '16:40', 'Out');
    let r = await E.compute(emp.e, day(0));
    ok(r.state === 'early' && r.date === sat && r.minutesEarly === 80, 'early: ' + r.text);
    ok(/left at 16:40 on 12 Sep 2026, 1 h 20 min before closing time \(18:00\)/.test(r.text), 'text has time, date, duration, closing');
    ok(r.chip === 'Early logout 1h 20m', 'chip ' + r.chip);
    ok(/Closing time 18:00/.test(r.rule), 'rule reported: ' + r.rule);
    // snapshot stays after a later punch edit
    const lv = await prisma.leaveRequest.create({ data: { employeeId: emp.e.id, type: 'Casual Leave', fromDate: day(0), toDate: day(0), days: 1, status: 'Pending' } });
    const snap = await E.snapshot(lv, emp.e);
    await prisma.attendancePunch.deleteMany({ where: { employeeId: emp.e.id, date: sat, direction: 'Out' } });
    await punch(sat, '18:45', 'Out');
    const snap2 = await E.snapshotOf(lv.id);
    const live = await E.compute(emp.e, day(0));
    ok(snap2.state === 'early' && live.state === 'ok', 'snapshot unchanged (' + snap2.state + ') while live recompute = ' + live.state);
    ok(/No early logout recorded on Sat 12 Sep \(left at 18:45\)/.test(live.text), 'not-early text: ' + live.text);
    // (c) no attendance
    await prisma.attendancePunch.deleteMany({ where: { employeeId: emp.e.id } });
    r = await E.compute(emp.e, day(0));
    ok(r.state === 'none' && /No attendance recorded on Sat 12 Sep/.test(r.text), 'no attendance: ' + r.text);
    // check-in only
    await punch(sat, '09:10', 'In');
    r = await E.compute(emp.e, day(0));
    ok(r.state === 'nocheckout', 'check-in without check-out: ' + r.text);
    await prisma.attendancePunch.deleteMany({ where: { employeeId: emp.e.id } });
    // (d) Saturday is a holiday -> look back to Friday
    const h = await prisma.holiday.create({ data: { name: 'ZZTEST holiday', date: sat, type: 'Festival' } }); holidayIds.push(h.id);
    await punch(fri, '09:00', 'In'); await punch(fri, '17:15', 'Out');
    r = await E.compute(emp.e, day(0));
    ok(r.state === 'early' && r.date === fri && r.minutesEarly === 45, 'holiday skipped -> Friday: ' + r.text);
    // (e) Friday on approved leave -> look back to Thursday
    await prisma.attendancePunch.deleteMany({ where: { employeeId: emp.e.id } });
    const al = await prisma.leaveRequest.create({ data: { employeeId: emp.e.id, type: 'Casual Leave', fromDate: fri, toDate: fri, days: 1, status: 'Approved' } });
    await punch(thu, '09:00', 'In'); await punch(thu, '18:30', 'Out');
    r = await E.compute(emp.e, day(0));
    ok(r.state === 'ok' && r.date === thu, 'leave day skipped -> Thursday: ' + r.text);
    // all 7 days leave
    await prisma.attendancePunch.deleteMany({ where: { employeeId: emp.e.id } });
    const all = await prisma.leaveRequest.create({ data: { employeeId: emp.e.id, type: 'Casual Leave', fromDate: day(-8), toDate: fri, days: 6, status: 'Approved' } });
    r = await E.compute(emp.e, day(0));
    ok(r.state === 'leave' && /On approved leave/.test(r.text), 'all leave: ' + r.text);
    await prisma.leaveRequest.deleteMany({ where: { id: { in: [lv.id, al.id, all.id] } } });
    await prisma.appSetting.deleteMany({ where: { key: `leave.early.${lv.id}` } });
    await prisma.approvalStep.deleteMany({ where: { recordId: { in: [lv.id, al.id, all.id] } } });
  } catch (e) { console.error('ERR', e); H.ok(false, 'exception ' + e.message); } finally {
    await prisma.holiday.deleteMany({ where: { id: { in: holidayIds } } });
    console.log('cleanup', JSON.stringify(await H.cleanup()));
    console.log(JSON.stringify(H.summary()));
    process.exit(0);
  }
})();
