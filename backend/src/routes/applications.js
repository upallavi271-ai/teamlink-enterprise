const express = require('express');
const prisma = require('../db');
const { stampFor } = require('../utils/positions');
const { requireAuth, requirePerm, requireProduct } = require('../middleware/auth');
// The pipeline's workflow-action guard. Stage ownership is part of THE
// permission engine now, not a role list in this file.
const { canMoveToStage } = require('../utils/permissions');
const { logAudit } = require('../utils/audit');
const { notifyUsers } = require('../utils/notify');
const { computeMatch } = require('../utils/matching');
const { stageLabel, STAGE_OWNER_ACTION } = require('../utils/atsVocab');
const { applicationWhere, scopeOf, CLIENT_SHARED_STAGES } = require('../utils/scope');
const { raiseAutoFollowUp } = require('../utils/followups');
const { groupLabelOfStage } = require('../utils/pipelineView');
const { recordStageCommunications } = require('../utils/candidateComms');
// Hiring Type, the invoice-on-joining path and the internal-hire path all live
// in ONE place so the pipeline and the Joining workspace cannot drift apart.
const {
  hiringTypeOf, onApplicationJoined, stageAllowedForHiringType,
} = require('../utils/joining');
const { REJECTED_BY, REJECTED_BY_LABEL, stageMoveProblem } = require('../utils/atsVocab');
// §12 stage chain + §32 who hears about a move (utils/stageEvents.js).
const { stageGlobal } = require('../utils/permissions');
const { applicationInScope, OUT_OF_SCOPE } = require('../utils/scope');
const { stageMoveAudience, stageMoveNotice } = require('../utils/stageEvents');
const { hasPersonQuery, attributedApplications } = require('../utils/workers');
// THE ACTUAL WORKFLOW (2026-09-29): Job Portal screening before the ATS, and
// the internal chain's Dept Head / TL approval.
const {
  isPreAtsApplication, HR_SOURCING_SOURCE, STAGE_PHASE, stageLabelFor,
} = require('../utils/atsVocab');
const { stageRoleOf } = require('../utils/permissions');

// The moves an application may make while it is still in the Job Portal
// screening (portal / HR-sourced and not yet Sent to ATS): the screening steps
// themselves, or out of the process (Hold / Reject).
const PRE_ATS_MOVES = ['NEW', 'AI_INTERVIEW_REQUIRED', 'AI_INTERVIEW_SCHEDULED', 'AI_INTERVIEW_COMPLETED',
  'RECRUITER_REVIEW', 'RECRUITER_APPROVED', 'HOLD', 'REJECTED'];
// Who approves an INTERNAL candidate out of TL Review: the Dept Head / TL.
const DEPT_HEAD_ROLES = ['TL', 'STL'];

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
// STAGE_OWNERS MOVED to backend/src/utils/permissions.js.
//
// It was a SECOND permission system: a role list, inside a route handler,
// deciding who may act — exactly what this app does not do anywhere else.
// It is now part of the engine (permissions.js STAGE_OWNERS /
// STAGE_WORKFLOW_ACTIONS / canMoveToStage), resolved against the ATS
// PRODUCT ROLE like every other ATS decision, and the frontend reads the
// resolved form of it from /auth/me instead of re-deciding it.

