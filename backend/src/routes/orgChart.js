// ---------------------------------------------------------------------------
// /api/org-chart — the overall organisation chart (Administration -> Organization Chart).
//
//   GET /     the reporting tree: Super Admin -> Managers / Assistant Managers -> departments -> STL -> TL -> employees,
//             with who is present / on leave / absent today and the numbers for the strip on top.
//
// READ ONLY, and it keeps nothing of its own: utils/orgChart.js builds the tree from Employee (reporting manager, TL, STL,
// department, team), the seat structure (Positions) and today's attendance / leave. Who may open it is the Role Catalog's
// "Organization Structure" view right (Super Admin and Admin; a Manager / Assistant Manager only when it is switched on for
// them), and WHO IS ON IT is the caller's own employee scope (utils/scope.js employeeWhere): nobody sees more people here
// than in Employee Management. Phone numbers, e-mail addresses and every other personal field stay out of this answer.
//
// Talking to a person from the chart goes through the existing conversation routes (/api/conversations/person/employees/:id),
// which apply their own contact-right and scope checks, so this file sends nothing.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { employeeWhere, scopeLabel } = require('../utils/scope');
const { withoutSystemAccounts } = require('../utils/systemAccounts');
const { hrStatusOf, EXIT_EMPLOYMENT } = require('../utils/hrStatus');
const D = require('../utils/attendanceDays');
const chart = require('../utils/orgChart');

const router = express.Router();
router.use(requireAuth);

router.get('/', requirePerm(null, 'administration', 'Organization Structure', 'view'), async (req, res, next) => {
  try {
    const today = D.localDate();
    const where = { AND: [withoutSystemAccounts(employeeWhere(req.user)), { employmentStatus: { notIn: EXIT_EMPLOYMENT } }] };
    const rows = await prisma.employee.findMany({
      where,
      select: {
        id: true, employeeCode: true, name: true, designation: true, department: true, team: true, tl: true, stl: true,
        reportingManagerId: true, employmentStatus: true,
        user: { select: { role: true, hrmsRole: true, status: true } },
      },
      orderBy: { name: 'asc' },
    });
    const ids = rows.map((r) => r.id);

    // The seat each person holds and the seat that seat reports to (Positions & Seat History). An old database
    // without these tables still gets a chart from the employee records alone.
    const seatOf = new Map(); // employeeId -> { code, reportsToEmployeeId }
    try {
      const assignments = await prisma.positionAssignment.findMany({
        where: { toDate: null, employeeId: { in: ids } },
        select: { employeeId: true, position: { select: { id: true, code: true, reportsToId: true } } },
      });
      const holderOfSeat = new Map(assignments.map((a) => [a.position.id, a.employeeId]));
      assignments.forEach((a) => {
        seatOf.set(a.employeeId, { code: a.position.code, reportsToEmployeeId: a.position.reportsToId ? holderOfSeat.get(a.position.reportsToId) || null : null });
      });
    } catch { /* no seat structure yet: employee records only */ }

    // Today: the attendance mark, else an approved leave that covers today.
    const attendance = new Map();
    const onLeave = new Set();
    try {
      const marks = await prisma.attendance.findMany({ where: { date: today, employeeId: { in: ids } }, select: { employeeId: true, status: true } });
      marks.forEach((m) => attendance.set(m.employeeId, m.status));
      const leaves = await prisma.leaveRequest.findMany({
        where: { status: 'Approved', fromDate: { lte: today }, toDate: { gte: today }, employeeId: { in: ids } },
        select: { employeeId: true },
      });
      leaves.forEach((l) => onLeave.add(l.employeeId));
    } catch { /* attendance not available: everybody shows as "not marked" */ }

    const employees = rows.map((r) => {
      const seat = seatOf.get(r.id) || {};
      return {
        id: r.id,
        employeeCode: r.employeeCode,
        name: r.name,
        designation: r.designation,
        department: r.department,
        team: r.team,
        tl: r.tl,
        stl: r.stl,
        reportingManagerId: r.reportingManagerId,
        user: r.user,
        hrStatus: hrStatusOf(r.employmentStatus || 'Active', r.user ? (r.user.status || 'Active') : 'No login'),
        seatCode: seat.code || null,
        seatReportsToEmployeeId: seat.reportsToEmployeeId || null,
      };
    });

    // Super Admin logins that are not employees at all: named only when nobody on the chart is a Super Admin.
    let superAdminLogins = [];
    if (!employees.some((e) => chart.levelOf(e) === 'SUPER_ADMIN')) {
      try {
        const sa = await prisma.user.findMany({
          where: { OR: [{ role: 'SUPER_ADMIN' }, { hrmsRole: 'SUPER_ADMIN' }], status: 'Active' }, select: { name: true }, orderBy: { name: 'asc' },
        });
        superAdminLogins = sa;
      } catch { /* leave empty */ }
    }

    const out = chart.build({
      employees, attendance, onLeave, superAdminLogins, today, viewerEmployeeId: req.user.employeeId || null,
    });
    res.json({ ...out, scope: scopeLabel(req.user) });
  } catch (err) { next(err); }
});

module.exports = router;
