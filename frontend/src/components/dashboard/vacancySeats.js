// Names for the VACANT SEATS in the Vacancies table (founder 2026-11-16: "when I click vacant, it shows the position, for example Edu-1, Med-1").
// A seat is "<department code>-<number>": the people working take seats 1, 2, 3 ... of that department and role, so the vacant ones are the
// numbers after them. Education TL: should have 2, working 1, vacant 1 -> "Edu-2". A team of a department adds its letter: Education,
// Team A -> "Edu-A-1". Plain code, no JSX, so scripts/vacancy-seats-test.mjs can run it with Node.

// "Education" -> Edu, "Medical + Manufacturing" -> Med+Man, "Non IT Medical" -> NIM, "BDE" -> BDE, "R&D" -> R&D
export function deptCode(name) {
  return String(name || '').trim().split(/\s*\+\s*/).map((part) => {
    const words = part.replace(/[^A-Za-z0-9& ]/g, ' ').split(/\s+/).filter(Boolean);
    if (!words.length) return '';
    if (words.length > 1) return words.map((w) => w[0].toUpperCase()).join('');
    const w = words[0];
    if (w.length <= 3 || w === w.toUpperCase()) return w;
    return w.charAt(0).toUpperCase() + w.slice(1, 3).toLowerCase();
  }).filter(Boolean).join('+');
}

// "Team A" -> A, "Team 2" -> 2, "Night shift" -> N
export function teamCode(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const last = words[words.length - 1];
  return last.length <= 2 ? last.toUpperCase() : words[0].charAt(0).toUpperCase();
}

// the vacant seats of one table row: { planned, vacant } -> ["Edu-2", "Edu-3"]; no vacancy -> []
export function seatCodes(code, row) {
  const vacant = Math.max(0, Number(row && row.vacant) || 0);
  const planned = Math.max(0, Number(row && row.planned) || 0);
  const first = Math.max(1, planned - vacant + 1);
  return Array.from({ length: vacant }, (_, i) => `${code}-${first + i}`);
}

// WHICH POSITIONS ARE VACANT, DEPARTMENT BY DEPARTMENT (founder 2026-11-13: "dashboard lo vacancies card lo positions wise vacancies em unai,
// ahh department lo kavali"; 2026-11-16: "the position on the dashboard is not updated" = the card must show the seat names too):
// one line per department (or per team of a department that is split into teams), listing only the positions (STL / TL / Employee) that
// still have a vacancy, with the seat names the table's Vacant click shows: "Medical: TL 1 (Med-2) · Employee 2 (Med-4, Med-5)".
export function vacantByDepartment(d) {
  const out = [];
  ((d && d.groups) || []).forEach((g) => {
    const dc = deptCode(g.name);
    const parts = (rows, code) => (rows || []).filter((r) => r.vacant > 0).map((r) => ({ role: r.role, n: r.vacant, seats: seatCodes(code, r) }));
    // a department split into teams: its TL / Employee rows are the teams added together, so show the teams (and the roles the teams do not plan, the STL)
    const split = new Set((g.teams || []).flatMap((t) => t.rows.map((r) => r.role)));
    const own = parts((g.rows || []).filter((r) => !split.has(r.role)), dc);
    if (own.length) out.push({ label: g.name, parts: own });
    (g.teams || []).forEach((t) => { const p = parts(t.rows, [dc, teamCode(t.name)].filter(Boolean).join('-')); if (p.length) out.push({ label: `${g.name} · ${t.name}`, parts: p }); });
  });
  return out;
}