router.get('/', async (req, res) => {
  // STEP 6 OF THE ENGINE — DATA SCOPE. This list had the module guard above
  // but no scope fragment, so it answered every signed-in login with the whole
  // pipeline: a Candidate calling GET /api/applications got all nineteen
  // applications, other people's names included, while GET /api/candidates
  // correctly returned only their own. Same helper every other list spreads.
  const where = { ...applicationWhere(req.user) };
  // Reaching a client's requirement is not enough for a CLIENT login: the
  // profile must actually have been SHARED with them. Same second gate
  // routes/candidates.js applies — without it a client sees everyone a
  // recruiter is still screening for their role.
  const scope = scopeOf(req.user);
  if (scope.role === 'CLIENT' || scope.atsRole === 'CLIENT') {
    where.stage = { in: CLIENT_SHARED_STAGES };
  }
  if (req.query.requirementId) where.requirementId = req.query.requirementId;
  if (req.query.candidateId) where.candidateId = req.query.candidateId;
  if (req.query.stage && !where.stage) where.stage = req.query.stage;
  // ?recruiter= / ?tl= / ?bde= ("id:<userId>" or "name:<name>") and
  // ?positionCode= — the work attributed to that person or seat
  // (utils/workers.js), former people included.
  if (hasPersonQuery(req.query)) {
    const att = await attributedApplications(req.user, req.query, { scope: applicationWhere(req.user) });
    where.id = { in: [...att.ids] };
  }
  const applications = await prisma.application.findMany({
    where,
    // recruiter and bde come along because utils/followups.js ownerOf() names
    // the follow-up owner from them — without them every automatic follow-up
    // was raised ownerless.
    include: { candidate: true, requirement: { include: { client: true, recruiter: true, bde: true } } },
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
  // Only onto a requirement this login may work (the same rule as the list).
  const reqInScope = await prisma.requirement.count({ where: { AND: [{ id: requirementId }, require('../utils/scope').requirementWhere(req.user)] } });
  if (!reqInScope) return res.status(403).json(OUT_OF_SCOPE);
  const match = computeMatch(candidate, requirement);
  // INTERNAL REQUIREMENT → HR SOURCING → CANDIDATES → JOB PORTAL (the actual
  // workflow). A candidate added to one of TeamLink's own openings lands in
  // the Job Portal screening (source "HR Sourcing", not yet Sent to ATS) and
  // reaches HR Review only through Duplicate Check → Resume Score → AI
  // Interview → Recruiter Review → Send to ATS. A candidate added to a client
  // requirement goes straight into the ATS as before.
  const hrSourced = hiringTypeOf(null, requirement) === 'TeamLink Internal Hire';

  const application = await prisma.application.create({
    data: {
      candidateId,
      requirementId,
      stage: 'NEW',
      matchScore: match.overall,
      resumeScore: candidate.resumeScore ?? null,
      source: hrSourced ? HR_SOURCING_SOURCE : 'ATS Match',
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
      action: hrSourced ? 'HR sourcing — added to the Job Portal screening' : 'Added to pipeline',
      comment: req.body.comment || null,
      actorUserId: req.user.id,
      actorName: req.user.name,
      actorRole: req.user.atsRole || req.user.role,
      // THE SEAT, beside the person — so this stays MED-1 work after the
      // person in MED-1 changes. Contributes nothing where no seat is held.
      ...(await stampFor(req.user, 'actor')),
    },
  });
  await logAudit({ userId: req.user.id, action: 'Candidate added to pipeline', entity: 'Application', entityId: application.id, toValue: 'New' });
  res.status(201).json(application);
});

// ---------------------------------------------------------------------------
// THE stage move. Extracted from the PATCH handler so that the route and the
// AI assistant's confirmed "move this candidate on" action run the SAME code:
// one permission check, one pipeline-ownership check, one set of side effects
// (stage event, candidate communications, audit row, notifications). There is
// no second stage-move implementation anywhere in this app.
//
// Returns { status, body } rather than writing to a response, because one of
// its two callers is not an HTTP handler.
// ---------------------------------------------------------------------------
async function applyStageMove(user, applicationId, body = {}) {
  const { stage, interviewAt, comment } = body;
  if (!stage) return { status: 400, body: { error: 'stage is required' } };

  // A REJECTION MUST SAY WHY, AND WHOSE DECISION IT WAS.
  //
  // Both used to be optional, on the grounds that the stage dropdowns and the
  // AI assistant share this function with the Reject dialog. The result was
  // 13,897 rejections that could not answer "why" or "who", which is the only
  // thing anybody opens a rejected record to find out. So every caller now
  // supplies them — the dialog asks, and the AI assistant has to ask the user
  // rather than inventing one.
  //
  // The side is ASKED, not inferred from the actor's role: a BDE recording a
  // client's "no" is recording the CLIENT's decision. A client login is the
  // one case where the side is a fact about who is acting.
  let rejectionSide = null;
  if (stage === 'REJECTED') {
    const clientLogin = [user.atsRole, user.role].includes('CLIENT');
    rejectionSide = clientLogin ? 'Client' : String(body.rejectedBy || '').trim();
    if (!REJECTED_BY.includes(rejectionSide)) {
      return {
        status: 400,
        body: {
          error: `Say whose decision the rejection was: ${REJECTED_BY.map((s) => REJECTED_BY_LABEL[s]).join(', ')}.`,
        },
      };
    }
    if (!String(body.reasonCategory || '').trim() && !String(body.reasonDetail || '').trim()) {
      return { status: 400, body: { error: 'Give a reason for the rejection.' } };
    }
  }

  // BOTH HALVES, in the engine. Access first (may this login act on the
  // pipeline at all, resolved against its ATS product role), then WORKFLOW
  // OWNERSHIP (does its ATS role own this stage) — seeing a record has never
  // implied acting on it and neither does being able to edit one.
  const refusal = await canMoveToStage(user, stage);
  if (refusal) return refusal;

  const existing = await prisma.application.findUnique({
    where: { id: applicationId },
    include: { candidate: true, requirement: { include: { client: true, recruiter: true, bde: true } } },
  });
  if (!existing) return { status: 404, body: { error: 'Application not found' } };

  // SCOPE FIRST: seeing the stage in your role is not reaching THIS candidate.
  // The record was loaded by id alone, so a recruiter could move another
  // team's candidate by id. Same rule as every list (utils/scope.js). Checked
  // before anything else so an outsider learns nothing about the record.
  if (!applicationInScope(user, existing)) return { status: 403, body: OUT_OF_SCOPE };

  // THE HIRING-TYPE BRANCH. Checked here rather than in canMoveToStage()
  // because that one is handed a user and a stage and nothing else, and this
  // question cannot be answered without the requirement: the same move is
  // right for an internal hire and wrong for a client placement.
  const wrongBranch = stageAllowedForHiringType(stage, existing, existing.requirement);
  if (wrongBranch) return { status: 409, body: { error: wrongBranch } };
  // THE JOB PORTAL COMES FIRST. Still in the screening → only the screening
  // steps, Hold or Reject. Send to ATS is the one way into the hiring chain.
  if (isPreAtsApplication(existing) && !PRE_ATS_MOVES.includes(stage)) {
    return {
      status: 409,
      body: { error: `${existing.candidate ? existing.candidate.name : 'This candidate'} is still in the Job Portal screening. Finish Duplicate Check → Resume Score → AI Interview → Recruiter Review and press Send to ATS first.` },
    };
  }
  // THE AGREEMENT GATE, for sharing too. A requirement cannot go live until
  // the client's agreement is Active (routes/requirements.js); a profile must
  // not reach the client while it is not Active either (e.g. it expired, or
  // was voided after the requirement opened). Internal hiring has no client.
  if (stage === 'SHARED_WITH_CLIENT' && existing.stage !== 'SHARED_WITH_CLIENT' && existing.requirement
    && !existing.requirement.internal && existing.requirement.client
    && existing.requirement.client.clientType !== 'Internal'
    // eslint-disable-next-line global-require
    && !require('../utils/atsVocab').agreementIsActive(existing.requirement.client.agreementStatus)) {
    // eslint-disable-next-line global-require
    const label = require('../utils/atsVocab').agreementStatusLabel(existing.requirement.client.agreementStatus);
    return {
      status: 409,
      body: { error: `Held at Agreement Check — the service agreement with ${existing.requirement.client.name} is ${label}, not Active. Profiles can be shared once it is Active.` },
    };
  }
  // A client acts only on profiles that have actually been shared with them.
  if ([user.atsRole, user.role].includes('CLIENT') && !CLIENT_SHARED_STAGES.includes(existing.stage)) {
    return { status: 403, body: OUT_OF_SCOPE };
  }

  // §12 THE CHAIN: forward at most one phase (utils/atsVocab.js
  // stageMoveProblem). Super Admin / Admin are exempt, for data correction.
  if (!stageGlobal(user)) {
    let resumeFrom = null;
    if (['HOLD', 'REJECTED'].includes(existing.stage)) {
      const parked = await prisma.applicationStageEvent.findFirst({
        where: { applicationId: existing.id, toStage: existing.stage },
        orderBy: { createdAt: 'desc' },
        select: { fromStage: true },
      });
      resumeFrom = parked ? parked.fromStage : null;
    }
    const internal = hiringTypeOf(existing, existing.requirement) === 'TeamLink Internal Hire';
    const chain = stageMoveProblem(existing.stage, stage, { internal, resumeFrom });
    if (chain) return { status: 409, body: { error: chain } };
    // INTERNAL HIRING: the Dept Head / TL approves (HR Review → Dept Head / TL
    // → Interview). HR owns the other internal stages, but an internal
    // candidate leaves TL Review forward only on a TL / STL's say-so.
    if (internal && existing.stage === 'TL_REVIEW' && (STAGE_PHASE[stage] || 0) > STAGE_PHASE.TL_REVIEW
      && !DEPT_HEAD_ROLES.includes(stageRoleOf(user))) {
      return { status: 403, body: { error: `Only the Dept Head / TL approves an internal candidate out of ${stageLabelFor('TL_REVIEW', { internal: true })}.` } };
    }
  }

  const application = await prisma.application.update({
    where: { id: applicationId },
    data: {
      stage,
      interviewStatus: stage === 'INTERVIEW_SCHEDULED' ? 'SCHEDULED' : stage === 'INTERVIEW_COMPLETED' ? 'COMPLETED' : existing.interviewStatus,
      // §34 — the AI interview's own status follows the AI stages, so the
      // calendar's AI list does not keep saying "Required" after it was taken.
      ...(stage === 'AI_INTERVIEW_SCHEDULED' && existing.aiInterviewStatus !== 'Completed' ? { aiInterviewStatus: 'Scheduled' } : {}),
      ...(stage === 'AI_INTERVIEW_COMPLETED' ? { aiInterviewStatus: 'Completed' } : {}),
      interviewAt: interviewAt ? new Date(interviewAt) : existing.interviewAt,
      // Scheduling an interview stamps the calendar columns the Interview
      // Calendar reads (interview ID, type, who booked it) if they aren't set yet.
      ...(stage === 'INTERVIEW_SCHEDULED'
        ? {
          interviewCode: existing.interviewCode || `INT-${existing.id.slice(-6).toUpperCase()}`,
          interviewType: existing.interviewType || (existing.requirement.internal ? 'Internal Panel' : 'Client Interview'),
          interviewCreatedBy: existing.interviewCreatedBy || user.name,
          ...(body.interviewer ? { interviewer: body.interviewer } : {}),
          ...(body.interviewMode ? { interviewMode: body.interviewMode } : {}),
          ...(body.interviewMeetingLink ? { interviewMeetingLink: body.interviewMeetingLink } : {}),
        }
        : {}),
      ...(body.offeredCtc != null && body.offeredCtc !== '' ? { offeredCtc: Number(body.offeredCtc) } : {}),
      ...(body.joiningDate ? { joiningDate: body.joiningDate } : {}),
    },
  });

  // ATS -> Accounts hand-off. Joining raises the placement invoice exactly
  // once, keyed on candidate + requirement, and every figure comes from the
  // client's agreed commercial terms — the prototype's confirmClientJoining()
  // (line 9099): fee = CTC x agreed fee %, GST 18%, TDS at the client's rate,
  // invoice 6 days after joining, payment due 6 days after that.
  if (stage === 'JOINED') {
    await onApplicationJoined({ application, existing, userId: user.id });
  }

  // §18-§20 — THE CHASE IS RAISED BY THE MOVE, not by somebody remembering.
  // Sharing with a client owes a decision chase, scheduling an interview owes
  // a confirmation, and so on. Never fatal: a follow-up that could not be
  // written must not lose a stage move that already happened.
  try {
    await raiseAutoFollowUp({
      application, requirement: existing.requirement, user, stage,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[followups] could not raise the automatic follow-up:', err.message);
  }

  // --- Pipeline History ----------------------------------------------------
  // One row per transition, carrying Who / When / Action / Comment. This is
  // what the candidate's Pipeline History tab renders; the stage column on the
  // application stays the single source of truth for WHERE they are now.
  //
  // followup_: REJECTED and HOLD keep their FULL record. Everything the user
  // listed is on this one row — candidate, requirement, client, previous
  // stage, who, their role, their SIDE, reason category, detailed reason,
  // comment, timestamp. The requirement title and client name are snapshotted
  // rather than only joined, because a rename must not rewrite history, and
  // `actorSide` is recorded rather than inferred from the role later: an
  // internal reject and a client reject mean two different things and the
  // record has to say which it was.
  //
  // Nothing is required here, because the same function serves the stage
  // dropdowns and the AI assistant's confirmed move as well as the Reject /
  // Hold dialog — a missing reason must not lose a move that already happened.
  // The dialog on the Candidate Detail screen is what actually asks for them.
  const clientOfRequirement = existing.requirement && existing.requirement.client;
  await prisma.applicationStageEvent.create({
    data: {
      applicationId: application.id,
      candidateId: existing.candidateId,
      fromStage: existing.stage,
      toStage: stage,
      action: `Moved to ${groupLabelOfStage(stage)} — ${stageLabel(stage)}`,
      comment: comment || null,
      actorUserId: user.id,
      actorName: user.name,
      actorRole: user.atsRole || user.role,
      ...(await stampFor(user, 'actor')),
      // For a rejection, whose decision it was (asked above). For any other
      // move, which side of the table the person moving it sits on.
      actorSide: rejectionSide || (['CLIENT'].includes(user.atsRole || user.role) ? 'Client' : 'Internal'),
      requirementId: existing.requirementId,
      requirementTitle: existing.requirement ? existing.requirement.title : null,
      clientId: existing.requirement ? existing.requirement.clientId : null,
      clientName: existing.requirement && existing.requirement.internal
        ? 'TeamLink Internal'
        : (clientOfRequirement && clientOfRequirement.name) || null,
      reasonCategory: body.reasonCategory || null,
      reasonDetail: body.reasonDetail || null,
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
      user: user,
      comment,
    });
  } catch (err) {
    // A communication record must never roll back a stage change that already
    // happened — the move is the business event, the message is a side effect.
    // eslint-disable-next-line no-console
    console.error('Could not record candidate communication:', err.message);
  }

  // followup_: a closed application stops owing a follow-up. Without this an
  // overdue follow-up on somebody who was rejected last week keeps escalating
  // to the TL and then to the Super Admin forever. Completing it preserves the
  // record — it is not deleted — and never rolls back the move.
  if (['JOINED', 'HIRED', 'REJECTED'].includes(stage)) {
    try {
      await prisma.applicationFollowUp.updateMany({
        where: { applicationId: application.id, completedAt: null },
        data: {
          completedAt: new Date(),
          completedById: user.id,
          completedNote: `Closed automatically — application moved to ${stageLabel(stage)}.`,
        },
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Could not close follow-ups on stage move:', err.message);
    }
  }

  await logAudit({
    userId: user.id,
    action: 'Application stage changed',
    entity: 'Application',
    entityId: application.id,
    fromValue: existing.stage,
    toValue: stage,
    reason: body.reasonCategory
      ? [body.reasonCategory, body.reasonDetail].filter(Boolean).join(' — ')
      : undefined,
  });

  // Tell whoever owns this requirement that the pipeline moved — the
  // prototype's pushNotification() on every stage transition. Stages the
  // client acts on also notify that client's users.
  // The TL is in the audience too: a move INTO TL Review is the TL's work.
  const audience = stageMoveAudience(existing.requirement);
  if (['SHARED_WITH_CLIENT', 'CLIENT_REVIEW'].includes(stage)) {
    const clientUsers = await prisma.user.findMany({
      where: { clientId: existing.requirement.clientId, role: 'CLIENT' },
      select: { id: true },
    });
    audience.push(...clientUsers.map((u) => u.id));
  }
  await notifyUsers(audience, {
    ...stageMoveNotice(existing.candidate.name, stage, existing.requirement),
    exceptUserId: user.id,
  });

  return { status: 200, body: application };
}

// ---------------------------------------------------------------------------
// BULK ACTIONS — POST /applications/bulk  (spec §25)
//
// The "N selected" bar on Candidates & Pipeline. Nothing here is a second
// rule set:
//   action 'stage'   every row goes through applyStageMove() above — the same
//                    permission check, stage ownership, scope, chain rule,
//                    reason requirement and side effects as a single move
//                    (Change Stage, Put on Hold, Reject, Schedule Interview).
//   action 'assign'  hands the application's current follow-up to a recruiter
//                    (closes the open one, opens one owned by them, stamped
//                    with their seat). Needs recruiterbde / Team View /
//                    assign — the leads' assign right; a recruiter is refused.
// Each row is checked on its own and reported on its own: one out-of-scope or
// wrong-stage row never blocks the rest, and never passes silently.
// Rows: applicationIds, or candidateIds (their CURRENT application — the one
// the list shows). At most BULK_ROW_LIMIT per call; the screen sends batches.
// ---------------------------------------------------------------------------
const BULK_ROW_LIMIT = 100;

router.post('/bulk', async (req, res, next) => {
  try {
    // eslint-disable-next-line global-require
    const { can: canDo } = require('../utils/permissions');
    // eslint-disable-next-line global-require
    const { chainSnapshot, resolveNames, defaultNextAction, defaultDueDate } = require('../utils/followups');
    // eslint-disable-next-line global-require
    const { atsRoleLabel } = require('../utils/atsVocab');
    const user = req.user;
    const b = req.body || {};
    const s = scopeOf(user);
    if ([s.role, s.atsRole].some((r) => ['CLIENT', 'CANDIDATE'].includes(r))) {
      return res.status(403).json({ error: 'Bulk actions are not available to this login' });
    }
    const action = String(b.action || '');
    if (!['stage', 'assign'].includes(action)) return res.status(400).json({ error: 'action must be stage or assign' });
    const appIds = [...new Set((Array.isArray(b.applicationIds) ? b.applicationIds : []).map(String).filter(Boolean))];
    const candIds = [...new Set((Array.isArray(b.candidateIds) ? b.candidateIds : []).map(String).filter(Boolean))];
    if (!appIds.length && !candIds.length) return res.status(400).json({ error: 'Select at least one candidate.' });
    if (appIds.length + candIds.length > BULK_ROW_LIMIT) {
      return res.status(400).json({ error: `At most ${BULK_ROW_LIMIT} rows per request — send them in batches.` });
    }

    // THE PERMISSION, ONCE, BEFORE ANY ROW: a login that may not do this at
    // all is refused outright rather than handed N identical failures.
    let target = null;
    let targetSeat = {};
    if (action === 'stage') {
      if (!b.stage) return res.status(400).json({ error: 'Choose the stage.' });
      const refusal = await canMoveToStage(user, b.stage);
      if (refusal) return res.status(refusal.status).json(refusal.body);
    } else {
      if (!(await canDo(user, 'ats', 'recruiterbde', 'Team View', 'assign'))) {
        return res.status(403).json({ error: "Assigning candidates isn't included in your role's permissions" });
      }
      target = b.recruiterId ? await prisma.user.findUnique({
        where: { id: String(b.recruiterId) },
        select: { id: true, name: true, status: true, atsAccess: true, atsRole: true, atsDepartment: true, atsScopeDepartments: true },
      }) : null;
      if (!target || target.status !== 'Active' || !target.atsAccess || !['RECRUITER', 'TL', 'STL'].includes(target.atsRole)) {
        return res.status(400).json({ error: 'Choose an active recruiter.' });
      }
      // Only someone inside the assigner's own reach — the same bench the
      // assign picker offers (a Medical TL cannot hand work to Education).
      if (!s.global) {
        const depts = [target.atsDepartment, ...String(target.atsScopeDepartments || '').split(',')].map((d) => String(d || '').trim()).filter(Boolean);
        const inTeam = (s.teamUserIds || []).includes(target.id)
          || (s.positions && (s.positions.holderUserIds || []).includes(target.id));
        if (!inTeam && !depts.some((d) => s.departments.includes(d))) {
          return res.status(403).json({ error: `${target.name} is outside your team, so work cannot be assigned to them.` });
        }
      }
      targetSeat = await stampFor(target, 'owner');
    }

    // RESOLVE THE ROWS. A candidate id means their current application —
    // the most recent one THIS login can see (the list's rule).
    const results = [];
    const rows = [];
    if (appIds.length) rows.push(...appIds.map((id) => ({ applicationId: id })));
    if (candIds.length) {
      const cands = await prisma.candidate.findMany({
        where: { id: { in: candIds } },
        select: { id: true, name: true, applications: { include: { requirement: true } } },
      });
      const byId = new Map(cands.map((c) => [c.id, c]));
      candIds.forEach((cid) => {
        const c = byId.get(cid);
        const visible = c ? c.applications.filter((a) => applicationInScope(user, a)) : [];
        const latest = visible.sort((x, y) => String(y.id).localeCompare(String(x.id)))[0];
        if (!c) results.push({ candidateId: cid, ok: false, error: 'Candidate not found' });
        else if (!latest) {
          results.push({
            candidateId: cid,
            candidateName: c.name,
            ok: false,
            error: c.applications.length ? 'Outside your access' : 'No application — nothing to act on',
          });
        } else rows.push({ applicationId: latest.id });
      });
    }

    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop
      const app = await prisma.application.findUnique({
        where: { id: row.applicationId },
        include: { candidate: { select: { id: true, name: true } }, requirement: { include: { client: true, recruiter: true, bde: true } } },
      });
      const base = {
        applicationId: row.applicationId,
        candidateId: app ? app.candidateId : null,
        candidateName: app && app.candidate ? app.candidate.name : null,
        fromStage: app ? app.stage : null,
      };
      if (!app) { results.push({ ...base, ok: false, error: 'Application not found' }); continue; }
      if (!applicationInScope(user, app)) { results.push({ ...base, ok: false, error: 'Outside your access' }); continue; }

      if (action === 'stage') {
        if (app.stage === b.stage) { results.push({ ...base, ok: false, skipped: true, error: `Already at ${stageLabel(b.stage)}` }); continue; }
        // eslint-disable-next-line no-await-in-loop
        const out = await applyStageMove(user, app.id, {
          stage: b.stage,
          comment: b.comment,
          rejectedBy: b.rejectedBy,
          reasonCategory: b.reasonCategory,
          reasonDetail: b.reasonDetail,
          interviewAt: b.interviewAt,
          interviewer: b.interviewer,
          interviewMode: b.interviewMode,
          interviewMeetingLink: b.interviewMeetingLink,
        });
        if (out.status === 200) results.push({ ...base, ok: true, toStage: b.stage });
        else results.push({ ...base, ok: false, error: (out.body && out.body.error) || `Refused (${out.status})` });
        continue;
      }

      // --- assign -----------------------------------------------------------
      // eslint-disable-next-line no-await-in-loop
      const open = await prisma.applicationFollowUp.findFirst({
        where: { applicationId: app.id, completedAt: null }, orderBy: { createdAt: 'desc' },
      });
      if (open && open.ownerUserId === target.id) {
        results.push({ ...base, ok: false, skipped: true, error: `Already with ${target.name}` });
        continue;
      }
      if (open) {
        // eslint-disable-next-line no-await-in-loop
        await prisma.applicationFollowUp.update({
          where: { id: open.id },
          data: { completedAt: new Date(), completedById: user.id, completedNote: `Reassigned to ${target.name} by ${user.name}.` },
        });
      }
      // eslint-disable-next-line no-await-in-loop
      const names = await resolveNames([app.requirement]);
      const snap = chainSnapshot(app, app.requirement, names);
      // eslint-disable-next-line no-await-in-loop
      await prisma.applicationFollowUp.create({
        data: {
          applicationId: app.id,
          candidateId: app.candidateId,
          requirementId: app.requirementId,
          ...snap,
          ownerUserId: target.id,
          ownerName: target.name,
          ownerRole: atsRoleLabel(target.atsRole),
          ...targetSeat,
          nextAction: (open && open.nextAction) || defaultNextAction(app),
          dueDate: (open && open.dueDate) || defaultDueDate(app),
          dueTime: (open && open.dueTime) || null,
          purpose: (open && open.purpose) || null,
          notes: `Assigned to ${target.name} by ${user.name}${b.comment ? ` — ${String(b.comment).slice(0, 500)}` : ''}`,
          createdById: user.id,
          createdByName: user.name,
        },
      });
      // eslint-disable-next-line no-await-in-loop
      await logAudit({
        userId: user.id,
        action: 'Candidate assigned to recruiter',
        entity: 'Application',
        entityId: app.id,
        fromValue: open ? open.ownerName || '—' : '—',
        toValue: target.name,
      });
      // Seen by the new owner only if their seat or the requirement reaches it
      // — said, rather than left for them to discover.
      const r = app.requirement || {};
      const onRequirement = r.recruiterId === target.id || String(r.recruiterIds || '').split(',').includes(target.id)
        || r.tlId === target.id || r.stlId === target.id;
      results.push({
        ...base,
        ok: true,
        note: onRequirement || targetSeat.ownerPositionCode ? null
          : `${target.name} holds no seat and is not on this requirement, so it will not appear in their list until the requirement is assigned to them.`,
      });
    }

    if (action === 'assign') {
      const assigned = results.filter((x) => x.ok).map((x) => x.candidateName).filter(Boolean);
      if (assigned.length) {
        await notifyUsers([target.id], {
          title: `${assigned.length} candidate(s) assigned to you`,
          message: `${assigned.slice(0, 5).join(', ')}${assigned.length > 5 ? ` +${assigned.length - 5} more` : ''} — assigned by ${user.name}`,
          exceptUserId: user.id,
        });
      }
    }

    const okCount = results.filter((x) => x.ok).length;
    return res.json({
      action,
      stage: action === 'stage' ? b.stage : undefined,
      recruiter: target ? { id: target.id, name: target.name } : undefined,
      total: results.length,
      ok: okCount,
      failed: results.length - okCount,
      results,
    });
  } catch (err) {
    return next(err);
  }
});

router.patch('/:id/stage', async (req, res, next) => {
  try {
    const out = await applyStageMove(req.user, req.params.id, req.body);
    return res.status(out.status).json(out.body);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
// Re-exported from the engine so any older importer of this name keeps
// working and there is still only ONE table.
module.exports.STAGE_OWNERS = require('../utils/permissions').STAGE_OWNERS;
module.exports.applyStageMove = applyStageMove;
