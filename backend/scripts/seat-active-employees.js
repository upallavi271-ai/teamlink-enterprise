// ---------------------------------------------------------------------------
// THE DEPARTMENTS THAT CAME IN WITH THE IMPORT, AND A SEAT FOR EVERYONE STILL
// WORKING.
//
// Two gaps the PulseHRM import left, and they are different in kind:
//
// 1. FIVE DEPARTMENTS EXIST ON EMPLOYEES BUT NOT IN THE MASTER.
//    Employee.department is a plain string, so the import wrote "Recruitment"
//    onto sixty people quite happily — but the Department table never heard of
//    it. The value is not wrong, it is just not registered, and until it is,
//    no dropdown offers it and no scope rule can be built on it. So they are
//    added to the master rather than rewritten on the employees: the data is
//    right, the catalogue was incomplete.
//
//    NO TEAMS ARE CREATED. Only Education is split into teams, and that rule
//    does not change because new departments arrived.
//
// 2. NOBODY HAS A SEAT.
//    A position is the DESK, not the person — MED-1 outlives whoever sits in
//    it. Every person still working occupies one, so one is created for each
//    and they are assigned to it from today.
//
//    Seats are created ONLY for Active and Notice Period. Somebody who left
//    does not occupy a desk, and back-dating tenures for 319 people from data
//    that has no joining dates would be inventing history.
//
//    The code is a department prefix plus a number, ordered by employee code
//    so the numbering is stable and repeatable. Rename them freely afterwards:
//    the code is snapshotted onto work as it happens, so a later rename never
//    rewrites what a seat already did.
//
// Dry run by default. --commit writes. Re-running is safe: it skips anybody
// who already holds a seat rather than minting a second one.
// ---------------------------------------------------------------------------

const prisma = require('../src/db');

const COMMIT = process.argv.includes('--commit');
const WORKING = ['Active', 'Notice Period'];
const today = () => new Date().toISOString().slice(0, 10);
const pad = (s, n) => String(s ?? '').padEnd(n);

// A short, readable prefix per department. Anything not listed falls back to
// its initials, which is predictable rather than clever.
const PREFIX = {
  HR: 'HR',
  Recruitment: 'REC',
  Administration: 'ADM',
  'Product Development': 'PD',
  'Customer Support': 'CS',
  Marketing: 'MKT',
  IT: 'IT',
  Medical: 'MED',
  Education: 'EDU',
  Manufacturing: 'MFG',
  Accounts: 'ACC',
  BDE: 'BDE',
};
const prefixFor = (d) => PREFIX[d]
  || String(d || 'GEN').split(/\s+/).map((w) => w[0]).join('').toUpperCase().slice(0, 4);

(async () => {
  console.log(COMMIT ? '*** COMMIT ***\n' : '*** DRY RUN — nothing will be written ***\n');

  // ---- 1. the missing departments -----------------------------------------
  const master = new Set((await prisma.department.findMany({ select: { name: true } })).map((d) => d.name));
  const used = await prisma.employee.groupBy({ by: ['department'], _count: true });
  const missing = used.filter((r) => r.department && !master.has(r.department));

  console.log('DEPARTMENTS TO ADD TO THE MASTER');
  if (!missing.length) console.log('  (none — every department on an employee already exists)');
  missing.sort((a, b) => b._count - a._count).forEach((r) => {
    console.log('  ' + pad(r.department, 24) + String(r._count).padStart(5) + ' employees');
  });
  if (COMMIT) {
    for (const r of missing) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.department.create({ data: { name: r.department } });
    }
  }

  // ---- 2. a seat for everybody still working ------------------------------
  const working = await prisma.employee.findMany({
    where: { employmentStatus: { in: WORKING } },
    select: { id: true, employeeCode: true, name: true, department: true },
    orderBy: { employeeCode: 'asc' },
  });
  const held = new Set((await prisma.positionAssignment.findMany({
    where: { toDate: null }, select: { employeeId: true },
  })).map((a) => a.employeeId));

  const existingCodes = new Set((await prisma.position.findMany({ select: { code: true } })).map((p) => p.code));
  const needSeat = working.filter((e) => !held.has(e.id));

  console.log(`\nSEATS — ${working.length} people still working, ${working.length - needSeat.length} already seated, ${needSeat.length} to place`);

  // Number within each department, continuing past any seat that already
  // exists so a re-run never collides.
  const counter = {};
  const nextCode = (dept) => {
    const p = prefixFor(dept);
    counter[p] = counter[p] || 0;
    let code;
    do { counter[p] += 1; code = `${p}-${counter[p]}`; } while (existingCodes.has(code));
    existingCodes.add(code);
    return code;
  };

  const plan = needSeat.map((e) => ({ e, code: nextCode(e.department) }));

  const byDept = {};
  plan.forEach((p) => { (byDept[p.e.department] ||= []).push(p); });
  Object.entries(byDept).forEach(([dept, list]) => {
    console.log(`\n  ${dept}  (${list.length})`);
    list.forEach((p) => console.log('    ' + pad(p.code, 10) + pad(p.e.employeeCode, 9) + p.e.name));
  });

  if (!COMMIT) {
    console.log('\nDRY RUN — re-run with --commit to apply.');
    process.exit(0);
  }

  for (const { e, code } of plan) {
    // eslint-disable-next-line no-await-in-loop
    const seat = await prisma.position.create({
      data: { code, department: e.department, name: `${e.department} seat ${code}` },
    });
    // eslint-disable-next-line no-await-in-loop
    await prisma.positionAssignment.create({
      data: { positionId: seat.id, employeeId: e.id, fromDate: today() },
    });
  }

  // ---- what it looks like now ---------------------------------------------
  console.log('\nAFTER');
  const deps = await prisma.department.findMany({ orderBy: { name: 'asc' }, select: { name: true } });
  console.log('  departments in master : ' + deps.map((d) => d.name).join(', '));
  console.log('  positions             : ' + await prisma.position.count());
  const seated = await prisma.positionAssignment.count({ where: { toDate: null } });
  console.log('  people holding a seat : ' + seated);
  const stillNone = await prisma.employee.count({ where: { employmentStatus: { in: WORKING } } }) - seated;
  console.log('  still without a seat  : ' + (stillNone < 0 ? 0 : stillNone));
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
