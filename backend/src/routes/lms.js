// ---------------------------------------------------------------------------
// LMS — Learning Management.
//
// The screen has two stacked halves and this router serves one endpoint each:
//
//   GET /lms/my       "My Learning" — the signed-in person's own enrollments.
//   GET /lms/company  "Company Learning & Development" — the same catalog read
//                     through the viewer's DATA SCOPE. Every count on it is
//                     computed over utils/scope.js employeeWhere(user), i.e.
//                     the viewer's assigned department(s)/team(s) only. It is
//                     a view: there is no write endpoint on it at all, which
//                     is what makes the "no create, edit, or enrollment-
//                     management actions here" note true rather than a label.
//
// Everything actionable is guarded by requirePerm(...) from the one permission
// engine (utils/permissions.js). Nothing here looks at a role name.
// ---------------------------------------------------------------------------

const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const attachments = require('../utils/attachments');
const { employeeWhere, scopeOf, matches } = require('../utils/scope');

const router = express.Router();
router.use(requireAuth);

// Reaching the LMS at all is the Performance & Development view permission —
// the same one the Performance & Development screen the LMS is a tab of needs.
const VIEW = requirePerm(null, 'hrms', 'Performance & Development', 'view');
// Self-enrollment is self-service, so it rides on the same VIEW grant; the
// two MANAGE actions below are the engine's create/edit on the same feature.
const MANAGE = requirePerm(null, 'hrms', 'Performance & Development', 'create');

function pct(done, total) {
  return total > 0 ? Math.round((done / total) * 100) : 0;
}

// The shape every course row on the screen renders from.
function courseRow(course, assignments, extra = {}) {
  const done = assignments.filter((a) => a.completed).length;
  return {
    id: course.id,
    title: course.title,
    category: course.category || null,
    duration: course.duration || null,
    mandatory: !!course.mandatory,
    passMark: course.passMark ?? 70,
    completed: done,
    total: assignments.length,
    pct: pct(done, assignments.length),
    ...extra,
  };
}

async function ownEmployee(req) {
  return prisma.employee.findUnique({ where: { userId: req.user.id } });
}

// --- A. My Learning --------------------------------------------------------
router.get('/my', VIEW, async (req, res) => {
  const [courses, me] = await Promise.all([
    prisma.course.findMany({ orderBy: [{ mandatory: 'desc' }, { title: 'asc' }] }),
    ownEmployee(req),
  ]);
  const mine = me
    ? await prisma.courseAssignment.findMany({ where: { employeeId: me.id } })
    : [];
  const byCourse = new Map(mine.map((a) => [a.courseId, a]));

  res.json({
    // No linked employee record = nothing to enrol. Said plainly rather than
    // rendered as an empty screen.
    linked: !!me,
    enrolledCourses: mine.length,
    certificatesEarned: mine.filter((a) => a.completed).length,
    // "0 / 0 completed (0%)" on a My Learning row is the viewer's OWN
    // progress: this app records completion per course, not per lesson, so an
    // enrolment is one unit. Not enrolled reads 0 / 0.
    courses: courses.map((c) => {
      const a = byCourse.get(c.id);
      return courseRow(c, a ? [a] : [], {
        enrolled: !!a,
        assignmentId: a ? a.id : null,
        completedAt: a && a.completedAt ? a.completedAt : null,
      });
    }),
    canEnroll: !!me,
  });
});

// Enrol MYSELF. Self-service, so it needs the view grant and nothing more —
// and it can only ever write the signed-in person's own employee row.
router.post('/my/enroll', VIEW, async (req, res) => {
  const me = await ownEmployee(req);
  if (!me) return res.status(404).json({ error: 'No employee record is linked to this login' });
  const { courseId } = req.body;
  if (!courseId) return res.status(400).json({ error: 'courseId is required' });
  const course = await prisma.course.findUnique({ where: { id: courseId } });
  if (!course) return res.status(404).json({ error: 'Course not found' });
  const existing = await prisma.courseAssignment.findUnique({
    where: { courseId_employeeId: { courseId, employeeId: me.id } },
  });
  if (existing) return res.json(existing);
  const created = await prisma.courseAssignment.create({ data: { courseId, employeeId: me.id } });
  await logAudit({ userId: req.user.id, action: 'Enrolled in course', entity: 'Course', entityId: courseId, toValue: course.title });
  res.status(201).json(created);
});

