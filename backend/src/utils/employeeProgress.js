// HOW PEOPLE ARE DOING THIS MONTH (founder 2026-11-06: "hrms dashboard medha employee progress kanipinchali, targets completed, attendance,
// performance & development, department wise employee performance chart"). One computation for the HRMS dashboard chart and an employee's own tiles.
//
//   Targets      Monthly Targets due this month + the recruiter's joining target. A person has met it when every one of theirs is done.
//   Attendance   days at work out of the working days so far this month. Week offs and holidays are not working days.
//   Performance  each person's latest approved review score, 0-100.
//   Training     LMS courses completed out of the courses given.
//
// A person with nothing to measure is left out of that figure: "no reviews yet" is never shown as a score of 0.
const D = require('./attendanceDays');
const RJ = require('./recruiterJoinings');
const { hrStatusOf } = require('./hrStatus');
const { filterActiveDepartments } = require('./masters');
const { splitByTeam } = require('./teamNames');

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : null);
const WORKED = { present: 1, halfDay: 0.5, absent: 0, onLeave: 0 };

const targetDone = (t) => t.status === 'Achieved' || (Number(t.amount) > 0 && Number(t.achieved) >= Number(t.amount));

// One person's figures from their raw rows. Pure, so it is tested on its own.
function personFigures({ employee, joining = null, targets = [], attendance = { worked: 0, days: 0 }, score = null, courses = [] }) {
  const targetItems = targets.length + (joining ? 1 : 0);
  const joiningMet = !!joining && joining.target > 0 && joining.joinings >= joining.target;
  const targetsDone = targets.filter(targetDone).length + (joiningMet ? 1 : 0);
  return {
    id: employee.id, name: employee.name, department: employee.department || 'No department', team: employee.team || '',
    joinings: joining ? joining.joinings : null, joiningTarget: joining ? joining.target : null,
    targetItems, targetsDone, targetMet: targetItems > 0 && targetsDone === targetItems,
    daysWorked: attendance.worked, workingDays: attendance.days,
    score, trainingDone: courses.filter((c) => c.completed).length, trainingTotal: courses.length,
  };
}

// The same figures added up for a group of people (a department, everybody).
function groupFigures(key, name, people) {
  const withTargets = people.filter((p) => p.targetItems > 0);
  const scored = people.filter((p) => p.score != null);
  const worked = people.reduce((n, p) => n + p.daysWorked, 0);
  const days = people.reduce((n, p) => n + p.workingDays, 0);
  const trainingDone = people.reduce((n, p) => n + p.trainingDone, 0);
  const trainingTotal = people.reduce((n, p) => n + p.trainingTotal, 0);
  const met = withTargets.filter((p) => p.targetMet).length;
  // THE JOINING COUNT (founder 2026-11-12: "targets close cheseru, ATS lo updates cheseru, count ekkada kanipinchali"): Targets % only says how many people
  // reached their whole target, so a team that is part way shows 0%. The joinings themselves (Recruiter joinings rule: ATS, Joined in the month) against the
  // joining targets of the people who have one are added up here, so the count is always visible.
  const withJoin = people.filter((p) => p.joiningTarget != null);
  return {
    key, name, people: people.length,
    joinings: withJoin.length ? withJoin.reduce((n, p) => n + (p.joinings || 0), 0) : null,
    joiningTarget: withJoin.length ? withJoin.reduce((n, p) => n + (p.joiningTarget || 0), 0) : null,
    targetsMet: met, targetsPeople: withTargets.length, targetsPct: pct(met, withTargets.length),
    daysWorked: worked, workingDays: days, attendancePct: pct(worked, days),
    reviewed: scored.length, scorePct: scored.length ? Math.round(scored.reduce((n, p) => n + p.score, 0) / scored.length) : null,
    trainingDone, trainingTotal, trainingPct: pct(trainingDone, trainingTotal),
  };
}

// One person as a chart row: their targets are items, not people.
function personRow(p) {
  return {
    key: p.id, name: p.name, people: 1,
    targetsMet: p.targetsDone, targetsPeople: p.targetItems, targetsPct: pct(p.targetsDone, p.targetItems),
    daysWorked: p.daysWorked, workingDays: p.workingDays, attendancePct: pct(p.daysWorked, p.workingDays),
    reviewed: p.score != null ? 1 : 0, scorePct: p.score,
    trainingDone: p.trainingDone, trainingTotal: p.trainingTotal, trainingPct: pct(p.trainingDone, p.trainingTotal),
    joinings: p.joinings, joiningTarget: p.joiningTarget,
  };
}

