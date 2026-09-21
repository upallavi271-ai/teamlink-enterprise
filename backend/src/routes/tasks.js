// ---------------------------------------------------------------------------
// Timesheet — tasks, assignment, comments and the Task Reports roll-up.
//
// PERMISSIONS COME FROM THE ONE ENGINE. There is no role list in this file.
//
//   reach the screen at all      can(hrms / Employee Services / view)
//                                — SET.STAFF by default: every employee.
//   assign work to SOMEONE ELSE  can(hrms / Employee Services / create)
//                                — SET.HR by default: Admin, Manager,
//                                  Assistant Manager, STL, TL. A recruiter
//                                  does NOT have it, so a recruiter's
//                                  Assign To offers only themselves.
//   WHICH other people           utils/scope.js employeeWhere(me) — the same
//                                department scope every other list obeys,
//                                narrowed to the team when the login carries
//                                an explicit atsScopeTeams.
//
// Scope is re-resolved from the database on every request (middleware/auth.js),
// so editing a user's scope on Administration → Users changes what they can
// fetch here on their very next call — no re-login.
// ---------------------------------------------------------------------------

const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { can } = require('../utils/permissions');
const { scopeOf, employeeWhere, OUT_OF_SCOPE } = require('../utils/scope');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);

// The status vocabulary. One list, served to the browser by /options so the
// modal's "-- Select Status --" picker and this file can never disagree.
const TASK_STATUSES = ['Not Started', 'In Progress', 'On Hold', 'Completed', 'Cancelled'];
const OPEN_STATUSES = ['Not Started', 'In Progress', 'On Hold'];

// The review leg of the lifecycle, stored on Task.reviewState.
//
//   Not Submitted   -> nobody has finished the work yet
//   Pending Review  -> the assignee pressed Complete; a reviewer owes a decision
//   Approved        -> a reviewer signed it off
//   Changes Requested -> a reviewer sent it back; the task reopens In Progress
const REVIEW_STATES = ['Not Submitted', 'Pending Review', 'Approved', 'Changes Requested'];

const DENIED = { error: "This action isn't included in your role's permissions" };

// The validation messages, in one place, worded exactly as the screen shows
// them so the browser's inline message and the API's refusal are the same
// sentence. The browser checks first; THESE are what actually enforce it.
const MSG = {
  department: 'Please select a department.',
  name: 'Please enter a task name.',
  status: 'Please select a status.',
  startDate: 'Please select a start date.',
  endBeforeStart: 'End date cannot be before start date.',
};

function csv(v) {
  return String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// YYYY-MM-DD or nothing. The browser sends an <input type="date"> value; a
// hand-rolled string is refused rather than stored in a shape the filters and
// the reports cannot compare.
//
// The shape test alone is not enough: "2026-02-31" and "2026-13-01" both match
// the pattern and are not days. They are round-tripped through Date and the
// result has to come back as the same string, so an impossible combination is
// rejected here instead of silently becoming a date nobody chose. This never
// throws on a rejection path that could reach the process — every caller wraps
// it — and it never calls `new Date()` on a value it has not already
// pattern-checked, which is what made the earlier date coercion blow up.
function asDate(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`${label} must be a real date (YYYY-MM-DD).`);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw new Error(`${label} is not a real date.`);
  }
  return s;
}

