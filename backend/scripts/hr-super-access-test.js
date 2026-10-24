#!/usr/bin/env node
// ---------------------------------------------------------------------------
// INTERNAL HR "HR SUPER ACCESS" TEST (founder, 2026-10-14) - SANDBOX ONLY.
//   node scripts/hr-super-access-test.js        (needs the sandbox API on :4011 and prisma/sandbox.db)
// Creates ZZTEST HS users / employees in sandbox.db, drives the API as an Internal HR + TL login, a plain TL, a real Super Admin
// and an Admin, prints a checklist, then removes every row it made. It refuses to run against dev.db / port 4010.
// ---------------------------------------------------------------------------
/* eslint-disable no-console, no-await-in-loop */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const BACK = path.resolve(__dirname, '..');
const DB = path.join(BACK, 'prisma', (process.env.TL_TEST_DB || 'sandbox.db'));
if (!fs.existsSync(DB)) { console.error('No prisma/sandbox.db - start the sandbox first.'); process.exit(2); }
process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}`;
require('dotenv').config({ path: path.join(BACK, '.env') });
process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}`;
const API = `${String(process.env.TL_API || 'http://localhost:4011').replace(/\/+$/, '').replace(/\/api$/, '')}/api`; // TL_API: a private test server on its own port
const prisma = require('../src/db');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

let pass = 0; let fail = 0;
const checklist = [];
const ok = (cond, name, extra = '') => { if (cond) { pass += 1; console.log(`  ok   ${name}`); } else { fail += 1; console.log(`  FAIL ${name} ${extra}`); } };
const item = (name, cond, why = '') => { checklist.push(`${cond ? 'WORKS  ' : 'BLOCKED'}  ${name}${why ? ` (${why})` : ''}`); ok(cond, name, why); };
const tok = (u) => jwt.sign({ id: u.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function http(user, method, url, body, opts = {}) {
  let r;
  for (let i = 0; i < 15; i += 1) {
    try {
      r = await fetch(`${API}${url}`, { method, headers: { ...(user ? { Authorization: `Bearer ${tok(user)}` } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); break;
    } catch (e) {
      const refused = e && e.cause && e.cause.code === 'ECONNREFUSED';
      if (i === 14 || (method !== 'GET' && !refused)) return { status: 0, body: null, text: `connection lost (${e.cause && e.cause.code})`, headers: {} };
      await sleep(4000);
    }
  }
  const text = opts.binary ? '' : await r.text();
  if (opts.binary) await r.arrayBuffer();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text, headers: r.headers };
}
const RUN = Date.now().toString(36);
const TAG = 'ZZTEST HS';
const made = { users: [], emps: [], depts: [], positions: [], months: [], ann: [] };
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const TODAY = iso(new Date());

async function mkUser(tag, role, hrmsRole, atsRole, extra = {}, emp = {}, withEmployee = true) {
  const u = await prisma.user.create({
    data: {
      passwordHash: 'x', name: `${TAG} ${tag} ${RUN}`, email: `zz-hs-${tag.toLowerCase()}-${RUN}@example.test`, username: `zz-hs-${tag.toLowerCase()}-${RUN}@example.test`,
      role, hrmsRole, atsRole, accountsRole: 'NONE', hrmsAccess: true, atsAccess: !!atsRole && atsRole !== 'NONE', accountsAccess: false, status: 'Active', ...extra,
    },
  });
  made.users.push(u.id);
  let e = null;
  if (withEmployee) {
    e = await prisma.employee.create({
      data: {
        employeeCode: `ZZHS${tag}${RUN}`.slice(0, 30), name: u.name, userId: u.id, email: u.email, designation: emp.designation || tag, department: 'ZZTEST HS A', team: 'T1', employmentStatus: 'Active',
        dateOfJoining: new Date('2025-01-01T00:00:00.000Z'), ...emp,
      },
    });
    made.emps.push(e.id);
  }
  return { u, e };
}
async function mkEmp(tag, department, extra = {}) {
  const e = await prisma.employee.create({
    data: {
      employeeCode: `ZZHS${tag}${RUN}`.slice(0, 30), name: `${TAG} ${tag} ${RUN}`, email: `zz-hs-e-${tag.toLowerCase()}-${RUN}@example.test`, designation: 'Employee', department, team: 'T9',
      employmentStatus: 'Active', dateOfJoining: new Date('2025-01-01T00:00:00.000Z'), ...extra,
    },
  });
  made.emps.push(e.id);
  return e;
}
const notesFor = (userId, like) => prisma.notification.findMany({ where: { userId, title: { contains: like } } });
async function waitFor(fn, ms = 8000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await sleep(300); } }
const rowsOf = (b) => (Array.isArray(b) ? b : (b && (b.rows || b.employees || b.items || b.data)) || []);

async function cleanup() {
  // also sweeps anything an earlier, interrupted run of this test left behind (strong markers only)
  const left = await prisma.employee.findMany({ where: { OR: [{ employeeCode: { startsWith: 'ZZHS' } }, { name: { contains: TAG } }] }, select: { id: true } });
  const leftU = await prisma.user.findMany({ where: { email: { contains: 'zz-hs-' } }, select: { id: true } });
  made.emps = [...new Set([...made.emps, ...left.map((x) => x.id)])];
  made.users = [...new Set([...made.users, ...leftU.map((x) => x.id)])];
  const empIds = made.emps;
  const recs = (await prisma.employeeRecord.findMany({ where: { employeeId: { in: empIds } }, select: { id: true } })).map((r) => r.id);
  await prisma.approvalStep.deleteMany({ where: { recordId: { in: recs } } });
  await prisma.resignationDetail.deleteMany({ where: { employeeId: { in: empIds } } });
  await prisma.employeeRecord.deleteMany({ where: { employeeId: { in: empIds } } });
  await prisma.fnfRequest.deleteMany({ where: { employeeId: { in: empIds } } });
  await prisma.attendance.deleteMany({ where: { employeeId: { in: empIds } } });
  await prisma.leaveRequest.deleteMany({ where: { employeeId: { in: empIds } } });
  await prisma.leaveBalance.deleteMany({ where: { employeeId: { in: empIds } } }).catch(() => {});
  await prisma.positionAssignment.deleteMany({ where: { employeeId: { in: empIds } } });
  await prisma.salaryStructureVersion.deleteMany({ where: { employeeId: { in: empIds } } }).catch(() => {});
  await prisma.salaryStructure.deleteMany({ where: { employeeId: { in: empIds } } }).catch(() => {});
  for (const m of made.months) {
    await prisma.employeePayrollRun.deleteMany({ where: { month: m } }).catch(() => {});
    await prisma.payrollRun.deleteMany({ where: { month: m } }).catch(() => {});
    await prisma.payslip.deleteMany({ where: { month: m, employeeId: { in: empIds } } }).catch(() => {});
  }
  // the extra users the create-login checks made, found by their e-mail
  const extraUsers = await prisma.user.findMany({ where: { email: { contains: `zz-hs-e-` }, id: { notIn: made.users } }, select: { id: true } });
  const allUsers = [...made.users, ...extraUsers.map((u) => u.id)];
  await prisma.task.deleteMany({ where: { OR: [{ name: { contains: TAG } }, { assigneeId: { in: allUsers } }, { assignedById: { in: allUsers } }] } });
  await prisma.announcement.deleteMany({ where: { OR: [{ title: { contains: TAG } }, { postedById: { in: allUsers } }] } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...empIds, ...recs, ...allUsers] } }, { actorName: { contains: TAG } }, { userId: { in: allUsers } }, { toValue: { contains: TAG } }, { fromValue: { contains: TAG } }, { toValue: { contains: 'ZZHS' } }] } });
  await prisma.notification.deleteMany({ where: { OR: [{ title: { contains: TAG } }, { userId: { in: allUsers } }, { message: { contains: TAG } }, { message: { contains: 'ZZHS' } }, { recipient: { contains: 'zz-hs-' } }] } });
  await prisma.employee.deleteMany({ where: { id: { in: empIds } } });
  await prisma.employee.deleteMany({ where: { email: { contains: 'zz-hs-e-' } } });
  await prisma.user.deleteMany({ where: { id: { in: allUsers } } });
  for (const d of made.depts) await prisma.department.deleteMany({ where: { id: d } });
  if (made.roleCreated) { await prisma.roleAccess.deleteMany({ where: { role: 'CUSTOM_INTERNAL_HR' } }); await prisma.$executeRawUnsafe('DELETE FROM "Role" WHERE "code" = ?', 'CUSTOM_INTERNAL_HR'); }
}

