// ---------------------------------------------------------------------------
// POSITION SCOPE — the organisation structure as the source of ATS scope.
//
//   Department -> Team -> TL seat -> recruiter seats -> current holder
//
// "Employees are replaceable, positions are not." A TL's team is not "the
// people whose Employee.team says Team-B" — it is the SEATS that report to the
// TL's seat (Position.reportsToId), and whoever holds them. When somebody
// leaves and a new person takes EDU-7, the TL's scope does not change at all:
// the seat is the same, the history recorded under it is the same, and the
// new holder's assigned requirements join it the day they sit down.
//
// resolvePositionScope() runs ONCE per request inside utils/identity.js and
// lands on req.user.atsPositionScope. utils/scope.js reads it synchronously —
// requirementWhere(), applicationWhere(), candidateWhere() — so ATS lists,
// ATS Reports, the follow-up screens, interviews and the AI tools all pick it
// up from the one place without a second implementation.
//
// WHAT IS IN IT
//   positionIds / positionCodes  the seats in scope: a TL's own seat + every
//                                seat reporting to it (recursively, so an STL
//                                seat reaches its TLs and their recruiters);
//                                a recruiter's own current seat(s).
//   holderUserIds                the logins of the CURRENT holders of those
//                                seats (and the viewer) — their assigned
//                                requirements are the team's.
//   workRequirementIds /         what was DONE from those seats, by the code
//   workApplicationIds           snapshotted on the follow-up / stage move.
//                                For a TL this is the whole history, so a
//                                previous holder's work stays visible to the
//                                team's TL. For a recruiter it is bounded by
//                                THEIR tenure: old work stays with the old
//                                holder.
//   foreignApplicationIds        applications worked from ANOTHER team's seat
//                                in the same department(s). Used to keep
//                                seats outside an STL's tree out of the
//                                department's unassigned pool. (A TL has no
//                                pool at all — only their team's work.)
//
// null means "no position structure applies" and scope.js falls back to the
// team / department logic exactly as before (a TL with no seat, a Manager…).
// ---------------------------------------------------------------------------

const prisma = require('../db');

const TEAM_KINDS = ['TL', 'RECRUITER', 'STL'];
const today = () => new Date().toISOString().slice(0, 10);
const uniq = (xs) => [...new Set(xs.filter(Boolean))];

// The seats under `rootIds`, following reportsToId downwards. Cycle-safe.
function descendants(rootIds, positions) {
  const children = new Map();
  positions.forEach((p) => {
    if (!p.reportsToId) return;
    if (!children.has(p.reportsToId)) children.set(p.reportsToId, []);
    children.get(p.reportsToId).push(p);
  });
  const seen = new Set(rootIds);
  const queue = [...rootIds];
  while (queue.length) {
    const id = queue.shift();
    (children.get(id) || []).forEach((c) => {
      if (seen.has(c.id)) return;
      seen.add(c.id);
      queue.push(c.id);
    });
  }
  return seen;
}

// Is this seat part of a team structure (as opposed to a free-standing BDE /
// HR / admin seat, or a retired extra that reports to nobody)?
function inStructure(p) {
  return TEAM_KINDS.includes(p.kind) && (p.kind !== 'RECRUITER' || !!p.reportsToId);
}

// Application / requirement ids with work recorded under these seat codes.
// `arms` is a list of { code, since } — `since` (YYYY-MM-DD) bounds a
// recruiter's own-seat work to their tenure; null means all history.
async function workUnder(arms) {
  if (!arms.length) return { applicationIds: [], requirementIds: [] };
  const byCode = (field) => arms.map((a) => (a.since
    ? { [field]: a.code, createdAt: { gte: new Date(`${a.since}T00:00:00.000Z`) } }
    : { [field]: a.code }));
  const [fus, evs] = await Promise.all([
    prisma.applicationFollowUp.findMany({
      where: { OR: byCode('ownerPositionCode') },
      select: { applicationId: true, application: { select: { requirementId: true } } },
    }),
    prisma.applicationStageEvent.findMany({
      where: { OR: byCode('actorPositionCode') },
      select: { applicationId: true, application: { select: { requirementId: true } } },
    }),
  ]);
  const rows = [...fus, ...evs];
  return {
    applicationIds: uniq(rows.map((r) => r.applicationId)),
    requirementIds: uniq(rows.map((r) => r.application && r.application.requirementId)),
  };
}

