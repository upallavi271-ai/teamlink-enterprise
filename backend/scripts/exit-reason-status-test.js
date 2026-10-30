#!/usr/bin/env node
// ---------------------------------------------------------------------------
// EXIT: THE REASON FOR LEAVING, AND "ALREADY LEFT" STAYS LEFT (founder 2026-10-30) - COPY DATABASE ONLY, never dev.db.
//
//   cd backend && npm run sandbox -- --restart --detach --no-watch
//   TL_API=http://localhost:4011 TL_TEST_DB=<absolute path of prisma/sandbox.db> node scripts/exit-reason-status-test.js
//
// 1. HR writes the reason for leaving and why (a configured reason, or their own words); it shows on the exit and in its history;
//    an ordinary employee cannot
// 2. a person whose status is Exited / Relieved: their exit shows that, never "Waiting for ... review", and is not in the
//    open exits list
// 3. profile completion: the full Aadhaar number (not on the employee's form) and the reporting manager are not counted
// A ZZTEST employee + exit record is made and removed again.
// ---------------------------------------------------------------------------
const path = require('path');

const BACK = path.resolve(__dirname, '..');
const API = String(process.env.TL_API || '').replace(/\/+$/, '').replace(/\/api$/, '');
if (!/^http:\/\/localhost:40(1[1-9]|[2-9][0-9])$/.test(API)) { console.error('Refusing: set TL_API=http://localhost:4011 (a copy-database server), never 4010.'); process.exit(2); }
const DB = process.env.TL_TEST_DB;
if (!DB || /dev\.db$/i.test(DB)) { console.error('Refusing: set TL_TEST_DB to the absolute path of a COPY database (never dev.db).'); process.exit(2); }
process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}`;
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}`;
process.env.TEST_MODE = '1';
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));

