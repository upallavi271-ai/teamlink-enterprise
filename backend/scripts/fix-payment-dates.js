#!/usr/bin/env node
// ---------------------------------------------------------------------------
// fix-payment-dates.js - put the REAL payment date on receipts whose linked bank
// statement line says a different day.   (Accounts > Invoices > payment dates)
//
//   node scripts/fix-payment-dates.js --db <file.db>                 DRY RUN (default, writes nothing)
//   node scripts/fix-payment-dates.js --db <file.db> --json          same, machine readable
//   node scripts/fix-payment-dates.js --db <file.db> --apply         backup + apply + undo manifest
//   node scripts/fix-payment-dates.js --db <file.db> --undo <manifest.json>
//
// WHAT IT CHANGES (only this, only with evidence):
//   InvoicePayment.date  ->  the date PRINTED on the linked BankTransaction (and dateSource='backfill')
//   Invoice.paidDate     ->  the last receipt date, ONLY for an invoice that is fully Paid and whose
//                            paidDate no longer matches its receipts.
// It never uses the import day, the invoice day, createdAt or "today". Nothing is deleted, no amount
// changes, no payment is created. Receipts with no bank link, and invoices whose "received" amount has
// no receipt rows at all, are only REPORTED (needs a person / a bank line) - never guessed.
//
// SAFETY: --apply on backend/prisma/dev.db (the live database) needs BOTH --really-real and the
// environment variable TL_ALLOW_REAL_APPLY=1. --apply always writes <db>.pre-paydates-<stamp>.bak
// next to the database and an undo manifest, and refuses to run without them.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

const dbArg = val('--db');
if (!dbArg) { console.error('Give the database with --db <file.db> (use a copy; the default is a dry run).'); process.exit(2); }
const dbPath = path.resolve(dbArg);
if (!fs.existsSync(dbPath)) { console.error('No such file: ' + dbPath); process.exit(2); }
const APPLY = flag('--apply');
const UNDO = val('--undo');
const JSON_OUT = flag('--json');
const isReal = path.basename(dbPath).toLowerCase() === 'dev.db';

if ((APPLY || UNDO) && isReal && !(flag('--really-real') && process.env.TL_ALLOW_REAL_APPLY === '1')) {
  console.error('REFUSED: this is the live database. It needs --really-real AND TL_ALLOW_REAL_APPLY=1 - and a go from the owner. Nothing was changed.');
  process.exit(3);
}

const db = new DatabaseSync(dbPath, { readOnly: !(APPLY || UNDO) });
const all = (s, ...a) => db.prepare(s).all(...a);
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const manifestPath = path.join(path.dirname(dbPath), `${path.basename(dbPath)}.paydates-undo-${stamp}.json`);

function analyse() {
  const rows = all(`select p.id, p.invoiceId, p.date, p.amount, p.dateSource, p.bankTxnId, p.bankLinked,
      t.date as bankDate, t.reference as bankRef, i.invoiceNumber, i.status, i.paidDate, i.receivedAmount
    from InvoicePayment p
    join Invoice i on i.id = p.invoiceId
    left join BankTransaction t on t.id = p.bankTxnId`);
  const fixes = [];
  const unlinkedReceipts = [];
  for (const r of rows) {
    if (Number(r.amount) <= 0) continue; // reversal entries keep their own date
    if (r.bankTxnId && r.bankDate && /^\d{4}-\d{2}-\d{2}$/.test(r.bankDate)) {
      if (r.bankDate !== r.date) fixes.push({ kind: 'payment-date', paymentId: r.id, invoiceId: r.invoiceId, invoiceNumber: r.invoiceNumber, amount: r.amount, from: r.date, to: r.bankDate, bankRef: r.bankRef || null, fromSource: r.dateSource || null });
    } else {
      unlinkedReceipts.push({ paymentId: r.id, invoiceNumber: r.invoiceNumber, date: r.date, amount: r.amount, source: r.dateSource || 'entered' });
    }
  }
  // Fully Paid invoices whose paidDate is not the last receipt (after the proposed fixes).
  const newDate = new Map(fixes.map((f) => [f.paymentId, f.to]));
  const byInv = new Map();
  rows.forEach((r) => { if (Number(r.amount) > 0) (byInv.get(r.invoiceId) || byInv.set(r.invoiceId, []).get(r.invoiceId)).push(newDate.get(r.id) || r.date); });
  const paidDateFixes = [];
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.invoiceId)) continue; seen.add(r.invoiceId);
    const ds = (byInv.get(r.invoiceId) || []).sort();
    if (r.status === 'Paid' && ds.length && r.paidDate !== ds[ds.length - 1]) paidDateFixes.push({ kind: 'paid-date', invoiceId: r.invoiceId, invoiceNumber: r.invoiceNumber, from: r.paidDate || null, to: ds[ds.length - 1] });
  }
  // Report only: received money with no (or not enough) receipt rows, and a paidDate on a not-fully-paid invoice.
  const itemised = new Map();
  all('select invoiceId, sum(amount) s, count(*) n from InvoicePayment group by invoiceId').forEach((x) => itemised.set(x.invoiceId, x));
  const unitemised = all('select id, invoiceNumber, status, paidDate, receivedAmount from Invoice where receivedAmount > 0.005')
    .map((i) => ({ i, it: itemised.get(i.id) }))
    .filter(({ i, it }) => !it || Math.abs(Number(it.s) - Number(i.receivedAmount)) > 0.5)
    .map(({ i, it }) => ({ invoiceNumber: i.invoiceNumber, status: i.status, received: i.receivedAmount, itemised: it ? it.s : 0, receipts: it ? it.n : 0, importSheetPaidDate: i.paidDate || null }));
  const partialWithPaidDate = all("select invoiceNumber, paidDate from Invoice where status = 'Partially Paid' and paidDate is not null");
  return { fixes, paidDateFixes, unlinkedReceipts, unitemised, partialWithPaidDate, receipts: rows.length };
}

