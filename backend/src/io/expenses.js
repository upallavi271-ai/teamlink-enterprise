// ---------------------------------------------------------------------------
// EXPENSE & TRAVEL CLAIMS (HRMS EmployeeRecord type EXPENSE, /api/expenses)
// — export (everyone in scope / one employee) and import of HISTORICAL
// claims (utils/moduleIo.js contract). Not the Accounts "Office & Expenses"
// module.
//
// An import records claims only: no bill/receipt file (attach it on the
// claim afterwards), no approval step, no notification, no email, nothing
// posted to Accounts. Rights: Employee Services create + approve — filing a
// claim for somebody else is a write on them, and an imported claim may carry
// a decided status (Approved / Reimbursed / Rejected).
// Match: the employee + the claim date + the description. The same three ->
// that claim is UPDATED (blank cells never overwrite); otherwise a new claim.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const io = require('../utils/moduleIo');

const CATEGORIES = ['Food', 'Travel', 'Accommodation', 'Other'];
const STATUSES = ['Pending', 'Approved', 'Reimbursed', 'Rejected'];

const columns = [
  { key: 'employeeCode', label: 'Employee ID', required: true, example: 'TL101', note: 'Employee ID (or email) of an employee in your scope.' },
  { key: 'employeeName', label: 'Employee Name', readOnly: true, example: 'Asha Rao' },
  { key: 'department', label: 'Department', readOnly: true, example: 'Medical' },
  { key: 'date', label: 'Date', type: 'date', required: true, example: '2026-08-14', note: 'The date of the expense.' },
  { key: 'title', label: 'Description', required: true, example: 'Client visit — cab fare', note: 'With the Employee ID and Date, this identifies the claim: the same three update that claim.' },
  { key: 'category', label: 'Category', list: 'Category', example: 'Travel' },
  { key: 'location', label: 'Location', example: 'Hyderabad' },
  { key: 'amount', label: 'Amount', type: 'number', required: true, example: 850, note: 'Rupees, more than 0.' },
  { key: 'status', label: 'Status', list: 'Status', example: 'Reimbursed', note: 'Blank = Pending (new claims).' },
  { key: 'detail', label: 'Notes', example: '' },
  { key: 'bill', label: 'Bill / Receipt', readOnly: true, example: '' },
];

function rowOf(r) {
  return {
    employeeCode: r.employee ? r.employee.employeeCode : '',
    employeeName: r.employee ? r.employee.name : '',
    department: r.employee ? r.employee.department || '' : '',
    date: r.date || '',
    title: r.title || '',
    category: r.category || '',
    location: r.location || '',
    amount: r.amount ?? '',
    status: r.status === 'Open' ? 'Pending' : r.status,
    detail: r.detail || '',
    bill: r.billName ? `Attached: ${r.billName}` : 'None',
  };
}

const keyOf = (employeeId, date, title) => `${employeeId}|${date}|${io.str(title).toLowerCase()}`;

