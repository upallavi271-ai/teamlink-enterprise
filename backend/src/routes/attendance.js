const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { employeeWhere, employeeRecordWhere, employeeInScope, OUT_OF_SCOPE } = require('../utils/scope');
const {
  CHECKIN_METHODS, DIRECTIONS, toMinutes, isLate, sortedPunches, firstIn, lastOut,
  calendarDays, businessDays, monthLabel, monthStats, employeeMatchesFilters,
} = require('../utils/attendanceMath');

const router = express.Router();
router.use(requireAuth);


async function getConfig() {
  let config = await prisma.hrConfig.findFirst();
  if (!config) config = await prisma.hrConfig.create({ data: {} });
  return config;
}

// Employees this request may see. DEPARTMENT-SCOPED: the old comment here said
// department scoping "lives in employees.js and is intentionally not duplicated
// here — attendance is read-only reporting", which meant a Medical TL read every
// IT employee's attendance, punch log and monthly report. Read-only is still
// access. utils/scope.js employeeWhere() is now the one rule for all of it, so
// the dashboard, the biometric view, the punch log and the report are all scoped
// by the same fragment that scopes the employee list itself.
async function scopedEmployees(req, q = {}) {
  const employees = await prisma.employee.findMany({
    where: employeeWhere(req.user), orderBy: { name: 'asc' },
  });
  return employees.filter((e) => employeeMatchesFilters(e, q));
}

// A requested employeeId is honoured only when it is INSIDE the caller's scope;
// anything else resolves to "no such employee for you" rather than leaking a row.
async function resolveEmployeeId(req, requestedEmployeeId) {
  if (req.user.caps.hrmsSelfOnly) {
    const own = await prisma.employee.findUnique({ where: { userId: req.user.id } });
    return own ? own.id : null;
  }
  if (!requestedEmployeeId) return null;
  const employee = await prisma.employee.findUnique({ where: { id: requestedEmployeeId } });
  return employee && employeeInScope(req.user, employee) ? employee.id : '__out_of_scope__';
}

router.get('/', async (req, res) => {
  const where = { ...employeeRecordWhere(req.user) };
  const employeeId = await resolveEmployeeId(req, req.query.employeeId);
  if (req.user.caps.hrmsSelfOnly && !employeeId) return res.json([]);
  if (employeeId) where.employeeId = employeeId;
  if (req.query.date) where.date = req.query.date;
  const attendance = await prisma.attendance.findMany({ where, include: { employee: true }, orderBy: { date: 'desc' } });
  res.json(attendance);
});

// Employees mark their own attendance; HR/managers can mark for anyone.
router.post('/', async (req, res) => {
  const { date, status, checkIn, checkOut } = req.body;
  let employeeId = req.body.employeeId;
  if (req.user.caps.hrmsSelfOnly) {
    const own = await prisma.employee.findUnique({ where: { userId: req.user.id } });
    if (!own) return res.status(404).json({ error: 'No employee record linked to this account' });
    employeeId = own.id;
  } else if (!req.user.caps.hrmsManage) {
    return res.status(403).json({ error: "This isn't included in your role's permissions" });
  }
  if (!employeeId || !date || !status) return res.status(400).json({ error: 'employeeId, date and status are required' });
  if (!req.user.caps.hrmsSelfOnly) {
    const target = await prisma.employee.findUnique({ where: { id: employeeId } });
    if (!target) return res.status(404).json({ error: 'Employee not found' });
    if (!employeeInScope(req.user, target)) return res.status(403).json(OUT_OF_SCOPE);
  }

  const attendance = await prisma.attendance.upsert({
    where: { employeeId_date: { employeeId, date } },
    update: { status, checkIn, checkOut },
    create: { employeeId, date, status, checkIn, checkOut },
  });
  await logAudit({ userId: req.user.id, action: 'Attendance marked', entity: 'Attendance', entityId: attendance.id, toValue: status });
  res.status(201).json(attendance);
});

// ---- Regularization requests (correcting a missed/incorrect punch after the fact) ----

