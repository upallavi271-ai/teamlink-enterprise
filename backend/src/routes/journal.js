// ---------------------------------------------------------------------------
// ACCOUNTS — Journal & Ledger (SPEC B §6-§8). Mounted at /api/accounts.
//
//   POST /journal-entries                 the internal booking API. HRMS payroll
//                                         calls it with X-Service-Token; an
//                                         Accounts user with Journal & Ledger /
//                                         create may call it too. Idempotent
//                                         per idempotency_key.
//   GET  /journal-entries                 ?month=YYYY-MM&account=<code|name>&referenceType=&search=&format=csv|xlsx
//   GET  /ledger                          ?month=&account= — per-account totals (+ lines for one account)
//   GET  /chart-of-accounts
//   GET  /reports/payroll-reconciliation  ?month=&format=csv|xlsx
//
// Access: Accounts roles and Super Admin / Admin only (the "Journal &
// Ledger" feature of the accounts module; a Manager's default Accounts reach
// does not include it). Every route carries its own guard — there is no
// router-level middleware, so this router never intercepts another
// /api/accounts/* route.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../middleware/auth');
const { can, DENIED } = require('../utils/permissions');
const { postJournal, isServiceToken, LedgerError, ensureChart } = require('../utils/ledger');
const { reconciliation } = require('../utils/payrollReports');
const { toCsv, toXlsx } = require('../utils/tabularExport');
const { logAudit } = require('../utils/audit');

const router = express.Router();
const FEATURE = 'Journal & Ledger';

function guard(action) {
  return [requireAuth, async (req, res, next) => {
    try {
      if (await can(req.user, 'accounts', 'accounts', FEATURE, action)) return next();
      return res.status(403).json(DENIED);
    } catch (err) { return next(err); }
  }];
}

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

const isMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));

