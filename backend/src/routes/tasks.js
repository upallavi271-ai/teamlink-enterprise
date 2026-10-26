// ---------------------------------------------------------------------------
// Timesheet — tasks, assignment, comments and the Task Reports roll-up.
//
// PERMISSIONS COME FROM THE ONE ENGINE. There is no role list in this file.
//
//   reach the screen at all      can(hrms / Employee Services / view)
//                                — SET.STAFF by default: every employee.
//   assign work to SOMEONE ELSE  can(hrms / Employee Services / create), AND
//                                every TEAM LEAD (hrmsRole TL) - the user's
//                                rule 2026-10-12: "TLs can assign the new task
//                                to their employees in the Timesheet". The
//                                matrix strips create/edit from a TL across
//                                HRMS (permissions.js section 11), and widening
//                                it there would also hand a TL announcements,
//                                documents, helpdesk and assets, so the TL's
//                                right is given HERE, to tasks only
//                                (teamLeadOf). A Manager / Assistant Manager
//                                stays view-only (permissions.js viewOnlyAllows).
//                                (SINCE 2026-10-24 that is no longer asked for GIVING: everyone can
//                                give a task to anyone, see assignable() below.)
//   WHICH other people           ANYONE active in the company (founder rule 2026-10-24).
//                                What a LEAD can edit / see of other people's tasks
//                                still follows utils/scope.js employeeWhere(me).
//
// Scope is re-resolved from the database on every request (middleware/auth.js),
// so editing a user's scope on Administration → Users changes what they can
// fetch here on their very next call — no re-login.
// ---------------------------------------------------------------------------

const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { can } = require('../utils/permissions');
const { scopeOf, employeeWhere, hrmsGlobal, OUT_OF_SCOPE } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const { NOT_SYSTEM_EMPLOYEE } = require('../utils/systemAccounts');
const hrmsNotify = require('../utils/hrmsNotify');
const {
  parseAudience, parseChannels, resolveAudience, deliver, describeDelivery,
} = require('../utils/audience');

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
  priority: 'Priority must be High, Medium or Low.',
  startDate: 'Please select a start date.',
  endBeforeStart: 'End date cannot be before start date.',
};

function csv(v) {
  return String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// People who have left are never offered work (the same list LMS and the
// audience picker use).
const EXITED = ['Relieved', 'Exited', 'Exit Process'];

// A notice must never fail the request, but it must also be FINISHED before the
// answer goes back (a fire-and-forget write races the caller's next write on
// SQLite and can be dropped under load).
async function quiet(p) {
  try { await p; } catch (e) { console.error('[tasks] notify failed', e.message); }
}

// A TEAM LEAD is the HRMS role TL (a BDE TL and a recruiting TL alike). Their
// people are whoever utils/scope.js employeeWhere() gives them: their own team
// (or department when no team is set) plus the people who report to them.
const teamLeadOf = (me) => scopeOf(me).hrmsRole === 'TL';
// May this login manage (edit / re-date / cancel) the tasks of other people? (GIVING a task to anyone is open to everyone since 2026-10-24.)
async function mayManageOthers(me) {
  return teamLeadOf(me) || can(me, 'hrms', 'hrms', 'Employee Services', 'edit');
}

// ---------------------------------------------------------------------------
// HOURS AGAINST A TASK (2026-10-12) - no new table.
//
// Hours a person works on a task are kept as EmployeeRecord rows of their own
// type, so nothing else in HRMS (the generic /api/timesheet records, the
// Employee Services exports, the dashboards) ever sees or edits them:
//
//   type TASK_HOURS, category "task:<taskId>"
//     status "Logged"    one row per entry (date, hours, note) - a day can have several
//     status "Estimate"  at most one row per task - the lead's estimated hours
//
// Only the ASSIGNEE can log hours (POST /:id/hours). The assignee, and a lead
// with the person in scope, can correct or remove an entry; every one of those
// writes an audit row with the old and the new value.
// ---------------------------------------------------------------------------
const HOURS_TYPE = 'TASK_HOURS';
const catOf = (id) => `task:${id}`;
const round2 = (n) => Math.round(Number(n) * 100) / 100;

// { logged: Map taskId -> hours, estimate: Map taskId -> hours } for these tasks.
async function hoursMap(taskIds, { from, to } = {}) {
  const logged = new Map();
  const estimate = new Map();
  const ids = [...new Set(taskIds)];
  for (let i = 0; i < ids.length; i += 400) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await prisma.employeeRecord.findMany({
      where: { type: HOURS_TYPE, category: { in: ids.slice(i, i + 400).map(catOf) } },
      select: { category: true, status: true, hours: true, date: true },
    });
    rows.forEach((r) => {
      const id = String(r.category).slice(5);
      if (r.status === 'Estimate') { estimate.set(id, round2(r.hours || 0)); return; }
      if (from && (!r.date || r.date < from)) return;
      if (to && (!r.date || r.date > to)) return;
      logged.set(id, round2((logged.get(id) || 0) + (r.hours || 0)));
    });
  }
  return { logged, estimate };
}

// Set (or clear) the estimate row of a task. employeeId = the assignee's Employee.id.
async function setEstimate(task, hours, employeeId) {
  const cur = await prisma.employeeRecord.findFirst({ where: { type: HOURS_TYPE, category: catOf(task.id), status: 'Estimate' } });
  if (hours === null || hours === undefined || hours === '') {
    if (cur) await prisma.employeeRecord.delete({ where: { id: cur.id } });
    return;
  }
  if (cur) {
    await prisma.employeeRecord.update({ where: { id: cur.id }, data: { hours: Number(hours), employeeId: employeeId || cur.employeeId, title: task.name } });
  } else if (employeeId) {
    await prisma.employeeRecord.create({
      data: { type: HOURS_TYPE, employeeId, title: task.name, status: 'Estimate', category: catOf(task.id), hours: Number(hours) },
    });
  }
}

function asHours(v, label = 'Estimated hours') {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1000) throw new Error(`${label} must be a number between 0 and 1000.`);
  return round2(n);
}

// An old->new line for each thing that changed, one audit row each.
async function auditChanges(me, task, action, changes, reason) {
  for (const c of changes) {
    // eslint-disable-next-line no-await-in-loop
    await logAudit({
      userId: me.id, action, entity: 'Task', entityId: task.id,
      field: c.field, fieldLabel: c.label || c.field,
      fromValue: c.from === undefined || c.from === null ? '' : String(c.from),
      toValue: c.to === undefined || c.to === null ? '' : String(c.to),
      reason: reason || undefined,
    });
  }
}

// The office's calendar day (the server's own clock), the same one attendance
// uses - not the UTC day, which is yesterday for the first hours of an IST morning.
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// PRIORITY (2026-10-09): High / Medium / Low, Medium unless said otherwise.
const PRIORITIES = ['High', 'Medium', 'Low'];
const PRIORITY_RANK = { High: 0, Medium: 1, Low: 2 };
const priorityOf = (v) => PRIORITIES.find((p) => p.toLowerCase() === String(v || '').trim().toLowerCase()) || null;

// OVERDUE is worked out, never typed: the due date has passed and the task is
// not finished (Not Started / In Progress / On Hold). It therefore clears by
// itself when the date is moved or the task is completed, and every screen
// agrees. The daily reminder (utils/taskOverdue.js) uses the same rule.
function isOverdue(t, now = today()) {
  return !!(t && t.endDate && t.endDate < now && OPEN_STATUSES.includes(t.status));
}
function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}
// What a row carries on top of the stored task.
function decorate(t, now = today()) {
  const overdue = isOverdue(t, now);
  return {
    ...t,
    priority: t.priority || 'Medium',
    overdue,
    daysLate: overdue ? daysBetween(t.endDate, now) : 0,
    displayStatus: overdue ? 'Overdue' : t.status,
    // Completion in words, from the stamps the lifecycle already keeps.
    completion: t.status === 'Completed'
      ? (t.reviewState === 'Approved' ? 'Completed and approved' : t.reviewState === 'Pending Review' ? 'Completed, waiting for review' : 'Completed')
      : t.status === 'Cancelled' ? 'Cancelled' : t.status === 'In Progress' ? 'In progress' : t.status === 'On Hold' ? 'On hold' : 'Not started',
  };
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

  // FOUNDER RULE 2026-10-24: ANYONE can give a task to ANYONE (a recruiter to a TL, anybody to the Super Admin ...). Neither the
  // create right nor the department/team scope narrows this list any more; only exited people and the system account are left out.
  // (What the giver can then SEE of the task is still decided by visibleWhere / taskRights below: the giver always sees what they gave.)
  const and = [{ userId: { not: null } }, { employmentStatus: { notIn: EXITED } }, NOT_SYSTEM_EMPLOYEE];

  const employees = await prisma.employee.findMany({
    where: { AND: and },
    select: {
      id: true, userId: true, name: true, employeeCode: true, department: true, team: true, designation: true,
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
      employeeCode: e.employeeCode || null,
      department: e.department || null,
      team: e.team || null,
      designation: e.designation || null,
      self: e.userId === me.id,
    }));

  if (!people.some((p) => p.self)) people.unshift(self);
  return {
    canAssignOthers: true,
    people,
    reason: 'You can give a task to anyone in the company.',
  };
}

