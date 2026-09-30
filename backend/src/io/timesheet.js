// ---------------------------------------------------------------------------
// TIMESHEET — export (everyone in scope / one employee) and import of TASKS
// (utils/moduleIo.js contract).
//
// The Timesheet screen (pages/hrms/Timesheet.jsx) is backed by /api/tasks —
// the Task table — not by the old EmployeeRecord type TIMESHEET, which no
// screen reads any more. So this spec exports and imports Task rows. The
// hours-worked summary stays on the screen's own Export (the insights panel,
// GET /api/insights/timesheet/export, which also takes ?employeeId=).
//
// A task belongs to a LOGIN (Task.assigneeId is a User.id — one employee =
// one user), so a row naming an employee without a login is refused.
// Match: the assignee + Task Name + Start Date. Same three -> the task is
// UPDATED (blank cells never overwrite); otherwise a new task is created,
// assigned by the importer.
//
// An import records work, it runs no workflow: nobody is notified, and a task
// imported as Completed is NOT put in a reviewer's queue (review state stays
// "Not Submitted", as for tasks completed before reviews existed).
//
// Rights: assigning work to somebody else is Employee Services / create on
// the screen (routes/tasks.js assignable()), so an import asks the same, and
// a login with an explicit team scope is held to that team, as there.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const io = require('../utils/moduleIo');
const { scopeOf } = require('../utils/scope');

const STATUSES = ['Not Started', 'In Progress', 'On Hold', 'Completed', 'Cancelled'];
const OPEN = ['Not Started', 'In Progress', 'On Hold'];

const columns = [
  { key: 'employeeCode', label: 'Employee ID', required: true, example: 'TL101', note: 'The assignee: Employee ID (or email) of an employee in your scope who has a TeamLink login.' },
  { key: 'employeeName', label: 'Employee Name', readOnly: true, example: 'Asha Rao' },
  { key: 'department', label: 'Department', list: 'Department', example: 'Medical', note: 'The task\'s department. Blank = the assignee\'s department.' },
  { key: 'name', label: 'Task Name', required: true, example: 'Screen 20 profiles' },
  { key: 'subTaskName', label: 'Sub Task', example: '' },
  { key: 'description', label: 'Description', example: '' },
  { key: 'status', label: 'Status', list: 'Status', example: 'Not Started', note: 'Blank = Not Started for a new task.' },
  { key: 'startDate', label: 'Start Date', type: 'date', required: true, example: '2026-10-01' },
  { key: 'endDate', label: 'End Date', type: 'date', example: '2026-10-03' },
  { key: 'assignedBy', label: 'Assigned By', readOnly: true, example: '' },
  { key: 'reviewState', label: 'Review', readOnly: true, example: '' },
];

const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

// The same narrowing routes/tasks.js assignable() applies on top of the scope.
function teamGate(user) {
  const s = scopeOf(user);
  const teams = csv(user.atsScopeTeams);
  if (s.global || !teams.length) return () => true;
  return (e) => teams.includes(e.team) || e.id === user.employeeId;
}

