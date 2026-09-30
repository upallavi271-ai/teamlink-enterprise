// ---------------------------------------------------------------------------
// ATTENDANCE IMPORT — the monthly sheets, turned into daily records.
//
// The workbook is seven sheets, one per payroll cycle (the 16th to the 15th),
// and each sheet is two things side by side:
//
//   cols 1-15   a SUMMARY per employee — salary, working days, leaves taken,
//               LOP, payable days. Derived figures, recomputed every cycle.
//   cols 16+    the DAILY GRID — one column per date, one letter per day.
//
// ONLY THE DAILY GRID IS IMPORTED, and that is deliberate. The summary columns
// are arithmetic over the grid, and importing both would give the system two
// sources for the same fact that drift apart the first time somebody corrects
// a day. utils/attendanceMath.js already computes present/absent/half-day from
// the records; let it.
//
// THE SALARY COLUMN IS NOT IMPORTED EITHER. It is in the file, it is sensitive,
// and "import the attendance" is not permission to load everybody's pay into a
// system where a different set of people can read it. Say so explicitly and it
// goes into SalaryStructure, which is the model built for it.
//
// STATUS CODES, as they actually appear:
//     P      Present
//     AB     Absent
//     P/2    Half Day        (and P\2, one typo in the source)
//   blank    no record — a weekend, a holiday, or before they joined. NOT
//            imported as absent: silence is not evidence of absence.
//
// Matching is on Employee No (TL063) against employeeCode. An unmatched code
// is REPORTED, never guessed at — the sheets contain people who have since
// left, and inventing an employee to hang their attendance on would be worse
// than leaving it out.
//
// Dry run by default. --commit writes. Re-running is safe: the table is unique
// on (employeeId, date), so a second run updates rather than duplicates.
// ---------------------------------------------------------------------------

const ExcelJS = require('exceljs');
const prisma = require('../src/db');

const FILE = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : 'C:/Users/user/Downloads/Jan 2026 to Dec 2026_Attendance sheet (2) (2).xlsx';
const COMMIT = process.argv.includes('--commit');
const pad = (s, n) => String(s ?? '').padEnd(n);

// Excel cells arrive as strings, numbers, dates, formula results or rich text.
const val = (cell) => {
  let v = cell.value;
  if (v && typeof v === 'object') {
    if (v.result !== undefined) v = v.result;
    else if (Array.isArray(v.richText)) v = v.richText.map((t) => t.text).join('');
    else if (v.text !== undefined) v = v.text;
  }
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return v === null || v === undefined ? '' : String(v).trim();
};

// The four codes in the file, and nothing else. An unknown code is counted and
// reported rather than mapped to a guess.
const STATUS = {
  P: 'Present',
  AB: 'Absent',
  'P/2': 'Half Day',
  'P\\2': 'Half Day',
};

// THE DATE HEADERS ARE NOT WRITTEN THE SAME WAY TWICE.
//
// The first three sheets hold real Excel dates. The last four hold TEXT — and
// not one format but the month spelled however the person felt that month:
// "May-16", "June-17", "July-18", "Aug-16". Reading only the real dates
// silently produced zero records for four of the seven sheets, which a dry run
// caught and a commit would not have.
//
// The year is not in the text at all. It comes from YEAR below, because the
// workbook is "Jan 2026 to Dec 2026" and every sheet in it is 2026. A cycle
// that crossed New Year (Dec 16 to Jan 15) would need the year per column,
// and there is no such sheet here — if one is ever added, this is the line
// that has to change, which is why it is a named constant and not a literal.
const YEAR = Number(process.env.ATTENDANCE_YEAR || 2026);
const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

function headerDate(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  // Already a real date.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // 16-03-2026 / 16/03/2026
  let m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s);
  if (m) return iso(m[3], m[2], m[1]);
  // May-16 / June-17 / Aug-16  — month name first, day second.
  m = /^([A-Za-z]{3,9})[-\s/](\d{1,2})$/.exec(s);
  if (m && MONTHS[m[1].toLowerCase()]) return iso(YEAR, MONTHS[m[1].toLowerCase()], m[2]);
  // 16-May — the other way round, in case a sheet is written that way.
  m = /^(\d{1,2})[-\s/]([A-Za-z]{3,9})$/.exec(s);
  if (m && MONTHS[m[2].toLowerCase()]) return iso(YEAR, MONTHS[m[2].toLowerCase()], m[1]);
  return null;
}

