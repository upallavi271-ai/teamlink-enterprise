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
