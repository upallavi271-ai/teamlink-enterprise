// ---------------------------------------------------------------------------
// The side effects of a pipeline move made OUTSIDE routes/applications.js
// applyStageMove() — the interview decision, offer release / acceptance,
// Mark Joined, Create HRMS Employee, and interview feedback moving Interview
// Scheduled -> Interview Completed.
//
// Those routes have their own permission gates and their own preconditions
// (an offer follows Selected, a joining needs verified documents, ...) so they
// do not call applyStageMove. What they must NOT do is move the stage
// silently: §32 — every action updates immediately, the pending action leaves
// one person and appears for the next, and the candidate's history says who
// did what. They used to write only an audit row, so the candidate's Pipeline
// History skipped straight from Interview to Joined and nobody was told.
//
// One helper, the same four effects applyStageMove has:
//   1. an ApplicationStageEvent row (Pipeline History)
//   2. the candidate communications for the new stage (utils/candidateComms)
//   3. the automatic follow-up the new stage owes / closing the open ones
//   4. an in-app notification to the requirement's recruiter, TL and BDE
// Never fatal: a side effect that fails must not lose a move already made.
// ---------------------------------------------------------------------------

const prisma = require('../db');
const { stampFor } = require('./positions');
const { notifyUsers } = require('./notify');
const { stageLabel, pendingTermOfStage } = require('./atsVocab');
const { groupLabelOfStage } = require('./pipelineView');

// The people whose queue a move on this requirement lands in or leaves.
function stageMoveAudience(requirement) {
  const r = requirement || {};
  return [r.recruiterId, r.tlId, r.bdeId].filter(Boolean);
}

// "Asha Rao moved to TL Review" / "TL Review pending — Staff Nurse · Apollo".
// The pending term is the §31 vocabulary, so the bell reads like the dashboard.
function stageMoveNotice(candidateName, toStage, requirement) {
  const r = requirement || {};
  const where = [r.title, r.internal ? 'TeamLink Internal' : (r.client && r.client.name)].filter(Boolean).join(' — ');
  const term = pendingTermOfStage(toStage);
  return {
    title: `${candidateName} moved to ${stageLabel(toStage)}`,
    message: term ? `${term} pending · ${where}` : where,
  };
}

async function recordWorkflowMove({
  user, existing, application, toStage, action, comment,
  reasonCategory, reasonDetail, rejectionSide,
}) {
  if (!existing || !toStage || existing.stage === toStage) return;
  const requirement = existing.requirement || {};
  const client = requirement.client;
  const app = application || existing;

  try {
    await prisma.applicationStageEvent.create({
      data: {
        applicationId: existing.id,
        candidateId: existing.candidateId,
        fromStage: existing.stage,
        toStage,
        action: action || `Moved to ${groupLabelOfStage(toStage)} — ${stageLabel(toStage)}`,
        comment: comment || null,
        actorUserId: user.id,
        actorName: user.name,
        actorRole: user.atsRole || user.role,
        ...(await stampFor(user, 'actor')),
        actorSide: rejectionSide || ([user.atsRole, user.role].includes('CLIENT') ? 'Client' : 'Internal'),
        requirementId: existing.requirementId,
        requirementTitle: requirement.title || null,
        clientId: requirement.clientId || null,
        clientName: requirement.internal ? 'TeamLink Internal' : (client && client.name) || null,
        reasonCategory: reasonCategory || null,
        reasonDetail: reasonDetail || null,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[stageEvents] could not write the stage event:', err.message);
  }

  try {
    // Required lazily: candidateComms pulls in the mail worker chain.
    // eslint-disable-next-line global-require
    const { recordStageCommunications } = require('./candidateComms');
    await recordStageCommunications({
      application: { ...app, stage: toStage },
      candidate: existing.candidate,
      requirement,
      fromStage: existing.stage,
      toStage,
      user,
      comment,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[stageEvents] could not record candidate communication:', err.message);
  }

  try {
    // eslint-disable-next-line global-require
    const { raiseAutoFollowUp } = require('./followups');
    await raiseAutoFollowUp({ application: { ...app, stage: toStage }, requirement, user, stage: toStage });
    if (['JOINED', 'HIRED', 'REJECTED'].includes(toStage)) {
      await prisma.applicationFollowUp.updateMany({
        where: { applicationId: existing.id, completedAt: null },
        data: {
          completedAt: new Date(),
          completedById: user.id,
          completedNote: `Closed automatically — application moved to ${stageLabel(toStage)}.`,
        },
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[stageEvents] follow-up bookkeeping failed:', err.message);
  }

  try {
    await notifyUsers(stageMoveAudience(requirement), {
      ...stageMoveNotice(existing.candidate ? existing.candidate.name : 'Candidate', toStage, requirement),
      exceptUserId: user.id,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[stageEvents] could not notify:', err.message);
  }
}

module.exports = { recordWorkflowMove, stageMoveAudience, stageMoveNotice };
