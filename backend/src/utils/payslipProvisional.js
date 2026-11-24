'use strict';
// ---------------------------------------------------------------------------
// A PAYSLIP IN EVERYBODY'S LOGIN AS SOON AS PAYROLL IS CALCULATED (founder 2026-11-24: "monthly payroll run calculate ainaka andhariki
// payslips vala logins lo kanipinchali").
//
// The issued payslip (the Payslip table) is still written only when a record is APPROVED, and everything that reads that table (the
// dashboard totals, Accounts, exports, the AI helper) keeps seeing approved figures only. Until then a person's OWN payslip for a
// month is shown from their calculated record (Draft / Sent for approval), marked PROVISIONAL, and it moves with the record: a
// recalculation or an edit shows at once, nothing is stored and nothing can go stale.
//
// Only once the pay period is over (a month calculated early, while its period is still running, has part-month attendance and a loss of
// pay that is not real). Only the person's own: the payroll desk's all-people Payslips register still lists issued payslips, the desk works from Process Payroll.
// When the record is approved the issued payslip takes over (same month), and a month that already has an issued payslip (approved,
// then re-opened) keeps showing that one.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const PC = require('./payrollCycle');

const PROVISIONAL_STATUSES = ['DRAFT', 'PENDING_APPROVAL']; // a calculated record nobody has approved yet
const PREFIX = 'draft-';

// Only once the pay period is OVER. A month calculated while its period is still running (HR looks ahead) has attendance for part of
// the period only, so it would show a big loss of pay that is not real: nobody is shown that. `to` is the period's last day (YYYY-MM-DD).
const todayIst = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const periodEnded = (to, today = todayIst()) => !!to && String(to).slice(0, 10) < String(today).slice(0, 10);
async function endedMonths(months, today = todayIst()) {
  const out = new Set();
  for (const m of [...new Set(months)]) {
    // eslint-disable-next-line no-await-in-loop
    const c = await PC.cycleFor(m).catch(() => null);
    if (c && periodEnded(c.to, today)) out.add(m);
  }
  return out;
}

const idFor = (entryId) => `${PREFIX}${entryId}`;
const isProvisionalId = (id) => typeof id === 'string' && id.startsWith(PREFIX) && id.length > PREFIX.length;
const entryIdOf = (id) => (isProvisionalId(id) ? id.slice(PREFIX.length) : null);

// A payslip-shaped object (what routes/payroll.js payslipPayload reads) made from one calculated record. Pure.
//   fields: the engine's slipFieldsOf(entry), lines: the labelled added rows (payrollEdit.payslipLinesOf) or null
function slipLike(entry, fields, lines = null) {
  return {
    ...fields,
    id: idFor(entry.id), employeeId: entry.employeeId, employee: entry.employee, month: entry.month,
    generatedAt: entry.calculatedAt || entry.updatedAt || entry.createdAt || null,
    provisional: true,
    ...(lines ? { _lines: lines } : {}),
  };
}

// newest month first; for one month the order given is kept
function newestFirst(list) {
  return list.map((x, i) => [x, i]).sort((a, b) => String(b[0].month || '').localeCompare(String(a[0].month || '')) || (a[1] - b[1])).map((p) => p[0]);
}

// the person's own calculated-but-not-approved months, as payslip-shaped objects (no `_lines`: the list does not need them)
async function ownFor(employeeId, { month = null } = {}) {
  if (!employeeId) return [];
  const E = require('./payrollEngine');
  const where = { employeeId, status: { in: PROVISIONAL_STATUSES } };
  if (month) where.month = month;
  const entries = await prisma.employeePayrollRun.findMany({ where, include: { employee: true }, orderBy: { month: 'desc' } });
  if (!entries.length) return [];
  const issued = await prisma.payslip.findMany({ where: { employeeId, month: { in: entries.map((e) => e.month) } }, select: { month: true } });
  const have = new Set(issued.map((p) => p.month));
  const over = await endedMonths(entries.map((e) => e.month));
  return entries.filter((e) => !have.has(e.month) && over.has(e.month)).map((e) => slipLike(e, E.slipFieldsOf(e)));
}

// One provisional payslip by its id ("draft-<record id>"), with the labelled rows of an edited record. Returns:
//   { slip }        the provisional payslip,
//   { issued }      the record was approved since the list was opened: the issued payslip of that month (the caller serves it instead),
//   null            no such record.
async function byId(id) {
  const entryId = entryIdOf(id);
  if (!entryId) return null;
  const E = require('./payrollEngine');
  const PEdit = require('./payrollEdit');
  const entry = await prisma.employeePayrollRun.findUnique({ where: { id: entryId }, include: { employee: true } });
  if (!entry) return null;
  if (!PROVISIONAL_STATUSES.includes(entry.status)) {
    const issued = await prisma.payslip.findUnique({ where: { employeeId_month: { employeeId: entry.employeeId, month: entry.month } }, include: { employee: true } });
    return issued ? { issued } : null;
  }
  if (!(await endedMonths([entry.month])).has(entry.month)) return null; // the pay period is still running: not shown
  const state = await PEdit.readState(entry.id).catch(() => null);
  return { slip: slipLike(entry, E.slipFieldsOf(entry), state ? PEdit.payslipLinesOf(entry, state) : null) };
}

module.exports = { PROVISIONAL_STATUSES, idFor, isProvisionalId, entryIdOf, slipLike, newestFirst, periodEnded, ownFor, byId };
