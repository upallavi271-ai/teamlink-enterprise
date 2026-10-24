#!/usr/bin/env node
// ---------------------------------------------------------------------------
// MARK AS EXITED / RELIEVED BY HR, NO APPROVAL (founder 2026-10-15) - SANDBOX ONLY.
//   node scripts/hr-relieve-now-test.js        (needs the sandbox API on :4011 and prisma/sandbox.db)
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
      passwordHash: 'x', name: `ZZTEST XR ${tag} ${RUN}`, email: `zz-xr-${tag.toLowerCase()}-${RUN}@example.test`, username: `zz-xr-${tag.toLowerCase()}-${RUN}@example.test`,
      role, hrmsRole, atsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: true, atsAccess: false, accountsAccess: false, status: 'Active', ...extra,
    },
  });
  made.users.push(u.id);
  const e = await prisma.employee.create({
    data: {
      employeeCode: `ZZXR${tag}${RUN}`.slice(0, 30), name: u.name, userId: u.id, email: u.email, designation: tag, department: 'ZZTEST Dept', employmentStatus: 'Active',
      dateOfJoining: new Date('2025-01-01T00:00:00.000Z'), ...emp,
    },
  });
  made.emps.push(e.id);
  return { u, e };
}
async function mkPerson(tag, status = 'Active', doj = '2025-01-01') {
  return mkUser(tag, 'EMPLOYEE', 'EMPLOYEE', {}, { dateOfJoining: new Date(`${doj}T00:00:00.000Z`), employmentStatus: status });
}
const empOf = (id) => prisma.employee.findUnique({ where: { id } });
const go = (actor, emp, body) => http(actor, 'POST', `/resignations/exit/employee/${emp.e.id}/relieve-now`, { reason: 'Better career opportunity', lastWorkingDate: TODAY, status: 'Relieved', ...body });
const SET_KEY = 'exit.hrDirectRelieve';

