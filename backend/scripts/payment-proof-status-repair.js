#!/usr/bin/env node
/* eslint-disable no-console */
// ---------------------------------------------------------------------------
// OFFICE BILLS: "PENDING" NEXT TO A MATCHED BANK LINE  (Accounts bug fix, 2026-10-19)
//
// THE BUG. A bill that was matched to a bank statement debit by "Match bills" (Bank & Reconciliation) was linked
// (OfficeExpense.bankTxnId) but, if it was still Pending, stayed Pending for ever: the match only moved a bill that
// was APPROVED, and APPROVED was retired on 2026-10-05, so no bill could ever reach it. The details then showed
// "Status: Pending" beside "Proof of payment: Bank statement line - View line". The code is fixed; this script
// brings the bills ALREADY in that state in line with it.
//
// WHAT IT CHANGES: only a bill that is Pending (or an old Approved) whose linked bank line is a real money-out line,
// not set aside, not reversed, matched to THAT bill (the line itself says so) and big enough to cover it. Such a
// bill becomes Paid (paid on the date of the bank line, sign-off recorded as "Payment status repair"). It writes one
// audit line per bill and no notification. A link that is only a link (line not matched to the bill, part paid, line
// reversed or gone) is NEVER turned into a payment: those are listed in the report for a person to decide.
//
//   node scripts/payment-proof-status-repair.js                    DRY RUN (default): reads a copy of the database, writes only the CSV
//   node scripts/payment-proof-status-repair.js --db <copy.db> --apply     really writes - on a COPY
//   node scripts/payment-proof-status-repair.js --apply --really-real      really writes into prisma/dev.db (also needs env TL_ALLOW_REAL_APPLY=1)
//   node scripts/payment-proof-status-repair.js --undo <manifest.json> [--db <db>] [--really-real]
//   --csv <path>   the review file (default C:/Users/user/Desktop/TeamLink-Payment-Status-Review.csv)
//   --out <dir>    undo manifest folder   --backup-dir <dir>  where the pre-change backup goes
// SAFETY: dry run by default; VACUUM INTO backup first; undo manifest (old values); ONE transaction; running it twice changes nothing.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };

const BACK = path.resolve(__dirname, '..');
const DEV_DB = path.join(BACK, 'prisma', 'dev.db');
const dbArg = path.resolve(val('--db', DEV_DB));
const isReal = dbArg.toLowerCase() === DEV_DB.toLowerCase();
const APPLY = has('--apply');
const UNDO = val('--undo');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(val('--out', path.join(os.tmpdir(), `payment-proof-repair-${STAMP}`)));
const BACKUP_DIR = path.resolve(val('--backup-dir', isReal ? path.join(os.homedir(), '.teamlink-backups', `payment-proof-${STAMP}`) : path.join(OUT, 'backup')));
const CSV = path.resolve(val('--csv', 'C:/Users/user/Desktop/TeamLink-Payment-Status-Review.csv'));
const WHO = 'Payment status repair (bank line matched)';

if ((APPLY || UNDO) && isReal && !(has('--really-real') && process.env.TL_ALLOW_REAL_APPLY === '1')) {
  console.error('REFUSED: this would change the REAL database (prisma/dev.db). It needs --really-real AND the environment variable TL_ALLOW_REAL_APPLY=1. Use --db <copy> to try it on a copy first.');
  process.exit(2);
}
if (APPLY && UNDO) { console.error('Use either --apply or --undo, not both.'); process.exit(2); }

process.env.DATABASE_URL = `file:${dbArg.split(path.sep).join('/')}`;
process.chdir(BACK);
const { PrismaClient } = require('@prisma/client');
const PS = require('../src/utils/expensePaymentState');

