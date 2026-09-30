const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm, can } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { employeeWhere, employeeRecordWhere, employeeInScope, OUT_OF_SCOPE } = require('../utils/scope');
const {
  CHECKIN_METHODS, DIRECTIONS, toMinutes, isLate, sortedPunches, clockOf,
  daySplit, dayCheckIn, dayCheckOut, methodLabel, toSeconds, hms,
  calendarDays, businessDays, monthLabel, monthStats, employeeMatchesFilters,
} = require('../utils/attendanceMath');
const { toCsv, toXlsx } = require('../utils/tabularExport');
const { notifyDataIo } = require('../utils/dataIoNotify');
const chain = require('../utils/chainRoute');
const { withoutSystemAccounts, systemRequesterError } = require('../utils/systemAccounts');
const { hrStatusOf } = require('../utils/hrStatus');
const {
  localDate, localTime, MISSING_RULES, isDate, eachDay, loadDays, rollOf, onRolls, tally, bucketOf, BUCKET_LABEL, summarise,
} = require('../utils/attendanceDays');
const registerSelfAttendance = require('./attendanceSelf');

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
    // The login's status comes along only so the rows can carry the person's
    // HR status (hrStatus.js) for the Status filter.
    where: withoutSystemAccounts(employeeWhere(req.user)), orderBy: { name: 'asc' }, include: { user: { select: { status: true, hrmsRole: true } } },
  });
  return employees.filter((e) => employeeMatchesFilters(e, q));
}

// ---------------------------------------------------------------------------
// THE DAY REPORT — one computation behind the Dashboard KPIs, the Biometric
// Attendance List and the Punch Log's date-wise totals, so the same day shows
// the same numbers on all three.
//
// It counts PEOPLE, never records or punches: the roster is the employees in
// scope (Super Admin excluded) who were ON THE ROLLS that day — joined, and
// not yet left (utils/attendanceDays.js rollOf). Each person lands in exactly
// one bucket (bucketOf), so Present + Half Day + Absent + On Leave + Week-off /
// Holiday + No record + Not checked in yet = the day's headcount.
// ---------------------------------------------------------------------------
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const weekdayOf = (d) => WEEKDAYS[new Date(`${d}T00:00:00Z`).getUTCDay()];
const MAX_REPORT_DAYS = 62;

async function dayReport(req, q, from, to) {
  const cfg = await getConfig();
  let all = await scopedEmployees(req, q);
  if (q.hrStatus) all = all.filter((e) => hrStatusOf(e.employmentStatus, e.user && e.user.status) === q.hrStatus);
  const roll = await rollOf(prisma, all);
  const employees = roll.employees.filter((e) => onRolls(e, from, to, roll.lastDayOf));
  const { days, today } = await loadDays(prisma, { employees, from, to, cfg, lastDayOf: roll.lastDayOf });
  const dates = eachDay(from, to);
  const rowsOf = new Map(employees.map((e) => [e.id, days(e)]));
  const at = (id, date) => { const r = rowsOf.get(id); const i = dates.indexOf(date); return r && i >= 0 ? r[i] : null; };
  const byDate = dates.map((date, i) => ({
    date, weekday: weekdayOf(date), ...tally(employees.map((e) => rowsOf.get(e.id)[i])),
  }));
  return { cfg, today, all, employees, lastDayOf: roll.lastDayOf, earlyStarts: roll.earlyStarts, dates, at, rowsOf, byDate };
}

// Why the headcount is what it is — "366 employee records: 35 on the rolls
// on this date, 329 had left, 1 Super Admin (system account) not counted".
async function headcountNote(req, rep, date) {
  const records = await prisma.employee.count({ where: employeeWhere(req.user) });
  const inScope = rep.all.length;
  const onRollsCount = rep.byDate.find((d) => d.date === date)?.headcount ?? 0;
  const left = rep.all.filter((e) => rep.lastDayOf.has(e.id) && (!rep.lastDayOf.get(e.id) || rep.lastDayOf.get(e.id) < date)).length;
  return {
    date,
    records,
    systemAccounts: Math.max(0, records - (await prisma.employee.count({ where: withoutSystemAccounts(employeeWhere(req.user)) }))),
    inScope,
    onRolls: onRollsCount,
    left,
    notYetJoined: Math.max(0, inScope - onRollsCount - left),
  };
}

// The latest day that has any punch or marked attendance in this scope, so an
// empty day can offer "jump to the latest day with data".
async function latestDataDate(ids) {
  if (!ids.length) return null;
  const today = localDate();
  const [p, a] = await Promise.all([
    prisma.attendancePunch.aggregate({ where: { employeeId: { in: ids }, date: { lte: today } }, _max: { date: true } }),
    prisma.attendance.aggregate({ where: { employeeId: { in: ids }, date: { lte: today } }, _max: { date: true } }),
  ]);
  const ds = [p._max.date, a._max.date].filter(Boolean).sort();
  return ds.length ? ds[ds.length - 1] : null;
}

// Where a day's attendance came from, in words.
function sourceOf(punches, record, history) {
  const s = new Set();
  punches.forEach((p) => {
    if (p.source === 'PulseHRM import') s.add('Imported CSV (old HRMS)');
    else if (p.method === 'Biometric') s.add('Biometric device');
    else if (p.source === 'Manual entry') s.add('Entered by HR');
    else if (p.source === 'Web' || p.source === 'Mobile') s.add(`${p.source} check-in`);
    else s.add(p.method || 'Punch');
  });
  if (!punches.length && history) s.add('Imported CSV (old HRMS)');
  if (!punches.length && !history && record) s.add('Marked by HR');
  return [...s].join(', ') || '—';
}

function sendTabular(res, format, name, headers, data, sheet) {
  // Every export tells the Super Admin (utils/dataIoNotify.js; never throws).
  notifyDataIo(res.req, { kind: 'export', module: 'Attendance & Time', count: data.length, what: `rows of ${sheet}`, format, detail: name }).catch(() => {});
  res.setHeader('Content-Disposition', `attachment; filename="${name}.${format}"`);
  if (format === 'csv') return res.type('text/csv').send(toCsv(headers, data));
  return res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(toXlsx(headers, data, sheet));
}

// The KPI block every screen shows for one day, with what each figure counts.
function kpisOf(t) {
  return {
    headcount: t.headcount,
    present: t.present,
    halfDay: t.halfDay,
    absent: t.absent,
    onLeave: t.onLeave,
    offDay: t.offDay,
    noRecord: t.noRecord,
    notYet: t.notYet,
    upcoming: t.upcoming,
    late: t.late,
    missingCheckIn: t.missingCheckIn,
    missingCheckOut: t.missingCheckOut,
    checkedIn: t.checkedIn,
    checkedOut: t.checkedOut,
    punched: t.punched,
    biometric: t.biometric,
  };
}

// SELF CHECK-IN METHODS, per employee. Super Admin assigns them (the Check-in
// Methods tab); an employee may punch ONLY by a method assigned to them, and
// with none assigned they cannot punch at all. Stored on
// Employee.checkInMethods as keys; punches record the label.
const CHECKIN_ASSIGNABLE = { GPS: 'GPS / Location', Biometric: 'Biometric', Face: 'Face Recognition' };
const CHECKIN_KEYS = Object.keys(CHECKIN_ASSIGNABLE);
function methodsOf(employee) {
  return String((employee && employee.checkInMethods) || '').split(',').map((m) => m.trim())
    .filter((m) => CHECKIN_KEYS.includes(m));
}
// Accepts a key (GPS) or its label (GPS / Location).
function methodKey(v) {
  const t = String(v || '').trim();
  if (CHECKIN_KEYS.includes(t)) return t;
  return CHECKIN_KEYS.find((k) => CHECKIN_ASSIGNABLE[k] === t) || null;
}
// can() is async — it must be awaited, or every login passes this check.
const isSuperAdmin = (user) => can(user, null, 'administration', 'Departments & Teams', 'create');
const ownEmployee = (req) => prisma.employee.findUnique({ where: { userId: req.user.id } });
const EXITED = ['Relieved', 'Exited', 'Exit Process'];

