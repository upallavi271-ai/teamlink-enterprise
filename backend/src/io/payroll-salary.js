// ---------------------------------------------------------------------------
// PAYROLL — SALARY STRUCTURES: export (the payroll register in scope / one
// employee) and import (utils/moduleIo.js contract).
//
// Salary is the most sensitive record in HRMS, so this spec is gated like the
// Salary Structure screen itself: export AND import need Payroll &
// Compensation / EDIT (the right GET/PUT /api/payroll/structure ask), there
// is no "export my own" fallback (My Salary Structure already shows it), and
// the employees reached are payrollEmployeeWhere()'s — the same rule the
// Salary Structure screen uses — never wider.
//
// An import writes VERSIONS, exactly as PUT /api/payroll/structure/:id does
// (utils/salaryVersions.js): one row = the structure effective from a month.
// Same employee + same month as an existing version -> that version is
// edited; a new month -> a new version (the previous one ends the day
// before). A month whose payroll is already beyond DRAFT is refused, so an
// import can never change a past run. Components are always computed from
// the Standard Package rules (utils/salaryRules.js) — they are read-only in
// the file. Blank cells keep the current value.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const io = require('../utils/moduleIo');
const SV = require('../utils/salaryVersions');
const E = require('../utils/payrollEngine');
const { structureFromRow } = require('../utils/salaryRules');
const { withoutSystemAccounts } = require('../utils/systemAccounts');

const PAY_MODES = ['Package', 'Stipend'];
const ESI = ['Auto', 'Yes', 'No'];
const COMPONENT_FIELDS = ['basic', 'hra', 'bonus', 'specialAllowance', 'employerPf', 'employeePf', 'professionalTax', 'gratuity'];
const INPUT_KEYS = ['effectiveFrom', 'payMode', 'monthlyCtc', 'stipend', 'bonus', 'tds', 'otherDeductions', 'esi', 'note'];
const pad = (n) => String(n).padStart(2, '0');

const columns = [
  { key: 'employeeCode', label: 'Employee ID', required: true, example: 'TL101', note: 'Employee ID (or email) of an employee on your payroll register.' },
  { key: 'employeeName', label: 'Employee Name', readOnly: true, example: 'Asha Rao' },
  { key: 'department', label: 'Department', readOnly: true, example: 'Medical' },
  { key: 'effectiveFrom', label: 'Effective From', required: true, example: '2026-04', note: 'The month this structure takes effect: YYYY-MM. The same month as an existing version edits that version; a new month adds a new version. A month whose payroll is already submitted / approved / paid is refused.' },
  { key: 'payMode', label: 'Pay Mode', list: 'Pay Mode', example: 'Package', note: 'Blank = the current pay mode (Package for a first structure).' },
  { key: 'monthlyCtc', label: 'Monthly CTC', type: 'number', example: 25000, note: 'Package: the monthly CTC in rupees — every component is computed from the Standard Package rules. Blank = keep the current CTC and components.' },
  { key: 'stipend', label: 'Monthly Stipend', type: 'number', example: '', note: 'Stipend pay mode only. Blank = keep the current stipend.' },
  { key: 'bonus', label: 'Bonus (monthly)', type: 'number', example: '', note: 'Blank = keep the current bonus (the policy bonus for a first structure).' },
  { key: 'tds', label: 'TDS (monthly)', type: 'number', example: '', note: 'Blank = keep the current TDS (none = the policy TDS %).' },
  { key: 'otherDeductions', label: 'Other Deductions (monthly)', type: 'number', example: '', note: 'Blank = keep the current amount.' },
  { key: 'esi', label: 'ESI', list: 'ESI', example: 'Auto', note: 'Auto = by the ESI gross ceiling; Yes / No force it. Blank = keep the current setting.' },
  { key: 'note', label: 'Note', example: 'Annual revision' },
  { key: 'effectiveTo', label: 'Effective To', readOnly: true, example: '' },
  { key: 'basic', label: 'Basic', type: 'number', readOnly: true, example: '' },
  { key: 'hra', label: 'HRA', type: 'number', readOnly: true, example: '' },
  { key: 'bonusPaid', label: 'Bonus', type: 'number', readOnly: true, example: '' },
  { key: 'special', label: 'Special Allowance', type: 'number', readOnly: true, example: '' },
  { key: 'gross', label: 'Gross', type: 'number', readOnly: true, example: '' },
  { key: 'employeePf', label: 'Employee PF', type: 'number', readOnly: true, example: '' },
  { key: 'professionalTax', label: 'Professional Tax', type: 'number', readOnly: true, example: '' },
  { key: 'esiEmployee', label: 'ESI (employee)', type: 'number', readOnly: true, example: '' },
  { key: 'net', label: 'Net (before TDS / other)', type: 'number', readOnly: true, example: '' },
  { key: 'employerPf', label: 'Employer PF', type: 'number', readOnly: true, example: '' },
  { key: 'gratuity', label: 'Gratuity', type: 'number', readOnly: true, example: '' },
];

