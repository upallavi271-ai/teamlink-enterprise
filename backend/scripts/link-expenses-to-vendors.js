#!/usr/bin/env node
/* eslint-disable no-console */
// ---------------------------------------------------------------------------
// LINK ACCOUNTS BILLS TO THEIR VENDOR BY ID (founder, 2026-10-23) - the fix for the empty Vendor Portal.
//
// WHY. The Vendor Portal reads a vendor's bills by OfficeExpense.vendorId, but bills booked in Accounts hold the vendor only as text
// (OfficeExpense.vendor); 151 of 152 had no vendorId, so every vendor's portal said "Nothing here yet". The rule (utils/vendorExpenseLink.js):
// the bill's vendor text equals exactly ONE vendor master record's name / company name (case, spaces, punctuation and the words Private,
// Pvt, Limited, Ltd, LLP ignored), or the bill's GSTIN equals exactly ONE vendor's GSTIN. Nothing else is linked; the rest is listed.
//
// WHAT IT CHANGES: OfficeExpense.vendorId, only where it is empty. No amount, status, name or date is touched; no row is created or deleted.
//   node scripts/link-expenses-to-vendors.js                         DRY RUN (default): reads, writes nothing, prints who would be linked
//   node scripts/link-expenses-to-vendors.js --db <copy.db> --apply  really writes - on a COPY
//   node scripts/link-expenses-to-vendors.js --apply --really-real   really writes into prisma/dev.db (also needs env TL_ALLOW_REAL_APPLY=1)
//   node scripts/link-expenses-to-vendors.js --undo <manifest.json> [--db <db>] [--really-real]
// SAFETY: dry run by default; VACUUM INTO backup first; undo manifest; ONE transaction; running it twice changes nothing.
// The LIVE site has its own database: run it there too (after the deploy).
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
const OUT = path.resolve(val('--out', path.join(os.tmpdir(), `link-expenses-${STAMP}`)));
const BACKUP_DIR = path.resolve(val('--backup-dir', isReal ? path.join(os.homedir(), '.teamlink-backups', `link-expenses-${STAMP}`) : path.join(OUT, 'backup')));

if ((APPLY || UNDO) && isReal && !(has('--really-real') && process.env.TL_ALLOW_REAL_APPLY === '1')) {
  console.error('REFUSED: this would change the REAL database (prisma/dev.db). It needs --really-real AND the environment variable TL_ALLOW_REAL_APPLY=1. Use --db <copy> to try it on a copy first.');
  process.exit(2);
}
if (APPLY && UNDO) { console.error('Use either --apply or --undo, not both.'); process.exit(2); }

process.env.DATABASE_URL = `file:${dbArg.split(path.sep).join('/')}`;
process.chdir(BACK);
const { PrismaClient } = require('@prisma/client');
const L = require('../src/utils/vendorExpenseLink');
const prisma = new PrismaClient();
const inr = (n) => Math.round(Number(n) || 0).toLocaleString('en-IN');

(async () => {
  try {
    if (UNDO) {
      const m = JSON.parse(fs.readFileSync(path.resolve(UNDO), 'utf8'));
      let back = 0;
      await prisma.$transaction(async (tx) => {
        for (const r of m.changes) {
          const x = await tx.officeExpense.updateMany({ where: { id: r.id, vendorId: r.newVendorId }, data: { vendorId: null } });
          back += x.count;
        }
      });
      console.log(`Undone: ${back} of ${m.changes.length} bills are unlinked again (a bill changed since is left as it is).`);
      return;
    }
    const vendors = await prisma.officeVendor.findMany({ select: { id: true, name: true, companyName: true, gstin: true, category: true } });
    const nameOf = new Map(vendors.map((v) => [v.id, v.name]));
    const index = L.indexOf(vendors);
    const bills = await prisma.officeExpense.findMany({ where: { vendorId: null }, select: { id: true, vendor: true, vendorGstin: true, monthlyAmount: true, expenseDate: true } });
    const changes = [];
    const per = new Map();
    const left = new Map();
    bills.forEach((b) => {
      const id = L.resolve(index, b.vendor, b.vendorGstin);
      if (id) {
        changes.push({ id: b.id, newVendorId: id, text: b.vendor });
        const p = per.get(id) || { n: 0, sum: 0, texts: new Set() };
        p.n += 1; p.sum += Number(b.monthlyAmount) || 0; p.texts.add(String(b.vendor)); per.set(id, p);
      } else {
        const k = String(b.vendor || '(no vendor name)');
        const l = left.get(k) || { n: 0, sum: 0 };
        l.n += 1; l.sum += Number(b.monthlyAmount) || 0; left.set(k, l);
      }
    });
    console.log(`Database: ${dbArg}${isReal ? '  (REAL)' : ''}`);
    console.log(`Bills without a vendor id: ${bills.length}. Would be linked: ${changes.length}. Left as they are: ${bills.length - changes.length}.\n`);
    console.log('LINKED (vendor master record <- bills):');
    [...per.entries()].forEach(([id, p]) => console.log(`  ${nameOf.get(id)}  <-  ${p.n} bill${p.n === 1 ? '' : 's'}, Rs ${inr(p.sum)}  (written as: ${[...p.texts].join(' | ')})`));
    console.log('\nNOT LINKED (no vendor master record with that name - add the vendor first, then run this again):');
    [...left.entries()].sort((a, b) => b[1].n - a[1].n).forEach(([k, l]) => console.log(`  ${k}: ${l.n} bill${l.n === 1 ? '' : 's'}, Rs ${inr(l.sum)}`));
    if (!APPLY) { console.log('\nDRY RUN: nothing was changed. Add --apply to write.'); return; }
    if (!changes.length) { console.log('\nNothing to link.'); return; }
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const bak = path.join(BACKUP_DIR, 'before.db');
    await prisma.$executeRawUnsafe(`VACUUM INTO '${bak.split(path.sep).join('/').replace(/'/g, "''")}'`);
    fs.mkdirSync(OUT, { recursive: true });
    const manifest = path.join(OUT, 'undo-manifest.json');
    fs.writeFileSync(manifest, JSON.stringify({ at: new Date().toISOString(), db: dbArg, changes }, null, 1));
    let done = 0;
    await prisma.$transaction(async (tx) => {
      for (const c of changes) {
        const x = await tx.officeExpense.updateMany({ where: { id: c.id, vendorId: null }, data: { vendorId: c.newVendorId } });
        done += x.count;
      }
      await tx.auditLog.create({ data: { action: 'Bills linked to vendors by id', entity: 'OfficeExpense', entityId: 'bulk', toValue: `${done} bills`, actorName: 'Vendor portal fix 2026-10-23' } });
    });
    console.log(`\nLINKED ${done} bills.\nBackup: ${bak}\nUndo:   node scripts/link-expenses-to-vendors.js --undo "${manifest}"${isReal ? ' --really-real' : ` --db "${dbArg}"`}`);
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error(String(e && e.message ? e.message : e).slice(0, 500)); process.exit(1); });
