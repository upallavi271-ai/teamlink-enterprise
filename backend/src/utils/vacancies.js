// ---------------------------------------------------------------------------
// VACANCIES ON THE DASHBOARD (founder 2026-11-02): "dashboard medha vacancies enni unai anni kuda kanipinchali. Education lo motham 13
// members untaru dantlo stl, tl's 2, employee 10 ... medical 1 tl, 5 employees, manufacturing 1 tl, 5 employees and medical and
// manufacturing rendu departments ki okate stl and bde ki tl-1, employee-5, and R&D tl-1, employee-3".
//
// PLAN  = how many people each department should have, per role (STL / TL / Employee). AppSetting 'hrms.vacancyPlan'; the founder's
//         numbers are the default; only the Super Admin changes it. A group may cover several departments (one STL for Medical +
//         Manufacturing).
// FILLED = employees who have not left (status not Relieved / Exited), by department and designation: a designation with "STL" or
//         "Senior Team Lead" = STL, one with "TL" or "Team Lead" = TL, everyone else = Employee. Notice Period still counts as filled
//         (shown as "leaving"), because the person is still working.
// VACANT = plan - filled (never below 0); more people than the plan shows as "over".
//
// TEAMS (founder 2026-11-12: "vacancies lo education team A undhi and Team B undhi, aa team vacancies unaya anni in detail ga pettu"):
// a department may also list its TEAMS (Education: Team A and Team B, each 1 TL + 5 employees). A team row is a SPLIT of the department's
// own TL / Employee rows, matched on Employee.team ("Team-A", "Team A" and "team a" are the same team). The department rows stay the
// ones that count: the totals, the dashboard card and the HRMS tile never add a team row again. A person of a team-split role whose team
// is blank or unknown is listed as "No team set", so nobody disappears from the screen.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const PLAN_KEY = 'hrms.vacancyPlan';
const ROLES = ['STL', 'TL', 'Employee'];
const LEFT = ['Relieved', 'Exited'];
const DEFAULT_PLAN = [
  {
    name: 'Education',
    departments: ['Education'],
    rows: [{ role: 'STL', planned: 1 }, { role: 'TL', planned: 2 }, { role: 'Employee', planned: 10 }],
    teams: [
      { name: 'Team A', rows: [{ role: 'TL', planned: 1 }, { role: 'Employee', planned: 5 }] },
      { name: 'Team B', rows: [{ role: 'TL', planned: 1 }, { role: 'Employee', planned: 5 }] },
    ],
  },
  { name: 'Medical', departments: ['Medical'], rows: [{ role: 'TL', planned: 1 }, { role: 'Employee', planned: 5 }] },
  { name: 'Manufacturing', departments: ['Manufacturing'], rows: [{ role: 'TL', planned: 1 }, { role: 'Employee', planned: 5 }] },
  { name: 'Medical + Manufacturing', departments: ['Medical', 'Manufacturing'], rows: [{ role: 'STL', planned: 1 }] },
  { name: 'BDE', departments: ['BDE'], rows: [{ role: 'TL', planned: 1 }, { role: 'Employee', planned: 5 }] },
  { name: 'R&D', departments: ['R&D'], rows: [{ role: 'TL', planned: 1 }, { role: 'Employee', planned: 3 }] },
];

const roleOf = (designation) => {
  const d = String(designation || '');
  if (/\bSTL\b|senior\s+team\s+lead/i.test(d)) return 'STL';
  if (/\bTL\b|team\s+lead/i.test(d)) return 'TL';
  return 'Employee';
};
const low = (s) => String(s || '').trim().toLowerCase();
const { teamKey, NO_TEAM, teamNameOf } = require('./teamNames'); // "Team-A" / "Team A" / "team a" are one team

// A plan saved before teams existed has no `teams` key: it gets the default teams of the group with the same name (Education), so the
// Team A / Team B rows show without anybody re-saving. A plan that says `teams: []` says "no teams" and is left alone.
function withDefaultTeams(plan) {
  return plan.map((g) => {
    if (!g || g.teams !== undefined) return g;
    const d = DEFAULT_PLAN.find((x) => x.teams && low(x.name) === low(g.name));
    return d ? { ...g, teams: JSON.parse(JSON.stringify(d.teams)) } : g;
  });
}

async function readPlan() {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: PLAN_KEY } });
    const v = row ? JSON.parse(row.value) : null;
    if (Array.isArray(v) && v.length) return withDefaultTeams(v);
  } catch { /* the default */ }
  return DEFAULT_PLAN;
}

// the rows of a department or a team -> clean rows, or { error }
function cleanRows(label, input, allowed) {
  const rows = [];
  for (const r of (input || [])) {
    if (!ROLES.includes(r && r.role)) return { error: `"${label}": the role must be STL, TL or Employee.` };
    if (allowed && !allowed.includes(r.role)) return { error: `"${label}": ${r.role} must also be planned for the department.` };
    const planned = Number(r.planned);
    if (!Number.isInteger(planned) || planned < 0 || planned > 500) return { error: `"${label}" ${r.role}: give a whole number from 0 to 500.` };
    if (rows.some((x) => x.role === r.role)) return { error: `"${label}" has ${r.role} twice.` };
    rows.push({ role: r.role, planned });
  }
  return { rows };
}

