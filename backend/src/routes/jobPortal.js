// ---------------------------------------------------------------------------
// Job Portal — the three experiences, one permission engine.
//
//   A. PUBLIC / CANDIDATE portal.  Not here. It is the customer's own
//      self-contained app, served byte-identical at /job-portal/ (see
//      backend/src/index.js). It keeps its own accounts in localStorage and
//      this API never touches it. The DB-backed careers flow that DOES reach
//      this database is routes/public.js.
//
//   B. INTERNAL ATS workspace.  GET /workspace, POST /jobs/:id/publish,
//      POST /sync, GET /applications, POST /applications/:id/import.
//      Lives inside Jobs / Requirements: every guard below is a feature of
//      the `requirements` module, never a module of its own.
//
//   C. CLIENT portal view.  GET /client. A client's own PUBLISHED
//      requirements and the candidates SHARED with them, and nothing else —
//      no posting controls, no sync, no recruiter names, no other client, no
//      internal notes.
//
// THERE IS NO SECOND PERMISSION SYSTEM HERE. Every route is guarded by
// requirePerm(product, module, feature, action) against
// utils/permissions.js, and every list is narrowed by utils/scope.js. No
// handler tests req.user.role.
//
// HONESTY. Nothing in this file pretends data crosses between this database
// and the standalone portal at /job-portal/. "Publish" records a decision in
// THIS database and makes the requirement visible on THIS app's public job
// feed (routes/public.js). "Sync" re-reads THIS database. Where the seam to a
// real two-way integration would attach is marked SYNC SEAM, the same phrase
// routes/admin.js uses.
// ---------------------------------------------------------------------------

const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm, can, requireProduct } = require('../middleware/auth');
const {
  requirementWhere, portalRequirementWhere, applicationWhere, matches,
  scopeOf, isAssignedTo, CLIENT_SHARED_STAGES, OUT_OF_SCOPE,
} = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const { notifyUsers } = require('../utils/notify');
const {
  REQUIREMENT_LIVE_STATUSES, requirementIsLive, stageLabel, requirementStatusLabel,
  PORTAL_APPLICATION_SOURCES,
} = require('../utils/atsVocab');

const router = express.Router();
router.use(requireAuth);
// The portal is an ATS surface. A login without ATS access — an Accountant,
// an HRMS-only Employee — is refused at the door, before any feature check,
// which is why "portal access comes from an ATS role, never from being an
// employee" is true of the API and not only of the sidebar.
router.use(requireProduct('ats'));

const WORKSPACE = ['ats', 'requirements', 'Job Portal Workspace'];
const APPLICATIONS = ['ats', 'requirements', 'Job Portal Applications'];
const CLIENT_VIEW = ['ats', 'requirements', 'Client Job Portal'];
const perm = (tuple, action) => requirePerm(tuple[0], tuple[1], tuple[2], action);

// Async handlers must never reject into the void — an unhandled rejection has
// taken this process down before. Every route below is wrapped.
const wrap = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// A portal application is one whose Application.source names a portal, or —
// for rows written before Application.source was stamped — whose CANDIDATE
// came from one. Both halves are the same list (utils/atsVocab.js).
const PORTAL_APPLICATION_FILTER = {
  OR: [
    { source: { in: PORTAL_APPLICATION_SOURCES } },
    { AND: [{ source: null }, { candidate: { source: { in: PORTAL_APPLICATION_SOURCES } } }] },
  ],
};

// requirementWhere() returns {} for a globally-scoped user, and Prisma does
// not accept an empty object as a relation filter, so wrap it rather than
// spreading it blind.
const onRequirements = (where) => (Object.keys(where).length ? { requirement: where } : {});

// EDIT / PUBLISH is narrower than VIEW, exactly as it is on the requirement
// itself: holding the permission is not enough, you must also be named on the
// record's assignment chain unless your scope is global. Same helper the
// requirements router uses (utils/scope.js isAssignedTo).
function mayActOnRecord(user, requirement) {
  const s = scopeOf(user);
  return s.global || isAssignedTo(user, requirement);
}

