const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);


router.get('/', async (req, res) => {
  const where = {};
  if (req.user.caps.hrmsSelfOnly) {
    const own = await prisma.employee.findUnique({ where: { userId: req.user.id } });
    if (!own) return res.json([]);
    where.employeeId = own.id;
  } else if (req.query.employeeId) {
    where.employeeId = req.query.employeeId;
  }
  const reviews = await prisma.performanceReview.findMany({ where, include: { employee: true }, orderBy: { createdAt: 'desc' } });
  res.json(reviews);
});

router.post('/', requirePerm(null, 'hrms', 'Performance & Development', 'create'), async (req, res) => {
  const { employeeId, period, score, notes } = req.body;
  if (!employeeId || !period || score == null) return res.status(400).json({ error: 'employeeId, period and score are required' });
  const band = score >= 75 ? 'High' : score >= 50 ? 'Medium' : 'Low';
  const recommendation = score >= 60 ? 'Recommended' : 'Not Recommended';
  const review = await prisma.performanceReview.create({ data: { employeeId, period, score: Number(score), band, recommendation, notes } });
  await logAudit({ userId: req.user.id, action: 'Performance review recorded', entity: 'PerformanceReview', entityId: review.id });
  res.status(201).json(review);
});

module.exports = router;
