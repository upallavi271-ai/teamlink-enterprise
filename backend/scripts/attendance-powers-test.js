#!/usr/bin/env node
// ---------------------------------------------------------------------------
// FOUNDER 2026-10-26 ATTENDANCE + LEAVE ITEMS. SANDBOX ONLY.
//   1 a "Leave" mark in Daily marking · 4 "who else is on leave" while applying · 5 a device punch after a web check-in is an
//   interval, not a check-out · 6 the day locks at the check-out, only the Super Admin unlocks it · 7 times changed by the Super
//   Admin, and by HR only when the Super Admin allows it.
//   cd backend && npm run sandbox -- --restart --detach --no-watch && TL_API=http://localhost:4011 node scripts/attendance-powers-test.js
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('APW');

(async () => {
  const { prisma } = Z;
  const DAY = '2026-10-19';
  const KEY = 'attendance.hrTimeEdit';
  const before = await prisma.appSetting.findUnique({ where: { key: KEY } });
  const empIds = [];
  try {
    const { webPunchGuard, unlockKey } = require('../src/utils/punchGuard'); // eslint-disable-line global-require
    const { settledDirections } = require('../src/utils/biometricDevice'); // eslint-disable-line global-require
    const mk = (tag, role, dept, team) => Z.mkUser(tag, { role, hrmsRole: role, hrmsAccess: true, atsRole: 'NONE', atsAccess: false }, { designation: 'Executive', department: dept, team });
    const hr = await mk('hr', 'HR', 'HR');
    const emp = await mk('emp', 'EMPLOYEE', 'Medical', 'ZZTEST APW team');
    const mate = await mk('mate', 'EMPLOYEE', 'Medical', 'ZZTEST APW team');
    const sa = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN', status: 'Active', employee: { isNot: null } } });
    const eEmp = await prisma.employee.findFirst({ where: { userId: emp.id } });
    const mEmp = await prisma.employee.findFirst({ where: { userId: mate.id } });
    empIds.push(eEmp.id, mEmp.id);
    const hTok = await Z.mint(hr); const eTok = await Z.mint(emp); const sTok = await Z.mint(sa);
    const setting = (tok, on) => Z.call('PUT', '/api/attendance/time-edit-setting', tok, { hrMayEdit: on });
    const times = (tok, ci, co) => Z.call('POST', '/api/attendance', tok, { employeeId: eEmp.id, date: DAY, status: 'Present', checkIn: ci, checkOut: co, timesEdit: true, reason: 'ZZTEST APW' });

    // 7 — times
    const off = await setting(sTok, false);
    const g1 = await Z.call('GET', '/api/attendance/time-edit-setting', hTok);
    Z.check('T1 Super Admin turns "HR may change times" off; HR then may not change times', off.status === 200 && g1.body.mayEditTimes === false && g1.body.canChangeSetting === false, [off.status, g1.text.slice(0, 160)]);
    const h1 = await times(hTok, '09:10', '18:20');
    Z.check('T2 HR changing times without the Super Admin\'s permission is refused (403)', h1.status === 403, h1.status);
    const hp = await setting(hTok, true); const ep = await setting(eTok, true);
    Z.check('T3 only the Super Admin flips the permission (HR 403, employee 403)', hp.status === 403 && ep.status === 403, [hp.status, ep.status]);
    const on = await setting(sTok, true);
    const g2 = await Z.call('GET', '/api/attendance/time-edit-setting', hTok);
    const h2 = await times(hTok, '09:10', '18:20');
    const row = await prisma.attendance.findFirst({ where: { employeeId: eEmp.id, date: DAY } });
    Z.check('T4 with permission on, HR changes the times and they are saved with who set them', on.status === 200 && g2.body.mayEditTimes === true && (h2.status === 200 || h2.status === 201) && row && row.checkIn === '09:10' && row.checkOut === '18:20' && !!row.timesSetBy, [h2.status, row && [row.checkIn, row.checkOut, row.timesSetBy]]);
    const bad = await times(sTok, '9.10', '18:20'); const back = await times(sTok, '18:00', '09:00');
    Z.check('T5 a wrong time (400) and an out before the in (400) are refused', bad.status === 400 && back.status === 400, [bad.status, back.status]);
    const s1 = await times(sTok, '09:05', '18:30');
    Z.check('T6 the Super Admin changes times', (s1.status === 200 || s1.status === 201), s1.status);
    const sneaky = await Z.call('POST', '/api/attendance', eTok, { employeeId: eEmp.id, date: DAY, status: 'Present', checkIn: '09:00' });
    const still = await prisma.attendance.findFirst({ where: { employeeId: eEmp.id, date: DAY } });
    Z.check('T7 the person\'s own mark cannot overwrite times the Super Admin / HR set', sneaky.status === 403 && still.checkIn === '09:05', [sneaky.status, still.checkIn]);
    const aud = await prisma.auditLog.count({ where: { action: 'Attendance times changed', entityId: row.id } });
    Z.check('T8 every time change is written down', aud >= 2, aud);

    // 1 — Leave mark
    const lv = await Z.call('POST', '/api/attendance', hTok, { employeeId: mEmp.id, date: DAY, status: 'On Leave' });
    const lr = await prisma.attendance.findFirst({ where: { employeeId: mEmp.id, date: DAY } });
    Z.check('L1 HR marks a person "On Leave" from Daily marking', (lv.status === 200 || lv.status === 201) && lr && lr.status === 'On Leave', [lv.status, lr && lr.status]);

    // 6 — the day locks at the check-out
    const D6 = '2026-10-20';
    const p = (time, direction, method) => prisma.attendancePunch.create({ data: { employeeId: eEmp.id, date: D6, time, direction, method, source: method === 'Biometric' ? 'Biometric device' : 'Web' } });
    await p('09:00', 'In', 'Web Check-in'); await new Promise((r) => setTimeout(r, 20)); await p('18:00', 'Out', 'Web Check-in');
    const k1 = await webPunchGuard(prisma, eEmp.id, D6, 'In');
    Z.check('F1 after their own check-out a new check-in is refused: DAY_LOCKED', k1.ok === false && k1.code === 'DAY_LOCKED', k1);
    const hu = await Z.call('POST', '/api/attendance/day-unlock', hTok, { employeeId: eEmp.id, date: D6 });
    Z.check('F2 HR cannot unlock the day (only the Super Admin)', hu.status === 403, hu.status);
    const su = await Z.call('POST', '/api/attendance/day-unlock', sTok, { employeeId: eEmp.id, date: D6, reason: 'ZZTEST APW forgot the laptop' });
    const k2 = await webPunchGuard(prisma, eEmp.id, D6, 'In');
    Z.check('F3 the Super Admin unlocks it and the person can check in again', su.status === 200 && k2.ok === true, [su.status, k2]);
    await new Promise((r) => setTimeout(r, 20)); await p('19:00', 'In', 'Web Check-in'); await new Promise((r) => setTimeout(r, 20)); await p('20:00', 'Out', 'Web Check-in');
    const k3 = await webPunchGuard(prisma, eEmp.id, D6, 'In');
    Z.check('F4 one unlock = one more check-in; the next check-out locks the day again', k3.ok === false && k3.code === 'DAY_LOCKED', k3.code);

    // 5 — the key pressed on the device decides In / Out (owner 2026-10-26)
    let n = 0;
    const P = (time, method, direction = 'In', deviceState = null) => ({ id: `p${n += 1}`, time, method, direction, deviceState });
    const dirs = (ps) => { const w = settledDirections(ps); return ps.map((x) => w.get(x.id) || x.direction).join(' '); };
    Z.check('B1 web check-in 9:00 + device Check-In 9:05 = two check-ins (In In), not a check-out', dirs([P('09:00', 'Web Check-in'), P('09:05', 'Biometric', 'Out', '0')]) === 'In In');
    Z.check('B2 device Check-In / Break-Out / Break-In / Check-Out = In Out In Out', dirs([P('09:00', 'Biometric', 'Out', '0'), P('13:00', 'Biometric', 'In', '2'), P('13:45', 'Biometric', 'Out', '3'), P('18:30', 'Biometric', 'In', '1')]) === 'In Out In Out');
    Z.check('B3 Check-In pressed twice (9:19, 10:10) stays two check-ins — no check-out', dirs([P('09:19', 'Biometric', 'In', '0'), P('10:10', 'Biometric', 'Out', '0')]) === 'In In');
    Z.check('B4 a web punch keeps its own direction; a device punch with no state keeps its own', dirs([P('09:00', 'Web Check-in'), P('18:00', 'Web Check-in', 'Out'), P('18:05', 'Biometric', 'Out')]) === 'In Out Out');

    // 4 — who else is on leave
    await prisma.leaveRequest.create({ data: { employeeId: mEmp.id, type: 'Casual', fromDate: '2026-11-02', toDate: '2026-11-03', days: 2, status: 'Approved', reason: 'ZZTEST APW' } });
    const w = await Z.call('GET', '/api/leave/who-else?from=2026-11-03&to=2026-11-04', eTok);
    const names = [...((w.body && w.body.team) || []), ...((w.body && w.body.department) || [])].map((x) => x.name);
    Z.check('W1 applying for leave shows who in the team / department is on leave those days', w.status === 200 && names.includes(mate.name) && !names.includes(emp.name), [w.status, names]);
    const w2 = await Z.call('GET', '/api/leave/who-else?from=2026-11-10&to=2026-11-11', eTok);
    Z.check('W2 nobody listed when nobody is away', w2.status === 200 && w2.body.team.length === 0 && w2.body.department.length === 0, w2.text.slice(0, 160));
    // the department cap is a reminder, not a block (founder 2026-10-26)
    const cfg = await prisma.hrConfig.findFirst();
    const capBefore = cfg ? { concurrentLeaveCapFlat: cfg.concurrentLeaveCapFlat, concurrentLeaveCapPct: cfg.concurrentLeaveCapPct } : null;
    if (cfg) await prisma.hrConfig.update({ where: { id: cfg.id }, data: { concurrentLeaveCapFlat: 1, concurrentLeaveCapPct: 100 } });
    try {
      const types = await Z.call('GET', '/api/leave/availability', eTok);
      const list = (types.body && (types.body.types || types.body.rows || types.body)) || [];
      const pick = (Array.isArray(list) ? list : []).find((t) => Number(t.available ?? t.remaining ?? 0) >= 1);
      const typeName = pick ? (pick.type || pick.name || pick.code) : 'Casual';
      const ap = await Z.call('POST', '/api/leave', eTok, { type: typeName, fromDate: '2026-11-03', toDate: '2026-11-03', reason: 'ZZTEST APW hospital' });
      Z.check('W3 a colleague away does NOT stop the apply: saved, with a reminder', ap.status === 201 && /on leave at once/.test(ap.body.teamNotice || ''), [ap.status, ap.text.slice(0, 220)]);
    } finally { if (cfg) await prisma.hrConfig.update({ where: { id: cfg.id }, data: capBefore }); }
  } catch (e) { Z.fail += 1; console.log('FAIL  crashed', e && e.stack ? e.stack.slice(0, 900) : e); } finally {
    try {
      if (before) await prisma.appSetting.update({ where: { key: KEY }, data: { value: before.value } });
      else await prisma.appSetting.deleteMany({ where: { key: KEY } });
    } catch (e) { console.log('setting restore problem', String(e.message).slice(0, 160)); }
    for (const m of ['attendancePunch', 'attendance', 'leaveRequest', 'leaveBalance']) {
      try { await prisma[m].deleteMany({ where: { employeeId: { in: empIds } } }); } catch (e) { if (!/undefined|Unknown/.test(e.message)) console.log('cleanup', m, String(e.message).slice(0, 120)); } // eslint-disable-line no-await-in-loop
    }
    await Z.cleanup([
      (pr) => pr.appSetting.deleteMany({ where: { key: { startsWith: 'attendance.unlock.' }, value: { contains: 'ZZTEST APW' } } }),
      (pr) => pr.auditLog.deleteMany({ where: { OR: [{ reason: { contains: 'ZZTEST APW' } }, { entityId: KEY, createdAt: { gte: new Date(Date.now() - 3600000) }, actorName: { not: null } }] } }),
    ]).catch((e) => console.log('cleanup problem', String(e.message).slice(0, 160)));
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();