// a plan from the screen -> a clean plan, or { error }
function cleanPlan(input) {
  if (!Array.isArray(input) || !input.length || input.length > 40) return { error: 'The plan needs at least one department.' };
  const out = [];
  for (const g of input) {
    const name = String((g && g.name) || '').trim().slice(0, 60);
    const departments = [...new Set((Array.isArray(g && g.departments) ? g.departments : [name]).map((d) => String(d || '').trim().slice(0, 60)).filter(Boolean))];
    if (!name || !departments.length) return { error: 'Every row needs a department name.' };
    const cr = cleanRows(name, g.rows);
    if (cr.error) return cr;
    const { rows } = cr;
    const group = { name, departments, rows };
    if (Array.isArray(g.teams)) { // the teams of the department (Education: Team A / Team B); [] = no teams
      if (g.teams.length > 12) return { error: `"${name}": at most 12 teams.` };
      group.teams = [];
      for (const t of g.teams) {
        const tn = String((t && t.name) || '').trim().slice(0, 40);
        if (!tn) return { error: `"${name}": every team needs a name.` };
        if (group.teams.some((x) => teamKey(x.name) === teamKey(tn))) return { error: `"${name}" has the team ${tn} twice.` };
        const tr = cleanRows(`${name} ${tn}`, t.rows, rows.map((r) => r.role));
        if (tr.error) return tr;
        group.teams.push({ name: tn, rows: tr.rows });
      }
    }
    out.push(group);
  }
  return { plan: out };
}

async function savePlan(input) {
  const c = cleanPlan(input);
  if (c.error) return c;
  const value = JSON.stringify(c.plan);
  await prisma.appSetting.upsert({ where: { key: PLAN_KEY }, update: { value }, create: { key: PLAN_KEY, value } });
  return { ok: true };
}

// the dashboard view: every group, every role, planned / filled / vacant, with the names
async function view() {
  const plan = await readPlan();
  const people = await prisma.employee.findMany({
    where: { employmentStatus: { notIn: LEFT } },
    select: { id: true, name: true, department: true, team: true, designation: true, employmentStatus: true },
    orderBy: { name: 'asc' },
  });
  // which group counts a (department, role): the first group that covers the department AND plans that role
  const groupFor = (dept, role) => plan.findIndex((g) => g.departments.some((d) => low(d) === low(dept)) && g.rows.some((r) => r.role === role));
  const seat = plan.map((g) => Object.fromEntries(g.rows.map((r) => [r.role, []])));
  people.forEach((p) => {
    const role = roleOf(p.designation);
    const gi = groupFor(p.department, role);
    if (gi >= 0) seat[gi][role].push({ id: p.id, name: p.name, designation: p.designation || '', team: p.team || '', leaving: p.employmentStatus === 'Notice Period' });
  });
  const seatRow = (planned, ppl) => ({ planned, filled: ppl.length, vacant: Math.max(0, planned - ppl.length), over: Math.max(0, ppl.length - planned), leaving: ppl.filter((x) => x.leaving).length, people: ppl });
  let planned = 0; let filled = 0; let vacant = 0; let leaving = 0;
  const groups = plan.map((g, gi) => {
    const rows = g.rows.map((r) => {
      const ppl = seat[gi][r.role];
      const v = Math.max(0, r.planned - ppl.length);
      const l = ppl.filter((x) => x.leaving).length;
      planned += r.planned; filled += Math.min(ppl.length, r.planned); vacant += v; leaving += l;
      return { role: r.role, planned: r.planned, filled: ppl.length, vacant: v, over: Math.max(0, ppl.length - r.planned), leaving: l, people: ppl };
    });
    // the teams of this department: a split of the TL / Employee rows above (not added to the totals again)
    let teams; let teamless;
    if (Array.isArray(g.teams) && g.teams.length) {
      const keys = g.teams.map((t) => teamKey(t.name));
      const roles = [...new Set(g.teams.flatMap((t) => t.rows.map((r) => r.role)))];
      teams = g.teams.map((t) => {
        const trows = t.rows.map((r) => ({ role: r.role, ...seatRow(r.planned, (seat[gi][r.role] || []).filter((p) => teamKey(p.team) === teamKey(t.name))) }));
        return { name: t.name, rows: trows, planned: trows.reduce((s, r) => s + r.planned, 0), filled: trows.reduce((s, r) => s + r.filled, 0), vacant: trows.reduce((s, r) => s + r.vacant, 0) };
      });
      teamless = roles.map((role) => ({ role, people: (seat[gi][role] || []).filter((p) => !keys.includes(teamKey(p.team))) })).filter((x) => x.people.length);
    }
    return { name: g.name, departments: g.departments, rows, ...(teams ? { teams, teamless } : {}), planned: rows.reduce((s, r) => s + r.planned, 0), filled: rows.reduce((s, r) => s + r.filled, 0), vacant: rows.reduce((s, r) => s + r.vacant, 0) };
  });
  return { groups, totals: { planned, filled, vacant, leaving }, plan, roles: ROLES };
}

// ---- the teams of a department, for the other HRMS dashboard charts (who came to work, employee performance) ----
// Map(lowercase department -> [team names, in plan order]) of the departments the plan splits into teams (today: Education -> Team A, Team B).
async function teamsByDepartment() {
  const m = new Map();
  (await readPlan()).forEach((g) => {
    if (!Array.isArray(g.teams) || !g.teams.length) return;
    g.departments.forEach((d) => { if (!m.has(low(d))) m.set(low(d), g.teams.map((t) => t.name)); });
  });
  return m;
}

module.exports = { view, readPlan, savePlan, cleanPlan, roleOf, teamKey, teamsByDepartment, teamNameOf, NO_TEAM, DEFAULT_PLAN, PLAN_KEY };
