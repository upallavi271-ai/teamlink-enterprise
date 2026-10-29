#!/usr/bin/env node
// ---------------------------------------------------------------------------
// STATEMENTS IMPORTED INTO THE WRONG BANK ACCOUNT (founder 2026-10-29: "HDFC and ICICI statements rendu import chesam kani anni HDFC ani chupistundi")
//   cd backend
//   node scripts/fix-statements-wrong-bank-2026-10-29.js           DRY RUN (default): reads only, prints what would move
//   node scripts/fix-statements-wrong-bank-2026-10-29.js --apply   moves them (take a copy of the database first)
// Uses the database in DATABASE_URL (backend/.env), so on the live server it runs against the live database.
//
// The import used to put every file into the account selected on the Bank screen (the first one, HDFC). An import is moved
// only when its own file name names a bank ("ICICI_May2026_statement.xlsx") that is not the account's bank AND exactly one
// account of that bank exists. Its lines, the import record and their duplicate-check keys move together; links to
// invoices / bills stay as they are (they point at the line, not the account). Nothing is deleted, no amount changes.
// Afterwards the opening balance of each account that changed is worked back from its own statement lines (the same as
// the "Fix opening" button) - the first import had set HDFC's opening from the ICICI September file.
// Running it twice moves nothing new.
// ---------------------------------------------------------------------------
const path = require('path');

const BACK = path.resolve(__dirname, '..');
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env') });
const prisma = require(path.join(BACK, 'src/db'));
const BF = require(path.join(BACK, 'src/utils/bankFormat'));

const APPLY = process.argv.includes('--apply');
const BANKS = BF.SIGNATURES.map((s) => s.bank);
const ROUND = (n) => Math.round(Number(n) * 100) / 100;
const signed = (t) => (t.type === 'Credit' ? Number(t.amount || 0) : -Number(t.amount || 0));
const oldestFirst = (rows) => [...rows].sort((a, b) => String(a.date).localeCompare(String(b.date))
  || String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id).localeCompare(String(b.id)));
const label = (a) => `${a.bank}${a.accNo ? ` ****${String(a.accNo).slice(-4)}` : ''}`;
const bankOfFile = (name) => {
  const hit = BANKS.filter((b) => new RegExp(`(^|[^a-z])${b}([^a-z]|$)`, 'i').test(String(name || '')));
  return hit.length === 1 ? hit[0] : null;
};

async function main() {
  const accounts = await prisma.bankAccount.findMany({ orderBy: { createdAt: 'asc' } });
  const firstId = accounts[0]?.id;
  const imports = await prisma.bankImport.findMany({ orderBy: { createdAt: 'asc' } });
  const moves = [];
  for (const imp of imports) {
    const fileBank = bankOfFile(imp.file || imp.originalName);
    const on = accounts.find((a) => a.id === (imp.bankAccountId || firstId));
    if (!fileBank || !on || BF.accountIsBank(on, fileBank)) continue;
    const right = accounts.filter((a) => BF.accountIsBank(a, fileBank));
    if (right.length !== 1) { console.log(`  SKIP ${imp.id} ${imp.file}: ${right.length} ${fileBank} accounts - choose by hand`); continue; }
    const lines = await prisma.bankTransaction.count({ where: { importBatch: imp.id } });
    moves.push({ imp, from: on, to: right[0], lines });
  }

  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} - ${moves.length} import(s) in the wrong account`);
  for (const m of moves) console.log(`  ${m.imp.id}  ${m.imp.file}  ${m.lines} line(s)  ${m.imp.fromDate || '?'}..${m.imp.toDate || '?'}  ${label(m.from)} -> ${label(m.to)}`);

  const touched = new Set(moves.flatMap((m) => [m.from.id, m.to.id]));
  if (APPLY && moves.length) {
    for (const m of moves) {
      const ids = (await prisma.bankTransaction.findMany({ where: { importBatch: m.imp.id }, select: { id: true } })).map((t) => t.id);
      await prisma.$transaction(async (tx) => {
        await tx.bankTransaction.updateMany({ where: { importBatch: m.imp.id }, data: { bankAccountId: m.to.id } });
        await tx.bankImport.update({ where: { id: m.imp.id }, data: { bankAccountId: m.to.id } });
        for (let i = 0; i < ids.length; i += 400) {
          const part = ids.slice(i, i + 400);
          await tx.$executeRawUnsafe(`UPDATE "BankTxnKey" SET "bankAccountId" = ? WHERE "txnId" IN (${part.map(() => '?').join(',')})`, m.to.id, ...part);
        }
        await tx.$executeRawUnsafe('UPDATE "BankStmtBatch" SET "bankAccountId" = ? WHERE "importId" = ?', m.to.id, m.imp.id);
        await tx.auditLog.create({ data: { action: 'Bank statement moved to the right account', entity: 'BankImport', entityId: m.imp.id, fromValue: label(m.from), toValue: `${label(m.to)} - ${ids.length} line(s), ${m.imp.file}` } });
      });
    }
  }

  // Opening balances: worked back from each changed account's own first line with a printed balance
  const all = await prisma.bankTransaction.findMany();
  for (const a of accounts.filter((x) => touched.has(x.id))) {
    let mine = all.filter((t) => (t.bankAccountId || firstId) === a.id);
    if (!APPLY) { // show what the opening WILL be once the lines have moved
      const moved = new Map(moves.map((m) => [m.imp.id, m.to.id]));
      mine = all.filter((t) => (moved.get(t.importBatch) || t.bankAccountId || firstId) === a.id);
    }
    const first = oldestFirst(mine).find((t) => t.balance != null);
    if (!first) { console.log(`  ${label(a)}: no line with a balance - opening left at ${a.openBal}`); continue; }
    const implied = ROUND(Number(first.balance) - signed(first));
    const same = ROUND(a.openBal || 0) === implied && a.openDate === first.date;
    console.log(`  ${label(a)} opening: ${a.openBal} on ${a.openDate || '-'}  ->  ${implied} on ${first.date}${same ? ' (already right)' : ''}`);
    if (APPLY && !same) {
      await prisma.bankAccount.update({ where: { id: a.id }, data: { openBal: implied, openDate: first.date } });
      await prisma.auditLog.create({ data: { action: 'Opening balance set from the statement', entity: 'BankAccount', entityId: a.id, fromValue: `${a.openBal} on ${a.openDate || '-'}`, toValue: `${implied} on ${first.date}` } });
    }
  }
  if (!APPLY && moves.length) console.log('Nothing changed. Run again with --apply to move them.');
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