// --- Whose timesheets this user may SEE (hrms-24 §8) -----------------------
//
// SEEING is not ASSIGNING. assignable() above asks the create permission,
// which a Manager / Assistant Manager does not hold (view-only, §3/§4) — so
// the list used to shrink them to their own tasks, the opposite of "Manager /
// AM: their permitted departments". The READ set is the HRMS data scope
// itself (utils/scope.js employeeWhere), exactly as every other HRMS list:
//
//   Super Admin / Admin / HR   every employee (HR: HRMS-wide)
//   Manager / AM / STL         their departments
//   TL                         their team (or department) + direct reports
//   Employee                   themselves only — no picker at all
//
// A login with an explicit team scope is held to it, as assignable() does.
async function viewable(me) {
  const self = {
    userId: me.id, employeeId: me.employeeId, name: me.name, employeeCode: null,
    department: me.department || null, designation: me.designation || null, active: true, self: true,
  };
  if (me.caps && me.caps.hrmsSelfOnly) return { selfOnly: true, global: false, people: [self] };
  const s = scopeOf(me);
  const and = [employeeWhere(me), { userId: { not: null } }];
  const explicitTeams = csv(me.atsScopeTeams);
  if (!s.global && explicitTeams.length) {
    and.push({ OR: [{ team: { in: explicitTeams } }, { id: me.employeeId || '__none__' }] });
  }
  const employees = await prisma.employee.findMany({
    where: { AND: and },
    select: {
      id: true, userId: true, name: true, employeeCode: true, department: true, designation: true,
      employmentStatus: true, user: { select: { status: true } },
    },
    orderBy: { name: 'asc' },
  });
  const people = employees.map((e) => ({
    userId: e.userId,
    employeeId: e.id,
    name: e.name,
    employeeCode: e.employeeCode,
    department: e.department || null,
    designation: e.designation || null,
    active: (e.user?.status || 'Active') === 'Active',
    self: e.userId === me.id,
  }));
  if (!people.some((p) => p.self)) people.unshift(self);
  // HR is HRMS-wide (utils/scope.js hrmsGlobal), so it reads every department.
  return { selfOnly: false, global: !!s.global || hrmsGlobal(me), people };
}

// The tasks this user may READ: their own, the ones they handed out, and — for
// anyone with an HRMS scope — everyone viewable() returns.
async function visibleWhere(me, view) {
  const { selfOnly, global, people } = view || await viewable(me);
  if (selfOnly) {
    return { OR: [{ assigneeId: me.id }, { assignedById: me.id }] };
  }
  if (global) return {};
  const ids = people.map((p) => p.userId);
  return { OR: [{ assigneeId: { in: ids } }, { assignedById: me.id }] };
}

// WHAT THIS LOGIN MAY DO WITH ONE TASK (2026-10-12).
//
//   assignee  the task is FOR them: start it, log hours, add a note, mark it
//             done, change its status between Not Started / In Progress / On
//             Hold. They can NOT rename it, change its dates, priority or
//             estimate, move it to somebody else or cancel it.
//   manage    whoever GAVE the task, or a lead (hrms / Employee Services /
//             edit) with the assignee inside their scope: all of the above on
//             the assignee's behalf, plus edit, move the due date, hand it to
//             someone else, cancel it, send it back, correct hours (audited).
//
// The browser mirrors these flags (rowRights) only to show or hide buttons;
// every route below asks again.
async function taskRights(me, task) {
  const assignee = task.assigneeId === me.id;
  let manage = task.assignedById === me.id;
  if (!manage && await mayManageOthers(me)) {
    const v = await viewable(me);
    // A lead's scope includes themselves, but a task somebody ELSE gave them is not theirs to rewrite.
    manage = !v.selfOnly && task.assigneeId !== me.id && v.people.some((p) => p.userId === task.assigneeId);
  }
  return { assignee, manage };
}
// Same answer for a whole list, with the lead check and the scope read once.
async function rightsFor(me, view) {
  const leadEdit = await mayManageOthers(me);
  const v = leadEdit ? (view || await viewable(me)) : null;
  const scope = v && !v.selfOnly ? new Set(v.people.map((p) => p.userId)) : new Set();
  return (t) => ({
    assignee: t.assigneeId === me.id,
    manage: t.assignedById === me.id || (t.assigneeId !== me.id && scope.has(t.assigneeId)),
  });
}
// Kept for the callers that only need "may this person change the task at all".
async function mayEdit(me, task) {
  const r = await taskRights(me, task);
  return r.assignee || r.manage;
}

async function reachable(me, id) {
  const task = await prisma.task.findUnique({ where: { id } });
  if (!task) return { status: 404, error: { error: 'Task not found' } };
  if (task.assigneeId === me.id || task.assignedById === me.id) return { task };
  const s = scopeOf(me);
  if (s.global) return { task };
  // READ reach follows the view scope (a Manager may open, not change, a task
  // in their departments); taskRights() still decides changes.
  const { people } = await viewable(me);
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
      prisma.department.findMany({ where: require('../utils/masters').activeOnly('Department'), select: { name: true }, orderBy: { name: 'asc' } }),
      can(me, 'hrms', 'hrms', 'Employee Services', 'approve'),
    ]);
    // The department picker offers what this login can actually work in: every
    // department for a global role, their own scope otherwise.
    const all = departmentRows.map((d) => d.name);
    const departments = s.global
      ? all
      : [...new Set([...s.departments, ...people.map((p) => p.department).filter(Boolean)])].sort();

    // THE EMPLOYEE PICKER (hrms-24 §8): the departments this login may look
    // into, and whether it gets a picker at all — an Employee sees only their
    // own timesheet and gets none. The people come from /tasks/people.
    const view = await viewable(me);
    // How busy each person is right now (open tasks), so a lead can give the
    // next task to the least busy one.
    const busy = people.length ? await prisma.task.groupBy({
      by: ['assigneeId'], where: { assigneeId: { in: people.map((p) => p.userId) }, status: { in: OPEN_STATUSES } }, _count: { _all: true },
    }) : [];
    const openOf = Object.fromEntries(busy.map((b) => [b.assigneeId, b._count._all]));
    const viewDepartments = view.selfOnly
      ? []
      : (view.global ? all : [...new Set(view.people.map((p) => p.department).filter(Boolean))].sort());
    res.json({
      departments,
      viewDepartments,
      canPickEmployee: !view.selfOnly,
      statuses: TASK_STATUSES,
      priorities: PRIORITIES,
      reviewStates: REVIEW_STATES,
      assignable: people.map((p) => ({ ...p, open: openOf[p.userId] || 0 })),
      canAssignOthers,
      canGive: canAssignOthers,
      // May this login take the whole team's tasks out as a file?
      canExport: await can(me, 'hrms', 'hrms', 'Employee Services', 'export'),
      // Signing work off is its own right, not a side-effect of being able to
      // finish it. The Review button is hidden without it and the API refuses
      // it anyway.
      canReview,
      scopeNote: reason,
      me: { id: me.id, name: me.name, department: me.department || null, employeeId: me.employeeId || null },
      today: today(),
    });
  } catch (err) { next(err); }
});

// --- Employee picker (hrms-24 §8) --------------------------------------------
// GET /tasks/people?department=Medical — the people in THIS login's scope, in
// that department. A department outside the scope is refused, not answered
// with an empty list, so the picker cannot be used to probe other departments.
router.get('/people', VIEW, async (req, res, next) => {
  try {
    const view = await viewable(req.user);
    if (view.selfOnly) return res.json({ selfOnly: true, people: view.people });
    const dept = String(req.query.department || '').trim();
    if (dept && !view.global && !view.people.some((p) => p.department === dept)) {
      return res.status(403).json(OUT_OF_SCOPE);
    }
    const people = dept ? view.people.filter((p) => p.department === dept) : view.people;
    return res.json({ selfOnly: false, department: dept || null, people });
  } catch (err) { return next(err); }
});

