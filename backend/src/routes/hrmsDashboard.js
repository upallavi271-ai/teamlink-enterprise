const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { employeeWhere } = require('../utils/scope');
const { HR_STATUSES, hrStatusOf } = require('../utils/hrStatus');
const dateRange = require('../utils/dateRange');
const D = require('../utils/attendanceDays');
const { withoutSystemAccounts } = require('../utils/systemAccounts');

const router = express.Router();
router.use(requireAuth);

const DAY_MS = 86400000;

// True when an anniversary of `dateStr` falls within the next `days` days.
// The date is re-based onto the current year and rolled forward if it has passed.
function withinNextDays(dateStr, days) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date(new Date().toISOString().slice(0, 10));
  let next = new Date(now.getFullYear(), d.getMonth(), d.getDate());
  if (next < now) next = new Date(now.getFullYear() + 1, d.getMonth(), d.getDate());
  const delta = (next - now) / DAY_MS;
  return delta >= 0 && delta <= days;
}

// The dashboard's four filters, all exact-match and AND'd together.
function matchesFilters(e, q) {
  if (q.department && e.department !== q.department) return false;
  if (q.location && e.location !== q.location) return false;
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
router.get('/', requirePerm(null, 'hrms', 'HRMS Dashboard', 'view'), async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const period = dateRange.fromQuery(req, res);
  if (!period) return;
  const inDays = dateRange.dayStringIn(period);

  // SCOPED, like every other employee list in the app. This read had no filter
  // at all, so a TL opening the HRMS Dashboard saw the WHOLE COMPANY: 28 Total
  // Employees and a Headcount-by-Department panel naming every department,
  // while HRMS -> Employees beside it correctly showed 8. Same helper
  // utils/scope.js gives /api/employees, so the two screens agree and widening
  // a role's scope widens both.
  const allEmployees = await prisma.employee.findMany({
    where: withoutSystemAccounts(employeeWhere(req.user)), // Super Admin is a system account, not headcount
    include: { reportingManager: true, user: { select: { status: true } } },
    orderBy: { name: 'asc' },
  });
  const employees = allEmployees.filter((e) => matchesFilters(e, req.query));
  const ids = employees.map((e) => e.id);

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
    prisma.announcement.findMany({ orderBy: { createdAt: 'desc' }, take: 4 }),
    // These four counted the WHOLE COMPANY while every tile above them was
    // already restricted to `ids` — so a TL's "Pending Tasks" panel reported
    // other departments' assets, training, targets and tickets.
    prisma.employeeRecord.count({ where: { type: 'ASSET', status: 'Assigned', employeeId: { in: ids } } }),
    prisma.courseAssignment.count({ where: { completed: false, employeeId: { in: ids } } }),
    prisma.employeeRecord.count({ where: { type: 'TARGET', status: 'In Progress', employeeId: { in: ids } } }),
    prisma.employeeRecord.count({ where: { type: 'HELPDESK', status: { notIn: ['Resolved', 'Closed'] }, employeeId: { in: ids } } }),
  ]);

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
  const cfg = (await prisma.hrConfig.findFirst()) || await prisma.hrConfig.create({ data: {} });
  const roll = await D.rollOf(prisma, employees);
  const asOf = period.to < D.localDate() ? period.to : D.localDate();
  const onDay = roll.employees.filter((e) => D.onRolls(e, asOf, asOf, roll.lastDayOf));
  const dayLoad = await D.loadDays(prisma, { employees: onDay, from: asOf, to: asOf, cfg, lastDayOf: roll.lastDayOf, preview: true });
  const dayTally = D.tally(onDay.map((e) => dayLoad.days(e)[0]));
  let computed = null;
  if (period.days <= insights.MAX_DAY_RANGE) {
    const working = roll.employees.filter((e) => D.onRolls(e, period.from, period.to, roll.lastDayOf));
    const { days } = await D.loadDays(prisma, { employees: working, from: period.from, to: period.to, cfg, lastDayOf: roll.lastDayOf, preview: true });
    const per = working.map((e) => {
      const rows = days(e).filter((d) => !['Upcoming', 'Not Joined', 'Left'].includes(d.status));
      return { employee: e, rows, summary: D.summarise(rows) };
    });
    computed = insights.buildAttendance(per, period);
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
  const joinedInRange = (e) => {
    if (!e.dateOfJoining) return false;
    const d = new Date(e.dateOfJoining).toISOString().slice(0, 10);
    return d >= period.from && d <= period.to;
  };
  const deptCounts = {};
  employees.forEach((e) => { if (e.department) deptCounts[e.department] = (deptCounts[e.department] || 0) + 1; });

  // Spec item 8 — BIRTHDAYS (and work anniversaries) ONLY FOR PEOPLE STILL
  // WORKING HERE. Inactive, suspended, resigned (serving notice) and exited
  // employees are left out, whatever filter the dashboard has, and so is any
  // test row. Soonest first, so "next 30 days" reads in date order.
  const celebrating = employees.filter((e) => hrStatusOf(e.employmentStatus, e.user && e.user.status) === 'Active'
    && !/zztest|example\.test/i.test(`${e.name} ${e.email || ''}`));
  const daysUntil = (dateStr) => {
    const d = new Date(dateStr);
    const now = new Date(new Date().toISOString().slice(0, 10));
    let next = new Date(now.getFullYear(), d.getMonth(), d.getDate());
    if (next < now) next = new Date(now.getFullYear() + 1, d.getMonth(), d.getDate());
    return (next - now) / DAY_MS;
  };
  const soonest = (field) => (a, b) => daysUntil(a[field]) - daysUntil(b[field]);
  const celebrations = [
    ...celebrating.filter((e) => withinNextDays(e.dateOfBirth, 30)).sort(soonest('dateOfBirth')).slice(0, 4)
      .map((e) => ({ name: e.name, kind: 'Birthday', date: e.dateOfBirth })),
    ...celebrating.filter((e) => e.dateOfJoining && withinNextDays(e.dateOfJoining, 30) && new Date(e.dateOfJoining).getFullYear() < new Date().getFullYear()).sort(soonest('dateOfJoining')).slice(0, 4)
      .map((e) => ({ name: e.name, kind: 'Work Anniversary', date: e.dateOfJoining })),
  ];

  res.json({
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
      return {
        departments: [...dept.keys()].sort(),
        locations: [...loc.keys()].sort(),
        statuses: HR_STATUSES.filter((s) => stat.has(s) || s === req.query.status),
        managers: [...mgr.keys()].filter((id) => mgrName.has(id))
          .map((id) => ({ id, name: mgrName.get(id), count: mgr.get(id) }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        counts: {
          department: Object.fromEntries(dept), location: Object.fromEntries(loc), status: Object.fromEntries(stat),
        },
      };
    })(),
    employeeOverview: {
      total: employees.length,
      active: employees.filter((e) => e.employmentStatus === 'Active').length,
      newJoiners: employees.filter(joinedInRange).length,
      onLeave: onLeave.size,
      servingNotice: employees.filter((e) => e.employmentStatus === 'Notice Period').length,
      exitProcess: employees.filter((e) => e.employmentStatus === 'Exit Process').length,
      relieved: employees.filter((e) => e.employmentStatus === 'Relieved').length,
    },
    // PEOPLE on one day (asOf) — see above. present + halfDay + absent +
    // onLeave + offDay + noRecord + notYet (+ upcoming) = headcount.
    attendanceOverview: {
      asOf,
      headcount: dayTally.headcount,
      present: dayTally.present,
      late: dayTally.late, // of those present / half day
      halfDay: dayTally.halfDay,
      absent: dayTally.absent,
      onLeave: dayTally.onLeave,
      offDay: dayTally.offDay,
      noRecord: dayTally.noRecord,
      notYet: dayTally.notYet,
      upcoming: dayTally.upcoming,
      missingPunch: dayTally.missingCheckIn + dayTally.missingCheckOut,
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
      pending: leaveRequests.filter((l) => l.status === 'Pending').length,
      approved: leaveRequests.filter((l) => l.status === 'Approved').length,
      rejected: leaveRequests.filter((l) => l.status === 'Rejected').length,
      cancellationRequests: leaveRequests.filter((l) => l.status === 'Cancellation Requested').length,
      upcoming: leaveUpcoming,
    },
    pendingTasks: {
      leaveApprovals: leavePending,
      attendanceRegularization: regularizations.length,
      assetsAssigned: assets,
      trainingPending: courseAssignments,
      openTargets: targets,
      openTickets: tickets,
    },
    headcountByDepartment: Object.keys(deptCounts).sort((a, b) => deptCounts[b] - deptCounts[a]).map((d) => ({ department: d, employees: deptCounts[d] })),
    celebrations,
    upcomingHolidays: holidays.filter((h) => h.date >= today).slice(0, 4),
    announcements,
    // Same shape the dashboard's CSV export writes, so the file matches the screen.
    exportRows: employees.map((e) => ({
      employeeCode: e.employeeCode, name: e.name, department: e.department || '',
      designation: e.designation || '', status: e.employmentStatus,
    })),
  });
});

module.exports = router;
