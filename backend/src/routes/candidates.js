const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm, requireProduct } = require('../middleware/auth');
const { requirementWhere, matches, scopeOf, OUT_OF_SCOPE } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const { computeMatch } = require('../utils/matching');
const {
  applicationOwner, applicationNextAction, applicationDueDate, applicationIsOverdue,
  applicationLifeStatus, stageLabel, REQUIREMENT_LIVE_STATUSES,
} = require('../utils/atsVocab');

const router = express.Router();
router.use(requireAuth);
// The whole router belongs to ATS: a login without ATS access, or without
// view permission on this module, is refused at the door rather than handed
// an empty list.
router.use(requireProduct('ats'));
router.use(requirePerm('ats', 'candidates', 'Candidate List', 'view'));

// A candidate is reachable only through an application on a requirement the
// signed-in user's scope already covers — so a Medical recruiter never sees an
// IT candidate, and one client never sees another client's shortlist. Computed
// once here from utils/scope.js and applied to both the list and the record.
function visibleApplications(user, applications) {
  const s = scopeOf(user);
  if (s.global) return applications;
  // A candidate sees only their OWN applications — never another candidate's,
  // even on a record they somehow reached.
  if (s.role === 'CANDIDATE') {
    return (applications || []).filter((a) => a.candidateId === s.candidateId);
  }
  const where = requirementWhere(user);
  return (applications || []).filter((a) => a.requirement && matches(a.requirement, where));
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

// The prototype's candidate list shows, per candidate, the state of their most
// recent application: Current Stage, Owner, Next Action, Due Date, Match Score,
// Status and AI Interview (renderCandidateList, line 8385). Owner/Next Action/
// Due Date are derived from the stage so they can never drift.
function decorate(candidate, { user } = {}) {
  const applications = user ? visibleApplications(user, candidate.applications) : (candidate.applications || []);

  // candidateStageOf(): the most recent application decides the current stage.
  const latest = [...applications].sort((a, b) => String(b.id).localeCompare(String(a.id)))[0] || null;
  if (!latest) {
    return { ...candidate, applications, currentStage: null, currentStageLabel: 'No application' };
  }
  const requirement = latest.requirement || null;
  return {
    ...candidate,
    applications,
    currentStage: latest.stage,
    currentStageLabel: stageLabel(latest.stage),
    owner: applicationOwner(latest, requirement),
    nextAction: applicationNextAction(latest),
    dueDate: applicationDueDate(latest),
    overdue: applicationIsOverdue(latest),
    matchScore: latest.matchScore ?? latest.resumeScore ?? null,
    lifeStatus: applicationLifeStatus(latest),
    aiInterviewStatus: latest.aiInterviewStatus || 'Required',
    latestApplicationId: latest.id,
  };
}

router.get('/', async (req, res) => {
  const candidates = await prisma.candidate.findMany({
    include: { applications: { include: { requirement: { include: { client: true, recruiter: true, bde: true } } } } },
    orderBy: { createdAt: 'desc' },
  });

  // Nobody browses the whole candidate master except a global role. A client
  // sees only people put forward on their own requirements; a recruiter only
  // people on requirements assigned to them; a TL only their department's.
  const s = scopeOf(req.user);
  if (s.global) return res.json(candidates.map((c) => decorate(c, { user: req.user })));
  if (s.role === 'CANDIDATE') {
    const own = candidates.filter((c) => c.id === s.candidateId);
    return res.json(own.map((c) => decorate(c, { user: req.user })));
  }
  const scoped = candidates
    .filter((c) => visibleApplications(req.user, c.applications).length > 0)
    .map((c) => decorate(c, { user: req.user }));
  return res.json(scoped);
});

// Must stay above /:id so "check-duplicate" isn't read as a candidate id.
router.get('/check-duplicate', async (req, res) => {
  const email = (req.query.email || '').trim();
  const phone = (req.query.phone || '').trim();
  const matches = await findDuplicates({ email, phone, excludeId: req.query.excludeId });
  res.json({
    duplicate: matches.length > 0,
    matches: matches.map((m) => ({ id: m.id, name: m.name, email: m.email, phone: m.phone, source: m.source })),
  });
});

router.get('/:id', async (req, res) => {
  const candidate = await prisma.candidate.findUnique({
    where: { id: req.params.id },
    include: { applications: { include: { requirement: { include: { client: true, recruiter: true, bde: true } } } } },
  });
  if (!candidate) return res.status(404).json({ error: 'Candidate not found' });

  const s = scopeOf(req.user);
  const decorated = decorate(candidate, { user: req.user });
  // Server-side scope. A candidate login reaches exactly one record — its own.
  // Everyone else reaches a candidate only through an application on a
  // requirement their scope covers; no such application means refused, not
  // rendered empty.
  if (s.role === 'CANDIDATE') {
    if (candidate.id !== s.candidateId) return res.status(403).json(OUT_OF_SCOPE);
  } else if (!s.global && decorated.applications.length === 0) {
    return res.status(403).json(OUT_OF_SCOPE);
  }

  // "Matching Requirements" tab: open requirements this candidate is not
  // already in the pipeline for, down to 50% (prototype candidateDetail).
  // Scoped the same way, so a client never sees another client's openings.
  const linked = new Set(decorated.applications.map((a) => a.requirementId));
  const open = await prisma.requirement.findMany({
    where: { status: { in: REQUIREMENT_LIVE_STATUSES }, ...requirementWhere(req.user) },
    include: { client: true },
  });
  const matchingRequirements = open
    .filter((r) => !linked.has(r.id))
    .map((r) => ({ ...r, match: computeMatch(candidate, r) }))
    .filter((r) => r.match.overall >= 50)
    .sort((a, b) => b.match.overall - a.match.overall);

  // Per-application Owner / Next Action / Due Date for the Applications tab.
  const applications = decorated.applications.map((a) => ({
    ...a,
    stageLabel: stageLabel(a.stage),
    owner: applicationOwner(a, a.requirement),
    nextAction: applicationNextAction(a),
    dueDate: applicationDueDate(a),
    overdue: applicationIsOverdue(a),
    lifeStatus: applicationLifeStatus(a),
  }));

  res.json({ ...decorated, applications, matchingRequirements });
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
    const matches = await findDuplicates({ email, phone });
    if (matches.length > 0) {
      return res.status(409).json({
        error: `Already on file: ${matches.map((m) => m.name).join(', ')}. Re-submit to add anyway.`,
        duplicate: true,
        matches: matches.map((m) => ({ id: m.id, name: m.name, email: m.email, phone: m.phone })),
      });
    }
  }

  const candidate = await prisma.candidate.create({ data });
  await logAudit({ userId: req.user.id, action: 'Candidate created (manual)', entity: 'Candidate', entityId: candidate.id, toValue: 'Active' });

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
      await logAudit({ userId: req.user.id, action: 'Application created (manual add)', entity: 'Application', entityId: application.id, toValue: 'New' });
    }
  }

  res.status(201).json({ ...candidate, application });
});

router.put('/:id', requirePerm('ats', 'candidates', 'Candidate Master', 'edit'), async (req, res) => {
  const candidate = await prisma.candidate.update({ where: { id: req.params.id }, data: pickCandidate(req.body) });
  await logAudit({ userId: req.user.id, action: 'Candidate updated', entity: 'Candidate', entityId: candidate.id });
  res.json(candidate);
});

module.exports = router;
