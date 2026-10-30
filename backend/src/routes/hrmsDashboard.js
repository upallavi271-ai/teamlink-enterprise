const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm, can } = require('../middleware/auth');
const { toCsv, toXlsx } = require('../utils/tabularExport');
const { notifyDataIo } = require('../utils/dataIoNotify');
const { logAudit } = require('../utils/audit');
const { employeeWhere } = require('../utils/scope');
const { HR_STATUSES, hrStatusOf } = require('../utils/hrStatus');
const dateRange = require('../utils/dateRange');
const D = require('../utils/attendanceDays');
const halfLeave = require('../utils/halfDayLeave');
const LP = require('../utils/latePermission');
const LP_STATES = LP.STATE_KEYS;
const leaveReconcile = require('../utils/leaveReconcile');
const { halfOf } = require('../utils/leaveText');
const leaveGenuine = require('../utils/leaveGenuine'); // 2026-10-13: Pending Approvals count only GENUINE pending leave
const { withoutSystemAccounts } = require('../utils/systemAccounts');
const { activeDepartmentSet, filterActiveDepartments } = require('../utils/masters');

const router = express.Router();
router.use(requireAuth);

const DAY_MS = 86400000;

// WHEN IS THE NEXT ANNIVERSARY of a date (a birthday, a joining date)?
// All in UTC so the answer never depends on the server's time zone: the old
// version mixed a UTC "today" with a local-midnight anniversary, which on an
// IST server put today's birthdays 5.5 hours in the past and rolled them to
// next year — people whose birthday is TODAY never appeared.
// Returns { days, on } (days until it; on = that date, YYYY-MM-DD) or null.
function nextAnniversary(dateStr, todayStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  const now = Date.parse(`${todayStr}T00:00:00Z`);
  const year = new Date(now).getUTCFullYear();
  let next = Date.UTC(year, d.getUTCMonth(), d.getUTCDate());
  if (next < now) next = Date.UTC(year + 1, d.getUTCMonth(), d.getUTCDate());
  return { days: Math.round((next - now) / DAY_MS), on: new Date(next).toISOString().slice(0, 10) };
}
const withinNextDays = (dateStr, days, todayStr) => {
  const n = nextAnniversary(dateStr, todayStr);
  return !!n && n.days >= 0 && n.days <= days;
};

// RECRUITER IS AN EMPLOYEE (founder 2026-10-27: "recruiter employee veru kaadu, employee matram kanipiste chalu"): for the
// designation filter a stored "Recruiter" reads as "Employee" — no Recruiter option, counted and matched under Employee.
// The employee records keep what they hold.
const dashDesignation = (d) => {
  const s = String(d || '').trim();
  return /^recruiter$/i.test(s) ? 'Employee' : s;
};

// The dashboard's filters (department, location, status, designation, reporting
// manager, and a name / employee-ID search), all AND'd together.
function matchesFilters(e, q) {
  if (q.department && e.department !== q.department) return false;
  if (q.location && e.location !== q.location) return false;
  if (q.designation && dashDesignation(e.designation) !== dashDesignation(q.designation)) return false;
  if (q.q) {
    const hay = `${e.name || ''} ${e.employeeCode || ''}`.toLowerCase();
    if (!String(q.q).toLowerCase().split(/s+/).filter(Boolean).every((t) => hay.includes(t))) return false;
  }
  if (q.status && hrStatusOf(e.employmentStatus, e.user && e.user.status) !== q.status) return false;
  if (q.manager && e.reportingManagerId !== q.manager) return false;
  return true;
}

// Everything the HRMS Dashboard shows, computed against the same filtered
// employee set so every tile, panel and the CSV export agree with each other.
//
// THE DATE FILTER (?range=today|this_week|…|custom&from&to, utils/dateRange.js)
// narrows only the figures that have a date of their own:
//   attendance      the marks inside the range (one day = that day's marks,
//                   several = the total of every mark across them)
//   on leave        approved leave overlapping the range
//   leave overview  requests overlapping the range
//   new joiners     dateOfJoining inside the range (was a fixed 30 days)
// Headcount, active / notice / exit-process / relieved counts (an Employee
// carries no relieving date — imported leavers have no resignation record —
// so there is nothing honest to date an exit by), the pending-approval
// queues, upcoming leave, celebrations and holidays are the state of things
// NOW and stay so — the page labels them that way.
// May this login EXPORT the dashboard? A separate right from viewing it (HR
// and the Super Admin hold it; a view-only Manager is allowed view + export).
const mayExportDashboard = (user) => can(user, 'hrms', 'hrms', 'HRMS Dashboard', 'export');

router.get('/', requirePerm(null, 'hrms', 'HRMS Dashboard', 'view'), async (req, res) => {
  const period = dateRange.fromQuery(req, res);
  if (!period) return;
  const out = await buildDashboard(req, period);
  // mayExport: the page shows its Export button only when this is true (GET /export checks again).
  out.mayExport = !!(await mayExportDashboard(req.user));
  return res.json(out);
});