router.get('/regularizations', async (req, res) => {
  const where = { ...employeeRecordWhere(req.user) };
  const employeeId = await resolveEmployeeId(req, req.query.employeeId);
  if (req.user.caps.hrmsSelfOnly && !employeeId) return res.json([]);
  if (employeeId) where.employeeId = employeeId;
  if (req.query.status) where.status = req.query.status;
  const regularizations = await prisma.attendanceRegularization.findMany({ where, include: { employee: true }, orderBy: { createdAt: 'desc' } });
  res.json(regularizations);
});

router.post('/regularizations', async (req, res) => {
  const { date, requestedCheckIn, requestedCheckOut, reason } = req.body;
  const own = await prisma.employee.findUnique({ where: { userId: req.user.id } });
  if (!own) return res.status(404).json({ error: 'No employee record linked to this account' });
  if (!date) return res.status(400).json({ error: 'date is required' });
  const regularization = await prisma.attendanceRegularization.create({ data: { employeeId: own.id, date, requestedCheckIn, requestedCheckOut, reason } });
  await logAudit({ userId: req.user.id, action: 'Attendance regularization requested', entity: 'AttendanceRegularization', entityId: regularization.id });
  res.status(201).json(regularization);
});

router.patch('/regularizations/:id/decision', requirePerm(null, 'hrms', 'Attendance & Time', 'approve'), async (req, res) => {
  const { status } = req.body; // Approved | Rejected
  if (!['Approved', 'Rejected'].includes(status)) return res.status(400).json({ error: 'status must be Approved or Rejected' });
  const existing = await prisma.attendanceRegularization.findUnique({
    where: { id: req.params.id }, include: { employee: true },
  });
  if (!existing) return res.status(404).json({ error: 'Request not found' });
  if (!employeeInScope(req.user, existing.employee)) return res.status(403).json(OUT_OF_SCOPE);
  const regularization = await prisma.attendanceRegularization.update({ where: { id: req.params.id }, data: { status, decidedAt: new Date() } });
  if (status === 'Approved') {
    await prisma.attendance.upsert({
      where: { employeeId_date: { employeeId: existing.employeeId, date: existing.date } },
      update: { checkIn: existing.requestedCheckIn || undefined, checkOut: existing.requestedCheckOut || undefined, status: 'Present' },
      create: { employeeId: existing.employeeId, date: existing.date, status: 'Present', checkIn: existing.requestedCheckIn, checkOut: existing.requestedCheckOut },
    });
  }
  await logAudit({ userId: req.user.id, action: 'Regularization ' + status.toLowerCase(), entity: 'AttendanceRegularization', entityId: regularization.id, toValue: status });
  res.json(regularization);
});

// ---- Attendance policy (grace time, half/full day thresholds) ----

router.get('/policy', async (req, res) => {
  let config = await prisma.hrConfig.findFirst();
  if (!config) config = await prisma.hrConfig.create({ data: {} });
  res.json(config);
});

router.put('/policy', requirePerm(null, 'hrms', 'Attendance & Time', 'configure'), async (req, res) => {
  const { graceTimeMinutes, graceTime, halfDayHours, fullDayHours, freeLateArrivalsPerMonth } = req.body;
  const config = await getConfig();
  if (graceTime != null && toMinutes(graceTime) == null) {
    return res.status(400).json({ error: 'graceTime must be a 24-hour HH:MM clock time (e.g. 09:30)' });
  }
  const updated = await prisma.hrConfig.update({
    where: { id: config.id },
    data: {
      graceTimeMinutes: graceTimeMinutes != null ? Number(graceTimeMinutes) : undefined,
      graceTime: graceTime != null ? graceTime : undefined,
      halfDayHours: halfDayHours != null ? Number(halfDayHours) : undefined,
      fullDayHours: fullDayHours != null ? Number(fullDayHours) : undefined,
      freeLateArrivalsPerMonth: freeLateArrivalsPerMonth != null ? Number(freeLateArrivalsPerMonth) : undefined,
    },
  });
  await logAudit({ userId: req.user.id, action: 'Attendance policy updated', entity: 'HrConfig', entityId: updated.id });
  res.json(updated);
});

// ---- Device punches --------------------------------------------------------

