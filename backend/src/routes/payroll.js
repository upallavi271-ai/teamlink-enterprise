const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const {
  employeeWhere, departmentWhere, accountsGlobal, matches, OUT_OF_SCOPE,
} = require('../utils/scope');

// Who this caller may see payroll for. The payroll SCREENS are already gated
// to Super Admin / Admin / Accountant by hrms/Payroll & Compensation/view; the
// question here is only which employees inside that. An unconfigured Accounts
// desk keeps the whole company (that is the job); a configured one, and any
// department-scoped lead who is ever granted payroll, is held to their
// departments; everybody else sees their own payslip and nothing more.
function payrollEmployeeWhere(req) {
  if (accountsGlobal(req.user)) return {};
  if (req.user.caps.payrollManage) return departmentWhere(req.user);
  return employeeWhere(req.user);
}
// Record-level twin, so editing a salary structure obeys the same rule the
// list does rather than a second, hand-written one.
function matchesScope(req, employee) {
  return matches(employee, payrollEmployeeWhere(req));
}
const { logAudit } = require('../utils/audit');
const { withoutSystemAccounts } = require('../utils/systemAccounts');
const { monthLabel } = require('../utils/attendanceMath');
const { can } = require('../utils/permissions');
const {
  computeStructure, structureFromRow, PT_SLAB, PT_STATE, DEFAULT_RULES,
} = require('../utils/salaryRules');
const { renderPayslip } = require('../utils/payslipPdf');
// Payroll -> Accounts (SPEC B): versioned structures, the per-employee engine.
const SV = require('../utils/salaryVersions');
const PE = require('../utils/payrollEngine');

const router = express.Router();
router.use(requireAuth);


async function getPolicy() {
  let config = await prisma.hrConfig.findFirst();
  // basicPctOfCtc is passed explicitly: the column's default is still the old
  // 50% (see schema.prisma), the Standard Package is 40%.
  if (!config) config = await prisma.hrConfig.create({ data: { basicPctOfCtc: DEFAULT_RULES.basicPctOfCtc } });
  return config;
}

// CTC breakup — utils/salaryRules.js holds the rules (Standard Package: Basic
// 40% of CTC, HRA 40% of Basic, fixed Bonus, PF 12% of Basic, Gratuity 4.81%
// of Basic, Telangana PT slab, Special Allowance absorbs the rest so the pieces
// reconcile exactly to CTC). SalaryStructure.ctc is stored ANNUAL, as it always
// has been; the rules work on the monthly figure.
function salaryBreakup(annualCtc, cfg) {
  return computeStructure((Number(annualCtc) || 0) / 12, cfg);
}

// ---- Who may read whose payslip ---------------------------------------------
//
// Everybody reads their OWN payslips. Reading OTHER people's is for:
//   - the payroll desk (Payroll & Compensation / edit — Super Admin, Admin,
//     Accountant, HR), held to payrollEmployeeWhere() like every payroll list;
//   - the view-only oversight roles (Manager, Assistant Manager), who hold
//     `export` but no write action, held to their HRMS data scope.
// An employee and a TL hold only `view` — their own payslips, nothing more.
async function payslipReach(req) {
  const own = await prisma.employee.findUnique({ where: { userId: req.user.id }, select: { id: true } });
  const ownId = own ? own.id : null;
  if (req.user.caps.payrollManage) return { ownId, where: payrollEmployeeWhere(req) };
  if (!req.user.caps.hrmsSelfOnly && await can(req.user, 'hrms', 'hrms', 'Payroll & Compensation', 'export')) {
    return { ownId, where: employeeWhere(req.user) };
  }
  return { ownId, where: null };
}
function reachWhere(reach) {
  if (!reach.where) return { employeeId: reach.ownId || '__no_employee__' };
  if (!Object.keys(reach.where).length) return {};
  return reach.ownId ? { OR: [{ employeeId: reach.ownId }, { employee: reach.where }] } : { employee: reach.where };
}
function reachAllows(reach, employee) {
  if (!employee) return false;
  if (reach.ownId && reach.ownId === employee.id) return true;
  return !!reach.where && matches(employee, reach.where);
}

router.get('/', async (req, res) => {
  // A payslip is the most personal HRMS record there is: your own, or — for
  // the payroll desk and the view-only oversight roles — the ones inside
  // your scope (payslipReach above).
  const where = { ...reachWhere(await payslipReach(req)) };
  if (req.query.employeeId) where.employeeId = req.query.employeeId;
  if (req.query.month) where.month = req.query.month;
  const payslips = await prisma.payslip.findMany({ where, include: { employee: true }, orderBy: { month: 'desc' } });
  res.json(payslips);
});

