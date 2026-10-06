// ---------------------------------------------------------------------------
// THE PAYROLL ENGINE (SPEC B §3-§5) — employee + month -> one payroll record.
//
//   structure  the SalaryStructureVersion effective in that month
//              (utils/salaryVersions.js), so a later revision never changes it
//   attendance HR's override (PayrollAttendance) or, by default, the month's
//              day statuses from the attendance module (utils/attendanceDays.js)
//
// Per employee per month (whole rupees):
//   grossPay        Basic + HRA + Bonus + Special (or the stipend) — full month
//   lopDeduction    round(grossPay x daysLop / workingDays)
//   earnedGross     grossPay - lopDeduction
//   pfEmployee/Er   the version's PF x paid-day ratio (so LOP reduces PF too)
//   esiEmployee/Er  on earnedGross, 0.75% / 3.25%, rounded up, only when the
//                   version's full gross is <= the ESI ceiling (HrConfig)
//   professionalTax min(version PT, Telangana slab on earnedGross)
//   tds             the version's monthly TDS, else HrConfig % of earnedGross
//   otherDeductions the version's figure
//   totalDeductions pfEmployee + esiEmployee + PT + TDS + LOP + other
//   netPay          grossPay - totalDeductions  (never below 0: TDS and other
//                   deductions are capped at what is left after statutory)
//
// Status: DRAFT -> PENDING_APPROVAL -> APPROVED -> SYNCED_TO_ACCOUNTS -> PAID.
// Every move is a conditional update on the CURRENT status (so two people
// cannot both make it) and writes an AuditLog row with who and when.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const D = require('./attendanceDays');
const { monthLabel } = require('./attendanceMath');
const { professionalTaxFor, DEFAULT_RULES } = require('./salaryRules');
const { versionsFor, versionFor, esiFor } = require('./salaryVersions');
const { logAudit } = require('./audit');
const { NOT_SYSTEM_EMPLOYEE } = require('./systemAccounts');

const STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SYNCED_TO_ACCOUNTS', 'PAID'];
const STATUS_LABEL = {
  DRAFT: 'Draft', PENDING_APPROVAL: 'Pending Approval', APPROVED: 'Approved', SYNCED_TO_ACCOUNTS: 'Synced', PAID: 'Paid',
};
// Approved or later: what counts as "the payroll" for reports and Accounts.
const FINAL_STATUSES = ['APPROVED', 'SYNCED_TO_ACCOUNTS', 'PAID'];
// Who is paid in a run. 'On Probation' is an employee on the payroll like any
// other (the old month run left them out).
const PAYABLE_STATUSES = ['Active', 'On Probation', 'Notice Period'];

// The only moves there are. sync and pay are made by utils/payrollSync.js,
// and only after Accounts has actually booked the journal.
const TRANSITIONS = {
  submit: { from: 'DRAFT', to: 'PENDING_APPROVAL', verb: 'Submitted for approval' },
  reject: { from: 'PENDING_APPROVAL', to: 'DRAFT', verb: 'Sent back to draft' },
  approve: { from: 'PENDING_APPROVAL', to: 'APPROVED', verb: 'Approved' },
  sync: { from: 'APPROVED', to: 'SYNCED_TO_ACCOUNTS', verb: 'Synced to Accounts' },
  pay: { from: 'SYNCED_TO_ACCOUNTS', to: 'PAID', verb: 'Marked paid' },
};

class PayrollError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

async function getPolicy(db = prisma) {
  let config = await db.hrConfig.findFirst();
  if (!config) config = await db.hrConfig.create({ data: { basicPctOfCtc: DEFAULT_RULES.basicPctOfCtc } });
  return config;
}

const isMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));
const monthParts = (m) => { const [y, mo] = m.split('-').map(Number); return { year: y, monthNum: mo }; };

// Payroll working days — the pay basis, same rule the month run always used:
// every calendar day when weekends are paid, otherwise Monday to Friday.
function payrollWorkingDays(month, policy) {
  const { year, monthNum } = monthParts(month);
  const days = new Date(year, monthNum, 0).getDate();
  let n = 0;
  for (let d = 1; d <= days; d += 1) {
    const dow = new Date(year, monthNum - 1, d).getDay();
    if (policy.weekendsPaid || (dow !== 0 && dow !== 6)) n += 1;
  }
  return n;
}

