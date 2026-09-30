// ---------------------------------------------------------------------------
// LMS COURSE ASSIGNMENTS (CourseAssignment) — import of assignments
// (employee + course + due date) (utils/moduleIo.js contract). The screen's
// export is the existing /api/insights/lms/export (everyone in scope /
// ?employeeId= one employee) and this sample uses the SAME column names, so
// an exported enrolment register re-imports as is (its progress columns are
// read-only).
//
// routes/lms.js's assignment rules hold:
//   * rights: canAssign — Performance & Development create OR assign (the
//     `caps` override below; moduleIo alone would ask every action);
//   * the course must be published (approvalStatus Approved);
//   * the employee must be inside the caller's scope, not exited, not a
//     system account (ctx.employees already is the scope minus system
//     accounts);
//   * a due date cannot be set in the past.
// An import only RECORDS the assignment: it never sends the "Course
// assigned" notification (notifyAssigned is not called), never touches
// progress, scores or completion (a course completes itself — there is no
// manual completion anywhere), and never changes the course's own
// assignMode. Same employee + course -> the assignment is kept and only its
// Due Date is updated (a blank never overwrites); otherwise it is created,
// with one CourseAssignmentBatch per course per import (label "Imported from
// spreadsheet") so the LMS History lists it like any other assign action.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const io = require('../utils/moduleIo');
const { can } = require('../utils/permissions');
const { hrmsGlobal } = require('../utils/scope');

const EXITED = ['Relieved', 'Exited', 'Exit Process'];
const BATCH_LABEL = 'Imported from spreadsheet';
const today = () => new Date().toISOString().slice(0, 10);
const ymd = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const dueAt = (s) => new Date(`${s}T23:59:59`); // end of that day, as routes/lms.js parseDue()

async function approvedCourses() {
  return prisma.course.findMany({ where: { approvalStatus: 'Approved' }, select: { id: true, title: true }, orderBy: { title: 'asc' } });
}

const RO = (key, label) => ({ key, label, readOnly: true, example: '' });