// ---- the payroll register's employees (payrollEmployeeWhere) ----------------
async function payrollIndex(req) {
  // eslint-disable-next-line global-require
  const { payrollEmployeeWhere } = require('../routes/payroll');
  const rows = await prisma.employee.findMany({
    where: withoutSystemAccounts(payrollEmployeeWhere(req)),
    select: {
      id: true, employeeCode: true, name: true, email: true, department: true, employmentStatus: true, dateOfJoining: true,
    },
    orderBy: { name: 'asc' },
  });
  const byCode = new Map(rows.map((e) => [io.str(e.employeeCode).toUpperCase(), e]));
  const byEmail = new Map(rows.filter((e) => e.email).map((e) => [io.str(e.email).toLowerCase(), e]));
  const byId = new Map(rows.map((e) => [e.id, e]));
  return {
    list: rows,
    byId,
    resolve(value) {
      const v = io.str(value);
      if (!v) return { error: 'Employee ID is required.' };
      const e = byCode.get(v.toUpperCase()) || byEmail.get(v.toLowerCase());
      return e ? { employee: e } : { error: `Employee "${v}" is not on your payroll register (or does not exist).` };
    },
  };
}

// The employees an export covers: the whole payroll register, or — when one
// employee was asked for (the framework has already checked the HRMS scope) —
// that employee, if the register reaches them.
async function exportEmployees(ctx, employeeIds, filters) {
  const idx = await payrollIndex(ctx.req);
  if (io.str(filters.employeeId)) return (employeeIds || []).map((id) => idx.byId.get(id)).filter(Boolean);
  return idx.list;
}