// --- Who this user may assign work to --------------------------------------
//
// Two separate questions, answered by the two halves of the engine:
//   1. MAY they assign to anyone but themselves?  -> can(), the action matrix
//   2. WHICH people?                              -> scope.js, the data scope
async function assignable(me) {
  const self = {
    userId: me.id,
    employeeId: me.employeeId,
    name: me.name,
    department: me.department || null,
    team: me.team || null,
    designation: me.designation || null,
    self: true,
  };

  const canAssignOthers = await can(me, 'hrms', 'hrms', 'Employee Services', 'create');
  if (!canAssignOthers) {
    return {
      canAssignOthers: false,
      people: [self],
      reason: 'Your role assigns work to yourself only.',
    };
  }

  const s = scopeOf(me);
  const where = { ...employeeWhere(me), userId: { not: null } };
  // "A TL to their team." When a login carries an EXPLICIT team scope, hold it
  // to that team; a lead with no configured team keeps their whole department.
  const explicitTeams = csv(me.atsScopeTeams);
  if (!s.global && explicitTeams.length) {
    where.AND = [{ OR: [{ team: { in: explicitTeams } }, { id: me.employeeId || '__none__' }] }];
  }

  const employees = await prisma.employee.findMany({
    where,
    select: {
      id: true, userId: true, name: true, department: true, team: true, designation: true,
      employmentStatus: true, user: { select: { status: true } },
    },
    orderBy: { name: 'asc' },
  });

  const people = employees
    .filter((e) => e.userId && (e.user?.status || 'Active') === 'Active')
    .map((e) => ({
      userId: e.userId,
      employeeId: e.id,
      name: e.name,
      department: e.department || null,
      team: e.team || null,
      designation: e.designation || null,
      self: e.userId === me.id,
    }));

  if (!people.some((p) => p.self)) people.unshift(self);
  return {
    canAssignOthers: true,
    people,
    reason: s.global
      ? 'Your role assigns work across every department.'
      : `Your role assigns work within ${(s.departments.join(', ') || 'your own records')}${explicitTeams.length ? ` · team ${explicitTeams.join(', ')}` : ''}.`,
  };
}

// The tasks this user may READ: their own, the ones they handed out, and — for
// a lead — everyone in their scope. Built from the same assignable() set, so
// the list and the Assign To picker can never drift apart.
async function visibleWhere(me) {
  const { canAssignOthers, people } = await assignable(me);
  if (!canAssignOthers) {
    return { OR: [{ assigneeId: me.id }, { assignedById: me.id }] };
  }
  const s = scopeOf(me);
  if (s.global) return {};
  const ids = people.map((p) => p.userId);
  return { OR: [{ assigneeId: { in: ids } }, { assignedById: me.id }] };
}

// One place that decides whether this user may change this task.
//   * the person it is assigned to, and the person who assigned it, always;
//   * a lead with hrms / Employee Services / edit, when the assignee is inside
//     their scope.
async function mayEdit(me, task) {
  if (task.assigneeId === me.id || task.assignedById === me.id) return true;
  const ok = await can(me, 'hrms', 'hrms', 'Employee Services', 'edit');
  if (!ok) return false;
  const { people } = await assignable(me);
  return people.some((p) => p.userId === task.assigneeId);
}

async function reachable(me, id) {
  const task = await prisma.task.findUnique({ where: { id } });
  if (!task) return { status: 404, error: { error: 'Task not found' } };
  if (task.assigneeId === me.id || task.assignedById === me.id) return { task };
  const s = scopeOf(me);
  if (s.global) return { task };
  const { people } = await assignable(me);
  if (people.some((p) => p.userId === task.assigneeId)) return { task };
  return { status: 403, error: OUT_OF_SCOPE };
}

const VIEW = requirePerm('hrms', 'hrms', 'Employee Services', 'view');

// --- Options the screen renders --------------------------------------------
router.get('/options', VIEW, async (req, res, next) => {
  try {
    const me = req.user;
    const s = scopeOf(me);
    const [{ canAssignOthers, people, reason }, departmentRows, canReview] = await Promise.all([
      assignable(me),
      prisma.department.findMany({ select: { name: true }, orderBy: { name: 'asc' } }),
      can(me, 'hrms', 'hrms', 'Employee Services', 'approve'),
    ]);
    // The department picker offers what this login can actually work in: every
    // department for a global role, their own scope otherwise.
    const all = departmentRows.map((d) => d.name);
    const departments = s.global
      ? all
      : [...new Set([...s.departments, ...people.map((p) => p.department).filter(Boolean)])].sort();

    res.json({
      departments,
      statuses: TASK_STATUSES,
      reviewStates: REVIEW_STATES,
      assignable: people,
      canAssignOthers,
      // Signing work off is its own right, not a side-effect of being able to
      // finish it. The Review button is hidden without it and the API refuses
      // it anyway.
      canReview,
      scopeNote: reason,
      me: { id: me.id, name: me.name, department: me.department || null },
      today: today(),
    });
  } catch (err) { next(err); }
});