module.exports = {
  key: 'expenses',
  label: 'Expense claims',
  module: 'Expense & Travel Claims',
  what: 'expense claims',
  feature: 'Employee Services',
  importActions: ['create', 'approve'],
  sheet: 'Expense claims',
  entity: 'EmployeeRecord',
  columns,
  instructions: [
    'An import records expense claims only — no bill/receipt file (attach it on the claim afterwards), no approval step, no notification and nothing is posted to Accounts.',
    'A row with the same Employee ID, Date and Description as an existing claim updates it; blank cells never overwrite.',
  ],
  lists: async () => ({ Category: CATEGORIES, Status: STATUSES }),

  async exportRows(ctx, { employeeIds, filters }) {
    const where = { type: 'EXPENSE', employeeId: { in: employeeIds } };
    const recs = await prisma.employeeRecord.findMany({ where, include: { employee: true }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }] });
    const from = io.parseDate(filters.from).value;
    const to = io.parseDate(filters.to).value;
    const status = io.str(filters.status);
    const category = io.str(filters.category);
    return recs.map(rowOf)
      .filter((r) => (!from || (r.date && r.date >= from)) && (!to || (r.date && r.date <= to)))
      .filter((r) => (!status || r.status === status) && (!category || r.category === category));
  },

  async validate(rows, ctx) {
    const resolved = rows.map((r) => ctx.employees.resolve(r.employeeCode));
    const empIds = [...new Set(resolved.filter((h) => h.employee).map((h) => h.employee.id))];
    const existing = empIds.length ? await prisma.employeeRecord.findMany({ where: { type: 'EXPENSE', employeeId: { in: empIds } } }) : [];
    const byKey = new Map(existing.map((x) => [keyOf(x.employeeId, x.date || '', x.title), x]));
    const seen = new Map();
    return rows.map((r, i) => {
      const errors = io.requiredErrors(module.exports, r);
      const hit = resolved[i];
      const e = hit.employee;
      const label = e ? `${e.name} (${e.employeeCode})` : io.str(r.employeeCode);
      if (hit.error && io.str(r.employeeCode)) errors.push({ field: 'Employee ID', message: hit.error });
      const date = io.parseDate(r.date);
      if (date.error) errors.push({ field: 'Date', message: `"${r.date}" is not a date (YYYY-MM-DD).` });
      const amount = io.parseNumber(r.amount);
      if (amount.error || (amount.value !== undefined && !(amount.value > 0))) errors.push({ field: 'Amount', message: `"${r.amount}" must be an amount more than 0.` });
      const category = io.str(r.category) ? io.pick(CATEGORIES, r.category) : null;
      if (io.str(r.category) && !category) errors.push({ field: 'Category', message: `"${r.category}" is not one of ${CATEGORIES.join(', ')}.` });
      const status = io.str(r.status) ? io.pick(STATUSES, r.status) : null;
      if (io.str(r.status) && !status) errors.push({ field: 'Status', message: `"${r.status}" is not one of ${STATUSES.join(', ')}.` });
      const title = io.str(r.title).slice(0, 300);
      if (e && date.value && title) {
        const k = keyOf(e.id, date.value, title);
        if (seen.has(k)) errors.push({ field: 'Description', message: `Same employee, date and description as row ${seen.get(k)}.` });
        else seen.set(k, r.line);
      }
      if (errors.length) return { line: r.line, label, errors, action: 'error' };
      const want = {
        category, location: io.str(r.location) || null, amount: amount.value, status, detail: io.str(r.detail) || null,
      };
      const match = byKey.get(keyOf(e.id, date.value, title));
      if (!match) {
        return {
          line: r.line, label, errors: [], action: 'create',
          changes: [{ field: 'Date', from: '', to: date.value }, { field: 'Amount', from: '', to: amount.value }, { field: 'Status', from: '', to: status || 'Pending' }],
          data: { employee: e, date: date.value, title, ...want, status: status || 'Pending' },
        };
      }
      const changes = [];
      const cmp = (field, cur, next) => { if (next !== null && next !== undefined && String(cur ?? '') !== String(next)) changes.push({ field, from: cur ?? '', to: next }); };
      cmp('Category', match.category, want.category);
      cmp('Location', match.location, want.location);
      cmp('Amount', match.amount, want.amount);
      cmp('Status', match.status === 'Open' ? 'Pending' : match.status, want.status);
      cmp('Notes', match.detail, want.detail);
      return {
        line: r.line, label, errors: [], action: changes.length ? 'update' : 'nochange', changes,
        data: { employee: e, record: match, ...want },
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
      const x = v.data;
      try {
        if (v.action === 'create') {
          // eslint-disable-next-line no-await-in-loop
          await prisma.$transaction(async (tx) => {
            const rec = await tx.employeeRecord.create({
              data: {
                type: 'EXPENSE', employeeId: x.employee.id, title: x.title, detail: x.detail, status: x.status,
                date: x.date, amount: x.amount, category: x.category, location: x.location,
              },
            });
            await tx.auditLog.create({
              data: {
                userId: ctx.user.id, actorName: actor, action: 'Expense claim imported', entity: 'EmployeeRecord', entityId: rec.id,
                toValue: `${x.status} ${x.date} · ₹${x.amount}${x.category ? ` · ${x.category}` : ''}`, reason: `${x.employee.employeeCode} ${x.employee.name}`,
              },
            });
          });
          created += 1;
        } else if (v.action === 'update') {
          const data = {};
          if (x.category) data.category = x.category;
          if (x.location) data.location = x.location;
          if (x.amount !== undefined && x.amount !== null) data.amount = x.amount;
          if (x.status) data.status = x.status;
          if (x.detail) data.detail = x.detail;
          // eslint-disable-next-line no-await-in-loop
          await prisma.$transaction(async (tx) => {
            await tx.employeeRecord.update({ where: { id: x.record.id }, data });
            await tx.auditLog.createMany({
              data: v.changes.map((c) => ({
                userId: ctx.user.id, actorName: actor, action: 'Expense claim updated by import', entity: 'EmployeeRecord', entityId: x.record.id,
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
