const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');

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
  if (q.status && e.employmentStatus !== q.status) return false;
  if (q.manager && e.reportingManagerId !== q.manager) return false;
  return true;
}

// Everything the HRMS Dashboard shows, computed against the same filtered
// employee set so every tile, panel and the CSV export agree with each other.
router.get('/', requirePerm(null, 'hrms', 'HRMS Dashboard', 'view'), async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(Date.now() - 30 * DAY_MS);

  const allEmployees = await prisma.employee.findMany({ include: { reportingManager: true }, orderBy: { name: 'asc' } });
  const employees = allEmployees.filter((e) => matchesFilters(e, req.query));
  const ids = employees.map((e) => e.id);

  const [attendanceToday, punchesToday, leaveRequests, regularizations, holidays, announcements, assets, courseAssignments, targets, tickets] = await Promise.all([
    prisma.attendance.findMany({ where: { date: today, employeeId: { in: ids } } }),
    prisma.attendancePunch.findMany({ where: { date: today, employeeId: { in: ids } } }),
    prisma.leaveRequest.findMany({ where: { employeeId: { in: ids } }, include: { employee: true } }),
    prisma.attendanceRegularization.findMany({ where: { employeeId: { in: ids }, status: 'Pending' } }),
    prisma.holiday.findMany({ orderBy: { date: 'asc' } }),
    prisma.announcement.findMany({ orderBy: { createdAt: 'desc' }, take: 4 }),
    prisma.employeeRecord.count({ where: { type: 'ASSET', status: 'Assigned' } }),
    prisma.courseAssignment.count({ where: { completed: false } }),
    prisma.employeeRecord.count({ where: { type: 'TARGET', status: 'In Progress' } }),
    prisma.employeeRecord.count({ where: { type: 'HELPDESK', status: { notIn: ['Resolved', 'Closed'] } } }),
  ]);

  const countStatus = (s) => attendanceToday.filter((a) => a.status === s).length;
  const onLeaveToday = leaveRequests.filter((l) => l.status === 'Approved' && l.fromDate <= today && (l.toDate || l.fromDate) >= today);
  const deptCounts = {};
  employees.forEach((e) => { if (e.department) deptCounts[e.department] = (deptCounts[e.department] || 0) + 1; });

  const celebrations = [
    ...employees.filter((e) => withinNextDays(e.dateOfBirth, 30)).slice(0, 4)
      .map((e) => ({ name: e.name, kind: 'Birthday', date: e.dateOfBirth })),
    ...employees.filter((e) => e.dateOfJoining && withinNextDays(e.dateOfJoining, 30) && new Date(e.dateOfJoining).getFullYear() < new Date().getFullYear()).slice(0, 4)
      .map((e) => ({ name: e.name, kind: 'Work Anniversary', date: e.dateOfJoining })),
  ];

  res.json({
    date: today,
    filterOptions: {
      departments: [...new Set(allEmployees.map((e) => e.department).filter(Boolean))].sort(),
      locations: [...new Set(allEmployees.map((e) => e.location).filter(Boolean))].sort(),
      statuses: ['Active', 'On Probation', 'Notice Period', 'Exit Process', 'Relieved'],
      managers: [...new Map(allEmployees.filter((e) => e.reportingManager).map((e) => [e.reportingManagerId, { id: e.reportingManagerId, name: e.reportingManager.name }])).values()],
    },
    employeeOverview: {
      total: employees.length,
      active: employees.filter((e) => e.employmentStatus === 'Active').length,
      newJoiners30d: employees.filter((e) => e.dateOfJoining && new Date(e.dateOfJoining) >= thirtyDaysAgo).length,
      onLeaveToday: onLeaveToday.length,
      servingNotice: employees.filter((e) => e.employmentStatus === 'Notice Period').length,
      exitProcess: employees.filter((e) => e.employmentStatus === 'Exit Process').length,
      relieved: employees.filter((e) => e.employmentStatus === 'Relieved').length,
    },
    attendanceOverview: {
      present: countStatus('Present'),
      absent: countStatus('Absent'),
      late: countStatus('Late'),
      halfDay: countStatus('Half Day'),
      // Punched in but never punched out (and no manual check-out recorded).
      missingPunch: attendanceToday.filter((a) => (a.checkIn || punchesToday.some((p) => p.employeeId === a.employeeId && p.direction === 'In'))
        && !a.checkOut && !punchesToday.some((p) => p.employeeId === a.employeeId && p.direction === 'Out')).length,
      regularizationPending: regularizations.length,
    },
    leaveOverview: {
      total: leaveRequests.length,
      pending: leaveRequests.filter((l) => l.status === 'Pending').length,
      approved: leaveRequests.filter((l) => l.status === 'Approved').length,
      rejected: leaveRequests.filter((l) => l.status === 'Rejected').length,
      cancellationRequests: leaveRequests.filter((l) => l.status === 'Cancellation Requested').length,
      upcoming: leaveRequests.filter((l) => l.status === 'Approved' && l.fromDate > today).length,
    },
    pendingTasks: {
      leaveApprovals: leaveRequests.filter((l) => l.status === 'Pending').length,
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