async function resolvePositionScope({ userId, employeeId, atsRole }) {
  if (!employeeId || !['TL', 'STL', 'RECRUITER'].includes(atsRole)) return null;
  const on = today();
  const held = await prisma.positionAssignment.findMany({
    where: { employeeId, toDate: null, fromDate: { lte: on } },
    include: { position: true },
  });
  if (!held.length) return null;

  // Which of the seats they hold decide their scope. A TL is scoped by a TL
  // seat, an STL by an STL seat; a TL who only holds a recruiter seat (or no
  // TL seat at all) keeps the team fallback rather than being narrowed to one
  // recruiter's desk by accident.
  const wantKind = atsRole === 'RECRUITER' ? null : atsRole;
  const mine = held.filter((a) => a.position && (wantKind ? a.position.kind === wantKind : true));
  if (!mine.length) return null;

  const all = await prisma.position.findMany({
    select: { id: true, code: true, kind: true, department: true, reportsToId: true, active: true },
  });
  const rootIds = mine.map((a) => a.position.id);
  const ids = atsRole === 'RECRUITER' ? new Set(rootIds) : descendants(rootIds, all);
  const inScope = all.filter((p) => ids.has(p.id));
  const positionCodes = uniq(inScope.map((p) => p.code));
  const departments = uniq(inScope.map((p) => p.department));

  // The people sitting in those seats today.
  const holders = await prisma.positionAssignment.findMany({
    where: { positionId: { in: [...ids] }, toDate: null, fromDate: { lte: on } },
    select: { employee: { select: { userId: true } } },
  });
  const holderUserIds = uniq([userId, ...holders.map((h) => h.employee && h.employee.userId)]);

  // Work done from the seats. A recruiter's is bounded by their own tenure;
  // a lead's is the seats' whole history.
  const arms = atsRole === 'RECRUITER'
    ? mine.map((a) => ({ code: a.position.code, since: a.fromDate }))
    : positionCodes.map((code) => ({ code, since: null }));
  const work = await workUnder(arms);

  // Another team's seats in the same department(s) — their work is theirs.
  let foreignApplicationIds = [];
  if (atsRole === 'STL') {
    const foreign = all.filter((p) => !ids.has(p.id) && inStructure(p) && departments.includes(p.department));
    if (foreign.length) {
      const fw = await workUnder(foreign.map((p) => ({ code: p.code, since: null })));
      const mineSet = new Set(work.applicationIds);
      // An application BOTH teams touched stays visible to both.
      foreignApplicationIds = fw.applicationIds.filter((id) => !mineSet.has(id));
    }
  }

  return {
    role: atsRole,
    // "Education Team A", "Medical Team" — what the scope line says.
    label: uniq(mine.map((a) => [a.position.department, a.position.team].filter(Boolean).join(' '))).join(', ') || null,
    ownPositionIds: rootIds,
    ownPositionCodes: uniq(mine.map((a) => a.position.code)),
    positionIds: [...ids],
    positionCodes,
    departments,
    holderUserIds,
    workRequirementIds: work.requirementIds,
    workApplicationIds: work.applicationIds,
    foreignApplicationIds,
  };
}

// ---------------------------------------------------------------------------
// WHO LEADS A SEAT — for notifications (follow-up escalation, requirement
// assignment). The CURRENT holder of the TL seat a recruiter seat reports to,
// and of the STL seat above that. Positions that report to nobody return
// nulls, and the caller falls back to what the requirement names.
// ---------------------------------------------------------------------------
async function leadsOfPosition({ positionId, positionCode }) {
  const out = { tlUserId: null, tlName: null, stlUserId: null, stlName: null };
  if (!positionId && !positionCode) return out;
  const seat = await prisma.position.findFirst({
    where: positionId ? { id: positionId } : { code: positionCode },
    select: { id: true, kind: true, reportsToId: true },
  });
  if (!seat) return out;
  const holderOf = async (id) => {
    const a = await prisma.positionAssignment.findFirst({
      where: { positionId: id, toDate: null },
      orderBy: { fromDate: 'desc' },
      select: { employee: { select: { userId: true, name: true } } },
    });
    return a && a.employee ? a.employee : null;
  };
  // Walk up: the first TL seat, then the first STL seat above it.
  let cursor = seat.kind === 'RECRUITER' ? seat.reportsToId : null;
  let guard = 0;
  while (cursor && guard < 6) {
    guard += 1;
    // eslint-disable-next-line no-await-in-loop
    const p = await prisma.position.findUnique({ where: { id: cursor }, select: { id: true, kind: true, reportsToId: true } });
    if (!p) break;
    if (p.kind === 'TL' && !out.tlUserId) {
      // eslint-disable-next-line no-await-in-loop
      const h = await holderOf(p.id);
      if (h) { out.tlUserId = h.userId || null; out.tlName = h.name || null; }
    }
    if (p.kind === 'STL' && !out.stlUserId) {
      // eslint-disable-next-line no-await-in-loop
      const h = await holderOf(p.id);
      if (h) { out.stlUserId = h.userId || null; out.stlName = h.name || null; }
      break;
    }
    cursor = p.reportsToId;
  }
  return out;
}

// The TL seat holders over the seats the given USERS currently hold — for
// "tell the team lead when a requirement is assigned to one of theirs".
async function teamLeadUserIdsFor(userIds) {
  const ids = uniq(userIds || []);
  if (!ids.length) return [];
  const seats = await prisma.positionAssignment.findMany({
    where: { toDate: null, employee: { userId: { in: ids } } },
    select: { positionId: true },
  });
  const leads = await Promise.all(uniq(seats.map((s) => s.positionId)).map((positionId) => leadsOfPosition({ positionId })));
  return uniq(leads.map((l) => l.tlUserId));
}

module.exports = {
  TEAM_KINDS, resolvePositionScope, leadsOfPosition, teamLeadUserIdsFor, descendants, inStructure,
};
