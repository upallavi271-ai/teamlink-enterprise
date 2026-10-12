// ---------------------------------------------------------------------------
// LATE COMING (user 2026-10-09 "late permission", 2026-10-10 "late coming, approved by higher roles").
//
// ONE request table (LatePermission) carries both ways of asking:
//   kind 'Advance'  "I will come in late on <day>, by <time>"   (before / on the day)
//   kind 'Explain'  "Tell why I was late"                        (after the person actually came late)
// Both climb the same approval ladder as a leave / regularization (utils/approvalWorkflow.js WORKFLOWS.latePermission).
//
// WHAT AN APPROVED REQUEST DOES TO A DAY (only the day engine reads this, nothing is stored on attendance rows):
//   * the person stays PRESENT; the day is marked "Late (approved)" and the lateness is NOT a late arrival for the
//     policy (payroll lateArrivals / free late arrivals / half-day cut per excess late, KPI "counts against me").
//     Arrival up to the approved time + the grace gap (Late-after minus start time, 15 min) is excused; later = "Late
//     beyond the approved time", which counts.
//   * PENDING  = still counts as Late, chip "Waiting for approval".
//   * REJECTED = counts as Late, chip "Rejected".
//   * no request = counts as Late, "Not explained".
// The excuse only applies under the NEW day rule (a day on / after the policy's "new rule from" date, or on the KPI
// screens before that date is set) so old payroll runs and imported months keep their numbers; the chip shows always.
// This file has no database writes and no dependency on attendanceDays.js (which requires it).
// ---------------------------------------------------------------------------
const { toMinutes } = require('./attendanceMath');

// The short plain list the form offers. `other` needs a note.
const REASONS = [
  { code: 'traffic', label: 'Traffic or road block' },
  { code: 'transport', label: 'Bus, train or vehicle problem' },
  { code: 'health', label: 'Not well / doctor visit' },
  { code: 'family', label: 'Family or home emergency' },
  { code: 'weather', label: 'Rain or bad weather' },
  { code: 'work', label: 'On office work or a client visit' },
  { code: 'power', label: 'Power or internet problem' },
  { code: 'other', label: 'Something else (write it below)' },
];
const REASON_LABEL = Object.fromEntries(REASONS.map((r) => [r.code, r.label]));

const STATE_LABEL = { approved: 'Approved', pending: 'Waiting for approval', rejected: 'Rejected', none: 'Not explained' };
const STATE_KEYS = ['approved', 'pending', 'rejected', 'none'];

const key = (employeeId, date) => `${employeeId}|${date}`;
const pad = (n) => String(n).padStart(2, '0');
const clock = (m) => (m == null ? '' : `${(Math.floor(m / 60) % 24) % 12 === 0 ? 12 : (Math.floor(m / 60) % 24) % 12}:${pad(m % 60)} ${Math.floor(m / 60) % 24 >= 12 ? 'PM' : 'AM'}`);

// The non-cancelled request of each person-day in [from, to], as a Map "employeeId|date" -> row.
// Never throws: a missing table (migration not applied) reads as "no requests".
async function loadFor(prisma, ids, from, to) {
  const map = new Map();
  if (!prisma || !prisma.latePermission || !ids || !ids.length) return map;
  try {
    const rows = await prisma.latePermission.findMany({
      where: { employeeId: { in: ids }, date: { gte: from, lte: to }, status: { not: 'Cancelled' } },
      orderBy: { requestedAt: 'asc' },
    });
    rows.forEach((r) => map.set(key(r.employeeId, r.date), r));
  } catch { /* table not there yet */ }
  return map;
}

// Mark ONE day row (from classifyDay) with the state of its late-coming request. Only a row that is late (came after the
// grace time) is touched. `lateGap` = policyTimes(cfg).lateGap (minutes between the start time and the Late-after time).
function annotate(row, perm, lateGap = 0) {
  if (!row || !row.late || !row.checkIn) return row;
  const arrive = toMinutes(row.checkIn);
  row.lateCame = true;
  if (!perm) { row.lateState = 'none'; row.latePermissionText = ''; return row; }
  const upTo = toMinutes(perm.expectedTime);
  const within = arrive != null && upTo != null && arrive <= upTo + lateGap;
  const lp = {
    id: perm.id, status: perm.status, kind: perm.kind || 'Advance', expectedTime: perm.expectedTime, reason: perm.reason,
    reasonCode: perm.reasonCode || null, decidedBy: perm.decidedBy || null, decisionNote: perm.decisionNote || null, within,
  };
  row.latePermission = lp;
  row.latePermissionId = perm.id;
  if (perm.status === 'Approved') {
    if (!within) {
      lp.beyond = true;
      row.lateState = 'none';
      row.latePermissionText = `Late beyond the approved time (${clock(upTo)})`;
      return row;
    }
    row.lateState = 'approved';
    row.latePermissionText = 'Late (approved)';
    if (row.rule === 'new') {
      row.lateExcused = true;
      row.late = false;
      if (row.status === 'Late') { row.status = 'Present'; row.colour = 'green'; }
      const was = row.reason || '';
      row.reason = row.status === 'Present'
        ? `Present — came ${clock(arrive)}, late but approved${perm.reason ? ` (${perm.reason})` : ''}`
        : `${was} — late arrival approved`;
    } else {
      lp.notYetApplied = true; // old rule (payroll before the policy date): the chip shows, the count does not change
    }
    return row;
  }
  if (perm.status === 'Pending') { row.lateState = 'pending'; row.latePermissionText = 'Late - waiting for approval'; return row; }
  if (perm.status === 'Rejected') { row.lateState = 'rejected'; row.latePermissionText = 'Late - rejected'; return row; }
  row.lateState = 'none'; row.latePermissionText = '';
  return row;
}

// Counts of the late arrivals by state, from day rows: { late, approved, pending, rejected, none }.
function stateCounts(rows) {
  const c = { late: 0, approved: 0, pending: 0, rejected: 0, none: 0 };
  (rows || []).forEach((r) => {
    if (!r || !r.lateState) return;
    c.late += 1;
    c[r.lateState] += 1;
  });
  return c;
}
// "Late 5 · Approved 3 · Pending 1 · Not explained 1" (a zero Rejected is left out).
function chipsText(c) {
  if (!c || !c.late) return '';
  const bits = [`Late ${c.late}`, `Approved ${c.approved}`, `Pending ${c.pending}`];
  if (c.rejected) bits.push(`Rejected ${c.rejected}`);
  bits.push(`Not explained ${c.none}`);
  return bits.join(' · ');
}

module.exports = { REASONS, REASON_LABEL, STATE_LABEL, STATE_KEYS, loadFor, annotate, stateCounts, chipsText, key, clock };