// --- List -------------------------------------------------------------------
router.get('/', VIEW, async (req, res, next) => {
  try {
    const where = await visibleWhere(req.user);
    const and = [];
    if (req.query.department) and.push({ department: req.query.department });
    if (req.query.status) and.push({ status: req.query.status });
    if (req.query.reviewState) and.push({ reviewState: String(req.query.reviewState) });
    if (req.query.assigneeId) and.push({ assigneeId: req.query.assigneeId });
    // "Mine" — the assignee's own My Tasks view, which is what a lead uses to
    // separate their own work from their team's.
    if (req.query.mine === '1') and.push({ assigneeId: req.user.id });
    // The two dd-mm-yyyy boxes: tasks whose window overlaps the one asked for.
    // `from` keeps anything that has not already ended, `to` anything that has
    // already started — an open-ended task is never filtered away by accident.
    if (req.query.from) and.push({ OR: [{ endDate: null }, { endDate: { gte: String(req.query.from) } }] });
    if (req.query.to) and.push({ OR: [{ startDate: null }, { startDate: { lte: String(req.query.to) } }] });
    if (req.query.q) {
      const q = String(req.query.q);
      and.push({ OR: [{ name: { contains: q } }, { subTaskName: { contains: q } }, { description: { contains: q } }] });
    }

    const tasks = await prisma.task.findMany({
      where: and.length ? { AND: [where, ...and] } : where,
      orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }],
    });
    const counts = await prisma.taskComment.groupBy({
      by: ['taskId'],
      where: { taskId: { in: tasks.map((t) => t.id) } },
      _count: { _all: true },
    });
    const commentCount = Object.fromEntries(counts.map((c) => [c.taskId, c._count._all]));
    res.json(tasks.map((t) => ({ ...t, commentCount: commentCount[t.id] || 0 })));
  } catch (err) { next(err); }
});

