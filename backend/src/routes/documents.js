const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);

// --- WHAT MAY BE PUBLISHED TO EMPLOYEES ------------------------------------
// "documents tab lo, except company documents remaining all can publish."
//
// A COMPANY DOCUMENT is the company's own paperwork — registration, tax
// filings, bank mandates, client contracts. It lives on this screen so HR and
// Administration can find it, but it is NEVER pushed to employee
// self-service. Every other category — Policy, Compliance, Handbook, anything
// typed into the creatable dropdown — can be published.
//
// Enforced HERE, not only in the browser: the create path forces it unpublished
// and the visibility toggle refuses to flip it on, so the rule holds for curl
// exactly as it does for the screen.
const INTERNAL_ONLY_CATEGORY = 'Company Documents';
function isInternalOnly(category) {
  return String(category || '').trim().toLowerCase() === INTERNAL_ONLY_CATEGORY.toLowerCase();
}


router.get('/', async (req, res) => {
  const where = req.user.caps.hrmsSelfOnly ? { published: true } : {};
  const documents = await prisma.policyDocument.findMany({ where, include: { acknowledgments: true }, orderBy: { createdAt: 'desc' } });
  const totalEmployees = await prisma.employee.count();
  res.json(documents.map((d) => ({
    ...d,
    totalEmployees,
    // So the screen can explain the missing Publish button instead of just
    // not drawing one.
    publishable: !isInternalOnly(d.category),
  })));
});

router.post('/', requirePerm(null, 'hrms', 'Employee Services', 'create'), async (req, res) => {
  const { title, category, mandatory, target, uploadedDate } = req.body;
  if (!title || !uploadedDate) return res.status(400).json({ error: 'title and uploadedDate are required' });
  const doc = await prisma.policyDocument.create({
    data: {
      title, category, mandatory: !!mandatory, target, uploadedDate, uploadedBy: req.user.name,
      // A company document starts — and stays — off employee self-service.
      published: !isInternalOnly(category),
    },
  });
  await logAudit({ userId: req.user.id, action: 'Document published', entity: 'PolicyDocument', entityId: doc.id });
  res.status(201).json(doc);
});

router.put('/:id/visibility', requirePerm(null, 'hrms', 'Employee Services', 'edit'), async (req, res) => {
  const existing = await prisma.policyDocument.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Document not found' });
  if (!existing.published && isInternalOnly(existing.category)) {
    return res.status(400).json({
      error: `A ${INTERNAL_ONLY_CATEGORY} document is the company's own paperwork and is never published to employees. Change its category first if it is meant for them.`,
    });
  }
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
