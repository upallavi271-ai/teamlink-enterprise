const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);


router.get('/courses', async (req, res) => {
  const courses = await prisma.course.findMany({ include: { assignments: true }, orderBy: { createdAt: 'desc' } });
  res.json(courses);
});

router.post('/courses', requirePerm(null, 'hrms', 'Performance & Development', 'create'), async (req, res) => {
  const { title, category, duration } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });
  const course = await prisma.course.create({ data: { title, category, duration } });
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

router.post('/assignments', requirePerm(null, 'hrms', 'Performance & Development', 'create'), async (req, res) => {
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
  const updated = await prisma.courseAssignment.update({ where: { id: req.params.id }, data: { completed: true } });
  res.json(updated);
});

module.exports = router;