// --- Task Reports -----------------------------------------------------------
//
// Every figure here is a count over the SAME scoped task set the list shows.
// Nothing is modelled, estimated or filled in: where a task carries no end
// date it is counted as "no due date", never as on time or late.
router.get('/reports', VIEW, async (req, res, next) => {
  try {
    const where = await visibleWhere(req.user);
    const tasks = await prisma.task.findMany({ where });
    const now = today();

    const byStatus = TASK_STATUSES.map((status) => ({
      status, count: tasks.filter((t) => t.status === status).length,
    })).filter((r) => r.count > 0);

    // The review leg, counted the same way: states with nothing in them are
    // left out rather than shown as a zero.
    const byReview = REVIEW_STATES.map((state) => ({
      state, count: tasks.filter((t) => (t.reviewState || 'Not Submitted') === state).length,
    })).filter((r) => r.count > 0);

    const byPerson = [];
    tasks.forEach((t) => {
      let row = byPerson.find((r) => r.userId === t.assigneeId);
      if (!row) {
        row = {
          userId: t.assigneeId, name: t.assigneeName,
          total: 0, open: 0, completed: 0, overdue: 0, awaitingReview: 0, approved: 0,
        };
        byPerson.push(row);
      }
      row.total += 1;
      if (t.status === 'Completed') row.completed += 1;
      else if (OPEN_STATUSES.includes(t.status)) row.open += 1;
      if (t.endDate && t.endDate < now && OPEN_STATUSES.includes(t.status)) row.overdue += 1;
      if (t.reviewState === 'Pending Review') row.awaitingReview += 1;
      if (t.reviewState === 'Approved') row.approved += 1;
    });
    byPerson.sort((a, b) => b.total - a.total);

    const byDepartment = [];
    tasks.forEach((t) => {
      const key = t.department || 'No department';
      let row = byDepartment.find((r) => r.department === key);
      if (!row) { row = { department: key, total: 0, completed: 0 }; byDepartment.push(row); }
      row.total += 1;
      if (t.status === 'Completed') row.completed += 1;
    });
    byDepartment.sort((a, b) => b.total - a.total);

    // On time vs late — computable at last, because `completedAt` records the
    // MOMENT a task was finished. Only tasks that carry BOTH a completion
    // stamp and a due date can be judged, so that subset is reported as its
    // own denominator instead of being folded into the total.
    const judgeable = tasks.filter((t) => t.completedAt && t.endDate);
    const onTime = judgeable.filter(
      (t) => new Date(t.completedAt).toISOString().slice(0, 10) <= t.endDate,
    ).length;

    const withDue = tasks.filter((t) => t.endDate);
    res.json({
      generatedAt: new Date().toISOString(),
      total: tasks.length,
      byStatus,
      byReview,
      byPerson,
      byDepartment,
      overdue: tasks.filter((t) => t.endDate && t.endDate < now && OPEN_STATUSES.includes(t.status)).length,
      dueToday: tasks.filter((t) => t.endDate === now && OPEN_STATUSES.includes(t.status)).length,
      noDueDate: tasks.length - withDue.length,
      awaitingReview: tasks.filter((t) => t.reviewState === 'Pending Review').length,
      approved: tasks.filter((t) => t.reviewState === 'Approved').length,
      changesRequested: tasks.filter((t) => t.reviewState === 'Changes Requested').length,
      onTime: {
        judged: judgeable.length,
        onTime,
        late: judgeable.length - onTime,
        rate: judgeable.length ? Math.round((onTime / judgeable.length) * 100) : null,
      },
      // What this roll-up STILL cannot say, said plainly rather than invented.
      // A task records when it started and when it finished, but not what was
      // done in between, so there is no effort figure. And a task finished
      // before the lifecycle stamps existed carries no completion moment, so
      // it is excluded from the on-time figure rather than guessed at.
      notComputed: [
        'Hours or effort spent — a task records when it started and finished, not a time log, so no hours figure can be derived.',
        `On-time completion is measured over the ${judgeable.length} task(s) that carry both a recorded completion moment and a due date — tasks completed before this was recorded, or with no due date, are excluded rather than assumed.`,
      ],
      scopeNote: (await assignable(req.user)).reason,
    });
  } catch (err) { next(err); }
});

// --- Create -----------------------------------------------------------------
// ---------------------------------------------------------------------------
// THE task create. Extracted from the POST handler so the route and the AI
// assistant's confirmed "create a task" action run the same validation, the
// same assignable() scope check and the same audit row. Returns
// { status, body } because one caller is not an HTTP handler.
// ---------------------------------------------------------------------------
async function createTask(me, input = {}) {
  const {
    department, name, description, subTaskName, status,
    startDate, endDate, dependent, dependsOnId,
  } = input;

  // THE SAME FIVE RULES THE MODAL CHECKS, enforced here because the modal is
  // a courtesy and this is the gate. `field` names the box so the browser can
  // put the message back under it when the API is what caught the problem.
  const bad = (field, error) => ({ status: 400, body: { field, error } });
  if (!department || !String(department).trim()) return bad('department', MSG.department);
  if (!name || !String(name).trim()) return bad('name', MSG.name);
  if (!status || !TASK_STATUSES.includes(status)) return bad('status', MSG.status);

  let start;
  let end;
  try {
    start = asDate(startDate, 'Task start date');
  } catch (err) { return bad('startDate', err.message); }
  try {
    end = asDate(endDate, 'Task end date');
  } catch (err) { return bad('endDate', err.message); }
  if (!start) return bad('startDate', MSG.startDate);
  if (end && end < start) return bad('endDate', MSG.endBeforeStart);

  // Assign To — blank means "myself", exactly as the field says.
  const wanted = input.assigneeId || me.id;
  const { canAssignOthers, people } = await assignable(me);
  if (wanted !== me.id && !canAssignOthers) return { status: 403, body: DENIED };
  const target = people.find((p) => p.userId === wanted);
  if (!target) return { status: 403, body: OUT_OF_SCOPE };

  // A dependency has to be a task this user can actually see.
  let dependsOn = null;
  if (dependent && dependsOnId) {
    const found = await reachable(me, String(dependsOnId));
    if (found.error) return { status: 400, body: { error: 'That dependent task is not one you can reach.' } };
    dependsOn = found.task.id;
  }

  const task = await prisma.task.create({
    data: {
      name: String(name).trim(),
      department: String(department).trim(),
      description: description ? String(description) : null,
      subTaskName: subTaskName ? String(subTaskName).trim() : null,
      status,
      startDate: start,
      endDate: end,
      dependent: !!dependent,
      dependsOnId: dependsOn,
      assigneeId: target.userId,
      assignedById: me.id,
      assigneeName: target.name,
      assignedByName: me.name,
      // A task created straight into a later state still gets its stamps, so
      // the lifecycle never has a hole in it.
      startedAt: status === 'Not Started' ? null : new Date(),
      completedAt: status === 'Completed' ? new Date() : null,
      reviewState: status === 'Completed' ? 'Pending Review' : 'Not Submitted',
    },
  });
  await logAudit({
    userId: me.id, action: 'Task created', entity: 'Task', entityId: task.id,
    toValue: `${task.name} → ${task.assigneeName}`,
  });
  return { status: 201, body: task };
}

