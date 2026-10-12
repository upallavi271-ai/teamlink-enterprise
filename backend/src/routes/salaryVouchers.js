// ---------------------------------------------------------------------------
// ACCOUNTS -> JOURNAL & LEDGER -> EMPLOYEE-WISE SALARY (user spec 2026-10-09).
// Mounted by routes/journal.js at /api/accounts/salary.
//
//   GET  /filters                      Employee / Department / Payroll month / Payment status options (cascading)
//   GET  /vouchers/:id                 one voucher, employee by employee (+ its accounting lines)
//   POST /vouchers/:id/pay             pay all unpaid, or some employees (a part of what is owed)
//   POST /vouchers/:id/adjust          a correction voucher for one employee (a posted voucher is never edited)
//   GET  /banks                        bank accounts for the pay form
//   GET  /subledger                    every employee's Salary payable balance
//   GET  /subledger/:employeeId        one employee: month-wise credited / paid / balance, voucher links
//   GET  /statement                    Employee salary statement (?employeeId&from&to&format=xlsx|csv|pdf)
//
// WHO SEES WHAT: only Accounts roles and Super Admin / Admin (checked on the
// ROLE and on Journal & Ledger / view). Everyone else gets 403 here, and the
// journal list/ledger routes collapse salary lines to account totals for them.
// Every view and export of employee-wise salary leaves an audit row.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../middleware/auth');
const { can, DENIED } = require('../utils/permissions');
const V = require('../utils/payrollVouchers');
const L = require('../utils/ledger');
const { formatOf, sendTable } = require('../utils/exportKit');
const { monthLabel } = require('../utils/attendanceMath');
const { logAudit } = require('../utils/audit');

const router = express.Router();
const FEATURE = 'Journal & Ledger';
const { P, R } = V;

function desk(action) {
  return [requireAuth, async (req, res, next) => {
    try {
      if (!(await L.employeeWiseReady())) return res.status(503).json({ error: 'Employee-wise salary is not switched on yet (database update pending).' });
      if (V.isPrivileged(req.user) && await can(req.user, 'accounts', 'accounts', FEATURE, action)) return next();
      return res.status(403).json(DENIED);
    } catch (err) { return next(err); }
  }];
}

function fail(res, err) {
  if (err && err.status && err.message) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
  throw err;
}

const filtersOf = (q) => ({
  employeeId: q.employeeId ? String(q.employeeId) : '',
  department: q.department ? String(q.department) : '',
  payrollMonth: V.isMonth(q.payrollMonth) ? String(q.payrollMonth) : '',
  paymentStatus: ['PAID', 'UNPAID', 'PARTIAL'].includes(String(q.paymentStatus || '').toUpperCase()) ? String(q.paymentStatus).toUpperCase() : '',
});

router.get('/filters', ...desk('view'), async (req, res) => {
  res.json(await V.facets(filtersOf(req.query)));
});

router.get('/vouchers/:id', ...desk('view'), async (req, res) => {
  const d = await V.voucherDetail(req.params.id);
  if (!d) return res.status(404).json({ error: 'Voucher not found' });
  await V.auditView(req.user, 'Employee-wise salary viewed', 'JournalEntry', d.voucher.id, `${d.voucher.voucherNo} · ${d.voucher.voucherType || 'voucher'} · ${(d.rows || d.payments || []).length} employee(s)`);
  return res.json(d);
});

async function monthOfVoucher(id) {
  const e = await prisma.journalEntry.findUnique({ where: { id }, select: { id: true, voucherType: true, referenceType: true, month: true, referenceId: true } });
  if (!e) return { error: [404, 'Voucher not found'] };
  if (e.voucherType !== V.VOUCHER.PAYROLL || e.referenceType !== 'PAYROLL_MONTH') return { error: [409, 'Only a Payroll voucher can be paid or corrected.'] };
  return { entry: e };
}

router.post('/vouchers/:id/pay', ...desk('create'), async (req, res) => {
  const { entry, error } = await monthOfVoucher(req.params.id);
  if (error) return res.status(error[0]).json({ error: error[1] });
  const b = req.body || {};
  const items = Array.isArray(b.items) && b.items.length ? b.items.map((i) => ({ employeeId: String(i.employeeId || ''), amount: i.amount, reference: i.reference })) : null;
  try {
    const run = await prisma.payrollRun.findUnique({ where: { id: entry.referenceId } });
    const r = await require('../utils/payrollPosting').payMonth(run.month, { id: req.user.id, name: req.user.name }, { // eslint-disable-line global-require
      items, paidDate: b.date, mode: b.mode, reference: b.reference ? String(b.reference).slice(0, 120) : null, bankAccountId: b.bankAccountId || null,
    });
    if (!r.ok) return res.status(502).json({ error: r.error });
    const d = await V.voucherDetail(entry.id);
    return res.json({ ok: true, already: !!r.already, paid: r.paid || 0, voucherNo: r.entry ? (await V.voucherMap()).get(r.entry.id) : null, detail: d });
  } catch (err) { return fail(res, err); }
});