// A requested employeeId is honoured only when it is INSIDE the caller's scope;
// anything else resolves to "no such employee for you" rather than leaking a row.
async function resolveEmployeeId(req, requestedEmployeeId) {
  // ?mine=1 — any login (HR, Manager, TL… included) reading ITS OWN rows.
  if (req.user.caps.hrmsSelfOnly || req.query.mine === '1') {
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
  if ((req.user.caps.hrmsSelfOnly || req.query.mine === '1') && !employeeId) return res.json([]);
  if (employeeId) where.employeeId = employeeId;
  if (req.query.date) where.date = req.query.date;
  // A day range (inclusive YYYY-MM-DD), for the common dashboard's date filter.
  else if (req.query.from && req.query.to) where.date = { gte: String(req.query.from), lte: String(req.query.to) };
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
//
// §9 — A REGULARIZATION CLIMBS THE SAME LADDER AS A LEAVE. Correcting your
// own attendance record is exactly the kind of request that needs somebody
// above you to agree, and it used to be one click by anyone holding
// 'approve' on Attendance & Time. Now:
//
//   Employee → TL → STL → HR → Assistant Manager → Manager → Super Admin
//
// and a TL's own correction starts at their STL, because nobody approves
// their own request. The ladder, who sits on each rung and which rungs gate
// are all utils/approvalWorkflow.js — see WORKFLOWS.regularization.
const WF_REG = 'regularization';

router.get('/regularizations', async (req, res) => {
  // Scope, OR being named on the request's own chain — an approver whose
  // department scope does not cover the applicant still sees what they decide.
  const scoped = employeeRecordWhere(req.user);
  const onMyChain = await chain.participantIds(WF_REG, req.user.id);
  const where = Object.keys(scoped).length
    ? { OR: onMyChain.length ? [scoped, { id: { in: onMyChain } }] : [scoped] }
    : {};
  const employeeId = await resolveEmployeeId(req, req.query.employeeId);
  if (req.user.caps.hrmsSelfOnly && !employeeId) return res.json([]);
  if (employeeId) where.employeeId = employeeId;
  if (req.query.status) where.status = req.query.status;
  const regularizations = await prisma.attendanceRegularization.findMany({ where, include: { employee: true }, orderBy: { createdAt: 'desc' } });
  // Each row carries its own chain summary, so the list can say WHO IT IS
  // WAITING ON instead of a bare "Pending".
  res.json(await chain.decorate(WF_REG, regularizations));
});

router.post('/regularizations', async (req, res) => {
  const { date, requestedCheckIn, requestedCheckOut, reason } = req.body;
  const own = await prisma.employee.findUnique({ where: { userId: req.user.id } });
  if (!own) return res.status(404).json({ error: 'No employee record linked to this account' });
  { const sys = await systemRequesterError(own, 'attendance regularization'); if (sys) return res.status(403).json({ error: sys }); }
  if (!date) return res.status(400).json({ error: 'date is required' });
  const regularization = await prisma.attendanceRegularization.create({ data: { employeeId: own.id, date, requestedCheckIn, requestedCheckOut, reason } });
  await logAudit({ userId: req.user.id, action: 'Attendance regularization requested', entity: 'AttendanceRegularization', entityId: regularization.id });
  // The chain goes down with the request. If the ladder has no rung above
  // whoever raised it, raise() comes back not pending and the request simply
  // waits for a decision the way it always did.
  const started = await chain.raise(WF_REG, { recordId: regularization.id, employee: own });
  res.status(201).json({ ...regularization, workflow: started.summary });
});

router.patch('/regularizations/:id/decision', requirePerm(null, 'hrms', 'Attendance & Time', 'approve'), async (req, res) => {
  const { status } = req.body; // Approved | Rejected
  if (!['Approved', 'Rejected'].includes(status)) return res.status(400).json({ error: 'status must be Approved or Rejected' });
  const existing = await prisma.attendanceRegularization.findUnique({
    where: { id: req.params.id }, include: { employee: true },
  });
  if (!existing) return res.status(404).json({ error: 'Request not found' });
  // Scope, OR being named on this request's own chain — an approver two
  // rungs up whose departments do not cover the applicant is still this
  // request's approver.
  if (!await chain.mayTouch(WF_REG, existing.id, req.user, existing.employee)) {
    return res.status(403).json(chain.OUT_OF_SCOPE);
  }
  if (existing.status !== 'Pending') return res.status(409).json({ error: `This request was already ${existing.status.toLowerCase()}.` });

  // A request raised before the chain shipped gets one now, so it climbs the
  // ladder rather than being decided in a single click.
  await chain.ensure(WF_REG, { recordId: existing.id, employee: existing.employee, open: true });
  const step = await chain.decide(WF_REG, existing.id, req.user, { decision: status, note: req.body.reason || req.body.rejectReason });
  if (step.error) return res.status(step.error.status).json(step.error.body);

  // STILL CLIMBING — nothing is written to the attendance record and the
  // request stays Pending. Only the LAST rung applies the correction.
  if (step.chained && !step.result.complete) {
    await logAudit({
      userId: req.user.id,
      action: `Regularization ${status.toLowerCase()} at ${step.result.level}`,
      entity: 'AttendanceRegularization',
      entityId: existing.id,
      fromValue: step.result.level,
      toValue: step.result.nextLevel || step.result.outcome,
    });
    return res.json({ ...existing, status: 'Pending', workflow: step.view });
  }
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

// The requester withdraws their own request while it is still pending. Any
// approval step still open is closed as Skipped, so it drops out of every
// approver's queue instead of waiting on a request nobody wants any more.
router.patch('/regularizations/:id/cancel', async (req, res) => {
  const own = await ownEmployee(req);
  const existing = await prisma.attendanceRegularization.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Request not found' });
  if (!own || existing.employeeId !== own.id) return res.status(403).json({ error: 'Only the person who raised a request can cancel it.' });
  if (existing.status !== 'Pending') return res.status(409).json({ error: `This request was already ${existing.status.toLowerCase()}.` });
  const regularization = await prisma.attendanceRegularization.update({
    where: { id: existing.id }, data: { status: 'Cancelled', decidedAt: new Date() },
  });
  await prisma.approvalStep.updateMany({
    where: { workflow: WF_REG, recordId: existing.id, status: { in: ['Pending', 'Waiting'] } },
    data: { status: 'Skipped', note: 'Not reached — the requester cancelled the request' },
  });
  await logAudit({ userId: req.user.id, action: 'Regularization cancelled', entity: 'AttendanceRegularization', entityId: existing.id, toValue: 'Cancelled' });
  res.json(regularization);
});

// ---- Check-in method assignment (Super Admin only) ----------------------------

router.get('/checkin-methods/mine', async (req, res) => {
  const own = await ownEmployee(req);
  res.json({
    hasEmployee: !!own,
    methods: own ? methodsOf(own).map((k) => ({ key: k, label: CHECKIN_ASSIGNABLE[k] })) : [],
  });
});

router.get('/checkin-methods', async (req, res) => {
  if (!(await isSuperAdmin(req.user))) return res.status(403).json({ error: 'Only Super Admin assigns check-in methods.' });
  const employees = await prisma.employee.findMany({
    where: withoutSystemAccounts({ employmentStatus: { notIn: EXITED } }), // no check-in rules for Super Admin
    select: { id: true, employeeCode: true, name: true, department: true, designation: true, checkInMethods: true },
    orderBy: { name: 'asc' },
  });
  res.json({
    methods: CHECKIN_KEYS.map((k) => ({ key: k, label: CHECKIN_ASSIGNABLE[k] })),
    employees: employees.map(({ checkInMethods, ...e }) => ({ ...e, methods: methodsOf({ checkInMethods }) })),
  });
});

router.put('/checkin-methods', async (req, res) => {
  if (!(await isSuperAdmin(req.user))) return res.status(403).json({ error: 'Only Super Admin assigns check-in methods.' });
  const list = Array.isArray(req.body && req.body.assignments) ? req.body.assignments : [];
  if (!list.length) return res.status(400).json({ error: 'Nothing to save.' });
  let changed = 0;
  for (const a of list) {
    const methods = [...new Set((Array.isArray(a.methods) ? a.methods : []).map(methodKey).filter(Boolean))];
    const employee = await prisma.employee.findUnique({ where: { id: String(a.employeeId || '') } });
    if (!employee) continue;
    const next = methods.join(',') || null;
    if ((employee.checkInMethods || null) === next) continue;
    await prisma.employee.update({ where: { id: employee.id }, data: { checkInMethods: next } });
    await logAudit({
      userId: req.user.id, action: 'Check-in methods assigned', entity: 'Employee', entityId: employee.id,
      fromValue: methodsOf(employee).map((k) => CHECKIN_ASSIGNABLE[k]).join(', ') || 'none',
      toValue: methods.map((k) => CHECKIN_ASSIGNABLE[k]).join(', ') || 'none',
    });
    changed += 1;
  }
  res.json({ changed });
});

// ---- Attendance policy (grace time, half/full day thresholds) ----

router.get('/policy', async (req, res) => {
  let config = await prisma.hrConfig.findFirst();
  if (!config) config = await prisma.hrConfig.create({ data: {} });
  res.json(config);
});

router.put('/policy', requirePerm(null, 'hrms', 'Attendance & Time', 'configure'), async (req, res) => {
  const { graceTimeMinutes, graceTime, halfDayHours, fullDayHours, freeLateArrivalsPerMonth, missingCheckInRule, weeklyOffDays } = req.body;
  const config = await getConfig();
  if (graceTime != null && toMinutes(graceTime) == null) {
    return res.status(400).json({ error: 'graceTime must be a 24-hour HH:MM clock time (e.g. 09:30)' });
  }
  // HRMS-24 §4 — how a past working day with no check-in reads, and the weekly offs.
  if (missingCheckInRule != null && !MISSING_RULES.includes(missingCheckInRule)) {
    return res.status(400).json({ error: `missingCheckInRule must be one of: ${MISSING_RULES.join(', ')}` });
  }
  if (weeklyOffDays != null && !/^([0-6](,[0-6])*)?$/.test(String(weeklyOffDays).replace(/\s/g, ''))) {
    return res.status(400).json({ error: 'weeklyOffDays must be day numbers 0-6 separated by commas (0 = Sunday)' });
  }
  if (missingCheckInRule != null || weeklyOffDays != null) {
    await prisma.hrConfig.update({
      where: { id: config.id },
      data: {
        missingCheckInRule: missingCheckInRule != null ? missingCheckInRule : undefined,
        weeklyOffDays: weeklyOffDays != null ? String(weeklyOffDays).replace(/\s/g, '') : undefined,
      },
    });
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
  if ((req.user.caps.hrmsSelfOnly || req.query.mine === '1') && !employeeId) return res.json([]);
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
//
// EVERY LOGIN CHECKS ITSELF IN. HR, Manager, Assistant Manager, STL and TL have
// their own attendance like anyone else: a punch with no employeeId (or their
// own) is theirs. Punching for SOMEBODY ELSE — entering a reading off an
// offline device — still needs hrmsManage and that person in scope.
router.post('/punches', async (req, res) => {
  const { date, time, direction, location } = req.body;
  const own = await ownEmployee(req);
  let employeeId = req.body.employeeId;
  const forSelf = req.user.caps.hrmsSelfOnly || !employeeId || (own && employeeId === own.id);
  let employee;
  if (forSelf) {
    if (!own) return res.status(404).json({ error: 'No employee record is linked to this login, so there is no attendance to record.' });
    employee = own;
  } else {
    if (!req.user.caps.hrmsManage) return res.status(403).json({ error: "This isn't included in your role's permissions" });
    employee = await prisma.employee.findUnique({ where: { id: employeeId } });
    if (!employee) return res.status(404).json({ error: 'Employee not found' });
    if (!employeeInScope(req.user, employee)) return res.status(403).json(OUT_OF_SCOPE);
  }
  employeeId = employee.id;

  // Only a method Super Admin has assigned to THIS employee.
  const allowed = methodsOf(employee);
  const key = methodKey(req.body.method);
  const who = forSelf ? 'you' : employee.name;
  if (!allowed.length) {
    return res.status(403).json({ error: forSelf
      ? 'No check-in method has been assigned to you yet. Super Admin assigns them under Attendance → Check-in Methods.'
      : `No check-in method is assigned to ${who}.` });
  }
  if (!key || !allowed.includes(key)) {
    return res.status(403).json({ error: `That method is not assigned to ${who}. Allowed: ${allowed.map((k) => CHECKIN_ASSIGNABLE[k]).join(', ')}.` });
  }
  // HRMS-24 §5 — A SELF PUNCH FROM THE BROWSER OR PHONE IS A VERIFIED ONE: a
  // live camera capture matched to the registered photo, plus a location. That
  // is POST /punches/verified (routes/attendanceSelf.js); this plain path is
  // left for HR entering a reading on somebody else's behalf.
  if (forSelf) {
    if (key === 'Biometric') return res.status(403).json({ error: 'Biometric punches come from the fingerprint device, not the browser.' });
    return res.status(400).json({ error: 'Web and mobile check-in needs a live camera capture and your location. Use Check In on My Attendance.', code: 'USE_VERIFIED' });
  }
  if (key === 'GPS' && !String(location || '').trim()) {
    return res.status(400).json({ error: 'GPS check-in needs your location — allow location access in the browser and try again.' });
  }
  const method = CHECKIN_ASSIGNABLE[key];
  const punchDate = date || localDate();
  const punchTime = time || localTime();
  if (toMinutes(punchTime) == null) return res.status(400).json({ error: 'time must be a 24-hour HH:MM clock time' });
  if (direction && !DIRECTIONS.includes(direction)) return res.status(400).json({ error: 'direction must be In or Out' });

  const punch = await prisma.attendancePunch.create({
    data: {
      employeeId, date: punchDate, time: punchTime, direction: direction || 'In', method, location,
      source: 'Manual entry', verificationStatus: 'Not applicable (entered by HR)', userAgent: String(req.headers['user-agent'] || '').slice(0, 400),
    },
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

// ---- The Dashboard, the Biometric list and the Punch Log ----------------------
//
// All three take ONE DAY (?date=, default today) or a FROM–TO range of up to
// 62 days (?from&to), and read the same dayReport(). One day: the KPIs are the
// people on the rolls that day, in exactly one bucket each. A range: the KPIs
// are still PEOPLE — "present on at least one day", per-day averages — never
// person-days dressed up as people; the day-by-day totals come alongside.

// ?date=, or ?from&to. Default: today.
function rangeOfQuery(q) {
  const today = localDate();
  let from;
  let to;
  if (q.from || q.to) {
    from = isDate(q.from) ? String(q.from) : null;
    to = isDate(q.to) ? String(q.to) : null;
    from = from || to || today;
    to = to || from;
  } else {
    from = isDate(q.date) ? String(q.date) : today;
    to = from;
  }
  if (from > to) return { error: 'The From date is after the To date.' };
  if (eachDay(from, to).length > MAX_REPORT_DAYS) return { error: `Pick at most ${MAX_REPORT_DAYS} days — use the Monthly Summary for longer periods.` };
  return { from, to, single: from === to };
}

// A range in PEOPLE: per person, how many days fell in each bucket; then how
// many people had at least one such day, and the per-day averages.
function rangeSummary(rep, from, to) {
  const idx = rep.dates.map((d, i) => (d >= from && d <= to ? i : -1)).filter((i) => i >= 0);
  const days = idx.map((i) => rep.byDate[i]);
  const people = rep.employees.map((e) => {
    const all = rep.rowsOf.get(e.id) || [];
    const c = { present: 0, halfDay: 0, absent: 0, onLeave: 0, offDay: 0, noRecord: 0, notYet: 0, upcoming: 0, late: 0, days: 0 };
    idx.forEach((i) => {
      const d = all[i];
      const b = bucketOf(d);
      if (!b) return;
      c.days += 1;
      c[b] += 1;
      if (d.late || d.status === 'Late') c.late += 1;
    });
    return {
      employeeId: e.id, employeeCode: e.employeeCode, name: e.name, department: e.department, role: e.designation,
      hrStatus: hrStatusOf(e.employmentStatus, e.user && e.user.status),
      ...c, workingDays: c.days - c.offDay - c.upcoming,
    };
  }).filter((p) => p.days > 0);
  const n = days.length || 1;
  const sum = (k) => days.reduce((s, d) => s + d[k], 0);
  const avg = (k) => Math.round((sum(k) / n) * 10) / 10;
  const anyOf = (k) => people.filter((p) => p[k] > 0).length;
  const keys = ['headcount', 'present', 'halfDay', 'absent', 'onLeave', 'offDay', 'noRecord', 'notYet', 'late', 'checkedIn', 'checkedOut'];
  return {
    days: days.length,
    people: people.length,
    presentAny: anyOf('present'),
    presentAll: people.filter((p) => p.workingDays > 0 && p.present === p.workingDays).length,
    halfDayAny: anyOf('halfDay'),
    absentAny: anyOf('absent'),
    onLeaveAny: anyOf('onLeave'),
    noRecordAny: anyOf('noRecord'),
    lateAny: anyOf('late'),
    avg: Object.fromEntries(keys.map((k) => [k, avg(k)])),
    personDays: Object.fromEntries(keys.map((k) => [k, sum(k)])),
    rows: people,
  };
}

const dayTotals = (rep, from, to) => rep.byDate.filter((d) => d.date >= from && d.date <= to)
  .map((t) => ({ ...kpisOf(t), date: t.date, weekday: t.weekday }));

// DISPLAY ONLY — the day's punches as check-ins and check-outs. The stored
// punches keep their own direction (for the device: the key pressed). The
// imported old-HRMS log ("Time Interval") carried no direction, so its times
// are placed by this rule, for the screen and the exports only:
//   * the first time is a check-in;
//   * the last time is a check-out ONLY when the file's row had a Last Check
//     Out — otherwise nothing is turned into a check-out (pressed-only rule);
//   * the times in between alternate, starting with a check-out.
// Merged with the stored punches by clock time, each time once.
function displayPunches(punches, history) {
  const key = (t) => (String(t).length === 5 ? `${t}:00` : String(t));
  const byKey = new Map();
  punches.forEach((p) => {
    const t = clockOf(p);
    if (!t || byKey.has(key(t))) return;
    byKey.set(key(t), { time: t, dir: p.direction === 'Out' ? 'Out' : 'In', imported: p.source === 'PulseHRM import' });
  });
  const log = history && history.punchTimes ? [...new Set(history.punchTimes.split('|').filter(Boolean))].sort() : [];
  log.forEach((t, i) => {
    const k = key(t);
    if (byKey.has(k)) { byKey.get(k).imported = true; return; }
    let dir;
    if (i === 0) dir = 'In';
    else if (i === log.length - 1) dir = history.lastCheckOut ? 'Out' : 'In';
    else dir = (i - 1) % 2 === 0 ? 'Out' : 'In';
    byKey.set(k, { time: t, dir, imported: true });
  });
  const list = [...byKey.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, v]) => v);
  return {
    list,
    ins: list.filter((x) => x.dir === 'In').map((x) => x.time),
    outs: list.filter((x) => x.dir === 'Out').map((x) => x.time),
    imported: list.some((x) => x.imported),
  };
}

// ---- The old HRMS report layouts -------------------------------------------
// 13-SEP-2026, the way the old HRMS wrote dates.
const MON3 = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const dmy = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(String(iso || '')) ? `${iso.slice(8, 10)}-${MON3[Number(iso.slice(5, 7)) - 1]}-${iso.slice(0, 4)}` : String(iso || ''));
const secs = (t) => toSeconds(String(t || '').length === 5 ? `${t}:00` : t);

// "First Check-In & Last Check-Out Report" values for one person-day. Where
// the imported CSV supplied a value it is shown exactly as exported; for a
// device / web day it is worked out from the stored punches:
//   First Check In = the first check-in, Last Check Out = the last pressed
//   check-out (attendanceMath.daySplit — the one rule), Total Hours = last out
//   minus first in, Total Time In Break = every gap from a check-out to the next
//   check-in in between, Total Time Worked = Total Hours minus the breaks.
// Presentation only — nothing is stored.
function reportDay(e, ps, h, d) {
  const day = daySplit(ps);
  const fin = day.checkIn;
  const lout = day.checkOut;
  const logFirst = h && h.punchTimes ? h.punchTimes.split('|').filter(Boolean).sort()[0] : null;
  const firstIn = (h && h.firstCheckIn) || (fin ? clockOf(fin) : null) || logFirst || (d && d.checkIn) || null;
  const lastOut = (h && h.lastCheckOut) || (lout ? clockOf(lout) : null) || (d && d.checkOut) || null;
  let total = null; let brk = null; let worked = null;
  if (h && (h.totalHours || h.totalTimeWorked || h.totalBreak)) {
    total = h.totalHours || null; brk = h.totalBreak || null; worked = h.totalTimeWorked || null;
  } else if (firstIn && lastOut && secs(lastOut) != null && secs(firstIn) != null && secs(lastOut) >= secs(firstIn)) {
    const span = secs(lastOut) - secs(firstIn);
    let gap = 0;
    const seq = day.punches.filter((p) => secs(clockOf(p)) != null && secs(clockOf(p)) >= secs(firstIn) && secs(clockOf(p)) <= secs(lastOut));
    for (let i = 0; i < seq.length - 1; i += 1) {
      if (seq[i].direction === 'Out' && seq[i + 1].direction !== 'Out') gap += secs(clockOf(seq[i + 1])) - secs(clockOf(seq[i]));
    }
    total = hms(span); brk = hms(gap); worked = hms(Math.max(0, span - gap));
  }
  return {
    employeeNo: e.employeeCode,
    employeeRef: (h && h.employeeRef) || e.employeeCode,
    firstCheckIn: firstIn,
    lastCheckOut: lastOut,
    workLocation: (h && h.workLocation) || (fin && fin.location) || e.branch || e.location || '',
    totalTimeWorked: worked,
    totalBreak: brk,
    totalHours: total,
  };
}

// Every punch time of a person-day — device / web punches and the imported
// bio-metric log merged by time, each time once — joined with "|": the old
// HRMS "Time Interval". On a day the log was imported for, the log is the
// record of the imported punches: the first-in / last-out rows the import
// created from the REPORT file (not always in the log) are left out, so the
// string equals the exported log.
const timeIntervalOf = (ps, h) => displayPunches(h && h.punchTimes ? ps.filter((p) => p.source !== 'PulseHRM import') : ps, h)
  .list.map((x) => x.time).join('|');

// Punches / marks / imported days for some people over a range, keyed "id|date".
async function dayFacts(ids, from, to) {
  const where = { employeeId: { in: ids }, date: { gte: from, lte: to } };
  const [punches, records, history] = await Promise.all([
    prisma.attendancePunch.findMany({ where }),
    prisma.attendance.findMany({ where }),
    prisma.attendanceHistory.findMany({
      where,
      select: {
        employeeId: true, employeeRef: true, date: true, punchTimes: true, firstCheckIn: true, lastCheckOut: true,
        totalTimeWorked: true, totalBreak: true, totalHours: true, workLocation: true,
      },
    }),
  ]);
  const k = (id, d) => `${id}|${d}`;
  const punchesOf = new Map();
  punches.forEach((p) => { const x = k(p.employeeId, p.date); if (!punchesOf.has(x)) punchesOf.set(x, []); punchesOf.get(x).push(p); });
  return {
    punches: (id, d) => punchesOf.get(k(id, d)) || [],
    record: new Map(records.map((r) => [k(r.employeeId, r.date), r])),
    history: new Map(history.map((h) => [k(h.employeeId, h.date), h])),
    keysWithPunches: new Set([...punchesOf.keys(), ...history.filter((h) => h.punchTimes).map((h) => k(h.employeeId, h.date))]),
    k,
  };
}

// ---- Dashboard ----------------------------------------------------------------

router.get('/dashboard', requirePerm(null, 'hrms', 'Attendance & Time', 'export'), async (req, res) => {
  const r = rangeOfQuery(req.query);
  if (r.error) return res.status(400).json({ error: r.error });
  const { from, to } = r;
  const date = to;
  const month = to.slice(0, 7);
  const rep = await dayReport(req, req.query, from, to);
  const [latest, note, regularizations] = await Promise.all([
    latestDataDate(rep.all.map((e) => e.id)),
    headcountNote(req, rep, to),
    prisma.attendanceRegularization.findMany({ where: { employeeId: { in: rep.employees.map((e) => e.id) } }, include: { employee: true }, orderBy: { createdAt: 'desc' }, take: 5 }),
  ]);

  if (!r.single) {
    return res.json({
      range: true, from, to, today: rep.today, latestDataDate: latest, headcount: note,
      summary: rangeSummary(rep, from, to), days: dayTotals(rep, from, to), regularizations,
    });
  }

  const employees = rep.employees.filter((e) => bucketOf(rep.at(e.id, date))); // on the rolls that day
  const ids = employees.map((e) => e.id);
  const [dayRecords, dayPunches, monthRecords, monthPunches] = await Promise.all([
    prisma.attendance.findMany({ where: { date, employeeId: { in: ids } } }),
    prisma.attendancePunch.findMany({ where: { date, employeeId: { in: ids } } }),
    prisma.attendance.findMany({ where: { date: { startsWith: month }, employeeId: { in: ids } } }),
    prisma.attendancePunch.findMany({ where: { date: { startsWith: month }, employeeId: { in: ids } } }),
  ]);
  const recOf = new Map(dayRecords.map((x) => [x.employeeId, x]));
  const punchesOf = new Map();
  dayPunches.forEach((p) => { if (!punchesOf.has(p.employeeId)) punchesOf.set(p.employeeId, []); punchesOf.get(p.employeeId).push(p); });

  // Payroll's number: late days beyond the free allowance, for the month of
  // the chosen day, over the people on the rolls that day.
  const halfDayCutTotal = employees.reduce((n, e) => n + monthStats({
    month,
    records: monthRecords.filter((x) => x.employeeId === e.id),
    punches: monthPunches.filter((p) => p.employeeId === e.id),
    cfg: rep.cfg,
  }).halfDayCut, 0);

  // Check-ins / check-outs by method: PEOPLE, by the method of their first
  // check-in / last check-out (attendanceMath.daySplit), not raw punches.
  const byMethod = {};
  CHECKIN_METHODS.forEach((m) => { byMethod[m] = { method: m, in: 0, out: 0 }; });
  punchesOf.forEach((ps) => {
    const day = daySplit(ps);
    [['in', day.checkIn], ['out', day.checkOut]].forEach(([k, p]) => {
      if (!p) return;
      const m = p.source === 'PulseHRM import' && p.method !== 'Biometric' ? 'Imported (no device log)' : p.method;
      if (!byMethod[m]) byMethod[m] = { method: m, in: 0, out: 0 };
      byMethod[m][k] += 1;
    });
  });

  const t = rep.byDate[rep.byDate.length - 1];
  res.json({
    range: false,
    date, from, to,
    weekday: t.weekday,
    month,
    today: rep.today,
    latestDataDate: latest,
    headcount: note,
    kpis: { ...kpisOf(t), halfDayCut: halfDayCutTotal },
    byMethod: Object.values(byMethod),
    regularizations,
    marking: employees.map((e) => {
      const d = rep.at(e.id, date) || {};
      const rec = recOf.get(e.id) || null;
      const ps = sortedPunches(punchesOf.get(e.id) || []);
      return {
        employeeId: e.id,
        employeeCode: e.employeeCode,
        name: e.name,
        department: e.department,
        hrStatus: hrStatusOf(e.employmentStatus, e.user && e.user.status),
        status: rec ? rec.status : null, // as marked (what the Mark buttons change)
        dayStatus: d.status || null, // as computed from punches, marks, leave, holidays
        bucket: bucketOf(d),
        late: !!(d.late || d.status === 'Late'),
        punchRows: ps.length,
        checkIn: d.checkIn || null,
        checkOut: d.checkOut || null,
        location: ps.length ? ps[0].location : null,
      };
    }),
  });
});

// ---- Biometric & device attendance — DATE-WISE ---------------------------------
// One row per person on the rolls per day (default: today), with the day's
// status, every check-in and check-out time (imported log times placed by
// displayPunches()), the method and where the attendance came from. One day:
// the totals are the Dashboard's for that day. A range (≤ 62 days): the rows
// are grouped by date and the totals are rangeSummary()'s.
// ?format=csv|xlsx exports the rows shown.
router.get('/biometric', requirePerm(null, 'hrms', 'Attendance & Time', 'export'), async (req, res) => {
  const r = rangeOfQuery(req.query);
  if (r.error) return res.status(400).json({ error: r.error });
  const { from, to, single } = r;
  const month = to.slice(0, 7);
  // One day also carries month-to-date counts, so the report starts on the 1st.
  const repFrom = single ? `${month}-01` : from;
  const rep = await dayReport(req, req.query, repFrom, to);
  const ids = rep.employees.map((e) => e.id);
  const [facts, latest, note] = await Promise.all([
    dayFacts(ids, from, to),
    latestDataDate(rep.all.map((e) => e.id)),
    headcountNote(req, rep, to),
  ]);

  let rows = [];
  eachDay(from, to).forEach((date) => {
    rep.employees.forEach((e) => {
      const d = rep.at(e.id, date);
      const bucket = bucketOf(d);
      if (!bucket) return;
      const key = facts.k(e.id, date);
      const ps = facts.punches(e.id, date);
      const h = facts.history.get(key) || null;
      const day = daySplit(ps);
      const disp = displayPunches(ps, h);
      const fin = day.checkIn;
      const lout = day.checkOut;
      const spanSec = fin && lout && d.checkOut ? toSeconds(clockOf(lout)) - toSeconds(clockOf(fin)) : null;
      let mtd = null;
      if (single) {
        const s = summarise((rep.rowsOf.get(e.id) || []).filter((x) => x.date <= date));
        mtd = { attended: s.present + s.late + s.missingCheckOut, late: s.lateArrivals, halfDay: s.halfDay, absent: s.absent, onLeave: s.onLeave, noRecord: s.noRecord, workingDays: s.workingDays };
      }
      rows.push({
        // The old "First Check-In & Last Check-Out Report" columns (reportDay()).
        ...reportDay(e, ps, h, d),
        designation: e.designation,
        dateLabel: dmy(date),
        employeeId: e.id,
        employeeCode: e.employeeCode,
        name: e.name,
        department: e.department,
        role: e.designation,
        hrStatus: hrStatusOf(e.employmentStatus, e.user && e.user.status),
        date,
        status: d.status,
        bucket,
        bucketLabel: BUCKET_LABEL[bucket],
        note: d.note || '',
        late: !!(d.late || d.status === 'Late'),
        // First check-in / last check-out exactly as the day rule saw them (so
        // the list and the KPI counts agree), with the device's seconds.
        checkIn: d.checkIn ? (fin ? clockOf(fin) : d.checkIn) : null,
        checkOut: d.checkOut ? (lout ? clockOf(lout) : d.checkOut) : null,
        // Every check-in / check-out time (display rule above).
        checkInTimes: disp.ins.length ? disp.ins : (d.checkIn ? [d.checkIn] : []),
        checkOutTimes: disp.outs.length ? disp.outs : (d.checkOut ? [d.checkOut] : []),
        workedSpan: spanSec != null && spanSec >= 0 ? hms(spanSec) : null,
        hours: d.hours ?? null,
        method: fin || ps[0] ? methodLabel(fin || ps[0]) : (h && h.punchTimes ? 'Imported CSV (old HRMS)' : '—'),
        punches: disp.list.length, // distinct punch times shown
        punchRows: ps.length, // stored punch rows (what the KPI "People with punches" counts)
        imported: disp.imported,
        source: sourceOf(ps, facts.record.get(key), h),
        location: (fin && fin.location) || (ps[0] && ps[0].location) || (h && h.workLocation) || '—',
        mtd,
      });
    });
  });
  const totals = single ? kpisOf(rep.byDate[rep.byDate.length - 1]) : null;
  const summary = single ? null : rangeSummary(rep, from, to);
  const days = dayTotals(rep, from, to);
  // The card filter applies to the rows; the totals stay the whole period's.
  const want = String(req.query.dayStatus || '');
  const wanted = {
    late: (x) => x.late,
    missingCheckOut: (x) => x.status === 'Missing Check-Out',
    punched: (x) => x.punchRows > 0,
    checkedIn: (x) => !!x.checkIn,
    checkedOut: (x) => !!x.checkOut,
  };
  if (want) rows = rows.filter((x) => x.bucket === want || x.status === want || (wanted[want] ? wanted[want](x) : false));
  // The filter bar's Status / Method / Source (review #3 §14). The options
  // (facets) are taken before these three narrow the rows, so a dropdown never
  // shrinks to the one value picked.
  const shownStatus = (x) => (x.bucket === 'noRecord' ? 'No record' : x.status);
  const facetOf = (fn) => [...new Set(rows.map(fn).filter((v) => v && v !== '—'))].sort();
  const facets = { statuses: facetOf(shownStatus), methods: facetOf((x) => x.method), sources: facetOf((x) => x.source) };
  if (req.query.status) rows = rows.filter((x) => shownStatus(x) === String(req.query.status));
  if (req.query.method) rows = rows.filter((x) => x.method === String(req.query.method));
  if (req.query.source) rows = rows.filter((x) => x.source === String(req.query.source));
  // Like the old report: only person-days with a check-in, unless the caller
  // asks for everyone (?all=1) or narrowed by a card / status (then every
  // matching person is listed, check-in or not).
  const everyone = req.query.all === '1' || !!want || !!req.query.status;
  const withoutCheckIn = rows.filter((x) => !x.firstCheckIn).length;
  if (!everyone) rows = rows.filter((x) => x.firstCheckIn);
  // Employee by employee, dates ascending — the old report's order.
  rows.sort((a, b) => String(a.employeeCode).localeCompare(String(b.employeeCode), undefined, { numeric: true }) || a.date.localeCompare(b.date));

  const format = String(req.query.format || '').toLowerCase();
  if (format === 'csv' || format === 'xlsx') {
    // Exactly the old "First Check-In & Last Check-Out Report" columns.
    const headers = ['Employee No', 'Employee Ref No', 'Employee Name', 'Department', 'Designation', 'Date', 'First Check In', 'Last Check Out',
      'Work Location', 'Total Time Worked', 'Total Time In Break', 'Total Hours'];
    const data = rows.map((x) => [x.employeeNo, x.employeeRef, x.name, x.department || '', x.designation || '', x.dateLabel,
      x.firstCheckIn || '', x.lastCheckOut || '', x.workLocation || '', x.totalTimeWorked || '', x.totalBreak || '', x.totalHours || '']);
    return sendTabular(res, format, `first-check-in-last-check-out-${single ? from : `${from}_to_${to}`}`, headers, data, 'First In Last Out');
  }

  res.json({
    range: !single, date: to, from, to, weekday: weekdayOf(to), month, today: rep.today, latestDataDate: latest, headcount: note,
    totals, summary, days, rows, facets, everyone, withoutCheckIn,
  });
});

// ---- Punch log: every punch of the day, as check-in times and check-out times ----

// The HRMS role as the organisation structure names it.
const HRMS_ROLE_LABEL = {
  SUPER_ADMIN: 'Super Admin', ADMIN: 'Admin', HR: 'HR Admin', MANAGER: 'Manager',
  ASSISTANT_MANAGER: 'Assistant Manager', STL: 'Senior Team Lead (STL)', TL: 'Team Lead (TL)',
  EMPLOYEE: 'Employee (Self-Service)',
};
const roleLabelOf = (e) => {
  const code = e && e.user && e.user.hrmsRole;
  return (code && code !== 'NONE' && HRMS_ROLE_LABEL[code]) || (e && e.designation) || '—';
};

// DATE-WISE: default one day (today); a From–To range of up to 62 days is
// grouped by date, each date with its own totals from dayReport() — the same
// figures the Dashboard and the Biometric list show for that day. Rows are the
// people with punches (device, web / mobile, or the imported CSVs) and — with
// ?absentees=1, the default — everyone else on the rolls that day too (absent,
// no record, on leave, week-off…), so the list and the day's counts agree.
router.get('/punch-log', requirePerm(null, 'hrms', 'Attendance & Time', 'export'), async (req, res) => {
  const r = rangeOfQuery(req.query);
  if (r.error) return res.status(400).json({ error: r.error });
  const { from, to } = r;
  // "Checked In" (still inside) | "Checked Out" | blank = both.
  const statusFilter = ['Checked In', 'Checked Out'].includes(req.query.punchStatus) ? req.query.punchStatus : '';
  // Like the old Bio-Metric Logs screen: only person-days with punches, unless
  // ?absentees=1 asks for everyone on the rolls (their Time Interval is empty).
  const withAbsentees = req.query.absentees === '1' && !statusFilter;
  const rep = await dayReport(req, req.query, from, to);
  const cfg = rep.cfg;
  // Every punch of anyone in scope is listed (it is a log); the day status
  // says how that person's day counted.
  const employees = rep.all;
  const byId = Object.fromEntries(employees.map((e) => [e.id, e]));
  const [facts, latest] = await Promise.all([
    dayFacts(employees.map((e) => e.id), from, to),
    latestDataDate(employees.map((e) => e.id)),
  ]);

  const rows = [];
  [...facts.keysWithPunches].forEach((key) => {
    const [employeeId, date] = key.split('|');
    const e = byId[employeeId];
    const d = rep.at(employeeId, date);
    const ps0 = facts.punches(employeeId, date);
    const h = facts.history.get(key) || null;
    const day = daySplit(ps0);
    const disp = displayPunches(ps0, h);
    const ps = day.punches;
    const fin = day.checkIn;
    const lout = day.checkOut;
    const mins = fin && lout ? toMinutes(lout.time) - toMinutes(fin.time) : null;
    const spanSec = fin && lout ? toSeconds(clockOf(lout)) - toSeconds(clockOf(fin)) : null;
    rows.push({
      // The old Bio-Metric Logs columns.
      employeeLabel: e ? `${e.employeeCode} - ${e.name}` : '',
      designation: e?.designation || '',
      dateLabel: dmy(date),
      timeInterval: timeIntervalOf(ps0, h),
      date,
      employeeId,
      employeeCode: e?.employeeCode,
      name: e?.name,
      department: e?.department,
      role: roleLabelOf(e),
      hrStatus: e ? hrStatusOf(e.employmentStatus, e.user && e.user.status) : null,
      inLog: true,
      status: day.status || 'Imported',
      dayStatus: d ? d.status : null,
      bucket: bucketOf(d),
      bucketLabel: BUCKET_LABEL[bucketOf(d)] || (d ? d.status : '—'),
      late: d ? !!(d.late || d.status === 'Late') : false,
      checkIn: d ? d.checkIn : null,
      checkOut: d ? d.checkOut : null,
      punches: disp.list.length,
      punchRows: ps.length,
      imported: disp.imported,
      // Every check-in / check-out time, the imported log times included
      // (displayPunches(): display only, nothing stored changes).
      checkInTimes: disp.ins,
      checkOutTimes: disp.outs,
      importedTimes: h && h.punchTimes ? h.punchTimes.split('|') : null,
      firstIn: fin ? fin.time : '—',
      lastOut: lout ? lout.time : '—',
      firstInClock: fin ? clockOf(fin) : null,
      lastOutClock: lout ? clockOf(lout) : null,
      workedSpan: spanSec != null && spanSec >= 0 ? hms(spanSec) : null,
      hours: mins != null ? Number((mins / 60).toFixed(1)) : null,
      method: ps.length ? methodLabel(fin || ps[0]) : 'Imported CSV (old HRMS)',
      source: sourceOf(ps, null, h),
      location: (fin && fin.location) || '—',
      // HRMS-24 §5 — how the first check-in was verified, and where it was.
      verification: fin ? (fin.verificationStatus || (fin.method === 'Biometric' ? 'Device' : 'Not verified')) : '—',
      verificationScore: fin && fin.verificationScore != null ? fin.verificationScore : null,
      locationStatus: fin ? (fin.locationStatus || '—') : '—',
      imagePunchId: fin && fin.imageFile ? fin.id : null,
    });
  });
  // Everyone else on the rolls that day: no punch at all.
  if (withAbsentees) {
    eachDay(from, to).forEach((date) => {
      rep.employees.forEach((e) => {
        const key = facts.k(e.id, date);
        if (facts.keysWithPunches.has(key)) return;
        const d = rep.at(e.id, date);
        const bucket = bucketOf(d);
        if (!bucket) return;
        rows.push({
          employeeLabel: `${e.employeeCode} - ${e.name}`, designation: e.designation || '', dateLabel: dmy(date), timeInterval: '',
          date, employeeId: e.id, employeeCode: e.employeeCode, name: e.name, department: e.department, role: roleLabelOf(e),
          hrStatus: hrStatusOf(e.employmentStatus, e.user && e.user.status),
          inLog: false, status: null, dayStatus: bucket === 'noRecord' ? 'No record' : d.status, bucket, bucketLabel: BUCKET_LABEL[bucket],
          note: d.note || '', late: false, checkIn: d.checkIn || null, checkOut: d.checkOut || null,
          punches: 0, punchRows: 0, imported: false,
          checkInTimes: d.checkIn ? [d.checkIn] : [], checkOutTimes: d.checkOut ? [d.checkOut] : [], importedTimes: null,
          firstIn: '—', lastOut: '—', firstInClock: null, lastOutClock: null, workedSpan: null, hours: null,
          method: '—', source: facts.record.get(key) ? 'Marked by HR' : '—', location: '—',
          verification: '—', verificationScore: null, locationStatus: '—', imagePunchId: null,
        });
      });
    });
  }
  // The filter bar's Day status / Method / Source (review #3 §14); options
  // (facets) come from the rows before those three narrow them.
  const base = rows.filter((x) => !statusFilter || x.status === statusFilter);
  const facetOf = (fn) => [...new Set(base.map(fn).filter((v) => v && v !== '—'))].sort();
  const facets = { dayStatuses: facetOf((x) => x.dayStatus), methods: facetOf((x) => x.method), sources: facetOf((x) => x.source) };
  const shown = base
    .filter((x) => !req.query.dayStatus || x.dayStatus === String(req.query.dayStatus))
    .filter((x) => !req.query.method || x.method === String(req.query.method))
    .filter((x) => !req.query.source || x.source === String(req.query.source))
    // Employee by employee, dates ascending — the old Bio-Metric Logs order.
    .sort((a, b) => String(a.employeeCode).localeCompare(String(b.employeeCode), undefined, { numeric: true }) || a.date.localeCompare(b.date));

  // The date-wise totals: one line per date, from dayReport(). `punched`
  // there counts people on the rolls with a punch that day.
  const days = dayTotals(rep, from, to).map((t) => ({
    ...t,
    rows: shown.filter((x) => x.date === t.date).length,
    inLog: shown.filter((x) => x.date === t.date && x.inLog).length,
  }));

  // Export (CSV / Excel): exactly the rows on screen, with the same columns —
  // or, with ?view=days, the date-wise totals.
  const format = String(req.query.format || '').toLowerCase();
  if ((format === 'csv' || format === 'xlsx') && req.query.view === 'days') {
    const headers = ['Date', 'Day', 'Headcount (on the rolls)', 'Present', 'Late (of present)', 'Half Day', 'Absent', 'On Leave', 'Week-off / Holiday',
      'No record', 'Not checked in yet', 'Checked In', 'Checked Out', 'Missing Check-Out', 'People with punches'];
    const data = days.map((d) => [d.date, d.weekday, d.headcount, d.present, d.late, d.halfDay, d.absent, d.onLeave, d.offDay,
      d.noRecord, d.notYet, d.checkedIn, d.checkedOut, d.missingCheckOut, d.punched]);
    return sendTabular(res, format, `attendance-date-wise-${from}_to_${to}`, headers, data, 'Date-wise totals');
  }
  if (format === 'csv' || format === 'xlsx') {
    // Exactly the old Bio-Metric Logs columns (every row filled in, for Excel).
    const headers = ['Employee', 'Department', 'Designation', 'Attendance Date', 'Time Interval'];
    const data = shown.map((x) => [x.employeeLabel, x.department || '', x.designation || '', x.dateLabel, x.timeInterval]);
    return sendTabular(res, format, `bio-metric-logs-${from}_to_${to}`, headers, data, 'Bio-Metric Logs');
  }

  res.json({ from, to, today: rep.today, latestDataDate: latest, absentees: withAbsentees, days, rows: shown, facets });
});

// ---- Past attendance import (old HRMS CSV exports) — utils/attendanceHistoryImport.js ----
// The three CSVs arrive together as JSON sent as text/plain ({ files: [{ name,
// text }] }), so the global 100 kB JSON parser does not refuse them.
const historyUpload = express.text({ type: 'text/plain', limit: '60mb' });

function readHistoryFiles(req) {
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const files = (body && Array.isArray(body.files) ? body.files : [])
      .filter((f) => f && typeof f.text === 'string')
      .map((f) => ({ name: String(f.name || 'file.csv').slice(0, 200), text: f.text }));
    return files.length ? { files } : { error: 'Choose at least one CSV file.' };
  } catch {
    return { error: 'The upload could not be read.' };
  }
}

// What the preview / result screen needs: counts, the unmatched IDs, and the
// days that were not a plain create (conflicts first), without 5,000 rows.
function historyPlanView(p) {
  const pick = (action, n = 200) => p.items.filter((i) => i.action === action).slice(0, n).map((i) => ({
    employeeRef: i.employeeRef, employee: i.employee ? `${i.employee.name} (${i.employee.department || '—'})` : null,
    date: i.date, firstCheckIn: i.firstCheckIn || null, lastCheckOut: i.lastCheckOut || null,
    existingStatus: i.existing ? i.existing.status : null, result: i.result,
  }));
  return {
    files: p.files, problems: p.problems.slice(0, 100), problemCount: p.problems.length,
    days: p.days, summaries: p.summaries, unmatched: p.unmatched,
    conflicts: pick('conflict'), historyOnly: pick('history-only'), kept: pick('keep'), unmatchedDays: pick('unmatched', 100),
  };
}

// The three layouts the importer reads (utils/attendanceHistoryImport.js) —
// the same headers as the sample files on the Import History tab. A file must
// carry every REQUIRED header of one of them; the rest are optional.
const HISTORY_SAMPLES = [
  {
    kind: 'First Check-In & Last Check-Out report',
    required: ['Employee Ref No', 'Employee Name', 'Date', 'First Check In', 'Last Check Out'],
    headers: ['Employee Ref No', 'Employee Name', 'Date', 'First Check In', 'Last Check Out', 'Total Time Worked', 'Total Time In Break', 'Total Hours', 'Work Location'],
  },
  { kind: 'Bio-metric logs', required: ['Employee', 'Attendance Date', 'Time Interval'], headers: ['Employee', 'Attendance Date', 'Time Interval'] },
  {
    kind: 'Attendance summary',
    required: ['Employee Ref No', 'Employee Name', 'Present', 'Payable Days'],
    headers: ['Employee Ref No', 'Employee Name', 'Location', 'Half-Day', 'Present', 'Week Offs', 'Public Holidays', 'Leaves', 'Payable Days', 'Total Hours'],
    fileName: 'the period in the file name, e.g. attendance-summary_01-sep-2025_to_01-jan-2026.csv',
  },
];
function historyHeaderProblem(file) {
  const first = String(file.text || '').replace(/^﻿/, '').split(/\r?\n/)[0] || '';
  const head = first.split(',').map((h) => h.replace(/^"|"$/g, '').trim().toLowerCase());
  const has = (h) => head.includes(h.toLowerCase());
  const fits = (s) => s.required.every((h) => has(h) || (h === 'Employee Ref No' && s.kind !== 'Attendance summary' && has('Employee No')));
  const match = HISTORY_SAMPLES.find(fits);
  if (!match) {
    return `its headers (${first.slice(0, 160) || 'none'}) do not match any sample. Expected one of: ${HISTORY_SAMPLES.map((s) => `${s.kind} — ${s.headers.join(', ')}`).join(' | ')}.`;
  }
  if (match.kind === 'Attendance summary' && !/\d{2}-[a-z]{3}-\d{4}_to_\d{2}-[a-z]{3}-\d{4}/i.test(file.name)) {
    return 'an attendance summary needs its period in the file name, e.g. …_01-sep-2025_to_01-jan-2026.csv.';
  }
  return null;
}
router.get('/history/samples', requirePerm(null, 'hrms', 'Attendance & Time', 'export'), (req, res) => res.json(HISTORY_SAMPLES));

router.post('/history/import', historyUpload, requirePerm(null, 'hrms', 'Attendance & Time', 'configure'), async (req, res) => {
  const parsed = readHistoryFiles(req);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  // Every file must be one of the three sample layouts — nothing is guessed.
  const bad = parsed.files.map((f) => ({ name: f.name, why: historyHeaderProblem(f) })).filter((x) => x.why);
  if (bad.length) {
    return res.status(400).json({
      error: `${bad.map((b) => `${b.name}: ${b.why}`).join(' ')} Use one of the sample files on this page.`,
      expected: HISTORY_SAMPLES,
    });
  }
  const hist = require('../utils/attendanceHistoryImport');
  const p = await hist.plan(parsed.files);
  if (!p.files.report && !p.files.logs && !p.files.summary) {
    return res.status(400).json({ error: `None of the files is a recognised attendance export${p.files.unknown.length ? ` (${p.files.unknown.join(', ')})` : ''}.` });
  }
  if (req.query.dryRun === '1') return res.json({ preview: true, ...historyPlanView(p) });
  const result = await hist.apply(p, { userId: req.user.id });
  await logAudit({
    userId: req.user.id, action: 'Past attendance imported', entity: 'AttendanceHistory', entityId: result.batch,
    toValue: `${result.historyRows} day row(s), ${result.daysCreated} day(s) created, ${result.daysFilled} filled, ${result.punchesCreated} punch(es), ${result.summaryRows} summary row(s), ${p.unmatched.length} unmatched ID(s)`,
  });
  return res.json({ preview: false, result, ...historyPlanView(p) });
});

// The imported history. Name / department / designation come from Employee
// Management (current master data), never from the file.
router.get('/history', requirePerm(null, 'hrms', 'Attendance & Time', 'export'), async (req, res) => {
  const where = {};
  if (req.query.matchStatus) where.matchStatus = String(req.query.matchStatus);
  if (req.query.code) where.employeeRef = { contains: String(req.query.code) };
  if (req.query.result) where.result = { startsWith: String(req.query.result) };
  if (req.query.from || req.query.to) where.date = { ...(req.query.from ? { gte: String(req.query.from) } : {}), ...(req.query.to ? { lte: String(req.query.to) } : {}) };
  // In scope: a matched row only for an employee this login may see.
  const inScope = await scopedEmployees(req, {});
  const scopeIds = new Set(inScope.map((e) => e.id));
  const [all, everything] = await Promise.all([
    prisma.attendanceHistory.findMany({ where, orderBy: [{ date: 'desc' }, { employeeRef: 'asc' }] }),
    // "N of M rows": M = every imported row this login may see, unfiltered.
    prisma.attendanceHistory.findMany({ select: { employeeId: true } }),
  ]);
  const totalAll = everything.filter((h) => !h.employeeId || scopeIds.has(h.employeeId)).length;
  const byId = Object.fromEntries(inScope.map((e) => [e.id, e]));
  // Department (exact) and name (contains) come from Employee Management — or,
  // for an unmatched row, the name as written in the file.
  const wantDept = String(req.query.department || '');
  const wantName = String(req.query.name || '').trim().toLowerCase();
  const rows = all.filter((h) => !h.employeeId || scopeIds.has(h.employeeId)).filter((h) => {
    const e = h.employeeId ? byId[h.employeeId] : null;
    if (wantDept && (!e || e.department !== wantDept)) return false;
    if (wantName && !String((e ? e.name : h.sourceName) || '').toLowerCase().includes(wantName)) return false;
    return true;
  }).map((h) => {
    const e = h.employeeId ? byId[h.employeeId] : null;
    return {
      id: h.id, employeeRef: h.employeeRef, matchStatus: h.matchStatus,
      name: e ? e.name : null, department: e ? e.department : null, designation: e ? e.designation : null, role: e ? roleLabelOf(e) : null,
      nameInFile: h.matchStatus === 'Matched' ? null : h.sourceName,
      date: h.date, firstCheckIn: h.firstCheckIn, lastCheckOut: h.lastCheckOut, totalTimeWorked: h.totalTimeWorked,
      totalBreak: h.totalBreak, totalHours: h.totalHours, punchTimes: h.punchTimes ? h.punchTimes.split('|') : [],
      workLocation: h.workLocation, result: h.result, importBatch: h.importBatch,
    };
  });
  const format = String(req.query.format || '').toLowerCase();
  if (format === 'xlsx' || format === 'csv') {
    const headers = ['Employee ID', 'Match', 'Employee Name (Employee Management)', 'Department', 'Designation', 'Role', 'Name in file (unmatched only)',
      'Date', 'First Check In', 'Last Check Out', 'Total Time Worked', 'Total Time In Break', 'Total Hours', 'Punch Times', 'Work Location', 'Import result'];
    const data = rows.map((r) => [r.employeeRef, r.matchStatus, r.name || '', r.department || '', r.designation || '', r.role || '', r.nameInFile || '',
      r.date, r.firstCheckIn || '', r.lastCheckOut || '', r.totalTimeWorked || '', r.totalBreak || '', r.totalHours || '', r.punchTimes.join(' | '), r.workLocation || '', r.result]);
    res.setHeader('Content-Disposition', `attachment; filename="past-attendance-import.${format}"`);
    if (format === 'csv') return res.type('text/csv').send(toCsv(headers, data));
    return res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(toXlsx(headers, data, 'Past attendance'));
  }
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  res.json({ total: rows.length, totalAll, rows: rows.slice(offset, offset + limit) });
});

router.get('/history/summary', requirePerm(null, 'hrms', 'Attendance & Time', 'export'), async (req, res) => {
  const inScope = await scopedEmployees(req, {});
  const byId = Object.fromEntries(inScope.map((e) => [e.id, e]));
  const all = await prisma.attendanceHistorySummary.findMany({ orderBy: [{ periodFrom: 'desc' }, { employeeRef: 'asc' }] });
  res.json(all.filter((s) => !s.employeeId || byId[s.employeeId]).map((s) => {
    const e = s.employeeId ? byId[s.employeeId] : null;
    return {
      ...s, name: e ? e.name : null, department: e ? e.department : null, designation: e ? e.designation : null, role: e ? roleLabelOf(e) : null,
      nameInFile: s.matchStatus === 'Matched' ? null : s.sourceName,
    };
  }));
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
      hrStatus: hrStatusOf(e.employmentStatus, e.user && e.user.status),
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

// HRMS-24 §4/§5/§10/§11 — verified web/mobile check-in, My Attendance, team
// attendance and the monthly summary (routes/attendanceSelf.js).
registerSelfAttendance(router, { getConfig, methodsOf, CHECKIN_ASSIGNABLE, isSuperAdmin, ownEmployee });
// Late-login / missing-punch alerts: settings + today's dry-run preview (utils/attendanceAlerts.js).
require('../utils/attendanceAlerts').registerRoutes(router, { requirePerm });

module.exports = router;
