#!/usr/bin/env node
// ---------------------------------------------------------------------------
// DUPLICATE PUNCHES — find them, and (only when told to) merge them.
//
//   node scripts/attendance-duplicates.js                  DRY RUN (default): a report, writes nothing
//   node scripts/attendance-duplicates.js --db <file>      another database file (a copy, the sandbox...)
//   node scripts/attendance-duplicates.js --apply          back up, then remove the duplicates
//   node scripts/attendance-duplicates.js --undo [--file <manifest>]   put the removed rows back
//   --window <seconds>   how close counts as "the same punch" (default 60)
//   --include-mixed      with --apply, ALSO merge same-minute punches made by different methods
//                        (face + manual + device): the strongest method is kept. Off by default.
//
// WHAT IS A DUPLICATE: the same employee, the same day, the same direction (In / Out), and the
// same method, within --window seconds (punch times are HH:MM, so the same minute; the device
// clock seconds are used when the row has them). Different methods in the same minute are only
// REPORTED unless --include-mixed is given.
//
// WHICH ONE IS KEPT: the strongest proof (device > verified face > GPS/other > typed in by HR),
// then the row that has a live picture, then the earliest created. The others are removed; any
// biometric log line that pointed at a removed row is pointed at the kept one.
//
// NEVER TOUCHED: a day that has an APPROVED regularization (that day was corrected on purpose),
// and punches of different directions or further apart than the window.
//
// REAL DATABASE: --apply on backend/prisma/dev.db needs BOTH --really-real AND the environment
// variable TL_ALLOW_REAL_APPLY=1. Run it on the live data only after the dry run was read.
// The undo manifest is written to backend/backups/attendance-duplicates-<time>.json first.
// ---------------------------------------------------------------------------
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const BACK = path.resolve(__dirname, '..');
const REAL_DB = path.join(BACK, 'prisma', 'dev.db');
const DB = path.resolve(arg('--db') || REAL_DB);
const isReal = DB.toLowerCase() === REAL_DB.toLowerCase();
const WINDOW = Math.max(0, Number(arg('--window')) || 60);
process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}`;
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const BACKUPS = path.join(BACK, 'backups');

const strength = (p) => (p.method === 'Biometric' || p.source === 'Biometric device' ? 3 : p.verificationStatus === 'Verified' ? 2 : p.source === 'Manual entry' ? 0 : 1);
const STRENGTH_WORD = ['typed in by HR', 'other', 'verified face', 'biometric device'];
const secs = (p) => {
  const c = String(p.clockTime || '').match(/^(\d{1,2}):(\d{2}):(\d{2})/);
  if (c) return Number(c[1]) * 3600 + Number(c[2]) * 60 + Number(c[3]);
  const m = String(p.time || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 : 0;
};

// Which of a cluster to keep, and why.
function pickKeeper(rows) {
  const ranked = [...rows].sort((a, b) => strength(b) - strength(a)
    || (b.imageFile ? 1 : 0) - (a.imageFile ? 1 : 0)
    || new Date(a.createdAt) - new Date(b.createdAt));
  const keep = ranked[0];
  const why = [];
  if (rows.some((r) => strength(r) !== strength(keep))) why.push(`strongest method (${STRENGTH_WORD[strength(keep)]})`);
  else if (rows.some((r) => !!r.imageFile !== !!keep.imageFile)) why.push('has the live picture');
  else why.push('earliest recorded');
  return { keep, why: why.join(', ') };
}

async function main() {
  console.log(`Database: ${DB}${isReal ? '  (THE REAL ONE)' : ''}`);
  if (has('--undo')) return undo();

  const [punches, regs, employees] = await Promise.all([
    prisma.attendancePunch.findMany({ orderBy: [{ employeeId: 'asc' }, { date: 'asc' }] }),
    prisma.attendanceRegularization.findMany({ where: { status: 'Approved' }, select: { employeeId: true, date: true } }),
    prisma.employee.findMany({ select: { id: true, name: true, employeeCode: true } }),
  ]);
  const empOf = new Map(employees.map((e) => [e.id, e]));
  const regDays = new Set(regs.map((r) => `${r.employeeId}|${r.date}`));
  console.log(`Punches: ${punches.length}.  Window: ${WINDOW} s.  Mode: ${has('--apply') ? 'APPLY' : 'DRY RUN'}${has('--include-mixed') ? ' (+ mixed methods)' : ''}`);

  // group by employee / day / direction, then cluster by time
  // per employee-day, walk the punches in time order; a run of SAME-direction punches that stay within the window,
  // with no punch of the other direction in between, is one cluster (In, Out, In a minute later is NOT a duplicate)
  const days = new Map();
  punches.forEach((p) => {
    const k = `${p.employeeId}|${p.date}`;
    if (!days.has(k)) days.set(k, []);
    days.get(k).push(p);
  });
  const clusters = [];
  let skippedRegularized = 0;
  days.forEach((rows, k) => {
    if (rows.length < 2) return;
    const [employeeId, date] = k.split('|');
    const sorted = [...rows].sort((x, y) => secs(x) - secs(y) || new Date(x.createdAt) - new Date(y.createdAt));
    let cur = [];
    const flush = () => {
      if (cur.length > 1) {
        const methods = new Set(cur.map((r) => r.method));
        clusters.push({ employeeId, date, direction: cur[0].direction, rows: cur, mixed: methods.size > 1 });
      }
      cur = [];
    };
    sorted.forEach((p) => {
      if (cur.length && (cur[0].direction !== p.direction || secs(p) - secs(cur[cur.length - 1]) > WINDOW)) flush();
      cur.push(p);
    });
    flush();
  });

  const same = clusters.filter((c) => !c.mixed);
  const mixed = clusters.filter((c) => c.mixed);
  const regularized = (c) => regDays.has(`${c.employeeId}|${c.date}`);
  const toApply = [...same, ...(has('--include-mixed') ? mixed : [])].filter((c) => { if (regularized(c)) { skippedRegularized += 1; return false; } return true; });

  const show = (title, list) => {
    console.log(`\n${title}: ${list.length} cluster(s), ${list.reduce((n, c) => n + c.rows.length - 1, 0)} extra row(s)`);
    list.slice(0, 40).forEach((c) => {
      const e = empOf.get(c.employeeId) || {};
      const { keep, why } = pickKeeper(c.rows);
      console.log(`  ${e.employeeCode || '?'} ${e.name || c.employeeId} · ${c.date} · ${c.direction}${regularized(c) ? ' · APPROVED REGULARIZATION - untouched' : ''}`);
      c.rows.forEach((r) => console.log(`     ${r === keep ? 'KEEP  ' : 'remove'} ${r.id} ${r.time}${r.clockTime ? ` (${r.clockTime})` : ''} · ${r.method} · ${r.source || '-'}${r.verificationStatus ? ` · ${r.verificationStatus}` : ''}`));
      console.log(`     keeps ${keep.id}: ${why}`);
    });
    if (list.length > 40) console.log(`  ... and ${list.length - 40} more`);
  };
  show('Same method within the window (exact / near-exact duplicates)', same);
  show('Different methods in the same window (face + manual + device)', mixed);
  const dayCount = new Set(clusters.map((c) => `${c.employeeId}|${c.date}`)).size;
  console.log(`\nSUMMARY: ${same.length} same-method cluster(s), ${mixed.length} mixed-method cluster(s), on ${dayCount} employee-day(s). `
    + `Would remove ${toApply.reduce((n, c) => n + c.rows.length - 1, 0)} row(s) with the current options. Regularized days skipped: ${skippedRegularized}.`);
  const dupAtt = await prisma.$queryRawUnsafe('select count(*) c from (select 1 from Attendance group by employeeId,date having count(*)>1)');
  console.log(`Attendance rows duplicated per employee/day: ${Number(dupAtt[0].c)} (the table has a unique key, so this is always 0).`);

  if (!has('--apply')) { console.log('\nDRY RUN: nothing was changed. Add --apply to remove the rows listed above.'); return; }
  if (isReal && !(has('--really-real') && process.env.TL_ALLOW_REAL_APPLY === '1')) {
    console.log('\nREFUSED: this is the real database. --apply needs --really-real AND TL_ALLOW_REAL_APPLY=1.');
    process.exitCode = 2; return;
  }
  if (!toApply.length) { console.log('\nNothing to remove.'); return; }

  // ---- apply: manifest first, then the changes ----
  const manifest = { db: DB, at: new Date().toISOString(), windowSec: WINDOW, removed: [], logs: [], attendance: [] };
  for (const c of toApply) {
    const { keep } = pickKeeper(c.rows);
    const remove = c.rows.filter((r) => r !== keep);
    const att = await prisma.attendance.findUnique({ where: { employeeId_date: { employeeId: c.employeeId, date: c.date } } });
    remove.forEach((r) => manifest.removed.push(r));
    const logs = await prisma.biometricPunchLog.findMany({ where: { attendancePunchId: { in: remove.map((r) => r.id) } } });
    logs.forEach((l) => manifest.logs.push({ id: l.id, from: l.attendancePunchId, to: keep.id }));
    // The day's own times: only if they pointed at a removed row's minute and not the kept one's.
    if (att) {
      const patch = {};
      if (c.direction === 'In' && att.checkIn && att.checkIn !== keep.time && remove.some((r) => r.time === att.checkIn)) patch.checkIn = keep.time;
      if (c.direction === 'Out' && att.checkOut && att.checkOut !== keep.time && remove.some((r) => r.time === att.checkOut)) patch.checkOut = keep.time;
      if (Object.keys(patch).length) manifest.attendance.push({ id: att.id, before: { checkIn: att.checkIn, checkOut: att.checkOut }, patch });
    }
  }
  fs.mkdirSync(BACKUPS, { recursive: true });
  const file = path.join(BACKUPS, `attendance-duplicates-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
  console.log(`\nUndo manifest written: ${file}`);
  for (const l of manifest.logs) await prisma.biometricPunchLog.update({ where: { id: l.id }, data: { attendancePunchId: l.to } });
  for (const a of manifest.attendance) await prisma.attendance.update({ where: { id: a.id }, data: a.patch });
  const del = await prisma.attendancePunch.deleteMany({ where: { id: { in: manifest.removed.map((r) => r.id) } } });
  console.log(`APPLIED: ${del.count} duplicate punch row(s) removed, ${manifest.logs.length} device log line(s) re-pointed, ${manifest.attendance.length} day time(s) adjusted.`);
  console.log(`Undo with: node scripts/attendance-duplicates.js --undo --file "${file}"${isReal ? ' --db <this database>' : ''}`);
}

