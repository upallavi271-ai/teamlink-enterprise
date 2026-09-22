const express = require('express');
const prisma = require('../db');
const { employeeRecordWhere } = require('../utils/scope');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);


router.get('/', async (req, res) => {
  // A PROJECT IS VISIBLE WHEN SOMEBODY IN SCOPE IS ON IT. The project row
  // itself is not departmental, but its assignment list names people — so an
  // unscoped read handed a TL the staffing of every other department's work.
  // Projects with nobody assigned stay visible: there is nothing private on
  // them yet.
  const scope = employeeRecordWhere(req.user);
  const where = Object.keys(scope).length
    ? { OR: [{ assignments: { none: {} } }, { assignments: { some: scope } }] }
    : {};
  const projects = await prisma.project.findMany({
    where,
    include: { assignments: { where: Object.keys(scope).length ? scope : undefined, include: { employee: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(projects);
});

router.get('/:id', async (req, res) => {
  const project = await prisma.project.findUnique({ where: { id: req.params.id }, include: { assignments: { include: { employee: true } } } });
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(project);
});

router.post('/', requirePerm(null, 'hrms', 'Performance & Development', 'create'), async (req, res) => {
  const { name, status } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const project = await prisma.project.create({ data: { name, status: status || 'Active' } });
  await logAudit({ userId: req.user.id, action: 'Project created', entity: 'Project', entityId: project.id });
  res.status(201).json(project);
});

router.post('/:id/assign', requirePerm(null, 'hrms', 'Performance & Development', 'edit'), async (req, res) => {
  const { employeeId, role } = req.body;
  if (!employeeId) return res.status(400).json({ error: 'employeeId is required' });
  const assignment = await prisma.projectAssignment.create({ data: { projectId: req.params.id, employeeId, role } });
  res.status(201).json(assignment);
});

module.exports = router;
