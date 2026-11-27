#!/usr/bin/env node
// ---------------------------------------------------------------------------
// APPROVER-LEFT TEST (2026-11-27) - SANDBOX ONLY.
//   node scripts/approver-left-test.js     (needs prisma/sandbox.db and the sandbox API: TL_API, default http://localhost:4011)
//
// Founder 2026-11-27: waiting approvals move by themselves when a lead exits. utils/approverLeft.js:
//   A  dry run changes nothing          B  requests on an exited TL move to the department's active TL (leave, regularization,
//   late coming), one audit row each, one bell with the count, nothing approved    C  a switched-off login counts as gone
//   D  Notice Period / Exit Process keep their requests    E  closed requests and not-yet-current steps are left alone
//   F  nobody holds the level: passed to the next level; with no next level it stays    G  a second pass changes nothing
//   H  the new owner can really approve it through the API    I  the timer runs it (and not in the sandbox)
// Removes every row it made and restores the logins it switched off. Refuses to run against dev.db / port 4010.
// ---------------------------------------------------------------------------
/* eslint-disable no-console, no-await-in-loop */
const path = require('path');
const fs = require('fs');

const BACK = path.resolve(__dirname, '..');
const DB = path.join(BACK, 'prisma', (process.env.TL_TEST_DB || 'sandbox.db'));
if (!fs.existsSync(DB) || /dev\.db$/.test(DB)) { console.error('No prisma/sandbox.db - start the sandbox first (never dev.db).'); process.exit(2); }
process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}`;
require('dotenv').config({ path: path.join(BACK, '.env') });
process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}`;
process.env.TEST_MODE = process.env.TEST_MODE || '1';
const API = `${String(process.env.TL_API || 'http://localhost:4011').replace(/\/+$/, '').replace(/\/api$/, '')}/api`;
if (/:4010(\/|$)/.test(API)) { console.error('Refusing: 4010 is the real server.'); process.exit(2); }
const prisma = require('../src/db');
const jwt = require('jsonwebtoken');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const AL = require('../src/utils/approverLeft');

let pass = 0; let fail = 0;
const ok = (cond, name, extra = '') => { if (cond) { pass += 1; console.log(`  ok   ${name}`); } else { fail += 1; console.log(`  FAIL ${name} ${String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 600)}`); } };
const RUN = Date.now().toString(36);
const DEPT = `ZZAL Dept ${RUN}`;
const made = { users: [], emps: [], leaves: [], regs: [], lates: [], steps: [] };
const switchedOff = [];

const base = { passwordHash: 'x'.repeat(40), atsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: true, accountsAccess: false, atsAccess: false, status: 'Active' };
async function mk(tag, role, team, extra = {}) {
  const name = `ZZAL ${tag} ${RUN}`;
  const u = await prisma.user.create({ data: { ...base, name, email: `zzal-${tag.toLowerCase()}-${RUN}@example.test`, username: `zzal-${tag.toLowerCase()}-${RUN}@example.test`, role, hrmsRole: role } });
  made.users.push(u.id);
  const e = await prisma.employee.create({
    data: { employeeCode: `ZZAL-${tag}-${RUN}`.slice(0, 40), name, userId: u.id, designation: role === 'TL' ? 'TL' : role === 'HR' ? 'HR' : 'Employee', employmentStatus: 'Active', department: DEPT, team: team || null, email: u.email, dateOfJoining: new Date('2025-01-01'), ...extra },
  });
  made.emps.push(e.id);
  return { u, e, name };
}
const setStatus = (p, employmentStatus) => prisma.employee.update({ where: { id: p.e.id }, data: { employmentStatus } });
const token = async (p) => jwt.sign(tokenPayload(await resolveIdentity(p.u.id)), process.env.JWT_SECRET, { expiresIn: '2h' });

