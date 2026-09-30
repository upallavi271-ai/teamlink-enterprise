// ---------------------------------------------------------------------------
// LEAVE BALANCES — export (everyone in scope / one employee) and import of the
// per-employee, per-leave-type balance (LeaveBalance: total = the entitlement
// for the current leave year, taken = days availed). utils/moduleIo.js
// contract.
//
// It is the spreadsheet form of the Leave screen's balance override
// (PUT /api/leave/balances/:employeeId, which asks Leave & Holidays /
// configure), so an import asks the same right. Match: employee + leave type
// (the table's own unique key). Blank cells never overwrite; a row creating a
// balance with a blank Total gets the leave type's entitlement, as the screen's
// lazily-created balances do (routes/leave.js ensureBalances()).
// Nothing is sent to anybody.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const io = require('../utils/moduleIo');

const MAX_DAYS = 1000;

const columns = [
  { key: 'employeeCode', label: 'Employee ID', required: true, example: 'TL101', note: 'Employee ID (or email) of an employee in your scope.' },
  { key: 'name', label: 'Name', readOnly: true, example: 'Asha Rao' },
  { key: 'department', label: 'Department', readOnly: true, example: 'Medical' },
  { key: 'type', label: 'Leave Type', required: true, list: 'Leave Type', example: 'Casual Leave' },
  { key: 'total', label: 'Total', type: 'number', example: 12, note: 'The entitlement for the current leave year, in days.' },
  { key: 'taken', label: 'Taken', type: 'number', example: 3, note: 'Days already availed this leave year.' },
  { key: 'remaining', label: 'Remaining', readOnly: true, example: 9 },
];

const round2 = (n) => Math.round(Number(n) * 100) / 100;
function annualEntitlement(t) {
  if (!t || t.unit === 'unpaid') return 0;
  return t.unit === 'month' ? Number(t.cap || 0) * 12 : Number(t.cap || 0);
}

