'use strict';
// ---------------------------------------------------------------------------
// SALARY AT ADD EMPLOYEE (founder 2026-11-24: Add Employee gets a "Salary status" - Package or Stipend - and a Package shows the
// Monthly CTC; "when the field is set up it updates on the payroll module for the monthly calculation").
//
// What Add Employee types is saved as the employee's FIRST salary structure, in exactly the form Payroll & Compensation > Salary Structure
// saves it (a SalaryStructureVersion, then the SalaryStructure mirror), so the monthly Calculate reads it with nothing to enter twice:
//   Package  Monthly CTC x 12 = the annual CTC, split into Basic / HRA / Bonus / Special / PF / PT by the company's CTC rules
//            (utils/salaryRules.js through salaryVersions.buildComponents) - the same split the Salary Structure screen makes.
//   Stipend  one flat monthly stipend.
// It takes effect from the joining month (the rule of a first structure on the Salary Structure screen), so the month the person joins
// in is calculated from it. Nothing is calculated or paid here: HR still presses Calculate, and the record shows in Process Payroll.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const SV = require('./salaryVersions');
const { logAudit } = require('./audit');

const MODES = ['Package', 'Stipend'];
const MAX_MONTHLY = 10000000; // a typing slip (an extra zero or two) is refused, not saved

const text = (v) => (v === undefined || v === null ? '' : String(v).trim());
const amount = (v) => {
  const t = text(v).replace(/,/g, '');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
};

// The Add Employee body -> { plan: null } (no salary asked), { plan: { payMode, monthlyCtc | monthlyStipend } } or { error }. Pure.
function planFrom(body) {
  const b = body || {};
  const mode = text(b.salaryMode);
  if (!mode) return { plan: null };
  if (!MODES.includes(mode)) return { error: 'Salary status must be Package or Stipend.' };
  if (mode === 'Package') {
    const n = amount(b.monthlyCtc);
    if (n === null) return { error: 'Enter the Monthly CTC for a Package.' };
    if (!(n > 0)) return { error: 'The Monthly CTC must be a number above 0.' };
    if (n > MAX_MONTHLY) return { error: 'That Monthly CTC looks too large. Check the number of zeros.' };
    return { plan: { payMode: 'Package', monthlyCtc: Math.round(n) } };
  }
  const n = amount(b.monthlyStipend);
  if (n === null) return { error: 'Enter the monthly stipend.' };
  if (!(n > 0)) return { error: 'The monthly stipend must be a number above 0.' };
  if (n > MAX_MONTHLY) return { error: 'That stipend looks too large. Check the number of zeros.' };
  return { plan: { payMode: 'Stipend', monthlyStipend: Math.round(n) } };
}

// The first day of the joining month ('YYYY-MM-01'); no joining date -> this month. Pure.
function effectiveFromFor(dateOfJoining, now = new Date()) {
  const d = dateOfJoining ? new Date(dateOfJoining) : null;
  const base = d && !Number.isNaN(d.getTime()) ? d : now;
  return `${base.toISOString().slice(0, 7)}-01`;
}

// The version row for a plan, split by the company's rules (cfg = the HrConfig row). Pure.
function dataFor(plan, cfg) {
  return SV.buildComponents({
    payMode: plan.payMode,
    annualCtc: plan.payMode === 'Package' ? plan.monthlyCtc * 12 : 0,
    bonus: undefined,
    overrides: {},
    stipend: plan.payMode === 'Stipend' ? plan.monthlyStipend : 0,
    cfg,
    esiApplicable: null,
    tds: null,
    otherDeductions: 0,
  });
}

// Saves the first structure of a just-created employee. NEVER throws: the employee already exists, so a failure here is reported back in
// words (HR then sets the salary on the Salary Structure screen) rather than breaking the whole create.
async function createFirst({ employee, plan, actor }) {
  try {
    const { getPolicy } = require('./payrollEngine'); // eslint-disable-line global-require -- (the engine reads this module's neighbours; no cycle at load)
    const cfg = await getPolicy();
    const effectiveFrom = effectiveFromFor(employee.dateOfJoining);
    const data = dataFor(plan, cfg);
    const version = await prisma.salaryStructureVersion.create({
      data: { employeeId: employee.id, effectiveFrom, createdBy: actor && actor.name ? actor.name : null, note: 'Set when the employee was added', ...data },
    });
    const structure = await SV.relink(employee.id);
    await logAudit({
      userId: actor && actor.id ? actor.id : null, action: 'Salary structure version created', entity: 'SalaryStructure', entityId: structure ? structure.id : version.id,
      toValue: `effective ${effectiveFrom.slice(0, 7)} · ${plan.payMode === 'Package' ? `CTC ${plan.monthlyCtc}/month` : `stipend ${plan.monthlyStipend}/month`} (set at Add Employee)`,
    });
    return {
      ok: true, payMode: plan.payMode, monthlyCtc: plan.monthlyCtc || null, monthlyStipend: plan.monthlyStipend || null,
      effectiveFrom, basic: data.basic, hra: data.hra, bonus: data.bonus, specialAllowance: data.specialAllowance,
    };
  } catch (err) {
    return { ok: false, message: `The salary could not be saved (${err.message}). Set it under Payroll > Salary Structure.` };
  }
}

module.exports = { MODES, planFrom, effectiveFromFor, dataFor, createFirst };