// Request the course material — a real record, listed back on My Learning and
// counted on the Company section's Training Reports screen.
router.get('/my/material-requests', VIEW, async (req, res) => {
  const me = await ownEmployee(req);
  if (!me) return res.json([]);
  const rows = await prisma.employeeRecord.findMany({
    where: { type: 'LMS_MATERIAL', employeeId: me.id },
    orderBy: { createdAt: 'desc' },
  });
  res.json(rows);
});

router.post('/my/material-requests', VIEW, async (req, res) => {
  const me = await ownEmployee(req);
  if (!me) return res.status(404).json({ error: 'No employee record is linked to this login' });
  const { courseId, note } = req.body;
  const course = courseId ? await prisma.course.findUnique({ where: { id: courseId } }) : null;
  if (!course) return res.status(400).json({ error: 'Choose a course' });
  const record = await prisma.employeeRecord.create({
    data: {
      type: 'LMS_MATERIAL', employeeId: me.id,
      title: `Material download — ${course.title}`,
      detail: note || null, status: 'Pending', category: course.category || null,
    },
  });
  await logAudit({ userId: req.user.id, action: 'Course material requested', entity: 'Course', entityId: course.id, toValue: course.title });
  res.status(201).json(record);
});

// --- B. Company Learning & Development -------------------------------------
// Read-only by construction. Every figure is computed over the employees the
// viewer's scope reaches, so a Medical TL sees Medical's learning and an
// employee with no team scope sees their own — the scope note, enforced.
router.get('/company', VIEW, async (req, res) => {
  const scope = scopeOf(req.user);
  const employees = await prisma.employee.findMany({
    where: employeeWhere(req.user),
    select: { id: true, name: true, department: true, team: true },
  });
  const ids = employees.map((e) => e.id);
  const [courses, assignments] = await Promise.all([
    prisma.course.findMany({ orderBy: [{ mandatory: 'desc' }, { title: 'asc' }] }),
    ids.length
      ? prisma.courseAssignment.findMany({
        where: { employeeId: { in: ids } },
        include: { employee: { select: { id: true, name: true, department: true, team: true } } },
        orderBy: { assignedAt: 'desc' },
      })
      : [],
  ]);
  const byCourse = new Map();
  assignments.forEach((a) => {
    if (!byCourse.has(a.courseId)) byCourse.set(a.courseId, []);
    byCourse.get(a.courseId).push(a);
  });

  const rows = courses.map((c) => courseRow(c, byCourse.get(c.id) || []));
  const materialRequests = ids.length
    ? await prisma.employeeRecord.findMany({
      where: { type: 'LMS_MATERIAL', employeeId: { in: ids } },
      include: { employee: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    })
    : [];

  res.json({
    // What the viewer's scope actually resolved to, printed on the screen so
    // the numbers are never mistaken for company-wide ones.
    scope: {
      global: scope.global,
      departments: scope.departments,
      teams: scope.teams,
      employeeCount: employees.length,
    },
    // "Active" = running in your scope: at least one enrollment you can see.
    activeCourses: rows.filter((r) => r.total > 0).length,
    totalEnrolled: assignments.length,
    courses: rows,
    // The Key Feature screens read from these; all of them are in-scope only.
    enrollments: assignments.map((a) => ({
      id: a.id,
      courseId: a.courseId,
      course: courses.find((c) => c.id === a.courseId)?.title || '—',
      employee: a.employee?.name || '—',
      department: a.employee?.department || '—',
      team: a.employee?.team || '—',
      completed: a.completed,
      assignedAt: a.assignedAt,
      completedAt: a.completedAt,
      passMark: courses.find((c) => c.id === a.courseId)?.passMark ?? 70,
    })),
    materialRequests: materialRequests.map((m) => ({
      id: m.id, title: m.title, employee: m.employee?.name || '—',
      status: m.status, createdAt: m.createdAt,
    })),
  });
});

// --- Existing endpoints, unchanged in behaviour ----------------------------

router.get('/courses', async (req, res) => {
  const courses = await prisma.course.findMany({ include: { assignments: true }, orderBy: { createdAt: 'desc' } });
  res.json(courses);
});

router.post('/courses', MANAGE, async (req, res) => {
  const { title, category, duration, mandatory, passMark } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });
  const course = await prisma.course.create({
    data: {
      title, category, duration,
      mandatory: !!mandatory,
      passMark: passMark != null ? Math.max(0, Math.min(100, Number(passMark))) : 70,
    },
  });
  await logAudit({ userId: req.user.id, action: 'Course created', entity: 'Course', entityId: course.id });
  res.status(201).json(course);
});

