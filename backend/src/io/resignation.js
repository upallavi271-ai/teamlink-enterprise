// ---------------------------------------------------------------------------
// RESIGNATION — export (everyone in scope / one employee) and import of
// HISTORICAL resignation records (utils/moduleIo.js contract).
//
// An import records history only: it never starts an approval chain, never
// emails anybody, never raises an F&F request and never changes the
// employee's status (use Relieve on the Resignation screen for that).
// Match: the employee + the relieving (last working) date. Same employee and
// date -> the record is UPDATED (blank cells never overwrite); otherwise a
// new record is created.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const io = require('../utils/moduleIo');

const TYPES = ['Resignation', 'Termination', 'Dropout', 'Absconding', 'Retirement', 'Contract end'];
const STATUSES = ['Relieved', 'Notice Period', 'Withdrawn', 'Rejected'];
const IMPORT_SOURCE = 'Imported from spreadsheet';

const columns = [
  { key: 'employeeCode', label: 'Employee ID', required: true, example: 'TL101', note: 'Employee ID (or email) of an employee in your scope.' },
  { key: 'employeeName', label: 'Employee Name', readOnly: true, example: 'Asha Rao' },
  { key: 'department', label: 'Department', readOnly: true, example: 'Medical' },
  { key: 'type', label: 'Resignation Type', list: 'Resignation Type', example: 'Resignation' },
  { key: 'resignationDate', label: 'Resignation Date', type: 'date', example: '2026-03-01' },
  { key: 'relievingDate', label: 'Relieving Date', type: 'date', required: true, example: '2026-03-31', note: 'The last working day.' },
  { key: 'reason', label: 'Reason', example: 'Higher studies' },
  { key: 'status', label: 'Status', list: 'Status', example: 'Relieved', note: 'Blank = Relieved.' },
  { key: 'comments', label: 'Comments', example: '' },
  { key: 'source', label: 'Source', readOnly: true, example: '' },
];

