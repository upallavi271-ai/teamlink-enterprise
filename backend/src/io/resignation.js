// ---------------------------------------------------------------------------
// RESIGNATION - export (everyone in scope / one employee) and IMPORT of
// resignation records (utils/moduleIo.js contract).
//
// THE FILE (HRMS spec 2026-10-09, point 8) - one row per employee:
//   Employee ID | Resignation Date | Time | Reason | Last Working Day |
//   Notice Days | Status
//
// HOW A ROW IS MATCHED: by EMPLOYEE ID only (an email is also accepted).
//   * an Employee ID that matches nobody (or somebody outside your scope) is
//     reported as UNMATCHED and nothing is created for it - a person is never
//     invented from a spreadsheet;
//   * the employee has NO resignation record yet -> one is created;
//   * the employee has ONE resignation record (a live one, or the history row
//     that was imported earlier with no date) -> it is UPDATED: only EMPTY
//     fields are filled (date, time, reason, last working day, notice days).
//     Anything already recorded is KEPT; where the file says something
//     different the preview says "kept as it is" and the file's value is not
//     written. So re-running the same file changes nothing (no duplicates);
//   * the employee has several -> the Last Working Day (or Resignation Date)
//     picks the one it belongs to; with no match the row is refused.
//
// An import records history only: it never starts an approval chain, never
// emails anybody, never raises an F&F request and never changes the
// employee's status (use Relieve on the Resignation screen for that). Every
// create / filled field is written to the audit log with the import batch.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const io = require('../utils/moduleIo');

const TYPES = ['Resignation', 'Termination', 'Dropout', 'Absconding', 'Retirement', 'Contract end'];
const STATUSES = ['Relieved', 'Notice Period', 'Withdrawn', 'Rejected'];
const IMPORT_SOURCE = 'Imported from spreadsheet';

const columns = [
  { key: 'employeeCode', label: 'Employee ID', required: true, example: 'TL101', note: 'Employee ID (or email) of an employee in your scope. The row is matched on this and never creates a new person.' },
  { key: 'employeeName', label: 'Employee Name', readOnly: true, example: 'Asha Rao' },
  { key: 'department', label: 'Department', readOnly: true, example: 'Medical' },
  { key: 'resignationDate', label: 'Resignation Date', type: 'date', required: true, example: '2026-09-18', note: 'The day the resignation was given. 2026-09-18, 18-09-2026 or 18-SEP-2026.' },
  { key: 'resignationTime', label: 'Time', example: '10:30', note: 'The time of day it was given: 10:30, 10:30 AM or 6 PM. Blank is fine.' },
  { key: 'reason', label: 'Reason', example: 'Higher studies' },
  { key: 'lastWorkingDate', label: 'Last Working Day', type: 'date', example: '2026-11-02', note: 'Blank = left as it is (or worked out from the notice days for a new record).' },
  { key: 'noticeDays', label: 'Notice Days', type: 'number', example: '45', note: 'Calendar days of notice, 0 to 365.' },
  { key: 'status', label: 'Status', list: 'Status', example: 'Notice Period', note: 'Relieved, Notice Period, Withdrawn or Rejected. Blank = worked out for a new record; never changes an existing one.' },
  { key: 'type', label: 'Resignation Type', readOnly: true, example: 'Resignation' },
  { key: 'comments', label: 'Comments', readOnly: true, example: '' },
  { key: 'source', label: 'Source', readOnly: true, example: '' },
];

