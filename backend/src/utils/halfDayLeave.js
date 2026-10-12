// ---------------------------------------------------------------------------
// HALF DAY + THE LEAVE THAT COVERS THE OTHER HALF (user, 2026-10-09).
//
// A person on the Half day tile worked one half. What happened to the other
// half is a half-day LEAVE, and the lists must say where that leave stands:
//   Approved         "Half day leave: Approved"        (and who approved it)
//   Pending          "Half day leave: Pending approval" (paid only when approved)
//   Rejected         "Half day leave: Rejected"
//   No leave applied "Half day leave: No leave applied"
// plus WHICH half the leave covers (1st half / 2nd half).
//
// This only DESCRIBES the day. The pay / leave / absent numbers of the day
// (attendanceDays.js classifyDay, payroll) are untouched: pending leave stays
// unpaid until it is approved, exactly as the engine already does.
// ---------------------------------------------------------------------------
const { halfOf } = require('./leaveText');

const STATE = { APPROVED: 'Approved', PENDING: 'Pending', REJECTED: 'Rejected', NONE: 'None' };
const STATE_TEXT = {
  Approved: 'Half day leave: Approved',
  Pending: 'Half day leave: Pending approval',
  Rejected: 'Half day leave: Rejected',
  None: 'Half day leave: No leave applied',
};
// Plain chip colours (the four colours of the simple-UX rule).
const STATE_TONE = { Approved: 'green', Pending: 'orange', Rejected: 'red', None: 'red' };
const halfWord = (h) => (/first/i.test(h || '') ? '1st half' : /second/i.test(h || '') ? '2nd half' : '');

// What the day row itself says, without the database (My / Team Attendance use this).
function fromRow(d) {
  if (!d) return { state: STATE.NONE, half: '' };
  if (d.leaveId || d.leaveHalf || d.status === 'Half Day + Half Leave') return { state: STATE.APPROVED, half: halfWord(d.leaveHalf) };
  if (d.pendingLeaveId || d.status === 'Half Day, Under Review') return { state: STATE.PENDING, half: '' };
  return { state: STATE.NONE, half: '' };
}

// rows: [{ employeeId, date, day }] where day is the engine row of a Half day person.
// Returns Map('employeeId|date' -> { state, text, tone, half, by, type }).
async function annotate(prisma, rows) {
  const out = new Map();
  if (!rows.length) return out;
  const ids = [...new Set(rows.map((r) => r.employeeId))];
  const dates = rows.map((r) => r.date).sort();
  const leaves = await prisma.leaveRequest.findMany({
    where: { employeeId: { in: ids }, fromDate: { lte: dates[dates.length - 1] }, toDate: { gte: dates[0] }, status: { in: ['Approved', 'Pending', 'Rejected', 'Cancellation Requested'] } },
    select: { id: true, employeeId: true, fromDate: true, toDate: true, type: true, status: true, reason: true, days: true, decidedBy: true },
  });
  const byId = new Map(leaves.map((l) => [l.id, l]));
  const covers = (l, e, d) => l.employeeId === e && String(l.fromDate).slice(0, 10) <= d && String(l.toDate).slice(0, 10) >= d;
  rows.forEach(({ employeeId, date, day }) => {
    const base = fromRow(day);
    let leave = (day && day.leaveId && byId.get(day.leaveId)) || (day && day.pendingLeaveId && byId.get(day.pendingLeaveId)) || null;
    let state = base.state;
    if (!leave && state === STATE.NONE) {
      // A half-day leave that was turned down for this very day.
      const rej = leaves.find((l) => l.status === 'Rejected' && covers(l, employeeId, date) && halfOf(l));
      if (rej) { leave = rej; state = STATE.REJECTED; }
    }
    if (!leave && state !== STATE.NONE) leave = leaves.find((l) => ['Approved', 'Pending', 'Cancellation Requested'].includes(l.status) && covers(l, employeeId, date) && halfOf(l)) || null;
    const half = halfWord(halfOf(leave)) || base.half;
    out.set(`${employeeId}|${date}`, {
      state, text: STATE_TEXT[state], tone: STATE_TONE[state], half,
      by: state === STATE.APPROVED && leave && leave.decidedBy ? leave.decidedBy : '',
      type: leave ? leave.type : '',
    });
  });
  return out;
}

// Counts for the Half day tile's sub-note: 1st half / 2nd half and the four states.
function summarise(infos) {
  const c = { firstHalf: 0, secondHalf: 0, approved: 0, pending: 0, rejected: 0, none: 0 };
  infos.forEach((i) => {
    if (i.half === '1st half') c.firstHalf += 1;
    if (i.half === '2nd half') c.secondHalf += 1;
    c[{ Approved: 'approved', Pending: 'pending', Rejected: 'rejected', None: 'none' }[i.state]] += 1;
  });
  return c;
}

module.exports = { annotate, fromRow, summarise, STATE, STATE_TEXT, STATE_TONE, halfWord };
