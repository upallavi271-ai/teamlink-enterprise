// ---------------------------------------------------------------------------
// "THIS PERSON IS ALREADY ON THIS JOB" - one place that says WHERE.
//
// Before: a second "Add application" for the same person + job was refused with
// one tiny line ("already in the pipeline") and the search boxes hid the person
// completely, so nobody could tell where the existing application was.
//
// Now every door answers the same way (409, code ALREADY_APPLIED):
//   { error, code, candidate:{id,name}, application:{...}, others:[...] }
// application / others carry ONLY what the caller may see:
//   * job title + code, client name, the step, when it was added  - the job is
//     already visible to the caller (the scope check runs first)
//   * the job's recruiter / TL names and "added by" - only when the application
//     itself is in the caller's scope (a BDE does not see the recruiters' desk)
//   * NEVER phone, email, salary or documents (the BDE privacy rule)
// `others` = the person's applications on OTHER jobs the caller may see (the same
// rule GET /candidates/:id/limited uses: jobs inside requirementWhere).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { stageLabelFor } = require('./atsVocab');
const { requirementWhere, applicationInScope } = require('./scope');

const ADDED_STATES = {
  REJECTED: 'Rejected',
  HOLD: 'On hold',
  JOINED: 'Joined',
  HIRED: 'Hired',
};

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => { const x = new Date(new Date(d).getTime() + 330 * 60000); return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`; };

function stateOf(app, requirement) {
  if (ADDED_STATES[app.stage]) return ADDED_STATES[app.stage];
  if (requirement && requirement.status === 'CLOSED') return 'Job closed';
  if (requirement && requirement.status === 'ON_HOLD') return 'Job paused';
  return 'Active';
}

// The row the screens show. `full` = the caller may see the desk details too.
function shape(app, requirement, { full, addedBy }) {
  const internal = !!requirement.internal;
  return {
    id: app.id,
    candidateId: app.candidateId,
    requirementId: requirement.id,
    requirementTitle: requirement.title,
    requirementCode: requirement.reqCode || null,
    clientName: internal ? 'TeamLink Internal' : (requirement.client && requirement.client.name) || null,
    stage: app.stage,
    step: stageLabelFor(app.stage, { internal }),
    status: stateOf(app, requirement),
    addedOn: app.createdAt,
    addedOnText: ymd(app.createdAt),
    ...(full ? {
      addedBy: addedBy || null,
      recruiterName: (requirement.recruiter && requirement.recruiter.name) || null,
      tlName: requirement.tl || null,
    } : {}),
    // One screen opens it for everyone: the candidate's page on that application (a BDE gets the limited card there).
    link: `/candidates/${app.candidateId}?application=${app.id}`,
  };
}

const APP_INCLUDE = { requirement: { include: { client: { select: { id: true, name: true } }, recruiter: { select: { id: true, name: true } } } } };

async function firstActor(applicationId) {
  const ev = await prisma.applicationStageEvent.findFirst({ where: { applicationId, fromStage: null }, orderBy: { createdAt: 'asc' }, select: { actorName: true } });
  return ev ? ev.actorName : null;
}

// The person's applications on OTHER jobs that the caller may see.
async function otherApplications(user, candidateId, excludeRequirementId) {
  const seeIds = new Set((await prisma.requirement.findMany({ where: requirementWhere(user), select: { id: true } })).map((r) => r.id));
  const rows = await prisma.application.findMany({
    where: { candidateId, ...(excludeRequirementId ? { requirementId: { not: excludeRequirementId } } : {}) },
    include: APP_INCLUDE,
    orderBy: { createdAt: 'desc' },
    take: 25,
  });
  return rows.filter((a) => a.requirement && seeIds.has(a.requirement.id)).map((a) => shape(a, a.requirement, { full: false }));
}

// The existing application of this pair, shaped for this caller (null when none).
async function existingFor(user, candidateId, requirementId) {
  const app = await prisma.application.findUnique({ where: { candidateId_requirementId: { candidateId, requirementId } }, include: APP_INCLUDE });
  if (!app) return null;
  let full = false;
  try { full = !!applicationInScope(user, app); } catch { full = false; }
  return shape(app, app.requirement, { full, addedBy: full ? await firstActor(app.id) : null });
}

// The 409 body. `candidate` = { id, name }.
async function alreadyAppliedBody(user, candidate, requirement, existing) {
  const application = existing || await existingFor(user, candidate.id, requirement.id);
  if (!application) return null;
  const others = await otherApplications(user, candidate.id, requirement.id);
  const where = [application.requirementTitle, application.clientName].filter(Boolean).join(' at ');
  const by = application.addedBy ? ` by ${application.addedBy}` : '';
  return {
    error: `${candidate.name} is already on ${where}: step ${application.step}, added ${application.addedOnText}${by}.`,
    code: 'ALREADY_APPLIED',
    candidate: { id: candidate.id, name: candidate.name },
    application,
    others,
  };
}

module.exports = { alreadyAppliedBody, existingFor, otherApplications, shape };
