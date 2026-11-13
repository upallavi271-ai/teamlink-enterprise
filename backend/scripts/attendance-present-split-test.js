#!/usr/bin/env node
// ---------------------------------------------------------------------------
// PRESENT vs CHECKED IN (founder 2026-11-13: "check-in employee ani chupistundhi malli total present lo 35 chupistundhi, conflict kakunda
// mention chey clear ga") - COPY DATABASE ONLY.
//
//   cd backend
//   node scripts/attendance-present-split-test.js   makes its own VACUUM INTO copy of prisma/dev.db (opened READ-ONLY) in the temp
//                                                   folder, starts a throw-away API on it (port 4099, TEST_MODE) and deletes both
//
// A day HR marks Present (or Work from home) by hand, with no punch and no time, is honoured as marked, so the day's Present is bigger than
// its Checked in. The day cards now say by how much: presentMarked / presentWfh on the day totals (GET /api/attendance/biometric), and the
// card filter ?dayStatus=markedPresent lists exactly those people. Proved with ZZTEST fixtures on the copy:
//   M  marked Present with no times: +1 Present, +1 presentMarked, Checked in unchanged
//   W  marked WFH: +1 Present, +1 presentWfh, Checked in unchanged
//   T  marked Present WITH an HR-set check-in time: +1 Present, +1 Checked in, not in presentMarked
//   O  only a check-out punch (Missing check-in): Present, not in presentMarked (it has the Missing check-in note)
//   P  a normal punched day: Present and Checked in, not in presentMarked
//   L  the list: ?dayStatus=markedPresent returns the two marked people and nobody else; the equation still adds up to the headcount
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BACK = path.resolve(__dirname, '..');
const REAL = path.resolve(BACK, 'prisma', 'dev.db');
const copy = path.join(os.tmpdir(), `presentsplit-${Date.now().toString(36)}.db`);
{
  const { DatabaseSync } = require('node:sqlite');
  const src = new DatabaseSync(REAL, { readOnly: true });
  src.exec(`VACUUM INTO '${copy.split(path.sep).join('/').replace(/'/g, "''")}'`);
  src.close();
}
const PORT = Number(process.env.TEST_PORT || 4099);
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
const DEPT = `ZZTEST PSP Dept ${RUN}`;

async function http(p, token) {
  const r = await fetch(`${API}${p}`, { headers: { Authorization: `Bearer ${token}`, 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }, signal: AbortSignal.timeout(180000) });
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body, text };
}
const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', atsRole: 'NONE', hrmsAccess: true, accountsAccess: false, atsAccess: false, status: 'Active' };
async function mk(tag, role) {
  const name = `ZZTEST PSP ${tag} ${RUN}`;
  const u = await prisma.user.create({ data: { ...base, name, email: `zz-psp-${tag}-${RUN}@example.test`, username: `zz-psp-${tag}-${RUN}@example.test`, role, hrmsRole: role } });
  const e = await prisma.employee.create({
    data: { employeeCode: `ZZPSP-${tag}-${RUN}`.slice(0, 40), name, userId: u.id, designation: 'Executive', employmentStatus: 'Active', department: DEPT, email: u.email, dateOfJoining: new Date('2025-01-01') },
  });
  const t = jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' });
  return { u, e, t };
}

