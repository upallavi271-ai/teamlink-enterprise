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
const {
  postJournal, isServiceToken, LedgerError, ensureChart, reverseJournal, groupOf, debitNatured, closedUpTo, CLOSED_KEY, employeeWiseReady,
} = require('../utils/ledger');
const { reconciliation } = require('../utils/payrollReports');
const { monthDetails, EXPORT_HEADERS, exportRows } = require('../utils/payrollMonthDetails');
const { formatOf, sendTable: sendKitTable } = require('../utils/exportKit');
const { roleForProduct, SET } = require('../utils/permissions');
const { toCsv, toXlsx } = require('../utils/tabularExport');
const { logAudit } = require('../utils/audit');
const V = require('../utils/payrollVouchers');
const salaryRouter = require('./salaryVouchers');

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
// The service token is the internal door (HRMS payroll / assets -> Accounts);
// otherwise an Accounts user with Journal & Ledger / create.
function bookingAuth(req, res, next) {
  if (isServiceToken(req.get('X-Service-Token'))) {
    req.journalActor = { id: null, name: 'HRMS (service)', service: true };
    return next();
  }
  return requireAuth(req, res, async (authErr) => {
    if (authErr) return next(authErr);
    try {
      if (!(await can(req.user, 'accounts', 'accounts', FEATURE, 'create'))) return res.status(403).json(DENIED);
      req.journalActor = { id: req.user.id, name: req.user.name };
      return next();
    } catch (err) { return next(err); }
  });
}

