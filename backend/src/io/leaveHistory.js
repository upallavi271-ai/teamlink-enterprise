// ---------------------------------------------------------------------------
// LEAVE HISTORY — import of DECIDED (historical) leave requests
// (utils/moduleIo.js contract). The export is the Leave screen's own
// GET /api/insights/leave/export (scoped, filters applied, ?employeeId= for
// one employee), and THE COLUMN NAMES HERE ARE THAT EXPORT'S HEADERS — so an
// exported file can be corrected and imported back as it is.
//
// WHAT AN IMPORT NEVER DOES
//   * start an approval chain — only Approved / Rejected / Cancelled rows are
//     accepted; a Pending request goes through Apply Leave, where the chain
//     runs (routes/leave.js starts a chain only for a Pending request);
//   * notify or email anybody;
//   * change the status or days of an existing request in a way that moves the
//     balance — that is done on the Leave screen (Cancel / decide), which keeps
//     the balance right; an open (Pending / Cancellation Requested) request is
//     not touched at all.
//
// THE BALANCE (the rule routes/leave.js /:id/decision applies): an Approved
// leave draws its days down from the employee's balance for that leave type.
// The balances on file are the CURRENT leave (calendar) year's
// (utils/leavePolicy.js monthlyFor), so an imported Approved leave starting in
// the current year draws the balance down exactly as an approval would, and
// one from an earlier year does not. If the balance you hold already counts
// those days, import the history first and then correct the balance with the
// Leave Balances import.
//
// Match: employee + leave type + From + To (scripts/import-leave-history.js's
// key). Same four -> the request is UPDATED (blank cells never overwrite).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const io = require('../utils/moduleIo');

const STATUSES = ['Approved', 'Rejected', 'Cancelled'];
const OPEN = ['Pending', 'Cancellation Requested'];
const IMPORTED_BY = 'Imported from spreadsheet';
const DEDUCTED = 'Leave imported — drawn from balance';

const columns = [
  { key: 'employeeCode', label: 'Employee ID', required: true, example: 'TL101', note: 'Employee ID (or email) of an employee in your scope.' },
  { key: 'name', label: 'Name', readOnly: true, example: 'Asha Rao' },
  { key: 'department', label: 'Department', readOnly: true, example: 'Medical' },
  { key: 'type', label: 'Leave Type', required: true, list: 'Leave Type', example: 'Casual Leave' },
  { key: 'fromDate', label: 'From', type: 'date', required: true, example: '2026-03-02' },
  { key: 'toDate', label: 'To', type: 'date', required: true, example: '2026-03-03' },
  { key: 'days', label: 'Days', type: 'number', example: 2, note: 'Blank = the calendar days From→To. 0.5 for a half day.' },
  { key: 'status', label: 'Status', list: 'Status', example: 'Approved', note: 'Approved, Rejected or Cancelled (blank = Approved). Pending requests are applied on the Leave screen instead.' },
  { key: 'reason', label: 'Reason', example: 'Family function' },
  { key: 'appliedOn', label: 'Applied On', type: 'date', example: '2026-02-25' },
  { key: 'decidedBy', label: 'Decided By', example: 'Ravi Kumar', note: 'Who approved / rejected it in the old system. Blank = "Imported from spreadsheet".' },
  { key: 'decidedOn', label: 'Decided On', type: 'date', example: '2026-02-26' },
];

const round2 = (n) => Math.round(Number(n) * 100) / 100;
function daySpan(from, to) {
  const a = new Date(`${from}T00:00:00Z`);
  const b = new Date(`${to}T00:00:00Z`);
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}
const ymd = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const currentYear = () => String(new Date().getFullYear());