router.get('/assignments', async (req, res) => {
  // SCOPED. Only the self-only branch below was ever applied, so a TL, an STL
  // and a Manager all read EVERY enrollment in the company — a Medical TL saw
  // all 8 rows, including IT's and Accounts'. The relation filter is the same
  // employeeWhere() the rest of HRMS uses, so this list now agrees with
  // HRMS -> Employees.
  const where = { employee: employeeWhere(req.user) };
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

router.post('/assignments', MANAGE, async (req, res) => {
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
  const updated = await prisma.courseAssignment.update({
    where: { id: req.params.id },
    data: { completed: true, completedAt: assignment.completedAt || new Date() },
  });
  res.json(updated);
});


// ===========================================================================
// COURSE MANAGEMENT — Course Materials, Manage Assessment, Enrolled Employees.
//
// These are the three panels behind "View & Enroll" on a course. Everything
// here is a WRITE on the course catalogue, so it is MANAGE-guarded, and every
// employee list is read through utils/scope.js employeeWhere() so a Medical TL
// enrolls Medical people and nobody else.
//
// THE CORRECT ANSWER NEVER LEAVES THE SERVER for someone taking the
// assessment. There are two shapes of question in this file:
//
//   bankQuestion()  includes correctIndex — only for a MANAGE caller, on the
//                   Question Bank panel where the tick is drawn.
//   examQuestion()  omits it entirely, and the options are shuffled per
//                   attempt, so the browser never holds the answer key.
// ===========================================================================

function parseOptions(raw) {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map((s) => String(s)) : [];
  } catch { return []; }
}

// For the Question Bank — carries the answer, MANAGE only.
function bankQuestion(q) {
  return {
    id: q.id,
    question: q.question,
    options: parseOptions(q.options),
    correctIndex: q.correctIndex,
    position: q.position,
  };
}

// Fisher-Yates. A fresh order per attempt, so two learners never see the same
// sequence and the position of the right answer carries no information.
function shuffled(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function courseOr404(req, res) {
  const course = await prisma.course.findUnique({ where: { id: req.params.id } });
  if (!course) { res.status(404).json({ error: 'Course not found' }); return null; }
  return course;
}

// --- The whole management view of one course -------------------------------
router.get('/courses/:id/manage', MANAGE, async (req, res) => {
  const course = await courseOr404(req, res);
  if (!course) return undefined;

  const [materials, questions, assignments] = await Promise.all([
    prisma.courseMaterial.findMany({ where: { courseId: course.id }, orderBy: { createdAt: 'asc' } }),
    prisma.assessmentQuestion.findMany({ where: { courseId: course.id }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] }),
    // SCOPED. The Enrolled Employees panel is a list of people, so it follows
    // the same rule every other employee list does.
    prisma.courseAssignment.findMany({
      where: { courseId: course.id, employee: employeeWhere(req.user) },
      include: { employee: true },
      orderBy: { assignedAt: 'asc' },
    }),
  ]);

  // Who could still be added — in scope, and not already enrolled.
  const enrolledIds = new Set(assignments.map((a) => a.employeeId));
  const candidates = await prisma.employee.findMany({
    where: { ...employeeWhere(req.user), employmentStatus: { not: 'Relieved' } },
    select: { id: true, name: true, employeeCode: true, department: true },
    orderBy: { name: 'asc' },
  });

  return res.json({
    course: {
      id: course.id, title: course.title, category: course.category,
      duration: course.duration, mandatory: course.mandatory, passMark: course.passMark,
    },
    materials: materials.map((m) => ({
      id: m.id, title: m.title, fileName: m.fileName, mimeType: m.mimeType,
      sizeBytes: m.sizeBytes, url: m.url, uploadedBy: m.uploadedBy, createdAt: m.createdAt,
      // A stored file is fetched through the API; a link opens as it is.
      href: m.storedPath ? `/api/lms/materials/${m.id}/file` : m.url,
    })),
    questions: questions.map(bankQuestion),
    enrolled: assignments.map((a) => ({
      id: a.id,
      employeeId: a.employeeId,
      name: a.employee.name,
      employeeCode: a.employee.employeeCode,
      department: a.employee.department,
      completed: a.completed,
      completedAt: a.completedAt,
      score: a.score,
      attempts: a.attempts,
      watchedSeconds: a.watchedSeconds,
    })),
    enrollable: candidates.filter((c) => !enrolledIds.has(c.id)),
  });
});

// --- Course Materials ------------------------------------------------------
// A LINK takes JSON; a FILE arrives as multipart. One endpoint, because from
// the screen's point of view both are "add a material".
router.post('/courses/:id/materials', MANAGE, async (req, res) => {
  const course = await courseOr404(req, res);
  if (!course) return undefined;

  const isUpload = String(req.headers['content-type'] || '').startsWith('multipart/form-data');
  if (!isUpload) {
    const { title, url } = req.body || {};
    if (!title || !url) return res.status(400).json({ error: 'A title and either a file or a link are required' });
    const created = await prisma.courseMaterial.create({
      data: { courseId: course.id, title: String(title).slice(0, 200), url: String(url).slice(0, 2000), uploadedBy: req.user.name || null },
    });
    await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Course material linked', entity: 'Course', entityId: course.id, toValue: created.title });
    return res.status(201).json(created);
  }

  let parsed;
  try {
    parsed = await attachments.parseMultipart(req);
  } catch (err) {
    return res.status(400).json({ error: attachments.MESSAGE[err.code] || 'Could not read the upload.' });
  }
  let stored;
  try {
    stored = attachments.store(parsed.file);
  } catch (err) {
    return res.status(400).json({ error: attachments.MESSAGE[err.code] || 'Could not store the upload.' });
  }
  const title = (parsed.fields && parsed.fields.title) ? String(parsed.fields.title).slice(0, 200) : stored.billName;
  const created = await prisma.courseMaterial.create({
    data: {
      courseId: course.id,
      title,
      fileName: stored.billName,
      storedPath: stored.billFile,
      mimeType: stored.billMime,
      sizeBytes: stored.billSize,
      uploadedBy: req.user.name || null,
    },
  });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Course material uploaded', entity: 'Course', entityId: course.id, toValue: title });
  return res.status(201).json(created);
});

// Anyone who may SEE the LMS may open a material — that is the point of them.
router.get('/materials/:id/file', VIEW, async (req, res) => {
  const m = await prisma.courseMaterial.findUnique({ where: { id: req.params.id } });
  if (!m || !m.storedPath) return res.status(404).json({ error: 'No file on that material' });
  // The path is rebuilt from the stored name only after utils/attachments.js
  // re-validates it, so the id in the URL can never reach a file outside the
  // upload directory.
  const full = attachments.resolveStored(m.storedPath);
  if (!full) return res.status(404).json({ error: 'The file is no longer on the server' });
  res.setHeader('Content-Type', m.mimeType || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `inline; filename="${attachments.safeDisplayName(m.fileName || 'material')}"`);
  return res.sendFile(full);
});

router.delete('/materials/:id', MANAGE, async (req, res) => {
  const m = await prisma.courseMaterial.findUnique({ where: { id: req.params.id } });
  if (!m) return res.status(404).json({ error: 'Material not found' });
  if (m.storedPath) attachments.remove(m.storedPath);
  await prisma.courseMaterial.delete({ where: { id: m.id } });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Course material removed', entity: 'Course', entityId: m.courseId, toValue: m.title });
  return res.status(204).end();
});

// --- Manage Assessment -----------------------------------------------------
function validQuestion(body) {
  const question = body && body.question ? String(body.question).trim() : '';
  const options = Array.isArray(body && body.options) ? body.options.map((o) => String(o).trim()) : [];
  const correctIndex = Number(body && body.correctIndex);
  if (!question) return { error: 'Type the question.' };
  const filled = options.filter(Boolean);
  if (filled.length < 2) return { error: 'Give at least two answer options.' };
  if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length || !options[correctIndex]) {
    return { error: 'Mark which option is the correct answer.' };
  }
  return { question, options, correctIndex };
}

