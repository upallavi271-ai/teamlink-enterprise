const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm, can, requireProduct } = require('../middleware/auth');
const {
  requirementWhere, matches, scopeOf, isAssignedTo, OUT_OF_SCOPE,
} = require('../utils/scope');
const { logAudit, logFieldChanges } = require('../utils/audit');
const { notifyUsers } = require('../utils/notify');
const { MATCH_THRESHOLD, SUGGESTION_THRESHOLD, rankCandidates } = require('../utils/matching');
const {
  REQUIREMENT_STATUS_CODES, REQUIREMENT_LIVE_STATUSES, requirementIsLive,
  agreementIsActive, normalizeAgreementStatus,
} = require('../utils/atsVocab');

const router = express.Router();
router.use(requireAuth);
// The whole router belongs to ATS: a login without ATS access, or without
// view permission on this module, is refused at the door rather than handed
// an empty list.
router.use(requireProduct('ats'));
router.use(requirePerm('ats', 'requirements', 'Requirement List', 'view'));

const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const isClient = (user) => scopeOf(user).role === 'CLIENT';

// Scope is not decided here. utils/scope.js owns it, and the same rule drives
// the list query, the single-record check and the frontend's UI — so a record
// the user cannot reach is refused by the API, not merely hidden.
//
// The rule is the ASSIGNMENT CHAIN:
//   Requirement -> Assigned TL -> Assigned Recruiter(s) -> BDE -> Client
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

// ---------------------------------------------------------------------------
// VIEW != EDIT. The six per-record permissions the brief names, resolved
// server-side against the ONE engine and then narrowed by the record itself.
//
//   VIEW    -> requirements/Requirement Detail/view   (+ data scope)
//   EDIT    -> requirements/Requirement Detail/edit
//   APPROVE -> requirements/Requirement Detail/approve  (activate / close)
//   ASSIGN  -> requirements/Requirement Detail/assign   (TL / recruiters / BDE)
//   SHARE   -> requirements/Job Posting/edit            (push the JD outward)
//   EXPORT  -> requirements/Requirement List/export
//
// A TL who can see a recruiter's requirement because it sits in their
// department does NOT thereby get to edit it: `edit` and `assign` additionally
// require that the user is named on the record's own assignment chain, unless
// they hold global scope.
// ---------------------------------------------------------------------------
async function requirementPermissions(user, record) {
  const [view, edit, approve, assign, share, exportable, pipeline, matching, pipelineEdit] = await Promise.all([
    can(user, 'ats', 'requirements', 'Requirement Detail', 'view'),
    can(user, 'ats', 'requirements', 'Requirement Detail', 'edit'),
    can(user, 'ats', 'requirements', 'Requirement Detail', 'approve'),
    can(user, 'ats', 'requirements', 'Requirement Detail', 'assign'),
    can(user, 'ats', 'requirements', 'Job Posting', 'edit'),
    can(user, 'ats', 'requirements', 'Requirement List', 'export'),
    can(user, 'ats', 'requirements', 'Requirement Pipeline', 'view'),
    can(user, 'ats', 'requirements', 'Matching Candidates', 'view'),
    // SEEING THE PIPELINE IS NOT ADDING TO IT. `pipeline` above is a VIEW
    // permission and the screen was drawing "Add to Pipeline" and the
    // "Move to…" control from it, so a view-only login (a Manager, §3) was
    // shown buttons whose POST the API refuses. This is the write half, and
    // it is the same permission routes/applications.js enforces.
    can(user, 'ats', 'candidates', 'Applications', 'create'),
  ]);
  const s = scopeOf(user);
  const owned = s.global || !record || isAssignedTo(user, record);
  return {
    view,
    edit: edit && owned,
    approve: approve && owned,
    assign: assign && owned,
    share: share && owned,
    export: exportable,
    pipeline,
    pipelineEdit,
    matching,
    // Why edit is off, so the screen can say so rather than just hiding a button.
    readOnlyReason: edit && !owned ? 'You can view this requirement, but it is not assigned to you.' : null,
  };
}