// --- List -------------------------------------------------------------------
router.get('/', VIEW, async (req, res, next) => {
  try {
    const view = await viewable(req.user);
    const where = await visibleWhere(req.user, view);
    const and = [];
    // THE PICKER'S TWO HALVES ARE CHECKED HERE TOO. An employee id or a
    // department outside this login's scope is refused (403) rather than
    // quietly returning nothing — the browser only offers in-scope choices,
    // and this is what holds when a URL is edited by hand.
    if (req.query.assigneeId || req.query.department) {
      const aid = req.query.assigneeId ? String(req.query.assigneeId) : '';
      if (aid && aid !== req.user.id && (view.selfOnly || (!view.global && !view.people.some((p) => p.userId === aid)))) {
        return res.status(403).json(OUT_OF_SCOPE);
      }
      if (req.query.department) {
        const dept = String(req.query.department);
        // The department is the TASK's department or the ASSIGNEE's — pick
        // Medical and every Medical employee's timesheet is in the list.
        let members;
        if (view.global) {
          members = (await prisma.employee.findMany({ where: { department: dept, userId: { not: null } }, select: { userId: true } })).map((m) => m.userId);
        } else {
          members = view.people.filter((p) => p.department === dept).map((p) => p.userId);
          // A lead naming a department nobody in their scope works in.
          if (!view.selfOnly && !members.length) return res.status(403).json(OUT_OF_SCOPE);
        }
        and.push({ OR: [{ department: dept }, { assigneeId: { in: members } }] });
      }
    }
    if (req.query.status === 'Overdue' || req.query.overdue === '1') and.push({ status: { in: OPEN_STATUSES }, endDate: { lt: today() } });
    else if (req.query.status) and.push({ status: req.query.status });
    if (req.query.priority) { const p = priorityOf(req.query.priority); if (p) and.push({ priority: p }); }
    // Due date = the task's End Date.
    if (req.query.dueFrom) and.push({ endDate: { gte: String(req.query.dueFrom) } });
    if (req.query.dueTo) and.push({ endDate: { lte: String(req.query.dueTo) } });
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
      take: 5000,
      include: { addOns: { orderBy: { createdAt: 'asc' } } },
    });
    const hrs = await hoursMap(tasks.map((t) => t.id));
    const rightsOf = await rightsFor(req.user, view);
    const counts = await prisma.taskComment.groupBy({
      by: ['taskId'],
      where: { taskId: { in: tasks.map((t) => t.id) } },
      _count: { _all: true },
    });
    const commentCount = Object.fromEntries(counts.map((c) => [c.taskId, c._count._all]));
    // The assignee's employee ID and designation, so the list can be filtered
    // by the person. Read-only, and only for the tasks already let through.
    const assignees = await prisma.employee.findMany({
      where: { userId: { in: [...new Set(tasks.map((t) => t.assigneeId))] } },
      select: { userId: true, employeeCode: true, name: true, department: true, team: true, designation: true, employmentStatus: true },
    });
    const assigneeOf = Object.fromEntries(assignees.map((e) => [e.userId, e]));
    const now = today();
    res.json(tasks.map((t) => ({
      ...decorate(t, now),
      commentCount: commentCount[t.id] || 0,
      assignee: assigneeOf[t.assigneeId] || null,
      hoursLogged: hrs.logged.get(t.id) || 0,
      estimatedHours: hrs.estimate.has(t.id) ? hrs.estimate.get(t.id) : null,
      cancelReason: t.status === 'Cancelled' ? (t.reviewNote || null) : null,
      rights: rightsOf(t),
    })));
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
    // DATE FILTER (founder 2026-10-26): a task counts when its window overlaps From - To (the same rule as the list and the export)
    const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
    const from = day(req.query.from); const to = day(req.query.to);
    if (from && to && to < from) return res.status(400).json({ error: 'The To date is before the From date.' });
    const and = [];
    if (from) and.push({ OR: [{ endDate: { gte: from } }, { endDate: null }] });
    if (to) and.push({ OR: [{ startDate: { lte: to } }, { startDate: null }] });
    const tasks = await prisma.task.findMany({ where: and.length ? { AND: [where, ...and] } : where });
    const now = today();
    const hrs = await hoursMap(tasks.map((t) => t.id), from || to ? { from, to } : undefined);

    const byStatus = TASK_STATUSES.map((status) => ({
      status, count: tasks.filter((t) => t.status === status).length,
    })).filter((r) => r.count > 0);

    // The review leg, counted the same way: states with nothing in them are
    // left out rather than shown as a zero.
    const byReview = REVIEW_STATES.map((state) => ({
      state, count: tasks.filter((t) => (t.reviewState || 'Not Submitted') === state).length,
    })).filter((r) => r.count > 0);

    const byPriority = PRIORITIES.map((priority) => ({
      priority,
      total: tasks.filter((t) => (t.priority || 'Medium') === priority).length,
      open: tasks.filter((t) => (t.priority || 'Medium') === priority && OPEN_STATUSES.includes(t.status)).length,
      overdue: tasks.filter((t) => (t.priority || 'Medium') === priority && isOverdue(t, now)).length,
    })).filter((r) => r.total > 0);
    const byPerson = [];
    tasks.forEach((t) => {
      let row = byPerson.find((r) => r.userId === t.assigneeId);
      if (!row) {
        row = {
          userId: t.assigneeId, name: t.assigneeName,
          total: 0, open: 0, completed: 0, overdue: 0, awaitingReview: 0, approved: 0, hoursLogged: 0, estimatedHours: 0,
        };
        byPerson.push(row);
      }
      row.total += 1;
      row.hoursLogged = round2(row.hoursLogged + (hrs.logged.get(t.id) || 0));
      row.estimatedHours = round2(row.estimatedHours + (hrs.estimate.get(t.id) || 0));
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
      range: { from, to },
      total: tasks.length,
      byStatus,
      byPriority,
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
        'Hours spent counts only what people typed against a task (Add hours). Time at work is on the Timesheet charts above.',
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
//
// 2026-10-12: the plain "New task" form sends no department or status - the
// department is the assignee's and the status is Not Started. Both can still
// be sent (the AI assistant does).
// ---------------------------------------------------------------------------
async function createTask(me, input = {}, opts = {}) {
  const {
    department, name, description, subTaskName,
    startDate, endDate, dependent, dependsOnId,
  } = input;
  const status = input.status === undefined || input.status === null || input.status === '' ? 'Not Started' : input.status;
  const priority = input.priority === undefined || input.priority === null || input.priority === '' ? 'Medium' : priorityOf(input.priority);

  // THE SAME RULES THE MODAL CHECKS, enforced here because the modal is
  // a courtesy and this is the gate. `field` names the box so the browser can
  // put the message back under it when the API is what caught the problem.
  const bad = (field, error) => ({ status: 400, body: { field, error } });
  if (!name || !String(name).trim()) return bad('name', MSG.name);
  if (!TASK_STATUSES.includes(status)) return bad('status', MSG.status);
  if (status === 'Cancelled') return bad('status', 'A new task cannot start as cancelled.');
  if (!priority) return bad('priority', MSG.priority);

  let start;
  let end;
  let estimate = null;
  try {
    start = asDate(startDate, 'Task start date');
  } catch (err) { return bad('startDate', err.message); }
  try {
    end = asDate(endDate, 'Task end date');
  } catch (err) { return bad('endDate', err.message); }
  try {
    estimate = asHours(input.estimatedHours);
  } catch (err) { return bad('estimatedHours', err.message); }
  if (!start) return bad('startDate', MSG.startDate);
  if (end && end < start) return bad('endDate', MSG.endBeforeStart);

  // Assign To — blank means "myself", exactly as the field says.
  // opts.target is the ONE way past the scope check: the R&D feedback route below has already picked an active R&D person itself
  // (the giver is not allowed to hand work to R&D in general, only to send it feedback), so the target is not looked up in assignable().
  let target = opts.target || null;
  if (!target) {
    const wanted = input.assigneeId || me.id;
    const { canAssignOthers, people } = await assignable(me);
    if (wanted !== me.id && !canAssignOthers) return { status: 403, body: DENIED };
    target = people.find((p) => p.userId === wanted);
    if (!target) return { status: 403, body: OUT_OF_SCOPE };
  }

  const dept = String(department || '').trim() || target.department || me.department || '';
  if (!dept) return bad('department', MSG.department);

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
      department: dept,
      description: description ? String(description) : null,
      subTaskName: subTaskName ? String(subTaskName).trim() : null,
      status,
      priority,
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
  if (estimate !== null) await setEstimate(task, estimate, target.employeeId);
  await logAudit({
    userId: me.id, action: 'Task created', entity: 'Task', entityId: task.id,
    toValue: `${task.name} → ${task.assigneeName}`,
    reason: target.userId === me.id ? 'For themselves' : `Given to ${task.assigneeName}${target.department ? ` (${target.department})` : ''}`,
  });
  return { status: 201, body: { ...task, estimatedHours: estimate } };
}

router.post('/', VIEW, async (req, res, next) => {
  try {
    // THE PLAIN "NEW TASK" FORM (2026-10-12): pick one or MANY people from "My
    // team". ONE TASK IS CREATED FOR EACH PERSON (each has their own status,
    // hours and done button), all with the same name, notes, dates and
    // priority. Every person must be inside the assigner's scope or the whole
    // request is refused (403) before anything is written.
    if (Array.isArray(req.body.assigneeIds)) {
      const ids = [...new Set(req.body.assigneeIds.map((v) => String(v)).filter(Boolean))];
      if (!ids.length) return res.status(400).json({ field: 'assigneeId', error: 'Pick at least one person.' });
      if (ids.length > 100) return res.status(400).json({ field: 'assigneeId', error: 'Pick at most 100 people at a time.' });
      const { canAssignOthers, people } = await assignable(req.user);
      if (ids.some((id) => id !== req.user.id) && !canAssignOthers) return res.status(403).json(DENIED);
      const outside = ids.filter((id) => !people.some((p) => p.userId === id));
      if (outside.length) {
        return res.status(403).json({ error: `${OUT_OF_SCOPE.error}: ${outside.length} of the people you picked ${outside.length === 1 ? 'is' : 'are'} not in your team.` });
      }
      const created = [];
      for (const id of ids) {
        // eslint-disable-next-line no-await-in-loop
        const out = await createTask(req.user, { ...req.body, assigneeId: id });
        if (out.status !== 201) {
          // Nothing was written for this person; tell the caller how far it got.
          return res.status(out.status).json({ ...out.body, created: created.length, ids: created.map((t) => t.id) });
        }
        created.push(out.body);
        // eslint-disable-next-line no-await-in-loop
        await quiet(hrmsNotify.taskAssigned(out.body, req.user));
      }
      return res.status(201).json({
        created: created.length,
        ids: created.map((t) => t.id),
        name: created[0].name,
        assigneeName: created.map((t) => t.assigneeName).join(', '),
        tasks: created,
      });
    }
    // AUDIENCE (utils/audience.js): assign the same task to one or MANY
    // departments or one or MANY people at once. It resolves inside the
    // caller's scope (403 for anything outside it), then keeps only the people
    // assignable() offers — a task goes to a LOGIN, so someone with no account
    // is reported as skipped, never silently given a task nobody can open —
    // and runs createTask() once per person, so each copy passes exactly the
    // same validation and audit as a single create.
    const aud = parseAudience(req.body);
    if (aud) {
      const { canAssignOthers, people } = await assignable(req.user);
      if (!canAssignOthers) return res.status(403).json(DENIED);
      const out = await resolveAudience(req.user, aud);
      if (!out.ok) return res.status(out.status).json({ error: out.error });
      const byEmployee = new Map(people.map((p) => [p.employeeId, p]));
      const targets = out.employees.map((e) => byEmployee.get(e.id)).filter(Boolean);
      const skipped = out.employees.filter((e) => !byEmployee.has(e.id)).map((e) => e.name);
      if (!targets.length) return res.status(400).json({ error: 'None of the selected people has a login to receive a task.' });
      // Validate once before writing anything, so a bad field is one 400, not
      // a half-created batch.
      const first = await createTask(req.user, { ...req.body, assigneeId: targets[0].userId });
      if (first.status !== 201) return res.status(first.status).json(first.body);
      const created = [first.body];
      for (const t of targets.slice(1)) {
        // eslint-disable-next-line no-await-in-loop
        const o = await createTask(req.user, { ...req.body, assigneeId: t.userId });
        if (o.status === 201) created.push(o.body);
      }
      const delivery = await deliver({
        employees: out.employees.filter((e) => byEmployee.has(e.id)),
        channels: parseChannels(req.body.channels),
        title: `New task: ${String(req.body.name || '').trim()}`,
        message: req.body.description || null,
        by: req.user,
        exceptUserId: req.user.id,
      });
      return res.status(201).json({
        created: created.length, label: out.label, skipped, ids: created.map((t) => t.id),
        name: first.body.name, assigneeName: out.label, delivery, deliveryText: describeDelivery(delivery),
      });
    }
    const out = await createTask(req.user, req.body);
    // HRMS item 14: tell the assignee (in-app; email in their daily email).
    // The many-people path above already delivers its own notice.
    if (out.status === 201) await quiet(hrmsNotify.taskAssigned(out.body, req.user));
    return res.status(out.status).json(out.body);
  } catch (err) { return next(err); }
});

// --- FEEDBACK TO THE R&D TEAM (founder, 2026-10-24) -------------------------
// "Any department that wants to give feedback should be able to assign a task to the R&D team." Everybody who reaches the Timesheet may
// send feedback — an employee, a recruiter, a TL, HR, Accounts — even though their role assigns work to themselves only. It creates an
// ordinary task for ONE active R&D person, with the giver as "given by", so the R&D person sees it in their Timesheet, the giver follows
// it (status, comments) in theirs, and the R&D TL sees it through their normal team scope. Nothing else about R&D's data is opened up:
// the giver is offered R&D names and how busy they are, and nothing more.
const FEEDBACK_DEPARTMENT = 'R&D';
const FEEDBACK_TAG = 'Feedback to R&D';

async function rdTeam() {
  const rows = await prisma.employee.findMany({
    where: {
      AND: [
        { department: FEEDBACK_DEPARTMENT }, { userId: { not: null } }, { employmentStatus: { notIn: EXITED } }, NOT_SYSTEM_EMPLOYEE,
      ],
    },
    select: { id: true, userId: true, name: true, employeeCode: true, department: true, team: true, designation: true, user: { select: { status: true } } },
    orderBy: { name: 'asc' },
  });
  const people = rows.filter((e) => (e.user?.status || 'Active') === 'Active');
  const busy = people.length ? await prisma.task.groupBy({
    by: ['assigneeId'], where: { assigneeId: { in: people.map((p) => p.userId) }, status: { in: OPEN_STATUSES } }, _count: { _all: true },
  }) : [];
  const openOf = Object.fromEntries(busy.map((b) => [b.assigneeId, b._count._all]));
  return people.map((e) => ({
    userId: e.userId, employeeId: e.id, name: e.name, employeeCode: e.employeeCode || null, department: e.department,
    team: e.team || null, designation: e.designation || null, self: false, open: openOf[e.userId] || 0,
  }));
}

router.get('/feedback/options', VIEW, async (req, res, next) => {
  try {
    const team = await rdTeam();
    res.json({
      department: FEEDBACK_DEPARTMENT,
      people: team.map((p) => ({ userId: p.userId, name: p.name, designation: p.designation, open: p.open })),
      priorities: PRIORITIES,
      today: today(),
      available: team.length > 0,
    });
  } catch (err) { next(err); }
});

router.post('/feedback', VIEW, async (req, res, next) => {
  try {
    const b = req.body || {};
    const subject = String(b.subject || b.name || '').trim();
    const details = String(b.details || b.description || '').trim();
    if (!subject) return res.status(400).json({ field: 'subject', error: 'Say in a few words what the feedback is about.' });
    if (!details) return res.status(400).json({ field: 'details', error: 'Write the feedback for the R&D team.' });
    const team = await rdTeam();
    if (!team.length) return res.status(409).json({ error: 'The R&D team has nobody with a login yet, so the feedback cannot be given to anyone. Tell the Super Admin.' });
    // A named R&D person, or — when "anyone" — whoever has the fewest open tasks (the same "least busy" rule a TL uses).
    let target = null;
    if (b.assigneeId) {
      target = team.find((p) => p.userId === String(b.assigneeId));
      if (!target) return res.status(400).json({ field: 'assigneeId', error: 'That person is not on the R&D team.' });
    } else {
      target = [...team].sort((x, y) => x.open - y.open || x.name.localeCompare(y.name))[0];
    }
    const from = [req.user.name, req.user.department].filter(Boolean).join(' · ');
    const out = await createTask(req.user, {
      name: `Feedback: ${subject}`.slice(0, 200),
      department: FEEDBACK_DEPARTMENT,
      description: `Feedback from ${from || 'a colleague'}\n\n${details}`,
      subTaskName: FEEDBACK_TAG,
      startDate: today(),
      endDate: b.endDate || null,
      priority: b.priority || 'Medium',
      status: 'Not Started',
    }, { target });
    if (out.status === 201) {
      await quiet(hrmsNotify.taskAssigned(out.body, req.user));
      await logAudit({ userId: req.user.id, action: 'Feedback sent to R&D', entity: 'Task', entityId: out.body.id, toValue: `${subject} → ${target.name}` });
    }
    return res.status(out.status).json(out.status === 201 ? { ...out.body, givenTo: target.name } : out.body);
  } catch (err) { return next(err); }
});

// --- Edit -------------------------------------------------------------------
//
// Whoever GAVE the task (or a lead with the person in scope) may change any of
// it. The person it is FOR may only move it between Not Started / In Progress /
// On Hold; the rest (name, notes, dates, priority, estimate, who it is for) is
// the giver's. Every changed field writes an audit row: old -> new.
const fmtDay = (v) => (v ? `${v.slice(8, 10)}-${v.slice(5, 7)}-${v.slice(0, 4)}` : 'no date');

async function applyManage(me, t, b, reason) {
  const data = {};
  const changes = [];
  const bad = (field, error) => ({ status: 400, body: { field, error } });
  const track = (field, label, from, to) => changes.push({ field, label, from, to });

  if (b.name !== undefined) {
    const v = String(b.name).trim();
    if (!v) return bad('name', MSG.name);
    if (v !== t.name) { data.name = v; track('name', 'Task name', t.name, v); }
  }
  if (b.department !== undefined) {
    const v = String(b.department).trim();
    if (!v) return bad('department', MSG.department);
    if (v !== (t.department || '')) { data.department = v; track('department', 'Department', t.department, v); }
  }
  if (b.description !== undefined) {
    const v = b.description ? String(b.description) : null;
    if ((v || '') !== (t.description || '')) { data.description = v; track('description', 'Notes', t.description, v); }
  }
  if (b.subTaskName !== undefined) {
    const v = b.subTaskName ? String(b.subTaskName).trim() : null;
    if ((v || '') !== (t.subTaskName || '')) { data.subTaskName = v; track('subTaskName', 'Project or job', t.subTaskName, v); }
  }
  if (b.priority !== undefined) {
    const p = priorityOf(b.priority);
    if (!p) return bad('priority', MSG.priority);
    if (p !== (t.priority || 'Medium')) { data.priority = p; track('priority', 'Priority', t.priority || 'Medium', p); }
  }
  let startDate = t.startDate;
  let endDate = t.endDate;
  try {
    if (b.startDate !== undefined) {
      const v = asDate(b.startDate, 'Task start date');
      if (!v) return bad('startDate', MSG.startDate);
      startDate = v;
      if (v !== t.startDate) { data.startDate = v; track('startDate', 'Start date', t.startDate, v); }
    }
  } catch (err) { return bad('startDate', err.message); }
  try {
    if (b.endDate !== undefined) {
      const v = asDate(b.endDate, 'Task end date');
      endDate = v;
      if ((v || '') !== (t.endDate || '')) { data.endDate = v; data.overdueRemindedOn = null; track('endDate', 'Due date', t.endDate, v); }
    }
  } catch (err) { return bad('endDate', err.message); }
  if (startDate && endDate && endDate < startDate) return bad('endDate', MSG.endBeforeStart);

  // Driving the status by hand keeps the lifecycle stamps honest, so a task
  // completed from here is reviewable exactly like one completed from Done.
  if (b.status !== undefined && b.status !== t.status) {
    if (!TASK_STATUSES.includes(b.status)) return bad('status', MSG.status);
    if (b.status === 'Cancelled') return bad('status', 'Use "Cancel task" - it asks why.');
    data.status = b.status;
    track('status', 'Status', t.status, b.status);
    if (b.status === 'In Progress' && !t.startedAt) data.startedAt = new Date();
    if (b.status === 'Completed') {
      if (!t.completedAt) data.completedAt = new Date();
      if (t.reviewState !== 'Approved') data.reviewState = 'Pending Review';
    } else if (t.status === 'Completed') {
      data.completedAt = null;
      // Opened again: neither a waiting check nor an old approval still applies.
      data.reviewState = 'Not Submitted';
    }
    // Reopened after a cancel: the reason no longer applies.
    if (t.status === 'Cancelled') { data.reviewNote = null; data.reviewedByName = null; data.reviewedAt = null; data.reviewedById = null; data.cancelledAt = null; data.cancelledByName = null; }
  }

  if (b.dependent !== undefined) data.dependent = !!b.dependent;
  if (b.dependsOnId !== undefined) {
    if (!b.dependsOnId) data.dependsOnId = null;
    else {
      if (String(b.dependsOnId) === t.id) return { status: 400, body: { error: 'A task cannot depend on itself.' } };
      const dep = await reachable(me, String(b.dependsOnId));
      if (dep.error) return { status: 400, body: { error: 'That dependent task is not one you can reach.' } };
      data.dependsOnId = dep.task.id;
    }
  }

  // Estimated hours (kept beside the hours, see HOURS_TYPE).
  let newEstimate;
  if (b.estimatedHours !== undefined) {
    try { newEstimate = asHours(b.estimatedHours); } catch (err) { return bad('estimatedHours', err.message); }
    const cur = (await hoursMap([t.id])).estimate.get(t.id);
    const curEstimate = cur === undefined ? null : cur;
    if (newEstimate !== curEstimate) track('estimatedHours', 'Estimated hours', curEstimate, newEstimate);
    else newEstimate = undefined;
  }

  // RE-ASSIGNING runs the same two checks a new task does.
  let target = null;
  if (b.assigneeId !== undefined && b.assigneeId !== t.assigneeId) {
    if (['Completed', 'Cancelled'].includes(t.status)) {
      return { status: 400, body: { error: 'A finished or cancelled task cannot be given to someone else. Reopen it first.' } };
    }
    const { canAssignOthers, people } = await assignable(me);
    if (b.assigneeId !== me.id && !canAssignOthers) return { status: 403, body: DENIED };
    target = people.find((p) => p.userId === b.assigneeId);
    if (!target) return { status: 403, body: OUT_OF_SCOPE };
    data.assigneeId = target.userId;
    data.assigneeName = target.name;
    data.overdueRemindedOn = null;
    track('assignee', 'Given to', t.assigneeName, target.name);
    // The new person has not started it.
    if (!data.status && ['In Progress', 'On Hold'].includes(t.status)) { data.status = 'Not Started'; data.startedAt = null; track('status', 'Status', t.status, 'Not Started'); }
  }

  if (!changes.length && !Object.keys(data).length) return { status: 200, body: { ...t, unchanged: true } };

  const task = Object.keys(data).length ? await prisma.task.update({ where: { id: t.id }, data }) : t;
  if (target) {
    // The estimate follows the task to its new person; hours already logged stay with whoever worked them.
    await prisma.employeeRecord.updateMany({ where: { type: HOURS_TYPE, category: catOf(t.id), status: 'Estimate' }, data: { employeeId: target.employeeId } });
  }
  if (newEstimate !== undefined) {
    const empId = target ? target.employeeId : (await prisma.employee.findFirst({ where: { userId: task.assigneeId }, select: { id: true } }))?.id;
    await setEstimate(task, newEstimate, empId);
  }
  await auditChanges(me, task, target ? 'Task given to someone else' : 'Task updated', changes, reason);

  // Plain lines in the task's own thread.
  const why = reason ? ` - ${reason}` : '';
  if (target) await noteOnTask(task, me, `${me.name} gave this task to ${target.name} (it was with ${t.assigneeName}).${why}`);
  if (data.endDate !== undefined) await noteOnTask(task, me, `${me.name} moved the due date from ${fmtDay(t.endDate)} to ${fmtDay(task.endDate)}.${why}`);
  const detailChanges = changes.filter((c) => !['assignee', 'endDate', 'status'].includes(c.field));
  if (detailChanges.length) await noteOnTask(task, me, `${me.name} changed: ${detailChanges.map((c) => c.label).join(', ')}.${why}`);

  // Tell the people it touches (bell + their daily email, never the person who did it).
  const tell = quiet;
  if (target) {
    await tell(hrmsNotify.taskChanged(t, me, 'Task moved to someone else', `${me.name} gave "${t.name}" to ${target.name}. You do not need to do it any more.`, t.assigneeId));
    await tell(hrmsNotify.taskAssigned(task, me));
  } else if (data.endDate !== undefined) {
    await tell(hrmsNotify.taskChanged(task, me, 'Due date changed', `${me.name} moved the due date of "${task.name}" from ${fmtDay(t.endDate)} to ${fmtDay(task.endDate)}.${why}`));
  } else if (detailChanges.length) {
    await tell(hrmsNotify.taskChanged(task, me, 'Task details changed', `${me.name} changed "${task.name}": ${detailChanges.map((c) => c.label).join(', ')}.${why}`));
  }
  return { status: 200, body: task };
}

router.put('/:id', VIEW, async (req, res, next) => {
  try {
    const me = req.user;
    const found = await reachable(me, req.params.id);
    if (found.error) return res.status(found.status).json(found.error);
    const t = found.task;
    const rights = await taskRights(me, t);
    if (!rights.assignee && !rights.manage) return res.status(403).json(DENIED);
    const b = req.body || {};

    if (!rights.manage) {
      // The person it is FOR: progress only.
      const extra = Object.keys(b).filter((k) => b[k] !== undefined && k !== 'status');
      if (extra.length) {
        return res.status(403).json({ error: `Only ${t.assignedByName || 'the person who gave this task'} can change the task details. You can start it, add your hours, write a note or mark it done.` });
      }
      if (!['Not Started', 'In Progress', 'On Hold'].includes(b.status)) {
        return res.status(400).json({ field: 'status', error: 'Choose Not Started, In Progress or On Hold. Use "Done" to finish the task.' });
      }
      if (['Completed', 'Cancelled'].includes(t.status)) {
        return res.status(400).json({ error: `This task is ${t.status === 'Completed' ? 'already done' : 'cancelled'}. Ask ${t.assignedByName || 'the person who gave it'} to reopen it.` });
      }
      if (b.status === t.status) return res.json(t);
      const data = { status: b.status };
      if (b.status === 'In Progress' && !t.startedAt) data.startedAt = new Date();
      const task = await prisma.task.update({ where: { id: t.id }, data });
      await auditChanges(me, task, 'Task progress', [{ field: 'status', label: 'Status', from: t.status, to: b.status }]);
      return res.json(task);
    }

    const out = await applyManage(me, t, b, String(b.reason || '').trim() || undefined);
    return res.status(out.status).json(out.body);
  } catch (err) { return next(err); }
});

// Move the due date (a lead's quick button).
router.post('/:id/extend', VIEW, async (req, res, next) => {
  try {
    const me = req.user;
    const found = await reachable(me, req.params.id);
    if (found.error) return res.status(found.status).json(found.error);
    const t = found.task;
    if (!(await taskRights(me, t)).manage) return res.status(403).json(DENIED);
    if (['Completed', 'Cancelled'].includes(t.status)) return res.status(400).json({ error: 'A finished or cancelled task has no due date to move.' });
    if (!req.body.endDate) return res.status(400).json({ field: 'endDate', error: 'Pick the new due date.' });
    const out = await applyManage(me, t, { endDate: req.body.endDate }, String(req.body.reason || '').trim() || undefined);
    return res.status(out.status).json(out.body);
  } catch (err) { return next(err); }
});

// Give the task to someone else (still inside the giver's team).
router.post('/:id/reassign', VIEW, async (req, res, next) => {
  try {
    const me = req.user;
    const found = await reachable(me, req.params.id);
    if (found.error) return res.status(found.status).json(found.error);
    const t = found.task;
    if (!(await taskRights(me, t)).manage) return res.status(403).json(DENIED);
    if (!req.body.assigneeId) return res.status(400).json({ field: 'assigneeId', error: 'Pick who should do it now.' });
    if (req.body.assigneeId === t.assigneeId) return res.status(400).json({ field: 'assigneeId', error: `${t.assigneeName} already has this task.` });
    const out = await applyManage(me, t, { assigneeId: req.body.assigneeId }, String(req.body.note || req.body.reason || '').trim() || undefined);
    return res.status(out.status).json(out.body);
  } catch (err) { return next(err); }
});

// --- ADD-ONS (founder 2026-10-26: "task change anedhi kakunda add-ons undali") ----------------------------
// Extra work added ONTO a task instead of rewriting it: the giver / lead adds a line (with an optional due day), the person ticks it
// when done. The original task stays as it was given; every add-on is written down on the task's notes.
router.post('/:id/addons', VIEW, async (req, res, next) => {
  try {
    const me = req.user;
    const found = await reachable(me, req.params.id);
    if (found.error) return res.status(found.status).json(found.error);
    const t = found.task;
    if (!(await taskRights(me, t)).manage) return res.status(403).json(DENIED);
    if (!OPEN_STATUSES.includes(t.status)) return res.status(400).json({ error: `This task is ${t.status.toLowerCase()}. Open it again before adding more work to it.` });
    const text = String((req.body && req.body.text) || '').trim();
    if (text.length < 3) return res.status(400).json({ field: 'text', error: 'Write what more has to be done.' });
    if (text.length > 1000) return res.status(400).json({ field: 'text', error: 'Keep it under 1000 characters.' });
    const dueDate = req.body.dueDate ? String(req.body.dueDate).slice(0, 10) : null;
    if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return res.status(400).json({ field: 'dueDate', error: 'Pick the due day as a date.' });
    const addOn = await prisma.taskAddOn.create({ data: { taskId: t.id, text, dueDate, addedById: me.id, addedByName: me.name } });
    await noteOnTask(t, me, `${me.name} added more work: ${text}${dueDate ? ` (by ${dueDate})` : ''}`);
    await logAudit({ userId: me.id, action: 'Task add-on added', entity: 'Task', entityId: t.id, toValue: text.slice(0, 190) });
    await quiet(hrmsNotify.taskChanged(t, me, 'More work added to your task', `${me.name} added to "${t.name}": ${text}`));
    return res.status(201).json(addOn);
  } catch (err) { return next(err); }
});
router.patch('/:id/addons/:addOnId', VIEW, async (req, res, next) => {
  try {
    const me = req.user;
    const found = await reachable(me, req.params.id);
    if (found.error) return res.status(found.status).json(found.error);
    const t = found.task;
    const r = await taskRights(me, t);
    if (!r.assignee && !r.manage) return res.status(403).json(DENIED);
    const a = await prisma.taskAddOn.findFirst({ where: { id: req.params.addOnId, taskId: t.id } });
    if (!a) return res.status(404).json({ error: 'That add-on is not on this task.' });
    const done = !!(req.body && req.body.done);
    const addOn = await prisma.taskAddOn.update({ where: { id: a.id }, data: done ? { done: true, doneAt: new Date(), doneByName: me.name } : { done: false, doneAt: null, doneByName: null } });
    await noteOnTask(t, me, `${me.name} marked the add-on "${a.text.slice(0, 80)}" as ${done ? 'done' : 'not done'}`);
    return res.json(addOn);
  } catch (err) { return next(err); }
});
router.delete('/:id/addons/:addOnId', VIEW, async (req, res, next) => {
  try {
    const me = req.user;
    const found = await reachable(me, req.params.id);
    if (found.error) return res.status(found.status).json(found.error);
    const t = found.task;
    if (!(await taskRights(me, t)).manage) return res.status(403).json(DENIED);
    const a = await prisma.taskAddOn.findFirst({ where: { id: req.params.addOnId, taskId: t.id } });
    if (!a) return res.status(404).json({ error: 'That add-on is not on this task.' });
    if (a.done) return res.status(400).json({ error: 'It is already done, so it stays on the task.' });
    await prisma.taskAddOn.delete({ where: { id: a.id } });
    await noteOnTask(t, me, `${me.name} removed the add-on "${a.text.slice(0, 80)}"`);
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

// Cancel (not once it is Done). A reason is required and is shown on the task.
router.post('/:id/cancel', VIEW, async (req, res, next) => {
  try {
    const me = req.user;
    const found = await reachable(me, req.params.id);
    if (found.error) return res.status(found.status).json(found.error);
    const t = found.task;
    if (!(await taskRights(me, t)).manage) return res.status(403).json(DENIED);
    if (t.status === 'Completed') return res.status(400).json({ error: 'This task is already done, so it cannot be cancelled.' });
    if (t.status === 'Cancelled') return res.status(400).json({ error: 'This task is already cancelled.' });
    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ field: 'reason', error: 'Say why you are cancelling it.' });
    const task = await prisma.task.update({
      where: { id: t.id },
      data: {
        status: 'Cancelled', completedAt: null, reviewState: 'Not Submitted',
        reviewNote: reason, reviewedById: null, reviewedByName: null, reviewedAt: null,
        cancelledAt: new Date(), cancelledByName: me.name,
      },
    });
    await noteOnTask(task, me, `${me.name} cancelled this task - ${reason}`);
    await logAudit({
      userId: me.id, action: 'Task cancelled', entity: 'Task', entityId: task.id,
      field: 'status', fieldLabel: 'Status', fromValue: t.status, toValue: 'Cancelled', reason,
    });
    await quiet(hrmsNotify.taskChanged(task, me, 'Task cancelled', `${me.name} cancelled "${task.name}" - ${reason}`));
    return res.json(task);
  } catch (err) { return next(err); }
});

// --- Hours ------------------------------------------------------------------
const DAYS_BACK = 14;
function shiftDay(iso, n) { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

// Checks one hours entry; returns { hours, date } or { status, body }.
async function checkHours({ hours, date }, { employeeId, ignoreId, backLimit = true }) {
  const bad = (field, error) => ({ status: 400, body: { field, error } });
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0) return bad('hours', 'Type the hours you worked, like 1.5.');
  if (h > 24) return bad('hours', 'A day has only 24 hours.');
  let d = today();
  try { d = asDate(date, 'The day') || today(); } catch (err) { return bad('date', err.message); }
  if (d > today()) return bad('date', 'That day has not come yet.');
  if (backLimit && d < shiftDay(today(), -DAYS_BACK)) return bad('date', `You can add hours for today and the last ${DAYS_BACK} days.`);
  const sameDay = await prisma.employeeRecord.findMany({
    where: { type: HOURS_TYPE, status: 'Logged', employeeId, date: d, ...(ignoreId ? { id: { not: ignoreId } } : {}) },
    select: { hours: true },
  });
  const already = sameDay.reduce((n, r) => n + (r.hours || 0), 0);
  if (already + h > 24) return bad('hours', `That would make ${round2(already + h)} hours on ${fmtDay(d)}. A day has only 24.`);
  return { hours: round2(h), date: d };
}

router.get('/:id/hours', VIEW, async (req, res, next) => {
  try {
    const found = await reachable(req.user, req.params.id);
    if (found.error) return res.status(found.status).json(found.error);
    const t = found.task;
    const rights = await taskRights(req.user, t);
    const rows = await prisma.employeeRecord.findMany({
      where: { type: HOURS_TYPE, category: catOf(t.id) },
      include: { employee: { select: { name: true, userId: true } } },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    });
    const entries = rows.filter((r) => r.status === 'Logged').map((r) => ({
      id: r.id, date: r.date, hours: r.hours, note: r.detail || '', byName: r.employee?.name || '',
      mine: !!req.user.employeeId && r.employeeId === req.user.employeeId,
      canEdit: (!!req.user.employeeId && r.employeeId === req.user.employeeId) || rights.manage,
    }));
    const est = rows.find((r) => r.status === 'Estimate');
    res.json({
      task: { id: t.id, name: t.name, status: t.status, assigneeName: t.assigneeName },
      entries,
      logged: round2(entries.reduce((n, e) => n + (e.hours || 0), 0)),
      estimated: est ? est.hours : null,
      canLog: t.assigneeId === req.user.id && t.status !== 'Cancelled',
    });
  } catch (err) { next(err); }
});

// Only the person the task is FOR can add hours.
router.post('/:id/hours', VIEW, async (req, res, next) => {
  try {
    const me = req.user;
    const found = await reachable(me, req.params.id);
    if (found.error) return res.status(found.status).json(found.error);
    const t = found.task;
    if (t.assigneeId !== me.id) return res.status(403).json({ error: `Only ${t.assigneeName} can add hours on this task.` });
    if (t.status === 'Cancelled') return res.status(400).json({ error: 'This task was cancelled, so hours cannot be added.' });
    if (!me.employeeId) return res.status(400).json({ error: 'Your login has no employee record, so hours cannot be saved.' });
    const ok = await checkHours(req.body || {}, { employeeId: me.employeeId });
    if (ok.status) return res.status(ok.status).json(ok.body);
    const entry = await prisma.employeeRecord.create({
      data: {
        type: HOURS_TYPE, employeeId: me.employeeId, title: t.name, status: 'Logged', category: catOf(t.id),
        date: ok.date, hours: ok.hours, detail: req.body.note ? String(req.body.note).slice(0, 500) : null, raisedBy: me.name,
      },
    });
    // Working on it means it has started.
    let started = false;
    if (t.status === 'Not Started') {
      await prisma.task.update({ where: { id: t.id }, data: { status: 'In Progress', startedAt: t.startedAt || new Date() } });
      started = true;
    }
    await logAudit({
      userId: me.id, action: 'Task hours added', entity: 'Task', entityId: t.id,
      field: 'hours', fieldLabel: 'Hours', fromValue: '', toValue: `${ok.hours} h on ${fmtDay(ok.date)}`,
    });
    const hrs = await hoursMap([t.id]);
    return res.status(201).json({ entry: { id: entry.id, date: entry.date, hours: entry.hours, note: entry.detail || '' }, hoursLogged: hrs.logged.get(t.id) || 0, started });
  } catch (err) { return next(err); }
});

async function entryFor(req, res) {
  // The person who logged the hours may always correct or remove their own entry,
  // even after the task was handed to somebody else; anyone else needs reach AND manage.
  const t = await prisma.task.findUnique({ where: { id: req.params.id } });
  if (!t) { res.status(404).json({ error: 'Task not found' }); return null; }
  const entry = await prisma.employeeRecord.findFirst({
    where: { id: req.params.entryId, type: HOURS_TYPE, category: catOf(t.id), status: 'Logged' },
    include: { employee: { select: { name: true, userId: true } } },
  });
  if (!entry) { res.status(404).json({ error: 'Those hours were not found.' }); return null; }
  const owner = !!req.user.employeeId && entry.employeeId === req.user.employeeId;
  if (!owner) {
    const found = await reachable(req.user, t.id);
    if (found.error) { res.status(found.status).json(found.error); return null; }
    if (!(await taskRights(req.user, t)).manage) { res.status(403).json(DENIED); return null; }
  }
  return { t, entry, owner };
}

// Correct an entry: the person who logged it, or a lead / HR with them in scope.
// A lead changing SOMEONE ELSE'S hours must say why; both are audited old -> new.
router.put('/:id/hours/:entryId', VIEW, async (req, res, next) => {
  try {
    const me = req.user;
    const got = await entryFor(req, res);
    if (!got) return undefined;
    const { t, entry, owner } = got;
    const reason = String(req.body.reason || '').trim();
    if (!owner && !reason) return res.status(400).json({ field: 'reason', error: `Say why you are changing ${entry.employee?.name || 'their'} hours.` });
    if (t.status === 'Cancelled') return res.status(400).json({ error: 'This task was cancelled, so its hours cannot be changed.' });
    const wanted = {
      hours: req.body.hours !== undefined ? req.body.hours : entry.hours,
      date: req.body.date !== undefined ? req.body.date : entry.date,
    };
    const ok = await checkHours(wanted, { employeeId: entry.employeeId, ignoreId: entry.id, backLimit: owner });
    if (ok.status) return res.status(ok.status).json(ok.body);
    const note = req.body.note !== undefined ? (req.body.note ? String(req.body.note).slice(0, 500) : null) : entry.detail;
    const changes = [];
    if (ok.hours !== entry.hours) changes.push({ field: 'hours', label: 'Hours', from: entry.hours, to: ok.hours });
    if (ok.date !== entry.date) changes.push({ field: 'date', label: 'Day', from: entry.date, to: ok.date });
    if ((note || '') !== (entry.detail || '')) changes.push({ field: 'note', label: 'Note', from: entry.detail, to: note });
    if (!changes.length) return res.json({ unchanged: true });
    await prisma.employeeRecord.update({ where: { id: entry.id }, data: { hours: ok.hours, date: ok.date, detail: note } });
    await auditChanges(me, t, owner ? 'Task hours changed' : 'Task hours changed by a lead', changes, reason || undefined);
    if (!owner && entry.employee?.userId) {
      await quiet(hrmsNotify.taskChanged(t, me, 'Your hours were changed', `${me.name} changed your hours on "${t.name}"${reason ? ` - ${reason}` : ''}.`, entry.employee.userId));
    }
    const hrs = await hoursMap([t.id]);
    return res.json({ ok: true, hoursLogged: hrs.logged.get(t.id) || 0 });
  } catch (err) { return next(err); }
});

router.delete('/:id/hours/:entryId', VIEW, async (req, res, next) => {
  try {
    const me = req.user;
    const got = await entryFor(req, res);
    if (!got) return undefined;
    const { t, entry, owner } = got;
    const reason = String((req.body && req.body.reason) || req.query.reason || '').trim();
    if (!owner && !reason) return res.status(400).json({ field: 'reason', error: `Say why you are removing ${entry.employee?.name || 'their'} hours.` });
    await prisma.employeeRecord.delete({ where: { id: entry.id } });
    await logAudit({
      userId: me.id, action: owner ? 'Task hours removed' : 'Task hours removed by a lead', entity: 'Task', entityId: t.id,
      field: 'hours', fieldLabel: 'Hours', fromValue: `${entry.hours} h on ${fmtDay(entry.date)}`, toValue: '', reason: reason || undefined,
    });
    if (!owner && entry.employee?.userId) {
      await quiet(hrmsNotify.taskChanged(t, me, 'Your hours were removed', `${me.name} removed ${entry.hours} h (${fmtDay(entry.date)}) from "${t.name}"${reason ? ` - ${reason}` : ''}.`, entry.employee.userId));
    }
    const hrs = await hoursMap([t.id]);
    return res.json({ ok: true, hoursLogged: hrs.logged.get(t.id) || 0 });
  } catch (err) { return next(err); }
});

// --- Approve what the team finished, in one click ------------------------------
// The same decision the Review button makes, for many tasks: only tasks that are
// waiting for a review, that this login can reach, and that are not their own.
router.post('/review-batch', VIEW, async (req, res, next) => {
  try {
    const me = req.user;
    if (!(await can(me, 'hrms', 'hrms', 'Employee Services', 'approve'))) return res.status(403).json(DENIED);
    const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map(String))].slice(0, 200);
    if (!ids.length) return res.status(400).json({ error: 'Pick the finished tasks to approve.' });
    const done = [];
    const skipped = [];
    for (const id of ids) {
      // eslint-disable-next-line no-await-in-loop
      const found = await reachable(me, id);
      if (found.error) { skipped.push({ id, why: 'outside your team' }); continue; }
      const t = found.task;
      if (t.reviewState !== 'Pending Review') { skipped.push({ id, why: 'not waiting for a check' }); continue; }
      if (t.assigneeId === me.id) { skipped.push({ id, why: 'your own task' }); continue; }
      // eslint-disable-next-line no-await-in-loop
      const task = await prisma.task.update({
        where: { id: t.id },
        data: { reviewState: 'Approved', reviewedById: me.id, reviewedByName: me.name, reviewedAt: new Date(), reviewNote: null, status: 'Completed' },
      });
      // eslint-disable-next-line no-await-in-loop
      await noteOnTask(t, me, `${me.name} reviewed and approved this task.`);
      // eslint-disable-next-line no-await-in-loop
      await logAudit({ userId: me.id, action: 'Task approved', entity: 'Task', entityId: task.id, fromValue: 'Pending Review', toValue: 'Approved' });
      // eslint-disable-next-line no-await-in-loop
      await quiet(hrmsNotify.taskChanged(task, me, 'Task approved', `${me.name} checked "${task.name}" and approved it. Well done.`));
      done.push(task.id);
    }
    return res.json({ approved: done.length, ids: done, skipped });
  } catch (err) { return next(err); }
});

// --- Export: the team's tasks and hours, Excel / CSV / PDF ----------------------
//   GET /tasks/export?format=xlsx|pdf&from=&to=&given=1&assigneeId=&status=&department=
// The rows are the ones the list shows this login (visibleWhere); without the
// Employee Services export right only the caller's own tasks come out.
router.get('/export', VIEW, async (req, res, next) => {
  try {
    const { formatOf, sendTable } = require('../utils/exportKit');
    const me = req.user;
    const format = formatOf(req.query);
    if (!format) return res.status(400).json({ error: 'format must be xlsx, csv or pdf' });
    const mayExport = await can(me, 'hrms', 'hrms', 'Employee Services', 'export');
    const and = [mayExport ? await visibleWhere(me) : { assigneeId: me.id }];
    if (req.query.given === '1') and.push({ assignedById: me.id });
    if (req.query.assigneeId) {
      const aid = String(req.query.assigneeId);
      const view = await viewable(me);
      if (aid !== me.id && (!mayExport || (!view.global && !view.people.some((p) => p.userId === aid)))) return res.status(403).json(OUT_OF_SCOPE);
      and.push({ assigneeId: aid });
    }
    if (req.query.status === 'Overdue') and.push({ status: { in: OPEN_STATUSES }, endDate: { lt: today() } });
    else if (req.query.status) and.push({ status: String(req.query.status) });
    if (req.query.department) and.push({ department: String(req.query.department) });
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || '')) ? String(req.query.from) : '';
    const to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || '')) ? String(req.query.to) : '';
    if (from) and.push({ OR: [{ endDate: null }, { endDate: { gte: from } }] });
    if (to) and.push({ OR: [{ startDate: null }, { startDate: { lte: to } }] });
    const tasks = await prisma.task.findMany({ where: { AND: and }, orderBy: [{ assigneeName: 'asc' }, { endDate: 'asc' }], take: 20000 });
    const hrs = await hoursMap(tasks.map((t) => t.id), { from, to });
    const emps = await prisma.employee.findMany({ where: { userId: { in: [...new Set(tasks.map((t) => t.assigneeId))] } }, select: { userId: true, employeeCode: true } });
    const codeOf = Object.fromEntries(emps.map((e) => [e.userId, e.employeeCode]));
    const now = today();
    const rows = tasks.map((t) => {
      const d = decorate(t, now);
      return [
        t.assigneeName, codeOf[t.assigneeId] || '', t.department || '', t.name, t.subTaskName || '', t.assignedByName,
        d.priority, d.displayStatus, t.startDate || '', t.endDate || '', d.daysLate || '',
        hrs.estimate.has(t.id) ? hrs.estimate.get(t.id) : '', hrs.logged.get(t.id) || 0,
        t.completedAt ? new Date(t.completedAt).toISOString().slice(0, 10) : '',
      ];
    });
    return sendTable(req, res, {
      format,
      name: 'tasks-and-hours',
      title: 'Tasks and hours',
      headers: ['Given to', 'Employee ID', 'Department', 'Task', 'Project or job', 'Given by', 'Priority', 'Status', 'Start', 'Due', 'Days late', 'Estimated hours', from || to ? 'Hours logged (in these dates)' : 'Hours logged', 'Done on'],
      rows,
      sheet: 'Tasks and hours',
      entity: 'Task',
      what: 'Tasks and hours',
      scope: !mayExport ? 'Own tasks' : req.query.given === '1' ? 'Tasks I gave' : 'My team',
      period: from || to ? { from: from || 'the start', to: to || 'today' } : null,
    });
  } catch (err) { return next(err); }
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
// which is exactly the taskRights().manage rule.
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
      reason: note || undefined,
    });
    // The person who gave the task hears it is done (their bell + daily email).
    await quiet(hrmsNotify.taskDone(task, me));
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
      entity: 'Task', entityId: task.id, fromValue: 'Pending Review', toValue: task.reviewState, reason: note || undefined,
    });
    await quiet(hrmsNotify.taskChanged(task, me, approved ? 'Task approved' : 'Changes needed', approved
      ? `${me.name} checked "${task.name}" and approved it.${note ? ` ${note}` : ''}`
      : `${me.name} sent "${task.name}" back: ${note}`));
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
module.exports.PRIORITIES = PRIORITIES;
module.exports.PRIORITY_RANK = PRIORITY_RANK;
module.exports.OPEN_STATUSES = OPEN_STATUSES;
module.exports.isOverdue = isOverdue;
module.exports.decorate = decorate;
module.exports.REVIEW_STATES = REVIEW_STATES;
module.exports.createTask = createTask;
module.exports.assignable = assignable;
module.exports.visibleWhere = visibleWhere;
module.exports.viewable = viewable;
