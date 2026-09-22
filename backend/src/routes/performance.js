const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { employeeRecordWhere, employeeInScope, OUT_OF_SCOPE } = require('../utils/scope');
const chain = require('../utils/chainRoute');

// §13 — A RECOMMENDATION IS NOT AN AWARD.
//
// `recommendation` on the row is the reviewer's opinion, computed from the
// score. It used to be the whole story: a TL typed a review and the employee
// was Recommended, full stop. The spec says a recommendation CLIMBS:
//
//   TL recommends → STL → Assistant Manager → Manager → HR → Super Admin
//
// so `approvalStatus` is now whether the ladder AGREED. The two words stay
// different on purpose — "Recommended" is what the TL thinks, "Approved" is
// what the company has decided.
//
// THE APPLICANT IS THE REVIEWER, NOT THE SUBJECT. A TL recommending one of
// their team is the one raising the request, so the chain starts above the
// TL — and the TL cannot approve their own recommendation. The LADDER is
// still resolved from the SUBJECT employee, because it is their department
// and their reporting line the request travels up.
const WF_REWARD = 'reward';

const router = express.Router();
router.use(requireAuth);


router.get('/', async (req, res) => {
  const where = { ...employeeRecordWhere(req.user) };
  if (req.query.employeeId) where.employeeId = req.query.employeeId;
  const reviews = await prisma.performanceReview.findMany({ where, include: { employee: true }, orderBy: { createdAt: 'desc' } });
  res.json(await chain.decorate(WF_REWARD, reviews));
});

router.post('/', requirePerm(null, 'hrms', 'Performance & Development', 'create'), async (req, res) => {
  const { employeeId, period, score, notes } = req.body;
  if (!employeeId || !period || score == null) return res.status(400).json({ error: 'employeeId, period and score are required' });
  const target = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!target) return res.status(404).json({ error: 'Employee not found' });
  if (!employeeInScope(req.user, target)) return res.status(403).json(OUT_OF_SCOPE);
  const band = score >= 75 ? 'High' : score >= 50 ? 'Medium' : 'Low';
  const recommendation = score >= 60 ? 'Recommended' : 'Not Recommended';
  // The reviewer is the applicant. Their own employee row is what names
  // their rung on the ladder, which is how a TL's recommendation starts at
  // the STL rather than at themselves.
  const reviewer = await prisma.employee.findUnique({ where: { userId: req.user.id } });
  const review = await prisma.performanceReview.create({
    data: {
      employeeId, period, score: Number(score), band, recommendation, notes,
      raisedById: req.user.id,
      approvalStatus: 'Pending',
    },
  });
  // The chain travels up the SUBJECT's reporting line, raised by the REVIEWER.
  const started = await chain.raise(WF_REWARD, {
    recordId: review.id,
    employee: target,
    applicantUserId: req.user.id,
    applicantName: reviewer ? reviewer.name : req.user.name,
  });
  // NOBODY ABOVE THE REVIEWER TO ASK — a Super Admin writing a review, or a
  // department with no ladder configured. It stands as written, exactly as
  // every review did before this shipped.
  if (!started.pending) {
    await prisma.performanceReview.update({ where: { id: review.id }, data: { approvalStatus: 'Approved' } });
    review.approvalStatus = 'Approved';
  }
  await logAudit({ userId: req.user.id, action: 'Performance review recorded', entity: 'PerformanceReview', entityId: review.id });
  res.status(201).json({ ...review, workflow: started.summary });
});

// One rung of the ladder deciding on a recommendation. Same shape as every
// other chained decision: act, and only the LAST rung writes the outcome.
router.patch('/:id/decision', requirePerm(null, 'hrms', 'Performance & Development', 'approve'), async (req, res) => {
  const { status, reason } = req.body; // Approved | Rejected
  if (!['Approved', 'Rejected'].includes(status)) return res.status(400).json({ error: 'status must be Approved or Rejected' });
  const existing = await prisma.performanceReview.findUnique({ where: { id: req.params.id }, include: { employee: true } });
  if (!existing) return res.status(404).json({ error: 'Review not found' });
  if (existing.approvalStatus !== 'Pending') return res.status(409).json({ error: `This recommendation was already ${existing.approvalStatus.toLowerCase()}.` });
  if (!await chain.mayTouch(WF_REWARD, existing.id, req.user, existing.employee)) {
    return res.status(403).json(chain.OUT_OF_SCOPE);
  }

  await chain.ensure(WF_REWARD, { recordId: existing.id, employee: existing.employee, open: true });
  const step = await chain.decide(WF_REWARD, existing.id, req.user, { decision: status, note: reason });
  if (step.error) return res.status(step.error.status).json(step.error.body);

  if (step.chained) {
    await logAudit({
      userId: req.user.id,
      action: `Recommendation ${status.toLowerCase()} at ${step.result.level}`,
      entity: 'PerformanceReview',
      entityId: existing.id,
      fromValue: step.result.level,
      toValue: step.result.nextLevel || step.result.outcome,
    });
    // STILL CLIMBING — the recommendation stays Pending and nothing is
    // awarded. Only the top of the ladder turns it into an approval.
    if (!step.result.complete) return res.json({ ...existing, workflow: step.view });
  }

  const updated = await prisma.performanceReview.update({
    where: { id: existing.id },
    data: { approvalStatus: status === 'Rejected' ? 'Rejected' : 'Approved' },
  });
  res.json({ ...updated, workflow: step.view || null });
});

module.exports = router;
