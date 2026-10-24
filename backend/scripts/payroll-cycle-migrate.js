#!/usr/bin/env node
// ---------------------------------------------------------------------------
// PAYROLL CYCLE (16th to 15th, named after the month it ends in) - REAL DATA
// SCRIPT (user, 2026-10-12). Dry run by default; it never rewrites a paid / posted
// payroll or an issued payslip, and it never deletes anything.
//
//   node scripts/payroll-cycle-migrate.js --db <copy.db>                  DRY RUN: the report only
//   node scripts/payroll-cycle-migrate.js --db <copy.db> --apply          write the two settings (backs up the old values first)
//   node scripts/payroll-cycle-migrate.js --db <copy.db> --undo           put the old settings back
//   --start-day 16          cycle start day                      (default 16)
//   --effective-from 2026-09  first payroll month on the cycle   (default 2026-09)
//   --first-from 2026-10-01  the first period starts on this date (only when some of its days were already paid)
//   --absent-days 2 --half-day-days 1 --absent-from 2026-09       the absent-without-leave rule (--no-absent = leave it off)
//   --from-month 2026-08    first month shown in the report      (default 2026-08)
//
// THE REAL dev.db IS REFUSED unless BOTH --really-real AND TL_ALLOW_REAL_APPLY=1 are given
// (main runs it after the user's OK). Without them use --db with a copy.
//
// What --apply writes (AppSetting only, no schema change):
//   payroll.cycle          { startDay, effectiveFrom, firstFrom? }
//   payroll.absentNoLeave  { days, halfDayDays, effectiveFrom }
// Backup of the previous values: backend/backups/payroll-cycle-<time>.json (--undo reads the newest).
// ---------------------------------------------------------------------------
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const BACK = path.resolve(__dirname, '..');
const DB = path.resolve(arg('--db') || path.join(BACK, 'prisma', 'dev.db'));
const IS_REAL = path.basename(DB) === 'dev.db';
if (IS_REAL && !(has('--really-real') && process.env.TL_ALLOW_REAL_APPLY === '1')) {
  console.error('REFUSED: this is the real dev.db. Run it on a copy (--db <copy>), or - after the user said yes - with --really-real and TL_ALLOW_REAL_APPLY=1.');
  process.exit(2);
}
process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}`;
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const PC = require('../src/utils/payrollCycle');
const E = require('../src/utils/payrollEngine');

const START = Number(arg('--start-day', 16));
const EFF = arg('--effective-from', '2026-09');
const FIRST_FROM = arg('--first-from', null);
const ABSENT = has('--no-absent') ? null : { days: Number(arg('--absent-days', 2)), halfDayDays: Number(arg('--half-day-days', 1)), effectiveFrom: arg('--absent-from', EFF) };
const FROM_MONTH = arg('--from-month', '2026-08');
const BACKUPS = path.join(BACK, 'backups');
const money = (n) => Math.round(Number(n) || 0).toLocaleString('en-IN');
const csv = (rows) => rows.map((r) => r.map((c) => { const t = String(c ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; }).join(',')).join('\n');

async function main() {
  console.log(`Database: ${DB}${IS_REAL ? '  (REAL)' : ''}`);
  const cur = await PC.getSettings({ fresh: true });
  const cycleNew = PC.normaliseCycle({ startDay: START, effectiveFrom: EFF, firstFrom: FIRST_FROM });
  const absentNew = ABSENT ? PC.normaliseAbsent(ABSENT) : cur.absent;

  if (has('--undo')) {
    const files = fs.existsSync(BACKUPS) ? fs.readdirSync(BACKUPS).filter((f) => /^payroll-cycle-.*\.json$/.test(f)).sort() : [];
    const file = arg('--file') ? path.resolve(arg('--file')) : (files.length ? path.join(BACKUPS, files[files.length - 1]) : null);
    if (!file || !fs.existsSync(file)) { console.log('No backup file found (backend/backups/payroll-cycle-*.json).'); return; }
    const b = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (path.resolve(b.db) !== DB) { console.log(`That backup belongs to ${b.db}, not this database - refusing.`); return; }
    for (const key of [PC.CYCLE_KEY, PC.ABSENT_KEY]) {
      if (b.before[key] == null) await prisma.appSetting.deleteMany({ where: { key } });
      else await prisma.appSetting.upsert({ where: { key }, update: { value: b.before[key] }, create: { key, value: b.before[key] } });
    }
    PC.clearCache();
    console.log(`UNDONE from ${path.basename(file)}: the two payroll settings are back as they were.`);
    return;
  }

  // ---- 1. what is stored today ----------------------------------------------------------------
  console.log('\n=== 1. TODAY ===');
  console.log(`Saved cycle setting: ${cur.saved.cycle ? JSON.stringify(cur.cycle) : 'none (code default = calendar month, 1st to last day)'}`);
  console.log(`Saved absent rule  : ${cur.saved.absent ? JSON.stringify(cur.absent) : 'none (an absent day = 1 LOP day)'}`);
  const runs = await prisma.payrollRun.findMany({ orderBy: { month: 'asc' } });
  const eprs = await prisma.employeePayrollRun.groupBy({ by: ['month', 'status'], _count: { _all: true }, _sum: { netPay: true, grossPay: true } });
  const wdRows = await prisma.employeePayrollRun.groupBy({ by: ['month', 'workingDays'], _count: { _all: true } });
  const wdOf = new Map();
  wdRows.forEach((r) => { const cur2 = wdOf.get(r.month); if (!cur2 || r._count._all > cur2.n) wdOf.set(r.month, { wd: r.workingDays, n: r._count._all }); });
  console.log('\nMonth     status        records  days used in the run   calendar days   16th-15th days   looks like');
  let cyc16 = 0; let cal = 0;
  runs.forEach((r) => {
    const w = wdOf.get(r.month);
    const calDays = PC.daysInMonth(r.month);
    const c16 = PC.cycleOf(r.month, { startDay: 16, effectiveFrom: r.month }).days;
    const looks = !w ? '-' : (w.wd === c16 && w.wd !== calDays ? '16th-15th' : w.wd === calDays && w.wd !== c16 ? 'calendar' : 'same either way');
    if (looks === '16th-15th') cyc16 += 1; if (looks === 'calendar') cal += 1;
    const recs = eprs.filter((e) => e.month === r.month).map((e) => `${e.status}:${e._count._all}`).join(' ');
    console.log(`${r.month}   ${String(r.status).padEnd(12)}  ${String(r.employees).padStart(6)}   ${String(w ? w.wd : '-').padStart(8)} (${recs || 'no per-employee records'})   ${String(calDays).padStart(8)}   ${String(c16).padStart(10)}   ${looks}`);
  });
  console.log(`\nEvidence: ${cyc16} month(s) have working days that only fit the 16th-15th period, ${cal} only fit the calendar month.`);
  console.log('(The imported pay registers were therefore already made on the 16th-15th basis; the app itself had used the calendar month.)');

  // ---- 2. what the new settings would be ------------------------------------------------------
  console.log('\n=== 2. THE NEW SETTINGS ===');
  console.log(`payroll.cycle         : ${JSON.stringify(cycleNew)}`);
  console.log(`payroll.absentNoLeave : ${ABSENT ? JSON.stringify(absentNew) : '(unchanged)'}`);
  const settingsNew = { cycle: cycleNew, absent: absentNew, saved: { cycle: true, absent: !!ABSENT } };
  const realGet = PC.getSettings;
  PC.getSettings = async () => settingsNew; // the report below is computed as if they were saved; nothing is written
  PC.clearCache();

  // ---- 3. each month: what the new definition makes of it ------------------------------------
  console.log('\n=== 3. MONTHS FROM ' + FROM_MONTH + ' ===');
  const lastPaid = eprs.filter((e) => e.status !== 'DRAFT').map((e) => e.month).sort().pop() || null;
  const months = [];
  for (let m = FROM_MONTH; m <= PC.addMonths(lastPaid || FROM_MONTH, 1); m = PC.addMonths(m, 1)) months.push(m);
  const compare = [['Month', 'Employee ID', 'Employee', 'Old days', 'New days', 'Old LOP days', 'New LOP days', 'Old gross', 'New gross', 'Old net', 'New net', 'Net change']];
  for (const m of months) {
    const c = PC.cycleOf(m, settingsNew.cycle);
    const old = PC.cycleOf(m, { startDay: 1, effectiveFrom: null });
    const recs = await prisma.employeePayrollRun.findMany({ where: { month: m }, include: { employee: true } });
    const drafts = recs.filter((r) => r.status === 'DRAFT');
    const locked = recs.filter((r) => r.status !== 'DRAFT');
    console.log(`\n${c.heading}   (the calendar definition was ${old.rangeText}, ${old.days} days; the new one is ${c.days} days)`);
    if (!recs.length) {
      console.log('  No payroll records yet: nothing to change. It will simply be created on the new period.');
      const ov = await E.overlapProblem(m, c, settingsNew);
      console.log(ov ? `  GUARD: ${ov.message}` : '  Guard: no overlap with a payroll that is already paid.');
      continue;
    }
    if (locked.length) {
      const by = {};
      locked.forEach((r) => { by[r.status] = (by[r.status] || 0) + 1; });
      console.log(`  LOCKED - needs the user's decision (not touched): ${locked.length} record(s) ${JSON.stringify(by)}, net Rs ${money(locked.reduce((n, r) => n + r.netPay, 0))}.`);
    }
    if (drafts.length) {
      const r = await E.calculateMonth({ month: m, dryRun: true });
      const newOf = new Map(r.rows.map((x) => [x.employeeId, x]));
      let dNet = 0;
      drafts.forEach((d) => {
        const n = newOf.get(d.employeeId);
        if (!n) { compare.push([m, d.employee.employeeCode, d.employee.name, d.workingDays, 'n/a', d.daysLop, 'n/a', d.grossPay, 'n/a', d.netPay, 'n/a', 'no longer in the run']); return; }
        dNet += n.netPay - d.netPay;
        compare.push([m, d.employee.employeeCode, d.employee.name, d.workingDays, n.workingDays, d.daysLop, n.daysLop, d.grossPay, n.grossPay, d.netPay, n.netPay, n.netPay - d.netPay]);
      });
      console.log(`  DRAFT records that would be recalculated on the new period: ${drafts.length}. Total net change Rs ${money(dNet)}. (rows are in the comparison CSV)`);
    }
  }

  // ---- 4. the transition options with real numbers --------------------------------------------
  console.log('\n=== 4. THE TRANSITION - WHAT THE USER MUST DECIDE ===');
  const paidMonths = [...new Set(eprs.filter((e) => e.status !== 'DRAFT').map((e) => e.month))].sort();
  const lastM = paidMonths[paidMonths.length - 1];
  if (lastM) {
    const nextM = PC.addMonths(lastM, 1);
    const lastCal = PC.cycleOf(lastM, { startDay: 1, effectiveFrom: null });
    const lastNew = PC.cycleOf(lastM, { startDay: START, effectiveFrom: lastM });
    const nextNew = PC.cycleOf(nextM, { startDay: START, effectiveFrom: lastM });
    const lastRecs = await prisma.employeePayrollRun.findMany({ where: { month: lastM } });
    const lastNet = lastRecs.reduce((n, r) => n + r.netPay, 0);
    const wd = wdOf.get(lastM);
    console.log(`Latest paid payroll: ${lastM} (${lastRecs.length} employees, net Rs ${money(lastNet)}), run on ${wd ? wd.wd : '?'} days.`);
    console.log(`First payroll NOT yet made: ${nextNew.heading} (${nextNew.days} days).`);
    console.log('\n  OPTION A - the paid payroll was already on the 16th-15th period (this is what the register day counts show):');
    console.log(`     ${lastM} = ${lastNew.rangeText}; the next one starts on ${nextNew.from} = ${PC.addDays(lastNew.to, 1)}. No gap and no overlap, nothing is paid twice.`);
    console.log(`     Set the cycle effective from ${nextM} or earlier (earlier only changes the dates shown beside old months, never their money).`);
    const calOverlap = PC.overlapDays(nextNew, lastCal);
    console.log('\n  OPTION B - the paid payroll really covered the CALENDAR month:');
    if (calOverlap > 0) {
      const share = lastRecs.reduce((n, r) => n + (r.netPay * calOverlap) / lastCal.days, 0);
      console.log(`     ${lastM} paid ${lastCal.rangeText}. The new ${nextNew.label} period (${nextNew.rangeText}) overlaps ${calOverlap} day(s) of it.`);
      console.log(`     Money already paid for those ${calOverlap} days is about Rs ${money(share)} (net x ${calOverlap}/${lastCal.days}).`);
      console.log(`     Ways to settle: (1) first period starts later: --first-from ${PC.addDays(lastCal.to, 1)} so ${nextNew.label} pays only ${PC.addDays(lastCal.to, 1)} to ${nextNew.to}; (2) pay the full ${nextNew.days} days and deduct the ${calOverlap} days already paid as a one-off adjustment line.`);
    } else {
      console.log(`     ${lastM} calendar ${lastCal.rangeText} leaves no overlap with ${nextNew.rangeText} (gap ${nextNew.from > PC.addDays(lastCal.to, 1) ? 'yes' : 'none'}).`);
    }
    console.log('\n  The guard in the app refuses to create a payroll month over days an earlier payroll already paid, with a plain message.');
  } else console.log('No paid payroll yet: nothing to settle.');

  PC.getSettings = realGet;
  PC.clearCache();
  fs.mkdirSync(BACKUPS, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const csvFile = path.join(BACKUPS, `payroll-cycle-compare-${stamp}.csv`);
  fs.writeFileSync(csvFile, csv(compare));
  console.log(`\nComparison CSV (draft records only): ${csvFile} (${compare.length - 1} row(s))`);

  // ---- 5. apply ---------------------------------------------------------------------------------
  if (!has('--apply')) { console.log('\nDRY RUN - nothing was written to the database. Add --apply to save the two settings (--undo puts them back).'); return; }
  const before = {};
  for (const key of [PC.CYCLE_KEY, PC.ABSENT_KEY]) {
    const row = await prisma.appSetting.findUnique({ where: { key } });
    before[key] = row ? row.value : null;
  }
  const file = path.join(BACKUPS, `payroll-cycle-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({ db: DB, at: new Date().toISOString(), before }, null, 2));
  const actor = { id: null, name: 'payroll-cycle-migrate.js' };
  const r1 = await PC.saveCycle({ startDay: START, effectiveFrom: EFF, firstFrom: FIRST_FROM }, actor);
  if (r1.error) throw new Error(r1.error);
  if (ABSENT) { const r2 = await PC.saveAbsentRule(ABSENT, actor); if (r2.error) throw new Error(r2.error); }
  await prisma.auditLog.create({ data: { action: 'Payroll cycle settings changed', entity: 'AppSetting', entityId: PC.CYCLE_KEY, fromValue: JSON.stringify(before), toValue: JSON.stringify({ cycle: cycleNew, absent: ABSENT ? absentNew : null }), reason: 'scripts/payroll-cycle-migrate.js' } }).catch(() => {});
  console.log(`\nAPPLIED. Backup: ${file}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
