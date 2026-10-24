// ---------------------------------------------------------------------------
// HRMS-24 §4 / §5 / §10 / §11 — attendance routes added to routes/attendance.js
// (registered onto the same router, after its requireAuth, so every path here
// is authenticated and lives under /api/attendance).
//
//   GET  /checkin/status          my check-in readiness (methods, photo, geofence)
//   GET  /face/challenge          a signed one-use liveness challenge
//   POST /punches/verified        web/mobile punch: live frames + location,
//                                 face verified ON THE SERVER (utils/faceEngine.js)
//   GET  /punches/:id/image       the live capture stored with a punch
//   GET  /my-days                 §10 My Attendance: own days, date range / month / year
//   GET  /team-days               §11 Team attendance, day by day, inside RBAC scope
//   GET  /monthly-summary         §11 per-employee monthly counts (+ csv / xlsx)
//   GET  /geofence, PUT /geofence Super Admin: office location, radius, face threshold
//
// Everyone with an employee record — TL, STL, HR, Assistant Manager, Manager,
// Super Admin included — checks in through the same path and is judged by the
// same day rule (utils/attendanceDays.js). Nothing here looks at a role except
// the Super Admin gate on the geofence settings.
// ---------------------------------------------------------------------------

const fs = require('fs');
const prisma = require('../db');
const { requirePerm } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { employeeWhere, employeeInScope, OUT_OF_SCOPE } = require('../utils/scope');
const { withoutSystemAccounts } = require('../utils/systemAccounts');
const attachments = require('../utils/attachments');
const face = require('../utils/faceEngine');
const D = require('../utils/attendanceDays');
const PSRC = require('../utils/punchSources'); // punch source labels (Web / Biometric / Pulse / HR)
const { employeeMatchesFilters, monthStats } = require('../utils/attendanceMath');
const { hrStatusOf } = require('../utils/hrStatus');
const { toCsv, toXlsx } = require('../utils/tabularExport');
const { notifyDataIo } = require('../utils/dataIoNotify');
const leaveCharge = require('../utils/leaveCharge');
const fence = require('../utils/geofence');
const guard = require('../utils/punchGuard');
const CS = require('../utils/checkinSettings'); // face mode, GPS-accuracy allowance, retention
const faceRef = require('../utils/faceRef'); // each person's reference face, computed once
const faceReview = require('../utils/faceReview'); // HR list of web check-ins whose face was not matched / not checked

const WEB_METHODS = ['GPS', 'Face'];
const FAILED = 'Face verification failed. Please try again.';
const NO_PHOTO = 'Add your photo in My Employee Profile first';
const EXITED = ['Relieved', 'Exited'];
const FRAME_MAX_BYTES = 700 * 1024;

// One check-in at a time per person, and a repeated tap / retry with the same
// idempotency key gets the first answer back instead of a second punch.
const WARMED = new Map(); // employeeId -> last warm-up
const BUSY = new Map(); // userId -> start time of the check-in being worked on
const IDEM = new Map(); // `${userId}:${key}` -> { state, status, body, at }
const IDEM_TTL_MS = 15 * 60 * 1000;
const BUSY_MAX_MS = 2 * 60 * 1000;

// Great-circle distance in metres.
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2
    + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Inside when the reading, allowing for up to 100 m of its own stated
// accuracy, reaches the circle. A reading worse than that cannot prove it.
function geofenceCheck(cfg, lat, lng, accuracy) {
  if (!cfg.geofenceEnabled || cfg.officeLatitude == null || cfg.officeLongitude == null) {
    return { inside: true, status: 'No geofence configured', distance: null };
  }
  const distance = haversine(cfg.officeLatitude, cfg.officeLongitude, lat, lng);
  const slack = Math.min(Math.max(0, accuracy || 0), 100);
  const inside = distance - slack <= cfg.geofenceRadiusM;
  return { inside, status: inside ? 'Inside geofence' : 'Outside geofence', distance: Math.round(distance) };
}

async function latestPhoto(employeeId) {
  return prisma.employeeDocument.findFirst({ where: { employeeId, docType: 'Photo' }, orderBy: { uploadedAt: 'desc' } });
}

// The reference face of this person: kept after the first time (faceRef.js), so the profile photo is analysed once.
async function referenceFace(own, photo, photoPath) {
  if (!photo || !photoPath) return null;
  const key = faceRef.photoKey(photo);
  const stored = await faceRef.get(own.id, key);
  if (stored) face.seedPhoto(key, [stored]);
  const faces = await face.analysePhoto(key, fs.readFileSync(photoPath));
  if (!faces || !faces.length) return null;
  const main = [...faces].sort((a, b) => (b.box.width * b.box.height) - (a.box.width * a.box.height))[0];
  if (!stored && main && main.descriptor) faceRef.put(own.id, key, main).catch(() => {});
  return main;
}

const num = (v) => (v === undefined || v === null || v === '' ? NaN : Number(v));
const deviceSource = (ua) => (/Mobi|Android|iPhone|iPad/i.test(String(ua || '')) ? 'Mobile' : 'Web');

// from/to out of ?from&to, ?month=YYYY-MM or ?year=YYYY (default: this month).
function rangeOf(q) {
  if (q.from || q.to) {
    const from = String(q.from || q.to);
    const to = String(q.to || q.from);
    if (!D.isDate(from) || !D.isDate(to)) return { error: 'Dates must be YYYY-MM-DD.' };
    if (from > to) return { error: 'The From date is after the To date.' };
    return { from, to };
  }
  if (q.year) {
    if (!/^\d{4}$/.test(String(q.year))) return { error: 'year must be YYYY.' };
    return { from: `${q.year}-01-01`, to: `${q.year}-12-31` };
  }
  const month = q.month ? String(q.month) : D.localDate().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) return { error: 'month must be YYYY-MM.' };
  return { month, ...D.monthRange(month) };
}

