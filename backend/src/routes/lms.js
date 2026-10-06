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
//
// A COURSE COMPLETES ITSELF. There is no "Mark as completed" — not a button,
// not an endpoint. The learner watches the required videos and reads the
// required documents (tracked per material in CourseMaterialProgress), the
// assessment opens on its own once that content is done, and passing it — or
// finishing the content, when the course needs no assessment — completes the
// course and issues its certificate. See evaluate() below; it is the only
// thing in this file that ever writes `completed`.
// ---------------------------------------------------------------------------

const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm, can } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const attachments = require('../utils/attachments');
const media = require('../utils/lmsMedia');
const { renderCertificate } = require('../utils/certificatePdf');
const { employeeWhere, scopeOf, matches, hrmsGlobal } = require('../utils/scope');
const { resolveIdentity } = require('../utils/identity');
const audience = require('../utils/audience');
const { NOT_SYSTEM_EMPLOYEE, isSystemEmployee } = require('../utils/systemAccounts');
const chain = require('../utils/chainRoute');

const router = express.Router();

// --- The view-only media stream --------------------------------------------
// Registered BEFORE requireAuth on purpose. A <video> or a pdf fetch cannot
// send an Authorization header, so it cannot carry the login token; instead
// POST /materials/:id/view-token (which IS behind requireAuth, and checks the
// caller is assigned to the course or authors it) hands out a SIGNED URL that
// expires in media.MEDIA_TTL_SECONDS and is bound to ONE material and ONE
// user (HMAC — utils/lmsMedia.js signMedia). The login token never appears in
// a URL, and no storage path ever leaves the server.
//
// EVERY failure is a 403 — no token, a forged or altered one, an expired one,
// a disabled login, or a user who is no longer assigned to the course. The
// assignment is re-checked HERE, at stream time, not only when the link was
// issued: removing somebody from a course cuts off a link they already hold.
const DENY_MEDIA = (res, why) => res.status(403).json({ error: why });

router.get('/media/:id', async (req, res, next) => {
  try {
    const v = media.verifyMedia(req.params.id, req.query.t);
    if (!v.ok) {
      return DENY_MEDIA(res, v.reason === 'expired'
        ? 'This viewing link has expired — reopen the material in the LMS.'
        : 'This material can only be opened from inside the LMS.');
    }
    const identity = await resolveIdentity(v.userId);
    if (!identity || (identity.status && identity.status !== 'Active')) return DENY_MEDIA(res, 'This login is not active');
    const m = await prisma.courseMaterial.findUnique({ where: { id: req.params.id }, include: { course: true } });
    if (!m || !m.storedPath) return DENY_MEDIA(res, 'This material can only be opened from inside the LMS.');
    if (!(await mayViewMaterial(identity, m))) return DENY_MEDIA(res, 'You are not assigned to this course');
    const full = media.resolve(m.storedPath);
    if (!full) return res.status(404).json({ error: 'The file is no longer on the server' });
    return media.stream(req, res, full, { mimeType: m.mimeType, fileName: m.fileName });
  } catch (err) {
    return next(err);
  }
});

router.use(requireAuth);

// Reaching the LMS at all is the Performance & Development view permission —
// the same one the Performance & Development screen the LMS is a tab of needs.
const VIEW = requirePerm(null, 'hrms', 'Performance & Development', 'view');
// Self-enrollment is self-service, so it rides on the same VIEW grant; the
// two MANAGE actions below are the engine's create/edit on the same feature.
const MANAGE = requirePerm(null, 'hrms', 'Performance & Development', 'create');

