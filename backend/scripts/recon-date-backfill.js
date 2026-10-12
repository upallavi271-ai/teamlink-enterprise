#!/usr/bin/env node
// ---------------------------------------------------------------------------
// recon-date-backfill.js - correct HISTORICAL payment dates, from evidence only.
//
//   node scripts/recon-date-backfill.js --db <path to .db>                 DRY RUN (default; writes nothing)
//   node scripts/recon-date-backfill.js --db <path> --json                 same, machine readable
//   node scripts/recon-date-backfill.js --db <path> --full                 list every flagged record (default: first 15 per rule)
//   node scripts/recon-date-backfill.js --db <path> --apply                backs the DB up, applies the PROPOSED changes, writes an undo file + audit rows
//   node scripts/recon-date-backfill.js --db <path> --undo <changes.json>  puts the old values back (only where the value is still the one this script wrote)
//
// RULES (Accounts spec 7 / user rule 3):
//   * A date is only ever changed to a date PRINTED ON A BANK STATEMENT LINE that is
//     linked to the record, or to the date of another payment record on the same
//     invoice. Never to an import day, an invoice day or "today".
//   * Where the original date cannot be recovered the record is listed under
//     FLAG FOR REVIEW - nothing is changed and nothing is guessed.
//   * Nothing is deleted. Only these fields can change: InvoicePayment.date (+dateSource),
//     Invoice.paidDate, OfficeExpense.paymentDate.
//   * --apply refuses to touch backend/prisma/dev.db (the live database) unless BOTH
//     --allow-real-db and the environment variable RECON_CONFIRM_REAL=YES are given.
//     It has NEVER been run against the live database by the developer.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

const dbArg = val('--db');
if (!dbArg) {
  console.error('Give the database with --db <path>. (Dry run reads only. Use the sandbox copy for --apply.)');
  process.exit(2);
}
const dbPath = path.resolve(dbArg);
if (!fs.existsSync(dbPath)) { console.error('No such file: ' + dbPath); process.exit(2); }
process.env.DATABASE_URL = 'file:' + dbPath.replace(/\\/g, '/');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const isReal = path.basename(dbPath).toLowerCase() === 'dev.db';
const APPLY = flag('--apply');
const UNDO = val('--undo');
const FULL = flag('--full');
const JSON_OUT = flag('--json');

const day = (v) => {
  if (!v) return null;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : new Date(t + 330 * 60000).toISOString().slice(0, 10);
};
const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const paise = (n) => Math.round((Number(n) || 0) * 100);
const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

