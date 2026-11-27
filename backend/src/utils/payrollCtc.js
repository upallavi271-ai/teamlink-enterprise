// ---------------------------------------------------------------------------
// THE MONTHLY CTC OF A PAYROLL RECORD (founder 2026-11-27, with "Pay Register for Oct 2026.xlsx": "add a Monthly CTC column in the payroll
// process; the actual monthly CTC must be visible").
//
// The team's pay register states each person's Monthly CTC (their package per month, with the employer's PF / ESI inside). TeamLink's salary
// structures were built from the register's EARNING columns, so their `ctc` does not always equal that figure. What a record shows, in order:
//   1. the register's own Monthly CTC for that record's month (importedBreakup.sheet.monthlyCtc, or the figures loaded for the month with
//      scripts/payroll-ctc-from-register.js: AppSetting 'payroll.registerCtc:<month>' = { file, loadedOn, people: { employeeId: amount } })
//   2. else the LATEST earlier register figure of that person - unless their salary was revised after that register month (a salary
//      structure effective in a later month), when the revision counts
//   3. else the salary structure the record was worked out from: Package = annual CTC / 12, Stipend = the stipend
// Reads only; nothing in the salary structures or the payroll records is changed.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const PREFIX = 'payroll.registerCtc:';
const keyOf = (month) => `${PREFIX}${month}`;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const positive = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? r2(n) : null; };

function fromBreakup(json) {
  if (!json) return null;
  try { const b = JSON.parse(json); return b && b.sheet ? positive(b.sheet.monthlyCtc) : null; } catch { return null; }
}
function fromVersion(v) {
  if (!v) return null;
  return v.payMode === 'Stipend' ? positive(v.stipend) : positive(Number(v.ctc) / 12);
}

// -> [{ month, file, people: {employeeId: amount} }] oldest first
async function registerMonths() {
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: PREFIX } } }).catch(() => []);
  return rows.map((r) => {
    try { const v = JSON.parse(r.value); return { month: r.key.slice(PREFIX.length), file: v.file || null, people: v.people || {} }; } catch { return null; }
  }).filter(Boolean).sort((a, b) => a.month.localeCompare(b.month));
}

// entries: EmployeePayrollRun rows (id, employeeId, month, importedBreakup, salaryVersionId).
// -> Map(entry.id -> { value, from: 'register' | 'structure', month (the register's month), file }) ; no entry in the map = not known.
async function monthlyCtcFor(entries) {
  const out = new Map();
  if (!entries.length) return out;
  const ids = [...new Set(entries.map((e) => e.employeeId))];
  const [registers, earlier, versions] = await Promise.all([
    registerMonths(),
    // earlier imported records may carry the figure in their own register cells
    prisma.employeePayrollRun.findMany({ where: { employeeId: { in: ids }, importedBreakup: { contains: 'monthlyCtc' } }, select: { employeeId: true, month: true, importedBreakup: true } }),
    prisma.salaryStructureVersion.findMany({ where: { employeeId: { in: ids } }, select: { id: true, employeeId: true, effectiveFrom: true, effectiveTo: true, payMode: true, ctc: true, stipend: true } }),
  ]);
  const byId = new Map(versions.map((v) => [v.id, v]));
  // the structure in force in a month = the latest one effective on or before it
  const inForce = (employeeId, month) => versions.filter((v) => v.employeeId === employeeId && String(v.effectiveFrom).slice(0, 7) <= month)
    .sort((a, b) => String(b.effectiveFrom).localeCompare(String(a.effectiveFrom)))[0] || null;
  entries.forEach((e) => {
    // the newest register figure of this person at or before the record's month
    let reg = null;
    const consider = (month, value, file) => { if (value && month <= e.month && (!reg || month >= reg.month)) reg = { month, value, file }; };
    earlier.filter((x) => x.employeeId === e.employeeId).forEach((x) => consider(x.month, fromBreakup(x.importedBreakup), null));
    registers.forEach((r) => consider(r.month, positive(r.people[e.employeeId]), r.file));
    consider(e.month, fromBreakup(e.importedBreakup), null);
    // revised after that register month? then the revision counts
    const current = inForce(e.employeeId, e.month);
    const revised = reg && current && String(current.effectiveFrom).slice(0, 7) > reg.month;
    if (reg && !revised) { out.set(e.id, { value: reg.value, from: 'register', month: reg.month, file: reg.file }); return; }
    const v = (revised ? current : (e.salaryVersionId && byId.get(e.salaryVersionId))) || current;
    const value = fromVersion(v);
    if (value) out.set(e.id, { value, from: 'structure', month: null, file: null });
  });
  return out;
}

module.exports = { PREFIX, keyOf, fromBreakup, fromVersion, registerMonths, monthlyCtcFor };