// ---- Salary structures ----

// THE PAYROLL OPERATOR'S SCREENS ARE GUARDED BY `edit`, NOT `view`.
//
// Salary structures, the run preview, past runs, F&F and the payroll reports
// are the operator's register — they are not an employee looking at their
// own payslip. Both used to sit behind the same `view`, which was harmless
// only while nobody but the Accounts desk held it. An employee holds it now,
// so the two are separated: SET.ACCOUNTS has edit, EMPLOYEE does not.
//
// GET '/' above is the employee's own payslip history and stays open — it is
// scoped by payslipReach() to their own rows.
function breakupOf(ss, cfg) {
  if (!ss) return null;
  if (ss.payMode === 'Stipend') return null;
  // Stored components win (they may carry HR's overrides); a row with only a
  // CTC on it is computed from the rules.
  if (Number(ss.basic) > 0) return structureFromRow(ss);
  return Number(ss.ctc) > 0 ? salaryBreakup(ss.ctc, cfg) : null;
}

router.get('/structure', requirePerm(null, 'hrms', 'Payroll & Compensation', 'edit'), async (req, res) => {
  const cfg = await getPolicy();
  // Salary is the most department-sensitive record in HRMS, so the structure
  // list is held to the caller's departments like everything else.
  const employees = await prisma.employee.findMany({
    where: withoutSystemAccounts(payrollEmployeeWhere(req)), include: { salaryStructure: true }, orderBy: { name: 'asc' },
  });
  res.json(
    employees.map((e) => {
      const ss = e.salaryStructure;
      return { employeeId: e.id, employeeCode: e.employeeCode, name: e.name, department: e.department, structure: ss, breakup: breakupOf(ss, cfg) };
    })
  );
});

// The Standard Package reference card (and the live preview while HR types a
// CTC). Pure arithmetic — nothing is read about or written to any employee.
// ?monthlyCtc=25000 (default) · ?ctc=300000 (annual, older callers) · ?bonus=1000
router.get('/reference-structure', requirePerm(null, 'hrms', 'Payroll & Compensation', 'view'), async (req, res) => {
  const cfg = await getPolicy();
  const monthly = req.query.monthlyCtc != null && req.query.monthlyCtc !== ''
    ? Number(req.query.monthlyCtc)
    : (req.query.ctc != null && req.query.ctc !== '' ? Number(req.query.ctc) / 12 : 25000);
  const bonus = req.query.bonus != null && req.query.bonus !== '' ? Number(req.query.bonus) : undefined;
  res.json(computeStructure(Number.isFinite(monthly) ? monthly : 0, cfg, { bonus }));
});

// The caller's OWN salary structure — the employee's side of Payroll &
// Compensation. Never anybody else's.
router.get('/my-structure', async (req, res) => {
  const me = await prisma.employee.findUnique({ where: { userId: req.user.id }, include: { salaryStructure: true } });
  if (!me) return res.json({ employee: null, structure: null, breakup: null });
  const cfg = await getPolicy();
  const ss = me.salaryStructure;
  return res.json({
    employee: { id: me.id, name: me.name, employeeCode: me.employeeCode, department: me.department, designation: me.designation },
    structure: ss ? { payMode: ss.payMode, ctc: ss.ctc, stipend: ss.stipend, updatedAt: ss.updatedAt } : null,
    breakup: breakupOf(ss, cfg),
  });
});

router.get('/structure/:employeeId', requirePerm(null, 'hrms', 'Payroll & Compensation', 'edit'), async (req, res) => {
  const emp = await prisma.employee.findUnique({ where: { id: req.params.employeeId }, include: { salaryStructure: true } });
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  if (!matchesScope(req, emp)) return res.status(403).json(OUT_OF_SCOPE);
  const cfg = await getPolicy();
  // Every version, newest first, with which months' payroll used it.
  const [versions, used, locked] = await Promise.all([
    prisma.salaryStructureVersion.findMany({ where: { employeeId: emp.id }, orderBy: { effectiveFrom: 'desc' } }),
    prisma.employeePayrollRun.findMany({ where: { employeeId: emp.id }, select: { month: true, status: true, salaryVersionId: true }, orderBy: { month: 'asc' } }),
    SV.lastLockedMonth(emp.id),
  ]);
  return res.json({
    employee: { id: emp.id, name: emp.name, employeeCode: emp.employeeCode, department: emp.department, designation: emp.designation, dateOfJoining: emp.dateOfJoining },
    structure: emp.salaryStructure,
    breakup: breakupOf(emp.salaryStructure, cfg),
    versions: versions.map((v) => ({
      ...v,
      breakup: v.payMode === 'Stipend' ? null : structureFromRow(v),
      runs: used.filter((r) => r.salaryVersionId === v.id).map((r) => ({ month: r.month, status: r.status })),
    })),
    // A new or edited version may only take effect after this month.
    lockedThrough: locked ? locked.month : null,
  });
});

