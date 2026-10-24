#!/usr/bin/env node
/* eslint-disable no-console */
// ---------------------------------------------------------------------------
// LEAVE: DUPLICATES AND STALE PENDING (HRMS item 8, 2026-10-13)
//
//   node scripts/leave-duplicates-and-stale-pending.js                  DRY RUN: writes NOTHING, prints the lists
//   node scripts/leave-duplicates-and-stale-pending.js --csv out.csv    dry run + the lists as a CSV
//   node scripts/leave-duplicates-and-stale-pending.js --apply          backup first, then the clean-up below
//   node scripts/leave-duplicates-and-stale-pending.js --undo <file>    put every request back as it was
//   --db <sqlite file>   another database (a scratch copy / the sandbox). Default: .env DATABASE_URL.
//
// WHAT IT LISTS (always)
//   * PENDING requests of people who have LEFT (Exited / Relieved / Terminated / Inactive), with names and dates
//   * EXACT DUPLICATES (same person, type, from, to) and overlapping same-type live requests
//   * OLD pending (dates older than the stale-days setting, default 60) of people still working
//   * every Pending by employee status
// WHAT --apply DOES (and nothing more)
//   * leavers' Pending  -> Rejected, "Closed as stale: employee has left"   (the chain steps are closed)
//   * Pending duplicates of a request that is Approved, or Pending and further along -> Cancelled "Duplicate of <id>"
//     (the one with the furthest approval is kept)
//   * Old pending of ACTIVE people is NOT touched here: HR decides each one in Leave -> Pulse sync -> Old pending.
//   * An Approved duplicate is only listed (its balance days need a person to look).
//   Nothing is deleted. One audit row per change. No notification is sent.
//
// SAFETY: --apply / --undo on the REAL database need BOTH --really-real AND TL_ALLOW_REAL_APPLY=1. A full
// backup is made first (utils/backup.js) and an undo file is written next to it. Test rows (ZZTEST / example.test)
// are never touched.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const BACKEND = path.resolve(__dirname, '..');
process.chdir(BACKEND);
require('dotenv').config({ path: path.join(BACKEND, '.env') });

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const dbArg = opt('--db');
if (dbArg) process.env.DATABASE_URL = `file:${path.resolve(dbArg).replace(/\\/g, '/')}`;
const REAL_DB = path.resolve(BACKEND, 'prisma', 'dev.db').toLowerCase();
function dbFileNow() {
  const url = String(process.env.DATABASE_URL || 'file:./dev.db').trim().replace(/^["']|["']$/g, '').replace(/^file:/, '').replace(/[?#].*$/, '');
  return path.isAbsolute(url) ? path.resolve(url) : path.resolve(BACKEND, 'prisma', url);
}
const isRealDb = () => dbFileNow().toLowerCase() === REAL_DB;
function guardReal(what) {
  if (!isRealDb()) return;
  if (!has('--really-real')) throw new Error(`This is the REAL database. ${what} needs --really-real (run the dry run first and get the lists approved).`);
  if (process.env.TL_ALLOW_REAL_APPLY !== '1') throw new Error(`This is the REAL database. ${what} also needs the environment variable TL_ALLOW_REAL_APPLY=1.`);
}

// eslint-disable-next-line import/order
const prisma = require('../src/db');
const genuine = require('../src/utils/leaveGenuine');

const TEST_ROW = /zztest|example\.test/i;
const d10 = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d || '').slice(0, 10));

async function analyse() {
  const b = await genuine.pendingBuckets();
  const rows = b.all.filter((r) => !TEST_ROW.test(`${r.employee.name} ${r.employee.employeeCode}`));
  const byStatus = {};
  rows.forEach((r) => { byStatus[r.employee.employmentStatus] = (byStatus[r.employee.employmentStatus] || 0) + 1; });
  const kind = (r) => b.reasonOf.get(r.id) || 'genuine';
  const leavers = rows.filter((r) => kind(r) === 'leaver');
  const dupPending = rows.filter((r) => kind(r) === 'duplicate');
  const old = rows.filter((r) => kind(r) === 'old');
  const genuineRows = rows.filter((r) => kind(r) === 'genuine');
  // exact duplicates among ALL live requests
  const live = await prisma.leaveRequest.findMany({ where: { status: { in: ['Pending', 'Approved', 'Cancellation Requested'] } }, include: { employee: { select: { name: true, employeeCode: true, employmentStatus: true } } }, orderBy: { createdAt: 'asc' } });
  const groups = new Map();
  live.filter((r) => !TEST_ROW.test(`${r.employee.name} ${r.employee.employeeCode}`)).forEach((r) => {
    const k = `${r.employeeId}|${r.type}|${d10(r.fromDate)}|${d10(r.toDate)}|${require('../src/utils/leaveText').halfOf(r) || ''}`; // opposite half days of one date are not duplicates
    groups.set(k, [...(groups.get(k) || []), r]);
  });
  const exact = [...groups.values()].filter((g) => g.length > 1);
  const approvedExtras = exact.filter((g) => g.filter((x) => x.status !== 'Pending').length > 1);
  return { staleDays: await genuine.getStaleDays(), total: rows.length, byStatus, leavers, dupPending, old, genuineRows, exact, approvedExtras, b };
}

