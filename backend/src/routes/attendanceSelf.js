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
const { employeeMatchesFilters, monthStats } = require('../utils/attendanceMath');
const { hrStatusOf } = require('../utils/hrStatus');
const { toCsv, toXlsx } = require('../utils/tabularExport');
const { notifyDataIo } = require('../utils/dataIoNotify');
const leaveCharge = require('../utils/leaveCharge');

const WEB_METHODS = ['GPS', 'Face'];
const FAILED = 'Face verification failed. Please try again.';
const NO_PHOTO = 'Add your photo in My Employee Profile first';
const EXITED = ['Relieved', 'Exited'];
const FRAME_MAX_BYTES = 700 * 1024;

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

const DAY_HEADERS = ['Date', 'Check-In', 'Check-Out', 'Total Hours', 'Status', 'Early Logout', 'Present', 'Leave', 'Absent (unpaid)', 'Paid', 'Method', 'Location Status', 'Verification', 'Regularization', 'Note', 'Result', 'Reason'];
const dayCells = (d) => [d.date, d.checkIn || '', d.checkOut || '', d.hours ?? '', d.status, d.earlyLogout ? 'Yes' : '', d.present ?? '', d.leave ?? '', d.absent ?? '', d.paid ?? '', d.method || '', d.locationStatus || '', d.verification || '', d.regularization || '', d.note || '', d.kpi ? (D.KPI_LABEL[d.kpi] || d.kpi) : '', d.reason || ''];

