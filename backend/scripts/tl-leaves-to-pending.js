#!/usr/bin/env node
/* eslint-disable no-console, no-await-in-loop */
// ---------------------------------------------------------------------------
// TL LEAVES APPROVED WITHOUT THE SUPER ADMIN -> BACK TO PENDING (founder 2026-10-28: "ninna unna leave lo Renuka and Leela Usha villu
// iddaru TLs kani Super Admin approve cheyaledu kabatti vallu pending ane ravali").
//
// From 2026-10-28 a TL's leave is approved ONLY by the Super Admin (utils/leadLeave.js). This script finds every TL leave (TL / STL
// role, or designation TL / Team Lead) that is APPROVED, runs on or after --from (default 2026-10-01), and was approved by someone
// other than a Super Admin (e.g. HR), and puts it back to PENDING with the Super Admin step waiting:
//   * the LeaveRequest becomes Pending (decided by / at cleared - who approved stays in the approval steps and in the audit log);
//   * its approval chain: the Super Admin step becomes Pending ("Final approval - a TL's leave is approved only by the Super Admin
//     (<who> approved before)"); a leave with no chain (imported / old) gets one laid down first;
//   * the balance: days this app's ledger took are given back (the Super Admin's approval takes them again); days the PulseHRM import /
//     an older approval already counted are marked "already counted", so the Super Admin's approval does not take them twice;
//   * one audit row per leave ("TL leave back to Pending - waiting for the Super Admin", from: Approved by <who>).
// Nothing is deleted. Running it twice does nothing (only Approved leaves are picked). Rejected / cancelled leaves are not touched.
//
//   node scripts/tl-leaves-to-pending.js                               DRY RUN on the app's database (.env DATABASE_URL)
//   node scripts/tl-leaves-to-pending.js --db prisma/copy.db --apply   on a copy
//   node scripts/tl-leaves-to-pending.js --apply --really-real         on the app's own database (the VPS push script does this)
//   --from YYYY-MM-DD   first leave date looked at (default 2026-10-01)
// A whole-database backup (VACUUM INTO) is written before anything changes.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const BACK = path.resolve(__dirname, '..');
const dbArg = val('--db');
const APPLY = has('--apply');
const FROM = val('--from', '2026-10-01');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
if (!/^\d{4}-\d{2}-\d{2}$/.test(FROM)) { console.error('--from must be YYYY-MM-DD'); process.exit(2); }
if (APPLY && !dbArg && !has('--really-real')) {
  console.error("REFUSED: --apply on the app's own database needs --really-real. Run the dry run first, or use --db <copy>.");
  process.exit(2);
}
if (dbArg) process.env.DATABASE_URL = `file:${path.resolve(dbArg).split(path.sep).join('/')}`;
process.chdir(BACK);
const prisma = require('../src/db');
const workflow = require('../src/utils/approvalWorkflow');
const leaveCharge = require('../src/utils/leaveCharge');
const lead = require('../src/utils/leadLeave');

const WF = 'leave';
const PRECOUNTED = 'Leave imported — days already counted in PulseHRM availed'; // the marker routes/leave.js reads
const ACTION = 'TL leave back to Pending - waiting for the Super Admin';
const WATCH = ['TL306', 'TL484']; // Renuka.G and D. Leela Usha Sri (founder 2026-10-28)
const norm = (s) => String(s || '').replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase(); // 'Vasudeva Rao Chitturi (Pulse)' = the Super Admin

async function watchList(label) {
  const rows = await prisma.leaveRequest.findMany({
    where: { employee: { is: { employeeCode: { in: WATCH } } }, toDate: { gte: FROM } },
    include: { employee: { select: { employeeCode: true, name: true } } }, orderBy: [{ fromDate: 'asc' }],
  });
  console.log(`\n${label}: leaves of ${WATCH.join(' / ')} from ${FROM}`);
  if (!rows.length) { console.log('  (none in this database)'); return; }
  for (const r of rows) {
    const p = (await workflow.loadSteps(WF, r.id)).filter((s) => s.status === 'Pending').map((s) => `${s.level} ${s.approverName || ''}`.trim()).join(' / ');
    console.log(`  ${r.employee.employeeCode} ${r.employee.name} | ${r.type} ${r.fromDate}${r.toDate !== r.fromDate ? ` to ${r.toDate}` : ''} | ${r.status}${r.decidedBy ? ` (by ${r.decidedBy})` : ''}${p ? ` | waiting for: ${p}` : ''}`);
  }
}

