const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);

// --- DEPARTMENT-TARGETED PUBLISHING ---------------------------------------
// "engagement surveys lo department wise publish avvali" — a survey is now
// published TO named departments. NULL or empty targets EVERY department,
// which is what every survey created before this column meant, so nothing
// about the existing ones changes.
//
// The stored shape is a comma-separated list of department names, the same
// shape User.atsScopeDepartments uses, so it reads the same way everywhere.
function parseDepartments(value) {
  if (Array.isArray(value)) return value.map((d) => String(d).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((d) => d.trim()).filter(Boolean);
  return [];
}

// Does this survey reach that department? An untargeted survey reaches all.
function reaches(survey, department) {
  const targets = parseDepartments(survey.departments);
  if (!targets.length) return true;
  return !!department && targets.includes(department);
}

// The department the CALLER sits in, off their employee record.
async function callerDepartment(req) {
  const own = await prisma.employee.findUnique({ where: { userId: req.user.id }, select: { department: true } });
  return own ? own.department : null;
}

const { hrmsGlobal, departmentsOf } = require('../utils/scope');

// Which departments' surveys this login may SEE.
//
// Only the company-wide HRMS roles (Super Admin, Admin, HR) see every one. A
// Manager, an STL or a TL sees the surveys published to the departments in
// THEIR scope and no others — an IT TL has no business reading a survey
// published to Medical, which is the same department isolation the rest of
// HRMS enforces. `undefined` here means unrestricted.
function surveyDepartments(user) {
  if (hrmsGlobal(user)) return undefined;
  return departmentsOf(user);
}


router.get('/', async (req, res) => {
  const surveys = await prisma.survey.findMany({ include: { responses: true }, orderBy: { createdAt: 'desc' } });
  // A lead sees every survey so they can read the aggregate; an employee sees
  // only what was published to their department. Filtered in JS rather than
  // SQL because the target list is a CSV column, and the set is small.
  const allowed = surveyDepartments(req.user);
  const visible = allowed === undefined
    ? surveys
    : surveys.filter((s) => {
      const targets = parseDepartments(s.departments);
      // Untargeted reaches everybody; otherwise the viewer's scope has to
      // overlap the survey's target list.
      if (!targets.length) return true;
      return targets.some((t) => allowed.includes(t));
    });
  res.json(visible.map((s) => ({
    ...s,
    questions: JSON.parse(s.questions),
    departments: parseDepartments(s.departments),
  })));
});

router.post('/', requirePerm(null, 'hrms', 'Employee Services', 'create'), async (req, res) => {
  const { title, questions } = req.body; // questions: string[]
  if (!title || !Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: 'title and a non-empty questions array are required' });
  }
  // The department dropdown. Nothing selected = published to everybody, which
  // is the same thing an empty column has always meant.
  const departments = parseDepartments(req.body.departments);
  const survey = await prisma.survey.create({
    data: {
      title,
      questions: JSON.stringify(questions),
      departments: departments.length ? departments.join(',') : null,
    },
  });
  await logAudit({ userId: req.user.id, action: 'Survey created', entity: 'Survey', entityId: survey.id });
  res.status(201).json({ ...survey, questions, departments });
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
  // ENFORCED SERVER-SIDE, not just hidden from the list: a survey published
  // to Medical cannot be answered by IT even with the id in hand.
  if (!reaches(survey, own.department)) {
    return res.status(403).json({ error: 'This survey was not published to your department' });
  }
  const response = await prisma.surveyResponse.upsert({
    where: { surveyId_employeeId: { surveyId: req.params.id, employeeId: own.id } },
    update: { answers: JSON.stringify(answers) },
    create: { surveyId: req.params.id, employeeId: own.id, answers: JSON.stringify(answers) },
  });
  res.status(201).json(response);
});

module.exports = router;