function jobRow(r) {
  return {
    id: r.id,
    reqCode: r.reqCode,
    title: r.title,
    client: r.client ? r.client.name : null,
    internal: r.internal,
    department: r.department,
    location: r.location,
    openings: r.openings,
    status: r.status,
    statusLabel: requirementStatusLabel(r.status),
    live: requirementIsLive(r.status),
    published: !!r.portalPublished,
    publishedAt: r.portalPublishedAt,
    portalSyncStatus: r.portalSyncStatus || 'Not Synced',
    applications: r._count ? r._count.applications : 0,
  };
}

// ---------------------------------------------------------------------------
// B. The internal workspace.
//   Publish -> Sync -> Applications -> Import to ATS -> Candidate Pipeline
// ---------------------------------------------------------------------------
router.get('/workspace', perm(WORKSPACE, 'view'), wrap(async (req, res) => {
  const where = portalRequirementWhere(req.user);
  const [jobs, portalApps] = await Promise.all([
    prisma.requirement.findMany({
      where,
      include: { client: true, _count: { select: { applications: true } } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.application.findMany({
      where: { ...PORTAL_APPLICATION_FILTER, ...onRequirements(where) },
      select: { id: true, portalImportedAt: true },
    }),
  ]);

  // What this user may DO, resolved from the engine and sent to the browser
  // so the buttons and the API can never disagree. Sync and Open Job Portal
  // are two separate answers because they are two separate actions.
  const [publish, sync, importApp, viewApps, exportable] = await Promise.all([
    can(req.user, ...WORKSPACE, 'edit'),
    can(req.user, ...WORKSPACE, 'configure'),
    can(req.user, ...APPLICATIONS, 'create'),
    can(req.user, ...APPLICATIONS, 'view'),
    can(req.user, ...WORKSPACE, 'export'),
  ]);

  const rows = jobs.map(jobRow);
  res.json({
    jobs: rows,
    stats: {
      requirements: rows.length,
      published: rows.filter((j) => j.published).length,
      unpublished: rows.filter((j) => !j.published && j.live).length,
      synced: rows.filter((j) => j.portalSyncStatus === 'Synced').length,
      pendingSync: rows.filter((j) => j.published && j.portalSyncStatus !== 'Synced').length,
      applications: portalApps.length,
      awaitingImport: portalApps.filter((a) => !a.portalImportedAt).length,
    },
    permissions: {
      // `view` is implied — this route refused already if it were false.
      publish, sync, import: importApp, viewApplications: viewApps, export: exportable,
      // Opening the portal is not a data action; anyone who reaches this
      // workspace may follow the link. It is listed separately from `sync` so
      // that the two buttons stay two buttons.
      openPortal: true,
    },
  });
}));

// Publish / unpublish. `edit` on Job Portal Workspace, plus the assignment
// chain for anyone whose scope is not global.
router.post('/jobs/:id/publish', perm(WORKSPACE, 'edit'), wrap(async (req, res) => {
  const requirement = await prisma.requirement.findUnique({ where: { id: req.params.id } });
  if (!requirement) return res.status(404).json({ error: 'Requirement not found' });
  if (!matches(requirement, requirementWhere(req.user))) return res.status(403).json(OUT_OF_SCOPE);
  if (!mayActOnRecord(req.user, requirement)) {
    return res.status(403).json({ error: 'You can see this requirement, but you are not on its assignment chain' });
  }

  const publish = req.body.published !== false;
  if (publish && !requirementIsLive(requirement.status)) {
    return res.status(400).json({
      error: `A requirement in "${requirementStatusLabel(requirement.status)}" cannot be published to the job portal — only a live requirement can.`,
    });
  }

  const updated = await prisma.requirement.update({
    where: { id: requirement.id },
    data: publish
      ? {
        portalPublished: true,
        portalPublishedAt: new Date(),
        portalPublishedBy: req.user.id,
        portalUnpublishedAt: null,
        // Published but not yet pushed out. Sync is the separate step.
        portalSyncStatus: 'Pending',
      }
      : {
        portalPublished: false,
        portalUnpublishedAt: new Date(),
        portalSyncStatus: 'Not Synced',
      },
  });
  await logAudit({
    userId: req.user.id,
    action: publish ? 'Requirement published to job portal' : 'Requirement unpublished from job portal',
    entity: 'Requirement',
    entityId: requirement.id,
    fromValue: requirement.portalPublished ? 'Published' : 'Not published',
    toValue: publish ? 'Published' : 'Not published',
  });
  return res.json(jobRow({ ...updated, client: null, _count: null }));
}));

// Sync — SCOPED. Deliberately a different endpoint from the Administration →
// Integrations sync (which needs administration/Integrations/configure and is
// company-wide): a Recruiter, TL or BDE gets Sync for THEIR requirements
// without being handed the Integrations screen.
//
// SYNC SEAM. What this does today: it marks the user's published, live
// requirements as Synced and writes a SyncLog row, all inside this database.
// It contacts nothing. The standalone portal at /job-portal/ holds its jobs in
// its own localStorage, so nothing is pushed to it and nothing is pulled back.
// A real integration would replace the update below with a call out to the
// portal's API and set Synced / Failed from its response.
router.post('/sync', perm(WORKSPACE, 'configure'), wrap(async (req, res) => {
  const where = portalRequirementWhere(req.user, { publishedOnly: true });
  const published = await prisma.requirement.findMany({
    where,
    select: { id: true, status: true, portalSyncStatus: true },
  });
  const live = published.filter((r) => requirementIsLive(r.status));
  const stale = published.filter((r) => !requirementIsLive(r.status));

  if (live.length) {
    await prisma.requirement.updateMany({
      where: { id: { in: live.map((r) => r.id) } },
      data: { portalSyncStatus: 'Synced' },
    });
  }
  // A published requirement that is no longer live cannot be on offer. Say so
  // rather than leaving it reading "Synced".
  if (stale.length) {
    await prisma.requirement.updateMany({
      where: { id: { in: stale.map((r) => r.id) } },
      data: { portalSyncStatus: 'Failed' },
    });
  }

  const applications = await prisma.application.count({
    where: { ...PORTAL_APPLICATION_FILTER, ...onRequirements(portalRequirementWhere(req.user)) },
  });

  await prisma.syncLog.create({
    data: {
      entity: 'Requirements',
      status: stale.length ? 'Failed' : 'Success',
      reason: `${req.user.name}: ${live.length} published requirement(s) marked Synced, `
        + `${stale.length} no longer live, ${applications} portal application(s) in scope. `
        + 'Re-read from this ATS — no external portal was contacted.',
    },
  });
  await logAudit({
    userId: req.user.id, action: 'Job portal sync (scoped)', entity: 'Requirement',
    toValue: `${live.length} synced / ${stale.length} failed`,
  });

  return res.json({
    ok: true,
    synced: live.length,
    failed: stale.length,
    applications,
    note: 'Sync re-read this ATS only. No external job portal was contacted.',
  });
}));

// The applications arriving from the portal, scoped. A Medical recruiter gets
// Medical applications; an IT recruiter gets IT ones. Same requirementWhere()
// that scopes every other requirement list.
router.get('/applications', perm(APPLICATIONS, 'view'), wrap(async (req, res) => {
  const apps = await prisma.application.findMany({
    where: { ...PORTAL_APPLICATION_FILTER, ...applicationWhere(req.user) },
    include: {
      candidate: { select: { id: true, name: true, email: true, phone: true, source: true, skills: true } },
      requirement: { select: { id: true, reqCode: true, title: true, department: true, portalPublished: true, client: { select: { name: true } } } },
    },
    orderBy: { createdAt: 'desc' },
  });
  const importable = await can(req.user, ...APPLICATIONS, 'create');
  res.json({
    applications: apps.map((a) => ({
      id: a.id,
      candidateId: a.candidateId,
      candidate: a.candidate.name,
      email: a.candidate.email,
      phone: a.candidate.phone,
      skills: a.candidate.skills,
      requirementId: a.requirementId,
      reqCode: a.requirement.reqCode,
      job: a.requirement.title,
      department: a.requirement.department,
      client: a.requirement.client ? a.requirement.client.name : null,
      published: !!a.requirement.portalPublished,
      // The brief's "source = TeamLink Job Portal". Stored, not inferred.
      source: a.source || a.candidate.source,
      stage: a.stage,
      stageLabel: stageLabel(a.stage),
      appliedAt: a.createdAt,
      imported: !!a.portalImportedAt,
      importedAt: a.portalImportedAt,
    })),
    permissions: { import: importable },
  });
}));

// IMPORT TO ATS.
//
// What it really does, stated plainly because the screen says the same thing:
// a portal application is ALREADY a pipeline row — routes/public.js creates
// the Candidate and the Application when the form is submitted. Import is the
// recorded act of a recruiter ADMITTING it: it stamps who imported it and
// when, moves it off NEW into Recruiter Review, and writes the pipeline-history
// event, so the candidate appears in Candidates & Pipeline as a reviewed
// arrival rather than an untouched inbox row. It does NOT fetch anything from
// the standalone portal — see SYNC SEAM above.
router.post('/applications/:id/import', perm(APPLICATIONS, 'create'), wrap(async (req, res) => {
  const application = await prisma.application.findFirst({
    where: { id: req.params.id, ...applicationWhere(req.user) },
    include: { requirement: true, candidate: { select: { name: true, source: true } } },
  });
  if (!application) return res.status(404).json({ error: 'Application not found, or outside your access scope' });
  if (!mayActOnRecord(req.user, application.requirement)) {
    return res.status(403).json({ error: 'You can see this application, but you are not on its requirement’s assignment chain' });
  }
  const source = application.source || application.candidate.source;
  if (!PORTAL_APPLICATION_SOURCES.includes(String(source || ''))) {
    return res.status(400).json({ error: 'This application did not come from a job portal, so there is nothing to import.' });
  }
  if (application.portalImportedAt) {
    return res.status(409).json({ error: 'This application has already been imported into the ATS.' });
  }

  const toStage = application.stage === 'NEW' ? 'RECRUITER_REVIEW' : application.stage;
  const updated = await prisma.application.update({
    where: { id: application.id },
    data: {
      portalImportedAt: new Date(),
      portalImportedBy: req.user.id,
      stage: toStage,
      // Keep the recorded provenance canonical now that it is in the pipeline.
      source: source,
      firstSource: application.firstSource || source,
    },
  });
  await prisma.applicationStageEvent.create({
    data: {
      applicationId: application.id,
      candidateId: application.candidateId,
      fromStage: application.stage,
      toStage,
      action: `Imported to ATS from ${source}`,
      comment: req.body && req.body.comment ? String(req.body.comment) : null,
      actorUserId: req.user.id,
      actorName: req.user.name,
      actorRole: req.user.atsRole || req.user.role,
    },
  });
  await logAudit({
    userId: req.user.id, action: 'Job portal application imported to ATS', entity: 'Application',
    entityId: application.id, fromValue: application.stage, toValue: toStage,
  });
  return res.json({ ok: true, id: updated.id, stage: updated.stage, stageLabel: stageLabel(updated.stage) });
}));

// ---------------------------------------------------------------------------
// C. The client portal view.
//
// A client sees: their own requirements WITH whether each one is published,
// and the candidates SHARED with them. The publish FLAG is reported; the
// publish CONTROL is not, and the list is not narrowed to published rows —
// a client asked to see their requirements and which of them are out, not to
// have the unpublished ones hidden from them.
//
// utils/scope.js decides both lists — requirementWhere()'s CLIENT branch
// (own company, never TeamLink's internal openings) and CLIENT_SHARED_STAGES
// (a profile the client has actually been shown, never one sitting at
// Recruiter Review). Nothing about posting, sync, integrations, recruiter
// assignment, another client or an internal note is selected, let alone sent.
// ---------------------------------------------------------------------------
router.get('/client', perm(CLIENT_VIEW, 'view'), wrap(async (req, res) => {
  const where = portalRequirementWhere(req.user);
  const requirements = await prisma.requirement.findMany({
    where,
    select: {
      id: true, reqCode: true, title: true, department: true, location: true,
      openings: true, status: true, portalPublished: true, portalPublishedAt: true,
      createdAt: true, client: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  // Applications on those requirements that have reached — or have ever
  // reached — a stage the client was shown. The "ever reached" half is why a
  // candidate the client themselves rejected does not vanish from their list,
  // while one rejected internally beforehand never appears at all. The same
  // rule routes/candidates.js applies.
  const all = await prisma.application.findMany({
    where: onRequirements(where),
    select: {
      id: true, stage: true, updatedAt: true, createdAt: true, interviewAt: true,
      interviewStatus: true, requirementId: true,
      candidate: { select: { id: true, name: true, experienceYears: true, location: true, skills: true } },
    },
    orderBy: { updatedAt: 'desc' },
  });
  const everShared = new Set(all.filter((a) => CLIENT_SHARED_STAGES.includes(a.stage)).map((a) => a.id));
  const rest = all.filter((a) => !everShared.has(a.id)).map((a) => a.id);
  if (rest.length) {
    const events = await prisma.applicationStageEvent.findMany({
      where: { applicationId: { in: rest }, toStage: { in: CLIENT_SHARED_STAGES } },
      select: { applicationId: true },
    });
    events.forEach((e) => everShared.add(e.applicationId));
  }
  const shared = all.filter((a) => everShared.has(a.id));
  const byRequirement = new Map();
  shared.forEach((a) => byRequirement.set(a.requirementId, (byRequirement.get(a.requirementId) || 0) + 1));

  res.json({
    company: requirements.length && requirements[0].client ? requirements[0].client.name : null,
    requirements: requirements.map((r) => ({
      id: r.id,
      reqCode: r.reqCode,
      title: r.title,
      department: r.department,
      location: r.location,
      openings: r.openings,
      live: requirementIsLive(r.status),
      // A client is told WHETHER their requirement is published, which they
      // asked for. They are not shown the posting controls or the sync state:
      // that is internal work and it is not selected above.
      published: !!r.portalPublished,
      publishedAt: r.portalPublishedAt,
      sharedCandidates: byRequirement.get(r.id) || 0,
      raisedAt: r.createdAt,
    })),
    candidates: shared.map((a) => ({
      applicationId: a.id,
      candidateId: a.candidate.id,
      name: a.candidate.name,
      experienceYears: a.candidate.experienceYears,
      location: a.candidate.location,
      skills: a.candidate.skills,
      requirementId: a.requirementId,
      stage: a.stage,
      stageLabel: stageLabel(a.stage),
      interviewAt: a.interviewAt,
      interviewStatus: a.interviewStatus,
      sharedAt: a.createdAt,
      updatedAt: a.updatedAt,
    })),
    // Live statuses are named so the screen does not have to guess.
    liveStatuses: REQUIREMENT_LIVE_STATUSES,
    // What this client may DO, from the engine, so the buttons and the API
    // cannot disagree. `decide` is `requirements / Client Job Portal / edit`.
    permissions: { decide: await can(req.user, ...CLIENT_VIEW, 'edit') },
  });
}));

// The client's decision on a candidate shared with them: Shortlist, Reject or
// Request Interview. Guarded by `requirements / Client Job Portal / edit` —
// NOT by `candidates / Pipeline Stages / edit`, which is the internal
// recruiter's grant and would hand a client the whole pipeline.
//
// Three transitions, and only three. They are the ones
// routes/applications.js STAGE_OWNERS already names a CLIENT on, so this is
// the same workflow, reached through the client's own screen rather than a
// second rulebook. "Request Interview" changes no stage on purpose: a client
// asks for an interview, a recruiter schedules it. Recording it as
// INTERVIEW_SCHEDULED would put a booking in the calendar that nobody made.
const CLIENT_DECISIONS = {
  SHORTLIST: { stage: 'CLIENT_SHORTLISTED', action: 'Shortlisted by client' },
  REJECT: { stage: 'REJECTED', action: 'Rejected by client' },
  REQUEST_INTERVIEW: { stage: null, action: 'Interview requested by client' },
};

router.post('/client/applications/:id/decision', perm(CLIENT_VIEW, 'edit'), wrap(async (req, res) => {
  const decision = CLIENT_DECISIONS[String((req.body && req.body.decision) || '').toUpperCase()];
  if (!decision) {
    return res.status(400).json({ error: 'decision must be SHORTLIST, REJECT or REQUEST_INTERVIEW' });
  }

  // Scope first: applicationWhere() pins a client to their own company's
  // requirements, so Client B cannot name Client A's application id here.
  const application = await prisma.application.findFirst({
    where: { id: req.params.id, ...applicationWhere(req.user) },
    include: {
      candidate: { select: { name: true } },
      requirement: { select: { id: true, title: true, recruiterId: true, bdeId: true, tlId: true, stlId: true } },
    },
  });
  if (!application) return res.status(404).json({ error: 'Candidate not found, or outside your access scope' });

  // Reaching the requirement is not enough — the candidate must actually have
  // been SHARED with this client. A profile still at Recruiter Review has not
  // been put in front of them and is not theirs to decide on.
  let shared = CLIENT_SHARED_STAGES.includes(application.stage);
  if (!shared) {
    const ever = await prisma.applicationStageEvent.findFirst({
      where: { applicationId: application.id, toStage: { in: CLIENT_SHARED_STAGES } },
      select: { id: true },
    });
    shared = !!ever;
  }
  if (!shared) {
    return res.status(403).json({ error: 'This candidate has not been shared with you yet' });
  }

  const toStage = decision.stage || application.stage;
  if (decision.stage) {
    await prisma.application.update({ where: { id: application.id }, data: { stage: decision.stage } });
  }
  await prisma.applicationStageEvent.create({
    data: {
      applicationId: application.id,
      candidateId: application.candidateId,
      fromStage: application.stage,
      toStage,
      action: decision.action,
      comment: req.body && req.body.comment ? String(req.body.comment).slice(0, 2000) : null,
      actorUserId: req.user.id,
      actorName: req.user.name,
      actorRole: req.user.atsRole || req.user.role,
    },
  });
  // The recruiter, BDE and lead named on the requirement are told. Scheduling
  // stays theirs; the client asked, they act.
  await notifyUsers(
    [application.requirement.recruiterId, application.requirement.bdeId,
      application.requirement.tlId, application.requirement.stlId],
    {
      title: `${decision.action}: ${application.candidate.name}`,
      message: `${application.requirement.title} — ${application.candidate.name}. ${decision.action}.`,
      exceptUserId: req.user.id,
    },
  );
  await logAudit({
    userId: req.user.id, action: decision.action, entity: 'Application',
    entityId: application.id, fromValue: stageLabel(application.stage), toValue: stageLabel(toStage),
  });

  return res.json({ ok: true, id: application.id, stage: toStage, stageLabel: stageLabel(toStage), action: decision.action });
}));

module.exports = router;
