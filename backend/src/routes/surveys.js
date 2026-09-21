const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);


router.get('/', async (req, res) => {
  const surveys = await prisma.survey.findMany({ include: { responses: true }, orderBy: { createdAt: 'desc' } });
  res.json(surveys.map((s) => ({ ...s, questions: JSON.parse(s.questions) })));
});

router.post('/', requirePerm(null, 'hrms', 'Employee Services', 'create'), async (req, res) => {
  const { title, questions } = req.body; // questions: string[]
  if (!title || !Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: 'title and a non-empty questions array are required' });
  }
  const survey = await prisma.survey.create({ data: { title, questions: JSON.stringify(questions) } });
  await logAudit({ userId: req.user.id, action: 'Survey created', entity: 'Survey', entityId: survey.id });
  res.status(201).json({ ...survey, questions });
});

// Close a survey to new responses, or reopen it.
router.patch('/:id/status', requirePerm(null, 'hrms', 'Employee Services', 'edit'), async (req, res) => {
  const { status } = req.body; // Active | Closed
  if (!['Active', 'Closed'].includes(status)) return res.status(400).json({ error: 'status must be Active or Closed' });
  const survey = await prisma.survey.update({ where: { id: req.params.id }, data: { status } });
  await logAudit({ userId: req.user.id, action: `Survey ${status.toLowerCase()}`, entity: 'Survey', entityId: survey.id, toValue: status });
  res.json({ ...survey, questions: JSON.parse(survey.questions) });
});

router.post('/:id/respond', async (req, res) => {
  const { answers } = req.body; // string[]
  const own = await prisma.employee.findUnique({ where: { userId: req.user.id } });
  if (!own) return res.status(404).json({ error: 'No employee record linked to this account' });
  if (!Array.isArray(answers)) return res.status(400).json({ error: 'answers must be an array' });
  const survey = await prisma.survey.findUnique({ where: { id: req.params.id } });
  if (!survey) return res.status(404).json({ error: 'Survey not found' });
  if (survey.status !== 'Active') return res.status(409).json({ error: 'This survey is closed to new responses' });
  const response = await prisma.surveyResponse.upsert({
    where: { surveyId_employeeId: { surveyId: req.params.id, employeeId: own.id } },
    update: { answers: JSON.stringify(answers) },
    create: { surveyId: req.params.id, employeeId: own.id, answers: JSON.stringify(answers) },
  });
  res.status(201).json(response);
});

module.exports = router;
