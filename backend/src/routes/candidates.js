const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm, requireProduct } = require('../middleware/auth');
const {
  requirementWhere, matches, scopeOf, OUT_OF_SCOPE, CLIENT_SHARED_STAGES,
} = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const { computeMatch } = require('../utils/matching');
const {
  applicationOwner, applicationNextAction, applicationDueDate, applicationIsOverdue,
  applicationLifeStatus, stageLabel, interviewStatusLabel, REQUIREMENT_LIVE_STATUSES,
} = require('../utils/atsVocab');
const {
  CANDIDATE_VIEWS, groupIdOfStage, groupLabelOfStage, stageDetail,
  stageIndex, matchesView, groupsWithDetail,
} = require('../utils/pipelineView');
const { TEMPLATES, NOT_SENT_DETAIL } = require('../utils/candidateComms');

const router = express.Router();
router.use(requireAuth);
// The whole router belongs to ATS: a login without ATS access, or without
// view permission on this module, is refused at the door rather than handed
// an empty list.
router.use(requireProduct('ats'));
router.use(requirePerm('ats', 'candidates', 'Candidate List', 'view'));

// ---------------------------------------------------------------------------
// VIEW ≠ EDIT, and INTERNAL ≠ SHARED.
//
// Two different things are enforced here and they are kept apart deliberately:
//
//   * SCOPE — WHICH candidate records a login reaches at all. That is
//     utils/scope.js: a recruiter their own, a TL their department's, a BDE
//     their clients', a client only people shared with that client, a
//     candidate only themselves. Enforced below on both the list and the
//     record, server-side. A hidden button is not access control.
//
//   * FIELD VISIBILITY — WHAT of a record a login is served. A client reaching
//     a candidate legitimately (they were shared) must still never receive
//     internal recruiter notes, the internal AI evaluation detail, or any
//     fee / salary internals. That is redactFor() below, and it runs on the
//     way out of every endpoint in this file — the field is absent from the
//     JSON, not merely hidden by the browser.
// ---------------------------------------------------------------------------
function viewerKind(user) {
  const s = scopeOf(user);
  if (s.role === 'CANDIDATE') return 'candidate';
  if (s.role === 'CLIENT') return 'client';
  return 'internal';
}
const isInternalViewer = (user) => viewerKind(user) === 'internal';

// Salary / fee internals. A client is paying a percentage of the candidate's
// CTC; what the candidate currently earns and what they asked for is our
// commercial position, not theirs.
const SALARY_FIELDS = ['currentSalary', 'expectedSalary'];
// Internal scoring. A client sees the person, not our machine's opinion of them.
const SCORE_FIELDS = ['resumeScore'];
const APPLICATION_SCORE_FIELDS = ['matchScore', 'resumeScore', 'aiInterviewScore', 'aiInterviewFeedback', 'offeredCtc'];

function redactCandidateFields(candidate, kind) {
  if (kind !== 'client') return candidate;
  const out = { ...candidate };
  [...SALARY_FIELDS, ...SCORE_FIELDS].forEach((f) => { delete out[f]; });
  return out;
}

function redactApplication(application, kind) {
  if (kind !== 'client') return application;
  const out = { ...application };
  APPLICATION_SCORE_FIELDS.forEach((f) => { delete out[f]; });
  return out;
}

// A candidate is reachable only through an application on a requirement the
// signed-in user's scope already covers — so a Medical recruiter never sees an
// IT candidate, and one client never sees another client's shortlist. Computed
// once here from utils/scope.js and applied to both the list and the record.
//
// `sharedIds` is the second gate, and it applies only to a CLIENT login:
// reaching the client's requirement is not enough, the profile must actually
// have been SHARED with them (utils/scope.js CLIENT_SHARED_STAGES). Without
// it a client would see everyone a recruiter was still screening for their
// role. `null` means the gate does not apply to this viewer.
function visibleApplications(user, applications, sharedIds = null) {
  const s = scopeOf(user);
  if (s.global) return applications;
  // A candidate sees only their OWN applications — never another candidate's,
  // even on a record they somehow reached.
  if (s.role === 'CANDIDATE') {
    return (applications || []).filter((a) => a.candidateId === s.candidateId);
  }
  const where = requirementWhere(user);
  const inScope = (applications || []).filter((a) => a.requirement && matches(a.requirement, where));
  if (!sharedIds) return inScope;
  return inScope.filter((a) => sharedIds.has(a.id));
}

