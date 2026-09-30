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
//   GET    /entries/:id/bank-matches            candidate bank debits for Mark paid
//   GET    /sync-logs?month=&status=            the delivery log
//   POST   /sync-logs/:id/retry                 retry one row
//   POST   /sync-logs/sweep                     run the automatic retry sweep now
//   GET    /reports/compliance?month=|year=&format=csv|xlsx
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
const S = require('../utils/payrollSync');
const { compliance } = require('../utils/payrollReports');
const { toCsv, toXlsx } = require('../utils/tabularExport');
const { notifyDataIo } = require('../utils/dataIoNotify');

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
    const [prepare, approveH, approveA, post, exportH, ledger] = await Promise.all([
      can(u, 'hrms', 'hrms', 'Payroll & Compensation', 'create'),
      can(u, 'hrms', 'hrms', 'Payroll & Compensation', 'approve'),
      can(u, 'accounts', 'accounts', 'Journal & Ledger', 'approve'),
      can(u, 'accounts', 'accounts', 'Journal & Ledger', 'create'),
      can(u, 'hrms', 'hrms', 'Payroll & Compensation', 'export'),
      can(u, 'accounts', 'accounts', 'Journal & Ledger', 'view'),
    ]);
    const approve = approveH || approveA;
    req.payrollAccess = { prepare, approve, post, ledger, view: prepare || approve || post || exportH || ledger };
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
    const logOf = new Map();
    logs.forEach((l) => { logOf.set(`${l.kind}|${l.employeePayrollRunId}`, l); });
    const sum = (k) => entries.reduce((n, e) => n + (Number(e[k]) || 0), 0);
    const byStatus = {};
    entries.forEach((e) => { byStatus[e.status] = (byStatus[e.status] || 0) + 1; });
    res.json({
      month, period: monthLabel(month), run, access: await accessOf(req), byStatus,
      totals: {
        employees: entries.length, grossPay: sum('grossPay'), lopDeduction: sum('lopDeduction'), earnedGross: sum('earnedGross'),
        totalDeductions: sum('totalDeductions'), netPay: sum('netPay'), pfEmployer: sum('pfEmployer'), esiEmployer: sum('esiEmployer'),
      },
      entries: entries.map((e) => ({
        ...e,
        statusLabel: E.STATUS_LABEL[e.status],
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
      journalPayload: S.buildAccrualPayload(e, e.employee),
    });
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
      month, period: monthLabel(month), workingDays,
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
      return res.status(409).json({ error: `${emp.name}'s ${monthLabel(month)} payroll is ${E.STATUS_LABEL[locked.status]} — attendance can only be changed while it is a draft.` });
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
    if (locked && locked.status !== 'DRAFT') return res.status(409).json({ error: 'The payroll for this month is no longer a draft.' });
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

  router.post('/entries/approve', need('approve'), async (req, res) => {
    const access = await accessOf(req);
    const syncNow = req.body.sync !== false && access.post;
    return bulk(req, res, 'PENDING_APPROVAL', async (e) => {
      const approved = await E.transition(e.id, 'approve', actor(req));
      await S.queueAccrual(approved.id);
      if (!syncNow) return approved;
      const r = await S.syncEntry(approved.id, actor(req));
      // Approval stands even if Accounts is down; the log and the sweep retry it.
      return { ok: true, entry: r.entry, syncError: r.ok ? null : r.log.lastError };
    });
  });

  router.post('/entries/sync', need('post'), (req, res) => bulk(req, res, 'APPROVED', (e) => S.syncEntry(e.id, actor(req))));

  router.post('/entries/mark-paid', need('post'), async (req, res) => {
    const paidDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.paidDate || '')) ? req.body.paidDate : undefined;
    const reference = req.body.reference ? String(req.body.reference).slice(0, 120) : undefined;
    const txnId = req.body.bankTransactionId || null;
    const t = await targetEntries(req, 'SYNCED_TO_ACCOUNTS');
    if (!t) return res.status(400).json({ error: 'Pass ids, or a month (YYYY-MM)' });
    // One bank debit for several records (a salary batch): it must equal their
    // total net pay, and it is linked once to all of them.
    const batch = txnId && t.list.length > 1;
    if (batch) {
      const txn = await prisma.bankTransaction.findUnique({ where: { id: txnId } });
      if (!txn || txn.type !== 'Debit') return res.status(400).json({ error: 'That bank transaction is not a debit on the statement' });
      if (txn.matched || txn.reconStatus !== 'Unmatched') return res.status(409).json({ error: 'That bank transaction is already matched' });
      const total = t.list.filter((e) => e.status === 'SYNCED_TO_ACCOUNTS').reduce((n, e) => n + Math.round(e.netPay * 100), 0);
      if (Math.round(txn.amount * 100) !== total) return res.status(400).json({ error: `The bank debit (${txn.amount}) is not the total net pay of these records (${(total / 100).toFixed(2)})` });
    }
    const r = await runBulk(req, 'SYNCED_TO_ACCOUNTS', (e) => S.payEntry(e.id, actor(req), {
      paidDate, reference, bankTransactionId: txnId, batchTxn: !!batch, autoMatch: !txnId,
    }));
    if (batch && r.body.ok > 0) {
      const names = r.body.results.filter((x) => x.ok).map((x) => x.name).join(', ');
      await S.linkBankTransaction(txnId, `Salary batch: ${names}`, actor(req));
    }
    return res.status(r.status).json(r.body);
  });

  router.get('/entries/:id/bank-matches', need('post'), async (req, res) => {
    const e = await scopedEntry(req, res);
    if (!e) return undefined;
    const cands = await prisma.bankTransaction.findMany({
      where: { type: 'Debit', matched: false, reconStatus: 'Unmatched', date: { gte: `${e.month}-01` } },
      orderBy: { date: 'asc' }, take: 200,
    });
    const net = Math.round(e.netPay * 100);
    const auto = await S.findBankMatch(e, e.employee);
    return res.json({
      suggested: auto ? auto.id : null,
      candidates: cands.filter((t) => Math.round(t.amount * 100) === net).map((t) => ({ id: t.id, date: t.date, description: t.description, amount: t.amount, reference: t.reference })),
    });
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
      employeeName: of.get(l.employeePayrollRunId)?.employee.name || null,
      employeeCode: of.get(l.employeePayrollRunId)?.employee.employeeCode || null,
      entryStatus: of.get(l.employeePayrollRunId)?.status || null,
    })));
  });

  router.post('/sync-logs/:id/retry', need('post'), async (req, res) => {
    try {
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
