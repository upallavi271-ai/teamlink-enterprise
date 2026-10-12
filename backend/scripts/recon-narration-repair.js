#!/usr/bin/env node
// ---------------------------------------------------------------------------
// recon-narration-repair.js - restore the narration (and the right dates) of
// bank lines that an OLDER importer damaged, from the ORIGINAL statement files.
//
//   node scripts/recon-narration-repair.js --db <file> --files <folder or file[,file]>        DRY RUN (default; writes nothing)
//   node scripts/recon-narration-repair.js --db <file> --files <...> --full                   print every line
//   node scripts/recon-narration-repair.js --db <file> --files <...> --apply                  backup + repair + undo file + audit rows
//   node scripts/recon-narration-repair.js --db <file> --files <...> --apply --add-missing    ... and also ADD the statement rows the old importer lost (see below)
//   node scripts/recon-narration-repair.js --db <file> --undo <changes.json>                  put the old values back
//
// WHAT WAS WRONG: on ICICI statements ("S.N., Tran. Id, Value Date, Transaction Date,
// Transaction Posted Date, Cheque No./Ref. No., Transaction Remarks, ...") the old importer
//   1. took the first date column it met - the VALUE date - as the transaction date, and
//   2. took the first column containing the word "transaction" - the Transaction DATE -
//      as the narration, so the real "Transaction Remarks" were never saved.
//
// HOW A LINE IS MATCHED to its statement row (nothing is guessed):
//   same direction + same amount to the paisa + same printed running balance to the paisa
//   + the stored date equals the row's value date or transaction date.
//   A line is repaired only when exactly ONE distinct statement row fits (the same row
//   appearing in two copies of a file counts once). Anything else is listed under FLAG FOR REVIEW.
//
// LOST LINES: the old importer also threw away real lines. With the date standing in for the
// narration, two different lines of the same day and amount (a charge's CGST and SGST, two
// equal transfers) looked identical and the second was skipped as a "duplicate". The statement's
// own running balance shows each gap. This script lists every statement row that has no stored
// line at all ("MISSING FROM THE BOOKS") and, only with --add-missing, adds them as new lines
// (new batch, original row kept in sourceRow, importFile = the statement) - nothing existing is touched.
//
// WHAT CHANGES (only these fields): description (the real narration), valueDate, date (to the
// statement's TRANSACTION date, only when the old date was really the value date), sourceRow,
// sourceLine. Amounts, direction, balance, reference, matches and links are never touched.
// If the date moves, receipts / bills dated from the line follow with
// scripts/recon-date-backfill.js (rules R1 / R6), which reads the line's date.
//
// --apply refuses the live dev.db unless --allow-real-db and RECON_CONFIRM_REAL=YES.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const dbArg = val('--db');
if (!dbArg) { console.error('Give the database with --db <path>.'); process.exit(2); }
const dbPath = path.resolve(dbArg);
if (!fs.existsSync(dbPath)) { console.error('No such file: ' + dbPath); process.exit(2); }
process.env.DATABASE_URL = 'file:' + dbPath.split('\\').join('/');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const isReal = path.basename(dbPath).toLowerCase() === 'dev.db';
const APPLY = flag('--apply');
const ADD_MISSING = flag('--add-missing');
const UNDO = val('--undo');
const FULL = flag('--full');
const paise = (n) => Math.round((Number(n) || 0) * 100);
const DAMAGED = /^\d{1,2}[/-][A-Za-z]{3}[/-]\d{4}$/;

function listFiles(spec) {
  const out = [];
  String(spec || '').split(',').map((x) => x.trim()).filter(Boolean).forEach((p) => {
    const abs = path.resolve(p);
    if (!fs.existsSync(abs)) { console.error('Not found: ' + abs); process.exit(2); }
    if (fs.statSync(abs).isDirectory()) fs.readdirSync(abs).filter((f) => /\.(xlsx|xls|xlsm|csv)$/i.test(f)).forEach((f) => out.push(path.join(abs, f)));
    else out.push(abs);
  });
  return out;
}

