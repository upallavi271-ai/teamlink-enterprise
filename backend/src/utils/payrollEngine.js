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
// PAY REGISTER RULES (founder 2026-10-28, utils/payrollRegister.js): from the month
// set in AppSetting 'payroll.registerRules' on, a record is worked out exactly like
// the team's Excel Pay Register (paise, earned parts, PF by the version's PF rule,
// ESI rounded up on the earned total, PT slab on the earned total) by the SAME
// calculation the edit screen uses (utils/payrollCalc.js), so an unedited record
// recalculates to itself. Earlier months keep the whole-rupee rules below.
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
const PC = require('./payrollCycle');
const ANL = require('./absentNoLeave');
const REG = require('./payrollRegister');

const STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SYNCED_TO_ACCOUNTS', 'PAID'];
const STATUS_LABEL = {
  DRAFT: 'Calculated', PENDING_APPROVAL: 'Pending Approval', APPROVED: 'Approved', SYNCED_TO_ACCOUNTS: 'Synced', PAID: 'Paid',
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
  reject: { from: 'PENDING_APPROVAL', to: 'DRAFT', verb: 'Sent back for changes' },
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

// Payroll working days — the pay basis: every calendar day when the week-off
// days are paid ("weekendsPaid", the policy flag), otherwise every day that is
// not a configured week off. Week off = Sunday only (HrConfig.weeklyOffDays,
// '0'), so Saturday always counts: Monday to Saturday (user, 2026-10-09).
// PAYROLL CYCLE (2026-10-12, utils/payrollCycle.js): the days are the payroll
// month's OWN days (16 Aug - 15 Sep = 31 days), not the calendar month's. `cycle`
// is optional so an old caller that passes only a month still gets the calendar.
function payrollWorkingDays(month, policy, cycle = null) {
  const c = cycle || PC.cycleOf(month);
  const offs = D.weeklyOffs(policy);
  let n = 0;
  D.eachDay(c.from, c.to).forEach((d) => {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (policy.weekendsPaid || !offs.has(dow)) n += 1;
  });
  return n;
}

// People who LEFT during (or before the end of) a cycle: employeeId -> last working
// day. Only for months on the new cycle, so every older month reads exactly as before.
const EXIT_STATUSES = ['Notice Period', 'Exit Process', 'Relieved', 'Exited'];
async function leaversIn(employees, cycle) {
  const out = new Map();
  if (!cycle.custom) return out;
  const ids = employees.filter((e) => EXIT_STATUSES.includes(e.employmentStatus)).map((e) => e.id);
  if (!ids.length) return out;
  const sums = await require('./resignationInfo').summariesFor(ids).catch(() => new Map());
  sums.forEach((x, id) => { if (x && x.lastWorkingDate && x.lastWorkingDate < cycle.to) out.set(id, x.lastWorkingDate); });
  return out;
}

// For the absent-without-leave rule: the dates anybody has data for, and each
// person's REJECTED leave dates (a rejected request was still an application).
async function awlContext(employees, cycle) {
  const ids = employees.map((e) => e.id);
  const range = { gte: cycle.from, lte: cycle.to };
  const [a, b, c, rej] = await Promise.all([
    prisma.attendance.groupBy({ by: ['date'], where: { date: range } }),
    prisma.attendancePunch.groupBy({ by: ['date'], where: { date: range } }),
    prisma.attendanceHistory.groupBy({ by: ['date'], where: { date: range } }),
    prisma.leaveRequest.findMany({
      where: { employeeId: { in: ids }, status: 'Rejected', fromDate: { lte: cycle.to }, toDate: { gte: cycle.from } },
      select: { employeeId: true, fromDate: true, toDate: true },
    }),
  ]);
  const withData = new Set([...a, ...b, ...c].map((g) => g.date));
  const rejected = new Map();
  rej.forEach((l) => {
    if (!rejected.has(l.employeeId)) rejected.set(l.employeeId, new Set());
    D.eachDay(String(l.fromDate).slice(0, 10), String(l.toDate).slice(0, 10)).forEach((d) => rejected.get(l.employeeId).add(d));
  });
  return { withData, rejected };
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
  // The payroll month's own days (utils/payrollCycle.js): 16 Aug - 15 Sep for "Sep 2026".
  const settings = await PC.getSettings();
  const cycle = PC.cycleOf(month, settings.cycle);
  const rule = PC.absentRuleFor(month, settings.absent);
  const { from, to } = cycle;
  const leavers = await leaversIn(employees, cycle);
  const { days } = await D.loadDays(prisma, { employees, from, to, cfg: policy, lastDayOf: leavers.size ? leavers : null });
  const workingDays = payrollWorkingDays(month, policy, cycle);
  const offs = D.weeklyOffs(policy);
  const awlCtx = rule.active ? await awlContext(employees, cycle) : null;
  const unmarkedUnpaid = policy.unmarkedDaysUnpaid !== false;
  const out = new Map();
  employees.forEach((e) => {
    const rows = days(e);
    const s = D.summarise(rows.filter((d) => !['Upcoming', 'Not Joined', 'Left'].includes(d.status)));
    const payable = (d) => policy.weekendsPaid || !offs.has(new Date(`${d.date}T00:00:00Z`).getUTCDay());
    const notJoined = rows.filter((d) => d.status === 'Not Joined' && payable(d)).length;
    // Days after the last working day are not paid: prorated by the cycle's own days.
    const afterExit = rows.filter((d) => d.status === 'Left' && payable(d)).length;
    const excessLate = Math.max(0, s.lateArrivals - Number(policy.freeLateArrivalsPerMonth || 0));
    const unpaidLeave = Math.max(0, s.leaveDays - Number(policy.paidLeaveDaysPerMonth || 0));
    // ABSENT WITHOUT APPLYING LEAVE: an absent working day with no leave of any kind
    // counts `rule.days` (2) LOP days instead of 1 (utils/absentNoLeave.js).
    const awl = ANL.detect(rows, {
      rule, withData: awlCtx ? awlCtx.withData : null, rejected: awlCtx ? (awlCtx.rejected.get(e.id) || null) : null, unmarkedUnpaid,
    });
    const lop = s.absentDays + s.pendingDays + (unmarkedUnpaid ? s.missingCheckIn : 0) + unpaidLeave + notJoined + afterExit + 0.5 * excessLate + awl.extraLop;
    const present = s.presentDays + (unmarkedUnpaid ? 0 : s.missingCheckIn);
    out.set(e.id, {
      workingDays,
      daysPresent: present,
      daysLop: Math.min(workingDays, lop),
      source: 'ATTENDANCE',
      cycle: { key: cycle.key, from, to, days: cycle.days },
      awl: awl.active ? awl : null,
      detail: {
        notJoinedDays: notJoined, afterExitDays: afterExit, lastWorkingDate: leavers.get(e.id) || null,
        absentNoLeaveDays: awl.days, absentNoLeaveDates: awl.dates, absentNoLeaveHalfDays: awl.halfDays, absentNoLeaveLop: awl.lop,
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
      awl: null, // HR's figures stand as typed: no automatic absent-without-leave penalty on top
      override: {
        id: o.id, reason: o.reason, by: o.overriddenByName, at: o.overriddenAt,
        autoDaysPresent: auto.daysPresent, autoDaysLop: auto.daysLop,
      },
    });
  });
  return { workingDays, map };
}

// ---- The arithmetic ----------------------------------------------------------
// `register` = { pfRule } in a pay-register month (utils/payrollRegister.js), else null.
function computeEntry({ version, att, policy, incentive = 0, register = null }) {
  if (register) return computeRegisterEntry({ version, att, policy, incentive, pfRule: register.pfRule || null });
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

// The pay-register month: the shared calculation (utils/payrollCalc.js) on the version, in paise.
function computeRegisterEntry({ version, att, policy, incentive, pfRule }) {
  const { payrollCalc } = require('./payrollCalc');
  const rules = REG.rulesOf(version, policy, version.payMode, pfRule);
  const stipend = rules.payMode === 'Stipend';
  const res = payrollCalc({
    workingDays: Number(att.workingDays) || 0, daysLop: Number(att.daysLop) || 0,
    basic: version.basic, hra: version.hra, bonus: version.bonus, specialAllowance: version.specialAllowance, conveyance: version.conveyance,
    stipend: version.stipend, incentive: Math.max(0, REG.r2(incentive)), arrears: 0, extraEarn: [], extraDed: [],
    otherDeductions: 0, loan: 0, manual: {},
  }, rules);
  // the engine's own cap: other deductions never take net pay below 0
  const room = Math.max(0, REG.r2(res.earnedGross - res.pfEmployee - res.esiEmployee - res.professionalTax - res.tds));
  const otherDeductions = Math.min(Math.max(0, REG.r2(version.otherDeductions)), room);
  const totalDeductions = REG.r2(res.totalDeductions + otherDeductions);
  return {
    payMode: stipend ? 'Stipend' : 'Package',
    workingDays: res.workingDays, daysPresent: Number(att.daysPresent) || 0, daysLop: res.daysLop,
    basic: res.basic, hra: res.hra, bonus: res.bonus, specialAllowance: res.specialAllowance, conveyance: res.conveyance, incentive: res.incentive,
    grossPay: res.grossPay, lopDeduction: res.lopDeduction, earnedGross: res.earnedGross,
    pfEmployee: res.pfEmployee, esiEmployee: res.esiEmployee, professionalTax: res.professionalTax, tds: res.tds, otherDeductions,
    totalDeductions, netPay: REG.r2(res.grossPay - totalDeductions),
    pfEmployer: res.pfEmployer, esiEmployer: res.esiEmployer, gratuity: res.gratuity,
  };
}

// The register switch + PF rules for one month's versions: (version) -> { pfRule } | null.
async function registerFor(month, versions) {
  if (!(await REG.isRegisterMonth(month))) return () => null;
  const rules = await REG.pfRulesFor([...versions].map((v) => v && v.id));
  return (v) => ({ pfRule: (v && rules.get(v.id)) || null });
}

// ---- Month-level run (the existing PayrollRun row is the month's container) --
function monthStatusOf(entries) {
  if (!entries.length) return null;
  const idx = Math.min(...entries.map((e) => STATUSES.indexOf(e.status)));
  return STATUS_LABEL[STATUSES[idx]] || 'Calculated';
}

async function refreshMonthRun(month, actorName = null) {
  const entries = await prisma.employeePayrollRun.findMany({ where: { month } });
  const run = await prisma.payrollRun.findUnique({ where: { month } });
  if (!entries.length) return run;
  const sum = (k) => REG.r2(entries.reduce((n, e) => n + (Number(e[k]) || 0), 0)); // to the paisa (no float tail)
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
  const settings = await PC.getSettings();
  const cycle = PC.cycleOf(month, settings.cycle);
  // The switch-over guard: a payroll month may not be created over days an earlier
  // payroll already paid (plain message; a dry run only reports it).
  const overlap = await overlapProblem(month, cycle, settings);
  if (overlap && !dryRun) throw new PayrollError(409, overlap.message, { overlap });
  // Super Admin is a system account, never on a payroll run (utils/systemAccounts.js).
  const where = { AND: [employeeWhere, { employmentStatus: { in: PAYABLE_STATUSES } }, NOT_SYSTEM_EMPLOYEE] };
  if (department) where.AND.push({ department });
  if (Array.isArray(employeeIds)) where.AND.push({ id: { in: employeeIds } });
  let employees = await prisma.employee.findMany({ where, orderBy: { name: 'asc' } });
  // On the payroll cycle, somebody whose last working day falls inside the cycle is
  // paid for the days they worked (prorated by the cycle's own days).
  if (cycle.custom) {
    const lw = { AND: [employeeWhere, { employmentStatus: { in: ['Relieved', 'Exited', 'Exit Process'] } }, NOT_SYSTEM_EMPLOYEE] };
    if (department) lw.AND.push({ department });
    if (Array.isArray(employeeIds)) lw.AND.push({ id: { in: employeeIds } });
    const gone = await prisma.employee.findMany({ where: lw, orderBy: { name: 'asc' } });
    if (gone.length) {
      const sums = await require('./resignationInfo').summariesFor(gone.map((g) => g.id)).catch(() => new Map());
      const have = new Set(employees.map((e) => e.id));
      const inCycle = gone.filter((g) => { const x = sums.get(g.id); return !have.has(g.id) && x && x.lastWorkingDate && x.lastWorkingDate >= cycle.from && x.lastWorkingDate <= cycle.to; });
      if (inCycle.length) employees = [...employees, ...inCycle].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    }
  }
  // Somebody no longer on the payroll statuses (Relieved / Exited / ...) for whom HR entered this month's payroll
  // days (PayrollAttendance - e.g. the attendance sheet lists the days they worked before leaving) is paid for them.
  {
    const have = new Set(employees.map((e) => e.id));
    const typed = await prisma.payrollAttendance.findMany({ where: { month }, select: { employeeId: true } });
    const extra = typed.map((t) => t.employeeId).filter((id) => !have.has(id));
    if (extra.length) {
      const xw = { AND: [employeeWhere, { id: { in: extra } }, NOT_SYSTEM_EMPLOYEE] };
      if (department) xw.AND.push({ department });
      if (Array.isArray(employeeIds)) xw.AND.push({ id: { in: employeeIds } });
      const more = await prisma.employee.findMany({ where: xw });
      if (more.length) employees = [...employees, ...more].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    }
  }
  const ids = employees.map((e) => e.id);
  const [versions, { workingDays, map: inputs }, existing, incentives] = await Promise.all([
    versionsFor(ids, month),
    attendanceInputs(employees, month, policy),
    prisma.employeePayrollRun.findMany({ where: { month, employeeId: { in: ids } } }),
    incentivesFor(ids, month),
  ]);
  const existingOf = new Map(existing.map((e) => [e.employeeId, e]));
  const regOf = await registerFor(month, versions.values());
  const { year, monthNum } = monthParts(month);
  // Payroll edit (utils/payrollEdit.js): a record somebody EDITED is never overwritten by a recalculation
  // (it is reset only by "Recalculate from attendance" on that record); adjustments from earlier months
  // (arrears / recovery) are added to the month's records.
  const PEdit = require('./payrollEdit');
  const [editedSet, adjMap] = await Promise.all([PEdit.editedIds(existing.map((e) => e.id)), PEdit.adjustmentsFor(month)]);
  const edited = [];

  const rows = [];
  const skipped = [];
  const locked = [];
  employees.forEach((emp) => {
    const v = versions.get(emp.id);
    const base = { employeeId: emp.id, employeeCode: emp.employeeCode, name: emp.name, department: emp.department };
    if (!v) { skipped.push({ ...base, reason: `No salary structure effective in ${monthLabel(month)}` }); return; }
    const reg = regOf(v);
    const c0 = computeEntry({ version: v, att: inputs.get(emp.id), policy, incentive: incentives.get(emp.id) || 0, register: reg });
    const adjusted = PEdit.applyAdjustments(c0, v, policy, adjMap.get(emp.id), reg);
    const c = adjusted.row;
    if (!(c.grossPay > 0)) { skipped.push({ ...base, reason: v.payMode === 'Stipend' ? 'Stipend is 0' : 'No CTC set' }); return; }
    const prior = existingOf.get(emp.id);
    if (prior && prior.status !== 'DRAFT') { locked.push({ ...base, id: prior.id, status: prior.status }); return; }
    // a record IMPORTED from the pay register as it is (scripts/payroll-import-register-as-is.js, founder 2026-10-29: "deni em change kuda
    // upload chey ... evvi correct calculation ne") keeps the register's figures: never recalculated
    if (prior && (prior.importNote || prior.importedBreakup)) { locked.push({ ...base, id: prior.id, status: 'IMPORTED' }); return; }
    if (prior && editedSet.has(prior.id)) { edited.push({ ...base, id: prior.id }); return; }
    rows.push({
      ...base, ...c, adjLines: adjusted.lines, salaryVersionId: v.id, effectiveFrom: v.effectiveFrom,
      attendanceSource: inputs.get(emp.id).source, attendance: inputs.get(emp.id), existingId: prior ? prior.id : null,
    });
  });

  const totals = rows.reduce((a, r) => ({
    employees: a.employees + 1, gross: a.gross + r.grossPay, deductions: a.deductions + r.totalDeductions, net: a.net + r.netPay,
  }), { employees: 0, gross: 0, deductions: 0, net: 0 });
  const result = {
    month, period: monthLabel(month), workingDays, rows, skipped, locked, edited, totals,
    cycle: { key: cycle.key, label: cycle.label, from: cycle.from, to: cycle.to, days: cycle.days, rangeText: cycle.rangeText, heading: cycle.heading, custom: cycle.custom },
    overlap: overlap || null, absentRule: PC.absentRuleFor(month, settings.absent),
  };
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
      arrears: r.arrears || 0,
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
  // A record keeps its own pay period and absent-without-leave detail (AppSetting
  // 'payroll.snapshot:<month>'), so a later change of the settings never rewrites it.
  await saveSnapshot(month, cycle, rows.filter((r) => r.id));
  // each record's edit state: back to the engine baseline + its adjustment lines
  await PEdit.afterCalculate(rows.filter((r) => r.id).map((r) => ({ id: r.id, employeeId: r.employeeId })), adjMap, actor);
  // The incentives now carried by a payroll record point at it.
  for (const r of rows) {
    if (!r.id || !r.incentive) continue;
    // eslint-disable-next-line no-await-in-loop
    await prisma.recruiterJoiningDecision.updateMany({ where: { employeeId: r.employeeId, payMonth: month, decision: 'INCENTIVE' }, data: { payrollEntryId: r.id } }).catch(() => {});
    // eslint-disable-next-line no-await-in-loop
    await require('./incentives').linkPayroll(r.employeeId, month, r.id);
  }
  if (rows.length || locked.length) await refreshMonthRun(month, actor ? actor.name : null);
  if (actor && (created || updated)) {
    await logAudit({
      userId: actor.id || null, actorName: actor.name, action: 'Payroll calculated', entity: 'PayrollRun',
      entityId: run ? run.id : null, toValue: `${monthLabel(month)}: ${created} created, ${updated} recalculated, ${locked.length} locked`,
    });
  }
  return { ...result, created, updated, run: await prisma.payrollRun.findUnique({ where: { month } }) };
}

// One employee-month straight from the engine (structure + attendance + incentive + the month's
// adjustments), without writing anything: what "Recalculate from attendance" compares and applies.
async function engineRowFor(employeeId, month) {
  const PEdit = require('./payrollEdit');
  const emp = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!emp) return null;
  const policy = await getPolicy();
  const [versions, { map: inputs }, incentives, adjMap] = await Promise.all([
    versionsFor([employeeId], month), attendanceInputs([emp], month, policy), incentivesFor([employeeId], month), PEdit.adjustmentsFor(month),
  ]);
  const v = versions.get(employeeId);
  if (!v) return null;
  const reg = (await registerFor(month, [v]))(v);
  const c0 = computeEntry({ version: v, att: inputs.get(employeeId), policy, incentive: incentives.get(employeeId) || 0, register: reg });
  const adjusted = PEdit.applyAdjustments(c0, v, policy, adjMap.get(employeeId), reg);
  return { ...adjusted.row, lines: adjusted.lines, salaryVersionId: v.id, attendance: inputs.get(employeeId) };
}

// ---- The switch-over guard ----------------------------------------------------
// Refuse a NEW payroll month whose days overlap a month that is already beyond
// DRAFT (or an old month run): the same day must never be paid twice.
async function overlapProblem(month, cycle, settings) {
  if (await prisma.employeePayrollRun.count({ where: { month } })) return null; // recalculating what already exists
  const others = [PC.addMonths(month, -2), PC.addMonths(month, -1), PC.addMonths(month, 1), PC.addMonths(month, 2)];
  const paid = await prisma.employeePayrollRun.groupBy({ by: ['month'], where: { month: { in: others }, status: { not: 'DRAFT' } } });
  const runs = await prisma.payrollRun.findMany({ where: { month: { in: others }, status: { in: ['Processing', 'Paid'] } }, select: { month: true } });
  const months = [...new Set([...paid.map((p) => p.month), ...runs.map((r) => r.month)])];
  for (const m of months) {
    const c = PC.cycleOf(m, settings.cycle);
    const days = PC.overlapDays(cycle, c);
    if (days > 0) {
      const from = cycle.from > c.from ? cycle.from : c.from;
      const to = cycle.to < c.to ? cycle.to : c.to;
      return {
        otherMonth: m, days, from, to,
        message: `${cycle.label} payroll (${cycle.rangeText}) cannot be created: ${PC.dayMon(from)} – ${PC.dayMon(to)} (${days} day${days === 1 ? '' : 's'}) ${days === 1 ? 'was' : 'were'} already paid in the ${c.label} payroll (${c.rangeText}). Pick the first cycle start date after those days (Payroll policy → Payroll cycle) so nothing is paid twice.`,
      };
    }
  }
  return null;
}

async function saveSnapshot(month, cycle, rows) {
  if (!rows.length) return;
  const key = `payroll.snapshot:${month}`;
  const row = await prisma.appSetting.findUnique({ where: { key } }).catch(() => null);
  let cur = {};
  try { cur = row ? JSON.parse(row.value) : {}; } catch { cur = {}; }
  const people = cur.people || {};
  rows.forEach((r) => {
    const a = r.attendance && r.attendance.awl;
    people[r.employeeId] = {
      awl: a ? { days: a.days, dates: a.dates, halfDays: a.halfDays, halfDates: a.halfDates, perDay: a.perDay, perHalf: a.perHalf, lop: a.lop } : null,
      lastWorkingDate: r.attendance && r.attendance.detail ? r.attendance.detail.lastWorkingDate : null,
    };
  });
  const value = JSON.stringify({ cycle: { key: cycle.key, from: cycle.from, to: cycle.to, days: cycle.days, label: cycle.label, custom: cycle.custom }, savedAt: new Date().toISOString(), people });
  await prisma.appSetting.upsert({ where: { key }, update: { value }, create: { key, value } }).catch(() => {});
}
async function readSnapshot(month) {
  const row = await prisma.appSetting.findUnique({ where: { key: `payroll.snapshot:${month}` } }).catch(() => null);
  try { return row ? JSON.parse(row.value) : null; } catch { return null; }
}

// Incentives paid in `month`: the recruiter-joinings decisions (utils/
// recruiterJoinings.js) and the approved department-rule awards
// (utils/incentives.js): Map(employeeId -> rupees).
async function incentivesFor(employeeIds, month) {
  const out = new Map();
  if (!employeeIds.length) return out;
  const rows = await prisma.recruiterJoiningDecision.findMany({
    where: { employeeId: { in: employeeIds }, payMonth: month, decision: 'INCENTIVE' },
    select: { employeeId: true, amount: true },
  }).catch(() => []);
  rows.forEach((d) => out.set(d.employeeId, (out.get(d.employeeId) || 0) + Math.max(0, Math.round(Number(d.amount) || 0))));
  // + the department-rule incentives Super Admin APPROVED for this pay month
  // (utils/incentives.js): the same "Incentive" earning line.
  const awards = await require('./incentives').approvedFor(employeeIds, month).catch(() => new Map());
  awards.forEach((amt, id) => out.set(id, (out.get(id) || 0) + amt));
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
  const slip = await prisma.payslip.upsert({
    where: { employeeId_month: { employeeId: entry.employeeId, month: entry.month } },
    update: fields,
    create: { employeeId: entry.employeeId, month: entry.month, ...fields },
  });
  // The labelled added earning / deduction rows of a payroll edit stay with THIS payslip (utils/payrollEdit.js).
  await require('./payrollEdit').snapshotPayslipLines(slip, entry);
  return slip;
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
  if (action === 'approve') {
    // Maker-checker: the person who edited this record cannot approve it.
    const block = await require('./payrollEdit').makerCheckerBlock(entry, actor && actor.id);
    if (block) throw new PayrollError(403, `${entry.employee.name}: ${block}`, { status: entry.status });
  }
  // A record imported from the pay register as it is carries the register's own figures: nothing to compare with a fresh run.
  const imported = !!(entry.importNote || entry.importedBreakup);
  if (action === 'submit' && !imported) {
    // A draft computed from a structure that has since been revised must be
    // recalculated first, or the approver would approve the old figures.
    const v = await versionFor(entry.employeeId, entry.month);
    if (!v || v.id !== entry.salaryVersionId || (entry.calculatedAt && v.updatedAt > entry.calculatedAt)) {
      throw new PayrollError(409, `${entry.employee.name}'s salary structure changed after this payroll was calculated — recalculate ${monthLabel(entry.month)} first.`);
    }
    // The same for attendance: a leave approved / rejected, or an absence fixed, since the
    // draft was calculated (only for months on the payroll cycle / absent rule).
    // A record somebody EDITED stands as edited: its days / incentive are not compared with a fresh run
    // (the approver sees the change in "Changes in this run"); "Recalculate from attendance" resets it.
    const isEdited = (await require('./payrollEdit').editedIds([entry.id])).has(entry.id);
    if (entry.attendanceSource === 'ATTENDANCE' && !isEdited) {
      const st = await PC.getSettings();
      if (PC.cycleApplies(entry.month, st.cycle) || PC.absentRuleFor(entry.month, st.absent).active) {
        const { map } = await attendanceDefaults([entry.employee], entry.month, await getPolicy());
        const now = map.get(entry.employeeId);
        if (now && Math.abs((Number(now.daysLop) || 0) - (Number(entry.daysLop) || 0)) > 0.001) {
          throw new PayrollError(409, `${entry.employee.name}'s attendance or leave changed after this payroll was calculated (loss of pay is now ${now.daysLop} day(s), the calculated payroll has ${entry.daysLop}) — recalculate ${monthLabel(entry.month)} first.`);
        }
      }
    }
    // The same for a recruiter-joinings incentive given / changed / undone since.
    const inc = (await incentivesFor([entry.employeeId], entry.month)).get(entry.employeeId) || 0;
    // (an edited record keeps an incentive the editor typed; one that was NOT touched must still match the decision)
    const editState = isEdited ? await require('./payrollEdit').readState(entry.id) : null;
    const base0 = editState && editState.versions[0] ? Math.round(Number(editState.versions[0].after.fields.incentive) || 0) : null;
    const typedIncentive = base0 !== null && Math.round(Number(entry.incentive) || 0) !== base0;
    if (!typedIncentive && inc !== Math.round(Number(entry.incentive) || 0)) {
      throw new PayrollError(409, `${entry.employee.name}'s incentive changed after this payroll was calculated — recalculate ${monthLabel(entry.month)} first.`);
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
  getPolicy, isMonth, monthParts, payrollWorkingDays, overlapProblem, readSnapshot,
  attendanceDefaults, attendanceInputs, computeEntry, computeRegisterEntry, registerFor, calculateMonth, engineRowFor, refreshMonthRun,
  writePayslip, transition, historyOf, incentivesFor,
};