router.post('/', VIEW, async (req, res, next) => {
  try {
    const out = await createTask(req.user, req.body);
    return res.status(out.status).json(out.body);
  } catch (err) { return next(err); }
});

// --- Edit -------------------------------------------------------------------
router.put('/:id', VIEW, async (req, res, next) => {
  try {
    const me = req.user;
    const found = await reachable(me, req.params.id);
    if (found.error) return res.status(found.status).json(found.error);
    if (!(await mayEdit(me, found.task))) return res.status(403).json(DENIED);

    const data = {};
    const b = req.body;
    const bad = (field, error) => res.status(400).json({ field, error });
    if (b.name !== undefined) {
      if (!String(b.name).trim()) return bad('name', MSG.name);
      data.name = String(b.name).trim();
    }
    if (b.department !== undefined) {
      if (!String(b.department).trim()) return bad('department', MSG.department);
      data.department = String(b.department).trim();
    }
    if (b.description !== undefined) data.description = b.description ? String(b.description) : null;
    if (b.subTaskName !== undefined) data.subTaskName = b.subTaskName ? String(b.subTaskName).trim() : null;
    if (b.status !== undefined) {
      if (!TASK_STATUSES.includes(b.status)) return bad('status', MSG.status);
      data.status = b.status;
    }
    try {
      if (b.startDate !== undefined) data.startDate = asDate(b.startDate, 'Task start date');
    } catch (err) { return bad('startDate', err.message); }
    try {
      if (b.endDate !== undefined) data.endDate = asDate(b.endDate, 'Task end date');
    } catch (err) { return bad('endDate', err.message); }
    // An edit may not blank out a start date that the create demanded.
    if (b.startDate !== undefined && !data.startDate) return bad('startDate', MSG.startDate);
    const start = data.startDate !== undefined ? data.startDate : found.task.startDate;
    const end = data.endDate !== undefined ? data.endDate : found.task.endDate;
    if (start && end && end < start) return bad('endDate', MSG.endBeforeStart);

    // Driving the status by hand through Edit still keeps the lifecycle stamps
    // honest, so a task completed from the modal is reviewable exactly like one
    // completed from the row's Complete button.
    if (data.status && data.status !== found.task.status) {
      if (data.status === 'In Progress' && !found.task.startedAt) data.startedAt = new Date();
      if (data.status === 'Completed') {
        if (!found.task.completedAt) data.completedAt = new Date();
        if (found.task.reviewState !== 'Approved') data.reviewState = 'Pending Review';
      } else if (found.task.status === 'Completed') {
        // Reopened: it is no longer a finished task awaiting a decision.
        data.completedAt = null;
        if (found.task.reviewState === 'Pending Review') data.reviewState = 'Not Submitted';
      }
    }

    if (b.dependent !== undefined) data.dependent = !!b.dependent;
    if (b.dependsOnId !== undefined) {
      if (!b.dependsOnId) data.dependsOnId = null;
      else {
        if (String(b.dependsOnId) === found.task.id) return res.status(400).json({ error: 'A task cannot depend on itself.' });
        const dep = await reachable(me, String(b.dependsOnId));
        if (dep.error) return res.status(400).json({ error: 'That dependent task is not one you can reach.' });
        data.dependsOnId = dep.task.id;
      }
    }

    // RE-ASSIGNING runs the same two checks a new task does.
    if (b.assigneeId !== undefined && b.assigneeId !== found.task.assigneeId) {
      const { canAssignOthers, people } = await assignable(me);
      if (b.assigneeId !== me.id && !canAssignOthers) return res.status(403).json(DENIED);
      const target = people.find((p) => p.userId === b.assigneeId);
      if (!target) return res.status(403).json(OUT_OF_SCOPE);
      data.assigneeId = target.userId;
      data.assigneeName = target.name;
    }

    const task = await prisma.task.update({ where: { id: found.task.id }, data });
    await logAudit({
      userId: me.id, action: 'Task updated', entity: 'Task', entityId: task.id,
      fromValue: found.task.status, toValue: task.status,
    });
    res.json(task);
  } catch (err) { next(err); }
});