router.get('/punches', async (req, res) => {
  const where = {};
  const employeeId = await resolveEmployeeId(req, req.query.employeeId);
  if (req.user.caps.hrmsSelfOnly && !employeeId) return res.json([]);
  if (employeeId) where.employeeId = employeeId;
  if (req.query.date) where.date = req.query.date;
  else if (req.query.from || req.query.to) {
    where.date = {};
    if (req.query.from) where.date.gte = req.query.from;
    if (req.query.to) where.date.lte = req.query.to;
  }
  const punches = await prisma.attendancePunch.findMany({ where, include: { employee: true }, orderBy: [{ date: 'desc' }, { time: 'desc' }] });
  res.json(punches);
});

// Record a punch. Employees punch for themselves; HR can punch on anyone's behalf
// (e.g. entering a reading off an offline biometric device).
router.post('/punches', async (req, res) => {
  const { date, time, direction, method, location } = req.body;
  let employeeId = req.body.employeeId;
  if (req.user.caps.hrmsSelfOnly) {
    const own = await prisma.employee.findUnique({ where: { userId: req.user.id } });
    if (!own) return res.status(404).json({ error: 'No employee record linked to this account' });
    employeeId = own.id;
  } else if (!req.user.caps.hrmsManage) {
    return res.status(403).json({ error: "This isn't included in your role's permissions" });
  }
  if (!employeeId) return res.status(400).json({ error: 'employeeId is required' });
  const punchDate = date || new Date().toISOString().slice(0, 10);
  const punchTime = time || new Date().toTimeString().slice(0, 5);
  if (toMinutes(punchTime) == null) return res.status(400).json({ error: 'time must be a 24-hour HH:MM clock time' });
  if (direction && !DIRECTIONS.includes(direction)) return res.status(400).json({ error: 'direction must be In or Out' });

  const punch = await prisma.attendancePunch.create({
    data: { employeeId, date: punchDate, time: punchTime, direction: direction || 'In', method: method || 'Web Check-in', location },
  });

  // First check-in of the day also marks the day, so the punch log and the daily
  // marking sheet never disagree. Late is decided against the grace clock time.
  const cfg = await getConfig();
  if ((punch.direction) === 'In') {
    const existing = await prisma.attendance.findUnique({ where: { employeeId_date: { employeeId, date: punchDate } } });
    if (!existing) {
      await prisma.attendance.create({
        data: { employeeId, date: punchDate, status: isLate(punchTime, cfg.graceTime) ? 'Late' : 'Present', checkIn: punchTime },
      });
    } else if (!existing.checkIn) {
      await prisma.attendance.update({ where: { id: existing.id }, data: { checkIn: punchTime } });
    }
  } else {
    const existing = await prisma.attendance.findUnique({ where: { employeeId_date: { employeeId, date: punchDate } } });
    if (existing) await prisma.attendance.update({ where: { id: existing.id }, data: { checkOut: punchTime } });
  }

  await logAudit({ userId: req.user.id, action: `Punch ${punch.direction} recorded`, entity: 'AttendancePunch', entityId: punch.id, toValue: `${punchDate} ${punchTime}` });
  res.status(201).json(punch);
});

// ---- Check-in methods: the methods on offer plus their usage from the punch log ----

router.get('/methods', async (req, res) => {
  const punches = await prisma.attendancePunch.findMany();
  const counts = {};
  CHECKIN_METHODS.forEach((m) => { counts[m] = 0; });
  punches.forEach((p) => { counts[p.method] = (counts[p.method] || 0) + 1; });
  res.json(Object.keys(counts).map((method) => ({ method, punches: counts[method] })));
});

// ---- Dashboard: today's KPIs plus the per-method check-in/check-out split ----