// Removes a version nobody's payroll beyond DRAFT has used.
router.delete('/structure/versions/:versionId', requirePerm(null, 'hrms', 'Payroll & Compensation', 'edit'), async (req, res) => {
  const v = await prisma.salaryStructureVersion.findUnique({ where: { id: req.params.versionId }, include: { employee: true } });
  if (!v) return res.status(404).json({ error: 'Version not found' });
  if (!matchesScope(req, v.employee)) return res.status(403).json(OUT_OF_SCOPE);
  const usedBy = await prisma.employeePayrollRun.findFirst({ where: { salaryVersionId: v.id, status: { not: 'DRAFT' } } });
  if (usedBy) return res.status(409).json({ error: `This version paid ${usedBy.month} (${usedBy.status}); it can no longer be removed.` });
  const locked = await SV.lastLockedMonth(v.employeeId);
  if (locked && v.effectiveFrom <= `${locked.month}-01`) return res.status(409).json({ error: `Removing it would change ${locked.month}'s payroll, which is already ${locked.status}.` });
  await prisma.salaryStructureVersion.delete({ where: { id: v.id } });
  await SV.relink(v.employeeId);
  await logAudit({ userId: req.user.id, action: 'Salary structure version removed', entity: 'SalaryStructureVersion', entityId: v.id, fromValue: v.effectiveFrom });
  return res.json({ ok: true });
});

const COMPONENT_FIELDS = ['basic', 'hra', 'bonus', 'specialAllowance', 'employerPf', 'employeePf', 'professionalTax', 'gratuity'];

