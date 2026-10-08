// ---------------------------------------------------------------------------
// THE BDE DESK — which department's clients a BDE works (user, 2026-10-08).
//
//   BDE TL                       every client
//   BDE, BDE desk                their own clients (assigned / Owner BDE)
//   BDE, Manufacturing desk      Manufacturing's clients (+ their own)
//   BDE, Medical / Education …   that department's clients (+ their own)
//
// Every BDE sits in the BDE department; the desk they work for is written in
// their team, designation or seat code — "BDE MFG", "BDE (Education)",
// "BDE MFG-2", "EDU BDE 1" — or set as a scope department on
// Administration -> Users. Department names are spelt several ways across
// the data ("Education" / "Educational", "Manufacture" / "MFG"), so both
// sides are reduced to one canonical desk before they are compared.
// ---------------------------------------------------------------------------

// Ordered: the first match wins.
const DESK_RULES = [
  [/manufac|\bmfg\b/i, 'Manufacturing'],
  [/\bmedical\b|\bmed\b/i, 'Medical'],
  [/\beducation(al)?\b|\bedu\b/i, 'Education'],
  [/\bnon[\s-]*it\b/i, 'Non IT'],
  [/\bit\b/i, 'IT'],
  [/r\s*&\s*d/i, 'R&D'],
];

// One department name -> its canonical desk ('BDE' for the BDE department
// itself), or null when it names none.
function canonicalDepartment(name) {
  const v = String(name || '').trim();
  if (!v) return null;
  if (/^bde$/i.test(v) || /^business development$/i.test(v)) return 'BDE';
  const hit = DESK_RULES.find(([re]) => re.test(v));
  return hit ? hit[1] : v;
}

// Free text (a team, a designation, a seat code) -> the desks it names.
// "BDE" alone names none: it is the department every BDE sits in.
function desksInText(text) {
  const v = String(text || '');
  if (!v.trim()) return [];
  const hit = DESK_RULES.find(([re]) => re.test(v));
  return hit ? [hit[1]] : [];
}

// The desks a BDE works, from their scope departments and the free text
// around them. Never contains 'BDE'.
function bdeDesks({ departments = [], texts = [] } = {}) {
  const out = new Set();
  departments.forEach((d) => {
    const c = canonicalDepartment(d);
    if (c && c !== 'BDE') out.add(c);
  });
  texts.forEach((t) => desksInText(t).forEach((d) => out.add(d)));
  return [...out];
}

// A TL of the BDE department: sees every client.
function isBdeDepartment(departments = []) {
  return departments.some((d) => canonicalDepartment(d) === 'BDE');
}

module.exports = { canonicalDepartment, desksInText, bdeDesks, isBdeDepartment };