// A client sees its own requirement, never TeamLink's internals on it.
function shapeForClient(r) {
  const {
    recruiterId, bdeId, tlId, stlId, recruiterIds, recruiter, bde, accountManager,
    matchingCandidates, matchThreshold, postingSources, ...rest
  } = r;
  return rest;
}

// ---------------------------------------------------------------------------
// GET /requirements — the consistent filter set:
//   Department · Client · Location · Recruiter · TL · BDE · Status · Priority
//   · Date Range
// Every one of them is applied to the SCOPED query on the server, so a filter
// can only ever narrow what the user may already see.
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  const q = req.query;
  const where = { AND: [requirementWhere(req.user)] };
  const and = where.AND;

  if (q.department) and.push({ department: q.department });
  if (q.clientId) and.push({ clientId: q.clientId });
  if (q.location) and.push({ location: q.location });
  if (q.recruiterId) {
    and.push({ OR: [{ recruiterId: q.recruiterId }, { recruiterIds: { contains: q.recruiterId } }] });
  }
  if (q.tlId) and.push({ tlId: q.tlId });
  if (q.bdeId) and.push({ bdeId: q.bdeId });
  if (q.priority) and.push({ priority: q.priority });
  if (q.status === 'LIVE') and.push({ status: { in: REQUIREMENT_LIVE_STATUSES } });
  else if (q.status) and.push({ status: q.status });
  if (q.from) and.push({ createdAt: { gte: new Date(`${q.from}T00:00:00.000Z`) } });
  if (q.to) and.push({ createdAt: { lte: new Date(`${q.to}T23:59:59.999Z`) } });
  if (q.search) {
    and.push({ OR: [{ title: { contains: q.search } }, { skills: { contains: q.search } }, { reqCode: { contains: q.search } }] });
  }

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

  // Resolve the assignment chain's names in one query rather than N.
  const people = await peopleFor(found);

  // Openings / Filled / Remaining, which the prototype's Open Requirements
  // tab (openRequirementsHtml, line 6832) shows as their own columns.
  const forClient = isClient(req.user);
  const requirements = found.map((r) => {
    const filled = r.applications.filter((a) => ['JOINED', 'HIRED'].includes(a.stage)).length;
    const { applications, ...rest } = r;
    const row = {
      ...rest,
      client: rest.client ? { ...rest.client, agreementStatus: normalizeAgreementStatus(rest.client.agreementStatus) } : null,
      tlName: people.get(r.tlId) || r.tl || null,
      stlName: people.get(r.stlId) || r.stl || null,
      coRecruiterNames: csv(r.recruiterIds).map((id) => people.get(id)).filter(Boolean),
      filled,
      remaining: Math.max(0, (r.openings || 1) - filled),
      live: requirementIsLive(r.status),
    };
    return forClient ? shapeForClient(row) : row;
  });

  const permissions = await requirementPermissions(req.user, null);

  // How many candidates in the master list clear the match threshold for each
  // requirement — the prototype's matchingCandidateCount(), computed live.
  if (!permissions.matching) return res.json(requirements.map((r) => ({ ...r, permissions })));
  const candidates = await prisma.candidate.findMany();
  res.json(
    requirements.map((r) => ({ ...r, matchingCandidates: rankCandidates(candidates, r).length, permissions })),
  );
});

// One lookup for every user id named anywhere on the assignment chain.
async function peopleFor(rows) {
  const ids = new Set();
  rows.forEach((r) => {
    [r.tlId, r.stlId].forEach((id) => id && ids.add(id));
    csv(r.recruiterIds).forEach((id) => ids.add(id));
  });
  if (!ids.size) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name]));
}

