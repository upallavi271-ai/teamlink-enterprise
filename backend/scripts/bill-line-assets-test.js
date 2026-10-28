#!/usr/bin/env node
// ---------------------------------------------------------------------------
// BILL LINES -> ASSET -> WHO HAD IT ON THE BILL DATE / WHO HAS IT NOW (founder 2026-10-28). NO SERVER NEEDED.
//   cd backend && node scripts/bill-line-assets-test.js
// Runs on its OWN copy of prisma/dev.db (deleted at the end). Proves: a serial number in a line finds the asset; brand + model of
// exactly one asset finds it; two assets of the same model are never guessed; the holder on the bill date is read from the asset's
// HRMS history (assigned before, returned after); a bill date before any assignment says "not recorded" and shows who has it now;
// another vendor's asset is never matched.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');

const BACK = path.join(__dirname, '..');
const copy = path.join(os.tmpdir(), `tl-billlines-${Date.now()}.db`);
let pass = 0; let fail = 0;
const check = (name, ok, info) => { if (ok) { pass += 1; console.log(`  PASS ${name}`); } else { fail += 1; console.log(`  FAIL ${name}`, info === undefined ? '' : JSON.stringify(info).slice(0, 500)); } };

(async () => {
  {
    const { PrismaClient } = require(path.join(BACK, 'node_modules/@prisma/client'));
    const p = new PrismaClient({ datasources: { db: { url: `file:${path.join(BACK, 'prisma/dev.db')}` } } });
    await p.$executeRawUnsafe(`VACUUM INTO '${copy.replace(/\\/g, '/')}'`);
    await p.$disconnect();
  }
  process.env.DATABASE_URL = `file:${copy.replace(/\\/g, '/')}`;
  process.env.TEST_MODE = '1';
  const prisma = require(path.join(BACK, 'src/db'));
  const BU = require(path.join(BACK, 'src/utils/billUploads'));
  const BLA = require(path.join(BACK, 'src/utils/billLineAssets'));
  const SCH = require(path.join(BACK, 'src/utils/assetVendorSchema'));
  try {
    await SCH.ensure();
    const T = Date.now();
    const ven = await prisma.officeVendor.create({ data: { name: `ZZTEST BL ${T}`, companyName: 'ZZTEST BL', isActive: true, category: 'Other' } });
    const other = await prisma.officeVendor.create({ data: { name: `ZZTEST BL other ${T}`, companyName: 'ZZTEST BLO', isActive: true, category: 'Other' } });
    const emps = await prisma.employee.findMany({ take: 2, orderBy: { createdAt: 'asc' } });
    const hist = (lines) => JSON.stringify(lines.slice().reverse()); // HRMS keeps the newest line first
    const a1 = await prisma.asset.create({ data: { assetCode: `ZZBL-${T}-1`, name: 'ZZ Laptop one', category: 'Laptop', assetType: 'DELL LATITUDE 5420 · SN ZZSER11111', serialNumber: `ZZSER11111`, vendorId: ven.id, status: 'Assigned', assignedToId: emps[1].id, assignedAt: new Date('2026-10-10T05:00:00Z'),
      history: hist([{ at: '2026-09-01 10:00', by: 'HR', text: `Assigned to ${emps[0].name}` }, { at: '2026-10-05 10:00', by: 'HR', text: `Returned by ${emps[0].name}` }, { at: '2026-10-10 10:00', by: 'HR', text: `Assigned to ${emps[1].name}` }]) } });
    const a2 = await prisma.asset.create({ data: { assetCode: `ZZBL-${T}-2`, name: 'ZZ Printer', category: 'Printer', assetType: 'HP LASERJET M1136', vendorId: ven.id, status: 'Assigned', assignedToId: emps[0].id, assignedAt: new Date('2026-10-20T05:00:00Z'), history: '[]' } });
    await prisma.asset.create({ data: { assetCode: `ZZBL-${T}-3`, name: 'ZZ Mouse a', category: 'Mouse', assetType: 'LOGITECH M90', vendorId: ven.id, status: 'Available', history: '[]' } });
    await prisma.asset.create({ data: { assetCode: `ZZBL-${T}-4`, name: 'ZZ Mouse b', category: 'Mouse', assetType: 'LOGITECH M90', vendorId: ven.id, status: 'Available', history: '[]' } });
    await prisma.asset.create({ data: { assetCode: `ZZBL-${T}-5`, name: 'ZZ other vendor laptop', category: 'Laptop', serialNumber: 'ZZSER99999', vendorId: other.id, status: 'Available', history: '[]' } });
    const cands = await BU.candidatesFor(ven.id);
    const lines = [
      { lineNo: 1, description: 'Screen replaced Dell sl no zzser11111' },
      { lineNo: 2, description: 'HP Laserjet M1136 drum' },
      { lineNo: 3, description: 'Logitech M90 mouse' },
      { lineNo: 4, description: 'Laptop sn ZZSER99999 keyboard' },
    ];
    let out = await BLA.lineAssets(lines, cands, '2026-09-20', null);
    const L = (n) => out.find((x) => x.lineNo === n);
    check('L1 serial number in a handwritten line finds the asset', L(1).asset && L(1).asset.id === a1.id, L(1));
    check('L2 the holder ON the bill date comes from the HRMS history (assigned 1 Sep, bill 20 Sep)', L(1).onBillDate && L(1).onBillDate.name === emps[0].name, L(1).onBillDate);
    check('L3 who has it NOW is shown too', L(1).now && L(1).now.name === emps[1].name, L(1).now);
    check('L4 brand + model of exactly one asset finds it', L(2).asset && L(2).asset.id === a2.id && /Brand and model/.test(L(2).how), L(2));
    check('L5 a bill date before any assignment: not recorded on that date, present holder shown', L(2).onBillDate === null && L(2).now && L(2).now.name === emps[0].name, L(2));
    check('L6 two assets of the same model are never guessed', !L(3).asset && L(3).ambiguous === true, L(3));
    check('L7 another vendor\'s asset is never matched', !L(4).asset, L(4));
    out = await BLA.lineAssets(lines, cands, '2026-10-07', null);
    check('L8 between return and the next assignment: nobody had it', L(1).onBillDate && L(1).onBillDate.none === true, L(1).onBillDate);
    out = await BLA.lineAssets([{ lineNo: 1, description: 'General service charges' }], cands, '2026-10-12', a1.id);
    check('L9 a one-line bill with an asset already chosen -> that asset, holder on the date', out[0].asset && out[0].asset.id === a1.id && out[0].onBillDate && out[0].onBillDate.name === emps[1].name, out[0]);
  } catch (err) {
    fail += 1; console.log('  ERROR', err && err.stack);
  } finally {
    await prisma.$disconnect().catch(() => {});
    for (const f of [copy, `${copy}-wal`, `${copy}-shm`, `${copy}-journal`]) { try { fs.unlinkSync(f); } catch { /* gone */ } }
    console.log(`\nBill lines: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
