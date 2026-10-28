#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ARE THE BANK STATEMENT LINES AND THE PAYMENTS MATCHED CORRECTLY? (Accounts, 2026-10-28). READ ONLY.
//   cd backend && node scripts/bank-match-check.js                    the database in prisma/dev.db
//   node scripts/bank-match-check.js --db /path/to/live.db            another copy (on the server: the live database file)
//   node scripts/bank-match-check.js --full                           every row of every problem, not the first 10
// Opens the SQLite file READ-ONLY (node:sqlite readOnly) - it cannot change anything. Exit code 1 when a hard problem is found.
// HARD problems (money or links that are wrong):
//   H1 payment linked to a bank line that no longer exists         H2 payment linked to a debit / reversed / ignored line
//   H3 one line allocated MORE than its amount                      H4 line with receipts but still shown Unmatched
//   H5 line Reconciled with nothing behind it                       H6 line's matched invoice is not among its receipts
//   H7 invoice received amount <> its receipt rows (rows exist)      H8 invoice status disagrees with what is received
//   H9 a bank-dated receipt whose date is not the line's date
// LOOK AT (may be right): L1 one line paying invoices of different clients, L2 hand receipt linked to a line of a different
// amount, L3 lines that look like the same transaction twice, L4 received with no receipt rows at all (evidence missing),
// L5 credits not matched to anything yet.
// ---------------------------------------------------------------------------
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const argv = process.argv.slice(2);
const dbAt = argv.indexOf('--db');
const DB = path.resolve(dbAt >= 0 ? argv[dbAt + 1] : path.join(__dirname, '..', 'prisma', 'dev.db'));
const FULL = argv.includes('--full');
const db = new DatabaseSync(DB, { readOnly: true });
const all = (sql, ...p) => db.prepare(sql).all(...p);
const P = (n) => Math.round((Number(n) || 0) * 100);
const rs = (n) => `Rs ${(Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const cols = (t) => new Set(all(`PRAGMA table_info("${t}")`).map((c) => c.name));
const has = (t, c) => cols(t).has(c);

const txns = all('SELECT * FROM "BankTransaction"');
const pays = all('SELECT * FROM "InvoicePayment"');
const invs = all('SELECT i.*, c."name" AS clientName FROM "Invoice" i LEFT JOIN "Client" c ON c."id" = i."clientId"');
const bills = has('OfficeExpense', 'bankTxnId') ? all('SELECT "id","bankTxnId" FROM "OfficeExpense" WHERE "bankTxnId" IS NOT NULL') : [];
const loans = (() => { try { return all('SELECT "bankTxnId" FROM "HandLoanLink"'); } catch { return []; } })();
const T = new Map(txns.map((t) => [t.id, t]));
const I = new Map(invs.map((i) => [i.id, i]));
const byLine = new Map();
pays.forEach((p) => { if (p.bankTxnId) { if (!byLine.has(p.bankTxnId)) byLine.set(p.bankTxnId, []); byLine.get(p.bankTxnId).push(p); } });
const billLines = new Set(bills.map((b) => b.bankTxnId));
const loanLines = new Set(loans.map((l) => l.bankTxnId));
const inv = (id) => (I.get(id) ? I.get(id).invoiceNumber : id);
const line = (t) => `${t.date} ${t.type} ${rs(t.amount)} "${String(t.description || '').slice(0, 60)}"`;
const state = (t) => t.reconStatus || (t.matched ? 'Reconciled' : 'Unmatched');

const out = {};
const add = (k, s) => { (out[k] = out[k] || []).push(s); };

pays.forEach((p) => {
  if (!p.bankTxnId) return;
  const t = T.get(p.bankTxnId);
  if (!t) { add('H1', `${inv(p.invoiceId)} · receipt ${p.date} ${rs(p.amount)} -> line ${p.bankTxnId} (gone)`); return; }
  if (t.type !== 'Credit' || ['Reversed', 'Ignored'].includes(t.reconStatus)) {
    if (!(Number(p.amount) < 0 && t.reconStatus === 'Reversed')) add('H2', `${inv(p.invoiceId)} · receipt ${rs(p.amount)} -> ${line(t)} [${state(t)}]`);
  }
  if (!p.bankLinked && p.dateSource === 'bank' && p.date && t.date && String(p.date).slice(0, 10) !== String(t.date).slice(0, 10) && Number(p.amount) > 0) add('H9', `${inv(p.invoiceId)} · receipt dated ${p.date} but its line is ${t.date} (${rs(p.amount)})`);
  if (p.bankLinked && Number(p.amount) > 0 && P(p.amount) !== P(t.amount)) add('L2', `${inv(p.invoiceId)} · hand receipt ${rs(p.amount)} linked to line ${line(t)}`);
});
for (const [id, list] of byLine) {
  const t = T.get(id);
  if (!t) continue;
  const sum = list.reduce((s, p) => s + P(p.amount), 0);
  if (t.type === 'Credit' && sum > P(t.amount) + 50) add('H3', `${line(t)}: ${rs(sum / 100)} allocated (${list.map((p) => `${inv(p.invoiceId)} ${rs(p.amount)}`).join(', ')})`);
  if (state(t) === 'Unmatched' && sum > 0) add('H4', `${line(t)}: receipts ${list.map((p) => inv(p.invoiceId)).join(', ')} but the line says Unmatched`);
  const clients = new Set(list.map((p) => (I.get(p.invoiceId) || {}).clientId).filter(Boolean));
  if (clients.size > 1) add('L1', `${line(t)} pays ${list.map((p) => `${inv(p.invoiceId)} (${(I.get(p.invoiceId) || {}).clientName || '?'})`).join(', ')}`);
  if (t.matchedInvoiceId && !list.some((p) => p.invoiceId === t.matchedInvoiceId)) add('H6', `${line(t)}: matched to ${inv(t.matchedInvoiceId)} but its receipts are on ${list.map((p) => inv(p.invoiceId)).join(', ')}`);
}
txns.forEach((t) => {
  if (state(t) !== 'Reconciled') return;
  if (byLine.has(t.id) || billLines.has(t.id) || loanLines.has(t.id) || t.category || t.categoryKind || t.createdBillId || t.billLinks) return;
  add('H5', `${line(t)} is Reconciled but no receipt, bill, loan or category is behind it`);
});
txns.forEach((t) => {
  if (t.type === 'Credit' && state(t) === 'Unmatched' && !t.excluded && !t.category && !t.categoryKind && !byLine.has(t.id)) add('L5', line(t));
});
// the same transaction twice: same account, date, type, amount and (reference or narration)
const seen = new Map();
txns.forEach((t) => {
  const k = [t.bankAccountId || '', String(t.date).slice(0, 10), t.type, P(t.amount), String(t.externalId || t.reference || t.description || '').trim().toUpperCase()].join('|');
  if (seen.has(k)) add('L3', `${line(t)} looks like ${seen.get(k).id === t.id ? '' : 'another line of'} the same day / amount / reference`); else seen.set(k, t);
});
const rows = new Map();
pays.forEach((p) => rows.set(p.invoiceId, (rows.get(p.invoiceId) || 0) + P(p.amount)));
invs.forEach((i) => {
  if (i.status === 'Cancelled') return;
  const rec = P(i.receivedAmount);
  const r = rows.get(i.id) || 0;
  if (rows.has(i.id) && Math.abs(rec - r) > 50) add('H7', `${i.invoiceNumber}: received ${rs(rec / 100)} but its receipts add up to ${rs(r / 100)}`);
  if (!rows.has(i.id) && rec > 50) add('L4', `${i.invoiceNumber} (${i.clientName || '?'}): ${rs(rec / 100)} received, no receipt row`);
  const total = P(i.amount) + P(i.gst) - P(i.tds);
  const owed = total - rec - P(i.creditedAmount) - P(i.adjustedAmount) + P(i.debitedAmount);
  if (i.status === 'Paid' && owed > 50) add('H8', `${i.invoiceNumber} says Paid but ${rs(owed / 100)} is still owed`);
  if (i.status !== 'Paid' && i.status !== 'Partially Paid' && rec > 50 && owed <= 50) add('H8', `${i.invoiceNumber} is fully received but says ${i.status}`);
});

const NAMES = {
  H1: 'payment linked to a bank line that no longer exists', H2: 'payment linked to a debit / reversed / ignored line', H3: 'line allocated more than its amount',
  H4: 'line with receipts but shown Unmatched', H5: 'line Reconciled with nothing behind it', H6: 'line matched to an invoice not among its receipts',
  H7: 'invoice received amount <> its receipt rows', H8: 'invoice status disagrees with what is received', H9: 'bank-dated receipt not on the line\'s date',
  L1: 'one line paying invoices of different clients', L2: 'hand receipt linked to a line of a different amount', L3: 'possible duplicate lines',
  L4: 'received with no receipt rows (evidence missing)', L5: 'credits not matched to anything yet',
};
console.log(`\nBank <-> payment match check (read only) - ${DB}`);
console.log(`  ${txns.length} bank lines · ${pays.length} receipt rows (${pays.filter((p) => p.bankTxnId).length} linked to a line) · ${invs.length} invoices`);
let hard = 0;
Object.keys(NAMES).forEach((k) => {
  const list = out[k] || [];
  if (k.startsWith('H')) hard += list.length;
  console.log(`${list.length ? (k.startsWith('H') ? '  PROBLEM' : '  look at') : '  ok     '} ${k} ${NAMES[k]}: ${list.length}`);
  (FULL ? list : list.slice(0, 10)).forEach((s) => console.log(`            ${s}`));
  if (!FULL && list.length > 10) console.log(`            ... ${list.length - 10} more (--full)`);
});
console.log(hard ? `\n${hard} hard problem(s) found.` : '\nNo hard problem: every link between a payment and a bank line is consistent.');
db.close();
process.exit(hard ? 1 : 0);
