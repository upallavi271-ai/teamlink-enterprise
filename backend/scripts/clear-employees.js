// ---------------------------------------------------------------------------
// REMOVE THE EMPLOYEE DATA, AND ONLY THE EMPLOYEE DATA.
//
// "employees data matrame remove cheyyu, remaining antha same vundali" — the
// HRMS people go, so a fresh set can be imported from Pulse HRM in their
// place. Everything else stays exactly where it is.
//
// WHAT GOES
//   Employee, and the fifteen HRMS tables that hang off it — attendance,
//   punches, regularisations, leave, balances, payslips, salary structures,
//   FNF, reviews, course and project assignments, survey responses,
//   acknowledgments, employee records and position assignments.
//
// WHAT STAYS, and this is the point of the script
//   Clients, requirements, candidates, applications, invoices,
//   specialisations, positions (the SEATS survive; only who sat in them goes),
//   and every login.
//
// WHY THE LOGINS STAY. A login is not an employee. Deleting the User rows
// would take the Super Admin account being used to run this with them, and
// Requirement.recruiterId / .bdeId point at User — so a future assignment
// would lose its target. After the Pulse import the logins can be re-linked to
// the new employee rows by email; that is a smaller, reversible job than
// recreating accounts. Orphaned logins are REPORTED at the end so nothing is
// silently left dangling.
//
// Application.hrmsEmployeeId is a plain string, not a foreign key, so deleting
// employees would leave it pointing at nothing. It is cleared here rather than
// left as a lie.
//
// EVERY DELETED ROW IS WRITTEN TO A BACKUP FILE FIRST. Dry run by default;
// pass --commit to write.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const prisma = require('../src/db');

const COMMIT = process.argv.includes('--commit');

// Delete order matters: children before the parent they point at.
const CHILDREN = [
  'acknowledgment',
  'surveyResponse',
  'projectAssignment',
  'courseAssignment',
  'performanceReview',
  'fnfRequest',
  'salaryStructure',
  'payslip',
  'leaveBalance',
  'leaveRequest',
  'attendanceRegularization',
  'attendancePunch',
  'attendance',
  'employeeRecord',
  'positionAssignment',
];

const pad = (s, n) => String(s).padEnd(n);

(async () => {
  console.log(COMMIT ? '*** COMMIT — rows will be deleted ***\n' : '*** DRY RUN — nothing will be written ***\n');

  // ---- count everything first ---------------------------------------------
  const counts = {};
  for (const m of CHILDREN) {
    counts[m] = await prisma[m].count().catch(() => 0);
  }
  const employees = await prisma.employee.count();

  console.log('WILL BE DELETED');
  CHILDREN.forEach((m) => { if (counts[m]) console.log('  ' + pad(m, 30) + String(counts[m]).padStart(7)); });
  console.log('  ' + pad('employee', 30) + String(employees).padStart(7));

  // ---- what must survive, measured before AND after ------------------------
  const KEEP = ['client', 'requirement', 'candidate', 'application', 'invoice', 'specialisation', 'position', 'user'];
  const before = {};
  for (const m of KEEP) before[m] = await prisma[m].count().catch(() => -1);
  console.log('\nMUST SURVIVE UNCHANGED');
  KEEP.forEach((m) => console.log('  ' + pad(m, 30) + String(before[m]).padStart(7)));

  const danglingApps = await prisma.application.count({ where: { hrmsEmployeeId: { not: null } } });
  console.log('\n  applications pointing at an employee (will be cleared): ' + danglingApps);

  if (!COMMIT) {
    console.log('\nDRY RUN — re-run with --commit to apply.');
    process.exit(0);
  }

  // ---- back up every row that is about to go ------------------------------
  const dir = path.join(__dirname, '..', 'backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `employees-before-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const backup = { takenAt: new Date().toISOString(), employees: await prisma.employee.findMany() };
  for (const m of CHILDREN) {
    backup[m] = counts[m] ? await prisma[m].findMany() : [];
  }
  backup.applicationsWithHrmsEmployee = await prisma.application.findMany({
    where: { hrmsEmployeeId: { not: null } },
    select: { id: true, hrmsEmployeeId: true },
  });
  fs.writeFileSync(file, JSON.stringify(backup, null, 2));
  console.log('\nbackup written: ' + file);
  console.log('                ' + (fs.statSync(file).size / 1024).toFixed(0) + ' KB');

  // ---- delete, children first ---------------------------------------------
  console.log('\nDELETING');
  for (const m of CHILDREN) {
    if (!counts[m]) continue;
    const r = await prisma[m].deleteMany({});
    console.log('  ' + pad(m, 30) + String(r.count).padStart(7));
  }
  // The dangling pointer goes before the rows it points at.
  if (danglingApps) {
    const r = await prisma.application.updateMany({
      where: { hrmsEmployeeId: { not: null } },
      data: { hrmsEmployeeId: null },
    });
    console.log('  ' + pad('application.hrmsEmployeeId', 30) + String(r.count).padStart(7) + '  (cleared, rows kept)');
  }
  const emp = await prisma.employee.deleteMany({});
  console.log('  ' + pad('employee', 30) + String(emp.count).padStart(7));

  // ---- prove the rest is untouched ----------------------------------------
  console.log('\nAFTER — must match the numbers above');
  let drift = false;
  for (const m of KEEP) {
    const now = await prisma[m].count().catch(() => -1);
    const ok = now === before[m];
    if (!ok) drift = true;
    console.log('  ' + pad(m, 30) + String(now).padStart(7) + (ok ? '  ok' : `  CHANGED from ${before[m]}`));
  }
  if (drift) console.log('\n!! Something outside the employee data changed. Read the backup and investigate.');

  // ---- logins that now have nobody behind them ----------------------------
  const orphans = await prisma.user.findMany({
    where: { employee: null },
    select: { email: true, role: true, status: true },
  });
  console.log(`\nLOGINS WITH NO EMPLOYEE RECORD: ${orphans.length} of ${before.user}`);
  orphans.slice(0, 12).forEach((u) => console.log('  ' + pad(u.email, 38) + u.role));
  if (orphans.length > 12) console.log(`  …and ${orphans.length - 12} more`);
  console.log('\nThese are kept on purpose — see the header. After the Pulse HRM import');
  console.log('they can be re-linked to the new employee rows by email address.');

  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
