#!/usr/bin/env node
// ---------------------------------------------------------------------------
// PUNCH LOG TAB (HRMS -> Attendance -> Punch log, founder 2026-10-29) - COPY DATABASE ONLY.
//
//   cd backend
//   node scripts/attendance-punch-log-test.js     makes its own VACUUM INTO copy of prisma/dev.db (opened
//                                                 READ-ONLY) in the temp folder and deletes it after
//
// Starts its OWN throw-away API (port 4097, TEST_MODE=1 TEAMLINK_SANDBOX=1) on the copy, adds ZZTEST
// fixtures to the COPY only (two departments, a TL's team, device / web / imported punches) and proves
// over GET /api/attendance/punch-log:
//   P  one row per person per day: the number of punches, every punch time in order with where it
//      came from (device / web / import), first in and last out
//   S  scope: HR sees everyone, a TL their team, an employee only their own punches (even when asking
//      for somebody else), no login = 401
//   F  Department -> Employee cascade (the Employee list is the picked department's), ?employeeId,
//      the 62-day limit, server paging
//   E  the CSV / Excel export: the new columns, every row, the employee's own export
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BACK = path.resolve(__dirname, '..');
const REAL = path.resolve(BACK, 'prisma', 'dev.db');
const copy = path.join(os.tmpdir(), `punchlog-${Date.now().toString(36)}.db`);
{
  const { DatabaseSync } = require('node:sqlite');
  const src = new DatabaseSync(REAL, { readOnly: true });
  src.exec(`VACUUM INTO '${copy.split(path.sep).join('/').replace(/'/g, "''")}'`);
  src.close();
}
const PORT = Number(process.env.TEST_PORT || 4097);
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
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 700)}` : ''}`); };
const RUN = Date.now().toString(36);
const DAY = '2026-10-20';
const DEPT_A = `ZZTEST PLG Dept A ${RUN}`;
const DEPT_B = `ZZTEST PLG Dept B ${RUN}`;
const TEAM = `ZZTEST PLG team ${RUN}`;

async function http(method, p, token) {
  const h = { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(`${API}${p}`, { method, headers: h, redirect: 'manual', signal: AbortSignal.timeout(180000) });
  const buf = Buffer.from(await r.arrayBuffer());
  const text = buf.toString('utf8');
  let body = null; try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body, text, buf, type: r.headers.get('content-type') || '' };
}

const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', atsRole: 'NONE', hrmsAccess: true, accountsAccess: false, atsAccess: false, status: 'Active' };
async function mk(tag, role, dept, team) {
  const name = `ZZTEST PLG ${tag} ${RUN}`;
  const u = await prisma.user.create({ data: { ...base, name, email: `zz-plg-${tag}-${RUN}@example.test`, username: `zz-plg-${tag}-${RUN}@example.test`, role, hrmsRole: role } });
  const e = await prisma.employee.create({
    data: {
      employeeCode: `ZZPLG-${tag}-${RUN}`.slice(0, 40), name, userId: u.id, designation: role === 'TL' ? 'Team Lead' : 'Executive',
      employmentStatus: 'Active', department: dept, team: team || null, email: u.email, dateOfJoining: new Date('2025-01-01'),
    },
  });
  const t = jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' });
  return { u, e, t };
}
const punch = (e, time, direction, kind) => prisma.attendancePunch.create({
  data: kind === 'device'
    ? { employeeId: e.id, date: DAY, time: time.slice(0, 5), clockTime: time, direction, method: 'Biometric', source: 'Biometric device', verificationStatus: 'Device', deviceState: direction === 'Out' ? '1' : '0', deviceVerify: '1' }
    : kind === 'import'
      ? { employeeId: e.id, date: DAY, time: time.slice(0, 5), clockTime: time, direction, method: 'Biometric', source: 'PulseHRM import', verificationStatus: 'Imported' }
      : { employeeId: e.id, date: DAY, time: time.slice(0, 5), clockTime: time, direction, method: 'GPS / Location', source: 'Web' },
});

