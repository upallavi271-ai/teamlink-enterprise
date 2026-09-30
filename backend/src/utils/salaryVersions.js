// ---------------------------------------------------------------------------
// VERSIONED SALARY STRUCTURES (SPEC B §2).
//
// Every revision of an employee's pay is a SalaryStructureVersion row with an
// effectiveFrom (always the 1st of a month) and an effectiveTo (the day before
// the next version starts; null on the latest). Payroll for month M reads the
// version whose effectiveFrom is the latest one on or before M-01.
//
// SalaryStructure (one row per employee, unique) is kept as the CURRENT
// version — a mirror of the latest version — so every existing reader of
// employee.salaryStructure (the structures table, My Salary Structure, the
// employee profile) keeps working unchanged.
//
// A revision may not take effect on a month whose payroll for that employee is
// already beyond DRAFT: that is what guarantees a later revision never changes
// a past run. (The run also stores a full snapshot of its amounts.)
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { computeStructure, professionalTaxFor } = require('./salaryRules');

const pad = (n) => String(n).padStart(2, '0');

// 'YYYY-MM' | 'YYYY-MM-DD' -> 'YYYY-MM-01', or null when unreadable.
function monthStart(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
  if (!m) return null;
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  return `${m[1]}-${m[2]}-01`;
}

function lastDayOf(month) { // 'YYYY-MM' -> 'YYYY-MM-DD'
  const [y, m] = String(month).split('-').map(Number);
  return `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
}

function dayBefore(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ESI for a full-month gross. `esiApplicable` null = automatic (gross at or
// under the configured ceiling, and ESI switched on). Amounts round UP to the
// rupee, as ESIC computes them.
function esiFor(gross, cfg, esiApplicable = null) {
  const g = Math.max(0, Number(gross) || 0);
  const enabled = cfg ? cfg.esiEnabled !== false : true;
  const ceiling = Number(cfg && cfg.esiGrossCeiling != null ? cfg.esiGrossCeiling : 21000);
  const applicable = esiApplicable === true || esiApplicable === false
    ? esiApplicable
    : (enabled && g > 0 && g <= ceiling);
  if (!applicable || g <= 0) return { applicable: !!applicable, employee: 0, employer: 0 };
  const ePct = Number(cfg && cfg.esiEmployeePct != null ? cfg.esiEmployeePct : 0.75);
  const rPct = Number(cfg && cfg.esiEmployerPct != null ? cfg.esiEmployerPct : 3.25);
  return {
    applicable: true,
    employee: Math.ceil(Math.round(g * ePct) / 100),
    employer: Math.ceil(Math.round(g * rPct) / 100),
  };
}

// The version effective in `month` ('YYYY-MM') for one employee.
async function versionFor(employeeId, month, db = prisma) {
  return db.salaryStructureVersion.findFirst({
    where: { employeeId, effectiveFrom: { lte: `${month}-01` } },
    orderBy: { effectiveFrom: 'desc' },
  });
}

// The same for many employees at once: Map(employeeId -> version).
async function versionsFor(employeeIds, month, db = prisma) {
  const rows = await db.salaryStructureVersion.findMany({
    where: { employeeId: { in: employeeIds }, effectiveFrom: { lte: `${month}-01` } },
    orderBy: { effectiveFrom: 'asc' },
  });
  const map = new Map();
  rows.forEach((v) => map.set(v.employeeId, v)); // ascending, so the last wins
  return map;
}

const MIRRORED = [
  'payMode', 'ctc', 'stipend', 'basic', 'hra', 'bonus', 'specialAllowance', 'employerPf', 'employeePf',
  'professionalTax', 'gratuity', 'esiApplicable', 'esiEmployee', 'esiEmployer', 'tds', 'otherDeductions',
  'effectiveFrom', 'effectiveTo',
];

// Re-chain effectiveTo across an employee's versions and mirror the latest
// into SalaryStructure (the "current version").
async function relink(employeeId, db = prisma) {
  const versions = await db.salaryStructureVersion.findMany({ where: { employeeId }, orderBy: { effectiveFrom: 'asc' } });
  for (let i = 0; i < versions.length; i += 1) {
    const next = versions[i + 1];
    const to = next ? dayBefore(next.effectiveFrom) : null;
    if (versions[i].effectiveTo !== to) {
      // Raw, so re-chaining the dates does not bump updatedAt: updatedAt means
      // "the pay figures changed", which is what marks a draft as stale.
      // eslint-disable-next-line no-await-in-loop
      await db.$executeRaw`UPDATE "SalaryStructureVersion" SET "effectiveTo" = ${to} WHERE "id" = ${versions[i].id}`;
      versions[i] = { ...versions[i], effectiveTo: to };
    }
  }
  const latest = versions[versions.length - 1];
  if (!latest) {
    await db.salaryStructure.deleteMany({ where: { employeeId } });
    return null;
  }
  const data = { currentVersionId: latest.id };
  MIRRORED.forEach((k) => { data[k] = latest[k]; });
  return db.salaryStructure.upsert({ where: { employeeId }, update: data, create: { employeeId, ...data } });
}

// The latest month whose payroll for this employee is beyond DRAFT, or null.
async function lastLockedMonth(employeeId, db = prisma) {
  const row = await db.employeePayrollRun.findFirst({
    where: { employeeId, status: { not: 'DRAFT' } },
    orderBy: { month: 'desc' },
    select: { month: true, status: true },
  });
  return row || null;
}

// Component values for a new version: the CTC split pre-fills everything,
// HR's typed overrides win, then ESI follows from the resulting gross.
function buildComponents({ payMode, annualCtc, bonus, overrides = {}, stipend, cfg, esiApplicable, tds, otherDeductions }) {
  const out = { payMode };
  if (payMode === 'Stipend') {
    Object.assign(out, {
      ctc: 0, stipend: Number(stipend) || 0, basic: 0, hra: 0, bonus: 0, specialAllowance: 0,
      employerPf: 0, employeePf: 0, professionalTax: 0, gratuity: 0,
      esiApplicable: esiApplicable === true ? true : (esiApplicable === false ? false : null),
      esiEmployee: 0, esiEmployer: 0,
    });
  } else {
    const b = computeStructure((Number(annualCtc) || 0) / 12, cfg, { bonus });
    Object.assign(out, {
      ctc: Number(annualCtc) || 0, stipend: 0,
      basic: b.basic, hra: b.hra, bonus: b.bonus, specialAllowance: b.special,
      employerPf: b.employerPf, employeePf: b.employeePf, professionalTax: b.professionalTax, gratuity: b.gratuity,
    });
    Object.keys(overrides).forEach((k) => { out[k] = overrides[k]; });
    const gross = out.basic + out.hra + out.bonus + out.specialAllowance;
    // PT follows the gross unless HR typed it.
    if (overrides.professionalTax === undefined) out.professionalTax = professionalTaxFor(gross);
    const esi = esiFor(gross, cfg, esiApplicable);
    out.esiApplicable = esiApplicable === true || esiApplicable === false ? esiApplicable : null;
    out.esiEmployee = esi.employee;
    out.esiEmployer = esi.employer;
  }
  out.tds = tds === null || tds === undefined || tds === '' ? null : Math.max(0, Math.round(Number(tds) || 0));
  out.otherDeductions = Math.max(0, Math.round(Number(otherDeductions) || 0));
  return out;
}

module.exports = {
  monthStart, lastDayOf, dayBefore, esiFor, versionFor, versionsFor, relink, lastLockedMonth, buildComponents,
};
