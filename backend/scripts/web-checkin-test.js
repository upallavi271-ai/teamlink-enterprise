#!/usr/bin/env node
// ---------------------------------------------------------------------------
// WEB CHECK-IN: distance + face acceptance tests (2026-10-15). SANDBOX ONLY, light, run once.
//
//   cd backend && TL_API=http://localhost:4011 node scripts/web-checkin-test.js
//
//   U  pure units: the distance rule (4 m / 10 m GPS, 120 m / 5 m, boundary, swapped lat/lng, nearest of several offices,
//      accuracy switch + cap), the sanity flags, the face verdict for every mode, the threshold function, and the
//      reference-face cache (a new photo invalidates it)
//   D  the distance rule through the real API (accepted / refused words, missing location per setting, nothing recorded)
//   F  the face mode matrix through the API (Record anyway / Easy / Strict x match, weak match, no match, no face,
//      timeout, engine, no camera, no profile photo): what is recorded, with which flag
//   P  the stored punch (distance, accuracy, score, flag, selfie <= 320 px) and the "All punches" / punch-log details
//   R  the HR review list (HR / Admin only), Mark OK / Not this person, audit, no change to the day, selfie access,
//      the daily summary, the retention sweep
// The face model itself is stood in for by X-Test-Face (honoured only when the server runs in TEST_MODE); the real model,
// camera and GPS are NOT exercised here.
// Builds ZZTEST WC fixtures in sandbox.db and removes them again.
// ---------------------------------------------------------------------------
const path = require('path');

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
const CS = require(path.join(BACK, 'src/utils/checkinSettings'));
const faceRef = require(path.join(BACK, 'src/utils/faceRef'));
const review = require(path.join(BACK, 'src/utils/faceReview'));
const D = require(path.join(BACK, 'src/utils/attendanceDays'));