// ASSIGNING a course to other people. Whoever runs courses (create) may, and
// so may anybody the engine grants `assign` on the feature — which is how a
// Manager / Assistant Manager, view-only everywhere else (§3/§4), assigns
// training to their departments without being able to author it. WHO they
// may assign to is data scope, applied per request: utils/scope.js
// employeeWhere(), so a TL reaches their team and nobody else.
async function canAssign(user) {
  return (await can(user, null, 'hrms', 'Performance & Development', 'create'))
    || can(user, null, 'hrms', 'Performance & Development', 'assign');
}
async function ASSIGN(req, res, next) {
  try {
    if (!(await canAssign(req.user))) {
      return res.status(403).json({ error: "This action isn't included in your role's permissions" });
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

// AUTHORING ONE COURSE (HRMS-24 §23). An ORGANISATION-WIDE login that holds
// `edit` on the feature (HR, Super Admin / Admin) may edit any course; a lead
// (STL / TL) — whose LMS role is "assign within scope, view progress within
// scope" — may edit only the courses THEY drafted (they may `create`, which is
// how a draft starts up the approval chain). So a lead can build their own
// draft but cannot change another course or open its question bank — which
// would hand a learner the answer key.
async function mayEditCourse(user, course) {
  if (!course) return false;
  if (orgWide(user) && await can(user, null, 'hrms', 'Performance & Development', 'edit')) return true;
  return !!course.raisedById && course.raisedById === user.id
    && can(user, null, 'hrms', 'Performance & Development', 'create');
}

// Guard for the per-course authoring endpoints. `find` loads the course from
// the request (by course id, material id or question id).
function EDIT_COURSE(find) {
  return async (req, res, next) => {
    try {
      const course = await find(req);
      if (!course) return res.status(404).json({ error: 'Course not found' });
      if (!(await mayEditCourse(req.user, course))) {
        return res.status(403).json({ error: 'Only HR, a Super Admin or the course author can change this course.' });
      }
      req.course = course;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}
const byCourseParam = (req) => prisma.course.findUnique({ where: { id: req.params.id } });
const byMaterialParam = async (req) => {
  const m = await prisma.courseMaterial.findUnique({ where: { id: req.params.id }, select: { courseId: true } });
  return m ? prisma.course.findUnique({ where: { id: m.courseId } }) : null;
};
const byQuestionParam = async (req) => {
  const q = await prisma.assessmentQuestion.findUnique({ where: { id: req.params.id }, select: { courseId: true } });
  return q ? prisma.course.findUnique({ where: { id: q.courseId } }) : null;
};

// ORGANISATION-WIDE for LMS assignment: Super Admin / Admin, an unscoped
// Manager / Assistant Manager, and HR. Only these may assign to "Everyone".
function orgWide(user) {
  return hrmsGlobal(user);
}

// May this identity see one stored material? Its learners (an assignment on
// the course), and the people who author the course (to preview it).
async function mayViewMaterial(user, material) {
  const emp = user.employeeId
    ? { id: user.employeeId }
    : await prisma.employee.findUnique({ where: { userId: user.id }, select: { id: true } });
  if (emp) {
    const a = await prisma.courseAssignment.findUnique({
      where: { courseId_employeeId: { courseId: material.courseId, employeeId: emp.id } },
      select: { id: true },
    });
    if (a) return true;
  }
  const course = material.course || await prisma.course.findUnique({ where: { id: material.courseId } });
  return mayEditCourse(user, course);
}

// The learner has opened the course: first-open time once, last-access always.
async function touch(assignment) {
  if (!assignment) return assignment;
  const now = new Date();
  return prisma.courseAssignment.update({
    where: { id: assignment.id },
    data: { lastAccessedAt: now, ...(assignment.startedAt ? {} : { startedAt: now }) },
  });
}

// Exited people are never assigned anything.
const EXITED = ['Relieved', 'Exited', 'Exit Process'];
// A document (or link) counts as read once it has been open in the viewer for
// this long AND the learner has said they have read it.
const DOC_MIN_SECONDS = 30;
// A video is watched once this share of it has actually been played.
const VIDEO_DONE_SHARE = 0.9;

// §14 — A COURSE IS A DRAFT UNTIL THE CHAIN APPROVES PUBLICATION.
//
//   TL drafts → STL → Assistant Manager → Manager → HR → Super Admin
//
// A TL may propose training; putting it in front of the whole company is not
// theirs alone to decide. The chain travels up the DRAFTER's own reporting
// line, because the course is their request, not any one employee's.
//
// PUBLISHED is what the learner-facing halves read. A course that is still
// climbing is invisible in My Learning and in Company Learning; it shows on
// the manage list, where the people deciding on it can see it.
const WF_COURSE = 'course';
const PUBLISHED = { approvalStatus: 'Approved' };

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

// ===========================================================================
// THE COMPLETION RULES.
//
// A material's KIND decides which rule it answers to: Video, Document or Link
// (a Link is read like a document — it cannot be streamed or tracked, so it
// is "opened in the viewer for DOC_MIN_SECONDS and confirmed"). Older rows
// have no kind and get one from their MIME type.
//
// What must be done is:
//   every REQUIRED Video      — when the course's requireVideos is on
//   every REQUIRED Doc / Link — when the course's requireDocuments is on
// and then, when requireAssessment is on, a passing assessment.
// ===========================================================================

function materialKind(m) {
  if (m.kind && ['Video', 'Document', 'Link'].includes(m.kind)) return m.kind;
  if (m.storedPath) return media.kindForMime(m.mimeType);
  return 'Link';
}

// Does this material count toward completion on this course?
function counts(course, m) {
  if (!m.required) return false;
  return materialKind(m) === 'Video' ? course.requireVideos !== false : course.requireDocuments !== false;
}

// Attempts the learner still has: null = unlimited.
function attemptsLeftOf(course, assignment) {
  if (!assignment || course.maxAttempts == null) return null;
  return Math.max(0, course.maxAttempts + (assignment.extraAttempts || 0) - (assignment.attempts || 0));
}

// Pure: where one learner stands on one course. Nothing is written here.
function stateOf(course, materials, progressByMaterial, assignment, questionCount) {
  const required = materials.filter((m) => counts(course, m));
  const done = required.filter((m) => progressByMaterial.get(m.id)?.completed).length;
  const contentDone = done === required.length;
  const needsAssessment = course.requireAssessment !== false;
  const completed = !!(assignment && assignment.completed);
  const attempts = assignment ? assignment.attempts || 0 : 0;
  const attemptsLeft = attemptsLeftOf(course, assignment);
  const outOfAttempts = attemptsLeft === 0 && !completed;

  // VIDEO progress: seconds actually watched over the videos' length.
  // DOCUMENT progress: documents / links read, of those on the course.
  const videos = materials.filter((m) => materialKind(m) === 'Video');
  const docs = materials.filter((m) => materialKind(m) !== 'Video');
  const videoLen = videos.reduce((n, m) => n + (m.durationSeconds || progressByMaterial.get(m.id)?.durationSeconds || 0), 0);
  const videoWatched = videos.reduce((n, m) => n + (progressByMaterial.get(m.id)?.secondsWatched || 0), 0);
  const videosDone = videos.filter((m) => progressByMaterial.get(m.id)?.completed).length;
  const docsDone = docs.filter((m) => progressByMaterial.get(m.id)?.completed).length;
  const anyActivity = materials.some((m) => {
    const p = progressByMaterial.get(m.id);
    return p && (p.secondsWatched > 0 || p.completed);
  }) || attempts > 0;

  // COURSE progress: each required material is one step, the assessment one
  // more; a completed course is 100 whatever else.
  const steps = required.length + (needsAssessment ? 1 : 0);
  const stepsDone = done + (needsAssessment && completed ? 1 : 0);
  const coursePct = completed ? 100 : (steps ? pct(stepsDone, steps) : 0);

  // Locked | Available | Passed | Failed | Not required — the dashboard's
  // Assessment column. "Failed" with attempts left still carries canRetry.
  let assessmentStatus;
  if (!needsAssessment) assessmentStatus = 'Not required';
  else if (completed) assessmentStatus = 'Passed';
  else if (!contentDone || questionCount === 0) assessmentStatus = 'Locked';
  else if (attempts > 0) assessmentStatus = 'Failed';
  else assessmentStatus = 'Available';

  return {
    requiredTotal: required.length,
    requiredDone: done,
    contentPct: required.length ? pct(done, required.length) : 100,
    contentDone,
    needsAssessment,
    questionCount,
    coursePct,
    videoTotal: videos.length,
    videosDone,
    videoSecondsWatched: videoWatched,
    videoSeconds: videoLen,
    videoPct: videoLen ? Math.min(100, pct(videoWatched, videoLen)) : (videos.length ? pct(videosDone, videos.length) : null),
    docTotal: docs.length,
    docsDone,
    docPct: docs.length ? pct(docsDone, docs.length) : null,
    attempts,
    maxAttempts: course.maxAttempts ?? null,
    attemptsLeft,
    outOfAttempts,
    canRetry: assessmentStatus === 'Failed' && !outOfAttempts,
    assessmentStatus,
    // The assessment opens BY ITSELF the moment the content is done — there
    // is no separate activation step for anyone to forget — and stays open
    // while the learner has attempts left.
    assessmentOpen: !!assignment && contentDone && needsAssessment && questionCount > 0 && !completed && !outOfAttempts,
    // One word for the row: Not enrolled | Not started | In progress |
    // Assessment due | Failed | Completed
    stage: !assignment ? 'Not enrolled'
      : completed ? 'Completed'
        : outOfAttempts ? 'Failed'
          : contentDone && needsAssessment ? 'Assessment due'
            : (anyActivity || assignment.startedAt) ? 'In progress' : 'Not started',
  };
}

async function loadState(course, assignment) {
  const [materials, progress, questionCount] = await Promise.all([
    prisma.courseMaterial.findMany({ where: { courseId: course.id }, orderBy: { createdAt: 'asc' } }),
    assignment
      ? prisma.courseMaterialProgress.findMany({ where: { courseId: course.id, employeeId: assignment.employeeId } })
      : [],
    prisma.assessmentQuestion.count({ where: { courseId: course.id } }),
  ]);
  const byMaterial = new Map(progress.map((p) => [p.materialId, p]));
  return { materials, byMaterial, questionCount, state: stateOf(course, materials, byMaterial, assignment, questionCount) };
}

// --- Certificates ----------------------------------------------------------
// TL-CERT-<year>-<six digits>, numbered in issue order within the year. The
// column is @unique, so two courses completing in the same instant cannot
// share a number: the loser of that race hits P2002 and takes the next one.
async function nextCertificateId(when) {
  const prefix = `TL-CERT-${when.getFullYear()}-`;
  const last = await prisma.courseAssignment.findFirst({
    where: { certificateId: { startsWith: prefix } },
    orderBy: { certificateId: 'desc' },
    select: { certificateId: true },
  });
  const n = last ? (parseInt(last.certificateId.slice(prefix.length), 10) || 0) + 1 : 1;
  return `${prefix}${String(n).padStart(6, '0')}`;
}

async function issueCertificate(assignment) {
  if (assignment.certificateId) return assignment;
  const when = assignment.completedAt ? new Date(assignment.completedAt) : new Date();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const certificateId = await nextCertificateId(when);
    try {
      // `certificateId: null` in the WHERE makes issuing idempotent: if
      // another request already issued one, this touches nothing.
      // eslint-disable-next-line no-await-in-loop
      await prisma.courseAssignment.updateMany({
        where: { id: assignment.id, certificateId: null },
        data: { certificateId, certificateIssuedAt: new Date() },
      });
      return prisma.courseAssignment.findUnique({ where: { id: assignment.id } });
    } catch (err) {
      if (err.code !== 'P2002') throw err; // somebody took that number — next one
    }
  }
  throw new Error('Could not allocate a certificate ID');
}

// THE ONLY PLACE `completed` IS WRITTEN (besides a passed assessment, which
// calls this too). Re-reads the rules every time, so a manager relaxing a
// course's rules later completes the learners it should on their next visit.
async function evaluate(course, assignment, loaded) {
  if (!assignment) return { assignment, ...(loaded || await loadState(course, null)) };
  const ctx = loaded || await loadState(course, assignment);
  let a = assignment;
  const now = new Date();
  const data = {};
  if (ctx.state.contentDone && !a.contentCompletedAt) data.contentCompletedAt = now;
  // No assessment on this course: finishing the content IS finishing it.
  if (ctx.state.contentDone && !ctx.state.needsAssessment && !a.completed) {
    data.completed = true;
    data.completedAt = a.completedAt || now;
    data.certificateEligible = true;
  }
  if (Object.keys(data).length) {
    a = await prisma.courseAssignment.update({ where: { id: a.id }, data });
  }
  // Completed without a certificate — a fresh completion, or one recorded
  // before certificates existed — gets its certificate now.
  if (a.completed && !a.certificateId) a = await issueCertificate(a);
  return { ...ctx, assignment: a, state: stateOf(course, ctx.materials, ctx.byMaterial, a, ctx.questionCount) };
}

// May this login read this employee's learning record? Their own, always;
// anyone else's only inside the caller's data scope.
async function mayReadEmployee(req, employeeId) {
  const own = await ownEmployee(req);
  if (own && own.id === employeeId) return true;
  const inScope = await prisma.employee.findFirst({ where: { AND: [{ id: employeeId }, employeeWhere(req.user)] }, select: { id: true } });
  return !!inScope;
}

// ORGANISATION-WIDE ASSIGNMENTS REACH PEOPLE WHO ARRIVE LATER (HRMS-24 §18).
// An "Everyone" or department assignment made by an org-wide login (HR, Super
// Admin, Manager) is a rule, not a one-off list: somebody who joins — or moves
// into — that department afterwards gets the course the next time they open
// the LMS. Each batch remembers who it already reached (employeeIds), so a
// learner an assigner deliberately removed is not silently re-added. A scoped
// assigner's batch (a TL's, an STL's) is a fixed list and never grows: their
// reach is decided per request, and re-deciding it here would be guesswork.
async function joinOrgWideCourses(me) {
  if (!me || EXITED.includes(me.employmentStatus)) return 0;
  // Super Admin is a system account: org-wide courses never reach it.
  if (await isSystemEmployee(me)) return 0;
  const batches = await prisma.courseAssignmentBatch.findMany({
    where: { orgWide: true, mode: { in: ['Everyone', 'Departments'] } },
    orderBy: { createdAt: 'asc' },
  });
  const due = batches.filter((b) => {
    const reached = audience.list(b.employeeIds);
    if (reached.includes(me.id)) return false;
    return b.mode === 'Everyone' || (!!me.department && audience.list(b.departments).includes(me.department));
  });
  if (!due.length) return 0;
  const have = new Set((await prisma.courseAssignment.findMany({
    where: { employeeId: me.id, courseId: { in: due.map((b) => b.courseId) } },
    select: { courseId: true },
  })).map((a) => a.courseId));
  const published = new Set((await prisma.course.findMany({
    where: { id: { in: due.map((b) => b.courseId) }, ...PUBLISHED },
    select: { id: true },
  })).map((c) => c.id));
  let added = 0;
  for (const b of due) {
    if (have.has(b.courseId) || !published.has(b.courseId)) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    await prisma.courseAssignment.create({
      data: {
        courseId: b.courseId, employeeId: me.id, batchId: b.id, dueDate: b.dueDate,
        assignedById: b.assignedById, assignedByName: b.assignedByName,
        source: b.mode === 'Everyone' ? 'Everyone' : 'Department', department: me.department || null,
      },
    }).catch((err) => { if (err.code !== 'P2002') throw err; });
    // eslint-disable-next-line no-await-in-loop
    await prisma.courseAssignmentBatch.update({
      where: { id: b.id },
      data: { employeeIds: JSON.stringify([...audience.list(b.employeeIds), me.id]), assignedCount: { increment: 1 } },
    });
    have.add(b.courseId);
    added += 1;
  }
  return added;
}

// The dashboard's row for one of MY assignments.
function myRow(c, a, st) {
  return courseRow(c, [a], {
    enrolled: true,
    assignmentId: a.id,
    completedAt: a.completedAt || null,
    stage: st.stage,
    contentPct: st.contentPct,
    coursePct: st.coursePct,
    requiredDone: st.requiredDone,
    requiredTotal: st.requiredTotal,
    videoPct: st.videoPct,
    docPct: st.docPct,
    assessmentStatus: st.assessmentStatus,
    canRetry: st.canRetry,
    attemptsLeft: st.attemptsLeft,
    maxAttempts: st.maxAttempts,
    score: a.score,
    attempts: a.attempts,
    certificateId: a.certificateId,
    // How it reached me — the dashboard's Department column.
    department: a.department || null,
    source: a.source || null,
    assignedByName: a.assignedByName || null,
    assignedAt: a.assignedAt,
    dueDate: a.dueDate || null,
    startedAt: a.startedAt || null,
    lastAccessedAt: a.lastAccessedAt || null,
  });
}

// --- A. My Learning --------------------------------------------------------
// ONLY THE COURSES ASSIGNED TO ME (HRMS-24 §18/§21). A course reaches a
// learner through a CourseAssignment row — made for them individually, for
// their department, or for everyone — and nothing else is listed here or
// reachable from here. Somebody who assigns or authors courses additionally
// gets `catalog`: the published courses they may assign, each flagged with
// whether they may also edit it. That list is theirs as an assigner, not as a
// learner, and is never sent to anybody who cannot assign.
router.get('/my', VIEW, async (req, res) => {
  const me = await ownEmployee(req);
  if (me) await joinOrgWideCourses(me);
  const mine = me
    ? await prisma.courseAssignment.findMany({ where: { employeeId: me.id } })
    : [];
  const courses = mine.length
    ? await prisma.course.findMany({
      where: { id: { in: mine.map((a) => a.courseId) }, ...PUBLISHED },
      orderBy: [{ mandatory: 'desc' }, { title: 'asc' }],
    })
    : [];
  const byCourse = new Map(mine.map((a) => [a.courseId, a]));

  // Everything the per-course progress needs, in three queries rather than
  // three per course.
  const enrolledIds = mine.map((a) => a.courseId);
  const [materials, progress, questionCounts] = enrolledIds.length
    ? await Promise.all([
      prisma.courseMaterial.findMany({ where: { courseId: { in: enrolledIds } } }),
      prisma.courseMaterialProgress.findMany({ where: { employeeId: me.id, courseId: { in: enrolledIds } } }),
      prisma.assessmentQuestion.groupBy({ by: ['courseId'], where: { courseId: { in: enrolledIds } }, _count: true }),
    ])
    : [[], [], []];
  const progressByMaterial = new Map(progress.map((p) => [p.materialId, p]));
  const qCount = new Map(questionCounts.map((q) => [q.courseId, q._count]));

  // The assigner's catalogue — published courses (plus the drafts they may
  // edit), each saying whether this login may edit it or only assign it.
  let catalog = null;
  if (await canAssign(req.user)) {
    const all = await prisma.course.findMany({ orderBy: [{ mandatory: 'desc' }, { title: 'asc' }] });
    const scoped = await prisma.courseAssignment.groupBy({
      by: ['courseId', 'completed'],
      where: { employee: employeeWhere(req.user) },
      _count: true,
    });
    catalog = [];
    for (const c of all) {
      // eslint-disable-next-line no-await-in-loop
      const canEdit = await mayEditCourse(req.user, c);
      if (c.approvalStatus !== 'Approved' && !canEdit) continue; // eslint-disable-line no-continue
      const rows = scoped.filter((g) => g.courseId === c.id);
      const total = rows.reduce((n, g) => n + g._count, 0);
      const done = rows.filter((g) => g.completed).reduce((n, g) => n + g._count, 0);
      catalog.push({
        id: c.id, title: c.title, category: c.category || null, duration: c.duration || null,
        mandatory: !!c.mandatory, passMark: c.passMark ?? 70, approvalStatus: c.approvalStatus,
        completed: done, total, pct: pct(done, total), canEdit,
      });
    }
  }

  res.json({
    // No linked employee record = nothing to enrol. Said plainly rather than
    // rendered as an empty screen.
    linked: !!me,
    enrolledCourses: mine.length,
    certificatesEarned: mine.filter((a) => a.completed).length,
    // Only courses assigned to me, each with my own status, course / video /
    // document progress, assessment state and score.
    courses: courses.map((c) => {
      const a = byCourse.get(c.id);
      const st = stateOf(c, materials.filter((m) => m.courseId === c.id), progressByMaterial, a, qCount.get(c.id) || 0);
      return myRow(c, a, st);
    }),
    catalog,
    orgWide: orgWide(req.user),
    // Self-enrolment is gone: courses are ASSIGNED (HRMS-24 §16-§18).
    canEnroll: false,
  });
});

// --- One enrolled course, from the learner's side --------------------------
// Only for someone ENROLLED on it: the materials, their own progress on each,
// and whether the assessment is open. The file URL is never in here — a
// stored file is reached through a view token (below), a Link by its url.
router.get('/my/courses/:id', VIEW, async (req, res) => {
  const course = await prisma.course.findFirst({ where: { id: req.params.id, ...PUBLISHED } });
  if (!course) return res.status(404).json({ error: 'Course not found' });
  const me = await ownEmployee(req);
  if (!me) return res.status(404).json({ error: 'No employee record is linked to this login' });
  const assignment = await prisma.courseAssignment.findUnique({
    where: { courseId_employeeId: { courseId: course.id, employeeId: me.id } },
  });
  if (!assignment) return res.status(403).json({ error: 'You are not enrolled on this course' });

  const ev = await evaluate(course, await touch(assignment));
  const a = ev.assignment;
  // An attempt already started (the learner left mid-assessment) — the
  // screen offers to resume it with the clock where the server has it.
  const open = await prisma.courseAssessmentAttempt.findFirst({
    where: { assignmentId: a.id, submittedAt: null },
    orderBy: { startedAt: 'desc' },
    select: { attemptNo: true, startedAt: true, expiresAt: true },
  });
  return res.json({
    openAttempt: open || null,
    serverNow: new Date(),
    course: {
      id: course.id, title: course.title, category: course.category, duration: course.duration,
      mandatory: course.mandatory, passMark: course.passMark,
      requireVideos: course.requireVideos, requireDocuments: course.requireDocuments, requireAssessment: course.requireAssessment,
      questionsPerAttempt: course.questionsPerAttempt, timeLimitMinutes: course.timeLimitMinutes,
      maxAttempts: course.maxAttempts, randomizeQuestions: course.randomizeQuestions,
    },
    materials: ev.materials.map((m) => {
      const p = ev.byMaterial.get(m.id);
      const kind = materialKind(m);
      return {
        id: m.id,
        title: m.title,
        kind,
        mimeType: m.mimeType,
        required: m.required,
        counts: counts(course, m),
        durationSeconds: m.durationSeconds,
        hasFile: !!m.storedPath,
        // A Link has nothing to protect — it is somebody else's page.
        url: !m.storedPath ? m.url : null,
        progress: {
          secondsWatched: p ? p.secondsWatched : 0,
          lastPosition: p ? p.lastPosition : 0,
          completed: !!(p && p.completed),
          completedAt: p ? p.completedAt : null,
          firstViewedAt: p ? p.firstViewedAt : null,
          pagesViewed: p ? p.pagesViewed : 0,
          pageCount: p ? p.pageCount : null,
        },
      };
    }),
    assignment: {
      id: a.id, assignedAt: a.assignedAt, contentCompletedAt: a.contentCompletedAt,
      completed: a.completed, completedAt: a.completedAt, score: a.score, attempts: a.attempts,
      certificateId: a.certificateId, certificateIssuedAt: a.certificateIssuedAt,
      startedAt: a.startedAt, lastAccessedAt: a.lastAccessedAt, dueDate: a.dueDate,
      assessmentStartedAt: a.assessmentStartedAt, assessmentCompletedAt: a.assessmentCompletedAt,
      passedAttempt: a.passedAttempt, certificateEligible: a.certificateEligible,
      department: a.department, source: a.source, assignedByName: a.assignedByName,
    },
    state: ev.state,
    docMinSeconds: DOC_MIN_SECONDS,
  });
});

// A SIGNED, SHORT-LIVED link to view ONE stored material (see /media above).
// Issued only to somebody assigned to the course, or its author (preview).
// The response carries the signed stream path and its expiry — never the
// file's name on disk or any storage location.
router.post('/materials/:id/view-token', VIEW, async (req, res) => {
  const m = await prisma.courseMaterial.findUnique({ where: { id: req.params.id }, include: { course: true } });
  if (!m) return res.status(404).json({ error: 'Material not found' });
  if (!m.storedPath) return res.status(400).json({ error: 'That material is a link, not a file' });
  if (!(await mayViewMaterial(req.user, m))) {
    return res.status(403).json({ error: 'You are not assigned to this course' });
  }
  const me = await ownEmployee(req);
  const a = me
    ? await prisma.courseAssignment.findUnique({ where: { courseId_employeeId: { courseId: m.courseId, employeeId: me.id } } })
    : null;
  if (a) await touch(a);
  const { token, expiresAt } = media.signMedia(m.id, req.user.id);
  return res.json({
    src: `/api/lms/media/${m.id}?t=${encodeURIComponent(token)}`,
    expiresAt,
    ttlSeconds: media.MEDIA_TTL_SECONDS,
    kind: materialKind(m),
    mimeType: m.mimeType,
  });
});

// PROGRESS, posted by the learner's viewer every ~10 s and on pause / end.
//
// VIDEO. The player sends the stretches it PLAYED since its last report —
// [from, to] pairs, split wherever the learner seeked — never just "where
// the playhead is". Credit is given in order: a stretch only counts where it
// starts at or before the point already credited, so jumping ahead earns
// nothing and re-watching the same minute earns nothing twice. The credit per
// report is also capped by the wall-clock time since the previous report, so
// a forged "I watched an hour" posted ten seconds later is worth ten seconds.
// `secondsWatched` is therefore seconds actually watched, and the video is
// done at VIDEO_DONE_SHARE of its length.
//
// DOCUMENT / LINK. The viewer reports how long it has been open (same
// wall-clock cap) and, for a PDF, how many of its pages have been on screen.
// It completes BY ITSELF (HRMS-24 §14 — there is no "Mark as completed", and
// no "I have read this" either) once it has been open DOC_MIN_SECONDS and,
// for a PDF, every page has been viewed. The page count is the in-app pdf.js
// viewer's; it can only grow, never shrink, so a report cannot shorten a
// document.
router.post('/materials/:id/progress', VIEW, async (req, res) => {
  const m = await prisma.courseMaterial.findUnique({ where: { id: req.params.id }, include: { course: true } });
  if (!m) return res.status(404).json({ error: 'Material not found' });
  const me = await ownEmployee(req);
  const assignment = me
    ? await prisma.courseAssignment.findUnique({ where: { courseId_employeeId: { courseId: m.courseId, employeeId: me.id } } })
    : null;
  if (!assignment) return res.status(403).json({ error: 'You are not enrolled on this course' });

  const body = req.body || {};
  const now = new Date();
  const existing = await prisma.courseMaterialProgress.findUnique({
    where: { materialId_employeeId: { materialId: m.id, employeeId: me.id } },
  });
  // Wall-clock allowance since the last report (the first report may claim a
  // report interval's worth), with a little slack for timer jitter.
  const elapsed = existing ? Math.max(0, (now - existing.updatedAt) / 1000) : 20;
  const allowance = elapsed * 1.1 + 3;
  const kind = materialKind(m);
  const data = {};

  if (existing && existing.completed) {
    // Done is done. Only the resume point still moves.
    if (kind === 'Video' && Number.isFinite(Number(body.position))) data.lastPosition = Math.max(0, Math.floor(Number(body.position)));
  } else if (kind === 'Video') {
    // The length is recorded from the first player that loads it.
    const reported = Math.floor(Number(body.duration) || 0);
    let duration = m.durationSeconds || (existing && existing.durationSeconds) || 0;
    if (reported > 0 && !m.durationSeconds) {
      await prisma.courseMaterial.update({ where: { id: m.id }, data: { durationSeconds: reported } });
      duration = reported;
    }
    let credited = existing ? existing.secondsWatched : 0;
    let budget = allowance;
    const segments = (Array.isArray(body.segments) ? body.segments : [])
      .map((s) => [Number(s && s[0]), Number(s && s[1])])
      .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
      .sort((x, y) => x[0] - y[0]);
    segments.forEach(([from, to]) => {
      if (budget <= 0) return;
      if (from > credited + 3 || to <= credited) return; // a jump ahead, or ground already covered
      const gain = Math.min(to - credited, budget);
      credited += gain;
      budget -= gain;
    });
    if (duration) credited = Math.min(credited, duration);
    data.secondsWatched = Math.floor(credited);
    if (duration) data.durationSeconds = duration;
    if (Number.isFinite(Number(body.position))) {
      data.lastPosition = Math.max(0, Math.min(Math.floor(Number(body.position)), duration || Number.MAX_SAFE_INTEGER));
    }
    if (duration && credited >= duration * VIDEO_DONE_SHARE) {
      data.completed = true;
      data.completedAt = now;
    }
  } else {
    const open = Math.max(0, Number(body.openSeconds) || 0);
    const total = Math.min(24 * 3600, (existing ? existing.secondsWatched : 0) + Math.min(open, allowance));
    data.secondsWatched = Math.floor(total);
    const isPdf = m.storedPath && m.mimeType === 'application/pdf';
    let pageCount = existing ? existing.pageCount : null;
    let pagesViewed = existing ? existing.pagesViewed : 0;
    if (isPdf) {
      const reportedCount = Math.floor(Number(body.pageCount) || 0);
      if (reportedCount > 0 && reportedCount <= 5000) pageCount = Math.max(pageCount || 0, reportedCount);
      const reportedSeen = Math.floor(Number(body.pagesViewed) || 0);
      if (reportedSeen > 0) pagesViewed = Math.min(pageCount || reportedSeen, Math.max(pagesViewed, reportedSeen));
      data.pageCount = pageCount;
      data.pagesViewed = pagesViewed;
    }
    const pagesDone = !isPdf || (!!pageCount && pagesViewed >= pageCount);
    if (total >= DOC_MIN_SECONDS && pagesDone) {
      data.completed = true;
      data.completedAt = now;
    }
  }
  if (!existing || !existing.firstViewedAt) data.firstViewedAt = now;
  await touch(assignment);

  // Two first reports can arrive together (the viewer's timer and its
  // unmount); upsert so the second one updates rather than failing.
  const row = existing
    ? await prisma.courseMaterialProgress.update({ where: { id: existing.id }, data })
    : await prisma.courseMaterialProgress.upsert({
      where: { materialId_employeeId: { materialId: m.id, employeeId: me.id } },
      create: { materialId: m.id, courseId: m.courseId, employeeId: me.id, ...data },
      update: data,
    });

  // The manager's "Video watch time" is the total across the course's videos.
  if (kind === 'Video') {
    const all = await prisma.courseMaterialProgress.findMany({
      where: { courseId: m.courseId, employeeId: me.id, material: { OR: [{ kind: 'Video' }, { kind: null, mimeType: { startsWith: 'video/' } }] } },
      select: { secondsWatched: true },
    });
    const total = all.reduce((n, p) => n + p.secondsWatched, 0);
    if (total !== assignment.watchedSeconds) {
      await prisma.courseAssignment.update({ where: { id: assignment.id }, data: { watchedSeconds: total } });
    }
  }

  // A material just finished may finish the content — and, with no
  // assessment on the course, the course itself. The state goes back on
  // every report so the learner's progress bars move as they watch / read.
  const ev = await evaluate(m.course, assignment);
  if (ev && ev.assignment.contentCompletedAt && !assignment.contentCompletedAt) {
    await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Course content completed', entity: 'Course', entityId: m.courseId });
  }
  if (ev && ev.assignment.completed && !assignment.completed) {
    await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Course completed', entity: 'Course', entityId: m.courseId, toValue: ev.assignment.certificateId });
  }
  const out = {
    progress: {
      materialId: m.id, secondsWatched: row.secondsWatched, lastPosition: row.lastPosition,
      durationSeconds: row.durationSeconds, completed: row.completed, completedAt: row.completedAt,
      firstViewedAt: row.firstViewedAt, pagesViewed: row.pagesViewed, pageCount: row.pageCount,
    },
    state: ev.state,
    assignment: {
      id: ev.assignment.id, contentCompletedAt: ev.assignment.contentCompletedAt, completed: ev.assignment.completed,
      completedAt: ev.assignment.completedAt, certificateId: ev.assignment.certificateId,
      certificateEligible: ev.assignment.certificateEligible,
    },
  };
  return res.json(out);
});

// SELF-ENROLMENT IS CLOSED (HRMS-24 §16-§18). A course reaches a learner only
// by being assigned — to them, their department or everyone — so an employee
// can no longer put themselves on a course nobody assigned, which would have
// made every course in the catalogue reachable by id. Kept as an endpoint so
// an older screen gets a clear answer: an existing enrolment is returned, any
// other request is refused.
router.post('/my/enroll', VIEW, async (req, res) => {
  const me = await ownEmployee(req);
  if (!me) return res.status(404).json({ error: 'No employee record is linked to this login' });
  const { courseId } = req.body || {};
  if (!courseId) return res.status(400).json({ error: 'courseId is required' });
  const existing = await prisma.courseAssignment.findUnique({
    where: { courseId_employeeId: { courseId: String(courseId), employeeId: me.id } },
  });
  if (existing) return res.json(existing);
  return res.status(403).json({ error: 'Courses are assigned by HR or your lead — this course has not been assigned to you.' });
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
  // Only a course assigned to you (§18: nothing unrelated is reachable).
  const mine = await prisma.courseAssignment.findUnique({
    where: { courseId_employeeId: { courseId: course.id, employeeId: me.id } },
    select: { id: true },
  });
  if (!mine) return res.status(403).json({ error: 'That course has not been assigned to you' });
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
    prisma.course.findMany({ where: PUBLISHED, orderBy: [{ mandatory: 'desc' }, { title: 'asc' }] }),
    ids.length
      ? prisma.courseAssignment.findMany({
        where: { employeeId: { in: ids } },
        include: { employee: { select: { id: true, name: true, employeeCode: true, department: true, team: true, designation: true, employmentStatus: true } } },
        orderBy: { assignedAt: 'desc' },
      })
      : [],
  ]);
  const byCourse = new Map();
  assignments.forEach((a) => {
    if (!byCourse.has(a.courseId)) byCourse.set(a.courseId, []);
    byCourse.get(a.courseId).push(a);
  });

  // §18 — somebody who cannot assign courses sees only the courses that
  // reach their scope (for an employee: their own). The full catalogue is an
  // assigner's list, never a learner's.
  const assigner = await canAssign(req.user);
  const rows = courses
    .filter((c) => assigner || byCourse.has(c.id))
    .map((c) => courseRow(c, byCourse.get(c.id) || []));

  // Each in-scope enrolment's own status — the same stateOf() the learner's
  // screen reads, so the two can never disagree.
  const courseIds = [...byCourse.keys()];
  const [allMaterials, allProgress, qCounts] = courseIds.length
    ? await Promise.all([
      prisma.courseMaterial.findMany({ where: { courseId: { in: courseIds } } }),
      prisma.courseMaterialProgress.findMany({ where: { courseId: { in: courseIds }, employeeId: { in: ids } } }),
      prisma.assessmentQuestion.groupBy({ by: ['courseId'], where: { courseId: { in: courseIds } }, _count: true }),
    ])
    : [[], [], []];
  const qByCourse = new Map(qCounts.map((q) => [q.courseId, q._count]));
  const courseById = new Map(courses.map((c) => [c.id, c]));
  const stateFor = (a) => {
    const c = courseById.get(a.courseId);
    if (!c) return null;
    const mats = allMaterials.filter((m) => m.courseId === a.courseId);
    const prog = new Map(allProgress.filter((p) => p.employeeId === a.employeeId && p.courseId === a.courseId).map((p) => [p.materialId, p]));
    return stateOf(c, mats, prog, a, qByCourse.get(a.courseId) || 0);
  };
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
    totalEnrolled: assignments.filter((a) => courseById.has(a.courseId)).length,
    courses: rows,
    canAssign: assigner,
    // The Key Feature screens read from these; all of them are in-scope only.
    enrollments: assignments.filter((a) => courseById.has(a.courseId)).map((a) => {
      const st = stateFor(a);
      return {
        id: a.id,
        courseId: a.courseId,
        course: courseById.get(a.courseId)?.title || '—',
        employee: a.employee?.name || '—',
        // ID and designation, for the Employee ID and Role filters.
        employeeCode: a.employee?.employeeCode || null,
        designation: a.employee?.designation || null,
        employmentStatus: a.employee?.employmentStatus || null,
        department: a.employee?.department || '—',
        team: a.employee?.team || '—',
        completed: a.completed,
        assignedAt: a.assignedAt,
        completedAt: a.completedAt,
        passMark: courseById.get(a.courseId)?.passMark ?? 70,
        score: a.score,
        // Opens the certificate (GET /lms/certificates/:id) from the
        // Certifications screen; the same scope rule guards that read.
        certificateId: a.certificateId,
        // §22 — the assignment and completion audit, per enrolment.
        assignedByName: a.assignedByName || null,
        source: a.source || null,
        assignedDepartment: a.department || null,
        dueDate: a.dueDate || null,
        startedAt: a.startedAt || null,
        lastAccessedAt: a.lastAccessedAt || null,
        attempts: a.attempts,
        passedAttempt: a.passedAttempt,
        certificateEligible: a.certificateEligible,
        stage: st ? st.stage : null,
        coursePct: st ? st.coursePct : null,
        videoPct: st ? st.videoPct : null,
        docPct: st ? st.docPct : null,
        assessmentStatus: st ? st.assessmentStatus : null,
      };
    }),
    materialRequests: materialRequests.map((m) => ({
      id: m.id, title: m.title, employee: m.employee?.name || '—',
      status: m.status, createdAt: m.createdAt,
    })),
  });
});