async function analyse() {
  const files = listFiles(val('--files'));
  if (!files.length) { console.error('Give the original statement files with --files <folder or file>.'); process.exit(2); }
  // eslint-disable-next-line global-require
  const importer = require('../src/routes/accountsImport');
  const stmtRows = []; // every row of every file
  const fileNotes = [];
  for (const f of files) {
    const data = fs.readFileSync(f);
    const a = importer.analyseFile({ data, filename: path.basename(f) }, { kind: 'bank' });
    if (a.error) { fileNotes.push(`${path.basename(f)}: not read (${a.error})`); continue; }
    a.rows.forEach((r) => stmtRows.push({ ...r, file: path.basename(f) }));
    fileNotes.push(`${path.basename(f)}: ${a.rows.length} row(s), header on row ${a.headerRow}`);
  }
  const lines = (await prisma.bankTransaction.findMany()).filter((t) => DAMAGED.test(String(t.description || '').trim()));
  const changes = []; // { id, fields: { name: { old, new } }, evidence }
  const flags = [];
  const used = new Set();
  const swapped = { dateWasValueDate: 0, dateSame: 0, other: 0 };

  for (const t of lines) {
    const tb = t.balance == null ? null : paise(t.balance);
    const cands = stmtRows.filter((r) => r.type === t.type && paise(r.amount) === paise(t.amount)
      && tb != null && r.balance != null && paise(r.balance) === tb
      && (r.date === t.date || r.valueDate === t.date));
    // the same statement row found in two copies of a file is ONE row
    const distinct = new Map();
    cands.forEach((r) => distinct.set([r.date, r.valueDate, r.type, paise(r.amount), paise(r.balance), r.description].join('|'), r));
    if (distinct.size === 0) { flags.push({ id: t.id, issue: tb == null ? 'No printed balance on the stored line to match on' : 'No statement row has the same amount, direction, balance and date', line: `${t.date} ${t.type} ${t.amount} balance ${t.balance} (${t.importFile})` }); continue; }
    if (distinct.size > 1) { flags.push({ id: t.id, issue: `${distinct.size} different statement rows fit - cannot tell which`, line: `${t.date} ${t.type} ${t.amount} balance ${t.balance}` }); continue; }
    const r = [...distinct.values()][0];
    const key = [r.date, r.valueDate, r.type, paise(r.amount), paise(r.balance), r.description].join('|');
    if (used.has(key)) { flags.push({ id: t.id, issue: 'Another stored line already claimed this statement row', line: `${t.date} ${t.type} ${t.amount}` }); continue; }
    used.add(key);
    const fields = {};
    fields.description = { old: t.description, new: r.description };
    if (r.valueDate && t.valueDate !== r.valueDate) fields.valueDate = { old: t.valueDate || null, new: r.valueDate };
    let dateNote;
    if (t.date !== r.date) {
      if (t.date === r.valueDate) { fields.date = { old: t.date, new: r.date }; dateNote = 'stored date was the VALUE date; statement transaction date differs'; swapped.dateWasValueDate += 1; } else { dateNote = 'stored date matches neither'; swapped.other += 1; }
    } else { dateNote = 'stored date already equals the transaction date'; swapped.dateSame += 1; }
    fields.sourceRow = { old: t.sourceRow || null, new: JSON.stringify(r.raw || {}) };
    fields.sourceLine = { old: t.sourceLine == null ? null : t.sourceLine, new: r.line };
    changes.push({
      id: t.id, fields, dateNote, evidence: `${r.file} row ${r.line}: ${r.type} ${r.amount}, balance ${r.balance}, "${String(r.description).slice(0, 90)}"`, stored: `${t.date} ${t.type} ${t.amount}`,
    });
  }
  // statement rows with no stored line at all (any narration): lost by the old import
  const all = await prisma.bankTransaction.findMany();
  const taken = new Set();
  const key = (r) => [r.type, paise(r.amount), r.balance == null ? '' : paise(r.balance)].join('|');
  const byKey = new Map();
  all.forEach((t) => { const k = key(t); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(t); });
  const missing = [];
  const seenRow = new Set();
  for (const r of stmtRows) {
    const rk = [r.date, r.valueDate, r.type, paise(r.amount), r.balance == null ? '' : paise(r.balance), r.description].join('|');
    // the same row in two copies of a file (and the same row in the next month's overlap) is one row
    if (seenRow.has(rk)) continue;
    seenRow.add(rk);
    const cands = (byKey.get(key(r)) || []).filter((t) => !taken.has(t.id) && (t.date === r.date || t.date === r.valueDate));
    if (cands.length) { taken.add(cands[0].id); continue; }
    // which account: the one whose lines came from this very statement file
    const base = (n) => String(n || '').replace(/ \(\d+\)(?=\.[a-z]+$)/i, '');
    const sib = all.find((t) => base(t.importFile) === base(r.file));
    missing.push({ row: r, bankAccountId: sib ? sib.bankAccountId : null, file: r.file });
  }
  return { fileNotes, damaged: lines.length, changes, flags, swapped, missing };
}