(async () => {
  console.log(COMMIT ? '*** COMMIT ***\n' : '*** DRY RUN — nothing will be written ***\n');
  console.log('file: ' + FILE + '\n');

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(FILE);

  const employees = await prisma.employee.findMany({ select: { id: true, employeeCode: true, name: true } });
  const byCode = new Map(employees.map((e) => [String(e.employeeCode).trim().toUpperCase(), e]));

  const rows = [];            // { employeeId, date, status }
  const unmatched = new Map(); // code -> { name, days }
  const unknownCodes = new Map();
  let blanks = 0;
  const perSheet = [];

  for (const ws of wb.worksheets) {
    // Which columns are dates, and which date each one is.
    const dateCols = [];
    for (let c = 1; c <= ws.columnCount; c += 1) {
      const d = headerDate(val(ws.getRow(1).getCell(c)));
      if (d) dateCols.push({ col: c, date: d });
    }
    let sheetRows = 0;
    let sheetPeople = 0;

    for (let r = 2; r <= ws.rowCount; r += 1) {
      const code = val(ws.getRow(r).getCell(1)).toUpperCase();
      if (!code) continue;
      sheetPeople += 1;
      const emp = byCode.get(code);
      if (!emp) {
        const name = val(ws.getRow(r).getCell(2));
        const prev = unmatched.get(code) || { name, days: 0 };
        prev.days += dateCols.length;
        unmatched.set(code, prev);
        continue;
      }
      for (const { col, date } of dateCols) {
        const raw = val(ws.getRow(r).getCell(col));
        if (!raw) { blanks += 1; continue; }
        const status = STATUS[raw.toUpperCase()] || STATUS[raw];
        if (!status) {
          unknownCodes.set(raw, (unknownCodes.get(raw) || 0) + 1);
          continue;
        }
        rows.push({ employeeId: emp.id, date, status });
        sheetRows += 1;
      }
    }
    perSheet.push({ name: ws.name, people: sheetPeople, dates: dateCols.length, records: sheetRows });
  }

  console.log('PER SHEET');
  console.log('  ' + pad('SHEET', 24) + pad('PEOPLE', 9) + pad('DATES', 8) + 'RECORDS');
  perSheet.forEach((s) => console.log('  ' + pad(s.name, 24) + pad(s.people, 9) + pad(s.dates, 8) + s.records));

  // The same employee/date can appear in two sheets where cycles touch.
  const seen = new Map();
  let overlaps = 0;
  rows.forEach((r) => {
    const k = `${r.employeeId}|${r.date}`;
    if (seen.has(k)) { overlaps += 1; }
    seen.set(k, r); // last sheet wins
  });
  const unique = [...seen.values()];

  const byStatus = unique.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
  const dates = unique.map((r) => r.date).sort();

  console.log('\nTOTALS');
  console.log('  ' + pad('records to write', 26) + unique.length);
  console.log('  ' + pad('duplicate employee+date', 26) + overlaps + (overlaps ? '  (cycles overlap — last sheet wins)' : ''));
  console.log('  ' + pad('blank cells skipped', 26) + blanks + '  (weekend / holiday / not yet joined)');
  console.log('  ' + pad('date range', 26) + (dates[0] || '—') + '  to  ' + (dates[dates.length - 1] || '—'));
  console.log('  ' + pad('employees matched', 26) + new Set(unique.map((r) => r.employeeId)).size);
  Object.entries(byStatus).forEach(([k, n]) => console.log('  ' + pad('  ' + k, 26) + n));

  if (unknownCodes.size) {
    console.log('\nUNKNOWN STATUS CODES (skipped, not guessed):');
    [...unknownCodes.entries()].forEach(([k, n]) => console.log('  ' + pad(JSON.stringify(k), 18) + n));
  }
  if (unmatched.size) {
    console.log(`\nEMPLOYEE CODES NOT IN THE SYSTEM (${unmatched.size}) — their attendance is NOT imported:`);
    [...unmatched.entries()].slice(0, 25).forEach(([code, v]) => console.log('  ' + pad(code, 10) + pad(v.name.slice(0, 34), 36) + v.days + ' days'));
    if (unmatched.size > 25) console.log(`  …and ${unmatched.size - 25} more`);
  }

  if (!COMMIT) {
    console.log('\nDRY RUN — re-run with --commit to write.');
    console.log('NOTE: the Salaries column in this file is NOT imported. Ask for it explicitly.');
    process.exit(0);
  }

  console.log('\nwriting…');
  let done = 0;
  const CHUNK = 500;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const slice = unique.slice(i, i + CHUNK);
    // eslint-disable-next-line no-await-in-loop
    await prisma.$transaction(slice.map((r) => prisma.attendance.upsert({
      where: { employeeId_date: { employeeId: r.employeeId, date: r.date } },
      update: { status: r.status },
      create: { employeeId: r.employeeId, date: r.date, status: r.status },
    })));
    done += slice.length;
    process.stdout.write(`\r  ${done} / ${unique.length}`);
  }
  console.log('\n\nAFTER');
  console.log('  attendance rows in the system : ' + await prisma.attendance.count());
  const g = await prisma.attendance.groupBy({ by: ['status'], _count: true });
  g.forEach((x) => console.log('  ' + pad('  ' + x.status, 26) + x._count));
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