// --- Existing endpoints, unchanged in behaviour ----------------------------

// The whole catalogue is an ASSIGNER's / APPROVER's list (§18): a learner who
// can do neither gets 403 here, and their enrolments come from /my. The
// enrolments carried on each course are held to the caller's scope.
router.get('/courses', async (req, res) => {
  const allowed = (await canAssign(req.user))
    || (await can(req.user, null, 'hrms', 'Performance & Development', 'approve'));
  if (!allowed) return res.status(403).json({ error: "This action isn't included in your role's permissions" });
  const courses = await prisma.course.findMany({
    include: { assignments: { where: { employee: employeeWhere(req.user) } } },
    orderBy: { createdAt: 'desc' },
  });
  // The MANAGE list shows drafts as well as published courses, each with its
  // chain summary, so whoever is deciding can see what is waiting on them.
  res.json(await chain.decorate(WF_COURSE, courses));
});

// The course fields a manager sets — shared by create and edit so the two can
// never accept different things. Completion rules default ON, which is what
// the schema defaults to as well.
function courseFields(body, { partial = false } = {}) {
  const b = body || {};
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  if (!partial || has('title')) out.title = String(b.title || '').trim().slice(0, 200);
  if (!partial || has('category')) out.category = b.category ? String(b.category).slice(0, 100) : null;
  if (!partial || has('duration')) out.duration = b.duration ? String(b.duration).slice(0, 100) : null;
  if (!partial || has('mandatory')) out.mandatory = !!b.mandatory;
  if (!partial || has('passMark')) {
    const n = Number(b.passMark);
    out.passMark = b.passMark != null && b.passMark !== '' && Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 70;
  }
  ['requireVideos', 'requireDocuments', 'requireAssessment'].forEach((k) => {
    if (!partial || has(k)) out[k] = b[k] === undefined ? true : !!b[k];
  });
  // ASSESSMENT RULES (§14). Blank = no limit (all questions / untimed /
  // unlimited attempts).
  const optInt = (k, min, max) => {
    if (partial && !has(k)) return;
    const raw = b[k];
    const n = Number(raw);
    out[k] = raw == null || raw === '' || !Number.isFinite(n) || n <= 0 ? null : Math.max(min, Math.min(max, Math.round(n)));
  };
  optInt('questionsPerAttempt', 1, 500);
  optInt('timeLimitMinutes', 1, 600);
  optInt('maxAttempts', 1, 100);
  if (!partial || has('randomizeQuestions')) out.randomizeQuestions = b.randomizeQuestions === undefined ? true : !!b.randomizeQuestions;
  return out;
}

