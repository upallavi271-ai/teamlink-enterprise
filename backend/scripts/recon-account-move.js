#!/usr/bin/env node
// ---------------------------------------------------------------------------
// recon-account-move.js - put statement lines under the bank account their
// statement belongs to. DRY RUN by default: it prints what would move and how
// every account's balances and reconciliation would change. Writes nothing.
//
//   node scripts/recon-account-move.js --db <file> --files <folder of the original statements>
//   node scripts/recon-account-move.js --db <file> --files <...> --apply        backup + move + undo file + audit rows
//   node scripts/recon-account-move.js --db <file> --undo <changes.json>
//
// EVIDENCE for a move: the statement file itself prints "A/C No: <number>" in its header;
// a line moves only if (a) it was imported from that file and (b) exactly one bank account
// on file has that account number. Anything else is listed, not moved.
// Only BankTransaction.bankAccountId and BankImport.bankAccountId change. Amounts, dates,
// narrations, matches and links are untouched. --apply refuses the live dev.db unless
// --allow-real-db and RECON_CONFIRM_REAL=YES.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

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
const P = (n) => Math.round((Number(n) || 0) * 100);
const baseName = (n) => String(n || '').replace(/ \(\d+\)(?=\.[a-z]+$)/i, '');

function headerAccountNo(file) {
  try {
    const wb = XLSX.read(fs.readFileSync(file), { type: 'buffer', raw: true });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
    for (const r of rows.slice(0, 25)) {
      const i = r.findIndex((c) => /^a\/c no\.?:?$/i.test(String(c).trim()) || /^account (no|number)\.?:?$/i.test(String(c).trim()));
      if (i >= 0 && r[i + 1] !== '') return String(r[i + 1]).replace(/\D/g, '') || null;
    }
  } catch { /* unreadable */ }
  return null;
}

async function plan() {
  const spec = val('--files');
  const files = [];
  if (spec) spec.split(',').forEach((p) => {
    const abs = path.resolve(p.trim());
    if (!fs.existsSync(abs)) { console.error('Not found: ' + abs); process.exit(2); }
    if (fs.statSync(abs).isDirectory()) fs.readdirSync(abs).filter((f) => /\.(xlsx|xls|xlsm)$/i.test(f)).forEach((f) => files.push(path.join(abs, f)));
    else files.push(abs);
  });
  const accounts = await prisma.bankAccount.findMany({ orderBy: { createdAt: 'asc' } });
  const txns = await prisma.bankTransaction.findMany();
  const first = accounts[0] && accounts[0].id;
  const accOfLine = (t) => t.bankAccountId || first;
  const byNo = new Map();
  accounts.forEach((a) => { const n = String(a.accNo || '').replace(/\D/g, ''); if (n.length >= 6) { if (!byNo.has(n)) byNo.set(n, []); byNo.get(n).push(a); } });
  const fileTarget = new Map(); // base file name -> { account, accNo }
  const notes = [];
  files.forEach((f) => {
    const no = headerAccountNo(f);
    const b = baseName(path.basename(f));
    if (!no) { notes.push(`${path.basename(f)}: no account number in the header - not used`); return; }
    const hits = byNo.get(no) || [];
    if (hits.length !== 1) { notes.push(`${path.basename(f)}: header account ${no} matches ${hits.length} account(s) on file - not used`); return; }
    fileTarget.set(b, { account: hits[0], accNo: no });
  });
  const moves = [];
  txns.forEach((t) => {
    const tgt = fileTarget.get(baseName(t.importFile));
    if (tgt && accOfLine(t) !== tgt.account.id) moves.push({ id: t.id, from: t.bankAccountId, to: tgt.account.id, file: t.importFile, date: t.date, type: t.type, amount: t.amount });
  });
  const moveIds = new Set(moves.map((m) => m.id));
  const imports = (await prisma.bankImport.findMany()).filter((i) => {
    const l = txns.find((t) => t.importBatch === i.id);
    const tgt = l && fileTarget.get(baseName(l.importFile));
    return tgt && (i.bankAccountId || first) !== tgt.account.id;
  }).map((i) => ({ id: i.id, from: i.bankAccountId, to: fileTarget.get(baseName((txns.find((t) => t.importBatch === i.id) || {}).importFile)).account.id }));
  // before / after for every account
  const stat = (acc, list) => {
    const net = list.reduce((s, t) => s + (t.type === 'Credit' ? P(t.amount) : -P(t.amount)), 0);
    const withBal = list.filter((t) => t.balance != null).sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.createdAt).localeCompare(String(b.createdAt)));
    const last = withBal.length ? withBal[withBal.length - 1] : null;
    const firstBal = withBal.length ? withBal[0] : null;
    const impliedOpening = firstBal ? (P(firstBal.balance) - (firstBal.type === 'Credit' ? P(firstBal.amount) : -P(firstBal.amount))) / 100 : null;
    const books = (P(acc.openBal) + net) / 100;
    return { lines: list.length, openBal: acc.openBal, books, printed: last ? last.balance : null, diff: last ? (P(last.balance) - P(books)) / 100 : null, impliedOpening, unmatched: list.filter((t) => t.reconStatus === 'Unmatched' && !t.category && !t.categoryKind && !t.excluded).length };
  };
  const before = {}; const after = {};
  accounts.forEach((a) => {
    before[a.id] = stat(a, txns.filter((t) => accOfLine(t) === a.id));
    after[a.id] = stat(a, txns.filter((t) => (moveIds.has(t.id) ? moves.find((m) => m.id === t.id).to : accOfLine(t)) === a.id));
  });
  return { accounts, moves, imports, notes, before, after };
}

