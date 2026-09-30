// ---------------------------------------------------------------------------
// PUT PEOPLE IN THE DEPARTMENT THEY ACTUALLY RECRUIT FOR.
//
// THE PROBLEM. The PulseHRM export's Department column is TeamLink's internal
// org — "HR", "Recruitment", "Administration". The ATS org is the SPECIALISM —
// Education, Medical, Manufacturing, BDE. Those two never overlap, so after the
// import every employee sat in a department with zero requirements:
//
//     Education      0 staff   2021 requirements
//     Medical        0 staff   1199 requirements
//     Manufacturing  0 staff    727 requirements
//     HR            21 staff      0 requirements
//     Recruitment   15 staff      0 requirements
//
// Everyone who signed in saw an empty ATS. Not a UI problem — the screens were
// fine, they had nothing to show.
//
// WHERE THE ANSWER CAME FROM. Not a guess: the attendance workbook's own
// Designation column names the specialism per person — "Education Recruiter",
// "Medical TL", "Manufacture Recruiter", "BDE (Education)". That is the
// company's own record of who works what, and it is the only place in any file
// supplied that carries it. Requirements themselves carry nothing: recruiterId
// and bdeId are null on all 3,987.
//
// WHAT IT CHANGES, AND WHAT FOLLOWS.
//   Employee.department            the desk they sit at
//   User.atsDepartment             via syncLoginToEmployee
//   User.atsScopeDepartments       ditto — this is what makes the ATS non-empty
//   their POSITION                 a seat belongs to a department, so a REC-2
//                                  seat is wrong once somebody moves to Medical.
//                                  The old tenure is CLOSED and a seat in the
//                                  new department is created and assigned.
//
// Designation is NOT touched. The level already agrees — somebody the sheet
// calls "Education TL" is already a TL here — and a designation change
// re-derives product roles, which is not something to do as a side effect of
// fixing a department.
//
// Only Active and Notice Period staff are moved. Somebody who left does not
// need a working ATS scope, and rewriting 319 historical records to fix a
// screen nobody will log into is churn.
//
// Dry run by default; --commit writes. Every change is audited.
// ---------------------------------------------------------------------------

const ExcelJS = require('exceljs');
const prisma = require('../src/db');
const { syncLoginToEmployee } = require('../src/utils/employeeAdmin');
const { logAudit } = require('../src/utils/audit');
const { today } = require('../src/utils/positions');

const FILE = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : 'C:/Users/user/Downloads/Jan 2026 to Dec 2026_Attendance sheet (2) (2).xlsx';
const COMMIT = process.argv.includes('--commit');
const pad = (s, n) => String(s ?? '').padEnd(n);

const val = (cell) => {
  let v = cell.value;
  if (v && typeof v === 'object') {
    if (v.result !== undefined) v = v.result;
    else if (Array.isArray(v.richText)) v = v.richText.map((t) => t.text).join('');
    else if (v.text !== undefined) v = v.text;
  }
  return v === null || v === undefined ? '' : String(v).trim();
};

// Designation text -> ATS department. Ordered: the first match wins, so
// "BDE (Education)" is read as BDE — the business development desk for
// education — rather than Education, which is what a naive contains() would
// give and is the wrong desk.
const RULES = [
  [/\bbde\b/i, 'BDE'],
  [/manufac|manufacrure/i, 'Manufacturing'], // the source's own typo included
  [/\bmedical\b|\bmed\b/i, 'Medical'],
  [/\beducation\b|\bedu\b/i, 'Education'],
  [/r\s*&\s*d/i, 'R&D'],
  [/internal hr|^hr\b|\bhr tl\b/i, 'HR'],
];
// Titles that name a rank and no specialism. They are left where they are
// rather than guessed at — a CEO is not a Medical recruiter.
const RANK_ONLY = /^(ceo|stl|recruiter|assistant manager|manager|md|systemadmin)$/i;

const deptFor = (designation) => {
  const d = String(designation || '').trim();
  if (!d || RANK_ONLY.test(d)) return null;
  const hit = RULES.find(([re]) => re.test(d));
  return hit ? hit[1] : null;
};

// The seat prefix per department, matching seat-active-employees.js.
const PREFIX = {
  Education: 'EDU', Medical: 'MED', Manufacturing: 'MFG', BDE: 'BDE',
  'R&D': 'RND', HR: 'HR', Recruitment: 'REC', Administration: 'ADM',
  IT: 'IT', 'Customer Support': 'CS', 'Product Development': 'PD', Marketing: 'MKT',
};

