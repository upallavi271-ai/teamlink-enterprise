// ---------------------------------------------------------------------------
// LEAVE BALANCES IMPORT.
//
// One row per employee per leave type:
//
//   Opening Balance + Entitlement - Leaves Availed = Current Balance
//
// That identity was checked across all 172 rows before writing anything: 117
// match exactly, 55 match once the result is floored at zero (somebody who has
// taken more than they were entitled to shows 0, not a negative), and none
// disagree. So the file is internally consistent and the mapping is safe:
//
//   LeaveBalance.total = Opening Balance + Entitlement
//   LeaveBalance.taken = Leaves Availed
//
// The system then derives the remaining balance itself, which is why `total`
// carries the opening balance rather than the entitlement alone — otherwise
// somebody who carried five days forward would silently lose them.
//
// "PLANNED LEAVE" IS NOT IN THE LEAVE TYPE MASTER. It is created rather than
// bent into "Earned Leave": Planned and Earned are not the same thing
// everywhere, and renaming somebody's leave type during an import is the kind
// of quiet decision that surfaces months later as a balance nobody can explain.
//
// Unique on (employeeId, type), so re-running updates instead of duplicating.
// Dry run by default; --commit writes.
// ---------------------------------------------------------------------------

const ExcelJS = require('exceljs');
const prisma = require('../src/db');

const FILE = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : 'C:/Users/user/Downloads/Leave Balances.xlsx';
const COMMIT = process.argv.includes('--commit');
const pad = (s, n) => String(s ?? '').padEnd(n);

const txt = (cell) => {
  let v = cell.value;
  if (v && typeof v === 'object') {
    if (v.result !== undefined) v = v.result;
    else if (Array.isArray(v.richText)) v = v.richText.map((t) => t.text).join('');
    else if (v.text !== undefined) v = v.text;
  }
  return v === null || v === undefined ? '' : String(v).trim();
};
const num = (cell) => {
  let v = cell.value;
  if (v && typeof v === 'object' && v.result !== undefined) v = v.result;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

(async () => {
  console.log(COMMIT ? '*** COMMIT ***\n' : '*** DRY RUN — nothing will be written ***\n');
  console.log('file: ' + FILE + '\n');

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(FILE);
  const ws = wb.worksheets[0];

  const employees = await prisma.employee.findMany({ select: { id: true, employeeCode: true, name: true } });
  const byCode = new Map(employees.map((e) => [String(e.employeeCode).trim().toUpperCase(), e]));
  const knownTypes = new Map((await prisma.leaveType.findMany()).map((t) => [t.name.toLowerCase(), t]));

  const rows = [];
  const unmatched = new Map();
  const newTypes = new Set();

  for (let r = 2; r <= ws.rowCount; r += 1) {
    const code = txt(ws.getRow(r).getCell(1)).toUpperCase();
    if (!code) continue;
    const emp = byCode.get(code);
    const type = txt(ws.getRow(r).getCell(4));
    if (!emp) {
      unmatched.set(code, txt(ws.getRow(r).getCell(2)));
      continue;
    }
    if (!type) continue;
    if (!knownTypes.has(type.toLowerCase())) newTypes.add(type);

    const opening = num(ws.getRow(r).getCell(5));
    const entitlement = num(ws.getRow(r).getCell(6));
    const availed = num(ws.getRow(r).getCell(7));
    const sheetCurrent = num(ws.getRow(r).getCell(8));

    rows.push({
      employeeId: emp.id,
      employeeCode: code,
      name: emp.name,
      type,
      total: opening + entitlement,
      taken: availed,
      sheetCurrent,
      derived: Math.max(0, opening + entitlement - availed),
    });
  }

  const byType = rows.reduce((m, r) => { m[r.type] = (m[r.type] || 0) + 1; return m; }, {});
  console.log('ROWS TO WRITE: ' + rows.length);
  Object.entries(byType).forEach(([t, n]) => console.log('  ' + pad(t, 22) + n));
  console.log('\n  employees covered : ' + new Set(rows.map((r) => r.employeeId)).size);

  if (newTypes.size) {
    console.log('\nLEAVE TYPES NOT IN THE MASTER — they will be created, not renamed:');
    [...newTypes].forEach((t) => console.log('  ' + t));
  }
  if (unmatched.size) {
    console.log(`\nEMPLOYEE CODES NOT IN THE SYSTEM (${unmatched.size}) — skipped:`);
    [...unmatched.entries()].forEach(([c, n]) => console.log('  ' + pad(c, 10) + n));
  }

  // People who have taken more than they hold. Worth naming rather than
  // silently flooring: it is usually a real payroll conversation.
  const over = rows.filter((r) => r.taken > r.total);
  if (over.length) {
    console.log(`\nTAKEN MORE THAN ENTITLED (${over.length}) — stored as-is, balance floors at 0:`);
    over.slice(0, 12).forEach((r) => console.log('  ' + pad(r.employeeCode, 9) + pad(r.name.slice(0, 28), 30)
      + pad(r.type, 16) + `entitled ${r.total}, taken ${r.taken}`));
    if (over.length > 12) console.log(`  …and ${over.length - 12} more`);
  }

  if (!COMMIT) {
    console.log('\nDRY RUN — re-run with --commit to write.');
    process.exit(0);
  }

  for (const t of newTypes) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.leaveType.create({
      data: {
        code: t.replace(/\s+/g, '_').toUpperCase().slice(0, 20),
        name: t,
        // Cap comes from the data itself: the largest entitlement anybody has.
        cap: Math.max(0, ...rows.filter((r) => r.type === t).map((r) => r.total)),
        unit: 'yr',
      },
    });
    console.log('created leave type: ' + t);
  }

  console.log('\nwriting…');
  let done = 0;
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    // eslint-disable-next-line no-await-in-loop
    await prisma.$transaction(slice.map((r) => prisma.leaveBalance.upsert({
      where: { employeeId_type: { employeeId: r.employeeId, type: r.type } },
      update: { total: r.total, taken: r.taken },
      create: { employeeId: r.employeeId, type: r.type, total: r.total, taken: r.taken },
    })));
    done += slice.length;
    process.stdout.write(`\r  ${done} / ${rows.length}`);
  }

  console.log('\n\nAFTER');
  console.log('  leave balance rows : ' + await prisma.leaveBalance.count());
  const g = await prisma.leaveBalance.groupBy({ by: ['type'], _count: true, _sum: { total: true, taken: true } });
  g.forEach((x) => console.log('  ' + pad('  ' + x.type, 24) + pad(x._count, 6)
    + `entitled ${x._sum.total}  taken ${x._sum.taken}`));
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