async function analyse() {
  const [invoices, payments, txns, expenses] = await Promise.all([
    prisma.invoice.findMany({ select: { id: true, invoiceNumber: true, status: true, invoiceDate: true, paidDate: true, receivedAmount: true, createdAt: true, clientId: true } }),
    prisma.invoicePayment.findMany(),
    prisma.bankTransaction.findMany(),
    prisma.officeExpense.findMany({ select: { id: true, expenseCode: true, approvalStatus: true, paymentDate: true, bankTxnId: true, paidAt: true, expenseDate: true, vendor: true, category: true } }),
  ]);
  const txnById = new Map(txns.map((t) => [t.id, t]));
  const payByInv = new Map();
  payments.forEach((p) => { if (!payByInv.has(p.invoiceId)) payByInv.set(p.invoiceId, []); payByInv.get(p.invoiceId).push(p); });

  const changes = []; // { table, id, field, old, new, evidence, rule }
  const flags = []; // { table, id, issue, detail, rule }

  // R1 - a receipt created from / linked to a bank line takes that line's date.
  for (const p of payments) {
    if (!p.bankTxnId) continue;
    const t = txnById.get(p.bankTxnId);
    if (!t) { flags.push({ rule: 'R1', table: 'InvoicePayment', id: p.id, issue: 'Linked bank line no longer exists', detail: `payment date ${p.date}, bankTxnId ${p.bankTxnId}` }); continue; }
    if (p.date === t.date) continue;
    if (p.bankLinked) {
      flags.push({ rule: 'R1', table: 'InvoicePayment', id: p.id, issue: 'Hand-recorded receipt differs from its bank line date', detail: `receipt ${p.date} vs statement ${t.date} (line ${t.id}, ref ${t.reference || '-'}); left as recorded - confirm which is right` });
    } else {
      changes.push({
        rule: 'R1', table: 'InvoicePayment', id: p.id, field: 'date', old: p.date, new: t.date,
        evidence: `bank statement line ${t.id} dated ${t.date} (ref ${t.reference || '-'}, ${t.type} ${t.amount}) is the source of this receipt`,
      });
    }
  }
  // payments whose dateSource is empty and which were created by the sheet import with the invoice date as the receipt date
  for (const p of payments) {
    if (p.bankTxnId || p.dateSource) continue;
    const inv = invoices.find((i) => i.id === p.invoiceId);
    if (inv && p.method === 'Imported' && inv.invoiceDate === p.date) {
      flags.push({ rule: 'R5', table: 'InvoicePayment', id: p.id, issue: 'Imported receipt dated the same day as the invoice - the sheet had no paid-on date, so this date was assumed', detail: `invoice ${inv.invoiceNumber}, date ${p.date}; no bank line or payment record to correct it from` });
    }
  }

  // R2 - invoice paid date follows its own receipts.
  const effectivePay = (pid) => {
    const c = changes.find((x) => x.table === 'InvoicePayment' && x.id === pid && x.field === 'date');
    return c ? c.new : null;
  };
  for (const inv of invoices) {
    if (inv.status === 'Cancelled') continue;
    const pays = payByInv.get(inv.id) || [];
    const received = Number(inv.receivedAmount || 0);
    if (pays.length) {
      const dates = pays.map((p) => effectivePay(p.id) || p.date).filter(Boolean).sort();
      const last = dates[dates.length - 1];
      if (inv.status === 'Paid' && inv.paidDate !== last) {
        changes.push({
          rule: 'R2', table: 'Invoice', id: inv.id, field: 'paidDate', old: inv.paidDate, new: last,
          evidence: `invoice ${inv.invoiceNumber}: last of ${pays.length} recorded receipt(s) is dated ${last}`,
        });
      }
      continue;
    }
    if (!(received > 0.5) || !['Paid', 'Partially Paid'].includes(inv.status)) continue;
    // No receipt rows: money kept on the invoice itself.
    if (inv.paidDate) {
      if (inv.paidDate > today) flags.push({ rule: 'R4', table: 'Invoice', id: inv.id, issue: 'Paid date is in the future', detail: `invoice ${inv.invoiceNumber} paidDate ${inv.paidDate}; no bank line or receipt to correct it from` });
      else if (inv.invoiceDate && inv.paidDate < inv.invoiceDate) flags.push({ rule: 'R4', table: 'Invoice', id: inv.id, issue: 'Paid date is before the invoice date', detail: `invoice ${inv.invoiceNumber} invoiced ${inv.invoiceDate}, paid ${inv.paidDate}` });
      else if (inv.paidDate === day(inv.createdAt)) flags.push({ rule: 'R4', table: 'Invoice', id: inv.id, issue: 'Paid date equals the day the invoice was imported', detail: `invoice ${inv.invoiceNumber} paidDate ${inv.paidDate} = import day; confirm from the bank statement` });
      continue;
    }
    // Paid money, no date: look for ONE exact bank credit that names the invoice number.
    const numNorm = norm(inv.invoiceNumber);
    const hits = numNorm.length >= 4 ? txns.filter((t) => t.type === 'Credit' && norm(`${t.description} ${t.reference}`).split(' ').join('').includes(numNorm.split(' ').join('')) && paise(t.amount) <= paise(received) + 1 && !payments.some((p) => p.bankTxnId === t.id)) : [];
    if (hits.length === 1) {
      changes.push({
        rule: 'R3', table: 'Invoice', id: inv.id, field: 'paidDate', old: null, new: hits[0].date,
        evidence: `bank credit ${hits[0].id} dated ${hits[0].date} (${hits[0].amount}, ref ${hits[0].reference || '-'}) names invoice ${inv.invoiceNumber}`,
      });
    } else {
      flags.push({ rule: 'R3', table: 'Invoice', id: inv.id, issue: hits.length > 1 ? 'Paid but undated; several bank credits mention this invoice' : 'Paid but undated; no bank line or receipt record to take the date from', detail: `invoice ${inv.invoiceNumber} status ${inv.status}, received ${received}` });
    }
  }

  // R6 - bills settled from a bank line take that line's date.
  for (const e of expenses) {
    if (!['PAID', 'REIMBURSED'].includes(e.approvalStatus)) continue;
    if (e.bankTxnId) {
      const t = txnById.get(e.bankTxnId);
      if (!t) { flags.push({ rule: 'R6', table: 'OfficeExpense', id: e.id, issue: 'Linked bank line no longer exists', detail: `${e.expenseCode || e.id}` }); continue; }
      if (e.paymentDate !== t.date) {
        changes.push({
          rule: 'R6', table: 'OfficeExpense', id: e.id, field: 'paymentDate', old: e.paymentDate || null, new: t.date,
          evidence: `bank statement line ${t.id} dated ${t.date} (ref ${t.reference || '-'}) paid ${e.expenseCode || e.id} (${e.vendor || e.category})`,
        });
      }
    } else if (!e.paymentDate) {
      flags.push({ rule: 'R7', table: 'OfficeExpense', id: e.id, issue: 'Paid, no bank line and no payment date - only "marked paid" time exists', detail: `${e.expenseCode || e.id} ${e.vendor || e.category}; ${e.paidAt ? 'the screen shows the day it was marked paid (' + day(e.paidAt) + '), labelled as such, not as a bank date' : 'no payment date exists anywhere on this record'}` });
    }
  }
  return {
    counts: {
      invoices: invoices.length, receipts: payments.length, bankLines: txns.length, expenses: expenses.length,
    },
    changes,
    flags,
  };
}