// --- The lifecycle: start -> complete -> review ------------------------------
//
// Create Task -> it lands in the assignee's My Tasks -> they START it ->
// they COMPLETE it -> a reviewer APPROVES it or SENDS IT BACK -> the Task
// Report counts it. Each hop is its own endpoint rather than a free-text
// status edit, so the moment of each transition is recorded and the permission
// question for each one is asked separately.
//
// Every hop writes a line into the task's own comment thread, which is where
// this screen already keeps its history — no second audit surface.
async function noteOnTask(task, me, text) {
  await prisma.taskComment.create({
    data: { taskId: task.id, authorId: me.id, authorName: me.name, text },
  });
}

// Start and Complete belong to the person the work is FOR. A lead who may edit
// the task can also drive them (someone has to, when the assignee is away),
// which is exactly the mayEdit() rule the Edit modal already uses.
router.post('/:id/start', VIEW, async (req, res, next) => {
  try {
    const me = req.user;
    const found = await reachable(me, req.params.id);
    if (found.error) return res.status(found.status).json(found.error);
    if (!(await mayEdit(me, found.task))) return res.status(403).json(DENIED);
    const t = found.task;
    if (t.status === 'Cancelled') return res.status(400).json({ error: 'A cancelled task cannot be started.' });
    if (t.status === 'In Progress') return res.status(400).json({ error: 'That task is already in progress.' });
    if (t.status === 'Completed') return res.status(400).json({ error: 'That task is already complete. Reopen it from Edit first.' });

    const task = await prisma.task.update({
      where: { id: t.id },
      data: {
        status: 'In Progress',
        startedAt: t.startedAt || new Date(),
        completedAt: null,
      },
    });
    await noteOnTask(t, me, `${me.name} started this task.`);
    await logAudit({
      userId: me.id, action: 'Task started', entity: 'Task', entityId: task.id,
      fromValue: t.status, toValue: task.status,
    });
    res.json(task);
  } catch (err) { next(err); }
});