const spec = {
  key: 'lms',
  label: 'Course assignments',
  module: 'LMS',
  what: 'course assignments',
  feature: 'Performance & Development',
  importActions: ['create'],
  sheet: 'Course assignments',
  entity: 'CourseAssignment',
  exportVia: '/insights/lms/export',
  columns: [
    { key: 'employeeCode', label: 'Employee ID', required: true, example: 'TL101', note: 'Employee ID (or email) of an active employee in your scope.' },
    RO('employeeName', 'Name'),
    RO('department', 'Department'),
    { key: 'course', label: 'Course', required: true, list: 'Course', example: 'POSH Awareness', note: 'The exact title of a PUBLISHED course (Lists sheet).' },
    RO('category', 'Category'),
    RO('assignedOn', 'Assigned On'),
    RO('assignedBy', 'Assigned By'),
    { key: 'dueDate', label: 'Due Date', type: 'date', example: '2026-12-31', note: 'Optional. Cannot be in the past (the LMS rule). Same employee + course: only the due date is updated.' },
    RO('status', 'Status'), RO('attempts', 'Attempts'), RO('score', 'Score'), RO('passMark', 'Pass Mark'), RO('completedOn', 'Completed On'), RO('lastAccessed', 'Last Accessed'),
  ],
  instructions: [
    'An import records course assignments only — the learner is NOT notified, and progress, scores and completion are never set by a file (a course completes itself).',
    'A row whose employee already has the course keeps that enrolment; only a new (non-blank) Due Date is applied.',
    'An enrolment register exported from the LMS can be re-imported as is: its progress columns are read-only and ignored.',
  ],
  lists: async () => ({ Course: (await approvedCourses()).map((c) => c.title) }),

  // canAssign (routes/lms.js): create OR assign on Performance & Development.
  async caps(user, base) {
    if (base.canImport) return base;
    const assign = await can(user, null, 'hrms', 'Performance & Development', 'assign');
    return assign ? { ...base, canImport: true, allowRequest: false, importBlockedReason: null } : {
      ...base, importBlockedReason: 'Importing course assignments needs the LMS assign right (Performance & Development create or assign).',
    };
  },

  async exportRows(ctx, { employeeIds }) {
    const list = await prisma.courseAssignment.findMany({
      where: { employeeId: { in: employeeIds } },
      include: { course: true, employee: true },
      orderBy: { assignedAt: 'desc' },
    });
    const statusOf = (a) => (a.completed ? 'Completed'
      : (a.startedAt || a.lastAccessedAt || a.watchedSeconds > 0 || a.attempts > 0 || a.contentCompletedAt ? 'In Progress' : 'Not Started'));
    return list.map((a) => ({
      employeeCode: a.employee.employeeCode, employeeName: a.employee.name, department: a.employee.department || '', course: a.course.title,
      category: a.course.category || '', assignedOn: ymd(a.assignedAt), assignedBy: a.assignedByName || '', dueDate: ymd(a.dueDate),
      status: statusOf(a), attempts: a.attempts, score: a.score ?? '', passMark: a.course.passMark, completedOn: ymd(a.completedAt), lastAccessed: ymd(a.lastAccessedAt),
    }));
  },

  async validate(rows, ctx) {
    const courses = await approvedCourses();
    const allCourses = await prisma.course.findMany({ select: { title: true, approvalStatus: true } });
    const byTitle = new Map();
    courses.forEach((c) => { const k = io.str(c.title).toLowerCase(); byTitle.set(k, byTitle.has(k) ? 'dup' : c); });
    const resolved = rows.map((r) => ctx.employees.resolve(r.employeeCode));
    const empIds = [...new Set(resolved.filter((h) => h.employee).map((h) => h.employee.id))];
    const existing = empIds.length ? await prisma.courseAssignment.findMany({ where: { employeeId: { in: empIds } } }) : [];
    const have = new Map(existing.map((a) => [`${a.employeeId}|${a.courseId}`, a]));
    const seen = new Map();
    return rows.map((r, i) => {
      const errors = io.requiredErrors(spec, r);
      const hit = resolved[i];
      if (hit.error && io.str(r.employeeCode)) errors.push({ field: 'Employee ID', message: hit.error });
      const e = hit.employee;
      if (e && EXITED.includes(e.employmentStatus)) errors.push({ field: 'Employee ID', message: `${e.name} has exited (${e.employmentStatus}) — courses are not assigned to exited employees.` });
      let course = null;
      if (io.str(r.course)) {
        const c = byTitle.get(io.str(r.course).toLowerCase());
        if (c === 'dup') errors.push({ field: 'Course', message: `More than one published course is called "${r.course}" — rename one first.` });
        else if (c) course = c;
        else {
          const draft = allCourses.find((x) => io.str(x.title).toLowerCase() === io.str(r.course).toLowerCase());
          errors.push({ field: 'Course', message: draft ? `"${r.course}" is still awaiting approval (${draft.approvalStatus}) — it can be assigned once it is published.` : `No published course is called "${r.course}".` });
        }
      }
      const d = io.parseDate(r.dueDate);
      if (d.error) errors.push({ field: 'Due Date', message: `"${r.dueDate}" is not a date (YYYY-MM-DD).` });
      const label = e ? `${e.name} (${e.employeeCode})${course ? ` · ${course.title}` : ''}` : io.str(r.employeeCode);
      const current = e && course ? have.get(`${e.id}|${course.id}`) : null;
      const due = d.value || null;
      // The LMS rule: a due date cannot be SET in the past. A re-imported
      // register that repeats a past due date already on file changes nothing.
      if (due && due < today() && !(current && ymd(current.dueDate) === due)) {
        errors.push({ field: 'Due Date', message: 'The due date cannot be in the past.' });
      }
      if (e && course && !errors.length) {
        const k = `${e.id}|${course.id}`;
        if (seen.has(k)) errors.push({ field: 'Course', message: `Same employee and course as row ${seen.get(k)}.` });
        else seen.set(k, r.line);
      }
      if (errors.length) return { line: r.line, label, errors, action: 'error' };
      if (!current) {
        return {
          line: r.line, label, errors: [], action: 'create',
          changes: [{ field: 'Course', from: '', to: course.title }, ...(due ? [{ field: 'Due Date', from: '', to: due }] : [])],
          data: { employee: e, course, due },
        };
      }
      if (due && ymd(current.dueDate) !== due) {
        return {
          line: r.line, label, errors: [], action: 'update',
          changes: [{ field: 'Due Date', from: ymd(current.dueDate), to: due }],
          data: { employee: e, course, due, record: current },
        };
      }
      return { line: r.line, label, errors: [], action: 'nochange', changes: [], data: {} };
    });
  },

  async apply(valid, ctx) {
    let created = 0;
    let updated = 0;
    const failed = [];
    const actor = ctx.user.name || ctx.user.email;
    const batches = new Map(); // courseId -> batch
    // eslint-disable-next-line no-restricted-syntax
    for (const v of valid) {
      try {
        const x = v.data;
        if (v.action === 'create') {
          // eslint-disable-next-line no-await-in-loop
          await prisma.$transaction(async (tx) => {
            let batch = batches.get(x.course.id);
            if (!batch) {
              batch = await tx.courseAssignmentBatch.create({
                data: {
                  courseId: x.course.id, mode: 'Individuals', employeeIds: '[]', label: BATCH_LABEL,
                  assignedById: ctx.user.id, assignedByName: ctx.user.name || null,
                  assignedByRole: ctx.user.hrmsRole || ctx.user.role || null, orgWide: hrmsGlobal(ctx.user), assignedCount: 0,
                },
              });
              batch.ids = [];
            }
            const a = await tx.courseAssignment.create({
              data: {
                courseId: x.course.id, employeeId: x.employee.id, batchId: batch.id, dueDate: x.due ? dueAt(x.due) : null,
                assignedById: ctx.user.id, assignedByName: ctx.user.name || null, source: 'Import', department: x.employee.department || null,
              },
            });
            const ids = [...batch.ids, x.employee.id];
            await tx.courseAssignmentBatch.update({ where: { id: batch.id }, data: { employeeIds: JSON.stringify(ids), assignedCount: ids.length } });
            await tx.auditLog.create({
              data: {
                userId: ctx.user.id, actorName: actor, action: 'Course assigned (Import)', entity: 'CourseAssignment', entityId: a.id,
                toValue: `${x.course.title}${x.due ? ` · due ${x.due}` : ''}`, reason: `${x.employee.employeeCode} ${x.employee.name}`,
              },
            });
            batch.ids = ids;
            batches.set(x.course.id, batch);
          });
          created += 1;
        } else if (v.action === 'update') {
          // eslint-disable-next-line no-await-in-loop
          await prisma.$transaction(async (tx) => {
            await tx.courseAssignment.update({ where: { id: x.record.id }, data: { dueDate: dueAt(x.due) } });
            await tx.auditLog.createMany({
              data: v.changes.map((c) => ({
                userId: ctx.user.id, actorName: actor, action: 'Course assignment updated by import', entity: 'CourseAssignment', entityId: x.record.id,
                field: c.field, fieldLabel: c.field, fromValue: String(c.from ?? ''), toValue: String(c.to ?? ''),
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

module.exports = spec;