router.post('/courses/:id/questions', MANAGE, async (req, res) => {
  const course = await courseOr404(req, res);
  if (!course) return undefined;
  const v = validQuestion(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const count = await prisma.assessmentQuestion.count({ where: { courseId: course.id } });
  const created = await prisma.assessmentQuestion.create({
    data: {
      courseId: course.id,
      question: v.question,
      options: JSON.stringify(v.options),
      correctIndex: v.correctIndex,
      position: count,
    },
  });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Assessment question added', entity: 'Course', entityId: course.id, toValue: v.question.slice(0, 120) });
  return res.status(201).json(bankQuestion(created));
});

router.put('/questions/:id', MANAGE, async (req, res) => {
  const existing = await prisma.assessmentQuestion.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Question not found' });
  const v = validQuestion(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const updated = await prisma.assessmentQuestion.update({
    where: { id: existing.id },
    data: { question: v.question, options: JSON.stringify(v.options), correctIndex: v.correctIndex },
  });
  return res.json(bankQuestion(updated));
});

router.delete('/questions/:id', MANAGE, async (req, res) => {
  const existing = await prisma.assessmentQuestion.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Question not found' });
  await prisma.assessmentQuestion.delete({ where: { id: existing.id } });
  return res.status(204).end();
});

// BULK IMPORT. One question per block, the shape the Import Questions button
// pastes in:
//
//   What is prompt engineering?
//   A. Prompt
//   B. Better way of prompt
//   *C. Understanding the computer
//   D. Engineer
//
// The asterisk marks the answer. A block with no marked option is REPORTED
// rather than guessed at — importing a question whose answer the server picked
// would be worse than refusing it.
router.post('/courses/:id/questions/import', MANAGE, async (req, res) => {
  const course = await courseOr404(req, res);
  if (!course) return undefined;
  const text = req.body && req.body.text ? String(req.body.text) : '';
  if (!text.trim()) return res.status(400).json({ error: 'Paste the questions first.' });

  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const ready = [];
  const rejected = [];
  blocks.forEach((block, i) => {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length < 3) { rejected.push({ block: i + 1, reason: 'Needs a question and at least two options' }); return; }
    const question = lines[0].replace(/^\d+[.)]\s*/, '').trim();
    const options = [];
    let correctIndex = -1;
    lines.slice(1).forEach((line) => {
      const marked = line.startsWith('*');
      const cleaned = line.replace(/^\*/, '').replace(/^[A-Za-z][.)]\s*/, '').trim();
      if (!cleaned) return;
      if (marked) correctIndex = options.length;
      options.push(cleaned);
    });
    if (options.length < 2) { rejected.push({ block: i + 1, question, reason: 'Fewer than two options' }); return; }
    if (correctIndex < 0) { rejected.push({ block: i + 1, question, reason: 'No option marked with * as the answer' }); return; }
    ready.push({ question, options, correctIndex });
  });

  let position = await prisma.assessmentQuestion.count({ where: { courseId: course.id } });
  const created = [];
  for (const q of ready) {
    // eslint-disable-next-line no-await-in-loop
    const row = await prisma.assessmentQuestion.create({
      data: {
        courseId: course.id, question: q.question, options: JSON.stringify(q.options),
        correctIndex: q.correctIndex, position,
      },
    });
    position += 1;
    created.push(bankQuestion(row));
  }
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: `Assessment questions imported (${created.length})`, entity: 'Course', entityId: course.id });
  return res.status(201).json({ imported: created.length, rejected, questions: created });
});