function printReport(r) {
  const byRule = (arr) => arr.reduce((m, x) => ({ ...m, [x.rule]: (m[x.rule] || 0) + 1 }), {});
  console.log('=== RECON DATE BACKFILL - ' + (APPLY ? 'APPLY' : 'DRY RUN (nothing is written)') + ' ===');
  console.log('database: ' + dbPath + (isReal ? '   <-- THE LIVE DATABASE (read only in dry run)' : ''));
  console.log('looked at: ' + JSON.stringify(r.counts));
  console.log('\n--- PROPOSED CHANGES (' + r.changes.length + ')  by rule ' + JSON.stringify(byRule(r.changes)));
  r.changes.forEach((c) => console.log(`  [${c.rule}] ${c.table} ${c.id}  ${c.field}: ${c.old === null ? '(empty)' : c.old}  ->  ${c.new}\n        evidence: ${c.evidence}`));
  console.log('\n--- FLAG FOR REVIEW (' + r.flags.length + ')  by rule ' + JSON.stringify(byRule(r.flags)) + '  (no change proposed; the date cannot be recovered from a source record)');
  const seen = {};
  r.flags.forEach((f) => {
    seen[f.rule] = (seen[f.rule] || 0) + 1;
    if (!FULL && seen[f.rule] > 15) return;
    console.log(`  [${f.rule}] ${f.table} ${f.id}  ${f.issue}\n        ${f.detail}`);
  });
  if (!FULL) Object.entries(byRule(r.flags)).forEach(([k, n]) => { if (n > 15) console.log(`  ... rule ${k}: ${n - 15} more (use --full)`); });
}

async function apply(r) {
  if (isReal && !(flag('--allow-real-db') && process.env.RECON_CONFIRM_REAL === 'YES')) {
    console.error('REFUSED: this is the live database. --apply on it needs the user\'s decision (--allow-real-db and RECON_CONFIRM_REAL=YES).');
    process.exit(3);
  }
  if (!r.changes.length) { console.log('Nothing to apply.'); return; }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(path.dirname(dbPath), '..', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const backup = path.join(dir, `recon-backfill-${path.basename(dbPath)}-${stamp}.db`);
  await prisma.$executeRawUnsafe(`VACUUM INTO '${backup.replace(/\\/g, '/').replace(/'/g, "''")}'`);
  console.log('Backup written: ' + backup);
  const undoFile = path.join(dir, `recon-backfill-${stamp}.changes.json`);
  fs.writeFileSync(undoFile, JSON.stringify({ db: dbPath, backup, at: new Date().toISOString(), changes: r.changes }, null, 2));
  const model = { InvoicePayment: 'invoicePayment', Invoice: 'invoice', OfficeExpense: 'officeExpense' };
  await prisma.$transaction(async (tx) => {
    for (const c of r.changes) {
      const data = { [c.field]: c.new };
      if (c.table === 'InvoicePayment' && c.field === 'date') data.dateSource = 'backfill';
      await tx[model[c.table]].update({ where: { id: c.id }, data });
      await tx.auditLog.create({
        data: {
          action: 'Payment date corrected from source record', entity: c.table, entityId: c.id, field: c.field, fieldLabel: c.field,
          fromValue: c.old === null ? '' : String(c.old), toValue: String(c.new), reason: c.evidence, actorName: 'recon-date-backfill',
        },
      });
    }
  }, { timeout: 120000 });
  console.log(`Applied ${r.changes.length} change(s). Undo with: node scripts/recon-date-backfill.js --db "${dbPath}" --undo "${undoFile}"`);
}

async function undo(file) {
  const log = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (path.resolve(log.db) !== dbPath) { console.error('That undo file belongs to ' + log.db); process.exit(2); }
  if (isReal && !(flag('--allow-real-db') && process.env.RECON_CONFIRM_REAL === 'YES')) { console.error('REFUSED: live database.'); process.exit(3); }
  const model = { InvoicePayment: 'invoicePayment', Invoice: 'invoice', OfficeExpense: 'officeExpense' };
  let reverted = 0; let skipped = 0;
  await prisma.$transaction(async (tx) => {
    for (const c of log.changes) {
      const row = await tx[model[c.table]].findUnique({ where: { id: c.id } });
      if (!row || row[c.field] !== c.new) { skipped += 1; continue; }
      const data = { [c.field]: c.old };
      if (c.table === 'InvoicePayment' && c.field === 'date') data.dateSource = null;
      await tx[model[c.table]].update({ where: { id: c.id }, data });
      await tx.auditLog.create({ data: { action: 'Payment date correction undone', entity: c.table, entityId: c.id, field: c.field, fromValue: String(c.new), toValue: c.old === null ? '' : String(c.old), actorName: 'recon-date-backfill' } });
      reverted += 1;
    }
  }, { timeout: 120000 });
  console.log(`Reverted ${reverted}, skipped ${skipped} (value had changed since).`);
}

(async () => {
  try {
    if (UNDO) { await undo(UNDO); return; }
    const r = await analyse();
    if (JSON_OUT) console.log(JSON.stringify(r, null, 2)); else printReport(r);
    if (APPLY) await apply(r);
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => { console.error(e); process.exit(1); });