// ---- Attendance input -------------------------------------------------------
//
// DEFAULT, from the attendance module's day statuses (past days only; a day
// still to come is assumed worked). Each day carries the fractions of the
// HRMS 7-case table (utils/attendanceDays.js dayStatus): present / leave /
// absent (unpaid) / pending, so e.g. "worked 9:00-1:30 + full-day leave
// approved" is 0.5 present + 0.5 leave = a full paid day.
//   daysPresent = the present fractions (Present, Late, Early Logout,
//                 Missing Check-Out = 1; a worked half = 0.5)
//   daysLop     = the absent fractions (Absent, the unworked half of a Half
//                 Day, an unpaid leave type)
//               + the pending fractions (leave still waiting: unpaid until
//                 it is approved, then it becomes leave on the next run)
//               + Missing Check-In (when "unmarked working days are unpaid")
//               + approved leave beyond the paid-leave days per month
//               + working days before the joining date
//               + half a day per late arrival beyond the free allowance
// capped at the month's payroll working days. HR can override any employee.
async function attendanceDefaults(employees, month, policy) {
  const { from, to } = D.monthRange(month);
  const { days } = await D.loadDays(prisma, { employees, from, to, cfg: policy });
  const workingDays = payrollWorkingDays(month, policy);
  const offs = D.weeklyOffs(policy);
  const out = new Map();
  employees.forEach((e) => {
    const rows = days(e);
    const s = D.summarise(rows.filter((d) => !['Upcoming', 'Not Joined'].includes(d.status)));
    const notJoined = rows.filter((d) => d.status === 'Not Joined'
      && (policy.weekendsPaid || !offs.has(new Date(`${d.date}T00:00:00Z`).getUTCDay()))).length;
    const unmarkedUnpaid = policy.unmarkedDaysUnpaid !== false;
    const excessLate = Math.max(0, s.lateArrivals - Number(policy.freeLateArrivalsPerMonth || 0));
    const unpaidLeave = Math.max(0, s.leaveDays - Number(policy.paidLeaveDaysPerMonth || 0));
    const lop = s.absentDays + s.pendingDays + (unmarkedUnpaid ? s.missingCheckIn : 0) + unpaidLeave + notJoined + 0.5 * excessLate;
    const present = s.presentDays + (unmarkedUnpaid ? 0 : s.missingCheckIn);
    out.set(e.id, {
      workingDays,
      daysPresent: present,
      daysLop: Math.min(workingDays, lop),
      source: 'ATTENDANCE',
      detail: {
        present: s.present, late: s.late, halfDay: s.halfDay, absent: s.absent, onLeave: s.onLeave,
        missingCheckIn: s.missingCheckIn, missingCheckOut: s.missingCheckOut, lateArrivals: s.lateArrivals,
        excessLate, unpaidLeave, notJoined,
        presentDays: s.presentDays, leaveDays: s.leaveDays, absentDays: s.absentDays, pendingDays: s.pendingDays,
        earlyLogouts: s.earlyLogouts, halfDayHalfLeave: s.halfDayHalfLeave, underReview: s.halfDayUnderReview + s.leaveUnderReview,
        sandwichDays: s.sandwichDays, unpaidLeaveTypeDays: s.unpaidLeaveDays,
      },
    });
  });
  return { workingDays, map: out };
}

// Default merged with HR's overrides: Map(employeeId -> input).
async function attendanceInputs(employees, month, policy) {
  const { workingDays, map } = await attendanceDefaults(employees, month, policy);
  const overrides = await prisma.payrollAttendance.findMany({ where: { month, employeeId: { in: employees.map((e) => e.id) } } });
  overrides.forEach((o) => {
    const auto = map.get(o.employeeId) || {};
    map.set(o.employeeId, {
      ...auto,
      workingDays: o.workingDays || workingDays,
      daysPresent: o.daysPresent,
      daysLop: Math.min(o.workingDays || workingDays, o.daysLop),
      source: 'OVERRIDE',
      override: {
        id: o.id, reason: o.reason, by: o.overriddenByName, at: o.overriddenAt,
        autoDaysPresent: auto.daysPresent, autoDaysLop: auto.daysLop,
      },
    });
  });
  return { workingDays, map };
}

