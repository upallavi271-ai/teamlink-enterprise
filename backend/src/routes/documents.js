const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const {
  EXITED, list, parseAudience, parseChannels, resolveAudience, storedColumns, viewerContext, reaches, reachesEmployee, deliver, describeDelivery,
} = require('../utils/audience');

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


// AUDIENCE (utils/audience.js). A document can be sent to everyone, to one or
// many departments, or to named employees. `totalEmployees` on each row is
// now THAT document's audience size, so "12 / 37 acknowledged" is measured
// against the people it was actually sent to. An employee only sees (and can
// only acknowledge) what was sent to them.
router.get('/', async (req, res) => {
  const where = req.user.caps.hrmsSelfOnly ? { published: true } : {};
  const documents = await prisma.policyDocument.findMany({ where, include: { acknowledgments: true }, orderBy: { createdAt: 'desc' } });
  const ctx = await viewerContext(req.user);
  const own = ctx.selfOnly ? await prisma.employee.findUnique({ where: { userId: req.user.id }, select: { id: true, department: true } }) : null;
  const visible = documents.filter((d) => (ctx.selfOnly ? reachesEmployee(d, own) : reaches(ctx, d)));
  const active = { employmentStatus: { notIn: EXITED } };
  const byDept = new Map((await prisma.employee.groupBy({ by: ['department'], where: active, _count: true }))
    .map((g) => [g.department, g._count]));
  const everyone = [...byDept.values()].reduce((a, b) => a + b, 0);
  res.json(visible.map((d) => {
    const ids = list(d.employeeIds);
    const depts = list(d.departments);
    return {
      ...d,
      departments: depts,
      employeeIds: ids,
      totalEmployees: ids.length ? ids.length : depts.length ? depts.reduce((n, x) => n + (byDept.get(x) || 0), 0) : everyone,
      // So the screen can explain the missing Publish button instead of just
      // not drawing one.
      publishable: !isInternalOnly(d.category),
    };
  }));
});

router.post('/', requirePerm(null, 'hrms', 'Employee Services', 'create'), async (req, res) => {
  const { title, category, mandatory, uploadedDate } = req.body;
  let { target } = req.body;
  if (!title || !uploadedDate) return res.status(400).json({ error: 'title and uploadedDate are required' });
  const aud = parseAudience(req.body);
  let reached = null;
  let columns = { departments: null, employeeIds: null };
  if (aud) {
    const out = await resolveAudience(req.user, aud);
    if (!out.ok) return res.status(out.status).json({ error: out.error });
    reached = out.employees;
    columns = storedColumns(out.audience);
    target = out.label;
  }
  const internal = isInternalOnly(category);
  const doc = await prisma.policyDocument.create({
    data: {
      title, category, mandatory: !!mandatory, target, uploadedDate, uploadedBy: req.user.name,
      createdById: req.user.id, ...columns,
      // A company document starts — and stays — off employee self-service.
      published: !internal,
    },
  });
  // A company document is never pushed to employees, so nobody is told.
  let delivery = null;
  if (reached && !internal) {
    delivery = await deliver({
      employees: reached,
      channels: parseChannels(req.body.channels),
      title: `${mandatory ? 'Please acknowledge' : 'New document'}: ${title}`,
      message: `${title} has been published in Employee Services → Documents${mandatory ? ' and needs your acknowledgement' : ''}.`,
      by: req.user,
      exceptUserId: req.user.id,
    });
  }
  await logAudit({ userId: req.user.id, action: 'Document published', entity: 'PolicyDocument', entityId: doc.id, toValue: target || null });
  res.status(201).json({ ...doc, reached: reached ? reached.length : null, delivery, deliveryText: delivery ? describeDelivery(delivery) : null });
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
  const doc = await prisma.policyDocument.findUnique({ where: { id: req.params.id } });
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  if (!reachesEmployee(doc, own)) return res.status(403).json({ error: 'This document was not sent to you' });
  const ack = await prisma.acknowledgment.upsert({
    where: { documentId_employeeId: { documentId: req.params.id, employeeId: own.id } },
    update: {},
    create: { documentId: req.params.id, employeeId: own.id },
  });
  res.status(201).json(ack);
});

module.exports = router;
