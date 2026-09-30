// ---------------------------------------------------------------------------
// SHIFT ROSTER — export (everyone in scope / one employee) and import of
// roster rows (utils/moduleIo.js contract). The rows are EmployeeRecord type
// SHIFT, exactly what the Shift Roster screen writes (routes/employeeRecords.js
// mounted at /api/shift-roster): title = the shift pattern's name, date = the
// shift date, detail = notes, status Scheduled | Completed.
//
// Match: the employee + the date (one rostered shift per person per day).
// Same employee and date -> the row is UPDATED (blank cells never overwrite);
// otherwise a new row is created. An import sends nothing: no in-app notice,
// no email (the screen's "Roster a Shift" delivery is not run).
//
// Rights: writing a roster row for someone else is an Employee Services
// create on the screen, so an import asks the same. A TL is refused the
// whole Shift Roster (access matrix 2026-09-25 §7), here as on the API.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const io = require('../utils/moduleIo');

const STATUSES = ['Scheduled', 'Completed'];
const TYPE = 'SHIFT';

const columns = [
  { key: 'employeeCode', label: 'Employee ID', required: true, example: 'TL101', note: 'Employee ID (or email) of an employee in your scope.' },
  { key: 'employeeName', label: 'Employee Name', readOnly: true, example: 'Asha Rao' },
  { key: 'department', label: 'Department', readOnly: true, example: 'Medical' },
  { key: 'date', label: 'Date', type: 'date', required: true, example: '2026-10-05', note: 'The shift date.' },
  { key: 'shift', label: 'Shift', required: true, list: 'Shift', example: 'General', note: 'A shift pattern name (Shift Roster → Shift Patterns).' },
  { key: 'timing', label: 'Shift Timing', readOnly: true, example: '09:30 – 18:30' },
  { key: 'status', label: 'Status', list: 'Status', example: 'Scheduled', note: 'Blank = Scheduled.' },
  { key: 'notes', label: 'Notes', example: '' },
];

const isTl = (user) => !!user && user.hrmsRole === 'TL';