// 'YYYY-MM' | 'YYYY-MM-DD' | 'MM-YYYY' | 'DD-MM-YYYY' | Excel serial -> { value: 'YYYY-MM-01' } | { empty } | { error }
function monthOf(v) {
  let s = io.str(v);
  if (!s) return { empty: true };
  if (/^\d{5}(\.\d+)?$/.test(s)) s = io.dateFromSerial(Number(s)) || s;
  let y; let m;
  let mt = /^(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?(?:[T ].*)?$/.exec(s);
  if (mt) [, y, m] = mt;
  else if ((mt = /^(\d{1,2})[-/.](\d{4})$/.exec(s))) [, m, y] = mt;
  else if ((mt = /^\d{1,2}[-/.](\d{1,2})[-/.](\d{4})$/.exec(s))) [, m, y] = mt;
  else return { error: true };
  const yy = Number(y); const mm = Number(m);
  if (mm < 1 || mm > 12 || yy < 2000 || yy > 2100) return { error: true };
  return { value: `${yy}-${pad(mm)}-01` };
}

function numberOf(r, key, label, errors) {
  const p = io.parseNumber(r[key]);
  if (p.empty) return null;
  if (p.error || p.value < 0) { errors.push({ field: label, message: `"${r[key]}" must be an amount of 0 or more.` }); return null; }
  return p.value;
}

// What a row would save, from the employee's versions (ascending) — the same
// arithmetic PUT /api/payroll/structure/:id does, with blank cells keeping the
// current value.
function plan(versions, x, cfg) {
  const eff = x.effectiveFrom;
  const sameMonth = versions.find((v) => v.effectiveFrom === eff) || null;
  const inForce = versions.filter((v) => v.effectiveFrom <= eff).pop() || null;
  const latest = versions[versions.length - 1] || null;
  const base = sameMonth || inForce || latest;
  const payMode = x.payMode || (base && base.payMode) || 'Package';
  // A new CTC or a new bonus recomputes every component from the rules;
  // otherwise the base version's stored components carry over as they are.
  const recompute = x.monthlyCtc !== null || x.bonus !== null;
  const annual = x.monthlyCtc !== null ? Math.round(x.monthlyCtc) * 12 : (base ? Number(base.ctc) || 0 : 0);
  if (payMode === 'Package' && !(annual > 0)) {
    return { error: { field: 'Monthly CTC', message: 'Monthly CTC is required — there is no current CTC to keep.' } };
  }
  const stipend = x.stipend !== null ? x.stipend : (base ? Number(base.stipend) || 0 : 0);
  if (payMode === 'Stipend' && !(stipend > 0)) {
    return { error: { field: 'Monthly Stipend', message: 'Monthly Stipend is required for the Stipend pay mode.' } };
  }
  const overrides = {};
  if (!recompute && base && payMode === 'Package' && base.payMode !== 'Stipend' && Number(base.basic) > 0) {
    COMPONENT_FIELDS.forEach((f) => { overrides[f] = Number(base[f]) || 0; });
  }
  let bonus = x.bonus !== null ? x.bonus : undefined;
  if (bonus === undefined && base && base.payMode !== 'Stipend' && Number(base.basic) > 0) bonus = Number(base.bonus) || 0;
  const esiApplicable = x.esi !== undefined ? x.esi : (base ? base.esiApplicable : null);
  const tds = x.tds !== null ? x.tds : (base ? base.tds : null);
  const otherDeductions = x.otherDeductions !== null ? x.otherDeductions : (base ? base.otherDeductions : 0);
  const data = SV.buildComponents({
    payMode, annualCtc: annual, bonus, overrides, stipend, cfg, esiApplicable, tds, otherDeductions,
  });
  data.note = x.note || (sameMonth ? sameMonth.note : null);
  return { data, sameMonth };
}

const COMPARE = [
  ['payMode', 'Pay Mode'], ['ctc', 'Monthly CTC', (v) => Math.round((Number(v) || 0) / 12)], ['stipend', 'Monthly Stipend'],
  ['basic', 'Basic'], ['hra', 'HRA'], ['bonus', 'Bonus'], ['specialAllowance', 'Special Allowance'],
  ['employeePf', 'Employee PF'], ['professionalTax', 'Professional Tax'], ['esiApplicable', 'ESI', (v) => (v === true ? 'Yes' : v === false ? 'No' : 'Auto')],
  ['esiEmployee', 'ESI (employee)'], ['tds', 'TDS', (v) => (v === null || v === undefined ? '' : v)], ['otherDeductions', 'Other Deductions'], ['note', 'Note', (v) => v || ''],
];
function diff(before, after) {
  return COMPARE.map(([k, label, f]) => {
    const fmt = f || ((v) => (v === null || v === undefined ? '' : v));
    const a = fmt(before ? before[k] : null);
    const b = fmt(after[k]);
    return String(a) === String(b) ? null : { field: label, from: a, to: b };
  }).filter(Boolean);
}

function rowOf(e, v) {
  const b = v && v.payMode !== 'Stipend' ? structureFromRow(v) : null;
  const esi = Number(v && v.esiEmployee) || 0;
  return {
    employeeCode: e.employeeCode || '',
    employeeName: e.name || '',
    department: e.department || '',
    effectiveFrom: v ? String(v.effectiveFrom).slice(0, 7) : '',
    payMode: v ? v.payMode || 'Package' : '',
    monthlyCtc: v && v.payMode !== 'Stipend' ? Math.round((Number(v.ctc) || 0) / 12) : '',
    stipend: v && v.payMode === 'Stipend' ? Number(v.stipend) || 0 : '',
    bonus: b ? b.bonus : '',
    tds: v && v.tds !== null && v.tds !== undefined ? v.tds : '',
    otherDeductions: v ? Number(v.otherDeductions) || 0 : '',
    esi: v ? (v.esiApplicable === true ? 'Yes' : v.esiApplicable === false ? 'No' : 'Auto') : '',
    note: (v && v.note) || '',
    effectiveTo: (v && v.effectiveTo) || (v ? 'current' : ''),
    basic: b ? b.basic : '',
    hra: b ? b.hra : '',
    bonusPaid: b ? b.bonus : '',
    special: b ? b.special : '',
    gross: b ? b.gross : (v ? Number(v.stipend) || 0 : ''),
    employeePf: b ? b.employeePf : '',
    professionalTax: b ? b.professionalTax : '',
    esiEmployee: v ? esi : '',
    net: b ? b.net - esi : (v ? (Number(v.stipend) || 0) - esi : ''),
    employerPf: b ? b.employerPf : '',
    gratuity: b ? b.gratuity : '',
  };
}

module.exports = {
  key: 'payroll-salary',
  label: 'Salary structures',
  module: 'Payroll',
  what: 'salary structures',
  feature: 'Payroll & Compensation',
  exportAction: 'edit',
  importActions: ['edit'],
  selfExport: false,
  sheet: 'Salary structures',
  entity: 'SalaryStructure',
  columns,
  instructions: [
    'One row = one employee\'s salary structure from a month (Effective From, YYYY-MM). Every change is saved as a VERSION, exactly like the Salary Structure screen: the same month edits that version, a new month adds a revision.',
    'A month whose payroll is already submitted, approved, synced or paid is refused — an import never changes a past run. Drafts from that month on must be recalculated afterwards.',
    'Components (Basic, HRA, Special Allowance, PF, PT, ESI …) are computed from the Standard Package rules and are read-only here. Blank cells keep the current value.',
    'A row with only the Employee ID filled in (the export lists everybody on the register) is skipped.',
  ],
  lists: async () => ({ 'Pay Mode': PAY_MODES, ESI }),
  payrollIndex,
  exportEmployees,

  async exportRows(ctx, { employeeIds, filters }) {
    const emps = await exportEmployees(ctx, employeeIds, filters);
    const ids = emps.map((e) => e.id);
    const versions = ids.length ? await prisma.salaryStructureVersion.findMany({
      where: { employeeId: { in: ids } }, orderBy: [{ effectiveFrom: 'desc' }],
    }) : [];
    const byEmp = new Map();
    versions.forEach((v) => { if (!byEmp.has(v.employeeId)) byEmp.set(v.employeeId, []); byEmp.get(v.employeeId).push(v); });
    const currentOnly = String(filters.current || '') === '1';
    const one = !!io.str(filters.employeeId);
    const out = [];
    emps.forEach((e) => {
      const vs = byEmp.get(e.id) || [];
      if (!vs.length) {
        // Everybody payable on the register gets a row, so the export doubles
        // as the file to fill in for people with no structure yet.
        if (one || E.PAYABLE_STATUSES.includes(e.employmentStatus)) out.push(rowOf(e, null));
        return;
      }
      (currentOnly ? vs.slice(0, 1) : vs).forEach((v) => out.push(rowOf(e, v)));
    });
    return out;
  },

  async validate(rows, ctx) {
    const idx = await payrollIndex(ctx.req);
    const cfg = await E.getPolicy();
    const resolved = rows.map((r) => idx.resolve(r.employeeCode));
    const empIds = [...new Set(resolved.filter((h) => h.employee).map((h) => h.employee.id))];
    const [versions, runs] = empIds.length ? await Promise.all([
      prisma.salaryStructureVersion.findMany({ where: { employeeId: { in: empIds } }, orderBy: { effectiveFrom: 'asc' } }),
      prisma.employeePayrollRun.findMany({ where: { employeeId: { in: empIds }, status: { not: 'DRAFT' } }, select: { employeeId: true, month: true, status: true } }),
    ]) : [[], []];
    const versionsOf = (id) => versions.filter((v) => v.employeeId === id);
    const lockedOf = new Map();
    runs.forEach((r) => { const cur = lockedOf.get(r.employeeId); if (!cur || r.month > cur.month) lockedOf.set(r.employeeId, r); });
    const seen = new Map();
    const out = [];
    rows.forEach((r, i) => {
      const hit = resolved[i];
      const e = hit.employee;
      const label = e ? `${e.name} (${e.employeeCode})` : io.str(r.employeeCode);
      // The export lists everybody on the register; an untouched row is skipped.
      if (INPUT_KEYS.every((k) => io.str(r[k]) === '')) {
        if (hit.error) { out.push({ line: r.line, label, errors: [{ field: 'Employee ID', message: hit.error }], action: 'error' }); return; }
        out.push({ line: r.line, label, errors: [], action: 'nochange', changes: [] });
        return;
      }
      const errors = io.requiredErrors(module.exports, r);
      if (hit.error && io.str(r.employeeCode)) errors.push({ field: 'Employee ID', message: hit.error });
      const eff = monthOf(r.effectiveFrom);
      if (eff.error) errors.push({ field: 'Effective From', message: `"${r.effectiveFrom}" is not a month (YYYY-MM).` });
      const payMode = io.str(r.payMode) ? io.pick(PAY_MODES, r.payMode) : null;
      if (io.str(r.payMode) && !payMode) errors.push({ field: 'Pay Mode', message: `"${r.payMode}" is not one of ${PAY_MODES.join(', ')}.` });
      const esiPick = io.str(r.esi) ? io.pick(ESI, r.esi) : null;
      if (io.str(r.esi) && !esiPick) errors.push({ field: 'ESI', message: `"${r.esi}" is not one of ${ESI.join(', ')}.` });
      const x = {
        effectiveFrom: eff.value || null,
        payMode,
        monthlyCtc: numberOf(r, 'monthlyCtc', 'Monthly CTC', errors),
        stipend: numberOf(r, 'stipend', 'Monthly Stipend', errors),
        bonus: numberOf(r, 'bonus', 'Bonus (monthly)', errors),
        tds: numberOf(r, 'tds', 'TDS (monthly)', errors),
        otherDeductions: numberOf(r, 'otherDeductions', 'Other Deductions (monthly)', errors),
        // undefined = keep · null = Auto · true / false = forced
        esi: esiPick === null ? undefined : (esiPick === 'Auto' ? null : esiPick === 'Yes'),
        note: io.str(r.note).slice(0, 300) || null,
      };
      if (x.monthlyCtc !== null && x.monthlyCtc === 0) errors.push({ field: 'Monthly CTC', message: 'Monthly CTC must be more than 0 (leave it blank to keep the current CTC).' });
      if (e && x.effectiveFrom) {
        const locked = lockedOf.get(e.id);
        if (locked && x.effectiveFrom <= `${locked.month}-01`) {
          errors.push({ field: 'Effective From', message: `${e.name}'s payroll for ${locked.month} is already ${E.STATUS_LABEL[locked.status] || locked.status} — a revision can only take effect from the following month.` });
        }
        const k = `${e.id}|${x.effectiveFrom}`;
        if (seen.has(k)) errors.push({ field: 'Effective From', message: `Same employee and month as row ${seen.get(k)}.` });
        else seen.set(k, r.line);
      }
      if (errors.length) { out.push({ line: r.line, label, errors, action: 'error' }); return; }
      const p = plan(versionsOf(e.id), x, cfg);
      if (p.error) { out.push({ line: r.line, label, errors: [p.error], action: 'error' }); return; }
      const changes = diff(p.sameMonth, p.data);
      if (!p.sameMonth) {
        out.push({
          line: r.line, label, errors: [], action: 'create',
          changes: [{ field: 'Effective From', from: '', to: x.effectiveFrom.slice(0, 7) }, ...changes],
          data: { employee: e, x },
        });
        return;
      }
      out.push({ line: r.line, label, errors: [], action: changes.length ? 'update' : 'nochange', changes, data: { employee: e, x } });
    });
    return out;
  },

  async apply(valid, ctx) {
    let created = 0;
    let updated = 0;
    const failed = [];
    const cfg = await E.getPolicy();
    const actor = ctx.user.name || ctx.user.email;
    // Oldest month first, so several revisions for one person chain in order.
    const ordered = [...valid].sort((a, b) => String(a.data.x.effectiveFrom).localeCompare(String(b.data.x.effectiveFrom)));
    // eslint-disable-next-line no-restricted-syntax
    for (const v of ordered) {
      const { employee: e, x } = v.data;
      try {
        // eslint-disable-next-line no-await-in-loop
        const result = await prisma.$transaction(async (tx) => {
          // Re-checked inside the write: a run may have moved on since the preview.
          const locked = await SV.lastLockedMonth(e.id, tx);
          if (locked && x.effectiveFrom <= `${locked.month}-01`) throw new Error(`payroll for ${locked.month} is already ${E.STATUS_LABEL[locked.status] || locked.status}`);
          const versions = await tx.salaryStructureVersion.findMany({ where: { employeeId: e.id }, orderBy: { effectiveFrom: 'asc' } });
          const p = plan(versions, x, cfg);
          if (p.error) throw new Error(p.error.message);
          if (p.sameMonth && !diff(p.sameMonth, p.data).length) return 'nochange';
          const version = p.sameMonth
            ? await tx.salaryStructureVersion.update({ where: { id: p.sameMonth.id }, data: p.data })
            : await tx.salaryStructureVersion.create({ data: { employeeId: e.id, effectiveFrom: x.effectiveFrom, createdBy: `${actor} (import)`, ...p.data } });
          const structure = await SV.relink(e.id, tx);
          await tx.auditLog.create({
            data: {
              userId: ctx.user.id,
              actorName: actor,
              action: p.sameMonth ? 'Salary structure version updated by import' : 'Salary structure version created by import',
              entity: 'SalaryStructure',
              entityId: structure ? structure.id : version.id,
              toValue: `effective ${x.effectiveFrom.slice(0, 7)} · ${version.payMode === 'Stipend' ? `stipend ${version.stipend}` : `CTC ${Math.round(version.ctc / 12)}/month`}`,
              reason: `${e.employeeCode} ${e.name}`,
            },
          });
          return p.sameMonth ? 'updated' : 'created';
        });
        if (result === 'created') created += 1;
        else if (result === 'updated') updated += 1;
      } catch (err) {
        failed.push({ line: v.line, reason: String(err.message || err).split('\n').pop().slice(0, 200) });
      }
    }
    return { created, updated, skipped: 0, failed };
  },
};
