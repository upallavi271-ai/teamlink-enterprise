#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ONE LEAVE PER DAY (founder 2026-11-13: "leave okka employee apply chestey ahh roju malli apply chesukokudadhu, duplicate ani ravali")
// COPY DATABASE ONLY.
//
//   cd backend
//   node scripts/leave-duplicate-day-test.js     makes its own VACUUM INTO copy of prisma/dev.db (opened READ-ONLY) in the temp folder,
//                                                starts a throw-away API on it (port 4098, TEST_MODE) and deletes both
//
// POST /api/leave refuses (409, code DUPLICATE_LEAVE, the words "Duplicate leave") a day that already has a Pending / Approved leave of the same
// person, whatever the leave type. Proved with a ZZTEST employee on the copy:
//   A  the first leave on a day is saved (201)
//   B  the same type again on that day is a duplicate (409)
//   C  ANOTHER type on that day is a duplicate too (409)
//   D  a range that touches that day is a duplicate (409)
//   E  a different day is fine (201)
//   F  a first half and a second half of one day are two different halves: allowed (201); the same half twice is a duplicate (409)
//   G  a Rejected leave frees its day (201)
//   H  another person on the same day is not affected (201)
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BACK = path.resolve(__dirname, '..');
const REAL = path.resolve(BACK, 'prisma', 'dev.db');
const copy = path.join(os.tmpdir(), `leavedup-${Date.now().toString(36)}.db`);
{
  const { DatabaseSync } = require('node:sqlite');
  const src = new DatabaseSync(REAL, { readOnly: true });
  src.exec(`VACUUM INTO '${copy.split(path.sep).join('/').replace(/'/g, "''")}'`);
  src.close();
}
const PORT = Number(process.env.TEST_PORT || 4098);
if (PORT === 4010) process.exit(2);
const API = `http://127.0.0.1:${PORT}`;
const DB_URL = `file:${path.resolve(copy).split(path.sep).join('/')}?socket_timeout=60`;
process.env.DATABASE_URL = DB_URL;
process.env.TEST_MODE = '1';
process.env.TEAMLINK_SANDBOX = '1';
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = DB_URL;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 600)}` : ''}`); };
const RUN = Date.now().toString(36);
const DEPT = `ZZTEST LDD Dept ${RUN}`;