async function undo() {
  const files = fs.existsSync(BACKUPS) ? fs.readdirSync(BACKUPS).filter((f) => /^attendance-duplicates-.*\.json$/.test(f)).sort() : [];
  const file = arg('--file') ? path.resolve(arg('--file')) : (files.length ? path.join(BACKUPS, files[files.length - 1]) : null);
  if (!file || !fs.existsSync(file)) { console.log('No manifest found (backend/backups/attendance-duplicates-*.json).'); return; }
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (path.resolve(m.db).toLowerCase() !== DB.toLowerCase()) { console.log(`That manifest belongs to ${m.db}, not this database - refusing.`); return; }
  if (isReal && !(has('--really-real') && process.env.TL_ALLOW_REAL_APPLY === '1')) { console.log('REFUSED: the real database needs --really-real AND TL_ALLOW_REAL_APPLY=1.'); process.exitCode = 2; return; }
  let back = 0;
  for (const r of m.removed) {
    const exists = await prisma.attendancePunch.findUnique({ where: { id: r.id } });
    if (!exists) { await prisma.attendancePunch.create({ data: r }); back += 1; }
  }
  for (const l of m.logs) await prisma.biometricPunchLog.update({ where: { id: l.id }, data: { attendancePunchId: l.from } }).catch(() => {});
  for (const a of m.attendance) await prisma.attendance.update({ where: { id: a.id }, data: a.before }).catch(() => {});
  console.log(`UNDONE from ${path.basename(file)}: ${back} punch row(s) put back, ${m.logs.length} log line(s) re-pointed, ${m.attendance.length} day time(s) restored.`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
