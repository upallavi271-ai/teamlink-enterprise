#!/usr/bin/env node
/* eslint-disable no-console */
// ---------------------------------------------------------------------------
// FREE THE SEATS OF PEOPLE WHO HAVE LEFT (user, 2026-10-10)
//
//   node scripts/free-exited-seats.js                 DRY RUN: writes NOTHING, prints the table
//   node scripts/free-exited-seats.js --md plan.md    dry run + a readable file
//   node scripts/free-exited-seats.js --apply         backup first, then end the tenures + audit rows
//   node scripts/free-exited-seats.js --undo <file>   re-open every tenure that run ended
//
//   --db <sqlite file>   another database (a scratch copy / the sandbox). Default: .env DATABASE_URL.
//
// WHAT IT DOES: every employee who is Exited / Relieved / Exit Process / Terminated
// but STILL holds an open seat (PositionAssignment.toDate = null) has that tenure
// ENDED, so the seat is vacant and a new person can take it. A person on Notice
// Period whose last working day is already behind us is ended on that day; a
// Notice Period person with no last working day (or one still ahead) KEEPS the seat.
//
// THE END DATE IS EVIDENCE, never "today": the last working day on the resignation,
// else the day the status was changed (audit trail), else their last day marked present,
// else the day their record last changed - and it is never before the tenure began.
// Each row prints which evidence it used.
//
// SAFETY: --apply on the REAL database needs BOTH --really-real AND the environment
// variable TL_ALLOW_REAL_APPLY=1. It makes a full backup first (utils/backup.js), writes in
// ONE transaction, one audit row per seat, and saves an undo file next to the backup.
// Test rows (ZZTEST / example.test) are never touched. Nothing is deleted.
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
  if (!has('--really-real')) throw new Error(`This is the REAL database. ${what} needs --really-real (run the dry run first and get the table approved).`);
  if (process.env.TL_ALLOW_REAL_APPLY !== '1') throw new Error(`This is the REAL database. ${what} also needs the environment variable TL_ALLOW_REAL_APPLY=1.`);
}

// eslint-disable-next-line import/order
const prisma = require('../src/db');
const { hasLeft, today } = require('../src/utils/positions');
const seat = require('../src/utils/seatRelease');

const TEST_ROW = /zztest|example\.test/i;

async function plan() {
  const open = await prisma.positionAssignment.findMany({
    where: { toDate: null },
    include: {
      position: { select: { id: true, code: true, department: true } },
      employee: { select: { id: true, name: true, employeeCode: true, employmentStatus: true, updatedAt: true, userId: true } },
    },
    orderBy: [{ fromDate: 'asc' }],
  });
  const rows = [];
  for (const a of open) {
    const e = a.employee;
    if (!e || TEST_ROW.test(`${e.name} ${e.employeeCode}`)) continue;
    const status = e.employmentStatus;
    const base = {
      assignmentId: a.id, positionId: a.position.id, seat: a.position.code, department: a.position.department,
      employeeId: e.id, employee: e.name, code: e.employeeCode, status, from: a.fromDate, note: a.note || null, hasLogin: !!e.userId,
    };
    if (hasLeft(status)) {
      // eslint-disable-next-line no-await-in-loop
      const end = await seat.endDateFor(e, a, { live: false });
      rows.push({ ...base, action: 'END', end: end.date, evidence: end.source, reason: 'Exited' });
    } else if (seat.isNotice(status)) {
      // eslint-disable-next-line no-await-in-loop
      const lwd = await seat.lastWorkingDayOf(e.id);
      if (lwd && lwd.date < today()) rows.push({ ...base, action: 'END', end: lwd.date < a.fromDate ? a.fromDate : lwd.date, evidence: lwd.source, reason: 'Notice ended' });
      else rows.push({ ...base, action: 'KEEP', end: null, evidence: lwd ? `notice until ${lwd.date}` : 'on notice - NO last working day on record, so the seat stays until HR sets one' });
    }
  }
  return { rows, openTotal: open.length };
}