// The people who may be put on a requirement — the Assignment picker's source.
//
// It carried NO permission guard, so a CLIENT login received the full internal
// staff directory: every recruiter, TL, STL and BDE in the company, by name.
// It is now held to the same feature that opens the Recruiter & BDE screen —
// an ATS working role — which excludes clients, candidates, accountants and
// HRMS-only employees by construction rather than by a role string.
//
// Scoped: a TL only assigns within the departments they actually cover.
router.get('/assignable-people', requirePerm('ats', 'recruiterbde', 'Team View', 'view'), async (req, res) => {
  const s = scopeOf(req.user);
  const where = { atsAccess: true, status: 'Active', atsRole: { in: ['RECRUITER', 'TL', 'STL', 'BDE'] } };
  if (!s.global) {
    // `atsScopeDepartments` is a COMMA-SEPARATED column, so `{ in: [...] }`
    // only ever matched a single-department list. `contains` per department is
    // what actually finds an STL scoped to "Medical,IT".
    where.OR = s.departments.length
      ? [
        { atsDepartment: { in: s.departments } },
        ...s.departments.map((d) => ({ atsScopeDepartments: { contains: d } })),
        // A BDE works across desks by definition, so the BDE bench stays
        // visible to anyone who may assign — that is the assignment chain.
        { atsRole: 'BDE' },
      ]
      : [{ id: s.userId }];
  }
  const users = await prisma.user.findMany({
    where,
    select: { id: true, name: true, atsRole: true, atsDepartment: true, team: true },
    orderBy: { name: 'asc' },
  });
  res.json(users);
});

router.get('/:id', async (req, res) => {
  const requirement = await prisma.requirement.findUnique({
    where: { id: req.params.id },
    include: { client: true, recruiter: true, bde: true, applications: { include: { candidate: true } } },
  });
  if (!requirement) return res.status(404).json({ error: 'Requirement not found' });

  const people = await peopleFor([requirement]);
  const filled = requirement.applications.filter((a) => ['JOINED', 'HIRED'].includes(a.stage)).length;
  const candidates = await prisma.candidate.findMany();
  const permissions = await requirementPermissions(req.user, requirement);

  const payload = {
    ...requirement,
    client: requirement.client
      ? { ...requirement.client, agreementStatus: normalizeAgreementStatus(requirement.client.agreementStatus) }
      : null,
    tlName: people.get(requirement.tlId) || requirement.tl || null,
    stlName: people.get(requirement.stlId) || requirement.stl || null,
    coRecruiters: csv(requirement.recruiterIds).map((id) => ({ id, name: people.get(id) || id })),
    filled,
    remaining: Math.max(0, (requirement.openings || 1) - filled),
    matchingCandidates: permissions.matching
      ? rankCandidates(candidates, requirement, { threshold: MATCH_THRESHOLD }).length
      : undefined,
    matchThreshold: MATCH_THRESHOLD,
    live: requirementIsLive(requirement.status),
    agreementActive: requirement.internal || agreementIsActive(requirement.client && requirement.client.agreementStatus),
  };

  // A client never receives the internal pipeline detail on their own req.
  if (isClient(req.user)) {
    const shaped = shapeForClient(payload);
    shaped.applications = (payload.applications || []).map((a) => ({
      id: a.id, stage: a.stage, candidateId: a.candidateId, candidateName: a.candidate && a.candidate.name,
      interviewAt: a.interviewAt, interviewStatus: a.interviewStatus, joiningDate: a.joiningDate,
    }));
    return res.json({ ...shaped, permissions });
  }
  res.json({ ...payload, permissions });
});

