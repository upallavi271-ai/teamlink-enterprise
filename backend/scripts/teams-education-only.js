// ---------------------------------------------------------------------------
// TEAMS ARE AN EDUCATION THING ONLY.
//
// "only education department ki matram team a team b vuntaru" — Education is
// split into Team-A and Team-B; no other department is split at all. The
// imported sheets disagreed: six departments carried teams, and Education's
// own two teams were sitting on a SECOND spelling of its name ("Educational",
// 2 employees) while the real 200 sat under "Education" on a third team name.
//
// So this does three things, in this order:
//
//   1. MERGE   "Educational" into "Education" — employees, teams, then drop it
//   2. NORMALISE Education's teams to exactly Team-A and Team-B, moving the
//      employees who were on "Education Team-A" onto "Team-A"
//   3. CLEAR   every other department's teams, from the master AND from the
//      employees carrying them
//
// EVERY ROW IT CHANGES IS WRITTEN TO A BACKUP FILE FIRST, so this is
// reversible. Run with --commit to actually write; without it, it only says
// what it would do.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const prisma = require('../src/db');

const COMMIT = process.argv.includes('--commit');
const KEEP = 'Education';
const DUPE = 'Educational';
const TEAMS = ['Team-A', 'Team-B'];

const log = (...a) => console.log(...a);

(async () => {
  const employees = await prisma.employee.findMany({ select: { id: true, name: true, employeeCode: true, department: true, team: true } });
  const departments = await prisma.department.findMany({ include: { teams: true } });

  // ---- the backup, written before a single write ---------------------------
  const dir = path.join(__dirname, '..', 'backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `teams-before-${stamp}.json`);
  const backup = {
    takenAt: new Date().toISOString(),
    departments: departments.map((d) => ({ id: d.id, name: d.name, teams: d.teams.map((t) => ({ id: t.id, name: t.name })) })),
    employees: employees.filter((e) => e.team || e.department === DUPE),
  };
  if (COMMIT) fs.writeFileSync(file, JSON.stringify(backup, null, 2));
  log(COMMIT ? `backup written  : ${file}` : 'backup           : (dry run — not written)');
  log(`                  ${backup.employees.length} employee rows, ${departments.length} departments`);

  // ---- 1. merge the duplicate department -----------------------------------
  const movers = employees.filter((e) => e.department === DUPE);
  log(`\n1. MERGE ${DUPE} -> ${KEEP}`);
  log(`   employees moved: ${movers.length}${movers.length ? ' — ' + movers.map((e) => e.name).join(', ') : ''}`);
  if (COMMIT && movers.length) {
    await prisma.employee.updateMany({ where: { department: DUPE }, data: { department: KEEP } });
  }

  // ---- 2. Education has exactly Team-A and Team-B --------------------------
  const keepDept = departments.find((d) => d.name === KEEP);
  if (!keepDept) throw new Error(`No "${KEEP}" department found — aborting rather than guessing.`);
  const eduTeamNames = new Set([
    ...(keepDept.teams || []).map((t) => t.name),
    ...departments.filter((d) => d.name === DUPE).flatMap((d) => d.teams.map((t) => t.name)),
  ]);
  log(`\n2. ${KEEP} teams -> ${TEAMS.join(', ')}`);
  log(`   was: ${[...eduTeamNames].join(', ') || '(none)'}`);

  // Anyone in Education on an old team name lands on Team-A: it is the team
  // they were actually in, under the name the company uses for it. Team-B
  // members already named Team-B keep it.
  const eduPeople = employees.filter((e) => e.department === KEEP || e.department === DUPE);
  const remap = eduPeople.filter((e) => e.team && !TEAMS.includes(e.team));
  log(`   employees whose team name is rewritten: ${remap.length}`);
  const byOld = {};
  remap.forEach((e) => { byOld[e.team] = (byOld[e.team] || 0) + 1; });
  Object.entries(byOld).forEach(([old, n]) => log(`     "${old}" -> "Team-A"  (${n})`));

  if (COMMIT) {
    for (const old of Object.keys(byOld)) {
      await prisma.employee.updateMany({ where: { department: KEEP, team: old }, data: { team: 'Team-A' } });
    }
    // Rebuild Education's team list to exactly the two.
    await prisma.team.deleteMany({ where: { departmentId: keepDept.id } });
    for (const name of TEAMS) {
      await prisma.team.create({ data: { name, departmentId: keepDept.id } });
    }
  }

  // ---- 3. every other department loses its teams ---------------------------
  const others = departments.filter((d) => d.name !== KEEP && d.name !== DUPE);
  const otherWithTeams = others.filter((d) => d.teams.length);
  const strays = employees.filter((e) => e.team && e.department !== KEEP && e.department !== DUPE);
  log('\n3. TEAMS REMOVED FROM EVERY OTHER DEPARTMENT');
  otherWithTeams.forEach((d) => log(`   ${d.name.padEnd(16)} drop: ${d.teams.map((t) => t.name).join(', ')}`));
  const byDept = {};
  strays.forEach((e) => { byDept[e.department] = (byDept[e.department] || 0) + 1; });
  log(`   employees whose team is cleared: ${strays.length}`);
  Object.entries(byDept).forEach(([d, n]) => log(`     ${String(d).padEnd(16)} ${n}`));

  if (COMMIT) {
    await prisma.team.deleteMany({ where: { departmentId: { in: otherWithTeams.map((d) => d.id) } } });
    await prisma.employee.updateMany({
      where: { department: { notIn: [KEEP, DUPE] }, team: { not: null } },
      data: { team: null },
    });
    // The duplicate department goes last, once nothing points at it. Its teams
    // cascade on delete.
    const dupeDept = departments.find((d) => d.name === DUPE);
    if (dupeDept) await prisma.department.delete({ where: { id: dupeDept.id } });
  }

  // ---- what it looks like now ---------------------------------------------
  if (COMMIT) {
    log('\nAFTER:');
    const after = await prisma.department.findMany({ include: { teams: true }, orderBy: { name: 'asc' } });
    after.forEach((d) => log(`   ${d.name.padEnd(16)} ${d.teams.map((t) => t.name).join(', ') || '(no teams)'}`));
    const withTeam = await prisma.employee.groupBy({ by: ['department', 'team'], _count: true, where: { team: { not: null } } });
    log('   employees with a team set:');
    withTeam.forEach((r) => log(`     ${String(r.department).padEnd(16)} ${String(r.team).padEnd(10)} ${r._count}`));
  } else {
    log('\nDRY RUN — nothing written. Re-run with --commit to apply.');
  }
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
