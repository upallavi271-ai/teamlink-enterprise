#!/usr/bin/env node
/* eslint-disable no-console */
// ---------------------------------------------------------------------------
// "PENDING, BUT THERE IS PROOF" - review + guarded correction (Accounts, 2026-10-21)
//
// WHAT IT DOES. Walks every record that can carry proof next to an unpaid status (office bills with a bank line / bill file,
// client invoices with a proof file / UTR / bank line / receipt rows, bank credits not matched, vendor / payout / ID-card /
// HRMS claims) and writes ONE review file for the founder (default C:/Users/user/Desktop/TeamLink-Pending-With-Proof-Review.csv):
//   WRONG    the proof is a confirmed full payment that the status never followed -> these (and only these) are moved:
//              - an office bill whose linked bank line is a real money-out line, not set aside, not reversed, FILED AGAINST THAT BILL
//                and big enough to cover it  -> Paid (on the date of the bank line)
//              - a client invoice whose receipt rows add up to more than its received total -> received total brought in line,
//                status re-derived (Paid / Partially Paid) by the one rule in utils/accounts.js
//   CORRECT  everything else (a bill file is the bill itself, a link that is not matched, part payment, reversed, a bare proof
//            file with nothing recorded, a bank credit not matched yet) is listed with the exact reason and is NEVER changed.
// NOTHING is ever marked Paid because a file exists. No notification is sent.
//
//   node scripts/pending-with-proof-repair.js                      DRY RUN (default): reads a copy of the database, writes only the CSV
//   node scripts/pending-with-proof-repair.js --db <copy.db> --apply         really writes - on a COPY
//   node scripts/pending-with-proof-repair.js --apply --really-real          really writes into prisma/dev.db (also needs env TL_ALLOW_REAL_APPLY=1)
//   node scripts/pending-with-proof-repair.js --undo <manifest.json> [--db <db>] [--really-real]
//   --csv <path>  the review file   --out <dir>  undo manifest folder   --backup-dir <dir>  where the pre-change backup goes
// SAFETY: dry run by default; VACUUM INTO backup first; undo manifest (old values); ONE transaction; running it twice changes
// nothing; one audit line per changed record.
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
const OUT = path.resolve(val('--out', path.join(os.tmpdir(), `pending-with-proof-${STAMP}`)));
const BACKUP_DIR = path.resolve(val('--backup-dir', isReal ? path.join(os.homedir(), '.teamlink-backups', `pending-with-proof-${STAMP}`) : path.join(OUT, 'backup')));
const CSV = path.resolve(val('--csv', 'C:/Users/user/Desktop/TeamLink-Pending-With-Proof-Review.csv'));
const WHO = 'Pending-with-proof repair';

if ((APPLY || UNDO) && isReal && !(has('--really-real') && process.env.TL_ALLOW_REAL_APPLY === '1')) {
  console.error('REFUSED: this would change the REAL database (prisma/dev.db). It needs --really-real AND the environment variable TL_ALLOW_REAL_APPLY=1. Use --db <copy> to try it on a copy first.');
  process.exit(2);
}
if (APPLY && UNDO) { console.error('Use either --apply or --undo, not both.'); process.exit(2); }

process.env.DATABASE_URL = `file:${dbArg.split(path.sep).join('/')}`;
process.chdir(BACK);
const { PrismaClient } = require('@prisma/client');
const PS = require('../src/utils/expensePaymentState');
const PW = require('../src/utils/pendingWithProof');
const { deriveInvoiceStatus, invoiceOutstanding } = require('../src/utils/accounts');

const ROUND = (n) => Math.round((Number(n) || 0) * 100) / 100;
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