module.exports = function registerSelfAttendance(router, { getConfig, methodsOf, CHECKIN_ASSIGNABLE, isSuperAdmin, ownEmployee }) {
  // ---- readiness ------------------------------------------------------------
  router.get('/checkin/status', async (req, res) => {
    const own = await ownEmployee(req);
    if (!own) return res.json({ hasEmployee: false, methods: [], hasPhoto: false });
    const cfg = await getConfig();
    const photo = await latestPhoto(own.id);
    const today = D.localDate();
    const punches = await prisma.attendancePunch.findMany({ where: { employeeId: own.id, date: today }, orderBy: { time: 'asc' } });
    res.json({
      hasEmployee: true,
      employeeId: own.id,
      methods: methodsOf(own).map((k) => ({ key: k, label: CHECKIN_ASSIGNABLE[k], web: WEB_METHODS.includes(k) })),
      hasPhoto: !!photo,
      geofence: { enabled: !!(cfg.geofenceEnabled && cfg.officeLatitude != null), radiusM: cfg.geofenceRadiusM },
      today,
      todayPunches: punches.map((p) => ({ id: p.id, time: p.time, direction: p.direction, method: p.method, verificationStatus: p.verificationStatus })),
    });
  });

  // ---- the liveness challenge ---------------------------------------------
  router.get('/face/challenge', async (req, res) => {
    const own = await ownEmployee(req);
    if (!own) return res.status(404).json({ error: 'No employee record is linked to this login, so there is no attendance to record.' });
    const methods = methodsOf(own).filter((k) => WEB_METHODS.includes(k));
    if (!methods.length) return res.status(403).json({ error: 'Web / mobile check-in is not assigned to you. Super Admin assigns check-in methods.' });
    if (!(await latestPhoto(own.id))) return res.status(400).json({ error: NO_PHOTO, code: 'NO_PHOTO' });
    const direction = req.query.direction === 'Out' ? 'Out' : 'In';
    // Load the model while the person is getting ready.
    face.warm().catch(() => {});
    res.json(face.issueChallenge(req.user.id, direction));
  });

  // ---- the verified punch ---------------------------------------------------
  router.post('/punches/verified', async (req, res) => {
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
    if (!own) return res.status(404).json({ error: 'No employee record is linked to this login, so there is no attendance to record.' });
    const allowed = methodsOf(own).filter((k) => WEB_METHODS.includes(k));
    const key = WEB_METHODS.includes(f.method) ? f.method : allowed[0];
    if (!key || !allowed.includes(key)) return res.status(403).json({ error: 'Web / mobile check-in is not assigned to you. Super Admin assigns check-in methods.' });

    // Location — required for check-in AND check-out.
    const lat = num(f.latitude); const lng = num(f.longitude); const acc = num(f.accuracy);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) {
      return res.status(400).json({ error: 'Your location is required. Allow location access for this site and try again.', code: 'LOCATION' });
    }
    const accuracy = Number.isFinite(acc) && acc >= 0 ? acc : null;
    const locTs = f.locationAt ? new Date(Number(f.locationAt) || f.locationAt) : null;
    const locationAt = locTs && !Number.isNaN(locTs.getTime()) ? locTs : new Date();
    if (Math.abs(Date.now() - locationAt.getTime()) > 10 * 60 * 1000) {
      return res.status(400).json({ error: 'That location reading is too old. Try again.', code: 'LOCATION' });
    }
    const cfg = await getConfig();
    const fence = geofenceCheck(cfg, lat, lng, accuracy);
    if (!fence.inside) {
      await logAudit({ userId: req.user.id, action: `Check-${challenge.direction === 'In' ? 'in' : 'out'} refused: outside geofence`, entity: 'Employee', entityId: own.id, toValue: `${fence.distance} m from office (allowed ${cfg.geofenceRadiusM} m)` });
      return res.status(403).json({ error: `You are outside the permitted check-in area — about ${fence.distance} m from the office (allowed ${cfg.geofenceRadiusM} m).`, code: 'GEOFENCE', distanceM: fence.distance });
    }

    // Registered photo.
    const photo = await latestPhoto(own.id);
    const photoPath = photo && attachments.resolveStored(photo.file);
    if (!photoPath) return res.status(400).json({ error: NO_PHOTO, code: 'NO_PHOTO' });

    // Frames: JPEG data URLs from the camera canvas.
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
    if (frames.length < face.MIN_FRAMES) return res.status(400).json({ error: 'Not enough camera frames were captured. Try again.', code: 'FRAMES' });

    let decision;
    try {
      const photoFaces = await face.analysePhoto(`${photo.id}:${photo.file}`, fs.readFileSync(photoPath));
      const { results, diffs } = await face.analyseFrames(frames);
      decision = face.decide({ photoFaces, frames: results, diffs, action: challenge.action, threshold: cfg.faceMatchThreshold ?? 0.45 });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[face] verification error', err);
      return res.status(503).json({ error: 'Face verification is unavailable right now. Try again in a minute.', code: 'ENGINE' });
    }

    if (!decision.ok) {
      await logAudit({
        userId: req.user.id, action: `Face verification failed (check-${challenge.direction === 'In' ? 'in' : 'out'})`, entity: 'Employee', entityId: own.id,
        toValue: `${decision.code}${decision.distance != null ? ` · distance ${decision.distance} (threshold ${decision.threshold})` : ''}`,
      });
      if (decision.code === 'NO_FACE_IN_PHOTO') {
        return res.status(400).json({ error: 'No face could be found in your registered photo. Upload a clear, front-facing photo in My Employee Profile.', code: decision.code });
      }
      return res.status(422).json({ error: FAILED, reason: decision.reason, code: decision.code, score: decision.score ?? null, liveness: decision.liveness || null });
    }

    // Verified: keep the best-matching live frame as the punch's image.
    let stored;
    try {
      stored = attachments.store({ filename: 'live-capture.jpg', contentType: 'image/jpeg', data: frames[decision.bestFrame] });
    } catch (err) {
      return res.status(500).json({ error: 'Could not store the capture. Try again.' });
    }
    const ua = String(req.headers['user-agent'] || '').slice(0, 400);
    let punch;
    try {
      punch = await prisma.attendancePunch.create({
        data: {
          employeeId: own.id,
          date: D.localDate(),
          time: D.localTime(),
          direction: challenge.direction,
          method: CHECKIN_ASSIGNABLE[key],
          location: `${lat.toFixed(5)},${lng.toFixed(5)}${accuracy != null ? ` (±${Math.round(accuracy)} m)` : ''}`,
          source: deviceSource(ua),
          latitude: lat,
          longitude: lng,
          accuracyM: accuracy,
          locationAt,
          locationStatus: fence.status,
          distanceM: fence.distance,
          imageFile: stored.billFile,
          verificationStatus: 'Verified',
          verificationScore: decision.score,
          livenessStatus: `Passed (${challenge.action === 'turn' ? 'head turn' : 'blink'})`,
          userAgent: ua,
        },
      });
    } catch (err) {
      attachments.remove(stored.billFile);
      throw err;
    }
    await D.applyPunchToDay(prisma, punch, cfg);
    // Items 4/6: working on a leave day changes what the leave uses.
    leaveCharge.afterAttendanceChange(own.id, punch.date);
    await logAudit({
      userId: req.user.id, action: `Punch ${punch.direction} recorded (face verified)`, entity: 'AttendancePunch', entityId: punch.id,
      toValue: `${punch.date} ${punch.time} · score ${decision.score} · ${fence.status}`,
    });
    const { imageFile, userAgent, ...safe } = punch;
    res.status(201).json({
      punch: safe,
      verification: { status: 'Verified', score: decision.score, distance: decision.distance, threshold: decision.threshold, liveness: decision.liveness },
    });
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
    const rows = days(own).filter((d) => !['Upcoming', 'Not Joined'].includes(d.status)).reverse();
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
        rows.push({ employeeId: e.id, employeeCode: e.employeeCode, name: e.name, department: e.department, designation: e.designation, ...d });
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
      const dayRows = days(e).filter((d) => !['Upcoming', 'Not Joined', 'Left'].includes(d.status));
      const s = D.summarise(dayRows);
      const attended = s.present + s.late + s.missingCheckOut + s.earlyLogout;
      const hoursWorked = Math.round(dayRows.reduce((n, d) => n + (Number(d.hours) || 0), 0) * 10) / 10;
      const imp = importedOf.get(e.id) || null;
      return {
        employeeId: e.id, employeeCode: e.employeeCode, name: e.name, department: e.department, designation: e.designation,
        hrStatus: hrStatusOf(e.employmentStatus, e.user && e.user.status),
        lastDay: roll.lastDayOf.has(e.id) ? roll.lastDayOf.get(e.id) : null,
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
    totals.lateCut = month ? rows.reduce((n, r) => n + (r.lateCut || 0), 0) : null;
    totals.attendancePct = totals.workingDays ? Math.round((totals.presentDays / totals.workingDays) * 1000) / 10 : 0;
    const impRows = rows.filter((r) => r.imported);
    const importedTotals = impRows.length ? Object.fromEntries(['present', 'halfDay', 'weekOffs', 'publicHolidays', 'leaves', 'payableDays']
      .map((k) => [k, Math.round(impRows.reduce((n, r) => n + (Number(r.imported[k]) || 0), 0) * 10) / 10])) : null;

    if (req.query.format === 'csv' || req.query.format === 'xlsx') {
      await logAudit({ userId: req.user.id, action: `Attendance monthly summary exported (${req.query.format.toUpperCase()})`, entity: 'Attendance', toValue: `${periodLabel} · ${rows.length} employee(s)` });
      const withImp = !!importedTotals;
      const headers = ['Period', 'Code', 'Name', 'Department', 'Designation', 'Employee Status', 'Left on (last attendance)', 'Working Days', 'Present', 'Late', 'Attended',
        'Half Day', 'Absent', 'On Leave', 'Missing Check-In', 'Missing Check-Out', 'No device data', 'Week off', 'Holidays', 'Late Arrivals',
        'Hours Worked', 'Attendance %', 'Early Logout', 'Half Day + Half Leave', 'Under Review', 'Paid Days', 'Unpaid (Absent) Days', ...(month ? ['Late Half-day Cut (payroll)'] : []),
        ...(withImp ? ['Old HRMS: Present', 'Old HRMS: Half Day', 'Old HRMS: Week-offs', 'Old HRMS: Public Holidays', 'Old HRMS: Leaves', 'Old HRMS: Payable Days', 'Old HRMS: Total Hours'] : [])];
      const line = (r) => [periodLabel, r.employeeCode, r.name, r.department || '', r.designation || '', r.hrStatus, r.lastDay || '', r.workingDays, r.present, r.late, r.attended,
        r.halfDay, r.absent, r.onLeave, r.missingCheckIn, r.missingCheckOut, r.noData, r.weeklyOffs, r.holidays, r.lateArrivals, r.hoursWorked, r.attendancePct,
        r.earlyLogout, r.halfDayHalfLeave, r.halfDayUnderReview + r.leaveUnderReview, r.paidDays, r.absentDays,
        ...(month ? [r.lateCut] : []),
        ...(withImp ? (r.imported ? [r.imported.present, r.imported.halfDay, r.imported.weekOffs, r.imported.publicHolidays, r.imported.leaves, r.imported.payableDays, r.imported.totalHours || ''] : ['', '', '', '', '', '', '']) : [])];
      const data = rows.map(line);
      data.push([]);
      data.push(['TOTAL', '', `${rows.length} employee(s)`, '', '', '', '', totals.workingDays, totals.present, totals.late, totals.attended, totals.halfDay, totals.absent,
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
    res.json({
      geofenceEnabled: cfg.geofenceEnabled, officeLatitude: cfg.officeLatitude, officeLongitude: cfg.officeLongitude,
      geofenceRadiusM: cfg.geofenceRadiusM, faceMatchThreshold: cfg.faceMatchThreshold,
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
    await logAudit({
      userId: req.user.id, action: 'Check-in geofence updated', entity: 'HrConfig', entityId: cfg.id,
      toValue: `${updated.geofenceEnabled ? 'on' : 'off'} · ${updated.officeLatitude ?? '—'},${updated.officeLongitude ?? '—'} · ${updated.geofenceRadiusM} m · threshold ${updated.faceMatchThreshold}`,
    });
    res.json({
      geofenceEnabled: updated.geofenceEnabled, officeLatitude: updated.officeLatitude, officeLongitude: updated.officeLongitude,
      geofenceRadiusM: updated.geofenceRadiusM, faceMatchThreshold: updated.faceMatchThreshold,
    });
  });
};

module.exports.haversine = haversine;
module.exports.geofenceCheck = geofenceCheck;