let server = null;
(async () => {
  try {
    // a past working day with data in the copy: the latest weekday before today that has punches
    const { DatabaseSync } = require('node:sqlite');
    const probe = new DatabaseSync(copy, { readOnly: true });
    const DAY = probe.prepare("SELECT date FROM AttendancePunch WHERE date < date('now') AND strftime('%w', date) NOT IN ('0') GROUP BY date HAVING COUNT(*) > 15 ORDER BY date DESC LIMIT 1").get().date;
    probe.close();
    console.log(`   test day: ${DAY}`);

    server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
    let healthy = false;
    for (let i = 0; i < 90 && !healthy; i += 1) {
      try { healthy = (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
    if (!healthy) { console.error('The throw-away server did not start.\n', log.slice(-1500)); process.exit(3); }

    const hr = await mk('hr', 'HR');
    const q = (extra = '') => `/api/attendance/biometric?from=${DAY}&to=${DAY}${extra}`;
    const before = await http(q(`&department=${encodeURIComponent('zz-nothing')}`), hr.t); // warm-up, also proves the call shape
    check('B0 the day report answers (200) with the new counts present', before.status === 200 && before.body.totals && 'presentMarked' in before.body.totals && 'presentWfh' in before.body.totals, [before.status, before.text.slice(0, 160)]);
    const b0 = (await http(q(), hr.t)).body.totals;

    const m = await mk('m', 'EMPLOYEE'); // marked Present, no times
    const w = await mk('w', 'EMPLOYEE'); // marked WFH
    const t = await mk('t', 'EMPLOYEE'); // marked Present with an HR-set check-in time
    const o = await mk('o', 'EMPLOYEE'); // only a check-out punch
    const p = await mk('p', 'EMPLOYEE'); // a normal punched day
    await prisma.attendance.create({ data: { employeeId: m.e.id, date: DAY, status: 'Present' } });
    await prisma.attendance.create({ data: { employeeId: w.e.id, date: DAY, status: 'WFH' } });
    await prisma.attendance.create({ data: { employeeId: t.e.id, date: DAY, status: 'Present', checkIn: '09:20', checkOut: '18:10', timesSetBy: `ZZTEST HR ${RUN}`, timesSetAt: new Date() } });
    await prisma.attendancePunch.create({ data: { employeeId: o.e.id, date: DAY, time: '18:05', clockTime: '18:05:00', direction: 'Out', method: 'Biometric', source: 'Biometric device', verificationStatus: 'Device', deviceState: '1', deviceVerify: '1' } });
    await prisma.attendancePunch.create({ data: { employeeId: p.e.id, date: DAY, time: '09:10', clockTime: '09:10:00', direction: 'In', method: 'Biometric', source: 'Biometric device', verificationStatus: 'Device', deviceState: '0', deviceVerify: '1' } });
    await prisma.attendancePunch.create({ data: { employeeId: p.e.id, date: DAY, time: '18:30', clockTime: '18:30:00', direction: 'Out', method: 'Biometric', source: 'Biometric device', verificationStatus: 'Device', deviceState: '1', deviceVerify: '1' } });

    const b1 = (await http(q(), hr.t)).body.totals;
    const d = (k) => (b1[k] || 0) - (b0[k] || 0);
    check('M1 five new people are on the rolls and counted somewhere', d('headcount') === 5, [b0.headcount, b1.headcount]);
    check('M2 Present rose by 5 (marked, WFH, HR times, missing check-in, normal)', d('present') === 5, [b0.present, b1.present]);
    check('M3 presentMarked rose by 1 (only the person marked Present with no times)', d('presentMarked') === 1, [b0.presentMarked, b1.presentMarked]);
    check('W1 presentWfh rose by 1 (the work-from-home mark)', d('presentWfh') === 1, [b0.presentWfh, b1.presentWfh]);
    check('T1 Checked in rose by 3 (HR-set time, the check-out-only person has none, the normal person): HR times 1 + normal 1 = 2; so the marked / WFH / check-out-only add 0', d('checkedIn') === 2, [b0.checkedIn, b1.checkedIn]);
    check('P1 so Present - Checked in grew by 3: the marked, the WFH and the check-out-only person', d('present') - d('checkedIn') === 3, [d('present'), d('checkedIn')]);

    check('N1 presentNoIn rose by 3 (marked, WFH, check-out-only): Present = checked in + presentNoIn adds up exactly', d('presentNoIn') === 3 && (b1.present - b1.presentNoIn) >= 0, [b0.presentNoIn, b1.presentNoIn]);

    // the card list
    const list = await http(q('&dayStatus=markedPresent&all=1'), hr.t);
    const ids = (list.body?.rows || []).map((r) => r.employeeId);
    check('L1 the list behind the card has the marked and the WFH person and not the others', list.status === 200 && ids.includes(m.e.id) && ids.includes(w.e.id) && !ids.includes(t.e.id) && !ids.includes(o.e.id) && !ids.includes(p.e.id), [list.status, ids.length]);
    check('L2 the list is exactly presentMarked + presentWfh people', ids.length === (b1.presentMarked || 0) + (b1.presentWfh || 0), [ids.length, b1.presentMarked, b1.presentWfh]);
    const sum = ['present', 'halfDay', 'absent', 'onLeave', 'offDay', 'noRecord', 'notYet', 'upcoming'].reduce((n, k) => n + (b1[k] || 0), 0);
    check('L3 the cards still add up to the headcount', sum === b1.headcount, [sum, b1.headcount]);
    const oRow = (await http(q('&dayStatus=missingCheckIn&all=1'), hr.t)).body?.rows?.find((r) => r.employeeId === o.e.id);
    check('O1 the check-out-only person is Present with the Missing check-in note, not a "marked Present" one', !!oRow && !ids.includes(o.e.id), oRow && oRow.dayStatus);
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
