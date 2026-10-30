#!/usr/bin/env node
// ---------------------------------------------------------------------------
// MY EMPLOYEE PROFILE: WHAT THEY FILLED, WHAT THEY DID NOT (founder 2026-10-30) - COPY DATABASE ONLY, never dev.db.
//
//   cd backend && npm run sandbox -- --restart --detach --no-watch
//   TL_API=http://localhost:4011 TL_TEST_DB=<absolute path of prisma/sandbox.db> node scripts/profile-fill-summary-test.js
//
// 1. GET /employees/me carries fillSummary: every field the employee may fill (no Aadhaar), filled or not, HR's label
// 2. after Submit the summary counts what they SUBMITTED (not the record before it)
// 3. HR sends it back: GET /me carries sentBack = the values they typed, so the form opens with them (it used to open with
//    the old record and everything had to be typed again)
// One employee with a login in the copy is used; its row and the audit rows made here are put back at the end.
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
  let before = null; const startedAt = new Date();
  try {
    const admin = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN', status: 'Active' }, orderBy: { createdAt: 'asc' } });
    const emp = await prisma.employee.findFirst({ where: { userId: { not: null }, isLocked: false, pendingChanges: null, employmentStatus: 'Active', user: { status: 'Active', role: { not: 'SUPER_ADMIN' } } } });
    if (!admin || !emp) throw new Error('no Super Admin / unlocked employee with a login in the copy');
    before = emp;
    await prisma.user.updateMany({ where: { id: { in: [admin.id, emp.userId] } }, data: { passwordChangedAt: new Date() } });
    const mint = async (id) => jwt.sign(tokenPayload(await resolveIdentity(id)), process.env.JWT_SECRET, { expiresIn: '1h' });
    const TA = await mint(admin.id); const TE = await mint(emp.userId);

    const m0 = await call('GET', '/api/employees/me', TE);
    const fs0 = m0.body && m0.body.fillSummary;
    check('F1 GET /me carries fillSummary: each field the employee may fill, with a label, filled or not', Array.isArray(fs0) && fs0.length >= 20 && fs0.every((x) => x.field && x.label && typeof x.filled === 'boolean'), m0.body && Object.keys(m0.body).slice(0, 5));
    check('F2 Aadhaar is not in it (it goes through the verification panel)', Array.isArray(fs0) && !fs0.some((x) => x.field === 'aadhaarNumber'));

    const bg = before.bloodGroup === 'O+' ? 'B+' : 'O+';
    const sent = { bloodGroup: bg, city: 'ZZ City', emergencyContactName: 'ZZ Contact', emergencyContactPhone: '9876543210', addressLine2: '' };
    const s = await call('PUT', '/api/employees/me', TE, sent);
    check('F3 the employee submits', s.status === 200, s.body || s.text);
    const m1 = await call('GET', '/api/employees/me', TE);
    const f1 = Object.fromEntries((m1.body.fillSummary || []).map((x) => [x.field, x.filled]));
    check('F4 after Submit the summary counts what they SUBMITTED (blood group, city, emergency contact filled)', f1.bloodGroup && f1.city && f1.emergencyContactName && f1.emergencyContactPhone, f1);
    check('F5 a field left empty shows as not filled', f1.addressLine2 === false || before.addressLine2, f1.addressLine2);
    const pc = Object.fromEntries((m1.body.pendingChanges || []).map((x) => [x.field, x.to]));
    check('F5b their OWN submitted phone / emergency contact are shown to them, not "(hidden)"', pc.emergencyContactPhone === '9876543210' && pc.emergencyContactName === 'ZZ Contact', m1.body.pendingChanges);

    const rj = await call('PATCH', `/api/employees/${emp.id}/changes/reject`, TA, { reason: 'ZZTEST fix the PAN' });
    check('F6 HR sends it back', rj.status === 200, rj.body || rj.text);
    const m2 = await call('GET', '/api/employees/me', TE);
    const sb = Object.fromEntries((m2.body.sentBack || []).map((x) => [x.field, x.to]));
    check('F7 sent back: GET /me carries what they typed (the form opens with it, not with the old record)', sb.bloodGroup === bg && sb.emergencyContactPhone === '9876543210' && sb.city === 'ZZ City' && sb.emergencyContactName === 'ZZ Contact', m2.body.sentBack);
    const f2 = Object.fromEntries((m2.body.fillSummary || []).map((x) => [x.field, x.filled]));
    check('F8 ...and the summary still counts those as filled', f2.bloodGroup && f2.city, f2);
  } catch (e) {
    check('no error', false, e.message);
  } finally {
    if (before) {
      const { id, createdAt, updatedAt, ...rest } = before; // eslint-disable-line no-unused-vars
      await prisma.employee.update({ where: { id }, data: rest }).catch((e) => console.log('restore failed', e.message));
      await prisma.auditLog.deleteMany({ where: { entity: 'Employee', entityId: id, createdAt: { gte: startedAt } } }).catch(() => null);
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