// REVERSE an entry (S3.5: payroll entries are read-only — reversal only).
//   service token  -> books the mirror entry (HRMS re-open / asset edits)
//   Accounts user  -> a MANUAL entry is reversed here; an HRMS payroll month
//                     is reversed through the payroll module, so HRMS shows
//                     it as "Not posted" again; other HRMS entries are
//                     changed in HRMS, never here.
router.post('/journal-entries/:id/reverse', bookingAuth, async (req, res) => {
  try {
    const entry = await prisma.journalEntry.findUnique({ where: { id: req.params.id } });
    if (!entry) return res.status(404).json({ error: 'Journal entry not found' });
    const narration = req.body && req.body.narration ? String(req.body.narration).slice(0, 300) : null;
    // A depreciation run is Accounts' own booking (from HRMS data): reversible here.
    if (!req.journalActor.service && entry.source !== 'MANUAL' && entry.referenceType !== 'ASSET_DEPRECIATION') {
      if (entry.source === 'HRMS_PAYROLL' && entry.referenceType === 'PAYROLL_MONTH') {
        // eslint-disable-next-line global-require
        const P = require('../utils/payrollPosting');
        const reason = String((req.body && req.body.reason) || '').trim();
        if (!reason) return res.status(400).json({ error: 'Say why this payroll journal is being reversed.' });
        const r = await P.reverseMonth(entry.month, req.journalActor, { toStatus: 'APPROVED', reason });
        if (!r.ok) return res.status(502).json({ error: r.error });
        return res.json({ entry: r.reversal, voucherNo: r.voucherNo, payroll: r.state });
      }
      return res.status(409).json({ error: `This entry comes from ${SOURCE_LABEL[entry.source] || entry.source}. Change it there — Accounts keeps it read-only.` });
    }
    const result = await reverseJournal(entry.id, { actor: req.journalActor, narration });
    if (!result.replay) {
      await logAudit({
        userId: req.journalActor.id, actorName: req.journalActor.name, action: 'Journal entry reversed', entity: 'JournalEntry',
        entityId: entry.id, toValue: `${result.entry.idempotencyKey} · ${result.entry.totalDebit.toFixed(2)}`, reason: (req.body && req.body.reason) || null,
      });
    }
    return res.status(result.status).json({ entry: result.entry, replay: result.replay });
  } catch (err) {
    if (err instanceof LedgerError || (err && err.status && err.message)) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

router.post('/journal-entries', bookingAuth, async (req, res) => {
  try {
    // A service call names the person behind it ("posted_by"), for the record.
    const by = req.journalActor.service && req.body && req.body.posted_by ? { id: null, name: `${String(req.body.posted_by).slice(0, 80)} (via HRMS)` } : req.journalActor;
    const result = await postJournal(req.body, { idempotencyKey: req.get('Idempotency-Key'), actor: by });
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
const SOURCE_LABEL = { MANUAL: 'Manual', HRMS_PAYROLL: 'HRMS Payroll', HRMS_ASSETS: 'HRMS Assets' };
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));

async function accountFilter(account) {
  if (!account) return null;
  const a = await prisma.ledgerAccount.findFirst({ where: { OR: [{ code: account }, { name: account }] } });
  return a ? a.code : '__none__';
}

// Voucher numbers: an entry's position in the (append-only) journal.
const voucherMap = () => V.voucherMap();

// The date window of a request: ?from=&to= (YYYY-MM-DD) or ?month=YYYY-MM.
function windowOf(q) {
  if (q.month) {
    if (!isMonth(q.month)) return { error: 'month must be YYYY-MM' };
    return { month: q.month };
  }
  const from = q.from ? String(q.from) : null;
  const to = q.to ? String(q.to) : null;
  if ((from && !isDate(from)) || (to && !isDate(to))) return { error: 'from / to must be YYYY-MM-DD' };
  if (from && to && from > to) return { error: '"From" is after "To"' };
  return { from, to };
}
const dateWhere = (w) => {
  if (w.month) return { month: w.month };
  const d = {};
  if (w.from) d.gte = w.from;
  if (w.to) d.lte = w.to;
  return Object.keys(d).length ? { date: d } : {};
};

router.get('/chart-of-accounts', ...guard('view'), async (req, res) => {
  await ensureChart();
  const accounts = await prisma.ledgerAccount.findMany({ orderBy: { code: 'asc' } });
  res.json(accounts.map((a) => ({ ...a, group: groupOf(a) })));
});

// A voucher whose lines are employee-wise (Payroll / Payment / Payroll adjustment and their reversals).
const salaryLike = (e) => !!e.voucherType && /^Payroll|^Payment/.test(e.voucherType);
const legacyType = (e) => { try { return JSON.parse(e.payload || '{}').voucher_type || 'Journal'; } catch { return 'Journal'; } };

// Lines of salary vouchers collapse to one row per ledger in the list (the employee-wise
// table is read from /api/accounts/salary/vouchers/:id, Accounts / Admin only).
async function collapsedLines(ids) {
  if (!ids.length) return new Map();
  const g = await prisma.journalLine.groupBy({
    by: ['journalEntryId', 'accountCode', 'accountName'], where: { journalEntryId: { in: ids } }, _sum: { debit: true, credit: true }, _count: { _all: true },
  });
  const out = new Map();
  g.forEach((x) => {
    const arr = out.get(x.journalEntryId) || [];
    arr.push({
      id: `${x.journalEntryId}:${x.accountCode}`, accountCode: x.accountCode, accountName: x.accountName, debit: Math.round((x._sum.debit || 0) * 100) / 100,
      credit: Math.round((x._sum.credit || 0) * 100) / 100, memo: null, lineNo: Number(x.accountCode) || 0,
    });
    out.set(x.journalEntryId, arr);
  });
  out.forEach((arr) => arr.sort((a, b) => (a.debit > 0 ? 0 : 1) - (b.debit > 0 ? 0 : 1) || a.lineNo - b.lineNo));
  return out;
}

router.get('/journal-entries', ...guard('view'), async (req, res) => {
  const w = windowOf(req.query);
  if (w.error) return res.status(400).json({ error: w.error });
  const priv = V.isPrivileged(req.user);
  const ready = await employeeWiseReady();
  const sf = {
    employeeId: ready && req.query.employeeId ? String(req.query.employeeId) : '',
    department: ready && req.query.department ? String(req.query.department) : '',
    payrollMonth: ready && V.isMonth(req.query.payrollMonth) ? String(req.query.payrollMonth) : '',
    paymentStatus: ready && ['PAID', 'UNPAID', 'PARTIAL'].includes(String(req.query.paymentStatus || '').toUpperCase()) ? String(req.query.paymentStatus).toUpperCase() : '',
  };
  const salaryFilter = !!(sf.employeeId || sf.department || sf.payrollMonth || sf.paymentStatus);
  // Who got how much is for Accounts and Admin only - refused outright for anyone else.
  if (salaryFilter && !priv) return res.status(403).json(DENIED);
  const where = { ...dateWhere(w) };
  if (req.query.referenceType) where.referenceType = String(req.query.referenceType);
  if (req.query.referenceId) where.referenceId = String(req.query.referenceId);
  if (req.query.source) where.source = String(req.query.source);
  if (req.query.id) where.id = String(req.query.id);
  const code = await accountFilter(req.query.account);
  if (code) where.lines = { some: { accountCode: code } };
  if (req.query.search) {
    const q = String(req.query.search);
    where.OR = [{ narration: { contains: q } }, { employeeName: { contains: q } }, { idempotencyKey: { contains: q } }, { lines: { some: { referenceId: q } } }];
    // The employee's name is searched only for those allowed to see it.
    if (priv && ready) where.OR.push({ lines: { some: { employeeName: { contains: q } } } });
  }
  const vt = req.query.voucherType ? String(req.query.voucherType) : '';
  const typeWhere = (t) => {
    if (t === 'Journal') return { AND: [{ OR: [{ voucherType: null }, { voucherType: 'Journal' }] }, { NOT: { payload: { contains: '"voucher_type":"Payment"' } } }, { NOT: { referenceType: 'REVERSAL' } }] };
    if (t === 'Payment') return { OR: [{ voucherType: 'Payment' }, { payload: { contains: '"voucher_type":"Payment"' } }] };
    if (t === 'Reversal') return { referenceType: 'REVERSAL' };
    return { voucherType: t };
  };
  const andBase = [];
  let match = null;
  if (salaryFilter) {
    match = await V.matching(sf);
    andBase.push({ id: { in: [...match.ids] } });
  }
  const baseWhere = { ...where, ...(andBase.length ? { AND: andBase } : {}) };
  if (vt && ready) where.AND = [...andBase, typeWhere(vt)]; else if (andBase.length) where.AND = andBase;
  const [entries, vno] = await Promise.all([
    prisma.journalEntry.findMany({ where, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], take: 1000 }),
    V.voucherMap(),
  ]);
  // Lines: salary vouchers one row per ledger; everything else in full.
  const salaryIds = entries.filter(salaryLike).map((e) => e.id);
  const otherIds = entries.filter((e) => !salaryLike(e)).map((e) => e.id);
  const [otherLines, saLines, summaries] = await Promise.all([
    otherIds.length ? prisma.journalLine.findMany({ where: { journalEntryId: { in: otherIds } }, orderBy: { lineNo: 'asc' } }) : [],
    collapsedLines(salaryIds),
    priv && ready ? V.summariesFor(entries) : new Map(),
  ]);
  const linesOf = new Map();
  otherLines.forEach((l) => { const a = linesOf.get(l.journalEntryId) || []; a.push(l); linesOf.set(l.journalEntryId, a); });
  // Which of them are reversed, and what each reversal reverses.
  const keys = entries.map((e) => `${e.idempotencyKey}:reversal`);
  const revs = keys.length ? await prisma.journalEntry.findMany({ where: { idempotencyKey: { in: keys } }, select: { id: true, idempotencyKey: true } }) : [];
  const reversedBy = new Map(revs.map((r) => [r.idempotencyKey.replace(/:reversal$/, ''), r.id]));
  const runIds = [...new Set(entries.filter((e) => e.source === 'HRMS_PAYROLL').map((e) => (e.referenceType === 'REVERSAL' ? (e.idempotencyKey.match(/^payroll-month:([^:]+):/) || [])[1] : e.referenceId)).filter(Boolean))];
  const runs = runIds.length ? await prisma.payrollRun.findMany({ where: { id: { in: runIds } }, select: { id: true, month: true } }) : [];
  const monthOfRun = new Map(runs.map((r) => [r.id, r.month]));
  const shaped = entries.map((e) => {
    const runId = e.source === 'HRMS_PAYROLL' ? (e.referenceType === 'REVERSAL' ? (e.idempotencyKey.match(/^payroll-month:([^:]+):/) || [])[1] : e.referenceId) : null;
    const reversedById = reversedBy.get(e.idempotencyKey) || null;
    const isSalary = salaryLike(e);
    const sm = summaries.get(e.id);
    const scoped = match && match.scope.get(e.id);
    const out = {
      ...e,
      payload: undefined,
      lines: isSalary ? (saLines.get(e.id) || []) : (linesOf.get(e.id) || []),
      voucherNo: vno.get(e.id) || null,
      voucherType: e.voucherType || legacyType(e),
      // The Entry No an import carried (Journal -> Import), so it can be found again.
      entryNo: (() => { try { return JSON.parse(e.payload || '{}').entry_no || null; } catch { return null; } })(),
      imported: e.referenceType === 'JOURNAL_IMPORT' || e.referenceType === 'OPENING_BALANCE',
      sourceLabel: SOURCE_LABEL[e.source] || e.source,
      readOnly: e.source !== 'MANUAL',
      isReversal: e.referenceType === 'REVERSAL',
      reversesId: e.referenceType === 'REVERSAL' ? e.referenceId : null,
      reversesVoucherNo: e.referenceType === 'REVERSAL' ? vno.get(e.referenceId) || null : null,
      reversedById,
      reversedByVoucherNo: reversedById ? vno.get(reversedById) || null : null,
      // What may be done from Accounts: reversal only, and only where it keeps
      // HRMS in step (a payroll month), or for a manual entry.
      canReverse: !reversedById && e.referenceType !== 'REVERSAL' && (e.source === 'MANUAL' || e.referenceType === 'ASSET_DEPRECIATION' || (e.source === 'HRMS_PAYROLL' && e.referenceType === 'PAYROLL_MONTH')),
      payrollMonth: runId ? monthOfRun.get(runId) || null : null,
      assetIds: e.source === 'HRMS_ASSETS' ? [...new Set((linesOf.get(e.id) || []).filter((l) => l.referenceType && l.referenceType.startsWith('ASSET')).map((l) => l.referenceId))] : [],
      employeeWise: isSalary && !!sm && sm.employees.size > 0,
    };
    // Employee-wise figures: Accounts / Admin only, and ONLY in the payload they are allowed to see.
    if (priv && sm && sm.employees.size) {
      out.salary = {
        employees: sm.employees.size, totalNet: Math.round(sm.net) / 100, totalDeductions: Math.round(sm.deductions) / 100, gross: Math.round(sm.gross) / 100,
        paidEmployees: sm.paidEmployees.size, unpaidEmployees: sm.unpaid, paid: Math.round(sm.paid) / 100,
      };
    }
    if (priv && scoped) out.scoped = { employees: scoped.employees.size, net: Math.round(scoped.net) / 100, deductions: Math.round(scoped.deductions) / 100, amount: Math.round(scoped.amount) / 100, paid: Math.round(scoped.paid) / 100 };
    return out;
  });

  if (req.query.format === 'csv' || req.query.format === 'xlsx' || req.query.format === 'pdf') {
    const wantsEmployees = [V.VOUCHER.PAYROLL, V.VOUCHER.PAYMENT, V.VOUCHER.ADJUSTMENT].includes(vt);
    if (wantsEmployees && priv && ready) {
      // One row per employee per voucher, with every active filter applied.
      const fmt = formatOf(req.query);
      const data = await salaryRouter.employeeWiseExport(shaped.map((e) => e.id), sf, vt);
      return sendKitTable(req, res, {
        format: fmt, name: `journal-${vt.toLowerCase().replace(/\s+/g, '-')}-${w.month || w.from || 'all'}`, title: `Journal - ${vt} vouchers, employee-wise`,
        headers: data.headers, rows: data.rows, sheet: 'Employee-wise', entity: 'JournalEntry', what: `Employee-wise ${vt} vouchers`,
        scope: `${shaped.length} voucher(s)${sf.employeeId ? ' · one employee' : ''}${sf.department ? ` · ${sf.department}` : ''}${sf.payrollMonth ? ` · ${sf.payrollMonth}` : ''}${sf.paymentStatus ? ` · ${sf.paymentStatus}` : ''}`,
        screen: 'Accounts',
      });
    }
    const rows = [];
    shaped.forEach((e) => e.lines.forEach((l) => rows.push([
      e.voucherNo, e.date, e.month, e.voucherType, e.sourceLabel, e.narration || '', e.referenceType || '', e.referenceId || '', l.accountCode, l.accountName, l.debit, l.credit,
    ])));
    await logAudit({ userId: req.user.id, action: `Journal exported (${req.query.format.toUpperCase()})`, entity: 'JournalEntry', toValue: `${entries.length} entries` });
    return sendTable(res, req.query.format === 'xlsx' ? 'xlsx' : 'csv', `journal-${w.month || w.from || 'all'}`,
      ['Voucher No', 'Date', 'Month', 'Voucher Type', 'Source', 'Narration', 'Reference Type', 'Reference ID', 'Account Code', 'Account', 'Debit', 'Credit'], rows, 'Journal');
  }
  if (priv && salaryFilter) {
    await V.auditView(req.user, 'Employee-wise salary viewed', 'JournalEntry', sf.employeeId || null, `Journal filter: ${[sf.employeeId && 'employee', sf.department, sf.payrollMonth, sf.paymentStatus].filter(Boolean).join(' · ')} · ${entries.length} voucher(s)`);
  }
  const totals = entries.reduce((a, e) => ({ debit: a.debit + e.totalDebit, credit: a.credit + e.totalCredit }), { debit: 0, credit: 0 });
  // Source counts over every OTHER filter (the Source filter cascades).
  const { source: _s, ...noSource } = where;
  const grouped = await prisma.journalEntry.groupBy({ by: ['source'], where: noSource, _count: { _all: true } });
  const bySource = Object.fromEntries(grouped.map((g) => [g.source, g._count._all]));
  // Voucher types over every other filter.
  let byType = {};
  if (ready) {
    const g = await prisma.journalEntry.groupBy({ by: ['voucherType'], where: baseWhere, _count: { _all: true } });
    g.forEach((x) => { const k = x.voucherType || 'Journal'; byType[k] = (byType[k] || 0) + x._count._all; });
    // Reversals of a voucher carry its type + " reversal"; show them under Reversal.
    Object.keys(byType).forEach((k) => { if (/ reversal$/.test(k)) { byType.Reversal = (byType.Reversal || 0) + byType[k]; delete byType[k]; } });
  }
  return res.json({
    entries: shaped, totals, count: entries.length, bySource, sources: SOURCE_LABEL, byType,
    salaryCards: priv && match ? match.cards : null, canSeeSalary: priv && ready,
  });
});

const r2 = (n) => Math.round(n * 100) / 100;
const natural = (a, dr, cr) => (debitNatured(a) ? dr - cr : cr - dr);

// Per-account totals (a trial balance for the filter), and the lines of one
// account when ?account= is given — with the opening balance (before the
// window), every line's running balance and the closing balance.
router.get('/ledger', ...guard('view'), async (req, res) => {
  const w = windowOf(req.query);
  if (w.error) return res.status(400).json({ error: w.error });
  const start = w.month ? `${w.month}-01` : w.from;
  const end = w.month ? `${w.month}-31` : w.to;
  const code = await accountFilter(req.query.account);
  const lineWhere = {};
  if (code) lineWhere.accountCode = code;
  const [accounts, rawLines, vno] = await Promise.all([
    prisma.ledgerAccount.findMany({ orderBy: { code: 'asc' } }),
    prisma.journalLine.findMany({ where: { ...lineWhere, ...(end ? { journalEntry: { date: { lte: end } } } : {}) }, include: { journalEntry: true } }),
    voucherMap(),
  ]);
  // WHO GOT HOW MUCH is for Accounts / Admin only: for anyone else a voucher's employee lines on one
  // ledger are one line (the voucher total), with no names (enforced here, on the payload).
  let lines = rawLines;
  if (!V.isPrivileged(req.user) && rawLines.some((l) => l.employeeId)) {
    const keep = [];
    const merged = new Map();
    rawLines.forEach((l) => {
      if (!l.employeeId) { keep.push(l); return; }
      const k = `${l.journalEntryId}|${l.accountCode}`;
      const m = merged.get(k);
      if (m) { m.debit += l.debit; m.credit += l.credit; } else merged.set(k, { ...l, memo: null, employeeId: null, employeeName: null, department: null, id: k });
    });
    lines = [...keep, ...[...merged.values()].map((m) => ({ ...m, debit: Math.round(m.debit * 100) / 100, credit: Math.round(m.credit * 100) / 100 }))];
  }
  const byCode = new Map(accounts.map((a) => [a.code, { code: a.code, name: a.name, type: a.type, group: groupOf(a), openDr: 0, openCr: 0, debit: 0, credit: 0, lines: 0 }]));
  lines.sort((a, b) => (a.journalEntry.date < b.journalEntry.date ? -1 : a.journalEntry.date > b.journalEntry.date ? 1 : (a.createdAt - b.createdAt) || (a.lineNo - b.lineNo)));
  lines.forEach((l) => {
    const row = byCode.get(l.accountCode) || { code: l.accountCode, name: l.accountName, type: '', group: 'Other', openDr: 0, openCr: 0, debit: 0, credit: 0, lines: 0 };
    if (start && l.journalEntry.date < start) { row.openDr += l.debit; row.openCr += l.credit; } else { row.debit += l.debit; row.credit += l.credit; row.lines += 1; }
    byCode.set(l.accountCode, row);
  });
  const summary = [...byCode.values()].filter((r) => !code || r.code === code).map((r) => ({
    ...r,
    opening: r2(natural(r, r.openDr, r.openCr)),
    balance: r2(natural(r, r.openDr + r.debit, r.openCr + r.credit)), // closing
    movement: r2(natural(r, r.debit, r.credit)),
  }));
  if (req.query.format === 'csv' || req.query.format === 'xlsx') {
    return sendTable(res, req.query.format, `ledger-${w.month || w.from || 'all'}${code ? `-${code}` : ''}`,
      ['Code', 'Account', 'Group', 'Type', 'Opening', 'Debit', 'Credit', 'Closing'], summary.map((r) => [r.code, r.name, r.group, r.type, r.opening, r.debit, r.credit, r.balance]), 'Ledger');
  }
  let out = [];
  if (code) {
    const acct = summary[0] || { type: '' };
    let run = acct.opening || 0;
    // Asset lines name the asset (S2.6): id, name, holder.
    const assetIds = [...new Set(lines.filter((l) => l.referenceType && l.referenceType.startsWith('ASSET')).map((l) => l.referenceId))];
    const assets = assetIds.length && prisma.asset ? await prisma.asset.findMany({ where: { id: { in: assetIds } }, include: { assignedTo: { select: { name: true } } } }) : [];
    const assetOf = new Map(assets.map((a) => [a.id, a]));
    out = lines.filter((l) => !start || l.journalEntry.date >= start).map((l) => {
      run += debitNatured(acct) ? l.debit - l.credit : l.credit - l.debit;
      const a = assetOf.get(l.referenceId);
      return {
        id: l.id, date: l.journalEntry.date, month: l.journalEntry.month, narration: l.journalEntry.narration, memo: l.memo,
        voucherNo: vno.get(l.journalEntryId) || null, source: l.journalEntry.source, sourceLabel: SOURCE_LABEL[l.journalEntry.source] || l.journalEntry.source,
        referenceType: l.referenceType, referenceId: l.referenceId, debit: l.debit, credit: l.credit, balance: r2(run), journalEntryId: l.journalEntryId,
        asset: a ? { id: a.id, code: a.assetCode, name: a.name, holder: a.assignedTo ? a.assignedTo.name : null } : null,
      };
    });
  }
  return res.json({ summary, lines: out, window: { from: start || null, to: end || null } });
});

// ---- Reports: Trial Balance, Profit & Loss, Balance Sheet -----------------------
async function balancesUpTo({ from = null, to = null } = {}) {
  const [accounts, lines] = await Promise.all([
    prisma.ledgerAccount.findMany({ orderBy: { code: 'asc' } }),
    prisma.journalLine.findMany({ where: to ? { journalEntry: { date: { lte: to } } } : {}, include: { journalEntry: { select: { date: true, source: true } } } }),
  ]);
  const byCode = new Map(accounts.map((a) => [a.code, { code: a.code, name: a.name, type: a.type, group: groupOf(a), openDr: 0, openCr: 0, debit: 0, credit: 0, payroll: 0 }]));
  lines.forEach((l) => {
    const r = byCode.get(l.accountCode);
    if (!r) return;
    if (from && l.journalEntry.date < from) { r.openDr += l.debit; r.openCr += l.credit; } else {
      r.debit += l.debit; r.credit += l.credit;
      if (l.journalEntry.source === 'HRMS_PAYROLL') r.payroll += l.debit - l.credit;
    }
  });
  return [...byCode.values()];
}

router.get('/reports/trial-balance', ...guard('view'), async (req, res) => {
  const w = windowOf(req.query);
  if (w.error) return res.status(400).json({ error: w.error });
  const from = w.month ? `${w.month}-01` : w.from;
  const to = w.month ? `${w.month}-31` : w.to;
  const rows = (await balancesUpTo({ from, to })).map((r) => {
    const open = r.openDr - r.openCr;
    const close = open + r.debit - r.credit;
    return {
      code: r.code, name: r.name, group: r.group, type: r.type,
      openingDr: r2(Math.max(open, 0)), openingCr: r2(Math.max(-open, 0)),
      debit: r2(r.debit), credit: r2(r.credit),
      closingDr: r2(Math.max(close, 0)), closingCr: r2(Math.max(-close, 0)),
    };
  }).filter((r) => r.openingDr || r.openingCr || r.debit || r.credit || req.query.all === '1');
  const sum = (k) => r2(rows.reduce((n, r) => n + r[k], 0));
  const totals = { openingDr: sum('openingDr'), openingCr: sum('openingCr'), debit: sum('debit'), credit: sum('credit'), closingDr: sum('closingDr'), closingCr: sum('closingCr') };
  totals.balanced = Math.round(totals.closingDr * 100) === Math.round(totals.closingCr * 100) && Math.round(totals.debit * 100) === Math.round(totals.credit * 100);
  if (req.query.format === 'csv' || req.query.format === 'xlsx') {
    const out = rows.map((r) => [r.code, r.name, r.group, r.openingDr, r.openingCr, r.debit, r.credit, r.closingDr, r.closingCr]);
    out.push(['', 'TOTAL', '', totals.openingDr, totals.openingCr, totals.debit, totals.credit, totals.closingDr, totals.closingCr]);
    return sendTable(res, req.query.format, `trial-balance-${from || 'start'}-${to || 'today'}`,
      ['Code', 'Account', 'Group', 'Opening Dr', 'Opening Cr', 'Debit', 'Credit', 'Closing Dr', 'Closing Cr'], out, 'Trial Balance');
  }
  return res.json({ from: from || null, to: to || null, rows, totals });
});

router.get('/reports/profit-loss', ...guard('view'), async (req, res) => {
  const w = windowOf(req.query);
  if (w.error) return res.status(400).json({ error: w.error });
  const from = w.month ? `${w.month}-01` : w.from;
  const to = w.month ? `${w.month}-31` : w.to;
  const all = await balancesUpTo({ from, to });
  const income = all.filter((r) => r.type === 'INCOME').map((r) => ({ code: r.code, name: r.name, group: r.group, amount: r2(r.credit - r.debit) })).filter((r) => r.amount);
  const expenses = all.filter((r) => r.type === 'EXPENSE').map((r) => ({ code: r.code, name: r.name, group: r.group, amount: r2(r.debit - r.credit), payroll: r2(r.payroll) })).filter((r) => r.amount);
  const totalIncome = r2(income.reduce((n, r) => n + r.amount, 0));
  const totalExpenses = r2(expenses.reduce((n, r) => n + r.amount, 0));
  const payrollCost = r2(expenses.reduce((n, r) => n + (r.payroll || 0), 0));
  if (req.query.format === 'csv' || req.query.format === 'xlsx') {
    const out = [...income.map((r) => ['Income', r.code, r.name, r.amount]), ['', '', 'Total income', totalIncome],
      ...expenses.map((r) => ['Expenses', r.code, r.name, r.amount]), ['', '', 'Total expenses', totalExpenses], ['', '', 'Net profit / (loss)', r2(totalIncome - totalExpenses)]];
    return sendTable(res, req.query.format, `profit-loss-${from || 'start'}-${to || 'today'}`, ['Section', 'Code', 'Account', 'Amount'], out, 'Profit & Loss');
  }
  return res.json({
    from: from || null, to: to || null, income, expenses, totalIncome, totalExpenses, payrollCost, netProfit: r2(totalIncome - totalExpenses),
    note: 'From the journal only: payroll and asset entries booked here, plus any manual entries. Client invoices and office bills are reported in Office & Accounts.',
  });
});

router.get('/reports/balance-sheet', ...guard('view'), async (req, res) => {
  const asOf = req.query.asOf ? String(req.query.asOf) : null;
  if (asOf && !isDate(asOf)) return res.status(400).json({ error: 'asOf must be YYYY-MM-DD' });
  const all = await balancesUpTo({ to: asOf });
  const bal = (r) => r2(r.debit - r.credit);
  // Fixed assets shown NET of accumulated depreciation, per category (15NN pairs with 16NN).
  const fixed = all.filter((r) => r.group === 'Fixed Assets').map((r) => {
    const dep = all.find((x) => x.code === `16${r.code.slice(2)}`);
    const gross = bal(r);
    const acc = dep ? r2(dep.credit - dep.debit) : 0;
    return { code: r.code, name: r.name, gross, accumulatedDepreciation: acc, net: r2(gross - acc) };
  }).filter((r) => r.gross || r.accumulatedDepreciation);
  const pairedDep = new Set(fixed.map((f) => `16${f.code.slice(2)}`));
  const strayDep = all.filter((r) => r.group === 'Accumulated Depreciation' && !pairedDep.has(r.code)).map((r) => ({ code: r.code, name: r.name, amount: r2(r.credit - r.debit) })).filter((r) => r.amount);
  const current = all.filter((r) => ['Cash & Bank', 'Current Assets'].includes(r.group)).map((r) => ({ code: r.code, name: r.name, group: r.group, amount: bal(r) })).filter((r) => r.amount);
  const liabilities = all.filter((r) => r.type === 'LIABILITY').map((r) => ({ code: r.code, name: r.name, group: r.group, amount: r2(r.credit - r.debit) })).filter((r) => r.amount);
  const equity = all.filter((r) => r.type === 'EQUITY').map((r) => ({ code: r.code, name: r.name, amount: r2(r.credit - r.debit) })).filter((r) => r.amount);
  const profit = r2(all.filter((r) => r.type === 'INCOME').reduce((n, r) => n + r.credit - r.debit, 0) - all.filter((r) => r.type === 'EXPENSE').reduce((n, r) => n + r.debit - r.credit, 0));
  const fixedNet = r2(fixed.reduce((n, r) => n + r.net, 0) - strayDep.reduce((n, r) => n + r.amount, 0));
  const totalAssets = r2(fixedNet + current.reduce((n, r) => n + r.amount, 0));
  const totalLiabilities = r2(liabilities.reduce((n, r) => n + r.amount, 0));
  const totalEquity = r2(equity.reduce((n, r) => n + r.amount, 0) + profit);
  return res.json({
    asOf: asOf || null, fixedAssets: fixed, strayDepreciation: strayDep, fixedAssetsNet: fixedNet, currentAssets: current, totalAssets,
    liabilities, totalLiabilities, equity, profitToDate: profit, totalEquity, balanced: Math.round(totalAssets * 100) === Math.round((totalLiabilities + totalEquity) * 100),
    note: 'From the journal only (payroll, assets and manual entries). Profit to date is the journal’s income less expenses.',
  });
});

// ---- Payroll Ledger Mapping (a tab of Journal & Ledger, S3.3) ------------------
router.get('/payroll-mapping', ...guard('view'), async (req, res) => {
  // eslint-disable-next-line global-require
  const P = require('../utils/payrollPosting');
  const m = await P.getMapping();
  const accounts = await prisma.ledgerAccount.findMany({ orderBy: { code: 'asc' } });
  let problem = null;
  try { await P.resolveMapping(m.map); } catch (err) { problem = err.message; }
  res.json({
    ...m, problem,
    components: P.ALL_COMPONENTS.map((c) => ({ key: c.key, label: c.label, side: c.side || 'credit', group: c.group, expects: c.expects, defaultCode: c.def })),
    accounts: accounts.map((a) => ({ code: a.code, name: a.name, type: a.type, group: groupOf(a), isActive: a.isActive })),
    canEdit: await can(req.user, 'accounts', 'accounts', FEATURE, 'edit'),
  });
});

router.put('/payroll-mapping', ...guard('edit'), async (req, res) => {
  // eslint-disable-next-line global-require
  const P = require('../utils/payrollPosting');
  try {
    const m = await P.saveMapping((req.body && req.body.map) || {}, { id: req.user.id, name: req.user.name });
    return res.json(m);
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

// A new ledger for the mapping (e.g. a separate "Bonus Expense"). Expenses
// get 5xxx codes, payables 2xxx; the group follows from the type.
router.post('/ledger-accounts', ...guard('edit'), async (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 80);
  const type = String((req.body && req.body.type) || '').toUpperCase();
  if (!name) return res.status(400).json({ error: 'Give the ledger a name.' });
  if (!['EXPENSE', 'LIABILITY', 'ASSET', 'INCOME', 'EQUITY'].includes(type)) return res.status(400).json({ error: 'Pick a type.' });
  if (await prisma.ledgerAccount.findUnique({ where: { name } })) return res.status(409).json({ error: 'A ledger with that name already exists.' });
  const base = { EXPENSE: 5500, LIABILITY: 2500, ASSET: 1700, INCOME: 4500, EQUITY: 3100 }[type];
  const used = new Set((await prisma.ledgerAccount.findMany({ select: { code: true } })).map((a) => a.code));
  let n = base;
  while (used.has(String(n))) n += 1;
  const a = await prisma.ledgerAccount.create({ data: { code: String(n), name, type, description: (req.body && req.body.description) || null } });
  await logAudit({ userId: req.user.id, action: 'Ledger account created', entity: 'LedgerAccount', entityId: a.id, toValue: `${a.code} · ${a.name} (${type})` });
  return res.status(201).json({ ...a, group: groupOf(a) });
});

// Books closed up to (YYYY-MM): asset changes into a closed month are
// refused with a warning unless confirmed (S2.3).
router.get('/settings/books-closed', ...guard('view'), async (req, res) => res.json({ closedUpTo: await closedUpTo() }));
router.put('/settings/books-closed', ...guard('edit'), async (req, res) => {
  const v = req.body && req.body.closedUpTo ? String(req.body.closedUpTo) : null;
  if (v && !isMonth(v)) return res.status(400).json({ error: 'Pick a month (YYYY-MM), or clear it.' });
  const before = await closedUpTo();
  await prisma.appSetting.upsert({
    where: { key: CLOSED_KEY },
    update: { value: JSON.stringify(v), updatedById: req.user.id, updatedByName: req.user.name },
    create: { key: CLOSED_KEY, value: JSON.stringify(v), updatedById: req.user.id, updatedByName: req.user.name },
  });
  await logAudit({ userId: req.user.id, action: 'Books closed up to changed', entity: 'AppSetting', entityId: CLOSED_KEY, fromValue: before || 'open', toValue: v || 'open' });
  return res.json({ closedUpTo: v });
});

// ---- Payroll months as Accounts sees them (Posted / Not posted / Paid) ------------
router.get('/payroll-months', ...guard('view'), async (req, res) => {
  // eslint-disable-next-line global-require
  const P = require('../utils/payrollPosting');
  const runs = await prisma.employeePayrollRun.groupBy({ by: ['month'], orderBy: { month: 'desc' }, take: 36 });
  const pcSettings = await require('../utils/payrollCycle').getSettings(); // payroll cycle: the dates behind each month name
  const out = [];
  for (const r of runs) {
    // eslint-disable-next-line no-await-in-loop
    const st = await P.monthState(r.month);
    const cyc = require('../utils/payrollCycle').cycleOf(r.month, pcSettings.cycle);
    out.push({ ...st, rangeText: cyc.rangeText, heading: cyc.heading, periodFrom: cyc.from, periodTo: cyc.to, periodDays: cyc.days, journalEntry: st.journalEntry ? { ...st.journalEntry, lines: undefined } : null });
  }
  res.json({ months: out, canPost: await can(req.user, 'accounts', 'accounts', FEATURE, 'create') });
});

// ---- One payroll month, employee by employee (Accounts -> Payroll months -> Open) ----
// Accounts roles and Super Admin / Admin ONLY - checked on the role as well as on
// the Journal & Ledger permission, so a Manager / TL / HR / Employee gets 403 here
// whatever a custom rule says.
async function payrollDesk(req, res, next) {
  try {
    const role = roleForProduct(req.user, 'accounts');
    if (SET.ACCOUNTS.includes(role) && await can(req.user, 'accounts', 'accounts', FEATURE, 'view')) return next();
    return res.status(403).json(DENIED);
  } catch (err) { return next(err); }
}
router.get('/payroll-months/:month/details', requireAuth, payrollDesk, async (req, res) => {
  const month = req.params.month;
  if (!isMonth(month)) return res.status(400).json({ error: 'month must be YYYY-MM' });
  const d = await monthDetails(month, { q: req.query.q, department: req.query.department, paymentStatus: req.query.paymentStatus });
  const format = req.query.format ? formatOf(req.query) : null;
  if (req.query.format) {
    if (!format || format === 'pdf') return res.status(400).json({ error: 'Export as Excel (xlsx) or CSV.' });
    if (!d.rows.length) return res.status(404).json({ error: 'There are no employees to export for this month and filter.' });
    return sendKitTable(req, res, {
      format, name: `payroll-${month}`, title: `Payroll ${d.cycle ? d.cycle.heading : d.period}`, headers: EXPORT_HEADERS, rows: exportRows(d), sheet: `Payroll ${month}`,
      entity: 'EmployeePayrollRun', what: `Payroll ${d.period}`, scope: d.filtered ? 'filtered employees' : 'all employees of the month', screen: 'Accounts',
    });
  }
  return res.json(d);
});

// POSTED VOUCHERS ARE READ-ONLY: no edit, no delete - only a reversal, or (payroll) an adjustment voucher.
router.all('/journal-entries/:id', requireAuth, (req, res, next) => {
  if (['PUT', 'PATCH', 'DELETE'].includes(req.method)) return res.status(405).json({ error: 'A posted voucher can not be edited or deleted. Reverse it, or for salary book a correction (adjustment) voucher.' });
  return next();
});

// EMPLOYEE-WISE SALARY (user spec 2026-10-09): routes/salaryVouchers.js, own guards.
router.use('/salary', salaryRouter);

// Journal / Ledger IMPORT (Accounts fixes 2026-10-09): routes/booksImport.js, own guards.
router.use('/books-import', require('./booksImport'));

// ---- Payroll reconciliation: HRMS run totals vs ledger booked -------------------
router.get('/reports/payroll-reconciliation', ...guard('view'), async (req, res) => {
  const month = req.query.month;
  if (!isMonth(month)) return res.status(400).json({ error: 'month is required (YYYY-MM)' });
  const r = await reconciliation(month);
  // Per-employee rows name who got what: Accounts / Admin only.
  if (!V.isPrivileged(req.user)) { r.rows = []; r.rowsHidden = true; }
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

// Fixed assets (S2): HRMS assets + repairs -> journal, depreciation, reports.
router.use('/fixed-assets', require('./assetAccounts'));

module.exports = router;
