const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm, can, requireProduct } = require('../middleware/auth');
const { requirementWhere, matches, OUT_OF_SCOPE } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const { MATCH_THRESHOLD, SUGGESTION_THRESHOLD, rankCandidates } = require('../utils/matching');

const router = express.Router();
router.use(requireAuth);
// The whole router belongs to ATS: a login without ATS access, or without
// view permission on this module, is refused at the door rather than handed
// an empty list.
router.use(requireProduct('ats'));
router.use(requirePerm('ats', 'requirements', 'Requirement List', 'view'));

// Scope is not decided here any more. utils/scope.js owns it, and the same rule
// drives the list query, the single-record check and the frontend's UI — so a
// record the user cannot reach is refused by the API, not merely hidden.
//
// One router.param covers EVERY /:id endpoint below — read and write alike —
// so no route can forget to scope-check.
router.param('id', async (req, res, next, id) => {
  const requirement = await prisma.requirement.findUnique({ where: { id } });
  if (!requirement) return res.status(404).json({ error: 'Requirement not found' });
  if (!matches(requirement, requirementWhere(req.user))) return res.status(403).json(OUT_OF_SCOPE);
  req.requirement = requirement;
  return next();
});

router.get('/', async (req, res) => {
  const where = requirementWhere(req.user);
  if (req.query.status) where.status = req.query.status;
  if (req.query.clientId) where.clientId = req.query.clientId;
  const found = await prisma.requirement.findMany({
    where,
    include: {
      client: true,
      recruiter: true,
      bde: true,
      applications: { select: { stage: true } },
      _count: { select: { applications: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  // Openings / Filled / Remaining, which the prototype's Open Requirements
  // tab (openRequirementsHtml, line 6832) shows as their own columns.
  const requirements = found.map((r) => {
    const filled = r.applications.filter((a) => ['JOINED', 'HIRED'].includes(a.stage)).length;
    const { applications, ...rest } = r;
    return { ...rest, filled, remaining: Math.max(0, (r.openings || 1) - filled) };
  });

  // How many candidates in the master list clear the match threshold for each
  // requirement — the prototype's matchingCandidateCount(), computed live.
  const showMatches = await can(req.user, 'ats', 'requirements', 'Matching Candidates', 'view');
  if (!showMatches) return res.json(requirements);
  const candidates = await prisma.candidate.findMany();
  res.json(
    requirements.map((r) => ({ ...r, matchingCandidates: rankCandidates(candidates, r).length }))
  );
});

router.get('/:id', async (req, res) => {
  const requirement = await prisma.requirement.findUnique({
    where: { id: req.params.id },
    include: { client: true, recruiter: true, bde: true, applications: { include: { candidate: true } } },
  });
  if (!requirement) return res.status(404).json({ error: 'Requirement not found' });

  // Openings / Filled / Remaining, and the count of candidates at or above the
  // 70% match threshold — the prototype's reqFilled(), reqRemaining() and
  // matchingCandidateCount() on the requirement detail screen.
  const filled = requirement.applications.filter((a) => ['JOINED', 'HIRED'].includes(a.stage)).length;
  const candidates = await prisma.candidate.findMany();
  res.json({
    ...requirement,
    filled,
    remaining: Math.max(0, (requirement.openings || 1) - filled),
    matchingCandidates: rankCandidates(candidates, requirement, { threshold: MATCH_THRESHOLD }).length,
    matchThreshold: MATCH_THRESHOLD,
  });
});

// Suggested candidates for this requirement — everyone not already in the
// pipeline who clears the match threshold, ranked, with the reasons behind the
// score. Mirrors the prototype's matchingCandidatesFor()/matchingCandidatesView().
router.get('/:id/matching-candidates', requirePerm('ats', 'requirements', 'Matching Candidates', 'view'), async (req, res) => {
  const requirement = await prisma.requirement.findUnique({ where: { id: req.params.id } });
  if (!requirement) return res.status(404).json({ error: 'Requirement not found' });

  const [candidates, linked] = await Promise.all([
    prisma.candidate.findMany(),
    prisma.application.findMany({ where: { requirementId: requirement.id }, select: { candidateId: true } }),
  ]);

  // The prototype's requirement detail lists suggestions down to 50%, while the
  // "Matching Candidates" count tile only counts those at or above 70%.
  const ranked = rankCandidates(candidates, requirement, {
    excludeIds: new Set(linked.map((a) => a.candidateId)),
    threshold: req.query.threshold ? Number(req.query.threshold) : SUGGESTION_THRESHOLD,
  });
  res.json(ranked);
});

// Every field the prototype's collectRequirementForm() (line 7062) gathers.
// Section letters match the prototype's Create Requirement modal headings:
// A Basic Information, B Client Information, C Job Description,
// D Job Conditions, E Compensation, F Assignment, G Job Posting.
const REQUIREMENT_FIELDS = [
  'title', 'description', 'department', 'priority', 'openings', 'closingDate', 'internal',
  'jobDescription', 'responsibilities', 'qualifications', 'education', 'skills', 'goodToHaveSkills',
  'employmentType', 'workMode', 'location', 'preferredLocation', 'experience', 'relevantExperience',
  'joiningTimeline', 'noticePeriodMax', 'jobPreference',
  'salaryType', 'currency', 'salary',
  'recruiterId', 'bdeId', 'tl', 'stl', 'postingSources',
];

function pickRequirement(body) {
  const data = {};
  for (const key of REQUIREMENT_FIELDS) {
    if (body[key] === undefined) continue;
    if (key === 'openings') data.openings = Number(body.openings) || 1;
    else if (key === 'internal') data.internal = Boolean(body.internal);
    // "— Not assigned —" arrives as an empty string; a relation field has to be
    // null, not '', or the write fails on a foreign key that does not exist.
    else if (['recruiterId', 'bdeId'].includes(key)) data[key] = body[key] || null;
    else data[key] = body[key];
  }
  return data;
}

router.post('/', requirePerm('ats', 'requirements', 'Create Requirement', 'create'), async (req, res) => {
  const { clientId, status } = req.body;
  const data = pickRequirement(req.body);
  // Prototype saveNewRequirement(): title, full job description and at least
  // one mandatory skill are required unless the requirement is saved as Draft.
  if (!data.title) return res.status(400).json({ error: 'Enter a job title.' });
  const asDraft = status === 'DRAFT';
  if (!asDraft) {
    if (!data.jobDescription && !data.description) return res.status(400).json({ error: 'Enter a job description.' });
    if (!String(data.skills || '').trim()) return res.status(400).json({ error: 'Enter at least one mandatory skill.' });
  }

  // An internal requirement carries no client; a client requirement must name one.
  if (!data.internal && !clientId) return res.status(400).json({ error: 'Select a client for a client requirement.' });

  // The agreement gate: a client requirement only opens once the agreement is
  // Active (prototype saveNewRequirement / activateRequirement).
  let requirementStatus = 'DRAFT';
  if (!asDraft) {
    if (data.internal) requirementStatus = 'OPEN';
    else {
      const client = await prisma.client.findUnique({ where: { id: clientId } });
      if (!client) return res.status(400).json({ error: 'Select a client for a client requirement.' });
      if (client.agreementStatus !== 'ACTIVE') {
        return res.status(400).json({
          error: 'Cannot activate or post — the client agreement is not Active yet. Save as Draft instead.',
        });
      }
      requirementStatus = 'OPEN';
    }
  }

  const requirement = await prisma.requirement.create({
    data: {
      ...data,
      clientId,
      priority: data.priority || 'Medium',
      status: requirementStatus,
      description: data.description || data.jobDescription || data.title,
    },
  });
  await logAudit({
    userId: req.user.id, action: 'Requirement created', entity: 'Requirement',
    entityId: requirement.id, toValue: requirementStatus,
  });
  res.status(201).json(requirement);
});

router.put('/:id', requirePerm('ats', 'requirements', 'Requirement Detail', 'edit'), async (req, res) => {
  const data = pickRequirement(req.body);
  // status only moves through /activate and /toggle-status, which enforce the
  // agreement gate — it is deliberately not editable here.
  const requirement = await prisma.requirement.update({ where: { id: req.params.id }, data });
  await logAudit({ userId: req.user.id, action: 'Requirement updated', entity: 'Requirement', entityId: requirement.id });
  res.json(requirement);
});

// Activate a draft requirement — the prototype's activateRequirement() refuses
// until the client's service agreement has actually been signed.
router.post('/:id/activate', requirePerm('ats', 'requirements', 'Requirement Detail', 'approve'), async (req, res) => {
  const existing = await prisma.requirement.findUnique({ where: { id: req.params.id }, include: { client: true } });
  if (!existing) return res.status(404).json({ error: 'Requirement not found' });
  if (existing.status === 'OPEN') return res.status(400).json({ error: 'This requirement is already open' });
  // Prototype activateRequirement() (line 6333): the gate is an ACTIVE
  // agreement, not merely a signed/confirmed one. Internal requirements have
  // no client agreement to wait on.
  if (!existing.internal && (!existing.client || existing.client.agreementStatus !== 'ACTIVE')) {
    return res.status(400).json({ error: 'Cannot activate — the client agreement is not yet Active.' });
  }

  const requirement = await prisma.requirement.update({ where: { id: req.params.id }, data: { status: 'OPEN' } });
  await logAudit({
    userId: req.user.id, action: 'Requirement activated', entity: 'Requirement',
    entityId: requirement.id, fromValue: existing.status, toValue: 'OPEN',
  });
  res.json(requirement);
});

// Open/close toggle — the prototype's toggleRequirementStatus().
router.post('/:id/toggle-status', requirePerm('ats', 'requirements', 'Requirement Detail', 'approve'), async (req, res) => {
  const existing = await prisma.requirement.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Requirement not found' });
  const status = existing.status === 'OPEN' ? 'CLOSED' : 'OPEN';
  const requirement = await prisma.requirement.update({ where: { id: req.params.id }, data: { status } });
  await logAudit({
    userId: req.user.id, action: 'Requirement status toggled', entity: 'Requirement',
    entityId: requirement.id, fromValue: existing.status, toValue: status,
  });
  res.json(requirement);
});

// Templated job description built from the requirement + client — the
// prototype's jobDescriptionHtml(). Saved onto description, which is what the
// public Job Portal (routes/public.js) already shows candidates.
router.post('/:id/generate-jd', requirePerm('ats', 'requirements', 'Job Posting', 'edit'), async (req, res) => {
  const requirement = await prisma.requirement.findUnique({ where: { id: req.params.id }, include: { client: true } });
  if (!requirement) return res.status(404).json({ error: 'Requirement not found' });

  // The prototype's jobDescriptionHtml() (line 6398): the JD is assembled from
  // the requirement's own recorded fields, in this section order, rather than
  // from boilerplate. Rendered as plain text so it can be stored in SQLite and
  // served by the public job portal.
  const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
  const skills = list(requirement.skills);
  const goodToHave = list(requirement.goodToHaveSkills);
  const row = (k, v) => (v ? `${k}: ${v}` : null);

  const description = [
    requirement.title,
    `${requirement.internal ? 'Internal TeamLink hiring' : requirement.client ? requirement.client.name : '—'} · ` +
      `${requirement.location || '—'} · ${requirement.workMode || '—'}`,
    '',
    'About the role',
    requirement.jobDescription || requirement.description || 'No description recorded yet.',
    ...(requirement.responsibilities ? ['', 'Responsibilities', requirement.responsibilities] : []),
    ...(requirement.qualifications ? ['', 'Qualifications', requirement.qualifications] : []),
    '',
    'Skills',
    `${skills.join(', ') || '—'} (mandatory)`,
    `${goodToHave.join(', ') || '—'} (good to have)`,
    '',
    'Details',
    ...[
      row('Experience', requirement.experience),
      row('Relevant experience', requirement.relevantExperience),
      row('Education', requirement.education),
      row('Location', requirement.location),
      row('Preferred location', requirement.preferredLocation),
      row('Work mode', requirement.workMode),
      row('Employment type', requirement.employmentType),
      row('Salary range', requirement.salary),
      row('Notice period', requirement.noticePeriodMax),
      row('Joining timeline', requirement.joiningTimeline),
      row('Openings', requirement.openings),
      row('Closing date', requirement.closingDate),
    ].filter(Boolean),
    ...(!requirement.internal && requirement.client
      ? [
          '',
          'About the client',
          [requirement.client.name, requirement.client.industry, requirement.client.location].filter(Boolean).join(' · '),
        ]
      : []),
  ].join('\n');

  const updated = await prisma.requirement.update({ where: { id: requirement.id }, data: { description } });
  await logAudit({ userId: req.user.id, action: 'Job description generated', entity: 'Requirement', entityId: requirement.id });
  res.json(updated);
});

module.exports = router;
