// TEAM NAMES (founder 2026-11-12: Education has Team A and Team B; the vacancies, "who came to work" and "employee performance" charts show them team wise).
// Employee.team is free text ("Team-A", "Team A", "team a"): those are one team. Pure, no database, so charts and tests can use it on its own.
const teamKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); // "Team-A" -> "teama"
const NO_TEAM = 'No team set';
// which of a department's team names a person belongs to, or NO_TEAM when it is blank or not one of them
const teamNameOf = (names, team) => { const k = teamKey(team); return (k && names.find((n) => teamKey(n) === k)) || NO_TEAM; };
// the team names that have people, in plan order, "No team set" last: Map(name -> items)
function splitByTeam(names, items, teamOf) {
  const by = new Map();
  items.forEach((it) => { const n = teamNameOf(names, teamOf(it)); if (!by.has(n)) by.set(n, []); by.get(n).push(it); });
  return [...names, NO_TEAM].filter((n) => by.has(n)).map((n) => ({ name: n, items: by.get(n) }));
}
module.exports = { teamKey, NO_TEAM, teamNameOf, splitByTeam };