router.get('/dashboard', requirePerm(null, 'hrms', 'Attendance & Time', 'export'), async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const month = date.slice(0, 7);
  const cfg = await getConfig();
  const employees = await scopedEmployees(req, req.query);
  const ids = employees.map((e) => e.id);

  const [dayRecords, dayPunches, monthRecords, monthPunches, regularizations] = await Promise.all([
    prisma.attendance.findMany({ where: { date, employeeId: { in: ids } } }),
    prisma.attendancePunch.findMany({ where: { date, employeeId: { in: ids } } }),
    prisma.attendance.findMany({ where: { date: { startsWith: month }, employeeId: { in: ids } } }),
    prisma.attendancePunch.findMany({ where: { date: { startsWith: month }, employeeId: { in: ids } } }),
    prisma.attendanceRegularization.findMany({ where: { employeeId: { in: ids } }, include: { employee: true }, orderBy: { createdAt: 'desc' } }),
  ]);

  const statusOf = (id) => (dayRecords.find((r) => r.employeeId === id) || {}).status || null;
  const punchesOf = (id) => dayPunches.filter((p) => p.employeeId === id);

  const halfDayCutTotal = employees.reduce((n, e) => n + monthStats({
    month,
    records: monthRecords.filter((r) => r.employeeId === e.id),
    punches: monthPunches.filter((p) => p.employeeId === e.id),
    cfg,
  }).halfDayCut, 0);

  const byMethod = {};
  CHECKIN_METHODS.forEach((m) => { byMethod[m] = { method: m, in: 0, out: 0 }; });
  dayPunches.forEach((p) => {
    if (!byMethod[p.method]) byMethod[p.method] = { method: p.method, in: 0, out: 0 };
    if (p.direction === 'Out') byMethod[p.method].out += 1;
    else byMethod[p.method].in += 1;
  });

  res.json({
    date,
    month,
    kpis: {
      presentToday: employees.filter((e) => ['Present', 'WFH', 'Late'].includes(statusOf(e.id))).length,
      absentToday: employees.filter((e) => statusOf(e.id) === 'Absent').length,
      lateCheckIn: employees.filter((e) => {
        const f = firstIn(punchesOf(e.id));
        return f ? isLate(f.time, cfg.graceTime) : statusOf(e.id) === 'Late';
      }).length,
      halfDayCut: halfDayCutTotal,
      missingPunchIn: employees.filter((e) => ['Present', 'Late'].includes(statusOf(e.id)) && !firstIn(punchesOf(e.id))).length,
      totalCheckedIn: employees.filter((e) => !!firstIn(punchesOf(e.id))).length,
      totalCheckedOut: employees.filter((e) => !!lastOut(punchesOf(e.id))).length,
    },
    byMethod: Object.values(byMethod),
    regularizations: regularizations.slice(0, 5),
    marking: employees.map((e) => {
      const ps = sortedPunches(punchesOf(e.id));
      const rec = dayRecords.find((r) => r.employeeId === e.id) || null;
      return {
        employeeId: e.id,
        employeeCode: e.employeeCode,
        name: e.name,
        department: e.department,
        status: rec ? rec.status : null,
        checkIn: (firstIn(ps) || {}).time || rec?.checkIn || null,
        location: ps.length ? ps[0].location : null,
      };
    }),
  });
});

// ---- Biometric & device attendance: one row per employee ----
// With ?date= it reports that specific day; without one it falls back to each
// employee's last-ever punch, matching the prototype's two reading modes.

router.get('/biometric', requirePerm(null, 'hrms', 'Attendance & Time', 'export'), async (req, res) => {
  const pickedDate = req.query.date || null;
  const month = (pickedDate || new Date().toISOString().slice(0, 10)).slice(0, 7);
  const cfg = await getConfig();
  const employees = await scopedEmployees(req, req.query);
  const ids = employees.map((e) => e.id);

  const [allPunches, monthRecords] = await Promise.all([
    prisma.attendancePunch.findMany({ where: { employeeId: { in: ids } } }),
    prisma.attendance.findMany({ where: { date: { startsWith: month }, employeeId: { in: ids } } }),
  ]);

  const rows = employees.map((e) => {
    const mine = allPunches.filter((p) => p.employeeId === e.id);
    let dayPunches = [];
    let lastPunchLabel = '—';
    let method = '—';
    if (pickedDate) {
      dayPunches = mine.filter((p) => p.date === pickedDate);
      if (dayPunches.length) {
        method = sortedPunches(dayPunches)[0].method;
        lastPunchLabel = `${dayPunches.length} punch(es)`;
      }
    } else {
      const ordered = [...mine].sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
      const last = ordered.length ? ordered[ordered.length - 1] : null;
      if (last) {
        method = last.method;
        lastPunchLabel = `${last.date} ${last.time}`;
        dayPunches = mine.filter((p) => p.date === last.date);
      }
    }
    const fin = firstIn(dayPunches);
    const lout = lastOut(dayPunches);
    const stats = monthStats({
      month,
      records: monthRecords.filter((r) => r.employeeId === e.id),
      punches: mine.filter((p) => p.date.startsWith(month)),
      cfg,
    });
    return {
      employeeId: e.id,
      employeeCode: e.employeeCode,
      name: e.name,
      department: e.department,
      role: e.designation,
      method,
      lastPunch: lastPunchLabel,
      checkIn: fin ? fin.time : '—',
      checkOut: lout ? lout.time : '—',
      location: (sortedPunches(dayPunches)[0] || {}).location || '—',
      present: stats.present,
      late: stats.late,
      halfDayCut: stats.halfDayCut,
      pct: stats.pct,
    };
  });

  res.json({ month, date: pickedDate, rows });
});

