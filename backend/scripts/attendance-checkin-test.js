#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CHECK-IN / CHECK-OUT acceptance tests (2026-10-13). SANDBOX ONLY.
//
//   cd backend && TL_API=http://localhost:4011 node scripts/attendance-checkin-test.js
//
//   G  the distance rule (pure): 40 m inside, 340 m / 1.2 km messages, the nearest of two offices, weak GPS
//   A  out of the area: the exact words, the same distance saved for HR, other offices listed
//   I  one tap = one punch: double tap, retry with the same key, a second check-in, check-out first,
//      a repeated check-out, check-in again after check-out
//   H  HR typing a punch for the same minute is the same punch
//   D  the biometric device: the same push twice, two lines in one minute, face + device in one minute
//   S  the settings round trip (office name, other offices, minimum gap)
//   X  attendance-duplicates.js on a copy with planted duplicates (dry run, apply, undo, regularized day untouched)
// The face model itself is stood in for by X-Test-Face (honoured only when the server runs in TEST_MODE).
// Builds ZZTEST fixtures in sandbox.db and removes them again.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BACK = path.resolve(__dirname, '..');
const API = String(process.env.TL_API || '').replace(/\/+$/, '').replace(/\/api$/, '');
if (!/^http:\/\/localhost:40(1[1-9]|[2-9][0-9])$/.test(API)) { console.error('Refusing: set TL_API=http://localhost:4011 (the sandbox) or another sandbox port 4011-4099.'); process.exit(2); }
const SBX = `file:${path.join(BACK, 'prisma', process.env.TL_TEST_DB || 'sandbox.db').split(path.sep).join('/')}`;
process.env.DATABASE_URL = SBX;
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = SBX;
process.env.TEST_MODE = '1';
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const sharp = require(path.join(BACK, 'node_modules/sharp'));
const prisma = require(path.join(BACK, 'src/db'));
const geo = require(path.join(BACK, 'src/utils/geofence'));
const D = require(path.join(BACK, 'src/utils/attendanceDays'));

