#!/usr/bin/env node
// ---------------------------------------------------------------------------
// PUNCH LOG - TIME INTERVAL (founder 2026-11-13) - COPY DATABASE ONLY.
//
//   cd backend
//   node scripts/attendance-interval-test.js     makes its own VACUUM INTO copy of prisma/dev.db (opened READ-ONLY) in the
//                                                temp folder, starts a throw-away API on it (port 4098, TEST_MODE) and deletes both
//
// "Even when HR checked the person in by hand, a later biometric punch counts as an interval; add a Time interval column; every
// punch is recorded." Proved over GET /api/attendance/punch-log with real device lines fed through the device ingest
// (utils/biometricDevice.js ingestAttlog) after an HR manual check-in:
//   A  HR set the check-in / check-out in Marked attendance, then the person pressed the device twice: both presses are stored,
//      HR's times still stand, the two presses are an interval (out -> back, minutes away), HR's times are in the list
//   B  HR typed a check-in punch, then the device: the later presses are intervals, the day's check-out is the last pressed out
//   C  a device-only day: first in / interval pair / last out
//   D  one web check-in: no interval, no made-up check-out
//   E  HR's time and a device punch in the same minute: one entry, not two
//   G  an imported old-HRMS day
//   H  the Excel / CSV export: old "Time Interval" unchanged, the new "Intervals" column
//   S  an employee sees only their own interval; nothing about the day's marking changed (HR's times stand, device days marked)
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BACK = path.resolve(__dirname, '..');
const REAL = path.resolve(BACK, 'prisma', 'dev.db');
const copy = path.join(os.tmpdir(), `interval-${Date.now().toString(36)}.db`);
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
const bio = require(path.join(BACK, 'src/utils/biometricDevice'));
const PIV = require(path.join(BACK, 'src/utils/punchIntervals'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 700)}` : ''}`); };
const RUN = Date.now().toString(36);
const DAY = '2026-10-21';
const DEPT = `ZZTEST PIV Dept ${RUN}`;

async function http(method, p, token) {
  const h = { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(`${API}${p}`, { method, headers: h, redirect: 'manual', signal: AbortSignal.timeout(180000) });
  const buf = Buffer.from(await r.arrayBuffer());
  const text = buf.toString('utf8');
  let body = null; try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body, text, buf };
}

const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', atsRole: 'NONE', hrmsAccess: true, accountsAccess: false, atsAccess: false, status: 'Active' };
async function mk(tag, role, dept) {
  const name = `ZZTEST PIV ${tag} ${RUN}`;
  const u = await prisma.user.create({ data: { ...base, name, email: `zz-piv-${tag}-${RUN}@example.test`, username: `zz-piv-${tag}-${RUN}@example.test`, role, hrmsRole: role } });
  const e = await prisma.employee.create({
    data: {
      employeeCode: `ZZPIV-${tag}-${RUN}`.slice(0, 40), name, userId: u.id, designation: 'Executive', employmentStatus: 'Active', department: dept,
      email: u.email, dateOfJoining: new Date('2025-01-01'), biometricPin: `ZZ${tag}${RUN}`,
    },
  });
  const t = jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' });
  return { u, e, t, pin: `ZZ${tag}${RUN}` };
}
const typedPunch = (e, time, direction) => prisma.attendancePunch.create({
  data: { employeeId: e.id, date: DAY, time: time.slice(0, 5), clockTime: time, direction, method: 'GPS / Location', source: 'Manual entry', verificationStatus: 'Not applicable (entered by HR)' },
});
const webPunch = (e, time, direction) => prisma.attendancePunch.create({
  data: { employeeId: e.id, date: DAY, time: time.slice(0, 5), clockTime: time, direction, method: 'GPS / Location', source: 'Web' },
});
// real device lines, through the device ingest: PIN \t YYYY-MM-DD HH:MM:SS \t state \t verify
let device = null;
const press = async (who, lines) => bio.ingestAttlog(device, lines.map(([t, state]) => `${who.pin}\t${DAY} ${t}\t${state}\t1`).join('\n'));