// Saves ONE employee's structure AS A VERSION (SPEC B §2). Components are
// computed from the CTC HR enters (utils/salaryRules.js) and any component HR
// typed over is kept as typed. Nothing here ever runs for employees HR did
// not save.
//
// Body: { payMode, monthlyCtc | ctc (annual), bonus, components: { basic, … }, stipend,
//         effectiveFrom ('YYYY-MM'; default: the latest version's month, or the
//         joining month / this month for a first structure),
//         esiApplicable (true | false | null = automatic), tds (monthly, '' = policy),
//         otherDeductions (monthly), note }
//
// Same effectiveFrom as an existing version → that version is edited; a new
// month → a new version (the previous one ends the day before). Refused when
// the version would take effect on a month whose payroll is beyond DRAFT, so a
// revision never changes a past run. SalaryStructure is then re-mirrored to
// the latest version (the "current version" everything else reads).
router.put('/structure/:employeeId', requirePerm(null, 'hrms', 'Payroll & Compensation', 'edit'), async (req, res) => {
  const inScope = await prisma.employee.findUnique({ where: { id: req.params.employeeId }, include: { salaryStructure: true } });
  if (!inScope) return res.status(404).json({ error: 'Employee not found' });
  if (!matchesScope(req, inScope)) return res.status(403).json(OUT_OF_SCOPE);
  const body = req.body || {};
  const { stipend } = body;
  const current = inScope.salaryStructure;
  const payMode = body.payMode || (current && current.payMode) || 'Package';
  if (!['Package', 'Stipend'].includes(payMode)) return res.status(400).json({ error: 'Pay mode must be Package or Stipend' });
  const cfg = await getPolicy();

  // Which month the version takes effect from.
  const latest = await prisma.salaryStructureVersion.findFirst({ where: { employeeId: inScope.id }, orderBy: { effectiveFrom: 'desc' } });
  let effectiveFrom;
  if (body.effectiveFrom) {
    effectiveFrom = SV.monthStart(body.effectiveFrom);
    if (!effectiveFrom) return res.status(400).json({ error: 'effectiveFrom must be a month (YYYY-MM)' });
  } else if (latest) {
    effectiveFrom = latest.effectiveFrom;
  } else {
    const doj = inScope.dateOfJoining ? new Date(inScope.dateOfJoining) : null;
    effectiveFrom = doj && !Number.isNaN(doj.getTime())
      ? `${doj.getFullYear()}-${String(doj.getMonth() + 1).padStart(2, '0')}-01`
      : `${new Date().toISOString().slice(0, 7)}-01`;
  }
  const locked = await SV.lastLockedMonth(inScope.id);
  if (locked && effectiveFrom <= `${locked.month}-01`) {
    return res.status(409).json({
      error: `${inScope.name}'s payroll for ${locked.month} is already ${PE.STATUS_LABEL[locked.status] || locked.status}. A revision can only take effect from the following month onwards.`,
      lockedThrough: locked.month,
    });
  }
  const sameMonth = await prisma.salaryStructureVersion.findUnique({ where: { employeeId_effectiveFrom: { employeeId: inScope.id, effectiveFrom } } });
  // The version this one starts from: the one it edits, else the one in force.
  const base = sameMonth || await SV.versionFor(inScope.id, effectiveFrom.slice(0, 7)) || latest || current;

  let annual = null;
  if (body.monthlyCtc != null && body.monthlyCtc !== '') annual = Math.round(Number(body.monthlyCtc)) * 12;
  else if (body.ctc != null && body.ctc !== '') annual = Number(body.ctc);
  if (annual != null && (!Number.isFinite(annual) || annual < 0)) return res.status(400).json({ error: 'CTC must be a positive amount' });
  if (annual == null) annual = base ? Number(base.ctc) || 0 : 0;
  if (payMode === 'Package' && !(annual > 0)) return res.status(400).json({ error: 'Enter the monthly CTC' });

  // HR's overrides, kept exactly as typed. Without a new CTC, the base
  // version's stored components carry over as overrides.
  const overrides = {};
  const ctcGiven = (body.monthlyCtc != null && body.monthlyCtc !== '') || (body.ctc != null && body.ctc !== '');
  if (!ctcGiven && base && payMode === 'Package' && Number(base.basic) > 0) COMPONENT_FIELDS.forEach((f) => { overrides[f] = Number(base[f]) || 0; });
  const typed = body.components && typeof body.components === 'object' ? body.components : {};
  for (const f of COMPONENT_FIELDS) {
    if (typed[f] === undefined || typed[f] === null || typed[f] === '') continue;
    const v = Number(typed[f]);
    if (!Number.isFinite(v)) return res.status(400).json({ error: `${f} must be a number` });
    overrides[f] = Math.round(v);
  }
  let stipendAmount = base ? Number(base.stipend) || 0 : 0;
  if (stipend != null && stipend !== '') {
    const v = Number(stipend);
    if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: 'Stipend must be a positive amount' });
    stipendAmount = v;
  }
  const pick = (k, fallback) => (Object.prototype.hasOwnProperty.call(body, k) ? body[k] : fallback);
  const esiRaw = pick('esiApplicable', base ? base.esiApplicable : null);
  const esiApplicable = esiRaw === true || esiRaw === 'true' ? true : (esiRaw === false || esiRaw === 'false' ? false : null);
  const tds = pick('tds', base ? base.tds : null);
  const otherDeductions = pick('otherDeductions', base ? base.otherDeductions : 0);
  if (tds !== null && tds !== '' && tds !== undefined && !(Number(tds) >= 0)) return res.status(400).json({ error: 'TDS must be 0 or more' });
  if (!(Number(otherDeductions || 0) >= 0)) return res.status(400).json({ error: 'Other deductions must be 0 or more' });

  const bonus = body.bonus != null && body.bonus !== '' ? Number(body.bonus) : undefined;
  const data = SV.buildComponents({
    payMode, annualCtc: annual, bonus, overrides, stipend: stipendAmount, cfg, esiApplicable, tds, otherDeductions,
  });
  data.note = body.note ? String(body.note).slice(0, 300) : (sameMonth ? sameMonth.note : null);

  const version = sameMonth
    ? await prisma.salaryStructureVersion.update({ where: { id: sameMonth.id }, data })
    : await prisma.salaryStructureVersion.create({ data: { employeeId: inScope.id, effectiveFrom, createdBy: req.user.name, ...data } });
  const structure = await SV.relink(inScope.id);
  await logAudit({
    userId: req.user.id, action: sameMonth ? 'Salary structure version updated' : 'Salary structure version created',
    entity: 'SalaryStructure', entityId: structure.id, toValue: `effective ${effectiveFrom.slice(0, 7)} · CTC ${Math.round(annual / 12)}/month`,
  });
  // Drafts already calculated from what this changed must be recalculated
  // before they can be submitted (payrollEngine.transition checks this).
  const staleDrafts = await prisma.employeePayrollRun.findMany({
    where: { employeeId: inScope.id, status: 'DRAFT', month: { gte: effectiveFrom.slice(0, 7) } }, select: { month: true },
  });
  res.json({ structure, version, breakup: breakupOf(structure, cfg), staleDrafts: staleDrafts.map((d) => d.month) });
});

// ---- CTC Split Settings (how CTC is broken into components) ----

