// ---------------------------------------------------------------------------
// ONE JOININGS CARD PER TEAM (founder 2026-11-20, Education: "Team A joinings" and "Team B joinings", in both TLs' logins).
//
// A TL / STL "My Team" dashboard of a department whose seats are split into 2+ teams (Position.team: "Team A", "Team B") shows one
// joinings card per team instead of the single "My team's joinings" card. Both teams' cards are in every lead's login of the department.
//
//   THE NUMBER  utils/recruiterJoinings.js creditedJoinings (the ONE joinings function), at the "all" level, for the dashboard's dates
//               and the department's seats: each joining goes to the team of the SEAT of the recruiter it is credited to, so the cards
//               add up to the department's joinings. A person who joined and left is not in the number (utils/joinedRule.js): the card
//               says "Still working: N / left after joining: M". A seat with no team: an "Other" card, only when it has joinings.
//   THE LISTS   candidate, requirement, client, recruiter, joining date - nothing else (no phone, email, pay, resume, profile link):
//               a lead sees the OTHER team's joiners too (founder's decision), but only these columns. Kind "tjoin" in utils/atsHome.js.
//   A department with ONE team keeps the single card (cardsFor returns null).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const RJ = require('./recruiterJoinings');
const { atsScopeOf } = require('./scope');

const norm = (s) => String(s || '').trim().toLowerCase();
const byName = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });

// department (normalised) -> { name, teams: Map(normalised team -> team name) }, read every minute
let CACHE = { at: 0, value: null };
async function seatsByDepartment() {
  if (CACHE.value && Date.now() - CACHE.at < 60000) return CACHE.value;
  const ps = await prisma.position.findMany({ select: { code: true, department: true, team: true } });
  const depts = new Map();
  const seatOf = new Map();
  ps.forEach((p) => {
    if (!p.department) return;
    const dk = norm(p.department);
    if (!depts.has(dk)) depts.set(dk, { name: String(p.department).trim(), teams: new Map() });
    const team = p.team && String(p.team).trim() ? String(p.team).trim() : null;
    if (team) depts.get(dk).teams.set(norm(team), team);
    seatOf.set(String(p.code).toUpperCase(), { dk, team });
  });
  CACHE = { at: Date.now(), value: { depts, seatOf } };
  return CACHE.value;
}
const reset = () => { CACHE = { at: 0, value: null }; };

// The departments this lead leads: the seats' departments, else the departments of the scope.
function departmentsOf(sc) {
  const p = sc.positions;
  const names = p && Array.isArray(p.departments) && p.departments.length ? p.departments : (sc.departments || []);
  return [...new Set(names.filter(Boolean).map((d) => norm(d)))];
}

// A joining against the page's filters (the ones a joining can answer).
function passes(a, f) {
  if (!f) return true;
  if (f.clientId && a.clientId !== f.clientId) return false;
  if (f.requirementId && a.requirementId !== f.requirementId) return false;
  if (f.department && (f.department === '__none__' ? !!a.reqDepartment : a.reqDepartment !== f.department)) return false;
  if (f.hiring && !!a.internal !== (f.hiring === 'internal')) return false;
  if (f.recruiter && String(f.recruiter).startsWith('u:') && `u:${(a.creditedTo || {}).userId}` !== f.recruiter) return false;
  return true;
}

// The ONLY columns a team joinings list carries.
const safeRow = (a) => ({
  id: a.id,
  candidate: a.candidate || '—',
  requirement: a.job || '—',
  reqCode: a.jobCode || null,
  client: a.client || null,
  recruiter: (a.creditedTo && a.creditedTo.name) || null,
  joiningDate: a.joiningDate || null,
});

/**
 * The team cards for a TL / STL login, or null when none of their departments has 2+ teams (the single card stays).
 * `c` is the dashboard context (user, period, prev, noPrev, f).
 * -> [{ key, label, team, department, mine, count, prevCount, leftCount, rows[], leftRows[] }]
 */
async function cardsFor(c) {
  const { user } = c;
  const sc = atsScopeOf(user);
  if (!['TL', 'STL'].includes(sc.atsRole)) return null;
  const { depts, seatOf } = await seatsByDepartment();
  const mineDepts = departmentsOf(sc).filter((d) => depts.has(d));
  const multiDepts = mineDepts.filter((d) => depts.get(d).teams.size > 1);
  if (!multiDepts.length) return null;

  // the groups, in order: each department's teams (A, B, ...), then its "Other"; a one-team department is one group
  const groups = [];
  const manyDepts = mineDepts.length > 1;
  mineDepts.forEach((dk) => {
    const d = depts.get(dk);
    if (d.teams.size > 1) {
      [...d.teams.values()].sort(byName).forEach((t) => groups.push({ key: `${dk}|${norm(t)}`, team: t, department: d.name, label: manyDepts ? `${d.name} ${t}` : t }));
      groups.push({ key: `${dk}|`, team: null, department: d.name, label: manyDepts ? `${d.name} other` : 'Other', other: true });
    } else {
      groups.push({ key: `${dk}|*`, team: null, department: d.name, label: d.name, single: true });
    }
  });
  // the viewer's own team: the team of the seat they hold
  const ownCodes = (sc.positions && sc.positions.ownPositionCodes) || [];
  const ownKeys = new Set(ownCodes.map((code) => seatOf.get(String(code).toUpperCase())).filter((s) => s && s.team && multiDepts.includes(s.dk)).map((s) => `${s.dk}|${norm(s.team)}`));

  const keyOf = (a) => {
    const cr = a.creditedTo || {};
    const dk = norm(cr.department);
    if (!mineDepts.includes(dk)) return null;
    const d = depts.get(dk);
    if (d.teams.size < 2) return `${dk}|*`;
    const t = norm(cr.team);
    return d.teams.has(t) ? `${dk}|${t}` : `${dk}|`;
  };
  const read = (cj) => {
    const out = new Map(groups.map((g) => [g.key, { rows: [], left: [] }]));
    (cj.list || []).filter((a) => passes(a, c.f)).forEach((a) => { const k = keyOf(a); if (k && out.has(k)) out.get(k).rows.push(a); });
    (cj.left || []).filter((a) => passes(a, c.f)).forEach((a) => { const k = keyOf(a); if (k && out.has(k)) out.get(k).left.push(a); });
    return out;
  };
  const cur = read(await RJ.creditedJoinings(user, { from: c.period.from, to: c.period.to, level: 'all' }));
  const prev = c.noPrev ? null : read(await RJ.creditedJoinings(user, { from: c.prev.from, to: c.prev.to, level: 'all' }));

  const cards = groups.map((g) => {
    const x = cur.get(g.key);
    return {
      key: g.key, label: g.label, team: g.team, department: g.department, mine: ownKeys.has(g.key), other: !!g.other, single: !!g.single,
      count: x.rows.length, prevCount: prev ? prev.get(g.key).rows.length : null,
      leftCount: x.left.length, rows: x.rows.map(safeRow), leftRows: x.left.map(safeRow),
    };
  }).filter((x) => !(x.other && !x.count && !x.leftCount));
  // the viewer's own team first, the rest in order (the sort is stable)
  cards.sort((a, b) => (b.mine ? 1 : 0) - (a.mine ? 1 : 0));
  return cards;
}

module.exports = { cardsFor, reset, safeRow, seatsByDepartment };