const line = (r) => `${(r.employee.employeeCode || '').padEnd(8)} ${(r.employee.name || '').slice(0, 26).padEnd(27)} ${r.type.padEnd(14)} ${d10(r.fromDate)}${d10(r.toDate) !== d10(r.fromDate) ? ` to ${d10(r.toDate)}` : ''}  (${r.employee.employmentStatus}, applied ${d10(r.createdAt)})`;

function report(a) {
  console.log(`\nPENDING leave requests: ${a.total}   (database: ${dbFileNow()}${isRealDb() ? '  = THE REAL ONE' : ''})`);
  console.log('  by employee status:', JSON.stringify(a.byStatus));
  console.log(`  genuine pending (counted in Pending Approvals): ${a.genuineRows.length}`);
  console.log(`  of people who have LEFT: ${a.leavers.length}   | duplicates of another request: ${a.dupPending.length}   | old (dates older than ${a.staleDays} days, people still working): ${a.old.length}`);
  console.log(`\n--- Pending of people who have left (${a.leavers.length}) ---`); a.leavers.forEach((r) => console.log('  ' + line(r)));
  console.log(`\n--- Pending duplicates of another live request (${a.dupPending.length}) ---`); a.dupPending.forEach((r) => console.log('  ' + line(r)));
  console.log(`\n--- Old pending, person still working (${a.old.length}): HR decides each one in the app ---`); a.old.forEach((r) => console.log('  ' + line(r)));
  console.log(`\n--- Exact duplicate groups (same person, type, from, to): ${a.exact.length} group(s), ${a.exact.reduce((n, g) => n + g.length, 0)} request(s) ---`);
  a.exact.forEach((g) => console.log('  ' + g.map((x) => `${x.id.slice(-6)}:${x.status}`).join('  ') + `   ${g[0].employee.employeeCode} ${g[0].employee.name} ${g[0].type} ${d10(g[0].fromDate)}`));
  if (a.approvedExtras.length) console.log(`  ${a.approvedExtras.length} group(s) have more than one APPROVED request: listed only, a person must look at the balance.`);
}

function writeCsv(a, file) {
  const esc = (v) => `"${String(v === null || v === undefined ? '' : v).replace(/"/g, '""')}"`;
  const out = [['Group', 'Employee ID', 'Name', 'Employee status', 'Type', 'From', 'To', 'Status', 'Applied', 'Request id'].map(esc).join(',')];
  const add = (g, rs) => rs.forEach((r) => out.push([g, r.employee.employeeCode, r.employee.name, r.employee.employmentStatus, r.type, d10(r.fromDate), d10(r.toDate), r.status, d10(r.createdAt), r.id].map(esc).join(',')));
  add('Left', a.leavers); add('Duplicate pending', a.dupPending); add('Old pending', a.old); a.exact.forEach((g) => add('Exact duplicate', g));
  fs.writeFileSync(file, `﻿${out.join('\r\n')}\r\n`);
  console.log(`CSV written: ${file}`);
}

async function closeSteps(tx, id, decision, note) {
  const steps = await tx.approvalStep.findMany({ where: { workflow: 'leave', recordId: id, status: { in: ['Pending', 'Waiting', 'Visibility'] } } });
  const before = steps.map((s) => ({ id: s.id, status: s.status, actedAt: s.actedAt, actedByName: s.actedByName, note: s.note }));
  for (const s of steps) {
    // eslint-disable-next-line no-await-in-loop
    await tx.approvalStep.update({ where: { id: s.id }, data: { status: s.status === 'Pending' ? decision : 'Skipped', actedAt: new Date(), actedByName: 'System (clean-up)', note } });
  }
  return before;
}