// Departments, or the people themselves once the list is down to one department.
// teamMap (utils/vacancies.js teamsByDepartment): a department the plan splits into teams (Education: Team A / Team B) also carries `teams`, the same
// figures per team, so the chart can show them under the department. The department row still counts everybody.
function rowsFor(people, level, teamMap) {
  if (level === 'employee') return people.map(personRow).sort((a, b) => a.name.localeCompare(b.name));
  const by = new Map();
  people.forEach((p) => { if (!by.has(p.department)) by.set(p.department, []); by.get(p.department).push(p); });
  return [...by.entries()].map(([d, list]) => {
    const row = groupFigures(d, d, list);
    const names = teamMap && teamMap.get(String(d).toLowerCase());
    if (names) row.teams = splitByTeam(names, list, (p) => p.team).map((t) => groupFigures(`${d}|${t.name}`, t.name, t.items));
    return row;
  }).sort((a, b) => b.people - a.people || a.name.localeCompare(b.name));
}

// Who counts (founder 2026-11-06: "only active departments and active employees"): Active people of an active department. People who left, and the
// "no department" bucket, stay out. Picking a status or a department in the dashboard filters is a choice, and is followed.
function counted(employees, liveDepartments, query = {}) {
  const live = query.status ? employees : employees.filter((e) => hrStatusOf(e.employmentStatus, e.user && e.user.status) === 'Active');
  if (!liveDepartments || !liveDepartments.size) return live.filter((e) => e.department || query.department);
  return filterActiveDepartments(live, liveDepartments, (e) => e.department, query.department).filter((e) => e.department);
}

// The month's figures for these employees, from the same sources as their own screens.
async function load(prisma, employees, month) {
  const today = D.localDate();
  const { from, to: monthEnd } = D.monthRange(month);
  const to = monthEnd < today ? monthEnd : today;
  const ids = employees.map((e) => e.id);
  const [board, targets, reviews, courses, cfg, roll] = await Promise.all([
    RJ.monthBoard(month).catch(() => ({ rows: [] })),
    prisma.employeeRecord.findMany({ where: { type: 'TARGET', employeeId: { in: ids }, date: { startsWith: month } }, select: { employeeId: true, status: true, amount: true, achieved: true } }),
    prisma.performanceReview.findMany({ where: { employeeId: { in: ids }, approvalStatus: 'Approved' }, orderBy: { createdAt: 'asc' }, select: { employeeId: true, score: true } }),
    prisma.courseAssignment.findMany({ where: { employeeId: { in: ids } }, select: { employeeId: true, completed: true } }),
    prisma.hrConfig.findFirst(),
    D.rollOf(prisma, employees),
  ]);
  const working = roll.employees.filter((e) => D.onRolls(e, from, to, roll.lastDayOf));
  const attendanceOf = new Map();
  if (working.length && from <= to) {
    const { days } = await D.loadDays(prisma, { employees: working, from, to, cfg: cfg || {}, lastDayOf: roll.lastDayOf, preview: true });
    working.forEach((e) => {
      const a = { worked: 0, days: 0 };
      days(e).forEach((d) => {
        const b = D.bucketOf(d);
        if (!(b in WORKED) || !d.counted) return; // week offs, holidays, days not reached yet
        a.days += 1;
        a.worked += WORKED[b];
      });
      attendanceOf.set(e.id, a);
    });
  }
  const group = (rows) => rows.reduce((m, r) => m.set(r.employeeId, [...(m.get(r.employeeId) || []), r]), new Map());
  const targetsOf = group(targets);
  const coursesOf = group(courses);
  const scoreOf = new Map(reviews.map((r) => [r.employeeId, r.score])); // oldest first, so the latest stays
  const joiningOf = new Map((board.rows || []).filter((r) => r.employeeId).map((r) => [r.employeeId, { target: r.target, joinings: r.joinings }]));
  return employees.map((employee) => personFigures({
    employee, joining: joiningOf.get(employee.id) || null, targets: targetsOf.get(employee.id) || [],
    attendance: attendanceOf.get(employee.id), score: scoreOf.has(employee.id) ? scoreOf.get(employee.id) : null, courses: coursesOf.get(employee.id) || [],
  }));
}

module.exports = { load, counted, personFigures, groupFigures, personRow, rowsFor, targetDone };