module.exports = {
  key: 'leave-balances',
  label: 'Leave balances',
  module: 'Leave',
  what: 'leave balances',
  feature: 'Leave & Holidays',
  importActions: ['configure'],
  sheet: 'Leave balances',
  entity: 'LeaveBalance',
  columns,
  instructions: [
    'One row = one employee and one leave type. Give Total, Taken or both; a blank cell keeps the value on record.',
    'Balances are for the current leave (calendar) year. Remaining = Total − Taken and is calculated, never imported.',
    'Nobody is notified by an import.',
  ],

  async lists() {
    const types = await prisma.leaveType.findMany({ where: { active: true }, orderBy: { name: 'asc' } });
    return { 'Leave Type': types.map((t) => t.name) };
  },

  async exportRows(ctx, { employeeIds, filters }) {
    const types = await prisma.leaveType.findMany({ where: { active: true }, orderBy: { name: 'asc' } });
    const wanted = filters.type ? types.filter((t) => t.name === String(filters.type) || t.code === String(filters.type)) : types;
    const bals = await prisma.leaveBalance.findMany({ where: { employeeId: { in: employeeIds } } });
    const key = new Map(bals.map((b) => [`${b.employeeId}|${b.type}`, b]));
    const one = employeeIds.length === 1;
    const out = [];
    employeeIds.forEach((id) => {
      const e = ctx.employees.byId.get(id);
      if (!e) return;
      // The balance grid leaves relieved people out; one named employee is always shown.
      if (!one && e.employmentStatus === 'Relieved') return;
      wanted.forEach((t) => {
        const b = key.get(`${id}|${t.name}`);
        out.push({
          employeeCode: e.employeeCode, name: e.name, department: e.department || '', type: t.name,
          total: b ? b.total : '', taken: b ? b.taken : '', remaining: b ? Math.max(0, round2(b.total - b.taken)) : '',
        });
      });
    });
    return out;
  },

  async validate(rows, ctx) {
    const types = await prisma.leaveType.findMany();
    const names = types.map((t) => t.name);
    const resolved = rows.map((r) => ctx.employees.resolve(r.employeeCode));
    const empIds = [...new Set(resolved.filter((h) => h.employee).map((h) => h.employee.id))];
    const existing = empIds.length ? await prisma.leaveBalance.findMany({ where: { employeeId: { in: empIds } } }) : [];
    const seen = new Map();
    return rows.map((r, i) => {
      const errors = io.requiredErrors(module.exports, r);
      const hit = resolved[i];
      if (hit.error && io.str(r.employeeCode)) errors.push({ field: 'Employee ID', message: hit.error });
      const e = hit.employee;
      const type = io.str(r.type) ? io.pick(names, r.type) : null;
      if (io.str(r.type) && !type) errors.push({ field: 'Leave Type', message: `"${r.type}" is not a leave type (${names.join(', ')}).` });
      const num = (field, v) => {
        const n = io.parseNumber(v);
        if (n.error) { errors.push({ field, message: `"${v}" is not a number.` }); return null; }
        if (n.value === undefined) return null;
        if (n.value < 0 || n.value > MAX_DAYS) { errors.push({ field, message: `${field} must be between 0 and ${MAX_DAYS} days.` }); return null; }
        if (Math.round(n.value * 2) !== n.value * 2) { errors.push({ field, message: `${field} must be whole or half days.` }); return null; }
        return round2(n.value);
      };
      const total = num('Total', r.total);
      const taken = num('Taken', r.taken);
      if (total === null && taken === null && !errors.some((x) => x.field === 'Total' || x.field === 'Taken')) {
        errors.push({ field: 'Total', message: 'Give a Total, a Taken, or both.' });
      }
      if (e && type) {
        const k = `${e.id}|${type}`;
        if (seen.has(k)) errors.push({ field: 'Leave Type', message: `Same employee and leave type as row ${seen.get(k)}.` });
        else seen.set(k, r.line);
      }
      const label = e ? `${e.name} (${e.employeeCode}) · ${type || io.str(r.type)}` : io.str(r.employeeCode);
      if (errors.length) return { line: r.line, label, errors, action: 'error' };
      const match = existing.find((b) => b.employeeId === e.id && b.type === type);
      if (!match) {
        const t = types.find((x) => x.name === type);
        const tot = total !== null ? total : annualEntitlement(t);
        return {
          line: r.line, label, errors: [], action: 'create',
          changes: [{ field: 'Total', from: '', to: tot }, { field: 'Taken', from: '', to: taken || 0 }],
          data: { employee: e, type, total: tot, taken: taken || 0 },
        };
      }
      const changes = [];
      if (total !== null && total !== match.total) changes.push({ field: 'Total', from: match.total, to: total });
      if (taken !== null && taken !== match.taken) changes.push({ field: 'Taken', from: match.taken, to: taken });
      return {
        line: r.line, label, errors: [], action: changes.length ? 'update' : 'nochange', changes,
        data: { employee: e, type, balance: match, total, taken },
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
        // eslint-disable-next-line no-await-in-loop
        await prisma.$transaction(async (tx) => {
          let bal;
          if (v.action === 'create') {
            bal = await tx.leaveBalance.upsert({
              where: { employeeId_type: { employeeId: x.employee.id, type: x.type } },
              update: { total: x.total, taken: x.taken },
              create: { employeeId: x.employee.id, type: x.type, total: x.total, taken: x.taken },
            });
          } else {
            const data = {};
            if (x.total !== null) data.total = x.total;
            if (x.taken !== null) data.taken = x.taken;
            bal = await tx.leaveBalance.update({ where: { id: x.balance.id }, data });
          }
          await tx.auditLog.createMany({
            data: v.changes.map((c) => ({
              userId: ctx.user.id, actorName: actor, action: v.action === 'create' ? 'Leave balance imported' : 'Leave balance updated by import',
              entity: 'LeaveBalance', entityId: bal.id, field: c.field, fieldLabel: `${x.type} ${c.field}`,
              fromValue: String(c.from ?? ''), toValue: String(c.to ?? ''), reason: `${x.employee.employeeCode} ${x.employee.name}`,
            })),
          });
        });
        if (v.action === 'create') created += 1; else updated += 1;
      } catch (err) {
        failed.push({ line: v.line, reason: String(err.message || err).split('\n').pop().slice(0, 200) });
      }
    }
    return { created, updated, skipped: 0, failed };
  },
};