let server = null;
(async () => {
  try {
    server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
    let healthy = false;
    for (let i = 0; i < 90 && !healthy; i += 1) {
      try { healthy = (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
    if (!healthy) { console.error('The throw-away server did not start.\n', log.slice(-1500)); process.exit(3); }

    const hr = await mk('hr', 'HR', 'HR');
    const tl = await mk('tl', 'TL', DEPT_A, TEAM);
    const a = await mk('a', 'EMPLOYEE', DEPT_A, TEAM);
    const b = await mk('b', 'EMPLOYEE', DEPT_A, TEAM);
    const c = await mk('c', 'EMPLOYEE', DEPT_B, `ZZTEST PLG other team ${RUN}`);
    // A: four device punches (the founder's example). B: one web check-in. C: an imported old-HRMS day.
    for (const [t, d] of [['09:12:05', 'In'], ['13:30:10', 'Out'], ['13:58:44', 'In'], ['18:41:02', 'Out']]) await punch(a.e, t, d, 'device'); // eslint-disable-line no-await-in-loop
    await punch(b.e, '09:30:00', 'In', 'web');
    await punch(c.e, '09:01:00', 'In', 'import');
    await punch(c.e, '18:00:00', 'Out', 'import');
    await prisma.attendanceHistory.create({
      data: {
        employeeRef: c.e.employeeCode, employeeId: c.e.id, matchStatus: 'Matched', date: DAY, firstCheckIn: '09:01:00', lastCheckOut: '18:00:00',
        punchTimes: '09:01:00|12:00:00|18:00:00', sources: 'logs', result: 'ZZTEST', importBatch: `ZZTEST PLG ${RUN}`,
      },
    });
    const q = (extra = '') => `/api/attendance/punch-log?from=${DAY}&to=${DAY}${extra}`;
    const rowOf = (res, who) => (res.body?.rows || []).find((r) => r.employeeId === who.e.id);

    // P - what a row says
    const all = await http('GET', q(), hr.t);
    check('P0 HR loads the punch log (200)', all.status === 200 && Array.isArray(all.body?.rows), [all.status, all.text.slice(0, 200)]);
    const ra = rowOf(all, a);
    check('P1 A: 4 punches, in time order, each from the biometric device',
      ra && ra.punchCount === 4 && ra.punchList.map((p) => p.time.slice(0, 5)).join(',') === '09:12,13:30,13:58,18:41' && ra.punchList.every((p) => p.from === 'Biometric device'),
      ra && [ra.punchCount, ra.punchList]);
    check('P2 A: first in 09:12, last out 18:41, code + name + department + date on the row',
      ra && String(ra.firstInTime).startsWith('09:12') && String(ra.lastOutTime).startsWith('18:41') && ra.employeeCode === a.e.employeeCode && ra.name === a.e.name && ra.department === DEPT_A && ra.date === DAY,
      ra && [ra.firstInTime, ra.lastOutTime, ra.employeeCode, ra.department, ra.date]);
    const rb = rowOf(all, b);
    check('P3 B: 1 punch from the web check-in, no last out (never a made-up check-out)',
      rb && rb.punchCount === 1 && rb.punchList[0].from === 'Web check-in' && String(rb.firstInTime).startsWith('09:30') && rb.lastOutTime === null, rb && [rb.punchCount, rb.punchList, rb.lastOutTime]);
    const rc = rowOf(all, c);
    check('P4 C: the imported day shows the 3 punch times of the old log (Import), first 09:01 / last 18:00',
      rc && rc.punchCount === 3 && rc.punchList.map((p) => p.time.slice(0, 5)).join(',') === '09:01,12:00,18:00' && rc.punchList.every((p) => p.group === 'biometric' && /import/i.test(p.from))
        && String(rc.firstInTime).startsWith('09:01') && String(rc.lastOutTime).startsWith('18:00'), rc && [rc.punchCount, rc.punchList, rc.firstInTime, rc.lastOutTime]);
    check('P5 one row per person per day', (all.body?.rows || []).filter((r) => r.employeeId === a.e.id).length === 1);
    check('P6 the totals count punches, people and days of the whole list', all.body?.totals && all.body.totals.punches >= 8 && all.body.totals.employees >= 3 && all.body.totals.rows === all.body.rows.length, all.body?.totals);

    // S - scope
    const tlRes = await http('GET', q(), tl.t);
    const tlIds = new Set((tlRes.body?.rows || []).map((r) => r.employeeId));
    check('S1 a TL sees their team (A, B) and not another department (C)', tlRes.status === 200 && tlIds.has(a.e.id) && tlIds.has(b.e.id) && !tlIds.has(c.e.id), [tlRes.status, [...tlIds].length]);
    const me = await http('GET', q(), a.t);
    check('S2 an employee opens the tab (200) and sees only their own punches', me.status === 200 && me.body.rows.length === 1 && me.body.rows[0].employeeId === a.e.id && me.body.seesOthers === false,
      [me.status, me.body?.rows?.map((r) => r.employeeId), me.body?.seesOthers]);
    const sneak = await http('GET', q(`&employeeId=${c.e.id}`), a.t);
    check('S3 an employee asking for somebody else gets nothing', sneak.status === 200 && sneak.body.rows.length === 0, [sneak.status, sneak.body?.rows?.length]);
    check('S4 an employee is offered no other person in the Employee list', (me.body.facets.employeeId || []).every((o) => o.value === a.e.id), me.body.facets.employeeId);
    const anon = await http('GET', q());
    check('S5 no login = 401', anon.status === 401, anon.status);

    // F - filters
    const dA = await http('GET', q(`&department=${encodeURIComponent(DEPT_A)}`), hr.t);
    const empOpts = (dA.body?.facets?.employeeId || []).map((o) => o.value);
    check('F1 Department narrows the rows and the Employee list to that department',
      dA.status === 200 && dA.body.rows.every((r) => r.department === DEPT_A) && empOpts.includes(a.e.id) && empOpts.includes(tl.e.id) && !empOpts.includes(c.e.id), [dA.status, empOpts.length]);
    const depts = (dA.body?.facets?.department || []).map((o) => o.value);
    check('F2 the Department list still offers every department (with counts) after one is picked', depts.includes(DEPT_A) && depts.includes(DEPT_B) && dA.body.facets.department.every((o) => o.count > 0), depts.length);
    const optA = (dA.body?.facets?.employeeId || []).find((o) => o.value === a.e.id);
    check('F3 each Employee option carries the days it has in the list', optA && optA.count === 1, optA);
    const one = await http('GET', q(`&employeeId=${b.e.id}`), hr.t);
    check('F4 ?employeeId shows just that person', one.status === 200 && one.body.rows.length === 1 && one.body.rows[0].employeeId === b.e.id, [one.status, one.body?.rows?.length]);
    const long = await http('GET', '/api/attendance/punch-log?from=2026-08-01&to=2026-10-20', hr.t);
    check('F5 more than 62 days is refused (400)', long.status === 400, long.status);
    const pg = await http('GET', '/api/attendance/punch-log?from=2026-10-01&to=2026-10-20&page=2&pageSize=10', hr.t);
    check('F6 the server pages the rows (page 2 of 10 rows, with the total)', pg.status === 200 && pg.body.page && pg.body.page.page === 2 && pg.body.page.pageSize === 10 && pg.body.rows.length <= 10 && pg.body.page.total === pg.body.totals.rows,
      [pg.status, pg.body?.page, pg.body?.rows?.length]);

    // E - export
    const csv = await http('GET', q(`&department=${encodeURIComponent(DEPT_A)}&format=csv`), hr.t);
    const lines = csv.text.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
    const lineA = lines.find((l) => l.includes(a.e.employeeCode)) || '';
    check('E1 the CSV has the punch log columns', csv.status === 200 && /Number of punches/.test(lines[0] || '') && /Punch times \(where from\)/.test(lines[0]) && /First in/.test(lines[0]) && /Last out/.test(lines[0]) && /Time Interval/.test(lines[0]), [csv.status, lines[0]]);
    check('E2 A\'s CSV line: 4 punches, each time with its source, first in / last out', /,4,/.test(lineA) && lineA.includes('09:12 (Biometric device)') && lineA.includes('18:41 (Biometric device)') && lineA.includes('09:12') && lineA.includes('18:41'), lineA);
    const xl = await http('GET', q('&format=xlsx&page=1&pageSize=10'), hr.t);
    check('E3 Excel export downloads (a real .xlsx)', xl.status === 200 && xl.buf.slice(0, 2).toString() === 'PK', [xl.status, xl.type]);
    const myCsv = await http('GET', q('&format=csv'), a.t);
    const myLines = myCsv.text.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
    check('E4 an employee exports only their own punches', myCsv.status === 200 && myLines.length === 2 && myLines[1].includes(a.e.employeeCode), [myCsv.status, myLines.length]);
  } catch (e) {
    fail += 1;
    console.error('ERROR', e);
  } finally {
    if (server) server.kill();
    await prisma.$disconnect().catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    [copy, `${copy}-wal`, `${copy}-shm`, `${copy}-journal`].forEach((f) => { try { fs.unlinkSync(f); } catch { /* gone */ } });
    console.log(`\n${pass} passed, ${fail} failed (the copy database is deleted; prisma/dev.db was only read)`);
    process.exit(fail ? 1 : 0);
  }
})();