// ------------------------------------------------------------------------------------------- APPLY
async function apply(prisma, wrong, summary) {
  await prisma.$queryRawUnsafe('PRAGMA busy_timeout=120000');
  if (!wrong.length) { console.log('NOTHING TO DO: no record is in a wrong state (no backup, nothing written).'); return null; }
  const backup = path.join(BACKUP_DIR, 'dev.db');
  await vacuumInto(prisma, backup);
  console.log(`backup written: ${backup} (${(fs.statSync(backup).size / 1048576).toFixed(1)} MB)`);
  const now = new Date();
  const manifest = {
    stamp: STAMP, database: dbArg, backup, status: 'planned', bills: [], invoices: [], auditIds: [], summary,
  };
  fs.mkdirSync(OUT, { recursive: true });
  const manifestPath = path.join(OUT, 'undo-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
  try {
    await prisma.$transaction(async (tx) => {
      for (const { fix, idOrCode } of wrong) {
        if (fix.type === 'office-paid') {
          const e = await tx.officeExpense.findUnique({ where: { id: fix.billId } });
          const txn = await tx.bankTransaction.findUnique({ where: { id: fix.txnId } });
          if (!e || !txn) continue;
          const status = PS.approvalOf(e);
          if (status !== 'PENDING' && status !== 'APPROVED') continue; // somebody already moved it: leave it
          // re-judge on the fresh rows, inside the transaction (a relinked bill is judged as if it already pointed at the line)
          const asLinked = fix.relink ? { ...e, bankTxnId: txn.id } : e;
          const j = PS.judgeWith(asLinked, await PS.loadFacts(tx, [asLinked]));
          if (j.state !== 'confirmed') continue;
          const data = {
            approvalStatus: 'PAID', paidStatus: 'Paid', paidAt: now, paymentDate: e.paymentDate || String(txn.date).slice(0, 10),
            ...(status === 'PENDING' ? { approvedAt: now, approvedBy: WHO } : {}),
            ...(fix.relink ? { bankTxnId: txn.id } : {}),
          };
          const done = await tx.officeExpense.updateMany({ where: { id: e.id, approvalStatus: e.approvalStatus, ...(fix.relink ? { bankTxnId: null } : { bankTxnId: e.bankTxnId }) }, data });
          if (done.count !== 1) continue;
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
            id: e.id, txnId: txn.id, oldBillLinks: oldLinks || null, relinked: !!fix.relink,
            before: { approvalStatus: e.approvalStatus, paidStatus: e.paidStatus, paidAt: e.paidAt, paymentDate: e.paymentDate, approvedAt: e.approvedAt, approvedBy: e.approvedBy },
            set: { approvalStatus: 'PAID' },
          });
        } else if (fix.type === 'invoice-received') {
          const inv = await tx.invoice.findUnique({ where: { id: fix.invoiceId }, include: { payments: true } });
          if (!inv || inv.status === 'Cancelled') continue;
          const paysTotal = ROUND(inv.payments.reduce((s, p) => s + Number(p.amount || 0), 0));
          if (!(inv.payments.length && paysTotal > ROUND(inv.receivedAmount) + 0.5)) continue; // already in line
          // never more than the invoice can still take
          const ceiling = ROUND(Number(inv.receivedAmount || 0) + Math.max(0, invoiceOutstanding(inv)));
          const received = Math.min(paysTotal, ceiling);
          const status = deriveInvoiceStatus({ ...inv, receivedAmount: received });
          const last = inv.payments.map((p) => p.date).filter(Boolean).sort().pop() || null;
          const data = { receivedAmount: received, status, ...(status === 'Paid' && !inv.paidDate && last ? { paidDate: last } : {}) };
          const done = await tx.invoice.updateMany({ where: { id: inv.id, receivedAmount: inv.receivedAmount }, data });
          if (done.count !== 1) continue;
          const audit = await tx.auditLog.create({
            data: {
              action: 'Invoice received total repaired', entity: 'Invoice', entityId: inv.id, field: 'receivedAmount', fieldLabel: 'Received amount', fromValue: String(inv.receivedAmount), toValue: String(received),
              reason: `Repair: ${inv.payments.length} receipt row(s) add up to ${paysTotal} but the invoice said ${inv.receivedAmount} was received`, actorName: WHO,
            },
          });
          manifest.auditIds.push(audit.id);
          manifest.invoices.push({ id: inv.id, before: { receivedAmount: inv.receivedAmount, status: inv.status, paidDate: inv.paidDate }, set: { receivedAmount: received, status } });
        }
      }
    }, { timeout: 120000, maxWait: 60000 });
    manifest.status = 'committed';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
  } catch (err) {
    manifest.status = 'failed'; manifest.error = String(err.message || err).slice(0, 600);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
    throw err;
  }
  console.log(`changed: ${manifest.bills.length} office bill(s), ${manifest.invoices.length} invoice(s); ${manifest.auditIds.length} audit line(s)`);
  return manifestPath;
}

