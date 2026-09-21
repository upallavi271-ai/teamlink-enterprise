const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);


router.get('/', async (req, res) => {
  const where = req.user.caps.hrmsSelfOnly ? { published: true } : {};
  const documents = await prisma.policyDocument.findMany({ where, include: { acknowledgments: true }, orderBy: { createdAt: 'desc' } });
  const totalEmployees = await prisma.employee.count();
  res.json(documents.map((d) => ({ ...d, totalEmployees })));
});

router.post('/', requirePerm(null, 'hrms', 'Employee Services', 'create'), async (req, res) => {
  const { title, category, mandatory, target, uploadedDate } = req.body;
  if (!title || !uploadedDate) return res.status(400).json({ error: 'title and uploadedDate are required' });
  const doc = await prisma.policyDocument.create({ data: { title, category, mandatory: !!mandatory, target, uploadedDate, uploadedBy: req.user.name } });
  await logAudit({ userId: req.user.id, action: 'Document published', entity: 'PolicyDocument', entityId: doc.id });
  res.status(201).json(doc);
});

router.put('/:id/visibility', requirePerm(null, 'hrms', 'Employee Services', 'edit'), async (req, res) => {
  const existing = await prisma.policyDocument.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Document not found' });
  const doc = await prisma.policyDocument.update({ where: { id: req.params.id }, data: { published: !existing.published } });
  res.json(doc);
});

router.delete('/:id', requirePerm(null, 'hrms', 'Employee Services', 'delete'), async (req, res) => {
  await prisma.acknowledgment.deleteMany({ where: { documentId: req.params.id } });
  await prisma.policyDocument.delete({ where: { id: req.params.id } });
  await logAudit({ userId: req.user.id, action: 'Document deleted', entity: 'PolicyDocument', entityId: req.params.id });
  res.status(204).end();
});

router.post('/:id/acknowledge', async (req, res) => {
  const own = await prisma.employee.findUnique({ where: { userId: req.user.id } });
  if (!own) return res.status(404).json({ error: 'No employee record linked to this account' });
  const ack = await prisma.acknowledgment.upsert({
    where: { documentId_employeeId: { documentId: req.params.id, employeeId: own.id } },
    update: {},
    create: { documentId: req.params.id, employeeId: own.id },
  });
  res.status(201).json(ack);
});

module.exports = router;