router.put('/ctc-settings', requirePerm(null, 'hrms', 'Payroll & Compensation', 'configure'), async (req, res) => {
  const fields = ['basicPctOfCtc', 'hraPctOfBasic', 'bonusFixedMonthly', 'bonusPctOfBasic', 'employeePfPctOfBasic', 'employerPfPctOfBasic', 'employeePfMonthlyCap', 'employerPfMonthlyCap', 'gratuityPctOfBasic', 'professionalTaxFlat',
    // SPEC B statutory settings: ESI rates / ceiling, default TDS %.
    'esiEmployeePct', 'esiEmployerPct', 'esiGrossCeiling', 'tdsDefaultPctOfGross'];
  const config = await getPolicy();
  const data = {};
  fields.forEach((f) => { if (req.body[f] != null) data[f] = Number(req.body[f]); });
  if (typeof req.body.esiEnabled === 'boolean') data.esiEnabled = req.body.esiEnabled;
  if (Object.values(data).some((v) => typeof v === 'number' && (!Number.isFinite(v) || v < 0))) {
    return res.status(400).json({ error: 'Settings must be numbers of 0 or more' });
  }
  const updated = await prisma.hrConfig.update({ where: { id: config.id }, data });
  await logAudit({ userId: req.user.id, action: 'CTC split settings updated', entity: 'HrConfig', entityId: updated.id });
  res.json(updated);
});

// ---- Payroll policy (how attendance turns into pay) ----

router.get('/policy', async (req, res) => {
  // The PT slab rides along so the settings screen can show it; it is edited
  // in utils/salaryRules.js, its one home.
  res.json({ ...(await getPolicy()), ptSlab: PT_SLAB, ptState: PT_STATE });
});

router.put('/policy', requirePerm(null, 'hrms', 'Payroll & Compensation', 'configure'), async (req, res) => {
  const {
    unmarkedDaysUnpaid, weekendsPaid, paidLeaveDaysPerMonth,
    payByHours, halfDayBySession, sessionSplit, halfDayHours, fullDayHours,
  } = req.body;
  const config = await getPolicy();
  const updated = await prisma.hrConfig.update({
    where: { id: config.id },
    data: {
      unmarkedDaysUnpaid: typeof unmarkedDaysUnpaid === 'boolean' ? unmarkedDaysUnpaid : undefined,
      weekendsPaid: typeof weekendsPaid === 'boolean' ? weekendsPaid : undefined,
      paidLeaveDaysPerMonth: paidLeaveDaysPerMonth != null ? Number(paidLeaveDaysPerMonth) : undefined,
      // The rest of the prototype's "How attendance affects pay" switches. Its
      // "minimum hours for a full / half day" are the same halfDayHours /
      // fullDayHours the attendance policy edits.
      payByHours: typeof payByHours === 'boolean' ? payByHours : undefined,
      halfDayBySession: typeof halfDayBySession === 'boolean' ? halfDayBySession : undefined,
      sessionSplit: sessionSplit != null ? String(sessionSplit) : undefined,
      halfDayHours: halfDayHours != null ? Number(halfDayHours) : undefined,
      fullDayHours: fullDayHours != null ? Number(fullDayHours) : undefined,
    },
  });
  await logAudit({ userId: req.user.id, action: 'Payroll policy updated', entity: 'HrConfig', entityId: updated.id });
  res.json(updated);
});

// ---- Full & Final settlement requests ----

router.get('/fnf', requirePerm(null, 'hrms', 'Payroll & Compensation', 'edit'), async (req, res) => {
  const requests = await prisma.fnfRequest.findMany({ include: { employee: true }, orderBy: { createdAt: 'desc' } });
  res.json(requests);
});

router.patch('/fnf/:id/process', requirePerm(null, 'hrms', 'Payroll & Compensation', 'approve'), async (req, res) => {
  const { settlementAmount } = req.body;
  const fnf = await prisma.fnfRequest.update({
    where: { id: req.params.id },
    data: { status: 'Processed', settlementAmount: settlementAmount != null ? Number(settlementAmount) : null, processedAt: new Date() },
  });
  await logAudit({ userId: req.user.id, action: 'F&F settlement processed', entity: 'FnfRequest', entityId: fnf.id });
  res.json(fnf);
});

// ---- Payroll calculation -----------------------------------------------------
// The per-employee engine lives in utils/payrollEngine.js (SPEC B): the salary
// structure VERSION effective in the month, the month's attendance input (the
// attendance module's day statuses, or HR's override), and one record per
// employee per month with its own approval status.