// one request with its chain. chain = [[level, person, status, mode]]; an Applied row for the applicant is added unless noApplied
async function request(workflow, applicant, chain, { noApplied = false, recordStatus = 'Pending', date = '2027-06-07' } = {}) {
  let rec;
  if (workflow === 'leave') { rec = await prisma.leaveRequest.create({ data: { employeeId: applicant.e.id, type: 'Casual Leave', fromDate: date, toDate: date, days: 1, status: recordStatus, reason: 'test' } }); made.leaves.push(rec.id); }
  else if (workflow === 'regularization') { rec = await prisma.attendanceRegularization.create({ data: { employeeId: applicant.e.id, date, status: recordStatus, reason: 'test' } }); made.regs.push(rec.id); }
  else if (workflow === 'latePermission') { rec = await prisma.latePermission.create({ data: { employeeId: applicant.e.id, date, expectedTime: '10:30', reason: 'test', status: recordStatus } }); made.lates.push(rec.id); }
  else rec = { id: `zzal-${workflow}-${RUN}-${made.steps.length}` };
  const rows = noApplied ? [] : [['EMPLOYEE', applicant, 'Applied', 'applicant']];
  rows.push(...chain);
  const out = {};
  for (let i = 0; i < rows.length; i += 1) {
    const [level, who, status, mode] = rows[i];
    const s = await prisma.approvalStep.create({ data: { workflow, recordId: rec.id, level, seq: i + 1, mode: mode || 'required', status, slaHours: 24, approverUserId: who ? who.u.id : null, approverName: who ? who.name : null, activatedAt: status === 'Pending' ? new Date('2026-01-01') : null } });
    made.steps.push(s.id); out[level] = s.id;
  }
  return { id: rec.id, steps: out };
}
const step = (id) => prisma.approvalStep.findUnique({ where: { id } });
const bells = (p) => prisma.notification.findMany({ where: { userId: p.u.id, title: 'Approvals moved to you' } });
const audits = (recordId) => prisma.auditLog.findMany({ where: { entityId: recordId, action: 'Approver changed' } });

