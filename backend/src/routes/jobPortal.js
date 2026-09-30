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

const bridge = require('../utils/jobPortalBridge');
// The Job Portal screening before the ATS (the actual workflow, 2026-09-29).
const {
  PRE_ATS_SOURCES, isPreAtsApplication, DUPLICATE_CHECK_ACTION, RESUME_SCORE_ACTION, SENT_TO_ATS_ACTION,
  stageLabelFor,
} = require('../utils/atsVocab');
const { screenEvents, screeningOf, findDuplicates } = require('../utils/preAtsScreening');
const { computeMatch } = require('../utils/matching');
const { hiringTypeOf } = require('../utils/joining');
const { applyStageMove } = require('./applications');
const { canMoveToStage } = require('../utils/permissions');
const { autoPost } = require('../utils/jobPosting');

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
    // Portal forms AND HR sourcing (internal openings) — both are screened here.
    { source: { in: PRE_ATS_SOURCES } },
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
    portalUrl: bridge.portalUrl(),
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
  // Out to the real Job Portal now (job-portal-app, utils/jobPortalBridge.js):
  // published -> an open job, unpublished -> closed there. A portal that is
  // down leaves the publish recorded here and the status Failed; Sync retries.
  const push = await bridge.pushRequirement(requirement.id);
  const fresh = await prisma.requirement.findUnique({ where: { id: requirement.id } });
  return res.json({
    ...jobRow({ ...fresh, client: null, _count: null }),
    portalUrl: push.ok && publish ? bridge.jobUrl(requirement.id) : null,
    portalError: push.ok ? null : push.error,
  });
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

  // THE REAL SYNC (replaces the SYNC SEAM note above): every published, live
  // requirement is pushed to the Job Portal and every other TeamLink job there
  // is closed; then the portal's applications are pulled in. The portal holds
  // one board for everybody, so the push is company-wide; the counts below
  // stay this user's scope.
  const portal = await bridge.fullSync({ actor: req.user.name });
  if (!portal.ok) {
    await prisma.requirement.updateMany({
      where: { id: { in: live.map((r) => r.id) } },
      data: { portalSyncStatus: 'Failed' },
    });
    const hint = /not reachable|did not answer/.test(portal.error || '')
      ? ' Start the TeamLink Job Portal (job-portal-app, port 4323) and press Sync again — nothing was lost; every published requirement is pushed on the next successful sync.'
      : (/SYNC_TOKEN|401|503/.test(portal.error || '') ? ' Check that JOB_PORTAL_SYNC_TOKEN matches in backend/.env and the portal .env.' : '');
    return res.status(502).json({ error: `Job Portal sync failed: ${portal.error}.${hint}` });
  }

  // fullSync() has already set Synced / Failed on every live requirement FROM
  // THE PORTAL'S OWN ANSWER. It used to be overwritten here with "Synced" for
  // all of them, which hid a job the portal had refused. Read it back instead.
  const after = live.length ? await prisma.requirement.findMany({
    where: { id: { in: live.map((r) => r.id) } },
    select: { id: true, portalSyncStatus: true },
  }) : [];
  const syncedCount = after.filter((r) => r.portalSyncStatus === 'Synced').length;
  const failedCount = after.length - syncedCount;
  // A published requirement that is no longer live cannot be on offer: take
  // it down everywhere (it is closed on the portal by the sync already).
  for (const r of stale) {
    // eslint-disable-next-line no-await-in-loop
    await autoPost(r.id, { actorId: req.user.id, actorName: req.user.name, trigger: 'edit' });
  }

  const applications = await prisma.application.count({
    where: { ...PORTAL_APPLICATION_FILTER, ...onRequirements(portalRequirementWhere(req.user)) },
  });

  await prisma.syncLog.create({
    data: {
      entity: 'Requirements',
      status: failedCount ? 'Failed' : 'Success',
      reason: `${req.user.name}: ${syncedCount} published requirement(s) Synced, ${failedCount} refused by the portal, `
        + `${stale.length} no longer live (taken down), ${applications} portal application(s) in scope. `
        + `Pushed to the Job Portal: ${portal.jobs} live, ${portal.closed} closed; ${portal.created} new portal application(s) pulled.`,
    },
  });
  await logAudit({
    userId: req.user.id, action: 'Job portal sync (scoped)', entity: 'Requirement',
    toValue: `${syncedCount} synced / ${failedCount} failed / ${stale.length} taken down`,
  });

  return res.json({
    ok: true,
    synced: syncedCount,
    failed: failedCount,
    takenDown: stale.length,
    applications,
    closedOnPortal: portal.closed,
    pulled: portal.pulled,
    newApplications: portal.created,
    stageUpdates: portal.stageUpdates || 0,
    problems: portal.errors || [],
    note: `Synced with the TeamLink Job Portal: ${portal.jobs} job(s) live there, ${portal.closed} closed, ${portal.created} new application(s) brought in, ${portal.stageUpdates || 0} status update(s) sent back.`
      + ((portal.errors || []).length ? ` ${portal.errors.length} problem(s) — see Last sync / errors.` : ''),
  });
}));