router.post('/courses', MANAGE, async (req, res) => {
  const fields = courseFields(req.body);
  if (!fields.title) return res.status(400).json({ error: 'title is required' });
  // raisedById names the author: a login that may only `create` edits the
  // courses it drafted and no others (mayEditCourse).
  const course = await prisma.course.create({ data: { ...fields, raisedById: req.user.id } });

  // The drafter's own employee row names their rung, so a TL's course starts
  // at their STL. Somebody with no employee record behind their login has no
  // ladder to climb and their course publishes directly, as it always did.
  const drafter = await ownEmployee(req);
  const started = drafter
    ? await chain.raise(WF_COURSE, { recordId: course.id, employee: drafter, applicantUserId: req.user.id })
    : { pending: false, summary: null };
  if (started.pending) {
    await prisma.course.update({ where: { id: course.id }, data: { approvalStatus: 'Pending' } });
    course.approvalStatus = 'Pending';
  }
  await logAudit({ userId: req.user.id, action: 'Course created', entity: 'Course', entityId: course.id });
  res.status(201).json({ ...course, workflow: started.summary });
});

// Edit a course — its details and its completion rules. A rule relaxed here
// takes effect for each learner on their next visit (evaluate() re-reads the
// rules every time); nobody already completed is ever un-completed.
router.put('/courses/:id', MANAGE, EDIT_COURSE(byCourseParam), async (req, res) => {
  const { course } = req;
  const fields = courseFields(req.body, { partial: true });
  if (Object.prototype.hasOwnProperty.call(fields, 'title') && !fields.title) {
    return res.status(400).json({ error: 'title is required' });
  }
  const updated = await prisma.course.update({ where: { id: course.id }, data: fields });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Course updated', entity: 'Course', entityId: course.id, toValue: updated.title });
  res.json(updated);
});