function report(p) {
  console.log('=== ACCOUNT MOVE - ' + (flag('--apply') ? 'APPLY' : 'DRY RUN (nothing is written)') + ' ===');
  console.log('database: ' + dbPath + (isReal ? '   <-- THE LIVE DATABASE (read only in dry run)' : ''));
  p.notes.forEach((n) => console.log('  note: ' + n));
  const byFile = {};
  p.moves.forEach((m) => { const k = `${baseName(m.file)} -> ${(p.accounts.find((a) => a.id === m.to) || {}).bank} ${(p.accounts.find((a) => a.id === m.to) || {}).accNo}`; byFile[k] = (byFile[k] || 0) + 1; });
  console.log(`\nLINES THAT WOULD MOVE: ${p.moves.length}  (import batches: ${p.imports.length})`);
  Object.entries(byFile).forEach(([k, n]) => console.log(`  ${n} line(s)  ${k}`));
  console.log('\nBEFORE -> AFTER, per account (amounts in rupees):');
  p.accounts.forEach((a) => {
    const b = p.before[a.id]; const x = p.after[a.id];
    console.log(`  ${a.bank} ${a.accNo || '(no account number)'} - ${a.name || ''}`);
    console.log(`     lines: ${b.lines} -> ${x.lines}   still to match: ${b.unmatched} -> ${x.unmatched}`);
    console.log(`     opening on account: ${b.openBal}   amount in the books: ${b.books} -> ${x.books}   last printed balance: ${b.printed} -> ${x.printed}`);
    console.log(`     difference books vs statement: ${b.diff} -> ${x.diff}   (opening that would make it tie: ${x.impliedOpening})`);
  });
  console.log('\nNothing else changes. Matches, receipts and bills stay linked to their lines.');
}

async function apply(p) {
  if (isReal && !(flag('--allow-real-db') && process.env.RECON_CONFIRM_REAL === 'YES')) {
    console.error("REFUSED: this is the live database. --apply on it needs the user's decision (--allow-real-db and RECON_CONFIRM_REAL=YES).");
    process.exit(3);
  }
  if (!p.moves.length) { console.log('Nothing to move.'); return; }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(path.dirname(dbPath), '..', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const backup = path.join(dir, `account-move-${path.basename(dbPath)}-${stamp}.db`);
  await prisma.$executeRawUnsafe(`VACUUM INTO '${backup.split('\\').join('/').split("'").join("''")}'`);
  const undoFile = path.join(dir, `account-move-${stamp}.changes.json`);
  fs.writeFileSync(undoFile, JSON.stringify({ db: dbPath, backup, at: new Date().toISOString(), moves: p.moves, imports: p.imports }, null, 2));
  await prisma.$transaction(async (tx) => {
    for (const m of p.moves) {
      await tx.bankTransaction.update({ where: { id: m.id }, data: { bankAccountId: m.to } });
    }
    for (const i of p.imports) await tx.bankImport.update({ where: { id: i.id }, data: { bankAccountId: i.to } });
    await tx.auditLog.create({ data: { action: 'Statement lines moved to the bank account their statement belongs to', entity: 'BankTransaction', toValue: `${p.moves.length} line(s), ${p.imports.length} import batch(es)`, reason: 'The statement file header names this account number', actorName: 'recon-account-move' } });
  }, { timeout: 120000 });
  console.log(`Moved ${p.moves.length} line(s). Backup: ${backup}\nUndo with: node scripts/recon-account-move.js --db "${dbPath}" --undo "${undoFile}"`);
}

async function undo(file) {
  const log = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (path.resolve(log.db) !== dbPath) { console.error('That undo file belongs to ' + log.db); process.exit(2); }
  if (isReal && !(flag('--allow-real-db') && process.env.RECON_CONFIRM_REAL === 'YES')) { console.error('REFUSED: live database.'); process.exit(3); }
  await prisma.$transaction(async (tx) => {
    for (const m of log.moves) await tx.bankTransaction.update({ where: { id: m.id }, data: { bankAccountId: m.from } });
    for (const i of log.imports) await tx.bankImport.update({ where: { id: i.id }, data: { bankAccountId: i.from } });
    await tx.auditLog.create({ data: { action: 'Statement line move undone', entity: 'BankTransaction', toValue: `${log.moves.length} line(s) back`, actorName: 'recon-account-move' } });
  }, { timeout: 120000 });
  console.log(`Moved ${log.moves.length} line(s) back.`);
}

(async () => {
  try {
    if (val('--undo')) { await undo(val('--undo')); return; }
    const p = await plan();
    report(p);
    if (flag('--apply')) await apply(p);
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error(e); process.exit(1); });
