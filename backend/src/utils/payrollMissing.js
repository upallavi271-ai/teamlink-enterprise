'use strict';
// ---------------------------------------------------------------------------
// EVERYBODY ON THE PAYROLL LIST (founder 2026-11-24: "every employee ki payroll work avali, andharivi kanipinchali, last month lo
// join avina sarey").
//
// The Salaries table (Process Payroll) lists calculated records only. Somebody with no record for the month - a new joiner whose
// salary structure HR added after the last Calculate, or who has no structure yet - was simply missing, with no hint why. This
// works out WHO has no record for the month and WHY, so the screen can list them with what to do next.
//
// READ ONLY: nothing is calculated, written or paid here, and the rule in calculateMonth is untouched - somebody with no salary
// structure is never paid a default.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const PC = require('./payrollCycle');
const { versionsFor } = require('./salaryVersions');
const { NOT_SYSTEM_EMPLOYEE } = require('./systemAccounts');

const PAYABLE_STATUSES = ['Active', 'On Probation', 'Notice Period']; // the same list payrollEngine.calculateMonth pays

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dmy = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${Number(m[3])} ${MON[Number(m[2]) - 1]} ${m[1]}` : ''; };

// the order the screen lists them in: what can be done right now first
const ORDER = { NOT_CALCULATED: 0, NO_STRUCTURE: 1, NO_PAY: 2, STRUCTURE_LATER: 3, NOT_JOINED: 4 };

// The reason for one person (pure, so it can be tested without a database).
//   e: { dateOfJoining }, cycle: { to, rangeText }, version: the salary version effective in the month (or null),
//   laterFrom: the first salary version that starts AFTER the month (or null)
function reasonOf(e, cycle, version, laterFrom) {
  const doj = e.dateOfJoining ? new Date(e.dateOfJoining).toISOString().slice(0, 10) : null;
  if (doj && cycle.to && doj > cycle.to) {
    return { code: 'NOT_JOINED', reason: `Joins on ${dmy(doj)}, after this pay period${cycle.rangeText ? ` (${cycle.rangeText})` : ''}, so nothing is due yet.` };
  }
  if (!version) {
    if (laterFrom) return { code: 'STRUCTURE_LATER', reason: `Salary structure only starts on ${dmy(laterFrom)}, after this pay period. Set an earlier effective month under Salary Structure.` };
    return { code: 'NO_STRUCTURE', reason: 'No salary structure yet. Add one under Salary Structure, then press Calculate. Nobody is paid a default.' };
  }
  // the same test calculateMonth uses: a Package is Basic + HRA + Bonus + Special + Conveyance, a Stipend is the stipend (utils/payrollCalc.js baseGross)
  const pay = version.payMode === 'Stipend'
    ? Number(version.stipend) || 0
    : ['basic', 'hra', 'bonus', 'specialAllowance', 'conveyance'].reduce((n, k) => n + (Number(version[k]) || 0), 0);
  if (!(pay > 0)) return { code: 'NO_PAY', reason: version.payMode === 'Stipend' ? 'The stipend on the salary structure is 0. Set it under Salary Structure.' : 'No CTC is set on the salary structure. Set it under Salary Structure.' };
  return { code: 'NOT_CALCULATED', reason: 'Salary structure is in place but the month was not calculated since. Press Calculate.' };
}

// month 'YYYY-MM'; employeeWhere = the caller's payroll scope (a prisma Employee filter); haveIds = employees that already have a record
async function missingFor({ month, employeeWhere = {}, department = null, haveIds = [] }) {
  const cycle = await PC.cycleFor(month);
  const where = { AND: [employeeWhere, { employmentStatus: { in: PAYABLE_STATUSES } }, NOT_SYSTEM_EMPLOYEE] };
  if (department) where.AND.push({ department });
  const emps = await prisma.employee.findMany({
    where, orderBy: { name: 'asc' },
    select: { id: true, employeeCode: true, name: true, department: true, designation: true, employmentStatus: true, dateOfJoining: true },
  });
  const have = new Set(haveIds);
  const todo = emps.filter((e) => !have.has(e.id));
  if (!todo.length) return [];
  const ids = todo.map((e) => e.id);
  const [versions, later] = await Promise.all([
    versionsFor(ids, month),
    prisma.salaryStructureVersion.findMany({
      where: { employeeId: { in: ids }, effectiveFrom: { gt: `${month}-01` } }, orderBy: { effectiveFrom: 'asc' }, select: { employeeId: true, effectiveFrom: true },
    }),
  ]);
  const laterOf = new Map();
  later.forEach((v) => { if (!laterOf.has(v.employeeId)) laterOf.set(v.employeeId, v.effectiveFrom); });
  return todo
    .map((e) => {
      const r = reasonOf(e, cycle, versions.get(e.id) || null, laterOf.get(e.id) || null);
      return {
        employeeId: e.id, employeeCode: e.employeeCode, name: e.name, department: e.department, designation: e.designation,
        employmentStatus: e.employmentStatus, dateOfJoining: e.dateOfJoining ? new Date(e.dateOfJoining).toISOString().slice(0, 10) : null,
        code: r.code, reason: r.reason, canCalculate: r.code === 'NOT_CALCULATED',
      };
    })
    .sort((a, b) => (ORDER[a.code] - ORDER[b.code]) || String(a.name || '').localeCompare(String(b.name || '')));
}

module.exports = { missingFor, reasonOf, PAYABLE_STATUSES };