// One rung deciding on a course. Approving at the top publishes it; a
// rejection anywhere leaves it a draft that no learner ever saw.
router.patch('/courses/:id/decision', requirePerm(null, 'hrms', 'Performance & Development', 'approve'), async (req, res) => {
  const { status, reason } = req.body; // Approved | Rejected
  if (!['Approved', 'Rejected'].includes(status)) return res.status(400).json({ error: 'status must be Approved or Rejected' });
  const course = await prisma.course.findUnique({ where: { id: req.params.id } });
  if (!course) return res.status(404).json({ error: 'Course not found' });
  if (course.approvalStatus !== 'Pending') return res.status(409).json({ error: `This course was already ${course.approvalStatus.toLowerCase()}.` });

  const step = await chain.decide(WF_COURSE, course.id, req.user, { decision: status, note: reason });
  if (step.error) return res.status(step.error.status).json(step.error.body);
  if (step.chained) {
    await logAudit({
      userId: req.user.id,
      action: `Course ${status.toLowerCase()} at ${step.result.level}`,
      entity: 'Course',
      entityId: course.id,
      fromValue: step.result.level,
      toValue: step.result.nextLevel || step.result.outcome,
    });
    // STILL CLIMBING — it stays a draft and no learner can see it yet.
    if (!step.result.complete) return res.json({ ...course, workflow: step.view });
  }
  const updated = await prisma.course.update({
    where: { id: course.id },
    data: { approvalStatus: status === 'Rejected' ? 'Rejected' : 'Approved' },
  });
  res.json({ ...updated, workflow: step.view || null });
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

// The single-row assign the API always had. Same rules as the bulk one below:
// the assign permission, the caller's scope, and never an exited employee.
router.post('/assignments', ASSIGN, async (req, res) => {
  const { courseId, employeeId } = req.body;
  if (!courseId || !employeeId) return res.status(400).json({ error: 'courseId and employeeId are required' });
  const course = await prisma.course.findUnique({ where: { id: String(courseId) } });
  if (!course) return res.status(404).json({ error: 'Course not found' });
  if (course.approvalStatus !== 'Approved') return res.status(409).json({ error: 'This course is still awaiting approval.' });
  const employee = await prisma.employee.findFirst({
    where: { AND: [{ id: employeeId, employmentStatus: { notIn: EXITED } }, employeeWhere(req.user)] },
  });
  if (!employee) return res.status(403).json({ error: 'That employee is outside your scope' });
  const existing = await prisma.courseAssignment.findUnique({ where: { courseId_employeeId: { courseId, employeeId } } });
  if (existing) return res.json(existing);
  const { assignment } = await assignIndividually(req, course, employee, parseDue(req.body && req.body.dueDate));
  res.status(201).json(assignment);
});

// NOTE: PATCH /assignments/:id/complete is GONE, on purpose. It let a learner
// complete a course by pressing a button. A course now completes only through
// evaluate() — required content done, then the assessment passed (or no
// assessment required) — so there is no path left that skips the rules.


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
router.get('/courses/:id/manage', MANAGE, EDIT_COURSE(byCourseParam), async (req, res) => {
  const { course } = req;

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

  // Who could still be added — in scope, not exited, and not already enrolled.
  const enrolledIds = new Set(assignments.map((a) => a.employeeId));
  const candidates = await prisma.employee.findMany({
    where: { AND: [employeeWhere(req.user), { employmentStatus: { notIn: EXITED } }] },
    select: { id: true, name: true, employeeCode: true, department: true },
    orderBy: { name: 'asc' },
  });

  // Each enrolled learner's progress — the same stateOf() their own screen
  // reads.
  const progress = assignments.length
    ? await prisma.courseMaterialProgress.findMany({
      where: { courseId: course.id, employeeId: { in: assignments.map((a) => a.employeeId) } },
    })
    : [];

  return res.json({
    course: {
      id: course.id, title: course.title, category: course.category,
      duration: course.duration, mandatory: course.mandatory, passMark: course.passMark,
      approvalStatus: course.approvalStatus,
      requireVideos: course.requireVideos, requireDocuments: course.requireDocuments, requireAssessment: course.requireAssessment,
      questionsPerAttempt: course.questionsPerAttempt, timeLimitMinutes: course.timeLimitMinutes,
      maxAttempts: course.maxAttempts, randomizeQuestions: course.randomizeQuestions,
      assignMode: course.assignMode,
      assignDepartments: course.assignDepartments ? course.assignDepartments.split(',').filter(Boolean) : [],
    },
    materials: materials.map((m) => ({
      id: m.id, title: m.title, fileName: m.fileName, mimeType: m.mimeType,
      sizeBytes: m.sizeBytes, url: m.url, uploadedBy: m.uploadedBy, createdAt: m.createdAt,
      kind: materialKind(m), required: m.required, durationSeconds: m.durationSeconds,
      hasFile: !!m.storedPath,
      // A stored file is opened through a view token, never a bare URL; a
      // link opens as it is.
      href: m.storedPath ? null : m.url,
    })),
    questions: questions.map(bankQuestion),
    canAssign: await canAssign(req.user),
    enrolled: assignments.map((a) => {
      const st = stateOf(course, materials, new Map(progress.filter((p) => p.employeeId === a.employeeId).map((p) => [p.materialId, p])), a, questions.length);
      return {
        id: a.id,
        employeeId: a.employeeId,
        name: a.employee.name,
        employeeCode: a.employee.employeeCode,
        department: a.employee.department,
        designation: a.employee.designation, // for the Role filter
        employmentStatus: a.employee.employmentStatus, // for the Employee status filter
        completed: a.completed,
        completedAt: a.completedAt,
        score: a.score,
        attempts: a.attempts,
        watchedSeconds: a.watchedSeconds,
        contentPct: st.contentPct,
        contentCompletedAt: a.contentCompletedAt,
        certificateId: a.certificateId,
        // §22 — the audit, per enrolment.
        stage: st.stage,
        coursePct: st.coursePct,
        videoPct: st.videoPct,
        docPct: st.docPct,
        assessmentStatus: st.assessmentStatus,
        attemptsLeft: st.attemptsLeft,
        outOfAttempts: st.outOfAttempts,
        passedAttempt: a.passedAttempt,
        certificateEligible: a.certificateEligible,
        assignedByName: a.assignedByName,
        source: a.source,
        assignedAt: a.assignedAt,
        dueDate: a.dueDate,
        startedAt: a.startedAt,
        lastAccessedAt: a.lastAccessedAt,
      };
    }),
    enrollable: candidates.filter((c) => !enrolledIds.has(c.id)),
  });
});

// --- Course Materials ------------------------------------------------------
// Three ways in, one endpoint, because from the screen's point of view all
// three are "add a material":
//
//   application/json     a LINK: { title, url, kind?, required? }
//   multipart/form-data  a small FILE in a form (the original shape; capped
//                        at lmsMedia.MULTIPART_MAX because it is buffered)
//   anything else        a FILE streamed as the request body — how the screen
//                        uploads, so a long video never sits in memory. Its
//                        title / kind / required ride in the query string and
//                        its filename in X-File-Name.
//
// Every stored file goes through utils/lmsMedia.js: the LMS's own allow-list
// (video, PDF, images) and cap, and the same magic-byte check as everywhere.
function kindOf(raw, fallback) {
  return ['Video', 'Document', 'Link'].includes(raw) ? raw : fallback;
}
function requiredOf(raw) {
  // Required unless explicitly marked optional.
  return !(raw === false || raw === 'false' || raw === '0' || raw === 0);
}

// A material as the API returns it: never its storage name on disk (§15).
function publicMaterial(m) {
  if (!m) return m;
  const { storedPath, ...rest } = m;
  return { ...rest, hasFile: !!storedPath };
}

router.post('/courses/:id/materials', MANAGE, EDIT_COURSE(byCourseParam), async (req, res) => {
  const { course } = req;

  const type = String(req.headers['content-type'] || '').toLowerCase();
  if (type.startsWith('application/json')) {
    const { title, url, kind, required } = req.body || {};
    if (!title || !url) return res.status(400).json({ error: 'A title and either a file or a link are required' });
    if (!/^https?:\/\//i.test(String(url).trim())) return res.status(400).json({ error: 'A link must start with http:// or https://' });
    const created = await prisma.courseMaterial.create({
      data: {
        courseId: course.id, title: String(title).slice(0, 200), url: String(url).trim().slice(0, 2000),
        uploadedBy: req.user.name || null, kind: kindOf(kind, 'Link'), required: requiredOf(required),
      },
    });
    await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Course material linked', entity: 'Course', entityId: course.id, toValue: created.title });
    return res.status(201).json(publicMaterial(created));
  }

  let stored;
  let fields = {};
  try {
    if (type.startsWith('multipart/form-data')) {
      const parsed = await attachments.parseMultipart(req, { maxBytes: media.MULTIPART_MAX });
      fields = parsed.fields || {};
      stored = media.storeBuffer(parsed.file);
    } else {
      let filename = 'material';
      try { filename = decodeURIComponent(String(req.headers['x-file-name'] || 'material')); } catch { /* keep the default */ }
      fields = req.query || {};
      stored = await media.receive(req, { filename, contentType: req.headers['content-type'] });
    }
  } catch (err) {
    // 413 for a file over its cap (the screen says "This video is bigger than
    // 300 MB."); the connection is closed so the rest of the body is not read.
    const status = media.STATUS[err.code] || 400;
    if (status === 413) res.set('Connection', 'close');
    return res.status(status).json({ error: media.MESSAGE[err.code] || attachments.MESSAGE[err.code] || 'Could not store the upload.' });
  }
  const title = fields.title ? String(fields.title).slice(0, 200) : stored.fileName;
  const created = await prisma.courseMaterial.create({
    data: {
      courseId: course.id,
      title,
      fileName: stored.fileName,
      storedPath: stored.storedPath,
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      uploadedBy: req.user.name || null,
      // Inferred from the file unless the manager said otherwise.
      kind: kindOf(fields.kind, media.kindForMime(stored.mimeType)),
      required: requiredOf(fields.required),
    },
  });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Course material uploaded', entity: 'Course', entityId: course.id, toValue: title });
  return res.status(201).json(publicMaterial(created));
});

// Change a material's title, kind or whether it is required.
router.patch('/materials/:id', MANAGE, EDIT_COURSE(byMaterialParam), async (req, res) => {
  const m = await prisma.courseMaterial.findUnique({ where: { id: req.params.id } });
  if (!m) return res.status(404).json({ error: 'Material not found' });
  const b = req.body || {};
  const data = {};
  if (b.title !== undefined) {
    if (!String(b.title).trim()) return res.status(400).json({ error: 'A material needs a title' });
    data.title = String(b.title).trim().slice(0, 200);
  }
  if (b.kind !== undefined) {
    if (!['Video', 'Document', 'Link'].includes(b.kind)) return res.status(400).json({ error: 'kind must be Video, Document or Link' });
    // A link cannot be played or streamed; a file cannot be "a link".
    if (b.kind === 'Link' && m.storedPath) return res.status(400).json({ error: 'An uploaded file cannot be a Link' });
    if (b.kind !== 'Link' && !m.storedPath && b.kind === 'Video') return res.status(400).json({ error: 'Only an uploaded video file can be a Video' });
    data.kind = b.kind;
  }
  if (b.required !== undefined) data.required = requiredOf(b.required);
  const updated = await prisma.courseMaterial.update({ where: { id: m.id }, data });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Course material updated', entity: 'Course', entityId: m.courseId, toValue: updated.title });
  return res.json(publicMaterial(updated));
});

// NOTE: GET /materials/:id/file is GONE. It served any material to anybody who
// could see the LMS, by a URL that could be pasted anywhere. Files are now
// reached only through POST /materials/:id/view-token -> GET /media/:id.

router.delete('/materials/:id', MANAGE, EDIT_COURSE(byMaterialParam), async (req, res) => {
  const m = await prisma.courseMaterial.findUnique({ where: { id: req.params.id } });
  if (!m) return res.status(404).json({ error: 'Material not found' });
  if (m.storedPath) media.remove(m.storedPath);
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

router.post('/courses/:id/questions', MANAGE, EDIT_COURSE(byCourseParam), async (req, res) => {
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

router.put('/questions/:id', MANAGE, EDIT_COURSE(byQuestionParam), async (req, res) => {
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

router.delete('/questions/:id', MANAGE, EDIT_COURSE(byQuestionParam), async (req, res) => {
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
router.post('/courses/:id/questions/import', MANAGE, EDIT_COURSE(byCourseParam), async (req, res) => {
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
  // Every import tells the Super Admin (utils/dataIoNotify.js; never throws).
  await require('../utils/dataIoNotify').notifyDataIo(req, {
    kind: 'import', module: 'LMS', count: blocks.length, created: created.length, what: 'assessment questions', detail: `course "${course.title}"; ${rejected.length} block(s) rejected`,
  });
  return res.status(201).json({ imported: created.length, rejected, questions: created });
});

// --- Enrolled Employees ----------------------------------------------------
// Enrolling SOMEBODY ELSE, one person at a time, from the course screen. The
// same scope rule, audit trail and notification as a bulk assignment.
router.post('/courses/:id/enroll', ASSIGN, async (req, res) => {
  const course = await courseOr404(req, res);
  if (!course) return undefined;
  if (course.approvalStatus !== 'Approved') {
    return res.status(409).json({ error: 'This course is still awaiting approval — it can be assigned once it is published.' });
  }
  const { employeeId } = req.body || {};
  if (!employeeId) return res.status(400).json({ error: 'Choose an employee.' });
  const due = parseDue(req.body && req.body.dueDate);
  if (due && due.error) return res.status(400).json({ error: due.error });
  // IN SCOPE, checked server-side: the dropdown is already filtered, and this
  // is what makes that filtering more than a suggestion.
  const employee = await prisma.employee.findFirst({
    where: { AND: [{ id: employeeId, employmentStatus: { notIn: EXITED } }, employeeWhere(req.user)] },
  });
  if (!employee) return res.status(403).json({ error: 'That employee is outside your scope' });
  const existing = await prisma.courseAssignment.findUnique({
    where: { courseId_employeeId: { courseId: course.id, employeeId } },
  });
  if (existing) return res.status(409).json({ error: `${employee.name} is already enrolled on this course` });
  const { assignment } = await assignIndividually(req, course, employee, due);
  return res.status(201).json(assignment);
});

router.delete('/enrollments/:id', MANAGE, async (req, res) => {
  const a = await prisma.courseAssignment.findUnique({ where: { id: req.params.id }, include: { employee: true } });
  if (!a) return res.status(404).json({ error: 'Enrollment not found' });
  if (!matches(a.employee, employeeWhere(req.user))) {
    return res.status(403).json({ error: 'That employee is outside your scope' });
  }
  await prisma.courseAssessmentAttempt.deleteMany({ where: { assignmentId: a.id } });
  await prisma.courseAssignment.delete({ where: { id: a.id } });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Removed from course', entity: 'Course', entityId: a.courseId, toValue: a.employee.name });
  return res.status(204).end();
});

// ONE MORE ATTEMPT (HRMS-24 §14 "retry per the configured attempts"). When a
// learner has used every attempt the course allows, somebody who may assign
// them courses can grant one more. Recorded in the audit log.
router.post('/enrollments/:id/extra-attempt', ASSIGN, async (req, res) => {
  const a = await prisma.courseAssignment.findUnique({ where: { id: req.params.id }, include: { employee: true, course: true } });
  if (!a) return res.status(404).json({ error: 'Enrollment not found' });
  if (!matches(a.employee, employeeWhere(req.user))) {
    return res.status(403).json({ error: 'That employee is outside your scope' });
  }
  if (a.completed) return res.status(409).json({ error: 'This learner has already completed the course.' });
  if (a.course.maxAttempts == null) return res.status(409).json({ error: 'This course allows unlimited attempts.' });
  const updated = await prisma.courseAssignment.update({ where: { id: a.id }, data: { extraAttempts: { increment: 1 } } });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Extra assessment attempt granted', entity: 'Course', entityId: a.courseId, toValue: a.employee.name });
  return res.json({ id: updated.id, extraAttempts: updated.extraAttempts, attemptsLeft: attemptsLeftOf(a.course, updated) });
});

// NOTE: PATCH /enrollments/:id/progress (one self-reported watchedSeconds
// number) is replaced by POST /materials/:id/progress above, which tracks
// each material and credits only time actually played.

// --- Taking the assessment -------------------------------------------------
// HRMS-24 §14. The assessment OPENS BY ITSELF once the required content is
// done, and follows the course's rules:
//
//   questionsPerAttempt  each attempt draws this many from the bank (all when
//                        blank) — at random when randomizeQuestions is on,
//                        otherwise the first N in bank order;
//   timeLimitMinutes     the clock is the SERVER's: the attempt row carries
//                        expiresAt, and a submission after it (plus a short
//                        grace for the network) is recorded as timed out;
//   maxAttempts          every submitted (or timed-out) attempt counts; when
//                        none are left the assessment closes and the course
//                        reads Failed until an assigner grants another;
//   passMark             scored here, against the stored answers — the
//                        browser never holds correctIndex and never sends a
//                        score.
//
// Starting is explicit: GET /assessment is what starts (or resumes) an
// attempt, and the learner's screen only calls it when they press Start.
const SUBMIT_GRACE_MS = 60 * 1000;

function drawPaper(course, bank) {
  const ordered = [...bank].sort((a, b) => (a.position - b.position) || (new Date(a.createdAt) - new Date(b.createdAt)));
  const pool = course.randomizeQuestions !== false ? shuffled(ordered) : ordered;
  const n = course.questionsPerAttempt ? Math.min(course.questionsPerAttempt, pool.length) : pool.length;
  return pool.slice(0, n);
}

function examQuestion(q, course) {
  const opts = parseOptions(q.options);
  return { id: q.id, question: q.question, options: course.randomizeQuestions !== false ? shuffled(opts) : opts };
}

function parseIds(raw) {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch { return []; }
}

async function openAttemptOf(assignment) {
  return prisma.courseAssessmentAttempt.findFirst({
    where: { assignmentId: assignment.id, submittedAt: null },
    orderBy: { startedAt: 'desc' },
  });
}

const expired = (attempt, now = new Date()) => !!attempt.expiresAt && now.getTime() > new Date(attempt.expiresAt).getTime() + SUBMIT_GRACE_MS;

// Close an attempt whose clock ran out without a submission: it counts, and
// it scores nothing.
async function closeTimedOut(attempt, assignment, course, req) {
  const now = new Date();
  await prisma.courseAssessmentAttempt.update({
    where: { id: attempt.id },
    data: { submittedAt: now, score: 0, correct: 0, passed: false, timedOut: true },
  });
  const a = await prisma.courseAssignment.update({
    where: { id: assignment.id },
    data: { attempts: { increment: 1 }, score: 0, scoredAt: now, assessmentCompletedAt: now },
  });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: `Assessment attempt ${attempt.attemptNo} timed out`, entity: 'Course', entityId: course.id });
  return a;
}

router.get('/courses/:id/assessment', VIEW, async (req, res) => {
  const course = await courseOr404(req, res);
  if (!course) return undefined;
  const me = await ownEmployee(req);
  let assignment = me
    ? await prisma.courseAssignment.findUnique({ where: { courseId_employeeId: { courseId: course.id, employeeId: me.id } } })
    : null;
  const bank = await prisma.assessmentQuestion.findMany({ where: { courseId: course.id } });

  if (!assignment) {
    // The AUTHOR's preview — no attempt, no answers, nothing recorded.
    if (!(await mayEditCourse(req.user, course))) return res.status(403).json({ error: 'You are not assigned to this course' });
    const paper = drawPaper(course, bank);
    return res.json({
      preview: true, courseId: course.id, passMark: course.passMark,
      timeLimitMinutes: course.timeLimitMinutes, maxAttempts: course.maxAttempts,
      questions: paper.map((q) => examQuestion(q, course)),
    });
  }

  const ev = await evaluate(course, await touch(assignment));
  assignment = ev.assignment;
  if (assignment.completed) return res.status(409).json({ error: 'You have already completed this course.' });
  if (!ev.state.contentDone) {
    return res.status(409).json({ error: 'Finish the required course materials first — the assessment opens by itself when they are done.' });
  }
  if (!bank.length) return res.status(409).json({ error: 'The assessment has not been set up yet.' });

  let attempt = await openAttemptOf(assignment);
  if (attempt && expired(attempt)) {
    assignment = await closeTimedOut(attempt, assignment, course, req);
    attempt = null;
  }
  if (!attempt) {
    const left = attemptsLeftOf(course, assignment);
    if (left === 0) {
      return res.status(409).json({ error: 'You have used every attempt this course allows. Ask HR or your lead if you need another.', outOfAttempts: true });
    }
    const now = new Date();
    const paper = drawPaper(course, bank);
    attempt = await prisma.courseAssessmentAttempt.create({
      data: {
        assignmentId: assignment.id, courseId: course.id, employeeId: assignment.employeeId,
        attemptNo: (assignment.attempts || 0) + 1,
        questionIds: JSON.stringify(paper.map((q) => q.id)),
        startedAt: now,
        expiresAt: course.timeLimitMinutes ? new Date(now.getTime() + course.timeLimitMinutes * 60000) : null,
        total: paper.length,
      },
    });
    if (!assignment.assessmentStartedAt) {
      await prisma.courseAssignment.update({ where: { id: assignment.id }, data: { assessmentStartedAt: now } });
    }
    await logAudit({ userId: req.user.id, actorName: req.user.name, action: `Assessment attempt ${attempt.attemptNo} started`, entity: 'Course', entityId: course.id });
  }

  const byId = new Map(bank.map((q) => [q.id, q]));
  const questions = parseIds(attempt.questionIds).map((id) => byId.get(id)).filter(Boolean);
  const left = attemptsLeftOf(course, assignment);
  return res.json({
    courseId: course.id,
    passMark: course.passMark,
    attemptId: attempt.id,
    attemptNo: attempt.attemptNo,
    maxAttempts: course.maxAttempts,
    // Including this one.
    attemptsLeft: left,
    timeLimitMinutes: course.timeLimitMinutes,
    startedAt: attempt.startedAt,
    expiresAt: attempt.expiresAt,
    serverNow: new Date(),
    questions: questions.map((q) => examQuestion(q, course)),
  });
});

// Marking happens HERE, against the stored answers and ONLY over the
// questions drawn for this attempt. The browser sends the option it chose,
// never a score.
router.post('/courses/:id/assessment/submit', VIEW, async (req, res) => {
  const course = await courseOr404(req, res);
  if (!course) return undefined;
  const me = await ownEmployee(req);
  if (!me) return res.status(404).json({ error: 'No employee record is linked to this login' });
  const assignment = await prisma.courseAssignment.findUnique({
    where: { courseId_employeeId: { courseId: course.id, employeeId: me.id } },
  });
  if (!assignment) return res.status(403).json({ error: 'You are not assigned to this course' });
  // The same gates the questions were handed out behind.
  const before = await evaluate(course, assignment);
  if (before.assignment.completed) return res.status(409).json({ error: 'You have already completed this course.' });
  if (!before.state.contentDone) {
    return res.status(409).json({ error: 'Finish the required course materials before taking the assessment.' });
  }
  const attempt = await openAttemptOf(before.assignment);
  if (!attempt) return res.status(409).json({ error: 'Start the assessment first.' });
  const b = req.body || {};
  if (b.attemptId && b.attemptId !== attempt.id) {
    return res.status(409).json({ error: 'That attempt is no longer open — reload the assessment.' });
  }

  const now = new Date();
  const answers = b.answers || {};
  const bank = await prisma.assessmentQuestion.findMany({ where: { id: { in: parseIds(attempt.questionIds) } } });
  const timedOut = expired(attempt, now);
  let correct = 0;
  if (!timedOut) {
    bank.forEach((q) => {
      const opts = parseOptions(q.options);
      // Compared by VALUE: the options were shuffled on the way out, so the
      // index the browser saw is not the stored one.
      if (answers[q.id] !== undefined && String(answers[q.id]) === opts[q.correctIndex]) correct += 1;
    });
  }
  const total = bank.length || attempt.total || 1;
  const score = Math.round((correct / total) * 100);
  const passed = !timedOut && score >= (course.passMark || 0);

  await prisma.courseAssessmentAttempt.update({
    where: { id: attempt.id },
    data: { submittedAt: now, score, correct, total, passed, timedOut },
  });
  let updated = await prisma.courseAssignment.update({
    where: { id: assignment.id },
    data: {
      score,
      scoredAt: now,
      attempts: { increment: 1 },
      assessmentCompletedAt: now,
      // Passing is what completes the course; a failed attempt leaves the
      // enrolment open for a retry while attempts remain.
      ...(passed ? {
        completed: true,
        completedAt: before.assignment.completedAt || now,
        passedAttempt: attempt.attemptNo,
        certificateEligible: true,
      } : {}),
    },
  });
  // A pass completes the course, and a completed course carries a certificate.
  if (updated.completed && !updated.certificateId) updated = await issueCertificate(updated);
  await logAudit({
    userId: req.user.id, actorName: req.user.name,
    action: `Assessment attempt ${attempt.attemptNo} ${timedOut ? 'timed out' : passed ? 'passed' : 'failed'} — ${score}%`,
    entity: 'Course', entityId: course.id,
    toValue: passed ? updated.certificateId : null,
  });
  const left = attemptsLeftOf(course, updated);
  return res.json({
    score, passed, correct, total, passMark: course.passMark, timedOut,
    attemptNo: attempt.attemptNo,
    attempts: updated.attempts, attemptsLeft: left, maxAttempts: course.maxAttempts,
    canRetry: !passed && left !== 0,
    completed: updated.completed,
    completedAt: updated.completedAt, certificateId: updated.certificateId,
    certificateEligible: updated.certificateEligible,
    assignmentId: updated.id,
  });
});

// ===========================================================================
// COURSE ASSIGNMENT — Everyone | Department(s) | Individual employee(s).
//
// HRMS-24 §16-§19. Guarded by ASSIGN (Super Admin, HR, Manager, Assistant
// Manager, STL, TL — never an Employee) and resolved by the SHARED audience
// rule (utils/audience.js resolveAudience), the same one every Employee
// Services form uses:
//
//   Everyone      organisation-wide logins ONLY (HR, Super Admin / Admin, an
//                 unscoped Manager / Assistant Manager). A TL or STL is
//                 refused (403) — they pick their department(s) or people.
//   Departments   one or many; every department must be inside the caller's
//                 scope or the WHOLE request is refused with 403 — nothing is
//                 silently dropped, including a department typed into the
//                 request by hand.
//   Individuals   one or many; every id must be inside the caller's scope or
//                 403 — likewise for ids slipped into the request.
//
// Within that, the people reached are the caller's scope (a TL's team, an
// STL's departments, HR's company). Exited people are never assigned, and
// anyone already on the course is skipped, never duplicated. Every assign is
// one CourseAssignmentBatch row (the audit), and every person it reaches gets
// an assignment row carrying who assigned it, how, their department, the due
// date and the batch — plus an in-app notification.
// ===========================================================================

function assignableWhere(user) {
  return { AND: [employeeWhere(user), { employmentStatus: { notIn: EXITED } }, NOT_SYSTEM_EMPLOYEE] };
}

// 'YYYY-MM-DD' -> end of that day; null when blank; { error } when bad.
function parseDue(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return { error: 'The due date must be a date (YYYY-MM-DD).' };
  const d = new Date(`${s}T23:59:59`);
  if (Number.isNaN(d.getTime())) return { error: 'The due date must be a date (YYYY-MM-DD).' };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (d < today) return { error: 'The due date cannot be in the past.' };
  return d;
}

const SOURCE_OF = { Everyone: 'Everyone', Departments: 'Department', Individuals: 'Individual' };

async function notifyAssigned(req, course, people, due) {
  if (!people.length) return;
  await audience.deliver({
    employees: people,
    channels: [],
    title: `Course assigned: ${course.title}`,
    message: `${req.user.name || 'HR'} assigned you "${course.title}"${due ? ` — due ${due.toISOString().slice(0, 10)}` : ''}. Open HRMS → Performance & Development → LMS → My Learning.`,
    by: req.user,
    exceptUserId: null,
  }).catch(() => {});
}

// One person, from the course screen or POST /assignments.
async function assignIndividually(req, course, employee, due) {
  const batch = await prisma.courseAssignmentBatch.create({
    data: {
      courseId: course.id, mode: 'Individuals', employeeIds: JSON.stringify([employee.id]),
      label: employee.name, assignedById: req.user.id, assignedByName: req.user.name || null,
      assignedByRole: req.user.hrmsRole || req.user.role || null, orgWide: orgWide(req.user),
      dueDate: due || null, assignedCount: 1,
    },
  });
  const assignment = await prisma.courseAssignment.create({
    data: {
      courseId: course.id, employeeId: employee.id, batchId: batch.id, dueDate: due || null,
      assignedById: req.user.id, assignedByName: req.user.name || null,
      source: 'Individual', department: employee.department || null,
    },
  });
  await notifyAssigned(req, course, [employee], due);
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Course assigned (Individual)', entity: 'Course', entityId: course.id, toValue: employee.name });
  return { assignment, batch };
}

router.get('/courses/:id/assign-options', ASSIGN, async (req, res) => {
  const course = await courseOr404(req, res);
  if (!course) return undefined;
  const [people, table, assigned] = await Promise.all([
    prisma.employee.findMany({
      where: assignableWhere(req.user),
      select: { id: true, name: true, employeeCode: true, department: true, team: true, designation: true },
      orderBy: { name: 'asc' },
    }),
    prisma.department.findMany({ where: require('../utils/masters').activeOnly('Department'), select: { name: true }, orderBy: { name: 'asc' } }),
    prisma.courseAssignment.findMany({ where: { courseId: course.id }, select: { employeeId: true } }),
  ]);
  const assignedIds = new Set(assigned.map((a) => a.employeeId));
  const scope = scopeOf(req.user);
  const wide = orgWide(req.user);
  // The departments this login may pick — the same list the server checks a
  // request against (utils/audience.js allowedDepartments).
  const allowed = await audience.allowedDepartments(req.user);
  const names = new Set(allowed);
  if (wide) table.forEach((d) => names.add(d.name));
  const departments = [...names].sort((a, b) => a.localeCompare(b)).map((name) => {
    const inDept = people.filter((p) => p.department === name);
    return {
      name,
      employees: inDept.length,
      notYetAssigned: inDept.filter((p) => !assignedIds.has(p.id)).length,
    };
  });
  return res.json({
    course: { id: course.id, title: course.title, approvalStatus: course.approvalStatus, assignMode: course.assignMode },
    scope: { global: wide, departments: scope.departments, teams: scope.teams },
    // Only an organisation-wide login may pick "Everyone".
    canAssignEveryone: wide,
    departments,
    employees: people.map((p) => ({ ...p, assigned: assignedIds.has(p.id) })),
    total: people.length,
    alreadyAssigned: people.filter((p) => assignedIds.has(p.id)).length,
  });
});

const ASSIGN_MODES = {
  everyone: 'everyone', all: 'everyone',
  departments: 'departments', department: 'departments',
  individuals: 'individuals', individual: 'individuals', employees: 'individuals',
};
const BATCH_MODE = { everyone: 'Everyone', departments: 'Departments', individuals: 'Individuals' };

// PREVIEW then COMMIT through the same code: `preview: true` answers "how
// many people will receive this" without writing, so the confirmation the
// screen shows is computed by exactly the rule that then runs.
router.post('/courses/:id/assign', ASSIGN, async (req, res) => {
  const course = await courseOr404(req, res);
  if (!course) return undefined;
  if (course.approvalStatus !== 'Approved') {
    return res.status(409).json({ error: 'This course is still awaiting approval — it can be assigned once it is published.' });
  }
  const b = req.body || {};
  // Either { mode, departments, employeeIds } or the shared picker's
  // { audience: { mode, departments, employeeIds } }.
  const src = (b.audience && typeof b.audience === 'object') ? b.audience : b;
  const kind = ASSIGN_MODES[String(src.mode || '').trim().toLowerCase()];
  if (!kind) return res.status(400).json({ error: 'Choose who to assign it to: Everyone, Department(s) or Individual employee(s).' });
  const aud = {
    mode: kind,
    departments: kind === 'departments' ? audience.list(src.departments) : [],
    employeeIds: kind === 'individuals' ? audience.list(src.employeeIds) : [],
  };
  if (kind === 'everyone' && !orgWide(req.user)) {
    return res.status(403).json({ error: 'Only an organisation-wide role (HR, Super Admin, Manager) can assign a course to everyone. Pick your department(s) or employees instead.' });
  }
  const due = parseDue(b.dueDate);
  if (due && due.error) return res.status(400).json({ error: due.error });

  const resolved = await audience.resolveAudience(req.user, aud);
  if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
  const targets = resolved.employees;

  const existing = new Set((await prisma.courseAssignment.findMany({
    where: { courseId: course.id, employeeId: { in: targets.map((t) => t.id) } },
    select: { employeeId: true },
  })).map((a) => a.employeeId));
  const fresh = targets.filter((t) => !existing.has(t.id));
  const mode = BATCH_MODE[kind];
  const summary = {
    mode,
    departments: aud.departments,
    label: resolved.label,
    dueDate: due || null,
    eligible: targets.length,
    alreadyAssigned: existing.size,
    toAssign: fresh.length,
    // Picked individuals who have exited are reported, not silently dropped.
    // (Anybody OUTSIDE the caller's scope was a 403 above.)
    skippedOutOfScope: 0,
    skippedExited: kind === 'individuals' ? aud.employeeIds.length - targets.length : 0,
    sample: fresh.slice(0, 8).map((t) => t.name),
  };
  if (b.preview) return res.json({ preview: true, ...summary });

  const batch = await prisma.courseAssignmentBatch.create({
    data: {
      courseId: course.id, mode,
      departments: aud.departments.length ? aud.departments.join(',') : null,
      // Everyone the batch reached (or already had it) — see joinOrgWideCourses().
      employeeIds: JSON.stringify(targets.map((t) => t.id)),
      label: resolved.label, assignedById: req.user.id, assignedByName: req.user.name || null,
      assignedByRole: req.user.hrmsRole || req.user.role || null, orgWide: orgWide(req.user),
      dueDate: due || null, assignedCount: fresh.length, alreadyCount: existing.size,
    },
  });
  if (fresh.length) {
    await prisma.courseAssignment.createMany({
      data: fresh.map((t) => ({
        courseId: course.id, employeeId: t.id, batchId: batch.id, dueDate: due || null,
        assignedById: req.user.id, assignedByName: req.user.name || null,
        source: SOURCE_OF[mode], department: t.department || null,
      })),
    });
  }
  await prisma.course.update({
    where: { id: course.id },
    data: { assignMode: mode, assignDepartments: kind === 'departments' ? aud.departments.join(',') : null },
  });
  await notifyAssigned(req, course, fresh, due);
  await logAudit({
    userId: req.user.id, actorName: req.user.name,
    action: `Course assigned (${mode}) — ${fresh.length} new, ${existing.size} already assigned`,
    entity: 'Course', entityId: course.id,
    toValue: resolved.label,
  });
  return res.status(201).json({ preview: false, assigned: fresh.length, batchId: batch.id, ...summary });
});

// ===========================================================================
// HISTORY — the LMS audit trail (HRMS-24 §22), held to the caller's scope
// (utils/scope.js employeeWhere): an employee reads their own, a TL their
// team's, an STL their departments', HR / Super Admin / Manager everybody's.
//
//   assignments  per enrolment: course, assigned by, how (Everyone /
//                Department / Individual), department, employee, date and
//                time, due date, status.
//   completions  per enrolment: start, last accessed, video and document
//                progress, attempts (each one), score, pass / fail,
//                completion date, certificate.
//   batches      each "assign" action — the caller's own, or all of them for
//                an organisation-wide login.
// ===========================================================================
router.get('/history', VIEW, async (req, res) => {
  const where = { employee: employeeWhere(req.user) };
  if (req.query.courseId) where.courseId = String(req.query.courseId);
  const rows = await prisma.courseAssignment.findMany({
    where,
    include: {
      course: true,
      employee: { select: { id: true, name: true, employeeCode: true, department: true, designation: true } },
    },
    orderBy: { assignedAt: 'desc' },
    take: 5000,
  });
  const courseIds = [...new Set(rows.map((r) => r.courseId))];
  const empIds = [...new Set(rows.map((r) => r.employeeId))];
  const [materials, progress, qCounts, attempts] = rows.length
    ? await Promise.all([
      prisma.courseMaterial.findMany({ where: { courseId: { in: courseIds } } }),
      prisma.courseMaterialProgress.findMany({ where: { courseId: { in: courseIds }, employeeId: { in: empIds } } }),
      prisma.assessmentQuestion.groupBy({ by: ['courseId'], where: { courseId: { in: courseIds } }, _count: true }),
      prisma.courseAssessmentAttempt.findMany({ where: { assignmentId: { in: rows.map((r) => r.id) } }, orderBy: { startedAt: 'asc' } }),
    ])
    : [[], [], [], []];
  const qBy = new Map(qCounts.map((q) => [q.courseId, q._count]));
  const out = rows.map((a) => {
    const st = stateOf(
      a.course,
      materials.filter((m) => m.courseId === a.courseId),
      new Map(progress.filter((p) => p.employeeId === a.employeeId && p.courseId === a.courseId).map((p) => [p.materialId, p])),
      a,
      qBy.get(a.courseId) || 0,
    );
    const tries = attempts.filter((t) => t.assignmentId === a.id).map((t) => ({
      attemptNo: t.attemptNo, startedAt: t.startedAt, submittedAt: t.submittedAt,
      score: t.score, passed: t.passed, timedOut: t.timedOut, total: t.total,
    }));
    return {
      id: a.id,
      courseId: a.courseId,
      course: a.course.title,
      employeeId: a.employeeId,
      employee: a.employee.name,
      employeeCode: a.employee.employeeCode,
      department: a.department || a.employee.department || null,
      currentDepartment: a.employee.department || null,
      assignedBy: a.assignedByName || null,
      assignedTo: a.source || null,
      assignedAt: a.assignedAt,
      dueDate: a.dueDate,
      overdue: !!(a.dueDate && !a.completed && new Date(a.dueDate) < new Date()),
      status: st.stage,
      startedAt: a.startedAt,
      lastAccessedAt: a.lastAccessedAt,
      coursePct: st.coursePct,
      videoPct: st.videoPct,
      videoSecondsWatched: st.videoSecondsWatched,
      docPct: st.docPct,
      docsDone: st.docsDone,
      docTotal: st.docTotal,
      assessmentStatus: st.assessmentStatus,
      assessmentStartedAt: a.assessmentStartedAt,
      assessmentCompletedAt: a.assessmentCompletedAt,
      attempts: a.attempts,
      attemptLog: tries,
      score: a.score,
      result: !st.needsAssessment ? (a.completed ? 'Completed (no assessment)' : null) : (a.completed ? 'Pass' : (a.attempts ? 'Fail' : null)),
      passedAttempt: a.passedAttempt,
      completed: a.completed,
      completedAt: a.completedAt,
      certificateEligible: a.certificateEligible,
      certificateId: a.certificateId,
    };
  });
  const batches = await prisma.courseAssignmentBatch.findMany({
    where: {
      ...(orgWide(req.user) ? {} : { assignedById: req.user.id }),
      ...(req.query.courseId ? { courseId: String(req.query.courseId) } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });
  const titles = new Map((await prisma.course.findMany({
    where: { id: { in: [...new Set(batches.map((x) => x.courseId))] } },
    select: { id: true, title: true },
  })).map((c) => [c.id, c.title]));
  return res.json({
    rows: out,
    batches: batches.map((x) => ({
      id: x.id, courseId: x.courseId, course: titles.get(x.courseId) || '—', mode: x.mode,
      departments: audience.list(x.departments), label: x.label,
      assignedBy: x.assignedByName, assignedByRole: x.assignedByRole, orgWide: x.orgWide,
      dueDate: x.dueDate, assignedCount: x.assignedCount, alreadyCount: x.alreadyCount, createdAt: x.createdAt,
    })),
  });
});

// ===========================================================================
// CERTIFICATES.
//
// Readable by the learner themselves, and by anybody whose data scope reaches
// the learner (a TL their team's, HR everybody's) — the same rule as every
// other employee record. View is JSON the screen lays out; Download is a PDF
// drawn from the same payload (utils/certificatePdf.js).
// ===========================================================================

async function certificatePayload(req, res) {
  const a = await prisma.courseAssignment.findUnique({
    where: { id: req.params.id },
    include: { course: true, employee: { select: { id: true, name: true, employeeCode: true, department: true, designation: true, employmentStatus: true } } },
  });
  if (!a) { res.status(404).json({ error: 'Certificate not found' }); return null; }
  if (!(await mayReadEmployee(req, a.employeeId))) {
    res.status(403).json({ error: 'This record is outside your access scope' });
    return null;
  }
  if (!a.completed) { res.status(409).json({ error: 'This course has not been completed yet.' }); return null; }
  const issued = a.certificateId ? a : await issueCertificate(a);
  const company = await prisma.company.findFirst().catch(() => null);
  return {
    assignmentId: a.id,
    courseId: a.courseId,
    certificateId: issued.certificateId,
    issuedAt: issued.certificateIssuedAt,
    completedAt: a.completedAt,
    employeeName: a.employee.name,
    employeeCode: a.employee.employeeCode,
    department: a.employee.department,
    courseTitle: a.course.title,
    category: a.course.category,
    duration: a.course.duration,
    score: a.score,
    passMark: a.course.passMark,
    organisation: (company && (company.legalName || company.name)) || 'TeamLink Consultants',
  };
}

router.get('/certificates/:id', VIEW, async (req, res) => {
  const cert = await certificatePayload(req, res);
  if (!cert) return undefined;
  return res.json(cert);
});

router.get('/certificates/:id/pdf', VIEW, async (req, res) => {
  const cert = await certificatePayload(req, res);
  if (!cert) return undefined;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${cert.certificateId}.pdf"`);
  res.setHeader('Cache-Control', 'no-store');
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Certificate downloaded', entity: 'Course', entityId: cert.courseId, toValue: cert.certificateId });
  return renderCertificate(cert, res);
});

module.exports = router;
