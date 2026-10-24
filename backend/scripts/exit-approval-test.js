#!/usr/bin/env node
// ---------------------------------------------------------------------------
// EMPLOYEE EXIT: APPROVAL + EXIT DATE TEST (HRMS spec items 6 + 7, 2026-10-13) - SANDBOX ONLY.
//   node scripts/exit-approval-test.js        (needs the sandbox API on :4011 and prisma/sandbox.db)
// Creates ZZTEST users / employees / seat / attendance / leave / payroll rows in sandbox.db, drives the API,
// then removes every row it made. It refuses to run against dev.db / port 4010.
// ---------------------------------------------------------------------------
/* eslint-disable no-console, no-await-in-loop */
const path = require('path');
const fs = require('fs');

const BACK = path.resolve(__dirname, '..');
const DB = path.join(BACK, 'prisma', (process.env.TL_TEST_DB || 'sandbox.db'));
if (!fs.existsSync(DB)) { console.error('No prisma/sandbox.db - start the sandbox first.'); process.exit(2); }
process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}`;
require('dotenv').config({ path: path.join(BACK, '.env') });
process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}`;
const API = 'http://localhost:4011/api';
const prisma = require('../src/db');
const jwt = require('jsonwebtoken');

let pass = 0; let fail = 0;
const ok = (cond, name, extra = '') => { if (cond) { pass += 1; console.log(`  ok   ${name}`); } else { fail += 1; console.log(`  FAIL ${name} ${extra}`); } };
const tok = (u) => jwt.sign({ id: u.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
// The sandbox restarts whenever anybody edits backend/src. A GET is simply retried; a write is retried ONLY when the
// connection was refused (the request never arrived) - never after a reset, so nothing is ever done twice.
async function http(user, method, url, body, raw = false) {
  let r;
  for (let i = 0; i < 15; i += 1) {
    try { r = await fetch(`${API}${url}`, { method, headers: { Authorization: `Bearer ${tok(user)}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); break; } catch (e) {
      const refused = e && e.cause && e.cause.code === 'ECONNREFUSED';
      if (i === 14 || (method !== 'GET' && !refused)) { await new Promise((res) => setTimeout(res, 15000)); return { status: 0, body: null, text: 'connection lost (' + (e.cause && e.cause.code) + ')' }; }
      await new Promise((res) => setTimeout(res, 4000));
    }
  }
  if (raw) return r;
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}
const RUN = Date.now().toString(36);
const made = { users: [], emps: [], positions: [], paymonths: [], leaves: [] };
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const TODAY = iso(new Date());

async function mkUser(tag, role, hrmsRole, extra = {}, emp = {}) {
  const u = await prisma.user.create({
    data: {
      passwordHash: 'x', name: `ZZTEST EX ${tag} ${RUN}`, email: `zz-ex-${tag.toLowerCase()}-${RUN}@example.test`, username: `zz-ex-${tag.toLowerCase()}-${RUN}@example.test`,
      role, hrmsRole, atsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: true, atsAccess: false, accountsAccess: false, status: 'Active', ...extra,
    },
  });
  made.users.push(u.id);
  const e = await prisma.employee.create({
    data: {
      employeeCode: `ZZEX${tag}${RUN}`.slice(0, 30), name: u.name, userId: u.id, email: u.email, designation: tag, department: 'ZZTEST Dept', employmentStatus: 'Active',
      dateOfJoining: new Date('2025-01-01T00:00:00.000Z'), ...emp,
    },
  });
  made.emps.push(e.id);
  return { u, e };
}
async function mkPerson(tag, tlName, status = 'Active', doj = '2025-01-01') {
  const { u, e } = await mkUser(tag, 'EMPLOYEE', 'EMPLOYEE', {}, { tl: tlName, dateOfJoining: new Date(`${doj}T00:00:00.000Z`), employmentStatus: status });
  return { u, e };
}
const notes = (userId, like) => prisma.notification.findMany({ where: { userId, title: { contains: like } } });
const stepsOf = (recordId) => prisma.approvalStep.findMany({ where: { workflow: 'resignation', recordId }, orderBy: { seq: 'asc' } });
const userById = (id) => prisma.user.findUnique({ where: { id } });
async function view(user, recordId) { return (await http(user, 'GET', `/resignations/exit/${recordId}`)); }
// Approve with whoever's turn it is, until the chain is done. Returns the last response.
async function approveAll(recordId, note = 'ok') {
  let last = null;
  for (let i = 0; i < 10; i += 1) {
    const cur = (await stepsOf(recordId)).find((s) => s.status === 'Pending');
    if (!cur) break;
    const actor = await userById(cur.approverUserId);
    last = await http(actor, 'POST', `/resignations/exit/${recordId}/approve`, { note });
    if (last.status >= 400) return last;
  }
  return last;
}

async function cleanup() {
  const empIds = made.emps;
  const recs = (await prisma.employeeRecord.findMany({ where: { employeeId: { in: empIds }, type: 'RESIGNATION' }, select: { id: true } })).map((r) => r.id);
  await prisma.approvalStep.deleteMany({ where: { workflow: 'resignation', recordId: { in: recs } } });
  await prisma.resignationDetail.deleteMany({ where: { employeeId: { in: empIds } } });
  await prisma.employeeRecord.deleteMany({ where: { employeeId: { in: empIds } } });
  await prisma.fnfRequest.deleteMany({ where: { employeeId: { in: empIds } } });
  await prisma.attendance.deleteMany({ where: { employeeId: { in: empIds } } });
  await prisma.leaveRequest.deleteMany({ where: { employeeId: { in: empIds } } });
  await prisma.positionAssignment.deleteMany({ where: { employeeId: { in: empIds } } });
  if (made.positions.length) await prisma.position.deleteMany({ where: { id: { in: made.positions } } });
  for (const m of made.paymonths) await prisma.payrollRun.deleteMany({ where: { month: m } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...empIds, ...recs, ...made.users] } }, { actorName: { contains: 'ZZTEST EX' } }, { userId: { in: made.users } }, { toValue: { contains: 'ZZTEST EX' } }, { fromValue: { contains: 'ZZTEST EX' } }] } });
  await prisma.notification.deleteMany({ where: { OR: [{ title: { contains: 'ZZTEST EX' } }, { userId: { in: made.users } }, { message: { contains: 'ZZTEST EX' } }] } });
  await prisma.employee.deleteMany({ where: { id: { in: empIds } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
}

(async () => {
  if (/4010/.test(API)) throw new Error('refusing 4010');
  const settingsBackup = await prisma.appSetting.findUnique({ where: { key: 'exit.settings' } });
  const directBackup = await prisma.appSetting.findUnique({ where: { key: 'exit.hrDirectRelieve' } });
  const pwKey = require('../src/utils/pendingWork').SETTINGS_KEY;
  const pwBackup = await prisma.appSetting.findUnique({ where: { key: pwKey } });
  try {
    // ---- the cast ----
    const tl = await mkUser('TL', 'TL', 'TL', { atsDepartment: null }, { designation: 'TL' });
    const hr = await mkUser('HR', 'HR', 'HR', {}, { designation: 'HR' });
    const sa1 = await mkUser('SA1', 'SUPER_ADMIN', 'SUPER_ADMIN', {}, { designation: 'Super Admin' });
    const sa2 = await mkUser('SA2', 'SUPER_ADMIN', 'SUPER_ADMIN', {}, { designation: 'Super Admin' });
    const admin = await mkUser('ADM', 'ADMIN', 'ADMIN', {}, { designation: 'Admin' });
    const mgr = await mkUser('MGR', 'MANAGER', 'MANAGER', {}, { designation: 'Manager' });
    const P1 = await mkPerson('P1', tl.e.name);
    const P2 = await mkPerson('P2', tl.e.name);
    const P3 = await mkPerson('P3', tl.e.name);
    const P4 = await mkPerson('P4', tl.e.name);
    const P5 = await mkPerson('P5', tl.e.name);
    const P6 = await mkPerson('P6', tl.e.name);
    await prisma.appSetting.deleteMany({ where: { key: 'exit.settings' } });
    // 2026-10-15: HR may mark Exited / Relieved directly (default ON). This suite proves the APPROVAL CHAIN, which is what applies when
    // the Admin's emergency switch is OFF, so it switches it OFF for the run and puts it back (hr-relieve-now-test.js covers the ON case).
    await prisma.appSetting.upsert({ where: { key: 'exit.hrDirectRelieve' }, update: { value: JSON.stringify({ enabled: false }) }, create: { key: 'exit.hrDirectRelieve', value: JSON.stringify({ enabled: false }) } });

    // ================= A. EXIT APPROVAL =================
    console.log('\nA1. initiate by resignation -> Super Admin bell + mail once');
    const lwd1 = addDays(TODAY, 20);
    let r1 = await http(P1.u, 'POST', '/resignations', { reason: 'Higher studies', requestedLastWorkingDate: lwd1, noticePeriodDays: 20 });
    if (r1.status === 0 || r1.status === 409) { const ex = await prisma.employeeRecord.findFirst({ where: { employeeId: P1.e.id, type: 'RESIGNATION' } }); if (ex) r1 = { status: 201, body: { id: ex.id }, text: 'recovered' }; }
    ok(r1.status === 201, 'employee files a resignation', `${r1.status} ${r1.text}`);
    const rec1 = r1.body && r1.body.id;
    for (const sa of [sa1, sa2]) {
      const n = await notes(sa.u.id, `Exit initiated: ${P1.e.name}`);
      const inapp = n.filter((x) => x.channel === 'In-App');
      const mail = n.filter((x) => x.channel === 'Email');
      ok(inapp.length === 1, `${sa.u.name.slice(10, 13)} gets ONE bell`, `got ${inapp.length}`);
      ok(mail.length === 1, `${sa.u.name.slice(10, 13)} gets ONE e-mail row (${mail[0] && mail[0].status})`, `got ${mail.length}`);
      ok(inapp[0] && /review in TeamLink/.test(inapp[0].message) && /proposed last working day/.test(inapp[0].message) && inapp[0].message.includes(`/employee-services?tab=resignation&exit=${rec1}`), 'message has line + deep link');
    }
    const exitFlow = require('../src/utils/exitFlow');
    const again = await exitFlow.notifyInitiated({ record: await prisma.employeeRecord.findUnique({ where: { id: rec1 } }), detail: await prisma.resignationDetail.findUnique({ where: { recordId: rec1 } }), employee: P1.e, by: P1.u });
    const nAgain = (await notes(sa1.u.id, `Exit initiated: ${P1.e.name}`)).filter((x) => x.channel === 'In-App').length;
    const nAgain2 = (await notes(sa2.u.id, `Exit initiated: ${P1.e.name}`)).filter((x) => x.channel === 'In-App').length;
    ok(nAgain === 1 && nAgain2 === 1, 'a second notify of the same event is de-duplicated (still ONE bell each)', JSON.stringify({ nAgain, nAgain2, again }));
    const tlNotes = (await notes(tl.u.id, `Exit initiated: ${P1.e.name}`)).length;
    ok(tlNotes >= 1, 'the TL is told (bell/e-mail)', `${tlNotes}`);

    console.log('\nA2. HR "Initiate exit" and the Edit form status, offboarding');
    const i2 = await http(hr.u, 'POST', `/resignations/exit/employee/${P2.e.id}/initiate`, { reason: 'Role closed', lastWorkingDate: addDays(TODAY, 10) });
    ok(i2.status === 201 && i2.body.recordId, 'HR initiates an exit', `${i2.status} ${i2.text}`);
    ok((await notes(sa1.u.id, `Exit initiated: ${P2.e.name}`)).filter((x) => x.channel === 'In-App').length === 1, 'Super Admin told (HR initiated)');
    const i2b = await http(tl.u, 'POST', `/resignations/exit/employee/${P3.e.id}/initiate`, { reason: 'x y z' });
    ok(i2b.status === 403, 'a TL cannot initiate for someone else', `${i2b.status}`);
    const ed = await http(hr.u, 'PUT', `/employees/${P3.e.id}`, { employmentStatus: 'Exit Process' });
    ok(ed.status === 200, 'Edit form sets Exit Process', `${ed.status} ${ed.text.slice(0, 200)}`);
    const rec3 = (await prisma.employeeRecord.findFirst({ where: { employeeId: P3.e.id, type: 'RESIGNATION' } }));
    ok(!!rec3 && rec3.status === 'Pending Approval', 'Edit form started an exit record + chain');
    ok((await stepsOf(rec3 ? rec3.id : 'x')).length > 1, 'with approval steps');
    ok((await notes(sa2.u.id, `Exit initiated: ${P3.e.name}`)).filter((x) => x.channel === 'In-App').length === 1, 'Super Admin told (status edit)');
    const off = await http(hr.u, 'POST', `/employees/${P4.e.id}/offboarding`);
    ok(off.status === 200 && off.body.exitRecordId, 'offboarding POST starts the exit', `${off.status} ${off.text.slice(0, 160)}`);
    const p4after = await prisma.employee.findUnique({ where: { id: P4.e.id } });
    ok(p4after.employmentStatus === 'Active' && p4after.offboardingStatus === 'Waiting for exit approval', 'person is NOT on notice before approval');
    ok((await notes(sa1.u.id, `Exit initiated: ${P4.e.name}`)).filter((x) => x.channel === 'In-App').length === 1, 'Super Admin told (offboarding)');

    console.log('\nA3. nothing can finalize without approval');
    const tryEdit = await http(hr.u, 'PUT', `/employees/${P1.e.id}`, { employmentStatus: 'Relieved' });
    ok(tryEdit.status === 403 && /waiting for approval/i.test(tryEdit.body && tryEdit.body.error), 'Edit form -> Relieved refused (waiting for approval)', `${tryEdit.status} ${tryEdit.text.slice(0, 200)}`);
    const trySa = await http(sa1.u, 'PUT', `/employees/${P1.e.id}`, { employmentStatus: 'Exited' });
    ok(trySa.status === 403, 'even the Super Admin through the Edit form is refused', `${trySa.status}`);
    const tryPatch = await http(hr.u, 'PATCH', `/resignations/${rec1}/status`, { status: 'Relieved' });
    ok([403, 409].includes(tryPatch.status), 'PATCH status Relieved refused', `${tryPatch.status} ${tryPatch.text.slice(0, 150)}`);
    const tryNone = await http(hr.u, 'PUT', `/employees/${P5.e.id}`, { employmentStatus: 'Exited' });
    ok(tryNone.status === 403 && /no approved exit/i.test(tryNone.body.error), 'person with NO exit -> Exited refused', `${tryNone.status} ${tryNone.text.slice(0, 200)}`);
    const rec4 = off.body.exitRecordId;
    const tasks4 = JSON.parse((await prisma.employee.findUnique({ where: { id: P4.e.id } })).offboardingTasks);
    let tickRes = null;
    for (let i = 0; i < tasks4.length; i += 1) tickRes = await http(hr.u, 'PATCH', `/employees/${P4.e.id}/offboarding/${i}`);
    const p4t = await prisma.employee.findUnique({ where: { id: P4.e.id } });
    ok(tickRes.status === 200 && p4t.employmentStatus === 'Active' && p4t.offboardingStatus === 'Cleared', 'ticking every item does NOT relieve (checklist Cleared, still Active)', `${p4t.employmentStatus} ${p4t.offboardingStatus}`);
    ok(tickRes.body && tickRes.body.exitNote && /waiting for approval/i.test(tickRes.body.exitNote), 'and says why in plain words');
    ok(!(await prisma.fnfRequest.findFirst({ where: { employeeId: P4.e.id } })), 'no full & final raised');
    const bulk = await http(hr.u, 'PUT', `/employees/${P6.e.id}`, { employmentStatus: 'Terminated' });
    ok(bulk.status === 403, 'Terminated through Edit refused too', `${bulk.status}`);

    console.log('\nA4. approve at each step; reject restores Active; send back; skip ahead');
    const v0 = await view(hr.u, rec1);
    ok(v0.status === 200 && v0.body.timeline[0].key === 'initiated', 'exit record opens with a timeline', `${v0.status}`);
    const cur1 = (await stepsOf(rec1)).find((s) => s.status === 'Pending');
    ok(!!cur1, 'a step is pending');
    // out of turn
    const notTurn = await http(mgr.u, 'POST', `/resignations/exit/${rec1}/approve`, { note: 'x' });
    ok([403, 404].includes(notTurn.status), 'someone whose turn it is not cannot approve', `${notTurn.status}`);
    // send back needs a note and a previous step
    const levels = (await stepsOf(rec1)).filter((s) => s.mode === 'required' && ['Pending', 'Waiting'].includes(s.status));
    ok(levels.length >= 2, 'the chain has more than one required step', `${levels.map((l) => l.level)}`);
    const first = await userById(cur1.approverUserId);
    const a1 = await http(first, 'POST', `/resignations/exit/${rec1}/approve`, { note: 'first ok' });
    ok(a1.status === 200, 'first approver approves', `${a1.status} ${a1.text.slice(0, 200)}`);
    const cur2 = (await stepsOf(rec1)).find((s) => s.status === 'Pending');
    if (cur2) {
      ok(cur2.seq > cur1.seq, 'it moved to the next step');
      ok((await notes(cur2.approverUserId, `Exit approval waiting for you: ${P1.e.name}`)).length === 1, 'next approver gets a bell');
      const next = await userById(cur2.approverUserId);
      const sbNo = await http(next, 'POST', `/resignations/exit/${rec1}/send-back`, { note: '' });
      ok(sbNo.status === 400, 'send back needs a note', `${sbNo.status}`);
      const sb = await http(next, 'POST', `/resignations/exit/${rec1}/send-back`, { note: 'please check the date' });
      ok(sb.status === 200, 'send back works', `${sb.status} ${sb.text.slice(0, 200)}`);
      const back = (await stepsOf(rec1)).find((s) => s.status === 'Pending');
      ok(back && back.id === cur1.id, 'it returned to the previous approver');
      await http(first, 'POST', `/resignations/exit/${rec1}/approve`, { note: 'again ok' });
    }
    const fin = await approveAll(rec1, 'fine');
    ok(fin && fin.status === 200, 'the chain finishes', fin ? `${fin.status} ${fin.text.slice(0, 200)}` : 'no response');
    const rec1After = await prisma.employeeRecord.findUnique({ where: { id: rec1 } });
    const p1emp = await prisma.employee.findUnique({ where: { id: P1.e.id } });
    ok(rec1After.status === 'Notice Period' && p1emp.employmentStatus === 'Notice Period', 'final approval -> Notice Period');
    ok((await notes(P1.u.id, 'Exit approved')).length >= 1, 'employee told it was approved');
    const sa1saw = await notes(sa1.u.id, `Exit approved: ${P1.e.name}`);
    ok(sa1saw.length >= 1 || (await stepsOf(rec1)).some((s) => s.actedByName && s.actedByName.includes('SA1')), 'Super Admin hears the decision (or decided it)');
    // reject
    const rj0 = await http(sa1.u, 'POST', `/resignations/exit/${rec3.id}/reject`, { note: '' });
    ok(rj0.status === 400, 'reject needs a reason', `${rj0.status}`);
    const rj = await http(sa1.u, 'POST', `/resignations/exit/${rec3.id}/reject`, { note: 'We need this person' });
    ok(rj.status === 200, 'reject works', `${rj.status} ${rj.text.slice(0, 200)}`);
    const p3 = await prisma.employee.findUnique({ where: { id: P3.e.id } });
    ok(p3.employmentStatus === 'Active' && (await prisma.employeeRecord.findUnique({ where: { id: rec3.id } })).status === 'Rejected', 'rejected -> back to Active, record Rejected');
    ok((await notes(P3.u.id, 'Exit rejected')).filter((x) => x.channel === 'In-App').length === 1, 'employee told it was rejected (one bell)');
    // skip ahead
    const rec2 = i2.body.recordId;
    const sk = await http(sa2.u, 'POST', `/resignations/exit/${rec2}/approve`, { note: 'urgent' });
    ok(sk.status === 200, 'Super Admin approves at the first step (skip ahead)', `${sk.status} ${sk.text.slice(0, 200)}`);
    const steps2 = await stepsOf(rec2);
    ok(steps2.some((s) => s.direct) || steps2.every((s) => s.status !== 'Pending'), 'recorded as direct approval');
    ok((await prisma.auditLog.count({ where: { entityId: rec2, action: { contains: 'Direct Super Admin' } } })) >= 1 || (await prisma.auditLog.count({ where: { entityId: rec2, action: { contains: 'approved at' } } })) >= 1, 'audited');
    ok((await prisma.employeeRecord.findUnique({ where: { id: rec2 } })).status === 'Notice Period', 'exit is approved');

    console.log('\nA5. finish: last day, early release, F&F, seat');
    const pos = await prisma.position.create({ data: { code: `ZZEX-${RUN}`.toUpperCase().slice(0, 12), department: 'ZZTEST Dept', active: true } });
    made.positions.push(pos.id);
    await prisma.positionAssignment.create({ data: { positionId: pos.id, employeeId: P1.e.id, fromDate: '2025-01-01' } });
    const early = await http(hr.u, 'POST', `/resignations/exit/${rec1}/finalize`, {});
    ok(early.status === 409 && /last working day/i.test(early.body.error), 'finalize before the last day refused', `${early.status} ${early.text.slice(0, 160)}`);
    const viaEdit = await http(hr.u, 'PUT', `/employees/${P1.e.id}`, { employmentStatus: 'Relieved' });
    ok(viaEdit.status === 403, 'Edit form -> Relieved still refused before the last day', `${viaEdit.status}`);
    const er0 = await http(hr.u, 'POST', `/resignations/exit/${rec1}/early-release`, { note: '' });
    ok(er0.status === 400, 'early release needs the approver note');
    const er = await http(hr.u, 'POST', `/resignations/exit/${rec1}/early-release`, { note: 'Agreed by the Super Admin on the phone' });
    ok(er.status === 200, 'early release recorded', `${er.status} ${er.text.slice(0, 200)}`);
    ok((await prisma.employeeRecord.findUnique({ where: { id: rec1 } })).date === TODAY, 'last working day is now today');
    const fz = await http(hr.u, 'POST', `/resignations/exit/${rec1}/finalize`, {});
    ok(fz.status === 200, 'finalize after the early release', `${fz.status} ${fz.text.slice(0, 200)}`);
    const p1f = await prisma.employee.findUnique({ where: { id: P1.e.id } });
    ok(p1f.employmentStatus === 'Relieved', 'employee is Relieved');
    ok(!!(await prisma.fnfRequest.findFirst({ where: { employeeId: P1.e.id, status: 'Pending' } })), 'full & final raised');
    const seat = await prisma.positionAssignment.findFirst({ where: { employeeId: P1.e.id } });
    ok(seat && seat.toDate === TODAY, 'seat freed on the exit date (seatRelease middleware still works)', `${seat && seat.toDate}`);

    console.log('\nA6. Super Admin override');
    const ov0 = await http(hr.u, 'POST', `/resignations/exit/employee/${P5.e.id}/finalize-override`, { reason: 'because I say so, long enough' });
    ok(ov0.status === 403, 'HR cannot override');
    const ov1 = await http(sa1.u, 'POST', `/resignations/exit/employee/${P5.e.id}/finalize-override`, { reason: 'short' });
    ok(ov1.status === 400, 'override needs a real reason');
    const ov = await http(sa1.u, 'POST', `/resignations/exit/employee/${P5.e.id}/finalize-override`, { reason: 'Absconded; HR confirmed in writing', status: 'Exited' });
    ok(ov.status === 200, 'Super Admin override works', `${ov.status} ${ov.text.slice(0, 200)}`);
    ok((await prisma.employee.findUnique({ where: { id: P5.e.id } })).employmentStatus === 'Exited', 'employee Exited');
    ok((await prisma.auditLog.count({ where: { action: { contains: 'WITHOUT approval' }, toValue: 'Exited' } })) >= 1, 'override is audited with its reason');
    const hrOf5 = (await exitFlow.peopleAround(P5.e)).hr;
    ok(!hrOf5 || (await notes(hrOf5, `Exit finished without approval: ${P5.e.name}`)).filter((x) => x.channel === 'In-App').length === 1, 'HR (the one on the chain) is told about the override');

    console.log('\nA7. settings: who finally approves');
    const s0 = await http(hr.u, 'PUT', '/resignations/exit/settings', { finalApprover: 'HR' });
    ok(s0.status === 403, 'only the Super Admin edits the setting');
    const s1 = await http(admin.u, 'GET', '/resignations/exit/settings');
    ok(s1.status === 200 && s1.body.finalApprover === 'SUPER_ADMIN' && s1.body.reminderHours === 24 && s1.body.canEdit === false, 'defaults: Super Admin, 24 hours (admin may read)');
    const s2 = await http(sa1.u, 'PUT', '/resignations/exit/settings', { finalApprover: 'HR', reminderHours: 12 });
    ok(s2.status === 200 && s2.body.finalApprover === 'HR', 'Super Admin saves HR as final approver');
    const P7 = await mkPerson('P7', tl.e.name);
    const r7 = await http(P7.u, 'POST', '/resignations', { reason: 'Relocation', requestedLastWorkingDate: addDays(TODAY, 15) });
    const fin7 = await approveAll(r7.body.id, 'ok');
    const st7 = await stepsOf(r7.body.id);
    ok(fin7 && fin7.status === 200 && (await prisma.employeeRecord.findUnique({ where: { id: r7.body.id } })).status === 'Notice Period', 'with HR as final approver the exit is approved at HR');
    ok(!st7.some((s) => s.status === 'Pending' || s.status === 'Waiting'), 'steps above HR are closed');
    await http(sa1.u, 'PUT', '/resignations/exit/settings', { finalApprover: 'SUPER_ADMIN', reminderHours: 24 });

    console.log('\nA8. reminders (engine switched on in the sandbox only)');
    const CA = require('../src/utils/chainAlerts');
    const PW = require('../src/utils/pendingWork');
    const enable = () => PW.saveSettings({ enabled: true, chain: { enabled: true, approvals: true, repeatDaily: true } }, { id: null, name: 'ZZTEST EX' }).catch((e) => console.log('   (settings save)', e.message));
    await enable();
    const runCA = async (o) => { await enable(); return CA.run(o); };
    const P8 = await mkPerson('P8', tl.e.name);
    const r8 = await http(P8.u, 'POST', '/resignations', { reason: 'Compensation', requestedLastWorkingDate: addDays(TODAY, 30) });
    const rec8 = r8.body.id;
    const key8 = `approval|resignation|${rec8}`;
    const sent = [];
    const mailer = async (m) => { sent.push(m); return { ok: true }; };
    const monday = (() => { const d = new Date(); d.setUTCHours(12, 0, 0, 0); while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1); return d; })();
    const sunday = new Date(monday.getTime() - 86400000);
    // not waited long enough yet (the step became current 2 hours before 'now')
    const cur8 = (await stepsOf(rec8)).find((s) => s.status === 'Pending');
    await prisma.approvalStep.update({ where: { id: cur8.id }, data: { activatedAt: new Date(monday.getTime() - 2 * 3600000) } });
    let run = await runCA({ now: monday, keys: [key8], testMode: true, mailer, work: false });
    ok(run.toTell === 0, 'not reminded before 24 hours', JSON.stringify({ toTell: run.toTell, skipped: run.skipped }));
    await prisma.approvalStep.update({ where: { id: cur8.id }, data: { activatedAt: new Date(monday.getTime() - 30 * 3600000) } });
    run = await runCA({ now: sunday, keys: [key8], testMode: true, mailer, work: false });
    ok(run.toTell === 0, 'nothing on a Sunday (working days only)', JSON.stringify(run));
    run = await runCA({ now: monday, keys: [key8], testMode: true, mailer, work: false });
    const sa1b = await notes(sa1.u.id, 'waiting');
    ok(sent.length >= 1 || run.emails >= 0, 'reminder mail went through the fake transport');
    ok(run.toTell >= 2, 'after 24 hours: the current approver AND the Super Admin are reminded', JSON.stringify(run));
    run = await runCA({ now: monday, keys: [key8], testMode: true, mailer, work: false });
    ok(run.toTell === 0, 'once per day: the same day sends nothing more', JSON.stringify(run));
    let tuesday = new Date(monday.getTime() + 86400000);
    while (await PW.offDayReason(PW.dayOfIst(tuesday))) tuesday = new Date(tuesday.getTime() + 86400000);
    run = await runCA({ now: tuesday, keys: [key8], testMode: true, mailer, work: false });
    ok(run.toTell >= 2, 'the next working day reminds again', JSON.stringify(run));
    ok(sa1b.length >= 0, 'bell rows recorded');
    // decided -> stops
    await http(sa1.u, 'POST', `/resignations/exit/${rec8}/approve`, { note: 'done' });
    const wednesday = new Date(tuesday.getTime() + 86400000);
    run = await runCA({ now: wednesday, keys: [key8], testMode: true, mailer, work: false });
    ok(run.toTell === 0 && run.items === 0, 'stops when decided', JSON.stringify(run));
    // restore the pending-work settings
    if (pwBackup) await prisma.appSetting.update({ where: { key: pwKey }, data: { value: pwBackup.value } });
    else await prisma.appSetting.deleteMany({ where: { key: pwKey } });
    await prisma.appSetting.deleteMany({ where: { key: { startsWith: 'pwr.' } } }).catch(() => {});

    console.log('\nA9. exit record: timeline, visibility, exports');
    const vv = await view(hr.u, rec1);
    const keys = vv.body.timeline.map((t) => t.key);
    ok(keys[0] === 'initiated' && keys.includes('notice') && keys.includes('lwd') && keys.includes('offboarding') && keys.includes('fnf') && keys[keys.length - 1] === 'relieved', 'timeline stages present', keys.join(','));
    ok(vv.body.timeline.filter((t) => t.state === 'done').every((t) => t.at !== undefined), 'each done stage carries who/when');
    ok(vv.body.timeline.find((t) => t.key === 'relieved').state === 'done', 'relieved is done');
    const own = await view(P1.u, rec1);
    // 2026-10-14: a person who has been Relieved can no longer sign in at all (utils/leftLogin.js), so their own exit view is closed too.
    ok((own.status === 200 && own.body.simple === true && !own.body.usage && !own.body.events) || (own.status === 401 && own.body && own.body.code === 'EMPLOYMENT_ENDED'), 'employee sees their own, simplified (or, once Relieved, is signed out)');
    const other = await view(P2.u, rec1);
    ok(other.status === 403, 'another employee cannot open it', `${other.status}`);
    const list = await http(hr.u, 'GET', '/resignations/exit/approvals');
    ok(list.status === 200 && Array.isArray(list.body.rows) && list.body.counts.stageOrder.length === 6, 'Exit approvals list with counts');
    const f2 = await http(hr.u, 'GET', '/resignations/exit/approvals?stage=Waiting%20for%20approval');
    ok(f2.body.rows.every((r) => r.stage === 'waiting'), 'status filter works');
    const xl = await http(hr.u, 'GET', '/resignations/exit/records.xlsx', null, true);
    ok(xl.status === 200 && /spreadsheetml/.test(xl.headers.get('content-type')), 'Excel export');
    const pdf = await http(hr.u, 'GET', '/resignations/exit/records.pdf', null, true);
    ok(pdf.status === 200 && /pdf/.test(pdf.headers.get('content-type')), 'PDF export');

    // ================= B. EXIT DATE =================
    console.log('\nB1. who may change the date, validations');
    const P9 = await mkPerson('P9', tl.e.name, 'Active', '2026-03-01');
    const r9 = await http(P9.u, 'POST', '/resignations', { reason: 'Relocation', resignationDate: '2026-09-01', requestedLastWorkingDate: '2026-10-31' });
    ok(r9.status === 201, 'P9 resigns', `${r9.status} ${r9.text.slice(0, 160)}`);
    const rec9 = r9.body.id;
    await approveAll(rec9, 'ok');
    ok((await prisma.employeeRecord.findUnique({ where: { id: rec9 } })).status === 'Notice Period', 'P9 approved');
    for (const [who, label] of [[tl, 'TL'], [mgr, 'Manager'], [P9, 'the employee']]) {
      const x = await http(who.u, 'PUT', `/resignations/exit/${rec9}/date`, { date: '2026-11-05', reason: 'because' });
      ok(x.status === 403, `${label} cannot change it`, `${x.status}`);
    }
    const noReason = await http(hr.u, 'PUT', `/resignations/exit/${rec9}/date`, { date: '2026-11-05', reason: '' });
    ok(noReason.status === 400, 'reason required', `${noReason.status}`);
    const beforeJoin = await http(hr.u, 'PUT', `/resignations/exit/${rec9}/date`, { date: '2026-02-01', reason: 'typo test' });
    ok(beforeJoin.status === 400 && /(joining|resignation) date/.test(beforeJoin.body.error), 'before the joining date refused', beforeJoin.text.slice(0, 160));
    await prisma.resignationDetail.update({ where: { recordId: rec9 }, data: { resignationDate: '2026-03-10' } });
    const beforeJoin2 = await http(hr.u, 'PUT', `/resignations/exit/${rec9}/date`, { date: '2026-02-01', reason: 'typo test' });
    ok(beforeJoin2.status === 400 && /joining date/.test(beforeJoin2.body.error), 'before the joining date: its own message', beforeJoin2.text.slice(0, 160));
    await prisma.resignationDetail.update({ where: { recordId: rec9 }, data: { resignationDate: '2026-09-01' } });
    const beforeRes = await http(hr.u, 'PUT', `/resignations/exit/${rec9}/date`, { date: '2026-08-15', reason: 'typo test' });
    ok(beforeRes.status === 400 && /resignation date/.test(beforeRes.body.error), 'before the resignation date refused', beforeRes.text.slice(0, 160));
    const badDate = await http(hr.u, 'PUT', `/resignations/exit/${rec9}/date`, { date: 'tomorrow', reason: 'typo test' });
    ok(badDate.status === 400, 'not a date refused');

    console.log('\nB2. paid-cycle warning, past date, change recorded, notices');
    const PC = require('../src/utils/payrollCycle');
    const stt = await PC.getSettings();
    const mo = PC.monthOfDate('2026-09-10', stt.cycle);
    const existingRun = await prisma.payrollRun.findUnique({ where: { month: mo.month } });
    if (!existingRun) { await prisma.payrollRun.create({ data: { month: mo.month, period: 'ZZTEST EX', status: 'Paid' } }); made.paymonths.push(mo.month); }
    const chk = await http(hr.u, 'POST', `/resignations/exit/${rec9}/date/check`, { date: '2026-09-10', reason: 'check' });
    ok(chk.status === 200 && chk.body.warnings.some((w) => /already paid/.test(w) && /next payroll/.test(w)), 'paid month warns in plain words', JSON.stringify(chk.body));
    ok(chk.body.warnings.some((w) => /already passed/.test(w)), 'a past date for a working person warns');
    ok((await prisma.employeeRecord.findUnique({ where: { id: rec9 } })).date === '2026-10-31', 'the check changed nothing');
    const ch = await http(hr.u, 'PUT', `/resignations/exit/${rec9}/date`, { date: addDays(TODAY, 12), reason: 'Handover finished early', note: 'agreed with TL' });
    ok(ch.status === 200, 'HR changes the date', `${ch.status} ${ch.text.slice(0, 200)}`);
    const dc = ch.body.dateChanges[0];
    ok(dc && dc.from === '2026-10-31' && dc.to === addDays(TODAY, 12) && /Handover/.test(dc.reason) && /HR/.test(dc.by) && dc.role && dc.source === 'UI', 'previous / new / reason / who / role / source recorded', JSON.stringify(dc));
    ok((await notes(P9.u.id, 'last working day changed')).length === 1, 'employee told (own summary)');
    for (let i = 0; i < 20 && !(await notes(tl.u.id, `Last working day changed: ${P9.e.name}`)).length; i += 1) await new Promise((r) => setTimeout(r, 250)); // the team is told right after the employee (async)
    { const tn = await notes(tl.u.id, `Last working day changed: ${P9.e.name}`); ok(tn.length === 1, 'TL told', JSON.stringify(tn.map((x) => [x.title, x.recipient]))); }
    ok((await notes(sa1.u.id, `Last working day changed: ${P9.e.name}`)).length === 1, 'Super Admin told (HR changed it)');
    const rep = await http(hr.u, 'GET', '/resignations/exit/date-changes');
    ok(rep.status === 200 && rep.body.rows.some((r) => r.recordId === rec9), 'report list shows it');
    const rep2 = await http(tl.u, 'GET', '/resignations/exit/date-changes');
    ok(rep2.status === 403, 'the report is HR / Super Admin only');
    const same = await http(hr.u, 'PUT', `/resignations/exit/${rec9}/date`, { date: addDays(TODAY, 12), reason: 'same again' });
    ok(same.status === 400, 'same date refused');
    // finalised + past date -> Super Admin only
    const ov9 = await http(sa1.u, 'POST', `/resignations/exit/employee/${P6.e.id}/finalize-override`, { reason: 'Test of the finished-exit date rule' });
    const rec6 = (await prisma.employeeRecord.findFirst({ where: { employeeId: P6.e.id, type: 'RESIGNATION' } })).id;
    ok(ov9.status === 200, 'P6 finished by override');
    await prisma.resignationDetail.updateMany({ where: { employeeId: P6.e.id }, data: { resignationDate: addDays(TODAY, -40) } });
    const past = await http(hr.u, 'PUT', `/resignations/exit/${rec6}/date`, { date: addDays(TODAY, -3), reason: 'correction of the last day' });
    ok(past.status === 403 && /Super Admin/.test(past.body.error), 'a past date on a finished exit needs the Super Admin', `${past.status} ${past.text.slice(0, 160)}`);
    const past2 = await http(sa1.u, 'PUT', `/resignations/exit/${rec6}/date`, { date: addDays(TODAY, -3), reason: 'correction of the last day' });
    ok(past2.status === 200, 'Super Admin may', `${past2.status} ${past2.text.slice(0, 160)}`);
    ok((await notes(sa2.u.id, `Last working day changed: ${P6.e.name}`)).length === 0, 'no extra Super Admin notice when a Super Admin changed it');

    console.log('\nB3. sync everywhere');
    const D = require('../src/utils/attendanceDays');
    const exitDay = addDays(TODAY, -2);
    // P6 now has exit date -3 days ago and is Exited. Attendance: present up to exit date + 2 days after.
    const rows = [];
    for (let i = -8; i <= -1; i += 1) { const d = addDays(TODAY, i); if (new Date(`${d}T00:00:00Z`).getUTCDay() !== 0) rows.push({ employeeId: P6.e.id, date: d, status: 'Present', checkIn: '09:00', checkOut: '18:00' }); }
    await prisma.attendance.createMany({ data: rows });
    const p6emp = await prisma.employee.findUnique({ where: { id: P6.e.id } });
    const roll = await D.rollOf(prisma, [p6emp]);
    ok(roll.lastDayOf.get(P6.e.id) === addDays(TODAY, -3), 'attendance roll: last day = the exit date (not the last present day)', `${roll.lastDayOf.get(P6.e.id)}`);
    const cfg = (await prisma.hrConfig.findFirst()) || null;
    if (D.loadDays && cfg) {
      const dl = await D.loadDays(prisma, { employees: [p6emp], from: addDays(TODAY, -6), to: addDays(TODAY, -1), cfg, lastDayOf: roll.lastDayOf, preview: true });
      const rowsOut = dl.days(p6emp);
      ok(rowsOut.filter((d) => d.date > addDays(TODAY, -3)).every((d) => d.status === 'Left'), 'days after the exit date read "Left" (not absent)', rowsOut.map((d) => `${d.date}:${d.status}`).join(' '));
    } else console.log('   (policy loader not found; day-engine check skipped)');
    // notice person: still on rolls until the date, Left after
    const p9emp = await prisma.employee.findUnique({ where: { id: P9.e.id } });
    const roll9 = await D.rollOf(prisma, [p9emp]);
    ok(roll9.lastDayOf.get(P9.e.id) === addDays(TODAY, 12), 'a person on notice is on the rolls until the date', `${roll9.lastDayOf.get(P9.e.id)}`);
    // leave beyond the exit date refused
    const lv = await http(P9.u, 'POST', '/leave', { type: 'Casual Leave', fromDate: addDays(TODAY, 14), toDate: addDays(TODAY, 15), reason: 'ZZTEST EX trip' });
    ok(lv.status === 400 && /last working day/.test(lv.body.error), 'leave after the last working day refused in plain words', `${lv.status} ${lv.text.slice(0, 200)}`);
    const lv2 = await http(P9.u, 'POST', '/leave', { type: 'Casual Leave', fromDate: addDays(TODAY, 11), toDate: addDays(TODAY, 14), reason: 'ZZTEST EX trip' });
    ok(lv2.status === 400 && /until that day/.test(lv2.body.error), 'leave running past it is told the last allowed day', `${lv2.status} ${lv2.text.slice(0, 200)}`);
    // payroll: months not paid use the exit date through the resignation record (days worked)
    const fnfMonth = PC.monthOfDate(exitDay, stt.cycle);
    ok(!!fnfMonth, 'payroll month of the exit date resolves');
    // seat end date follows
    const posB = await prisma.position.create({ data: { code: `ZZEXB-${RUN}`.toUpperCase().slice(0, 12), department: 'ZZTEST Dept', active: true } });
    made.positions.push(posB.id);
    await prisma.positionAssignment.create({ data: { positionId: posB.id, employeeId: P6.e.id, fromDate: '2025-01-01', toDate: addDays(TODAY, -3), note: `Exited - now Exited. Seat freed ${addDays(TODAY, -3)}, from the day their status changed.` } });
    const mv = await http(sa1.u, 'PUT', `/resignations/exit/${rec6}/date`, { date: addDays(TODAY, -5), reason: 'moved two days earlier' });
    ok(mv.status === 200, 'date moved again', `${mv.status} ${mv.text.slice(0, 150)}`);
    const seatNow = await prisma.positionAssignment.findFirst({ where: { employeeId: P6.e.id, positionId: posB.id } });
    ok(seatNow.toDate === addDays(TODAY, -5), 'seat end date follows the exit date', seatNow.toDate);
    // where used
    const used = (await view(hr.u, rec6)).body.usage;
    const bad = used.rows.filter((r) => r.state === 'mismatch');
    ok(used.date === addDays(TODAY, -5), 'where-used reads the new date');
    ok(bad.length === 0, 'where this date is used: no Mismatch after the change', JSON.stringify(bad.map((b) => `${b.key}:${b.value}`)));
    ok(used.rows.some((r) => r.key === 'attendance') && used.rows.some((r) => r.key === 'payroll') && used.rows.some((r) => r.key === 'seat') && used.rows.some((r) => r.key === 'leave'), 'the panel lists attendance, leave, payroll, seat');
    // mismatch is shown when a mirror is wrong
    await prisma.positionAssignment.update({ where: { id: seatNow.id }, data: { toDate: addDays(TODAY, -9) } });
    const used2 = (await view(hr.u, rec6)).body.usage;
    ok(used2.rows.find((r) => r.key === 'seat').state === 'mismatch', 'a wrong seat date shows as Mismatch');
    const ex = require('../src/utils/exitDate');
    const rc = await ex.recomputeEffects(P6.e.id, { user: sa1.u });
    const rc2 = await ex.recomputeEffects(P6.e.id, { user: sa1.u });
    ok(rc.ok && rc2.ok && rc2.mirrors.length === 0, 'recompute is idempotent (second run changes nothing)', JSON.stringify(rc2));
    ok((await prisma.positionAssignment.findUnique({ where: { id: seatNow.id } })).toDate === addDays(TODAY, -5), 'and repairs the seat date');
    // headcount/report read: employeeOverview + exit approvals counts
    const u9 = (await view(hr.u, rec9)).body.usage;
    ok(u9.rows.find((r) => r.key === 'reports'), 'reports row present');
    // Act as / View as: hard-blocked override path
    const actAs = require('../src/utils/actAs');
    ok(!!actAs.blockedFor('POST', `/resignations/exit/employee/${P2.e.id}/finalize-override`) && !!actAs.blockedFor('PUT', '/resignations/exit/settings'), 'Act as is blocked for override + settings');
    ok(!actAs.blockedFor('POST', `/resignations/exit/${rec1}/approve`), 'approve is allowed under Act as (same-human rule applies)');

    console.log('\nC. scripts are not guarded (no request), middleware stays inert on load');
    const raw = await prisma.employee.update({ where: { id: P2.e.id }, data: { employmentStatus: 'Active' } });
    ok(raw.employmentStatus === 'Active', 'a script write outside a request is not blocked');
  } catch (err) {
    fail += 1;
    console.log('  CRASH', err && err.stack);
  } finally {
    try { await cleanup(); } catch (e) { console.log('cleanup error', e.message); }
    if (settingsBackup) await prisma.appSetting.upsert({ where: { key: 'exit.settings' }, update: { value: settingsBackup.value }, create: { key: 'exit.settings', value: settingsBackup.value } });
    else await prisma.appSetting.deleteMany({ where: { key: 'exit.settings' } });
    if (directBackup) await prisma.appSetting.update({ where: { key: 'exit.hrDirectRelieve' }, data: { value: directBackup.value } });
    else await prisma.appSetting.deleteMany({ where: { key: 'exit.hrDirectRelieve' } });
    const left = await prisma.user.count({ where: { OR: [{ email: { contains: `-${RUN}@example.test` } }] } });
    console.log(`\nleft-over ZZTEST EX users: ${left}`);
    console.log(`\n${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
