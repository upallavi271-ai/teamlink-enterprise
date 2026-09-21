const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm, requireProduct } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { notifyUsers } = require('../utils/notify');
const { computeMatch } = require('../utils/matching');
const { stageLabel, STAGE_OWNER_ACTION } = require('../utils/atsVocab');
const { applicationWhere, scopeOf, CLIENT_SHARED_STAGES } = require('../utils/scope');
const { groupLabelOfStage } = require('../utils/pipelineView');
const { recordStageCommunications } = require('../utils/candidateComms');
// Hiring Type, the invoice-on-joining path and the internal-hire path all live
// in ONE place so the pipeline and the Joining workspace cannot drift apart.
const { hiringTypeOf, onApplicationJoined } = require('../utils/joining');

const router = express.Router();
router.use(requireAuth);
// The whole router belongs to ATS: a login without ATS access, or without
// view permission on this module, is refused at the door rather than handed
// an empty list.
router.use(requireProduct('ats'));
router.use(requirePerm('ats', 'candidates', 'Applications', 'view'));

// Who is allowed to move an application INTO each stage. Admins/Super Admins always allowed.
// The three AI_INTERVIEW_* stages sit between NEW and RECRUITER_REVIEW: a
// recruiter flags that an AI screening interview is needed, schedules it, then
// records it as completed before the human review starts.
// The 20 keys and their order match STAGE_CODES + EXTRA_STAGE_CODES in
// backend/src/utils/atsVocab.js. Labels are never derived from these codes.
const STAGE_OWNERS = {
  NEW: ['RECRUITER', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  AI_INTERVIEW_REQUIRED: ['RECRUITER', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  AI_INTERVIEW_SCHEDULED: ['RECRUITER', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  AI_INTERVIEW_COMPLETED: ['RECRUITER', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  RECRUITER_REVIEW: ['RECRUITER', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  RECRUITER_APPROVED: ['RECRUITER', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  WITH_BDE: ['RECRUITER', 'BDE', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  BDE_APPROVED: ['BDE', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  SHARED_WITH_CLIENT: ['BDE', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  CLIENT_REVIEW: ['BDE', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  CLIENT_SHORTLISTED: ['CLIENT', 'BDE', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  INTERVIEW_SCHEDULED: ['RECRUITER', 'BDE', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  INTERVIEW_COMPLETED: ['RECRUITER', 'BDE', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  SELECTED: ['CLIENT', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  OFFER: ['RECRUITER', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  OFFER_ACCEPTED: ['RECRUITER', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  JOINED: ['RECRUITER', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  HIRED: ['TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  REJECTED: ['RECRUITER', 'BDE', 'CLIENT', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  HOLD: ['RECRUITER', 'BDE', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
};

// Every other application read goes through applicationWhere(); this one did
// not, so any ATS login got the whole table — a client could list another
// client's candidates. The query filters below only ever NARROW the scoped
// set; they can never widen it.
router.get('/', async (req, res) => {
  const scope = scopeOf(req.user);
  const where = { ...applicationWhere(req.user) };
  // Reaching a client's requirement is not enough for a CLIENT login: the
  // profile must actually have been shared with them. Same gate as
  // routes/candidates.js.
  if (scope.role === 'CLIENT' || scope.atsRole === 'CLIENT') {
    where.stage = { in: CLIENT_SHARED_STAGES };
  }
  if (req.query.requirementId) where.requirementId = req.query.requirementId;
  if (req.query.candidateId) where.candidateId = req.query.candidateId;
  if (req.query.stage && !where.stage) where.stage = req.query.stage;
  const applications = await prisma.application.findMany({
    where,
    include: { candidate: true, requirement: { include: { client: true } } },
    orderBy: { updatedAt: 'desc' },
  });
  res.json(applications);
});

// Adding someone to a pipeline is a recruiting action — the prototype gates it
// on the "candidates: create" permission, so a CLIENT or EMPLOYEE cannot do it.

router.post('/', requirePerm('ats', 'candidates', 'Applications', 'create'), async (req, res) => {
  const { candidateId, requirementId } = req.body;
  if (!candidateId || !requirementId) return res.status(400).json({ error: 'candidateId and requirementId are required' });

  const existing = await prisma.application.findUnique({
    where: { candidateId_requirementId: { candidateId, requirementId } },
  });
  if (existing) return res.status(409).json({ error: 'This candidate is already in the pipeline for this requirement.' });

  // The match score is frozen onto the application at the moment the candidate
  // enters the pipeline — the prototype's addCandidateToRequirement().
  const [candidate, requirement] = await Promise.all([
    prisma.candidate.findUnique({ where: { id: candidateId } }),
    prisma.requirement.findUnique({ where: { id: requirementId } }),
  ]);
  if (!candidate || !requirement) return res.status(404).json({ error: 'Candidate or requirement not found' });
  const match = computeMatch(candidate, requirement);

  const application = await prisma.application.create({
    data: {
      candidateId,
      requirementId,
      stage: 'NEW',
      matchScore: match.overall,
      resumeScore: candidate.resumeScore ?? null,
      source: 'ATS Match',
      applicationMethod: 'Manual',
      aiInterviewStatus: 'Required',
      // Client Placement vs TeamLink Internal Hire, decided once, here, from
      // the requirement it is raised against — and stored, not re-guessed.
      hiringType: hiringTypeOf(null, requirement),
    },
  });
  // The first link in the pipeline chain the Candidate Detail screen renders.
  await prisma.applicationStageEvent.create({
    data: {
      applicationId: application.id,
      candidateId,
      fromStage: null,
      toStage: 'NEW',
      action: 'Added to pipeline',
      comment: req.body.comment || null,
      actorUserId: req.user.id,
      actorName: req.user.name,
      actorRole: req.user.atsRole || req.user.role,
    },
  });
  await logAudit({ userId: req.user.id, action: 'Candidate added to pipeline', entity: 'Application', entityId: application.id, toValue: 'New' });
  res.status(201).json(application);
});

router.patch('/:id/stage', async (req, res) => {
  const { stage, interviewAt, comment } = req.body;
  if (!stage) return res.status(400).json({ error: 'stage is required' });

  const allowedRoles = STAGE_OWNERS[stage];
  if (!allowedRoles) return res.status(400).json({ error: 'Unknown stage' });
  // STAGE_OWNERS is pipeline workflow (who owns a stage), not access control:
  // the access half is caps.atsAct, resolved from the permission engine.
  if (!req.user.caps.atsAct) {
    return res.status(403).json({ error: "This action isn't included in your role's permissions" });
  }
  const isAdmin = req.user.caps.hrmsManage && req.user.caps.accountsManage;
  if (!isAdmin && !allowedRoles.includes(req.user.atsRole || req.user.role)) {
    return res.status(403).json({ error: "Moving to this stage isn't included in your role's permissions" });
  }

  const existing = await prisma.application.findUnique({
    where: { id: req.params.id },
    include: { candidate: true, requirement: { include: { client: true } } },
  });
  if (!existing) return res.status(404).json({ error: 'Application not found' });

  const application = await prisma.application.update({
    where: { id: req.params.id },
    data: {
      stage,
      interviewStatus: stage === 'INTERVIEW_SCHEDULED' ? 'SCHEDULED' : stage === 'INTERVIEW_COMPLETED' ? 'COMPLETED' : existing.interviewStatus,
      interviewAt: interviewAt ? new Date(interviewAt) : existing.interviewAt,
      // Scheduling an interview stamps the calendar columns the Interview
      // Calendar reads (interview ID, type, who booked it) if they aren't set yet.
      ...(stage === 'INTERVIEW_SCHEDULED'
        ? {
          interviewCode: existing.interviewCode || `INT-${existing.id.slice(-6).toUpperCase()}`,
          interviewType: existing.interviewType || (existing.requirement.internal ? 'Internal Panel' : 'Client Interview'),
          interviewCreatedBy: existing.interviewCreatedBy || req.user.name,
          ...(req.body.interviewer ? { interviewer: req.body.interviewer } : {}),
          ...(req.body.interviewMode ? { interviewMode: req.body.interviewMode } : {}),
          ...(req.body.interviewMeetingLink ? { interviewMeetingLink: req.body.interviewMeetingLink } : {}),
        }
        : {}),
      ...(req.body.offeredCtc != null && req.body.offeredCtc !== '' ? { offeredCtc: Number(req.body.offeredCtc) } : {}),
      ...(req.body.joiningDate ? { joiningDate: req.body.joiningDate } : {}),
    },
  });

  // ATS -> Accounts hand-off. Joining raises the placement invoice exactly
  // once, keyed on candidate + requirement, and every figure comes from the
  // client's agreed commercial terms — the prototype's confirmClientJoining()
  // (line 9099): fee = CTC x agreed fee %, GST 18%, TDS at the client's rate,
  // invoice 6 days after joining, payment due 6 days after that.
  if (stage === 'JOINED') {
    await onApplicationJoined({ application, existing, userId: req.user.id });
  }

  // --- Pipeline History ----------------------------------------------------
  // One row per transition, carrying Who / When / Action / Comment. This is
  // what the candidate's Pipeline History tab renders; the stage column on the
  // application stays the single source of truth for WHERE they are now.
  await prisma.applicationStageEvent.create({
    data: {
      applicationId: application.id,
      candidateId: existing.candidateId,
      fromStage: existing.stage,
      toStage: stage,
      action: `Moved to ${groupLabelOfStage(stage)} — ${stageLabel(stage)}`,
      comment: comment || null,
      actorUserId: req.user.id,
      actorName: req.user.name,
      actorRole: req.user.atsRole || req.user.role,
    },
  });

  // --- Candidate communication ---------------------------------------------
  // Stage changes trigger the candidate-facing Email / SMS / WhatsApp records
  // (AI Interview Scheduled, Interview Scheduled, Selected, and the rest — see
  // utils/candidateComms.js for the template set). NOTHING IS TRANSMITTED: no
  // provider is configured in this app, so each row is written with status
  // NOT_SENT_NO_PROVIDER and shows up in the Communications tab labelled that
  // way. The trigger and the record are real; the delivery is not.
  //
  // The from-address on each row is the acting EMPLOYEE's own email, taken
  // from the employee record captured when they were added.
  try {
    await recordStageCommunications({
      application,
      candidate: existing.candidate,
      requirement: existing.requirement,
      fromStage: existing.stage,
      toStage: stage,
      user: req.user,
      comment,
    });
  } catch (err) {
    // A communication record must never roll back a stage change that already
    // happened — the move is the business event, the message is a side effect.
    // eslint-disable-next-line no-console
    console.error('Could not record candidate communication:', err.message);
  }

  await logAudit({
    userId: req.user.id,
    action: 'Application stage changed',
    entity: 'Application',
    entityId: application.id,
    fromValue: existing.stage,
    toValue: stage,
  });

  // Tell whoever owns this requirement that the pipeline moved — the
  // prototype's pushNotification() on every stage transition. Stages the
  // client acts on also notify that client's users.
  const audience = [existing.requirement.recruiterId, existing.requirement.bdeId];
  if (['SHARED_WITH_CLIENT', 'CLIENT_REVIEW'].includes(stage)) {
    const clientUsers = await prisma.user.findMany({
      where: { clientId: existing.requirement.clientId, role: 'CLIENT' },
      select: { id: true },
    });
    audience.push(...clientUsers.map((u) => u.id));
  }
  await notifyUsers(audience, {
    title: `${existing.candidate.name} moved to ${stageLabel(stage)}`,
    message: `${existing.requirement.title} — ${existing.requirement.client.name}`,
    exceptUserId: req.user.id,
  });

  res.json(application);
});

module.exports = router;