// routes/leave.js annualEntitlement() / ensureBalances(), for one employee.
function annualEntitlement(t) {
  if (!t || t.unit === 'unpaid') return 0;
  return t.unit === 'month' ? Number(t.cap || 0) * 12 : Number(t.cap || 0);
}
async function ensureBalances(tx, employeeId) {
  const types = (await tx.leaveType.findMany()).filter((t) => t.active);
  const have = new Set((await tx.leaveBalance.findMany({ where: { employeeId }, select: { type: true } })).map((b) => b.type));
  const missing = types.filter((t) => !have.has(t.name)).map((t) => ({ employeeId, type: t.name, total: annualEntitlement(t), taken: 0 }));
  if (missing.length) await tx.leaveBalance.createMany({ data: missing });
}

module.exports = {
  key: 'leave-history',
  label: 'Leave requests',
  module: 'Leave',
  what: 'leave requests',
  feature: 'Leave & Holidays',
  importActions: ['create', 'approve'],
  sheet: 'Leave requests',
  entity: 'LeaveRequest',
  exportVia: '/insights/leave/export',
  columns,
  instructions: [
    'An import records leave HISTORY: only Approved, Rejected or Cancelled requests; no approval chain is started and nobody is notified or emailed.',
    'An Approved leave starting in the current year draws its days down from the leave balance, as an approval does; earlier years do not touch the balance.',
    'A row with the same Employee ID, Leave Type, From and To as an existing request updates it; blank cells never overwrite. Status or Days changes that would move the balance are made on the Leave screen instead.',
    'The Leave screen\'s Export produces this same layout, so an exported file can be corrected and imported back.',
  ],

  async lists() {
    const types = await prisma.leaveType.findMany({ orderBy: { name: 'asc' } });
    return { 'Leave Type': types.filter((t) => t.active).map((t) => t.name), Status: STATUSES };
  },

  async validate(rows, ctx) {
    const typeNames = (await prisma.leaveType.findMany()).map((t) => t.name);
    const resolved = rows.map((r) => ctx.employees.resolve(r.employeeCode));
    const empIds = [...new Set(resolved.filter((h) => h.employee).map((h) => h.employee.id))];
    const existing = empIds.length ? await prisma.leaveRequest.findMany({ where: { employeeId: { in: empIds } } }) : [];
    const seen = new Map();
    const approvedInFile = []; // { empId, from, to, line }
    return rows.map((r, i) => {
      const errors = io.requiredErrors(module.exports, r);
      const hit = resolved[i];
      if (hit.error && io.str(r.employeeCode)) errors.push({ field: 'Employee ID', message: hit.error });
      const e = hit.employee;
      const type = io.str(r.type) ? io.pick(typeNames, r.type) : null;
      if (io.str(r.type) && !type) errors.push({ field: 'Leave Type', message: `"${r.type}" is not a leave type (${typeNames.join(', ')}).` });
      const from = io.parseDate(r.fromDate);
      const to = io.parseDate(r.toDate);
      if (from.error) errors.push({ field: 'From', message: `"${r.fromDate}" is not a date (YYYY-MM-DD).` });
      if (to.error) errors.push({ field: 'To', message: `"${r.toDate}" is not a date (YYYY-MM-DD).` });
      if (from.value && to.value && to.value < from.value) errors.push({ field: 'To', message: 'To is before From.' });
      const span = from.value && to.value && to.value >= from.value ? daySpan(from.value, to.value) : null;
      const dn = io.parseNumber(r.days);
      if (dn.error) errors.push({ field: 'Days', message: `"${r.days}" is not a number.` });
      let days = dn.value !== undefined ? round2(dn.value) : span;
      if (dn.value !== undefined) {
        if (days <= 0) errors.push({ field: 'Days', message: 'Days must be more than 0.' });
        else if (Math.round(days * 2) !== days * 2) errors.push({ field: 'Days', message: 'Days must be whole or half days (e.g. 1, 1.5).' });
        else if (span && days > span) errors.push({ field: 'Days', message: `${days} day(s) do not fit in ${from.value} → ${to.value} (${span} calendar day(s)).` });
      }
      const rawStatus = io.str(r.status);
      const status = rawStatus ? io.pick(STATUSES, rawStatus) : 'Approved';
      if (rawStatus && !status) {
        errors.push({
          field: 'Status',
          message: io.pick(OPEN, rawStatus)
            ? `A ${rawStatus} request is not history — apply it on the Leave screen so its approval chain runs.`
            : `"${rawStatus}" is not one of ${STATUSES.join(', ')}.`,
        });
      }
      const applied = io.parseDate(r.appliedOn);
      const decided = io.parseDate(r.decidedOn);
      if (applied.error) errors.push({ field: 'Applied On', message: `"${r.appliedOn}" is not a date (YYYY-MM-DD).` });
      if (decided.error) errors.push({ field: 'Decided On', message: `"${r.decidedOn}" is not a date (YYYY-MM-DD).` });
      if (applied.value && decided.value && decided.value < applied.value) errors.push({ field: 'Decided On', message: 'Decided On is before Applied On.' });

      if (e && type && from.value && to.value) {
        const k = `${e.id}|${type}|${from.value}|${to.value}`;
        if (seen.has(k)) errors.push({ field: 'From', message: `Same employee, leave type and dates as row ${seen.get(k)}.` });
        else seen.set(k, r.line);
      }
      const label = e ? `${e.name} (${e.employeeCode}) · ${type || io.str(r.type)} ${from.value || ''}${to.value && to.value !== from.value ? ` → ${to.value}` : ''}` : io.str(r.employeeCode);
      if (errors.length) return { line: r.line, label, errors, action: 'error' };

      const match = existing.find((x) => x.employeeId === e.id && x.type === type && x.fromDate === from.value && x.toDate === to.value);
      // A blank Status keeps an existing request's status (blanks never overwrite).
      const effStatus = match && !rawStatus ? match.status : status;
      // An Approved leave may not overlap another leave that holds those days.
      if (effStatus === 'Approved') {
        const clash = existing.find((x) => x !== match && x.employeeId === e.id && ['Approved', ...OPEN].includes(x.status)
          && x.fromDate <= to.value && x.toDate >= from.value);
        if (clash) {
          return {
            line: r.line, label, action: 'error',
            errors: [{ field: 'From', message: `Overlaps ${e.name}'s ${clash.status.toLowerCase()} ${clash.type} ${clash.fromDate} → ${clash.toDate}.` }],
          };
        }
        const twin = approvedInFile.find((x) => x.empId === e.id && x.from <= to.value && x.to >= from.value);
        if (twin) return { line: r.line, label, action: 'error', errors: [{ field: 'From', message: `Overlaps the Approved leave in row ${twin.line}.` }] };
        approvedInFile.push({ empId: e.id, from: from.value, to: to.value, line: r.line });
      }
      const want = {
        reason: io.str(r.reason) || null,
        decidedBy: io.str(r.decidedBy) || null,
        appliedOn: applied.value || null,
        decidedOn: decided.value || null,
      };
      if (!match) {
        const deduct = status === 'Approved' && from.value.slice(0, 4) === currentYear();
        return {
          line: r.line, label, errors: [], action: 'create',
          changes: [
            { field: 'Status', from: '', to: status },
            { field: 'Days', from: '', to: days },
            ...(deduct ? [{ field: `${type} balance`, from: '', to: `-${days} day(s)` }] : []),
          ],
          data: { employee: e, type, fromDate: from.value, toDate: to.value, days, status, deduct, ...want },
        };
      }
      if (OPEN.includes(match.status)) {
        return { line: r.line, label, action: 'error', errors: [{ field: 'Status', message: `This request is still ${match.status} on the Leave screen — decide it there.` }] };
      }
      const curDays = match.days == null ? 1 : Number(match.days);
      const moves = (match.status === 'Approved') !== (effStatus === 'Approved') || (effStatus === 'Approved' && dn.value !== undefined && days !== curDays);
      if (moves) {
        return {
          line: r.line, label, action: 'error',
          errors: [{ field: 'Status', message: `Changing this ${match.status.toLowerCase()} request to ${effStatus}${dn.value !== undefined && days !== curDays ? `, ${days} day(s)` : ''} would move the leave balance — do it on the Leave screen.` }],
        };
      }
      if (dn.value === undefined) days = null; // blank Days never overwrites
      const changes = [];
      const cmp = (field, cur, next) => { if (next !== null && next !== undefined && String(cur ?? '') !== String(next)) changes.push({ field, from: cur ?? '', to: next }); };
      cmp('Status', match.status, rawStatus ? status : null);
      cmp('Days', curDays, days);
      cmp('Reason', match.reason, want.reason);
      cmp('Decided By', match.decidedBy, want.decidedBy);
      cmp('Applied On', ymd(match.createdAt), want.appliedOn);
      cmp('Decided On', ymd(match.decidedAt), want.decidedOn);
      return {
        line: r.line, label, errors: [], action: changes.length ? 'update' : 'nochange', changes,
        data: { employee: e, request: match, status: rawStatus ? status : null, days, ...want },
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
            const leave = await tx.leaveRequest.create({
              data: {
                employeeId: x.employee.id, type: x.type, fromDate: x.fromDate, toDate: x.toDate, days: x.days, reason: x.reason,
                status: x.status, decidedBy: x.decidedBy || IMPORTED_BY,
                decidedAt: x.decidedOn ? new Date(`${x.decidedOn}T00:00:00.000Z`) : null,
                ...(x.appliedOn ? { createdAt: new Date(`${x.appliedOn}T00:00:00.000Z`) } : {}),
              },
            });
            let drawn = null;
            if (x.deduct) {
              await ensureBalances(tx, x.employee.id);
              const bal = await tx.leaveBalance.findUnique({ where: { employeeId_type: { employeeId: x.employee.id, type: x.type } } });
              if (bal) {
                await tx.leaveBalance.update({ where: { id: bal.id }, data: { taken: bal.taken + x.days } });
                drawn = `${x.type}: taken ${bal.taken} → ${round2(bal.taken + x.days)} of ${bal.total}`;
              }
            }
            await tx.auditLog.create({
              data: {
                userId: ctx.user.id, actorName: actor, action: 'Leave imported', entity: 'LeaveRequest', entityId: leave.id,
                toValue: `${x.status} · ${x.type} ${x.fromDate} → ${x.toDate} · ${x.days} day(s)`, reason: `${x.employee.employeeCode} ${x.employee.name}`,
              },
            });
            if (drawn) {
              await tx.auditLog.create({
                data: {
                  userId: ctx.user.id, actorName: actor, action: DEDUCTED, entity: 'LeaveRequest', entityId: leave.id,
                  toValue: drawn, reason: `${x.employee.employeeCode} ${x.employee.name}`,
                },
              });
            }
          });
          created += 1;
        } else if (v.action === 'update') {
          const data = {};
          if (x.status) data.status = x.status;
          if (x.days !== null && x.days !== undefined) data.days = x.days;
          if (x.reason) data.reason = x.reason;
          if (x.decidedBy) data.decidedBy = x.decidedBy;
          if (x.decidedOn) data.decidedAt = new Date(`${x.decidedOn}T00:00:00.000Z`);
          if (x.appliedOn) data.createdAt = new Date(`${x.appliedOn}T00:00:00.000Z`);
          // eslint-disable-next-line no-await-in-loop
          await prisma.$transaction(async (tx) => {
            // Re-checked inside the write: the request may have moved since the check.
            const cur = await tx.leaveRequest.findUnique({ where: { id: x.request.id } });
            if (!cur || cur.status !== x.request.status) throw new Error('This request changed on the Leave screen since the file was checked — check the file again.');
            await tx.leaveRequest.update({ where: { id: cur.id }, data });
            await tx.auditLog.createMany({
              data: v.changes.map((c) => ({
                userId: ctx.user.id, actorName: actor, action: 'Leave updated by import', entity: 'LeaveRequest', entityId: cur.id,
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
