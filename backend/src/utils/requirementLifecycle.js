// ---------------------------------------------------------------------------
// WHEN A REQUIREMENT GOES ON HOLD, IS CLOSED OR IS REOPENED (ATS audit 2026-11-18, Q614 / Q615 / Q612).
//
// Before this, POST /requirements/:id/status changed only the requirement's own status: its candidates kept "moving", their follow-ups kept
// falling due and the recruiters kept getting reminders for a job nobody was hiring for.
//
//   ON HOLD / CLOSED   every candidate still in the ACTIVE part of the pipeline (New ... Interview completed) is put on Hold with the reason
//                      "Requirement on hold" / "Requirement closed"; the stage they were at is kept in the stage history. Their open
//                      follow-ups are closed with that reason. The recruiters, the TL and the candidates' owners get one notice each.
//                      Candidates already Selected / Offer / Joined (and Rejected ones) are NOT touched.
//   REOPENED           the candidates THIS module put on hold go back to the stage they were at, with a history line saying so.
//
// No message is sent to any candidate (the stage is written directly, not through the stage-move route that writes candidate messages),
// so a hold never mails anybody a rejection. Every change is in the stage history (ApplicationStageEvent) and the audit log.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('./audit');
const { notifyUsers } = require('./notify');

const ACTIVE_STAGES = ['NEW', 'AI_INTERVIEW_REQUIRED', 'AI_INTERVIEW_SCHEDULED', 'AI_INTERVIEW_COMPLETED', 'RECRUITER_REVIEW', 'RECRUITER_APPROVED',
  'TL_REVIEW', 'WITH_BDE', 'BDE_APPROVED', 'SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'CLIENT_SHORTLISTED', 'INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED'];
const LIVE = ['OPEN', 'RECRUITER_ASSIGNED', 'SOURCING', 'CANDIDATES_AVAILABLE'];
const SYSTEM_ACTION = 'Put on hold: requirement'; // the marker a reopen looks for
const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

async function pauseCandidates(requirement, to, user) {
  const reason = to === 'CLOSED' ? 'Requirement closed' : 'Requirement on hold';
  const apps = await prisma.application.findMany({
    where: { requirementId: requirement.id, stage: { in: ACTIVE_STAGES } },
    select: { id: true, candidateId: true, stage: true, ownerRecruiterId: true },
  });
  const client = requirement.clientId ? await prisma.client.findUnique({ where: { id: requirement.clientId }, select: { name: true } }).catch(() => null) : null;
  let followUpsClosed = 0;
  for (const a of apps) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.$transaction([
      prisma.application.update({ where: { id: a.id }, data: { stage: 'HOLD' } }),
      prisma.applicationStageEvent.create({
        data: {
          applicationId: a.id, candidateId: a.candidateId, fromStage: a.stage, toStage: 'HOLD', action: `${SYSTEM_ACTION} ${to === 'CLOSED' ? 'closed' : 'on hold'}`,
          comment: `${reason} - moved automatically from "${a.stage}". It goes back to that stage if the requirement is reopened.`,
          actorUserId: user ? user.id : null, actorName: user ? user.name : 'System', actorRole: user ? (user.atsRole || user.role || null) : null,
          requirementId: requirement.id, requirementTitle: requirement.title || null, clientId: requirement.clientId || null, clientName: client ? client.name : null,
          actorSide: 'Internal', reasonCategory: reason, reasonDetail: `The requirement was ${to === 'CLOSED' ? 'closed' : 'put on hold'}.`,
        },
      }),
    ]);
    // eslint-disable-next-line no-await-in-loop
    const fu = await prisma.applicationFollowUp.updateMany({
      where: { applicationId: a.id, completedAt: null },
      data: { completedAt: new Date(), completedById: user ? user.id : null, completedNote: `Closed automatically: ${reason.toLowerCase()}.` },
    }).catch(() => ({ count: 0 }));
    followUpsClosed += fu.count || 0;
  }
  return { moved: apps.length, followUpsClosed, reason, owners: apps.map((a) => a.ownerRecruiterId) };
}

