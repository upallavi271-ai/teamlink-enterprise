// ---------------------------------------------------------------------------
// DASHBOARD INSIGHTS + EMPLOYEE-DATA EXPORTS (hrms-24 §1, §3, §9).
//
//   GET /api/insights/:module          tiles + chart data for the range
//   GET /api/insights/:module/export   the rows behind them, as a file
//   GET /api/insights/employee/:id/summary   one person's summary (xlsx/csv/pdf)
//
// :module is attendance | leave | regularization | payroll | lms | timesheet |
// assets | performance | rewards | documents | ats.
//
// THREE RULES, THE SAME FOR EVERY MODULE
//
// 1. The DATE RANGE (?range=… or ?from=YYYY-MM-DD&to=YYYY-MM-DD, resolved by
//    utils/dateRange.js) is applied IN THE QUERY. Nothing is fetched whole and
//    filtered in the browser.
//
// 2. The DATA SCOPE is the screen's own. Each loader below starts from the
//    same helper the module's list endpoint uses — employeeWhere() /
//    employeeRecordWhere() for HRMS records (plus approval-chain membership
//    for leave and regularization, exactly as their lists do),
//    payslipReach() for payroll, tasks.viewable()/visibleWhere() for the
//    timesheet, assetWhere() for assets, applicationWhere() for ATS. A
//    department or employee filter is ANDed onto that scope — it can narrow
//    it, never widen it — and an employee outside it is a 403.
//
// 3. EXPORT needs the feature's `export` permission, EXCEPT an employee
//    exporting their OWN data: without the permission the export is pinned to
//    the caller's own employee record, and asking for anyone else is a 403.
//    Every export is audit-logged (utils/exportKit.js).
//
// The chart payloads are built from the SAME rows the export writes, so a
// chart can never disagree with the table behind it. Nothing here writes to
// the database except the audit rows.
// ---------------------------------------------------------------------------

const express = require('express');
const prisma = require('../db');
const { requireAuth, can } = require('../middleware/auth');
const {
  employeeWhere, employeeRecordWhere, employeeInScope, scopeLabel, applicationWhere,
  requirementWhere, OUT_OF_SCOPE,
} = require('../utils/scope');
const dateRange = require('../utils/dateRange');
const D = require('../utils/attendanceDays');
const workflow = require('../utils/approvalWorkflow');
const chain = require('../utils/chainRoute');
const { formatOf, sendTable } = require('../utils/exportKit');
const { groupOfStage } = require('../utils/pipelineView');
const { hrStatusOf } = require('../utils/hrStatus');
const { NOT_SYSTEM_EMPLOYEE } = require('../utils/systemAccounts');

const router = express.Router();
router.use(requireAuth);

// ---- small helpers ---------------------------------------------------------

const EXITED = ['Relieved', 'Exited', 'Exit Process'];
const MAX_DAY_RANGE = 366; // attendance / hours are computed day by day
const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const ymd = (v) => (v ? new Date(v).toISOString().slice(0, 10) : '');
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

class HttpError extends Error {
  constructor(status, body) { super(body.error); this.status = status; this.body = body; }
}
const bad = (msg) => new HttpError(400, { error: msg });

// Every handler is wrapped: an HttpError answers itself, anything else goes to
// the app's error handler (Express 4 does not catch async rejections).
const guarded = (fn) => (req, res, next) => fn(req, res).catch((err) => {
  if (err instanceof HttpError) return res.status(err.status).json(err.body);
  return next(err);
});

// The HRMS feature each module's view / export permission is asked of — the
// same feature the module's own screen is gated on.
const FEATURE = {
  attendance: 'Attendance & Time',
  regularization: 'Attendance & Time',
  leave: 'Leave & Holidays',
  payroll: 'Payroll & Compensation',
  lms: 'Performance & Development',
  performance: 'Performance & Development',
  rewards: 'Performance & Development',
  timesheet: 'Employee Services',
  assets: 'Employee Services',
  documents: 'Employee Services',
  employee: 'Employee Management',
};

// The range for a chart request: what was asked, or This Month when nothing
// was (a chart needs dates). For an export, no range means every date, except
// for the two day-by-day modules, which also fall back to This Month.
function periodFor(req, { optional = false } = {}) {
  const q = req.query || {};
  const asked = q.range || q.from || q.to;
  try {
    if (!asked || q.range === 'all') {
      return optional ? null : dateRange.resolve({ range: 'this_month' });
    }
    return dateRange.resolve(q);
  } catch (err) {
    if (err.status === 400) throw bad(err.message);
    throw err;
  }
}

function checkDays(period) {
  if (period && period.days > MAX_DAY_RANGE) {
    throw bad(`Pick a range of at most ${MAX_DAY_RANGE} days — attendance and hours are counted day by day.`);
  }
}

// Who the request is for. `self` pins it to the caller's own employee record:
// always for an export without the `export` permission, and for a chart when
// the caller asked for ?mine=1 (My Attendance and the other self screens).
async function reachOf(req, module, { forExport }) {
  const feature = FEATURE[module];
  const [mayView, mayExport] = await Promise.all([
    can(req.user, null, 'hrms', feature, 'view'),
    can(req.user, null, 'hrms', feature, 'export'),
  ]);
  const own = req.user.employeeId || null;
  const wantsSelf = req.query.mine === '1';
  if (forExport) {
    if (mayExport && !wantsSelf) return { self: null, feature, mayExport };
    // "An employee can export only their own data."
    if (!own) throw new HttpError(403, { error: 'Export is not included in your role’s permissions, and there is no employee record of your own to export.' });
    const asked = str(req.query.employeeId);
    if (asked && asked !== own) throw new HttpError(403, { error: 'You can export only your own data. Exporting other employees needs the export permission.' });
    return { self: own, feature, mayExport };
  }
  if (!mayView && !own) throw new HttpError(403, { error: "This area isn't included in your role's permissions" });
  // An HRMS self-only login's scope IS its own record; saying so up front
  // labels the charts "My own records" and drops the department filter.
  if (!mayView || wantsSelf || (req.user.caps && req.user.caps.hrmsSelfOnly)) return { self: own, feature, mayExport };
  return { self: null, feature, mayExport };
}

// The employees this request covers: the HRMS data scope, then the filters.
// An employeeId outside the scope is refused outright.
async function scopedEmployees(req, reach, { activeOnly = false } = {}) {
  const and = [employeeWhere(req.user)];
  if (!reach.self) and.push(NOT_SYSTEM_EMPLOYEE); // Super Admin is not headcount
  if (reach.self) and.push({ id: reach.self });
  const dept = str(req.query.department);
  if (dept) and.push({ department: dept });
  const asked = str(req.query.employeeId);
  if (asked) {
    const e = await prisma.employee.findFirst({ where: { AND: [{ id: asked }, employeeWhere(req.user)] }, select: { id: true } });
    if (!e) throw new HttpError(403, OUT_OF_SCOPE);
    and.push({ id: asked });
  }
  if (activeOnly) and.push({ employmentStatus: { notIn: EXITED } });
  return prisma.employee.findMany({
    where: { AND: and },
    select: {
      id: true, employeeCode: true, name: true, department: true, designation: true,
      dateOfJoining: true, employmentStatus: true, userId: true,
    },
    orderBy: { name: 'asc' },
  });
}

// The department dropdown: the departments inside this login's scope.
async function departmentOptions(req, reach) {
  if (reach.self) return [];
  const rows = await prisma.employee.findMany({
    where: employeeWhere(req.user), select: { department: true }, distinct: ['department'],
  });
  return rows.map((r) => r.department).filter(Boolean).sort();
}