// Preview a cycle without writing anything — the Calculate step on Process
// Payroll. Since SPEC B this is the per-employee engine (utils/payrollEngine.js)
// in dry-run mode: the versioned structure effective that month and the
// month's attendance input. The row shape keeps the old keys the screen reads.
router.get('/preview', requirePerm(null, 'hrms', 'Payroll & Compensation', 'edit'), async (req, res) => {
  const month = req.query.month;
  if (!PE.isMonth(month)) return res.status(400).json({ error: 'month is required (YYYY-MM)' });
  const existing = await prisma.payrollRun.findUnique({ where: { month } });
  const r = await PE.calculateMonth({ month, department: req.query.department || null, employeeWhere: payrollEmployeeWhere(req), dryRun: true });
  const rows = r.rows.map((x) => ({
    ...x, gross: x.grossPay, deductions: x.pfEmployee + x.esiEmployee + x.professionalTax + x.tds + x.otherDeductions,
    lopDays: x.daysLop, lateDays: 0, lateCut: 0, attendance: undefined,
  }));
  const hasEntries = await prisma.employeePayrollRun.count({ where: { month } });
  res.json({
    ...r, rows, totals: { ...r.totals, lateCuts: 0 },
    // "Already processed" now means: a month run from before the per-employee
    // records (it cannot be recalculated). Drafts can always be recalculated.
    alreadyProcessed: !!existing && !hasEntries, hasEntries: hasEntries > 0, run: existing,
  });
});

