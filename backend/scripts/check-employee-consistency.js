// ---------------------------------------------------------------------------
// DID THE CHANGE REACH EVERY MODULE?
//
// Employee.department is the truth. Four other places keep a copy of it, and
// every one of them is read by a different part of the app — so a copy that
// falls behind does not look like a bug, it looks like the app showing the
// wrong data to one role and the right data to another:
//
//   User.atsDepartment         the ATS "my desk" label
//   User.atsScopeDepartments   WHAT THE ATS ACTUALLY FILTERS ON — requirements,
//                              candidates, clients, applications, reports
//   User.team                  the HRMS team label
//   User.atsScopeTeams         what a TL's team scope filters on
//   Position.department        the seat they hold belongs to a department
//
// This finds every employee where any copy disagrees with the employee record,
// and with --fix pushes the employee record back out to all of them through
// syncLoginToEmployee — the same helper the edit form and Transfer use, not a
// second implementation that could drift from it.
//
// A seat in the wrong department is REPORTED but never auto-moved: which desk
// somebody sits at is a decision, and picking one for them would be inventing
// org structure. The fix is to vacate it, which the report tells you.
//
//   node scripts/check-employee-consistency.js
//   node scripts/check-employee-consistency.js --fix
// ---------------------------------------------------------------------------

const prisma = require('../src/db');
const { syncLoginToEmployee } = require('../src/utils/employeeAdmin');
const { logAudit } = require('../src/utils/audit');

const FIX = process.argv.includes('--fix');
const pad = (s, n) => String(s ?? '').padEnd(n);
const csv = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

(async () => {
  console.log(FIX ? '*** FIX MODE ***\n' : '*** CHECK ONLY — nothing will be written ***\n');

  const staff = await prisma.employee.findMany({
    where: { userId: { not: null } },
    select: {
      id: true, employeeCode: true, name: true, department: true, team: true,
      designation: true, employmentStatus: true, userId: true,
      user: {
        select: {
          atsDepartment: true, atsScopeDepartments: true, atsScopeTeams: true,
          team: true, atsRole: true, hrmsRole: true, role: true,
        },
      },
    },
    orderBy: { employeeCode: 'asc' },
  });

  const seats = await prisma.positionAssignment.findMany({
    where: { toDate: null },
    include: { position: true },
  });
  const seatOf = new Map(seats.map((a) => [a.employeeId, a.position]));

  const problems = [];
  for (const e of staff) {
    const u = e.user;
    const issues = [];

    if (e.department && u.atsDepartment !== e.department) {
      issues.push(`atsDepartment "${u.atsDepartment || '—'}" should be "${e.department}"`);
    }
    // The scope may legitimately be WIDER than one department (a Manager over
    // three). It is only wrong when it is a single department and that one is
    // not theirs — which is the shape every non-oversight login has.
    const scope = csv(u.atsScopeDepartments);
    if (e.department && scope.length === 1 && scope[0] !== e.department) {
      issues.push(`atsScopeDepartments "${scope[0]}" should be "${e.department}"  <- the ATS filters on this`);
    }
    if ((e.team || null) !== (u.team || null)) {
      issues.push(`login team "${u.team || '—'}" should be "${e.team || '—'}"`);
    }
    const teamScope = csv(u.atsScopeTeams);
    if (teamScope.length === 1 && teamScope[0] !== (e.team || null)) {
      issues.push(`atsScopeTeams "${teamScope[0]}" should be "${e.team || '—'}"`);
    }
    const seat = seatOf.get(e.id);
    if (seat && seat.department && e.department && seat.department !== e.department) {
      issues.push(`SEAT ${seat.code} belongs to ${seat.department}, but they are in ${e.department}  <- vacate it`);
    }

    if (issues.length) problems.push({ e, issues });
  }

  console.log(`${staff.length} employees with a login checked.\n`);
  if (!problems.length) {
    console.log('EVERY COPY AGREES WITH THE EMPLOYEE RECORD.');
    console.log('  department, ATS scope, team, team scope and seat are all consistent.');
  } else {
    console.log(`${problems.length} EMPLOYEE(S) WHERE A COPY HAS FALLEN BEHIND:\n`);
    problems.forEach(({ e, issues }) => {
      console.log('  ' + pad(e.employeeCode, 9) + pad(e.name.slice(0, 30), 32)
        + pad(e.department || '—', 16) + pad(e.employmentStatus, 15));
      issues.forEach((i) => console.log('      - ' + i));
    });
  }

  // A second, different question: is anybody's ATS role one that can see work?
  console.log('\nATS WORKING ROLES IN USE');
  const roles = await prisma.user.groupBy({ by: ['atsRole'], _count: true, where: { atsAccess: true } });
  roles.sort((a, b) => b._count - a._count)
    .forEach((r) => console.log('  ' + pad(r.atsRole || '(none)', 18) + r._count));

  console.log('\nSTAFF vs WORK, BY DEPARTMENT');
  const ed = await prisma.employee.groupBy({
    by: ['department'], _count: true, where: { employmentStatus: { in: ['Active', 'Notice Period'] } },
  });
  const rd = await prisma.requirement.groupBy({ by: ['department'], _count: true });
  const emp = {}; ed.forEach((r) => { emp[r.department] = r._count; });
  const req = {}; rd.forEach((r) => { req[r.department] = r._count; });
  [...new Set([...Object.keys(emp), ...Object.keys(req)])].sort().forEach((d) => {
    const s = emp[d] || 0; const q = req[d] || 0;
    console.log('  ' + pad(d, 22) + String(s).padStart(5) + ' staff' + String(q).padStart(8) + ' requirements'
      + (s > 0 && q === 0 ? '   (staff with no work here)' : '')
      + (s === 0 && q > 0 ? '   (work with nobody on it)' : ''));
  });

  if (!FIX || !problems.length) {
    if (problems.length) console.log('\nRe-run with --fix to push the employee record out to every copy.');
    process.exit(0);
  }

  console.log('\nfixing…');
  let fixed = 0;
  for (const { e } of problems) {
    // The SAME helper the edit form and /transfer call. Re-running it with the
    // employee as it stands now re-derives every copy from the truth.
    // eslint-disable-next-line no-await-in-loop
    const moved = await syncLoginToEmployee(
      { ...e, department: e.department, team: e.team },
      // `previous` is what the login currently thinks, so the helper's
      // "was this scope just their own desk" test compares against reality.
      { department: e.user.atsDepartment, team: e.user.team },
    );
    if (moved) {
      fixed += 1;
      // eslint-disable-next-line no-await-in-loop
      await logAudit({
        action: 'Login re-synced to the employee record (consistency check)',
        entity: 'User',
        entityId: e.userId,
        toValue: moved.changes.join('; ').slice(0, 200),
      });
      console.log('  ' + pad(e.employeeCode, 9) + moved.changes.join('; '));
    }
  }
  console.log(`\n  ${fixed} login(s) re-synced.`);
  console.log('  Seats are NOT auto-moved — see the report above and vacate them on the employee record.');
  process.exit(0);
})().catch((err) => { console.error('FAILED:', err.message); process.exit(1); });
