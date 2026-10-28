// ---------------------------------------------------------------------------
// A LEAVE MARKED BY HAND IS A LEAVE WAITING FOR APPROVAL (founder 2026-10-28: "hr manual ga leave ani pettina ahh leave approve
// kakapothey pending ane ravali").
//
// HR (or anyone) pressing "Leave" in Attendance -> Daily marking (POST /api/attendance with status 'On Leave' / 'Leave') used to make
// the day an APPROVED leave by itself. Now:
//   * the mark still writes Attendance.status = 'On Leave' (so the Marked column shows it), and
//   * raiseFromMark() raises a PENDING LeaveRequest for that day (one day, Casual Leave unless another type is sent) on the normal
//     approval chain (TL -> ... -> HR -> Super Admin, the same rules as an applied leave; a TL's leave needs the Super Admin);
//   * the day reads "Leave Under Review" (pending) until that request is approved, then "On Leave" (utils/attendanceDays.js);
//   * a mark with no request behind it (made before this change) also reads as pending, never as approved;
//   * the request REJECTED / CANCELLED: clearMarks() takes the day's Leave mark away (a mark-only row is removed, a row with times
//     keeps its times and reads from them), so the day is not shown as leave any more.
// No new request when a Pending / Approved leave already covers that day, or the day is a Sunday / company holiday.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('./audit');
const workflow = require('./approvalWorkflow');
const leaveText = require('./leaveText');

const LEAVE_MARKS = ['On Leave', 'Leave'];
const LIVE = ['Pending', 'Approved', 'Cancellation Requested'];
const isLeaveMark = (s) => LEAVE_MARKS.includes(String(s || ''));

async function pickType(asked) {
  const types = (await prisma.leaveType.findMany()).filter((t) => t.active);
  const want = String(asked || '').trim().toLowerCase();
  return (want && types.find((t) => t.name.toLowerCase() === want))
    || types.find((t) => t.name === 'Casual Leave')
    || types.find((t) => t.unit !== 'unpaid')
    || types[0] || null;
}

function waitingForOf(steps) {
  const p = (steps || []).filter((s) => s.status === 'Pending');
  if (!p.length) return null;
  const word = { TL: 'TL', STL: 'STL', HR: 'HR', ASSISTANT_MANAGER: 'Asst Manager', MANAGER: 'Manager', SUPER_ADMIN: 'Super Admin' };
  return p.map((s) => `${word[s.level] || workflow.labelFor(s.level).label}${s.approverName ? ` ${s.approverName}` : ''}`).join(' / ');
}

// Raise the pending leave for a day marked "Leave". Never throws: the mark itself is already saved.
// Returns { leave, created, waitingFor } or { skipped: '<why>' }.
async function raiseFromMark({ employee, date, user, leaveType = null, notify = true }) {
  try {
    if (!employee || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return { skipped: 'no employee / date' };
    const covering = await prisma.leaveRequest.findFirst({
      where: { employeeId: employee.id, status: { in: LIVE }, fromDate: { lte: date }, toDate: { gte: date } },
      orderBy: { createdAt: 'desc' },
    });
    if (covering) {
      const steps = covering.status === 'Pending' ? await workflow.loadSteps('leave', covering.id) : [];
      return { leave: covering, created: false, waitingFor: waitingForOf(steps) };
    }
    const sys = await require('./systemAccounts').systemRequesterError(employee, 'leave'); // eslint-disable-line global-require
    if (sys) return { skipped: sys };
    try {
      const c = await require('./leaveDays').countFor(date, date); // eslint-disable-line global-require
      if (c && c.calendarDays > 0 && c.countedDays === 0) return { skipped: 'Sunday or company holiday - no leave needed' };
    } catch { /* count is a nicety */ }
    const type = await pickType(leaveType);
    if (!type) return { skipped: 'no active leave type' };
    const by = (user && (user.name || user.email)) || 'HR';
    const own = user && employee.userId && employee.userId === user.id;
    const leave = await prisma.leaveRequest.create({
      data: {
        employeeId: employee.id, type: type.name, fromDate: date, toDate: date, days: 1,
        reason: leaveText.compose({ reason: own ? 'Marked as Leave in attendance' : `Marked as Leave in attendance by ${by} - waiting for approval` }),
      },
    });
    await logAudit({ userId: user ? user.id : null, actorName: by, action: 'Leave requested (marked as Leave in attendance)', entity: 'LeaveRequest', entityId: leave.id, toValue: 'Pending' });
    let steps = [];
    try {
      steps = await workflow.start({ workflow: 'leave', recordId: leave.id, employee, applicantUserId: employee.userId || null, applicantName: employee.name });
    } catch (err) { console.error('[markedLeave] chain start failed', err.message); }
    if (notify) require('./hrmsNotify').leaveRaised({ leave, employee }).catch(() => {}); // eslint-disable-line global-require
    return { leave, created: true, waitingFor: waitingForOf(steps) };
  } catch (err) {
    console.error('[markedLeave] could not raise the leave', err.message);
    return { skipped: err.message };
  }
}

// The leave was rejected / cancelled: the "Leave" marks on its days go, unless another live leave still covers that day.
async function clearMarks(request, user, outcome = 'Rejected') {
  if (!request || !request.employeeId) return 0;
  const from = String(request.fromDate).slice(0, 10);
  const to = String(request.toDate || request.fromDate).slice(0, 10);
  const rows = await prisma.attendance.findMany({ where: { employeeId: request.employeeId, date: { gte: from, lte: to }, status: { in: LEAVE_MARKS } } });
  let n = 0;
  for (const r of rows) {
    const other = await prisma.leaveRequest.findFirst({ where: { employeeId: request.employeeId, id: { not: request.id }, status: { in: LIVE }, fromDate: { lte: r.date }, toDate: { gte: r.date } }, select: { id: true } });
    if (other) continue; // eslint-disable-line no-continue
    if (!r.checkIn && !r.checkOut) await prisma.attendance.delete({ where: { id: r.id } });
    else await prisma.attendance.update({ where: { id: r.id }, data: { status: 'Present' } });
    n += 1;
    await logAudit({ userId: user ? user.id : null, actorName: user ? user.name : null, action: `Leave mark removed - the leave was ${String(outcome).toLowerCase()}`, entity: 'Attendance', entityId: r.id, fromValue: r.status, toValue: r.checkIn || r.checkOut ? 'Present (times kept)' : '(not marked)' }).catch(() => {});
  }
  return n;
}

module.exports = { LEAVE_MARKS, isLeaveMark, raiseFromMark, clearMarks, waitingForOf };
