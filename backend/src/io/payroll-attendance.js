// ---------------------------------------------------------------------------
// PAYROLL — ATTENDANCE INPUT: export (a month's payroll attendance for the
// register in scope / one employee) and import of HR's OVERRIDES
// (utils/moduleIo.js contract).
//
// The import is the bulk twin of PUT /api/payroll/attendance-inputs/:id
// (routes/payrollRuns.js): same rights (Payroll & Compensation / create —
// "prepare"), same payroll scope (payrollEmployeeWhere), same rules (whole
// or half days, within the payroll working days, a reason for every change),
// and refused once that month's payroll for the employee is beyond DRAFT. It
// never calculates, submits or approves anything — recalculate the drafts on
// Process Payroll afterwards. A row whose figures equal what is already in
// force (the attendance default or the current override) changes nothing.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const io = require('../utils/moduleIo');
const E = require('../utils/payrollEngine');
const { monthLabel } = require('../utils/attendanceMath');
const { NOT_SYSTEM_EMPLOYEE } = require('../utils/systemAccounts');
const salary = require('./payroll-salary');

const columns = [
  { key: 'employeeCode', label: 'Employee ID', required: true, example: 'TL101', note: 'Employee ID (or email) of an employee on your payroll register.' },
  { key: 'employeeName', label: 'Employee Name', readOnly: true, example: 'Asha Rao' },
  { key: 'department', label: 'Department', readOnly: true, example: 'Medical' },
  { key: 'month', label: 'Month', required: true, example: '2026-09', note: 'The payroll month: YYYY-MM. Refused when that month\'s payroll for the employee is already submitted / approved / paid.' },
  { key: 'workingDays', label: 'Payroll Days', type: 'number', example: '', note: 'Blank = the month\'s payroll working days from the payroll policy.' },
  { key: 'daysPresent', label: 'Days Present', type: 'number', required: true, example: 20, note: 'Whole or half days, 0 to the payroll days.' },
  { key: 'daysLop', label: 'LOP Days', type: 'number', required: true, example: 2, note: 'Whole or half days, 0 to the payroll days.' },
  { key: 'reason', label: 'Reason', example: 'Approved regularization not yet in attendance', note: 'Required for every row that changes the figures (it is recorded in the audit log).' },
  { key: 'source', label: 'Source', readOnly: true, example: '' },
  { key: 'autoPresent', label: 'Attendance Days Present', type: 'number', readOnly: true, example: '' },
  { key: 'autoLop', label: 'Attendance LOP Days', type: 'number', readOnly: true, example: '' },
  { key: 'payrollStatus', label: 'Payroll Status', readOnly: true, example: '' },
];

const thisMonth = () => new Date().toISOString().slice(0, 7);
function monthOf(v) {
  const s = io.str(v);
  if (!s) return { empty: true };
  if (E.isMonth(s)) return { value: s };
  const d = io.parseDate(s);
  if (d.value) return { value: d.value.slice(0, 7) };
  const mt = /^(\d{1,2})[-/.](\d{4})$/.exec(s);
  if (mt && Number(mt[1]) >= 1 && Number(mt[1]) <= 12) return { value: `${mt[2]}-${String(Number(mt[1])).padStart(2, '0')}` };
  return { error: true };
}

async function fullEmployees(ids) {
  if (!ids.length) return [];
  return prisma.employee.findMany({ where: { AND: [{ id: { in: ids } }, NOT_SYSTEM_EMPLOYEE] }, orderBy: { name: 'asc' } });
}

