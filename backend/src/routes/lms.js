// ---------------------------------------------------------------------------
// LMS — Learning Management.
//
// The screen has two stacked halves and this router serves one endpoint each:
//
//   GET /lms/my       "My Learning" — the signed-in person's own enrollments.
//   GET /lms/company  "Company Learning & Development" — the same catalog read
//                     through the viewer's DATA SCOPE. Every count on it is
//                     computed over utils/scope.js employeeWhere(user), i.e.
//                     the viewer's assigned department(s)/team(s) only. It is
//                     a view: there is no write endpoint on it at all, which
//                     is what makes the "no create, edit, or enrollment-
//                     management actions here" note true rather than a label.
//
// Everything actionable is guarded by requirePerm(...) from the one permission
// engine (utils/permissions.js). Nothing here looks at a role name.
// ---------------------------------------------------------------------------

const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { employeeWhere, scopeOf } = require('../utils/scope');

const router = express.Router();
router.use(requireAuth);

// Reaching the LMS at all is the Performance & Development view permission —
// the same one the Performance & Development screen the LMS is a tab of needs.
const VIEW = requirePerm(null, 'hrms', 'Performance & Development', 'view');
// Self-enrollment is self-service, so it rides on the same VIEW grant; the
// two MANAGE actions below are the engine's create/edit on the same feature.
const MANAGE = requirePerm(null, 'hrms', 'Performance & Development', 'create');

function pct(done, total) {
  return total > 0 ? Math.round((done / total) * 100) : 0;
}

// The shape every course row on the screen renders from.
function courseRow(course, assignments, extra = {}) {
  const done = assignments.filter((a) => a.completed).length;
  return {
    id: course.id,
    title: course.title,
    category: course.category || null,
    duration: course.duration || null,
    mandatory: !!course.mandatory,
    passMark: course.passMark ?? 70,
    completed: done,
    total: assignments.length,
    pct: pct(done, assignments.length),
    ...extra,
  };
}

async function ownEmployee(req) {
  return prisma.employee.findUnique({ where: { userId: req.user.id } });
}

// --- A. My Learning --------------------------------------------------------
router.get('/my', VIEW, async (req, res) => {
  const [courses, me] = await Promise.all([
    prisma.course.findMany({ orderBy: [{ mandatory: 'desc' }, { title: 'asc' }] }),
    ownEmployee(req),
  ]);
  const mine = me
    ? await prisma.courseAssignment.findMany({ where: { employeeId: me.id } })
    : [];
  const byCourse = new Map(mine.map((a) => [a.courseId, a]));

  res.json({
    // No linked employee record = nothing to enrol. Said plainly rather than
    // rendered as an empty screen.
    linked: !!me,
    enrolledCourses: mine.length,
    certificatesEarned: mine.filter((a) => a.completed).length,
    // "0 / 0 completed (0%)" on a My Learning row is the viewer's OWN
    // progress: this app records completion per course, not per lesson, so an
    // enrolment is one unit. Not enrolled reads 0 / 0.
    courses: courses.map((c) => {
      const a = byCourse.get(c.id);
      return courseRow(c, a ? [a] : [], {
        enrolled: !!a,
        assignmentId: a ? a.id : null,
        completedAt: a && a.completedAt ? a.completedAt : null,
      });
    }),
    canEnroll: !!me,
  });
});

// Enrol MYSELF. Self-service, so it needs the view grant and nothing more —
// and it can only ever write the signed-in person's own employee row.
router.post('/my/enroll', VIEW, async (req, res) => {
  const me = await ownEmployee(req);
  if (!me) return res.status(404).json({ error: 'No employee record is linked to this login' });
  const { courseId } = req.body;
  if (!courseId) return res.status(400).json({ error: 'courseId is required' });
  const course = await prisma.course.findUnique({ where: { id: courseId } });
  if (!course) return res.status(404).json({ error: 'Course not found' });
  const existing = await prisma.courseAssignment.findUnique({
    where: { courseId_employeeId: { courseId, employeeId: me.id } },
  });
  if (existing) return res.json(existing);
  const created = await prisma.courseAssignment.create({ data: { courseId, employeeId: me.id } });
  await logAudit({ userId: req.user.id, action: 'Enrolled in course', entity: 'Course', entityId: courseId, toValue: course.title });
  res.status(201).json(created);
});

// Request the course material — a real record, listed back on My Learning and
// counted on the Company section's Training Reports screen.
router.get('/my/material-requests', VIEW, async (req, res) => {
  const me = await ownEmployee(req);
  if (!me) return res.json([]);
  const rows = await prisma.employeeRecord.findMany({
    where: { type: 'LMS_MATERIAL', employeeId: me.id },
    orderBy: { createdAt: 'desc' },
  });
  res.json(rows);
});