async function post(p, body, token) {
  const r = await fetch(`${API}${p}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Forwarded-For': `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}
const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', atsRole: 'NONE', hrmsAccess: true, accountsAccess: false, atsAccess: false, status: 'Active' };
async function mk(tag, role) {
  const name = `ZZTEST LDD ${tag} ${RUN}`;
  const u = await prisma.user.create({ data: { ...base, name, email: `zz-ldd-${tag}-${RUN}@example.test`, username: `zz-ldd-${tag}-${RUN}@example.test`, role, hrmsRole: role === 'SUPER_ADMIN' ? 'NONE' : role } });
  const e = await prisma.employee.create({
    data: { employeeCode: `ZZLDD-${tag}-${RUN}`.slice(0, 40), name, userId: u.id, designation: 'Executive', employmentStatus: 'Active', department: DEPT, email: u.email, dateOfJoining: new Date('2025-01-01') },
  });
  const t = jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' });
  return { u, e, t };
}

let server = null;
(async () => {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const probe = new DatabaseSync(copy, { readOnly: true });
    const types = probe.prepare('SELECT type FROM LeaveRequest GROUP BY type ORDER BY COUNT(*) DESC LIMIT 3').all().map((r) => r.type);
    probe.close();
    const T1 = types[0]; const T2 = types.find((t) => t !== T1) || T1;
    console.log(`   leave types used: ${T1} / ${T2}`);

    server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
    let healthy = false;
    for (let i = 0; i < 90 && !healthy; i += 1) {
      try { healthy = (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
    if (!healthy) { console.error('The throw-away server did not start.\n', log.slice(-1500)); process.exit(3); }

    const admin = await mk('hr', 'HR'); // an HR login applies on behalf of the others, with the balance override, so only the duplicate rule is under test
    const a = await mk('a', 'EMPLOYEE');
    const b = await mk('b', 'EMPLOYEE');
    const apply = (who, o) => post('/api/leave', { employeeId: who.e.id, type: T1, reason: 'zz test', overrideBalance: true, ...o }, admin.t);
    const D1 = '2027-03-09'; const D2 = '2027-03-10'; const D3 = '2027-03-11'; const D4 = '2027-03-12';

    const r1 = await apply(a, { fromDate: D1, toDate: D1 });
    check('A1 the first leave on a day is saved', r1.status === 201, [r1.status, r1.text.slice(0, 200)]);
    const r2 = await apply(a, { fromDate: D1, toDate: D1 });
    check('B1 the same type again on that day is refused (409)', r2.status === 409, [r2.status, r2.text.slice(0, 200)]);
    check('B2 the message says Duplicate and the code is DUPLICATE_LEAVE', /^Duplicate leave/.test(r2.body?.error || '') && r2.body?.code === 'DUPLICATE_LEAVE' && r2.body?.duplicateOf === r1.body?.id, r2.body);
    const r3 = await apply(a, { fromDate: D1, toDate: D1, type: T2 });
    check('C1 ANOTHER leave type on that day is refused too (409, Duplicate)', r3.status === 409 && /^Duplicate leave/.test(r3.body?.error || ''), [r3.status, r3.text.slice(0, 200)]);
    const r4 = await apply(a, { fromDate: '2027-03-08', toDate: D2 });
    check('D1 a range that touches that day is refused (409, Duplicate)', r4.status === 409 && /^Duplicate leave/.test(r4.body?.error || ''), [r4.status, r4.text.slice(0, 200)]);
    const r5 = await apply(a, { fromDate: D2, toDate: D2 });
    check('E1 a different day is fine', r5.status === 201, [r5.status, r5.text.slice(0, 200)]);

    const h1 = await apply(a, { fromDate: D3, toDate: D3, halfDay: 'First Half' });
    check('F1 a first half is saved', h1.status === 201, [h1.status, h1.text.slice(0, 200)]);
    const h2 = await apply(a, { fromDate: D3, toDate: D3, halfDay: 'Second Half', type: T2 });
    check('F2 the other half of that day is allowed', h2.status === 201, [h2.status, h2.text.slice(0, 200)]);
    const h3 = await apply(a, { fromDate: D3, toDate: D3, halfDay: 'First Half', type: T2 });
    check('F3 the same half again is a duplicate (409)', h3.status === 409 && /^Duplicate leave/.test(h3.body?.error || ''), [h3.status, h3.text.slice(0, 200)]);
    const h4 = await apply(a, { fromDate: D3, toDate: D3 });
    check('F4 a whole day over a half day is a duplicate (409)', h4.status === 409, [h4.status, h4.text.slice(0, 200)]);

    const g1 = await apply(a, { fromDate: D4, toDate: D4 });
    check('G1 a leave on a fresh day is saved', g1.status === 201, [g1.status, g1.text.slice(0, 200)]);
    await prisma.leaveRequest.update({ where: { id: g1.body.id }, data: { status: 'Rejected' } });
    const g2 = await apply(a, { fromDate: D4, toDate: D4 });
    check('G2 once it is Rejected the day is free again', g2.status === 201, [g2.status, g2.text.slice(0, 200)]);

    const o1 = await apply(b, { fromDate: D1, toDate: D1 });
    const clashRow = o1.body && o1.body.duplicateOf ? await prisma.leaveRequest.findUnique({ where: { id: o1.body.duplicateOf }, select: { employeeId: true, type: true, fromDate: true, toDate: true, status: true } }) : null;
    check('H1 another person on the same day is not affected', o1.status === 201, [o1.status, o1.text.slice(0, 200), 'b=', b.e.id, 'a=', a.e.id, clashRow]);
  } catch (err) {
    fail += 1;
    console.error('ERROR', err);
  } finally {
    if (server) server.kill();
    await prisma.$disconnect().catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    [copy, `${copy}-wal`, `${copy}-shm`, `${copy}-journal`].forEach((f) => { try { fs.unlinkSync(f); } catch { /* gone */ } });
    console.log(`\n${pass} passed, ${fail} failed (the copy database is deleted; prisma/dev.db was only read)`);
    process.exit(fail ? 1 : 0);
  }
})();