// ---- The internal booking API ------------------------------------------------
router.post('/journal-entries', async (req, res, next) => {
  // The service token is the internal door (HRMS payroll -> Accounts).
  if (isServiceToken(req.get('X-Service-Token'))) {
    req.journalActor = { id: null, name: 'HRMS Payroll (service)' };
    return next();
  }
  // Otherwise an Accounts user.
  return requireAuth(req, res, async (authErr) => {
    if (authErr) return next(authErr);
    try {
      if (!(await can(req.user, 'accounts', 'accounts', FEATURE, 'create'))) return res.status(403).json(DENIED);
      req.journalActor = { id: req.user.id, name: req.user.name };
      return next();
    } catch (err) { return next(err); }
  });
}, async (req, res) => {
  try {
    const result = await postJournal(req.body, { idempotencyKey: req.get('Idempotency-Key'), actor: req.journalActor });
    if (!result.replay) {
      await logAudit({
        userId: req.journalActor.id, actorName: req.journalActor.name, action: 'Journal entry booked', entity: 'JournalEntry',
        entityId: result.entry.id, toValue: `${result.entry.idempotencyKey} · ${result.entry.totalDebit.toFixed(2)}`,
      });
    }
    return res.status(result.status).json({ entry: result.entry, replay: result.replay });
  } catch (err) {
    if (err instanceof LedgerError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

// ---- Reads --------------------------------------------------------------------
async function accountFilter(account) {
  if (!account) return null;
  const a = await prisma.ledgerAccount.findFirst({ where: { OR: [{ code: account }, { name: account }] } });
  return a ? a.code : '__none__';
}

router.get('/chart-of-accounts', ...guard('view'), async (req, res) => {
  await ensureChart();
  res.json(await prisma.ledgerAccount.findMany({ orderBy: { code: 'asc' } }));
});

router.get('/journal-entries', ...guard('view'), async (req, res) => {
  const where = {};
  if (req.query.month) {
    if (!isMonth(req.query.month)) return res.status(400).json({ error: 'month must be YYYY-MM' });
    where.month = req.query.month;
  }
  if (req.query.referenceType) where.referenceType = String(req.query.referenceType);
  if (req.query.referenceId) where.referenceId = String(req.query.referenceId);
  const code = await accountFilter(req.query.account);
  if (code) where.lines = { some: { accountCode: code } };
  if (req.query.search) {
    const q = String(req.query.search);
    where.OR = [{ narration: { contains: q } }, { employeeName: { contains: q } }, { idempotencyKey: { contains: q } }];
  }
  const entries = await prisma.journalEntry.findMany({
    where, include: { lines: { orderBy: { lineNo: 'asc' } } }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], take: 1000,
  });
  if (req.query.format === 'csv' || req.query.format === 'xlsx') {
    const rows = [];
    entries.forEach((e) => e.lines.forEach((l) => rows.push([
      e.date, e.month, e.narration || '', e.referenceType || '', e.referenceId || '', e.idempotencyKey, l.accountCode, l.accountName, l.debit, l.credit,
    ])));
    await logAudit({ userId: req.user.id, action: `Journal exported (${req.query.format.toUpperCase()})`, entity: 'JournalEntry', toValue: `${entries.length} entries` });
    return sendTable(res, req.query.format, `journal-${req.query.month || 'all'}`,
      ['Date', 'Month', 'Narration', 'Reference Type', 'Reference ID', 'Idempotency Key', 'Account Code', 'Account', 'Debit', 'Credit'], rows, 'Journal');
  }
  const totals = entries.reduce((a, e) => ({ debit: a.debit + e.totalDebit, credit: a.credit + e.totalCredit }), { debit: 0, credit: 0 });
  return res.json({ entries, totals, count: entries.length });
});

// Per-account totals (a trial balance for the filter), and the lines of one
// account when ?account= is given.
router.get('/ledger', ...guard('view'), async (req, res) => {
  const where = {};
  if (req.query.month) {
    if (!isMonth(req.query.month)) return res.status(400).json({ error: 'month must be YYYY-MM' });
    where.journalEntry = { month: req.query.month };
  }
  const code = await accountFilter(req.query.account);
  if (code) where.accountCode = code;
  const [accounts, lines] = await Promise.all([
    prisma.ledgerAccount.findMany({ orderBy: { code: 'asc' } }),
    prisma.journalLine.findMany({ where, include: { journalEntry: true }, orderBy: { createdAt: 'asc' } }),
  ]);
  const byCode = new Map(accounts.map((a) => [a.code, { code: a.code, name: a.name, type: a.type, debit: 0, credit: 0, lines: 0 }]));
  lines.forEach((l) => {
    const row = byCode.get(l.accountCode) || { code: l.accountCode, name: l.accountName, type: '', debit: 0, credit: 0, lines: 0 };
    row.debit += l.debit; row.credit += l.credit; row.lines += 1;
    byCode.set(l.accountCode, row);
  });
  const summary = [...byCode.values()].filter((r) => !code || r.code === code).map((r) => ({
    ...r,
    // Natural balance: assets and expenses are debit-balance accounts.
    balance: ['ASSET', 'EXPENSE'].includes(r.type) ? r.debit - r.credit : r.credit - r.debit,
  }));
  if (req.query.format === 'csv' || req.query.format === 'xlsx') {
    return sendTable(res, req.query.format, `ledger-${req.query.month || 'all'}${code ? `-${code}` : ''}`,
      ['Code', 'Account', 'Type', 'Debit', 'Credit', 'Balance'], summary.map((r) => [r.code, r.name, r.type, r.debit, r.credit, r.balance]), 'Ledger');
  }
  return res.json({
    summary,
    lines: code ? lines.map((l) => ({
      id: l.id, date: l.journalEntry.date, month: l.journalEntry.month, narration: l.journalEntry.narration,
      referenceType: l.referenceType, referenceId: l.referenceId, debit: l.debit, credit: l.credit, journalEntryId: l.journalEntryId,
    })) : [],
  });
});

// ---- Payroll reconciliation: HRMS run totals vs ledger booked -------------------
router.get('/reports/payroll-reconciliation', ...guard('view'), async (req, res) => {
  const month = req.query.month;
  if (!isMonth(month)) return res.status(400).json({ error: 'month is required (YYYY-MM)' });
  const r = await reconciliation(month);
  if (req.query.format === 'csv' || req.query.format === 'xlsx') {
    const rows = r.rows.map((x) => [
      x.employeeCode || '', x.name, x.status || '', x.costToCompany, x.expectedDebit, x.bookedDebit, x.difference,
      x.ok ? 'OK' : x.flags.join(' + '),
      x.diffs.map((d) => `${d.accountName}: expected Dr ${d.expectedDebit} Cr ${d.expectedCredit}, booked Dr ${d.bookedDebit} Cr ${d.bookedCredit}`).join('; '),
    ]);
    rows.push([]);
    rows.push(['TOTAL', r.period, '', r.hrms.totalCost, '', r.ledger.salaryExpense, r.difference, `${r.mismatches} mismatch(es)`, '']);
    await logAudit({ userId: req.user.id, action: `Payroll reconciliation exported (${req.query.format.toUpperCase()})`, entity: 'JournalEntry', toValue: month });
    return sendTable(res, req.query.format, `payroll-reconciliation-${month}`,
      ['Code', 'Employee', 'Payroll Status', 'HRMS Cost (Dr Salary Expense)', 'Expected Debits', 'Booked Debits', 'Difference', 'Result', 'Detail'], rows, 'Reconciliation');
  }
  return res.json(r);
});

module.exports = router;
