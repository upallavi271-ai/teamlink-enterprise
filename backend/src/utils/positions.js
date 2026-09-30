// ---------------------------------------------------------------------------
// POSITIONS — the seat, as distinct from the person in it.
//
// MED-1, MED-2, Non IT-03, Edu BDE 1. The company staffs and reports by these
// already; the imported sheets are full of them. When the person in MED-1
// resigns and somebody else takes the desk:
//
//   * MED-1 keeps everything done under it, with the name of whoever did it
//   * the new holder starts adding to the same seat
//   * both questions stay answerable — "what has this DESK done" and "what has
//     this PERSON done", and they are different questions
//
// HOW WORK GETS ATTRIBUTED. Every write that records an action stamps the
// acting user's CURRENT seat onto the row — both the id and the CODE. The id
// is for joining; the code is a snapshot, because a position can be renamed
// and an assignment can be corrected, and a follow-up made in March under
// MED-1 has to still say MED-1 afterwards. Exactly the reason
// ApplicationStageEvent already snapshots the requirement title and the client
// name rather than only joining to them.
//
// NOTHING HERE IS REQUIRED. A company that does not use seats simply never
// creates any, every stamp is null, and every screen reads exactly as before.
// ---------------------------------------------------------------------------

const prisma = require('../db');

const today = () => new Date().toISOString().slice(0, 10);

// A seat whose open tenure belongs to somebody who has LEFT is not really
// held (user, 2026-09-29: seats stayed "held" by Exited people, so a new
// person could never be given MED-1). These statuses mean the person is gone.
const LEFT_STATUSES = ['relieved', 'exited', 'terminated', 'resigned', 'absconded', 'dropout'];
const hasLeft = (status) => LEFT_STATUSES.includes(String(status || '').trim().toLowerCase());

// The day a departed holder's tenure should end: their approved (else
// requested) last working date from the resignation record, else today.
async function lastWorkingDayOf(employeeId) {
  try {
    const r = await prisma.resignationDetail.findFirst({
      where: { employeeId },
      orderBy: { createdAt: 'desc' },
      select: { approvedLastWorkingDate: true, requestedLastWorkingDate: true },
    });
    const d = r && (r.approvedLastWorkingDate || r.requestedLastWorkingDate);
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(String(d).slice(0, 10))) return String(d).slice(0, 10);
  } catch (e) { /* no resignation record → today */ }
  return today();
}

// The seat a USER holds right now, or null.
//
// Resolved through their employee record, because a seat is held by a person
// and a login is only how that person signs in. Returns { id, code } so a
// caller can stamp both without a second query.
async function currentPositionOf(userOrId) {
  const userId = typeof userOrId === 'string' ? userOrId : (userOrId && userOrId.id);
  if (!userId) return null;
  try {
    const employee = await prisma.employee.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!employee) return null;
    return positionOfEmployee(employee.id);
  } catch {
    return null;
  }
}

// The seat an EMPLOYEE holds right now, or null.
async function positionOfEmployee(employeeId, on = null) {
  if (!employeeId) return null;
  const when = on || today();
  try {
    const held = await prisma.positionAssignment.findFirst({
      where: {
        employeeId,
        fromDate: { lte: when },
        // Open-ended, or not yet ended on the date asked about.
        OR: [{ toDate: null }, { toDate: { gte: when } }],
      },
      orderBy: { fromDate: 'desc' },
      include: { position: { select: { id: true, code: true, name: true, department: true } } },
    });
    if (!held || !held.position) return null;
    return {
      id: held.position.id,
      code: held.position.code,
      name: held.position.name,
      department: held.position.department,
      assignmentId: held.id,
      since: held.fromDate,
    };
  } catch {
    return null;
  }
}

// The fields to spread onto a row being written. Always safe to spread: with
// no seat it contributes nothing rather than nulls that would overwrite.
//
//   await prisma.applicationFollowUp.create({
//     data: { ...rest, ...(await stampFor(req.user, 'owner')) },
//   });
async function stampFor(user, prefix = 'actor') {
  const pos = await currentPositionOf(user);
  if (!pos) return {};
  return {
    [`${prefix}PositionId`]: pos.id,
    [`${prefix}PositionCode`]: pos.code,
  };
}

// ---------------------------------------------------------------------------
// WHO HELD A SEAT, AND WHEN. The tenure list, newest first, with the gaps
// named — a seat that sat empty for three weeks is a fact worth seeing, not a
// silent join between two rows.
// ---------------------------------------------------------------------------
async function tenuresOf(positionId) {
  const rows = await prisma.positionAssignment.findMany({
    where: { positionId },
    orderBy: [{ fromDate: 'desc' }],
    include: { employee: { select: { id: true, name: true, employeeCode: true, department: true } } },
  });
  const out = [];
  rows.forEach((a, i) => {
    out.push({
      assignmentId: a.id,
      employeeId: a.employeeId,
      employeeName: a.employee ? a.employee.name : null,
      employeeCode: a.employee ? a.employee.employeeCode : null,
      fromDate: a.fromDate,
      toDate: a.toDate,
      current: !a.toDate,
      note: a.note,
      days: daysBetween(a.fromDate, a.toDate || today()),
    });
    // A gap between this tenure's start and the previous one's end.
    const older = rows[i + 1];
    if (older && older.toDate && older.toDate < a.fromDate) {
      const gap = daysBetween(older.toDate, a.fromDate);
      if (gap > 1) out.push({ vacant: true, fromDate: older.toDate, toDate: a.fromDate, days: gap });
    }
  });
  return out;
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  const d1 = new Date(`${a}T00:00:00.000Z`);
  const d2 = new Date(`${b}T00:00:00.000Z`);
  if (Number.isNaN(d1.getTime()) || Number.isNaN(d2.getTime())) return null;
  return Math.max(0, Math.round((d2 - d1) / 86400000));
}

// Who held this seat on a given DAY — used to attribute an old record that was
// written before seats existed, and to answer "who was on MED-1 in March".
async function holderOn(positionId, date) {
  const a = await prisma.positionAssignment.findFirst({
    where: {
      positionId,
      fromDate: { lte: date },
      OR: [{ toDate: null }, { toDate: { gte: date } }],
    },
    orderBy: { fromDate: 'desc' },
    include: { employee: { select: { id: true, name: true, employeeCode: true } } },
  });
  return a ? { employeeId: a.employeeId, name: a.employee && a.employee.name, code: a.employee && a.employee.employeeCode } : null;
}

module.exports = {
  currentPositionOf, positionOfEmployee, stampFor,
  tenuresOf, holderOn, daysBetween, today, hasLeft, lastWorkingDayOf,
};
