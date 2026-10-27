// ---------------------------------------------------------------------------
// PAYROLL RUNS — per employee per month (SPEC B §3-§6), registered on the
// /api/payroll router (routes/payroll.js), which has already authenticated.
//
//   GET    /entries?month=                      the month's records + the caller's access
//   GET    /entries/:id                         one record, its audit trail, sync log, payload
//   POST   /calculate {month, department?, employeeIds?, dryRun?}   drafts (idempotent)
//   GET    /attendance-inputs?month=            default (attendance module) + overrides
//   PUT    /attendance-inputs/:employeeId       HR's override {month, daysPresent, daysLop, workingDays?, reason}
//   DELETE /attendance-inputs/:employeeId?month=  back to the attendance default
//   POST   /entries/submit   {ids | month}      DRAFT -> PENDING_APPROVAL           (HR / payroll desk)
//   POST   /entries/reject   {ids, reason}      PENDING_APPROVAL -> DRAFT           (approvers)
//   POST   /entries/approve  {ids | month, sync?} PENDING_APPROVAL -> APPROVED       (approvers)
//                                               + payslip + journal payload queued (+ synced now)
//   POST   /entries/sync     {ids | month}      APPROVED -> SYNCED_TO_ACCOUNTS      (Accounts, SA/Admin)
//   POST   /entries/mark-paid {ids | month, paidDate?, bankTransactionId?, reference?}
//                                               SYNCED_TO_ACCOUNTS -> PAID          (Accounts, SA/Admin)
//   S3 (2026-10-05) — ONE journal per month (utils/payrollPosting.js):
//     approve that finalizes the month posts it automatically;
//   GET    /runs/:month/accounts                Posted / Not posted, the JE, the reason
//   POST   /runs/:month/post                    "Post to Accounts" (finalized, unposted)
//   POST   /runs/:month/reopen {reason}         reversal JE + records back to Draft
//   POST   /runs/:month/mark-paid {bankAccountId?, paidDate?, bankTransactionId?, reference?}
//                                               Dr Salary Payable / Cr Bank
//   GET    /runs/:month/bank-matches?bankAccountId=  statement debits = the month's net
//   (/entries/sync and /entries/mark-paid now take {month} and act on the month)
//   GET    /sync-logs?month=&status=            the delivery log
//   POST   /sync-logs/:id/retry                 retry one row
//   POST   /sync-logs/sweep                     run the automatic retry sweep now
//   GET    /reports/compliance?month=|year=&format=csv|xlsx
//   Payroll edit and recalculate (2026-10-13):
//   GET    /entries/:id/edit                    the editor: components, rules, lock reason, edit state
//   PUT    /entries/:id/edit                    save {fields, earnings, deductions, manual, reason, totals}
//   POST   /entries/:id/edit/recalc {apply?, reason?}  compare (apply:false) / apply the engine's own numbers
//   GET    /entries/:id/history                 versions + audit rows + superseded payslips
//   GET    /runs/:month/changes                 "Changes in this run": every edited record with deltas
//   POST   /adjustments {employeeId, sourceMonth, kind, amount, label, reason}   arrears / recovery -> next open month
//   GET    /adjustments?month=&employeeId=&sourceMonth=
//   edit = Payroll & Compensation / edit (SA, Admin, Accountant, HR); only while the month is Draft / Pending;
//   the person who edited a record cannot approve it; reopen = Payroll / configure (Super Admin, Admin).
//
// ACCESS (resolved by the permission engine, never a role list here):
//   prepare  hrms / Payroll & Compensation / create     — HR, Accounts, SA/Admin
//   approve  hrms / Payroll & Compensation / approve    — SA/Admin, Accountant
//            or accounts / Journal & Ledger / approve   — an Accounts role with approve
//   post     accounts / Journal & Ledger / create       — Accounts roles, SA/Admin
//   view     any of the above, or Payroll & Compensation / export (Manager /
//            Assistant Manager: view only — approve is not a chain feature for them)
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { can, DENIED } = require('../utils/permissions');
const { matches, OUT_OF_SCOPE } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const { monthLabel } = require('../utils/attendanceMath');
const { NOT_SYSTEM_EMPLOYEE } = require('../utils/systemAccounts');
const E = require('../utils/payrollEngine');
const PC = require('../utils/payrollCycle');
const S = require('../utils/payrollSync');
// S3 (2026-10-05): ONE journal per payroll month (utils/payrollPosting.js).
const P = require('../utils/payrollPosting');
const { compliance } = require('../utils/payrollReports');
const { toCsv, toXlsx } = require('../utils/tabularExport');
const { notifyDataIo } = require('../utils/dataIoNotify');
// Payroll edit and recalculate (user spec 2026-10-13, item 5): utils/payrollEdit.js
const PEdit = require('../utils/payrollEdit');
const { ipOf } = require('../utils/clientIp');

