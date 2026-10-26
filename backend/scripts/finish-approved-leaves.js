#!/usr/bin/env node
/* eslint-disable no-console, no-await-in-loop */
// ---------------------------------------------------------------------------
// LEAVES ALREADY GRANTED BUT STILL SHOWING "PENDING" (founder 2026-10-26: "Sravathi Maganapalli ki TL and HR approve echaru leave ki kani
// pending ane vastundhi, ala rakudadhu").
//
// From 2026-10-26 a leave is granted when the TL approves it within the TL leave limit (default 2 days) or when HR approves it; the levels
// above stay in the chain as Visibility (routes/leave.js). Requests decided BEFORE that change still wait on the Super Admin. This script
// finishes those: every Pending leave whose HR step is Approved, or whose TL step is Approved and whose days are within the TL limit.
// It does what the approve button does: the leave becomes Approved (decided by / at = that approver), the waiting levels become Visibility,
// and the balance is drawn down (utils/leaveCharge.js) unless the days were already counted by the PulseHRM import. No message is sent.
//
//   node scripts/finish-approved-leaves.js                                        DRY RUN on prisma/dev.db
//   node scripts/finish-approved-leaves.js --db <copy.db> --apply                 on a copy
//   TL_ALLOW_REAL_APPLY=1 node scripts/finish-approved-leaves.js --apply --really-real
// SAFETY: dry run by default; VACUUM INTO backup first (undo = put it back); only Pending requests are touched; running it twice does nothing.
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
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
if (APPLY && isReal && !(has('--really-real') && process.env.TL_ALLOW_REAL_APPLY === '1')) {
  console.error('REFUSED: this writes to the REAL database. It needs --really-real AND TL_ALLOW_REAL_APPLY=1. Run the dry run first, or --db <copy>.');
  process.exit(2);
}
process.env.DATABASE_URL = `file:${dbArg.split(path.sep).join('/')}`;
process.chdir(BACK);
const prisma = require('../src/db');
const policy = require('../src/utils/leavePolicy');
const leaveCharge = require('../src/utils/leaveCharge');

const PRECOUNTED = 'Leave imported — days already counted in PulseHRM availed';

(async () => {
  try {
    const rule = await policy.getTlRule();
    const pending = await prisma.leaveRequest.findMany({ where: { status: 'Pending' }, include: { employee: { select: { name: true } } } });
    const todo = [];
    for (const lv of pending) {
      const steps = await prisma.approvalStep.findMany({ where: { workflow: 'leave', recordId: lv.id }, orderBy: { seq: 'asc' } });
      const hr = steps.find((s) => s.level === 'HR' && s.status === 'Approved');
      const tl = steps.find((s) => s.level === 'TL' && s.status === 'Approved');
      const days = lv.days != null ? Number(lv.days) : 1;
      const tlGrants = tl && rule.enabled && (rule.mode === 'count' || days <= rule.limit);
      const by = hr || (tlGrants ? tl : null);
      if (by) todo.push({ lv, by, why: hr ? 'HR approved' : `TL approved within the ${rule.limit}-day limit` });
    }
    console.log(`Database: ${dbArg}${isReal ? '  (REAL)' : ''}`);
    console.log(`Pending leave requests: ${pending.length}. Already granted (TL within the limit, or HR) but still Pending: ${todo.length}`);
    todo.forEach((t) => console.log(`  ${t.lv.employee ? t.lv.employee.name : t.lv.employeeId} | ${t.lv.type} ${t.lv.fromDate} to ${t.lv.toDate} (${t.lv.days ?? 1} d) | ${t.why}: ${t.by.actedByName || t.by.approverName || ''}`));
    if (!todo.length || !APPLY) { console.log(todo.length ? '\nDRY RUN: nothing was changed.' : '\nNothing to do.'); return; }

    const bakDir = path.resolve(isReal ? path.join(os.homedir(), '.teamlink-backups', `finish-approved-leaves-${STAMP}`) : path.join(path.dirname(dbArg), `finish-approved-leaves-${STAMP}`));
    fs.mkdirSync(bakDir, { recursive: true });
    const bak = path.join(bakDir, 'before.db');
    await prisma.$executeRawUnsafe(`VACUUM INTO '${bak.split(path.sep).join('/').replace(/'/g, "''")}'`);
    let done = 0;
    for (const t of todo) {
      const fresh = await prisma.leaveRequest.findUnique({ where: { id: t.lv.id } });
      if (!fresh || fresh.status !== 'Pending') continue; // eslint-disable-line no-continue
      await prisma.approvalStep.updateMany({ where: { workflow: 'leave', recordId: fresh.id, status: { in: ['Pending', 'Waiting'] } }, data: { status: 'Visibility', note: `Not needed - ${t.why}. Shown for information.` } });
      const leave = await prisma.leaveRequest.update({ where: { id: fresh.id }, data: { status: 'Approved', decidedAt: t.by.actedAt || new Date(), decidedBy: t.by.actedByName || t.by.approverName || 'Approver' } });
      const preCounted = !!await prisma.auditLog.findFirst({ where: { entity: 'LeaveRequest', entityId: fresh.id, action: PRECOUNTED }, select: { id: true } });
      if (!preCounted) { try { await leaveCharge.onApprove(leave, t.by.actedByUserId || null); } catch (e) { console.log(`  balance not drawn for ${fresh.id}: ${e.message}`); } }
      await prisma.auditLog.create({ data: { action: 'Leave approved', entity: 'LeaveRequest', entityId: fresh.id, fromValue: 'Pending', toValue: 'Approved', reason: `${t.why} - finished by finish-approved-leaves.js (rule of 2026-10-26)`, actorName: 'finish-approved-leaves 2026-10-26' } });
      done += 1;
    }
    console.log(`\nDONE: ${done} leave request(s) are Approved now.\nBackup (the whole database before this): ${bak}\nTo undo: stop TeamLink, copy the backup over the database file (remove its -wal / -shm), start TeamLink.`);
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error('FAILED:', e.message.slice(0, 500)); process.exit(1); });