(async () => {
  console.log(COMMIT ? '*** COMMIT ***\n' : '*** DRY RUN — nothing will be written ***\n');

  // --- read the specialism per employee code -------------------------------
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(FILE);
  const designation = new Map();
  for (const ws of wb.worksheets) {
    for (let r = 2; r <= ws.rowCount; r += 1) {
      const code = val(ws.getRow(r).getCell(1)).toUpperCase();
      const d = val(ws.getRow(r).getCell(3));
      if (code && d) designation.set(code, d); // later sheets win — most recent
    }
  }

  const staff = await prisma.employee.findMany({
    where: { employmentStatus: { in: ['Active', 'Notice Period'] } },
    select: { id: true, employeeCode: true, name: true, department: true, userId: true },
    orderBy: { employeeCode: 'asc' },
  });

  const seats = await prisma.positionAssignment.findMany({
    where: { toDate: null },
    include: { position: true },
  });
  const seatOf = new Map(seats.map((a) => [a.employeeId, a]));

  const moves = [];
  const noSignal = [];
  const alreadyRight = [];

  for (const e of staff) {
    const code = String(e.employeeCode).toUpperCase();
    const title = designation.get(code);
    const want = deptFor(title);
    if (!want) { noSignal.push({ ...e, title: title || '(not in the attendance sheets)' }); continue; }
    if (want === e.department) { alreadyRight.push(e); continue; }
    moves.push({ ...e, title, from: e.department, to: want, seat: seatOf.get(e.id) || null });
  }

  console.log('MOVES (' + moves.length + ')');
  console.log('  ' + pad('CODE', 9) + pad('NAME', 30) + pad('SHEET SAYS', 24) + pad('FROM', 16) + pad('TO', 16) + 'SEAT');
  moves.forEach((m) => console.log('  ' + pad(m.employeeCode, 9) + pad(m.name.slice(0, 28), 30)
    + pad(m.title, 24) + pad(m.from || '—', 16) + pad(m.to, 16)
    + (m.seat ? `${m.seat.position.code} -> new ${PREFIX[m.to] || 'GEN'}-n` : 'none')));

  const tally = moves.reduce((acc, m) => { acc[m.to] = (acc[m.to] || 0) + 1; return acc; }, {});
  console.log('\nRESULTING HEADCOUNT CHANGE');
  Object.entries(tally).sort((a, b) => b[1] - a[1]).forEach(([d, n]) => console.log('  ' + pad(d, 18) + '+' + n));

  if (alreadyRight.length) {
    console.log(`\nALREADY IN THE RIGHT DEPARTMENT (${alreadyRight.length}): `
      + alreadyRight.map((e) => e.employeeCode).join(', '));
  }
  if (noSignal.length) {
    console.log(`\nNO SPECIALISM IN THE SHEETS (${noSignal.length}) — LEFT WHERE THEY ARE:`);
    noSignal.forEach((e) => console.log('  ' + pad(e.employeeCode, 9) + pad(e.name.slice(0, 28), 30)
      + pad(e.department || '—', 18) + e.title));
  }

  if (!COMMIT) {
    console.log('\nDRY RUN — re-run with --commit to apply.');
    process.exit(0);
  }

  console.log('\napplying…');
  // Seat numbering continues past whatever already exists in each department.
  const existingCodes = new Set((await prisma.position.findMany({ select: { code: true } })).map((p) => p.code));
  const counter = {};
  const nextSeat = (dept) => {
    const p = PREFIX[dept] || 'GEN';
    counter[p] = counter[p] || 0;
    let code;
    do { counter[p] += 1; code = `${p}-${counter[p]}`; } while (existingCodes.has(code));
    existingCodes.add(code);
    return code;
  };

  for (const m of moves) {
    // 1. the employee record
    // eslint-disable-next-line no-await-in-loop
    const employee = await prisma.employee.update({
      where: { id: m.id },
      data: { department: m.to, team: null },
    });

    // 2. THE LOGIN FOLLOWS. Same helper the /transfer route uses, so the ATS
    //    scope moves with the person instead of pointing at the old desk.
    // eslint-disable-next-line no-await-in-loop
    const moved = await syncLoginToEmployee(employee, { department: m.from, team: null });

    // 3. THE SEAT FOLLOWS TOO. A seat belongs to a department, so REC-2 is
    //    wrong once somebody is in Medical. Close the tenure, do not delete it.
    let newSeat = null;
    if (m.seat) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.positionAssignment.update({ where: { id: m.seat.id }, data: { toDate: today() } });
    }
    const code = nextSeat(m.to);
    // eslint-disable-next-line no-await-in-loop
    const seat = await prisma.position.create({ data: { code, department: m.to, name: `${m.to} seat ${code}` } });
    // eslint-disable-next-line no-await-in-loop
    await prisma.positionAssignment.create({ data: { positionId: seat.id, employeeId: m.id, fromDate: today() } });
    newSeat = code;

    // eslint-disable-next-line no-await-in-loop
    await logAudit({
      action: `Re-departmented from the attendance record (${m.title})`,
      entity: 'Employee',
      entityId: m.id,
      fromValue: m.from || '(none)',
      toValue: `${m.to} · seat ${newSeat}${moved ? ` · login: ${moved.changes.join('; ').slice(0, 120)}` : ''}`,
    });
  }

  console.log(`  ${moves.length} moved.\n`);
  console.log('AFTER — staff vs work, by department');
  const ed = await prisma.employee.groupBy({
    by: ['department'], _count: true, where: { employmentStatus: { in: ['Active', 'Notice Period'] } },
  });
  const rd = await prisma.requirement.groupBy({ by: ['department'], _count: true });
  const emp = {}; ed.forEach((r) => { emp[r.department] = r._count; });
  const req = {}; rd.forEach((r) => { req[r.department] = r._count; });
  [...new Set([...Object.keys(emp), ...Object.keys(req)])].sort().forEach((d) => console.log('  '
    + pad(d, 22) + String(emp[d] || 0).padStart(5) + ' staff' + String(req[d] || 0).padStart(8) + ' requirements'));
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