(async () => {
  try {
    console.log(`Database: ${process.env.DATABASE_URL || '(.env DATABASE_URL)'}   ${APPLY ? '*** APPLY ***' : '*** DRY RUN - nothing is written ***'}`);
    const saUsers = await prisma.user.findMany({ where: { role: 'SUPER_ADMIN' }, select: { id: true, name: true } });
    const saIds = new Set(saUsers.map((u) => u.id));
    const saNames = new Set(saUsers.map((u) => norm(u.name)).filter(Boolean));
    const approved = await prisma.leaveRequest.findMany({
      where: { status: 'Approved', toDate: { gte: FROM } },
      include: { employee: { include: { user: { select: { id: true, role: true, hrmsRole: true } } } } },
      orderBy: [{ fromDate: 'asc' }],
    });
    const todo = [];
    for (const lv of approved) {
      if (!lv.employee || !lead.isLeadSync(lv.employee, lv.employee.user)) continue; // eslint-disable-line no-continue
      const steps = await workflow.loadSteps(WF, lv.id);
      const saStep = steps.find((s) => s.level === 'SUPER_ADMIN' && s.status === 'Approved');
      const bySa = steps.length ? !!(saStep && saIds.has(saStep.actedByUserId || saStep.approverUserId)) : saNames.has(norm(lv.decidedBy));
      if (bySa) continue; // eslint-disable-line no-continue
      const lastOk = steps.filter((s) => s.status === 'Approved' && s.level !== 'EMPLOYEE').pop();
      todo.push({ lv, steps, by: lv.decidedBy || (lastOk && (lastOk.actedByName || lastOk.approverName)) || 'someone (not recorded)', source: steps.length ? 'approval chain' : 'no chain (imported / old)' });
    }
    await watchList('BEFORE');
    console.log(`\nTL leaves Approved from ${FROM} without the Super Admin: ${todo.length}`);
    todo.forEach((t) => console.log(`  ${t.lv.employee.employeeCode} ${t.lv.employee.name} | ${t.lv.type} ${t.lv.fromDate}${t.lv.toDate !== t.lv.fromDate ? ` to ${t.lv.toDate}` : ''} (${t.lv.days ?? 1} d) | approved by ${t.by} | ${t.source}`));
    if (!todo.length || !APPLY) { console.log(todo.length ? '\nDRY RUN: nothing was changed. Add --apply to put these back to Pending.' : '\nNothing to do.'); return; }

    const target = dbArg ? path.resolve(dbArg) : null;
    const bakDir = target ? path.join(path.dirname(target), `tl-leaves-to-pending-${STAMP}`) : path.join(os.homedir(), '.teamlink-backups', `tl-leaves-to-pending-${STAMP}`);
    fs.mkdirSync(bakDir, { recursive: true });
    const bak = path.join(bakDir, 'before.db');
    await prisma.$executeRawUnsafe(`VACUUM INTO '${bak.split(path.sep).join('/').replace(/'/g, "''")}'`);

    let done = 0;
    for (const t of todo) {
      const fresh = await prisma.leaveRequest.findUnique({ where: { id: t.lv.id }, include: { employee: true } });
      if (!fresh || fresh.status !== 'Approved') continue; // eslint-disable-line no-continue
      // the balance: what the ledger took goes back; days counted elsewhere are marked so the Super Admin's approval does not take them twice
      let balance;
      const charged = await leaveCharge.lastCharge(fresh.id);
      if (charged != null) { await leaveCharge.onCancel(fresh, null); balance = `${charged} day(s) given back until the Super Admin approves`; } else {
        const marked = await prisma.auditLog.findFirst({ where: { entity: 'LeaveRequest', entityId: fresh.id, action: PRECOUNTED }, select: { id: true } });
        if (!marked) await prisma.auditLog.create({ data: { action: PRECOUNTED, entity: 'LeaveRequest', entityId: fresh.id, actorName: 'tl-leaves-to-pending 2026-10-28', reason: 'Approved before the TL rule; its days are already counted in the balance' } });
        balance = 'days already counted in the balance (not taken twice)';
      }
      await prisma.leaveRequest.update({ where: { id: fresh.id }, data: { status: 'Pending', decidedAt: null, decidedBy: null } });
      if (!t.steps.length) {
        await workflow.start({ workflow: WF, recordId: fresh.id, employee: fresh.employee, applicantUserId: fresh.employee.userId || null, applicantName: fresh.employee.name });
      }
      const sa = await lead.sendToSuperAdmin(WF, fresh.id, { by: t.by });
      await prisma.auditLog.create({
        data: {
          action: ACTION, entity: 'LeaveRequest', entityId: fresh.id, fromValue: `Approved (by ${t.by})`, toValue: `Pending (Super Admin${sa && sa.approverName ? ` ${sa.approverName}` : ''})`,
          actorName: 'tl-leaves-to-pending 2026-10-28', reason: `A TL's leave is approved only by the Super Admin (founder 2026-10-28). Balance: ${balance}.`,
        },
      });
      done += 1;
    }
    await watchList('AFTER');
    console.log(`\nDONE: ${done} TL leave(s) are Pending now, waiting for the Super Admin.\nBackup (the whole database before this): ${bak}\nTo undo: stop TeamLink, copy the backup over the database file (remove its -wal / -shm), start TeamLink.`);
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error('FAILED:', e.message.slice(0, 500)); process.exit(1); });