(async () => {
  if (/4010/.test(API)) throw new Error('refusing 4010');
  const hrSuper = require('../src/utils/hrSuper');
  const settingBackup = await prisma.appSetting.findUnique({ where: { key: hrSuper.SETTINGS_KEY } });
  // 2026-10-15: the HR desk may mark Exited / Relieved directly (default ON). This suite proves the approval-chain parts, which apply
  // when the Admin's emergency switch is OFF: switched OFF for the run, put back after (hr-relieve-now-test.js covers ON).
  const directBackup = await prisma.appSetting.findUnique({ where: { key: 'exit.hrDirectRelieve' } });
  await prisma.appSetting.upsert({ where: { key: 'exit.hrDirectRelieve' }, update: { value: JSON.stringify({ enabled: false }) }, create: { key: 'exit.hrDirectRelieve', value: JSON.stringify({ enabled: false }) } });
  try {
    // ---------------- the cast ----------------
    const sa1 = await mkUser('SA1', 'SUPER_ADMIN', 'SUPER_ADMIN', 'SUPER_ADMIN', { atsAccess: true }, { designation: 'Super Admin' }, false);
    const sa2 = await mkUser('SA2', 'SUPER_ADMIN', 'SUPER_ADMIN', 'SUPER_ADMIN', { atsAccess: true }, { designation: 'Super Admin' }, false);
    const adm = await mkUser('ADM', 'ADMIN', 'ADMIN', 'NONE', {}, { designation: 'Admin' });
    const ih = await mkUser('IH', 'TL', 'TL', 'TL', { atsDepartment: 'ZZTEST HS A' }, { designation: 'TL' });
    const ihHr = await mkUser('IHHR', 'HR', 'HR', 'HR', {}, { designation: 'HR' }); // a second member: the HR-role person
    const tl = await mkUser('TL', 'TL', 'TL', 'TL', { atsDepartment: 'ZZTEST HS A' }, { designation: 'TL', team: 'T2' });
    const mine = await mkEmp('MINE', 'ZZTEST HS A', { team: 'T2', tl: tl.e.name });
    const depts = ['ZZTEST HS B', 'ZZTEST HS C', 'ZZTEST HS D'];
    const others = [];
    for (const d of depts) {
      const e = await mkEmp(`E${d.slice(-1)}`, d);
      await prisma.attendance.create({ data: { employeeId: e.id, date: TODAY, status: 'Present' } });
      const l = await prisma.leaveRequest.create({ data: { employeeId: e.id, fromDate: addDays(TODAY, 3), toDate: addDays(TODAY, 3), reason: `${TAG} leave`, status: 'Pending', type: 'Casual Leave' } });
      others.push({ e, l });
    }
    await prisma.appSetting.upsert({
      where: { key: hrSuper.SETTINGS_KEY },
      create: { key: hrSuper.SETTINGS_KEY, value: JSON.stringify({ enabled: true, emailSuperAdmins: true, notifyAdmins: false, users: [{ id: ih.u.id, name: ih.u.name }, { id: ihHr.u.id, name: ihHr.u.name }] }) },
      update: { value: JSON.stringify({ enabled: true, emailSuperAdmins: true, notifyAdmins: false, users: [{ id: ih.u.id, name: ih.u.name }, { id: ihHr.u.id, name: ihHr.u.name }] }) },
    });
    const roleMade = await hrSuper.ensureRole(null);
    made.roleCreated = !!roleMade.created;
    hrSuper.invalidate();
    await sleep(16000); // the server caches the setting for 8 s

    // ================= A. WHO IS WHO =================
    console.log('\nA. identity');
    const meIh = await http(ih.u, 'GET', '/auth/me');
    ok(meIh.status === 200 && meIh.body.hrSuper && meIh.body.hrSuper.real.role === 'TL', 'Internal HR + TL login: identity carries hrSuper and keeps the stored TL role', `${meIh.status} ${meIh.text.slice(0, 160)}`);
    const meTl = await http(tl.u, 'GET', '/auth/me');
    ok(meTl.status === 200 && !meTl.body.hrSuper && meTl.body.role === 'TL', 'plain TL: no hrSuper, still TL');
    const meSa = await http(sa1.u, 'GET', '/auth/me');
    ok(meSa.status === 200 && !meSa.body.hrSuper, 'real Super Admin: not an hrSuper');
    const login = await prisma.user.findUnique({ where: { id: ih.u.id } });
    ok(login.role === 'TL', 'the database still stores role TL for the Internal HR person');

    // ================= B. SEE EVERYTHING (company-wide scope) =================
    console.log('\nB. company-wide view: employees, attendance, leaves, payroll');
    const empIh = await http(ih.u, 'GET', '/employees');
    const emps = rowsOf(empIh.body);
    const seenDepts = new Set(emps.filter((e) => /ZZTEST HS/.test(e.name || '')).map((e) => e.department));
    item('Employee list: employees of 3 other departments', empIh.status === 200 && depts.every((d) => seenDepts.has(d)), `${empIh.status}; seen ${[...seenDepts].join(',')}`);
    const empTl = rowsOf((await http(tl.u, 'GET', '/employees')).body);
    ok(!empTl.some((e) => depts.includes(e.department)), 'plain TL does NOT see the other departments');
    ok(empTl.some((e) => e.id === mine.id), 'plain TL still sees their own team');
    const mgmt = await http(ih.u, 'GET', '/employees/management?pageSize=500');
    ok(mgmt.status === 200, 'Employee Management list opens', `${mgmt.status}`);
    const att = rowsOf((await http(ih.u, 'GET', `/attendance?date=${TODAY}`)).body);
    item('Attendance: rows of 3 other departments', others.every((o) => att.some((a) => a.employeeId === o.e.id)));
    const attTl = rowsOf((await http(tl.u, 'GET', `/attendance?date=${TODAY}`)).body);
    ok(!others.some((o) => attTl.some((a) => a.employeeId === o.e.id)), 'plain TL does not see other departments\' attendance');
    const lv = rowsOf((await http(ih.u, 'GET', '/leave')).body);
    item('Leaves: requests of 3 other departments', others.every((o) => lv.some((l) => l.id === o.l.id)));
    const lvTl = rowsOf((await http(tl.u, 'GET', '/leave')).body);
    ok(!others.some((o) => lvTl.some((l) => l.id === o.l.id)), 'plain TL does not see other departments\' leaves');
    const st = await http(ih.u, 'GET', '/payroll/structure');
    const stRows = rowsOf(st.body);
    item('Payroll: salary structure list shows 3 other departments', st.status === 200 && others.every((o) => stRows.some((r) => r.employeeId === o.e.id)), `${st.status}`);
    const stTl = await http(tl.u, 'GET', '/payroll/structure');
    ok(stTl.status === 403 || !others.some((o) => rowsOf(stTl.body).some((r) => r.employeeId === o.e.id)), 'plain TL: no salary structures of other departments');
    item('Payroll: run board / past runs open', (await http(ih.u, 'GET', '/payroll/runs')).status === 200);
    item('Payroll: preview opens', (await http(ih.u, 'GET', `/payroll/preview?month=${TODAY.slice(0, 7)}`)).status === 200);
    item('Payroll: reports open', (await http(ih.u, 'GET', '/payroll/reports')).status === 200);
    item('Payroll: payslips list opens', (await http(ih.u, 'GET', '/payroll')).status === 200);

    // ================= C. DO THINGS =================
    console.log('\nC. approve leave, announcements, payroll run, salary structure');
    const dec = await http(ih.u, 'PATCH', `/leave/${others[0].l.id}/decision`, { status: 'Approved', comment: 'ok' });
    item('Leave: approve another department\'s leave like a Super Admin', dec.status === 200 && (await prisma.leaveRequest.findUnique({ where: { id: others[0].l.id } })).status === 'Approved', `${dec.status} ${dec.text.slice(0, 160)}`);
    const a1 = await http(ih.u, 'POST', '/announcements', { title: `${TAG} A1 ${RUN}`, body: 'test', category: 'General', date: TODAY, pinned: false, target: 'All' });
    item('Announcements: create (all departments)', a1.status === 201 || a1.status === 200, `${a1.status} ${a1.text.slice(0, 160)}`);
    const aid = a1.body && (a1.body.id || (a1.body.announcement && a1.body.announcement.id));
    const pin = aid ? await http(ih.u, 'PUT', `/announcements/${aid}/pin`, { pinned: true }) : { status: 0 };
    item('Announcements: pin', pin.status === 200, `${pin.status}`);
    const sal = await http(ih.u, 'PUT', `/payroll/structure/${others[1].e.id}`, { ctc: 345678, payMode: 'Package', effectiveFrom: '2031-01' });
    item('Salary structure: edit another department\'s employee', sal.status === 200, `${sal.status} ${sal.text.slice(0, 200)}`);
    const mn = '2031-03';
    made.months.push(mn);
    const run = await http(ih.u, 'POST', '/payroll/run', { month: mn, department: depts[1] });
    item('Payroll: generate / run payroll for a department', [200, 201].includes(run.status), `${run.status} ${run.text.slice(0, 200)}`);
    const cs = await http(ih.u, 'GET', '/payroll/ctc-settings');
    item('Salary structure: company CTC settings readable', cs.status === 200 || cs.status === 404, `${cs.status}`);
    const sa1sees = await waitFor(async () => (await notesFor(sa1.u.id, 'edited a salary structure')).find(() => true));
    ok(!!sa1sees && sa1sees.message.includes(others[1].e.employeeCode), 'salary edit: Super Admin bell names the employee id', sa1sees ? sa1sees.message : 'none');
    ok(!!sa1sees && !/345\s?678|3,45,678/.test(sa1sees.message), 'salary edit: no amount in the notification text');
    ok((await prisma.auditLog.count({ where: { entity: 'HrSensitive', field: 'salary', userId: ih.u.id } })) >= 1, 'salary edit: audit row written');

    // ================= D. EXIT CHAIN =================
    console.log('\nD. exit: initiate (incl. a Notice Period person with no record), approve, early release, finish');
    const np = await mkEmp('NP', 'ZZTEST HS B', { employmentStatus: 'Notice Period' });
    const early0 = await http(ih.u, 'POST', `/resignations/exit/employee/${np.id}/initiate`, { reason: 'Notice period without a record', lastWorkingDate: addDays(TODAY, 15) });
    item('Exit: initiate for a Notice Period person who has no exit record', early0.status === 201, `${early0.status} ${early0.text.slice(0, 200)}`);
    const rec = early0.body && early0.body.recordId;
    const f0 = await http(ih.u, 'POST', `/resignations/exit/${rec}/finalize`, {});
    ok(f0.status === 409 && /not approved yet/i.test(f0.body && f0.body.error), 'finish before approval: plain 409 "not approved yet" (not a 403 "no permission")', `${f0.status} ${f0.text.slice(0, 200)}`);
    let last = null;
    for (let i = 0; i < 8; i += 1) {
      const cur = await prisma.approvalStep.findFirst({ where: { workflow: 'resignation', recordId: rec, status: 'Pending' } });
      if (!cur) break;
      last = await http(ih.u, 'POST', `/resignations/exit/${rec}/approve`, { note: 'ok' });
      if (last.status >= 400) break;
    }
    item('Exit: approve the chain like a Super Admin', !!last && last.status === 200 && (await prisma.employeeRecord.findUnique({ where: { id: rec } })).status === 'Notice Period', last ? `${last.status} ${last.text.slice(0, 200)}` : 'no step');
    const f1 = await http(ih.u, 'POST', `/resignations/exit/${rec}/finalize`, {});
    ok(f1.status === 409 && /Early release/i.test(f1.body && f1.body.error) && /last working day is/i.test(f1.body.error), 'finish before the last day: plain reason that names Early release', `${f1.status} ${f1.text.slice(0, 200)}`);
    const er = await http(ih.u, 'POST', `/resignations/exit/${rec}/early-release`, { note: `${TAG} agreed by the Super Admin` });
    item('Exit: early release', er.status === 200, `${er.status} ${er.text.slice(0, 160)}`);
    const f2 = await http(ih.u, 'POST', `/resignations/exit/${rec}/finalize`, {});
    item('Exit: FINAL "Relieved"', f2.status === 200 && (await prisma.employee.findUnique({ where: { id: np.id } })).employmentStatus === 'Relieved', `${f2.status} ${f2.text.slice(0, 200)}`);
    const rel = await waitFor(async () => (await notesFor(sa1.u.id, 'Exit finished by Internal HR'))[0]);
    ok(!!rel && /marked/.test(rel.message), 'Super Admin is told the exit was finished by Internal HR', rel ? rel.message : 'none');
    ok((await prisma.auditLog.count({ where: { entityId: rec, action: { contains: 'Relieved' }, userId: ih.u.id } })) >= 1, 'the finish is audited with the actor');
    const np2 = await mkEmp('NP2', 'ZZTEST HS C', { employmentStatus: 'Notice Period' });
    const ov = await http(ih.u, 'POST', `/resignations/exit/employee/${np2.id}/finalize-override`, { reason: 'because I say so, long enough' });
    item('Exit: "Finish without approval" override stays Super-Admin-only', ov.status === 403, `${ov.status}`);
    const tlInit = await http(tl.u, 'POST', `/resignations/exit/employee/${mine.id}/initiate`, { reason: 'x y z abc' });
    ok(tlInit.status === 403, 'plain TL still cannot start an exit for someone else');
    const tlPatch = await http(tl.u, 'PATCH', `/resignations/${rec}/status`, { status: 'Relieved' });
    ok([403, 409].includes(tlPatch.status), 'plain TL cannot relieve through the PATCH route either', `${tlPatch.status}`);

    // ================= E. THE KEPT GUARDS =================
    console.log('\nE. kept Super-Admin-only (an Internal HR login is refused, a real Super Admin is not)');
    const refused = async (name, method, url, body) => { const r = await http(ih.u, method, url, body); item(`Guard: ${name}`, r.status === 403, `${r.status} ${r.text.slice(0, 140)}`); return r; };
    await refused('edit the Role Catalog / permission matrix', 'PUT', '/admin/role-catalog/EMPLOYEE/modules/attendance', { moduleEnabled: true });
    await refused('create a role', 'POST', '/admin/role-catalog/roles', { name: `${TAG} role`, permissions: {} });
    await refused('change which role a designation gets', 'PUT', '/admin/designation-roles/TL', {});
    await refused('security settings (password alert)', 'PUT', '/admin/password-alert-setting', {});
    await refused('integration secrets (replace credentials)', 'PUT', '/admin/integrations/email/configure', { values: { host: 'x' } });
    await refused('View as / Act as', 'POST', `/admin/view-as/start`, { userId: tl.u.id });
    await refused('backups / restore', 'POST', '/system/backup', {});
    await refused('exit approval settings', 'PUT', '/resignations/exit/settings', {});
    await refused('the Internal HR list itself', 'PUT', '/admin/hr-super-access', { add: [tl.u.id] });
    await refused('switch off a Super Admin login', 'POST', `/admin/users/${sa1.u.id}/toggle-status`, {});
    await refused('reset a Super Admin password', 'POST', `/admin/users/${sa1.u.id}/reset-password`, { password: 'Zz-test-1234' });
    await refused('edit an Admin login', 'PUT', `/admin/users/${adm.u.id}`, { name: 'x' });
    await refused('their OWN roles (Employee Management)', 'PUT', `/employees/management/${ih.e.id}/roles`, { role: 'SUPER_ADMIN' });
    await refused('their OWN login (Users screen)', 'PUT', `/admin/users/${ih.u.id}`, { name: 'x' });
    const giveSa = await http(ih.u, 'PUT', `/admin/users/${tl.u.id}`, { role: 'SUPER_ADMIN' });
    item('Guard: give anybody the Super Admin role', giveSa.status === 403, `${giveSa.status} ${giveSa.text.slice(0, 120)}`);
    const giveIh = await http(ih.u, 'PUT', `/admin/users/${tl.u.id}`, { hrmsRole: hrSuper.ROLE_CODE });
    item('Guard: give anybody the Internal HR role', giveIh.status === 403, `${giveIh.status} ${giveIh.text.slice(0, 120)}`);
    const delSaEmp = await http(ih.u, 'DELETE', `/employees/${(await prisma.employee.findFirst({ where: { userId: sa1.u.id } }) || { id: 'none' }).id}`);
    ok([403, 404].includes(delSaEmp.status), 'no deleting an employee record that belongs to a Super Admin login', `${delSaEmp.status}`);
    const stList = await http(ih.u, 'GET', '/admin/audit?page=1&pageSize=5');
    ok(stList.status === 200, 'Administration pages still open for reading (audit)');
    ok((await http(ih.u, 'GET', '/admin/role-catalog')).status === 200, 'Role Catalog can be READ (only editing is guarded)');
    const adminGrant = await http(adm.u, 'PUT', '/admin/hr-super-access', { add: [mine.userId || tl.u.id] });
    ok(adminGrant.status === 200, 'an Admin can give Internal HR access', `${adminGrant.status} ${adminGrant.text.slice(0, 140)}`);
    const saRemove = await http(sa1.u, 'PUT', '/admin/hr-super-access', { remove: [tl.u.id] });
    ok(saRemove.status === 200, 'a real Super Admin can take it away again', `${saRemove.status}`);
    const guardsList = await http(sa1.u, 'GET', '/admin/hr-super-access');
    ok(guardsList.status === 200 && guardsList.body.guards.length >= 8, 'the kept-guards list is shown', `${guardsList.status}`);

    // ================= F. ALERTS =================
    console.log('\nF. delete / export / import alerts');
    const base1 = (await notesFor(sa1.u.id, 'Internal HR')).length;
    const base2 = (await notesFor(sa2.u.id, 'Internal HR')).length;
    // delete: three deletes in a burst
    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      const a = await http(ih.u, 'POST', '/announcements', { title: `${TAG} DEL${i} ${RUN}`, body: 'x', category: 'General', date: TODAY, target: 'All' });
      ids.push(a.body && (a.body.id || (a.body.announcement && a.body.announcement.id)));
    }
    let delOk = 0;
    for (const id of ids) { if (id && [200, 204].includes((await http(ih.u, 'DELETE', `/announcements/${id}`)).status)) delOk += 1; }
    item('Announcements: delete own announcements (3)', delOk === 3, `${delOk}/3`);
    const del1 = await waitFor(async () => (await notesFor(sa1.u.id, 'deleted something')).length >= 1 && (await notesFor(sa1.u.id, 'deleted something')));
    const del2 = await notesFor(sa2.u.id, 'deleted something');
    await sleep(1500);
    const delNow1 = await notesFor(sa1.u.id, 'deleted something');
    ok(delNow1.length === 1 && del2.length === 1, 'delete burst: exactly ONE notification per Super Admin', `sa1 ${delNow1.length}, sa2 ${del2.length}`);
    ok(delNow1[0] && /Internal HR\) deleted Announcements/.test(delNow1[0].message) && /3 times/.test(delNow1[0].message), 'the burst notification carries the count', delNow1[0] ? delNow1[0].message : 'none');
    ok((await prisma.task.count({ where: { assigneeId: sa1.u.id, name: { contains: 'deleted' } } })) === 1, 'one task for the Super Admin');
    const aud = await prisma.auditLog.findMany({ where: { entity: 'HrSensitive', userId: ih.u.id, field: 'delete' } });
    ok(aud.length === 1 && /3 times/.test(aud[0].reason || '') && /IP /.test(aud[0].reason || '') && /filters:/.test(aud[0].reason || ''), 'one audit row: who, module, count, filters, IP', aud[0] ? aud[0].reason : 'none');
    // export
    const ex = await http(ih.u, 'GET', '/employees/export.xlsx', null, { binary: true });
    item('Export: employee list (Excel)', ex.status === 200, `${ex.status}`);
    const exn = await waitFor(async () => (await notesFor(sa1.u.id, 'exported data'))[0]);
    ok(!!exn && /Internal HR\) exported/.test(exn.message) && /Employee/.test(exn.message), 'export: Super Admin bell with who / module', exn ? exn.message : 'none');
    ok(!!(await waitFor(async () => (await notesFor(sa2.u.id, 'exported data'))[0])), 'export: every Super Admin told');
    await http(ih.u, 'GET', '/employees/export.xlsx', null, { binary: true });
    await sleep(1500);
    ok((await notesFor(sa1.u.id, 'exported data')).length === 1, 'a second export inside 5 minutes does not make a second bell');
    // a CSV built in the browser (utils/csv.js downloadCsv) reports itself
    const ce = await http(ih.u, 'POST', '/admin/hr-sensitive/client-export', { name: 'attendance-report.csv', rows: 12, page: '/attendance' });
    const ceN = await waitFor(async () => (await notesFor(sa1.u.id, 'exported data')).find((n) => /Attendance/.test(n.message)));
    ok(ce.status === 204 && !!ceN && /12 rows/.test(ceN.message), 'browser-built CSV export: reported to the Super Admin', ceN ? ceN.message : `${ce.status} none`);
    const ce2 = await http(tl.u, 'POST', '/admin/hr-sensitive/client-export', { name: 'x.csv', rows: 1, page: '/attendance' });
    ok(ce2.status === 204, 'a plain TL calling it changes nothing');
    // import
    const fields = await http(ih.u, 'GET', '/employees/bulk-import/fields');
    const dept0 = ((fields.body && fields.body.departments) || [])[0];
    const dName = dept0 && (dept0.name || dept0);
    const imp = await http(ih.u, 'POST', '/employees/bulk-import', { rows: [{ name: `${TAG} IMP ${RUN}`, email: `zz-hs-e-imp-${RUN}@example.test`, department: dName, designation: 'Employee', employeeCode: `ZZHSIMP${RUN}`.slice(0, 20) }] });
    item('Import: employees (bulk import)', imp.status === 200, `${imp.status} ${imp.text.slice(0, 200)}`);
    const impn = await waitFor(async () => (await notesFor(sa1.u.id, 'imported data'))[0]);
    ok(!!impn && /Internal HR\) imported/.test(impn.message), 'import: Super Admin bell', impn ? impn.message : 'none');
    const created = await prisma.employee.findFirst({ where: { employeeCode: { startsWith: 'ZZHSIMP' } } });
    if (created) made.emps.push(created.id);
    // preview/dry run does not alert
    const before = (await notesFor(sa2.u.id, 'imported data')).length;
    await http(ih.u, 'POST', '/employees/bulk-import/preview', { rows: [{ name: `${TAG} PRE`, email: `zz-hs-e-pre-${RUN}@example.test`, department: dName, designation: 'Employee' }] });
    await sleep(1500);
    ok((await notesFor(sa2.u.id, 'imported data')).length === before, 'an import PREVIEW raises no alert');
    // the same by a REAL Super Admin: nothing for the OTHER Super Admin
    const sa2Before = (await notesFor(sa2.u.id, 'Internal HR')).length;
    const sa2BeforeTasks = await prisma.task.count({ where: { assigneeId: sa2.u.id } });
    const x1 = await http(sa1.u, 'POST', '/announcements', { title: `${TAG} SADEL ${RUN}`, body: 'x', category: 'General', date: TODAY, target: 'All' });
    const x1id = x1.body && (x1.body.id || (x1.body.announcement && x1.body.announcement.id));
    if (x1id) await http(sa1.u, 'DELETE', `/announcements/${x1id}`);
    await http(sa1.u, 'GET', '/employees/export.xlsx', null, { binary: true });
    await sleep(2500);
    ok((await notesFor(sa2.u.id, 'Internal HR')).length === sa2Before && (await prisma.task.count({ where: { assigneeId: sa2.u.id } })) === sa2BeforeTasks, 'the same delete + export by a REAL Super Admin makes no Internal HR alert');
    ok((await prisma.auditLog.count({ where: { entity: 'HrSensitive', userId: sa1.u.id } })) === 0, 'and no HR-sensitive audit row');
    // a plain TL: unaffected
    const tlDel = await http(tl.u, 'DELETE', `/announcements/${ids[0] || 'none'}`);
    ok([403, 404].includes(tlDel.status), 'plain TL: delete is still refused / nothing to delete', `${tlDel.status}`);
    await sleep(1000);
    ok((await prisma.auditLog.count({ where: { entity: 'HrSensitive', userId: tl.u.id } })) === 0, 'plain TL: no HR-sensitive audit row');
    // the HR-role member (second person)
    const hrDelA = await http(ihHr.u, 'POST', '/announcements', { title: `${TAG} HRDEL ${RUN}`, body: 'x', category: 'General', date: TODAY, target: 'All' });
    const hrDelId = hrDelA.body && (hrDelA.body.id || (hrDelA.body.announcement && hrDelA.body.announcement.id));
    if (hrDelId) await http(ihHr.u, 'DELETE', `/announcements/${hrDelId}`);
    ok(!!(await waitFor(async () => (await prisma.auditLog.count({ where: { entity: 'HrSensitive', userId: ihHr.u.id } })) >= 1)), 'the second Internal HR person (HR role) is watched the same way');
    // the "HR sensitive actions" list
    const listed = await http(sa1.u, 'GET', '/admin/audit?page=1&pageSize=20&entity=HrSensitive');
    ok(listed.status === 200 && listed.body.total >= 3, 'Audit Logs > HR sensitive actions lists the events', `${listed.status} ${listed.body && listed.body.total}`);
    void base1; void base2;

    // ================= G. SIGN-IN BLOCK + CREATE LOGIN =================
    console.log('\nG. left employees cannot sign in; create login (link only)');
    const gone = await mkUser('GONE', 'EMPLOYEE', 'EMPLOYEE', 'NONE', {}, { designation: 'Employee', employmentStatus: 'Exited', department: 'ZZTEST HS B' });
    const probe = await http(gone.u, 'GET', '/auth/me');
    ok(probe.status === 401 && probe.body && probe.body.code === 'EMPLOYMENT_ENDED', 'existing session of an Exited employee is signed out (401 EMPLOYMENT_ENDED)', `${probe.status} ${probe.text.slice(0, 120)}`);
    const pw = crypto.randomBytes(9).toString('base64url');
    await prisma.user.update({ where: { id: gone.u.id }, data: { passwordHash: await bcrypt.hash(pw, 4) } });
    const lg = await http(null, 'POST', '/auth/login', { email: gone.u.email, password: pw });
    ok(lg.status === 403 && lg.body && lg.body.code === 'EMPLOYMENT_ENDED', 'sign-in of an Exited employee is refused', `${lg.status} ${lg.text.slice(0, 120)}`);
    const active = await mkEmp('NOLOGIN', 'ZZTEST HS B');
    const cl = await http(ih.u, 'POST', `/employees/management/${active.id}/create-login`, {});
    const mk = await prisma.employee.findUnique({ where: { id: active.id } });
    item('Create login button route (Active employee, link only)', cl.status === 200 && !!mk.userId, `${cl.status} ${cl.text.slice(0, 200)}`);
    ok(cl.body && cl.body.credentials && !/password/i.test(JSON.stringify(Object.keys(cl.body.credentials))), 'no password in the answer (link only)', cl.body ? JSON.stringify(Object.keys(cl.body.credentials || {})) : '');
    const gone2 = await mkEmp('GONE2', 'ZZTEST HS B', { employmentStatus: 'Exited' });
    const cl2 = await http(ih.u, 'POST', `/employees/management/${gone2.id}/create-login`, {});
    ok(cl2.status === 409, 'no login for a person who left', `${cl2.status} ${cl2.text.slice(0, 120)}`);
    const noMail = await mkEmp('NOMAIL', 'ZZTEST HS B', { email: null });
    const cl3 = await http(ih.u, 'POST', `/employees/management/${noMail.id}/create-login`, {});
    ok(cl3.status === 400 && /email/i.test(cl3.body.error), 'no email: plain reason', `${cl3.status}`);
    const miss = await http(ih.u, 'GET', '/employees/management/missing-logins');
    ok(miss.status === 200 && Array.isArray(miss.body.rows), 'missing-logins panel list');
    const rowN = (miss.body.rows || []).find((r) => r.id === noMail.id);
    ok(rowN && !rowN.canCreate && /email/i.test(rowN.reason), 'panel: a person without e-mail is listed with the reason');
    ok(!(miss.body.rows || []).some((r) => r.id === gone2.id), 'panel: people who left are not listed');
    const m2 = await mkEmp('NOLOGIN2', 'ZZTEST HS C');
    const dry = await http(ih.u, 'POST', '/employees/management/create-missing-logins', { dryRun: true, ids: [m2.id] });
    ok(dry.status === 200 && dry.body.dryRun === true && dry.body.wouldCreate === 1 && !(await prisma.employee.findUnique({ where: { id: m2.id } })).userId, 'panel: dry run writes nothing');
    const real = await http(ih.u, 'POST', '/employees/management/create-missing-logins', { dryRun: false, ids: [m2.id] });
    ok(real.status === 200 && real.body.created === 1 && !!(await prisma.employee.findUnique({ where: { id: m2.id } })).userId, 'panel: confirm creates the login', `${real.status} ${real.text.slice(0, 160)}`);

    // ================= H. SCRIPT DRY RUNS =================
    console.log('\nH. data scripts, dry run');
    const deptsBefore = await prisma.department.count({ where: { name: 'Internal HR' } });
    const out = execFileSync(process.execPath, [path.join(BACK, 'scripts', 'set-internal-hr-v2.js'), '--db', DB], { encoding: 'utf8' });
    ok(/DRY RUN/.test(out) && /(WOULD CHANGE|STOP)/.test(out), 'set-internal-hr-v2.js prints a dry run');
    ok((await prisma.department.count({ where: { name: 'Internal HR' } })) === deptsBefore, 'it wrote nothing');
    const out2 = execFileSync(process.execPath, [path.join(BACK, 'scripts', 'deactivate-exited-logins.js'), '--db', DB], { encoding: 'utf8' });
    ok(/DRY RUN/.test(out2) && /Logins of people who have left/.test(out2), 'deactivate-exited-logins.js prints a dry run');
    let guarded = false;
    try { execFileSync(process.execPath, [path.join(BACK, 'scripts', 'set-internal-hr-v2.js'), '--db', path.join(BACK, 'prisma', 'dev.db'), '--apply'], { encoding: 'utf8', stdio: 'pipe' }); } catch (e) { guarded = /REAL database/.test(String(e.stderr || e.stdout)); }
    ok(guarded, 'applying on the real database is refused without the two guards');
  } catch (err) {
    fail += 1;
    console.log('  FAIL (crash)', err && err.stack);
  } finally {
    try {
      if (directBackup) await prisma.appSetting.update({ where: { key: 'exit.hrDirectRelieve' }, data: { value: directBackup.value } });
      else await prisma.appSetting.deleteMany({ where: { key: 'exit.hrDirectRelieve' } });
    } catch { /* ignore */ }
    try {
      if (settingBackup) await prisma.appSetting.update({ where: { key: 'hr-super-access' }, data: { value: settingBackup.value } });
      else await prisma.appSetting.deleteMany({ where: { key: 'hr-super-access' } });
    } catch { /* ignore */ }
    await cleanup().catch((e) => console.log('cleanup problem', e.message));
    require('../src/utils/hrSuper').invalidate();
  }
  console.log('\n=== CHECKLIST (Internal HR + TL login) ===');
  checklist.forEach((l) => console.log(l));
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
})();