// ---------------------------------------------------------------------------
// LAST SYNC / ERRORS (user notes #10). What the last sync did, whether the
// portal is answering right now, which of this user's published requirements
// failed to reach it and why, and the recent sync problems — each with a
// Retry. The log is company-wide; a push failure is shown only for a
// requirement in this user's scope.
// ---------------------------------------------------------------------------
router.get('/sync-status', perm(WORKSPACE, 'view'), wrap(async (req, res) => {
  const where = portalRequirementWhere(req.user);
  const since = new Date(Date.now() - 7 * 86400000);
  const [ping, lastSync, lastOk, failedJobs, logs, canRetry, canSync] = await Promise.all([
    bridge.ping(),
    prisma.syncLog.findFirst({ where: { reason: { startsWith: 'Job Portal sync' } }, orderBy: { createdAt: 'desc' } }),
    prisma.syncLog.findFirst({ where: { reason: { startsWith: 'Job Portal sync' }, status: 'Success' }, orderBy: { createdAt: 'desc' } }),
    prisma.requirement.findMany({
      where: { AND: [where, { portalPublished: true, portalSyncStatus: { in: ['Failed', 'Pending'] } }] },
      select: { id: true, reqCode: true, title: true, status: true, portalSyncStatus: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    }),
    prisma.syncLog.findMany({
      where: {
        status: 'Failed', createdAt: { gte: since },
        OR: [{ reason: { startsWith: 'Job Portal' } }, { entity: 'Applications' }],
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
    can(req.user, ...WORKSPACE, 'edit'),
    can(req.user, ...WORKSPACE, 'configure'),
  ]);
  const inScope = new Set(failedJobs.map((r) => r.id));
  const scopeIds = logs.filter((l) => l.recordRef && /^Job Portal push failed/.test(l.reason || '')).map((l) => l.recordRef);
  const visibleReq = scopeIds.length
    ? new Set((await prisma.requirement.findMany({ where: { AND: [where, { id: { in: [...new Set(scopeIds)] } }] }, select: { id: true } })).map((r) => r.id))
    : new Set();
  // Consecutive repeats of the same message (a portal down across restarts)
  // collapse into one line with a count.
  const errors = [];
  logs.forEach((l) => {
    const isPush = /^Job Portal push failed/.test(l.reason || '');
    if (isPush && !visibleReq.has(l.recordRef)) return;
    if (!isPush && l.entity === 'Applications' && !/Job Portal/.test(l.reason || '')) return;
    const key = [l.entity, (l.reason || '').replace(/\(([^)]*)\)/, ''), l.recordRef || ''].join('|');
    const prev = errors[errors.length - 1];
    if (prev && prev.key === key) { prev.count += 1; prev.firstAt = l.createdAt; return; }
    errors.push({ key, id: l.id, entity: l.entity, reason: l.reason, recordRef: l.recordRef, at: l.createdAt, firstAt: l.createdAt, count: 1 });
  });
  const lastFailure = new Map();
  logs.filter((l) => /^Job Portal push failed/.test(l.reason || '')).forEach((l) => {
    if (!lastFailure.has(l.recordRef)) lastFailure.set(l.recordRef, l);
  });
  res.json({
    configured: bridge.status().configured,
    portalUrl: bridge.portalUrl(),
    reachable: ping.ok,
    reachability: ping.result,
    lastSync: lastSync ? { at: lastSync.createdAt, status: lastSync.status, summary: lastSync.reason } : null,
    lastSuccess: lastOk ? { at: lastOk.createdAt, summary: lastOk.reason } : null,
    failedJobs: failedJobs.map((r) => ({
      id: r.id, reqCode: r.reqCode, title: r.title, status: r.portalSyncStatus,
      reason: lastFailure.has(r.id) ? lastFailure.get(r.id).reason.replace(/^Job Portal push failed:s*/, '') : null,
      at: lastFailure.has(r.id) ? lastFailure.get(r.id).createdAt : r.updatedAt,
      inScope: inScope.has(r.id),
    })),
    errors: errors.slice(0, 20).map(({ key, ...e }) => e),
    permissions: { retry: canRetry, sync: canSync },
  });
}));

// Retry ONE requirement's posting now (the "Retry" beside a failed job).
// Same guard as Publish: `edit` on the workspace plus the assignment chain.
router.post('/jobs/:id/push', perm(WORKSPACE, 'edit'), wrap(async (req, res) => {
  const requirement = await prisma.requirement.findUnique({ where: { id: req.params.id } });
  if (!requirement) return res.status(404).json({ error: 'Requirement not found' });
  if (!matches(requirement, requirementWhere(req.user))) return res.status(403).json(OUT_OF_SCOPE);
  if (!mayActOnRecord(req.user, requirement)) {
    return res.status(403).json({ error: 'You can see this requirement, but you are not on its assignment chain' });
  }
  if (!requirementIsLive(requirement.status)) {
    return res.status(400).json({ error: `"${requirement.title}" is ${requirementStatusLabel(requirement.status)} — only a live requirement is posted.` });
  }
  const out = await autoPost(requirement.id, { actorId: req.user.id, actorName: req.user.name, trigger: 'retry' });
  const fresh = await prisma.requirement.findUnique({ where: { id: requirement.id } });
  const push = out.push || {};
  if (push.ok === false) {
    return res.status(502).json({ error: `${requirement.reqCode || requirement.title} could not be posted to the Job Portal: ${push.error}`, portalSyncStatus: fresh.portalSyncStatus });
  }
  return res.json({ ok: true, portalSyncStatus: fresh.portalSyncStatus, url: bridge.jobUrl(requirement.id) });
}));

// The applications arriving from the portal, scoped. A Medical recruiter gets
// Medical applications; an IT recruiter gets IT ones. Same requirementWhere()
// that scopes every other requirement list.
const PORTAL_TABS = ['new', 'resume_reviewed', 'ai_pending', 'ai_completed', 'ready', 'sent', 'rejected', 'hold'];
// Which Job Portal sub-tab one application sits in (utils/preAtsScreening.js
// screeningOf() decides the steps; this only names the tab).
function portalTabOf(r) {
  const sc = r.screening || {};
  if (r.imported || !sc.preAts) return 'sent';
  if (r.stage === 'REJECTED') return 'rejected';
  if (r.stage === 'HOLD') return 'hold';
  if (['RECRUITER_REVIEW', 'RECRUITER_APPROVED'].includes(r.stage)) return 'ready';
  if (r.stage === 'AI_INTERVIEW_COMPLETED' || sc.aiInterviewStatus === 'Manual Review Requested') return 'ai_completed';
  if (r.stage === 'AI_INTERVIEW_SCHEDULED') return 'ai_pending';
  if (sc.resumeScored) return 'resume_reviewed';
  return 'new';
}
router.get('/applications', perm(APPLICATIONS, 'view'), wrap(async (req, res) => {
  const apps = await prisma.application.findMany({
    where: { ...PORTAL_APPLICATION_FILTER, ...applicationWhere(req.user) },
    include: {
      candidate: { select: { id: true, name: true, email: true, phone: true, source: true, skills: true } },
      requirement: { select: { id: true, reqCode: true, title: true, department: true, portalPublished: true, internal: true, hiringType: true, recruiterId: true, recruiterIds: true, tlId: true, stlId: true, bdeId: true, clientId: true, client: { select: { name: true } } } },
    },
    orderBy: { createdAt: 'desc' },
  });
  const importable = await can(req.user, ...APPLICATIONS, 'create');
  const events = await screenEvents(apps.filter(isPreAtsApplication).map((a) => a.id));
  const screenOwner = !(await canMoveToStage(req.user, 'RECRUITER_REVIEW'));
  const rows = apps.map((a) => ({
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
      // The screening before the ATS, and whether this login may work it.
      hiring: hiringTypeOf(a, a.requirement) === 'TeamLink Internal Hire' ? 'Internal' : 'Client',
      stageLabelWorkflow: stageLabelFor(a.stage, { internal: hiringTypeOf(a, a.requirement) === 'TeamLink Internal Hire' }),
      screening: screeningOf(a, events),
      mayScreen: importable && screenOwner && mayScreen(req.user, a.requirement),
    }));
  // Candidates & Pipeline → Job Portal sub-tabs (user spec 2026-09-29): All
  // Applications · New · Resume Reviewed · AI Interview Pending · AI Interview
  // Completed · Ready for Recruiter Review · Sent to ATS · Rejected.
  rows.forEach((r) => {
    r.portalTab = portalTabOf(r);
    r.aiScore = r.screening ? r.screening.aiInterviewScore : null;
    r.resumeScore = r.screening ? r.screening.resumeScore : null;
  });
  const counts = { all: rows.length };
  PORTAL_TABS.forEach((t) => { counts[t] = rows.filter((r) => r.portalTab === t).length; });
  res.json({
    applications: rows,
    counts,
    permissions: { import: importable, screen: importable && screenOwner },
  });
}));

// ---------------------------------------------------------------------------
// THE JOB PORTAL SCREENING (the actual workflow, 2026-09-29) — the steps
// BEFORE the ATS, on the application a portal form (or HR sourcing) created:
//
//   POST /applications/:id/duplicate-check   Duplicate Check
//   POST /applications/:id/score             Resume Parsing / Score
//   POST /applications/:id/ai-interview      AI Interview: { action: 'send' }
//                                            then { action: 'result', score,
//                                            feedback } (or 'manual')
//   POST /applications/:id/review            AI Interview Score -> Recruiter Review
//   POST /applications/:id/send-to-ats       SEND TO ATS (the recruiter / HR)
//   POST /applications/:id/import            the old name of send-to-ats
//
// Who: `requirements / Job Portal Applications / create` (the working roles,
// and HR for internal openings), inside utils/scope.js, and on the
// requirement's assignment chain unless global — HR on any INTERNAL
// requirement. Every stage move goes through routes/applications.js
// applyStageMove(), so the event / audit / notification trail is the same one
// every other move writes. Rules in utils/preAtsScreening.js.
// ---------------------------------------------------------------------------
function mayScreen(user, requirement) {
  const s = scopeOf(user);
  return s.global || isAssignedTo(user, requirement) || (s.atsRole === 'HR' && !!requirement && !!requirement.internal);
}

async function loadScreenable(req, res, { preAtsOnly = true } = {}) {
  const application = await prisma.application.findFirst({
    where: { id: req.params.id, ...applicationWhere(req.user) },
    include: { requirement: { include: { client: true } }, candidate: true },
  });
  if (!application) { res.status(404).json({ error: 'Application not found, or outside your access scope' }); return null; }
  if (!mayScreen(req.user, application.requirement)) {
    res.status(403).json({ error: 'You can see this application, but you are not on its requirement’s assignment chain' });
    return null;
  }
  // Screening is the recruiter's work (HR's for an internal opening) — the
  // same owners as Recruiter Review (utils/permissions.js STAGE_OWNERS), so a
  // BDE or a client cannot run it.
  const refusal = await canMoveToStage(req.user, 'RECRUITER_REVIEW');
  if (refusal) { res.status(refusal.status).json(refusal.body); return null; }
  if (preAtsOnly && !isPreAtsApplication(application)) {
    res.status(409).json({
      error: application.portalImportedAt
        ? 'This application has already been sent to the ATS.'
        : 'This application did not come in through the Job Portal / HR sourcing, so it has no screening step.',
    });
    return null;
  }
  return application;
}

async function screenEvent(user, application, action, comment) {
  const r = application.requirement;
  await prisma.applicationStageEvent.create({
    data: {
      applicationId: application.id,
      candidateId: application.candidateId,
      fromStage: application.stage,
      toStage: application.stage,
      action,
      comment: comment ? String(comment).slice(0, 2000) : null,
      actorUserId: user.id,
      actorName: user.name,
      actorRole: user.atsRole || user.role,
      requirementId: application.requirementId,
      requirementTitle: r ? r.title : null,
      clientId: r ? r.clientId : null,
      clientName: r && r.internal ? 'TeamLink Internal' : (r && r.client && r.client.name) || null,
    },
  });
}

async function screeningReply(id) {
  const app = await prisma.application.findUnique({ where: { id } });
  const events = await screenEvents([id]);
  return { id, stage: app.stage, stageLabel: stageLabel(app.stage), screening: screeningOf(app, events) };
}

// Duplicate Check. Records the result; merges nothing.
router.post('/applications/:id/duplicate-check', perm(APPLICATIONS, 'create'), wrap(async (req, res) => {
  const application = await loadScreenable(req, res);
  if (!application) return null;
  const found = await findDuplicates(application.candidate);
  const n = found.strong.length;
  const result = n ? `${n} possible duplicate${n > 1 ? 's' : ''} on file` : 'clear';
  const detail = [
    ...found.strong.map((d) => `${d.name} (${d.reasons.join(', ')})`),
    ...found.possible.slice(0, 5).map((d) => `${d.name} (same name only)`),
  ].join('; ');
  await screenEvent(req.user, application, `${DUPLICATE_CHECK_ACTION} — ${result}`, detail || null);
  await logAudit({
    userId: req.user.id, action: 'Job Portal duplicate check', entity: 'Application',
    entityId: application.id, toValue: result,
  });
  return res.json({ ...(await screeningReply(application.id)), duplicates: found });
}));

// Resume Parsing / Score — the existing matcher against this requirement.
router.post('/applications/:id/score', perm(APPLICATIONS, 'create'), wrap(async (req, res) => {
  const application = await loadScreenable(req, res);
  if (!application) return null;
  const events = await screenEvents([application.id]);
  if (!screeningOf(application, events).duplicateChecked) {
    return res.status(409).json({ error: 'Run the duplicate check first.' });
  }
  const match = computeMatch(application.candidate, application.requirement);
  const resumeScore = application.candidate.resumeScore != null ? application.candidate.resumeScore : match.overall;
  await prisma.application.update({
    where: { id: application.id },
    data: { matchScore: match.overall, resumeScore },
  });
  await screenEvent(req.user, application, `${RESUME_SCORE_ACTION} — ${resumeScore}% (match ${match.overall}%)`, null);
  await logAudit({
    userId: req.user.id, action: 'Job Portal resume scored', entity: 'Application',
    entityId: application.id, toValue: `${resumeScore}%`,
  });
  return res.json(await screeningReply(application.id));
}));

// AI Interview -> AI Interview Score. The AI result lives in the aiInterview*
// columns only — it is never written into client interview feedback.
router.post('/applications/:id/ai-interview', perm(APPLICATIONS, 'create'), wrap(async (req, res) => {
  const application = await loadScreenable(req, res);
  if (!application) return null;
  const action = String((req.body && req.body.action) || '');
  const events = await screenEvents([application.id]);
  const st = screeningOf(application, events);
  if (action === 'send') {
    if (!st.duplicateChecked || !st.resumeScored) {
      return res.status(409).json({ error: 'Duplicate check and resume score come before the AI interview.' });
    }
    if (!['NEW', 'AI_INTERVIEW_REQUIRED'].includes(application.stage)) {
      return res.status(409).json({ error: `The AI interview is already ${stageLabel(application.stage)}.` });
    }
    const out = await applyStageMove(req.user, application.id, { stage: 'AI_INTERVIEW_SCHEDULED', comment: 'AI interview invite sent (Job Portal screening)' });
    if (out.status !== 200) return res.status(out.status).json(out.body);
    return res.json(await screeningReply(application.id));
  }
  if (action === 'result' || action === 'manual') {
    if (!['AI_INTERVIEW_REQUIRED', 'AI_INTERVIEW_SCHEDULED'].includes(application.stage)) {
      return res.status(409).json({ error: 'Send the AI interview first.' });
    }
    let score = null;
    if (action === 'result') {
      score = Number(req.body.score);
      if (req.body.score === '' || req.body.score == null || !Number.isFinite(score) || score < 0 || score > 100) {
        return res.status(400).json({ error: 'The AI interview score must be 0–100.' });
      }
      score = Math.round(score);
    }
    const out = await applyStageMove(req.user, application.id, {
      stage: 'AI_INTERVIEW_COMPLETED',
      comment: action === 'result' ? `AI interview score ${score}%` : 'Manual review requested instead of an AI score',
    });
    if (out.status !== 200) return res.status(out.status).json(out.body);
    await prisma.application.update({
      where: { id: application.id },
      data: action === 'result'
        ? { aiInterviewStatus: 'Completed', aiInterviewScore: score, aiInterviewFeedback: req.body.feedback ? String(req.body.feedback).slice(0, 4000) : null }
        : { aiInterviewStatus: 'Manual Review Requested' },
    });
    return res.json(await screeningReply(application.id));
  }
  return res.status(400).json({ error: "action must be 'send', 'result' or 'manual'" });
}));

// AI Interview Score -> Recruiter Review (still before the ATS).
router.post('/applications/:id/review', perm(APPLICATIONS, 'create'), wrap(async (req, res) => {
  const application = await loadScreenable(req, res);
  if (!application) return null;
  if (application.stage !== 'AI_INTERVIEW_COMPLETED') {
    return res.status(409).json({ error: `Recruiter review follows the AI interview score — this candidate is at ${stageLabel(application.stage)}.` });
  }
  const out = await applyStageMove(req.user, application.id, { stage: 'RECRUITER_REVIEW', comment: (req.body && req.body.comment) || 'Recruiter review (Job Portal screening)' });
  if (out.status !== 200) return res.status(out.status).json(out.body);
  return res.json(await screeningReply(application.id));
}));

// SEND TO ATS — the recruiter's (HR's, for an internal opening) explicit act.
// Client requirement -> the ATS at Recruiter Review; internal -> HR Review
// (the same RECRUITER_REVIEW code, read as "HR Review" on an internal hire).
async function sendToAts(req, res) {
  const application = await loadScreenable(req, res);
  if (!application) return null;
  const events = await screenEvents([application.id]);
  const st = screeningOf(application, events);
  if (!st.readyToSend) {
    return res.status(409).json({ error: `Not ready to send to the ATS: ${st.blockers.join('; ')}.`, blockers: st.blockers });
  }
  const internal = hiringTypeOf(application, application.requirement) === 'TeamLink Internal Hire';
  const lands = internal ? 'HR Review' : 'Recruiter Review';
  const source = application.source || application.candidate.source;
  await prisma.application.update({
    where: { id: application.id },
    data: {
      portalImportedAt: new Date(),
      portalImportedBy: req.user.id,
      stage: 'RECRUITER_REVIEW',
      hiringType: hiringTypeOf(application, application.requirement),
      source,
      firstSource: application.firstSource || source,
    },
  });
  const aiText = st.aiInterviewScore != null ? `${st.aiInterviewScore}%` : st.aiInterviewStatus;
  await screenEvent(req.user, { ...application, stage: 'RECRUITER_REVIEW' }, `${SENT_TO_ATS_ACTION} — ${lands}`,
    (req.body && req.body.comment) || `From ${source}. Duplicate check: ${st.duplicateResult}; resume ${st.resumeScore != null ? `${st.resumeScore}%` : '—'}; AI ${aiText}.`);
  await logAudit({
    userId: req.user.id, action: 'Job Portal application sent to ATS', entity: 'Application',
    entityId: application.id, fromValue: 'Job Portal screening', toValue: lands,
  });
  // Who picks it up: the requirement's recruiter / TL, and for an internal
  // opening the HR desk (HR runs internal hiring).
  const r = application.requirement;
  const hr = internal
    ? (await prisma.user.findMany({ where: { status: 'Active', atsRole: 'HR' }, select: { id: true } })).map((u) => u.id)
    : [];
  await notifyUsers([r.recruiterId, r.tlId, ...hr], {
    title: `${application.candidate.name} sent to the ATS`,
    message: `${lands} pending · ${r.title}${internal ? ' — TeamLink Internal' : ''}`,
    exceptUserId: req.user.id,
  });
  const fresh = await prisma.application.findUnique({ where: { id: application.id } });
  return res.json({
    ok: true, id: fresh.id, stage: fresh.stage, stageLabel: lands, hiring: internal ? 'Internal' : 'Client',
    sentToAtsAt: fresh.portalImportedAt,
  });
}
router.post('/applications/:id/send-to-ats', perm(APPLICATIONS, 'create'), wrap(sendToAts));

// IMPORT TO ATS — the older name of SEND TO ATS, kept so existing links and
// scripts keep working. It now runs the same gate: an application reaches the
// ATS only after the Job Portal screening (see above).
router.post('/applications/:id/import', perm(APPLICATIONS, 'create'), wrap(sendToAts));

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
  // HOLD is the client saying 'not yet' — recorded (with their note) and the
  // team is told, but NO stage moves: STAGE_OWNERS.HOLD does not name a
  // client, and the profile stays in their review. (Client portal, notes #4.)
  HOLD: { stage: null, action: 'Put on hold by client' },
};

router.post('/client/applications/:id/decision', perm(CLIENT_VIEW, 'edit'), wrap(async (req, res) => {
  const decision = CLIENT_DECISIONS[String((req.body && req.body.decision) || '').toUpperCase()];
  if (!decision) {
    return res.status(400).json({ error: 'decision must be SHORTLIST, HOLD, REJECT or REQUEST_INTERVIEW' });
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

  // A CLIENT'S REJECTION SAYS WHY. It used to record neither a reason nor a
  // side, so the one rejection that is unambiguously the client's own came out
  // as nobody's, with no explanation — the least useful record possible for
  // the recruiter who has to find this candidate another role.
  const reasonCategory = String((req.body && req.body.reasonCategory) || '').trim() || null;
  const reasonDetail = String((req.body && req.body.reasonDetail) || '').trim() || null;
  if (decision.stage === 'REJECTED' && !reasonCategory && !reasonDetail) {
    return res.status(400).json({ error: 'Tell us why you are rejecting this candidate.' });
  }
  if (decision.action === CLIENT_DECISIONS.HOLD.action && !['SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'CLIENT_SHORTLISTED'].includes(application.stage)) {
    return res.status(409).json({ error: `This candidate is already at ${stageLabel(application.stage)} — Hold applies only while they are in your review.` });
  }
  // Shortlisting is a Client Review decision. A candidate already past it
  // (interviewing, selected, joined) or closed out is not pulled backwards.
  if (decision.stage === 'CLIENT_SHORTLISTED' && !['SHARED_WITH_CLIENT', 'CLIENT_REVIEW'].includes(application.stage)) {
    return res.status(409).json({ error: `This candidate is already at ${stageLabel(application.stage)} — shortlisting applies only while they are in Client Review.` });
  }
  if (decision.stage === 'REJECTED' && ['JOINED', 'HIRED', 'REJECTED'].includes(application.stage)) {
    return res.status(409).json({ error: `This candidate is already ${stageLabel(application.stage)}.` });
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
      // This screen is the client's own portal, so the decision is the
      // client's by definition.
      actorSide: 'Client',
      reasonCategory: decision.stage === 'REJECTED' ? reasonCategory : null,
      reasonDetail: decision.stage === 'REJECTED' ? reasonDetail : null,
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