router.post('/vouchers/:id/adjust', ...desk('create'), async (req, res) => {
  const { entry, error } = await monthOfVoucher(req.params.id);
  if (error) return res.status(error[0]).json({ error: error[1] });
  const b = req.body || {};
  try {
    const run = await prisma.payrollRun.findUnique({ where: { id: entry.referenceId } });
    const r = await V.adjust(run.month, { id: req.user.id, name: req.user.name }, {
      employeeId: String(b.employeeId || ''), deltas: b.deltas || {}, reason: b.reason, date: b.date,
    });
    return res.json({ ...r, detail: await V.voucherDetail(entry.id) });
  } catch (err) { return fail(res, err); }
});

router.get('/banks', ...desk('view'), async (req, res) => {
  const banks = await prisma.bankAccount.findMany({ where: { active: true }, orderBy: { createdAt: 'asc' }, select: { id: true, bank: true, name: true, accNo: true } });
  res.json(banks.map((x) => ({ id: x.id, label: `${x.bank}${x.accNo ? ` ·${String(x.accNo).slice(-4)}` : ''}${x.name ? ` — ${x.name}` : ''}` })));
});

// ---- Employee sub-ledger under Salary payable ---------------------------------------------------
async function salaryPayableCode() {
  const PP = require('../utils/payrollPosting'); // eslint-disable-line global-require
  const { map } = await PP.getMapping();
  return map.salaryPayable || '2100';
}

router.get('/subledger', ...desk('view'), async (req, res) => {
  const code = await salaryPayableCode();
  const groups = await prisma.journalLine.groupBy({
    by: ['employeeId', 'employeeName', 'department'], where: { accountCode: code, employeeId: { not: null } }, _sum: { debit: true, credit: true },
  });
  const byEmp = new Map();
  groups.forEach((g) => {
    const e = byEmp.get(g.employeeId) || { employeeId: g.employeeId, name: g.employeeName, department: g.department, credit: 0, debit: 0 };
    e.credit += P(g._sum.credit); e.debit += P(g._sum.debit); if (g.employeeName) e.name = g.employeeName; byEmp.set(g.employeeId, e);
  });
  const q = String(req.query.q || '').trim().toLowerCase();
  let list = [...byEmp.values()].map((e) => ({ ...e, credited: R(e.credit), paid: R(e.debit), balance: R(e.credit - e.debit) }));
  if (q) list = list.filter((e) => `${e.name || ''} ${e.department || ''}`.toLowerCase().includes(q));
  list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  await V.auditView(req.user, 'Employee salary sub-ledger list viewed', 'LedgerAccount', code, `${list.length} employee(s)`);
  res.json({
    accountCode: code, employees: list.map(({ credit, debit, ...e }) => e),
    totals: { credited: R(list.reduce((n, e) => n + P(e.credited), 0)), paid: R(list.reduce((n, e) => n + P(e.paid), 0)), balance: R(list.reduce((n, e) => n + P(e.balance), 0)) },
  });
});

async function subledgerOf(employeeId, from, to) {
  const code = await salaryPayableCode();
  const data = await V.employeeMonths(employeeId, { from, to });
  const lines = await prisma.journalLine.groupBy({ by: ['employeeId'], where: { accountCode: code, employeeId }, _sum: { debit: true, credit: true } });
  const ledgerBalance = lines[0] ? R(P(lines[0]._sum.credit) - P(lines[0]._sum.debit)) : 0;
  let run = 0;
  const months = data.months.map((m) => { run += P(m.net) - P(m.paid); return { ...m, running: R(run) }; });
  const credited = R(months.reduce((n, m) => n + P(m.net), 0));
  const paid = R(months.reduce((n, m) => n + P(m.paid), 0));
  return {
    ...data, months, accountCode: code, credited, paid, balance: R(P(credited) - P(paid)),
    // The ledger's own figure (all periods) - equals the month-wise balance when no period is cut.
    ledgerBalance, matchesLedger: !from && !to ? P(ledgerBalance) === P(credited) - P(paid) : null,
  };
}

router.get('/subledger/:employeeId', ...desk('view'), async (req, res) => {
  const from = V.isMonth(req.query.from) ? req.query.from : null;
  const to = V.isMonth(req.query.to) ? req.query.to : null;
  const d = await subledgerOf(req.params.employeeId, from, to);
  if (!d.name) return res.status(404).json({ error: 'No salary has been booked for this employee yet.' });
  await V.auditView(req.user, 'Employee salary sub-ledger viewed', 'Employee', req.params.employeeId, d.name);
  return res.json(d);
});

