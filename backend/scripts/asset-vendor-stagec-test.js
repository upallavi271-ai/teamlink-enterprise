#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ASSETS VENDOR PORTAL - STAGE C (Repairs & HRMS Tickets, founder's prompt 27 Oct 2026, §C6). NO SERVER NEEDED.
//   cd backend && node scripts/asset-vendor-stagec-test.js
// Runs on its OWN copy of prisma/dev.db (VACUUM INTO a temp file, deleted at the end): the real database is never written.
// Proves: accept / reject (reject needs a reason, blocks the steps); "Asset received" counts as accepting; parts + labour + real dates +
// outcome saved and the real completion date reaches HRMS (AssetRepair.repairDate); proof files are kept (same file twice = once);
// a replaced invoice file is KEPT; another vendor cannot touch the repair; a second repair of the same asset is its own history;
// replacement: vendor asks -> HR approves -> new asset recorded, the original kept with its id; a second open request is refused;
// an approved HRMS "Replacement" ticket opens an approved replacement; the vendor's HRMS ticket list shows only its own assets.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');

const BACK = path.join(__dirname, '..');
const copy = path.join(os.tmpdir(), `tl-stagec-${Date.now()}.db`);
let pass = 0; let fail = 0;
const check = (name, ok, info) => { if (ok) { pass += 1; console.log(`  PASS ${name}`); } else { fail += 1; console.log(`  FAIL ${name}`, info === undefined ? '' : JSON.stringify(info).slice(0, 400)); } };

