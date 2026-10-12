#!/usr/bin/env node
// ---------------------------------------------------------------------------
// SATURDAY IS A WORKING DAY (user, 2026-10-09). Week off = Sunday only (plus
// company holidays). This script finds and fixes the STORED data that still
// treats Saturday as a day off.
//
//   node scripts/saturday-working-day.js            DRY RUN on the real dev.db: shows what would change
//   node scripts/saturday-working-day.js --apply    write it (backs the old values up first)
//   node scripts/saturday-working-day.js --undo     put the backed-up old values back
//   --db <file>   another database file (e.g. prisma/sandbox.db)
//
// WHAT IT CHANGES (and nothing else):
//   1. HrConfig.weeklyOffDays      "0,6" -> "0"   (only if 6 is still in it)
//   2. LeaveRequest.days           multi-day leave whose day count skipped the Saturdays
//                                  AND the Sundays (days = span - Saturdays - Sundays)
//                                  -> days = span - Sundays.  Half-day rows are never touched.
//                                  Leave BALANCES (LeaveBalance.taken) are NOT touched:
//                                  the balance change for each person is only REPORTED.
//
// WHAT IT ONLY REPORTS (never rewrites):
//   - Attendance rows that carry a Saturday week-off marker (status Weekly Off / Week Off)
//   - Company holidays that fall on a Saturday (they stay holidays - that is a company decision)
//   - Imported payroll runs / payslips (Sep 2025 - Sep 2026): their stored working days
//     are NOT recomputed; the months whose stored figure disagrees with Monday-Saturday
//     are listed so the user can decide
//   - Imported old-HRMS summaries (their week-off counts are kept as exported)
// The backup is a small JSON file in backend/backups/ (saturday-working-day-<time>.json).
// ---------------------------------------------------------------------------
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const BACK = path.resolve(__dirname, '..');
const DB = path.resolve(arg('--db') || path.join(BACK, 'prisma', 'dev.db'));
process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}`;
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const BACKUPS = path.join(BACK, 'backups');
const dow = (d) => new Date(`${String(d).slice(0, 10)}T00:00:00Z`).getUTCDay();
const DAY = 864e5;

// Count the Saturdays / Sundays of from..to.
function weekdaysIn(from, to) {
  let sat = 0; let sun = 0; let span = 0;
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY) {
    span += 1;
    const w = new Date(t).getUTCDay();
    if (w === 6) sat += 1;
    if (w === 0) sun += 1;
  }
  return { span, sat, sun };
}

async function main() {
  console.log(`Database: ${DB}`);
  const cfg = await prisma.hrConfig.findFirst();

  if (has('--undo')) {
    const files = fs.existsSync(BACKUPS) ? fs.readdirSync(BACKUPS).filter((f) => /^saturday-working-day-.*\.json$/.test(f)).sort() : [];
    const file = arg('--file') ? path.resolve(arg('--file')) : (files.length ? path.join(BACKUPS, files[files.length - 1]) : null);
    if (!file || !fs.existsSync(file)) { console.log('No backup file found (backend/backups/saturday-working-day-*.json).'); return; }
    const b = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (path.resolve(b.db) !== DB) { console.log(`That backup belongs to ${b.db}, not this database - refusing.`); return; }
    if (cfg && b.weeklyOffDays != null) await prisma.hrConfig.update({ where: { id: cfg.id }, data: { weeklyOffDays: b.weeklyOffDays } });
    for (const l of b.leaves || []) await prisma.leaveRequest.update({ where: { id: l.id }, data: { days: l.days } }).catch(() => {});
    console.log(`UNDONE from ${path.basename(file)}: weeklyOffDays -> ${b.weeklyOffDays}, ${(b.leaves || []).length} leave row(s) put back.`);
    return;
  }

  // ---- 1. the week-off setting ----
  const offs = cfg ? String(cfg.weeklyOffDays ?? '0,6').split(',').map((x) => x.trim()).filter(Boolean) : [];
  const newOffs = offs.filter((x) => x !== '6').join(',') || '0';
  console.log('\n1. HrConfig.weeklyOffDays');
  console.log(`   ${cfg ? cfg.weeklyOffDays : '(no HrConfig row)'} -> ${newOffs}${cfg && cfg.weeklyOffDays === newOffs ? '   (already Sunday only)' : ''}`);

  // ---- 2. leave rows that skipped Saturdays ----
  const leaves = await prisma.leaveRequest.findMany({ include: { employee: { select: { employeeCode: true, name: true } } }, orderBy: { fromDate: 'asc' } });
  const fix = []; const other = [];
  leaves.forEach((l) => {
    if (l.days === 0.5) return;
    const f = String(l.fromDate).slice(0, 10); const t = String(l.toDate).slice(0, 10);
    const { span, sat, sun } = weekdaysIn(f, t);
    if (!sat) return;
    if (l.days === span - sun - sat) fix.push({ l, f, t, span, sat, sun, to: span - sun });
    else if (l.days !== span && l.days !== span - sun) other.push({ l, f, t, span, sat, sun });
  });
  console.log(`\n2. Leave rows that skipped the Saturdays (days = span - Saturdays - Sundays): ${fix.length}`);
  const balance = new Map();
  fix.forEach(({ l, f, t, span, sat, sun, to }) => {
    console.log(`   ${l.employee.employeeCode} ${l.employee.name} | ${l.type} | ${f} -> ${t} | ${l.status} | days ${l.days} -> ${to}  (span ${span}, ${sat} Saturday, ${sun} Sunday)`);
    if (l.status === 'Approved') { const k = `${l.employee.employeeCode} ${l.type}`; balance.set(k, (balance.get(k) || 0) + (to - l.days)); }
  });
  if (balance.size) console.log(`   Leave balance effect (REPORT ONLY - LeaveBalance.taken is not touched): ${[...balance.entries()].map(([k, v]) => `${k} +${v}`).join(', ')}`);
  console.log(`   Other leave rows with a Saturday whose day count follows neither rule (left as they are, listed for you): ${other.length}`);
  other.forEach(({ l, f, t, span, sat, sun }) => console.log(`     ${l.employee.employeeCode} | ${f} -> ${t} | ${l.status} | days ${l.days} (span ${span}, ${sat} Saturday, ${sun} Sunday)`));

  // ---- report only ----
  const att = await prisma.attendance.findMany({ select: { date: true, status: true } });
  const offMarks = att.filter((a) => dow(a.date) === 6 && /week.?off|holiday/i.test(a.status || ''));
  const byStatusSat = {};
  att.filter((a) => dow(a.date) === 6).forEach((a) => { byStatusSat[a.status] = (byStatusSat[a.status] || 0) + 1; });
  console.log(`\n3. (report) Attendance rows on a Saturday carrying a week-off / holiday marker: ${offMarks.length}.  All Saturday rows by status: ${JSON.stringify(byStatusSat)}`);
  const hol = await prisma.holiday.findMany({ select: { date: true, name: true } });
  const satHol = hol.filter((h) => dow(h.date) === 6);
  console.log(`4. (report) Company holidays on a Saturday (they stay holidays): ${satHol.length}${satHol.length ? ` - ${satHol.map((h) => `${String(h.date).slice(0, 10)} ${h.name}`).join('; ')}` : ''}`);
  const runs = await prisma.employeePayrollRun.groupBy({ by: ['month'], _count: { _all: true }, _min: { workingDays: true }, _max: { workingDays: true } });
  console.log('5. (report) Imported payroll runs - stored working days vs Monday-Saturday (NOT recomputed):');
  runs.sort((a, b) => a.month.localeCompare(b.month)).forEach((r) => {
    const [y, m] = r.month.split('-').map(Number);
    const dim = new Date(y, m, 0).getDate(); let sun = 0;
    for (let d = 1; d <= dim; d += 1) if (new Date(y, m - 1, d).getDay() === 0) sun += 1;
    const monSat = dim - sun;
    const same = r._min.workingDays === monSat && r._max.workingDays === monSat;
    console.log(`   ${r.month}: ${r._count._all} people, stored working days ${r._min.workingDays}${r._min.workingDays === r._max.workingDays ? '' : `-${r._max.workingDays}`} | calendar days ${dim} | Monday-Saturday ${monSat}${same ? '' : '   <- differs'}`);
  });

  if (!fix.length && cfg && cfg.weeklyOffDays === newOffs) { console.log('\nNothing to change.'); return; }
  if (!has('--apply')) { console.log('\nDRY RUN - nothing was written. Add --apply to write it (--undo restores the old values).'); return; }

  fs.mkdirSync(BACKUPS, { recursive: true });
  const file = path.join(BACKUPS, `saturday-working-day-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify({
    db: DB, at: new Date().toISOString(), weeklyOffDays: cfg ? cfg.weeklyOffDays : null,
    leaves: fix.map(({ l }) => ({ id: l.id, days: l.days })),
  }, null, 2));
  if (cfg && cfg.weeklyOffDays !== newOffs) {
    await prisma.hrConfig.update({ where: { id: cfg.id }, data: { weeklyOffDays: newOffs } });
    await prisma.auditLog.create({ data: { action: 'Week off changed', entity: 'HrConfig', entityId: cfg.id, field: 'weeklyOffDays', fromValue: cfg.weeklyOffDays, toValue: newOffs, reason: 'Saturday is a working day (scripts/saturday-working-day.js)' } }).catch(() => {});
  }
  for (const { l, to } of fix) {
    await prisma.leaveRequest.update({ where: { id: l.id }, data: { days: to } });
    await prisma.auditLog.create({ data: { action: 'Leave days corrected', entity: 'LeaveRequest', entityId: l.id, field: 'days', fromValue: String(l.days), toValue: String(to), reason: 'Saturday is a working day (scripts/saturday-working-day.js)' } }).catch(() => {});
  }
  console.log(`\nAPPLIED. Backup: ${file}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