// Which of these applications a CLIENT login has actually been shown. An
// application counts as shared if it is at a shared stage now, OR if it ever
// reached one (Pipeline History) — so a candidate the client themselves
// rejected stays visible to them, while one rejected internally before ever
// being shared never becomes visible.
async function clientSharedApplicationIds(user, candidates) {
  if (viewerKind(user) !== 'client') return null;
  const apps = candidates.flatMap((c) => c.applications || []);
  const shared = new Set(apps.filter((a) => CLIENT_SHARED_STAGES.includes(a.stage)).map((a) => a.id));
  const ids = apps.map((a) => a.id);
  if (ids.length) {
    const events = await prisma.applicationStageEvent.findMany({
      where: { applicationId: { in: ids }, toStage: { in: CLIENT_SHARED_STAGES } },
      select: { applicationId: true },
    });
    events.forEach((e) => shared.add(e.applicationId));
  }
  return shared;
}

// Candidates already on file with the same email or phone. Mirrors the
// prototype's checkCandidateDuplicate() — used both by the Add Candidate form
// (to warn while typing) and by POST / below (to block a silent double-entry).
async function findDuplicates({ email, phone, excludeId }) {
  const or = [];
  if (email) or.push({ email });
  if (phone) or.push({ phone });
  if (or.length === 0) return [];
  return prisma.candidate.findMany({
    where: { OR: or, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
    orderBy: { createdAt: 'desc' },
  });
}

// The candidate list shows, per candidate, the state of their most recent
// application. The visible columns are Candidate | Requirement | Client |
// Stage | Owner | Next Action | Due | Status — Owner is a first-class column,
// not something buried on the detail page. Owner / Next Action / Due are
// derived from the stage so they can never drift.
function decorate(candidate, { user, sharedIds = null } = {}) {
  const kind = user ? viewerKind(user) : 'internal';
  const applications = user
    ? visibleApplications(user, candidate.applications, sharedIds)
    : (candidate.applications || []);
  const base = redactCandidateFields(candidate, kind);

  // candidateStageOf(): the most recent application decides the current stage.
  const latest = [...applications].sort((a, b) => String(b.id).localeCompare(String(a.id)))[0] || null;
  const shaped = applications.map((a) => redactApplication(a, kind));
  if (!latest) {
    return {
      ...base,
      applications: shaped,
      currentStage: null,
      currentStageLabel: 'No application',
      stageGroup: null,
      stageGroupLabel: '—',
      stageDetailLabel: null,
      requirementTitle: null,
      requirementId: null,
      clientName: null,
      clientId: null,
    };
  }
  const requirement = latest.requirement || null;
  const client = requirement ? requirement.client : null;
  return {
    ...base,
    applications: shaped,
    currentStage: latest.stage,
    currentStageLabel: stageLabel(latest.stage),
    // The VISIBLE stage — one of the ten groups. The precise status inside it
    // travels alongside as stageDetailLabel; nothing is lost, it is folded.
    stageGroup: groupIdOfStage(latest.stage),
    stageGroupLabel: groupLabelOfStage(latest.stage),
    stageDetailLabel: stageDetail(latest),
    requirementId: latest.requirementId,
    requirementTitle: requirement ? requirement.title : null,
    requirementDepartment: requirement ? requirement.department : null,
    clientId: requirement ? requirement.clientId : null,
    clientName: requirement ? (requirement.internal ? 'TeamLink Internal' : (client && client.name) || null) : null,
    recruiterName: requirement && requirement.recruiter ? requirement.recruiter.name : null,
    bdeName: requirement && requirement.bde ? requirement.bde.name : null,
    tlName: requirement ? requirement.tl || null : null,
    appliedDate: latest.createdAt,
    owner: applicationOwner(latest, requirement),
    nextAction: applicationNextAction(latest),
    dueDate: applicationDueDate(latest),
    overdue: applicationIsOverdue(latest),
    ...(kind === 'client' ? {} : { matchScore: latest.matchScore ?? latest.resumeScore ?? null }),
    lifeStatus: applicationLifeStatus(latest),
    aiInterviewStatus: latest.aiInterviewStatus || 'Required',
    latestApplicationId: latest.id,
  };
}

// Every candidate this login may reach, already scoped. Shared by the list and
// by source analytics so the two can never disagree.
async function scopedCandidates(user) {
  const all = await prisma.candidate.findMany({
    include: { applications: { include: { requirement: { include: { client: true, recruiter: true, bde: true } } } } },
    orderBy: { createdAt: 'desc' },
  });
  const sharedIds = await clientSharedApplicationIds(user, all);
  const s = scopeOf(user);
  if (s.global) return { candidates: all, sharedIds };
  if (s.role === 'CANDIDATE') {
    return { candidates: all.filter((c) => c.id === s.candidateId), sharedIds };
  }
  return {
    candidates: all.filter((c) => visibleApplications(user, c.applications, sharedIds).length > 0),
    sharedIds,
  };
}

router.get('/', async (req, res) => {
  // Nobody browses the whole candidate master except a global role. A client
  // sees only people SHARED with them on their own requirements; a recruiter
  // only people on requirements assigned to them; a TL only their department's.
  const { candidates, sharedIds } = await scopedCandidates(req.user);
  let rows = candidates.map((c) => decorate(c, { user: req.user, sharedIds }));
  // Hold and Rejected are VIEWS over this same list, not separate modules —
  // so the server offers them as a query parameter on the one endpoint.
  if (req.query.view && req.query.view !== 'all') {
    rows = rows.filter((r) => matchesView(req.query.view, r.currentStage));
  }
  if (req.query.stageGroup) {
    rows = rows.filter((r) => r.stageGroup === req.query.stageGroup);
  }
  return res.json(rows);
});

// The visible pipeline and the views, served from the same definition the
// server filters with, so the screen cannot drift from the rules.
router.get('/pipeline-view', (req, res) => {
  res.json({ groups: groupsWithDetail(), views: CANDIDATE_VIEWS });
});

// Must stay above /:id so "check-duplicate" isn't read as a candidate id.
router.get('/check-duplicate', async (req, res) => {
  const email = (req.query.email || '').trim();
  const phone = (req.query.phone || '').trim();
  const found = await findDuplicates({ email, phone, excludeId: req.query.excludeId });
  res.json({
    duplicate: found.length > 0,
    matches: found.map((m) => ({ id: m.id, name: m.name, email: m.email, phone: m.phone, source: m.source })),
  });
});

// ---------------------------------------------------------------------------
// Source analytics.
//
// Per source: Total, Screened, Shortlisted, Client Shared, Interviewed,
// Selected, Rejected, Joined. Counted per CANDIDATE (not per application) on
// the furthest point they ever reached, which is why it needs the pipeline
// history and not just the current stage: someone sitting at Rejected today
// was still screened and still shared with a client.
// ---------------------------------------------------------------------------
const REACH_COLUMNS = [
  { key: 'screened', label: 'Screened', stage: 'RECRUITER_REVIEW' },
  { key: 'shortlisted', label: 'Shortlisted', stage: 'RECRUITER_APPROVED' },
  { key: 'clientShared', label: 'Client Shared', stage: 'SHARED_WITH_CLIENT' },
  { key: 'interviewed', label: 'Interviewed', stage: 'INTERVIEW_SCHEDULED' },
  { key: 'selected', label: 'Selected', stage: 'SELECTED' },
  { key: 'joined', label: 'Joined', stage: 'JOINED' },
];

router.get('/source-analytics', async (req, res) => {
  const { candidates, sharedIds } = await scopedCandidates(req.user);
  const ids = candidates.flatMap((c) => (c.applications || []).map((a) => a.id));
  const events = ids.length
    ? await prisma.applicationStageEvent.findMany({ where: { applicationId: { in: ids } } })
    : [];
  const reachedByApp = new Map();
  events.forEach((e) => {
    const best = Math.max(reachedByApp.get(e.applicationId) ?? -1, stageIndex(e.toStage));
    reachedByApp.set(e.applicationId, best);
  });

  const by = new Map();
  const bucket = (name) => {
    if (!by.has(name)) {
      by.set(name, {
        source: name, total: 0, screened: 0, shortlisted: 0, clientShared: 0,
        interviewed: 0, selected: 0, rejected: 0, joined: 0,
      });
    }
    return by.get(name);
  };

  candidates.forEach((c) => {
    const apps = visibleApplications(req.user, c.applications, sharedIds);
    const row = bucket(c.source || c.firstSource || 'Unknown');
    row.total += 1;
    // The furthest point this candidate ever reached, across every application
    // of theirs this login can see: current stage, or anything in the history.
    let furthest = -1;
    let everRejected = false;
    apps.forEach((a) => {
      furthest = Math.max(furthest, stageIndex(a.stage), reachedByApp.get(a.id) ?? -1);
      if (a.stage === 'REJECTED') everRejected = true;
    });
    REACH_COLUMNS.forEach((col) => {
      if (furthest >= stageIndex(col.stage)) row[col.key] += 1;
    });
    if (everRejected) row.rejected += 1;
  });

  res.json({
    columns: REACH_COLUMNS.map((c) => ({ key: c.key, label: c.label, stage: c.stage })),
    rows: [...by.values()].sort((a, b) => b.total - a.total),
    note: 'Counts are per candidate and cumulative — someone who reached a later stage is '
      + 'counted at every earlier one, including if they were later rejected. "Interviewed" '
      + 'means the candidate reached Interview Scheduled or beyond.',
  });
});

// Load a candidate and apply scope. Returns [candidate, decorated] or sends the
// refusal itself and returns null — one place, so every sub-route below refuses
// identically.
async function loadInScope(req, res) {
  const candidate = await prisma.candidate.findUnique({
    where: { id: req.params.id },
    include: { applications: { include: { requirement: { include: { client: true, recruiter: true, bde: true } } } } },
  });
  if (!candidate) {
    res.status(404).json({ error: 'Candidate not found' });
    return null;
  }
  const s = scopeOf(req.user);
  const sharedIds = await clientSharedApplicationIds(req.user, [candidate]);
  const decorated = decorate(candidate, { user: req.user, sharedIds });
  // Server-side scope. A candidate login reaches exactly one record — its own.
  // Everyone else reaches a candidate only through an application on a
  // requirement their scope covers; no such application means refused, not
  // rendered empty.
  if (s.role === 'CANDIDATE') {
    if (candidate.id !== s.candidateId) {
      res.status(403).json(OUT_OF_SCOPE);
      return null;
    }
  } else if (!s.global && decorated.applications.length === 0) {
    res.status(403).json(OUT_OF_SCOPE);
    return null;
  }
  return { candidate, decorated, sharedIds };
}

// --- AI Match --------------------------------------------------------------
// Fed entirely by the existing engine in utils/matching.js — there is no second
// scorer in this file. The framing matters as much as the number: AI output is
// SUPPORTING INFORMATION for a human recruiter, never an automatic decision, so
// the payload carries that statement and a "recommendation" that is explicitly
// advisory. A CLIENT login never receives this object at all.
function recommendationFor(overall) {
  if (overall >= 85) return 'Strong match on the scored signals — worth a recruiter screen.';
  if (overall >= 70) return 'Good match — a recruiter should confirm the gaps listed below.';
  if (overall >= 50) return 'Partial match — screen carefully against the gaps.';
  return 'Weak match on the scored signals — a recruiter may still decide otherwise.';
}

function aiMatchFor(candidate, application) {
  const requirement = application && application.requirement;
  if (!requirement) return null;
  const m = computeMatch(candidate, requirement);
  return {
    requirementId: requirement.id,
    requirementTitle: requirement.title,
    overall: m.overall,
    matchedSkills: m.matchedSkills,
    missingSkills: m.missingSkills,
    goodMatched: m.goodMatched,
    goodMissing: m.goodMissing,
    experienceMatch: { percent: m.expPct, reason: m.expReason, relevantPercent: m.relevPct, relevantReason: m.relevReason },
    educationMatch: { percent: m.eduPct, reason: m.eduReason },
    locationMatch: { percent: m.locPct, reason: m.locReason },
    salaryMatch: { percent: m.salPct, reason: m.salReason },
    noticeMatch: { percent: m.notPct, reason: m.notReason },
    reasons: m.reasons,
    gaps: m.gaps,
    recommendation: recommendationFor(m.overall),
    advisory: 'AI match is supporting information for a human recruiter. It does not screen, '
      + 'shortlist or reject anyone — every stage change in this pipeline is made by a named person '
      + 'and recorded in Pipeline History.',
  };
}

// --- Pipeline history ------------------------------------------------------
// The stage chain with Who / When / Action / Comment. Rows come from
// ApplicationStageEvent, written by routes/applications.js on every transition.
// Applications that predate this table still show their creation and where they
// stand, labelled as derived rather than silently presented as a real event.
async function pipelineHistoryFor(applications, kind) {
  const ids = applications.map((a) => a.id);
  const events = ids.length
    ? await prisma.applicationStageEvent.findMany({
      where: { applicationId: { in: ids } },
      orderBy: { createdAt: 'asc' },
    })
    : [];
  const byApp = new Map();
  events.forEach((e) => {
    if (!byApp.has(e.applicationId)) byApp.set(e.applicationId, []);
    byApp.get(e.applicationId).push(e);
  });

  const out = [];
  applications.forEach((a) => {
    const ctx = a.requirement ? a.requirement.title : '—';
    const own = byApp.get(a.id) || [];
    // The chain must start at the beginning. If no recorded event opens the
    // application (because it existed before this table did), the creation
    // link is reconstructed from the application row and labelled as derived
    // rather than passed off as something someone actually did.
    if (own.length > 0 && !own.some((e) => e.fromStage == null)) {
      out.push({
        applicationId: a.id,
        requirementTitle: ctx,
        when: a.createdAt,
        who: '—',
        role: null,
        action: 'Application created',
        fromStage: null,
        toStage: 'NEW',
        toStageLabel: stageLabel('NEW'),
        stageGroupLabel: groupLabelOfStage('NEW'),
        comment: null,
        derived: true,
      });
    }
    if (own.length === 0) {
      out.push({
        applicationId: a.id,
        requirementTitle: ctx,
        when: a.createdAt,
        who: '—',
        role: null,
        action: 'Application created',
        fromStage: null,
        toStage: 'NEW',
        toStageLabel: stageLabel('NEW'),
        stageGroupLabel: groupLabelOfStage('NEW'),
        comment: null,
        derived: true,
      });
      if (a.stage !== 'NEW') {
        out.push({
          applicationId: a.id,
          requirementTitle: ctx,
          when: a.updatedAt,
          who: '—',
          role: null,
          action: `Currently at ${stageLabel(a.stage)}`,
          fromStage: null,
          toStage: a.stage,
          toStageLabel: stageLabel(a.stage),
          stageGroupLabel: groupLabelOfStage(a.stage),
          comment: null,
          derived: true,
        });
      }
      return;
    }
    own.forEach((e) => {
      out.push({
        applicationId: a.id,
        requirementTitle: ctx,
        when: e.createdAt,
        who: e.actorName || '—',
        role: e.actorRole || null,
        action: e.action,
        fromStage: e.fromStage,
        fromStageLabel: e.fromStage ? stageLabel(e.fromStage) : null,
        toStage: e.toStage,
        toStageLabel: stageLabel(e.toStage),
        stageGroupLabel: groupLabelOfStage(e.toStage),
        // A transition comment is an INTERNAL recruiter note by another name,
        // so it is withheld from every external login exactly like the Notes
        // tab is — from the candidate being discussed as well as the client.
        comment: kind === 'internal' ? e.comment : null,
        derived: false,
      });
    });
  });
  return out.sort((a, b) => new Date(b.when) - new Date(a.when));
}

router.get('/:id', async (req, res) => {
  const loaded = await loadInScope(req, res);
  if (!loaded) return undefined;
  const { candidate, decorated, sharedIds } = loaded;
  const kind = viewerKind(req.user);

  // "Matching Requirements": open requirements this candidate is not already in
  // the pipeline for, down to 50%. Scoped the same way, so a client never sees
  // another client's openings — and withheld from a client entirely, because it
  // is an internal sourcing suggestion built on the internal scorer.
  const linked = new Set(decorated.applications.map((a) => a.requirementId));
  let matchingRequirements = [];
  if (kind === 'internal') {
    const open = await prisma.requirement.findMany({
      where: { status: { in: REQUIREMENT_LIVE_STATUSES }, ...requirementWhere(req.user) },
      include: { client: true },
    });
    matchingRequirements = open
      .filter((r) => !linked.has(r.id))
      .map((r) => ({ ...r, match: computeMatch(candidate, r) }))
      .filter((r) => r.match.overall >= 50)
      .sort((a, b) => b.match.overall - a.match.overall);
  }

  // Per-application Owner / Next Action / Due Date for the Application tab.
  const rawApplications = visibleApplications(req.user, candidate.applications, sharedIds);
  const applications = decorated.applications.map((a) => ({
    ...a,
    stageLabel: stageLabel(a.stage),
    stageGroup: groupIdOfStage(a.stage),
    stageGroupLabel: groupLabelOfStage(a.stage),
    stageDetailLabel: stageDetail(a),
    owner: applicationOwner(a, a.requirement),
    nextAction: applicationNextAction(a),
    dueDate: applicationDueDate(a),
    overdue: applicationIsOverdue(a),
    lifeStatus: applicationLifeStatus(a),
    interviewStatusLabel: a.interviewStatus ? interviewStatusLabel(a.interviewStatus) : null,
  }));

  const latest = [...rawApplications].sort((a, b) => String(b.id).localeCompare(String(a.id)))[0] || null;

  // --- The tabs, each from its own source ---------------------------------
  const pipelineHistory = await pipelineHistoryFor(rawApplications, kind);

  // Communications are between TeamLink and the candidate. The candidate is a
  // party to them and sees their own; a CLIENT is not, and is served none.
  const communications = kind === 'client' ? [] : await prisma.candidateMessage.findMany({
    where: { candidateId: candidate.id },
    orderBy: { createdAt: 'desc' },
  });

  const documents = await prisma.candidateDocument.findMany({
    where: { candidateId: candidate.id, ...(kind === 'internal' ? {} : { internalOnly: false }) },
    orderBy: { createdAt: 'desc' },
  });

  // Internal notes and the audit trail are INTERNAL. A client or candidate
  // login is served neither the tab nor the field.
  let notes = [];
  let audit = [];
  if (kind === 'internal') {
    notes = await prisma.candidateNote.findMany({
      where: { candidateId: candidate.id },
      orderBy: { createdAt: 'desc' },
    });
    const appIds = rawApplications.map((a) => a.id);
    const rows = await prisma.auditLog.findMany({
      where: {
        OR: [
          { entity: 'Candidate', entityId: candidate.id },
          ...(appIds.length ? [{ entity: 'Application', entityId: { in: appIds } }] : []),
        ],
      },
      include: { user: { select: { name: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    audit = rows.map((r) => ({
      id: r.id,
      when: r.createdAt,
      who: r.user ? r.user.name : '—',
      action: r.action,
      entity: r.entity,
      entityId: r.entityId,
      fromValue: r.fromValue,
      toValue: r.toValue,
    }));
  }

  res.json({
    ...decorated,
    applications,
    matchingRequirements,
    viewer: {
      kind,
      internal: kind === 'internal',
      // Spelled out so the screen never has to guess why a tab is missing.
      withheld: kind === 'internal' ? [] : [
        'Internal recruiter notes',
        'Internal AI evaluation detail',
        'Internal stage comments',
        'Audit history',
        ...(kind === 'client'
          ? ['Salary and fee internals', 'Candidate communications']
          : []),
      ],
    },
    // AI Match is internal evaluation detail: never served to a client, and
    // never served to the candidate being evaluated.
    aiMatch: kind === 'internal' && latest ? aiMatchFor(candidate, latest) : null,
    pipelineHistory,
    communications,
    communicationsNote: NOT_SENT_DETAIL,
    documents,
    notes,
    audit,
  });
  return undefined;
});

// --- Communications tab (also its own endpoint, for refresh after a move) ---
router.get('/:id/communications', async (req, res) => {
  const loaded = await loadInScope(req, res);
  if (!loaded) return undefined;
  if (viewerKind(req.user) === 'client') {
    return res.status(403).json({ error: 'Candidate communications are not available to this login' });
  }
  const rows = await prisma.candidateMessage.findMany({
    where: { candidateId: req.params.id },
    orderBy: { createdAt: 'desc' },
  });
  res.json({
    rows,
    note: NOT_SENT_DETAIL,
    templates: Object.values(TEMPLATES).map((t) => ({ key: t.key, label: t.label, channels: t.channels })),
  });
  return undefined;
});

// --- Notes tab -------------------------------------------------------------
// Internal only, at BOTH ends: the GET refuses a client or candidate login
// outright (not an empty list — a refusal), and the POST needs candidate-master
// edit permission from the same engine every other write here uses.
router.get('/:id/notes', async (req, res) => {
  const loaded = await loadInScope(req, res);
  if (!loaded) return undefined;
  if (!isInternalViewer(req.user)) {
    return res.status(403).json({ error: 'Internal notes are not available to this login' });
  }
  const rows = await prisma.candidateNote.findMany({
    where: { candidateId: req.params.id },
    orderBy: { createdAt: 'desc' },
  });
  return res.json(rows);
});

router.post('/:id/notes', requirePerm('ats', 'candidates', 'Candidate Master', 'edit'), async (req, res) => {
  const loaded = await loadInScope(req, res);
  if (!loaded) return undefined;
  if (!isInternalViewer(req.user)) {
    return res.status(403).json({ error: 'Internal notes are not available to this login' });
  }
  const body = String(req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'A note cannot be empty.' });
  const note = await prisma.candidateNote.create({
    data: {
      candidateId: req.params.id,
      applicationId: req.body.applicationId || null,
      body,
      authorUserId: req.user.id,
      authorName: req.user.name,
      authorRole: req.user.atsRole || req.user.role,
    },
  });
  await logAudit({
    userId: req.user.id, action: 'Internal note added', entity: 'Candidate', entityId: req.params.id,
  });
  return res.status(201).json(note);
});

// --- Documents tab ---------------------------------------------------------
const DOC_TYPES = ['Resume', 'ID', 'Certificate', 'Offer', 'Joining'];

router.get('/:id/documents', async (req, res) => {
  const loaded = await loadInScope(req, res);
  if (!loaded) return undefined;
  const internal = isInternalViewer(req.user);
  const rows = await prisma.candidateDocument.findMany({
    where: { candidateId: req.params.id, ...(internal ? {} : { internalOnly: false }) },
    orderBy: { createdAt: 'desc' },
  });
  return res.json({ rows, types: DOC_TYPES });
});

router.post('/:id/documents', requirePerm('ats', 'candidates', 'Candidate Master', 'edit'), async (req, res) => {
  const loaded = await loadInScope(req, res);
  if (!loaded) return undefined;
  const docType = DOC_TYPES.includes(req.body.docType) ? req.body.docType : null;
  const name = String(req.body.name || '').trim();
  if (!docType) return res.status(400).json({ error: `Document type must be one of: ${DOC_TYPES.join(', ')}` });
  if (!name) return res.status(400).json({ error: 'A document name is required.' });
  const doc = await prisma.candidateDocument.create({
    data: {
      candidateId: req.params.id,
      docType,
      name,
      note: req.body.note || null,
      // Offer paperwork carries the commercial terms, so it defaults to
      // internal-only unless someone deliberately says otherwise.
      internalOnly: req.body.internalOnly != null ? !!req.body.internalOnly : docType === 'Offer',
      uploadedByUserId: req.user.id,
      uploadedByName: req.user.name,
    },
  });
  await logAudit({
    userId: req.user.id, action: `Document recorded (${docType})`, entity: 'Candidate', entityId: req.params.id, toValue: name,
  });
  return res.status(201).json(doc);
});

// --- Audit History tab -----------------------------------------------------
router.get('/:id/audit', async (req, res) => {
  const loaded = await loadInScope(req, res);
  if (!loaded) return undefined;
  if (!isInternalViewer(req.user)) {
    return res.status(403).json({ error: 'Audit history is not available to this login' });
  }
  const appIds = loaded.decorated.applications.map((a) => a.id);
  const rows = await prisma.auditLog.findMany({
    where: {
      OR: [
        { entity: 'Candidate', entityId: req.params.id },
        ...(appIds.length ? [{ entity: 'Application', entityId: { in: appIds } }] : []),
      ],
    },
    include: { user: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  return res.json(rows.map((r) => ({
    id: r.id,
    when: r.createdAt,
    who: r.user ? r.user.name : '—',
    action: r.action,
    entity: r.entity,
    fromValue: r.fromValue,
    toValue: r.toValue,
  })));
});

// Every field the prototype's acCollectCandidate() (line 8250) gathers, in the
// section order of the Add Candidate modal: A Personal, B Professional,
// C Education, D Skills, E Resume, F Source.
const CANDIDATE_FIELDS = {
  text: [
    'name', 'email', 'phone', 'dob', 'gender', 'location', 'preferredLocation',
    'currentCompany', 'currentDesignation', 'currentSalary', 'expectedSalary',
    'noticePeriod', 'availability', 'jobPreference', 'preferredEmploymentType', 'preferredWorkMode',
    'education', 'specialization', 'institute', 'passingYear',
    'skills', 'goodToHaveSkills', 'technicalSkills', 'softSkills',
    'resumeName', 'source', 'firstSource', 'sourceCampaign', 'profileStatus',
  ],
  numeric: ['experienceYears', 'relevantExperienceYears', 'resumeScore'],
};

function pickCandidate(body) {
  const data = {};
  for (const key of CANDIDATE_FIELDS.text) {
    if (body[key] !== undefined) data[key] = body[key];
  }
  for (const key of CANDIDATE_FIELDS.numeric) {
    if (body[key] !== undefined && body[key] !== '' && body[key] !== null) data[key] = Number(body[key]);
  }
  // A candidate arriving from a second source updates their latest source; the
  // first source is recorded once and never overwritten.
  if (data.source && !data.firstSource) data.firstSource = data.source;
  if (data.source && !data.preferredLocation && data.location) data.preferredLocation = data.location;
  return data;
}

router.post('/', requirePerm('ats', 'candidates', 'Add Candidate', 'create'), async (req, res) => {
  const { email, phone, allowDuplicate } = req.body;
  const data = pickCandidate(req.body);
  // Prototype saveNewCandidate() (line 8304) required fields, in its order.
  if (!data.name) return res.status(400).json({ error: 'First name is required.' });
  if (!phone) return res.status(400).json({ error: 'Mobile is required.' });
  if (!email) return res.status(400).json({ error: 'Email is required.' });
  if (!String(data.skills || '').trim()) return res.status(400).json({ error: 'Enter at least one mandatory skill.' });

  // Warn (409) rather than silently creating a second record for the same
  // person — the caller re-sends with allowDuplicate to go ahead anyway.
  if (!allowDuplicate) {
    const found = await findDuplicates({ email, phone });
    if (found.length > 0) {
      return res.status(409).json({
        error: `Already on file: ${found.map((m) => m.name).join(', ')}. Re-submit to add anyway.`,
        duplicate: true,
        matches: found.map((m) => ({ id: m.id, name: m.name, email: m.email, phone: m.phone })),
      });
    }
  }

  const candidate = await prisma.candidate.create({ data });
  await logAudit({ userId: req.user.id, action: 'Candidate created (manual)', entity: 'Candidate', entityId: candidate.id, toValue: 'Active' });

  // A resume named on the Add Candidate form becomes the first row of the
  // Documents tab, so the tab is never empty for a candidate who has one.
  if (candidate.resumeName) {
    await prisma.candidateDocument.create({
      data: {
        candidateId: candidate.id,
        docType: 'Resume',
        name: candidate.resumeName,
        note: 'Attached on the Add Candidate form',
        uploadedByUserId: req.user.id,
        uploadedByName: req.user.name,
      },
    });
  }

  // "Apply to Requirement" on the Add Candidate form creates the application in
  // the same save, scored against that requirement — prototype saveNewCandidate().
  let application = null;
  if (req.body.requirementId) {
    const requirement = await prisma.requirement.findUnique({ where: { id: req.body.requirementId } });
    if (requirement) {
      const match = computeMatch(candidate, requirement);
      application = await prisma.application.create({
        data: {
          candidateId: candidate.id,
          requirementId: requirement.id,
          stage: 'NEW',
          matchScore: match.overall,
          resumeScore: candidate.resumeScore ?? null,
          source: candidate.source,
          firstSource: candidate.firstSource,
          sourceCampaign: candidate.sourceCampaign,
          applicationMethod: req.body.applicationMethod || 'Manual',
          aiInterviewStatus: 'Required',
        },
      });
      // First link in the pipeline chain — Who / When / Action / Comment.
      await prisma.applicationStageEvent.create({
        data: {
          applicationId: application.id,
          candidateId: candidate.id,
          fromStage: null,
          toStage: 'NEW',
          action: 'Application created (manual add)',
          comment: null,
          actorUserId: req.user.id,
          actorName: req.user.name,
          actorRole: req.user.atsRole || req.user.role,
        },
      });
      await logAudit({ userId: req.user.id, action: 'Application created (manual add)', entity: 'Application', entityId: application.id, toValue: 'New' });
    }
  }

  return res.status(201).json({ ...candidate, application });
});

router.put('/:id', requirePerm('ats', 'candidates', 'Candidate Master', 'edit'), async (req, res) => {
  const candidate = await prisma.candidate.update({ where: { id: req.params.id }, data: pickCandidate(req.body) });
  await logAudit({ userId: req.user.id, action: 'Candidate updated', entity: 'Candidate', entityId: candidate.id });
  res.json(candidate);
});

module.exports = router;