const csvCell = (v) => { const s = v === null || v === undefined ? '' : String(v).replace(/\r?\n/g, ' '); return /[",;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const writeCsv = (file, cols, rows) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `\ufeff${cols.join(',')}\n${rows.map((r) => cols.map((c) => csvCell(r[c])).join(',')).join('\n')}${rows.length ? '\n' : ''}`); };
const sqlq = (s) => `'${String(s).split(path.sep).join('/').replace(/'/g, "''")}'`;

function vacuumFromReadOnly(src, dest) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(src, { readOnly: true });
  try { fs.mkdirSync(path.dirname(dest), { recursive: true }); if (fs.existsSync(dest)) fs.unlinkSync(dest); db.exec(`VACUUM INTO ${sqlq(dest)}`); } finally { db.close(); }
}
async function vacuumInto(prisma, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
  await prisma.$executeRawUnsafe(`VACUUM INTO ${sqlq(dest)}`);
}

// ------------------------------------------------------------------------------------------- PLAN
async function plan(prisma) {
  const linked = await prisma.officeExpense.findMany({ where: { bankTxnId: { not: null } }, orderBy: [{ expenseDate: 'asc' }, { createdAt: 'asc' }] });
  const F = await PS.loadFacts(prisma, linked);
  const rows = [];
  const fix = [];
  for (const e of linked) {
    const p = PS.judgeWith(e, F);
    const txn = F.txns.get(e.bankTxnId) || null;
    const status = PS.approvalOf(e);
    const pendingLike = status === 'PENDING' || status === 'APPROVED';
    // the symptom the founder saw: still Pending next to a bank line - and what is to be done about it
    let action = 'nothing to change';
    if (pendingLike && p.state === 'confirmed') action = 'WILL BE MARKED PAID (the bank line is matched to this bill and covers it)';
    else if (pendingLike) action = `left as it is - ${p.short}: a person has to decide`;
    else if (p.inconsistent) action = `left as it is (already ${status}) - ${p.short}: a person has to look`;
    rows.push({
      expenseCode: e.expenseCode || '', billId: e.id, vendor: e.vendor || '', category: e.category || '', billNumber: e.billNumber || '',
      billTotalAfterTds: PS.netOf(e), status, bankTxnId: e.bankTxnId,
      lineDate: txn ? txn.date : '', lineNarration: txn ? txn.description : '', lineReference: txn ? (txn.reference || '') : '', lineType: txn ? txn.type : '', lineAmount: txn ? txn.amount : '',
      lineState: p.proof.lineState || '', lineFiledToThisBill: p.proof.filed ? 'yes' : 'no', paymentState: p.state, reason: p.reason, action,
    });
    if (pendingLike && p.state === 'confirmed') fix.push({ e, txn, p });
  }
  return { rows, fix, linkedCount: linked.length };
}

// ------------------------------------------------------------------------------------------- APPLY
async function apply(prisma, fix, summary) {
  await prisma.$queryRawUnsafe('PRAGMA busy_timeout=120000');
  if (!fix.length) { console.log('NOTHING TO DO: no bill is Pending beside a matched bank line (no backup, nothing written).'); return null; }
  const backup = path.join(BACKUP_DIR, 'dev.db');
  await vacuumInto(prisma, backup);
  console.log(`backup written: ${backup} (${(fs.statSync(backup).size / 1048576).toFixed(1)} MB)`);
  const now = new Date();
  const manifest = { stamp: STAMP, database: dbArg, backup, status: 'planned', bills: [], auditIds: [], summary };
  fs.mkdirSync(OUT, { recursive: true });
  const manifestPath = path.join(OUT, 'undo-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
  try {
    await prisma.$transaction(async (tx) => {
      for (const { e, txn } of fix) {
        const status = PS.approvalOf(e);
        const data = {
          approvalStatus: 'PAID', paidStatus: 'Paid', paidAt: now, paymentDate: e.paymentDate || String(txn.date).slice(0, 10),
          ...(status === 'PENDING' ? { approvedAt: now, approvedBy: WHO } : {}),
        };
        const done = await tx.officeExpense.updateMany({ where: { id: e.id, approvalStatus: e.approvalStatus, bankTxnId: e.bankTxnId }, data });
        if (done.count !== 1) continue; // changed by somebody a moment ago: leave it
        // the line's own record of the match remembers how to undo it
        const oldLinks = txn.billLinks;
        if (oldLinks) {
          try {
            const arr = JSON.parse(oldLinks);
            const hit = Array.isArray(arr) ? arr.find((l) => l && l.id === e.id) : null;
            if (hit && !hit.movedToPaid) {
              Object.assign(hit, { movedToPaid: true, approvedById: e.approvedById || null, approvedAt: e.approvedAt || null, approvedBy: e.approvedBy || null });
              await tx.bankTransaction.update({ where: { id: txn.id }, data: { billLinks: JSON.stringify(arr) } });
            }
          } catch { /* the line's note is not JSON: leave it */ }
        }
        const audit = await tx.auditLog.create({
          data: {
            action: 'Office expense status: Paid', entity: 'OfficeExpense', entityId: e.id, field: 'approvalStatus', fieldLabel: 'Approval status', fromValue: status, toValue: 'PAID',
            reason: `Repair: the bank statement line of ${txn.date}${txn.reference ? ` (Ref ${txn.reference})` : ''} was already matched to this bill and covers it, but the bill was left Pending`,
            approvalStatus: 'PAID', approvedByName: WHO, approvedAt: now, actorName: WHO,
          },
        });
        manifest.auditIds.push(audit.id);
        manifest.bills.push({
          id: e.id, txnId: txn.id, oldBillLinks: oldLinks || null,
          before: { approvalStatus: e.approvalStatus, paidStatus: e.paidStatus, paidAt: e.paidAt, paymentDate: e.paymentDate, approvedAt: e.approvedAt, approvedBy: e.approvedBy },
          set: { approvalStatus: data.approvalStatus, approvedBy: data.approvedBy || e.approvedBy },
        });
      }
    }, { timeout: 120000, maxWait: 60000 });
    manifest.status = 'committed';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
  } catch (err) {
    manifest.status = 'failed'; manifest.error = String(err.message || err).slice(0, 600);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
    throw err;
  }
  return manifestPath;
}

// ------------------------------------------------------------------------------------------- UNDO
async function undo(prisma) {
  const m = JSON.parse(fs.readFileSync(UNDO, 'utf8'));
  console.log(`UNDO of ${m.stamp}: ${m.bills.length} bills, ${m.auditIds.length} audit lines`);
  await prisma.$queryRawUnsafe('PRAGMA busy_timeout=120000');
  await vacuumInto(prisma, path.join(BACKUP_DIR, 'before-undo.db'));
  const out = { restored: 0, skipped: [], auditRemoved: 0 };
  await prisma.$transaction(async (tx) => {
    out.auditRemoved = (await tx.auditLog.deleteMany({ where: { id: { in: m.auditIds } } })).count;
    for (const b of m.bills) {
      const cur = await tx.officeExpense.findUnique({ where: { id: b.id } });
      if (!cur) { out.skipped.push(`${b.id}: no longer exists`); continue; }
      if (cur.approvalStatus !== b.set.approvalStatus) { out.skipped.push(`${b.id}: status changed after the repair (now ${cur.approvalStatus}) - left as it is`); continue; }
      await tx.officeExpense.update({ where: { id: b.id }, data: { ...b.before, paidAt: b.before.paidAt ? new Date(b.before.paidAt) : null, approvedAt: b.before.approvedAt ? new Date(b.before.approvedAt) : null } });
      if (b.txnId) await tx.bankTransaction.update({ where: { id: b.txnId }, data: { billLinks: b.oldBillLinks } }).catch(() => {});
      out.restored += 1;
    }
  }, { timeout: 120000, maxWait: 60000 });
  console.log(JSON.stringify(out, null, 1));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  try {
    if (UNDO) { await undo(prisma); return; }
    let work = prisma; let tmp = null;
    if (!APPLY) {
      tmp = path.join(os.tmpdir(), `paymentproof-dryrun-${Date.now()}.db`);
      vacuumFromReadOnly(dbArg, tmp); // a read-only copy: a dry run cannot touch the database
      work = new PrismaClient({ datasources: { db: { url: `file:${tmp.split(path.sep).join('/')}` } } });
    }
    const r = await plan(work);
    const cols = ['expenseCode', 'billId', 'vendor', 'category', 'billNumber', 'billTotalAfterTds', 'status', 'bankTxnId', 'lineDate', 'lineNarration', 'lineReference', 'lineType', 'lineAmount', 'lineState', 'lineFiledToThisBill', 'paymentState', 'reason', 'action'];
    writeCsv(CSV, cols, r.rows);
    const summary = {
      mode: APPLY ? 'APPLY' : 'DRY RUN', database: dbArg, real: isReal, billsWithABankLink: r.linkedCount,
      listedInTheCsv: r.rows.length, willBeMarkedPaid: r.fix.length, needAPersonToDecide: r.rows.filter((x) => /a person has to/.test(x.action)).length, csv: CSV,
    };
    console.log(JSON.stringify(summary, null, 1));
    if (APPLY) {
      const done = await apply(prisma, r.fix, summary);
      if (done) console.log('APPLIED. undo manifest:', done);
    } else {
      await work.$disconnect();
      if (tmp) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
      console.log('DRY RUN - nothing was written to the database.');
    }
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error('FAILED:', e && e.stack ? e.stack : e); process.exit(1); });