function sendTable(res, format, filename, headers, rows, sheet) {
  if (format === 'xlsx') {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
    return res.send(toXlsx(headers, rows, sheet));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
  return res.send(toCsv(headers, rows));
}

module.exports = function registerPayrollRuns(router, { payrollEmployeeWhere }) {
  async function accessOf(req) {
    if (req.payrollAccess) return req.payrollAccess;
    const u = req.user;
    const [prepare, approveH, approveA, post, exportH, ledger, editH, reopenH] = await Promise.all([
      can(u, 'hrms', 'hrms', 'Payroll & Compensation', 'create'),
      can(u, 'hrms', 'hrms', 'Payroll & Compensation', 'approve'),
      can(u, 'accounts', 'accounts', 'Journal & Ledger', 'approve'),
      can(u, 'accounts', 'accounts', 'Journal & Ledger', 'create'),
      can(u, 'hrms', 'hrms', 'Payroll & Compensation', 'export'),
      can(u, 'accounts', 'accounts', 'Journal & Ledger', 'view'),
      can(u, 'hrms', 'hrms', 'Payroll & Compensation', 'edit'),
      can(u, 'hrms', 'hrms', 'Payroll & Compensation', 'configure'),
    ]);
    const approve = approveH || approveA;
    req.payrollAccess = { prepare, approve, post, ledger, edit: !!editH, reopen: !!reopenH, export: !!exportH, view: prepare || approve || post || exportH || ledger || !!editH };
    return req.payrollAccess;
  }
  const need = (flag) => async (req, res, next) => {
    try {
      const a = await accessOf(req);
      return a[flag] ? next() : res.status(403).json(DENIED);
    } catch (err) { return next(err); }
  };
  const actor = (req) => ({ id: req.user.id, name: req.user.name || req.user.email });
  const fail = (res, err) => {
    if (err && err.status) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
    throw err;
  };

  // The records a bulk action applies to: explicit ids, or every record of the
  // month in the `from` status — always cut to the caller's scope.
  async function targetEntries(req, fromStatus) {
    const where = { employee: payrollEmployeeWhere(req) };
    const ids = Array.isArray(req.body.ids) ? req.body.ids.filter(Boolean).map(String) : null;
    if (ids && ids.length) where.id = { in: ids };
    else if (E.isMonth(req.body.month)) { where.month = req.body.month; where.status = fromStatus; } else return null;
    const list = await prisma.employeePayrollRun.findMany({ where, include: { employee: true }, orderBy: { employee: { name: 'asc' } } });
    if (ids && ids.length && list.length !== ids.length) {
      const found = new Set(list.map((e) => e.id));
      return { list, missing: ids.filter((id) => !found.has(id)) };
    }
    return { list, missing: [] };
  }

  // Runs fn over the targets. Resolves { status, body }:
  //   200 everything moved (or nothing to do) · 207 a mix ·
  //   409 nothing moved because of the state machine · 502 Accounts refused /
  //   was unreachable (the sync log has the error) · 404 ids not found.
  async function runBulk(req, fromStatus, fn) {
    const t = await targetEntries(req, fromStatus);
    if (!t) return { status: 400, body: { error: 'Pass ids, or a month (YYYY-MM)' } };
    const results = t.missing.map((id) => ({ id, ok: false, code: 404, error: 'Not found or outside your scope' }));
    for (const e of t.list) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await fn(e);
        const failed = r.ok === false;
        results.push({
          id: e.id, name: e.employee.name, ok: !failed, code: failed ? 502 : 200, status: (r.entry || r).status,
          error: failed ? (r.log && r.log.lastError) || r.error : undefined, syncError: r.syncError || undefined,
        });
      } catch (err) {
        if (!err.status) throw err;
        results.push({ id: e.id, name: e.employee.name, ok: false, code: err.status, status: err.extra && err.extra.status, error: err.message });
      }
    }
    const ok = results.filter((r) => r.ok).length;
    const codes = [...new Set(results.filter((r) => !r.ok).map((r) => r.code))];
    let status = 200;
    if (ok === 0 && codes.length) status = codes.length === 1 ? codes[0] : (codes.includes(502) ? 502 : 409);
    else if (ok < results.length) status = 207;
    return { status, body: { ok, failed: results.length - ok, results } };
  }
  async function bulk(req, res, fromStatus, fn) {
    const r = await runBulk(req, fromStatus, fn);
    return res.status(r.status).json(r.body);
  }

  // ---- Reads -------------------------------------------------------------------
  router.get('/entries', need('view'), async (req, res) => {
    const month = req.query.month;
    if (!E.isMonth(month)) return res.status(400).json({ error: 'month is required (YYYY-MM)' });
    const where = { month, employee: payrollEmployeeWhere(req) };
    if (req.query.status) where.status = String(req.query.status);
    if (req.query.department) where.employee = { AND: [payrollEmployeeWhere(req), { department: String(req.query.department) }] };
    const [entries, run, logs] = await Promise.all([
      prisma.employeePayrollRun.findMany({
        where,
        include: { employee: { select: { id: true, name: true, employeeCode: true, department: true, designation: true, bankAccountNumber: true, bankName: true, ifscCode: true, panNumber: true, uanNumber: true } } },
        orderBy: { employee: { name: 'asc' } },
      }),
      prisma.payrollRun.findUnique({ where: { month } }),
      prisma.payrollSyncLog.findMany({ where: { month } }),
    ]);
    const editStates = await PEdit.readStates(entries.map((e) => e.id));
    const logOf = new Map();
    logs.forEach((l) => { logOf.set(`${l.kind}|${l.employeePayrollRunId}`, l); });
    const sum = (k) => entries.reduce((n, e) => n + (Number(e[k]) || 0), 0);
    const byStatus = {};
    entries.forEach((e) => { byStatus[e.status] = (byStatus[e.status] || 0) + 1; });
    res.json({
      month, period: monthLabel(month), cycle: await PC.cycleFor(month), run, access: await accessOf(req), byStatus,
      totals: {
        employees: entries.length, grossPay: sum('grossPay'), lopDeduction: sum('lopDeduction'), earnedGross: sum('earnedGross'),
        totalDeductions: sum('totalDeductions'), netPay: sum('netPay'), pfEmployer: sum('pfEmployer'), esiEmployer: sum('esiEmployer'),
      },
      entries: entries.map((e) => ({
        ...e,
        statusLabel: E.STATUS_LABEL[e.status],
        lock: PEdit.lockOf(e),
        edit: (() => {
          const st = editStates.get(e.id);
          const last = st && st.versions && st.versions.length > 1 ? st.versions[st.versions.length - 1] : null;
          return { edited: !!(st && st.edited), versions: st && st.versions ? Math.max(0, st.versions.length - 1) : 0, lastBy: last ? last.byName : null, lastAt: last ? last.at : null };
        })(),
        accrualSync: logOf.get(`ACCRUAL|${e.id}`) ? (({ payload, ...rest }) => rest)(logOf.get(`ACCRUAL|${e.id}`)) : null,
        paymentSync: logOf.get(`PAYMENT|${e.id}`) ? (({ payload, ...rest }) => rest)(logOf.get(`PAYMENT|${e.id}`)) : null,
      })),
    });
  });

  async function scopedEntry(req, res) {
    const e = await prisma.employeePayrollRun.findUnique({ where: { id: req.params.id }, include: { employee: true } });
    if (!e) { res.status(404).json({ error: 'Payroll record not found' }); return null; }
    if (!matches(e.employee, payrollEmployeeWhere(req))) { res.status(403).json(OUT_OF_SCOPE); return null; }
    return e;
  }

  // EXPORT THE MONTH'S CALCULATED PAYROLL (founder 2026-10-27: "process payroll lo export option pettu"): every record the
  // Payroll records table shows (the same scope, optional department), one row per employee, as Excel or CSV. Bank account,
  // PAN and UAN numbers are left out of the file. Needs the Payroll export right.
  router.get('/runs/:month/export', need('export'), async (req, res) => {
    const month = req.params.month;
    if (!E.isMonth(month)) return res.status(400).json({ error: 'month is required (YYYY-MM)' });
    const format = String(req.query.format || 'xlsx').toLowerCase() === 'csv' ? 'csv' : 'xlsx';
    const where = { month, employee: payrollEmployeeWhere(req) };
    if (req.query.department) where.employee = { AND: [payrollEmployeeWhere(req), { department: String(req.query.department) }] };
    const entries = await prisma.employeePayrollRun.findMany({
      where,
      include: { employee: { select: { name: true, employeeCode: true, department: true, designation: true } } },
      orderBy: { employee: { name: 'asc' } },
    });
    const edited = await PEdit.readStates(entries.map((e) => e.id));
    const n = (v) => Math.round(Number(v) || 0);
    const headers = ['Employee ID', 'Name', 'Department', 'Designation', 'Pay type', 'Working days', 'Days present', 'LOP days',
      'Basic', 'HRA', 'Special allowance', 'Conveyance', 'Bonus', 'Incentive', 'Other earnings', 'Gross', 'LOP amount', 'Earned gross',
      'PF (employee)', 'ESI (employee)', 'Professional tax', 'TDS', 'Other deductions', 'Total deductions', 'Net pay',
      'PF (employer)', 'ESI (employer)', 'Gratuity', 'Status', 'Edited by hand'];
    const rows = entries.map((e) => [e.employee.employeeCode || '', e.employee.name, e.employee.department || '', e.employee.designation || '', e.payMode || '',
      e.workingDays ?? '', e.daysPresent ?? '', e.daysLop ?? '',
      n(e.basic), n(e.hra), n(e.specialAllowance), n(e.conveyance), n(e.bonus), n(e.incentive), n(e.arrears), n(e.grossPay), n(e.lopDeduction), n(e.earnedGross),
      n(e.pfEmployee), n(e.esiEmployee), n(e.professionalTax), n(e.tds), n(e.otherDeductions), n(e.totalDeductions), n(e.netPay),
      n(e.pfEmployer), n(e.esiEmployer), n(e.gratuity), E.STATUS_LABEL[e.status] || e.status, (edited.get(e.id) || {}).edited ? 'Yes' : 'No']);
    if (entries.length) {
      const t = (k) => entries.reduce((s, e) => s + n(e[k]), 0);
      rows.push(['', 'TOTAL', '', '', '', '', '', '', t('basic'), t('hra'), t('specialAllowance'), t('conveyance'), t('bonus'), t('incentive'), t('arrears'), t('grossPay'),
        t('lopDeduction'), t('earnedGross'), t('pfEmployee'), t('esiEmployee'), t('professionalTax'), t('tds'), t('otherDeductions'), t('totalDeductions'), t('netPay'),
        t('pfEmployer'), t('esiEmployer'), t('gratuity'), '', '']);
    }
    await logAudit({ userId: req.user.id, action: `Payroll exported (${format.toUpperCase()})`, entity: 'EmployeePayrollRun', toValue: `${month} - ${entries.length} record(s)` });
    return sendTable(res, format, `payroll-${month}${req.query.department ? `-${String(req.query.department).replace(/[^A-Za-z0-9]+/g, '-')}` : ''}`, headers, rows, 'Payroll');
  });

  router.get('/entries/:id', need('view'), async (req, res) => {
    const e = await scopedEntry(req, res);
    if (!e) return undefined;
    const [history, logs, version] = await Promise.all([
      E.historyOf(e.id),
      prisma.payrollSyncLog.findMany({ where: { employeePayrollRunId: e.id }, orderBy: { createdAt: 'asc' } }),
      e.salaryVersionId ? prisma.salaryStructureVersion.findUnique({ where: { id: e.salaryVersionId } }) : null,
    ]);
    return res.json({
      entry: { ...e, statusLabel: E.STATUS_LABEL[e.status] },
      version, history, syncLogs: logs,
      // This employee's share of the month's one journal entry.
      journalPayload: await P.employeeShare(e),
    });
  });

  // ---- Payroll edit and recalculate (utils/payrollEdit.js) ---------------------------------------
  const editFail = (res, err) => {
    if (err && err.status) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
    throw err;
  };
  router.get('/entries/:id/edit', need('view'), async (req, res) => {
    const e = await scopedEntry(req, res);
    if (!e) return undefined;
    return res.json(await PEdit.editorPayload(e, await accessOf(req)));
  });
  router.put('/entries/:id/edit', need('edit'), async (req, res) => {
    const e = await scopedEntry(req, res);
    if (!e) return undefined;
    try {
      const r = await PEdit.saveEdit({ entry: e, body: req.body || {}, actor: actor(req), ip: ipOf(req) });
      return res.json({ ok: true, version: r.version, before: r.before, after: r.after, changes: r.changes, status: r.entry.status, payload: await PEdit.editorPayload(r.entry, await accessOf(req)) });
    } catch (err) { return editFail(res, err); }
  });
  router.post('/entries/:id/edit/recalc', need('edit'), async (req, res) => {
    const e = await scopedEntry(req, res);
    if (!e) return undefined;
    try {
      if (!(req.body && req.body.apply)) {
        const c = await PEdit.engineCompare(e);
        return res.json({ same: c.same, changes: c.changes, before: c.before, after: c.after });
      }
      const r = await PEdit.applyEngine({ entry: e, actor: actor(req), ip: ipOf(req), reason: req.body.reason });
      return res.json({ ok: true, version: r.version, before: r.before, after: r.after, changes: r.changes, payload: await PEdit.editorPayload(r.entry, await accessOf(req)) });
    } catch (err) { return editFail(res, err); }
  });
  router.get('/entries/:id/history', need('view'), async (req, res) => {
    const e = await scopedEntry(req, res);
    if (!e) return undefined;
    return res.json({ ...(await PEdit.historyOf(e)), lock: PEdit.lockOf(e), status: e.status, statusLabel: E.STATUS_LABEL[e.status] });
  });
  router.get('/runs/:month/changes', need('view'), async (req, res) => {
    if (!E.isMonth(req.params.month)) return res.status(400).json({ error: 'month must be YYYY-MM' });
    return res.json(await PEdit.changesInRun(req.params.month, payrollEmployeeWhere(req)));
  });
  router.post('/adjustments', need('edit'), async (req, res) => {
    const b = req.body || {};
    const emp = await prisma.employee.findUnique({ where: { id: String(b.employeeId || '') } });
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    if (!matches(emp, payrollEmployeeWhere(req))) return res.status(403).json(OUT_OF_SCOPE);
    try {
      const r = await PEdit.createAdjustment({ employeeId: emp.id, sourceMonth: b.sourceMonth, kind: b.kind, amount: b.amount, label: b.label, reason: b.reason, actor: actor(req), ip: ipOf(req) });
      return res.status(201).json(r);
    } catch (err) { return editFail(res, err); }
  });
  router.get('/adjustments', need('view'), async (req, res) => {
    const list = await PEdit.listAdjustments({ month: req.query.month || null, employeeId: req.query.employeeId || null, sourceMonth: req.query.sourceMonth || null });
    const ids = [...new Set(list.map((a) => a.employeeId))];
    const emps = await prisma.employee.findMany({ where: { AND: [{ id: { in: ids } }, payrollEmployeeWhere(req)] }, select: { id: true, name: true, employeeCode: true } });
    const of = new Map(emps.map((x) => [x.id, x]));
    return res.json(list.filter((a) => of.has(a.employeeId)).map((a) => ({ ...a, employeeName: of.get(a.employeeId).name, employeeCode: of.get(a.employeeId).employeeCode })));
  });

  // ---- Calculate (drafts) ----------------------------------------------------------
  router.post('/calculate', need('prepare'), async (req, res) => {
    try {
      const r = await E.calculateMonth({
        month: req.body.month,
        department: req.body.department || null,
        employeeIds: Array.isArray(req.body.employeeIds) && req.body.employeeIds.length ? req.body.employeeIds : null,
        employeeWhere: payrollEmployeeWhere(req),
        actor: actor(req),
        dryRun: !!req.body.dryRun,
      });
      return res.status(req.body.dryRun ? 200 : 201).json(r);
    } catch (err) { return fail(res, err); }
  });

  // ---- Attendance input -------------------------------------------------------------
  router.get('/attendance-inputs', need('view'), async (req, res) => {
    const month = req.query.month;
    if (!E.isMonth(month)) return res.status(400).json({ error: 'month is required (YYYY-MM)' });
    const policy = await E.getPolicy();
    const employees = await prisma.employee.findMany({
      where: { AND: [payrollEmployeeWhere(req), { employmentStatus: { in: E.PAYABLE_STATUSES } }, NOT_SYSTEM_EMPLOYEE] },
      orderBy: { name: 'asc' },
    });
    const { workingDays, map } = await E.attendanceInputs(employees, month, policy);
    const entries = await prisma.employeePayrollRun.findMany({ where: { month, employeeId: { in: employees.map((e) => e.id) } }, select: { employeeId: true, status: true } });
    const statusOf = new Map(entries.map((e) => [e.employeeId, e.status]));
    res.json({
      month, period: monthLabel(month), cycle: await PC.cycleFor(month), workingDays,
      rows: employees.map((e) => ({
        employeeId: e.id, employeeCode: e.employeeCode, name: e.name, department: e.department,
        payrollStatus: statusOf.get(e.id) || null, ...map.get(e.id),
      })),
    });
  });

  router.put('/attendance-inputs/:employeeId', need('prepare'), async (req, res) => {
    const { month } = req.body || {};
    if (!E.isMonth(month)) return res.status(400).json({ error: 'month is required (YYYY-MM)' });
    const emp = await prisma.employee.findUnique({ where: { id: req.params.employeeId } });
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    if (!matches(emp, payrollEmployeeWhere(req))) return res.status(403).json(OUT_OF_SCOPE);
    const locked = await prisma.employeePayrollRun.findUnique({ where: { employeeId_month: { employeeId: emp.id, month } } });
    if (locked && locked.status !== 'DRAFT') {
      return res.status(409).json({ error: `${emp.name}'s ${monthLabel(month)} payroll is ${E.STATUS_LABEL[locked.status]} — attendance can only be changed before it is submitted.` });
    }
    const policy = await E.getPolicy();
    const { workingDays: defaultWd, map } = await E.attendanceDefaults([emp], month, policy);
    const wd = req.body.workingDays != null && req.body.workingDays !== '' ? Number(req.body.workingDays) : defaultWd;
    const present = Number(req.body.daysPresent);
    const lop = Number(req.body.daysLop);
    const reason = String(req.body.reason || '').trim();
    if (!Number.isFinite(wd) || wd <= 0 || wd > 31) return res.status(400).json({ error: 'Working days must be between 1 and 31' });
    if (!Number.isFinite(present) || present < 0 || present > wd) return res.status(400).json({ error: `Days present must be between 0 and ${wd}` });
    if (!Number.isFinite(lop) || lop < 0 || lop > wd) return res.status(400).json({ error: `LOP days must be between 0 and ${wd}` });
    if ((present * 2) % 1 || (lop * 2) % 1) return res.status(400).json({ error: 'Days are whole or half days' });
    if (!reason) return res.status(400).json({ error: 'A reason is required for an attendance override' });
    const auto = map.get(emp.id);
    const prev = await prisma.payrollAttendance.findUnique({ where: { employeeId_month: { employeeId: emp.id, month } } });
    const { year, monthNum } = E.monthParts(month);
    const data = {
      year, monthNum, workingDays: wd, daysPresent: present, daysLop: lop,
      autoDaysPresent: auto.daysPresent, autoDaysLop: auto.daysLop, reason,
      overriddenBy: req.user.id, overriddenByName: req.user.name, overriddenAt: new Date(),
    };
    const row = await prisma.payrollAttendance.upsert({
      where: { employeeId_month: { employeeId: emp.id, month } }, update: data, create: { employeeId: emp.id, month, ...data },
    });
    const from = prev ? `present ${prev.daysPresent}, LOP ${prev.daysLop} (override)` : `present ${auto.daysPresent}, LOP ${auto.daysLop} (attendance)`;
    await logAudit({
      userId: req.user.id, actorName: req.user.name, action: 'Payroll attendance overridden', entity: 'PayrollAttendance', entityId: row.id,
      field: 'attendance', fieldLabel: `${emp.name} · ${monthLabel(month)}`, fromValue: from, toValue: `present ${present}, LOP ${lop} of ${wd}`, reason,
    });
    return res.json({ row, auto });
  });

  router.delete('/attendance-inputs/:employeeId', need('prepare'), async (req, res) => {
    const month = req.query.month;
    if (!E.isMonth(month)) return res.status(400).json({ error: 'month is required (YYYY-MM)' });
    const emp = await prisma.employee.findUnique({ where: { id: req.params.employeeId } });
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    if (!matches(emp, payrollEmployeeWhere(req))) return res.status(403).json(OUT_OF_SCOPE);
    const locked = await prisma.employeePayrollRun.findUnique({ where: { employeeId_month: { employeeId: emp.id, month } } });
    if (locked && locked.status !== 'DRAFT') return res.status(409).json({ error: 'The payroll for this month is already submitted.' });
    const prev = await prisma.payrollAttendance.findUnique({ where: { employeeId_month: { employeeId: emp.id, month } } });
    if (!prev) return res.json({ ok: true });
    await prisma.payrollAttendance.delete({ where: { id: prev.id } });
    await logAudit({
      userId: req.user.id, actorName: req.user.name, action: 'Payroll attendance override removed', entity: 'PayrollAttendance', entityId: prev.id,
      field: 'attendance', fieldLabel: `${emp.name} · ${monthLabel(month)}`, fromValue: `present ${prev.daysPresent}, LOP ${prev.daysLop} (override)`, toValue: 'attendance default',
    });
    return res.json({ ok: true });
  });

  // ---- Transitions ---------------------------------------------------------------------
  router.post('/entries/submit', need('prepare'), (req, res) => bulk(req, res, 'DRAFT', (e) => E.transition(e.id, 'submit', actor(req))));

  router.post('/entries/reject', need('approve'), (req, res) => {
    if (!String(req.body.reason || '').trim()) return res.status(400).json({ error: 'A reason is required to send a record back' });
    return bulk(req, res, 'PENDING_APPROVAL', (e) => E.transition(e.id, 'reject', actor(req), { reason: String(req.body.reason).trim() }));
  });

  // Approve = finalize. When the approval leaves no record of the month in
  // Draft / Pending, the month's ONE journal is posted to Accounts at once
  // (S3.1). The approval stands even if posting fails — the month then shows
  // "Not posted" with the reason, a "Post to Accounts" button and the retry.
  router.post('/entries/approve', need('approve'), async (req, res) => {
    const r = await runBulk(req, 'PENDING_APPROVAL', (e) => E.transition(e.id, 'approve', actor(req)));
    const months = r.body.results.filter((x) => x.ok).length
      ? (await prisma.employeePayrollRun.findMany({ where: { id: { in: r.body.results.filter((x) => x.ok).map((x) => x.id) } }, select: { month: true } })).map((x) => x.month)
      : [];
    if (months.length) {
      const posting = await P.postIfFinalized(months, { id: req.user.id, name: `${req.user.name || req.user.email} (finalized)` });
      r.body.posting = posting;
    }
    return res.status(r.status).json(r.body);
  });

  // ---- The month and Accounts (S3) ----------------------------------------------
  const monthOf = (req) => (E.isMonth(req.params.month) ? req.params.month : null);
  const needAny = (...flags) => async (req, res, next) => {
    try {
      const a = await accessOf(req);
      return flags.some((f) => a[f]) ? next() : res.status(403).json(DENIED);
    } catch (err) { return next(err); }
  };

  router.get('/runs/:month/accounts', need('view'), async (req, res) => {
    const month = monthOf(req);
    if (!month) return res.status(400).json({ error: 'month must be YYYY-MM' });
    const st = await P.monthState(month);
    return res.json({ ...st, voucherNo: st.journalEntry ? await P.voucherNo(st.journalEntry) : null, access: await accessOf(req) });
  });

  // "Post to Accounts" — a finalized month that is not posted (e.g. a
  // mapping was missing, or Accounts was down). Same as the automatic post.
  router.post('/runs/:month/post', needAny('approve', 'post'), async (req, res) => {
    const month = monthOf(req);
    if (!month) return res.status(400).json({ error: 'month must be YYYY-MM' });
    try {
      const r = await P.postMonth(month, actor(req));
      if (!r.ok) return res.status(502).json({ error: `Could not post to Accounts: ${r.error}`, state: r.state });
      return res.json(r);
    } catch (err) { return fail(res, err); }
  });

  // Re-open to correct: the posted journal is REVERSED (never edited), the
  // records go back to Draft; finalizing again books a new journal.
  router.post('/runs/:month/reopen', needAny('approve', 'post'), async (req, res) => {
    const month = monthOf(req);
    if (!month) return res.status(400).json({ error: 'month must be YYYY-MM' });
    // An approved payroll is re-opened only by the Super Admin (the Payroll "configure" holders): 2026-10-13.
    if (!(await accessOf(req)).reopen) return res.status(403).json({ error: 'Only the Super Admin can reopen an approved payroll. Ask them to reopen it.' });
    const reason = String((req.body && req.body.reason) || '').trim();
    if (reason.length < 3) return res.status(400).json({ error: 'Say why the payroll is being re-opened.' });
    try {
      const r = await P.reverseMonth(month, actor(req), { toStatus: 'DRAFT', reason });
      if (!r.ok) return res.status(502).json({ error: `Could not book the reversal in Accounts: ${r.error}`, state: r.state });
      try {
        const who = await prisma.user.findMany({
          where: { role: { in: ['SUPER_ADMIN', 'ADMIN', 'ACCOUNTANT'] }, NOT: [{ email: { contains: 'example.test' } }, { name: { contains: 'ZZTEST' } }] },
          select: { id: true },
        });
        await require('../utils/notify').notifyUsers(who.map((u) => u.id), { title: 'Payroll re-opened', message: `${req.user.name || 'The Super Admin'} re-opened ${monthLabel(month)} payroll (back to Calculated). Reason: ${reason}`, exceptUserId: req.user.id });
      } catch { /* the re-open stands even if a notification cannot be written */ }
      return res.json(r);
    } catch (err) { return fail(res, err); }
  });

  // Salary payment: Dr Salary Payable / Cr the chosen bank (S3.4).
  router.post('/runs/:month/mark-paid', need('post'), async (req, res) => {
    const month = monthOf(req);
    if (!month) return res.status(400).json({ error: 'month must be YYYY-MM' });
    const b = req.body || {};
    try {
      const r = await P.payMonth(month, actor(req), {
        bankAccountId: b.bankAccountId || null,
        paidDate: /^\d{4}-\d{2}-\d{2}$/.test(String(b.paidDate || '')) ? b.paidDate : null,
        bankTransactionId: b.bankTransactionId || null,
        reference: b.reference ? String(b.reference).slice(0, 120) : null,
      });
      if (!r.ok) return res.status(502).json({ error: `Could not book the payment in Accounts: ${r.error}`, state: r.state });
      return res.json(r);
    } catch (err) { return fail(res, err); }
  });

  router.get('/runs/:month/bank-matches', need('post'), async (req, res) => {
    const month = monthOf(req);
    if (!month) return res.status(400).json({ error: 'month must be YYYY-MM' });
    const [m, banks] = await Promise.all([
      P.bankMatches(month, req.query.bankAccountId ? String(req.query.bankAccountId) : null),
      prisma.bankAccount.findMany({ where: { active: true }, orderBy: { createdAt: 'asc' }, select: { id: true, bank: true, name: true, accNo: true } }),
    ]);
    return res.json({ ...m, banks: banks.map((x) => ({ id: x.id, label: `${x.bank}${x.accNo ? ` ·${String(x.accNo).slice(-4)}` : ''}${x.name ? ` — ${x.name}` : ''}` })) });
  });

  // The old per-record routes now act on the whole month.
  router.post('/entries/sync', needAny('approve', 'post'), async (req, res) => {
    if (!E.isMonth(req.body.month)) return res.status(400).json({ error: 'Payroll is posted to Accounts once for the whole month — pass the month (YYYY-MM).' });
    try {
      const r = await P.postMonth(req.body.month, actor(req));
      return res.status(r.ok ? 200 : 502).json(r.ok ? r : { error: r.error, state: r.state });
    } catch (err) { return fail(res, err); }
  });

  router.post('/entries/mark-paid', need('post'), async (req, res) => {
    if (!E.isMonth(req.body.month)) return res.status(400).json({ error: 'Salary is marked paid for the whole month — pass the month (YYYY-MM).' });
    try {
      const r = await P.payMonth(req.body.month, actor(req), {
        bankAccountId: req.body.bankAccountId || null, paidDate: req.body.paidDate || null,
        bankTransactionId: req.body.bankTransactionId || null, reference: req.body.reference || null,
      });
      return res.status(r.ok ? 200 : 502).json(r.ok ? r : { error: r.error, state: r.state });
    } catch (err) { return fail(res, err); }
  });

  // ---- Sync log ---------------------------------------------------------------------------
  router.get('/sync-logs', async (req, res) => {
    const a = await accessOf(req);
    if (!(a.post || a.approve || a.ledger)) return res.status(403).json(DENIED);
    const where = {};
    if (req.query.month) where.month = String(req.query.month);
    if (req.query.status) where.status = String(req.query.status);
    const logs = await prisma.payrollSyncLog.findMany({ where, orderBy: { updatedAt: 'desc' }, take: 500 });
    const entries = await prisma.employeePayrollRun.findMany({
      where: { id: { in: logs.map((l) => l.employeePayrollRunId) } }, include: { employee: { select: { name: true, employeeCode: true } } },
    });
    const of = new Map(entries.map((e) => [e.id, e]));
    res.json(logs.map((l) => ({
      ...l, payload: l.payload ? JSON.parse(l.payload) : null,
      employeeName: of.get(l.employeePayrollRunId)?.employee.name || (String(l.kind).startsWith('MONTH') ? `Whole month · ${monthLabel(l.month)}` : null),
      employeeCode: of.get(l.employeePayrollRunId)?.employee.employeeCode || null,
      entryStatus: of.get(l.employeePayrollRunId)?.status || null,
    })));
  });

  router.post('/sync-logs/:id/retry', need('post'), async (req, res) => {
    try {
      const row = await prisma.payrollSyncLog.findUnique({ where: { id: req.params.id } });
      if (row && String(row.kind).startsWith('MONTH')) {
        // A month-level booking: run the same action again (idempotent).
        let r;
        if (row.kind === 'MONTH') r = await P.postMonth(row.month, actor(req));
        else if (row.kind === 'MONTH_PAYMENT') {
          const p = JSON.parse(row.payload || '{}');
          r = await P.payMonth(row.month, actor(req), { bankAccountId: p.bank_account_id || null, paidDate: p.date, bankTransactionId: p.bank_transaction_id || null });
        } else r = await P.reverseMonth(row.month, actor(req), { toStatus: 'DRAFT', reason: 'Retry of the reversal' });
        const log = await prisma.payrollSyncLog.findUnique({ where: { id: row.id } });
        return res.status(r.ok ? 200 : 502).json({ ok: r.ok, log, error: r.ok ? undefined : r.error });
      }
      const r = await S.retryLog(req.params.id, actor(req));
      return res.status(r.ok ? 200 : 502).json({ ok: r.ok, log: r.log, entry: r.entry, error: r.ok ? undefined : r.log && r.log.lastError });
    } catch (err) { return fail(res, err); }
  });

  router.post('/sync-logs/sweep', need('post'), async (req, res) => {
    res.json(await S.sweepOnce());
  });

  // ---- Compliance summary -------------------------------------------------------------------
  router.get('/reports/compliance', need('view'), async (req, res) => {
    const month = req.query.month;
    if (month && !E.isMonth(month)) return res.status(400).json({ error: 'month must be YYYY-MM' });
    const r = await compliance({ month: month || null, year: req.query.year || null, includeDraft: req.query.includeDraft === '1' });
    const fmt = req.query.format;
    if (fmt === 'csv' || fmt === 'xlsx') {
      await logAudit({ userId: req.user.id, action: `Payroll compliance exported (${fmt.toUpperCase()})`, entity: 'EmployeePayrollRun', toValue: month || String(r.year) });
      if (month) {
        const rows = r.rows.map((x) => [x.employeeCode || '', x.name, x.uan || '', x.esiNumber || '', x.pan || '', x.status, x.earnedGross,
          x.pfEmployee, x.pfEmployer, x.pfTotal, x.esiEmployee, x.esiEmployer, x.esiTotal, x.tds, x.professionalTax]);
        const t = r.totals;
        rows.push(['TOTAL', `${t.employees} employee(s)`, '', '', '', '', t.earnedGross, t.pfEmployee, t.pfEmployer, t.pfTotal, t.esiEmployee, t.esiEmployer, t.esiTotal, t.tds, t.professionalTax]);
        await notifyDataIo(req, { kind: 'export', module: 'Payroll', count: rows.length - 1, what: 'payroll compliance rows', format: fmt, detail: `Compliance report ${month}` });
        return sendTable(res, fmt, `payroll-compliance-${month}`,
          ['Code', 'Employee', 'UAN', 'ESI No', 'PAN', 'Status', 'Earned Gross', 'PF Employee', 'PF Employer', 'PF Total', 'ESI Employee', 'ESI Employer', 'ESI Total', 'TDS', 'PT'], rows, 'Compliance');
      }
      const rows = r.months.map((x) => [x.period, x.employees, x.earnedGross, x.pfEmployee, x.pfEmployer, x.pfTotal, x.esiEmployee, x.esiEmployer, x.esiTotal, x.tds, x.professionalTax]);
      const t = r.totals;
      rows.push(['TOTAL', t.employees, t.earnedGross, t.pfEmployee, t.pfEmployer, t.pfTotal, t.esiEmployee, t.esiEmployer, t.esiTotal, t.tds, t.professionalTax]);
      await notifyDataIo(req, { kind: 'export', module: 'Payroll', count: rows.length - 1, what: 'payroll compliance months', format: fmt, detail: `Compliance report ${r.year}` });
      return sendTable(res, fmt, `payroll-compliance-${r.year}`,
        ['Month', 'Employees', 'Earned Gross', 'PF Employee', 'PF Employer', 'PF Total', 'ESI Employee', 'ESI Employer', 'ESI Total', 'TDS', 'PT'], rows, 'Compliance');
    }
    return res.json(r);
  });
};