// ------------------------------------------------------------------------------------------- UNDO
async function undo(prisma) {
  const m = JSON.parse(fs.readFileSync(UNDO, 'utf8'));
  console.log(`UNDO of ${m.stamp}: ${m.bills.length} bills, ${m.invoices.length} invoices, ${m.auditIds.length} audit lines`);
  await prisma.$queryRawUnsafe('PRAGMA busy_timeout=120000');
  await vacuumInto(prisma, path.join(BACKUP_DIR, 'before-undo.db'));
  const out = { restored: 0, skipped: [], auditRemoved: 0 };
  await prisma.$transaction(async (tx) => {
    out.auditRemoved = (await tx.auditLog.deleteMany({ where: { id: { in: m.auditIds } } })).count;
    for (const b of m.bills) {
      const cur = await tx.officeExpense.findUnique({ where: { id: b.id } });
      if (!cur) { out.skipped.push(`${b.id}: no longer exists`); continue; }
      if (cur.approvalStatus !== b.set.approvalStatus) { out.skipped.push(`${b.id}: status changed after the repair (now ${cur.approvalStatus}) - left as it is`); continue; }
      await tx.officeExpense.update({
        where: { id: b.id },
        data: { ...b.before, paidAt: b.before.paidAt ? new Date(b.before.paidAt) : null, approvedAt: b.before.approvedAt ? new Date(b.before.approvedAt) : null, ...(b.relinked ? { bankTxnId: null } : {}) },
      });
      if (b.txnId) await tx.bankTransaction.update({ where: { id: b.txnId }, data: { billLinks: b.oldBillLinks } }).catch(() => {});
      out.restored += 1;
    }
    for (const i of m.invoices) {
      const cur = await tx.invoice.findUnique({ where: { id: i.id } });
      if (!cur) { out.skipped.push(`${i.id}: no longer exists`); continue; }
      if (ROUND(cur.receivedAmount) !== ROUND(i.set.receivedAmount)) { out.skipped.push(`${i.id}: received total changed after the repair - left as it is`); continue; }
      await tx.invoice.update({ where: { id: i.id }, data: i.before });
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
      tmp = path.join(os.tmpdir(), `pendingproof-dryrun-${Date.now()}.db`);
      vacuumFromReadOnly(dbArg, tmp); // a read-only copy: a dry run cannot touch the database
      work = new PrismaClient({ datasources: { db: { url: `file:${tmp.split(path.sep).join('/')}` } } });
    }
    const r = await PW.scanAll(work);
    const rows = r.rows.map((x) => ({ ...x, verdict: x.verdict === 'WRONG' ? 'WRONG status - will be corrected by --apply' : 'CORRECT pending - left as it is' }));
    // the possible duplicate pairs go in the same file, listed only (never deleted or changed)
    r.dupes.forEach((d) => rows.push({
      kind: 'Possible duplicate (bill + bank-line bill)', idOrCode: `${d.pending.expenseCode || d.pending.id} vs ${d.paidFromLine.expenseCode || d.paidFromLine.id}`, party: d.pending.vendor || d.pending.category || '', amount: PS.netOf(d.pending), shownStatus: 'Pending',
      proofAttached: `${d.paidFromLine.expenseCode || d.paidFromLine.id} already carries the bank line`, whyStillPending: 'Another bill of the same cash amount (same vendor or within 45 days) already carries a bank line. If this is the same payment it is a duplicate bill - the founder decides; nothing is deleted.',
      rootCauseClass: 'same payment entered twice?', proposedStatus: 'untouched - for a person', verdict: 'LISTED for a person',
    }));
    writeCsv(CSV, PW.COLUMNS, rows);
    const summary = {
      mode: APPLY ? 'APPLY' : 'DRY RUN', database: dbArg, real: isReal, ...r.summary, listedInTheCsv: rows.length, willBeCorrected: r.wrong.length, csv: CSV,
    };
    console.log(JSON.stringify(summary, null, 1));
    if (APPLY) {
      const done = await apply(prisma, r.wrong, summary);
      if (done) console.log('APPLIED. undo manifest:', done);
    } else {
      await work.$disconnect();
      if (tmp) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
      console.log('DRY RUN - nothing was written to the database.');
    }
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error('FAILED:', e && e.stack ? e.stack : e); process.exit(1); });