module.exports = {
  key: 'payroll-attendance',
  label: 'Payroll attendance input',
  module: 'Payroll',
  what: 'payroll attendance inputs',
  feature: 'Payroll & Compensation',
  importActions: ['create'],
  selfExport: false,
  sheet: 'Attendance input',
  entity: 'PayrollAttendance',
  columns,
  instructions: [
    'One row = one employee\'s payroll attendance for one month. A row that changes the figures becomes HR\'s override (exactly like Override on Process Payroll → Attendance input) and needs a Reason.',
    'A row whose figures equal what is already in force is skipped, so the export (every payable employee for the month) can be edited and uploaded back as it is.',
    'Refused once that month\'s payroll for the employee is submitted, approved, synced or paid. Nothing is calculated — recalculate the drafts on Process Payroll afterwards.',
  ],

  async exportRows(ctx, { employeeIds, filters }) {
    const month = E.isMonth(filters.month) ? filters.month : thisMonth();
    let emps = await salary.exportEmployees(ctx, employeeIds, filters);
    if (!io.str(filters.employeeId)) emps = emps.filter((e) => E.PAYABLE_STATUSES.includes(e.employmentStatus));
    const full = await fullEmployees(emps.map((e) => e.id));
    if (!full.length) return [];
    const policy = await E.getPolicy();
    const { map } = await E.attendanceInputs(full, month, policy);
    const runs = await prisma.employeePayrollRun.findMany({ where: { month, employeeId: { in: full.map((e) => e.id) } }, select: { employeeId: true, status: true } });
    const statusOf = new Map(runs.map((r) => [r.employeeId, r.status]));
    return full.map((e) => {
      const a = map.get(e.id) || {};
      const ov = a.override;
      return {
        employeeCode: e.employeeCode || '',
        employeeName: e.name || '',
        department: e.department || '',
        month,
        workingDays: a.workingDays ?? '',
        daysPresent: a.daysPresent ?? '',
        daysLop: a.daysLop ?? '',
        reason: ov ? ov.reason || '' : '',
        source: a.source === 'OVERRIDE' ? `Override (${ov && ov.by ? ov.by : 'HR'})` : 'Attendance',
        autoPresent: ov ? ov.autoDaysPresent ?? '' : a.daysPresent ?? '',
        autoLop: ov ? ov.autoDaysLop ?? '' : a.daysLop ?? '',
        payrollStatus: statusOf.has(e.id) ? E.STATUS_LABEL[statusOf.get(e.id)] || statusOf.get(e.id) : '',
      };
    });
  },

  async validate(rows, ctx) {
    const idx = await salary.payrollIndex(ctx.req);
    const policy = await E.getPolicy();
    const parsed = rows.map((r) => ({ r, hit: idx.resolve(r.employeeCode), month: monthOf(r.month) }));
    // What is in force today, per month, for the employees named.
    const byMonth = new Map();
    parsed.forEach((p) => {
      if (!p.hit.employee || !p.month.value) return;
      if (!byMonth.has(p.month.value)) byMonth.set(p.month.value, new Set());
      byMonth.get(p.month.value).add(p.hit.employee.id);
    });
    const current = new Map(); // `${id}|${month}` -> { input, status, workingDays }
    // eslint-disable-next-line no-restricted-syntax
    for (const [month, set] of byMonth) {
      // eslint-disable-next-line no-await-in-loop
      const full = await fullEmployees([...set]);
      // eslint-disable-next-line no-await-in-loop
      const [{ workingDays, map }, runs] = await Promise.all([
        E.attendanceInputs(full, month, policy),
        prisma.employeePayrollRun.findMany({ where: { month, employeeId: { in: [...set] } }, select: { employeeId: true, status: true } }),
      ]);
      const statusOf = new Map(runs.map((x) => [x.employeeId, x.status]));
      full.forEach((e) => current.set(`${e.id}|${month}`, { input: map.get(e.id) || {}, status: statusOf.get(e.id) || null, workingDays }));
    }
    const seen = new Map();
    return parsed.map(({ r, hit, month }) => {
      const errors = io.requiredErrors(module.exports, r);
      const e = hit.employee;
      const label = e ? `${e.name} (${e.employeeCode})` : io.str(r.employeeCode);
      if (hit.error && io.str(r.employeeCode)) errors.push({ field: 'Employee ID', message: hit.error });
      if (month.error) errors.push({ field: 'Month', message: `"${r.month}" is not a month (YYYY-MM).` });
      const num = (key, label2) => {
        const p = io.parseNumber(r[key]);
        if (p.empty) return null;
        if (p.error) { errors.push({ field: label2, message: `"${r[key]}" is not a number.` }); return null; }
        return p.value;
      };
      const wdIn = num('workingDays', 'Payroll Days');
      const present = num('daysPresent', 'Days Present');
      const lop = num('daysLop', 'LOP Days');
      const cur = e && month.value ? current.get(`${e.id}|${month.value}`) : null;
      if (e && month.value) {
        const k = `${e.id}|${month.value}`;
        if (seen.has(k)) errors.push({ field: 'Month', message: `Same employee and month as row ${seen.get(k)}.` });
        else seen.set(k, r.line);
      }
      if (errors.length || !cur) return { line: r.line, label, errors: errors.length ? errors : [{ field: 'Employee ID', message: 'Could not read this row.' }], action: 'error' };
      const wd = wdIn !== null ? wdIn : cur.workingDays;
      if (!Number.isFinite(wd) || wd <= 0 || wd > 31) errors.push({ field: 'Payroll Days', message: 'Payroll days must be between 1 and 31.' });
      if (present < 0 || present > wd) errors.push({ field: 'Days Present', message: `Days present must be between 0 and ${wd}.` });
      if (lop < 0 || lop > wd) errors.push({ field: 'LOP Days', message: `LOP days must be between 0 and ${wd}.` });
      if ((present * 2) % 1 || (lop * 2) % 1) errors.push({ field: 'Days Present', message: 'Days are whole or half days.' });
      const inForce = cur.input;
      const same = Number(inForce.workingDays) === Number(wd) && Number(inForce.daysPresent) === Number(present) && Number(inForce.daysLop) === Number(lop);
      if (!errors.length && same) return { line: r.line, label, errors: [], action: 'nochange', changes: [] };
      if (cur.status && cur.status !== 'DRAFT') {
        errors.push({ field: 'Month', message: `${e.name}'s ${monthLabel(month.value)} payroll is ${E.STATUS_LABEL[cur.status] || cur.status} — attendance can only be changed while it is a draft.` });
      }
      const reason = io.str(r.reason).slice(0, 500);
      if (!reason) errors.push({ field: 'Reason', message: 'A reason is required for an attendance override.' });
      if (errors.length) return { line: r.line, label, errors, action: 'error' };
      const changes = [];
      if (Number(inForce.workingDays) !== Number(wd)) changes.push({ field: 'Payroll Days', from: inForce.workingDays ?? '', to: wd });
      if (Number(inForce.daysPresent) !== Number(present)) changes.push({ field: 'Days Present', from: inForce.daysPresent ?? '', to: present });
      if (Number(inForce.daysLop) !== Number(lop)) changes.push({ field: 'LOP Days', from: inForce.daysLop ?? '', to: lop });
      return {
        line: r.line, label, errors: [], action: inForce.source === 'OVERRIDE' ? 'update' : 'create', changes,
        data: { employee: e, month: month.value, workingDays: wd, daysPresent: present, daysLop: lop, reason },
      };
    });
  },

  async apply(valid, ctx) {
    let created = 0;
    let updated = 0;
    const failed = [];
    const policy = await E.getPolicy();
    const actorName = ctx.user.name || ctx.user.email;
    // eslint-disable-next-line no-restricted-syntax
    for (const v of valid) {
      const x = v.data;
      try {
        // eslint-disable-next-line no-await-in-loop
        const [emp] = await fullEmployees([x.employee.id]);
        if (!emp) throw new Error('employee not found');
        // eslint-disable-next-line no-await-in-loop
        const locked = await prisma.employeePayrollRun.findUnique({ where: { employeeId_month: { employeeId: emp.id, month: x.month } } });
        if (locked && locked.status !== 'DRAFT') throw new Error(`the ${monthLabel(x.month)} payroll is ${E.STATUS_LABEL[locked.status]} — no longer a draft`);
        // eslint-disable-next-line no-await-in-loop
        const { map } = await E.attendanceDefaults([emp], x.month, policy);
        const auto = map.get(emp.id) || {};
        // eslint-disable-next-line no-await-in-loop
        const prev = await prisma.payrollAttendance.findUnique({ where: { employeeId_month: { employeeId: emp.id, month: x.month } } });
        const { year, monthNum } = E.monthParts(x.month);
        const data = {
          year, monthNum, workingDays: x.workingDays, daysPresent: x.daysPresent, daysLop: x.daysLop,
          autoDaysPresent: auto.daysPresent, autoDaysLop: auto.daysLop, reason: x.reason,
          overriddenBy: ctx.user.id, overriddenByName: actorName, overriddenAt: new Date(),
        };
        // eslint-disable-next-line no-await-in-loop
        const row = await prisma.payrollAttendance.upsert({
          where: { employeeId_month: { employeeId: emp.id, month: x.month } }, update: data, create: { employeeId: emp.id, month: x.month, ...data },
        });
        const from = prev ? `present ${prev.daysPresent}, LOP ${prev.daysLop} (override)` : `present ${auto.daysPresent}, LOP ${auto.daysLop} (attendance)`;
        // eslint-disable-next-line no-await-in-loop
        await prisma.auditLog.create({
          data: {
            userId: ctx.user.id, actorName, action: 'Payroll attendance overridden (import)', entity: 'PayrollAttendance', entityId: row.id,
            field: 'attendance', fieldLabel: `${emp.name} · ${monthLabel(x.month)}`, fromValue: from,
            toValue: `present ${x.daysPresent}, LOP ${x.daysLop} of ${x.workingDays}`, reason: x.reason,
          },
        });
        if (prev) updated += 1; else created += 1;
      } catch (err) {
        failed.push({ line: v.line, reason: String(err.message || err).split('\n').pop().slice(0, 200) });
      }
    }
    return { created, updated, skipped: 0, failed };
  },
};