function sendTable(res, format, filename, headers, rows, sheet) {
  // Every export tells the Super Admin (utils/dataIoNotify.js; never throws).
  notifyDataIo(res.req, { kind: 'export', module: 'Attendance & Time', count: rows.length, what: `rows of ${sheet}`, format, detail: filename }).catch(() => {});
  if (format === 'xlsx') {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
    return res.send(toXlsx(headers, rows, sheet));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
  return res.send(toCsv(headers, rows));
}

const DAY_HEADERS = ['Date', 'Check-In', 'Check-Out', 'Total Hours', 'Status', 'Early Logout', 'Present', 'Leave', 'Absent (unpaid)', 'Paid', 'Method', 'Location Status', 'Verification', 'Regularization', 'Note', 'Result', 'Reason', 'Late coming', 'Punches by source'];
const dayCells = (d) => [d.date, d.checkIn || '', d.checkOut || '', d.hours ?? '', d.status, d.earlyLogout ? 'Yes' : '', d.present ?? '', d.leave ?? '', d.absent ?? '', d.paid ?? '', d.howText || d.method || '', d.locationStatus || '', d.verification || '', d.regularization || '', d.note || '', d.kpi ? (D.KPI_LABEL[d.kpi] || d.kpi) : '', d.reason || '', (d.late || d.lateExcused) ? (d.latePermissionText || 'Not explained') : '', d.sourceCounts ? PSRC.GROUPS.filter((g) => d.sourceCounts[g]).map((g) => `${PSRC.GROUP_LABEL[g]} ${d.sourceCounts[g]}`).join(', ') : ''];

module.exports = function registerSelfAttendance(router, { getConfig, methodsOf, CHECKIN_ASSIGNABLE, isSuperAdmin, ownEmployee }) {
  // ---- readiness ------------------------------------------------------------
  router.get('/checkin/status', async (req, res) => {
    const own = await ownEmployee(req);
    if (!own) return res.json({ hasEmployee: false, methods: [], hasPhoto: false });
    const cfg = await getConfig();
    const cs = await CS.load();
    const photo = await latestPhoto(own.id);
    const today = D.localDate();
    const punches = await prisma.attendancePunch.findMany({ where: { employeeId: own.id, date: today }, orderBy: { time: 'asc' } });
    res.json({
      hasEmployee: true,
      employeeId: own.id,
      methods: methodsOf(own).map((k) => ({ key: k, label: CHECKIN_ASSIGNABLE[k], web: WEB_METHODS.includes(k) })),
      hasPhoto: !!photo,
      geofence: { enabled: !!(cfg.geofenceEnabled && cfg.officeLatitude != null), radiusM: cfg.geofenceRadiusM, accuracyCounts: cs.accuracyCounts, accuracyCapM: cs.accuracyCapM, ...fence.publicOffices(await fence.loadOffices(cfg)) },
      face: { mode: cs.faceMode, privacy: 'Your photo is used only to check your attendance.' },
      today,
      open: punches.length ? punches[punches.length - 1].direction === 'In' : false,
      minGapSec: await guard.minGapSec(),
      todayPunches: punches.map((p) => ({ id: p.id, time: p.time, direction: p.direction, method: p.method, verificationStatus: p.verificationStatus, sourceKey: PSRC.sourceKeyOf(p), sourceLabel: PSRC.LABEL[PSRC.sourceKeyOf(p)] })),
    });
  });

  // ---- warm-up: called when My Attendance opens, so the face models and this
  // person's registered photo are ready BEFORE they tap Check In ------------
  router.post('/face/warm', async (req, res) => {
    const own = await ownEmployee(req);
    if (!own || !methodsOf(own).some((k) => WEB_METHODS.includes(k))) return res.json({ warming: false });
    const photo = await latestPhoto(own.id);
    res.json({ warming: !!photo });
    if (!photo) return;
    const last = WARMED.get(own.id) || 0;
    if (Date.now() - last < 5 * 60 * 1000) return;
    WARMED.set(own.id, Date.now());
    try {
      const p = attachments.resolveStored(photo.file);
      await face.warm();
      if (p) await referenceFace(own, photo, p);
    } catch (err) { WARMED.delete(own.id); }
  });

  // The employee's OWN profile photo, so the check-in screen can show the picture the face is compared with (own record only).
  router.get('/face/my-photo', async (req, res) => {
    const own = await ownEmployee(req);
    if (!own) return res.status(404).json({ error: 'No employee record is linked to this login.' });
    const doc = await latestPhoto(own.id);
    const full = doc && attachments.resolveStored(doc.file);
    if (!full || !['image/jpeg', 'image/png', 'image/webp'].includes(doc.mime)) return res.status(404).json({ error: 'No profile photo yet.' });
    res.setHeader('Content-Type', doc.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=60');
    return res.sendFile(full);
  });

  // ---- the liveness challenge ---------------------------------------------
  router.get('/face/challenge', async (req, res) => {
    const own = await ownEmployee(req);
    if (!own) return res.status(404).json({ error: require('../utils/ownEmployee').NO_LINK_MESSAGE });
    const methods = methodsOf(own).filter((k) => WEB_METHODS.includes(k));
    if (!methods.length) return res.status(403).json({ error: 'Web / mobile check-in is not assigned to you. Super Admin assigns check-in methods.' });
    // A profile photo is NOT needed to check in (the punch is then recorded as 'Face not checked').
    const cs = await CS.load();
    const direction = req.query.direction === 'Out' ? 'Out' : 'In';
    // Load the model while the person is getting ready.
    face.warm().catch(() => {});
    // Strict keeps the head-turn / blink challenge; Easy and Record-anyway use a plain 'look at the camera' (3 small pictures).
    // QUICK unless an Admin asked for the live move: 'look at the camera' (3 small pictures) is compared with the profile photo; Required still refuses a face that
    // does not match. The blink / head-turn challenge only when Strict / Required AND the Admin switched "Also ask for a blink or head turn" on.
    res.json({ ...face.issueChallenge(req.user.id, direction, ['strict', 'required'].includes(cs.faceMode) && cs.livenessCheck ? undefined : 'look'), mode: cs.faceMode });
  });

  // ---- the verified punch ---------------------------------------------------
  async function verifiedPunch(req, res) {
    let parsed;
    try {
      parsed = await attachments.parseMultipart(req, { maxBytes: 12 * 1024 * 1024 });
    } catch (err) {
      return res.status(400).json({ error: attachments.MESSAGE[err.code] || 'Could not read the check-in.' });
    }
    const f = parsed.fields;
    // No file part is ever accepted: the frames are camera captures sent as
    // fields by the in-app camera, and a form carrying an uploaded file is
    // refused outright.
    if (parsed.file) return res.status(400).json({ error: 'Uploading a picture is not allowed. Use the live camera.' });

    const challenge = face.consumeChallenge(f.token, req.user.id);
    if (challenge.error) return res.status(400).json({ error: challenge.error, code: 'CHALLENGE' });

    const own = await ownEmployee(req);
    if (!own) return res.status(404).json({ error: require('../utils/ownEmployee').NO_LINK_MESSAGE });
    const allowed = methodsOf(own).filter((k) => WEB_METHODS.includes(k));
    const key = WEB_METHODS.includes(f.method) ? f.method : allowed[0];
    if (!key || !allowed.includes(key)) return res.status(403).json({ error: 'Web / mobile check-in is not assigned to you. Super Admin assigns check-in methods.' });

    // Location — asked for at check-in AND check-out. What a missing location does is Admin's setting (default: refuse).
    const cs = await CS.load();
    const lat = num(f.latitude); const lng = num(f.longitude); const acc = num(f.accuracy);
    const locValid = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
    const locRule = CS.locationRule({ valid: locValid, setting: cs.noLocation });
    if (!locRule.record) {
      return res.status(400).json({ error: 'Your location is required. Allow location access for this site and try again.', code: 'LOCATION' });
    }
    const accuracy = locValid && Number.isFinite(acc) && acc >= 0 ? acc : null;
    const locTs = f.locationAt ? new Date(Number(f.locationAt) || f.locationAt) : null;
    const locationAt = locTs && !Number.isNaN(locTs.getTime()) ? locTs : new Date();
    if (locValid && Math.abs(Date.now() - locationAt.getTime()) > 10 * 60 * 1000) {
      return res.status(400).json({ error: 'That location reading is too old. Try again.', code: 'LOCATION' });
    }
    const cfg = await getConfig();
    const offices = await fence.loadOffices(cfg);
    const fenceInfo = locValid
      ? fence.check(offices, lat, lng, accuracy, { accuracyCounts: cs.accuracyCounts, accuracyCapM: cs.accuracyCapM })
      : { inside: true, status: locRule.status, distance: null, office: null, radiusM: null, others: [], lowAccuracy: false };
    if (!fenceInfo.inside) {
      // The refused attempt is kept for HR: who, when, how far away (GET /attendance/refused-attempts).
      const dirWord = challenge.direction === 'In' ? 'check in' : 'check out';
      const text = `Tried to ${dirWord} ${fence.distanceText(fenceInfo.distance)} away at ${D.localTime()}`;
      await logAudit({
        userId: req.user.id, action: `Check-${challenge.direction === 'In' ? 'in' : 'out'} refused: outside geofence`, entity: 'Employee', entityId: own.id,
        fromValue: JSON.stringify({ distanceM: fenceInfo.distance, office: fenceInfo.office.name, radiusM: fenceInfo.radiusM, accuracyM: accuracy, direction: challenge.direction, date: D.localDate(), time: D.localTime(), latitude: lat, longitude: lng }),
        toValue: `${text} (${fenceInfo.office.name}, allowed ${fence.distanceText(fenceInfo.radiusM)})`,
      });
      return res.status(403).json({
        error: fence.outsideMessage(fenceInfo, challenge.direction),
        code: 'GEOFENCE',
        distanceM: fenceInfo.distance,
        geofence: { distanceM: fenceInfo.distance, radiusM: fenceInfo.radiusM, office: fenceInfo.office, others: fenceInfo.others, accuracyM: accuracy, weakGps: fenceInfo.weakGps, lowAccuracy: fenceInfo.lowAccuracy, swapped: fenceInfo.swapped },
      });
    }
    // Sanity flags (never a refusal): a "too perfect" GPS or a jump faster than any vehicle since the last web punch.
    let gpsFlags = [];
    if (locValid) {
      const prev = await prisma.attendancePunch.findFirst({ where: { employeeId: own.id, latitude: { not: null }, source: { in: ['Web', 'Mobile'] } }, orderBy: { createdAt: 'desc' } });
      gpsFlags = fence.spoofFlags({ accuracy, lat, lng, prev: prev ? { latitude: prev.latitude, longitude: prev.longitude, at: prev.createdAt } : null });
    }

    // Cheap checks first: no point in a face comparison for a punch the day does not allow.
    const early = await guard.webPunchGuard(prisma, own.id, D.localDate(), challenge.direction);
    if (!early.ok) return answerGuard(res, early);

    // Registered photo. NOT required to punch: without one the check-in is recorded as "Face not checked".
    const photo = await latestPhoto(own.id);
    const photoPath = photo && attachments.resolveStored(photo.file);
    // TEST SANDBOX ONLY (never on the real server): X-Test-Face: pass | weak | fail | noface | timeout | engine stands in for
    // the face model, so tests can exercise the punch rules with fake camera frames. Without TEST_MODE the header is ignored.
    const stub = require('../utils/sandbox').isSandbox() ? req.get('X-Test-Face') : null; // eslint-disable-line global-require

    // Frames: JPEG data URLs from the camera canvas (none when the camera was not available).
    const frames = [];
    for (let i = 0; i < face.MAX_FRAMES; i += 1) {
      const v = f[`frame${i}`];
      if (!v) continue;
      const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(v.trim());
      if (!m) return res.status(400).json({ error: 'The camera frames were not readable. Try again.', code: 'FRAMES' });
      const buf = Buffer.from(m[1], 'base64');
      if (buf.length > FRAME_MAX_BYTES || !(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) {
        return res.status(400).json({ error: 'The camera frames were not readable. Try again.', code: 'FRAMES' });
      }
      frames.push(buf);
    }

    // The face check. Result: { code, distance, bestIdx, liveness } — judged by CS.faceVerdict() per the Admin's mode.
    const mode = cs.faceMode;
    const strictThr = cfg.faceMatchThreshold ?? 0.45;
    const threshold = CS.thresholdFor(mode, strictThr);
    const fullCheck = ['strict', 'required'].includes(mode) && challenge.action !== 'look' && frames.length >= face.MIN_FRAMES;
    const runCheck = async () => {
      const ref = await referenceFace(own, photo, photoPath);
      if (!ref) return { code: 'NO_FACE_IN_PHOTO', distance: null, bestIdx: 0 };
      if (fullCheck) {
        const { results, diffs } = await face.analyseFrames(frames);
        const d = face.decide({ photoFaces: [ref], frames: results, diffs, action: challenge.action, threshold });
        return { code: d.code, distance: d.distance ?? null, bestIdx: d.bestFrame ?? 0, liveness: d.liveness || null, multiple: d.code === 'MULTIPLE_FACES', reason: d.reason || null };
      }
      const q = await face.analyseQuick(ref, frames, { threshold, maxFrames: 3, deadlineAt: Date.now() + cs.analysisMs });
      if (q.best == null) return { code: q.multiple ? 'MULTIPLE_FACES' : (q.timedOut ? 'TIMEOUT' : 'NO_FACE'), distance: null, bestIdx: 0 };
      return { code: q.best <= threshold ? 'VERIFIED' : 'NO_MATCH', distance: q.best, bestIdx: Math.max(0, q.bestIdx) };
    };
    let outcome = null;
    let lateRun = null;
    if (stub) {
      const S = {
        pass: { code: 'VERIFIED', distance: 0.07 }, weak: { code: 'NO_MATCH', distance: 0.6 }, fail: { code: 'NO_MATCH', distance: 0.9 },
        noface: { code: 'NO_FACE', distance: null }, timeout: { code: 'TIMEOUT', distance: null }, engine: { code: 'ENGINE', distance: null },
      };
      outcome = { bestIdx: 0, ...(S[stub] || S.engine), liveness: stub === 'pass' ? { passed: true, stub: true } : null };
    } else if (!frames.length) {
      outcome = { code: 'NO_CAMERA', distance: null, bestIdx: 0 };
    } else if (!photoPath) {
      outcome = { code: 'NO_PHOTO', distance: null, bestIdx: 0 };
    } else {
      try {
        const work = runCheck();
        const limit = fullCheck ? 25000 : cs.analysisMs + 1500;
        outcome = await Promise.race([work, new Promise((r) => { setTimeout(() => r(null), limit).unref(); })]);
        if (!outcome) { lateRun = work; outcome = { code: 'TIMEOUT', distance: null, bestIdx: 0 }; }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[face] verification error', err);
        outcome = { code: 'ENGINE', distance: null, bestIdx: 0 };
      }
    }
    const verdict = CS.faceVerdict({ mode, code: outcome.code, distance: outcome.distance, strictThreshold: strictThr });
    // The engine's own plain sentence says what was wrong (no blink / not clearly visible / more than one face) - the screen shows that one.
    if (!verdict.matched && outcome.reason && ['LIVENESS', 'NO_FACE', 'MULTIPLE_FACES', 'INCONSISTENT'].includes(outcome.code)) verdict.reason = outcome.reason;

    if (!verdict.record) {
      await logAudit({
        userId: req.user.id, action: `Face verification failed (check-${challenge.direction === 'In' ? 'in' : 'out'})`, entity: 'Employee', entityId: own.id,
        toValue: `${outcome.code}${outcome.distance != null ? ` · distance ${outcome.distance} (threshold ${verdict.threshold})` : ''} · mode ${mode}`,
      });
      return res.status(422).json({ error: mode === 'required' ? `Check-in not taken. ${verdict.reason} Please try again in good light, face the camera, and do the move it asks.` : FAILED, reason: verdict.reason, code: outcome.code, score: outcome.distance != null ? Number(Math.max(0, 1 - outcome.distance).toFixed(4)) : null, liveness: outcome.liveness || null });
    }
    const score = outcome.distance != null ? Number(Math.max(0, 1 - outcome.distance).toFixed(4)) : null;

    // A small selfie (320 px, JPEG quality 60) kept with the punch for HR; deleted after the retention days.
    let stored = null;
    if (frames.length) {
      try {
        const small = await require('sharp')(frames[Math.min(outcome.bestIdx || 0, frames.length - 1)]).rotate().resize({ width: 320, withoutEnlargement: true }).jpeg({ quality: 60 }).toBuffer(); // eslint-disable-line global-require
        stored = attachments.store({ filename: 'live-capture.jpg', contentType: 'image/jpeg', data: small });
      } catch (err) { stored = null; } // no selfie is no reason to lose an attendance
    }
    const ua = String(req.headers['user-agent'] || '').slice(0, 400);
    // The person closed the page / pressed Cancel while we were comparing faces: record nothing.
    if (req.socket && req.socket.destroyed) { if (stored) attachments.remove(stored.billFile); return undefined; }
    let punch;
    let blocked = null;
    const liveText = verdict.matched
      ? (outcome.liveness && outcome.liveness.passed ? `Passed (${challenge.action === 'turn' ? 'head turn' : challenge.action === 'blink' ? 'blink' : 'live camera'})` : (outcome.code === 'LIVENESS' ? 'Liveness not seen' : 'Not required'))
      : verdict.reason;
    try {
      // Check again and insert under one lock: two taps that both passed the early check cannot both write.
      punch = await guard.withLock(own.id, async () => {
        const again = await guard.webPunchGuard(prisma, own.id, D.localDate(), challenge.direction);
        if (!again.ok) { blocked = again; return null; }
        return prisma.attendancePunch.create({
        data: {
          employeeId: own.id,
          date: D.localDate(),
          time: D.localTime(),
          direction: challenge.direction,
          method: CHECKIN_ASSIGNABLE[key],
          location: locValid ? `${lat.toFixed(5)},${lng.toFixed(5)}${accuracy != null ? ` (±${Math.round(accuracy)} m)` : ''}${gpsFlags.length ? ` · ${gpsFlags.join('; ')}` : ''}` : 'Location not captured',
          source: deviceSource(ua),
          latitude: locValid ? lat : null,
          longitude: locValid ? lng : null,
          accuracyM: accuracy,
          locationAt: locValid ? locationAt : null,
          locationStatus: fenceInfo.status,
          distanceM: fenceInfo.distance,
          imageFile: stored ? stored.billFile : null,
          verificationStatus: verdict.status,
          verificationScore: score,
          livenessStatus: liveText,
          userAgent: ua,
        },
        });
      });
    } catch (err) {
      if (stored) attachments.remove(stored.billFile);
      throw err;
    }
    if (blocked) { if (stored) attachments.remove(stored.billFile); return answerGuard(res, blocked); }
    await D.applyPunchToDay(prisma, punch, cfg);
    // Items 4/6: working on a leave day changes what the leave uses.
    leaveCharge.afterAttendanceChange(own.id, punch.date);
    await logAudit({
      userId: req.user.id, action: `Punch ${punch.direction} recorded (${verdict.matched ? 'face verified' : verdict.status.toLowerCase()})`, entity: 'AttendancePunch', entityId: punch.id,
      toValue: `${punch.date} ${punch.time} · ${score != null ? `score ${score} · ` : ''}${verdict.matched ? '' : `${verdict.reason} · `}${fenceInfo.status}${fenceInfo.distance != null ? ` · ${fenceInfo.distance} m` : ''}${gpsFlags.length ? ` · ${gpsFlags.join('; ')}` : ''}`,
    });
    // The check took longer than we waited: it keeps running, and when it ends the punch's face status is brought up to date.
    if (lateRun) {
      lateRun.then(async (late) => {
        const v = CS.faceVerdict({ mode, code: late.code, distance: late.distance, strictThreshold: strictThr });
        const fresh = await prisma.attendancePunch.findUnique({ where: { id: punch.id } });
        if (!fresh || fresh.verificationStatus !== 'Face not checked') return;
        await prisma.attendancePunch.update({ where: { id: punch.id }, data: { verificationStatus: v.status, verificationScore: late.distance != null ? Number(Math.max(0, 1 - late.distance).toFixed(4)) : null, livenessStatus: v.matched ? 'Not required' : v.reason } });
      }).catch(() => {});
    }
    const { imageFile, userAgent, ...safe } = punch;
    res.status(201).json({
      punch: safe,
      verification: { status: verdict.status, matched: verdict.matched, reason: verdict.reason, mode, score, distance: outcome.distance, threshold: verdict.threshold, liveness: outcome.liveness || null },
      location: { distanceM: fenceInfo.distance, accuracyM: accuracy, lowAccuracy: !!fenceInfo.lowAccuracy, flags: gpsFlags },
    });
    return undefined;
  }

  // A punch the day does not allow (already in / already out / not in yet): a plain answer.
  // An 'already' answer is a 200 with the existing punch; the others are 409.
  function answerGuard(res, g) {
    if (g.duplicate) {
      const { imageFile, userAgent, ...safe } = g.punch;
      return res.status(200).json({ duplicate: true, code: g.code, message: g.message, punch: safe });
    }
    return res.status(409).json({ error: g.message, code: g.code });
  }

  router.post('/punches/verified', async (req, res) => {
    const uid = req.user.id;
    const now = Date.now();
    IDEM.forEach((v, k) => { if (now - v.at > IDEM_TTL_MS) IDEM.delete(k); });
    const rawKey = String(req.get('Idempotency-Key') || '').trim().slice(0, 80);
    const idem = rawKey ? `${uid}:${rawKey}` : null;
    const seen = idem ? IDEM.get(idem) : null;
    // The same tap / retry again: give the first answer back.
    if (seen && seen.state === 'done') return res.status(seen.status).json({ ...seen.body, replayed: true });
    const started = BUSY.get(uid);
    if ((seen && seen.state === 'pending') || (started && now - started < BUSY_MAX_MS)) {
      return res.status(409).json({ error: 'Your check-in is already being checked. Please wait a few seconds.', code: 'IN_FLIGHT' });
    }
    BUSY.set(uid, now);
    if (idem) IDEM.set(idem, { state: 'pending', at: now });
    const send = res.json.bind(res);
    res.json = (body) => {
      if (idem) {
        if (res.statusCode === 200 || res.statusCode === 201) IDEM.set(idem, { state: 'done', status: res.statusCode, body, at: Date.now() });
        else IDEM.delete(idem);
      }
      return send(body);
    };
    try {
      await verifiedPunch(req, res);
    } catch (err) {
      if (idem) IDEM.delete(idem);
      throw err;
    } finally {
      BUSY.delete(uid);
    }
  });

  // ---- the stored live capture ---------------------------------------------
  router.get('/punches/:id/image', async (req, res) => {
    const punch = await prisma.attendancePunch.findUnique({ where: { id: req.params.id }, include: { employee: true } });
    if (!punch || !punch.imageFile) return res.status(404).json({ error: 'No image for this punch' });
    const self = punch.employee.userId === req.user.id;
    if (!self && !(req.user.caps.hrmsManage && employeeInScope(req.user, punch.employee))) return res.status(403).json(OUT_OF_SCOPE);
    const full = attachments.resolveStored(punch.imageFile);
    if (!full) return res.status(404).json({ error: 'The file is no longer on the server' });
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    return res.sendFile(full);
  });

  // ---- §10 My Attendance -----------------------------------------------------
  router.get('/my-days', async (req, res) => {
    const own = await ownEmployee(req);
    if (!own) return res.json({ hasEmployee: false, rows: [], summary: null });
    const range = rangeOf(req.query);
    if (range.error) return res.status(400).json({ error: range.error });
    if (D.eachDay(range.from, range.to).length > 366) return res.status(400).json({ error: 'Pick a range of at most one year.' });
    const cfg = await getConfig();
    const { days } = await D.loadDays(prisma, { employees: [own], from: range.from, to: range.to, cfg, preview: true });
    // Notes (Late / Missing check-in / Missing check-out / No punches / Punch on a leave day) stay visible even when a leave covers the day.
    const withNotes = (d) => { const n = D.notesOf(d); return { ...d, notes: n, noteText: n.map((k) => D.NOTE_LABEL[k]).join(' · ') }; };
    const rows = days(own).filter((d) => !['Upcoming', 'Not Joined'].includes(d.status)).reverse().map(withNotes);
    if (req.query.format === 'csv' || req.query.format === 'xlsx') {
      return sendTable(res, req.query.format, `my-attendance-${range.from}_${range.to}`, DAY_HEADERS, rows.map(dayCells), 'My Attendance');
    }
    res.json({ hasEmployee: true, employee: { id: own.id, name: own.name, employeeCode: own.employeeCode }, ...range, rows, summary: D.summarise(rows) });
  });

  // ---- §11 Team attendance (scoped) ----------------------------------------
  async function scopedActive(req) {
    const list = await prisma.employee.findMany({
      where: withoutSystemAccounts(employeeWhere(req.user)), orderBy: { name: 'asc' }, include: { user: { select: { status: true } } },
    });
    return list.filter((e) => !EXITED.includes(e.employmentStatus) && employeeMatchesFilters(e, req.query));
  }

  router.get('/team-days', requirePerm(null, 'hrms', 'Attendance & Time', 'export'), async (req, res) => {
    const today = D.localDate();
    const range = req.query.from || req.query.to || req.query.month ? rangeOf(req.query) : { from: today, to: today };
    if (range.error) return res.status(400).json({ error: range.error });
    if (D.eachDay(range.from, range.to).length > 62) return res.status(400).json({ error: 'Pick a range of at most 62 days, or use the Monthly Summary.' });
    const cfg = await getConfig();
    const employees = await scopedActive(req);
    const { days } = await D.loadDays(prisma, { employees, from: range.from, to: range.to, cfg, preview: true });
    let rows = [];
    employees.forEach((e) => {
      days(e).forEach((d) => {
        if (['Upcoming', 'Not Joined'].includes(d.status)) return;
        const n = D.notesOf(d);
        rows.push({ employeeId: e.id, employeeCode: e.employeeCode, name: e.name, department: e.department, designation: e.designation, ...d, notes: n, noteText: n.map((k) => D.NOTE_LABEL[k]).join(' · ') });
      });
    });
    if (req.query.status) rows = rows.filter((r) => r.status === req.query.status);
    rows.sort((a, b) => b.date.localeCompare(a.date) || String(a.name).localeCompare(String(b.name)));
    if (req.query.format === 'csv' || req.query.format === 'xlsx') {
      return sendTable(res, req.query.format, `team-attendance-${range.from}_${range.to}`,
        ['Code', 'Name', 'Department', ...DAY_HEADERS], rows.map((r) => [r.employeeCode, r.name, r.department || '', ...dayCells(r)]), 'Team Attendance');
    }
    res.json({ ...range, employees: employees.length, rows });
  });

  // MONTHLY SUMMARY + MONTHLY REPORT in one (the old "Reports (Monthly)" tab
  // is merged in here): per person, the month's days by status — from the one
  // day rule (utils/attendanceDays.js) — plus attendance %, hours worked and
  // payroll's late half-day cuts. ?month=YYYY-MM, or ?from&to (up to a year),
  // e.g. the imported old-HRMS period, whose own summary is shown alongside.
  //
  // The people are those ON THE ROLLS during the period (D.rollOf): a person
  // who has since left is included for the months they worked, and their
  // days after leaving are not counted against them.
  router.get('/monthly-summary', requirePerm(null, 'hrms', 'Attendance & Time', 'export'), async (req, res) => {
    let month = null;
    let from;
    let to;
    if (req.query.from || req.query.to) {
      const r = rangeOf({ from: req.query.from, to: req.query.to });
      if (r.error) return res.status(400).json({ error: r.error });
      ({ from, to } = r);
      if (D.eachDay(from, to).length > 366) return res.status(400).json({ error: 'Pick a period of at most one year.' });
      if (from.slice(0, 7) === to.slice(0, 7) && from.endsWith('-01') && to === D.monthRange(from.slice(0, 7)).to) month = from.slice(0, 7);
    } else {
      month = req.query.month ? String(req.query.month) : D.localDate().slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM.' });
      ({ from, to } = D.monthRange(month));
    }
    const periodLabel = month ? D.monthLabel(month) : `${from} to ${to}`;
    const cfg = await getConfig();
    let all = (await prisma.employee.findMany({
      where: withoutSystemAccounts(employeeWhere(req.user)), orderBy: { name: 'asc' }, include: { user: { select: { status: true } } },
    })).filter((e) => employeeMatchesFilters(e, req.query));
    if (req.query.hrStatus) all = all.filter((e) => hrStatusOf(e.employmentStatus, e.user && e.user.status) === req.query.hrStatus);
    const roll = await D.rollOf(prisma, all);
    const employees = roll.employees.filter((e) => D.onRolls(e, from, to, roll.lastDayOf));
    const ids = employees.map((e) => e.id);
    const [{ days }, imported, periods, monthRecords, monthPunches] = await Promise.all([
      D.loadDays(prisma, { employees, from, to, cfg, lastDayOf: roll.lastDayOf, preview: true }),
      prisma.attendanceHistorySummary.findMany({ where: { employeeId: { in: ids }, periodFrom: from, periodTo: to } }),
      prisma.attendanceHistorySummary.groupBy({ by: ['periodFrom', 'periodTo'], _count: true }),
      // Payroll's late half-day cut is a per-month figure (attendanceMath.monthStats).
      month ? prisma.attendance.findMany({ where: { date: { startsWith: month }, employeeId: { in: ids } } }) : [],
      month ? prisma.attendancePunch.findMany({ where: { date: { startsWith: month }, employeeId: { in: ids } } }) : [],
    ]);
    const importedOf = new Map(imported.map((s) => [s.employeeId, s]));
    const rows = employees.map((e) => {
      const allRows = days(e);
      const dayRows = allRows.filter((d) => !['Upcoming', 'Not Joined', 'Left'].includes(d.status));
      const s = D.summarise(dayRows);
      // THE ONE TILE DEFINITION (the Biometric list, the Calendar and the dashboard read the same): Present (incl. late / early /
      // missing as notes) + Absent + Half day + On leave + Week off / Holiday = days. s (summarise) stays for payroll detail.
      const tiles = D.tallyPerson(allRows);
      const attended = s.present + s.late + s.missingCheckOut + s.earlyLogout;
      const hoursWorked = Math.round(dayRows.reduce((n, d) => n + (Number(d.hours) || 0), 0) * 10) / 10;
      const imp = importedOf.get(e.id) || null;
      return {
        employeeId: e.id, employeeCode: e.employeeCode, name: e.name, department: e.department, designation: e.designation,
        hrStatus: hrStatusOf(e.employmentStatus, e.user && e.user.status),
        lastDay: roll.lastDayOf.has(e.id) ? roll.lastDayOf.get(e.id) : null,
        tiles, equation: D.equationText(tiles),
        ...s,
        attended,
        // Days attended (Present + Late + Early Logout + Missing Check-Out, every
        // worked half at ½ — the present fractions) ÷ working days.
        attendancePct: s.workingDays ? Math.round((s.presentDays / s.workingDays) * 1000) / 10 : 0,
        hoursWorked,
        lateCut: month ? monthStats({
          month, cfg,
          records: monthRecords.filter((r) => r.employeeId === e.id),
          punches: monthPunches.filter((p) => p.employeeId === e.id),
          excusedDates: new Set(dayRows.filter((d) => d.lateExcused).map((d) => d.date)),
        }).halfDayCut : null,
        imported: imp ? {
          present: imp.present, halfDay: imp.halfDay, weekOffs: imp.weekOffs, publicHolidays: imp.publicHolidays,
          leaves: imp.leaves, payableDays: imp.payableDays, totalHours: imp.totalHours,
        } : null,
      };
    });
    const keys = ['workingDays', 'present', 'late', 'attended', 'halfDay', 'absent', 'onLeave', 'missingCheckIn', 'missingCheckOut', 'noRecord', 'noData', 'informed', 'weeklyOffs', 'holidays', 'lateArrivals', 'hoursWorked',
      'earlyLogout', 'earlyLogouts', 'halfDayHalfLeave', 'halfDayUnderReview', 'leaveUnderReview', 'halfLeaveAbsent', 'sandwichDays', 'presentDays', 'leaveDays', 'absentDays', 'pendingDays', 'paidDays'];
    const totals = Object.fromEntries(keys.map((k) => [k, Math.round(rows.reduce((n, r) => n + (r[k] || 0), 0) * 10) / 10]));
    totals.tiles = D.addTallies(rows.map((r) => r.tiles));
    totals.equation = D.equationText(totals.tiles);
    totals.lateCut = month ? rows.reduce((n, r) => n + (r.lateCut || 0), 0) : null;
    totals.attendancePct = totals.workingDays ? Math.round((totals.presentDays / totals.workingDays) * 1000) / 10 : 0;
    const impRows = rows.filter((r) => r.imported);
    const importedTotals = impRows.length ? Object.fromEntries(['present', 'halfDay', 'weekOffs', 'publicHolidays', 'leaves', 'payableDays']
      .map((k) => [k, Math.round(impRows.reduce((n, r) => n + (Number(r.imported[k]) || 0), 0) * 10) / 10])) : null;

    if (req.query.format === 'csv' || req.query.format === 'xlsx') {
      await logAudit({ userId: req.user.id, action: `Attendance monthly summary exported (${req.query.format.toUpperCase()})`, entity: 'Attendance', toValue: `${periodLabel} · ${rows.length} employee(s)` });
      const withImp = !!importedTotals;
      const headers = ['Period', 'Code', 'Name', 'Department', 'Designation', 'Employee Status', 'Left on (last attendance)',
        'Days on the rolls', 'Present (incl. late / early / missing)', 'Absent', 'Half day', 'On leave', 'Week off / Holiday', 'No device data', 'Not checked in yet', 'Working days',
        'of Present: Late', 'of Present: Early logout', 'of Present: Missing check-in', 'of Present: Missing check-out', 'Days with a punch', 'Punches received', 'Adds up to',
        'Payroll detail: Working Days', 'Payroll detail: Present (status only)', 'Payroll detail: Late', 'Payroll detail: Attended',
        'Payroll detail: Half Day', 'Payroll detail: Absent', 'Payroll detail: On Leave', 'Payroll detail: Missing Check-In', 'Payroll detail: Missing Check-Out', 'No device data (status)', 'Week off (status)', 'Holidays (status)', 'Late Arrivals (payroll)',
        'Hours Worked', 'Attendance %', 'Early Logout', 'Half Day + Half Leave', 'Under Review', 'Paid Days', 'Unpaid (Absent) Days', ...(month ? ['Late Half-day Cut (payroll)'] : []),
        ...(withImp ? ['Old HRMS: Present', 'Old HRMS: Half Day', 'Old HRMS: Week-offs', 'Old HRMS: Public Holidays', 'Old HRMS: Leaves', 'Old HRMS: Payable Days', 'Old HRMS: Total Hours'] : [])];
      const tl = (r) => [r.tiles.days, r.tiles.present, r.tiles.absent, r.tiles.halfDay, r.tiles.onLeave, r.tiles.offDay, r.tiles.noRecord, r.tiles.notYet, r.tiles.workingDays,
        r.tiles.late, r.tiles.earlyLogout, r.tiles.missingCheckIn, r.tiles.missingCheckOut, r.tiles.punchDays, r.tiles.punchRows, r.equation];
      const line = (r) => [periodLabel, r.employeeCode, r.name, r.department || '', r.designation || '', r.hrStatus, r.lastDay || '', ...tl(r), r.workingDays, r.present, r.late, r.attended,
        r.halfDay, r.absent, r.onLeave, r.missingCheckIn, r.missingCheckOut, r.noData, r.weeklyOffs, r.holidays, r.lateArrivals, r.hoursWorked, r.attendancePct,
        r.earlyLogout, r.halfDayHalfLeave, r.halfDayUnderReview + r.leaveUnderReview, r.paidDays, r.absentDays,
        ...(month ? [r.lateCut] : []),
        ...(withImp ? (r.imported ? [r.imported.present, r.imported.halfDay, r.imported.weekOffs, r.imported.publicHolidays, r.imported.leaves, r.imported.payableDays, r.imported.totalHours || ''] : ['', '', '', '', '', '', '']) : [])];
      const data = rows.map(line);
      data.push([]);
      data.push(['TOTAL', '', `${rows.length} employee(s)`, '', '', '', '', ...tl({ tiles: totals.tiles, equation: totals.equation }), totals.workingDays, totals.present, totals.late, totals.attended, totals.halfDay, totals.absent,
        totals.onLeave, totals.missingCheckIn, totals.missingCheckOut, totals.noData, totals.weeklyOffs, totals.holidays, totals.lateArrivals, totals.hoursWorked, totals.attendancePct,
        totals.earlyLogout, totals.halfDayHalfLeave, totals.halfDayUnderReview + totals.leaveUnderReview, totals.paidDays, totals.absentDays,
        ...(month ? [totals.lateCut] : []),
        ...(withImp ? [importedTotals.present, importedTotals.halfDay, importedTotals.weekOffs, importedTotals.publicHolidays, importedTotals.leaves, importedTotals.payableDays, ''] : [])]);
      return sendTable(res, req.query.format, `attendance-summary-${month || `${from}_${to}`}`, headers, data, 'Monthly Summary');
    }
    res.json({
      month, monthLabel: periodLabel, from, to, missingCheckInRule: cfg.missingCheckInRule,
      freeLateArrivalsPerMonth: cfg.freeLateArrivalsPerMonth,
      importedPeriods: periods.map((p) => ({ from: p.periodFrom, to: p.periodTo, employees: p._count })),
      importedTotals,
      earlyStarts: roll.earlyStarts.filter((x) => ids.includes(x.employeeId)),
      rows, totals,
    });
  });

  // ---- geofence + face threshold (Super Admin) -----------------------------
  router.get('/geofence', async (req, res) => {
    if (!(await isSuperAdmin(req.user))) return res.status(403).json({ error: 'Only Super Admin configures the check-in geofence.' });
    const cfg = await getConfig();
    const o = await fence.loadOffices(cfg);
    res.json({
      geofenceEnabled: cfg.geofenceEnabled, officeLatitude: cfg.officeLatitude, officeLongitude: cfg.officeLongitude,
      geofenceRadiusM: cfg.geofenceRadiusM, faceMatchThreshold: cfg.faceMatchThreshold,
      officeName: o.mainName, otherOffices: o.offices.filter((x) => !x.main), minPunchGapSec: await guard.minGapSec(),
      checkin: await CS.load(),
    });
  });

  router.put('/geofence', async (req, res) => {
    if (!(await isSuperAdmin(req.user))) return res.status(403).json({ error: 'Only Super Admin configures the check-in geofence.' });
    const b = req.body || {};
    const cfg = await getConfig();
    const data = {};
    if (b.geofenceEnabled !== undefined) data.geofenceEnabled = !!b.geofenceEnabled;
    if (b.officeLatitude !== undefined) {
      const v = b.officeLatitude === null || b.officeLatitude === '' ? null : Number(b.officeLatitude);
      if (v !== null && !(Number.isFinite(v) && Math.abs(v) <= 90)) return res.status(400).json({ error: 'Latitude must be between -90 and 90.' });
      data.officeLatitude = v;
    }
    if (b.officeLongitude !== undefined) {
      const v = b.officeLongitude === null || b.officeLongitude === '' ? null : Number(b.officeLongitude);
      if (v !== null && !(Number.isFinite(v) && Math.abs(v) <= 180)) return res.status(400).json({ error: 'Longitude must be between -180 and 180.' });
      data.officeLongitude = v;
    }
    if (b.geofenceRadiusM !== undefined) {
      const v = Math.round(Number(b.geofenceRadiusM));
      if (!(v >= 20 && v <= 100000)) return res.status(400).json({ error: 'Radius must be between 20 m and 100 km.' });
      data.geofenceRadiusM = v;
    }
    if (b.faceMatchThreshold !== undefined) {
      const v = Number(b.faceMatchThreshold);
      if (!(v >= 0.3 && v <= 0.6)) return res.status(400).json({ error: 'Face-match threshold must be between 0.30 (strictest) and 0.60.' });
      data.faceMatchThreshold = v;
    }
    const next = { ...cfg, ...data };
    if (next.geofenceEnabled && (next.officeLatitude == null || next.officeLongitude == null)) {
      return res.status(400).json({ error: 'Set the office latitude and longitude before turning the geofence on.' });
    }
    const updated = await prisma.hrConfig.update({ where: { id: cfg.id }, data });
    // Office name, the other offices and the minimum gap live in the small settings store (no schema change).
    const putSetting = (key, value) => prisma.appSetting.upsert({
      where: { key }, create: { key, value: JSON.stringify(value), updatedById: req.user.id }, update: { value: JSON.stringify(value), updatedById: req.user.id },
    });
    if (b.officeName !== undefined) await putSetting('attendance.officeName', String(b.officeName || '').trim().slice(0, 60));
    if (b.otherOffices !== undefined) {
      const rows = Array.isArray(b.otherOffices) ? b.otherOffices : [];
      const clean = fence.cleanOffices(rows);
      if (clean.length !== rows.length) return res.status(400).json({ error: 'Each other office needs a name, a latitude between -90 and 90 and a longitude between -180 and 180.' });
      await putSetting('attendance.offices', clean);
    }
    if (b.minPunchGapSec !== undefined) {
      const g = Math.round(Number(b.minPunchGapSec));
      if (!(g >= 0 && g <= 3600)) return res.status(400).json({ error: 'The minimum gap must be between 0 and 3600 seconds.' });
      await putSetting('attendance.minPunchGapSec', g);
      guard.resetGapCache();
    }
    if (b.checkin && typeof b.checkin === 'object') {
      const c = b.checkin;
      if (c.faceMode !== undefined && !CS.MODES.includes(c.faceMode)) return res.status(400).json({ error: 'Face check must be Required, Strict, Easy or Record anyway.' });
      const saved = await CS.save({ faceMode: c.faceMode, accuracyCounts: c.accuracyCounts, accuracyCapM: c.accuracyCapM, noLocation: c.noLocation, selfieRetentionDays: c.selfieRetentionDays, livenessCheck: c.livenessCheck }, req.user.id);
      await logAudit({ userId: req.user.id, action: 'Web check-in settings updated', entity: 'AppSetting', entityId: 'attendance.checkin', toValue: JSON.stringify(saved) });
    }
    await logAudit({
      userId: req.user.id, action: 'Check-in geofence updated', entity: 'HrConfig', entityId: cfg.id,
      toValue: `${updated.geofenceEnabled ? 'on' : 'off'} · ${updated.officeLatitude ?? '—'},${updated.officeLongitude ?? '—'} · ${updated.geofenceRadiusM} m · threshold ${updated.faceMatchThreshold}`,
    });
    const o = await fence.loadOffices(updated);
    res.json({
      geofenceEnabled: updated.geofenceEnabled, officeLatitude: updated.officeLatitude, officeLongitude: updated.officeLongitude,
      geofenceRadiusM: updated.geofenceRadiusM, faceMatchThreshold: updated.faceMatchThreshold,
      officeName: o.mainName, otherOffices: o.offices.filter((x) => !x.main), minPunchGapSec: await guard.minGapSec(),
      checkin: await CS.load(),
    });
  });

  // ---- refused attempts: who tried to check in / out from outside the area, and how far away.
  // For HR (people in their scope): 'Tried to check in 340 m away at 09:12'.
  router.get('/refused-attempts', requirePerm(null, 'hrms', 'Attendance & Time', 'export'), async (req, res) => {
    const r = rangeOf(req.query);
    if (r.error) return res.status(400).json({ error: r.error });
    const rows = await prisma.auditLog.findMany({
      where: { action: { startsWith: 'Check-' }, entity: 'Employee', createdAt: { gte: new Date(`${r.from}T00:00:00`), lte: new Date(`${r.to}T23:59:59`) } },
      orderBy: { createdAt: 'desc' }, take: 500,
    });
    const ids = [...new Set(rows.map((x) => x.entityId).filter(Boolean))];
    const emps = await prisma.employee.findMany({ where: { id: { in: ids } } });
    const byId = new Map(emps.map((e) => [e.id, e]));
    const out = [];
    rows.forEach((x) => {
      if (!/refused: outside geofence/.test(x.action)) return;
      const e = byId.get(x.entityId);
      if (!e || !employeeInScope(req.user, e)) return;
      let d = {};
      try { d = JSON.parse(x.fromValue || '{}'); } catch { d = {}; }
      out.push({
        id: x.id, employeeId: e.id, employeeCode: e.employeeCode, name: e.name, department: e.department || null,
        date: d.date || D.localDate(x.createdAt), time: d.time || D.localTime(x.createdAt), direction: d.direction || (/check-in/.test(x.action) ? 'In' : 'Out'),
        distanceM: d.distanceM ?? null, office: d.office || null, radiusM: d.radiusM ?? null, accuracyM: d.accuracyM ?? null, text: x.toValue,
      });
    });
    res.json({ from: r.from, to: r.to, rows: out });
  });

  // ---- the screen asks the server to judge a location BEFORE the camera opens; an outside answer is kept for HR too
  // (the screen used to refuse by itself, so HR never saw those attempts). Nothing is recorded as a punch here.
  router.post('/checkin/location-check', async (req, res) => {
    const own = await ownEmployee(req);
    if (!own) return res.status(404).json({ error: 'No employee record is linked to this login.' });
    const b = req.body || {};
    const lat = num(b.latitude); const lng = num(b.longitude); const acc = num(b.accuracy);
    if (!(Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) return res.status(400).json({ error: 'Your location is required.', code: 'LOCATION' });
    const direction = b.direction === 'Out' ? 'Out' : 'In';
    const cs = await CS.load();
    const accuracy = Number.isFinite(acc) && acc >= 0 ? acc : null;
    const info = fence.check(await fence.loadOffices(await getConfig()), lat, lng, accuracy, { accuracyCounts: cs.accuracyCounts, accuracyCapM: cs.accuracyCapM });
    if (!info.inside) {
      await logAudit({
        userId: req.user.id, action: `Check-${direction === 'In' ? 'in' : 'out'} refused: outside geofence`, entity: 'Employee', entityId: own.id,
        fromValue: JSON.stringify({ distanceM: info.distance, office: info.office.name, radiusM: info.radiusM, accuracyM: accuracy, direction, date: D.localDate(), time: D.localTime(), latitude: lat, longitude: lng }),
        toValue: `Tried to ${direction === 'In' ? 'check in' : 'check out'} ${fence.distanceText(info.distance)} away at ${D.localTime()} (${info.office.name}, allowed ${fence.distanceText(info.radiusM)})`,
      });
    }
    return res.json({ inside: info.inside, distanceM: info.distance, radiusM: info.radiusM, office: info.office, others: info.others, accuracyM: accuracy, lowAccuracy: info.lowAccuracy, weakGps: info.weakGps, swapped: info.swapped, message: info.inside ? '' : fence.outsideMessage(info, direction) });
  });

  faceReview.register(router);
};

module.exports.haversine = haversine;
module.exports.geofenceCheck = geofenceCheck;