// The narrowing an HRMS record list gets from ?department / ?employeeId / self,
// expressed on its `employee` relation.
function employeeFilter(req, reach) {
  const and = [];
  if (reach.self) and.push({ employeeId: reach.self });
  if (str(req.query.department)) and.push({ employee: { department: str(req.query.department) } });
  if (str(req.query.employeeId)) and.push({ employeeId: str(req.query.employeeId) });
  return and;
}

async function assertEmployeeInScope(req) {
  const asked = str(req.query.employeeId);
  if (!asked) return;
  const e = await prisma.employee.findUnique({ where: { id: asked } });
  if (!e || !employeeInScope(req.user, e)) throw new HttpError(403, OUT_OF_SCOPE);
}

// Time buckets for a trend: days up to a month, weeks (from Monday) up to
// four months, calendar months beyond.
function bucketsOf(period) {
  const unit = period.days <= 31 ? 'day' : period.days <= 120 ? 'week' : 'month';
  const keyOf = (d) => {
    const s = String(d).slice(0, 10);
    if (unit === 'day') return s;
    if (unit === 'month') return s.slice(0, 7);
    const dt = new Date(`${s}T00:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
    return dt.toISOString().slice(0, 10);
  };
  const labelOf = (k) => {
    if (unit === 'month') return `${MONTHS[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}`;
    const d = new Date(`${k}T00:00:00Z`);
    const txt = `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]}`;
    return unit === 'week' ? `Wk of ${txt}` : txt;
  };
  const keys = [];
  D.eachDay(period.from, period.to).forEach((d) => { const k = keyOf(d); if (keys[keys.length - 1] !== k) keys.push(k); });
  return { unit, keyOf, keys, labelOf };
}

// A trend chart's points, from rows that each carry a date and a value per
// series.
function trend(period, series, rows) {
  const b = bucketsOf(period);
  const at = new Map(b.keys.map((k) => [k, series.map(() => 0)]));
  rows.forEach((r) => {
    const vals = at.get(b.keyOf(r.date));
    if (vals) r.values.forEach((v, i) => { vals[i] += Number(v) || 0; });
  });
  return {
    bucket: b.unit, // day | week | month — not `unit`, which is the value unit (hours, money)
    rows: b.keys.map((k) => ({ label: b.labelOf(k), key: k, values: at.get(k).map(round1) })),
  };
}

// Count rows by a key, in a fixed order when one is given.
function countBy(list, keyOf, order) {
  const m = new Map();
  (order || []).forEach((k) => m.set(k, 0));
  list.forEach((x) => { const k = keyOf(x) || 'Not set'; m.set(k, (m.get(k) || 0) + 1); });
  return [...m.entries()].map(([label, value]) => ({ label, value }));
}

// Per-category stacked counts: rows = categories, values = one per series.
function stackBy(list, catOf, seriesOf, series) {
  const m = new Map();
  list.forEach((x) => {
    const c = catOf(x) || 'No department';
    const i = series.indexOf(seriesOf(x));
    if (i < 0) return;
    if (!m.has(c)) m.set(c, series.map(() => 0));
    m.get(c)[i] += 1;
  });
  return [...m.entries()]
    .map(([label, values]) => ({ label, values }))
    .sort((a, b) => b.values.reduce((s, v) => s + v, 0) - a.values.reduce((s, v) => s + v, 0));
}

const deptOf = (x) => (x.employee && x.employee.department) || x.department || 'No department';

// ---------------------------------------------------------------------------
// ATTENDANCE — one status per person per day (utils/attendanceDays.js), the
// same computation My Attendance, Team Attendance and the Monthly Summary use.
// ---------------------------------------------------------------------------

async function hrConfig() {
  return (await prisma.hrConfig.findFirst()) || prisma.hrConfig.create({ data: {} });
}

async function attendanceRows(req, reach, period) {
  checkDays(period);
  // The people ON THE ROLLS in the range (utils/attendanceDays.js rollOf) —
  // someone who has since left still counts for the days they worked, so a
  // past range agrees with the Attendance page's day report.
  const roll = await D.rollOf(prisma, await scopedEmployees(req, reach));
  const employees = roll.employees.filter((e) => D.onRolls(e, period.from, period.to, roll.lastDayOf));
  const cfg = await hrConfig();
  const { days } = await D.loadDays(prisma, { employees, from: period.from, to: period.to, cfg, lastDayOf: roll.lastDayOf, preview: true });
  return employees.map((e) => {
    const rows = days(e).filter((d) => !['Upcoming', 'Not Joined', 'Left'].includes(d.status));
    const summary = D.summarise(rows);
    const hours = round1(rows.reduce((s, d) => s + (Number(d.hours) || 0), 0));
    return { employee: e, rows, summary, hours, daysWithHours: rows.filter((d) => d.hours).length };
  });
}

const PRESENTISH = ['Present', 'Late', 'Early Logout'];
async function attendanceInsights(req, reach, period) {
  return buildAttendance(await attendanceRows(req, reach, period), period);
}

// Tiles + charts from per-employee day rows ({ employee, rows, summary }).
// Also used by the HRMS Dashboard, so its tiles and charts agree.
function buildAttendance(per, period) {
  const keys = ['workingDays', 'present', 'late', 'halfDay', 'absent', 'onLeave', 'missingCheckIn', 'missingCheckOut'];
  const t = Object.fromEntries(keys.map((k) => [k, per.reduce((n, p) => n + p.summary[k], 0)]));
  const allDays = per.flatMap((p) => p.rows.map((d) => ({ ...d, department: p.employee.department })));
  const S = ['Present', 'Half Day', 'Absent', 'On Leave', 'Missing punch'];
  const seriesOf = (d) => (PRESENTISH.includes(d.status) ? 'Present'
    : d.status === 'Missing Check-In' || d.status === 'Missing Check-Out' ? 'Missing punch'
      : String(d.status).startsWith('Half Day') ? 'Half Day' : d.status === 'Half Leave + Absent' ? 'On Leave' : d.status === 'Leave Under Review' ? 'Absent' : d.status);
  const counted = allDays.filter((d) => d.counted);
  return {
    employees: per.length,
    tiles: [
      { key: 'present', label: 'Present', value: t.present },
      { key: 'late', label: 'Late', value: t.late },
      { key: 'halfDay', label: 'Half Day', value: t.halfDay },
      { key: 'absent', label: 'Absent', value: t.absent },
      { key: 'onLeave', label: 'On Leave', value: t.onLeave },
      { key: 'missingCheckIn', label: 'Missing Check-In', value: t.missingCheckIn },
      { key: 'missingCheckOut', label: 'Missing Check-Out', value: t.missingCheckOut },
      // The Attendance screen's biometric check-in / check-out counts, as
      // person-days in the range (one day = the people who checked in).
      { key: 'checkedIn', label: 'Checked In', value: allDays.filter((d) => d.checkIn).length },
      { key: 'checkedOut', label: 'Checked Out', value: allDays.filter((d) => d.checkOut).length },
    ],
    totals: t,
    charts: [
      {
        id: 'att-status', kind: 'bar', title: 'Attendance by status', sub: 'Person-days in the range',
        rows: [
          { label: 'Present', value: t.present }, { label: 'Late', value: t.late },
          { label: 'Half Day', value: t.halfDay }, { label: 'Absent', value: t.absent },
          { label: 'On Leave', value: t.onLeave }, { label: 'Missing Check-In', value: t.missingCheckIn },
          { label: 'Missing Check-Out', value: t.missingCheckOut },
        ],
      },
      {
        id: 'att-trend', kind: 'trend', title: 'Present vs absent', sub: 'Person-days per period (Present includes Late)',
        series: ['Present', 'Absent', 'On Leave'],
        ...trend(period, ['Present', 'Absent', 'On Leave'], counted.map((d) => ({
          date: d.date,
          values: [PRESENTISH.includes(d.status) ? 1 : 0, d.status === 'Absent' ? 1 : 0, d.status === 'On Leave' ? 1 : 0],
        }))),
      },
      {
        id: 'att-dept', kind: 'stacked', title: 'Department-wise attendance', sub: 'Person-days by status',
        series: S, rows: stackBy(counted, (d) => d.department, seriesOf, S),
      },
    ],
  };
}

const DAY_HEADERS = ['Employee ID', 'Name', 'Department', 'Date', 'Check-In', 'Check-Out', 'Hours', 'Status', 'Method', 'Regularization', 'Note'];
const SUMMARY_HEADERS = ['Employee ID', 'Name', 'Department', 'Designation', 'Working Days', 'Present', 'Late', 'Half Day', 'Absent', 'On Leave', 'Missing Check-In', 'Missing Check-Out', 'Hours Worked'];

async function attendanceExport(req, reach, period) {
  const per = await attendanceRows(req, reach, period);
  // One person: every day. Several: one summary row each.
  if (per.length === 1) {
    const p = per[0];
    return {
      headers: DAY_HEADERS,
      rows: p.rows.map((d) => [p.employee.employeeCode, p.employee.name, p.employee.department, d.date, d.checkIn, d.checkOut, d.hours, d.status, d.method, d.regularization, d.note]),
      title: `Attendance — ${p.employee.name}`,
      name: `attendance-${p.employee.employeeCode}`,
    };
  }
  return {
    headers: SUMMARY_HEADERS,
    rows: per.map((p) => {
      const s = p.summary;
      return [p.employee.employeeCode, p.employee.name, p.employee.department, p.employee.designation, s.workingDays, s.present, s.late, s.halfDay, s.absent, s.onLeave, s.missingCheckIn, s.missingCheckOut, p.hours];
    }),
    title: 'Attendance summary',
    name: 'attendance-summary',
  };
}

// ---------------------------------------------------------------------------
// LEAVE — the Leave list's own visibility (scope OR on the request's chain),
// narrowed to requests OVERLAPPING the range.
// ---------------------------------------------------------------------------

async function leaveWhere(req, reach, period) {
  const scoped = employeeRecordWhere(req.user);
  const onMyChain = reach.self ? [] : await workflow.recordIdsForParticipant('leave', req.user.id);
  const and = [];
  if (Object.keys(scoped).length) and.push({ OR: onMyChain.length ? [scoped, { id: { in: onMyChain } }] : [scoped] });
  and.push(...employeeFilter(req, reach));
  if (period) and.push({ fromDate: { lte: period.to } }, { toDate: { gte: period.from } });
  // The Leave screens' own filter bar, so an export is exactly the rows on
  // screen. Each one only narrows.
  const q = req.query || {};
  if (str(q.type)) and.push({ type: str(q.type) });
  if (str(q.status)) and.push({ status: str(q.status) });
  if (str(q.code)) and.push({ employee: { employeeCode: { contains: str(q.code) } } });
  if (str(q.name)) and.push({ employee: { name: { contains: str(q.name) } } });
  // One-sided dates from the filter bar (overlap, like the screen).
  if (ISO_DAY.test(str(q.leaveFrom))) and.push({ toDate: { gte: str(q.leaveFrom) } });
  if (ISO_DAY.test(str(q.leaveTo))) and.push({ fromDate: { lte: str(q.leaveTo) } });
  return and.length ? { AND: and } : {};
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const LEAVE_STATUSES = ['Pending', 'Approved', 'Rejected', 'Cancelled'];
async function leaveRequests(req, reach, period) {
  await assertEmployeeInScope(req);
  const list = await prisma.leaveRequest.findMany({
    where: await leaveWhere(req, reach, period),
    include: {
      employee: {
        select: {
          employeeCode: true, name: true, department: true, designation: true, employmentStatus: true,
          user: { select: { status: true } },
        },
      },
    },
    orderBy: { fromDate: 'desc' },
  });
  // The HR status (Active / Notice Period / Exit …) is derived, so it is
  // matched here, on the server, over the full scoped set.
  const hr = str(req.query.empStatus);
  const role = str(req.query.role);
  return list.filter((l) => (!hr || hrStatusOf(l.employee?.employmentStatus, l.employee?.user?.status) === hr)
    && (!role || l.employee?.designation === role));
}

async function leaveInsights(req, reach, period) {
  const built = buildLeave(await leaveRequests(req, reach, period));
  // "Employees on Leave Today" — a now figure, not the range's: distinct
  // people with an approved request covering today, in the same scope and
  // department filter as the tiles beside it.
  const day = new Date().toISOString().slice(0, 10);
  const today = await leaveRequests(req, reach, { from: day, to: day });
  const onLeaveToday = new Set(today.filter((l) => l.status === 'Approved').map((l) => l.employeeId)).size;
  built.tiles.push({ key: 'onLeaveToday', label: 'On Leave Today (now)', value: onLeaveToday });
  return built;
}

// Tiles + charts from leave requests (each with employee.department). Also
// used by the HRMS Dashboard.
function buildLeave(list) {
  const by = (s) => list.filter((l) => l.status === s).length;
  const statusKey = (l) => (LEAVE_STATUSES.includes(l.status) ? l.status : 'Other');
  const S = ['Pending', 'Approved', 'Rejected', 'Other'];
  return {
    tiles: [
      { key: 'total', label: 'Leave Requests', value: list.length },
      { key: 'pending', label: 'Pending', value: by('Pending') },
      { key: 'approved', label: 'Approved', value: by('Approved') },
      { key: 'rejected', label: 'Rejected', value: by('Rejected') },
      { key: 'cancelled', label: 'Cancelled', value: by('Cancelled') },
      { key: 'cancelRequested', label: 'Cancellation Requests', value: by('Cancellation Requested') },
      { key: 'days', label: 'Approved Days', value: round1(list.filter((l) => l.status === 'Approved').reduce((s, l) => s + (Number(l.days) || 0), 0)) },
    ],
    charts: [
      {
        id: 'leave-type', kind: 'bar', title: 'Leave by type', sub: 'Requests overlapping the range',
        rows: countBy(list, (l) => l.type).sort((a, b) => b.value - a.value),
      },
      {
        id: 'leave-status', kind: 'bar', title: 'Pending vs approved vs rejected', sub: 'Requests overlapping the range',
        rows: countBy(list, statusKey, LEAVE_STATUSES).filter((r) => r.value > 0 || LEAVE_STATUSES.slice(0, 3).includes(r.label)),
      },
      {
        id: 'leave-dept', kind: 'stacked', title: 'Department-wise leave', sub: 'Requests by status (Other = cancelled or cancellation requested)',
        series: S, rows: stackBy(list, deptOf, (l) => (S.includes(l.status) ? l.status : 'Other'), S),
      },
    ],
  };
}

async function leaveExport(req, reach, period) {
  const list = await leaveRequests(req, reach, period);
  return {
    headers: ['Employee ID', 'Name', 'Department', 'Leave Type', 'From', 'To', 'Days', 'Status', 'Reason', 'Applied On', 'Decided By', 'Decided On'],
    rows: list.map((l) => [l.employee?.employeeCode, l.employee?.name, l.employee?.department, l.type, l.fromDate, l.toDate, l.days, l.status, l.reason, ymd(l.createdAt), l.decidedBy, ymd(l.decidedAt)]),
    title: 'Leave requests',
    name: 'leave-requests',
  };
}

// ---------------------------------------------------------------------------
// REGULARIZATION — the Regularization list's own visibility, by request date.
// ---------------------------------------------------------------------------

async function regularizationExport(req, reach, period) {
  await assertEmployeeInScope(req);
  const scoped = employeeRecordWhere(req.user);
  const onMyChain = reach.self ? [] : await chain.participantIds('regularization', req.user.id);
  const and = [];
  if (Object.keys(scoped).length) and.push({ OR: onMyChain.length ? [scoped, { id: { in: onMyChain } }] : [scoped] });
  and.push(...employeeFilter(req, reach));
  if (period) and.push({ date: { gte: period.from, lte: period.to } });
  // The Regularization tab's own filter bar — each one only narrows.
  const q = req.query || {};
  if (ISO_DAY.test(str(q.date))) and.push({ date: str(q.date) });
  if (str(q.status)) and.push({ status: str(q.status) });
  if (str(q.code)) and.push({ employee: { employeeCode: { contains: str(q.code) } } });
  if (str(q.name)) and.push({ employee: { name: { contains: str(q.name) } } });
  const all = await prisma.attendanceRegularization.findMany({
    where: and.length ? { AND: and } : {},
    include: { employee: { select: { employeeCode: true, name: true, department: true, employmentStatus: true } } },
    orderBy: { date: 'desc' },
  });
  const hr = str(q.empStatus);
  const list = hr ? all.filter((r) => hrStatusOf(r.employee?.employmentStatus) === hr) : all;
  return {
    headers: ['Employee ID', 'Name', 'Department', 'Date', 'Requested Check-In', 'Requested Check-Out', 'Reason', 'Status', 'Requested On', 'Decided On'],
    rows: list.map((r) => [r.employee?.employeeCode, r.employee?.name, r.employee?.department, r.date, r.requestedCheckIn, r.requestedCheckOut, r.reason, r.status, ymd(r.createdAt), ymd(r.decidedAt)]),
    title: 'Attendance regularization',
    name: 'regularization',
  };
}

// ---------------------------------------------------------------------------
// PAYROLL — payslipReach(), the rule GET /api/payroll uses. A payslip belongs
// to a month; it is in the range when its month overlaps it.
// ---------------------------------------------------------------------------

async function payslips(req, reach, period) {
  await assertEmployeeInScope(req);
  const { payslipReach, reachWhere } = require('./payroll');
  const and = [reachWhere(await payslipReach(req))];
  and.push(...employeeFilter(req, reach));
  if (period) and.push({ month: { gte: period.from.slice(0, 7), lte: period.to.slice(0, 7) } });
  // The Payslips tab's filter bar — narrowing only.
  if (str(req.query.code)) and.push({ employee: { employeeCode: { contains: str(req.query.code) } } });
  if (str(req.query.name)) and.push({ employee: { name: { contains: str(req.query.name) } } });
  // The same bar's search box (employee name OR ID), Month and Pay type.
  if (str(req.query.q)) {
    const q = str(req.query.q);
    and.push({ OR: [{ employee: { employeeCode: { contains: q } } }, { employee: { name: { contains: q } } }] });
  }
  if (/^\d{4}-\d{2}$/.test(str(req.query.month))) and.push({ month: str(req.query.month) });
  if (str(req.query.payMode)) {
    const pm = str(req.query.payMode);
    and.push(pm === 'Package' ? { OR: [{ payMode: 'Package' }, { payMode: null }] } : { payMode: pm });
  }
  return prisma.payslip.findMany({
    where: { AND: and },
    include: { employee: { select: { employeeCode: true, name: true, department: true } } },
    orderBy: [{ month: 'desc' }],
  });
}

async function payrollInsights(req, reach, period) {
  const list = await payslips(req, reach, period);
  const sum = (k) => Math.round(list.reduce((s, p) => s + (Number(p[k]) || 0), 0));
  const byDept = new Map();
  list.forEach((p) => { const d = deptOf(p); byDept.set(d, (byDept.get(d) || 0) + (Number(p.netPay) || 0)); });
  const months = [...new Set(list.map((p) => p.month))].sort();
  return {
    tiles: [
      { key: 'payslips', label: 'Payslips', value: list.length },
      { key: 'employees', label: 'Employees Paid', value: new Set(list.map((p) => p.employeeId)).size },
      { key: 'gross', label: 'Gross', value: sum('gross'), money: true },
      { key: 'deductions', label: 'Deductions', value: sum('deductions'), money: true },
      { key: 'net', label: 'Net Pay', value: sum('netPay'), money: true },
    ],
    charts: [
      {
        id: 'pay-dept', kind: 'bar', title: 'Net pay by department', sub: 'Payslips for months in the range', unit: 'money',
        rows: [...byDept.entries()].map(([label, value]) => ({ label, value: Math.round(value) })).sort((a, b) => b.value - a.value),
      },
      {
        id: 'pay-trend', kind: 'trend', title: 'Gross vs net by month', unit: 'money', series: ['Gross', 'Net Pay'],
        rows: months.map((m) => {
          const ps = list.filter((p) => p.month === m);
          return {
            label: `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`, key: m,
            values: [Math.round(ps.reduce((s, p) => s + (Number(p.gross) || 0), 0)), Math.round(ps.reduce((s, p) => s + (Number(p.netPay) || 0), 0))],
          };
        }),
      },
    ],
  };
}

async function payrollExport(req, reach, period) {
  const list = await payslips(req, reach, period);
  return {
    headers: ['Employee ID', 'Name', 'Department', 'Month', 'Working Days', 'LOP Days', 'Basic', 'HRA', 'Allowances', 'Gross', 'Deductions', 'Net Pay'],
    rows: list.map((p) => [p.employee?.employeeCode, p.employee?.name, p.employee?.department, p.month, p.workingDays, p.lopDays, Math.round(p.basic), Math.round(p.hra), Math.round(p.allowances), Math.round(p.gross || 0), Math.round(p.deductions), Math.round(p.netPay)]),
    title: 'Payslips',
    name: 'payslips',
  };
}

// ---------------------------------------------------------------------------
// LMS — course assignments made inside the range, and assessment attempts
// submitted inside it, for employees in scope (employeeWhere, as /lms does).
// ---------------------------------------------------------------------------

function learnerStatus(a) {
  if (a.completed) return 'Completed';
  if (a.startedAt || a.lastAccessedAt || a.watchedSeconds > 0 || a.attempts > 0 || a.contentCompletedAt) return 'In Progress';
  return 'Not Started';
}

async function lmsAssignments(req, reach, period) {
  await assertEmployeeInScope(req);
  const and = [{ employee: employeeWhere(req.user) }, ...employeeFilter(req, reach)];
  if (period) and.push({ assignedAt: dateRange.dateTimeIn(period) });
  return prisma.courseAssignment.findMany({
    where: { AND: and },
    include: {
      course: { select: { title: true, category: true, passMark: true } },
      employee: { select: { employeeCode: true, name: true, department: true } },
    },
    orderBy: { assignedAt: 'desc' },
  });
}

async function lmsInsights(req, reach, period) {
  const list = await lmsAssignments(req, reach, period);
  const ids = (await scopedEmployees(req, reach)).map((e) => e.id);
  const attempts = await prisma.courseAssessmentAttempt.findMany({
    where: { employeeId: { in: ids }, submittedAt: dateRange.dateTimeIn(period) },
    select: { passed: true, score: true, employeeId: true },
  });
  const S = ['Not Started', 'In Progress', 'Completed'];
  const passed = attempts.filter((a) => a.passed === true).length;
  const scored = attempts.filter((a) => a.score != null);
  return {
    tiles: [
      { key: 'enrolled', label: 'Enrolled', value: list.length },
      { key: 'notStarted', label: 'Not Started', value: list.filter((a) => learnerStatus(a) === 'Not Started').length },
      { key: 'inProgress', label: 'In Progress', value: list.filter((a) => learnerStatus(a) === 'In Progress').length },
      { key: 'completed', label: 'Completed', value: list.filter((a) => learnerStatus(a) === 'Completed').length },
      { key: 'passed', label: 'Assessments Passed', value: passed },
      { key: 'failed', label: 'Assessments Failed', value: attempts.length - passed },
      { key: 'avg', label: 'Average Score', value: scored.length ? `${Math.round(scored.reduce((s, a) => s + a.score, 0) / scored.length)}%` : '—' },
    ],
    charts: [
      {
        id: 'lms-status', kind: 'bar', title: 'Enrolled, in progress, completed', sub: 'Courses assigned in the range',
        rows: countBy(list, learnerStatus, S),
      },
      {
        id: 'lms-assess', kind: 'bar', title: 'Assessment results', sub: 'Attempts submitted in the range',
        rows: [{ label: 'Passed', value: passed }, { label: 'Failed', value: attempts.length - passed }],
      },
      {
        id: 'lms-dept', kind: 'stacked', title: 'Department-wise learning', sub: 'Assignments by status',
        series: S, rows: stackBy(list, deptOf, learnerStatus, S),
      },
    ],
  };
}

async function lmsExport(req, reach, period) {
  const list = await lmsAssignments(req, reach, period);
  return {
    headers: ['Employee ID', 'Name', 'Department', 'Course', 'Category', 'Assigned On', 'Assigned By', 'Due Date', 'Status', 'Attempts', 'Score', 'Pass Mark', 'Completed On', 'Last Accessed'],
    rows: list.map((a) => [a.employee?.employeeCode, a.employee?.name, a.employee?.department, a.course?.title, a.course?.category, ymd(a.assignedAt), a.assignedByName, ymd(a.dueDate), learnerStatus(a), a.attempts, a.score, a.course?.passMark, ymd(a.completedAt), ymd(a.lastAccessedAt)]),
    title: 'Learning (LMS)',
    name: 'lms-assignments',
  };
}

// ---------------------------------------------------------------------------
// TIMESHEET — the Timesheet's own reach (routes/tasks.js viewable() /
// visibleWhere()). Hours worked are the check-in → check-out hours of each
// day (attendanceDays.js); tasks are those whose window overlaps the range.
// ---------------------------------------------------------------------------

async function timesheetData(req, reach, period) {
  checkDays(period);
  const tasksRoute = require('./tasks');
  const view = await tasksRoute.viewable(req.user);
  let people = view.people.filter((p) => p.employeeId);
  if (reach.self) people = people.filter((p) => p.employeeId === reach.self);
  const dept = str(req.query.department);
  if (dept) people = people.filter((p) => p.department === dept);
  const asked = str(req.query.employeeId);
  if (asked) {
    if (!people.some((p) => p.employeeId === asked) && !view.global) throw new HttpError(403, OUT_OF_SCOPE);
    people = people.filter((p) => p.employeeId === asked);
  }
  const employees = await prisma.employee.findMany({
    where: {
      id: { in: people.map((p) => p.employeeId) },
      ...(view.global && dept ? { department: dept } : {}),
    },
    select: { id: true, employeeCode: true, name: true, department: true, designation: true, dateOfJoining: true, userId: true },
    orderBy: { name: 'asc' },
  });
  const cfg = await hrConfig();
  const { days } = await D.loadDays(prisma, { employees, from: period.from, to: period.to, cfg, preview: true });
  const visible = await tasksRoute.visibleWhere(req.user);
  const tasks = await prisma.task.findMany({
    where: {
      AND: [
        visible,
        { assigneeId: { in: employees.map((e) => e.userId).filter(Boolean) } },
        { OR: [{ endDate: null }, { endDate: { gte: period.from } }] },
        { OR: [{ startDate: null }, { startDate: { lte: period.to } }] },
      ],
    },
    select: { assigneeId: true, status: true, endDate: true },
  });
  const today = new Date().toISOString().slice(0, 10);
  const per = employees.map((e) => {
    const rows = days(e).filter((d) => d.hours);
    const mine = tasks.filter((t) => t.assigneeId === e.userId);
    return {
      employee: e,
      rows,
      hours: round1(rows.reduce((s, d) => s + d.hours, 0)),
      days: rows.length,
      tasks: mine.length,
      completed: mine.filter((t) => t.status === 'Completed').length,
      open: mine.filter((t) => ['Not Started', 'In Progress', 'On Hold'].includes(t.status)).length,
      overdue: mine.filter((t) => t.endDate && t.endDate < today && ['Not Started', 'In Progress', 'On Hold'].includes(t.status)).length,
    };
  });
  return { per, tasks };
}

async function timesheetInsights(req, reach, period) {
  const { per, tasks } = await timesheetData(req, reach, period);
  const hours = round1(per.reduce((s, p) => s + p.hours, 0));
  const dayCount = per.reduce((s, p) => s + p.days, 0);
  const byDept = new Map();
  per.forEach((p) => { const d = p.employee.department || 'No department'; byDept.set(d, round1((byDept.get(d) || 0) + p.hours)); });
  return {
    tiles: [
      { key: 'hours', label: 'Hours Worked', value: hours },
      { key: 'days', label: 'Days With Hours', value: dayCount },
      { key: 'avg', label: 'Avg Hours / Day', value: dayCount ? round1(hours / dayCount) : 0 },
      { key: 'tasks', label: 'Tasks', value: tasks.length },
      { key: 'completed', label: 'Completed', value: tasks.filter((t) => t.status === 'Completed').length },
      { key: 'overdue', label: 'Overdue', value: per.reduce((s, p) => s + p.overdue, 0) },
    ],
    charts: [
      {
        id: 'ts-trend', kind: 'trend', title: 'Hours worked', sub: 'Check-in to check-out hours', unit: 'hours', series: ['Hours'],
        ...trend(period, ['Hours'], per.flatMap((p) => p.rows.map((d) => ({ date: d.date, values: [d.hours] })))),
      },
      {
        id: 'ts-dept', kind: 'bar', title: 'Hours by department', unit: 'hours',
        rows: [...byDept.entries()].map(([label, value]) => ({ label, value })).filter((r) => r.value > 0).sort((a, b) => b.value - a.value),
      },
      {
        id: 'ts-emp', kind: 'bar', title: 'Hours by employee', sub: 'Top 12 in the range', unit: 'hours',
        rows: per.filter((p) => p.hours > 0).sort((a, b) => b.hours - a.hours).slice(0, 12).map((p) => ({ label: p.employee.name, value: p.hours })),
      },
    ],
  };
}

async function timesheetExport(req, reach, period) {
  const { per } = await timesheetData(req, reach, period);
  if (per.length === 1) {
    const p = per[0];
    return {
      headers: ['Employee ID', 'Name', 'Department', 'Date', 'Check-In', 'Check-Out', 'Hours', 'Status'],
      rows: p.rows.map((d) => [p.employee.employeeCode, p.employee.name, p.employee.department, d.date, d.checkIn, d.checkOut, d.hours, d.status]),
      title: `Timesheet — ${p.employee.name}`,
      name: `timesheet-${p.employee.employeeCode}`,
    };
  }
  return {
    headers: ['Employee ID', 'Name', 'Department', 'Designation', 'Days With Hours', 'Hours Worked', 'Avg Hours / Day', 'Tasks', 'Completed', 'Open', 'Overdue'],
    rows: per.map((p) => [p.employee.employeeCode, p.employee.name, p.employee.department, p.employee.designation, p.days, p.hours, p.days ? round1(p.hours / p.days) : 0, p.tasks, p.completed, p.open, p.overdue]),
    title: 'Timesheet summary',
    name: 'timesheet-summary',
  };
}

// ---------------------------------------------------------------------------
// ASSETS — assetWhere(), the Asset Report's own scope. Status is NOW; the
// range dates the movements (assigned / returned inside it).
// ---------------------------------------------------------------------------

async function assetInsights(req, reach, period) {
  const { assetWhere } = require('./assetInventory');
  const q = { department: str(req.query.department), employeeCode: '' };
  const and = [assetWhere(req.user, q)];
  if (reach.self) and.push({ assignedToId: reach.self });
  const all = await prisma.asset.findMany({
    where: { AND: and },
    include: { assignedTo: { select: { department: true } } },
  });
  const within = (v) => { const d = ymd(v); return !!d && d >= period.from && d <= period.to; };
  const status = (s) => all.filter((a) => a.status === s).length;
  const assignedIn = all.filter((a) => within(a.assignedAt)).length;
  const returnedIn = all.filter((a) => within(a.returnedAt)).length;
  const byDept = countBy(all.filter((a) => a.status === 'Assigned'), (a) => (a.assignedTo && a.assignedTo.department) || 'No department')
    .sort((a, b) => b.value - a.value);
  return {
    tiles: [
      { key: 'total', label: 'Assets (now)', value: all.length },
      { key: 'assigned', label: 'Assigned (now)', value: status('Assigned') },
      { key: 'available', label: 'Available (now)', value: status('Available') },
      { key: 'repair', label: 'In Maintenance (now)', value: status('In Repair') },
      { key: 'assignedIn', label: 'Assigned in range', value: assignedIn },
      { key: 'returnedIn', label: 'Returned in range', value: returnedIn },
    ],
    charts: [
      {
        id: 'asset-status', kind: 'bar', title: 'Assigned, available, maintenance', sub: 'Current status',
        rows: [
          { label: 'Assigned', value: status('Assigned') }, { label: 'Available', value: status('Available') },
          { label: 'Maintenance', value: status('In Repair') }, { label: 'Retired', value: status('Retired') },
        ],
      },
      {
        id: 'asset-moves', kind: 'bar', title: 'Assigned vs returned', sub: 'Movements inside the range',
        rows: [{ label: 'Assigned', value: assignedIn }, { label: 'Returned', value: returnedIn }],
      },
      { id: 'asset-dept', kind: 'bar', title: 'Assigned assets by department', sub: 'Current holders', rows: byDept },
    ],
  };
}

// ---------------------------------------------------------------------------
// PERFORMANCE / REWARDS — recognition records (/api/recognition's scope),
// nominations (/api/recognition-nominations' scope) and performance reviews
// (/api/performance's scope), dated inside the range.
// ---------------------------------------------------------------------------

async function rewardsData(req, reach, period) {
  await assertEmployeeInScope(req);
  const narrow = employeeFilter(req, reach);
  const recAnd = [{ type: 'RECOGNITION' }, employeeRecordWhere(req.user), ...narrow];
  const revAnd = [employeeRecordWhere(req.user), ...narrow];
  if (period) {
    recAnd.push({ createdAt: dateRange.dateTimeIn(period) });
    revAnd.push({ createdAt: dateRange.dateTimeIn(period) });
  }
  // Nominations: the list's rule — nominees in scope, or ones I raised.
  const nomAnd = [];
  if (reach.self) nomAnd.push({ nomineeId: reach.self });
  else {
    const where = employeeWhere(req.user);
    if (Object.keys(where).length) {
      const ids = (await prisma.employee.findMany({ where, select: { id: true } })).map((e) => e.id);
      nomAnd.push({ OR: [{ nomineeId: { in: ids } }, { nominatedById: req.user.id }] });
    }
  }
  if (str(req.query.department)) nomAnd.push({ nomineeDepartment: str(req.query.department) });
  if (str(req.query.employeeId)) nomAnd.push({ nomineeId: str(req.query.employeeId) });
  if (period) nomAnd.push({ nominationDate: { gte: period.from, lte: period.to } });
  const [recognitions, nominations, reviews] = await Promise.all([
    prisma.employeeRecord.findMany({ where: { AND: recAnd }, include: { employee: { select: { employeeCode: true, name: true, department: true } } }, orderBy: { createdAt: 'desc' } }),
    prisma.recognitionNomination.findMany({ where: nomAnd.length ? { AND: nomAnd } : {}, orderBy: { nominationDate: 'desc' } }),
    prisma.performanceReview.findMany({ where: { AND: revAnd }, include: { employee: { select: { employeeCode: true, name: true, department: true } } }, orderBy: { createdAt: 'desc' } }),
  ]);
  return { recognitions, nominations, reviews };
}

async function rewardsInsights(req, reach, period) {
  const { recognitions, nominations, reviews } = await rewardsData(req, reach, period);
  const S = ['Recognitions', 'Nominations'];
  const both = [
    ...recognitions.map((r) => ({ date: ymd(r.createdAt), dept: deptOf(r), kind: 'Recognitions' })),
    ...nominations.map((n) => ({ date: n.nominationDate, dept: n.nomineeDepartment || 'No department', kind: 'Nominations' })),
  ];
  const scored = reviews.filter((r) => r.score != null);
  const b = bucketsOf(period);
  const avgRows = b.keys.map((k) => {
    const xs = scored.filter((r) => b.keyOf(ymd(r.createdAt)) === k);
    return { label: b.labelOf(k), key: k, values: [xs.length ? Math.round(xs.reduce((s, r) => s + r.score, 0) / xs.length) : 0] };
  });
  return {
    tiles: [
      { key: 'recognitions', label: 'Recognitions', value: recognitions.length },
      { key: 'points', label: 'Points Awarded', value: recognitions.reduce((s, r) => s + (Number(r.points) || 0), 0) },
      { key: 'nominations', label: 'Nominations', value: nominations.length },
      { key: 'awarded', label: 'Awarded', value: nominations.filter((n) => n.status === 'Awarded').length },
      { key: 'reviews', label: 'Performance Reviews', value: reviews.length },
      { key: 'avgScore', label: 'Avg Review Score', value: scored.length ? Math.round(scored.reduce((s, r) => s + r.score, 0) / scored.length) : '—' },
      // The Performance Reports screen's bands and recommendations, for the
      // reviews recorded in the range (band / recommendation as stored).
      { key: 'highBand', label: 'High Performers', value: reviews.filter((r) => r.band === 'High').length },
      { key: 'mediumBand', label: 'Medium Band', value: reviews.filter((r) => r.band === 'Medium').length },
      { key: 'lowBand', label: 'Low Band', value: reviews.filter((r) => r.band === 'Low').length },
      { key: 'recommended', label: 'Salary Increase Recommended', value: reviews.filter((r) => r.recommendation === 'Recommended').length },
      { key: 'notRecommended', label: 'Not Recommended', value: reviews.filter((r) => r.recommendation === 'Not Recommended').length },
    ],
    charts: [
      {
        id: 'rw-trend', kind: 'trend', title: 'Recognition trend', series: S,
        ...trend(period, S, both.map((x) => ({ date: x.date, values: [x.kind === S[0] ? 1 : 0, x.kind === S[1] ? 1 : 0] }))),
      },
      {
        id: 'rw-dept', kind: 'stacked', title: 'Department-wise recognition', series: S,
        rows: stackBy(both, (x) => x.dept, (x) => x.kind, S),
      },
      {
        id: 'rw-status', kind: 'bar', title: 'Nominations by status',
        rows: countBy(nominations, (n) => n.status, ['Pending Review', 'Approved', 'Rejected', 'Awarded']),
      },
      {
        id: 'perf-trend', kind: 'trend', title: 'Average review score', sub: 'Reviews recorded in the range (0–100)', series: ['Avg score'],
        rows: scored.length ? avgRows : [], bucket: b.unit,
      },
    ],
  };
}

async function rewardsExport(req, reach, period) {
  const { recognitions, nominations } = await rewardsData(req, reach, period);
  return {
    headers: ['Date', 'Kind', 'Employee ID', 'Name', 'Department', 'Title / Type', 'Status', 'Points', 'Given / Nominated By'],
    rows: [
      ...recognitions.map((r) => [ymd(r.createdAt), 'Recognition', r.employee?.employeeCode, r.employee?.name, r.employee?.department, r.title, r.status, r.points, r.fromName]),
      ...nominations.map((n) => [n.nominationDate, 'Nomination', n.nomineeCode, n.nomineeName, n.nomineeDepartment, n.recognitionType, n.status, '', n.nominatedByName]),
    ].sort((a, b) => String(b[0]).localeCompare(String(a[0]))),
    title: 'Rewards & recognition',
    name: 'rewards',
  };
}

async function performanceExport(req, reach, period) {
  const { reviews } = await rewardsData(req, reach, period);
  return {
    headers: ['Employee ID', 'Name', 'Department', 'Period', 'Score', 'Band', 'Recommendation', 'Approval', 'Notes', 'Recorded On'],
    rows: reviews.map((r) => [r.employee?.employeeCode, r.employee?.name, r.employee?.department, r.period, r.score, r.band, r.recommendation, r.approvalStatus, r.notes, ymd(r.createdAt)]),
    title: 'Performance reviews',
    name: 'performance-reviews',
  };
}

// ---------------------------------------------------------------------------
// DOCUMENTS — each in-scope employee's documents on file, and their policy
// acknowledgments.
// ---------------------------------------------------------------------------

async function documentsExport(req, reach, period) {
  const employees = await scopedEmployees(req, reach);
  const ids = employees.map((e) => e.id);
  const byId = new Map(employees.map((e) => [e.id, e]));
  const when = period ? dateRange.dateTimeIn(period) : undefined;
  const [docs, acks] = await Promise.all([
    prisma.employeeDocument.findMany({
      where: { employeeId: { in: ids }, ...(when ? { uploadedAt: when } : {}) },
      select: { employeeId: true, docType: true, docName: true, fileName: true, uploadedBy: true, uploadedAt: true },
      orderBy: { uploadedAt: 'desc' },
    }),
    prisma.acknowledgment.findMany({
      where: { employeeId: { in: ids }, ...(when ? { acknowledgedAt: when } : {}) },
      include: { document: { select: { title: true, category: true } } },
      orderBy: { acknowledgedAt: 'desc' },
    }),
  ]);
  const who = (id) => byId.get(id) || {};
  return {
    headers: ['Employee ID', 'Name', 'Department', 'Record', 'Document', 'Type / Category', 'File', 'Date', 'By'],
    rows: [
      ...docs.map((d) => [who(d.employeeId).employeeCode, who(d.employeeId).name, who(d.employeeId).department, 'Document on file', d.docName || d.docType, d.docType, d.fileName, ymd(d.uploadedAt), d.uploadedBy]),
      ...acks.map((a) => [who(a.employeeId).employeeCode, who(a.employeeId).name, who(a.employeeId).department, 'Policy acknowledged', a.document?.title, a.document?.category, '', ymd(a.acknowledgedAt), who(a.employeeId).name]),
    ],
    title: 'Employee documents',
    name: 'employee-documents',
  };
}

// ---------------------------------------------------------------------------
// ATS — applications in scope (applicationWhere, as /api/dashboard). Every
// figure is something that HAPPENED inside the range: applications received,
// candidates moved into screening / selected / rejected (stage events),
// interviews held and joinings — the last two by the same rule as the
// dashboard's own "Interviews — <range>" and "Joined — <range>" rows.
// ---------------------------------------------------------------------------

const SCREENING_GROUPS = ['ai_interview', 'recruiter_review', 'tl_review', 'bde_review', 'client_review'];
const JOINED_STAGES = ['JOINED', 'HIRED'];

async function atsInsights(req, period) {
  if (!(req.user.products || {}).ats) throw new HttpError(403, { error: 'Your login does not include ATS access' });
  // A client or candidate sees its own shared pipeline, never the internal
  // traffic (screening moves, rejections) these charts count.
  if (['CLIENT', 'CANDIDATE'].includes(req.user.role) || ['CLIENT', 'CANDIDATE'].includes(req.user.atsRole)) {
    throw new HttpError(403, { error: 'This area is not part of your access' });
  }
  const when = dateRange.dateTimeIn(period);
  const dept = str(req.query.department);
  const scope = { AND: [applicationWhere(req.user), ...(dept ? [{ requirement: { is: { department: dept } } }] : [])] };
  const inScope = (extra) => ({ AND: [scope, extra] });
  const [apps, events, interviews, joined, reqDepts] = await Promise.all([
    // requirementId, not the relation: the department is looked up once per
    // distinct requirement below rather than once per application.
    prisma.application.findMany({ where: inScope({ createdAt: when }), select: { createdAt: true, requirementId: true } }),
    prisma.applicationStageEvent.findMany({
      where: { createdAt: when, fromStage: { not: null }, application: { is: scope } },
      select: { applicationId: true, toStage: true },
    }),
    prisma.application.count({ where: inScope({ interviewAt: when, OR: [{ interviewStatus: null }, { interviewStatus: { notIn: ['CANCELLED', 'NO_SHOW'] } }] }) }),
    prisma.application.count({ where: inScope({ stage: { in: JOINED_STAGES }, OR: [{ joiningDate: dateRange.dayStringIn(period) }, { joiningDate: null, joinedAt: when }] }) }),
    prisma.requirement.findMany({ where: requirementWhere(req.user), select: { department: true }, distinct: ['department'] }),
  ]);
  const reqIds = [...new Set(apps.map((a) => a.requirementId))];
  const deptById = new Map((reqIds.length
    ? await prisma.requirement.findMany({ where: { id: { in: reqIds } }, select: { id: true, department: true } })
    : []).map((r) => [r.id, r]));
  apps.forEach((a) => { a.requirement = deptById.get(a.requirementId) || null; }); // eslint-disable-line no-param-reassign
  const distinct = (pred) => new Set(events.filter(pred).map((e) => e.applicationId)).size;
  const screening = distinct((e) => { const g = groupOfStage(e.toStage); return !!g && SCREENING_GROUPS.includes(g.id); });
  const selected = distinct((e) => e.toStage === 'SELECTED');
  const rejected = distinct((e) => e.toStage === 'REJECTED');
  const funnel = [
    { label: 'Applications', value: apps.length },
    { label: 'Screening', value: screening },
    { label: 'Interviews', value: interviews },
    { label: 'Selected', value: selected },
    { label: 'Joined', value: joined },
    { label: 'Rejected', value: rejected },
  ];
  return {
    departments: reqDepts.map((r) => r.department).filter(Boolean).sort(),
    tiles: funnel.map((f) => ({ key: f.label.toLowerCase(), label: f.label, value: f.value })),
    charts: [
      { id: 'ats-funnel', kind: 'bar', title: 'Hiring activity', sub: 'What happened inside the range', rows: funnel },
      {
        id: 'ats-trend', kind: 'trend', title: 'Applications received', series: ['Applications'],
        ...trend(period, ['Applications'], apps.map((a) => ({ date: ymd(a.createdAt), values: [1] }))),
      },
      {
        id: 'ats-dept', kind: 'bar', title: 'Applications by department', sub: 'Requirement department',
        rows: countBy(apps, (a) => a.requirement && a.requirement.department).sort((a, b) => b.value - a.value),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// THE ROUTES
// ---------------------------------------------------------------------------

const INSIGHTS = {
  attendance: attendanceInsights,
  leave: leaveInsights,
  payroll: payrollInsights,
  lms: lmsInsights,
  timesheet: timesheetInsights,
  assets: assetInsights,
  performance: rewardsInsights,
  rewards: rewardsInsights,
};

const EXPORTS = {
  attendance: { fn: attendanceExport, what: 'Attendance', entity: 'Attendance', needsRange: true },
  leave: { fn: leaveExport, what: 'Leave requests', entity: 'LeaveRequest' },
  regularization: { fn: regularizationExport, what: 'Regularization requests', entity: 'AttendanceRegularization' },
  payroll: { fn: payrollExport, what: 'Payslips', entity: 'Payslip' },
  lms: { fn: lmsExport, what: 'LMS assignments', entity: 'CourseAssignment' },
  timesheet: { fn: timesheetExport, what: 'Timesheet', entity: 'Task', needsRange: true },
  performance: { fn: performanceExport, what: 'Performance reviews', entity: 'PerformanceReview' },
  rewards: { fn: rewardsExport, what: 'Rewards & recognition', entity: 'RecognitionNomination' },
  documents: { fn: documentsExport, what: 'Employee documents', entity: 'EmployeeDocument' },
};

// ONE EMPLOYEE'S SUMMARY — profile, and attendance / leave / learning /
// assets / payslips inside the range. For the person themselves, or anyone
// holding Employee Management export with that person in scope.
router.get('/employee/:id/summary', guarded(async (req, res) => {
  const format = formatOf(req.query);
  if (!format) throw bad('format must be xlsx, csv or pdf');
  const e = await prisma.employee.findUnique({ where: { id: req.params.id }, include: { reportingManager: { select: { name: true } } } });
  if (!e) throw new HttpError(404, { error: 'Employee not found' });
  const own = req.user.employeeId === e.id;
  if (!own) {
    if (!(await can(req.user, null, 'hrms', 'Employee Management', 'export'))) {
      throw new HttpError(403, { error: 'Export is not included in your role’s permissions.' });
    }
    if (!employeeInScope(req.user, e)) throw new HttpError(403, OUT_OF_SCOPE);
  }
  const period = periodFor(req);
  checkDays(period);
  const cfg = await hrConfig();
  const { days } = await D.loadDays(prisma, { employees: [e], from: period.from, to: period.to, cfg, preview: true });
  const att = D.summarise(days(e).filter((d) => !['Upcoming', 'Not Joined'].includes(d.status)));
  const [leave, courses, assets, slips] = await Promise.all([
    prisma.leaveRequest.findMany({ where: { employeeId: e.id, fromDate: { lte: period.to }, toDate: { gte: period.from } } }),
    prisma.courseAssignment.findMany({ where: { employeeId: e.id }, include: { course: { select: { title: true } } } }),
    prisma.asset.findMany({ where: { assignedToId: e.id } }),
    prisma.payslip.findMany({ where: { employeeId: e.id, month: { gte: period.from.slice(0, 7), lte: period.to.slice(0, 7) } } }),
  ]);
  const rows = [
    ['Profile', 'Employee ID', e.employeeCode], ['Profile', 'Name', e.name], ['Profile', 'Department', e.department],
    ['Profile', 'Designation', e.designation], ['Profile', 'Reporting Manager', e.reportingManager?.name],
    ['Profile', 'Employment Status', e.employmentStatus], ['Profile', 'Date of Joining', ymd(e.dateOfJoining)],
    ['Attendance', 'Working days', att.workingDays], ['Attendance', 'Present', att.present], ['Attendance', 'Late', att.late],
    ['Attendance', 'Half Day', att.halfDay], ['Attendance', 'Absent', att.absent], ['Attendance', 'On Leave', att.onLeave],
    ['Attendance', 'Missing Check-In', att.missingCheckIn], ['Attendance', 'Missing Check-Out', att.missingCheckOut],
    ['Leave', 'Requests in range', leave.length],
    ['Leave', 'Approved days', round1(leave.filter((l) => l.status === 'Approved').reduce((s, l) => s + (Number(l.days) || 0), 0))],
    ['Leave', 'Pending', leave.filter((l) => l.status === 'Pending').length],
    ...courses.map((c) => ['Learning', c.course?.title, `${learnerStatus(c)}${c.score != null ? ` · score ${c.score}` : ''}`]),
    ...assets.map((a) => ['Assets held', `${a.assetCode} ${a.name}`, a.category]),
    ...slips.map((p) => ['Payslips', p.month, `Net ${Math.round(p.netPay)}`]),
  ];
  return sendTable(req, res, {
    format,
    name: `employee-summary-${e.employeeCode}`,
    title: `Employee summary — ${e.name} (${e.employeeCode})`,
    headers: ['Section', 'Item', 'Value'],
    rows,
    sheet: 'Summary',
    entity: 'Employee',
    what: `Employee summary (${e.employeeCode})`,
    scope: own ? 'Own record' : scopeLabel(req.user),
    period,
  });
}));

router.get('/:module/export', guarded(async (req, res) => {
  const spec = EXPORTS[req.params.module];
  if (!spec) throw new HttpError(404, { error: 'Unknown export' });
  const format = formatOf(req.query);
  if (!format) throw bad('format must be xlsx, csv or pdf');
  const reach = await reachOf(req, req.params.module, { forExport: true });
  const period = periodFor(req, { optional: !spec.needsRange });
  const out = await spec.fn(req, reach, period);
  return sendTable(req, res, {
    format,
    name: out.name,
    title: out.title,
    headers: out.headers,
    rows: out.rows,
    sheet: out.title,
    entity: spec.entity,
    what: spec.what,
    scope: reach.self ? 'Own data' : scopeLabel(req.user),
    period,
  });
}));

router.get('/:module', guarded(async (req, res) => {
  const module = req.params.module;
  const period = periodFor(req);
  if (module === 'ats') {
    const data = await atsInsights(req, period);
    return res.json({ module, period, scope: scopeLabel(req.user), self: false, canExport: false, ...data });
  }
  const fn = INSIGHTS[module];
  if (!fn) throw new HttpError(404, { error: 'Unknown dashboard' });
  const reach = await reachOf(req, module, { forExport: false });
  const [data, departments] = await Promise.all([fn(req, reach, period), departmentOptions(req, reach)]);
  return res.json({
    module,
    period,
    scope: reach.self ? 'My own records' : scopeLabel(req.user),
    self: !!reach.self,
    departments,
    // The export button is offered to anyone: with the permission it takes
    // the scope, without it the caller's own rows.
    canExport: !!reach.mayExport,
    ...data,
  });
}));

module.exports = router;
module.exports.buildAttendance = buildAttendance;
module.exports.buildLeave = buildLeave;
module.exports.MAX_DAY_RANGE = MAX_DAY_RANGE;