// ---- Employee salary statement ------------------------------------------------------------------
const STATEMENT_HEADERS = ['Month', 'Gross', 'PF', 'ESI', 'TDS', 'Other deductions', 'Net pay', 'Corrections (in net)', 'Paid', 'Balance', 'Status', 'Paid on', 'Mode', 'UTR / reference'];
router.get('/statement', ...desk('view'), async (req, res) => {
  const employeeId = String(req.query.employeeId || '');
  if (!employeeId) return res.status(400).json({ error: 'Pick an employee.' });
  const from = V.isMonth(req.query.from) ? req.query.from : null;
  const to = V.isMonth(req.query.to) ? req.query.to : null;
  const d = await subledgerOf(employeeId, from, to);
  if (!d.name) return res.status(404).json({ error: 'No salary has been booked for this employee in this period.' });
  const tot = (k) => R(d.months.reduce((n, m) => n + P(m[k]), 0));
  const totals = { gross: tot('gross'), pf: tot('pf'), esi: tot('esi'), tds: tot('tds'), other: tot('other'), net: tot('net'), paid: tot('paid'), balance: tot('balance') };
  if (req.query.format) {
    const format = formatOf(req.query);
    if (!format) return res.status(400).json({ error: 'Export as Excel (xlsx), CSV or PDF.' });
    const rows = d.months.map((m) => [m.label, m.gross, m.pf, m.esi, m.tds, m.other, m.net, m.adjustments || '', m.paid || '', m.balance, m.statusLabel, m.paidOn || '', m.mode || '', m.reference || '']);
    rows.push(['TOTAL', totals.gross, totals.pf, totals.esi, totals.tds, totals.other, totals.net, '', totals.paid, totals.balance, '', '', '', '']);
    return sendTable(req, res, {
      format, name: `salary-statement-${d.name}`, title: `Salary statement - ${d.name}${d.code ? ` (${d.code})` : ''}`, headers: STATEMENT_HEADERS, rows, sheet: 'Salary statement',
      entity: 'PayrollVoucherEmployee', what: `Salary statement of ${d.name}`, scope: `employee ${d.name}${d.department ? ` · ${d.department}` : ''}`,
      period: from || to ? { from: from || 'start', to: to || 'today' } : null, screen: 'Accounts',
    });
  }
  await V.auditView(req.user, 'Employee salary statement viewed', 'Employee', employeeId, `${d.name} · ${from || 'start'} to ${to || 'today'}`);
  return res.json({ employeeId, name: d.name, code: d.code, department: d.department, from, to, months: d.months, totals });
});

// ---- Employee-wise rows for the Journal export (one row per employee per voucher) ---------------
const EXPORT_HEADERS = ['Voucher No', 'Voucher type', 'Date', 'Payroll month', 'Employee ID', 'Employee', 'Department', 'Gross', 'PF', 'ESI', 'TDS', 'Other deductions', 'Net pay', 'Payment status', 'Paid on', 'Mode', 'UTR / reference'];
async function employeeWiseExport(entryIds, f, kind) {
  const vno = await V.voucherMap();
  const entries = await prisma.journalEntry.findMany({ where: { id: { in: entryIds } }, select: { id: true, date: true, voucherType: true, month: true } });
  const eOf = new Map(entries.map((e) => [e.id, e]));
  const rows = [];
  if (kind === V.VOUCHER.PAYMENT) {
    const pays = await prisma.payrollVoucherPayment.findMany({ where: { journalEntryId: { in: entryIds } }, orderBy: [{ paidOn: 'asc' }, { employeeName: 'asc' }] });
    const deptOf = new Map((await prisma.payrollVoucherEmployee.findMany({ where: { kind: 'PAYROLL', employeeId: { in: [...new Set(pays.map((p) => p.employeeId))] } }, select: { employeeId: true, department: true, employeeCode: true } })).map((r) => [r.employeeId, r]));
    pays.filter((p) => (!f.employeeId || p.employeeId === f.employeeId) && (!f.payrollMonth || p.month === f.payrollMonth)
      && (!f.department || ((deptOf.get(p.employeeId) || {}).department || 'Not set') === f.department)).forEach((p) => {
      const e = eOf.get(p.journalEntryId) || {};
      const d = deptOf.get(p.employeeId) || {};
      rows.push([vno.get(p.journalEntryId), e.voucherType, e.date, monthLabel(p.month), d.employeeCode || '', p.employeeName, d.department || '', '', '', '', '', '', p.amount, 'Paid', p.paidOn, p.mode, p.reference || '']);
    });
    return { headers: EXPORT_HEADERS, rows };
  }
  const data = await prisma.payrollVoucherEmployee.findMany({ where: { journalEntryId: { in: entryIds } }, orderBy: [{ month: 'asc' }, { employeeName: 'asc' }] });
  data.filter((r) => V.matchRow(r, f)).forEach((r) => {
    const e = eOf.get(r.journalEntryId) || {};
    const s = V.shapeRow(r);
    const isAdj = r.kind === 'ADJUSTMENT';
    rows.push([vno.get(r.journalEntryId), e.voucherType, e.date, monthLabel(r.month), r.employeeCode || '', r.employeeName, r.department || '',
      s.gross, s.pf, s.esi, s.tds, s.other, s.net, isAdj ? 'Correction' : V.STATUS_LABEL[r.payStatus], isAdj ? '' : r.paidOn || '', isAdj ? '' : r.payMode || '', isAdj ? (r.note || '') : r.payRef || '']);
  });
  return { headers: EXPORT_HEADERS, rows };
}
router.employeeWiseExport = employeeWiseExport;

module.exports = router;