async function cleanup() {
  const empIds = made.emps;
  const recs = (await prisma.employeeRecord.findMany({ where: { employeeId: { in: empIds }, type: 'RESIGNATION' }, select: { id: true } })).map((r) => r.id);
  await prisma.approvalStep.deleteMany({ where: { workflow: 'resignation', recordId: { in: recs } } });
  await prisma.resignationDetail.deleteMany({ where: { employeeId: { in: empIds } } });
  await prisma.employeeRecord.deleteMany({ where: { employeeId: { in: empIds } } });
  await prisma.fnfRequest.deleteMany({ where: { employeeId: { in: empIds } } });
  await prisma.positionAssignment.deleteMany({ where: { employeeId: { in: empIds } } });
  if (made.positions.length) await prisma.position.deleteMany({ where: { id: { in: made.positions } } });
  await prisma.task.deleteMany({ where: { OR: [{ assigneeId: { in: made.users } }, { assignedById: { in: made.users } }, { name: { contains: 'ZZTEST XR' } }, { assigneeName: { contains: 'ZZTEST XR' } }] } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...empIds, ...recs, ...made.users] } }, { actorName: { contains: 'ZZTEST XR' } }, { userId: { in: made.users } }, { toValue: { contains: 'ZZTEST XR' } }, { reason: { contains: 'ZZTEST XR' } }] } });
  await prisma.notification.deleteMany({ where: { OR: [{ title: { contains: 'ZZTEST XR' } }, { userId: { in: made.users } }, { message: { contains: 'ZZTEST XR' } }] } });
  await prisma.employee.deleteMany({ where: { id: { in: empIds } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
}

(async () => {
  if (/4010/.test(API)) throw new Error('refusing 4010');
  const settingBackup = await prisma.appSetting.findUnique({ where: { key: SET_KEY } });
  try {
    const hr = await mkUser('HR', 'HR', 'HR', {}, { designation: 'HR' });
    const ihr = await mkUser('IHR', 'TL', 'CUSTOM_INTERNAL_HR', {}, { designation: 'TL' });
    const adm = await mkUser('ADM', 'ADMIN', 'ADMIN', {}, { designation: 'Admin' });
    const sa1 = await mkUser('SA1', 'SUPER_ADMIN', 'SUPER_ADMIN', {}, { designation: 'Super Admin' });
    const sa2 = await mkUser('SA2', 'SUPER_ADMIN', 'SUPER_ADMIN', {}, { designation: 'Super Admin' });
    const tl = await mkUser('TL', 'TL', 'TL', {}, { designation: 'TL' });
    const P = {};
    for (const t of ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8']) P[t] = await mkPerson(t);
    await prisma.appSetting.deleteMany({ where: { key: SET_KEY } });

    console.log('\nA. HR marks an Active person Relieved in ONE step (no exit record before)');
    const pos = await prisma.position.create({ data: { code: `ZZTEST-XR-${RUN}`, department: 'ZZTEST Dept', name: 'ZZTEST XR seat' } }).catch(() => null);
    if (pos) { made.positions.push(pos.id); await prisma.positionAssignment.create({ data: { positionId: pos.id, employeeId: P.P1.e.id, fromDate: '2025-01-01' } }); }
    const opt = await http(hr.u, 'GET', '/resignations/exit/relieve-now/options');
    ok(opt.status === 200 && opt.body.enabled === true && opt.body.canUse === true && Array.isArray(opt.body.reasons) && opt.body.reasons.length > 0, 'options: ON by default, HR can use it, reasons listed', opt.text.slice(0, 160));
    ok((await http(tl.u, 'GET', '/resignations/exit/relieve-now/options')).body.canUse === false, 'plain TL: canUse false');
    const a1 = await go(hr.u, P.P1, { reason: 'Custom typed reason', remarks: 'ZZTEST XR note' });
    ok(a1.status === 200 && a1.body.ok, 'HR relieves directly: 200', `${a1.status} ${a1.text.slice(0, 200)}`);
    const e1 = await empOf(P.P1.e.id);
    ok(e1.employmentStatus === 'Relieved', 'employee status = Relieved');
    const rec1 = await prisma.employeeRecord.findFirst({ where: { employeeId: P.P1.e.id, type: 'RESIGNATION' } });
    const det1 = rec1 && await prisma.resignationDetail.findUnique({ where: { recordId: rec1.id } });
    ok(rec1 && rec1.status === 'Relieved' && rec1.date === TODAY, 'exit record created: Relieved, canonical date = chosen day');
    ok(det1 && /HR direct relieve/.test(det1.source) && det1.reason === 'Other' && det1.reasonOther === 'Custom typed reason', 'record marked as HR direct; custom reason kept');
    ok((await prisma.fnfRequest.count({ where: { employeeId: P.P1.e.id } })) === 1, 'full & final request raised');
    if (pos) { const asg = await prisma.positionAssignment.findFirst({ where: { employeeId: P.P1.e.id } }); ok(asg && asg.toDate === TODAY, 'seat released on the last working day', JSON.stringify(asg)); }
    const au = await prisma.auditLog.findMany({ where: { entityId: rec1.id } });
    ok(au.some((x) => /^Resignation Relieved$/.test(x.action)) && au.some((x) => /WITHOUT approval/.test(x.action) && /marked .* Relieved directly/.test(x.reason || '') && (x.reason || '').includes(hr.u.name)), 'audit rows name who, reason and date');
    ok((await prisma.notification.count({ where: { userId: sa1.u.id, title: { contains: 'was marked Relieved' }, channel: 'In-App' } })) === 1 && (await prisma.notification.count({ where: { userId: sa2.u.id, channel: 'In-App', title: { contains: 'was marked Relieved' } } })) === 1, 'every Super Admin gets the bell');
    ok((await prisma.task.count({ where: { assigneeId: sa1.u.id, name: { contains: 'was marked Relieved' } } })) === 1, 'Super Admin gets an info task');
    const mail = await prisma.notification.findFirst({ where: { userId: sa1.u.id, channel: 'Email' } });
    ok(!mail || /Sent|Not sent/.test(mail.status), 'e-mail status is honest', mail ? mail.status : 'no mail row');
    const probe = await http(P.P1.u, 'GET', '/auth/me');
    console.log(`  info the relieved person's session right now: ${probe.status} ${(probe.body && probe.body.code) || ''}`);

    console.log('\nB. Internal HR marks Exited; Admin closes a pending request as Completed by HR');
    const b1 = await go(ihr.u, P.P2, { status: 'Exited' });
    ok(b1.status === 200 && (await empOf(P.P2.e.id)).employmentStatus === 'Exited', 'Internal HR: Exited', `${b1.status} ${b1.text.slice(0, 160)}`);
    const rec3 = await prisma.employeeRecord.create({ data: { type: 'RESIGNATION', employeeId: P.P3.e.id, title: 'x', status: 'Pending Approval', date: TODAY } });
    await prisma.approvalStep.create({ data: { workflow: 'resignation', recordId: rec3.id, seq: 1, level: 'TL', status: 'Pending', approverName: 'x' } }).catch((e) => console.log('  (step create:', e.message.slice(0, 80), ')'));
    const b2 = await go(adm.u, P.P3, {});
    const st3 = await prisma.approvalStep.findMany({ where: { workflow: 'resignation', recordId: rec3.id } });
    ok(b2.status === 200 && (await empOf(P.P3.e.id)).employmentStatus === 'Relieved' && (await prisma.employeeRecord.findUnique({ where: { id: rec3.id } })).status === 'Relieved', 'Admin: pending request does not block', `${b2.status} ${b2.text.slice(0, 160)}`);
    ok(st3.every((s) => s.status !== 'Pending' && /Completed by HR/.test(s.note || '')), 'pending steps closed as Completed by HR', JSON.stringify(st3.map((s) => [s.status, s.note])));

    console.log('\nC. Refusals in plain words');
    const c1 = await go(hr.u, hr, {});
    ok(c1.status === 403 && /own record/.test(c1.body.error), 'not on your own record', c1.text);
    const c2 = await go(hr.u, sa2, {});
    ok(c2.status === 403 && /Super Admin/.test(c2.body.error), 'HR cannot relieve a Super Admin login', c2.text);
    const c2b = await go(adm.u, sa2, {});
    ok(c2b.status === 403, 'Admin cannot relieve a Super Admin login', c2b.text);
    const c3 = await go(hr.u, P.P1, {});
    ok(c3.status === 409 && /already relieved/.test(c3.body.error), 'already relieved: plain message', c3.text);
    const c4 = await go(hr.u, P.P4, { lastWorkingDate: addDays(TODAY, 3) });
    ok(c4.status === 400 && /today or an earlier date/.test(c4.body.error), 'future date refused', c4.text);
    const c5 = await go(hr.u, P.P4, { lastWorkingDate: '2024-01-01' });
    ok(c5.status === 400 && /joining date/.test(c5.body.error), 'before the joining date refused', c5.text);
    const c6 = await go(hr.u, P.P4, { reason: '' });
    ok(c6.status === 400 && /reason/i.test(c6.body.error), 'missing reason refused', c6.text);
    const c8 = await go(tl.u, P.P5, {});
    ok(c8.status === 403, 'plain TL gets 403', c8.text);
    const c9 = await go(P.P6.u, P.P5, {});
    ok(c9.status === 403, 'plain employee gets 403');
    ok((await empOf(P.P5.e.id)).employmentStatus === 'Active' && (await empOf(P.P4.e.id)).employmentStatus === 'Active', 'refused people stay Active');

    console.log('\nD. Idempotency + rollback');
    const d1 = await Promise.all([go(hr.u, P.P7, {}), go(hr.u, P.P7, {})]);
    ok(d1.some((r) => r.status === 200) && (await prisma.employeeRecord.count({ where: { employeeId: P.P7.e.id, type: 'RESIGNATION' } })) === 1 && (await prisma.fnfRequest.count({ where: { employeeId: P.P7.e.id } })) === 1, 'double submit: one record, one settlement', d1.map((r) => r.status).join(','));
    const d2 = await go(hr.u, P.P8, { __testFail: true });
    ok(d2.status >= 400 && (await empOf(P.P8.e.id)).employmentStatus === 'Active' && (await prisma.employeeRecord.count({ where: { employeeId: P.P8.e.id } })) === 0 && (await prisma.fnfRequest.count({ where: { employeeId: P.P8.e.id } })) === 0, 'forced failure rolls everything back', `${d2.status} ${d2.text.slice(0, 120)}`);
    ok((await prisma.auditLog.count({ where: { entityId: P.P8.e.id, action: { contains: 'marked' } } })) === 0, 'no audit row left by the failed attempt');

    console.log('\nE. The emergency switch');
    const e1s = await http(hr.u, 'PUT', '/resignations/exit/relieve-now/setting', { enabled: false });
    ok(e1s.status === 403, 'HR cannot change the switch');
    const e2s = await http(adm.u, 'PUT', '/resignations/exit/relieve-now/setting', { enabled: false });
    ok(e2s.status === 200 && e2s.body.enabled === false, 'Admin switches it OFF');
    const e3 = await go(hr.u, P.P8, {});
    ok(e3.status === 409 && /no approved exit/.test(e3.body.error) && (await empOf(P.P8.e.id)).employmentStatus === 'Active', 'OFF: old message, nobody relieved', e3.text);
    await http(adm.u, 'PUT', '/resignations/exit/relieve-now/setting', { enabled: true });
    const e4 = await http(hr.u, 'PUT', `/employees/management/${P.P8.e.id}`, { employmentStatus: 'Relieved' });
    ok(!/no approved exit/.test(e4.text), 'ON: HR is never shown "has no approved exit" on the Edit route', `${e4.status} ${e4.text.slice(0, 160)}`);

    console.log('\nF. The old chain suites are run separately (exit-approval-test, hr-super-access-test, qa/hr-desk-test).');
  } finally {
    if (settingBackup) await prisma.appSetting.upsert({ where: { key: SET_KEY }, update: { value: settingBackup.value }, create: { key: SET_KEY, value: settingBackup.value } });
    else await prisma.appSetting.deleteMany({ where: { key: SET_KEY } });
    await cleanup().catch((e) => console.error('cleanup failed', e.message));
    await prisma.$disconnect();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