let server = null;
(async () => {
  try {
    // ---- the pure rule first (no server) ------------------------------------------------------------------------
    {
      const raw = (arr) => arr.map(([time, direction, source, sourceLabel]) => ({ time, direction, source, sourceLabel, group: source }));
      const v1 = PIV.build({ rawPunches: raw([['13:00:10', 'In', 'biometric', 'Biometric device'], ['14:05:30', 'In', 'biometric', 'Biometric device']]), record: { timesSetBy: 'HR', checkIn: '09:30', checkOut: '18:30' }, firstInTime: '13:00:10', lastOutTime: null });
      check('U1 pure: HR times 09:30 / 18:30 + two device presses -> check-in, interval, interval, check-out',
        v1.entries.map((e) => `${e.time.slice(0, 5)}:${e.kind}`).join(',') === '09:30:checkin,13:00:interval,14:05:interval,18:30:checkout', v1.entries);
      check('U2 pure: the two presses pair up out -> back with 65 minutes away', v1.intervals.length === 1 && v1.intervals[0].minutes === 65 && v1.intervalMinutes === 65, v1.intervals);
      const v2 = PIV.build({ rawPunches: raw([['09:00:00', 'In', 'web', 'Web check-in'], ['12:00:00', 'Out', 'web', 'Web check-in'], ['12:30:00', 'In', 'web', 'Web check-in'], ['13:00:00', 'Out', 'web', 'Web check-in'], ['18:00:00', 'Out', 'web', 'Web check-in']]), record: null, firstInTime: '09:00:00', lastOutTime: '18:00:00' });
      check('U3 pure: three in-between times -> one pair and one with no return (never guessed)', v2.intervals.length === 2 && v2.intervals[0].minutes === 30 && v2.intervals[1].to === null && v2.intervals[1].minutes === null, v2.intervals);
      const v3 = PIV.build({ rawPunches: raw([['09:00:00', 'In', 'web', 'Web check-in']]), record: null, firstInTime: '09:00:00', lastOutTime: null });
      check('U4 pure: one punch -> no interval', v3.intervals.length === 0 && v3.entries[0].kind === 'checkin');
      const v4 = PIV.build({ rawPunches: [], record: { timesSetBy: 'HR', checkIn: '09:30', checkOut: null }, firstInTime: null, lastOutTime: null });
      check('U5 pure: HR set only a check-in and nothing else -> one HR entry', v4.entries.length === 1 && v4.entries[0].source === 'hr' && v4.entries[0].kind === 'checkin' && v4.intervals.length === 0, v4.entries);
      check('U6 pure: the export text', PIV.intervalsText(v1.intervals) === '13:00 → 14:05 (1h 05m)' && PIV.intervalsText(v2.intervals) === '12:00 → 12:30 (30 min); 13:00 → no return recorded', [PIV.intervalsText(v1.intervals), PIV.intervalsText(v2.intervals)]);
    }

    server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
    let healthy = false;
    for (let i = 0; i < 90 && !healthy; i += 1) {
      try { healthy = (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
    if (!healthy) { console.error('The throw-away server did not start.\n', log.slice(-1500)); process.exit(3); }

    device = await prisma.biometricDevice.create({ data: { vendor: 'ZKTeco', serialNumber: `ZZTEST-PIV-${RUN}`, endpoint: 'http://zz.example.test', status: 'Active' } });
    const hr = await mk('hr', 'HR', 'HR');
    const a = await mk('a', 'EMPLOYEE', DEPT); // HR set the times by hand, then the device
    const b = await mk('b', 'EMPLOYEE', DEPT); // HR typed a check-in punch, then the device
    const c = await mk('c', 'EMPLOYEE', DEPT); // device only
    const d = await mk('d', 'EMPLOYEE', DEPT); // one web check-in
    const e = await mk('e', 'EMPLOYEE', DEPT); // HR time and a device punch in the same minute
    const g = await mk('g', 'EMPLOYEE', DEPT); // imported day

    // A: HR set 09:30 -> 18:30 in Marked attendance (the times stand over punches), then the device is pressed twice (state 0 both times).
    await prisma.attendance.create({ data: { employeeId: a.e.id, date: DAY, status: 'Present', checkIn: '09:30', checkOut: '18:30', timesSetBy: `ZZTEST HR ${RUN}`, timesSetAt: new Date() } });
    const ra0 = await press(a, [['13:00:10', 0], ['14:05:30', 0]]);
    // B: HR typed a check-in punch 09:30, then the device: In 13:00 (state 0), Out 18:30 (state 1).
    await typedPunch(b.e, '09:30:00', 'In');
    await press(b, [['13:00:00', 0], ['18:30:00', 1]]);
    // C: device only, the founder's four presses.
    await press(c, [['09:12:05', 0], ['13:30:10', 1], ['13:58:44', 0], ['18:41:02', 1]]);
    // D: one web check-in.
    await webPunch(d.e, '09:30:00', 'In');
    // E: HR set 09:12, the device pressed at 09:12:05 the same minute, then check-out 18:00 by hand.
    await prisma.attendance.create({ data: { employeeId: e.e.id, date: DAY, status: 'Present', checkIn: '09:12', checkOut: '18:00', timesSetBy: `ZZTEST HR ${RUN}`, timesSetAt: new Date() } });
    await press(e, [['09:12:05', 0]]);
    // G: an imported old-HRMS day.
    await prisma.attendancePunch.create({ data: { employeeId: g.e.id, date: DAY, time: '09:01', clockTime: '09:01:00', direction: 'In', method: 'Biometric', source: 'PulseHRM import', verificationStatus: 'Imported' } });
    await prisma.attendancePunch.create({ data: { employeeId: g.e.id, date: DAY, time: '18:00', clockTime: '18:00:00', direction: 'Out', method: 'Biometric', source: 'PulseHRM import', verificationStatus: 'Imported' } });
    await prisma.attendanceHistory.create({
      data: { employeeRef: g.e.employeeCode, employeeId: g.e.id, matchStatus: 'Matched', date: DAY, firstCheckIn: '09:01:00', lastCheckOut: '18:00:00', punchTimes: '09:01:00|12:00:00|18:00:00', sources: 'logs', result: 'ZZTEST', importBatch: `ZZTEST PIV ${RUN}` },
    });

    const q = (extra = '') => `/api/attendance/punch-log?from=${DAY}&to=${DAY}${extra}`;
    const all = await http('GET', q(`&department=${encodeURIComponent(DEPT)}`), hr.t);
    const rowOf = (who) => (all.body?.rows || []).find((r) => r.employeeId === who.e.id);
    const kinds = (r) => (r ? r.punchList.map((p) => `${String(p.time).slice(0, 5)}:${p.kind}:${p.group}`).join(',') : '');
    check('P0 HR loads the punch log (200)', all.status === 200 && Array.isArray(all.body?.rows), [all.status, all.text.slice(0, 200)]);

    // A
    const rowsA = await prisma.attendancePunch.findMany({ where: { employeeId: a.e.id, date: DAY } });
    check('A1 both device presses after the HR check-in are stored (ingest applied 2)', ra0.applied === 2 && rowsA.length === 2, [ra0, rowsA.length]);
    const attA = await prisma.attendance.findUnique({ where: { employeeId_date: { employeeId: a.e.id, date: DAY } } });
    check('A2 HR\'s times still stand over the device presses (09:30 / 18:30, set by HR)', attA && attA.checkIn === '09:30' && attA.checkOut === '18:30' && !!attA.timesSetBy, attA);
    const ra = rowOf(a);
    check('A3 the list has HR\'s check-in, the two presses as intervals, HR\'s check-out',
      ra && kinds(ra) === '09:30:checkin:hr,13:00:interval:biometric,14:05:interval:biometric,18:30:checkout:hr', ra && kinds(ra));
    check('A4 one interval: 13:00 -> 14:05, 65 minutes away; the text says so', ra && ra.intervals.length === 1 && ra.intervals[0].minutes === 65 && ra.intervalMinutes === 65 && ra.intervalText === '13:00 → 14:05 (1h 05m)', ra && [ra.intervals, ra.intervalText]);
    check('A5 First in / Last out read HR\'s times (09:30 / 18:30), as Marked attendance does; Punches counts the 2 real punches', ra && ra.firstInTime === '09:30' && ra.lastOutTime === '18:30' && ra.punchCount === 2 && ra.hrSetTimes === true, ra && [ra.firstInTime, ra.lastOutTime, ra.punchCount, ra.hrSetTimes]);

    // B
    const rb = rowOf(b);
    check('B1 HR typed a check-in, then the device: HR check-in, the 13:00 press as an interval, the 18:30 check-out',
      rb && kinds(rb) === '09:30:checkin:hr,13:00:interval:biometric,18:30:checkout:biometric', rb && kinds(rb));
    check('B2 the 13:00 press has no return recorded (not guessed); first in 09:30, last out 18:30; 3 punches', rb && rb.intervals.length === 1 && rb.intervals[0].to === null && rb.intervals[0].minutes === null && rb.firstInTime.startsWith('09:30') && rb.lastOutTime.startsWith('18:30') && rb.punchCount === 3 && rb.hrSetTimes === false,
      rb && [rb.intervals, rb.firstInTime, rb.lastOutTime, rb.punchCount]);

    // C
    const rc = rowOf(c);
    check('C1 device only: check-in 09:12, interval pair 13:30 -> 13:58 (28 min), check-out 18:41',
      rc && kinds(rc) === '09:12:checkin:biometric,13:30:interval:biometric,13:58:interval:biometric,18:41:checkout:biometric' && rc.intervals.length === 1 && rc.intervals[0].minutes === 28 && rc.intervalText === '13:30 → 13:58 (28 min)', rc && [kinds(rc), rc.intervals]);
    const attC = await prisma.attendance.findUnique({ where: { employeeId_date: { employeeId: c.e.id, date: DAY } } });
    check('C2 the day is still marked from the punches as before (check-in 09:12, check-out 18:41)', attC && attC.checkIn === '09:12' && attC.checkOut === '18:41', attC);

    // D
    const rd = rowOf(d);
    check('D1 one web check-in: no interval, no made-up check-out', rd && rd.intervals.length === 0 && rd.intervalCount === 0 && rd.lastOutTime === null && kinds(rd) === '09:30:checkin:web', rd && [rd.intervals, rd.lastOutTime, kinds(rd)]);

    // E
    const re = rowOf(e);
    check('E1 HR 09:12 and a device press at 09:12:05 are ONE entry (the device\'s), HR\'s 18:00 check-out is added',
      re && kinds(re) === '09:12:checkin:biometric,18:00:checkout:hr' && re.intervals.length === 0, re && kinds(re));

    // G
    const rg = rowOf(g);
    check('G1 imported day: 09:01 check-in, the 12:00 log time as an interval, 18:00 check-out', rg && rg.punchList.map((p) => `${String(p.time).slice(0, 5)}:${p.kind}`).join(',') === '09:01:checkin,12:00:interval,18:00:checkout' && rg.intervalCount === 1, rg && [rg.punchList, rg.intervalCount]);

    // H - export
    const csv = await http('GET', q(`&department=${encodeURIComponent(DEPT)}&format=csv`), hr.t);
    const lines = csv.text.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
    const head = lines[0] || '';
    const lineC = lines.find((l) => l.includes(c.e.employeeCode)) || '';
    const lineA = lines.find((l) => l.includes(a.e.employeeCode)) || '';
    check('H1 the CSV keeps "Time Interval" and adds "Intervals (out → back)"', csv.status === 200 && /Time Interval/.test(head) && /Intervals \(out → back\)/.test(head), [csv.status, head]);
    check('H2 C\'s line: the old Time Interval (every time, "|") unchanged + the new interval text', lineC.includes('09:12:05|13:30:10|13:58:44|18:41:02') && lineC.includes('13:30 → 13:58 (28 min)'), lineC);
    check('H3 A\'s line lists HR\'s check-in and check-out among the punch times (Set by HR) and the interval text', lineA.includes('09:30 (Set by HR)') && lineA.includes('18:30 (Set by HR)') && lineA.includes('13:00 → 14:05 (1h 05m)'), lineA);

    // S - scope and nothing else changed
    const mine = await http('GET', q(), a.t);
    check('S1 an employee sees only their own row, with their interval', mine.status === 200 && mine.body.rows.length === 1 && mine.body.rows[0].employeeId === a.e.id && mine.body.rows[0].intervals.length === 1, [mine.status, mine.body?.rows?.length]);
    const anon = await http('GET', q());
    check('S2 no login = 401', anon.status === 401, anon.status);
    const bad = await http('GET', '/api/attendance/punch-log?from=2026-08-01&to=2026-10-21', hr.t);
    check('S3 the 62-day limit still holds (400)', bad.status === 400, bad.status);
    const attA2 = await prisma.attendance.findUnique({ where: { employeeId_date: { employeeId: a.e.id, date: DAY } } });
    check('S4 reading the punch log wrote nothing: HR\'s Marked attendance row is identical', attA2 && attA2.checkIn === attA.checkIn && attA2.checkOut === attA.checkOut && attA2.status === attA.status && attA2.timesSetBy === attA.timesSetBy, attA2);
    const stored = await prisma.biometricPunchLog.count({ where: { deviceSerial: device.serialNumber } });
    check('S5 every device press is in the device log as received (2 + 2 + 4 + 1 = 9 lines)', stored === 9, stored);
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