// ---- The arithmetic ----------------------------------------------------------
function computeEntry({ version, att, policy, incentive = 0 }) {
  const workingDays = Number(att.workingDays) || 0;
  const daysLop = Math.max(0, Math.min(workingDays, Number(att.daysLop) || 0));
  const ratio = workingDays > 0 ? (workingDays - daysLop) / workingDays : 1;
  const stipend = version.payMode === 'Stipend';
  const basic = stipend ? 0 : Number(version.basic) || 0;
  const hra = stipend ? 0 : Number(version.hra) || 0;
  const bonus = stipend ? 0 : Number(version.bonus) || 0;
  const specialAllowance = stipend ? 0 : Number(version.specialAllowance) || 0;
  // Conveyance (payroll import, 2026-10-06): a fixed earning of the imported
  // registers' packages, part of the full-month gross like the others.
  const conveyance = stipend ? 0 : Number(version.conveyance) || 0;
  const baseGross = stipend ? Math.round(Number(version.stipend) || 0) : basic + hra + bonus + specialAllowance + conveyance;
  const lopDeduction = workingDays > 0 ? Math.round((baseGross * daysLop) / workingDays) : 0;
  // Recruiter-joinings incentive (utils/recruiterJoinings.js): a separate
  // earning added AFTER loss of pay (it is earned, not a day rate), so ESI,
  // PT and a policy-% TDS see it like any other earning. 0 = as before.
  const incentiveAmt = Math.max(0, Math.round(Number(incentive) || 0));
  const grossPay = baseGross + incentiveAmt;
  const earnedGross = grossPay - lopDeduction;

  const pfEmployee = stipend ? 0 : Math.round((Number(version.employeePf) || 0) * ratio);
  const pfEmployer = stipend ? 0 : Math.round((Number(version.employerPf) || 0) * ratio);
  const gratuity = stipend ? 0 : Math.round((Number(version.gratuity) || 0) * ratio);
  // ESI eligibility is decided on the version's full-month gross; the
  // contribution is on what was actually earned.
  const eligible = esiFor(baseGross, policy, version.esiApplicable).applicable;
  const esi = eligible && earnedGross > 0 ? esiFor(earnedGross, policy, true) : { employee: 0, employer: 0 };
  const professionalTax = stipend ? 0 : Math.min(Number(version.professionalTax) || 0, professionalTaxFor(earnedGross));

  const statutory = pfEmployee + esi.employee + professionalTax;
  const room = Math.max(0, earnedGross - statutory);
  const wantTds = version.tds !== null && version.tds !== undefined
    ? Math.round(Number(version.tds) || 0)
    : Math.round((earnedGross * (Number(policy.tdsDefaultPctOfGross) || 0)) / 100);
  const tds = Math.min(Math.max(0, wantTds), room);
  const otherDeductions = Math.min(Math.max(0, Math.round(Number(version.otherDeductions) || 0)), room - tds);
  const totalDeductions = pfEmployee + esi.employee + professionalTax + tds + lopDeduction + otherDeductions;
  const netPay = grossPay - totalDeductions;

  return {
    payMode: stipend ? 'Stipend' : 'Package',
    workingDays, daysPresent: Number(att.daysPresent) || 0, daysLop,
    basic, hra, bonus, specialAllowance, conveyance, incentive: incentiveAmt, grossPay, lopDeduction, earnedGross,
    pfEmployee, esiEmployee: esi.employee, professionalTax, tds, otherDeductions, totalDeductions, netPay,
    pfEmployer, esiEmployer: esi.employer, gratuity,
  };
}

// ---- Month-level run (the existing PayrollRun row is the month's container) --
function monthStatusOf(entries) {
  if (!entries.length) return null;
  const idx = Math.min(...entries.map((e) => STATUSES.indexOf(e.status)));
  return STATUS_LABEL[STATUSES[idx]] || 'Draft';
}

async function refreshMonthRun(month, actorName = null) {
  const entries = await prisma.employeePayrollRun.findMany({ where: { month } });
  const run = await prisma.payrollRun.findUnique({ where: { month } });
  if (!entries.length) return run;
  const sum = (k) => entries.reduce((n, e) => n + (Number(e[k]) || 0), 0);
  const allPaid = entries.every((e) => e.status === 'PAID');
  const data = {
    period: monthLabel(month),
    status: monthStatusOf(entries),
    employees: entries.length,
    totalGross: sum('grossPay'),
    totalDeductions: sum('totalDeductions'),
    totalLateCuts: 0,
    totalNet: sum('netPay'),
    paidAt: allPaid ? new Date(Math.max(...entries.map((e) => new Date(e.paidAt || 0).getTime()))) : null,
  };
  if (actorName) data.processedBy = actorName;
  if (run) return prisma.payrollRun.update({ where: { id: run.id }, data });
  return prisma.payrollRun.create({ data: { month, ...data, processedBy: actorName } });
}

