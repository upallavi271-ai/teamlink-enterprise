#!/usr/bin/env node
/* eslint-disable no-console, no-await-in-loop */
// ---------------------------------------------------------------------------
// FOUNDER 2026-10-28: "hr manual ga leave ani pettina ahh leave approve kakapothey pending ane ravali and tl's ki matram directga
// superadmin approval estey ne approve, hr echina pending ane ravali". SANDBOX ONLY (a copy of the database).
//   R1  a day HR marks "Leave" by hand is a PENDING leave (a leave request on the chain) until it is approved
//   R2  a TL's leave: HR's approval sends it to the Super Admin (still Pending); only the Super Admin's approval grants it
//   R3  scripts/tl-leaves-to-pending.js puts a TL leave approved by HR back to Pending (Super Admin waiting), leaves a Super Admin
//       approval alone, raises a Pending request for a hand-marked Leave day
//   TL_API=http://localhost:<port> TL_TEST_DB=<copy>.db node scripts/leave-hr-mark-tl-sa-test.js
// ---------------------------------------------------------------------------
const path = require('path');
const { execFileSync } = require('child_process');
const fs = require('fs');
const Z = require('./lib/zzfix')('LHM');
const D = require('../src/utils/attendanceDays');

(async () => {
  const { prisma } = Z;
  const leaveIds = [];
  try {
    // ---- the classifier on its own: a hand mark is not an approved leave ----
    const cfg = { graceTime: '09:15', workStart: '09:00', workEnd: '18:00' };
    const marked = D.classifyDay({ preview: true, date: '2026-10-27', today: '2026-10-28', cfg, record: { status: 'On Leave' }, punches: [] });
    Z.check('U1 a day marked On Leave with no approved leave reads Leave Under Review (pending), not On Leave', marked.status === D.STATUS.LEAVE_REVIEW && marked.pending === 1 && !marked.leave, [marked.status, marked.pending, marked.leave]);
    const markedOk = D.classifyDay({ date: '2026-10-27', today: '2026-10-28', cfg, record: { status: 'On Leave' }, punches: [], leave: { id: 'x', type: 'Casual Leave', half: null, unpaid: false } });
    const legacy = D.classifyDay({ date: '2026-10-27', today: '2026-10-28', cfg, record: { status: 'Leave' }, punches: [] });
    Z.check('U1b the old rule too: a Leave mark alone is pending', legacy.status === D.STATUS.LEAVE_REVIEW && !legacy.leave, [legacy.status]);
    Z.check('U2 the same day with the leave approved reads On Leave', markedOk.status === 'On Leave' && markedOk.leave === 1, [markedOk.status]);

    const mk = (tag, role, designation = 'Executive') => Z.mkUser(tag, { role, hrmsRole: role, hrmsAccess: true, atsRole: 'NONE', atsAccess: false }, { designation, department: 'R&D' });
    const hr = await mk('hr', 'HR');
    const sa = await mk('sa', 'SUPER_ADMIN');
    const tl = await mk('tl', 'TL', 'Team Lead');
    const emp = await mk('emp', 'EMPLOYEE');
    const eTl = await prisma.employee.findFirst({ where: { userId: tl.id } });
    const eEmp = await prisma.employee.findFirst({ where: { userId: emp.id } });
    const T = { hr: await Z.mint(hr), sa: await Z.mint(sa) };
    const stepsOf = async (id) => Object.fromEntries((await prisma.approvalStep.findMany({ where: { recordId: id, workflow: 'leave' } })).map((s) => [s.level, s.status]));
    // approve, answering the "approval reason" question when the server asks for one
    const approve = async (id, tok) => {
      let r = await Z.call('PATCH', `/api/leave/${id}/decision`, tok, { status: 'Approved', comment: 'ZZTEST LHM ok' });
      if (r.status === 400 && r.body && r.body.reasons) r = await Z.call('PATCH', `/api/leave/${id}/decision`, tok, { status: 'Approved', comment: 'ZZTEST LHM ok', approvalReason: r.body.reasons[0] });
      return r;
    };
    // a request with a known chain: Applied -> TL (skipped / pending) -> HR -> Super Admin, all required
    const mkLeave = async (e, applicant, from, to, days, { tlStep = 'Skipped' } = {}) => {
      const lv = await prisma.leaveRequest.create({ data: { employeeId: e.id, type: 'Casual Leave', fromDate: from, toDate: to, days, status: 'Pending', reason: 'ZZTEST LHM' } });
      leaveIds.push(lv.id);
      const step = (level, seq, user, status) => ({ workflow: 'leave', recordId: lv.id, level, seq, mode: 'required', approverUserId: user ? user.id : null, approverName: user ? user.name : null, status, activatedAt: status === 'Pending' ? new Date() : null });
      await prisma.approvalStep.createMany({ data: [
        { workflow: 'leave', recordId: lv.id, level: 'EMPLOYEE', seq: 1, mode: 'applicant', approverUserId: applicant.id, approverName: applicant.name, status: 'Applied' },
        step('TL', 2, tlStep === 'Skipped' ? null : tl, tlStep),
        step('HR', 4, hr, tlStep === 'Pending' ? 'Waiting' : 'Pending'),
        step('SUPER_ADMIN', 7, sa, 'Waiting'),
      ] });
      return lv;
    };

    // ---- R2: a TL's leave ----
    const a = await mkLeave(eTl, tl, '2026-11-16', '2026-11-16', 1);
    const r1 = await approve(a.id, T.hr);
    const a1 = await prisma.leaveRequest.findUnique({ where: { id: a.id } });
    const s1 = await stepsOf(a.id);
    Z.check('T1 HR approves a TL\'s leave: it stays Pending and says "Sent to the Super Admin for final approval"', r1.status === 200 && a1.status === 'Pending' && r1.body.sentToSuperAdmin === true && /Sent to the Super Admin for final approval/.test(r1.body.message || ''), [r1.status, r1.text.slice(0, 200), a1.status]);
    Z.check('T2 the chain: HR Approved, Super Admin Pending now', s1.HR === 'Approved' && s1.SUPER_ADMIN === 'Pending', s1);
    const r2 = await approve(a.id, T.hr);
    Z.check('T3 HR approving again is refused (only the Super Admin can approve it now)', r2.status === 409 && (await prisma.leaveRequest.findUnique({ where: { id: a.id } })).status === 'Pending', [r2.status, r2.text.slice(0, 160)]);
    const list = await Z.call('GET', '/api/hrms/dashboard/list?tile=taskLeave', T.sa);
    const row = list.body && Array.isArray(list.body.rows) ? list.body.rows.find((x) => x.reqId === a.id) : null;
    Z.check('T4 the Super Admin sees it in Pending tasks with Approve / Reject (their turn)', !!row && row.myTurn === true && /Super Admin/.test(row.chain || ''), [list.status, row && row.myTurn, row && row.chain]);
    const r3 = await approve(a.id, T.sa);
    const a2 = await prisma.leaveRequest.findUnique({ where: { id: a.id } });
    Z.check('T5 the Super Admin approves: Approved', r3.status === 200 && a2.status === 'Approved' && a2.decidedBy === sa.name, [r3.status, r3.text.slice(0, 160), a2.status, a2.decidedBy]);

    const b = await mkLeave(eTl, tl, '2026-11-17', '2026-11-17', 1);
    const r4 = await approve(b.id, T.sa);
    const b1 = await prisma.leaveRequest.findUnique({ where: { id: b.id } });
    Z.check('T6 the Super Admin approves a TL\'s leave directly while it is still with HR: Approved', r4.status === 200 && b1.status === 'Approved', [r4.status, r4.text.slice(0, 160), b1.status]);

    const c = await mkLeave(eTl, tl, '2026-11-18', '2026-11-18', 1);
    const r5 = await Z.call('PATCH', `/api/leave/${c.id}/decision`, T.hr, { status: 'Rejected', rejectReason: 'ZZTEST LHM no' });
    Z.check('T7 HR can still reject a TL\'s leave (unchanged)', r5.status === 200 && (await prisma.leaveRequest.findUnique({ where: { id: c.id } })).status === 'Rejected', [r5.status, r5.text.slice(0, 160)]);

    const d = await mkLeave(eEmp, emp, '2026-11-19', '2026-11-19', 1);
    const r6 = await approve(d.id, T.hr);
    const d1 = await prisma.leaveRequest.findUnique({ where: { id: d.id } });
    Z.check('T8 a normal employee\'s leave: HR\'s approval still grants it (unchanged)', r6.status === 200 && d1.status === 'Approved' && !r6.body.sentToSuperAdmin, [r6.status, r6.text.slice(0, 160), d1.status]);

    // ---- R1: HR marks a day "Leave" by hand ----
    const DAY = '2026-10-27';
    const m1 = await Z.call('POST', '/api/attendance', T.hr, { employeeId: eEmp.id, date: DAY, status: 'On Leave' });
    const lr = m1.body && m1.body.leaveRequest;
    if (lr && lr.id) leaveIds.push(lr.id);
    const req1 = lr ? await prisma.leaveRequest.findUnique({ where: { id: lr.id } }) : null;
    Z.check('M1 HR marks Leave: the mark is saved and a PENDING leave request is raised for that day', (m1.status === 201) && m1.body.status === 'On Leave' && req1 && req1.status === 'Pending' && req1.fromDate === DAY && lr.created === true, [m1.status, m1.text.slice(0, 240)]);
    Z.check('M2 the answer says "Pending - waiting for ..."', /Pending - waiting for /.test(m1.body.message || ''), m1.body.message);
    Z.check('M3 the request is on the approval chain', req1 && Object.keys(await stepsOf(req1.id)).length > 1, req1 && await stepsOf(req1.id));
    const dayOf = async (date) => { const r = await Z.call('GET', `/api/attendance/dashboard?date=${date}`, T.hr); return ((r.body && r.body.marking) || []).find((x) => x.employeeId === eEmp.id) || {}; };
    const day1 = await dayOf(DAY);
    Z.check('M4 the day reads Leave Under Review (pending), not On Leave', day1.dayStatus === D.STATUS.LEAVE_REVIEW && day1.status === 'On Leave', [day1.dayStatus, day1.status]);
    const m2 = await Z.call('POST', '/api/attendance', T.hr, { employeeId: eEmp.id, date: DAY, status: 'On Leave' });
    const cnt = await prisma.leaveRequest.count({ where: { employeeId: eEmp.id, fromDate: DAY } });
    Z.check('M5 marking the same day again raises no second request', m2.status === 201 && m2.body.leaveRequest && m2.body.leaveRequest.created === false && cnt === 1, [m2.status, cnt]);
    const ok = await approve(req1.id, T.sa);
    const day2 = await dayOf(DAY);
    Z.check('M6 once approved, the day reads On Leave', ok.status === 200 && day2.dayStatus === 'On Leave', [ok.status, ok.text.slice(0, 120), day2.dayStatus]);

    const DAY2 = '2026-10-26';
    const m3 = await Z.call('POST', '/api/attendance', T.hr, { employeeId: eEmp.id, date: DAY2, status: 'On Leave' });
    const lr2 = m3.body && m3.body.leaveRequest;
    if (lr2 && lr2.id) leaveIds.push(lr2.id);
    const no = lr2 ? await Z.call('PATCH', `/api/leave/${lr2.id}/decision`, T.sa, { status: 'Rejected', rejectReason: 'ZZTEST LHM was at work' }) : { status: 0, text: 'no request' };
    const rec2 = await prisma.attendance.findFirst({ where: { employeeId: eEmp.id, date: DAY2 } });
    const day3 = await dayOf(DAY2);
    Z.check('M7 the marked leave rejected: the Leave mark goes and the day is not leave any more', no.status === 200 && !rec2 && day3.dayStatus !== 'On Leave' && day3.dayStatus !== D.STATUS.LEAVE_REVIEW, [no.status, no.text.slice(0, 120), rec2 && rec2.status, day3.dayStatus]);

    // ---- R3: the data script (founder's live case: Renuka / Leela Usha approved by HR on 27 Oct -> Pending; Durga approved by the Super Admin stays) ----
    const SDAY = '2026-10-23';
    const FROMD = '2026-10-21';
    const old = await mkLeave(eTl, tl, SDAY, SDAY, 1);
    await prisma.approvalStep.updateMany({ where: { recordId: old.id, level: 'HR' }, data: { status: 'Approved', actedByUserId: hr.id, actedByName: hr.name, actedAt: new Date() } });
    await prisma.approvalStep.updateMany({ where: { recordId: old.id, level: 'SUPER_ADMIN' }, data: { status: 'Visibility', note: 'Not needed - approved by HR. Shown for information.' } });
    await prisma.leaveRequest.update({ where: { id: old.id }, data: { status: 'Approved', decidedBy: hr.name, decidedAt: new Date() } });
    const bySa = await mkLeave(eTl, tl, '2026-10-22', '2026-10-22', 1);
    await prisma.approvalStep.updateMany({ where: { recordId: bySa.id, level: 'HR' }, data: { status: 'Skipped', note: 'Skipped — decided directly by Super Admin' } });
    await prisma.approvalStep.updateMany({ where: { recordId: bySa.id, level: 'SUPER_ADMIN' }, data: { status: 'Approved', actedByUserId: sa.id, actedByName: sa.name, actedAt: new Date(), direct: true } });
    await prisma.leaveRequest.update({ where: { id: bySa.id }, data: { status: 'Approved', decidedBy: sa.name, decidedAt: new Date() } });
    const handMark = await prisma.attendance.create({ data: { employeeId: eEmp.id, date: '2026-10-21', status: 'On Leave' } });
    const db = process.env.TL_TEST_DB;
    const run = (...extra) => execFileSync(process.execPath, [path.join(__dirname, 'tl-leaves-to-pending.js'), '--db', path.join(__dirname, '..', 'prisma', db), '--from', FROMD, ...extra], { encoding: 'utf8' });
    const dry = run();
    const listed = (txt, date) => txt.split('\n').some((l) => l.includes(eTl.employeeCode) && l.includes(`Casual Leave ${date} (`));
    Z.check('S1 dry run lists the TL leave approved by HR (not the one the Super Admin approved), changes nothing', listed(dry, SDAY) && !listed(dry, '2026-10-22') && /DRY RUN/.test(dry) && (await prisma.leaveRequest.findUnique({ where: { id: old.id } })).status === 'Approved', dry.slice(-600));
    Z.check('S1b dry run lists the hand-marked Leave day that has no leave request', dry.split('\n').some((l) => l.includes(eEmp.employeeCode) && l.includes('2026-10-21')), dry.slice(-600));
    const app = run('--apply');
    const bakLine = /Backup \(the whole database before this\): (.*)/.exec(app);
    if (bakLine) { try { fs.rmSync(path.dirname(bakLine[1].trim()), { recursive: true, force: true }); } catch { /* temp */ } }
    const o1 = await prisma.leaveRequest.findUnique({ where: { id: old.id } });
    const so = await stepsOf(old.id);
    const aud = await prisma.auditLog.findFirst({ where: { entityId: old.id, action: 'TL leave back to Pending - waiting for the Super Admin' } });
    Z.check('S2 --apply: the TL leave is Pending, HR\'s approval kept, the Super Admin step waiting, audited', o1.status === 'Pending' && so.HR === 'Approved' && so.SUPER_ADMIN === 'Pending' && !!aud && /by .*ZZTEST LHM hr/.test(aud.fromValue || ''), [o1.status, so, aud && aud.fromValue]);
    Z.check('S3 the TL leave the Super Admin approved stays Approved', (await prisma.leaveRequest.findUnique({ where: { id: bySa.id } })).status === 'Approved');
    const raisedReq = await prisma.leaveRequest.findFirst({ where: { employeeId: eEmp.id, fromDate: '2026-10-21' } });
    if (raisedReq) leaveIds.push(raisedReq.id);
    Z.check('S4 the hand-marked Leave day got a Pending leave request', !!raisedReq && raisedReq.status === 'Pending' && !!handMark, raisedReq && raisedReq.status);
    const rep = await Z.call('GET', `/api/attendance/kpi-report?from=${SDAY}&to=${SDAY}`, T.hr);
    const findRow = (o) => { if (!o || typeof o !== 'object') return null; if (Array.isArray(o)) { for (const x of o) { const f = findRow(x); if (f) return f; } return null; } if (o.employeeId === eTl.id && o.date === SDAY && o.reason !== undefined) return o; for (const v of Object.values(o)) { const f = findRow(v); if (f) return f; } return null; };
    const drow = findRow(rep.body);
    Z.check('S5 the attendance list reads "Leave (pending) - ...: HR (<name>) approved, waiting for the Super Admin"', !!drow && drow.status === D.STATUS.LEAVE_REVIEW && /HR \(ZZTEST LHM hr[^)]*\) approved, waiting for the Super Admin/.test(drow.reason), [rep.status, drow && drow.status, drow && drow.reason]);
    const again = run();
    Z.check('S6 running it again finds nothing to do for these (idempotent)', !listed(again, SDAY) && !again.split('\n').some((l) => l.includes(eEmp.employeeCode) && l.includes('2026-10-21')), again.slice(-300));
  } catch (err) { Z.fail += 1; console.log('FAIL  crashed', err && err.stack ? err.stack.slice(0, 900) : err); } finally {
    try {
      const emps = Z.made.emps;
      const all = (await prisma.leaveRequest.findMany({ where: { employeeId: { in: emps } }, select: { id: true } })).map((x) => x.id);
      const ids = [...new Set([...leaveIds, ...all])];
      await prisma.approvalStep.deleteMany({ where: { recordId: { in: ids } } });
      await prisma.attendance.deleteMany({ where: { employeeId: { in: emps } } });
      for (const m of ['leaveCharge', 'leaveBalance']) { try { await prisma[m].deleteMany({ where: { employeeId: { in: emps } } }); } catch { /* not every table */ } }
      await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } });
      await prisma.notification.deleteMany({ where: { OR: [{ recipient: { contains: ids[0] || '__none__' } }, { message: { contains: 'ZZTEST LHM' } }, { title: { contains: 'ZZTEST LHM' } }] } }).catch(() => {});
      await prisma.leaveRequest.deleteMany({ where: { id: { in: ids } } });
    } catch (e) { console.log('cleanup', String(e.message).slice(0, 160)); }
    await Z.cleanup([(p) => p.auditLog.deleteMany({ where: { OR: [{ reason: { contains: 'ZZTEST LHM' } }, { toValue: { contains: 'ZZTEST LHM' } }] } })]).catch((e) => console.log('cleanup problem', String(e.message).slice(0, 160)));
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();