function report(r) {
  console.log('=== NARRATION REPAIR - ' + (APPLY ? 'APPLY' : 'DRY RUN (nothing is written)') + ' ===');
  console.log('database: ' + dbPath + (isReal ? '   <-- THE LIVE DATABASE (read only in dry run)' : ''));
  console.log('statement files read:'); r.fileNotes.forEach((x) => console.log('  ' + x));
  console.log(`bank lines whose narration is just a date (damaged by the old importer): ${r.damaged}`);
  console.log(`\nCAN BE RESTORED: ${r.changes.length}   |   FLAG FOR REVIEW (no unique statement row): ${r.flags.length}`);
  console.log('date check on the restorable lines: ' + JSON.stringify(r.swapped) + '  (dateWasValueDate = the old importer stored the VALUE date as the transaction date)');
  const shown = FULL ? r.changes : r.changes.slice(0, 12);
  console.log('\n--- restorable lines' + (FULL ? '' : ' (first 12; --full for all)') + ' ---');
  shown.forEach((c) => {
    console.log(`  ${c.id}  ${c.stored}`);
    Object.entries(c.fields).filter(([k]) => ['description', 'valueDate', 'date'].includes(k)).forEach(([k, v]) => console.log(`      ${k}: ${v.old === null ? '(empty)' : v.old}  ->  ${String(v.new).slice(0, 110)}`));
    console.log(`      date: ${c.dateNote}`);
    console.log(`      evidence: ${c.evidence}`);
  });
  console.log(`\nMISSING FROM THE BOOKS (statement rows with no stored line - lost by the old import): ${r.missing.length}`);
  r.missing.slice(0, FULL ? 1000 : 15).forEach((m) => console.log(`  ${m.file} row ${m.row.line}: ${m.row.date} ${m.row.type} ${m.row.amount} balance ${m.row.balance} "${String(m.row.description).slice(0, 80)}"${m.bankAccountId ? '' : '  (account unknown - will be skipped)'}`));
  if (!FULL && r.missing.length > 15) console.log(`  ... ${r.missing.length - 15} more (--full)`);
  if (r.missing.length) console.log('  They are added only with --add-missing; the statement\'s running balance explains each one (see scripts/recon-validate.js, check B1).');
  console.log('\n--- flag for review ---');
  (FULL ? r.flags : r.flags.slice(0, 15)).forEach((f) => console.log(`  ${f.id}  ${f.line}  - ${f.issue}`));
  if (!FULL && r.flags.length > 15) console.log(`  ... ${r.flags.length - 15} more (--full)`);
}