// ---- Calculate (idempotent for drafts) ---------------------------------------
//
// dryRun: compute and return, write nothing (the Process Payroll preview).
// Otherwise: DRAFT rows are created or updated in place; anything beyond
// DRAFT is left exactly as it is and reported as locked.
async function calculateMonth({ month, employeeWhere = {}, department = null, employeeIds = null, actor = null, dryRun = false }) {
  if (!isMonth(month)) throw new PayrollError(400, 'month is required (YYYY-MM)');
  // A month already processed by the older month-level run (it has no
  // per-employee records, e.g. August 2026) must not be paid a second time.
  const monthRun = await prisma.payrollRun.findUnique({ where: { month }, include: { _count: { select: { entries: true } } } });
  if (monthRun && monthRun._count.entries === 0 && ['Processing', 'Paid'].includes(monthRun.status)) {
    throw new PayrollError(409, `${monthLabel(month)} was already processed as a month run (${monthRun.status}) before per-employee payroll existed; it cannot be calculated again.`);
  }
  // S3: a month posted to Accounts (one journal for the whole month) takes no
  // new drafts — re-open it first, which reverses the journal.
  if (!dryRun) {
    const posted = await prisma.employeePayrollRun.count({ where: { month, status: { in: ['SYNCED_TO_ACCOUNTS', 'PAID'] } } });
    if (posted) throw new PayrollError(409, `${monthLabel(month)} is already posted to Accounts. Re-open the month first to change it.`);
  }
  const policy = await getPolicy();
  // Super Admin is a system account, never on a payroll run (utils/systemAccounts.js).
  const where = { AND: [employeeWhere, { employmentStatus: { in: PAYABLE_STATUSES } }, NOT_SYSTEM_EMPLOYEE] };
  if (department) where.AND.push({ department });
  if (Array.isArray(employeeIds)) where.AND.push({ id: { in: employeeIds } });
  const employees = await prisma.employee.findMany({ where, orderBy: { name: 'asc' } });
  const ids = employees.map((e) => e.id);
  const [versions, { workingDays, map: inputs }, existing, incentives] = await Promise.all([
    versionsFor(ids, month),
    attendanceInputs(employees, month, policy),
    prisma.employeePayrollRun.findMany({ where: { month, employeeId: { in: ids } } }),
    incentivesFor(ids, month),
  ]);
  const existingOf = new Map(existing.map((e) => [e.employeeId, e]));
  const { year, monthNum } = monthParts(month);

  const rows = [];
  const skipped = [];
  const locked = [];
  employees.forEach((emp) => {
    const v = versions.get(emp.id);
    const base = { employeeId: emp.id, employeeCode: emp.employeeCode, name: emp.name, department: emp.department };
    if (!v) { skipped.push({ ...base, reason: `No salary structure effective in ${monthLabel(month)}` }); return; }
    const c = computeEntry({ version: v, att: inputs.get(emp.id), policy, incentive: incentives.get(emp.id) || 0 });
    if (!(c.grossPay > 0)) { skipped.push({ ...base, reason: v.payMode === 'Stipend' ? 'Stipend is 0' : 'No CTC set' }); return; }
    const prior = existingOf.get(emp.id);
    if (prior && prior.status !== 'DRAFT') { locked.push({ ...base, id: prior.id, status: prior.status }); return; }
    rows.push({
      ...base, ...c, salaryVersionId: v.id, effectiveFrom: v.effectiveFrom,
      attendanceSource: inputs.get(emp.id).source, attendance: inputs.get(emp.id), existingId: prior ? prior.id : null,
    });
  });

  const totals = rows.reduce((a, r) => ({
    employees: a.employees + 1, gross: a.gross + r.grossPay, deductions: a.deductions + r.totalDeductions, net: a.net + r.netPay,
  }), { employees: 0, gross: 0, deductions: 0, net: 0 });
  const result = { month, period: monthLabel(month), workingDays, rows, skipped, locked, totals };
  if (dryRun) return result;

  let run = await prisma.payrollRun.findUnique({ where: { month } });
  if (!run && rows.length) {
    run = await prisma.payrollRun.create({ data: { month, period: monthLabel(month), status: 'Draft', processedBy: actor ? actor.name : null } });
  }
  let created = 0;
  let updated = 0;
  const now = new Date();
  for (const r of rows) {
    const data = {
      payrollRunId: run ? run.id : null, year, monthNum, salaryVersionId: r.salaryVersionId, payMode: r.payMode,
      workingDays: r.workingDays, daysPresent: r.daysPresent, daysLop: r.daysLop, attendanceSource: r.attendanceSource,
      basic: r.basic, hra: r.hra, bonus: r.bonus, specialAllowance: r.specialAllowance, conveyance: r.conveyance || 0, incentive: r.incentive,
      grossPay: r.grossPay, lopDeduction: r.lopDeduction, earnedGross: r.earnedGross,
      pfEmployee: r.pfEmployee, esiEmployee: r.esiEmployee, professionalTax: r.professionalTax, tds: r.tds,
      otherDeductions: r.otherDeductions, totalDeductions: r.totalDeductions, netPay: r.netPay,
      pfEmployer: r.pfEmployer, esiEmployer: r.esiEmployer, gratuity: r.gratuity,
      calculatedBy: actor ? actor.name : null, calculatedAt: now,
    };
    if (r.existingId) {
      // Conditional on DRAFT: a concurrent submit wins and this row is left alone.
      // eslint-disable-next-line no-await-in-loop
      const u = await prisma.employeePayrollRun.updateMany({ where: { id: r.existingId, status: 'DRAFT' }, data });
      if (u.count) { updated += 1; r.id = r.existingId; } else locked.push({ employeeId: r.employeeId, name: r.name, id: r.existingId, status: 'changed' });
    } else {
      // eslint-disable-next-line no-await-in-loop
      const row = await prisma.employeePayrollRun.create({ data: { employeeId: r.employeeId, month, status: 'DRAFT', ...data } });
      created += 1; r.id = row.id;
    }
  }
  // The incentives now carried by a payroll record point at it.
  for (const r of rows) {
    if (!r.id || !r.incentive) continue;
    // eslint-disable-next-line no-await-in-loop
    await prisma.recruiterJoiningDecision.updateMany({ where: { employeeId: r.employeeId, payMonth: month, decision: 'INCENTIVE' }, data: { payrollEntryId: r.id } }).catch(() => {});
  }
  if (rows.length || locked.length) await refreshMonthRun(month, actor ? actor.name : null);
  if (actor && (created || updated)) {
    await logAudit({
      userId: actor.id || null, actorName: actor.name, action: 'Payroll calculated (draft)', entity: 'PayrollRun',
      entityId: run ? run.id : null, toValue: `${monthLabel(month)}: ${created} created, ${updated} recalculated, ${locked.length} locked`,
    });
  }
  return { ...result, created, updated, run: await prisma.payrollRun.findUnique({ where: { month } }) };
}

