// ---------------------------------------------------------------------------
// GENUINE PENDING LEAVE (HRMS item 8, 2026-10-13).
//
// "Display only genuinely pending requests in the Pending Approvals section."
// A leave request that has status Pending is GENUINE only when
//   * the employee is still working here (not Exited / Relieved / Terminated / Inactive),
//   * it is not a DUPLICATE of another request (same person, same leave type,
//     overlapping dates) that is Approved, or Pending and further along,
//   * its dates are not absurdly old (setting leave.pending.staleDays, default 60:
//     older ones go to HR's "Old pending: decide or close" list instead).
// Everything else is still Pending in the table (nothing is deleted or changed here)
// but is kept OUT of the counts, the Pending Approvals list and the reminders.
//
// ONE function decides, so the HRMS dashboard tile, the Leave screen, the approval
// reminders and the Pulse sync all read the same answer (see leave-views-agree-test).
// ---------------------------------------------------------------------------
const prisma = require('../db');

const LEFT_STATUSES = ['Exited', 'Relieved', 'Terminated', 'Inactive'];
const STALE_KEY = 'leave.pending.staleDays';
const DEFAULT_STALE_DAYS = 60;
const REASON_TEXT = {
  leaver: 'The employee has left',
  duplicate: 'Duplicate of another request',
  old: 'Dates are long past',
};

async function getStaleDays() {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: STALE_KEY } });
    const n = row ? Number(JSON.parse(row.value)) : NaN;
    return Number.isInteger(n) && n >= 1 && n <= 3650 ? n : DEFAULT_STALE_DAYS;
  } catch { return DEFAULT_STALE_DAYS; }
}
async function setStaleDays(days, user = null) {
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1 || n > 3650) return { error: 'Days must be a whole number from 1 to 3650.' };
  const value = JSON.stringify(n);
  await prisma.appSetting.upsert({
    where: { key: STALE_KEY },
    update: { value, updatedById: user ? user.id : null, updatedByName: user ? user.name : null },
    create: { key: STALE_KEY, value, updatedById: user ? user.id : null, updatedByName: user ? user.name : null },
  });
  return { staleDays: n };
}

const iso = (d) => String(d || '').slice(0, 10);
const addDays = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const todayIso = (now = new Date()) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const overlaps = (a, b) => iso(a.fromDate) <= iso(b.toDate) && iso(b.fromDate) <= iso(a.toDate);
const RANK = { Approved: 3, 'Cancellation Requested': 3, Pending: 1 };

// Who of two overlapping same-type requests is the one to KEEP: decided beats
// pending; among pendings the one with more steps already acted; then the older.
function keepScore(r, acted) {
  return (RANK[r.status] || 0) * 1e6 + (acted.get(r.id) || 0) * 1e3 - new Date(r.createdAt).getTime() / 1e9;
}

// rows: LeaveRequest rows WITH `employee` (employmentStatus). Returns a Map id -> 'leaver' | 'duplicate' | 'old'
// for every PENDING row that is not genuine; genuine pendings are absent from the map.
async function classify(pendingRows, { now = new Date(), staleDays = null, universe = null } = {}) {
  const stale = staleDays || await getStaleDays();
  const cutoff = addDays(todayIso(now), -stale);
  const out = new Map();
  if (!pendingRows.length) return out;
  // The universe for duplicate detection: every live request (Pending / Approved) of these people.
  const empIds = [...new Set(pendingRows.map((r) => r.employeeId))];
  const all = universe || await prisma.leaveRequest.findMany({
    where: { employeeId: { in: empIds }, status: { in: ['Pending', 'Approved', 'Cancellation Requested'] } },
    select: { id: true, employeeId: true, type: true, fromDate: true, toDate: true, status: true, createdAt: true, days: true, reason: true },
  });
  const stepRows = await prisma.approvalStep.findMany({
    where: { workflow: 'leave', recordId: { in: all.map((r) => r.id) }, mode: { not: 'applicant' } },
    select: { recordId: true, status: true },
  });
  const acted = new Map();
  stepRows.forEach((s) => { if (['Approved', 'Rejected', 'Reassigned', 'Skipped'].includes(s.status)) acted.set(s.recordId, (acted.get(s.recordId) || 0) + 1); });
  const byEmp = new Map();
  all.forEach((r) => { if (!byEmp.has(r.employeeId)) byEmp.set(r.employeeId, []); byEmp.get(r.employeeId).push(r); });
  for (const r of pendingRows) {
    const e = r.employee || {};
    if (LEFT_STATUSES.includes(e.employmentStatus)) { out.set(r.id, 'leaver'); continue; }
    const mine = (byEmp.get(r.employeeId) || []).filter((x) => x.id !== r.id && x.type === r.type && overlaps(x, r));
    // half-day requests on the same date but opposite halves are not duplicates of each other
    const clash = mine.filter((x) => {
      const hx = /First Half|Second Half/.exec(String(x.reason || '')); const hr = /First Half|Second Half/.exec(String(r.reason || ''));
      if (hx && hr && hx[0] !== hr[0]) return false;
      return true;
    });
    if (clash.some((x) => keepScore(x, acted) > keepScore(r, acted) || (keepScore(x, acted) === keepScore(r, acted) && x.id < r.id))) { out.set(r.id, 'duplicate'); continue; }
    if (iso(r.toDate) < cutoff) out.set(r.id, 'old');
  }
  return out;
}

// All pending requests in an employee scope, split. employeeIds null = everyone.
async function pendingBuckets({ employeeIds = null, now = new Date(), from = null, to = null } = {}) {
  const where = { status: 'Pending' };
  if (employeeIds) where.employeeId = { in: employeeIds };
  if (from) where.toDate = { gte: from };
  if (to) where.fromDate = { lt: to };
  const rows = await prisma.leaveRequest.findMany({ where, include: { employee: { select: { id: true, name: true, employeeCode: true, department: true, team: true, employmentStatus: true } } }, orderBy: { fromDate: 'desc' } });
  const bad = await classify(rows, { now });
  const b = { genuine: [], leaver: [], duplicate: [], old: [], all: rows, reasonOf: bad };
  rows.forEach((r) => { const k = bad.get(r.id); (k ? b[k] : b.genuine).push(r); });
  return b;
}

async function genuinePendingIds(opts = {}) {
  const b = await pendingBuckets(opts);
  return new Set(b.genuine.map((r) => r.id));
}

module.exports = { LEFT_STATUSES, REASON_TEXT, getStaleDays, setStaleDays, classify, pendingBuckets, genuinePendingIds, addDays, todayIso };
