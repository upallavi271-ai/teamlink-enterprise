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

const DENIED = { error: "This action isn't included in your role's permissions" };

function csv(v) {
  return String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// YYYY-MM-DD or nothing. The browser sends an <input type="date"> value; a
// hand-rolled string is refused rather than stored in a shape the filters and
// the reports cannot compare.
function asDate(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`${label} must be a date`);
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
router.get('/options', VIEW, async (req, res) => {
  const me = req.user;
  const s = scopeOf(me);
  const [{ canAssignOthers, people, reason }, departmentRows] = await Promise.all([
    assignable(me),
    prisma.department.findMany({ select: { name: true }, orderBy: { name: 'asc' } }),
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
    assignable: people,
    canAssignOthers,
    scopeNote: reason,
    me: { id: me.id, name: me.name, department: me.department || null },
    today: today(),
  });
});

// --- List -------------------------------------------------------------------
router.get('/', VIEW, async (req, res) => {
  const where = await visibleWhere(req.user);
  const and = [];
  if (req.query.department) and.push({ department: req.query.department });
  if (req.query.status) and.push({ status: req.query.status });
  if (req.query.assigneeId) and.push({ assigneeId: req.query.assigneeId });
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
});

// --- Task Reports -----------------------------------------------------------
//
// Every figure here is a count over the SAME scoped task set the list shows.
// Nothing is modelled, estimated or filled in: where a task carries no end
// date it is counted as "no due date", never as on time or late.
router.get('/reports', VIEW, async (req, res) => {
  const where = await visibleWhere(req.user);
  const tasks = await prisma.task.findMany({ where });
  const now = today();

  const byStatus = TASK_STATUSES.map((status) => ({
    status, count: tasks.filter((t) => t.status === status).length,
  })).filter((r) => r.count > 0);

  const byPerson = [];
  tasks.forEach((t) => {
    let row = byPerson.find((r) => r.userId === t.assigneeId);
    if (!row) {
      row = { userId: t.assigneeId, name: t.assigneeName, total: 0, open: 0, completed: 0, overdue: 0 };
      byPerson.push(row);
    }
    row.total += 1;
    if (t.status === 'Completed') row.completed += 1;
    else if (OPEN_STATUSES.includes(t.status)) row.open += 1;
    if (t.endDate && t.endDate < now && OPEN_STATUSES.includes(t.status)) row.overdue += 1;
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

  const withDue = tasks.filter((t) => t.endDate);
  res.json({
    generatedAt: new Date().toISOString(),
    total: tasks.length,
    byStatus,
    byPerson,
    byDepartment,
    overdue: tasks.filter((t) => t.endDate && t.endDate < now && OPEN_STATUSES.includes(t.status)).length,
    dueToday: tasks.filter((t) => t.endDate === now && OPEN_STATUSES.includes(t.status)).length,
    noDueDate: tasks.length - withDue.length,
    // What this roll-up CANNOT say, said plainly rather than invented: a task
    // carries a start and an end date, not logged hours, and nothing records
    // the moment a task was actually finished. So there is no time-spent
    // figure and no on-time-completion rate here.
    notComputed: [
      'Hours or effort spent — a task carries dates, not a time log, so no hours figure can be derived.',
      'On-time completion rate — the date a task was completed is not recorded, only its current status.',
    ],
    scopeNote: (await assignable(req.user)).reason,
  });
});

// --- Create -----------------------------------------------------------------
router.post('/', VIEW, async (req, res, next) => {
  try {
    const me = req.user;
    const {
      department, name, description, subTaskName, status,
      startDate, endDate, dependent, dependsOnId,
    } = req.body;

    if (!department || !String(department).trim()) return res.status(400).json({ error: 'Select a department.' });
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Enter a task name.' });
    if (!status || !TASK_STATUSES.includes(status)) return res.status(400).json({ error: 'Select a status.' });

    let start;
    let end;
    try {
      start = asDate(startDate, 'Task start date');
      end = asDate(endDate, 'Task end date');
    } catch (err) { return res.status(400).json({ error: err.message }); }
    if (!start) return res.status(400).json({ error: 'Task start date is required.' });
    if (end && end < start) return res.status(400).json({ error: 'The end date cannot fall before the start date.' });

    // Assign To — blank means "myself", exactly as the field says.
    const wanted = req.body.assigneeId || me.id;
    const { canAssignOthers, people } = await assignable(me);
    if (wanted !== me.id && !canAssignOthers) return res.status(403).json(DENIED);
    const target = people.find((p) => p.userId === wanted);
    if (!target) return res.status(403).json(OUT_OF_SCOPE);

    // A dependency has to be a task this user can actually see.
    let dependsOn = null;
    if (dependent && dependsOnId) {
      const found = await reachable(me, String(dependsOnId));
      if (found.error) return res.status(400).json({ error: 'That dependent task is not one you can reach.' });
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
      },
    });
    await logAudit({
      userId: me.id, action: 'Task created', entity: 'Task', entityId: task.id,
      toValue: `${task.name} → ${task.assigneeName}`,
    });
    res.status(201).json(task);
  } catch (err) { next(err); }
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
    if (b.name !== undefined) {
      if (!String(b.name).trim()) return res.status(400).json({ error: 'Enter a task name.' });
      data.name = String(b.name).trim();
    }
    if (b.department !== undefined) {
      if (!String(b.department).trim()) return res.status(400).json({ error: 'Select a department.' });
      data.department = String(b.department).trim();
    }
    if (b.description !== undefined) data.description = b.description ? String(b.description) : null;
    if (b.subTaskName !== undefined) data.subTaskName = b.subTaskName ? String(b.subTaskName).trim() : null;
    if (b.status !== undefined) {
      if (!TASK_STATUSES.includes(b.status)) return res.status(400).json({ error: 'Select a status.' });
      data.status = b.status;
    }
    try {
      if (b.startDate !== undefined) data.startDate = asDate(b.startDate, 'Task start date');
      if (b.endDate !== undefined) data.endDate = asDate(b.endDate, 'Task end date');
    } catch (err) { return res.status(400).json({ error: err.message }); }
    const start = data.startDate !== undefined ? data.startDate : found.task.startDate;
    const end = data.endDate !== undefined ? data.endDate : found.task.endDate;
    if (start && end && end < start) return res.status(400).json({ error: 'The end date cannot fall before the start date.' });

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

// --- Comments ---------------------------------------------------------------
router.get('/:id/comments', VIEW, async (req, res) => {
  const found = await reachable(req.user, req.params.id);
  if (found.error) return res.status(found.status).json(found.error);
  const comments = await prisma.taskComment.findMany({
    where: { taskId: found.task.id }, orderBy: { createdAt: 'asc' },
  });
  res.json({ task: found.task, comments });
});

router.post('/:id/comments', VIEW, async (req, res) => {
  const found = await reachable(req.user, req.params.id);
  if (found.error) return res.status(found.status).json(found.error);
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Write a comment first.' });
  const comment = await prisma.taskComment.create({
    data: { taskId: found.task.id, authorId: req.user.id, authorName: req.user.name, text },
  });
  res.status(201).json(comment);
});

module.exports = router;
module.exports.TASK_STATUSES = TASK_STATUSES;