(async () => {
  // 1. a private copy of the database
  {
    const { PrismaClient } = require(path.join(BACK, 'node_modules/@prisma/client'));
    const p = new PrismaClient({ datasources: { db: { url: `file:${path.join(BACK, 'prisma/dev.db')}` } } });
    await p.$executeRawUnsafe(`VACUUM INTO '${copy.replace(/\\/g, '/')}'`);
    await p.$disconnect();
  }
  process.env.DATABASE_URL = `file:${copy.replace(/\\/g, '/')}`;
  process.env.TEST_MODE = '1';
  const prisma = require(path.join(BACK, 'src/db'));
  const AVP = require(path.join(BACK, 'src/utils/assetVendorPortal'));
  const RW = require(path.join(BACK, 'src/utils/assetRepairWork'));
  const HS = require(path.join(BACK, 'src/utils/assetHrmsScope'));
  const DB = require(path.join(BACK, 'src/utils/vmDb'));
  const AC = require(path.join(BACK, 'src/utils/assetComplaints'));
  const SCH = require(path.join(BACK, 'src/utils/assetVendorSchema'));
  try {
    await SCH.ensure();
    const T = Date.now();
    const mkVendor = async (tag) => {
      const ven = await prisma.officeVendor.create({ data: { name: `ZZTEST SC ${tag} ${T}`, companyName: `ZZTEST SC ${tag}`, isActive: true, category: 'Other' } });
      const vu = await prisma.vendorUser.create({ data: { vendorId: ven.id, name: `ZZ ${tag}`, email: `zz-sc-${tag}-${T}@example.test`, passwordHash: 'x', status: 'Active', canEdit: true } });
      await DB.run('INSERT INTO "VendorLoginModule" ("id","vendorUserId","moduleKey","permissionsJson","createdAt","updatedAt") VALUES (?,?,?,?,?,?)', [`zzsc${tag}${T}`, vu.id, 'assets', '{}', T, T]);
      return { userId: vu.id, vendorId: ven.id, vendorName: ven.name, name: vu.name, canEdit: true, canViewCost: false, showAmounts: true };
    };
    const v = await mkVendor('A');
    const other = await mkVendor('B');
    const asset = await prisma.asset.create({ data: { assetCode: `ZZSC-${T}-1`, name: 'ZZTEST laptop', category: 'Laptop', status: 'In Repair', vendorId: v.vendorId, history: '[]' } });
    const newAsset = await prisma.asset.create({ data: { assetCode: `ZZSC-${T}-2`, name: 'ZZTEST laptop new', category: 'Laptop', status: 'Available', history: '[]' } });
    const rep = await prisma.assetRepair.create({ data: { repairNo: `ZZSC-${T}-R1`, assetId: asset.id, dateReported: '2026-10-01', issue: 'Screen broken', vendor: v.vendorName, status: 'Reported' } });
    const my = async (vv = v) => AVP.myRepair(vv, rep.id);
    const stage = async () => { const m = await my(); return AVP.stageOf(m.repair, m.side); };

    // decisions
    let m = await my();
    let r = await RW.decide(v, m, await stage(), { decision: 'Rejected', reason: '' });
    check('C1 reject without a reason is refused', r.status === 400 && r.body.field === 'reason', r);
    check('C2 another vendor cannot even open the repair', (await my(other)) === null);
    r = await RW.decide(v, m, await stage(), { decision: 'Accepted' });
    let list = await AVP.listRepairs(v, { bucket: 'In progress' });
    check('C3 accepted -> "In progress" tab', r.status === 200 && list.rows.some((x) => x.id === rep.id && x.decision === 'Accepted'), [r.status, list.rows.map((x) => x.bucket)]);
    r = await RW.saveWork(v, await my(), await stage(), { partsCost: 100 });
    check('C4 the work is refused before "Asset received"', r.status === 409, r);
    // steps
    m = await my();
    r = await AVP.updateRepair(v, {}, rep.id, { stage: 'Sent for repair', updatedAt: m.repair.updatedAt });
    check('C5 "Asset received" works after accepting', r.status === 200, r.body && r.body.error);
    r = await RW.saveWork(v, await my(), await stage(), { partsCost: '1200', labourCost: 300, startDate: '2026-10-02', workPerformed: 'Panel replaced' });
    check('C6 parts, labour, start date, work done are saved', r.status === 200 && r.body.changed.length === 4, r);
    r = await RW.saveWork(v, await my(), await stage(), { completedDate: '2026-10-05' });
    check('C7 a completion date before "Repair done" is refused', r.status === 409, r);
    m = await my();
    r = await AVP.updateRepair(v, {}, rep.id, { stage: 'Under repair', updatedAt: m.repair.updatedAt });
    m = await my();
    r = await AVP.updateRepair(v, {}, rep.id, { stage: 'Completed', finalCost: 1500, updatedAt: m.repair.updatedAt });
    check('C8 "Repair done" with the final cost', r.status === 200, r.body && r.body.error);
    r = await RW.saveWork(v, await my(), await stage(), { completedDate: '2026-10-04', outcome: 'repaired' });
    const fresh = await prisma.assetRepair.findUnique({ where: { id: rep.id } });
    check('C9 the REAL completion date reaches HRMS (AssetRepair.repairDate) and the outcome is saved', r.status === 200 && fresh.repairDate === '2026-10-04', [r.status, fresh.repairDate, r.body]);
    r = await RW.saveWork(v, await my(), await stage(), { completedDate: '2026-09-01' });
    check('C10 a completion date before the start date is refused', r.status === 400, r);
    // proof files
    const fake = (n) => ({ billFile: `${'a'.repeat(31)}${n}.pdf`, billName: `proof-${n}.pdf`, billMime: 'application/pdf', billSize: 10 });
    r = await RW.addProof(v, await my(), fake(1), 'hash-1', 'Before photo');
    const r2 = await RW.addProof(v, await my(), fake(2), 'hash-1', 'same again');
    await RW.addProof(v, await my(), fake(3), 'hash-2', 'After photo');
    const proofs = await RW.proofsOf([rep.id], v.vendorId);
    check('C11 proof files kept; the same file twice is kept once', r.status === 201 && r2.body.unchanged && proofs.length === 2, proofs.length);
    let blocked = false;
    try { await DB.run('DELETE FROM "AssetRepairProof" WHERE "repairId" = ?', [rep.id]); } catch { blocked = true; }
    check('C12 proof rows cannot be deleted (append-only)', blocked);
    check('C13 another vendor cannot download the proof', (await RW.ownedProofFile(other.vendorId, await HS.visibleRepairIds(other), proofs[0].id)) === null);
    // detail + history
    const d = await AVP.repairDetail(v, rep.id);
    check('C14 the detail shows the work, proofs and history', d.repair.partsCost === 1200 && d.repair.labourCost === 300 && d.repair.outcome === 'Repaired' && d.proofs.length === 2 && d.history.length > 0, d.repair);
    // a second repair of the same asset = its own record
    const rep2 = await prisma.assetRepair.create({ data: { repairNo: `ZZSC-${T}-R2`, assetId: asset.id, dateReported: '2026-10-10', issue: 'Keyboard', vendor: v.vendorName, status: 'Reported' } });
    const d2 = await AVP.repairDetail(v, rep2.id);
    check('C15 a second repair of the same asset keeps its own history (the first is listed under the asset)', d2.repair.partsCost === null && d2.assetRepairs.some((x) => x.id === rep.id));
    // rejection blocks the steps
    m = await AVP.myRepair(v, rep2.id);
    r = await RW.decide(v, m, AVP.stageOf(m.repair, m.side), { decision: 'Rejected', reason: 'No parts available for this model' });
    m = await AVP.myRepair(v, rep2.id);
    const r3 = await AVP.updateRepair(v, {}, rep2.id, { stage: 'Sent for repair', updatedAt: m.repair.updatedAt });
    list = await AVP.listRepairs(v, { bucket: 'Closed' });
    check('C16 rejected with a reason -> steps blocked, shown under Closed', r.status === 200 && r3.status === 409 && list.rows.some((x) => x.id === rep2.id), [r.status, r3.status]);
    // replacement
    m = await my();
    r = await RW.requestReplacement(v, m, await stage(), { reason: 'Motherboard dead, cannot be repaired' });
    const again = await RW.requestReplacement(v, await my(), await stage(), { reason: 'again please' });
    list = await AVP.listRepairs(v, { bucket: 'Waiting for approval' });
    check('C17 replacement asked; a second open request is refused; the repair waits for approval', r.status === 201 && again.status === 409 && list.rows.some((x) => x.id === rep.id), [r.status, again.status, list.rows.map((x) => x.bucket)]);
    const hr = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN' } });
    let rows = await RW.listReplacements({});
    const rx = rows.find((x) => x.originalAssetId === asset.id);
    let c = await RW.completeReplacement(hr, rx.id, { replacementAssetId: newAsset.assetCode, originalFinalStatus: 'Scrapped' });
    check('C18 the new asset cannot be recorded before approval', c.status === 409, c);
    c = await RW.decideReplacement(hr, rx.id, { approve: true, approvalRef: 'MAIL-28OCT' });
    check('C19 HR approves', c.status === 200, c);
    c = await RW.completeReplacement(hr, rx.id, { replacementAssetId: asset.assetCode, originalFinalStatus: 'Scrapped' });
    check('C20 the same asset cannot replace itself', c.status === 400, c);
    c = await RW.completeReplacement(hr, rx.id, { replacementAssetId: newAsset.assetCode, originalFinalStatus: 'Scrapped', replacementDate: '2026-10-20' });
    rows = await RW.listReplacements({});
    const done = rows.find((x) => x.id === rx.id);
    const orig = await prisma.asset.findUnique({ where: { id: asset.id } });
    check('C21 replacement complete: links original -> new, the original is kept with its id and history', c.status === 200 && done.status === 'Completed' && done.replacementAssetId === newAsset.id && !!orig && /Replaced by/.test(orig.history), [c, done && done.status]);
    const dd = await AVP.repairDetail(v, rep.id);
    check('C22 the vendor sees the replacement on the repair', dd.replacements.some((x) => x.status === 'Completed'), dd.replacements);
    // an approved HRMS Replacement ticket opens an approved replacement
    const emp = await prisma.employee.findFirst({ where: { NOT: { userId: null } } });
    const asset3 = await prisma.asset.create({ data: { assetCode: `ZZSC-${T}-3`, name: 'ZZTEST mouse', category: 'Mouse', status: 'Assigned', assignedToId: emp.id, vendorId: v.vendorId, history: '[]' } });
    const rec = await prisma.employeeRecord.create({ data: { type: 'ASSET', employeeId: emp.id, title: 'ZZ', detail: 'Mouse broken', category: 'Replacement', priority: 'Medium', status: 'Approved', notes: '[]' } });
    const tn = new Date().toISOString();
    await DB.run('INSERT INTO "AssetComplaint" ("ticketId","ticketRef","assetId","kind","issue","employeeId","raisedAt","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?)', [rec.id, `ZZT-${T}`, asset3.id, 'Replacement', 'Mouse broken', emp.id, tn, tn, tn]);
    const oc = await AC.onStatusChange(rec, { id: hr.id, name: 'ZZ HR', role: 'HR' });
    rows = await RW.listReplacements({ status: 'Approved' });
    check('C23 an approved HRMS "Replacement" ticket opens an approved replacement', !!oc.replacementId && rows.some((x) => x.originalAssetId === asset3.id && x.ticketRef === `ZZT-${T}`), oc);
    // the vendor's HRMS tickets: its own assets only
    const tk = await RW.vendorTickets(v, await HS.listing(v), await AVP.ensureMask());
    const tkOther = await RW.vendorTickets(other, await HS.listing(other), await AVP.ensureMask());
    check('C24 HRMS tickets: the vendor sees the ticket on its asset, another vendor does not', tk.some((x) => x.ticketRef === `ZZT-${T}`) && !tkOther.some((x) => x.ticketRef === `ZZT-${T}`), [tk.length, tkOther.length]);
    // a replaced invoice file is kept
    m = await my();
    await DB.run('UPDATE "AssetRepairVendor" SET "invoiceFile" = ?, "invoiceName" = ?, "invoiceHash" = ? WHERE "repairId" = ?', [`${'b'.repeat(32)}.pdf`, 'old-invoice.pdf', 'h-old', rep.id]);
    await prisma.$transaction(async (tx) => { await RW.keepEarlierInvoice(tx, rep, v.vendorId, (await AVP.myRepair(v, rep.id)).side, 'ZZ'); });
    const kept = (await RW.proofsOf([rep.id], v.vendorId)).find((p) => p.kind === 'earlier invoice');
    check('C25 a replaced invoice file is kept as "earlier invoice"', !!kept && kept.name === 'old-invoice.pdf');
  } catch (err) {
    fail += 1; console.log('  ERROR', err && err.stack);
  } finally {
    await prisma.$disconnect().catch(() => {});
    for (const f of [copy, `${copy}-wal`, `${copy}-shm`, `${copy}-journal`]) { try { fs.unlinkSync(f); } catch { /* gone */ } }
    console.log(`\nStage C: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