async function resumeCandidates(requirement, user) {
  const held = await prisma.application.findMany({ where: { requirementId: requirement.id, stage: 'HOLD' }, select: { id: true, candidateId: true, ownerRecruiterId: true } });
  let restored = 0;
  for (const a of held) {
    // the LAST event of this application must be our own automatic hold; a hold a person chose stays as it is
    // eslint-disable-next-line no-await-in-loop
    const last = await prisma.applicationStageEvent.findFirst({ where: { applicationId: a.id }, orderBy: { createdAt: 'desc' } });
    if (!last || !String(last.action || '').startsWith(SYSTEM_ACTION) || !last.fromStage || !ACTIVE_STAGES.includes(last.fromStage)) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    await prisma.$transaction([
      prisma.application.update({ where: { id: a.id }, data: { stage: last.fromStage } }),
      prisma.applicationStageEvent.create({
        data: {
          applicationId: a.id, candidateId: a.candidateId, fromStage: 'HOLD', toStage: last.fromStage, action: 'Back from hold: requirement reopened',
          comment: `The requirement was reopened - back to "${last.fromStage}", where the candidate was before the hold.`,
          actorUserId: user ? user.id : null, actorName: user ? user.name : 'System', actorRole: user ? (user.atsRole || user.role || null) : null,
          requirementId: requirement.id, requirementTitle: requirement.title || null, clientId: requirement.clientId || null, actorSide: 'Internal',
        },
      }),
    ]);
    restored += 1;
  }
  return { restored, owners: held.map((a) => a.ownerRecruiterId) };
}

// Called after the requirement's status was saved. Never throws: the status change itself already happened and is what the user asked for.
async function onStatusChange(requirement, from, to, user) {
  try {
    if (!requirement || from === to) return null;
    const people = new Set([requirement.recruiterId, ...csv(requirement.recruiterIds), requirement.tlId, requirement.stlId].filter(Boolean));
    const label = `${requirement.reqCode ? `${requirement.reqCode} ` : ''}${requirement.title || 'Requirement'}`;
    if (to === 'ON_HOLD' || to === 'CLOSED') {
      const r = await pauseCandidates(requirement, to, user);
      r.owners.forEach((id) => id && people.add(id));
      if (r.moved || r.followUpsClosed) {
        await logAudit({ userId: user ? user.id : null, action: `Requirement ${to === 'CLOSED' ? 'closed' : 'on hold'}: candidates put on hold`, entity: 'Requirement', entityId: requirement.id, toValue: `${r.moved} candidate(s) on hold, ${r.followUpsClosed} follow-up(s) closed` }).catch(() => {});
      }
      await notifyUsers([...people], {
        title: `${label} is ${to === 'CLOSED' ? 'closed' : 'on hold'}`,
        message: r.moved ? `${r.moved} candidate(s) in its pipeline were put on hold and ${r.followUpsClosed} follow-up(s) were closed. Candidates already selected, offered or joined were not changed.` : 'Nobody was in its active pipeline.',
        exceptUserId: user ? user.id : null,
      }).catch(() => {});
      return r;
    }
    if (LIVE.includes(to) && (from === 'ON_HOLD' || from === 'CLOSED')) {
      const r = await resumeCandidates(requirement, user);
      r.owners.forEach((id) => id && people.add(id));
      if (r.restored) {
        await logAudit({ userId: user ? user.id : null, action: 'Requirement reopened: candidates back from hold', entity: 'Requirement', entityId: requirement.id, toValue: `${r.restored} candidate(s) back at their earlier stage` }).catch(() => {});
        await notifyUsers([...people], { title: `${label} is open again`, message: `${r.restored} candidate(s) went back to the stage they were at before the hold. Add their next follow-up.`, exceptUserId: user ? user.id : null }).catch(() => {});
      }
      return r;
    }
  } catch (err) {
    console.error('[requirement-lifecycle]', err.message); // eslint-disable-line no-console
  }
  return null;
}

module.exports = { onStatusChange, ACTIVE_STAGES, SYSTEM_ACTION };
