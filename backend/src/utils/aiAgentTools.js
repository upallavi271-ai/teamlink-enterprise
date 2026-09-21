// ---------------------------------------------------------------------------
// The AI agent's tool surface — this app's own data, and nothing else.
//
// THE RULE THAT MATTERS
// Every tool here reads data EXACTLY the way a route does:
//
//   1. can(user, product, module, feature, action) — the permission engine in
//      utils/permissions.js. No tool runs without it, and a refusal is
//      returned to the model as text so it can say so honestly.
//   2. requirementWhere / candidateWhere / applicationWhere / clientWhere from
//      utils/scope.js, spread into the Prisma query. The scope is part of the
//      WHERE clause, not a filter applied afterwards.
//   3. For a CLIENT login, the extra "was this profile actually shared with
//      you" gate, the same one routes/candidates.js applies.
//
// There is no second permission path and no service-account read. If the API
// would refuse the asking user, the agent refuses too — ask it for a candidate
// on somebody else's requirement and it reports that it cannot see one.
//
// Scores are NEVER invented by the model: match numbers come from
// utils/matching.js, stage names from utils/atsVocab.js.
// ---------------------------------------------------------------------------

const prisma = require('../db');
const { can } = require('./permissions');
const {
  scopeOf, requirementWhere, candidateWhere, applicationWhere, clientWhere,
  matches, CLIENT_SHARED_STAGES,
} = require('./scope');
const { computeMatch, rankCandidates, MATCH_THRESHOLD } = require('./matching');
const {
  stageLabel, applicationNextAction, applicationDueDate, applicationIsOverdue,
  applicationOwner, REQUIREMENT_LIVE_STATUSES,
} = require('./atsVocab');

// How many rows any one tool call may return. The model does not need more,
// and an unbounded read is an unbounded bill.
const LIMIT = 25;

const DENIED = (what) => ({
  denied: true,
  message: `Refused: your role does not have permission to ${what}. Nothing was read.`,
});

function short(s, n = 300) {
  const v = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return v.length > n ? `${v.slice(0, n)}…` : v;
}

// --- shaping ---------------------------------------------------------------
function shapeRequirement(r) {
  return {
    id: r.id,
    title: r.title,
    client: r.internal ? 'TeamLink (internal)' : (r.client ? r.client.name : null),
    status: r.status,
    department: r.department,
    location: r.location,
    workMode: r.workMode || null,
    employmentType: r.employmentType || null,
    openings: r.openings,
    priority: r.priority,
    experience: r.experience || null,
    relevantExperience: r.relevantExperience || null,
    salary: r.salary || null,
    mandatorySkills: r.skills || null,
    goodToHaveSkills: r.goodToHaveSkills || null,
    education: r.education || null,
    qualifications: short(r.qualifications, 400),
    responsibilities: short(r.responsibilities, 600),
    noticePeriodMax: r.noticePeriodMax || null,
    closingDate: r.closingDate || null,
    description: short(r.description || r.jobDescription, 600),
  };
}

function shapeCandidate(c) {
  return {
    id: c.id,
    name: c.name,
    email: c.email || null,
    phone: c.phone || null,
    currentDesignation: c.currentDesignation || null,
    currentCompany: c.currentCompany || null,
    experienceYears: c.experienceYears,
    relevantExperienceYears: c.relevantExperienceYears,
    location: c.location || null,
    preferredLocation: c.preferredLocation || null,
    mandatorySkills: c.skills || null,
    goodToHaveSkills: c.goodToHaveSkills || null,
    education: c.education || null,
    specialization: c.specialization || null,
    expectedSalary: c.expectedSalary || null,
    source: c.source || null,
    noticePeriod: c.noticePeriod || null,
    resumeScore: c.resumeScore,
  };
}

function shapeApplication(a) {
  return {
    applicationId: a.id,
    candidate: a.candidate ? a.candidate.name : null,
    candidateId: a.candidateId,
    requirement: a.requirement ? a.requirement.title : null,
    requirementId: a.requirementId,
    client: a.requirement && a.requirement.client ? a.requirement.client.name : null,
    stage: a.stage,
    stageLabel: stageLabel(a.stage),
    owner: applicationOwner(a, a.requirement),
    nextAction: applicationNextAction(a),
    due: applicationDueDate(a),
    overdue: applicationIsOverdue(a),
  };
}