const t12 = (t) => {
  const m = /^(\d{2}):(\d{2})$/.exec(String(t || ''));
  if (!m) return '';
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`;
};
const lwdOf = (rec, d) => rec.date || (d && (d.approvedLastWorkingDate || d.requestedLastWorkingDate)) || '';
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

function rowOf(rec, d) {
  const imported = d && /^Imported from/i.test(d.submittedByName || '');
  return {
    employeeCode: rec.employee ? rec.employee.employeeCode : (d && d.employeeCode) || '',
    employeeName: rec.employee ? rec.employee.name : (d && d.employeeName) || '',
    department: rec.employee ? rec.employee.department || '' : (d && d.department) || '',
    resignationDate: (d && d.resignationDate) || '',
    resignationTime: (d && d.resignationTime) || '',
    reason: d ? (d.reason === 'Other' && d.reasonOther ? d.reasonOther : d.reason || '') : (rec.title || ''),
    lastWorkingDate: lwdOf(rec, d),
    noticeDays: d && d.noticePeriodDays != null ? d.noticePeriodDays : '',
    status: rec.status,
    type: rec.category || '',
    comments: (d && d.comments) || rec.detail || '',
    source: imported ? d.submittedByName : ((d && d.source) || 'Submitted in TeamLink'),
  };
}

module.exports = {
  key: 'resignation',
  label: 'Resignations',
  module: 'Resignation',
  what: 'resignation records',
  feature: 'Employee Services',
  importActions: ['create', 'approve'],
  sheet: 'Resignations',
  entity: 'EmployeeRecord',
  columns,
  instructions: [
    'One row = one employee. The row is matched on the Employee ID. An ID that matches nobody is reported and skipped - nobody is created.',
    'An employee who already has a resignation record (including the history rows that came without a date) is UPDATED: only empty fields are filled; what is already recorded is kept. The same file can be loaded again safely.',
    'An import records history only: no approval chain, no email, no F&F request, and the employee\'s status is not changed. Every change is written to the audit log.',
  ],
  lists: async () => ({ Status: STATUSES }),

  async exportRows(ctx, { employeeIds, filters }) {
    const where = { type: 'RESIGNATION', employeeId: { in: employeeIds } };
    const recs = await prisma.employeeRecord.findMany({ where, include: { employee: true }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }] });
    const details = await prisma.resignationDetail.findMany({ where: { recordId: { in: recs.map((r) => r.id) } } });
    const byRec = new Map(details.map((d) => [d.recordId, d]));
    const from = io.parseDate(filters.from).value;
    const to = io.parseDate(filters.to).value;
    return recs.map((r) => rowOf(r, byRec.get(r.id)))
      .filter((r) => (!from || (r.lastWorkingDate && r.lastWorkingDate >= from)) && (!to || (r.lastWorkingDate && r.lastWorkingDate <= to)))
      .filter((r) => !filters.status || r.status === filters.status);
  },

  async validate(rows, ctx) {
    const out = [];
    const seen = new Map();
    const resolved = rows.map((r) => ctx.employees.resolve(r.employeeCode));
    const empIds = [...new Set(resolved.filter((h) => h.employee).map((h) => h.employee.id))];
    const existing = empIds.length ? await prisma.employeeRecord.findMany({ where: { type: 'RESIGNATION', employeeId: { in: empIds } }, orderBy: { createdAt: 'asc' } }) : [];
    const details = existing.length ? await prisma.resignationDetail.findMany({ where: { recordId: { in: existing.map((e) => e.id) } } }) : [];
    const detailOf = new Map(details.map((d) => [d.recordId, d]));
    rows.forEach((r, i) => {
      const errors = io.requiredErrors(module.exports, r);
      const hit = resolved[i];
      if (hit.error && io.str(r.employeeCode)) errors.push({ field: 'Employee ID', message: hit.error });
      const e = hit.employee;
      const res = io.parseDate(r.resignationDate);
      const lwdP = io.parseDate(r.lastWorkingDate);
      const time = io.parseTime(r.resignationTime);
      if (res.error) errors.push({ field: 'Resignation Date', message: `"${r.resignationDate}" is not a date (try 2026-09-18 or 18-SEP-2026).` });
      if (lwdP.error) errors.push({ field: 'Last Working Day', message: `"${r.lastWorkingDate}" is not a date (try 2026-11-02 or 02-NOV-2026).` });
      if (time.error) errors.push({ field: 'Time', message: `"${r.resignationTime}" is not a time (try 10:30 or 10:30 AM).` });
      if (res.value && lwdP.value && res.value > lwdP.value) errors.push({ field: 'Last Working Day', message: 'The Last Working Day is before the Resignation Date.' });
      const notice = io.parseNumber(r.noticeDays);
      if (notice.error || (notice.value !== undefined && (!Number.isInteger(notice.value) || notice.value < 0 || notice.value > 365))) {
        errors.push({ field: 'Notice Days', message: `"${r.noticeDays}" is not a whole number of days between 0 and 365.` });
      }
      const status = io.str(r.status) ? io.pick(STATUSES, r.status) : null;
      if (io.str(r.status) && !status) errors.push({ field: 'Status', message: `"${r.status}" is not one of ${STATUSES.join(', ')}.` });
      if (e) {
        if (seen.has(e.id)) errors.push({ field: 'Employee ID', message: `Same employee as row ${seen.get(e.id)} - one row per employee.` });
        else seen.set(e.id, r.line);
      }
      const label = e ? `${e.name} (${e.employeeCode})` : io.str(r.employeeCode);
      if (errors.length) { out.push({ line: r.line, label, errors, action: 'error' }); return; }

      const want = {
        resignationDate: res.value || null, resignationTime: time.value || null, reason: io.str(r.reason) || null,
        lastWorkingDate: lwdP.value || null, noticeDays: notice.value !== undefined ? notice.value : null, status,
      };
      const mine = existing.filter((x) => x.employeeId === e.id);
      let match = null;
      if (mine.length === 1) [match] = mine;
      else if (mine.length > 1) {
        match = mine.find((x) => want.lastWorkingDate && lwdOf(x, detailOf.get(x.id)) === want.lastWorkingDate)
          || mine.find((x) => want.resignationDate && (detailOf.get(x.id) || {}).resignationDate === want.resignationDate) || null;
        if (!match) {
          out.push({ line: r.line, label, errors: [{ field: 'Employee ID', message: `${e.name} has ${mine.length} resignation records - give the Last Working Day (or Resignation Date) of the one this row belongs to.` }], action: 'error' });
          return;
        }
      }

      if (!match) {
        const lwd = want.lastWorkingDate || addDays(want.resignationDate, want.noticeDays != null ? want.noticeDays : 45);
        const st = status || (['Relieved', 'Exited'].includes(e.employmentStatus) || lwd < today() ? 'Relieved' : 'Notice Period');
        out.push({
          line: r.line, label, errors: [], action: 'create',
          changes: [
            { field: 'Resignation Date', from: '', to: want.resignationDate + (want.resignationTime ? ` ${t12(want.resignationTime)}` : '') },
            ...(want.reason ? [{ field: 'Reason', from: '', to: want.reason }] : []),
            { field: 'Last Working Day', from: '', to: lwd },
            { field: 'Status', from: '', to: st },
          ],
          data: { employee: e, ...want, lastWorkingDate: lwd, status: st },
        });
        return;
      }

      const d = detailOf.get(match.id);
      const cur = {
        resignationDate: (d && d.resignationDate) || '', resignationTime: (d && d.resignationTime) || '',
        reason: d ? (d.reason === 'Other' && d.reasonOther ? d.reasonOther : d.reason || '') : '',
        lastWorkingDate: lwdOf(match, d), noticeDays: d && d.noticePeriodDays != null ? d.noticePeriodDays : null,
      };
      const changes = [];
      const notes = [];
      const fill = (field, key, fmt = (v) => v) => {
        const next = want[key];
        if (next === null || next === undefined || next === '') return;
        const have = cur[key];
        if (have === '' || have === null || have === undefined) changes.push({ field, from: '', to: fmt(next), key });
        else if (String(have) !== String(next)) notes.push(`${field}: kept as it is (${fmt(have)}); the file says ${fmt(next)}`);
      };
      fill('Resignation Date', 'resignationDate');
      fill('Time', 'resignationTime', t12);
      fill('Reason', 'reason');
      fill('Last Working Day', 'lastWorkingDate');
      fill('Notice Days', 'noticeDays');
      if (status && status !== match.status) notes.push(`Status: kept as it is (${match.status}); the file says ${status}`);
      out.push({
        line: r.line, label, errors: [], action: changes.length ? 'update' : 'nochange', changes, notes,
        data: { employee: e, record: match, detail: d, fills: Object.fromEntries(changes.map((c) => [c.key, want[c.key]])) },
      });
    });
    return out;
  },

  async apply(valid, ctx) {
    let created = 0;
    let updated = 0;
    const failed = [];
    const actor = ctx.user.name || ctx.user.email;
    const batch = `RI-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
    const source = ctx.fileName ? `Imported: ${ctx.fileName}` : IMPORT_SOURCE;
    // eslint-disable-next-line no-restricted-syntax
    for (const v of valid) {
      try {
        const x = v.data;
        if (v.action === 'create') {
          // eslint-disable-next-line no-await-in-loop
          await prisma.$transaction(async (tx) => {
            const rec = await tx.employeeRecord.create({
              data: {
                type: 'RESIGNATION', employeeId: x.employee.id, title: x.reason || 'Resignation (history)', detail: null,
                status: x.status, date: x.lastWorkingDate, category: 'Resignation',
              },
            });
            const emp = await tx.employee.findUnique({ where: { id: x.employee.id }, include: { reportingManager: { select: { name: true } } } });
            await tx.resignationDetail.create({
              data: {
                recordId: rec.id, employeeId: emp.id, employeeCode: emp.employeeCode, employeeName: emp.name, department: emp.department,
                designation: emp.designation, reportingManager: (emp.reportingManager && emp.reportingManager.name) || emp.tl || emp.stl || null,
                resignationDate: x.resignationDate || '', resignationTime: x.resignationTime || null,
                requestedLastWorkingDate: x.lastWorkingDate, approvedLastWorkingDate: x.lastWorkingDate,
                reason: x.reason || '', noticePeriodDays: x.noticeDays, source, importBatch: batch,
                submittedByUserId: ctx.user.id, submittedByName: IMPORT_SOURCE,
                exitComments: `Imported by ${actor}${ctx.request ? ` (approved request from ${ctx.request.requestedBy})` : ''}.`,
              },
            });
            await tx.auditLog.create({
              data: {
                userId: ctx.user.id, actorName: actor, action: 'Resignation imported', entity: 'EmployeeRecord', entityId: rec.id,
                toValue: `${x.status} · resigned ${x.resignationDate}${x.resignationTime ? ` ${x.resignationTime}` : ''} · last day ${x.lastWorkingDate}${x.reason ? ` · ${x.reason}` : ''}`,
                reason: `${emp.employeeCode} ${emp.name} · batch ${batch}`,
              },
            });
          });
          created += 1;
        } else if (v.action === 'update') {
          const f = x.fills;
          const recData = {};
          if (f.lastWorkingDate) recData.date = f.lastWorkingDate;
          const detData = {};
          if (f.resignationDate) detData.resignationDate = f.resignationDate;
          if (f.resignationTime) detData.resignationTime = f.resignationTime;
          if (f.reason) detData.reason = f.reason;
          if (f.noticeDays !== undefined && f.noticeDays !== null) detData.noticePeriodDays = f.noticeDays;
          if (f.lastWorkingDate) { detData.approvedLastWorkingDate = f.lastWorkingDate; if (!(x.detail && x.detail.requestedLastWorkingDate)) detData.requestedLastWorkingDate = f.lastWorkingDate; }
          // eslint-disable-next-line no-await-in-loop
          await prisma.$transaction(async (tx) => {
            if (Object.keys(recData).length) await tx.employeeRecord.update({ where: { id: x.record.id }, data: recData });
            if (x.detail) {
              if (Object.keys(detData).length) await tx.resignationDetail.update({ where: { id: x.detail.id }, data: { ...detData, importBatch: batch } });
            } else {
              const emp = await tx.employee.findUnique({ where: { id: x.employee.id } });
              await tx.resignationDetail.create({
                data: {
                  recordId: x.record.id, employeeId: emp.id, employeeCode: emp.employeeCode, employeeName: emp.name, department: emp.department, designation: emp.designation,
                  resignationDate: detData.resignationDate || '', resignationTime: detData.resignationTime || null, reason: detData.reason || '',
                  noticePeriodDays: detData.noticePeriodDays ?? null, requestedLastWorkingDate: detData.requestedLastWorkingDate || null, approvedLastWorkingDate: detData.approvedLastWorkingDate || null,
                  source, importBatch: batch, submittedByUserId: ctx.user.id, submittedByName: IMPORT_SOURCE,
                },
              });
            }
            await tx.auditLog.createMany({
              data: v.changes.map((c) => ({
                userId: ctx.user.id, actorName: actor, action: 'Resignation filled by import', entity: 'EmployeeRecord', entityId: x.record.id,
                field: c.field, fieldLabel: c.field, fromValue: String(c.from || ''), toValue: String(c.to || ''), reason: `batch ${batch}`,
              })),
            });
          });
          updated += 1;
        }
      } catch (err) {
        failed.push({ line: v.line, reason: String(err.message || err).split('\n').pop().slice(0, 200) });
      }
    }
    return { created, updated, skipped: 0, failed, batch };
  },
};