async function apply(r) {
  if (isReal && !(flag('--allow-real-db') && process.env.RECON_CONFIRM_REAL === 'YES')) {
    console.error("REFUSED: this is the live database. --apply on it needs the user's decision (--allow-real-db and RECON_CONFIRM_REAL=YES).");
    process.exit(3);
  }
  if (!r.changes.length && !(ADD_MISSING && r.missing.length)) { console.log('Nothing to apply.'); return; }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(path.dirname(dbPath), '..', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const backup = path.join(dir, `narration-repair-${path.basename(dbPath)}-${stamp}.db`);
  await prisma.$executeRawUnsafe(`VACUUM INTO '${backup.split('\\').join('/').split("'").join("''")}'`);
  console.log('Backup written: ' + backup);
  const undoFile = path.join(dir, `narration-repair-${stamp}.changes.json`);
  const addable = ADD_MISSING ? r.missing.filter((m) => m.bankAccountId) : [];
  const batch = `IMP-REPAIR-${Date.now()}`;
  const addedIds = [];
  fs.writeFileSync(undoFile, JSON.stringify({ db: dbPath, backup, at: new Date().toISOString(), changes: r.changes, addBatch: addable.length ? batch : null }, null, 2));
  await prisma.$transaction(async (tx) => {
    for (const m of addable) {
      const x = m.row;
      const made = await tx.bankTransaction.create({
        data: {
          bankAccountId: m.bankAccountId, date: x.date, valueDate: x.valueDate || null, description: x.description, reference: x.reference || null, type: x.type, amount: x.amount,
          balance: x.balance == null ? null : x.balance, importBatch: batch, importFile: m.file, sourceLine: x.line, sourceRow: JSON.stringify(x.raw || {}),
          reviewReason: 'Added by the statement repair: this line was lost by an older import',
        },
      });
      addedIds.push(made.id);
      await tx.auditLog.create({ data: { action: 'Bank line added from the statement (lost by an older import)', entity: 'BankTransaction', entityId: made.id, toValue: `${x.date} ${x.type} ${x.amount} ${String(x.description).slice(0, 80)}`, reason: `${m.file} row ${x.line}`, actorName: 'recon-narration-repair' } });
    }
    if (addable.length) {
      await tx.bankImport.create({ data: { id: batch, bankAccountId: addable[0].bankAccountId, date: new Date().toISOString().slice(0, 10), file: 'Statement repair (lost lines)', recordedBy: 'recon-narration-repair', lines: addable.length, skipped: 0, credits: addable.filter((m) => m.row.type === 'Credit').reduce((a, m) => a + m.row.amount, 0), debits: addable.filter((m) => m.row.type === 'Debit').reduce((a, m) => a + m.row.amount, 0) } });
    }
    for (const c of r.changes) {
      const data = {};
      Object.entries(c.fields).forEach(([k, v]) => { data[k] = v.new; });
      await tx.bankTransaction.update({ where: { id: c.id }, data });
      await tx.auditLog.create({
        data: {
          action: 'Bank line narration restored from the statement', entity: 'BankTransaction', entityId: c.id, field: 'description', fieldLabel: 'Narration',
          fromValue: c.fields.description.old, toValue: String(c.fields.description.new).slice(0, 400), reason: c.evidence + (c.fields.date ? ` - transaction date corrected ${c.fields.date.old} -> ${c.fields.date.new}` : ''), actorName: 'recon-narration-repair',
        },
      });
    }
  }, { timeout: 120000 });
  if (addedIds.length) fs.writeFileSync(undoFile, JSON.stringify({ db: dbPath, backup, at: new Date().toISOString(), changes: r.changes, addBatch: batch, addedIds }, null, 2));
  console.log(`Repaired ${r.changes.length} line(s)${addedIds.length ? ` and added ${addedIds.length} lost line(s)` : ''}. Undo with: node scripts/recon-narration-repair.js --db "${dbPath}" --undo "${undoFile}"`);
  console.log('Next: run scripts/recon-date-backfill.js (dry run) - receipts and bills dated from a line whose date moved will be listed there.');
}

async function undo(file) {
  const log = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (path.resolve(log.db) !== dbPath) { console.error('That undo file belongs to ' + log.db); process.exit(2); }
  if (isReal && !(flag('--allow-real-db') && process.env.RECON_CONFIRM_REAL === 'YES')) { console.error('REFUSED: live database.'); process.exit(3); }
  let reverted = 0; let skipped = 0; let removed = 0;
  await prisma.$transaction(async (tx) => {
    for (const id of (log.addedIds || [])) {
      const t = await tx.bankTransaction.findUnique({ where: { id } });
      const linked = t && (await tx.invoicePayment.count({ where: { bankTxnId: id } })) + (await tx.officeExpense.count({ where: { bankTxnId: id } }));
      if (!t || t.reconStatus !== 'Unmatched' || linked || t.category || t.categoryKind) { skipped += 1; continue; }
      await tx.bankTransaction.delete({ where: { id } });
      await tx.auditLog.create({ data: { action: 'Bank line added by the statement repair was removed (undo)', entity: 'BankTransaction', entityId: id, actorName: 'recon-narration-repair' } });
      removed += 1;
    }
    if (log.addBatch) await tx.bankImport.deleteMany({ where: { id: log.addBatch } });
    for (const c of log.changes) {
      const row = await tx.bankTransaction.findUnique({ where: { id: c.id } });
      if (!row || row.description !== c.fields.description.new) { skipped += 1; continue; }
      const data = {};
      Object.entries(c.fields).forEach(([k, v]) => { data[k] = v.old; });
      await tx.bankTransaction.update({ where: { id: c.id }, data });
      await tx.auditLog.create({ data: { action: 'Bank line narration repair undone', entity: 'BankTransaction', entityId: c.id, field: 'description', fromValue: String(c.fields.description.new).slice(0, 400), toValue: c.fields.description.old, actorName: 'recon-narration-repair' } });
      reverted += 1;
    }
  }, { timeout: 120000 });
  console.log(`Reverted ${reverted}, removed ${removed} added line(s), skipped ${skipped} (changed since).`);
}

(async () => {
  try {
    if (UNDO) { await undo(UNDO); return; }
    const r = await analyse();
    report(r);
    if (APPLY) await apply(r);
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error(e); process.exit(1); });