async function applyRun(a) {
  guardReal('--apply');
  // --no-backup is allowed ONLY for a scratch copy (never the real database): no backup is made and the undo file sits beside the copy.
  const scratch = has('--no-backup') && !isRealDb();
  const backup = scratch ? null : require('../src/utils/backup'); // eslint-disable-line global-require
  const b = scratch ? { name: '(scratch copy, no backup)' } : await backup.makeBackup({ reason: 'before closing leavers\' pending leave and duplicate pending leave', by: 'leave-duplicates-and-stale-pending.js', log: (m) => console.log(`[backup] ${m}`) });
  const undo = { at: new Date().toISOString(), db: dbFileNow(), backup: b.name, rows: [] };
  const todo = [
    ...a.leavers.map((r) => ({ r, status: 'Rejected', why: 'Closed as stale: employee has left' })),
    ...a.dupPending.map((r) => ({ r, status: 'Cancelled', why: 'Duplicate of another leave request' })),
  ];
  await prisma.$transaction(async (tx) => {
    for (const { r, status, why } of todo) {
      const cur = await tx.leaveRequest.findUnique({ where: { id: r.id } });
      if (!cur || cur.status !== 'Pending') continue; // eslint-disable-line no-continue
      const stepsBefore = await closeSteps(tx, r.id, status === 'Rejected' ? 'Rejected' : 'Skipped', why);
      await tx.leaveRequest.update({ where: { id: r.id }, data: { status, decidedAt: new Date(), decidedBy: 'System (clean-up)', ...(status === 'Rejected' ? { rejectReason: why } : {}) } });
      await tx.auditLog.create({ data: { action: status === 'Rejected' ? 'Pending leave closed (employee left)' : 'Pending leave cancelled (duplicate)', entity: 'LeaveRequest', entityId: r.id, fromValue: 'Pending', toValue: status, reason: why, actorName: 'System' } });
      undo.rows.push({ id: r.id, before: { status: cur.status, decidedAt: cur.decidedAt, decidedBy: cur.decidedBy, rejectReason: cur.rejectReason, approvalReason: cur.approvalReason }, stepsBefore });
    }
  }, { timeout: 120000 });
  const file = path.join(scratch ? path.dirname(dbFileNow()) : backup.backupRoot(), `leave-cleanup-undo-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(undo));
  console.log(`Closed ${undo.rows.length} request(s) (${a.leavers.length} leavers, ${a.dupPending.length} duplicates considered).`);
  console.log(`To put them back:  node scripts/leave-duplicates-and-stale-pending.js --undo "${file}"${isRealDb() ? ' --really-real  (with TL_ALLOW_REAL_APPLY=1)' : ''}`);
}

async function undoRun(file) {
  guardReal('--undo');
  const undo = JSON.parse(fs.readFileSync(file, 'utf8'));
  let n = 0;
  await prisma.$transaction(async (tx) => {
    for (const r of undo.rows) {
      await tx.leaveRequest.update({ where: { id: r.id }, data: { status: r.before.status, decidedAt: r.before.decidedAt, decidedBy: r.before.decidedBy, rejectReason: r.before.rejectReason, approvalReason: r.before.approvalReason } });
      for (const s of r.stepsBefore) await tx.approvalStep.update({ where: { id: s.id }, data: { status: s.status, actedAt: s.actedAt, actedByName: s.actedByName, note: s.note } });
      await tx.auditLog.create({ data: { action: 'Leave clean-up undone', entity: 'LeaveRequest', entityId: r.id, reason: 'Bulk undo', actorName: 'System' } });
      n += 1;
    }
  }, { timeout: 120000 });
  console.log(`Restored ${n} request(s).`);
}

(async () => {
  try {
    if (opt('--undo')) { await undoRun(opt('--undo')); return; }
    const a = await analyse();
    report(a);
    if (opt('--csv')) writeCsv(a, path.resolve(opt('--csv')));
    if (has('--apply')) await applyRun(a); else console.log('\nDRY RUN: nothing was changed. Add --apply (with --really-real and TL_ALLOW_REAL_APPLY=1 on the real database) to close the leavers\' pending and the duplicates.');
  } catch (e) { console.error('FAILED:', e.message); process.exitCode = 1; } finally { await prisma.$disconnect(); }
})();