// Suggested candidates for this requirement — everyone not already in the
// pipeline who clears the match threshold, ranked, with the reasons behind the
// score. Mirrors the prototype's matchingCandidatesFor()/matchingCandidatesView().
router.get('/:id/matching-candidates', requirePerm('ats', 'requirements', 'Matching Candidates', 'view'), async (req, res) => {
  const requirement = req.requirement;
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

// The requirement's own activity trail — the Requirement Detail activity strip.
router.get('/:id/activity', async (req, res) => {
  const rows = await prisma.auditLog.findMany({
    where: { entity: 'Requirement', entityId: req.requirement.id },
    include: { user: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
    take: 40,
  });
  res.json(rows.map((a) => ({
    id: a.id,
    action: a.action,
    fromValue: a.fromValue,
    toValue: a.toValue,
    // followup_: Edit Requirement writes one row per changed field, so the
    // activity strip can say "Job Title: Staff Nurse → Staff Nurse (ICU)"
    // instead of the bare "Requirement updated" it used to show.
    field: a.field,
    fieldLabel: a.fieldLabel,
    reason: isClient(req.user) ? null : a.reason,
    createdAt: a.createdAt,
    by: isClient(req.user) ? null : (a.user ? a.user.name : (a.actorName || 'System')),
  })));
});

// Every field the prototype's collectRequirementForm() (line 7062) gathers,
// plus the clireq assignment chain and portal sync. Section letters match the
// prototype's Create Requirement modal headings: A Basic Information,
// B Client Information, C Job Description, D Job Conditions, E Compensation,
// F Assignment, G Job Posting.
const REQUIREMENT_FIELDS = [
  'title', 'description', 'department', 'priority', 'openings', 'closingDate', 'internal',
  'jobDescription', 'responsibilities', 'qualifications', 'education', 'skills', 'goodToHaveSkills',
  'employmentType', 'workMode', 'location', 'preferredLocation', 'experience', 'relevantExperience',
  'joiningTimeline', 'noticePeriodMax', 'jobPreference',
  'salaryType', 'currency', 'salary',
  'recruiterId', 'bdeId', 'tl', 'stl', 'postingSources',
  // clireq
  'tlId', 'stlId', 'recruiterIds', 'targetDate', 'accountManager', 'portalSyncStatus',
];

function pickRequirement(body) {
  const data = {};
  for (const key of REQUIREMENT_FIELDS) {
    if (body[key] === undefined) continue;
    if (key === 'openings') data.openings = Number(body.openings) || 1;
    else if (key === 'internal') data.internal = Boolean(body.internal);
    // "— Not assigned —" arrives as an empty string; a relation field has to be
    // null, not '', or the write fails on a foreign key that does not exist.
    else if (['recruiterId', 'bdeId', 'tlId', 'stlId'].includes(key)) data[key] = body[key] || null;
    else if (key === 'recruiterIds') {
      data.recruiterIds = Array.isArray(body.recruiterIds)
        ? body.recruiterIds.filter(Boolean).join(',')
        : (body.recruiterIds || null);
    } else data[key] = body[key];
  }
  return data;
}

// REQ-0001, REQ-0002 … the human-facing Requirement ID.
async function nextRequirementCode() {
  const used = await prisma.requirement.count();
  for (let n = used + 1; n < used + 500; n += 1) {
    const code = `REQ-${String(n).padStart(4, '0')}`;
    // eslint-disable-next-line no-await-in-loop
    const clash = await prisma.requirement.findFirst({ where: { reqCode: code }, select: { id: true } });
    if (!clash) return code;
  }
  return `REQ-${Date.now()}`;
}

// Tell the people now on the chain that they have been given the requirement.
async function notifyAssignment(requirement, actorId, verb = 'assigned to you') {
  const ids = [requirement.recruiterId, requirement.bdeId, requirement.tlId, requirement.stlId,
    ...csv(requirement.recruiterIds)];
  await notifyUsers(ids, {
    title: `Requirement ${requirement.reqCode || requirement.title} ${verb}`,
    message: `${requirement.title} — ${requirement.department || 'no department'}.`,
    exceptUserId: actorId,
  });
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

  // THE AGREEMENT GATE. A client requirement cannot go live until its client's
  // agreement is ACTIVE. Rather than refusing the save outright it now parks
  // the requirement in AGREEMENT_CHECK, which is the state the workflow names:
  //   Draft -> Agreement Check -> Open -> ...
  let requirementStatus = 'DRAFT';
  let gateNote = null;
  if (!asDraft) {
    if (data.internal) requirementStatus = 'OPEN';
    else {
      const client = await prisma.client.findUnique({ where: { id: clientId } });
      if (!client) return res.status(400).json({ error: 'Select a client for a client requirement.' });
      if (!agreementIsActive(client.agreementStatus)) {
        requirementStatus = 'AGREEMENT_CHECK';
        gateNote = 'Saved at Agreement Check — the client agreement is not Active yet, so this requirement is not live.';
      } else {
        requirementStatus = 'OPEN';
      }
    }
  }
  // A requirement that already names a recruiter starts one step further on.
  if (requirementStatus === 'OPEN' && (data.recruiterId || csv(data.recruiterIds).length)) {
    requirementStatus = 'RECRUITER_ASSIGNED';
  }

  const requirement = await prisma.requirement.create({
    data: {
      ...data,
      clientId,
      reqCode: await nextRequirementCode(),
      priority: data.priority || 'Medium',
      status: requirementStatus,
      description: data.description || data.jobDescription || data.title,
    },
  });
  await logAudit({
    userId: req.user.id, action: 'Requirement created', entity: 'Requirement',
    entityId: requirement.id, toValue: requirementStatus,
  });
  await notifyAssignment(requirement, req.user.id);
  res.status(201).json({ ...requirement, gateNote });
});

// ---------------------------------------------------------------------------
// EDIT REQUIREMENT.
//
// Open a saved requirement and change its fields. The screen reuses the
// Create Requirement form (frontend/src/components/RequirementForm.jsx — one
// form, two modes), and this endpoint is the same PUT it always was, with two
// things it was missing:
//
//   1. THE ASSIGNMENT CHAIN IS NOT AN EDIT. tlId / stlId / recruiterId /
//      recruiterIds / bdeId / accountManager decide WHO CAN SEE THIS RECORD
//      (utils/scope.js requirementWhere). Changing them is a scope change, so
//      it needs the `assign` action, not `edit` — the same split POST
//      /:id/assign already enforces. A recruiter holds `edit` on requirements
//      they are assigned and does NOT hold `assign`; before this, `edit`
//      quietly carried the whole chain with it and a recruiter could have
//      handed their own requirement to somebody else, or taken someone
//      else's co-recruiter seat, through the edit form.
//
//   2. A FIELD-LEVEL AUDIT TRAIL. "Requirement updated" with no values told
//      nobody anything. Every changed field is now one row —
//      Field · Old Value · New Value · Changed By · Changed At — written by
//      the same utils/audit.js logFieldChanges() the employee lifecycle uses.
// ---------------------------------------------------------------------------

// The fields that decide scope. Kept next to the rule they serve.
const ASSIGNMENT_FIELDS = ['recruiterId', 'bdeId', 'tlId', 'stlId', 'recruiterIds', 'accountManager'];

// Human labels for the audit trail, so a row reads "Job Title" and not "title".
const FIELD_LABELS = {
  title: 'Job Title',
  description: 'Description',
  department: 'Department',
  priority: 'Priority',
  openings: 'Number of Openings',
  closingDate: 'Closing Date',
  internal: 'Requirement Type',
  jobDescription: 'Job Description',
  responsibilities: 'Responsibilities',
  qualifications: 'Qualifications',
  education: 'Education',
  skills: 'Mandatory Skills',
  goodToHaveSkills: 'Good-to-have Skills',
  employmentType: 'Employment Type',
  workMode: 'Work Mode',
  location: 'Location',
  preferredLocation: 'Preferred Location',
  experience: 'Experience',
  relevantExperience: 'Relevant Experience',
  joiningTimeline: 'Joining Timeline',
  noticePeriodMax: 'Maximum Notice Period',
  jobPreference: 'Job Preference',
  salaryType: 'Salary Type',
  currency: 'Currency',
  salary: 'Salary Range',
  targetDate: 'Target Date',
  postingSources: 'Posting Sources',
  portalSyncStatus: 'Job Portal Sync',
  recruiterId: 'Assigned Recruiter',
  bdeId: 'BDE',
  tlId: 'Assigned TL',
  stlId: 'STL',
  recruiterIds: 'Co-recruiters',
  accountManager: 'Account Manager',
  tl: 'TL (name)',
  stl: 'STL (name)',
};

const sameValue = (a, b) => {
  const norm = (v) => (v === null || v === undefined || v === '' ? '' : String(v));
  return norm(a) === norm(b);
};

router.put('/:id', requirePerm('ats', 'requirements', 'Requirement Detail', 'edit'), async (req, res, next) => {
  try {
    // VIEW != EDIT: holding the edit action is not enough — the record has to
    // be one this user is actually on, unless their scope is global.
    const perms = await requirementPermissions(req.user, req.requirement);
    if (!perms.edit) return res.status(403).json({ error: perms.readOnlyReason || OUT_OF_SCOPE.error });

    const before = req.requirement;
    const data = pickRequirement(req.body);

    // --- the assignment gate ------------------------------------------------
    const touchedAssignment = ASSIGNMENT_FIELDS
      .filter((k) => k in data && !sameValue(data[k], before[k]));
    if (touchedAssignment.length && !perms.assign) {
      return res.status(403).json({
        error: 'Changing the assignment chain is a scope change and needs the assign permission, '
          + 'not edit. Ask a TL or an admin to re-assign this requirement.',
        fields: touchedAssignment.map((k) => FIELD_LABELS[k] || k),
      });
    }
    // Fields the caller may not change are dropped rather than silently kept
    // in the update — a request that tried nothing is never refused, so an
    // edit form that round-trips unchanged assignment values still works.
    if (!perms.assign) ASSIGNMENT_FIELDS.forEach((k) => { delete data[k]; });

    // status only moves through /activate, /assign and /status, which enforce
    // the agreement gate — it is deliberately not editable here.
    delete data.status;
    // The client is not editable here either: moving a requirement to another
    // client re-decides the agreement gate and the whole commercial record.
    delete data.clientId;

    const changes = Object.keys(data)
      .filter((k) => !sameValue(data[k], before[k]))
      .map((k) => ({ field: k, label: FIELD_LABELS[k] || k, from: before[k], to: data[k] }));

    if (!changes.length) {
      return res.json({ ...before, unchanged: true });
    }

    const requirement = await prisma.requirement.update({ where: { id: before.id }, data });

    // One summary row for the activity strip …
    await logAudit({
      userId: req.user.id,
      action: 'Requirement updated',
      entity: 'Requirement',
      entityId: requirement.id,
      actorName: req.user.name,
      fromValue: `${changes.length} field(s)`,
      toValue: changes.map((c) => c.label).join(', '),
      reason: req.body.editReason || null,
    });
    // … and one row per field, so the trail says what actually changed.
    await logFieldChanges({
      userId: req.user.id,
      actorName: req.user.name,
      entity: 'Requirement',
      entityId: requirement.id,
      action: 'Requirement field changed',
      changes,
      approvalStatus: null, // an edit is not a review — see utils/audit.js
      reason: req.body.editReason || null,
    });

    // Someone whose assignment changed finds out, exactly as POST /:id/assign
    // already tells them.
    if (touchedAssignment.length) await notifyAssignment(requirement, req.user.id, 'assignment updated');

    return res.json({ ...requirement, changedFields: changes.map((c) => c.label) });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /:id/assign — the assignment chain.
//   Requirement -> Assigned TL -> Assigned Recruiter(s) -> BDE -> Client
// This is a SEPARATE permission from edit: a lead may re-assign work they do
// not otherwise edit, and a recruiter may edit a requirement they cannot
// re-assign.
// ---------------------------------------------------------------------------
router.post('/:id/assign', requirePerm('ats', 'requirements', 'Requirement Detail', 'assign'), async (req, res) => {
  const perms = await requirementPermissions(req.user, req.requirement);
  const s = scopeOf(req.user);
  // A lead assigning work for the first time is not yet "on" the record, so an
  // unassigned requirement inside their scope is assignable; a requirement
  // already owned by someone else is not, unless their scope is global.
  const unclaimed = !req.requirement.tlId && !req.requirement.recruiterId && !req.requirement.recruiterIds;
  if (!perms.assign && !(s.global || unclaimed)) {
    return res.status(403).json({ error: 'This requirement is assigned to someone else.' });
  }

  const before = req.requirement;
  const data = {};
  ['tlId', 'stlId', 'recruiterId', 'bdeId'].forEach((k) => {
    if (req.body[k] !== undefined) data[k] = req.body[k] || null;
  });
  if (req.body.recruiterIds !== undefined) {
    data.recruiterIds = Array.isArray(req.body.recruiterIds)
      ? req.body.recruiterIds.filter(Boolean).join(',')
      : (req.body.recruiterIds || null);
  }
  if (req.body.accountManager !== undefined) data.accountManager = req.body.accountManager || null;

  // Assigning a recruiter to a live requirement advances the workflow.
  const willHaveRecruiter = (data.recruiterId !== undefined ? data.recruiterId : before.recruiterId)
    || csv(data.recruiterIds !== undefined ? data.recruiterIds : before.recruiterIds).length;
  if (willHaveRecruiter && before.status === 'OPEN') data.status = 'RECRUITER_ASSIGNED';

  const requirement = await prisma.requirement.update({ where: { id: before.id }, data });
  await logAudit({
    userId: req.user.id,
    action: 'Requirement assignment changed',
    entity: 'Requirement',
    entityId: requirement.id,
    fromValue: [before.tlId, before.recruiterId, before.bdeId].filter(Boolean).join(' / ') || 'unassigned',
    toValue: [requirement.tlId, requirement.recruiterId, requirement.bdeId].filter(Boolean).join(' / ') || 'unassigned',
  });
  await notifyAssignment(requirement, req.user.id);
  res.json(requirement);
});

// Activate — the agreement gate. Draft / Agreement Check -> Open.
router.post('/:id/activate', requirePerm('ats', 'requirements', 'Requirement Detail', 'approve'), async (req, res) => {
  const existing = await prisma.requirement.findUnique({ where: { id: req.params.id }, include: { client: true } });
  if (requirementIsLive(existing.status)) return res.status(400).json({ error: 'This requirement is already open' });
  // The gate is an ACTIVE agreement, not merely a signed one. Internal
  // requirements have no client agreement to wait on.
  if (!existing.internal && !agreementIsActive(existing.client && existing.client.agreementStatus)) {
    await prisma.requirement.update({ where: { id: existing.id }, data: { status: 'AGREEMENT_CHECK' } });
    return res.status(400).json({
      error: 'Cannot activate — the client agreement is not yet Active. The requirement is held at Agreement Check.',
    });
  }

  const status = (existing.recruiterId || csv(existing.recruiterIds).length) ? 'RECRUITER_ASSIGNED' : 'OPEN';
  const requirement = await prisma.requirement.update({ where: { id: req.params.id }, data: { status } });
  await logAudit({
    userId: req.user.id, action: 'Requirement activated', entity: 'Requirement',
    entityId: requirement.id, fromValue: existing.status, toValue: status,
  });
  res.json(requirement);
});

// ---------------------------------------------------------------------------
// POST /:id/status — the rest of the workflow.
//   Draft -> Agreement Check -> Open -> Recruiter Assigned -> Sourcing
//     -> Candidates Available -> On Hold / Closed
// Each hop is checked: you cannot skip the agreement gate, you cannot say
// "Recruiter Assigned" with nobody assigned, and you cannot claim candidates
// are available when the pipeline is empty.
// ---------------------------------------------------------------------------
const NEXT_STATUS = {
  DRAFT: ['AGREEMENT_CHECK', 'OPEN', 'CLOSED'],
  AGREEMENT_CHECK: ['OPEN', 'DRAFT', 'CLOSED'],
  OPEN: ['RECRUITER_ASSIGNED', 'SOURCING', 'ON_HOLD', 'CLOSED'],
  RECRUITER_ASSIGNED: ['SOURCING', 'OPEN', 'ON_HOLD', 'CLOSED'],
  SOURCING: ['CANDIDATES_AVAILABLE', 'RECRUITER_ASSIGNED', 'ON_HOLD', 'CLOSED'],
  CANDIDATES_AVAILABLE: ['SOURCING', 'ON_HOLD', 'CLOSED'],
  ON_HOLD: ['OPEN', 'RECRUITER_ASSIGNED', 'SOURCING', 'CANDIDATES_AVAILABLE', 'CLOSED'],
  CLOSED: ['OPEN', 'DRAFT'],
};

router.post('/:id/status', requirePerm('ats', 'requirements', 'Requirement Detail', 'approve'), async (req, res) => {
  const existing = await prisma.requirement.findUnique({ where: { id: req.params.id }, include: { client: true, _count: { select: { applications: true } } } });
  const to = String(req.body.status || '').toUpperCase();
  if (!REQUIREMENT_STATUS_CODES.includes(to)) return res.status(400).json({ error: 'Unknown requirement status.' });
  const allowed = NEXT_STATUS[existing.status] || [];
  if (!allowed.includes(to)) {
    return res.status(400).json({ error: `A requirement in "${existing.status}" cannot move to "${to}".` });
  }
  if (requirementIsLive(to) && !existing.internal && !agreementIsActive(existing.client && existing.client.agreementStatus)) {
    return res.status(400).json({ error: 'Cannot go live — the client agreement is not Active.' });
  }
  if (to === 'RECRUITER_ASSIGNED' && !existing.recruiterId && !csv(existing.recruiterIds).length) {
    return res.status(400).json({ error: 'Assign a recruiter before moving to Recruiter Assigned.' });
  }
  if (to === 'CANDIDATES_AVAILABLE' && !existing._count.applications) {
    return res.status(400).json({ error: 'No candidates in the pipeline yet.' });
  }

  const requirement = await prisma.requirement.update({ where: { id: existing.id }, data: { status: to } });
  await logAudit({
    userId: req.user.id, action: 'Requirement status changed', entity: 'Requirement',
    entityId: requirement.id, fromValue: existing.status, toValue: to,
  });
  res.json(requirement);
});

// Open/close toggle — the prototype's toggleRequirementStatus(), kept so the
// existing button and any caller still work.
router.post('/:id/toggle-status', requirePerm('ats', 'requirements', 'Requirement Detail', 'approve'), async (req, res) => {
  const existing = req.requirement;
  const status = requirementIsLive(existing.status) ? 'CLOSED' : 'OPEN';
  if (status === 'OPEN' && !existing.internal) {
    const client = await prisma.client.findUnique({ where: { id: existing.clientId } });
    if (!agreementIsActive(client && client.agreementStatus)) {
      return res.status(400).json({ error: 'Cannot reopen — the client agreement is not Active.' });
    }
  }
  const requirement = await prisma.requirement.update({ where: { id: existing.id }, data: { status } });
  await logAudit({
    userId: req.user.id, action: 'Requirement status toggled', entity: 'Requirement',
    entityId: requirement.id, fromValue: existing.status, toValue: status,
  });
  res.json(requirement);
});

// Job Portal sync status. The portal itself is another module's; this records
// where the requirement stands with it, which the detail screen shows.
router.post('/:id/portal-sync', requirePerm('ats', 'requirements', 'Job Posting', 'edit'), async (req, res) => {
  const to = String(req.body.portalSyncStatus || '');
  if (!['Not Synced', 'Pending', 'Synced', 'Failed'].includes(to)) {
    return res.status(400).json({ error: 'Unknown portal sync status.' });
  }
  if (to === 'Synced' && !requirementIsLive(req.requirement.status)) {
    return res.status(400).json({ error: 'Only a live requirement can be marked Synced to the job portal.' });
  }
  const requirement = await prisma.requirement.update({
    where: { id: req.requirement.id },
    data: { portalSyncStatus: to },
  });
  await logAudit({
    userId: req.user.id, action: 'Job portal sync status set', entity: 'Requirement',
    entityId: requirement.id, fromValue: req.requirement.portalSyncStatus, toValue: to,
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
      row('Target date', requirement.targetDate),
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