function table(p) {
  const L = [];
  L.push('| Employee | Status | Seat | Held since | Would end on | Evidence | Action |');
  L.push('|---|---|---|---|---|---|---|');
  p.rows.forEach((r) => {
    L.push(`| ${r.employee} (${r.code}) | ${r.status} | ${r.seat} | ${r.from} | ${r.end || '-'} | ${r.evidence} | ${r.action === 'END' ? 'END tenure' : 'KEEP'} |`);
  });
  const ends = p.rows.filter((r) => r.action === 'END');
  L.push('');
  L.push(`Open seat tenures in the database: ${p.openTotal}. WOULD END: ${ends.length}. KEPT (on notice): ${p.rows.length - ends.length}. `
    + `Everyone else holding a seat is still working here and is not touched.`);
  return L.join('\n');
}

async function apply(p) {
  guardReal('--apply');
  const ends = p.rows.filter((r) => r.action === 'END');
  if (!ends.length) { console.log('Nothing to do.'); return; }
  // eslint-disable-next-line global-require
  const backup = require('../src/utils/backup');
  const b = await backup.makeBackup({ reason: 'before freeing the seats of people who left', by: 'free-exited-seats.js', log: (m) => console.log(`[backup] ${m}`) });
  console.log(`Backup made: ${b.name}`);
  const undo = { at: new Date().toISOString(), db: dbFileNow(), backup: b.name, rows: [] };
  await prisma.$transaction(async (tx) => {
    for (const r of ends) {
      const note = `${r.reason} - now ${r.status}. Seat freed ${r.end}, from ${r.evidence}.${r.note ? ` ${r.note}` : ''}`.slice(0, 500);
      // eslint-disable-next-line no-await-in-loop
      const done = await tx.positionAssignment.updateMany({ where: { id: r.assignmentId, toDate: null }, data: { toDate: r.end, note } });
      if (!done.count) continue;
      undo.rows.push({ id: r.assignmentId, toDate: r.end, note, previousNote: r.note });
      // eslint-disable-next-line no-await-in-loop
      await tx.auditLog.createMany({
        data: [
          { action: `Seat ${r.seat} is vacant - ${r.employee} is ${r.status}`, entity: 'Position', entityId: r.positionId, fromValue: r.employee, toValue: `vacant from ${r.end}`, reason: r.evidence, actorName: 'System (free-exited-seats.js)' },
          { action: `Seat ${r.seat} ended - ${r.status}`, entity: 'Employee', entityId: r.employeeId, field: 'position', fieldLabel: 'Position', fromValue: r.seat, toValue: `(none) from ${r.end}`, reason: r.evidence, actorName: 'System (free-exited-seats.js)' },
        ],
      });
    }
  }, { timeout: 120000, maxWait: 30000 });
  const file = path.join(backup.backupRoot(), `free-seats-undo-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(undo));
  console.log(`Ended ${undo.rows.length} seat tenure(s).`);
  console.log(`To put them back:  node scripts/free-exited-seats.js --undo "${file}"${isRealDb() ? ' --really-real  (with TL_ALLOW_REAL_APPLY=1)' : ''}`);
}

async function undoRun(file) {
  guardReal('--undo');
  const u = JSON.parse(fs.readFileSync(file, 'utf8'));
  let n = 0;
  await prisma.$transaction(async (tx) => {
    for (const r of u.rows) {
      // eslint-disable-next-line no-await-in-loop
      const c = await tx.positionAssignment.updateMany({ where: { id: r.id, toDate: r.toDate }, data: { toDate: null, note: r.previousNote || null } });
      n += c.count;
      if (c.count) {
        // eslint-disable-next-line no-await-in-loop
        await tx.auditLog.create({ data: { action: 'Seat tenure re-opened (undo of free-exited-seats.js)', entity: 'PositionAssignment', entityId: r.id, reason: 'Bulk undo', actorName: 'System' } });
      }
    }
  }, { timeout: 120000, maxWait: 30000 });
  console.log(`Undone: ${n} tenure(s) are open again (only those still ending on the date this run set).`);
}

(async () => {
  console.log(`Database: ${dbFileNow()}${isRealDb() ? '  (REAL)' : ''}`);
  if (opt('--undo')) { await undoRun(opt('--undo')); return; }
  const p = await plan();
  console.log(table(p));
  if (opt('--md')) { fs.writeFileSync(opt('--md'), table(p)); console.log(`Wrote ${opt('--md')}`); }
  if (has('--apply')) await apply(p);
  else console.log('\nDRY RUN - nothing was written. Add --apply to end these tenures (backup + undo file are made first).');
})().catch((e) => { console.error(e.message || e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