const RUN = Date.now().toString(36);
let pass = 0; let fail = 0;
function check(name, ok, detail) {
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail != null ? `  -> ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400)}` : ''}`);
}
async function call(method, p, token, body, headers) {
  const h = { 'X-Forwarded-For': '10.9.7.8', ...(headers || {}) };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined && typeof body === 'string') { h['Content-Type'] = 'text/plain'; payload = body; } else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  // the sandbox restarts when another agent edits src: wait and ask again (a request that never arrived is safe to resend)
  let r;
  for (let i = 0; ; i += 1) {
    try { r = await fetch(`${API}${p}`, { method, headers: h, body: payload }); break; } catch (e) { if (i >= 25) throw e; await sleep(2000); }
  }
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}

const OFFICE = { lat: 17.488936, lng: 78.39216, radius: 100, name: 'ZZTEST Head Office' };
const OTHER = { name: 'ZZTEST Branch', latitude: 17.55, longitude: 78.45, radiusM: 150 };
const northOf = (lat, metres) => lat + metres / 111194.9;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

(async () => {
  const made = { users: [], emps: [], devices: [] };
  let cfgBefore = null; let setBefore = {};
  let jpeg;
  try {
    jpeg = `data:image/jpeg;base64,${(await sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 120, g: 120, b: 120 } } }).jpeg().toBuffer()).toString('base64')}`;

    // ---------- G: the distance rule, pure ----------
    const offices = { enabled: true, offices: [
      { name: OFFICE.name, latitude: OFFICE.lat, longitude: OFFICE.lng, radiusM: OFFICE.radius, main: true },
      { ...OTHER, main: false },
    ] };
    const at = (m) => geo.check(offices, northOf(OFFICE.lat, m), OFFICE.lng, 10);
    check('G1 40 m away is inside', at(40).inside === true && at(40).distance >= 39 && at(40).distance <= 41, at(40));
    const r340 = at(340);
    check('G2 340 m away: outside, exact words', !r340.inside && geo.outsideMessage(r340, 'In') === `You are about ${r340.distance} m from ${OFFICE.name}. Allowed: 100 m to check in.` && Math.abs(r340.distance - 340) <= 2, geo.outsideMessage(r340, 'In'));
    const r1200 = at(1200);
    check('G3 1.2 km away is written in km with one decimal', geo.outsideMessage(r1200, 'Out') === `You are about 1.2 km from ${OFFICE.name}. Allowed: 100 m to check out.`, geo.outsideMessage(r1200, 'Out'));
    const nearBranch = geo.check(offices, OTHER.latitude + 0.0036, OTHER.longitude, 20); // ~400 m north of the branch
    check('G4 nearest of two offices is named, the other listed', nearBranch.office.name === OTHER.name && nearBranch.others.length === 1 && nearBranch.others[0].name === OFFICE.name, nearBranch);
    const inBranch = geo.check(offices, OTHER.latitude + 0.0005, OTHER.longitude, 10);
    check('G5 inside the OTHER office is inside', inBranch.inside === true && inBranch.office.name === OTHER.name, inBranch);
    check('G6 GPS worse than the radius is flagged', geo.check(offices, northOf(OFFICE.lat, 340), OFFICE.lng, 250).weakGps === true);
    check('G7 distance words: 999 m / 1000 m / 0 m', geo.distanceText(999) === '999 m' && geo.distanceText(1000) === '1.0 km' && geo.distanceText(0) === '0 m');
    check('G8 accuracy slack: 150 m away with ±60 m GPS is inside a 100 m fence', geo.check(offices, northOf(OFFICE.lat, 150), OFFICE.lng, 60).inside === true);

    // ---------- fixtures ----------
    cfgBefore = await prisma.hrConfig.findFirst();
    for (const k of ['attendance.offices', 'attendance.officeName', 'attendance.minPunchGapSec', 'attendance.checkin']) {
      const row = await prisma.appSetting.findUnique({ where: { key: k } });
      setBefore[k] = row ? row.value : null;
    }
    await prisma.hrConfig.update({ where: { id: cfgBefore.id }, data: { geofenceEnabled: true, officeLatitude: OFFICE.lat, officeLongitude: OFFICE.lng, geofenceRadiusM: OFFICE.radius } });
    await prisma.appSetting.upsert({ where: { key: 'attendance.officeName' }, create: { key: 'attendance.officeName', value: JSON.stringify(OFFICE.name) }, update: { value: JSON.stringify(OFFICE.name) } });
    await prisma.appSetting.upsert({ where: { key: 'attendance.offices' }, create: { key: 'attendance.offices', value: JSON.stringify([OTHER]) }, update: { value: JSON.stringify([OTHER]) } });
    await prisma.appSetting.deleteMany({ where: { key: 'attendance.minPunchGapSec' } });

    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: true, accountsAccess: false, atsAccess: false, status: 'Active' };
    const mkUser = async (tag, extra, withEmp) => {
      const u = await prisma.user.create({ data: { ...base, name: `ZZTEST CI ${tag} ${RUN}`, email: `zz-ci-${tag}-${RUN}@example.test`, username: `zz-ci-${tag}-${RUN}@example.test`, role: 'EMPLOYEE', ...extra } });
      made.users.push(u.id);
      let e = null;
      if (withEmp) {
        e = await prisma.employee.create({ data: { employeeCode: `ZZTEST-CI-${tag}-${RUN}`.slice(0, 40), name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', checkInMethods: 'Face,GPS,Biometric', biometricPin: `9${Math.floor(Math.random() * 1e7)}`, ...withEmp } });
        made.emps.push(e.id);
        await prisma.employeeDocument.create({ data: { employeeId: e.id, docType: 'Photo', file: `zztest-${RUN}.jpg`, fileName: 'zztest.jpg' } });
      }
      const tok = jwt.sign({ id: u.id }, process.env.JWT_SECRET);
      return { u, e, tok };
    };
    const A = await mkUser('a', {}, {});
    const B = await mkUser('b', {}, {});
    const C = await mkUser('c', {}, {});
    const SA = await mkUser('sa', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN' }, null);

    const verified = async (who, { direction = 'In', lat, lng, acc = 12, key, face = 'pass' } = {}) => {
      const ch = await call('GET', `/api/attendance/face/challenge?direction=${direction}`, who.tok);
      if (ch.status !== 200) return { status: ch.status, body: ch.body, challengeFailed: true };
      const form = new FormData();
      form.append('token', ch.body.token);
      form.append('method', 'Face');
      form.append('latitude', String(lat ?? OFFICE.lat)); form.append('longitude', String(lng ?? OFFICE.lng));
      form.append('accuracy', String(acc)); form.append('locationAt', String(Date.now()));
      for (let i = 0; i < 8; i += 1) form.append(`frame${i}`, jpeg);
      const h = { 'X-Test-Face': face };
      if (key) h['Idempotency-Key'] = key;
      return call('POST', '/api/attendance/punches/verified', who.tok, form, h);
    };
    const today = D.localDate();
    const punchesOf = (e, direction) => prisma.attendancePunch.findMany({ where: { employeeId: e.id, date: today, ...(direction ? { direction } : {}) } });

    // ---------- A: out of the area ----------
    const st = await call('GET', '/api/attendance/checkin/status', A.tok);
    check('A0 status carries the offices, nothing open yet', st.status === 200 && st.body.geofence.enabled && st.body.geofence.offices.length === 2 && st.body.open === false && st.body.minGapSec === 60, st.body);
    const far = await verified(A, { lat: northOf(OFFICE.lat, 340) });
    check('A1 340 m away is refused with the exact words', far.status === 403 && far.body.code === 'GEOFENCE' && /^You are about 3(39|4\d) m from ZZTEST Head Office\. Allowed: 100 m to check in\.$/.test(far.body.error), far.body);
    check('A2 the answer carries distance, radius, office and the other offices', far.body.geofence && far.body.geofence.radiusM === 100 && far.body.geofence.others.length === 1 && far.body.geofence.office.name === OFFICE.name, far.body && far.body.geofence);
    check('A3 nothing was recorded', (await punchesOf(A.e)).length === 0);
    const far2 = await verified(A, { lat: northOf(OFFICE.lat, 1200), direction: 'In' });
    check('A4 1.2 km away says km', far2.status === 403 && /^You are about 1\.2 km from ZZTEST Head Office/.test(far2.body.error), far2.body);
    const nearB = await verified(A, { lat: OTHER.latitude + 0.0036, lng: OTHER.longitude });
    check('A5 near the branch: the branch is the one named, the head office listed', nearB.status === 403 && /from ZZTEST Branch\. Allowed: 150 m/.test(nearB.body.error) && nearB.body.geofence.others[0].name === OFFICE.name, nearB.body);
    const weak = await verified(A, { lat: northOf(OFFICE.lat, 800), acc: 300 });
    check('A6 weak GPS (±300 m) 800 m away is flagged and refused', weak.status === 403 && weak.body.geofence.weakGps === true && weak.body.geofence.accuracyM === 300, weak.body);
    const ref = await call('GET', `/api/attendance/refused-attempts?from=${today}&to=${today}`, SA.tok);
    const mine = (ref.body && ref.body.rows || []).filter((r) => r.employeeId === A.e.id);
    check('A7 HR sees the refused tries with the distance and time', ref.status === 200 && mine.length >= 4 && mine.some((r) => /^Tried to check in 3(39|4\d) m away at \d\d:\d\d \(ZZTEST Head Office/.test(r.text) && r.distanceM >= 339 && r.distanceM <= 341), ref.body);
    const noScope = await call('GET', `/api/attendance/refused-attempts?from=${today}&to=${today}`, A.tok);
    check('A8 an ordinary employee cannot read the refused-attempts list', noScope.status === 403, noScope.status);
    const inside40 = await verified(B, { lat: northOf(OFFICE.lat, 40), key: `k-in-${RUN}` });
    check('A9 40 m away checks in, distance saved on the punch', inside40.status === 201 && inside40.body.punch.distanceM >= 39 && inside40.body.punch.distanceM <= 41 && inside40.body.punch.locationStatus === 'Inside geofence', inside40.body);

    // ---------- I: one tap = one punch ----------
    const key = `k-dbl-${RUN}`;
    const [t1, t2] = await Promise.all([verified(A, { key }), verified(A, { key })]);
    const codes = [t1.status, t2.status].sort();
    check('I1 double tap at once: one is recorded, the other is told to wait or gets the same answer', codes[0] === 200 || codes[0] === 201 || codes[0] === 409, [t1.status, t2.status, t1.body, t2.body]);
    const retry = await verified(A, { key });
    check('I2 a retry with the same key gives the first answer back (replayed), no new punch', (retry.status === 201 || retry.status === 200) && !!retry.body.punch, retry.body);
    const ins = await punchesOf(A.e, 'In');
    check('I3 exactly ONE check-in exists', ins.length === 1, ins.length);
    const sameId = retry.body.punch && ins[0] && retry.body.punch.id === ins[0].id;
    check('I4 the retry points at that same punch', !!sameId, [retry.body && retry.body.punch && retry.body.punch.id, ins[0] && ins[0].id]);
    const again = await verified(A, { key: `k-second-${RUN}` });
    check('I5 a second check-in the same day: "Already checked in at"', again.status === 200 && again.body.duplicate === true && /^Already checked in at \d{1,2}:\d\d (AM|PM)\.$/.test(again.body.message) && again.body.punch.id === ins[0].id, again.body);
    check('I6 still ONE check-in', (await punchesOf(A.e, 'In')).length === 1);
    const outFirst = await verified(C, { direction: 'Out', key: `k-outfirst-${RUN}` });
    check('I7 check-out with no check-in: plain message, nothing recorded', outFirst.status === 409 && outFirst.body.code === 'NOT_CHECKED_IN' && /not checked in today/.test(outFirst.body.error) && (await punchesOf(C.e)).length === 0, outFirst.body);
    const out1 = await verified(A, { direction: 'Out', key: `k-out1-${RUN}` });
    check('I8 check-out after check-in is recorded', out1.status === 201 && out1.body.punch.direction === 'Out', out1.body);
    const out2 = await verified(A, { direction: 'Out', key: `k-out2-${RUN}` });
    check('I9 a repeated check-out is a no-op: "Already checked out at"', out2.status === 200 && out2.body.duplicate === true && /^Already checked out at/.test(out2.body.message) && (await punchesOf(A.e, 'Out')).length === 1, out2.body);
    const in2 = await verified(A, { key: `k-in2-${RUN}` });
    check('I10 checking in again AFTER a check-out is allowed (a new open day)', in2.status === 201 && (await punchesOf(A.e, 'In')).length === 2, in2.body);
    const dayRow = await prisma.attendance.findUnique({ where: { employeeId_date: { employeeId: A.e.id, date: today } } });
    const split = require(path.join(BACK, 'src/utils/attendanceMath')).daySplit(await punchesOf(A.e));
    check('I11 the day still reads first check-in / last check-out (no double counting)', !!dayRow && dayRow.checkIn === split.checkIn.time, [dayRow, split.checkIn && split.checkIn.time]);
    // Since 2026-10-15 the default face mode is 'record anyway'; this check is about STRICT mode (the web-checkin-test covers the others).
    await prisma.appSetting.upsert({ where: { key: 'attendance.checkin' }, create: { key: 'attendance.checkin', value: JSON.stringify({ faceMode: 'strict' }) }, update: { value: JSON.stringify({ faceMode: 'strict' }) } });
    await sleep(11000); // the server keeps its settings for 10 s
    const failFace = await verified(C, { key: `k-ff-${RUN}`, face: 'fail' });
    check('I12 a face that does not match records nothing and frees the retry', failFace.status === 422 && (await punchesOf(C.e)).length === 0, failFace.body);
    const afterFail = await verified(C, { key: `k-ff2-${RUN}` });
    check('I13 after a failed face the next attempt is not blocked', afterFail.status === 201, afterFail.body);
    const noKey = await Promise.all([verified(B, { direction: 'Out' }), verified(B, { direction: 'Out' })]);
    check('I14 two taps without any key still make one check-out', (await punchesOf(B.e, 'Out')).length === 1, noKey.map((x) => x.status));

    // ---------- H: HR typing the same minute ----------
    const manual = (e, time, direction = 'In') => call('POST', '/api/attendance/punches', SA.tok, { employeeId: e.id, date: today, time, direction, method: 'Face' });
    const aIn = (await punchesOf(A.e, 'In')).sort((x, y) => x.time.localeCompare(y.time))[0];
    const hrSame = await manual(A.e, aIn.time, 'In');
    check('H1 HR typing a check-in for the same minute is the same punch', hrSame.status === 200 && hrSame.body.duplicate === true && (await punchesOf(A.e, 'In')).length === 2, hrSame.body);
    const hrLater = await manual(C.e, '23:58', 'Out');
    const hrAgain = await manual(C.e, '23:58', 'Out');
    check('H2 a new minute is recorded once, the repeat is the same punch', hrLater.status === 201 && hrAgain.status === 200 && hrAgain.body.duplicate === true, [hrLater.status, hrAgain.status]);

    // ---------- D: the biometric device ----------
    const SN = `ZZTEST${RUN}`.toUpperCase();
    const dev = await prisma.biometricDevice.create({ data: { vendor: 'ZZTEST Device', serialNumber: SN, endpoint: 'zztest', status: 'Active' } });
    made.devices.push(dev.id);
    const attlog = (pin, stamp, state = '0') => call('POST', `/iclock/cdata?SN=${SN}&table=ATTLOG`, null, `${pin}\t${stamp}\t${state}\t1\t0\t0\n`, {});
    const dEmp = await prisma.employee.create({ data: { employeeCode: `ZZTEST-CI-d-${RUN}`.slice(0, 40), name: `ZZTEST CI dev ${RUN}`, designation: 'Employee', employmentStatus: 'Active', biometricPin: `8${Math.floor(Math.random() * 1e7)}`, checkInMethods: 'Biometric' } });
    made.emps.push(dEmp.id);
    const stamp = (s) => `${today} ${s}`;
    const d1 = await attlog(dEmp.biometricPin, stamp('09:12:00'));
    const d2 = await attlog(dEmp.biometricPin, stamp('09:12:00'));
    check('D1 the device pushes the same punch twice: ONE punch row', /OK: 1/.test(d1.text) && /OK: 1/.test(d2.text) && (await punchesOf(dEmp)).length === 1, [d1.text, d2.text]);
    const d3 = await attlog(dEmp.biometricPin, stamp('09:12:40'));
    check('D2 another line within the same minute (double press) is the same punch', /OK: 1/.test(d3.text) && (await punchesOf(dEmp)).length === 1, await punchesOf(dEmp));
    const logs = await prisma.biometricPunchLog.findMany({ where: { deviceSerial: SN } });
    const pid = (await punchesOf(dEmp))[0].id;
    check('D3 every log line points at that one punch', logs.length === 2 && logs.every((l) => l.attendancePunchId === pid), logs);
    const d4 = await attlog(dEmp.biometricPin, stamp('13:30:00'), '1');
    check('D4 a check-out line later is its own punch', (await punchesOf(dEmp)).length === 2 && (await punchesOf(dEmp, 'Out')).length === 1, d4.text);
    const nowHm = D.localTime();
    const fresh = await mkUser('f', {}, {});
    const fIn = await verified(fresh, { key: `k-f-${RUN}` });
    const faceT = fIn.body && fIn.body.punch ? fIn.body.punch.time : nowHm;
    const dFace = await attlog(fresh.e.biometricPin, stamp(`${faceT}:20`));
    const fp = await punchesOf(fresh.e, 'In');
    check('D5 face check-in + device punch in the same minute: ONE punch, the device (strongest) kept', fIn.status === 201 && /OK: 1/.test(dFace.text) && fp.length === 1 && fp[0].method === 'Biometric', [fp, dFace.text]);

    // ---------- S: settings round trip ----------
    const put = await call('PUT', '/api/attendance/geofence', SA.tok, { officeName: 'ZZTEST Renamed', minPunchGapSec: 90, otherOffices: [{ name: 'ZZTEST Two', latitude: 17.6, longitude: 78.5, radiusM: 120 }, { name: 'ZZTEST Three', latitude: 17.7, longitude: 78.6, radiusM: 80 }] });
    check('S1 settings saved', put.status === 200 && put.body.officeName === 'ZZTEST Renamed' && put.body.minPunchGapSec === 90 && put.body.otherOffices.length === 2, put.body);
    const badOff = await call('PUT', '/api/attendance/geofence', SA.tok, { otherOffices: [{ name: 'Bad', latitude: 999, longitude: 1 }] });
    check('S2 a bad office is refused', badOff.status === 400, badOff.body);
    const noSa = await call('PUT', '/api/attendance/geofence', A.tok, { officeName: 'x' });
    check('S3 only Super Admin may change them', noSa.status === 403, noSa.status);
    const st2 = await call('GET', '/api/attendance/checkin/status', A.tok);
    check('S4 the status now lists the new offices and the gap', st2.body.geofence.offices.length === 3 && st2.body.minGapSec === 90 && st2.body.geofence.offices[0].name === 'ZZTEST Renamed', st2.body.geofence);

    // ---------- X: attendance-duplicates.js on a copy ----------
    const tmp = path.join(os.tmpdir(), `ci-dups-${RUN}.db`);
    try {
      await prisma.$queryRawUnsafe(`VACUUM INTO '${tmp.split(path.sep).join('/')}'`);
      const { PrismaClient } = require(path.join(BACK, 'node_modules/@prisma/client'));
      const cp = new PrismaClient({ datasources: { db: { url: `file:${tmp.split(path.sep).join('/')}` } } });
      const day = '2019-03-04'; const day2 = '2019-03-05';
      const mk = (employeeId, date, time, direction, extra) => cp.attendancePunch.create({ data: { employeeId, date, time, direction, method: 'Face Recognition', source: 'Web', ...extra } });
      await mk(A.e.id, day, '09:10', 'In', {});
      const dupe1 = await mk(A.e.id, day, '09:10', 'In', {});
      await mk(A.e.id, day, '18:00', 'Out', {});
      await mk(B.e.id, day2, '09:05', 'In', { method: 'Biometric', source: 'Biometric device' });
      await mk(B.e.id, day2, '09:05', 'In', { method: 'Face Recognition', source: 'Web', verificationStatus: 'Verified' }); // mixed
      await mk(C.e.id, day, '09:30', 'In', {});
      await mk(C.e.id, day, '09:30', 'In', {});
      await cp.attendanceRegularization.create({ data: { employeeId: C.e.id, date: day, requestedCheckIn: '09:30', status: 'Approved' } });
      await cp.$disconnect();
      const script = path.join(BACK, 'scripts', 'attendance-duplicates.js');
      const run = (args) => execFileSync(process.execPath, [script, '--db', tmp, ...args], { encoding: 'utf8', cwd: BACK, env: { ...process.env, TL_ALLOW_REAL_APPLY: '' } });
      const dry = run([]);
      check('X1 the dry run finds the same-method pair, the mixed pair, and skips the regularized day', dry.includes(`ZZTEST-CI-a-${RUN}`) && dry.includes(`ZZTEST-CI-b-${RUN}`) && /Would remove \d+ row/.test(dry) && /APPROVED REGULARIZATION/.test(dry) && /DRY RUN: nothing was changed/.test(dry), dry.split('\n').filter((l) => /SUMMARY|cluster/.test(l)).join(' | '));
      const cp2 = new PrismaClient({ datasources: { db: { url: `file:${tmp.split(path.sep).join('/')}` } } });
      const mineWhere = { employeeId: { in: [A.e.id, B.e.id, C.e.id] }, date: { in: [day, day2] } };
      const before = await cp2.attendancePunch.count({ where: mineWhere });
      check('X2 the dry run wrote nothing', before === 7, before);
      const ap = run(['--apply']);
      const after = await cp2.attendancePunch.count({ where: mineWhere });
      check('X3 --apply removed only the same-method duplicate (mixed and regularized days untouched)', /APPLIED: \d+ duplicate/.test(ap) && after === 6, [ap.split('\n').slice(-3).join(' | '), after]);
      const manifestFile = (/Undo manifest written: (.+)/.exec(ap) || [])[1];
      const un = execFileSync(process.execPath, [script, '--db', tmp, '--undo', '--file', manifestFile.trim()], { encoding: 'utf8', cwd: BACK });
      const back = await cp2.attendancePunch.findUnique({ where: { id: dupe1.id } });
      check('X4 --undo puts the removed row back', /\d+ punch row\(s\) put back/.test(un) && !!back, un);
      const ap2 = run(['--apply', '--include-mixed']);
      const kept = await cp2.attendancePunch.findMany({ where: { employeeId: B.e.id, date: day2 } });
      check('X5 --include-mixed keeps the strongest (biometric) of the mixed pair', /APPLIED/.test(ap2) && kept.length === 1 && kept[0].method === 'Biometric', kept);
      let refused = false;
      try { execFileSync(process.execPath, [script, '--apply'], { encoding: 'utf8', cwd: BACK, env: { ...process.env, TL_ALLOW_REAL_APPLY: '' }, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { refused = /REFUSED/.test(String(e.stdout)); }
      check('X6 --apply on the real database is refused without the guards', refused);
      await cp2.$disconnect();
      if (manifestFile) { try { fs.unlinkSync(manifestFile.trim()); } catch { /* gone */ } }
      fs.readdirSync(path.join(BACK, 'backups')).filter((f) => /^attendance-duplicates-/.test(f) && fs.statSync(path.join(BACK, 'backups', f)).mtimeMs > Date.now() - 600000).forEach((f) => { try { fs.unlinkSync(path.join(BACK, 'backups', f)); } catch { /* gone */ } });
    } finally { ['', '-wal', '-shm', '-journal'].forEach((s) => { try { fs.unlinkSync(tmp + s); } catch { /* none */ } }); }
  } catch (e) {
    fail += 1; console.log(`FAIL  test crashed: ${e && e.stack ? e.stack : e}`);
  } finally {
    // ---------- clean up: every ZZTEST row ----------
    try {
      const empIds = made.emps;
      const punches = await prisma.attendancePunch.findMany({ where: { employeeId: { in: empIds } }, select: { id: true, imageFile: true } });
      try {
        const att = require(path.join(BACK, 'src/utils/attachments'));
        punches.forEach((p) => { if (p.imageFile) att.remove(p.imageFile); });
      } catch { /* files are in the sandbox files folder only */ }
      await prisma.biometricPunchLog.deleteMany({ where: { OR: [{ employeeId: { in: empIds } }, { deviceSerial: { startsWith: 'ZZTEST' } }] } });
      await prisma.attendancePunch.deleteMany({ where: { employeeId: { in: empIds } } });
      await prisma.attendance.deleteMany({ where: { employeeId: { in: empIds } } });
      await prisma.attendanceRegularization.deleteMany({ where: { employeeId: { in: empIds } } });
      await prisma.employeeDocument.deleteMany({ where: { employeeId: { in: empIds } } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: made.users } }, { entityId: { in: [...empIds, ...punches.map((p) => p.id)] } }] } });
      await prisma.notification.deleteMany({ where: { userId: { in: made.users } } }).catch(() => {});
      await prisma.biometricDevice.deleteMany({ where: { id: { in: made.devices } } });
      await prisma.employee.deleteMany({ where: { id: { in: empIds } } });
      await prisma.user.deleteMany({ where: { id: { in: made.users } } });
      if (cfgBefore) await prisma.hrConfig.update({ where: { id: cfgBefore.id }, data: { geofenceEnabled: cfgBefore.geofenceEnabled, officeLatitude: cfgBefore.officeLatitude, officeLongitude: cfgBefore.officeLongitude, geofenceRadiusM: cfgBefore.geofenceRadiusM } });
      for (const k of Object.keys(setBefore)) {
        if (setBefore[k] == null) await prisma.appSetting.deleteMany({ where: { key: k } });
        else await prisma.appSetting.update({ where: { key: k }, data: { value: setBefore[k] } });
      }
    } catch (e) { console.log(`cleanup problem: ${e && e.message}`); }
    await prisma.$disconnect();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