// Recruiter-joinings incentives paid in `month` (utils/recruiterJoinings.js,
// Super Admin's decisions): Map(employeeId -> rupees).
async function incentivesFor(employeeIds, month) {
  const out = new Map();
  if (!employeeIds.length) return out;
  const rows = await prisma.recruiterJoiningDecision.findMany({
    where: { employeeId: { in: employeeIds }, payMonth: month, decision: 'INCENTIVE' },
    select: { employeeId: true, amount: true },
  }).catch(() => []);
  rows.forEach((d) => out.set(d.employeeId, (out.get(d.employeeId) || 0) + Math.max(0, Math.round(Number(d.amount) || 0))));
  return out;
}

// ---- Payslip, generated from the run (the existing payslip layout reads it) --
async function writePayslip(entry) {
  const fields = {
    basic: entry.basic, hra: entry.hra, allowances: entry.bonus + entry.specialAllowance + (entry.conveyance || 0) + (entry.arrears || 0),
    incentive: entry.incentive || 0, // its own line on the payslip (in gross)
    // Payroll import (2026-10-06): Conveyance / Arrears lines and the sheet breakup.
    conveyance: entry.conveyance || 0, arrears: entry.arrears || 0, importedBreakup: entry.importedBreakup || null,
    // Payslip.deductions keeps its old meaning: the statutory/structure
    // deductions (PF + PT, now + ESI + TDS + other), LOP separately.
    deductions: entry.pfEmployee + entry.professionalTax + entry.esiEmployee + entry.tds + entry.otherDeductions,
    netPay: entry.netPay,
    bonus: entry.bonus, specialAllowance: entry.specialAllowance, employerPf: entry.pfEmployer, employeePf: entry.pfEmployee,
    professionalTax: entry.professionalTax, gratuity: entry.gratuity, lopDays: entry.daysLop,
    gross: entry.grossPay, lateCut: 0, lateDays: 0, payMode: entry.payMode,
    workingDays: entry.workingDays, lopDeduction: entry.lopDeduction,
    esiEmployee: entry.esiEmployee, esiEmployer: entry.esiEmployer, tds: entry.tds, otherDeductions: entry.otherDeductions,
    payrollEntryId: entry.id, generatedAt: new Date(),
  };
  return prisma.payslip.upsert({
    where: { employeeId_month: { employeeId: entry.employeeId, month: entry.month } },
    update: fields,
    create: { employeeId: entry.employeeId, month: entry.month, ...fields },
  });
}

