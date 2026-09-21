const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);


router.get('/', async (req, res) => {
  const projects = await prisma.project.findMany({ include: { assignments: { include: { employee: true } } }, orderBy: { createdAt: 'desc' } });
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