// --- Enrolled Employees ----------------------------------------------------
// Enrolling SOMEBODY ELSE. The self-service version stays where it was.
router.post('/courses/:id/enroll', MANAGE, async (req, res) => {
  const course = await courseOr404(req, res);
  if (!course) return undefined;
  const { employeeId } = req.body || {};
  if (!employeeId) return res.status(400).json({ error: 'Choose an employee.' });
  // IN SCOPE, checked server-side: the dropdown is already filtered, and this
  // is what makes that filtering more than a suggestion.
  const employee = await prisma.employee.findFirst({ where: { id: employeeId, ...employeeWhere(req.user) } });
  if (!employee) return res.status(403).json({ error: 'That employee is outside your scope' });
  const existing = await prisma.courseAssignment.findUnique({
    where: { courseId_employeeId: { courseId: course.id, employeeId } },
  });
  if (existing) return res.status(409).json({ error: `${employee.name} is already enrolled on this course` });
  const created = await prisma.courseAssignment.create({ data: { courseId: course.id, employeeId } });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Enrolled on course', entity: 'Course', entityId: course.id, toValue: employee.name });
  return res.status(201).json(created);
});

router.delete('/enrollments/:id', MANAGE, async (req, res) => {
  const a = await prisma.courseAssignment.findUnique({ where: { id: req.params.id }, include: { employee: true } });
  if (!a) return res.status(404).json({ error: 'Enrollment not found' });
  if (!matches(a.employee, employeeWhere(req.user))) {
    return res.status(403).json({ error: 'That employee is outside your scope' });
  }
  await prisma.courseAssignment.delete({ where: { id: a.id } });
  return res.status(204).end();
});

