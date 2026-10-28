// ---------------------------------------------------------------------------
// IMPORT THE OLD HRMS (PulseHRM) ATTENDANCE FILES FROM THE COMMAND LINE - the same importer as Attendance -> Import History
// (utils/attendanceHistoryImport.js): the report (first check-in / last check-out), the bio-metric log and/or the summary.
// A day imported before is updated when the file adds to it (later check-out, more punches); nothing is ever doubled.
// Dry run by default (prints what would happen); --apply writes, in one transaction, with one audit row.
//
//   node scripts/import-attendance-files.js <file.csv> [<file.csv> ...] [--apply]
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const prisma = require('../src/db');
const H = require('../src/utils/attendanceHistoryImport');
const { logAudit } = require('../src/utils/audit');

const APPLY = process.argv.includes('--apply');
const paths = process.argv.slice(2).filter((a) => !a.startsWith('--'));

(async () => {
  if (!paths.length) { console.error('Give the CSV files to import.'); process.exit(2); }
  const files = paths.map((p) => ({ name: path.basename(p), text: fs.readFileSync(p, 'utf8') }));
  const p = await H.plan(files);
  console.log(APPLY ? '*** APPLY ***' : '*** DRY RUN - nothing is written ***');
  Object.entries(p.files).forEach(([k, v]) => { if (v && (!Array.isArray(v) || v.length)) console.log(`  ${k}: ${Array.isArray(v) ? v.join(', ') : `${v.name} (${v.rows} rows)`}`); });
  if (p.problems.length) { console.log('\nPROBLEMS'); p.problems.forEach((x) => console.log(`  ${x}`)); }
  console.log(`\nEMPLOYEE-DAYS ${p.days.total}`);
  Object.entries(p.days.byAction).forEach(([k, v]) => console.log(`  ${k.padEnd(14)} ${v}`));
  console.log(`  updated from this newer file: ${p.days.updated}   punches to add: ${p.days.punchesToAdd}`);
  if (p.unmatched.length) console.log(`\nNOT IN EMPLOYEE MANAGEMENT (stored, nothing created): ${p.unmatched.map((u) => `${u.employeeRef} ${u.sourceName || ''}`.trim()).join(', ')}`);
  const conflicts = p.items.filter((i) => i.action === 'conflict');
  if (conflicts.length) { console.log('\nKEPT (TeamLink marks the day Absent / Leave)'); conflicts.forEach((i) => console.log(`  ${i.employeeRef} ${i.date} ${i.result}`)); }
  if (!APPLY) { console.log('\nDRY RUN - run again with --apply to import.'); process.exit(0); }
  const r = await H.apply(p, { userId: null });
  await logAudit({
    actorName: 'Attendance import (command line)', action: 'Past attendance imported', entity: 'AttendanceHistory', entityId: r.batch,
    toValue: `${r.historyRows} day row(s), ${r.daysCreated} created, ${r.daysFilled} filled, ${r.daysUpdated} updated from a newer file, ${r.punchesCreated} punch(es), ${files.map((f) => f.name).join(' + ')}`.slice(0, 480),
  }).catch(() => {});
  console.log(`\nIMPORTED: ${JSON.stringify(r)}`);
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