router.post('/my/material-requests', VIEW, async (req, res) => {
  const me = await ownEmployee(req);
  if (!me) return res.status(404).json({ error: 'No employee record is linked to this login' });
  const { courseId, note } = req.body;
  const course = courseId ? await prisma.course.findUnique({ where: { id: courseId } }) : null;
  if (!course) return res.status(400).json({ error: 'Choose a course' });
  const record = await prisma.employeeRecord.create({
    data: {
      type: 'LMS_MATERIAL', employeeId: me.id,
      title: `Material download — ${course.title}`,
      detail: note || null, status: 'Pending', category: course.category || null,
    },
  });
  await logAudit({ userId: req.user.id, action: 'Course material requested', entity: 'Course', entityId: course.id, toValue: course.title });
  res.status(201).json(record);
});

// --- B. Company Learning & Development -------------------------------------
// Read-only by construction. Every figure is computed over the employees the
// viewer's scope reaches, so a Medical TL sees Medical's learning and an
// employee with no team scope sees their own — the scope note, enforced.
router.get('/company', VIEW, async (req, res) => {
  const scope = scopeOf(req.user);
  const employees = await prisma.employee.findMany({
    where: employeeWhere(req.user),
    select: { id: true, name: true, department: true, team: true },
  });
  const ids = employees.map((e) => e.id);
  const [courses, assignments] = await Promise.all([
    prisma.course.findMany({ orderBy: [{ mandatory: 'desc' }, { title: 'asc' }] }),
    ids.length
      ? prisma.courseAssignment.findMany({
        where: { employeeId: { in: ids } },
        include: { employee: { select: { id: true, name: true, department: true, team: true } } },
        orderBy: { assignedAt: 'desc' },
      })
      : [],
  ]);
  const byCourse = new Map();
  assignments.forEach((a) => {
    if (!byCourse.has(a.courseId)) byCourse.set(a.courseId, []);
    byCourse.get(a.courseId).push(a);
  });

  const rows = courses.map((c) => courseRow(c, byCourse.get(c.id) || []));
  const materialRequests = ids.length
    ? await prisma.employeeRecord.findMany({
      where: { type: 'LMS_MATERIAL', employeeId: { in: ids } },
      include: { employee: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    })
    : [];

  res.json({
    // What the viewer's scope actually resolved to, printed on the screen so
    // the numbers are never mistaken for company-wide ones.
    scope: {
      global: scope.global,
      departments: scope.departments,
      teams: scope.teams,
      employeeCount: employees.length,
    },
    // "Active" = running in your scope: at least one enrollment you can see.
    activeCourses: rows.filter((r) => r.total > 0).length,
    totalEnrolled: assignments.length,
    courses: rows,
    // The Key Feature screens read from these; all of them are in-scope only.
    enrollments: assignments.map((a) => ({
      id: a.id,
      courseId: a.courseId,
      course: courses.find((c) => c.id === a.courseId)?.title || '—',
      employee: a.employee?.name || '—',
      department: a.employee?.department || '—',
      team: a.employee?.team || '—',
      completed: a.completed,
      assignedAt: a.assignedAt,
      completedAt: a.completedAt,
      passMark: courses.find((c) => c.id === a.courseId)?.passMark ?? 70,
    })),
    materialRequests: materialRequests.map((m) => ({
      id: m.id, title: m.title, employee: m.employee?.name || '—',
      status: m.status, createdAt: m.createdAt,
    })),
  });
});

// --- Existing endpoints, unchanged in behaviour ----------------------------

router.get('/courses', async (req, res) => {
  const courses = await prisma.course.findMany({ include: { assignments: true }, orderBy: { createdAt: 'desc' } });
  res.json(courses);
});

router.post('/courses', MANAGE, async (req, res) => {
  const { title, category, duration, mandatory, passMark } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });
  const course = await prisma.course.create({
    data: {
      title, category, duration,
      mandatory: !!mandatory,
      passMark: passMark != null ? Math.max(0, Math.min(100, Number(passMark))) : 70,
    },
  });
  await logAudit({ userId: req.user.id, action: 'Course created', entity: 'Course', entityId: course.id });
  res.status(201).json(course);
});

router.get('/assignments', async (req, res) => {
  const where = {};
  if (req.user.caps.hrmsSelfOnly) {
    const own = await prisma.employee.findUnique({ where: { userId: req.user.id } });
    if (!own) return res.json([]);
    where.employeeId = own.id;
  } else if (req.query.employeeId) {
    where.employeeId = req.query.employeeId;
  }
  const assignments = await prisma.courseAssignment.findMany({ where, include: { course: true, employee: true } });
  res.json(assignments);
});

router.post('/assignments', MANAGE, async (req, res) => {
  const { courseId, employeeId } = req.body;
  if (!courseId || !employeeId) return res.status(400).json({ error: 'courseId and employeeId are required' });
  const assignment = await prisma.courseAssignment.create({ data: { courseId, employeeId } });
  res.status(201).json(assignment);
});

router.patch('/assignments/:id/complete', async (req, res) => {
  const assignment = await prisma.courseAssignment.findUnique({ where: { id: req.params.id }, include: { employee: true } });
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
  if (req.user.caps.hrmsSelfOnly && assignment.employee.userId !== req.user.id) {
    return res.status(403).json({ error: "This isn't included in your role's permissions" });
  }
  const updated = await prisma.courseAssignment.update({
    where: { id: req.params.id },
    data: { completed: true, completedAt: assignment.completedAt || new Date() },
  });
  res.json(updated);
});

module.exports = router;
