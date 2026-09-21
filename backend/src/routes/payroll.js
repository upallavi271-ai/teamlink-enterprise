const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const {
  employeeWhere, employeeRecordWhere, employeeInScope, departmentWhere, accountsGlobal, matches, OUT_OF_SCOPE,
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
function payrollPayslipWhere(req) {
  const where = payrollEmployeeWhere(req);
  return Object.keys(where).length ? { employee: where } : {};
}
// Record-level twin, so editing a salary structure obeys the same rule the
// list does rather than a second, hand-written one.
function matchesScope(req, employee) {
  return matches(employee, payrollEmployeeWhere(req));
}
const { logAudit } = require('../utils/audit');
const { monthStats, monthLabel } = require('../utils/attendanceMath');

const router = express.Router();
router.use(requireAuth);


async function getPolicy() {
  let config = await prisma.hrConfig.findFirst();
  if (!config) config = await prisma.hrConfig.create({ data: {} });
  return config;
}

// CTC breakup driven by the configurable CTC Split Settings (see PUT /ctc-settings)
// rather than hardcoded percentages: Basic is a % of CTC, HRA/Bonus/PF/Gratuity are
// % of Basic (PF capped), flat professional tax, Special Allowance absorbs the
// remainder so the pieces reconcile exactly back to CTC — mirrors the reference
// app's Salary Structure panel and its Configuration Policies screen.
function salaryBreakup(annualCtc, cfg) {
  const monthlyCtc = annualCtc / 12;
  const basic = Math.round(monthlyCtc * (cfg.basicPctOfCtc / 100));
  const hra = Math.round(basic * (cfg.hraPctOfBasic / 100));
  const bonus = Math.round(basic * (cfg.bonusPctOfBasic / 100));
  const employeePf = Math.round(Math.min(basic * (cfg.employeePfPctOfBasic / 100), cfg.employeePfMonthlyCap));
  const employerPf = Math.round(Math.min(basic * (cfg.employerPfPctOfBasic / 100), cfg.employerPfMonthlyCap));
  const professionalTax = cfg.professionalTaxFlat;
  const gratuity = Math.round(basic * (cfg.gratuityPctOfBasic / 100));
  const gross = basic + hra + bonus;
  const special = Math.max(0, Math.round(monthlyCtc - gross - employerPf - gratuity));
  const grossWithSpecial = gross + special;
  const deductions = employeePf + professionalTax;
  const net = grossWithSpecial - deductions;
  const ctcCheck = Math.round((grossWithSpecial + employerPf + gratuity) * 12);
  return { basic, hra, bonus, special, employerPf, employeePf, professionalTax, gratuity, gross: grossWithSpecial, deductions, net, ctcCheck };
}

router.get('/', async (req, res) => {
  // A payslip is the most personal HRMS record there is. This list is an
  // employee's own payslip history, NOT the payroll operator's register —
  // /payroll/structure, /preview and /runs are that — so it stays on the HRMS
  // rule for everyone: your own, or your departments' if you lead them.
  // Narrowed only: an accountant's reach here is unchanged from before.
  const where = { ...employeeRecordWhere(req.user) };
  if (req.query.employeeId) where.employeeId = req.query.employeeId;
  if (req.query.month) where.month = req.query.month;
  const payslips = await prisma.payslip.findMany({ where, include: { employee: true }, orderBy: { month: 'desc' } });
  res.json(payslips);
});

// ---- Salary structures ----

router.get('/structure', requirePerm(null, 'hrms', 'Payroll & Compensation', 'view'), async (req, res) => {
  const cfg = await getPolicy();
  // Salary is the most department-sensitive record in HRMS, so the structure
  // list is held to the caller's departments like everything else.
  const employees = await prisma.employee.findMany({
    where: payrollEmployeeWhere(req), include: { salaryStructure: true }, orderBy: { name: 'asc' },
  });
  res.json(
    employees.map((e) => {
      const ss = e.salaryStructure;
      const breakup = ss && ss.payMode === 'Package' ? salaryBreakup(ss.ctc || 0, cfg) : null;
      return { employeeId: e.id, employeeCode: e.employeeCode, name: e.name, department: e.department, structure: ss, breakup };
    })
  );
});

// Reference CTC breakup for the "Standard Package" example shown on the Payroll dashboard.
router.get('/reference-structure', requirePerm(null, 'hrms', 'Payroll & Compensation', 'view'), async (req, res) => {
  const cfg = await getPolicy();
  res.json(salaryBreakup(Number(req.query.ctc) || 300000, cfg));
});

router.put('/structure/:employeeId', requirePerm(null, 'hrms', 'Payroll & Compensation', 'edit'), async (req, res) => {
  const inScope = await prisma.employee.findUnique({ where: { id: req.params.employeeId } });
  if (!inScope) return res.status(404).json({ error: 'Employee not found' });
  if (!matchesScope(req, inScope)) return res.status(403).json(OUT_OF_SCOPE);
  const { payMode, ctc, stipend } = req.body;
  const cfg = await getPolicy();
  const data = {};
  if (payMode) data.payMode = payMode;
  if (ctc != null) {
    data.ctc = Number(ctc);
    const b = salaryBreakup(Number(ctc), cfg);
    Object.assign(data, { basic: b.basic, hra: b.hra, bonus: b.bonus, specialAllowance: b.special, employerPf: b.employerPf, employeePf: b.employeePf, professionalTax: b.professionalTax, gratuity: b.gratuity });
  }
  if (stipend != null) data.stipend = Number(stipend);

  const structure = await prisma.salaryStructure.upsert({
    where: { employeeId: req.params.employeeId },
    update: data,
    create: { employeeId: req.params.employeeId, payMode: payMode || 'Package', ...data },
  });
  await logAudit({ userId: req.user.id, action: 'Salary structure updated', entity: 'SalaryStructure', entityId: structure.id });
  res.json(structure);
});

// ---- CTC Split Settings (how CTC is broken into components) ----

router.put('/ctc-settings', requirePerm(null, 'hrms', 'Payroll & Compensation', 'configure'), async (req, res) => {
  const fields = ['basicPctOfCtc', 'hraPctOfBasic', 'bonusPctOfBasic', 'employeePfPctOfBasic', 'employerPfPctOfBasic', 'employeePfMonthlyCap', 'employerPfMonthlyCap', 'gratuityPctOfBasic', 'professionalTaxFlat'];
  const config = await getPolicy();
  const data = {};
  fields.forEach((f) => { if (req.body[f] != null) data[f] = Number(req.body[f]); });
  const updated = await prisma.hrConfig.update({ where: { id: config.id }, data });
  await logAudit({ userId: req.user.id, action: 'CTC split settings updated', entity: 'HrConfig', entityId: updated.id });
  res.json(updated);
});

// ---- Payroll policy (how attendance turns into pay) ----

router.get('/policy', async (req, res) => {
  res.json(await getPolicy());
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

router.get('/fnf', requirePerm(null, 'hrms', 'Payroll & Compensation', 'view'), async (req, res) => {
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
// One function feeds both the preview (Process Payroll → Calculate) and the real
// run, so what you confirm is exactly what gets written. Pay is prorated against
// the month's attendance per the payroll policy — unmarked/absent working days
// beyond the paid-leave allowance become loss of pay — and each late arrival
// beyond the free monthly allowance costs half a day's pay.
async function calculatePayroll({ month, department, defaultCTC }) {
  const policy = await getPolicy();

  const [year, mo] = month.split('-').map(Number);
  const daysInMonth = new Date(year, mo, 0).getDate();
  let workingDays = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(year, mo - 1, d).getDay();
    if (policy.weekendsPaid || (dow !== 0 && dow !== 6)) workingDays++;
  }

  const where = { employmentStatus: { in: ['Active', 'Notice Period'] } };
  if (department) where.department = department;
  const employees = await prisma.employee.findMany({ where, include: { salaryStructure: true }, orderBy: { name: 'asc' } });
  const ids = employees.map((e) => e.id);
  const [allRecords, allPunches] = await Promise.all([
    prisma.attendance.findMany({ where: { employeeId: { in: ids }, date: { startsWith: month } } }),
    prisma.attendancePunch.findMany({ where: { employeeId: { in: ids }, date: { startsWith: month } } }),
  ]);

  const rows = employees.map((emp) => {
    const isStipend = emp.salaryStructure?.payMode === 'Stipend';
    const stipend = Number(emp.salaryStructure?.stipend || 0);
    const ctc = emp.salaryStructure?.payMode === 'Package' ? emp.salaryStructure.ctc : Number(defaultCTC) || 600000;
    // A stipend is a flat monthly figure with no components and no deductions.
    const b = isStipend
      ? { basic: 0, hra: 0, bonus: 0, special: 0, employerPf: 0, employeePf: 0, professionalTax: 0, gratuity: 0, gross: stipend, deductions: 0, net: stipend }
      : salaryBreakup(ctc, policy);
    const gross = b.gross;

    const records = allRecords.filter((r) => r.employeeId === emp.id);
    const absentDays = records.filter((r) => r.status === 'Absent').length;
    const unmarkedDays = policy.unmarkedDaysUnpaid ? Math.max(0, workingDays - records.length) : 0;
    const leaveDays = records.filter((r) => r.status === 'Leave').length;
    const unpaidLeaveDays = Math.max(0, leaveDays - policy.paidLeaveDaysPerMonth);
    const lopDays = absentDays + unmarkedDays + unpaidLeaveDays;

    const perDayPay = workingDays ? gross / workingDays : 0;
    const lopDeduction = Math.round(perDayPay * lopDays);

    const stats = monthStats({
      month,
      records,
      punches: allPunches.filter((p) => p.employeeId === emp.id),
      cfg: policy,
    });
    // Half a day's pay per excess late arrival; a "day" here is net/30.
    const netBeforeLate = Math.max(0, gross - b.deductions - lopDeduction);
    const lateCut = Math.round(netBeforeLate / 60) * stats.halfDayCut;
    const netPay = Math.max(0, netBeforeLate - lateCut);

    return {
      employeeId: emp.id,
      employeeCode: emp.employeeCode,
      name: emp.name,
      department: emp.department,
      payMode: isStipend ? 'Stipend' : 'Package',
      basic: b.basic, hra: b.hra, bonus: b.bonus, specialAllowance: b.special,
      employerPf: b.employerPf, employeePf: b.employeePf, professionalTax: b.professionalTax, gratuity: b.gratuity,
      gross, deductions: b.deductions,
      lopDays, lateDays: stats.late, halfDayCut: stats.halfDayCut, lateCut,
      netPay,
    };
  });

  const totals = rows.reduce((acc, r) => ({
    employees: acc.employees + 1,
    gross: acc.gross + r.gross,
    deductions: acc.deductions + r.deductions,
    lateCuts: acc.lateCuts + r.lateCut,
    net: acc.net + r.netPay,
  }), { employees: 0, gross: 0, deductions: 0, lateCuts: 0, net: 0 });

  return { month, period: monthLabel(month), workingDays, rows, totals };
}

// Preview a cycle without writing anything — the Calculate step on Process Payroll.
router.get('/preview', requirePerm(null, 'hrms', 'Payroll & Compensation', 'view'), async (req, res) => {
  const month = req.query.month;
  if (!month) return res.status(400).json({ error: 'month is required (YYYY-MM)' });
  const existing = await prisma.payrollRun.findUnique({ where: { month } });
  const preview = await calculatePayroll({ month, department: req.query.department || null, defaultCTC: req.query.defaultCTC });
  res.json({ ...preview, alreadyProcessed: !!existing, run: existing });
});

// Runs a payroll cycle for every active employee for a given month, writes a
// payslip each and records the run so Reports can compare month over month.
router.post('/run', requirePerm(null, 'hrms', 'Payroll & Compensation', 'create'), async (req, res) => {
  const { month, defaultCTC, department } = req.body; // month = "YYYY-MM"
  if (!month) return res.status(400).json({ error: 'month is required (YYYY-MM)' });

  const existing = await prisma.payrollRun.findUnique({ where: { month } });
  if (existing && !req.body.rerun) {
    return res.status(409).json({ error: `Payroll for ${monthLabel(month)} has already been processed.`, run: existing });
  }

  const { rows, totals, period } = await calculatePayroll({ month, department: department || null, defaultCTC });
  const payslips = [];
  for (const r of rows) {
    const slip = await prisma.payslip.upsert({
      where: { employeeId_month: { employeeId: r.employeeId, month } },
      update: {
        basic: r.basic, hra: r.hra, allowances: r.bonus + r.specialAllowance, deductions: r.deductions, netPay: r.netPay,
        bonus: r.bonus, specialAllowance: r.specialAllowance, employerPf: r.employerPf, employeePf: r.employeePf,
        professionalTax: r.professionalTax, gratuity: r.gratuity, lopDays: r.lopDays,
        gross: r.gross, lateCut: r.lateCut, lateDays: r.lateDays, payMode: r.payMode,
      },
      create: {
        employeeId: r.employeeId, month, basic: r.basic, hra: r.hra, allowances: r.bonus + r.specialAllowance,
        deductions: r.deductions, netPay: r.netPay, bonus: r.bonus, specialAllowance: r.specialAllowance,
        employerPf: r.employerPf, employeePf: r.employeePf, professionalTax: r.professionalTax, gratuity: r.gratuity,
        lopDays: r.lopDays, gross: r.gross, lateCut: r.lateCut, lateDays: r.lateDays, payMode: r.payMode,
      },
    });
    payslips.push(slip);
  }

  const runData = {
    month, period, department: department || null, status: 'Processing',
    employees: totals.employees, totalGross: totals.gross, totalDeductions: totals.deductions,
    totalLateCuts: totals.lateCuts, totalNet: totals.net,
    processedBy: req.user.name || req.user.email, processedAt: new Date(),
  };
  const run = await prisma.payrollRun.upsert({ where: { month }, update: runData, create: runData });

  await logAudit({ userId: req.user.id, action: 'Payroll processed', entity: 'PayrollRun', entityId: run.id, toValue: `${payslips.length} payslips, net ${Math.round(totals.net)}` });
  res.status(201).json({ month, period, count: payslips.length, run, payslips });
});

// ---- Payroll runs ----

router.get('/runs', requirePerm(null, 'hrms', 'Payroll & Compensation', 'view'), async (req, res) => {
  const runs = await prisma.payrollRun.findMany({ orderBy: { month: 'desc' } });
  res.json(runs);
});

router.patch('/runs/:id/paid', requirePerm(null, 'hrms', 'Payroll & Compensation', 'approve'), async (req, res) => {
  const existing = await prisma.payrollRun.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Payroll run not found' });
  if (existing.status === 'Paid') return res.status(409).json({ error: 'This run is already marked paid.' });
  const run = await prisma.payrollRun.update({ where: { id: req.params.id }, data: { status: 'Paid', paidAt: new Date() } });
  await logAudit({ userId: req.user.id, action: 'Payroll paid', entity: 'PayrollRun', entityId: run.id, fromValue: 'Processing', toValue: 'Paid' });
  res.json(run);
});

// ---- Reports: month-over-month comparison, payout by period, payout by department ----

router.get('/reports', requirePerm(null, 'hrms', 'Payroll & Compensation', 'view'), async (req, res) => {
  const runs = await prisma.payrollRun.findMany({ orderBy: { month: 'desc' } });
  const cfg = await getPolicy();
  const employees = await prisma.employee.findMany({ where: { employmentStatus: { not: 'Relieved' } }, include: { salaryStructure: true } });

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
    const net = ss?.payMode === 'Stipend' ? Number(ss.stipend || 0) : salaryBreakup(ss?.ctc || 0, cfg).net;
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

// ---- A single payslip, expanded for the printable view ----

router.get('/payslips/:id', async (req, res) => {
  const slip = await prisma.payslip.findUnique({ where: { id: req.params.id }, include: { employee: true } });
  if (!slip) return res.status(404).json({ error: 'Payslip not found' });
  if (req.user.caps.hrmsSelfOnly) {
    const own = await prisma.employee.findUnique({ where: { userId: req.user.id } });
    if (!own || own.id !== slip.employeeId) return res.status(403).json({ error: "This isn't included in your role's permissions" });
  } else if (!req.user.caps.payrollManage) {
    return res.status(403).json({ error: "This isn't included in your role's permissions" });
  }
  const company = await prisma.company.findFirst();
  const gross = slip.gross || slip.basic + slip.hra + (slip.bonus || 0) + (slip.specialAllowance || 0);
  res.json({
    ...slip,
    period: monthLabel(slip.month),
    gross,
    company: company || { name: 'TeamLink Consultants' },
    earnings: [
      { label: 'Basic', amount: slip.basic },
      { label: 'HRA', amount: slip.hra },
      { label: 'Bonus', amount: slip.bonus || 0 },
      { label: 'Special Allowance', amount: slip.specialAllowance || 0 },
    ],
    deductionLines: [
      { label: 'Provident Fund', amount: slip.employeePf || 0 },
      { label: 'Professional Tax', amount: slip.professionalTax || 0 },
      ...(slip.lateCut ? [{ label: `Late arrival cut (${slip.lateDays || 0} late day(s))`, amount: slip.lateCut }] : []),
    ],
    employerCost: [
      { label: 'Employer PF', amount: slip.employerPf || 0 },
      { label: 'Gratuity', amount: slip.gratuity || 0 },
    ],
  });
});

module.exports = router;