module.exports = {
  key: 'timesheet',
  label: 'Timesheet tasks',
  module: 'Timesheet',
  what: 'timesheet tasks',
  feature: 'Employee Services',
  importActions: ['create'],
  sheet: 'Tasks',
  entity: 'Task',
  columns,
  instructions: [
    'One row = one task for one person. A row with the same Employee ID, Task Name and Start Date as an existing task updates it; blank cells never overwrite.',
    'An import notifies nobody, and a task imported as Completed is not sent for review.',
    'The hours-worked summary is exported from the Timesheet screen\'s own Export button; it is calculated from attendance and is not imported.',
  ],

  async lists() {
    const depts = await prisma.department.findMany({ select: { name: true }, orderBy: { name: 'asc' } });
    return { Department: depts.map((d) => d.name), Status: STATUSES };
  },

  async exportRows(ctx, { employeeIds, filters }) {
    const emps = employeeIds.map((id) => ctx.employees.byId.get(id)).filter((e) => e && e.userId);
    if (!emps.length) return [];
    const byUser = new Map(emps.map((e) => [e.userId, e]));
    const and = [{ assigneeId: { in: [...byUser.keys()] } }];
    const from = io.parseDate(filters.from).value;
    const to = io.parseDate(filters.to).value;
    // The list's own rule: tasks whose window overlaps the range.
    if (from) and.push({ OR: [{ endDate: null }, { endDate: { gte: from } }] });
    if (to) and.push({ OR: [{ startDate: null }, { startDate: { lte: to } }] });
    if (filters.status) and.push({ status: String(filters.status) });
    if (filters.department) {
      const dept = String(filters.department);
      and.push({ OR: [{ department: dept }, { assigneeId: { in: emps.filter((e) => e.department === dept).map((e) => e.userId) } }] });
    }
    const tasks = await prisma.task.findMany({ where: { AND: and }, orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }] });
    return tasks.map((t) => {
      const e = byUser.get(t.assigneeId);
      return {
        employeeCode: e ? e.employeeCode : '',
        employeeName: e ? e.name : t.assigneeName,
        department: t.department || '',
        name: t.name,
        subTaskName: t.subTaskName || '',
        description: t.description || '',
        status: t.status,
        startDate: t.startDate || '',
        endDate: t.endDate || '',
        assignedBy: t.assignedByName || '',
        reviewState: t.reviewState || '',
      };
    });
  },

  async validate(rows, ctx) {
    const depts = (await prisma.department.findMany({ select: { name: true } })).map((d) => d.name);
    const inTeam = teamGate(ctx.user);
    const resolved = rows.map((r) => ctx.employees.resolve(r.employeeCode));
    const userIds = [...new Set(resolved.filter((h) => h.employee && h.employee.userId).map((h) => h.employee.userId))];
    const existing = userIds.length ? await prisma.task.findMany({ where: { assigneeId: { in: userIds } } }) : [];
    const seen = new Map();
    return rows.map((r, i) => {
      const errors = io.requiredErrors(module.exports, r);
      const hit = resolved[i];
      if (hit.error && io.str(r.employeeCode)) errors.push({ field: 'Employee ID', message: hit.error });
      let e = hit.employee;
      if (e && !e.userId) { errors.push({ field: 'Employee ID', message: `${e.name} has no TeamLink login, so cannot be given a task.` }); e = null; }
      if (e && !inTeam(e)) { errors.push({ field: 'Employee ID', message: `${e.name} is outside the team you may assign work to.` }); e = null; }
      const start = io.parseDate(r.startDate);
      const end = io.parseDate(r.endDate);
      if (start.error) errors.push({ field: 'Start Date', message: `"${r.startDate}" is not a date (YYYY-MM-DD).` });
      if (end.error) errors.push({ field: 'End Date', message: `"${r.endDate}" is not a date (YYYY-MM-DD).` });
      if (start.value && end.value && end.value < start.value) errors.push({ field: 'End Date', message: 'End date cannot be before start date.' });
      const status = io.str(r.status) ? io.pick(STATUSES, r.status) : null;
      if (io.str(r.status) && !status) errors.push({ field: 'Status', message: `"${r.status}" is not one of ${STATUSES.join(', ')}.` });
      const deptAsked = io.str(r.department);
      const dept = deptAsked ? io.pick(depts, deptAsked) : null;
      if (deptAsked && !dept) errors.push({ field: 'Department', message: `"${deptAsked}" is not a department.` });
      const name = io.str(r.name);
      if (name.length > 200) errors.push({ field: 'Task Name', message: 'Keep the task name under 200 characters.' });
      if (e && name && start.value) {
        const k = `${e.userId}|${name.toLowerCase()}|${start.value}`;
        if (seen.has(k)) errors.push({ field: 'Task Name', message: `Same employee, task and start date as row ${seen.get(k)}.` });
        else seen.set(k, r.line);
      }
      const label = e ? `${e.name} (${e.employeeCode}) · ${name}` : `${io.str(r.employeeCode)} · ${name}`;
      if (errors.length) return { line: r.line, label, errors, action: 'error' };
      const match = existing.find((t) => t.assigneeId === e.userId && io.str(t.name).toLowerCase() === name.toLowerCase() && (t.startDate || '') === start.value);
      const want = {
        department: dept, subTaskName: io.str(r.subTaskName) || null, description: io.str(r.description) || null, status, endDate: end.value || null,
      };
      if (!match) {
        const department = dept || e.department;
        if (!department) return { line: r.line, label, errors: [{ field: 'Department', message: 'Give a department — the assignee has none on record.' }], action: 'error' };
        return {
          line: r.line, label, errors: [], action: 'create',
          changes: [{ field: 'Task', from: '', to: name }, { field: 'Status', from: '', to: status || 'Not Started' }],
          data: { employee: e, name, startDate: start.value, ...want, department, status: status || 'Not Started' },
        };
      }
      const changes = [];
      const cmp = (field, cur, next) => { if (next !== null && next !== undefined && String(cur || '') !== String(next)) changes.push({ field, from: cur || '', to: next }); };
      cmp('Department', match.department, want.department);
      cmp('Sub Task', match.subTaskName, want.subTaskName);
      cmp('Description', match.description, want.description);
      cmp('Status', match.status, want.status);
      cmp('End Date', match.endDate, want.endDate);
      if (want.endDate && !want.status && match.startDate && want.endDate < match.startDate) {
        return { line: r.line, label, errors: [{ field: 'End Date', message: 'End date cannot be before start date.' }], action: 'error' };
      }
      return {
        line: r.line, label, errors: [], action: changes.length ? 'update' : 'nochange', changes,
        data: { employee: e, task: match, ...want },
      };
    });
  },

  async apply(valid, ctx) {
    let created = 0;
    let updated = 0;
    const failed = [];
    const actor = ctx.user.name || ctx.user.email;
    // eslint-disable-next-line no-restricted-syntax
    for (const v of valid) {
      try {
        const x = v.data;
        if (v.action === 'create') {
          const now = new Date();
          // eslint-disable-next-line no-await-in-loop
          await prisma.$transaction(async (tx) => {
            const t = await tx.task.create({
              data: {
                name: x.name, department: x.department, description: x.description, subTaskName: x.subTaskName,
                status: x.status, startDate: x.startDate, endDate: x.endDate,
                assigneeId: x.employee.userId, assignedById: ctx.user.id, assigneeName: x.employee.name, assignedByName: ctx.user.name || actor,
                startedAt: x.status === 'Not Started' ? null : now,
                completedAt: x.status === 'Completed' ? now : null,
                reviewState: 'Not Submitted',
              },
            });
            await tx.auditLog.create({
              data: {
                userId: ctx.user.id, actorName: actor, action: 'Task imported', entity: 'Task', entityId: t.id,
                toValue: `${t.name} → ${t.assigneeName} · ${t.status}`, reason: `${x.employee.employeeCode} ${x.employee.name}`,
              },
            });
          });
          created += 1;
        } else if (v.action === 'update') {
          const cur = x.task;
          const data = {};
          ['department', 'subTaskName', 'description', 'endDate'].forEach((k) => { if (x[k]) data[k] = x[k]; });
          if (x.status && x.status !== cur.status) {
            data.status = x.status;
            // The lifecycle stamps, as the screen keeps them: started once it
            // leaves Not Started, completed only while Completed.
            if (x.status !== 'Not Started' && !cur.startedAt) data.startedAt = new Date();
            if (x.status === 'Completed') data.completedAt = cur.completedAt || new Date();
            else if (OPEN.includes(x.status)) {
              data.completedAt = null;
              // Reopened: a review nobody has given yet is withdrawn.
              if (cur.reviewState === 'Pending Review') data.reviewState = 'Not Submitted';
            }
          }
          // eslint-disable-next-line no-await-in-loop
          await prisma.$transaction(async (tx) => {
            await tx.task.update({ where: { id: cur.id }, data });
            await tx.auditLog.createMany({
              data: v.changes.map((c) => ({
                userId: ctx.user.id, actorName: actor, action: 'Task updated by import', entity: 'Task', entityId: cur.id,
                field: c.field, fieldLabel: c.field, fromValue: String(c.from || ''), toValue: String(c.to || ''),
              })),
            });
          });
          updated += 1;
        }
      } catch (err) {
        failed.push({ line: v.line, reason: String(err.message || err).split('\n').pop().slice(0, 200) });
      }
    }
    return { created, updated, skipped: 0, failed };
  },
};