(async () => {
  try {
    const sa = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN', status: 'Active' }, orderBy: { createdAt: 'asc' } });
    if (!sa) throw new Error('the sandbox has no Super Admin');
    const SA = { u: sa, name: sa.name };
    const tlOld = await mk('TLOLD', 'TL', 'Team-A');
    const tlNew = await mk('TLNEW', 'TL', 'Team-B');
    const emp1 = await mk('EMP1', 'EMPLOYEE', 'Team-A', { tl: tlOld.name });
    const emp2 = await mk('EMP2', 'EMPLOYEE', 'Team-A', { reportingManagerId: tlOld.e.id });
    // the approvers who must KEEP their requests / are gone in other ways
    const tlNotice = await mk('TLNOTICE', 'TL', 'Team-C');
    const tlExiting = await mk('TLEXITING', 'TL', 'Team-C');
    const tlOff = await mk('TLOFF', 'TL', 'Team-C');
    await setStatus(tlNotice, 'Notice Period');
    await setStatus(tlExiting, 'Exit Process');

    const l1 = await request('leave', emp1, [['TL', tlOld, 'Pending'], ['SUPER_ADMIN', SA, 'Waiting']], { date: '2027-06-07' });
    const l2 = await request('leave', emp2, [['TL', tlOld, 'Pending']], { date: '2027-06-08' });
    const reg = await request('regularization', emp1, [['TL', tlOff, 'Pending']], { noApplied: true, date: '2027-06-09' });
    const late = await request('latePermission', emp2, [['TL', tlOld, 'Pending']], { noApplied: true, date: '2027-06-10' });
    const onNotice = await request('leave', emp1, [['TL', tlNotice, 'Pending']], { date: '2027-06-11' });
    const exiting = await request('leave', emp2, [['TL', tlExiting, 'Pending']], { date: '2027-06-12' });
    const closed = await request('leave', emp1, [['TL', tlOld, 'Pending']], { recordStatus: 'Rejected', date: '2027-06-14' });
    const future = await request('leave', emp2, [['TL', tlNew, 'Pending'], ['STL', tlOld, 'Waiting']], { date: '2027-06-15' });
    const decided = await request('leave', emp1, [['TL', tlOld, 'Approved'], ['SUPER_ADMIN', SA, 'Pending']], { date: '2027-06-16' });

    console.log('\nEverybody still working: nothing to do');
    const idle = await AL.run({ dryRun: true });
    ok(!idle.items.some((x) => [l1.id, l2.id, late.id, onNotice.id, exiting.id].includes(x.recordId)), 'no request of an active, notice-period or exit-process approver is picked up', idle.items);

    await setStatus(tlOld, 'Exited');
    await prisma.user.update({ where: { id: tlOff.u.id }, data: { status: 'Inactive' } });

    console.log('\nA  dry run');
    const dry = await AL.run({ dryRun: true });
    const mine = (r, rec) => r.items.find((x) => x.recordId === rec.id);
    ok(mine(dry, l1) && mine(dry, l1).action === 'move' && mine(dry, l1).to === tlNew.name, 'dry run says the exited TL\'s leave goes to the other TL', mine(dry, l1));
    ok((await step(l1.steps.TL)).approverUserId === tlOld.u.id && !(await bells(tlNew)).length && !(await audits(l1.id)).length, 'dry run writes nothing');

    console.log('\nB / C / D / E  the real pass');
    const r = await AL.run();
    for (const [label, rec] of [['leave', l1], ['second leave (own reporting manager exited)', l2], ['regularization (login switched off, applicant read from the record)', reg], ['late coming (applicant read from the record)', late]]) {
      const s = await step(rec.steps.TL);
      ok(s.approverUserId === tlNew.u.id && s.approverName === tlNew.name && s.status === 'Pending' && /Moved from/.test(s.note || ''), `${label}: now waiting for the active TL`, s);
      ok((await audits(rec.id)).length === 1, `${label}: one audit row`);
    }
    const moved1 = await step(l1.steps.TL);
    ok(moved1.activatedAt.getFullYear() >= 2026 && moved1.activatedAt > new Date('2026-06-01') && moved1.dueAt > moved1.activatedAt, 'the new owner gets a fresh clock', moved1);
    ok((await step(l1.steps.SUPER_ADMIN)).status === 'Waiting', 'the later level still waits its turn');
    const b = await bells(tlNew);
    ok(b.length === 1 && /^4 requests/.test(b[0].message) && b[0].message.includes(tlOld.name) && b[0].message.includes(tlOff.name), 'one bell with the count and who left', b);
    ok((await prisma.leaveRequest.findUnique({ where: { id: l1.id } })).status === 'Pending', 'nothing was approved or rejected');
    ok((await step(onNotice.steps.TL)).approverUserId === tlNotice.u.id, 'Notice Period keeps the request');
    ok((await step(exiting.steps.TL)).approverUserId === tlExiting.u.id, 'Exit Process keeps the request');
    ok((await step(closed.steps.TL)).approverUserId === tlOld.u.id && mine(r, closed).action === 'keep', 'a closed (rejected) leave is left alone', mine(r, closed));
    ok((await step(future.steps.STL)).approverUserId === tlOld.u.id && (await step(future.steps.STL)).status === 'Waiting', 'a step that is not current yet is left to the normal next-step check');
    ok((await step(decided.steps.TL)).approverUserId === tlOld.u.id && (await step(decided.steps.TL)).status === 'Approved', 'a decision already taken is untouched');

    console.log('\nF  nobody holds the level');
    const hrGone = await mk('HRGONE', 'HR', null);
    // only for this test: every other HR login in the sandbox is switched off, and put back at the end
    const otherHr = await prisma.user.findMany({ where: { status: 'Active', id: { not: hrGone.u.id }, OR: [{ hrmsRole: 'HR' }, { hrmsRole: null, role: 'HR' }] }, select: { id: true } });
    for (const u of otherHr) { await prisma.user.update({ where: { id: u.id }, data: { status: 'Inactive' } }); switchedOff.push(u.id); }
    await setStatus(hrGone, 'Relieved');
    const toNext = await request('leave', emp1, [['TL', tlNew, 'Approved'], ['HR', hrGone, 'Pending'], ['SUPER_ADMIN', SA, 'Waiting']], { date: '2027-06-17' });
    const noNext = await request('leave', emp2, [['TL', tlNew, 'Approved'], ['HR', hrGone, 'Pending']], { date: '2027-06-18' });
    const saBellsBefore = (await bells(SA)).length;
    const f = await AL.run();
    const hs = await step(toNext.steps.HR); const ss = await step(toNext.steps.SUPER_ADMIN);
    ok(hs.status === 'Skipped' && /nobody active holds/.test(hs.note || '') && ss.status === 'Pending', 'passed to the next level with the reason', { hs, ss, item: mine(f, toNext) });
    ok((await bells(SA)).length === saBellsBefore + 1, 'the next level gets a bell');
    ok((await step(noNext.steps.HR)).status === 'Pending' && (await step(noNext.steps.HR)).approverUserId === hrGone.u.id && mine(f, noNext).action === 'keep', 'with no later level it stays as it is (never completed by itself)', mine(f, noNext));
    ok((await prisma.leaveRequest.findUnique({ where: { id: noNext.id } })).status === 'Pending', 'and the request is still Pending');

    console.log('\nG  a second pass');
    const nBell = (await bells(tlNew)).length; const nAudit = (await audits(l1.id)).length;
    const again = await AL.run();
    ok(again.moved === 0 && again.skipped === 0, 'nothing more to move', again);
    ok((await bells(tlNew)).length === nBell && (await audits(l1.id)).length === nAudit, 'no second bell or audit row');

    console.log('\nH  the new owner can approve it');
    const t = await token(tlNew);
    const res = await fetch(`${API}/leave/${l2.id}/decision`, { method: 'PATCH', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'Approved', comment: 'Approved in the test', approvalReason: 'Approved in the test' }) });
    const body = await res.json().catch(() => null);
    const after = await step(l2.steps.TL);
    ok(res.status === 200 && after.status === 'Approved' && after.actedByUserId === tlNew.u.id, 'approve through the API works for the new owner', { status: res.status, body, after });

    console.log('\nI  the timer');
    AL.startSweep(); // sandbox: must not start
    const t1 = await request('leave', emp1, [['TL', tlOld, 'Pending']], { date: '2027-06-19' });
    await new Promise((res2) => setTimeout(res2, 900));
    ok((await step(t1.steps.TL)).approverUserId === tlOld.u.id, 'no timer in the test sandbox');
    const keep = { TEST_MODE: process.env.TEST_MODE, TEAMLINK_SANDBOX: process.env.TEAMLINK_SANDBOX };
    delete process.env.TEST_MODE; delete process.env.TEAMLINK_SANDBOX;
    process.env.APPROVER_LEFT_SWEEP_MS = '0'; AL.startSweep();
    await new Promise((res2) => setTimeout(res2, 900));
    ok((await step(t1.steps.TL)).approverUserId === tlOld.u.id, 'APPROVER_LEFT_SWEEP_MS=0 switches it off');
    process.env.APPROVER_LEFT_SWEEP_MS = '300'; AL.startSweep();
    await new Promise((res2) => setTimeout(res2, 2500));
    ok((await step(t1.steps.TL)).approverUserId === tlNew.u.id, 'outside the sandbox the timer moves it by itself', await step(t1.steps.TL));
    Object.entries(keep).forEach(([k, v]) => { if (v !== undefined) process.env[k] = v; });
  } catch (e) {
    fail += 1; console.error('CRASH', e);
  } finally {
    for (const id of switchedOff) await prisma.user.update({ where: { id }, data: { status: 'Active' } }).catch(() => {});
    await prisma.approvalStep.deleteMany({ where: { id: { in: made.steps } } }).catch(() => {});
    await prisma.leaveRequest.deleteMany({ where: { id: { in: made.leaves } } }).catch(() => {});
    await prisma.attendanceRegularization.deleteMany({ where: { id: { in: made.regs } } }).catch(() => {});
    await prisma.latePermission.deleteMany({ where: { id: { in: made.lates } } }).catch(() => {});
    await prisma.attendance.deleteMany({ where: { employeeId: { in: made.emps } } }).catch(() => {});
    await prisma.leaveBalance.deleteMany({ where: { employeeId: { in: made.emps } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: made.users } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { id: { in: made.emps } } }).catch((e) => console.log('cleanup employees:', e.message));
    await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch((e) => console.log('cleanup users:', e.message));
    console.log(`\n${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