function undo(file) {
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  let back = 0; let skipped = 0;
  db.exec('BEGIN');
  for (const c of m.changes) {
    if (c.kind === 'payment-date') {
      const cur = all('select date from InvoicePayment where id = ?', c.paymentId)[0];
      if (cur && cur.date === c.to) { db.prepare('update InvoicePayment set date = ?, dateSource = ? where id = ?').run(c.from, c.fromSource, c.paymentId); back += 1; } else skipped += 1;
    } else {
      const cur = all('select paidDate from Invoice where id = ?', c.invoiceId)[0];
      if (cur && cur.paidDate === c.to) { db.prepare('update Invoice set paidDate = ? where id = ?').run(c.from, c.invoiceId); back += 1; } else skipped += 1;
    }
  }
  db.exec('COMMIT');
  console.log(`Undo: ${back} value(s) put back, ${skipped} left alone (changed since).`);
}

if (UNDO) { undo(path.resolve(UNDO)); process.exit(0); }

const a = analyse();
const out = {
  database: dbPath, mode: APPLY ? 'APPLY' : 'DRY RUN', receipts: a.receipts,
  proposedPaymentDateFixes: a.fixes.length, proposedPaidDateFixes: a.paidDateFixes.length,
  receiptsWithNoBankLink: a.unlinkedReceipts.length, invoicesWithUnitemisedMoney: a.unitemised.length, partiallyPaidWithPaidDate: a.partialWithPaidDate.length,
};
if (JSON_OUT) console.log(JSON.stringify({ ...out, fixes: a.fixes, paidDateFixes: a.paidDateFixes, unitemised: a.unitemised }, null, 1));
else {
  console.log(`${out.mode} on ${dbPath}`);
  console.log(`  receipts checked ................ ${out.receipts}`);
  console.log(`  receipt dates to correct ........ ${out.proposedPaymentDateFixes}   (linked bank line prints a different day)`);
  a.fixes.slice(0, 15).forEach((f) => console.log(`     ${f.invoiceNumber}  Rs ${f.amount}  ${f.from} -> ${f.to}  (bank ref ${f.bankRef || '-'})`));
  console.log(`  paid-on dates to correct ........ ${out.proposedPaidDateFixes}   (fully Paid invoice, paid-on is not its last receipt)`);
  a.paidDateFixes.slice(0, 15).forEach((f) => console.log(`     ${f.invoiceNumber}  ${f.from || '(blank)'} -> ${f.to}`));
  console.log(`  receipts with no bank link ...... ${out.receiptsWithNoBankLink}   (typed / sheet dates - left as they are)`);
  console.log(`  invoices with money but no / partial receipt rows: ${out.invoicesWithUnitemisedMoney}   (report only - needs a bank line or a person)`);
  a.unitemised.slice(0, 15).forEach((u) => console.log(`     ${u.invoiceNumber}  ${u.status}  received ${u.received}, itemised ${u.itemised} in ${u.receipts} receipt(s), import-sheet date ${u.importSheetPaidDate || '-'}`));
  console.log(`  part-paid invoices still carrying a paid-on date: ${out.partiallyPaidWithPaidDate}   (report only)`);
}
if (!APPLY) { if (!JSON_OUT) console.log('\nDry run - nothing was written. Add --apply (on a copy) to apply.'); process.exit(0); }

const changes = [...a.fixes, ...a.paidDateFixes];
if (!changes.length) { console.log('Nothing to apply.'); process.exit(0); }
const bak = `${dbPath}.pre-paydates-${stamp}.bak`;
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
fs.copyFileSync(dbPath, bak);
fs.writeFileSync(manifestPath, JSON.stringify({ database: dbPath, at: new Date().toISOString(), backup: bak, changes }, null, 1));
db.exec('BEGIN');
try {
  for (const c of a.fixes) db.prepare("update InvoicePayment set date = ?, dateSource = 'backfill' where id = ?").run(c.to, c.paymentId);
  for (const c of a.paidDateFixes) db.prepare('update Invoice set paidDate = ? where id = ?').run(c.to, c.invoiceId);
  db.exec('COMMIT');
} catch (e) { db.exec('ROLLBACK'); console.error('Rolled back: ' + e.message); process.exit(1); }
console.log(`Applied ${changes.length} change(s). Backup: ${bak}\nUndo: node scripts/fix-payment-dates.js --db ${dbArg} --undo ${manifestPath}`);