// A CLIENT login only sees profiles that were actually shared with them —
// the same two-part test routes/candidates.js runs.
async function clientSharedGate(user, applications) {
  const s = scopeOf(user);
  if (s.role !== 'CLIENT' && s.atsRole !== 'CLIENT') return null;
  const shared = new Set(applications.filter((a) => CLIENT_SHARED_STAGES.includes(a.stage)).map((a) => a.id));
  const ids = applications.map((a) => a.id);
  if (ids.length) {
    const events = await prisma.applicationStageEvent.findMany({
      where: { applicationId: { in: ids }, toStage: { in: CLIENT_SHARED_STAGES } },
      select: { applicationId: true },
    });
    events.forEach((e) => shared.add(e.applicationId));
  }
  return shared;
}

// ---------------------------------------------------------------------------
// The tools. Each entry is { name, description, input_schema, run(user, input) }.
// `run` returns a plain object; the route JSON-stringifies it into the
// tool_result block.
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'my_pending_actions',
    description: 'The queues and individual items waiting on the signed-in user right now, with the one next action for each. Use this for "what should I do next", "what is waiting on me", "my queue".',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    async run(user) {
      if (!await can(user, null, 'dashboard', 'Pending Approvals', 'view')) return DENIED('see the pending-actions dashboard');
      const apps = await prisma.application.findMany({
        where: applicationWhere(user),
        include: { candidate: true, requirement: { include: { client: true } } },
        orderBy: { updatedAt: 'desc' },
        take: 200,
      });
      const shared = await clientSharedGate(user, apps);
      const visible = shared ? apps.filter((a) => shared.has(a.id)) : apps;
      const open = visible.filter((a) => !['JOINED', 'HIRED', 'REJECTED'].includes(a.stage));
      const rows = open.map(shapeApplication)
        .sort((a, b) => String(a.due || '9999').localeCompare(String(b.due || '9999')));
      const byStage = {};
      open.forEach((a) => { byStage[stageLabel(a.stage)] = (byStage[stageLabel(a.stage)] || 0) + 1; });
      return {
        totalOpen: open.length,
        overdue: rows.filter((r) => r.overdue).length,
        byStage,
        items: rows.slice(0, LIMIT),
        note: 'Scoped to this user by utils/scope.js — these are their own items, not the whole company.',
      };
    },
  },

  {
    name: 'search_requirements',
    description: 'Find requirements (job openings) the signed-in user is allowed to see. Filter by free text on the title, by status, or by department. Returns at most 25.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to look for in the title, skills or description.' },
        status: { type: 'string', description: 'Requirement status code, e.g. OPEN, SOURCING, CLOSED. Omit for any.' },
        department: { type: 'string' },
        openOnly: { type: 'boolean', description: 'Only requirements that are still live.' },
      },
      additionalProperties: false,
    },
    async run(user, input) {
      if (!await can(user, 'ats', 'requirements', 'Requirement List', 'view')) return DENIED('view requirements');
      const where = { ...requirementWhere(user) };
      const and = [];
      if (input.query) {
        and.push({
          OR: [
            { title: { contains: input.query } },
            { skills: { contains: input.query } },
            { description: { contains: input.query } },
          ],
        });
      }
      if (input.status) and.push({ status: input.status });
      if (input.department) and.push({ department: input.department });
      if (input.openOnly) and.push({ status: { in: REQUIREMENT_LIVE_STATUSES } });
      if (and.length) where.AND = and;
      const rows = await prisma.requirement.findMany({
        where, include: { client: true }, orderBy: { createdAt: 'desc' }, take: LIMIT,
      });
      return { count: rows.length, requirements: rows.map(shapeRequirement) };
    },
  },

  {
    name: 'get_requirement',
    description: 'Full detail for one requirement, plus its pipeline: how many candidates sit at each stage. Use before drafting a job description or summarising a role.',
    input_schema: {
      type: 'object',
      properties: { requirementId: { type: 'string' } },
      required: ['requirementId'],
      additionalProperties: false,
    },
    async run(user, input) {
      if (!await can(user, 'ats', 'requirements', 'Requirement Detail', 'view')) return DENIED('view requirement detail');
      const r = await prisma.requirement.findUnique({
        where: { id: String(input.requirementId) }, include: { client: true },
      });
      if (!r) return { notFound: true, message: 'No such requirement.' };
      // Record-level scope: the same where fragment, evaluated against this row.
      if (!matches(r, requirementWhere(user))) {
        return { denied: true, message: 'Refused: that requirement is outside your access scope.' };
      }
      const apps = await prisma.application.findMany({
        where: { requirementId: r.id, ...applicationWhere(user) },
        include: { candidate: true },
      });
      const pipeline = {};
      apps.forEach((a) => { pipeline[stageLabel(a.stage)] = (pipeline[stageLabel(a.stage)] || 0) + 1; });
      return { requirement: shapeRequirement(r), pipelineCount: apps.length, pipeline };
    },
  },

  {
    name: 'search_candidates',
    description: 'Find candidates the signed-in user is allowed to see, by name, skill or email. A client login only gets profiles that were actually shared with them. Returns at most 25.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name, skill, email or location text.' },
        requirementId: { type: 'string', description: 'Only candidates who applied to this requirement.' },
        stage: { type: 'string', description: 'Only candidates whose application is at this pipeline stage code.' },
      },
      additionalProperties: false,
    },
    async run(user, input) {
      if (!await can(user, 'ats', 'candidates', 'Candidate List', 'view')) return DENIED('view candidates');
      const where = { ...candidateWhere(user) };
      const and = [];
      if (input.query) {
        and.push({
          OR: [
            { name: { contains: input.query } },
            { skills: { contains: input.query } },
            { email: { contains: input.query } },
            { location: { contains: input.query } },
          ],
        });
      }
      if (input.requirementId || input.stage) {
        and.push({
          applications: {
            some: {
              ...applicationWhere(user),
              ...(input.requirementId ? { requirementId: String(input.requirementId) } : {}),
              ...(input.stage ? { stage: String(input.stage) } : {}),
            },
          },
        });
      }
      if (and.length) where.AND = and;
      const rows = await prisma.candidate.findMany({
        where,
        include: { applications: { include: { requirement: { include: { client: true } } } } },
        orderBy: { createdAt: 'desc' },
        take: LIMIT,
      });
      const allApps = rows.flatMap((c) => c.applications || []);
      const shared = await clientSharedGate(user, allApps);
      const out = rows
        .map((c) => {
          const apps = (c.applications || []).filter((a) => (shared ? shared.has(a.id) : true));
          return { ...shapeCandidate(c), applications: apps.map(shapeApplication) };
        })
        // A client whose only route to this candidate was an unshared
        // application must not see the candidate at all.
        .filter((c) => (shared ? c.applications.length > 0 : true));
      return { count: out.length, candidates: out };
    },
  },

  {
    name: 'summarise_candidate_against_requirement',
    description: "Score one candidate against one requirement using this app's own matching engine (utils/matching.js) and return the score with the reasons and gaps it produced. Always use this rather than estimating a fit yourself.",
    input_schema: {
      type: 'object',
      properties: {
        candidateId: { type: 'string' },
        requirementId: { type: 'string' },
      },
      required: ['candidateId', 'requirementId'],
      additionalProperties: false,
    },
    async run(user, input) {
      if (!await can(user, 'ats', 'candidates', 'Resume & Scores', 'view')) return DENIED('view candidate scores');
      const [c, r] = await Promise.all([
        prisma.candidate.findUnique({ where: { id: String(input.candidateId) } }),
        prisma.requirement.findUnique({ where: { id: String(input.requirementId) }, include: { client: true } }),
      ]);
      if (!c || !r) return { notFound: true, message: 'Candidate or requirement not found.' };
      if (!matches(r, requirementWhere(user))) {
        return { denied: true, message: 'Refused: that requirement is outside your access scope.' };
      }
      // Reachability for the candidate is the same query the list uses.
      const reachable = await prisma.candidate.findFirst({
        where: { id: c.id, ...candidateWhere(user) }, select: { id: true },
      });
      if (!reachable) return { denied: true, message: 'Refused: that candidate is outside your access scope.' };
      const match = computeMatch(c, r);
      return {
        candidate: shapeCandidate(c),
        requirement: shapeRequirement(r),
        match: {
          overall: match.overall,
          threshold: MATCH_THRESHOLD,
          reasons: match.reasons,
          gaps: match.gaps,
          matchedSkills: match.matchedSkills,
          missingSkills: match.missingSkills,
          breakdown: {
            mandatorySkills: match.skillsPct,
            goodToHave: match.goodPct,
            experience: match.expPct,
            relevantExperience: match.relevPct,
            education: match.eduPct,
            location: match.locPct,
            workMode: match.modePct,
            employmentType: match.empPct,
            salary: match.salPct,
            notice: match.notPct,
          },
        },
        note: 'Scores come from utils/matching.js, not from the model.',
      };
    },
  },

  {
    name: 'top_matches_for_requirement',
    description: "The best-matching candidates on file for one requirement, ranked by this app's matching engine. Use for 'who should I put forward for X'.",
    input_schema: {
      type: 'object',
      properties: {
        requirementId: { type: 'string' },
        limit: { type: 'integer', description: 'How many to return, 1-10.' },
      },
      required: ['requirementId'],
      additionalProperties: false,
    },
    async run(user, input) {
      if (!await can(user, 'ats', 'requirements', 'Matching Candidates', 'view')) return DENIED('view matching candidates');
      const r = await prisma.requirement.findUnique({ where: { id: String(input.requirementId) }, include: { client: true } });
      if (!r) return { notFound: true, message: 'No such requirement.' };
      if (!matches(r, requirementWhere(user))) {
        return { denied: true, message: 'Refused: that requirement is outside your access scope.' };
      }
      const pool = await prisma.candidate.findMany({ where: candidateWhere(user), take: 400 });
      const ranked = rankCandidates(pool, r).slice(0, Math.min(Math.max(Number(input.limit) || 5, 1), 10));
      return {
        requirement: shapeRequirement(r),
        matches: ranked.map((c) => ({
          ...shapeCandidate(c),
          score: c.match.overall,
          reasons: c.match.reasons,
          gaps: c.match.gaps,
        })),
        note: 'Ranked by utils/matching.js over the candidates this user can see.',
      };
    },
  },

  {
    name: 'job_description_facts',
    description: 'The facts to draft a job description from, for one requirement: title, client, skills, experience, budget, location and the existing description. Call this first, then write the JD yourself from what it returns — do not invent a requirement.',
    input_schema: {
      type: 'object',
      properties: { requirementId: { type: 'string' } },
      required: ['requirementId'],
      additionalProperties: false,
    },
    async run(user, input) {
      // Drafting a JD is a Requirement Detail read. Writing it back is not
      // this tool's job — the agent never writes.
      if (!await can(user, 'ats', 'requirements', 'Requirement Detail', 'view')) return DENIED('view requirement detail');
      const r = await prisma.requirement.findUnique({ where: { id: String(input.requirementId) }, include: { client: true } });
      if (!r) return { notFound: true, message: 'No such requirement.' };
      if (!matches(r, requirementWhere(user))) {
        return { denied: true, message: 'Refused: that requirement is outside your access scope.' };
      }
      return {
        facts: shapeRequirement(r),
        internal: !!r.internal,
        note: 'Draft from these facts only. The agent cannot save a description — the user does that on the requirement screen.',
      };
    },
  },

  {
    name: 'list_clients',
    description: 'The clients the signed-in user can see, with how many live requirements each has.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      additionalProperties: false,
    },
    async run(user, input) {
      if (!await can(user, 'ats', 'clients', 'Client List', 'view')) return DENIED('view clients');
      const where = { ...clientWhere(user) };
      if (input.query) where.name = { contains: input.query };
      const rows = await prisma.client.findMany({
        where, include: { requirements: { select: { status: true } } }, take: LIMIT,
      });
      return {
        count: rows.length,
        clients: rows.map((c) => ({
          id: c.id,
          name: c.name,
          industry: c.industry || null,
          status: c.status || null,
          agreementStatus: c.agreementStatus || null,
          liveRequirements: (c.requirements || []).filter((r) => REQUIREMENT_LIVE_STATUSES.includes(r.status)).length,
        })),
      };
    },
  },
];

const TOOL_BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

// What the Anthropic API is sent. The `run` function stays on this side.
function toolDefinitions() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

// Execute one tool call for one user. Never throws: a failure comes back as a
// tool result the model can read and report.
async function runTool(user, name, input) {
  const tool = TOOL_BY_NAME[name];
  if (!tool) return { error: `Unknown tool ${name}.` };
  try {
    return await tool.run(user, input && typeof input === 'object' ? input : {});
  } catch (err) {
    return { error: `That lookup failed: ${short((err && err.message) || err, 200)}` };
  }
}

module.exports = { TOOLS, toolDefinitions, runTool, LIMIT };
