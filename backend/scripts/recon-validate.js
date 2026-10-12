#!/usr/bin/env node
// ---------------------------------------------------------------------------
// recon-validate.js - READ-ONLY integrity check of the Accounts books.
//
//   node scripts/recon-validate.js --db <file> [--json]
//
// Checks (each prints OK or the records that break it):
//   B1  statement balances: per imported statement, opening + credits - debits = closing
//       and the printed running balance chains line to line (utils/bankImportCore.checkBalances)
//   B2  account level: opening balance + every line = the last printed balance
//   D1  duplicate lines (same day, direction, amount, reference/narration AND balance)
//   I1  invoice received amount = sum of its receipt rows (where it has rows)
//   I2  stored invoice status = the status its figures derive
//   I3  no invoice has a negative outstanding; Paid invoices have a payment date or a receipt row
//   C1  client totals: sum of the client's invoices = what the client group shows (receivable, received, outstanding)
//   A1  a bank credit never allocated beyond its amount; a line with receipts is Reconciled
//   X1  one bank line is never counted twice: as an expense AND an invoice receipt (or two bills)
//   L1  receipts / bills that point at a bank line that no longer exists
//   T1  dates: receipts dated in the future; receipts dated before their invoice
// Nothing is written.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const dbArg = args.includes('--db') ? args[args.indexOf('--db') + 1] : null;
if (!dbArg) { console.error('Give the database with --db <path> (it is only read).'); process.exit(2); }
const dbPath = path.resolve(dbArg);
if (!fs.existsSync(dbPath)) { console.error('No such file: ' + dbPath); process.exit(2); }
process.env.DATABASE_URL = 'file:' + dbPath.split('\\').join('/');
const { PrismaClient } = require('@prisma/client');
const BIC = require('../src/utils/bankImportCore');
const A = require('../src/utils/accounts');
const prisma = new PrismaClient();

const P = BIC.toPaise;
const today = BIC.istToday();