// ---- Punch log: every device punch, paired into one session per employee per day ----

router.get('/punch-log', requirePerm(null, 'hrms', 'Attendance & Time', 'export'), async (req, res) => {
  const to = req.query.to || new Date().toISOString().slice(0, 10);
  const from = req.query.from || `${to.slice(0, 7)}-01`;
  const cfg = await getConfig();
  const employees = await scopedEmployees(req, req.query);
  const byId = Object.fromEntries(employees.map((e) => [e.id, e]));

  const punches = await prisma.attendancePunch.findMany({
    where: { employeeId: { in: employees.map((e) => e.id) }, date: { gte: from, lte: to } },
  });

  const sessions = {};
  punches.forEach((p) => {
    const key = `${p.employeeId}|${p.date}`;
    (sessions[key] = sessions[key] || []).push(p);
  });

  const rows = Object.keys(sessions).map((key) => {
    const [employeeId, date] = key.split('|');
    const e = byId[employeeId];
    const ps = sortedPunches(sessions[key]);
    const fin = firstIn(ps);
    const lout = lastOut(ps);
    const mins = fin && lout ? toMinutes(lout.time) - toMinutes(fin.time) : null;
    return {
      date,
      employeeId,
      employeeCode: e?.employeeCode,
      name: e?.name,
      department: e?.department,
      punches: ps.length,
      firstIn: fin ? fin.time : '—',
      lastOut: lout ? lout.time : '—',
      hours: mins != null ? Number((mins / 60).toFixed(1)) : null,
      method: fin ? fin.method : '—',
      location: (fin && fin.location) || '—',
      late: fin ? isLate(fin.time, cfg.graceTime) : false,
    };
  }).sort((a, b) => b.date.localeCompare(a.date) || String(a.name).localeCompare(String(b.name)));

  res.json({ from, to, rows });
});

// ---- Monthly report: per-employee present/absent/late/half-day counts + attendance % ----

router.get('/report', requirePerm(null, 'hrms', 'Attendance & Time', 'export'), async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7); // YYYY-MM
  const cfg = await getConfig();
  const all = await scopedEmployees(req, req.query);
  const employees = all.filter((e) => e.employmentStatus !== 'Relieved');
  const ids = employees.map((e) => e.id);
  const [records, punches] = await Promise.all([
    prisma.attendance.findMany({ where: { date: { startsWith: month }, employeeId: { in: ids } } }),
    prisma.attendancePunch.findMany({ where: { date: { startsWith: month }, employeeId: { in: ids } } }),
  ]);

  const rows = employees.map((e) => {
    const stats = monthStats({
      month,
      records: records.filter((r) => r.employeeId === e.id),
      punches: punches.filter((p) => p.employeeId === e.id),
      cfg,
    });
    return {
      employeeId: e.id, employeeCode: e.employeeCode, name: e.name, department: e.department, role: e.designation,
      workingDays: stats.working, ...stats,
    };
  });

  const totals = rows.reduce((acc, r) => ({
    present: acc.present + r.present,
    absent: acc.absent + r.absent,
    late: acc.late + r.late,
    halfDayCut: acc.halfDayCut + r.halfDayCut,
  }), { present: 0, absent: 0, late: 0, halfDayCut: 0 });

  res.json({ month, monthLabel: monthLabel(month), workingDays: calendarDays(month), businessDays: businessDays(month), totals, rows });
});

module.exports = router;
