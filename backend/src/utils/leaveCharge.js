// ---------------------------------------------------------------------------
// WHAT A LEAVE REALLY TAKES FROM THE BALANCE (HRMS changes, items 4 and 6).
//
// A request asks for `days` (the calendar span, or what the form said). What
// it actually USES is read from the day rule (utils/attendanceDays.js):
//   * case 4 — full-day leave approved, but the person worked 9:00-1:30:
//     the day is Half Day + Half Leave, so only 0.5 is taken;
//   * worked the whole day on a leave day: nothing is taken for that day;
//   * a half-day leave: 0.5;
//   * the sandwich rule: a holiday / weekly off between two leave days is
//     taken too (charged to the later leave); with the rule off, off days
//     inside a request are NOT taken.
// Days still to come are read as planned (no punch yet = on leave).
//
// THE LEDGER. Every time the balance is moved for a request, an AuditLog row
// is written: action 'Leave balance charged', entity LeaveRequest, toValue =
// the days now charged. sync() compares the days used now with the last row
// and moves the balance only by the difference, so it can run any number of
// times (idempotent). A request with NO ledger row (approved before this
// shipped, or imported as pre-counted) is never touched: old balances are
// never rewritten.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const D = require('./attendanceDays');

const MARK = 'Leave balance charged';
const APPROVED = ['Approved', 'Cancellation Requested'];
const PAD = 12; // > attendanceDays SANDWICH_PAD, so sandwiched days are seen
const round2 = (n) => Math.round(n * 100) / 100;
const shift = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

async function config() {
  return (await prisma.hrConfig.findFirst()) || {};
}

// Days this request uses, from the day rule. Planned days count as taken.
async function usedDays(request, { cfg = null } = {}) {
  const employee = await prisma.employee.findUnique({ where: { id: request.employeeId } });
  if (!employee) return 0;
  const from = shift(String(request.fromDate).slice(0, 10), -PAD);
  const to = String(request.toDate || request.fromDate).slice(0, 10);
  // Read as of a date past the request: a day still to come (no punch yet)
  // reads as planned leave; a past day reads what really happened.
  const { days } = await D.loadDays(prisma, { employees: [employee], from, to, cfg: cfg || await config(), asOf: shift(to, PAD) });
  return round2(days(employee).filter((d) => d.leaveId === request.id)
    .reduce((n, d) => n + (Number(d.leave) || 0) + (Number(d.unpaidLeave) || 0), 0));
}

async function lastCharge(requestId) {
  const row = await prisma.auditLog.findFirst({
    where: { entity: 'LeaveRequest', entityId: requestId, action: MARK }, orderBy: { createdAt: 'desc' }, select: { toValue: true },
  });
  if (!row) return null;
  const n = Number(row.toValue);
  return Number.isFinite(n) ? n : null;
}

async function move(request, delta) {
  if (!delta) return;
  const balance = await prisma.leaveBalance.findUnique({ where: { employeeId_type: { employeeId: request.employeeId, type: request.type } } });
  if (!balance) return;
  await prisma.leaveBalance.update({ where: { id: balance.id }, data: { taken: Math.max(0, round2(balance.taken + delta)) } });
}

async function mark(request, from, to, why, userId = null) {
  await prisma.auditLog.create({
    data: {
      userId, action: MARK, entity: 'LeaveRequest', entityId: request.id,
      fromValue: from == null ? null : String(from), toValue: String(to), reason: why,
    },
  });
}

// On approval: take what the request uses (not blindly `days`). Returns the
// days taken. The caller has already set the request to Approved.
async function onApprove(request, userId = null) {
  const used = await usedDays(request);
  await move(request, used);
  await mark(request, null, used, `Approved: ${request.days ?? 1} day(s) applied, ${used} used`, userId);
  // A neighbour's sandwich days may now belong to a later leave.
  await syncAround(request.employeeId, request.fromDate, request.toDate, { except: request.id });
  return used;
}

// An approved leave is cancelled: give back exactly what was taken. Returns
// the days given back, or null when this request has no ledger (the caller
// then keeps its old behaviour).
async function onCancel(request, userId = null) {
  const charged = await lastCharge(request.id);
  if (charged == null) return null;
  await move(request, -charged);
  await mark(request, charged, 0, 'Cancelled: days given back', userId);
  await syncAround(request.employeeId, request.fromDate, request.toDate, { except: request.id });
  return charged;
}

// Re-read one approved request and move the balance by the difference.
async function sync(request, cfg = null) {
  if (!APPROVED.includes(request.status)) return null;
  const charged = await lastCharge(request.id);
  if (charged == null) return null; // never charged by this ledger: leave it alone
  const used = await usedDays(request, { cfg });
  if (Math.abs(used - charged) < 0.001) return { id: request.id, charged, used, moved: 0 };
  await move(request, round2(used - charged));
  await mark(request, charged, used, 'Attendance changed: days used re-read');
  return { id: request.id, charged, used, moved: round2(used - charged) };
}

// Every ledgered approved request of one employee near a date range.
async function syncAround(employeeId, fromDate, toDate, { except = null } = {}) {
  const from = shift(String(fromDate).slice(0, 10), -PAD);
  const to = shift(String(toDate || fromDate).slice(0, 10), PAD);
  const list = await prisma.leaveRequest.findMany({
    where: { employeeId, status: { in: APPROVED }, fromDate: { lte: to }, toDate: { gte: from }, ...(except ? { id: { not: except } } : {}) },
  });
  const cfg = await config();
  const out = [];
  for (const r of list) {
    // eslint-disable-next-line no-await-in-loop
    const x = await sync(r, cfg);
    if (x && x.moved) out.push(x);
  }
  return out;
}

// Best-effort hook for a new punch / regularization: never throws.
function afterAttendanceChange(employeeId, date) {
  return syncAround(employeeId, date, date).catch((e) => { console.error('[leave-charge]', e.message); return []; });
}

// The sweep (utils/attendanceAlerts.js, real server only): every ledgered
// approved request touching the last `days` days. Biometric punches arrive
// without passing through any route, so this is how they reach the balance.
async function sweep({ days = 35 } = {}) {
  const today = D.localDate();
  const from = shift(today, -days);
  const marked = await prisma.auditLog.findMany({ where: { entity: 'LeaveRequest', action: MARK, createdAt: { gte: new Date(Date.now() - 120 * 86400000) } }, select: { entityId: true }, distinct: ['entityId'] });
  const ids = marked.map((m) => m.entityId).filter(Boolean);
  if (!ids.length) return { checked: 0, moved: [] };
  const list = await prisma.leaveRequest.findMany({ where: { id: { in: ids }, status: { in: APPROVED }, toDate: { gte: from }, fromDate: { lte: today } } });
  const cfg = await config();
  const moved = [];
  for (const r of list) {
    // eslint-disable-next-line no-await-in-loop
    const x = await sync(r, cfg).catch(() => null);
    if (x && x.moved) moved.push(x);
  }
  return { checked: list.length, moved };
}

// For a list screen: the days each request has taken (ledger), or null.
async function chargedMap(ids) {
  if (!ids.length) return new Map();
  const rows = await prisma.auditLog.findMany({
    where: { entity: 'LeaveRequest', action: MARK, entityId: { in: ids } }, orderBy: { createdAt: 'asc' }, select: { entityId: true, toValue: true },
  });
  const m = new Map();
  rows.forEach((r) => { const n = Number(r.toValue); if (Number.isFinite(n)) m.set(r.entityId, n); });
  return m;
}

module.exports = { MARK, usedDays, lastCharge, onApprove, onCancel, sync, syncAround, afterAttendanceChange, sweep, chargedMap };
