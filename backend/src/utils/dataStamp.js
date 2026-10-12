// ---------------------------------------------------------------------------
// DATA STAMP — one cheap string that changes whenever anything the ATS
// workload screens are built from changes: applications, requirements,
// follow-ups, stage events, notes / messages / feedback / audit (the same
// eight reads utils/nextAction.js stamps its snapshot with), people, seats —
// and the IST day.
//
// A few COUNT / MAX(updatedAt) reads (milliseconds) instead of rebuilding a
// 4-12 second answer: a cache entry is reused while its stamp is unchanged and
// is never kept longer than its own maximum age. Clients have no change date,
// so only a change in their NUMBER is seen at once; an edited client shows up
// when the entry expires. Used by utils/teamWorkload.js (Recruiter & BDE),
// routes/followUps.js (the list) and GET /requirements/attention.
//
// dataStamp() -> { all, snap }.  `snap` is the next-action snapshot's part of
// the stamp: the snapshot is rebuilt in the background after a write, so an
// answer computed while it still lags behind must NOT be kept —
// snapshotCurrent(stamp) tells whether it has caught up.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const nextAction = require('./nextAction');

const t = (d) => (d ? new Date(d).getTime() : 0);

async function snapshotPart() {
  const [ev, fu, notes, msgs, fb, aud, users, apps] = await Promise.all([
    prisma.applicationStageEvent.aggregate({ _count: { _all: true }, _max: { createdAt: true } }),
    prisma.applicationFollowUp.aggregate({ _count: { _all: true }, _max: { updatedAt: true } }),
    prisma.candidateNote.aggregate({ _count: { _all: true }, _max: { createdAt: true } }),
    prisma.candidateMessage.aggregate({ _count: { _all: true }, _max: { createdAt: true } }),
    prisma.interviewFeedback.aggregate({ _count: { _all: true }, _max: { updatedAt: true } }),
    prisma.auditLog.aggregate({ where: { entity: { in: ['Candidate', 'Application'] } }, _count: { _all: true }, _max: { createdAt: true } }),
    prisma.user.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.application.aggregate({ _count: { _all: true }, _max: { updatedAt: true } }),
  ]);
  const people = users.map((u) => `${u.status}:${u._count._all}`).sort().join(',');
  // The very same string utils/nextAction.js stampNow() builds.
  return [ev._count._all, t(ev._max.createdAt), fu._count._all, t(fu._max.updatedAt), notes._count._all, t(notes._max.createdAt),
    msgs._count._all, t(msgs._max.createdAt), fb._count._all, t(fb._max.updatedAt), aud._count._all, t(aud._max.createdAt), people,
    apps._count._all, t(apps._max.updatedAt)].join('|');
}

async function dataStamp() {
  await nextAction.ensureNextActionContext(); // keeps the snapshot as fresh as every other reader does
  const [snap, reqs, users, emps, pos, asg, clients] = await Promise.all([
    snapshotPart(),
    prisma.requirement.aggregate({ _count: { _all: true }, _max: { updatedAt: true } }),
    prisma.user.aggregate({ _count: { _all: true }, _max: { updatedAt: true } }),
    prisma.employee.aggregate({ _count: { _all: true }, _max: { updatedAt: true } }),
    prisma.position.aggregate({ _count: { _all: true }, _max: { createdAt: true } }),
    prisma.positionAssignment.aggregate({ _count: { _all: true }, _max: { createdAt: true } }),
    prisma.client.aggregate({ _count: { _all: true } }),
  ]);
  const rest = [nextAction.todayIst(), reqs._count._all, t(reqs._max.updatedAt), users._count._all, t(users._max.updatedAt),
    emps._count._all, t(emps._max.updatedAt), pos._count._all, t(pos._max.createdAt), asg._count._all, t(asg._max.createdAt),
    clients._count._all].join('|');
  return { all: `${snap}#${rest}`, snap };
}

// True when the next-action snapshot has caught up with `stamp` — an answer
// built from it right after is current and may be kept.
const snapshotCurrent = (stamp) => !!stamp && nextAction.snapshot().stamp === stamp.snap;

module.exports = { dataStamp, snapshotCurrent };