function rowOf(rec, d) {
  const imported = d && /^Imported from/i.test(d.submittedByName || '');
  return {
    employeeCode: rec.employee ? rec.employee.employeeCode : (d && d.employeeCode) || '',
    employeeName: rec.employee ? rec.employee.name : (d && d.employeeName) || '',
    department: rec.employee ? rec.employee.department || '' : (d && d.department) || '',
    type: rec.category || '',
    resignationDate: (d && d.resignationDate) || '',
    relievingDate: rec.date || (d && (d.approvedLastWorkingDate || d.requestedLastWorkingDate)) || '',
    reason: d ? (d.reason === 'Other' && d.reasonOther ? d.reasonOther : d.reason || '') : (rec.title || ''),
    status: rec.status,
    comments: (d && d.comments) || rec.detail || '',
    source: imported ? d.submittedByName : 'Submitted in TeamLink',
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
    'An import records resignation HISTORY only — no approval chain, no email, no F&F request, and the employee\'s status is not changed.',
    'A row with the same Employee ID and Relieving Date as an existing resignation updates it; blank cells never overwrite.',
  ],
  lists: async () => ({ 'Resignation Type': TYPES, Status: STATUSES }),

  async exportRows(ctx, { employeeIds, filters }) {
    const where = { type: 'RESIGNATION', employeeId: { in: employeeIds } };
    const recs = await prisma.employeeRecord.findMany({ where, include: { employee: true }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }] });
    const details = await prisma.resignationDetail.findMany({ where: { recordId: { in: recs.map((r) => r.id) } } });
    const byRec = new Map(details.map((d) => [d.recordId, d]));
    const from = io.parseDate(filters.from).value;
    const to = io.parseDate(filters.to).value;
    return recs.map((r) => rowOf(r, byRec.get(r.id)))
      .filter((r) => (!from || (r.relievingDate && r.relievingDate >= from)) && (!to || (r.relievingDate && r.relievingDate <= to)))
      .filter((r) => !filters.status || r.status === filters.status);
  },

  async validate(rows, ctx) {
    const out = [];
    const seen = new Map();
    const empIds = [];
    const resolved = rows.map((r) => {
      const hit = ctx.employees.resolve(r.employeeCode);
      if (hit.employee) empIds.push(hit.employee.id);
      return hit;
    });
    const existing = empIds.length ? await prisma.employeeRecord.findMany({ where: { type: 'RESIGNATION', employeeId: { in: [...new Set(empIds)] } } }) : [];
    const details = existing.length ? await prisma.resignationDetail.findMany({ where: { recordId: { in: existing.map((e) => e.id) } } }) : [];
    const detailOf = new Map(details.map((d) => [d.recordId, d]));
    rows.forEach((r, i) => {
      const errors = io.requiredErrors(module.exports, r);
      const hit = resolved[i];
      if (hit.error && io.str(r.employeeCode)) errors.push({ field: 'Employee ID', message: hit.error });
      const e = hit.employee;
      const rel = io.parseDate(r.relievingDate);
      const res = io.parseDate(r.resignationDate);
      if (rel.error) errors.push({ field: 'Relieving Date', message: `"${r.relievingDate}" is not a date (YYYY-MM-DD).` });
      if (res.error) errors.push({ field: 'Resignation Date', message: `"${r.resignationDate}" is not a date (YYYY-MM-DD).` });
      if (rel.value && res.value && res.value > rel.value) errors.push({ field: 'Resignation Date', message: 'Resignation Date is after the Relieving Date.' });
      const type = io.str(r.type) ? io.pick(TYPES, r.type) : null;
      if (io.str(r.type) && !type) errors.push({ field: 'Resignation Type', message: `"${r.type}" is not one of ${TYPES.join(', ')}.` });
      const status = io.str(r.status) ? io.pick(STATUSES, r.status) : null;
      if (io.str(r.status) && !status) errors.push({ field: 'Status', message: `"${r.status}" is not one of ${STATUSES.join(', ')}.` });
      if (e && rel.value) {
        const k = `${e.id}|${rel.value}`;
        if (seen.has(k)) errors.push({ field: 'Relieving Date', message: `Same employee and date as row ${seen.get(k)}.` });
        else seen.set(k, r.line);
      }
      const label = e ? `${e.name} (${e.employeeCode})` : io.str(r.employeeCode);
      if (errors.length) { out.push({ line: r.line, label, errors, action: 'error' }); return; }
      const match = existing.find((x) => x.employeeId === e.id && (x.date || '') === rel.value);
      const want = {
        type, resignationDate: res.value || null, reason: io.str(r.reason) || null, status, comments: io.str(r.comments) || null,
      };
      if (!match) {
        out.push({
          line: r.line, label, errors: [], action: 'create',
          changes: [{ field: 'Relieving Date', from: '', to: rel.value }, ...(type ? [{ field: 'Type', from: '', to: type }] : [])],
          data: { employee: e, relievingDate: rel.value, ...want, status: status || 'Relieved' },
        });
        return;
      }
      const d = detailOf.get(match.id);
      const changes = [];
      const cmp = (field, cur, next) => { if (next !== null && next !== undefined && String(cur || '') !== String(next)) changes.push({ field, from: cur || '', to: next }); };
      cmp('Type', match.category, type);
      cmp('Resignation Date', d && d.resignationDate, want.resignationDate);
      cmp('Reason', d ? d.reason : match.title, want.reason);
      cmp('Status', match.status, status);
      cmp('Comments', d ? d.comments : match.detail, want.comments);
      out.push({
        line: r.line, label, errors: [], action: changes.length ? 'update' : 'nochange', changes,
        data: { employee: e, record: match, detail: d, ...want },
      });
    });
    return out;
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
          // eslint-disable-next-line no-await-in-loop
          await prisma.$transaction(async (tx) => {
            const rec = await tx.employeeRecord.create({
              data: {
                type: 'RESIGNATION', employeeId: x.employee.id, title: x.type || 'Resignation (history)', detail: x.comments,
                status: x.status, date: x.relievingDate, category: x.type,
              },
            });
            const emp = await tx.employee.findUnique({ where: { id: x.employee.id }, include: { reportingManager: { select: { name: true } } } });
            await tx.resignationDetail.create({
              data: {
                recordId: rec.id, employeeId: emp.id, employeeCode: emp.employeeCode, employeeName: emp.name, department: emp.department,
                designation: emp.designation, reportingManager: (emp.reportingManager && emp.reportingManager.name) || emp.tl || emp.stl || null,
                resignationDate: x.resignationDate || '', requestedLastWorkingDate: x.relievingDate, approvedLastWorkingDate: x.relievingDate,
                reason: x.reason || '', comments: x.comments, submittedByUserId: ctx.user.id, submittedByName: IMPORT_SOURCE,
                exitComments: `Imported by ${actor}${ctx.request ? ` (approved request from ${ctx.request.requestedBy})` : ''}.`,
              },
            });
            await tx.auditLog.create({
              data: {
                userId: ctx.user.id, actorName: actor, action: 'Resignation imported', entity: 'EmployeeRecord', entityId: rec.id,
                toValue: `${x.status} ${x.relievingDate}${x.type ? ` · ${x.type}` : ''}`, reason: `${emp.employeeCode} ${emp.name}`,
              },
            });
          });
          created += 1;
        } else if (v.action === 'update') {
          const recData = {};
          if (x.type) { recData.category = x.type; recData.title = x.type; }
          if (x.status) recData.status = x.status;
          if (x.comments) recData.detail = x.comments;
          const detData = {};
          if (x.resignationDate) detData.resignationDate = x.resignationDate;
          if (x.reason) detData.reason = x.reason;
          if (x.comments) detData.comments = x.comments;
          // eslint-disable-next-line no-await-in-loop
          await prisma.$transaction(async (tx) => {
            if (Object.keys(recData).length) await tx.employeeRecord.update({ where: { id: x.record.id }, data: recData });
            if (x.detail && Object.keys(detData).length) await tx.resignationDetail.update({ where: { id: x.detail.id }, data: detData });
            await tx.auditLog.createMany({
              data: v.changes.map((c) => ({
                userId: ctx.user.id, actorName: actor, action: 'Resignation updated by import', entity: 'EmployeeRecord', entityId: x.record.id,
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