// Calculates the month for every payable employee in scope as DRAFT records
// (utils/payrollEngine.js). Idempotent: a DRAFT is recalculated in place;
// a record beyond DRAFT is never touched (reported as locked). Payslips are
// generated when a record is APPROVED, not here.
router.post('/run', requirePerm(null, 'hrms', 'Payroll & Compensation', 'create'), async (req, res) => {
  const { month, department } = req.body;
  if (!PE.isMonth(month)) return res.status(400).json({ error: 'month is required (YYYY-MM)' });
  const legacy = await prisma.payrollRun.findUnique({ where: { month } });
  const hasEntries = await prisma.employeePayrollRun.count({ where: { month } });
  if (legacy && !hasEntries && legacy.status === 'Paid') {
    return res.status(409).json({ error: `Payroll for ${monthLabel(month)} was processed and paid before per-employee records existed; it cannot be recalculated.`, run: legacy });
  }
  try {
    const r = await PE.calculateMonth({
      month, department: department || null, employeeWhere: payrollEmployeeWhere(req), actor: { id: req.user.id, name: req.user.name || req.user.email },
    });
    if (!r.rows.length && !r.locked.length) {
      return res.status(409).json({ error: 'Nobody in this run has a salary structure effective this month — set a CTC on Salary Structure first.', skipped: r.skipped });
    }
    return res.status(201).json({
      month, period: r.period, count: r.rows.length, created: r.created, updated: r.updated,
      locked: r.locked, skipped: r.skipped, run: r.run, totals: r.totals,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

// ---- Payroll runs ----

router.get('/runs', requirePerm(null, 'hrms', 'Payroll & Compensation', 'edit'), async (req, res) => {
  const runs = await prisma.payrollRun.findMany({ orderBy: { month: 'desc' }, include: { _count: { select: { entries: true } } } });
  // perEmployee: the month is run through per-employee records (SPEC B) and
  // is paid per record through Accounts; otherwise it is an older month run.
  // S3: "Posted to Accounts" / "Not posted" per month (one journal per month).
  // eslint-disable-next-line global-require
  const P = require('../utils/payrollPosting');
  const out = [];
  for (const { _count, ...r } of runs) {
    const perEmployee = _count.entries > 0;
    // eslint-disable-next-line no-await-in-loop
    const st = perEmployee ? await P.monthState(r.month) : null;
    out.push({
      ...r, perEmployee, records: _count.entries,
      accountsPosted: st ? st.posted : null, accountsJournalId: st && st.journalEntry ? st.journalEntry.id : null,
    });
  }
  res.json(out);
});

// Marks an OLDER month run (one with no per-employee records, e.g. August
// 2026) paid. A month with per-employee records is paid record by record —
// Mark paid posts the bank payment journal through Accounts.
router.patch('/runs/:id/paid', requirePerm(null, 'hrms', 'Payroll & Compensation', 'approve'), async (req, res) => {
  const existing = await prisma.payrollRun.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Payroll run not found' });
  if (await prisma.employeePayrollRun.count({ where: { payrollRunId: existing.id } })) {
    return res.status(409).json({ error: 'This month is paid per employee: sync the approved records to Accounts, then use Mark paid on them.' });
  }
  if (existing.status === 'Paid') return res.status(409).json({ error: 'This run is already marked paid.' });
  const run = await prisma.payrollRun.update({ where: { id: req.params.id }, data: { status: 'Paid', paidAt: new Date() } });
  await logAudit({ userId: req.user.id, action: 'Payroll paid', entity: 'PayrollRun', entityId: run.id, fromValue: 'Processing', toValue: 'Paid' });
  res.json(run);
});

// ---- Reports: month-over-month comparison, payout by period, payout by department ----

router.get('/reports', requirePerm(null, 'hrms', 'Payroll & Compensation', 'edit'), async (req, res) => {
  const runs = await prisma.payrollRun.findMany({ orderBy: { month: 'desc' } });
  const cfg = await getPolicy();
  const employees = await prisma.employee.findMany({ where: withoutSystemAccounts({ employmentStatus: { not: 'Relieved' } }), include: { salaryStructure: true } });

  let comparison = null;
  if (runs.length >= 2) {
    const [a, b] = runs;
    const delta = a.totalNet - b.totalNet;
    const pct = b.totalNet > 0 ? Math.round((delta / b.totalNet) * 1000) / 10 : 0;
    comparison = {
      current: { month: a.month, period: a.period, net: a.totalNet, employees: a.employees },
      previous: { month: b.month, period: b.period, net: b.totalNet, employees: b.employees },
      delta, pct, headcountDelta: a.employees - b.employees,
    };
  }

  const byDepartment = {};
  employees.forEach((e) => {
    const key = e.department || 'Unassigned';
    const ss = e.salaryStructure;
    const net = ss?.payMode === 'Stipend' ? Number(ss.stipend || 0) : (breakupOf(ss, cfg)?.net || 0);
    if (!byDepartment[key]) byDepartment[key] = { department: key, employees: 0, net: 0 };
    byDepartment[key].employees += 1;
    byDepartment[key].net += net;
  });

  res.json({
    comparison,
    byPeriod: runs.map((r) => ({
      id: r.id, month: r.month, period: r.period, status: r.status, employees: r.employees,
      gross: r.totalGross, deductions: r.totalDeductions, lateCuts: r.totalLateCuts, net: r.totalNet,
      processedAt: r.processedAt, paidAt: r.paidAt,
    })),
    byDepartment: Object.values(byDepartment).sort((a, b) => b.net - a.net),
  });
});

// ---- A single payslip, laid out as the user's sample payslip ----
//
// ONE payload feeds the on-screen payslip (frontend components/PayslipView.jsx)
// and the PDF (utils/payslipPdf.js). Missing values are null; both print "—".

function companyAddress(co) {
  if (!co) return null;
  let text = (co.address || '').trim();
  const lower = text.toLowerCase();
  [co.city, co.state].forEach((part) => {
    if (part && !lower.includes(String(part).toLowerCase())) text = text ? `${text}, ${part}` : String(part);
  });
  if (co.pin && !text.includes(String(co.pin))) text = text ? `${text} - ${co.pin}` : String(co.pin);
  return text || null;
}

function fmtDoj(d) {
  if (!d) return null;
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

async function payslipPayload(slip) {
  const company = await prisma.company.findFirst();
  const e = slip.employee;
  const isStipend = slip.payMode === 'Stipend';
  const gross = Number(slip.gross) || (slip.basic + slip.hra + (slip.bonus || 0) + (slip.specialAllowance || 0));
  const pf = Number(slip.employeePf) || 0;
  const pt = Number(slip.professionalTax) || 0;
  const lateCut = Number(slip.lateCut) || 0;
  const lopDays = Number(slip.lopDays) || 0;
  // Stored by the run since 2026-09-25. An older payslip did not store it, so
  // it is read back from the run's own arithmetic: whatever of gross the net,
  // PF, PT and late cut do not account for is what loss of pay took.
  let lopDeduction = Number(slip.lopDeduction) || 0;
  if (!lopDeduction && lopDays > 0 && !slip.payrollEntryId) lopDeduction = Math.max(0, Math.round(gross - pf - pt - lateCut - (Number(slip.netPay) || 0)));
  const workingDays = Number(slip.workingDays) > 0 ? Number(slip.workingDays) : null;

  // Recruiter-joinings incentive (Super Admin's decision, utils/recruiterJoinings.js):
  // its own earning line, already inside the run's gross.
  const incentive = Math.max(0, Number(slip.incentive) || 0);
  const earnings = [
    ...(isStipend
      ? [{ label: 'Stipend', amount: gross - incentive }]
      : [
        { label: 'Basic', amount: slip.basic || 0 },
        { label: 'HRA', amount: slip.hra || 0 },
        // Payroll import (2026-10-06): the registers' Conveyance line, only when paid.
        ...(Number(slip.conveyance) > 0 ? [{ label: 'Conveyance', amount: Number(slip.conveyance) }] : []),
        { label: 'Bonus', amount: slip.bonus || 0 },
        { label: 'Special Allowance', amount: slip.specialAllowance || 0 },
      ]),
    ...(Number(slip.arrears) > 0 ? [{ label: 'Arrears', amount: Number(slip.arrears) }] : []),
    ...(incentive > 0 ? [{ label: 'Incentive', amount: incentive }] : []),
  ];
  const deductions = [
    ...(isStipend ? [] : [{ label: 'PF', amount: pf }, { label: 'PT', amount: pt }]),
    // SPEC B lines, printed only when the run deducted them.
    ...(Number(slip.esiEmployee) > 0 ? [{ label: 'ESI', amount: Number(slip.esiEmployee) }] : []),
    ...(Number(slip.tds) > 0 ? [{ label: 'TDS', amount: Number(slip.tds) }] : []),
    ...(Number(slip.otherDeductions) > 0 ? [{ label: 'Other Deductions', amount: Number(slip.otherDeductions) }] : []),
    ...(lopDeduction > 0 ? [{ label: `LOP (${lopDays} day${lopDays === 1 ? '' : 's'})`, amount: lopDeduction }] : []),
    ...(lateCut > 0 ? [{ label: `Late arrivals (${slip.lateDays || 0})`, amount: lateCut }] : []),
  ];
  const totalDeductions = deductions.reduce((s, d) => s + (Number(d.amount) || 0), 0);

  return {
    id: slip.id,
    month: slip.month,
    period: monthLabel(slip.month),
    payMode: slip.payMode || 'Package',
    generatedAt: slip.generatedAt,
    company: {
      name: (company && (company.legalName || company.name)) || 'TeamLink Consultants',
      address: companyAddress(company),
    },
    employee: {
      id: e.id,
      employeeCode: e.employeeCode || null,
      name: e.name || null,
      panNumber: e.panNumber || null,
      uanNumber: e.uanNumber || null,
      esiNumber: e.esiNumber || null,
      pfNumber: e.pfNumber || null,
      dateOfJoining: fmtDoj(e.dateOfJoining),
      department: e.department || null,
      designation: e.designation || null,
      location: e.location || e.branch || null,
      bankAccountNumber: e.bankAccountNumber || null,
      bankName: e.bankName || null,
    },
    workingDays,
    lopDays,
    daysWorked: workingDays != null ? Math.max(0, workingDays - lopDays) : null,
    monthlyGross: gross,
    earnings,
    deductions,
    gross,
    totalDeductions,
    netPay: Number(slip.netPay) || 0,
    lopDeduction,
    lateCut,
  };
}

async function slipForReader(req, res) {
  const slip = await prisma.payslip.findUnique({ where: { id: req.params.id }, include: { employee: true } });
  if (!slip) { res.status(404).json({ error: 'Payslip not found' }); return null; }
  const reach = await payslipReach(req);
  if (!reachAllows(reach, slip.employee)) {
    res.status(403).json({ error: "This isn't included in your role's permissions" });
    return null;
  }
  return slip;
}

router.get('/payslips/:id', async (req, res) => {
  const slip = await slipForReader(req, res);
  if (!slip) return undefined;
  return res.json(await payslipPayload(slip));
});

router.get('/payslips/:id/pdf', async (req, res) => {
  const slip = await slipForReader(req, res);
  if (!slip) return undefined;
  const payload = await payslipPayload(slip);
  const safe = (s) => String(s || '').replace(/[^A-Za-z0-9_-]+/g, '-');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="Payslip-${safe(payload.employee.employeeCode || payload.employee.name)}-${payload.month}.pdf"`);
  res.setHeader('Cache-Control', 'no-store');
  await logAudit({ userId: req.user.id, action: 'Payslip downloaded', entity: 'Payslip', entityId: slip.id, toValue: payload.month });
  renderPayslip(payload, res);
  return undefined;
});

// SPEC B — per-employee payroll records, attendance input, approval, sync to
// Accounts, mark paid and the compliance report (routes/payrollRuns.js).
require('./payrollRuns')(router, { payrollEmployeeWhere });

module.exports = router;
module.exports.payslipPayload = payslipPayload;
// The one payslip reach rule, reused by the dashboard charts and exports
// (routes/insights.js) so they can never see more than GET / does.
module.exports.payslipReach = payslipReach;
module.exports.reachWhere = reachWhere;
// The payroll register's employee scope, reused by the payroll import/export
// specs (src/io/payroll-*.js) so a spreadsheet reaches exactly who the
// Salary Structure / Attendance input screens reach.
module.exports.payrollEmployeeWhere = payrollEmployeeWhere;