const RUN = Date.now().toString(36);
const TAG = 'ZZTEST WC';
let pass = 0; let fail = 0;
function check(name, ok, detail) {
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail != null ? `  -> ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400)}` : ''}`);
}
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
async function call(method, p, token, body, headers) {
  const h = { 'X-Forwarded-For': '10.9.7.9', ...(headers || {}) };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  let r;
  for (let i = 0; ; i += 1) {
    try { r = await fetch(`${API}${p}`, { method, headers: h, body: payload }); break; } catch (e) { if (i >= 25) throw e; await sleep(2000); }
  }
  const raw = Buffer.from(await r.arrayBuffer());
  let json = null; try { json = JSON.parse(raw.toString('utf8')); } catch { /* not json */ }
  return { status: r.status, body: json, raw };
}

const OFFICE = { lat: 17.488936, lng: 78.39216, radius: 100, name: `${TAG} Head Office` };
const BRANCH = { name: `${TAG} Branch`, latitude: 17.55, longitude: 78.45, radiusM: 150 };
const northOf = (lat, metres) => lat + metres / 111194.9;

(async () => {
  const made = { users: [], emps: [] };
  let cfgBefore = null; const setBefore = {};
  const KEYS = ['attendance.offices', 'attendance.officeName', 'attendance.minPunchGapSec', 'attendance.checkin'];
  try {
    // ======================= U: pure units =======================
    const offices = { enabled: true, offices: [
      { name: OFFICE.name, latitude: OFFICE.lat, longitude: OFFICE.lng, radiusM: OFFICE.radius, main: true },
      { ...BRANCH, main: false },
    ] };
    const at = (m, acc, opts) => geo.check(offices, northOf(OFFICE.lat, m), OFFICE.lng, acc, opts);
    check('U1 4 m away with 10 m GPS accuracy is inside', at(4, 10).inside === true && at(4, 10).distance <= 5);
    check('U2 120 m away with 5 m accuracy is outside a 100 m limit, in plain words', at(120, 5).inside === false && geo.outsideMessage(at(120, 5), 'In') === `You are about ${at(120, 5).distance} m from ${OFFICE.name}. Allowed: 100 m to check in.`, geo.outsideMessage(at(120, 5), 'In'));
    check('U3 120 m away with 40 m accuracy is inside (the circle of doubt touches the limit)', at(120, 40).inside === true);
    check('U4 accuracy switched OFF: 120 m away with 40 m accuracy is outside', at(120, 40, { accuracyCounts: false }).inside === false);
    check('U5 accuracy is allowed for only up to the cap (300 m): 800 m away with 900 m accuracy is outside, 380 m with 900 m is inside', at(800, 900).inside === false && at(380, 900).inside === true);
    check('U6 the old fixed cap of 100 m is gone: 250 m away with ±200 m accuracy is inside', at(250, 200).inside === true);
    const exact = { enabled: true, offices: [{ name: 'x', latitude: OFFICE.lat, longitude: OFFICE.lng, radiusM: geo.haversine(OFFICE.lat, OFFICE.lng, northOf(OFFICE.lat, 100), OFFICE.lng) }] };
    check('U7 exactly on the boundary is inside', geo.check(exact, northOf(OFFICE.lat, 100), OFFICE.lng, 0).inside === true);
    const swapped = { enabled: true, offices: [{ name: 'Swapped', latitude: OFFICE.lng, longitude: OFFICE.lat, radiusM: 100 }] }; // lat/lng typed the wrong way round
    const sw = geo.check(swapped, OFFICE.lat, OFFICE.lng, 10);
    check('U8 office latitude/longitude typed the wrong way round is detected and said so', sw.inside === false && sw.swapped === true && /wrong way round/.test(geo.outsideMessage(sw, 'In')), sw);
    const nb = geo.check(offices, BRANCH.latitude + 0.0036, BRANCH.longitude, 20);
    check('U9 several offices: the nearest is named, the other listed', nb.office.name === BRANCH.name && nb.others.length === 1 && nb.others[0].name === OFFICE.name, nb);
    check('U10 inside ANY office is accepted', geo.check(offices, BRANCH.latitude + 0.0005, BRANCH.longitude, 10).inside === true);
    check('U11 geofence off = always inside', geo.check({ enabled: false, offices: offices.offices }, 0, 0, 5).inside === true);
    check('U12 low accuracy (> 100 m) is a warning, not a refusal: 5 m away with ±180 m is inside and lowAccuracy', at(5, 180).inside === true && at(5, 180).lowAccuracy === true);
    check('U13 sanity flags: ±0 m looks too perfect; a 50 km jump in 2 minutes is flagged; normal movement is not',
      geo.spoofFlags({ accuracy: 0, lat: 1, lng: 1, prev: null }).length === 1
      && geo.spoofFlags({ accuracy: 10, lat: northOf(OFFICE.lat, 50000), lng: OFFICE.lng, prev: { latitude: OFFICE.lat, longitude: OFFICE.lng, at: Date.now() - 120000 } }).length === 1
      && geo.spoofFlags({ accuracy: 10, lat: northOf(OFFICE.lat, 300), lng: OFFICE.lng, prev: { latitude: OFFICE.lat, longitude: OFFICE.lng, at: Date.now() - 120000 } }).length === 0);

    const V = (mode, code, distance) => CS.faceVerdict({ mode, code, distance, strictThreshold: 0.45 });
    // match / weak match (0.6) / no match (0.9) / no face / no photo / camera / timeout / engine
    const cases = {
      match: ['VERIFIED', 0.3], weak: ['NO_MATCH', 0.6], nomatch: ['NO_MATCH', 0.9],
      noface: ['NO_FACE', null], nophoto: ['NO_PHOTO', null], camera: ['NO_CAMERA', null], timeout: ['TIMEOUT', null], engine: ['ENGINE', null],
    };
    const row = (mode) => Object.fromEntries(Object.entries(cases).map(([k, [c, d]]) => [k, V(mode, c, d)]));
    const rec = row('record'); const eas = row('easy'); const str = row('strict');
    check('U14 Record anyway: every case is recorded; match = matched, weak (0.60) = matched, the rest flagged', Object.values(rec).every((v) => v.record) && rec.match.matched && rec.weak.matched && rec.nomatch.status === 'Face not matched' && ['noface', 'nophoto', 'camera', 'timeout', 'engine'].every((k) => rec[k].status === 'Face not checked'), rec);
    check('U15 Easy: weak match accepted, clear mismatch (0.90) refused, technical problems recorded as not checked', eas.weak.matched && eas.weak.record && !eas.nomatch.record && ['noface', 'nophoto', 'camera', 'timeout', 'engine'].every((k) => eas[k].record && eas[k].status === 'Face not checked'), eas);
    check('U16 Strict: only a face that was seen and does not match is refused (0.60 and 0.90); every technical problem is recorded', !str.weak.record && !str.nomatch.record && str.match.record && ['noface', 'nophoto', 'camera', 'timeout', 'engine'].every((k) => str[k].record), str);
    check('U17 thresholds: strict 0.45 (Admin number), easy / record 0.70', CS.thresholdFor('strict', 0.45) === 0.45 && CS.thresholdFor('easy') === 0.7 && CS.thresholdFor('record') === 0.7 && CS.thresholdFor('strict', 0.5) === 0.5);
    check('U18 the default face mode is Required; bad values fall back', CS.clean({}).faceMode === 'required' && CS.clean({ faceMode: 'nonsense' }).faceMode === 'required' && CS.clean({ accuracyCapM: -5 }).accuracyCapM === 0 && CS.clean({ noLocation: 'x' }).noLocation === 'block');
    const req = row('required');
    check('U21 Required: only a seen face that matches (<= 0.45) is taken; a weak match, a wrong face, no face, no photo, no camera, timeout, engine are ALL refused with a reason', req.match.record && req.match.matched && !req.weak.record && !req.nomatch.record && ['noface', 'nophoto', 'camera', 'timeout', 'engine'].every((k) => !req[k].record && req[k].reason) && V('required', 'VERIFIED', 0.5).record === false && CS.thresholdFor('required', 0.45) === 0.45, req);
    check('U19 Record anyway never refuses, whatever the face result', Object.values(rec).every((v) => v.record === true));
    check('U20 missing location: per setting (block refuses, record keeps and says so)', CS.locationRule({ valid: false, setting: 'block' }).record === false && CS.locationRule({ valid: false, setting: 'record' }).status === 'Location not captured' && CS.locationRule({ valid: true, setting: 'block' }).record === true);
    const ph1 = { id: 'p1', file: 'a.jpg' }; const ph2 = { id: 'p2', file: 'b.jpg' };
    const stored = { key: faceRef.photoKey(ph1), face: { descriptor: new Array(128).fill(0.1), score: 0.9, box: { x: 1, y: 1, width: 5, height: 5 } } };
    check('U21 reference-face cache: valid for the same photo, invalid for a new photo (id or file), invalid when damaged',
      faceRef.isCurrent(stored, faceRef.photoKey(ph1)) && !faceRef.isCurrent(stored, faceRef.photoKey(ph2)) && !faceRef.isCurrent(stored, faceRef.photoKey({ id: 'p1', file: 'c.jpg' })) && !faceRef.isCurrent({ key: stored.key, face: { descriptor: [1, 2] } }, stored.key) && !faceRef.isCurrent(null, 'x'));

    // ======================= fixtures =======================
    cfgBefore = await prisma.hrConfig.findFirst();
    for (const k of KEYS) { const r = await prisma.appSetting.findUnique({ where: { key: k } }); setBefore[k] = r ? r.value : null; }
    await prisma.hrConfig.update({ where: { id: cfgBefore.id }, data: { geofenceEnabled: true, officeLatitude: OFFICE.lat, officeLongitude: OFFICE.lng, geofenceRadiusM: OFFICE.radius } });
    const put = (key, value) => prisma.appSetting.upsert({ where: { key }, create: { key, value: JSON.stringify(value) }, update: { value: JSON.stringify(value) } });
    await put('attendance.officeName', OFFICE.name);
    await put('attendance.offices', [BRANCH]);
    await prisma.appSetting.deleteMany({ where: { key: { in: ['attendance.minPunchGapSec', 'attendance.checkin'] } } });

    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: true, accountsAccess: false, atsAccess: false, status: 'Active' };
    const mkUser = async (tag, extra, withEmp) => {
      const u = await prisma.user.create({ data: { ...base, name: `${TAG} ${tag} ${RUN}`, email: `zz-wc-${tag}-${RUN}@example.test`, username: `zz-wc-${tag}-${RUN}@example.test`, role: 'EMPLOYEE', ...extra } });
      made.users.push(u.id);
      let e = null;
      if (withEmp) {
        e = await prisma.employee.create({ data: { employeeCode: `ZZTEST-WC-${tag}-${RUN}`.slice(0, 40), name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', checkInMethods: 'Face,GPS', ...withEmp } });
        made.emps.push(e.id);
        await prisma.employeeDocument.create({ data: { employeeId: e.id, docType: 'Photo', file: `zztest-wc-${RUN}.jpg`, fileName: 'zztest.jpg' } });
      }
      return { u, e, tok: jwt.sign({ id: u.id }, process.env.JWT_SECRET) };
    };
    const E1 = await mkUser('e1', {}, {});
    const E2 = await mkUser('e2', {}, {});
    const SA = await mkUser('sa', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN' }, null);
    const jpeg = `data:image/jpeg;base64,${(await sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 120, g: 120, b: 120 } } }).jpeg().toBuffer()).toString('base64')}`;
    const today = D.localDate();
    const reset = async (e) => {
      await prisma.attendancePunch.deleteMany({ where: { employeeId: e.id } });
      await prisma.attendance.deleteMany({ where: { employeeId: e.id } });
    };
    const mode = async (m, extra = {}) => {
      const r = await call('PUT', '/api/attendance/geofence', SA.tok, { checkin: { faceMode: m, ...extra } });
      return r;
    };
    // one web check-in. face: stub name | null (no stub = the real path with no model). frames: how many pictures.
    const punch = async (who, { direction = 'In', metres = 4, lat, lng, acc = 10, face = 'pass', frames = 3, noLoc = false, key } = {}) => {
      const ch = await call('GET', `/api/attendance/face/challenge?direction=${direction}`, who.tok);
      if (ch.status !== 200) return { status: ch.status, body: ch.body, ch };
      const form = new FormData();
      form.append('token', ch.body.token); form.append('method', 'Face');
      if (!noLoc) {
        form.append('latitude', String(lat ?? northOf(OFFICE.lat, metres))); form.append('longitude', String(lng ?? OFFICE.lng));
        form.append('accuracy', String(acc)); form.append('locationAt', String(Date.now()));
      }
      for (let i = 0; i < frames; i += 1) form.append(`frame${i}`, jpeg);
      const h = {}; if (face) h['X-Test-Face'] = face; if (key) h['Idempotency-Key'] = key;
      const r = await call('POST', '/api/attendance/punches/verified', who.tok, form, h);
      r.challenge = ch.body;
      return r;
    };
    const rowsOf = (e) => prisma.attendancePunch.findMany({ where: { employeeId: e.id, date: today } });

    // ======================= D: the distance rule through the API =======================
    let s = await mode('record');
    check('D0 SA saves the face mode (plain-words setting) and reads it back', s.status === 200 && s.body.checkin && s.body.checkin.faceMode === 'record' && s.body.checkin.accuracyCounts === true && s.body.checkin.accuracyCapM === 300 && s.body.checkin.selfieRetentionDays === 30, s.body);
    const bad = await mode('loose');
    check('D0b a wrong face mode is refused in words', bad.status === 400 && /Strict, Easy or Record anyway/.test(bad.body.error), bad.body);
    const plain = await call('PUT', '/api/attendance/geofence', E1.tok, { checkin: { faceMode: 'strict' } });
    check('D0c an employee cannot change the settings', plain.status === 403, plain.body);
    const st = await call('GET', '/api/attendance/checkin/status', E1.tok);
    check('D0d status tells the screen the face mode, the privacy line and the accuracy rule', st.status === 200 && st.body.face.mode === 'record' && /only to check your attendance/.test(st.body.face.privacy) && st.body.geofence.accuracyCounts === true && st.body.geofence.accuracyCapM === 300, st.body);
    await reset(E1.e);
    let r = await punch(E1, { metres: 4, acc: 10 });
    check('D1 4 m from the office with 10 m GPS: accepted and recorded', r.status === 201 && r.body.punch.distanceM <= 5 && r.body.location.distanceM <= 5, r.body);
    await reset(E1.e);
    r = await punch(E1, { metres: 4, acc: 71 });
    check('D2 4 m away with a typical indoor GPS (±71 m, the real median here): accepted', r.status === 201, r.body);
    await reset(E1.e);
    r = await punch(E1, { metres: 4, acc: 450 });
    check('D3 4 m away with a very poor GPS (±450 m): accepted with a low-accuracy warning, never refused', r.status === 201 && r.body.location.lowAccuracy === true, r.body);
    await reset(E1.e);
    r = await punch(E1, { metres: 120, acc: 5 });
    check('D4 120 m away with a good GPS: refused with the plain words, nothing recorded', r.status === 403 && r.body.code === 'GEOFENCE' && new RegExp(`^You are about 1(19|2\\d) m from ${OFFICE.name}\\. Allowed: 100 m to check in\\.$`).test(r.body.error) && (await rowsOf(E1.e)).length === 0, r.body);
    r = await punch(E1, { metres: 160, acc: 80 });
    check('D5 160 m away with ±80 m GPS: accepted (the circle of doubt touches the limit)', r.status === 201, r.body);
    await reset(E1.e);
    await mode('record', { accuracyCounts: false }); await sleep(100);
    r = await punch(E1, { metres: 160, acc: 80 });
    check('D6 the same reading with "count the GPS accuracy" OFF: refused', r.status === 403 && r.body.code === 'GEOFENCE', r.body);
    await mode('record', { accuracyCounts: true, accuracyCapM: 50 });
    r = await punch(E1, { metres: 160, acc: 200 });
    check('D7 the allowance cap is Admin-editable: with a 50 m cap, 160 m away with ±200 m is refused', r.status === 403, r.body);
    await mode('record', { accuracyCapM: 300 });
    const ref = await call('GET', `/api/attendance/refused-attempts?from=${today}&to=${today}`, SA.tok);
    check('D8 refused tries are kept for HR with the distance', ref.status === 200 && (ref.body.rows || []).some((x) => x.employeeId === E1.e.id && x.distanceM >= 119 && x.distanceM <= 121), ref.body);
    const lc = await call('POST', '/api/attendance/checkin/location-check', E1.tok, { latitude: northOf(OFFICE.lat, 500), longitude: OFFICE.lng, accuracy: 10, direction: 'In' });
    check('D9 the screen asks the server about the location first: outside answer carries the plain message', lc.status === 200 && lc.body.inside === false && /^You are about 5\d\d m from/.test(lc.body.message), lc.body);
    const lc2 = await call('POST', '/api/attendance/checkin/location-check', E1.tok, { latitude: northOf(OFFICE.lat, 4), longitude: OFFICE.lng, accuracy: 10, direction: 'In' });
    check('D10 4 m away: the location check says inside', lc2.status === 200 && lc2.body.inside === true && lc2.body.distanceM <= 5, lc2.body);
    await reset(E1.e);
    r = await punch(E1, { noLoc: true });
    check('D11 no location, setting "ask the person" (default): refused, nothing recorded', r.status === 400 && r.body.code === 'LOCATION' && (await rowsOf(E1.e)).length === 0, r.body);
    await mode('record', { noLocation: 'record' });
    r = await punch(E1, { noLoc: true });
    check('D12 no location, setting "record": recorded and shown as Location not captured', r.status === 201 && r.body.punch.locationStatus === 'Location not captured' && r.body.punch.distanceM == null, r.body);
    await reset(E1.e); await mode('record', { noLocation: 'block' });
    r = await punch(E1, { lat: 0, lng: 0 });
    check('D13 0,0 (a typical fake) counts as no location', r.status === 400 && r.body.code === 'LOCATION', r.body);
    r = await punch(E1, { metres: 4, acc: 0.2 });
    const flagged = await rowsOf(E1.e);
    check('D14 a too-perfect GPS (±0.2 m) is accepted but flagged on the punch', r.status === 201 && flagged.length === 1 && /too perfect/.test(flagged[0].location) && r.body.location.flags.length === 1, [r.body, flagged[0] && flagged[0].location]);
    await reset(E1.e);

    // ======================= F: the face mode matrix through the API =======================
    const matrix = [
      // mode, stub, frames, expect: recorded?, status
      ['record', 'pass', 3, true, 'Verified'], ['record', 'weak', 3, true, 'Verified'], ['record', 'fail', 3, true, 'Face not matched'],
      ['record', 'noface', 3, true, 'Face not checked'], ['record', 'timeout', 3, true, 'Face not checked'], ['record', 'engine', 3, true, 'Face not checked'],
      ['record', null, 0, true, 'Face not checked'], ['record', null, 3, true, 'Face not checked'], // no camera / no (readable) profile photo
      ['easy', 'pass', 3, true, 'Verified'], ['easy', 'weak', 3, true, 'Verified'], ['easy', 'fail', 3, false, null],
      ['easy', 'noface', 3, true, 'Face not checked'], ['easy', null, 0, true, 'Face not checked'], ['easy', null, 3, true, 'Face not checked'],
      ['strict', 'pass', 3, true, 'Verified'], ['strict', 'weak', 3, false, null], ['strict', 'fail', 3, false, null],
      ['strict', 'noface', 3, true, 'Face not checked'], ['strict', 'timeout', 3, true, 'Face not checked'], ['strict', 'engine', 3, true, 'Face not checked'], ['strict', null, 0, true, 'Face not checked'],
    ];
    for (const [m, face, frames, recorded, status] of matrix) {
      await mode(m); await reset(E1.e);
      const x = await punch(E1, { face, frames, metres: 4 });
      const rows = await rowsOf(E1.e);
      const label = `F ${m} / ${face || (frames ? 'no photo' : 'no camera')} / ${frames} pictures`;
      if (recorded) check(`${label}: recorded as "${status}"`, x.status === 201 && rows.length === 1 && rows[0].verificationStatus === status && x.body.verification.status === status, [x.status, x.body && x.body.error, rows.length && rows[0].verificationStatus]);
      else check(`${label}: refused (a face was seen and is not this person), nothing recorded`, x.status === 422 && rows.length === 0, [x.status, x.body]);
    }
    await mode('record'); await reset(E1.e);
    let ch = await call('GET', '/api/attendance/face/challenge?direction=In', E1.tok);
    check('F-a Record anyway asks for no head turn or blink: just look, 3 small pictures', ch.status === 200 && ch.body.mode === 'record' && ch.body.action === 'look' && ch.body.frames === 3 && ch.body.intervalMs <= 250, ch.body);
    // QUICK BY DEFAULT (2026-10-23): even Strict / Required only ask 'look at the camera' (3 pictures) until an Admin switches the live move on
    await mode('strict');
    ch = await call('GET', '/api/attendance/face/challenge?direction=In', E1.tok);
    check('F-b Strict is QUICK by default: just look, 3 small pictures (the live move is off)', ch.status === 200 && ch.body.action === 'look' && ch.body.frames === 3, ch.body);
    await mode('strict', { livenessCheck: true });
    ch = await call('GET', '/api/attendance/face/challenge?direction=In', E1.tok);
    check('F-b2 Strict with "also ask for a blink or head turn" switched on asks for the live move', ch.status === 200 && ['turn', 'blink'].includes(ch.body.action) && ch.body.frames >= 10, ch.body);
    await mode('required');
    ch = await call('GET', '/api/attendance/face/challenge?direction=In', E1.tok);
    check('F-b3 Required is quick too by default (it still refuses a face that does not match)', ch.status === 200 && ch.body.action === 'look' && ch.body.mode === 'required', ch.body);
    const mp = await call('GET', '/api/attendance/face/my-photo', E1.tok);
    check('F-b4 the profile photo of the person is served to the person (200 or 404 when there is none), never JSON with a path', [200, 404].includes(mp.status), mp.status);
    await mode('record');
    const e3 = await mkUser('e3', {}, {});
    await prisma.employeeDocument.deleteMany({ where: { employeeId: e3.e.id } });
    ch = await call('GET', '/api/attendance/face/challenge?direction=In', e3.tok);
    check('F-c a person with NO profile photo can still start a check-in (no NO_PHOTO block)', ch.status === 200, ch.body);
    r = await punch(e3, { face: null, frames: 3 });
    const e3rows = await prisma.attendancePunch.findMany({ where: { employeeId: e3.e.id } });
    check('F-d … and it is recorded as "Face not checked" with the plain reason', r.status === 201 && e3rows.length === 1 && e3rows[0].verificationStatus === 'Face not checked' && /no profile photo/i.test(e3rows[0].livenessStatus || ''), [r.body, e3rows[0] && e3rows[0].livenessStatus]);

    // ======================= P: what is stored =======================
    await mode('record'); await reset(E1.e);
    r = await punch(E1, { metres: 4, acc: 71, face: 'fail', frames: 3 });
    const [p] = await rowsOf(E1.e);
    check('P1 the punch keeps the distance, GPS accuracy, coordinates, location time, flag and reason', r.status === 201 && p && p.distanceM <= 5 && p.accuracyM === 71 && p.latitude != null && p.longitude != null && p.locationAt && p.verificationStatus === 'Face not matched' && /did not match/.test(p.livenessStatus) && /±71 m/.test(p.location), p);
    check('P2 the response says the face was not matched and why (no penalty wording)', r.body.verification.matched === false && r.body.verification.mode === 'record' && /did not match/.test(r.body.verification.reason), r.body.verification);
    const img = await call('GET', `/api/attendance/punches/${p.id}/image`, E1.tok);
    const meta = img.status === 200 ? await sharp(img.raw).metadata() : null;
    check('P3 a small selfie (at most 320 px wide, JPEG) is stored and the employee can open it', img.status === 200 && meta && meta.format === 'jpeg' && meta.width <= 320, [img.status, meta]);
    const imgOther = await call('GET', `/api/attendance/punches/${p.id}/image`, E2.tok);
    check('P4 another employee cannot open it', imgOther.status === 403, imgOther.status);
    const imgHr = await call('GET', `/api/attendance/punches/${p.id}/image`, SA.tok);
    check('P5 Admin / HR can open it', imgHr.status === 200, imgHr.status);
    const day = await prisma.attendance.findUnique({ where: { employeeId_date: { employeeId: E1.e.id, date: today } } });
    check('P6 the day is recorded (check-in set) - a failed face never makes the day absent / unpaid', !!day && !!day.checkIn && !/absent|lop|unpaid/i.test(String(day.status)), day);
    const pl = await call('GET', `/api/attendance/punch-log?from=${today}&to=${today}&punchSource=web`, SA.tok);
    const prow = ((pl.body && pl.body.rows) || []).find((x) => x.employeeId === E1.e.id);
    const raw = prow && (prow.rawPunches || []).find((x) => x.id === p.id);
    check('P7 the "Web check-in" source filter lists it with "Face: not matched" and "Distance"', pl.status === 200 && pl.body.sourceTotals && pl.body.sourceTotals.web >= 1 && raw && raw.face === 'not matched' && raw.distanceM <= 5 && raw.accuracyM === 71 && raw.source === 'web', [pl.status, pl.body && pl.body.sourceTotals, raw]);

    // ======================= R: HR review =======================
    const list = await call('GET', '/api/attendance/face-review', SA.tok);
    const mine = ((list.body && list.body.rows) || []).find((x) => x.id === p.id);
    check('R1 Admin sees the check-in in the review list with employee, time, score, reason and a selfie flag', list.status === 200 && mine && mine.hasSelfie === true && mine.status === 'Face not matched' && mine.score != null && mine.employeeCode && mine.reason && list.body.counts.waiting >= 1, list.body);
    const listEmp = await call('GET', '/api/attendance/face-review', E2.tok);
    check('R2 an ordinary employee cannot open the review list', listEmp.status === 403, listEmp.status);
    const decEmp = await call('POST', `/api/attendance/face-review/${p.id}`, E2.tok, { decision: 'ok' });
    check('R3 an ordinary employee cannot decide', decEmp.status === 403, decEmp.status);
    const dayBefore = JSON.stringify(await prisma.attendance.findUnique({ where: { employeeId_date: { employeeId: E1.e.id, date: today } } }));
    const sum = await call('GET', '/api/attendance/face-summary', SA.tok);
    check('R4 the daily summary counts web check-ins, matched, not matched, waiting', sum.status === 200 && sum.body.webCheckins >= 1 && sum.body.notMatched >= 1 && sum.body.waitingForReview >= 1, sum.body);
    const wrong = await call('POST', `/api/attendance/face-review/${p.id}`, SA.tok, { decision: 'maybe' });
    check('R5 a wrong decision is refused in words', wrong.status === 400, wrong.body);
    const ok = await call('POST', `/api/attendance/face-review/${p.id}`, SA.tok, { decision: 'ok' });
    const afterOk = await prisma.attendancePunch.findUnique({ where: { id: p.id } });
    check('R6 Mark OK changes the face status and says so', ok.status === 200 && afterOk.verificationStatus === 'Face OK (HR)', [ok.body, afterOk.verificationStatus]);
    const gone = await call('GET', '/api/attendance/face-review', SA.tok);
    check('R7 a reviewed check-in leaves the waiting list', !((gone.body.rows || []).some((x) => x.id === p.id)));
    const rej = await call('POST', `/api/attendance/face-review/${p.id}`, SA.tok, { decision: 'reject' });
    const afterRej = await prisma.attendancePunch.findUnique({ where: { id: p.id } });
    check('R8 "Not this person" is saved too', rej.status === 200 && afterRej.verificationStatus === 'Not this person (HR)', rej.body);
    const dayAfter = JSON.stringify(await prisma.attendance.findUnique({ where: { employeeId_date: { employeeId: E1.e.id, date: today } } }));
    check('R9 reviewing never changes the day (no LOP / late / leave side effect)', dayBefore === dayAfter, [dayBefore, dayAfter]);
    const au = await prisma.auditLog.findMany({ where: { entityId: p.id, action: { startsWith: 'Face check reviewed' } } });
    check('R10 both decisions are in the audit log with who decided', au.length === 2 && au.every((a) => a.userId === SA.u.id), au.length);
    const allList = await call('GET', `/api/attendance/face-review?state=all`, SA.tok);
    check('R11 "all" also lists the reviewed ones', (allList.body.rows || []).some((x) => x.id === p.id && x.status === 'Not this person (HR)'));
    // retention: a selfie older than the retention days is deleted, the punch row stays
    const removed = await review.sweepSelfies(30, new Date(Date.now() + 40 * 86400000), [E1.e.id]);
    const swept = await prisma.attendancePunch.findUnique({ where: { id: p.id } });
    const imgGone = await call('GET', `/api/attendance/punches/${p.id}/image`, SA.tok);
    check('R12 retention sweep: the old selfie is removed, the punch (time, distance, score) stays', removed >= 1 && swept && swept.imageFile == null && swept.distanceM != null && swept.verificationScore != null && imgGone.status === 404, [removed, swept && swept.imageFile, imgGone.status]);
    const notYet = await review.sweepSelfies(30, new Date(), [E1.e.id]);
    check('R13 a recent selfie is not removed', notYet === 0);
    await reset(E1.e);
    r = await punch(E1, { face: 'pass', frames: 3 });
    const sw2 = await review.sweepSelfies(30, new Date(), [E1.e.id]);
    check('R14 today\'s selfie survives a sweep with the 30-day default', r.status === 201 && sw2 === 0);
    const sumAfter = await call('GET', '/api/attendance/face-summary', SA.tok);
    check('R15 matched check-ins are counted as matched', sumAfter.body.matched >= 1);
    const sumEmp = await call('GET', '/api/attendance/face-summary', E2.tok);
    check('R16 an ordinary employee cannot read the summary', sumEmp.status === 403);
  } catch (e) {
    fail += 1; console.log(`FAIL  test crashed: ${e && e.stack ? e.stack : e}`);
  } finally {
    try {
      const empIds = made.emps;
      const punches = await prisma.attendancePunch.findMany({ where: { employeeId: { in: empIds } }, select: { id: true, imageFile: true } });
      try { const att = require(path.join(BACK, 'src/utils/attachments')); punches.forEach((x) => { if (x.imageFile) att.remove(x.imageFile); }); } catch { /* sandbox files only */ }
      await prisma.attendancePunch.deleteMany({ where: { employeeId: { in: empIds } } });
      await prisma.attendance.deleteMany({ where: { employeeId: { in: empIds } } });
      await prisma.employeeDocument.deleteMany({ where: { employeeId: { in: empIds } } });
      await prisma.appSetting.deleteMany({ where: { key: { in: empIds.map((id) => faceRef.keyOf(id)) } } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: made.users } }, { entityId: { in: [...empIds, ...punches.map((x) => x.id)] } }, { toValue: { contains: 'ZZTEST WC' } }] } });
      await prisma.notification.deleteMany({ where: { userId: { in: made.users } } }).catch(() => {});
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