const RUN = Date.now().toString(36);
let pass = 0; let fail = 0;
function check(name, ok, detail) {
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail != null ? `  -> ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400)}` : ''}`);
}
async function call(method, p, token, body) {
  const h = { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual' });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}

(async () => {
  const made = { emp: null, rec: null };
  try {
    const admin = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN', status: 'Active' }, orderBy: { createdAt: 'asc' } });
    const plainEmp = await prisma.employee.findFirst({ where: { userId: { not: null }, employmentStatus: 'Active', user: { status: 'Active', role: { notIn: ['SUPER_ADMIN', 'ADMIN', 'HR'] }, hrmsRole: { notIn: ['HR', 'ADMIN', 'SUPER_ADMIN'] } }, department: { not: 'HR' } } });
    if (!admin || !plainEmp) throw new Error('no Super Admin / ordinary employee login in the copy');
    await prisma.user.updateMany({ where: { id: { in: [admin.id, plainEmp.userId] } }, data: { passwordChangedAt: new Date() } });
    const mint = async (id) => jwt.sign(tokenPayload(await resolveIdentity(id)), process.env.JWT_SECRET, { expiresIn: '1h' });
    const TA = await mint(admin.id); const TE = await mint(plainEmp.userId);

    made.emp = await prisma.employee.create({ data: { name: `ZZTEST EX ${RUN}`, employeeCode: `ZZX${RUN}`.slice(0, 12), email: `zz-ex-${RUN}@example.test`, department: 'Education', designation: 'Recruiter', employmentStatus: 'Notice Period', dateOfJoining: new Date('2025-01-10') } });
    made.rec = await prisma.employeeRecord.create({ data: { employeeId: made.emp.id, type: 'RESIGNATION', title: 'Resignation', status: 'Pending Approval', date: '2026-11-20' } });
    await prisma.resignationDetail.create({ data: { recordId: made.rec.id, employeeId: made.emp.id, employeeName: made.emp.name, resignationDate: '2026-10-20', reason: 'Personal / family reasons', requestedLastWorkingDate: '2026-11-20' } });

    // ---- 1. the reason ----
    const r1 = await call('PUT', `/api/resignations/exit/${made.rec.id}/reason`, TA, { reason: 'Better opportunity elsewhere', details: 'Got a higher salary at another consultancy' });
    check('R1 HR saves the reason for leaving', r1.status === 200, r1.body || r1.text);
    const own = 'Moving to Chennai with family';
    const r2 = await call('PUT', `/api/resignations/exit/${made.rec.id}/reason`, TA, { reason: own, details: 'Spouse transferred' });
    const d = await prisma.resignationDetail.findUnique({ where: { recordId: made.rec.id } });
    check('R2 their own words are kept (as "Other: ..."), with the why', r2.status === 200 && d.reasonOther === own && d.comments === 'Spouse transferred', [r2.status, d.reason, d.reasonOther, d.comments]);
    check('R3 the exit shows it, and HR gets the reason list', r2.body && r2.body.reason === `Other: ${own}` && r2.body.comments === 'Spouse transferred' && Array.isArray(r2.body.actions.reasonList) && r2.body.actions.canEditReason, r2.body && { reason: r2.body.reason, a: r2.body.actions && r2.body.actions.canEditReason });
    check('R4 it is in the exit history (who / old -> new)', r2.body && (r2.body.events || []).some((e) => /Reason for leaving/.test(e.action)), r2.body && (r2.body.events || []).map((e) => e.action));
    const r5 = await call('PUT', `/api/resignations/exit/${made.rec.id}/reason`, TE, { reason: 'x reason' });
    check('R5 an ordinary employee cannot write it (403)', r5.status === 403, r5.status);

    // ---- 2. already left stays left ----
    const w = await call('GET', `/api/resignations/exit/${made.rec.id}`, TA);
    check('S1 still serving: the exit waits for approval', w.body && w.body.stage === 'waiting', w.body && w.body.stageLabel);
    await prisma.employee.update({ where: { id: made.emp.id }, data: { employmentStatus: 'Exited' } });
    const x = await call('GET', `/api/resignations/exit/${made.rec.id}`, TA);
    check('S2 status Exited: the exit shows "Exited", not "Waiting for ... review"', x.body && x.body.stage === 'relieved' && x.body.stageLabel === 'Exited', x.body && x.body.stageLabel);
    const list = await call('GET', '/api/resignations/exit/approvals', TA);
    const rows = (list.body && list.body.rows) || [];
    check('S3 ...and it is not in the open exits list', list.status === 200 && !rows.some((r) => r.id === made.rec.id), [list.status, rows.length]);

    // ---- 3. completion ----
    const full = { phone: '9000000001', email: 'a@b.c', dateOfBirth: new Date('1995-01-01'), gender: 'Female', bloodGroup: 'O+', addressLine1: 'x', city: 'Hyderabad', state: 'Telangana', postalCode: '500001', emergencyContactName: 'y', emergencyContactPhone: '9000000002', branch: 'Hyderabad', bankName: 'SBI', bankAccountNumber: '123', ifscCode: 'SBIN0000001', panNumber: 'ABCDE1234F', educationDetails: 'B.Com', skills: 'Excel', location: 'Hyderabad' };
    await prisma.employee.update({ where: { id: made.emp.id }, data: { ...full, employmentStatus: 'Active', aadhaarNumber: null, reportingManagerId: null } });
    const e1 = await call('GET', `/api/employees/${made.emp.id}`, TA);
    const pct = e1.body && (e1.body.profileCompletionPct ?? (e1.body.employee && e1.body.employee.profileCompletionPct));
    check('C1 everything on the employee\'s form filled = 100%, with no full Aadhaar number and no reporting manager', pct === 100, [e1.status, pct]);
  } catch (e) {
    check('no error', false, e.stack || e.message);
  } finally {
    if (made.rec) {
      await prisma.auditLog.deleteMany({ where: { entityId: made.rec.id } }).catch(() => null);
      await prisma.approvalStep.deleteMany({ where: { recordId: made.rec.id } }).catch(() => null);
      await prisma.resignationDetail.deleteMany({ where: { recordId: made.rec.id } }).catch(() => null);
      await prisma.employeeRecord.delete({ where: { id: made.rec.id } }).catch(() => null);
    }
    if (made.emp) {
      await prisma.auditLog.deleteMany({ where: { entityId: made.emp.id } }).catch(() => null);
      await prisma.employee.delete({ where: { id: made.emp.id } }).catch((e) => console.log('cleanup:', e.message));
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