// Complete does NOT end the workflow — it hands the task to a reviewer.
router.post('/:id/complete', VIEW, async (req, res, next) => {
  try {
    const me = req.user;
    const found = await reachable(me, req.params.id);
    if (found.error) return res.status(found.status).json(found.error);
    if (!(await mayEdit(me, found.task))) return res.status(403).json(DENIED);
    const t = found.task;
    if (t.status === 'Cancelled') return res.status(400).json({ error: 'A cancelled task cannot be completed.' });
    if (t.status === 'Completed') return res.status(400).json({ error: 'That task is already complete.' });

    const note = String(req.body.note || '').trim();
    const task = await prisma.task.update({
      where: { id: t.id },
      data: {
        status: 'Completed',
        startedAt: t.startedAt || new Date(),
        completedAt: new Date(),
        reviewState: 'Pending Review',
        reviewedById: null,
        reviewedByName: null,
        reviewedAt: null,
        reviewNote: null,
      },
    });
    await noteOnTask(t, me, `${me.name} marked this task complete and sent it for review.${note ? ` — ${note}` : ''}`);
    await logAudit({
      userId: me.id, action: 'Task completed', entity: 'Task', entityId: task.id,
      fromValue: t.status, toValue: 'Completed · Pending Review',
    });
    res.json(task);
  } catch (err) { next(err); }
});

// The review decision. A SEPARATE permission — hrms / Employee Services /
// approve — so finishing your own work and signing work off are not the same
// right. A recruiter or a plain employee has `view` but not `approve`, so the
// engine refuses this for them even on their own task.
router.post('/:id/review', VIEW, async (req, res, next) => {
  try {
    const me = req.user;
    const found = await reachable(me, req.params.id);
    if (found.error) return res.status(found.status).json(found.error);
    const mayReview = await can(me, 'hrms', 'hrms', 'Employee Services', 'approve');
    if (!mayReview) return res.status(403).json(DENIED);
    const t = found.task;
    if (t.reviewState !== 'Pending Review') {
      return res.status(400).json({ error: 'That task is not waiting for a review.' });
    }
    const decision = String(req.body.decision || '').toLowerCase();
    if (!['approve', 'changes'].includes(decision)) {
      return res.status(400).json({ error: 'Choose Approve or Request changes.' });
    }
    const note = String(req.body.note || '').trim();
    if (decision === 'changes' && !note) {
      return res.status(400).json({ error: 'Say what needs changing.' });
    }

    const approved = decision === 'approve';
    const task = await prisma.task.update({
      where: { id: t.id },
      data: {
        reviewState: approved ? 'Approved' : 'Changes Requested',
        reviewedById: me.id,
        reviewedByName: me.name,
        reviewedAt: new Date(),
        reviewNote: note || null,
        // Sent back = back on the assignee's plate, and no longer a completion.
        status: approved ? 'Completed' : 'In Progress',
        completedAt: approved ? t.completedAt : null,
      },
    });
    await noteOnTask(
      t, me,
      approved
        ? `${me.name} reviewed and approved this task.${note ? ` — ${note}` : ''}`
        : `${me.name} requested changes — ${note}`,
    );
    await logAudit({
      userId: me.id, action: approved ? 'Task approved' : 'Task changes requested',
      entity: 'Task', entityId: task.id, fromValue: 'Pending Review', toValue: task.reviewState,
    });
    res.json(task);
  } catch (err) { next(err); }
});

// --- Comments ---------------------------------------------------------------
router.get('/:id/comments', VIEW, async (req, res, next) => {
  try {
    const found = await reachable(req.user, req.params.id);
    if (found.error) return res.status(found.status).json(found.error);
    const comments = await prisma.taskComment.findMany({
      where: { taskId: found.task.id }, orderBy: { createdAt: 'asc' },
    });
    res.json({ task: found.task, comments });
  } catch (err) { next(err); }
});

router.post('/:id/comments', VIEW, async (req, res, next) => {
  try {
    const found = await reachable(req.user, req.params.id);
    if (found.error) return res.status(found.status).json(found.error);
    const text = String(req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Write a comment first.' });
    const comment = await prisma.taskComment.create({
      data: { taskId: found.task.id, authorId: req.user.id, authorName: req.user.name, text },
    });
    res.status(201).json(comment);
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.TASK_STATUSES = TASK_STATUSES;
module.exports.REVIEW_STATES = REVIEW_STATES;
module.exports.createTask = createTask;
module.exports.assignable = assignable;
module.exports.visibleWhere = visibleWhere;