(async () => {
  const [accounts, txns, imports, invoices, payments, expenses, loanLinks, notes] = await Promise.all([
    prisma.bankAccount.findMany({ orderBy: { createdAt: 'asc' } }),
    prisma.bankTransaction.findMany({ orderBy: [{ date: 'asc' }, { createdAt: 'asc' }] }),
    prisma.bankImport.findMany(),
    prisma.invoice.findMany({ include: { client: { select: { id: true, name: true } } } }),
    prisma.invoicePayment.findMany(),
    prisma.officeExpense.findMany({ select: { id: true, expenseCode: true, bankTxnId: true, monthlyAmount: true, tdsAmount: true } }),
    prisma.handLoanLink.findMany({ select: { bankTxnId: true } }),
    prisma.creditNote.findMany({ where: { status: 'Issued' } }).catch(() => []),
  ]);
  const out = { database: dbPath, counts: { accounts: accounts.length, bankLines: txns.length, imports: imports.length, invoices: invoices.length, receipts: payments.length, expenses: expenses.length }, checks: [] };
  const check = (id, title, bad, note) => out.checks.push({ id, title, ok: bad.length === 0, count: bad.length, note: note || null, sample: bad.slice(0, 8) });
  const firstId = accounts[0] && accounts[0].id;
  const txnById = new Map(txns.map((t) => [t.id, t]));

  // B1 - per statement FILE (a statement repair adds lost lines in a second batch of the same file)
  const b1 = [];
  const notChecked = [];
  const baseName = (n) => String(n || '').replace(/ \(\d+\)(?=\.[a-z]+$)/i, '');
  const groups = new Map();
  txns.filter((t) => t.importFile && t.importBatch).forEach((t) => {
    const k = baseName(t.importFile);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  });
  for (const [file, list] of groups) {
    const allHaveLine = list.every((t) => t.sourceLine != null);
    const ordered = [...list].sort((a, c) => (allHaveLine ? (a.sourceLine - c.sourceLine) : 0) || String(a.createdAt).localeCompare(String(c.createdAt)) || String(a.id).localeCompare(String(c.id)));
    const rows = ordered.map((t, i) => ({ line: t.sourceLine || i + 1, date: t.date, type: t.type, paise: P(t.amount), balance: t.balance, amount: t.amount }));
    const r = BIC.checkBalances(rows, {});
    if (r.checked && r.ok === false) b1.push({ file, lines: rows.length, diff: r.diff, breaks: r.breaks.length, firstBreak: r.breaks[0] && `${r.breaks[0].date} gap ${r.breaks[0].gap}` });
    if (!r.checked) notChecked.push({ file, why: r.limitation });
  }
  check('B1', 'Statement balances tie (opening + credits - debits = closing, running balance chains)', b1, notChecked.length ? `${notChecked.length} statement(s) carry no balance column and could not be checked` : null);

  // B2 - account level
  const b2 = [];
  accounts.forEach((acc) => {
    const mine = txns.filter((t) => (t.bankAccountId || firstId) === acc.id);
    const withBal = mine.filter((t) => t.balance != null);
    if (!withBal.length) return;
    const last = withBal.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.createdAt).localeCompare(String(b.createdAt))).pop();
    const net = mine.reduce((s, t) => s + (t.type === 'Credit' ? P(t.amount) : -P(t.amount)), 0);
    const books = P(acc.openBal) + net;
    if (books !== P(last.balance)) b2.push({ account: `${acc.bank} ${acc.name || ''}`, inBooks: books / 100, printed: last.balance, diff: (P(last.balance) - books) / 100, lastLine: last.date });
  });
  check('B2', 'Account: opening balance + every line = the last printed balance', b2, 'a difference usually means a statement period is missing or the opening balance is not set');

  // D1
  const dm = new Map();
  txns.forEach((t) => {
    const k = [t.bankAccountId || firstId, t.date, t.type, P(t.amount), String(t.reference || '').trim() || BIC.normNarr(t.description).slice(0, 40), t.balance == null ? '' : P(t.balance)].join('|');
    if (!dm.has(k)) dm.set(k, []);
    dm.get(k).push(t);
  });
  check('D1', 'No duplicate bank lines', [...dm.values()].filter((g) => g.length > 1).map((g) => ({ date: g[0].date, amount: g[0].amount, copies: g.length, ids: g.map((x) => x.id) })));

  // I1 / I2 / I3 / C1
  const payBy = new Map();
  payments.forEach((p) => { if (!payBy.has(p.invoiceId)) payBy.set(p.invoiceId, []); payBy.get(p.invoiceId).push(p); });
  const i1 = []; const i2 = []; const i3 = [];
  invoices.forEach((i) => {
    const ps = payBy.get(i.id) || [];
    if (ps.length) {
      const s = ps.reduce((x, p) => x + P(p.amount), 0);
      if (s !== P(i.receivedAmount)) i1.push({ invoice: i.invoiceNumber, receivedOnInvoice: i.receivedAmount, receiptRows: s / 100 });
    }
    if (i.status !== 'Cancelled') {
      const d = A.deriveInvoiceStatus(i);
      // 'Overdue' is derived from the due date and drifts with time; compare the settled / partly settled distinction
      const norm = (x) => (x === 'Overdue' ? 'Pending' : x);
      if (norm(d) !== norm(i.status)) i2.push({ invoice: i.invoiceNumber, stored: i.status, derived: d });
      if (A.invoiceOutstanding(i) < -0.5) i3.push({ invoice: i.invoiceNumber, issue: 'negative outstanding', outstanding: A.invoiceOutstanding(i) });
      if (i.status === 'Paid' && !i.paidDate && !ps.length) i3.push({ invoice: i.invoiceNumber, issue: 'Paid with no payment date and no receipt row' });
    }
  });
  check('I1', 'Invoice received amount = sum of its receipt rows (invoices that have rows)', i1);
  check('I2', 'Stored invoice status = status its figures derive', i2);
  check('I3', 'No negative outstanding; Paid invoices carry a payment date or receipt row', i3, 'invoices Paid with no payment date are listed for review, not changed');
  const byClient = new Map();
  invoices.filter((i) => i.status !== 'Cancelled').forEach((i) => {
    const k = i.clientId;
    const c = byClient.get(k) || { name: i.client ? i.client.name : k, receivable: 0, received: 0, outstanding: 0, n: 0 };
    c.receivable += P(A.invoiceTotal(i)) - P(i.adjustedAmount); c.received += P(i.receivedAmount); c.outstanding += P(A.invoiceOutstanding(i)); c.n += 1;
    byClient.set(k, c);
  });
  const c1 = [...byClient.values()].filter((c) => c.receivable - c.received - P(0) !== c.outstanding && Math.abs((c.receivable - c.received) - c.outstanding) > 100)
    .map((c) => ({ client: c.name, invoices: c.n, receivable: c.receivable / 100, received: c.received / 100, outstanding: c.outstanding / 100, gap: (c.receivable - c.received - c.outstanding) / 100 }));
  check('C1', 'Client totals: receivable - received = outstanding (the difference can only be issued credit / debit notes)', c1, `${byClient.size} client(s); ${notes.length} issued credit/debit note(s) explain gaps`);
  out.totals = {
    clients: byClient.size,
    receivable: [...byClient.values()].reduce((s, c) => s + c.receivable, 0) / 100,
    received: [...byClient.values()].reduce((s, c) => s + c.received, 0) / 100,
    outstanding: [...byClient.values()].reduce((s, c) => s + c.outstanding, 0) / 100,
  };

  // A1
  const allocBy = new Map();
  payments.filter((p) => p.bankTxnId).forEach((p) => allocBy.set(p.bankTxnId, (allocBy.get(p.bankTxnId) || 0) + P(p.amount)));
  const a1 = [];
  allocBy.forEach((v, id) => {
    const t = txnById.get(id);
    if (!t) return;
    if (v > P(t.amount)) a1.push({ txn: id, date: t.date, amount: t.amount, allocated: v / 100, issue: 'allocated more than received' });
    else if (v > 0 && !['Reconciled', 'Reversed'].includes(t.reconStatus)) a1.push({ txn: id, date: t.date, issue: `has receipts but state is ${t.reconStatus}` });
  });
  check('A1', 'Bank credits are never allocated beyond their amount and are Reconciled once allocated', a1);

  // X1
  const x1 = [];
  const exp = new Map();
  expenses.filter((e) => e.bankTxnId).forEach((e) => { if (!exp.has(e.bankTxnId)) exp.set(e.bankTxnId, []); exp.get(e.bankTxnId).push(e); });
  exp.forEach((list, id) => {
    if (allocBy.has(id)) x1.push({ txn: id, issue: 'counted as an expense AND as an invoice receipt' });
    const t = txnById.get(id);
    const sum = list.reduce((s, e) => s + P(e.monthlyAmount) - P(e.tdsAmount), 0);
    if (t && sum > P(t.amount) + 5000) x1.push({ txn: id, issue: `bills linked (${sum / 100}) exceed the line (${t.amount})` });
  });
  loanLinks.forEach((l) => { if (allocBy.has(l.bankTxnId) || exp.has(l.bankTxnId)) x1.push({ txn: l.bankTxnId, issue: 'a hand-loan line is also an expense / receipt' }); });
  check('X1', 'No bank line is counted twice (expense + receipt + hand loan)', x1);

  // L1
  const l1 = [];
  payments.filter((p) => p.bankTxnId && !txnById.has(p.bankTxnId)).forEach((p) => l1.push({ receipt: p.id, missingLine: p.bankTxnId }));
  expenses.filter((e) => e.bankTxnId && !txnById.has(e.bankTxnId)).forEach((e) => l1.push({ expense: e.expenseCode || e.id, missingLine: e.bankTxnId }));
  check('L1', 'Every receipt / bill that points at a bank line points at one that exists', l1);

  // T1
  const t1 = [];
  const invById = new Map(invoices.map((i) => [i.id, i]));
  payments.forEach((p) => {
    if (p.date > today) t1.push({ receipt: p.id, date: p.date, issue: 'dated in the future' });
    const inv = invById.get(p.invoiceId);
    if (inv && inv.invoiceDate && p.date < inv.invoiceDate && Number(p.amount) > 0) t1.push({ receipt: p.id, date: p.date, invoice: inv.invoiceNumber, issue: `before the invoice date ${inv.invoiceDate}` });
  });
  check('T1', 'Receipt dates are not in the future or before their invoice', t1);

  if (args.includes('--json')) console.log(JSON.stringify(out, null, 2));
  else {
    console.log('=== ACCOUNTS INTEGRITY CHECK (read only) ===');
    console.log('database:', dbPath, JSON.stringify(out.counts));
    console.log('client totals (all invoices, by client id):', JSON.stringify(out.totals));
    out.checks.forEach((c) => {
      console.log(`\n[${c.ok ? ' OK ' : 'LOOK'}] ${c.id} ${c.title}${c.count ? ` - ${c.count}` : ''}${c.note ? `\n         note: ${c.note}` : ''}`);
      c.sample.forEach((s) => console.log('         ' + JSON.stringify(s)));
    });
  }
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