// ---- Transitions ------------------------------------------------------------
async function transition(entryId, action, actor, { reason = null, data = {} } = {}) {
  const t = TRANSITIONS[action];
  if (!t) throw new PayrollError(400, `Unknown action ${action}`);
  const entry = await prisma.employeePayrollRun.findUnique({ where: { id: entryId }, include: { employee: true } });
  if (!entry) throw new PayrollError(404, 'Payroll record not found');
  if (entry.status !== t.from) {
    throw new PayrollError(409, `Only a ${STATUS_LABEL[t.from]} record can be ${t.verb.toLowerCase()} — this one is ${STATUS_LABEL[entry.status] || entry.status}.`, { status: entry.status });
  }
  if (action === 'submit') {
    // A draft computed from a structure that has since been revised must be
    // recalculated first, or the approver would approve the old figures.
    const v = await versionFor(entry.employeeId, entry.month);
    if (!v || v.id !== entry.salaryVersionId || (entry.calculatedAt && v.updatedAt > entry.calculatedAt)) {
      throw new PayrollError(409, `${entry.employee.name}'s salary structure changed after this draft was calculated — recalculate ${monthLabel(entry.month)} first.`);
    }
    // The same for a recruiter-joinings incentive given / changed / undone since.
    const inc = (await incentivesFor([entry.employeeId], entry.month)).get(entry.employeeId) || 0;
    if (inc !== Math.round(Number(entry.incentive) || 0)) {
      throw new PayrollError(409, `${entry.employee.name}'s incentive changed after this draft was calculated — recalculate ${monthLabel(entry.month)} first.`);
    }
  }
  const stamp = new Date();
  const who = actor ? actor.name : 'System';
  const extra = { ...data };
  if (action === 'submit') Object.assign(extra, { submittedBy: who, submittedAt: stamp, rejectionReason: null });
  if (action === 'approve') Object.assign(extra, { approvedBy: who, approvedAt: stamp });
  if (action === 'reject') Object.assign(extra, { rejectionReason: reason || null, submittedBy: null, submittedAt: null });
  if (action === 'sync') Object.assign(extra, { syncedAt: stamp });
  if (action === 'pay') Object.assign(extra, { paidBy: who, paidAt: data.paidAt || stamp });
  const u = await prisma.employeePayrollRun.updateMany({ where: { id: entryId, status: t.from }, data: { status: t.to, ...extra } });
  if (!u.count) throw new PayrollError(409, 'This record changed while you were acting on it — reload and try again.');
  await logAudit({
    userId: actor && actor.id ? actor.id : null,
    actorName: who,
    action: `Payroll ${t.verb.toLowerCase()}`,
    entity: 'EmployeePayrollRun',
    entityId: entryId,
    fromValue: t.from,
    toValue: t.to,
    reason: reason || `${entry.employee.name} · ${monthLabel(entry.month)}`,
  });
  let updated = await prisma.employeePayrollRun.findUnique({ where: { id: entryId } });
  if (action === 'approve') {
    const slip = await writePayslip(updated);
    updated = await prisma.employeePayrollRun.update({ where: { id: entryId }, data: { payslipId: slip.id } });
  }
  await refreshMonthRun(entry.month);
  return updated;
}

// The audit trail of one record, oldest first.
async function historyOf(entryId) {
  return prisma.auditLog.findMany({
    where: { entity: 'EmployeePayrollRun', entityId: entryId },
    orderBy: { createdAt: 'asc' },
    select: { action: true, fromValue: true, toValue: true, actorName: true, reason: true, createdAt: true },
  });
}

module.exports = {
  STATUSES, STATUS_LABEL, FINAL_STATUSES, PAYABLE_STATUSES, TRANSITIONS, PayrollError,
  getPolicy, isMonth, monthParts, payrollWorkingDays,
  attendanceDefaults, attendanceInputs, computeEntry, calculateMonth, refreshMonthRun,
  writePayslip, transition, historyOf, incentivesFor,
};