async function buildDashboard(req, period) {
  const today = new Date().toISOString().slice(0, 10);
  const inDays = dateRange.dayStringIn(period);

  // SCOPED, like every other employee list in the app. This read had no filter
  // at all, so a TL opening the HRMS Dashboard saw the WHOLE COMPANY: 28 Total
  // Employees and a Headcount-by-Department panel naming every department,
  // while HRMS -> Employees beside it correctly showed 8. Same helper
  // utils/scope.js gives /api/employees, so the two screens agree and widening
  // a role's scope widens both.
  const { allEmployees, employees, ids } = await loadBase(req);

  const [attendance, punches, leaveRequests, leavePending, leaveUpcoming, regularizations, holidays, announcements, assets, courseAssignments, targets, tickets] = await Promise.all([
    prisma.attendance.findMany({ where: { date: inDays, employeeId: { in: ids } } }),
    prisma.attendancePunch.findMany({ where: { date: inDays, employeeId: { in: ids } }, select: { employeeId: true, date: true, direction: true } }),
    // Overlapping the range: starts before it ends, ends on or after it starts.
    prisma.leaveRequest.findMany({ where: { employeeId: { in: ids }, fromDate: { lt: inDays.lt }, toDate: { gte: period.from } } }),
    // The approval queue and what is booked ahead are NOW, whatever the range.
    prisma.leaveRequest.count({ where: { employeeId: { in: ids }, status: 'Pending' } }),
    prisma.leaveRequest.count({ where: { employeeId: { in: ids }, status: 'Approved', fromDate: { gt: today } } }),
    prisma.attendanceRegularization.findMany({ where: { employeeId: { in: ids }, status: 'Pending' } }),
    prisma.holiday.findMany({ orderBy: { date: 'asc' } }),
    // a PAUSED announcement (utils/announcementPause.js) is not on the dashboard
    prisma.announcement.findMany({ orderBy: { createdAt: 'desc' }, take: 40 }).then((rows) => rows.filter((a) => !require('../utils/announcementPause').isPaused(a)).slice(0, 4)), // eslint-disable-line global-require
    // These four counted the WHOLE COMPANY while every tile above them was
    // already restricted to `ids` — so a TL's "Pending Tasks" panel reported
    // other departments' assets, training, targets and tickets.
    prisma.employeeRecord.count({ where: { type: 'ASSET', status: 'Assigned', employeeId: { in: ids } } }),
    prisma.courseAssignment.count({ where: { completed: false, employeeId: { in: ids } } }),
    prisma.employeeRecord.count({ where: { type: 'TARGET', status: 'In Progress', employeeId: { in: ids } } }),
    prisma.employeeRecord.count({ where: { type: 'HELPDESK', status: { notIn: ['Resolved', 'Closed'] }, employeeId: { in: ids } } }),
  ]);
  // Late coming requests waiting for an approver (the same "waiting" idea as the attendance corrections tile). Never throws.
  const lateComingPending = prisma.latePermission ? await prisma.latePermission.count({ where: { employeeId: { in: ids }, status: 'Pending' } }).catch(() => 0) : 0;

  const countStatus = (s) => attendance.filter((a) => a.status === s).length;

  // hrms-24 §9 — THE ATTENDANCE TILES AND CHARTS FROM ONE COMPUTATION. Each
  // person's day status comes from utils/attendanceDays.js (punches, marks,
  // approved leave, holidays, weekly offs) — the rule My Attendance, Team
  // Attendance and the Monthly Summary use — over the same filtered employee
  // set, so a tile and the chart beside it can never disagree. Day by day, so
  // it covers ranges up to a year; a longer custom range keeps the raw mark
  // counts below and draws no attendance chart.
  //
  // THE TILES COUNT PEOPLE, NOT PERSON-DAYS. They used to total every day of
  // the range, so "This Year" showed Present 3,038 and Missing Punch 1,714
  // against a headcount of 35 active people (366 records, 330 of whom have
  // left). Now the tiles are ONE DAY — the range's last day, or today when the
  // range runs into the future — out of the people on the rolls that day
  // (utils/attendanceDays.js rollOf: joined, not yet left, Super Admin
  // excluded), each person in exactly one bucket, so they add up to the day's
  // headcount and match the Attendance page's Dashboard for that date. The
  // charts beside them still show the whole range, labelled person-days.
  const insights = require('./insights');
  // One computation of "each person's day" — the tiles below and the lists
  // behind them (GET /list) both read it, so a tile and its list cannot differ.
  const { cfg, roll, asOf, dayRows } = await attendanceDay(employees, period);
  const dayTally = D.tally(dayRows.map((r) => r.day));
  let computed = null;
  if (period.days <= insights.MAX_DAY_RANGE) {
    const working = roll.employees.filter((e) => D.onRolls(e, period.from, period.to, roll.lastDayOf));
    const { days } = await D.loadDays(prisma, { employees: working, from: period.from, to: period.to, cfg, lastDayOf: roll.lastDayOf, preview: true });
    // THE CHARTS GROUP A DAY THE WAY THE TILES DO. insights.buildAttendance
    // groups by the raw status, so a person who checked in and never checked
    // out (status Missing Check-Out) was a "Missing Check-Out" bar there but
    // PRESENT in the tile above it: on 28 Sep the tile said Present 24 and the
    // chart Present 0. Each day's status is folded into its tile bucket
    // (D.bucketOf) before the chart is built; Late and Missing punch are
    // "of which" figures counted inside Present / Half day.
    const bucketLabel = { present: 'Present', halfDay: 'Half Day', absent: 'Absent', onLeave: 'On Leave' };
    let lateDays = 0; let missingDays = 0;
    const per = working.map((e) => {
      const rows = days(e).filter((d) => !['Upcoming', 'Not Joined', 'Left'].includes(d.status)).map((d) => {
        if (D.bucketOf(d) && d.counted) {
          if (d.late || d.status === 'Late') lateDays += 1;
          if (d.status === 'Missing Check-Out' || (d.status === 'Missing Check-In' && !d.noRecord)) missingDays += 1;
        }
        const b = D.bucketOf(d);
        return bucketLabel[b] ? { ...d, status: bucketLabel[b] } : d;
      });
      return { employee: e, rows, summary: D.summarise(rows) };
    });
    computed = insights.buildAttendance(per, period);
    const t = computed.totals;
    const statusChart = computed.charts.find((c) => c.id === 'att-status');
    if (statusChart) {
      statusChart.sub = 'Person-days in the range, grouped like the tiles. Late and Missing punch are counted inside Present / Half day.';
      statusChart.rows = [
        { label: 'Present (incl. late)', value: t.present }, { label: 'Half Day', value: t.halfDay }, { label: 'Absent', value: t.absent },
        { label: 'On Leave', value: t.onLeave }, { label: 'Of whom late', value: lateDays }, { label: 'Missing punch', value: missingDays },
      ];
    }
    const deptChart = computed.charts.find((c) => c.id === 'att-dept');
    if (deptChart) {
      // The empty "Missing punch" series goes: those days are inside Present now.
      const drop = deptChart.series.indexOf('Missing punch');
      if (drop >= 0) {
        deptChart.series = deptChart.series.filter((_, i) => i !== drop);
        deptChart.rows = deptChart.rows.map((r) => ({ ...r, values: r.values.filter((_, i) => i !== drop) }));
      }
    }
  }
  const deptById = new Map(employees.map((e) => [e.id, e.department]));
  const leaveBuilt = insights.buildLeave(leaveRequests.map((l) => ({ ...l, employee: { department: deptById.get(l.employeeId) || null } })));
  // Punches keyed by employee + day, so a mark is checked against its own day's.
  const punchKey = (p) => `${p.employeeId}|${p.date}`;
  const punchedIn = new Set(punches.filter((p) => p.direction === 'In').map(punchKey));
  const punchedOut = new Set(punches.filter((p) => p.direction === 'Out').map(punchKey));
  // Distinct employees, not requests: two approved requests inside one month
  // are still one person away.
  const onLeave = new Set(leaveRequests.filter((l) => l.status === 'Approved').map((l) => l.employeeId));
  const joinedInRange = (e) => joinedIn(e, period);
  // HEADCOUNT BY DEPARTMENT — the people WORKING here now (everybody except
  // Relieved / Exited), with the number who have left beside it, so the working
  // numbers add up to Total minus Left and working + left add up to Total.
  // (It used to count the 319 people who left as headcount, and dropped anyone
  // with no department.)
  const deptRows = headcountByDepartmentOf(employees);
  // Pending leave that belongs to people who have already left: counted in
  // Leave Approvals (every pending request is), and said so beside the tile.
  // 2026-10-13 (HRMS item 8): the Pending Approvals figures count GENUINE pending only (employee still working, not a duplicate,
  // dates not long past). The rest is told beside the tile (and listed for HR under Leave -> Pulse sync -> Old pending).
  const pendingSplit = await leaveGenuine.pendingBuckets({ employeeIds: ids });
  const leaveApprovalsFromLeft = pendingSplit.leaver.length;

  // BIRTHDAYS and WORK ANNIVERSARIES in the next 30 days — all of them, soonest
  // first (it used to stop at 4 of each and say "next 30 days"); the panel
  // scrolls and its heading carries the count.
  const liveDepts = await activeDepartmentSet();
  const celebrations = celebrationsOf(employees, today).map((c) => ({ name: c.name, kind: c.kind, date: c.date, on: c.on, inDays: c.inDays, years: c.years }));

  return {
    date: today,
    period,
    // THE FILTERS CASCADE (filter rule, 2026-10-03): each list is counted over
    // the people the OTHER filters leave, and an option with nobody behind it
    // is not offered (the value already chosen always stays). `counts` holds
    // the numbers the pickers print beside each option.
    filterOptions: (() => {
      const without = (k) => allEmployees.filter((e) => matchesFilters(e, { ...req.query, [k]: '' }));
      const tally = (list, keyOf) => {
        const m = new Map();
        list.forEach((e) => { const k = keyOf(e); if (k) m.set(k, (m.get(k) || 0) + 1); });
        return m;
      };
      const keep = (m, chosen) => { if (chosen && !m.has(chosen)) m.set(chosen, 0); return m; };
      const dept = keep(tally(without('department'), (e) => e.department), req.query.department);
      const loc = keep(tally(without('location'), (e) => e.location), req.query.location);
      const stat = tally(without('status'), (e) => hrStatusOf(e.employmentStatus, e.user && e.user.status));
      const forMgr = without('manager');
      const mgr = tally(forMgr, (e) => e.reportingManagerId);
      // Spec item 7 — every reporting manager of the people on this dashboard.
      const mgrName = new Map(allEmployees.filter((e) => e.reportingManager).map((e) => [e.reportingManagerId, e.reportingManager.name]));
      if (req.query.manager && !mgr.has(req.query.manager)) mgr.set(req.query.manager, 0);
      // DESIGNATIONS COUNT THE PEOPLE WORKING NOW (founder 2026-10-27): "Employee 325" counted the 297 who left. With no Status picked the
      // list is the working people only; a Status picked (e.g. Relieved) counts that status, so the left can still be found.
      const forDesig = req.query.status ? without('designation') : without('designation').filter((e) => !LEFT_STATUSES.includes(e.employmentStatus));
      const desig = keep(tally(forDesig, (e) => dashDesignation(e.designation)), req.query.designation && dashDesignation(req.query.designation));
      return {
        // Only switched-on Department & Team names are offered (2026-10-28).
        departments: filterActiveDepartments([...dept.keys()], liveDepts, (x) => x, req.query.department).sort(),
        locations: [...loc.keys()].sort(),
        designations: [...desig.keys()].sort(),
        statuses: HR_STATUSES.filter((s) => stat.has(s) || s === req.query.status),
        managers: [...mgr.keys()].filter((id) => mgrName.has(id))
          .map((id) => ({ id, name: mgrName.get(id), count: mgr.get(id) }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        counts: {
          department: Object.fromEntries(dept), location: Object.fromEntries(loc), status: Object.fromEntries(stat), designation: Object.fromEntries(desig),
        },
      };
    })(),
    // THE TILES ADD UP: Active + Notice period + Exit process + Left (Relieved
    // + Exited) [+ Other, shown only when somebody is in a status with no tile
    // of its own, e.g. On Probation / Inactive / Suspended] = Total. Each
    // number is the length of its list (GET /list?tile=...): both come from
    // the same predicates in EMP_TILE below. The system Super Admin account is
    // not an employee and is left out of Total (withoutSystemAccounts above).
    // EXIT APPROVALS (HRMS spec item 6): only the Super Admin and the HR desk are sent this. 'Left this month' counts the LAST WORKING DAY
    // of approved exits (utils/exitDate.js), so a changed date moves the person to the right month.
    exitApprovals: await exitApprovalsLine(req.user, today),
    employeeOverview: {
      total: employees.length,
      headcount: employees.filter(EMP_TILE.empHeadcount).length,
      active: employees.filter(EMP_TILE.active).length,
      newJoiners: employees.filter(joinedInRange).length,
      onLeave: onLeave.size,
      servingNotice: employees.filter(EMP_TILE.notice).length,
      exitProcess: employees.filter(EMP_TILE.exitProcess).length,
      left: employees.filter(EMP_TILE.left).length,
      relieved: employees.filter(EMP_TILE.relieved).length,
      exited: employees.filter(EMP_TILE.exited).length,
      other: employees.filter(EMP_TILE.other).length,
      otherStatuses: [...new Set(employees.filter(EMP_TILE.other).map((e) => e.employmentStatus || 'No status'))].sort(),
    },
    // PEOPLE on one day (asOf) — see above. present + halfDay + absent +
    // onLeave + offDay + noRecord + notYet (+ upcoming) = headcount.
    attendanceOverview: {
      asOf,
      // THE ONE CHART (founder 2026-10-28: "HRMS dashboard clear ga, okka bar graph"): the same people as the tiles, on the same day,
      // per department - present / half day / on leave / absent / week off - so each bar adds up to that department's headcount.
      byDepartment: (() => {
        const m = new Map();
        dayRows.forEach(({ employee, day }) => {
          const name = employee.department || 'No department';
          const x = m.get(name) || { department: name, present: 0, halfDay: 0, onLeave: 0, absent: 0, offDay: 0, noRecord: 0, notYet: 0, other: 0, total: 0 };
          const b = D.bucketOf(day);
          x[['present', 'halfDay', 'onLeave', 'absent', 'offDay', 'noRecord', 'notYet'].includes(b) ? b : 'other'] += 1;
          x.total += 1;
          m.set(name, x);
        });
        return [...m.values()].sort((a, b) => b.total - a.total || a.department.localeCompare(b.department));
      })(),
      headcount: dayTally.headcount,
      present: dayTally.present,
      // THE TILES (2026-10-09): Present + Absent + Half day + On leave + Week off / Holiday
      // = Headcount (No device data / Not checked in yet / Upcoming only when somebody
      // is in them). Present INCLUDES late, early logout, missing check-in and missing
      // check-out; those four are small notes inside the Present tile, not tiles.
      notes: dayTally.notes,
      lateAfter: lateAfterText(cfg), // "9:15 AM": the configured grace time, never hard-coded
      // Why Total employees (everybody in the filter, left or not) is bigger than the
      // Headcount (the people on the rolls on this date).
      offTheRolls: offTheRollsOf(employees, dayRows, asOf),
      late: dayTally.notes.late, // inside Present
      // Late arrivals by the state of their late-coming request: Late 5 = Approved 3 + Pending 1 + Not explained 1 (+ Rejected).
      // An approved one stays Present and is NOT a policy late (not counted for payroll); the others still are.
      lateStates: dayTally.lateStates,
      lateExcused: dayTally.lateExcused,
      lateChips: LP.chipsText(dayTally.lateStates),
      halfDay: dayTally.halfDay,
      absent: dayTally.absent,
      onLeave: dayTally.onLeave,
      // What the On Leave tile is made of: approved leave on a working day, leave
      // still waiting for approval, and attendance corrections asked (Informed).
      onLeaveKinds: onLeaveKinds(dayRows),
      // The Half day tile: which half the leave covers, and where that leave stands.
      halfDayLeave: halfLeave.summarise([...(await halfLeave.annotate(prisma, dayRows.filter((r) => D.bucketOf(r.day) === 'halfDay').map((r) => ({ employeeId: r.employee.id, date: asOf, day: r.day })))).values()]),
      // Where the people with APPROVED leave on this day landed in the tiles above
      // (On leave / Half day when they worked the other half / Week-off or
      // Holiday / elsewhere), so the note under On Leave states exactly why it
      // can differ from "Leave approved for this date".
      // Every APPROVED leave request that overlaps this date, put in the ONE tile it lands in
      // (see utils/leaveReconcile.js) - so the Leave overview and the tiles reconcile.
      leaveReconcile: await leaveReconcileOf(ids, dayRows, asOf),
      tileNotes: dayTally.tileNotes, // notes per tile (Present / Half day / On leave); never in the equation
      offDay: dayTally.offDay,
      noRecord: dayTally.noRecord,
      notYet: dayTally.notYet,
      upcoming: dayTally.upcoming,
      missingPunch: dayTally.notes.missingCheckIn + dayTally.notes.missingCheckOut,
      checkedIn: dayTally.checkedIn,
      checkedOut: dayTally.checkedOut,
      regularizationPending: regularizations.length,
      computed: true,
      // The range's person-days (what the tiles used to show), for the charts' context.
      rangePersonDays: computed ? computed.totals : null,
    },
    // hrms-24 §9 — the charts, built from exactly the figures in the tiles.
    charts: [...(computed ? computed.charts : []), ...leaveBuilt.charts],
    leaveOverview: {
      total: leaveRequests.length,
      pending: leaveRequests.filter((l) => l.status === 'Pending' && !pendingSplit.reasonOf.has(l.id)).length,
      approved: leaveRequests.filter((l) => l.status === 'Approved').length,
      rejected: leaveRequests.filter((l) => l.status === 'Rejected').length,
      // Cancelled + cancellation requests are the rest of the total, so
      // Pending + Approved + Rejected + Cancelled = Leave Requests.
      cancelled: leaveRequests.filter((l) => l.status === 'Cancelled').length,
      cancellationRequests: leaveRequests.filter((l) => l.status === 'Cancellation Requested').length,
      // Pending in this range that is NOT genuine (left / duplicate / long past): kept out of Pending so the numbers stay honest.
      pendingOther: leaveRequests.filter((l) => l.status === 'Pending' && pendingSplit.reasonOf.has(l.id)).length,
      upcoming: leaveUpcoming,
      // Approved requests counted as REQUESTS, split full day / half day, and how many PEOPLE they are.
      approvedFullDay: leaveRequests.filter((l) => l.status === 'Approved' && !halfOf(l)).length,
      approvedHalfDay: leaveRequests.filter((l) => l.status === 'Approved' && !!halfOf(l)).length,
      approvedPeople: new Set(leaveRequests.filter((l) => l.status === 'Approved').map((l) => l.employeeId)).size,
    },
    pendingTasks: {
      leaveApprovals: pendingSplit.genuine.length,
      leaveApprovalsFromLeft,
      leaveOldPending: pendingSplit.old.length,
      leaveDuplicatePending: pendingSplit.duplicate.length,
      attendanceRegularization: regularizations.length,
      lateComing: lateComingPending,
      assetsAssigned: assets,
      trainingPending: courseAssignments,
      openTargets: targets,
      openTickets: tickets,
    },
    headcountByDepartment: deptRows,
    celebrations,
    upcomingHolidays: holidays.filter((h) => h.date >= today).slice(0, 4),
    announcements,
  };
}

// ===========================================================================
// SHARED PIECES — read by the dashboard (GET /) and by the lists behind its
// tiles (GET /list), so a tile number and the list it opens are one computation.
// ===========================================================================

// The status each Employee Overview tile counts. Active + Notice period + Exit
// process + Left (Relieved + Exited) + Other = Total, always: `other` is whoever
// is in a status with no tile of its own (On Probation, Inactive, Suspended ...).
const LEFT_STATUSES = D.LEFT_EMPLOYMENT; // Relieved, Exited
const TILE_STATUSES = ['Active', 'Notice Period', 'Exit Process', ...LEFT_STATUSES];
const EMP_TILE = {
  total: () => true,
  active: (e) => e.employmentStatus === 'Active',
  notice: (e) => e.employmentStatus === 'Notice Period',
  exitProcess: (e) => e.employmentStatus === 'Exit Process',
  left: (e) => LEFT_STATUSES.includes(e.employmentStatus),
  // HEADCOUNT (founder 2026-10-27): the people working here now = everybody who has not left (Active + Notice + Exit process + Other)
  empHeadcount: (e) => !LEFT_STATUSES.includes(e.employmentStatus),
  relieved: (e) => e.employmentStatus === 'Relieved',
  exited: (e) => e.employmentStatus === 'Exited',
  other: (e) => !TILE_STATUSES.includes(e.employmentStatus),
};

// The filtered, scoped employee set every figure on the page is counted over.
async function exitApprovalsLine(user, today) {
  try {
    const exitDate = require('../utils/exitDate'); // eslint-disable-line global-require
    if (!exitDate.isHrDesk(user)) return null;
    // exits waiting for a decision - not those of people who have already left (founder 2026-10-30)
    const pendingIds = (await prisma.approvalStep.findMany({ where: { workflow: 'resignation', status: 'Pending' }, select: { recordId: true } })).map((s) => s.recordId);
    const waiting = pendingIds.length ? await prisma.employeeRecord.count({ where: { id: { in: [...new Set(pendingIds)] }, employee: { employmentStatus: { notIn: ['Relieved', 'Exited', 'Terminated'] } } } }) : 0;
    const month = today.slice(0, 7);
    const gone = await prisma.employee.findMany({ where: withoutSystemAccounts({ employmentStatus: { in: ['Notice Period', 'Exit Process', 'Relieved', 'Exited', 'Terminated'] } }), select: { id: true } });
    const dates = await exitDate.exitDatesFor(gone.map((g) => g.id));
    let exitsThisMonth = 0;
    dates.forEach((x) => { if (x.date.slice(0, 7) === month && x.date <= today) exitsThisMonth += 1; });
    const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return { waiting, exitsThisMonth, monthLabel: `${MON[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}` };
  } catch { return null; }
}

async function loadBase(req) {
  const allEmployees = await prisma.employee.findMany({
    where: withoutSystemAccounts(employeeWhere(req.user)), // Super Admin is a system account, not headcount
    include: { reportingManager: true, user: { select: { status: true } } },
    orderBy: { name: 'asc' },
  });
  const employees = allEmployees.filter((e) => matchesFilters(e, req.query));
  return { allEmployees, employees, ids: employees.map((e) => e.id) };
}

// ONE ROW PER PERSON FOR THE ATTENDANCE DAY (the range's last day, or today
// when the range runs on past it): who is on the rolls that day, and each
// person's classified day (utils/attendanceDays.js classifyDay).
async function attendanceDay(employees, period) {
  const cfg = (await prisma.hrConfig.findFirst()) || await prisma.hrConfig.create({ data: { graceTime: '09:15', weeklyOffDays: '0' } });
  const roll = await D.rollOf(prisma, employees);
  const asOf = period.to < D.localDate() ? period.to : D.localDate();
  const onDay = roll.employees.filter((e) => D.onRolls(e, asOf, asOf, roll.lastDayOf));
  const dayLoad = await D.loadDays(prisma, { employees: onDay, from: asOf, to: asOf, cfg, lastDayOf: roll.lastDayOf, preview: true });
  return { cfg, roll, asOf, onDay, dayLoad, dayRows: onDay.map((e) => ({ employee: e, day: dayLoad.days(e)[0] })) };
}

// "9:15 AM" - the grace time the Late note follows (HrConfig.graceTime).
function lateAfterText(cfg) {
  const m = require('../utils/attendanceMath').toMinutes(String((cfg && cfg.graceTime) || '09:15'));
  return D.clock(m == null ? 9 * 60 + 15 : m);
}
// The people in the filter who are NOT on the rolls on the date: had left already,
// or had not joined yet. employees.length = headcount + these.
function offTheRollsOf(employees, dayRows, asOf) {
  const on = new Set(dayRows.map((r) => r.employee.id));
  const out = { left: 0, notJoinedYet: 0, total: 0 };
  employees.forEach((e) => {
    if (on.has(e.id)) return;
    const j = D.joinedOn(e);
    if (j && j > asOf) out.notJoinedYet += 1; else out.left += 1;
    out.total += 1;
  });
  return out;
}

// How many of the day's On Leave people are approved / waiting / informed.
function onLeaveKinds(dayRows) {
  const k = { approved: 0, pending: 0, informed: 0 };
  dayRows.forEach(({ day }) => { if (D.bucketOf(day) === 'onLeave') k[D.leaveKindOf(day) || 'approved'] += 1; });
  return k;
}

async function leaveReconcileOf(ids, dayRows, asOf) {
  const leaves = await prisma.leaveRequest.findMany({
    where: { employeeId: { in: ids }, status: 'Approved', fromDate: { lte: asOf }, toDate: { gte: asOf } },
    select: { id: true, employeeId: true, fromDate: true, toDate: true, days: true, reason: true },
  });
  const dayOf = new Map(dayRows.map(({ employee, day }) => [employee.id, day]));
  return { asOf, ...leaveReconcile.reconcile(leaves, (id) => dayOf.get(id)) };
}

// New joiners: date of joining inside the range.
function joinedIn(e, period) {
  if (!e.dateOfJoining) return false;
  const d = new Date(e.dateOfJoining).toISOString().slice(0, 10);
  return d >= period.from && d <= period.to;
}

const NO_DEPARTMENT = 'No department';
function headcountByDepartmentOf(employees) {
  const m = new Map();
  employees.forEach((e) => {
    const name = e.department || NO_DEPARTMENT;
    if (!m.has(name)) m.set(name, { department: name, working: 0, left: 0 });
    m.get(name)[EMP_TILE.left(e) ? 'left' : 'working'] += 1;
  });
  return [...m.values()]
    .sort((a, b) => b.working - a.working || b.left - a.left || a.department.localeCompare(b.department))
    .map((r) => ({ department: r.department, employees: r.working, working: r.working, left: r.left, total: r.working + r.left }));
}

// Birthdays + work anniversaries in the next 30 days — only people still
// working here (hrStatus Active), never a test row. Soonest first.
function celebrationsOf(employees, todayStr, kind = '') {
  const celebrating = employees.filter((e) => hrStatusOf(e.employmentStatus, e.user && e.user.status) === 'Active'
    && !/zztest|example\.test/i.test(`${e.name} ${e.email || ''}`));
  const out = [];
  const add = (label, field, years) => celebrating.forEach((e) => {
    const n = nextAnniversary(e[field], todayStr);
    if (!n || n.days > 30) return;
    const y = years ? Number(n.on.slice(0, 4)) - new Date(e[field]).getUTCFullYear() : null;
    if (years && y < 1) return; // joined this year: no anniversary yet
    out.push({ employee: e, name: e.name, kind: label, date: e[field], on: n.on, inDays: n.days, years: y });
  });
  if (!kind || kind === 'Birthday') add('Birthday', 'dateOfBirth', false);
  if (!kind || kind === 'Work Anniversary') add('Work Anniversary', 'dateOfJoining', true);
  return out.sort((a, b) => a.inDays - b.inDays || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// THE LISTS BEHIND THE TILES
//   GET /api/hrms/dashboard/list?tile=<key>[&part=<x>][&format=xlsx]
// plus the dashboard's own filters and date range (department, location, status,
// manager, range, from, to) — the SAME ones the tiles were counted with.
//
//   people     total, active, newJoiners, onLeave, notice, exitProcess,
//              left (part = relieved | exited), other
//   attendance headcount, present, halfDay, absent, attOnLeave, offDay,
//              noRecord, notYet, upcoming, late, missingPunch
//   leave      leaveTotal, leavePending, leaveApproved, leaveRejected,
//              leaveCancelled, leaveCancelAsked, leaveUpcoming
//   tasks      taskLeave, taskRegularization, taskAssets, taskTraining,
//              taskTargets, taskTickets
//   panels     dept (part = department name or "No department"; scope =
//              working | left | all), celebrations (part = Birthday | Work Anniversary)
// Response: { title, note, columns:[{key,label,kind}], rows, total }. `total`
// is the tile's number. ?format=xlsx downloads the same rows.
// ---------------------------------------------------------------------------
const C = (key, label, kind = 'text') => ({ key, label, kind });
const PEOPLE_COLS = [
  C('name', 'Name'), C('employeeCode', 'Employee ID'), C('department', 'Department'), C('designation', 'Designation'),
  C('seat', 'Seat'), C('status', 'Status'), C('joined', 'Joined on', 'date'), C('lastWorkingDay', 'Last working day', 'date'),
  C('manager', 'Reporting manager'),
];
// Serving notice / Exit process / Left: when (date AND time) and why they resigned.
const EXIT_COLS = [
  C('name', 'Name'), C('employeeCode', 'Employee ID'), C('department', 'Department'), C('designation', 'Designation'),
  C('status', 'Status'), C('resignedOn', 'Resigned on'), C('resignReason', 'Reason'), C('lastWorkingDay', 'Last working day', 'date'),
  C('manager', 'Reporting manager'),
];
const ATT_COLS = [
  C('name', 'Name'), C('employeeCode', 'Employee ID'), C('department', 'Department'), C('designation', 'Designation'),
  C('checkIn', 'In', 'time'), C('checkOut', 'Out', 'time'), C('result', 'Result'), C('late', 'Late'), C('lateComing', 'Late coming'), C('note', 'Note'), C('why', 'Why'),
];
// The Half day list also says where the leave for the other half stands.
const ATT_COLS_HALF = [
  C('name', 'Name'), C('employeeCode', 'Employee ID'), C('department', 'Department'), C('designation', 'Designation'),
  C('checkIn', 'In', 'time'), C('checkOut', 'Out', 'time'), C('halfLeave', 'Half day leave', 'halfleave'), C('halfLeaveHalf', 'Leave covers'), C('halfLeaveBy', 'Approved by'), C('note', 'Note'), C('why', 'Why'),
];
const LEAVE_COLS = [
  C('name', 'Name'), C('employeeCode', 'Employee ID'), C('department', 'Department'), C('leaveType', 'Leave type'),
  C('from', 'From', 'date'), C('to', 'To', 'date'), C('days', 'Days', 'num'), C('leaveStatus', 'Leave status'),
  C('applied', 'Applied on', 'date'), C('status', 'Employee status'),
];

const dstr = (v) => (v ? new Date(v).toISOString().slice(0, 10) : '');
const personOf = (e) => ({ id: e.id, name: e.name, employeeCode: e.employeeCode, department: e.department || '', designation: e.designation || '' });
// "9:05 AM" from "09:05" / "09:05:12".
function t12(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
  if (!m) return '';
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`;
}

// Seat (position code) held now, else the last one held — what Employee
// Management shows; and the last working day of the people who left.
async function peopleExtras(emps) {
  const ids = emps.map((e) => e.id);
  if (!ids.length) return { seat: new Map(), lwd: new Map() };
  const goneIds = emps.filter((e) => ['Notice Period', 'Exit Process', ...LEFT_STATUSES].includes(e.employmentStatus)).map((e) => e.id);
  const [assignments, details, records] = await Promise.all([
    prisma.positionAssignment.findMany({ where: { employeeId: { in: ids } }, select: { employeeId: true, fromDate: true, toDate: true, position: { select: { code: true } } }, orderBy: { fromDate: 'asc' } }),
    prisma.resignationDetail.findMany({ where: { employeeId: { in: goneIds } }, orderBy: { createdAt: 'desc' }, select: { employeeId: true, approvedLastWorkingDate: true, requestedLastWorkingDate: true } }),
    prisma.employeeRecord.findMany({ where: { type: 'RESIGNATION', employeeId: { in: goneIds }, date: { not: null } }, orderBy: { updatedAt: 'desc' }, select: { employeeId: true, date: true } }),
  ]);
  const byEmp = new Map();
  assignments.forEach((a) => {
    if (a.toDate && a.toDate <= a.fromDate) return; // opened and closed the same day: never held
    if (!byEmp.has(a.employeeId)) byEmp.set(a.employeeId, []);
    byEmp.get(a.employeeId).push(a);
  });
  const seat = new Map();
  byEmp.forEach((list, id) => seat.set(id, (list.find((a) => !a.toDate) || list[list.length - 1]).position.code));
  const lwd = new Map();
  const iso = (v) => (v && /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? String(v).slice(0, 10) : '');
  details.forEach((d) => {
    const v = iso(d.approvedLastWorkingDate) || iso(d.requestedLastWorkingDate);
    if (v && !lwd.has(d.employeeId)) lwd.set(d.employeeId, v);
  });
  records.forEach((r) => { if (!lwd.has(r.employeeId) && iso(r.date)) lwd.set(r.employeeId, iso(r.date)); });
  // Left with no resignation date on file: their last day of attendance.
  const unresolved = emps.filter((e) => EMP_TILE.left(e) && !lwd.has(e.id));
  if (unresolved.length) {
    const roll = await D.rollOf(prisma, unresolved);
    unresolved.forEach((e) => { const d = roll.lastDayOf.get(e.id); if (d) lwd.set(e.id, `${d} (last attendance)`); });
  }
  return { seat, lwd };
}

function peopleRows(emps, extras, more = () => ({})) {
  return emps.map((e) => ({
    ...personOf(e),
    seat: extras.seat.get(e.id) || '',
    status: e.employmentStatus || '',
    joined: dstr(e.dateOfJoining),
    lastWorkingDay: extras.lwd.get(e.id) || '',
    manager: e.reportingManager ? e.reportingManager.name : '',
    ...more(e),
  }));
}

const LEAVE_TILE_STATUS = { leavePending: 'Pending', leaveApproved: 'Approved', leaveRejected: 'Rejected', leaveCancelled: 'Cancelled', leaveCancelAsked: 'Cancellation Requested' };
const TILE_TITLE = {
  total: 'Total employees', active: 'Active', newJoiners: 'New joiners', onLeave: 'Leave approved for this date',
  notice: 'Serving notice', exitProcess: 'Exit process', left: 'Left the company', other: 'Other status',
  headcount: 'Headcount on the rolls', empHeadcount: 'Headcount (working now)', present: 'Present', halfDay: 'Half day', absent: 'Absent',
  attOnLeave: 'On leave', offDay: 'Week-off / Holiday', noRecord: 'No device data', notYet: 'Not checked in yet',
  upcoming: 'Upcoming day', late: 'Late', missingPunch: 'Missing punch',
  leaveTotal: 'Leave requests', leavePending: 'Leave: pending', leaveApproved: 'Leave: approved', leaveRejected: 'Leave: rejected',
  leaveCancelled: 'Leave: cancelled', leaveCancelAsked: 'Leave: cancellation asked', leaveUpcoming: 'Upcoming leaves',
  taskLeave: 'Leave approvals waiting', taskRegularization: 'Attendance corrections waiting', taskLateComing: 'Late coming requests waiting', taskAssets: 'Assets assigned',
  taskTraining: 'Training pending', taskTargets: 'Open targets', taskTickets: 'Open tickets',
  dept: 'Headcount by department', celebrations: 'Birthdays & anniversaries (next 30 days)',
};
const spanText = (period) => `${period.name} (${period.from}${period.from === period.to ? '' : ` to ${period.to}`})`;

async function buildList(req, tile, part) {
  const today = new Date().toISOString().slice(0, 10);
  const period = dateRange.resolve(req.query);
  const title = TILE_TITLE[tile];
  if (!title) return null;
  const { employees, ids } = await loadBase(req);
  const byId = new Map(employees.map((e) => [e.id, e]));
  const out = (extra) => ({ tile, part, title, period, today, note: '', ...extra });
  // THE APPROVAL CHAIN ON THE PENDING LISTS (founder 2026-10-27: "approve / reject chain wise gane ravali"): Approve / Reject is offered only to
  // the person whose turn it is (the decision route checks the same again); the chain itself opens with "Open chain" (no column - founder).
  const STEP_WORD = { Approved: 'Approved', Rejected: 'Rejected', Pending: 'Pending now', Waiting: 'Waiting', Visibility: 'Sees only', Skipped: 'Skipped' };
  const LEVEL_WORD = { TL: 'TL', STL: 'STL', HR: 'HR', ASSISTANT_MANAGER: 'Asst Manager', MANAGER: 'Manager', SUPER_ADMIN: 'Super Admin' };
  const withChain = async (workflow, rows) => {
    const recIds = rows.map((r) => r.reqId).filter(Boolean);
    const steps = recIds.length ? await prisma.approvalStep.findMany({ where: { workflow, recordId: { in: recIds }, level: { not: 'EMPLOYEE' } }, orderBy: { seq: 'asc' } }).catch(() => []) : [];
    const byRec = new Map();
    steps.forEach((s) => { if (!byRec.has(s.recordId)) byRec.set(s.recordId, []); byRec.get(s.recordId).push(s); });
    return rows.map((r) => {
      const list = byRec.get(r.reqId) || [];
      const now = list.filter((s) => s.status === 'Pending');
      return {
        ...r,
        chain: list.length ? list.map((s) => `${LEVEL_WORD[s.level] || s.level} ${s.approverName || ''}: ${STEP_WORD[s.status] || s.status}`.replace(/\s+/g, ' ')).join(' → ') : 'No chain yet (the first decision builds it)',
        waitingFor: now.map((s) => `${LEVEL_WORD[s.level] || s.level} ${s.approverName || ''}`.trim()).join(' / ') || null,
        // a request with no chain yet: the server builds it on the first decision and decides whether this login may act
        // a step waiting for the Super Admin (e.g. a TL's leave, utils/leadLeave.js) is any real Super Admin's turn
        myTurn: list.length ? now.some((s) => s.approverUserId === req.user.id || (s.level === 'SUPER_ADMIN' && require('../utils/leadLeave').isRealSuperAdmin(req.user))) : true, // eslint-disable-line global-require
      };
    });
  };
  const leaveRow = (l) => {
    const e = byId.get(l.employeeId);
    return { ...personOf(e), reqId: l.id, leaveType: l.type, from: String(l.fromDate).slice(0, 10), to: String(l.toDate).slice(0, 10), days: l.days ?? '', leaveStatus: l.status, applied: dstr(l.createdAt), status: e.employmentStatus || '' };
  };

  // ---- people tiles ----
  if (EMP_TILE[tile] || tile === 'newJoiners' || tile === 'onLeave' || tile === 'dept') {
    let list; let note = ''; let sub = ''; let more; let cols = PEOPLE_COLS;
    if (tile === 'newJoiners') {
      list = employees.filter((e) => joinedIn(e, period));
      note = `People whose joining date is in ${spanText(period)}.`;
    } else if (tile === 'onLeave') {
      const leaves = await prisma.leaveRequest.findMany({ where: { employeeId: { in: ids }, status: 'Approved', fromDate: { lt: dateRange.dayStringIn(period).lt }, toDate: { gte: period.from } }, orderBy: { fromDate: 'asc' } });
      const by = new Map();
      leaves.forEach((l) => { if (!by.has(l.employeeId)) by.set(l.employeeId, []); by.get(l.employeeId).push(l); });
      list = employees.filter((e) => by.has(e.id));
      const span = (l) => { const f = String(l.fromDate).slice(0, 10); const t = String(l.toDate).slice(0, 10); return `${l.type} ${f}${f === t ? '' : ` to ${t}`}`; };
      more = (e) => ({ leave: by.get(e.id).map(span).join('; ') });
      cols = [...PEOPLE_COLS.slice(0, 6), C('leave', 'Approved leave'), ...PEOPLE_COLS.slice(6)];
      note = `People with APPROVED leave that overlaps ${spanText(period)}. The attendance row can show fewer under On leave: someone on approved leave on a week-off or holiday is shown under Week-off / Holiday, and someone on half-day leave who worked the other half is shown under Half day.`;
    } else if (tile === 'left') {
      list = employees.filter(part === 'relieved' ? EMP_TILE.relieved : part === 'exited' ? EMP_TILE.exited : EMP_TILE.left);
      sub = part === 'relieved' ? ': Relieved' : part === 'exited' ? ': Exited' : '';
    } else if (tile === 'dept') {
      const scope = String(req.query.scope || 'working');
      list = employees.filter((e) => (e.department || NO_DEPARTMENT) === part && (scope === 'left' ? EMP_TILE.left(e) : scope === 'all' ? true : !EMP_TILE.left(e)));
      sub = `: ${part}${scope === 'left' ? ' (left)' : scope === 'all' ? '' : ' (working now)'}`;
    } else list = employees.filter(EMP_TILE[tile]);
    const extras = await peopleExtras(list);
    if (['notice', 'exitProcess', 'left'].includes(tile)) {
      const ri = await require('../utils/resignationInfo').summariesFor(list.map((e) => e.id));
      more = (e) => { const r = ri.get(e.id); return { resignedOn: r ? (r.resignedOn || '') : '', resignReason: r ? r.reason : '' }; };
      cols = EXIT_COLS;
      note = note || 'Resigned on = the day and time the resignation was given; the Resignation screen has the full letter.';
    }
    return out({ title: `${title}${sub}`, note, columns: cols, rows: peopleRows(list, extras, more) });
  }

  // ---- attendance tiles (one person per row, on the attendance day) ----
  const ATT = {
    headcount: () => true,
    present: (b) => b === 'present', halfDay: (b) => b === 'halfDay', absent: (b) => b === 'absent', attOnLeave: (b) => b === 'onLeave',
    offDay: (b) => b === 'offDay', noRecord: (b) => b === 'noRecord', notYet: (b) => b === 'notYet', upcoming: (b) => b === 'upcoming',
  };
  // The four notes inside Present (late / early logout / missing check-in / missing
  // check-out) are lists too: tile=present&part=<note>. The old tile names still work.
  const NOTE_TILE = { late: 'late', earlyLogout: 'earlyLogout', missingCheckIn: 'missingCheckIn', missingCheckOut: 'missingCheckOut' };
  if (ATT[tile] || tile === 'late' || tile === 'missingPunch') {
    const { asOf, dayRows } = await attendanceDay(employees, period);
    // A note is a list too, on every tile that carries notes: tile=halfDay&part=missingCheckOut ...
    const wantNote = (['present', 'halfDay', 'attOnLeave', 'absent'].includes(tile) && D.NOTE_KEYS.includes(String(part || ''))) ? String(part) : (tile === 'late' ? 'late' : '');
    const rows = [];
    const halfInfo = tile === 'halfDay'
      ? await halfLeave.annotate(prisma, dayRows.filter((r) => D.bucketOf(r.day) === 'halfDay').map((r) => ({ employeeId: r.employee.id, date: asOf, day: r.day })))
      : new Map();
    dayRows.forEach(({ employee, day }) => {
      const bucket = D.bucketOf(day);
      if (!bucket) return;
      const hl = halfInfo.get(`${employee.id}|${asOf}`);
      if (tile === 'halfDay' && part && !wantNote && hl && hl.state !== part) return; // ?part=Approved|Pending|Rejected|None
      if (tile === 'attOnLeave' && ['approved', 'pending', 'informed'].includes(String(part)) && D.leaveKindOf(day) !== part) return;
      const notes = D.notesOf(day, bucket);
      const isLate = notes.includes('late');
      if ((tile === 'late' || tile === 'missingPunch') && bucket !== 'present') return; // the old digest tiles are Present-only
      // The late-coming state: ?state=approved|pending|rejected|none, or tile=late&part=<state>.
      const stateQ = LP_STATES.includes(String(req.query.state || '')) ? String(req.query.state) : (tile === 'late' && LP_STATES.includes(String(part)) ? String(part) : '');
      if (stateQ && wantNote === 'late' && (!isLate || day.lateState !== stateQ)) return;
      const ok = tile === 'missingPunch' ? (notes.includes('missingCheckIn') || notes.includes('missingCheckOut'))
        : wantNote ? ((ATT[tile] ? ATT[tile](bucket) : true) && notes.includes(wantNote))
          : ATT[tile](bucket);
      if (!ok) return;
      rows.push({
        ...personOf(byId.get(employee.id) || employee),
        checkIn: day.checkIn ? String(day.checkIn).slice(0, 5) : '',
        checkOut: day.checkOut ? String(day.checkOut).slice(0, 5) : '',
        result: `${bucket === 'present' ? 'Present' : bucket === 'halfDay' ? 'Half day' : (D.KPI_LABEL[day.kpi] || D.BUCKET_LABEL[bucket] || day.status || '')}${bucket === 'onLeave' && D.leaveKindOf(day) ? ` (${D.leaveKindOf(day)})` : ''}`,
        late: isLate ? 'Late' : '',
        lateComing: isLate ? (LP.STATE_LABEL[day.lateState] || '') + (day.latePermission && day.latePermission.beyond ? ' (came after the approved time)' : '') : '',
        lateState: isLate ? (day.lateState || '') : '',
        note: notes.map((k) => D.NOTE_LABEL[k]).join(' · '),
        halfLeave: hl ? hl.text.replace('Half day leave: ', '') : '', halfLeaveHalf: hl ? hl.half : '', halfLeaveBy: hl ? hl.by : '',
        why: day.reason || day.note || '',
      });
    });
    rows.sort((a, b) => a.name.localeCompare(b.name));
    const tileWord = { present: 'Present', halfDay: 'Half day', attOnLeave: 'On leave' }[tile] || '';
    const note = (wantNote && tile !== 'late') ? `These people are ${tileWord}. ${D.NOTE_LABEL[wantNote]} is only a note on them - they are counted once, under ${tileWord}.`
      : tile === 'halfDay' ? 'Half day = worked one half, or has a half-day leave (approved, pending or rejected) and did not work the other half. A half-day leave with no punch at all shows "No punches": half on leave, half absent until HR fixes it.'
      : tile === 'attOnLeave' ? 'Approved leave on a working day, leave waiting for approval, and people who asked for an attendance correction (informed). People on approved leave on a week-off or holiday are shown under Week-off / Holiday, and people on half-day leave under Half day, not here. "Punch on a leave day" and a missing check-in / check-out stay visible for HR.'
      : tile === 'present' ? (wantNote ? `These people are Present. ${D.NOTE_LABEL[wantNote]} is only a note on them - they are counted once, under Present.` : 'Everyone who came to work, including those who were late, left early or missed a check-in / check-out.')
        : tile === 'late' ? 'People who came after the grace time. They are counted under Present. "Late coming" says whether they told why and whether it was approved: an approved one is not counted as a late arrival in payroll.'
          : tile === 'missingPunch' ? 'Present, but a check-in or a check-out is missing. HR can fix these in Attendance.' : '';
    const noteTitle = wantNote ? ` - ${D.NOTE_LABEL[wantNote]}` : '';
    return out({ title: `${title}${noteTitle} on ${asOf}`, asOf, note, columns: tile === 'halfDay' ? ATT_COLS_HALF : ATT_COLS, rows });
  }

  // ---- leave tiles ----
  if (tile.startsWith('leave')) {
    const dayStr = dateRange.dayStringIn(period);
    const where = tile === 'leaveUpcoming'
      ? { employeeId: { in: ids }, status: 'Approved', fromDate: { gt: today } }
      : { employeeId: { in: ids }, fromDate: { lt: dayStr.lt }, toDate: { gte: period.from }, ...(LEAVE_TILE_STATUS[tile] ? { status: LEAVE_TILE_STATUS[tile] } : {}) };
    let leaves = await prisma.leaveRequest.findMany({ where, orderBy: { fromDate: 'desc' } });
    if (tile === 'leavePending') { const g = await leaveGenuine.genuinePendingIds({ employeeIds: ids }); leaves = leaves.filter((l) => g.has(l.id)); }
    // Approved: ?part=full|half (the split the Leave overview shows next to the Approved tile).
    if (tile === 'leaveApproved' && (part === 'full' || part === 'half')) leaves = leaves.filter((l) => (part === 'half') === !!halfOf(l));
    const note = tile === 'leaveUpcoming' ? 'Approved leave that starts after today.' : `Leave requests that overlap ${spanText(period)}.${tile === 'leaveApproved' ? ' One row per REQUEST: a person with two requests shows twice.' : ''}`;
    return out({ note, columns: LEAVE_COLS, rows: leaves.map(leaveRow) });
  }

  // ---- pending tasks (the state of things now) ----
  if (tile === 'taskLeave') {
    const gset = await leaveGenuine.genuinePendingIds({ employeeIds: ids });
    const leaves = (await prisma.leaveRequest.findMany({ where: { employeeId: { in: ids }, status: 'Pending' }, orderBy: { fromDate: 'desc' } })).filter((l) => gset.has(l.id));
    const rows = await withChain('leave', leaves.map(leaveRow));
    const gone = rows.filter((r) => LEFT_STATUSES.includes(r.status)).length;
    return out({ note: 'Genuinely pending leave: the person still works here, it is not a duplicate and the dates are not long past. Others are under Leave > Pulse sync > Old pending.', columns: LEAVE_COLS, rows, decide: 'leave' });
  }
  if (tile === 'taskRegularization') {
    const regs = await prisma.attendanceRegularization.findMany({ where: { employeeId: { in: ids }, status: 'Pending' }, orderBy: { date: 'desc' } });
    const rows = await withChain('regularization', regs.map((r) => ({ ...personOf(byId.get(r.employeeId)), reqId: r.id, date: r.date, reqIn: r.requestedCheckIn || '', reqOut: r.requestedCheckOut || '', reason: r.reason || '', applied: dstr(r.createdAt) })));
    return out({ note: 'Attendance corrections waiting for approval.', columns: [C('name', 'Name'), C('employeeCode', 'Employee ID'), C('department', 'Department'), C('date', 'For date', 'date'), C('reqIn', 'Asked in time', 'time'), C('reqOut', 'Asked out time', 'time'), C('reason', 'Reason'), C('applied', 'Asked on', 'date')], rows, decide: 'regularization' });
  }
  if (tile === 'taskLateComing') {
    const lps = prisma.latePermission ? await prisma.latePermission.findMany({ where: { employeeId: { in: ids }, status: 'Pending' }, orderBy: { date: 'desc' } }) : [];
    const rows = await withChain('latePermission', lps.map((r) => ({ ...personOf(byId.get(r.employeeId)), reqId: r.id, date: r.date, came: r.arrivedAt || r.expectedTime || '', reason: r.reason || '', applied: dstr(r.requestedAt) })));
    return out({ note: 'Late coming requests waiting for approval. Approve or reject them here (or on Attendance → Late coming).', columns: [C('name', 'Name'), C('employeeCode', 'Employee ID'), C('department', 'Department'), C('date', 'For date', 'date'), C('came', 'Came at / will come by', 'time'), C('reason', 'Reason'), C('applied', 'Asked on', 'date')], rows, decide: 'late' });
  }
  if (tile === 'taskAssets' || tile === 'taskTargets' || tile === 'taskTickets') {
    const where = tile === 'taskAssets' ? { type: 'ASSET', status: 'Assigned' } : tile === 'taskTargets' ? { type: 'TARGET', status: 'In Progress' } : { type: 'HELPDESK', status: { notIn: ['Resolved', 'Closed'] } };
    const recs = await prisma.employeeRecord.findMany({ where: { ...where, employeeId: { in: ids } }, orderBy: { createdAt: 'desc' } });
    const rows = recs.map((r) => ({
      ...personOf(byId.get(r.employeeId)), what: r.title, category: r.category || '', recStatus: r.status, date: r.date || '',
      extra: tile === 'taskTargets' ? (r.progressPct != null ? `${r.progressPct}%` : '') : tile === 'taskTickets' ? (r.priority || '') : '',
    }));
    const extraLabel = tile === 'taskTargets' ? 'Progress' : tile === 'taskTickets' ? 'Priority' : '';
    return out({ columns: [C('name', 'Name'), C('employeeCode', 'Employee ID'), C('department', 'Department'), C('what', tile === 'taskAssets' ? 'Asset' : tile === 'taskTargets' ? 'Target' : 'Ticket'), C('category', 'Category'), C('recStatus', 'Status'), C('date', 'Date', 'date'), ...(extraLabel ? [C('extra', extraLabel)] : [])], rows });
  }
  if (tile === 'taskTraining') {
    const cas = await prisma.courseAssignment.findMany({ where: { completed: false, employeeId: { in: ids } }, include: { course: { select: { title: true } } }, orderBy: { assignedAt: 'desc' } });
    const rows = cas.map((c) => ({ ...personOf(byId.get(c.employeeId)), course: c.course ? c.course.title : '', assigned: dstr(c.assignedAt) }));
    return out({ note: 'Courses assigned and not yet finished.', columns: [C('name', 'Name'), C('employeeCode', 'Employee ID'), C('department', 'Department'), C('course', 'Course'), C('assigned', 'Assigned on', 'date')], rows });
  }

  // ---- birthdays & anniversaries ----
  if (tile === 'celebrations') {
    const rows = celebrationsOf(employees, today, part).map((c) => ({
      ...personOf(c.employee), kind: c.kind, on: c.on,
      inDays: c.inDays === 0 ? 'Today' : `In ${c.inDays} day${c.inDays === 1 ? '' : 's'}`,
      years: c.years == null ? '' : `${c.years} year${c.years === 1 ? '' : 's'}`,
    }));
    return out({ note: 'People still working here, in the next 30 days from today.', columns: [C('name', 'Name'), C('employeeCode', 'Employee ID'), C('department', 'Department'), C('kind', 'What'), C('on', 'On', 'date'), C('inDays', 'When'), C('years', 'Years with us')], rows });
  }
  return null;
}

router.get('/list', requirePerm(null, 'hrms', 'HRMS Dashboard', 'view'), async (req, res) => {
  const tile = String(req.query.tile || '');
  const part = String(req.query.part || '');
  if (!dateRange.fromQuery(req, res)) return; // bad custom range: 400 already sent
  const built = await buildList(req, tile, part);
  if (!built) return res.status(400).json({ error: 'Unknown tile' });
  const format = String(req.query.format || '').toLowerCase();
  if (format === 'xlsx' || format === 'csv') {
    if (!(await can(req.user, 'hrms', 'hrms', 'HRMS Dashboard', 'export'))) return res.status(403).json({ error: 'You do not have permission to export the dashboard.' });
    const cell = (r, c) => (c.kind === 'time' ? t12(r[c.key]) : r[c.key]);
    const headers = built.columns.map((c) => c.label);
    const data = built.rows.map((r) => built.columns.map((c) => cell(r, c)));
    const name = `hrms-${tile}${part ? `-${part.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : ''}-${built.asOf || built.today}`;
    notifyDataIo(req, { kind: 'export', module: 'HRMS Dashboard', count: data.length, what: `rows of ${built.title}`, format, detail: name }).catch(() => {});
    // The audit trail (every export leaves one row: who, what, how many).
    await logAudit({ userId: req.user.id, actorName: req.user.name, action: `HRMS dashboard list "${built.title}" exported (${format.toUpperCase()})`, entity: 'HRMSDashboard', toValue: `${data.length} row(s) · ${name}` }).catch(() => null);
    res.setHeader('Content-Disposition', `attachment; filename="${name}.${format}"`);
    if (format === 'csv') return res.type('text/csv').send(`﻿${toCsv(headers, data)}`);
    return res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(toXlsx(headers, data, built.title.slice(0, 31)));
  }
  return res.json({ ...built, total: built.rows.length });
});

// ---------------------------------------------------------------------------
// THE DASHBOARD'S OWN EXPORT (user, 2026-10-09: "dashboard lo export button")
//   GET /api/hrms/dashboard/export?format=xlsx|csv  + the dashboard's filters
// One workbook of what is on the screen for the filters picked: every tile,
// the charts' numbers, the headcount and celebrations panels, and the lists
// the main tiles open (the SAME buildList the tiles use). Export is its own
// right (HRMS Dashboard / export), checked here; scoped by employeeWhere like
// the screen; audited. The old browser-side CSV (every employee in the page
// data, no permission, no log) is gone.
// ---------------------------------------------------------------------------
const EXPORT_LISTS = [
  ['total', '', 'Employees'], ['newJoiners', '', 'New joiners'], ['headcount', '', 'Attendance on the day'], ['late', '', 'Late'],
  ['missingPunch', '', 'Missing punch'], ['leaveTotal', '', 'Leave requests'], ['taskLeave', '', 'Leave approvals waiting'], ['taskRegularization', '', 'Attendance corrections waiting'], ['taskLateComing', '', 'Late coming requests waiting'],
];
router.get('/export', requirePerm(null, 'hrms', 'HRMS Dashboard', 'view'), async (req, res) => {
  const { formatOf, sendBook } = require('../utils/exportKit'); // eslint-disable-line global-require
  const { hrmsBook } = require('../utils/dashboardExport'); // eslint-disable-line global-require
  const { scopeLabel } = require('../utils/scope'); // eslint-disable-line global-require
  const period = dateRange.fromQuery(req, res);
  if (!period) return undefined;
  const format = formatOf(req.query);
  if (!format || format === 'pdf') return res.status(400).json({ error: 'Pick Excel or CSV.' });
  if (!(await mayExportDashboard(req.user))) return res.status(403).json({ error: 'You do not have permission to export the dashboard.' });
  const d = await buildDashboard(req, period);
  const lists = [];
  for (const [tile, part, name] of EXPORT_LISTS) { // eslint-disable-line no-restricted-syntax
    const built = await buildList(req, tile, part); // eslint-disable-line no-await-in-loop
    if (!built || !built.rows.length) continue; // eslint-disable-line no-continue
    const rows = built.rows.map((r) => {
      const o = { ...r };
      built.columns.forEach((c) => { if (c.kind === 'time') o[c.key] = t12(r[c.key]); });
      return o;
    });
    lists.push({ name: tile === 'headcount' ? `${name} ${built.asOf || ''}`.trim() : name, columns: built.columns, rows });
  }
  const managerName = req.query.manager ? ((d.filterOptions.managers.find((m) => String(m.id) === String(req.query.manager)) || {}).name) : '';
  const { sheets } = hrmsBook({ d, lists, query: req.query, managerName });
  return sendBook(req, res, {
    format, name: 'hrms-dashboard', sheets, entity: 'HRMSDashboard', what: 'HRMS dashboard', scope: scopeLabel(req.user, 'hrms'), period: { from: period.from, to: period.to }, screen: 'HRMS Dashboard',
  });
});

module.exports = router;
