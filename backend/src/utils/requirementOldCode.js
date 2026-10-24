// ---------------------------------------------------------------------------
// THE OLD REQUIREMENT CODES (2026-10-22)
//
// Every requirement now carries one series, REQ-xxxx. The codes it was known by before (EDU-0412, MED-2835, MFG-..., ITR-...) live in
// RequirementOldCode (requirementId, oldCode, oldKey). An old code is for FINDING a requirement only, never for display: typing MED-2835
// in a search must still open that requirement, every screen shows the REQ code.
//
//   const OC = require('../utils/requirementOldCode');
//   and.push({ OR: [{ reqCode: { contains: s } }, await OC.idTerm(s)] });   // -> { id: { in: [...] } }
//
// The table is created by scripts/renumber-requirement-codes-2026-10-22.js; until it exists every call answers "nothing found".
// ---------------------------------------------------------------------------
const prisma = require('../db');

const keyOf = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function idsOf(term) {
  const k = keyOf(term);
  if (k.length < 3) return [];
  try {
    const rows = await prisma.$queryRawUnsafe('SELECT requirementId FROM RequirementOldCode WHERE oldKey LIKE ? LIMIT 200', `%${k}%`);
    return rows.map((r) => r.requirementId);
  } catch (e) {
    return []; // table not there yet
  }
}

// a Prisma where fragment on Requirement: ids whose old code matches the term
async function idTerm(term) {
  return { id: { in: await idsOf(term) } };
}

// the old codes of some requirements, for a detail screen: Map<requirementId, string[]>
async function oldCodesOf(ids) {
  const list = [...new Set((ids || []).filter(Boolean))];
  const out = new Map();
  if (!list.length) return out;
  try {
    const rows = await prisma.$queryRawUnsafe(`SELECT requirementId, oldCode FROM RequirementOldCode WHERE requirementId IN (${list.map(() => '?').join(',')})`, ...list);
    rows.forEach((r) => { out.set(r.requirementId, [...(out.get(r.requirementId) || []), r.oldCode]); });
  } catch (e) { /* table not there yet */ }
  return out;
}

module.exports = { keyOf, idsOf, idTerm, oldCodesOf };