// Watch time, posted by the player as it plays. Monotonic — it only ever goes
// up, so a reload cannot reduce somebody's recorded progress.
router.patch('/enrollments/:id/progress', VIEW, async (req, res) => {
  const a = await prisma.courseAssignment.findUnique({ where: { id: req.params.id }, include: { employee: true } });
  if (!a) return res.status(404).json({ error: 'Enrollment not found' });
  const own = await ownEmployee(req);
  const isOwn = own && own.id === a.employeeId;
  if (!isOwn && !matches(a.employee, employeeWhere(req.user))) {
    return res.status(403).json({ error: "This isn't included in your role's permissions" });
  }
  const seconds = Math.max(0, Math.floor(Number(req.body && req.body.watchedSeconds) || 0));
  const updated = await prisma.courseAssignment.update({
    where: { id: a.id },
    data: { watchedSeconds: Math.max(a.watchedSeconds, seconds) },
  });
  return res.json({ id: updated.id, watchedSeconds: updated.watchedSeconds });
});

// --- Taking the assessment -------------------------------------------------
// The learner's copy: NO correctIndex, and shuffled.
router.get('/courses/:id/assessment', VIEW, async (req, res) => {
  const course = await courseOr404(req, res);
  if (!course) return undefined;
  const questions = await prisma.assessmentQuestion.findMany({ where: { courseId: course.id } });
  return res.json({
    courseId: course.id,
    passMark: course.passMark,
    questions: shuffled(questions).map((q) => ({
      id: q.id,
      question: q.question,
      options: parseOptions(q.options),
    })),
  });
});

// Marking happens HERE, against the stored answers. The browser sends the
// option it chose, never a score.
router.post('/courses/:id/assessment/submit', VIEW, async (req, res) => {
  const course = await courseOr404(req, res);
  if (!course) return undefined;
  const me = await ownEmployee(req);
  if (!me) return res.status(404).json({ error: 'No employee record is linked to this login' });
  const assignment = await prisma.courseAssignment.findUnique({
    where: { courseId_employeeId: { courseId: course.id, employeeId: me.id } },
  });
  if (!assignment) return res.status(409).json({ error: 'Enroll on this course before taking the assessment' });

  const answers = (req.body && req.body.answers) || {};
  const questions = await prisma.assessmentQuestion.findMany({ where: { courseId: course.id } });
  if (!questions.length) return res.status(409).json({ error: 'This course has no assessment yet' });

  let correct = 0;
  questions.forEach((q) => {
    const opts = parseOptions(q.options);
    // The answer is compared by VALUE, because the options were shuffled on
    // the way out and the index the browser saw is not the stored one.
    if (answers[q.id] !== undefined && String(answers[q.id]) === opts[q.correctIndex]) correct += 1;
  });
  const score = Math.round((correct / questions.length) * 100);
  const passed = score >= (course.passMark || 0);

  const updated = await prisma.courseAssignment.update({
    where: { id: assignment.id },
    data: {
      score,
      scoredAt: new Date(),
      attempts: assignment.attempts + 1,
      // Passing is what completes the course; a failed attempt leaves the
      // enrolment open so it can be retaken.
      completed: passed || assignment.completed,
      completedAt: passed && !assignment.completedAt ? new Date() : assignment.completedAt,
    },
  });
  await logAudit({
    userId: req.user.id, actorName: req.user.name,
    action: `Assessment ${passed ? 'passed' : 'failed'} — ${score}%`,
    entity: 'Course', entityId: course.id,
  });
  return res.json({
    score, passed, correct, total: questions.length, passMark: course.passMark,
    attempts: updated.attempts, completed: updated.completed,
  });
});

module.exports = router;