module.exports = {
  key: 'shift-roster',
  label: 'Shift roster',
  module: 'Shift Roster',
  what: 'shift roster entries',
  feature: 'Employee Services',
  importActions: ['create'],
  sheet: 'Shift roster',
  entity: 'EmployeeRecord',
  columns,
  instructions: [
    'One row = one person\'s shift on one date. A row with the same Employee ID and Date as an existing roster entry updates it; blank cells never overwrite.',
    'Nobody is notified by an import (no in-app notice, no email).',
  ],

  async caps(user, base) {
    if (!isTl(user)) return base;
    return {
      ...base, canView: false, canExport: false, selfExport: false, canImport: false, allowRequest: false,
      importBlockedReason: "The Shift Roster isn't included in a TL's permissions.",
    };
  },

  async lists() {
    const patterns = await prisma.shiftPattern.findMany({ where: { active: true }, orderBy: { startTime: 'asc' } });
    return { Shift: patterns.map((p) => p.name), Status: STATUSES };
  },

  async exportRows(ctx, { employeeIds, filters }) {
    if (isTl(ctx.user)) return [];
    const where = { type: TYPE, employeeId: { in: employeeIds } };
    const from = io.parseDate(filters.from).value;
    const to = io.parseDate(filters.to).value;
    if (from || to) where.date = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
    if (filters.status) where.status = String(filters.status);
    const [recs, patterns] = await Promise.all([
      prisma.employeeRecord.findMany({ where, include: { employee: true }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }] }),
      prisma.shiftPattern.findMany(),
    ]);
    const byName = new Map(patterns.map((p) => [io.loose(p.name), p]));
    return recs.map((r) => {
      const p = byName.get(io.loose(r.title));
      return {
        employeeCode: r.employee ? r.employee.employeeCode : '',
        employeeName: r.employee ? r.employee.name : '',
        department: r.employee ? r.employee.department || '' : '',
        date: r.date || '',
        shift: r.title || '',
        timing: p ? `${p.startTime} – ${p.endTime}` : '',
        status: r.status || '',
        notes: r.detail || '',
      };
    });
  },

  async validate(rows, ctx) {
    const patterns = await prisma.shiftPattern.findMany();
    const names = patterns.map((p) => p.name);
    const resolved = rows.map((r) => ctx.employees.resolve(r.employeeCode));
    const empIds = [...new Set(resolved.filter((h) => h.employee).map((h) => h.employee.id))];
    const existing = empIds.length
      ? await prisma.employeeRecord.findMany({ where: { type: TYPE, employeeId: { in: empIds } }, orderBy: { createdAt: 'asc' } })
      : [];
    const seen = new Map();
    return rows.map((r, i) => {
      const errors = io.requiredErrors(module.exports, r);
      const hit = resolved[i];
      if (hit.error && io.str(r.employeeCode)) errors.push({ field: 'Employee ID', message: hit.error });
      const e = hit.employee;
      const d = io.parseDate(r.date);
      if (d.error) errors.push({ field: 'Date', message: `"${r.date}" is not a date (YYYY-MM-DD).` });
      const shift = io.str(r.shift) ? io.pick(names, r.shift) : null;
      if (io.str(r.shift) && !shift) errors.push({ field: 'Shift', message: `"${r.shift}" is not a shift pattern (${names.join(', ') || 'none defined yet'}).` });
      const status = io.str(r.status) ? io.pick(STATUSES, r.status) : null;
      if (io.str(r.status) && !status) errors.push({ field: 'Status', message: `"${r.status}" is not one of ${STATUSES.join(', ')}.` });
      if (e && d.value) {
        const k = `${e.id}|${d.value}`;
        if (seen.has(k)) errors.push({ field: 'Date', message: `Same employee and date as row ${seen.get(k)}.` });
        else seen.set(k, r.line);
      }
      const label = e ? `${e.name} (${e.employeeCode})` : io.str(r.employeeCode);
      if (errors.length) return { line: r.line, label, errors, action: 'error' };
      const notes = io.str(r.notes) || null;
      const match = existing.find((x) => x.employeeId === e.id && (x.date || '') === d.value);
      if (!match) {
        return {
          line: r.line, label, errors: [], action: 'create',
          changes: [{ field: 'Date', from: '', to: d.value }, { field: 'Shift', from: '', to: shift }],
          data: { employee: e, date: d.value, shift, status: status || 'Scheduled', notes },
        };
      }
      const changes = [];
      const cmp = (field, cur, next) => { if (next !== null && next !== undefined && String(cur || '') !== String(next)) changes.push({ field, from: cur || '', to: next }); };
      cmp('Shift', match.title, shift);
      cmp('Status', match.status, status);
      cmp('Notes', match.detail, notes);
      return {
        line: r.line, label, errors: [], action: changes.length ? 'update' : 'nochange', changes,
        data: { employee: e, record: match, shift, status, notes },
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
          // eslint-disable-next-line no-await-in-loop
          await prisma.$transaction(async (tx) => {
            const rec = await tx.employeeRecord.create({
              data: { type: TYPE, employeeId: x.employee.id, title: x.shift, date: x.date, status: x.status, detail: x.notes },
            });
            await tx.auditLog.create({
              data: {
                userId: ctx.user.id, actorName: actor, action: 'Shift rostered by import', entity: 'EmployeeRecord', entityId: rec.id,
                toValue: `${x.date} · ${x.shift} · ${x.status}`, reason: `${x.employee.employeeCode} ${x.employee.name}`,
              },
            });
          });
          created += 1;
        } else if (v.action === 'update') {
          const data = {};
          if (x.shift) data.title = x.shift;
          if (x.status) data.status = x.status;
          if (x.notes) data.detail = x.notes;
          // eslint-disable-next-line no-await-in-loop
          await prisma.$transaction(async (tx) => {
            await tx.employeeRecord.update({ where: { id: x.record.id }, data });
            await tx.auditLog.createMany({
              data: v.changes.map((c) => ({
                userId: ctx.user.id, actorName: actor, action: 'Shift roster updated by import', entity: 'EmployeeRecord', entityId: x.record.id,
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
