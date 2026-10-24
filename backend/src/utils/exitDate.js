// ---------------------------------------------------------------------------
// THE EXIT DATE, ONE SOURCE OF TRUTH (HRMS spec item 7, 2026-10-13).
//
// "Reflect changes consistently across employee records, attendance, leave,
//  payroll and reports. Record the previous date, updated date, reason and the
//  person making the change."
//
// THE CANONICAL FIELD is the last working day of the person's CURRENT
// resignation record: EmployeeRecord(type RESIGNATION).date. It was already the
// field the Resignation list, the employee profile, payroll proration (the
// 'Left' day status) and Full & Final read (utils/resignationInfo.js). Employee
// has no exit-date column and none is needed: every exit - a resignation filed
// by the employee, an exit started by HR, a status set on the Edit form - gets
// ONE resignation record (utils/exitFlow.js), so there is always exactly one
// place to read and to change.
//
// The copies are MIRRORS, kept equal by recomputeEffects() in the same request:
//   ResignationDetail.approvedLastWorkingDate (requested one while pending)
//   FnfRequest.lastWorkingDate (the pending settlement)
//   PositionAssignment.toDate (the seat, when it was ended by this exit)
// Everything else READS the date through effectiveExitDate()/exitDatesFor():
//   attendance roll (utils/attendanceDays.js rollOf) - 'Left company' after it
//   leave (routes/leave.js) - no leave after it
//   payroll (utils/payrollEngine.js via resignationInfo) - days worked
//   dashboards / lists (hrmsDashboard, employeeAdmin) and the after-exit worklists
//
// Nothing here runs at load or on a timer: it changes data only when a person
// changes the date (setExitDate) or a script calls it.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('./audit');

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const DEAD = ['Withdrawn', 'Rejected'];
const SERVING = ['Notice Period', 'Accepted'];
const isoDay = (v) => (v && ISO.test(String(v).slice(0, 10)) ? String(v).slice(0, 10) : null);
const realDate = (s) => ISO.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const todayIso = () => require('./positions').today();
const MON3 = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const dmy = (iso) => (isoDay(iso) ? `${iso.slice(8, 10)} ${MON3[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : '');

function dateOf(record, detail) {
  return isoDay(record && record.date) || isoDay(detail && (detail.approvedLastWorkingDate || detail.requestedLastWorkingDate));
}

// The CURRENT resignation record of each person: the newest that is not
// Withdrawn / Rejected. Returns Map(employeeId -> { record, detail }).
async function liveRecords(employeeIds) {
  const ids = [...new Set(employeeIds)].filter(Boolean);
  const out = new Map();
  if (!ids.length) return out;
  const recs = await prisma.employeeRecord.findMany({
    where: { type: 'RESIGNATION', employeeId: { in: ids }, status: { notIn: DEAD } },
    orderBy: { createdAt: 'desc' },
  });
  if (!recs.length) return out;
  const details = await prisma.resignationDetail.findMany({ where: { recordId: { in: recs.map((r) => r.id) } } });
  const detailOf = new Map(details.map((d) => [d.recordId, d]));
  recs.forEach((r) => { if (!out.has(r.employeeId)) out.set(r.employeeId, { record: r, detail: detailOf.get(r.id) || null }); });
  return out;
}

// Map(employeeId -> { date, recordId, status }) for the people that HAVE an exit date the READERS may act on:
// an APPROVED exit (serving notice, or relieved while the person's status really says they left). A request still waiting
// for approval, or an old exit of somebody who has since been re-hired, is not a last working day yet.
// { approvedOnly: false } also returns the requested date of a pending request (the Exit record screens).
async function exitDatesFor(employeeIds, { approvedOnly = true } = {}) {
  const live = await liveRecords(employeeIds);
  const out = new Map();
  if (!live.size) return out;
  const emps = await prisma.employee.findMany({ where: { id: { in: [...live.keys()] } }, select: { id: true, employmentStatus: true } });
  const statusOf = new Map(emps.map((e) => [e.id, e.employmentStatus]));
  live.forEach(({ record, detail }, id) => {
    const date = dateOf(record, detail);
    if (!date) return;
    if (approvedOnly) {
      if (record.status === 'Pending Approval') return;
      if (record.status === 'Relieved' && !['Relieved', 'Exited', 'Terminated', 'Exit Process', 'Notice Period'].includes(statusOf.get(id))) return;
    }
    out.set(id, { date, recordId: record.id, status: record.status });
  });
  return out;
}

// THE helper every reader uses. Accepts an Employee row or an id; null = no exit date on record.
async function effectiveExitDate(employeeOrId) {
  const id = employeeOrId && typeof employeeOrId === 'object' ? employeeOrId.id : employeeOrId;
  if (!id) return null;
  const m = await exitDatesFor([id]);
  return m.has(id) ? m.get(id).date : null;
}

// Is this day AFTER the person's exit date (so they have left the company that day)?
const leftBy = (day, exitDate) => !!exitDate && !!day && String(day) > exitDate;

// ---- who may change it ------------------------------------------------------
const named = (v) => (v && v !== 'NONE' ? v : null);
const isSuperAdmin = (u) => !!u && (u.role === 'SUPER_ADMIN' || named(u.hrmsRole) === 'SUPER_ADMIN');
// The existing HR desk rule (utils/permissions.js SET.HR_DESK): Super Admin, Admin, HR.
function isHrDesk(u) {
  if (!u) return false;
  const HR_DESK = require('./permissions').SET.HR_DESK;
  return HR_DESK.includes(u.role) || HR_DESK.includes(named(u.hrmsRole));
}

// ---- payroll month already paid? -------------------------------------------
async function payrollStatusOn(date) {
  try {
    const PC = require('./payrollCycle');
    const st = await PC.getSettings();
    const m = PC.monthOfDate(date, st.cycle);
    if (!m) return null;
    const c = PC.cycleOf(m.month, st.cycle);
    const run = await prisma.payrollRun.findUnique({ where: { month: c.key } }).catch(() => null);
    const posted = await prisma.payrollVoucherEmployee.count({ where: { month: c.key } }).catch(() => 0);
    const entries = await prisma.employeePayrollRun.findMany({ where: { month: c.key }, select: { status: true } }).catch(() => []);
    const locked = entries.some((e) => !['DRAFT', 'Draft'].includes(e.status));
    const paid = !!(run && run.status === 'Paid');
    return { month: c.key, heading: c.heading, from: c.from, to: c.to, days: c.days, paid, posted: posted > 0, locked, closed: paid || posted > 0 || locked };
  } catch { return null; }
}

// ---- the seat (PositionAssignment.toDate) ----------------------------------
// The seat's end date follows the exit date when the seat was ended BY this exit
// (its note starts "Exited ..." / "Notice ended ..." - utils/seatRelease.js). It is
// never moved past the day the next holder started.
async function seatOf(employeeId) {
  const rows = await prisma.positionAssignment.findMany({
    where: { employeeId }, orderBy: [{ toDate: 'desc' }], include: { position: { select: { id: true, code: true } } },
  });
  const open = rows.find((r) => !r.toDate) || null;
  const ended = rows.filter((r) => r.toDate && /^(Exited|Notice ended|Relieved|Terminated)/i.test(r.note || ''))
    .sort((a, b) => String(b.toDate).localeCompare(String(a.toDate)))[0] || null;
  return { open, ended };
}
async function syncSeat(employeeId, date, user) {
  const { ended } = await seatOf(employeeId);
  if (!ended) return { changed: false, note: 'no seat was ended by this exit' };
  const next = await prisma.positionAssignment.findFirst({
    where: { positionId: ended.positionId, fromDate: { gt: ended.toDate }, NOT: { id: ended.id } }, orderBy: { fromDate: 'asc' },
  });
  let to = date < ended.fromDate ? ended.fromDate : date;
  let capped = false;
  if (next) {
    const dayBefore = new Date(`${next.fromDate}T00:00:00Z`);
    dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
    const cap = dayBefore.toISOString().slice(0, 10);
    if (to > cap) { to = cap; capped = true; }
  }
  if (to === ended.toDate) return { changed: false, note: capped ? `kept at ${to} (the next holder starts ${next.fromDate})` : 'already equal' };
  const note = `${(ended.note || '').replace(/ Seat freed \d{4}-\d{2}-\d{2},/, ` Seat freed ${to},`)}`.slice(0, 500);
  await prisma.positionAssignment.update({ where: { id: ended.id }, data: { toDate: to, note } });
  await logAudit({
    userId: user ? user.id : null, actorName: user ? (user.name || user.email) : 'System',
    action: `Seat ${ended.position.code} end date follows the exit date`, entity: 'Position', entityId: ended.position.id,
    fromValue: ended.toDate, toValue: to, reason: capped ? `capped: the next holder starts ${next.fromDate}` : 'exit date changed',
  });
  return { changed: true, from: ended.toDate, to, capped };
}

// ---- RECOMPUTE EXIT EFFECTS (idempotent) ------------------------------------
// Re-applies the canonical date to every mirror. Safe to run twice; returns what it did.
async function recomputeEffects(employeeId, { user = null, date = null } = {}) {
  const live = (await liveRecords([employeeId])).get(employeeId);
  if (!live) return { ok: false, reason: 'no exit record' };
  const { record, detail } = live;
  const d = date || dateOf(record, detail);
  if (!d) return { ok: false, reason: 'no date' };
  const out = { date: d, mirrors: [] };
  if (isoDay(record.date) !== d) { await prisma.employeeRecord.update({ where: { id: record.id }, data: { date: d } }); out.mirrors.push('resignation record'); }
  if (detail) {
    const pending = record.status === 'Pending Approval';
    const key = pending ? 'requestedLastWorkingDate' : 'approvedLastWorkingDate';
    if (detail[key] !== d) { await prisma.resignationDetail.update({ where: { id: detail.id }, data: { [key]: d } }); out.mirrors.push('resignation form'); }
  }
  const fnf = await prisma.fnfRequest.findMany({ where: { employeeId, status: 'Pending' } });
  for (const f of fnf) {
    if (isoDay(f.lastWorkingDate) !== d) { await prisma.fnfRequest.update({ where: { id: f.id }, data: { lastWorkingDate: d } }); out.mirrors.push('full & final request'); }
  }
  const seat = await syncSeat(employeeId, d, user);
  if (seat.changed) out.mirrors.push('seat end date');
  out.seat = seat;
  // Leave beyond the new date: flagged, never deleted.
  out.leaveAfter = await leaveAfter(employeeId, d);
  return { ok: true, ...out };
}

async function leaveAfter(employeeId, date) {
  const rows = await prisma.leaveRequest.findMany({
    where: { employeeId, status: { in: ['Approved', 'Pending'] }, toDate: { gt: date } },
    select: { id: true, type: true, fromDate: true, toDate: true, status: true, days: true },
  }).catch(() => []);
  return rows;
}

// ---- THE ONE WAY TO CHANGE THE DATE ----------------------------------------
class ExitDateError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.exitBlocked = true; Object.assign(this, extra); }
}

// Validates and (unless dryRun) writes. Returns { ok, from, to, warnings, effects }.
async function setExitDate({ employeeId, date, reason, note = null, user, source = 'UI', dryRun = false, ensureRecord = null }) {
  const warnings = [];
  const to = String(date || '').trim();
  if (!realDate(to)) throw new ExitDateError(400, 'Pick the new last working day as a date.');
  const why = String(reason || '').trim();
  if (why.length < 3) throw new ExitDateError(400, 'Say why the date is changing (at least a few words).');
  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee) throw new ExitDateError(404, 'Employee not found');
  let live = (await liveRecords([employeeId])).get(employeeId);
  if (!live) {
    // A person who is leaving by status alone (an old Edit-form change) has no record yet: make the one record.
    if (!ensureRecord) throw new ExitDateError(404, `${employee.name} has no exit on record. Start the exit first.`);
    if (dryRun) live = { record: { id: null, status: ensureRecord.status, date: null }, detail: null };
    else live = await ensureRecord();
  }
  const { record, detail } = live;
  const from = dateOf(record, detail);
  if (from === to) throw new ExitDateError(400, 'That is already the last working day.');
  const joined = employee.dateOfJoining ? new Date(employee.dateOfJoining).toISOString().slice(0, 10) : null;
  if (joined && to < joined) throw new ExitDateError(400, `The last working day cannot be before the joining date (${dmy(joined)}).`);
  const resignedOn = isoDay(detail && detail.resignationDate);
  if (resignedOn && to < resignedOn) throw new ExitDateError(400, `The last working day cannot be before the resignation date (${dmy(resignedOn)}).`);
  const finalised = record.status === 'Relieved' || ['Relieved', 'Exited', 'Terminated'].includes(employee.employmentStatus);
  const today = todayIso();
  if (finalised && to < today && !isSuperAdmin(user)) {
    throw new ExitDateError(403, `${employee.name} has already left. Only the Super Admin can move the last working day to a date in the past.`);
  }
  const pay = await payrollStatusOn(to);
  const payFrom = from ? await payrollStatusOn(from) : null;
  [pay, payFrom].filter(Boolean).forEach((p, i, arr) => {
    if (p.closed && !arr.slice(0, i).some((q) => q.month === p.month)) {
      const [y, m] = p.month.split('-');
      warnings.push(`Payroll for ${MON3[Number(m) - 1].charAt(0) + MON3[Number(m) - 1].slice(1).toLowerCase()} ${y} is already ${p.paid ? 'paid' : 'posted'}. A difference will be adjusted in the next payroll.`);
    }
  });
  if (to < today && !finalised) warnings.push(`That day has already passed and ${employee.name} is still working. Their days after it will show as "Left company".`);
  if (dryRun) return { ok: true, dryRun: true, from, to, warnings };

  await prisma.employeeRecord.update({ where: { id: record.id }, data: { date: to } });
  const actorName = user ? (user.name || user.email) : 'System';
  await logAudit({
    userId: user ? user.id : null, actorName, action: 'Exit date changed', entity: 'EmployeeRecord', entityId: record.id,
    field: 'exitDate', fieldLabel: `Last working day · ${source}`, fromValue: from || '(none)', toValue: to,
    reason: `${why}${note ? ` — ${String(note).trim()}` : ''}`.slice(0, 480),
  });
  await logAudit({
    userId: user ? user.id : null, actorName, action: 'Exit date changed', entity: 'Employee', entityId: employee.id,
    field: 'exitDate', fieldLabel: `Last working day · ${source}`, fromValue: from || '(none)', toValue: to, reason: why.slice(0, 480),
  });
  const effects = await recomputeEffects(employeeId, { user, date: to });
  return { ok: true, from, to, warnings, effects, recordId: record.id };
}

// The change log: previous date, new date, reason, who (name + role), when, source.
async function changesFor({ employeeId = null, recordId = null, limit = 300 } = {}) {
  let ids = recordId ? [recordId] : null;
  if (!ids && employeeId) ids = (await prisma.employeeRecord.findMany({ where: { type: 'RESIGNATION', employeeId }, select: { id: true } })).map((r) => r.id);
  const where = { action: 'Exit date changed', entity: 'EmployeeRecord', ...(ids ? { entityId: { in: ids } } : {}) };
  const rows = await prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, include: { user: { select: { name: true, role: true, hrmsRole: true } } } });
  const recIds = [...new Set(rows.map((r) => r.entityId).filter(Boolean))];
  const recs = recIds.length ? await prisma.employeeRecord.findMany({ where: { id: { in: recIds } }, include: { employee: { select: { id: true, name: true, employeeCode: true, department: true } } } }) : [];
  const recOf = new Map(recs.map((r) => [r.id, r]));
  return rows.map((r) => {
    const [label, src] = String(r.fieldLabel || '').split(' · ');
    const rec = recOf.get(r.entityId);
    const role = r.user ? (named(r.user.hrmsRole) || r.user.role) : null;
    return {
      id: r.id, recordId: r.entityId, employee: rec && rec.employee ? rec.employee : null,
      from: r.fromValue === '(none)' ? null : r.fromValue, to: r.toValue, reason: r.reason || '',
      by: r.actorName || (r.user && r.user.name) || 'System', role, at: r.createdAt, source: src || label || 'UI',
    };
  });
}

module.exports = {
  ExitDateError, dateOf, liveRecords, exitDatesFor, effectiveExitDate, leftBy, setExitDate, recomputeEffects, changesFor,
  payrollStatusOn, seatOf, leaveAfter, isSuperAdmin, isHrDesk, isoDay, realDate, dmy, SERVING, DEAD,
};
