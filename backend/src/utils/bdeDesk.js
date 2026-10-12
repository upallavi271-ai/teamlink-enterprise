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

// ---------------------------------------------------------------------------
// SEAT CODES (user, 2026-10-09). A BDE sits in a seat whose code names the
// desk it works: BDE-EDU-1, BDE-EDU-2, BDE-MED, BDE-MFG, BDE-TL … (also
// written "BDE MFG-2", "EDU BDE 1"). ONE helper turns a code into
//   desk   the canonical department the BDE's clients belong to
//          ('Education' / 'Medical' / 'Manufacturing' / 'IT' …), or null
//   isTl   the BDE team lead's seat (sees every client)
//   label  what people read: "BDE EDU 1", "BDE MED", "BDE TL"
// ---------------------------------------------------------------------------
function seatTokens(code) {
  return String(code || '').split(/[\s_\-/]+/).map((t) => t.trim()).filter(Boolean);
}

// A seat (code string, or { code, name, team, department }) -> its BDE parts.
// isBde is false for any seat that is not a BDE seat (MED-1, MFG TL, HR …).
function parseBdeSeat(seat) {
  const code = typeof seat === 'string' ? seat : (seat && seat.code) || '';
  const tokens = seatTokens(code);
  const isBde = tokens.some((t) => /^bde$/i.test(t));
  if (!isBde) return { isBde: false, desk: null, isTl: false, code, label: String(code || '').replace(/[-_]+/g, ' ').trim() };
  const rest = tokens.filter((t) => !/^bde$/i.test(t));
  const isTl = rest.some((t) => /^tl$/i.test(t));
  let desk = null;
  rest.some((t) => { const d = desksInText(t)[0]; if (d) { desk = d; return true; } return false; });
  // The seat's own name / team can name the desk when the code does not
  // ("BDE-1" named "Medical BDE") — never the department field: every BDE seat
  // sits in the BDE department.
  if (!desk && seat && typeof seat === 'object' && !isTl) desk = desksInText(`${seat.name || ''} ${seat.team || ''}`)[0] || null;
  return { isBde: true, desk, isTl, code, label: ['BDE', ...rest.map((t) => t.toUpperCase())].join(' ') };
}

// The department a BDE seat works for ('Education' for BDE-EDU-1), null for a
// seat that names none (BDE-1, BDE-TL, BDE FIELD) or is not a BDE seat.
function deptOfBdeSeat(seat) {
  const p = parseBdeSeat(seat);
  return p.isBde && !p.isTl ? p.desk : null;
}

// "BDE-EDU-1" -> "BDE EDU 1"
function seatLabel(code) {
  return parseBdeSeat(code).label;
}

module.exports = { canonicalDepartment, desksInText, bdeDesks, isBdeDepartment, parseBdeSeat, deptOfBdeSeat, seatLabel };
