// ---------------------------------------------------------------------------
// THE ACTUAL WORKFLOW — live counts per box, in the signed-in user's scope.
//
// The groups themselves (which stage codes, which side of "Send to ATS",
// client vs internal, and the few rules a stage list cannot express) are
// defined ONCE in utils/atsVocab.js WORKFLOW_STAGE_GROUPS. This file only
// counts them: it loads the applications the user can reach
// (utils/scope.js applicationWhere — the same rule every list uses), gives
// each one the context a rule needs (duplicate check recorded? resume
// scored? last move came back from the TL? client guarantee days? invoice
// raised?) and asks atsVocab.inWorkflowGroup().
//
// Dashboards call countWorkflowGroups(user); the Workflow view calls
// workflowSnapshot(user) (counts + the flow diagram + requirement boxes);
// a box's drill-down calls listWorkflowGroup(user, groupId).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const {
  WORKFLOW_STAGE_GROUPS, WORKFLOW_FLOW, inWorkflowGroup, isPreAtsApplication,
  DUPLICATE_CHECK_ACTION, RESUME_SCORE_ACTION, PRE_ATS_SOURCES, HR_SOURCING_SOURCE,
  REQUIREMENT_LIVE_STATUSES, stageLabelFor, nextActionForStage, guaranteeEndOf,
} = require('./atsVocab');
const { applicationWhere, requirementWhere, atsScopeOf: scopeOf } = require('./scope');
const { hiringTypeOf, INTERNAL_HIRE } = require('./joining');

// "1 Month" / "30 Days" / "3 Months" / "1 Year" / "No replacement" -> days.
// Same arithmetic as routes/clients.js guaranteeDays() (Replacement /
// Guarantee column on the client list).
function guaranteeDaysOf(g) {
  const s = String(g || '').toLowerCase().trim();
  if (!s) return null;
  if (/no\s*replacement|^none$|^nil$/.test(s)) return 0;
  const m = s.match(/(\d+)\s*(day|week|month|year|yr|m\b)?/);
  if (!m) return null;
  const n = Number(m[1]);
  const u = m[2] || 'month';
  if (u.startsWith('day')) return n;
  if (u.startsWith('week')) return n * 7;
  if (u.startsWith('y')) return n * 365;
  return n * 30;
}

const APP_SELECT = {
  id: true,
  stage: true,
  source: true,
  firstSource: true,
  portalImportedAt: true,
  hiringType: true,
  joiningStatus: true,
  joiningDate: true,
  joinedAt: true,
  billingStatus: true,
  resumeScore: true,
  matchScore: true,
  aiInterviewScore: true,
  candidateId: true,
  requirementId: true,
  updatedAt: true,
};

const toDate = (v) => (v == null ? null : new Date(typeof v === 'bigint' ? Number(v) : v));
// The whole table for a company-wide login: one plain SELECT is ~3x faster
// than the ORM on ~24k rows. Scoped logins go through the ORM with their
// scope fragment (utils/scope.js applicationWhere), which is far fewer rows.
async function loadBare(user) {
  const where = applicationWhere(user);
  if (Object.keys(where).length) return prisma.application.findMany({ where, select: APP_SELECT });
  const raw = await prisma.$queryRawUnsafe(
    'SELECT id, stage, source, firstSource, portalImportedAt, hiringType, joiningStatus, joiningDate, joinedAt, '
    + 'billingStatus, resumeScore, matchScore, aiInterviewScore, candidateId, requirementId, updatedAt FROM "Application"',
  );
  return raw.map((a) => ({
    ...a,
    portalImportedAt: toDate(a.portalImportedAt),
    joinedAt: toDate(a.joinedAt),
    updatedAt: toDate(a.updatedAt),
    resumeScore: a.resumeScore == null ? null : Number(a.resumeScore),
    matchScore: a.matchScore == null ? null : Number(a.matchScore),
    aiInterviewScore: a.aiInterviewScore == null ? null : Number(a.aiInterviewScore),
  }));
}

// A dashboard, the ATS dashboard's workflow strip and the Workflow view can
// all ask within the same few seconds; the answer is shared per login for
// CACHE_MS. Moves made in between show on the next refresh.
const CACHE_MS = 15000;
const cache = new Map();

// Every application in scope, each with the context its rules need.
async function loadContexts(user, { fresh = false } = {}) {
  const key = user && user.id;
  const hit = key && cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.loaded;
  const loaded = await loadContextsNow(user);
  if (key) {
    cache.set(key, { at: Date.now(), loaded });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
  }
  return loaded;
}

async function loadContextsNow(user) {
  // The requirement side is loaded once per requirement and joined in memory:
  // a relation select on ~24k applications costs seconds on SQLite.
  const bare = await loadBare(user);
  const reqIds = [...new Set(bare.map((a) => a.requirementId))];
  const reqs = [];
  for (let i = 0; i < reqIds.length; i += 900) {
    // eslint-disable-next-line no-await-in-loop
    reqs.push(...await prisma.requirement.findMany({
      where: { id: { in: reqIds.slice(i, i + 900) } },
      select: { id: true, internal: true, hiringType: true, clientId: true, client: { select: { guaranteePeriod: true } } },
    }));
  }
  const reqById = new Map(reqs.map((r) => [r.id, r]));
  const rows = bare.map((a) => ({ ...a, requirement: reqById.get(a.requirementId) || null }));
  const pre = rows.filter(isPreAtsApplication);
  const preIds = pre.map((a) => a.id);
  const returnable = rows.filter((a) => !isPreAtsApplication(a) && ['RECRUITER_REVIEW', 'RECRUITER_APPROVED'].includes(a.stage));
  const joinedClient = rows.filter((a) => ['JOINED', 'HIRED'].includes(a.stage) && hiringTypeOf(a, a.requirement) !== INTERNAL_HIRE);

  const [screenEvents, lastEvents, invoices] = await Promise.all([
    preIds.length ? prisma.applicationStageEvent.findMany({
      where: { applicationId: { in: preIds }, OR: [{ action: { startsWith: DUPLICATE_CHECK_ACTION } }, { action: { startsWith: RESUME_SCORE_ACTION } }] },
      select: { applicationId: true, action: true },
    }) : [],
    returnable.length ? prisma.applicationStageEvent.findMany({
      where: { applicationId: { in: returnable.map((a) => a.id) } },
      select: { applicationId: true, fromStage: true, toStage: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }) : [],
    joinedClient.length ? prisma.invoice.findMany({
      where: { candidateId: { in: [...new Set(joinedClient.map((a) => a.candidateId))] } },
      select: { id: true, candidateId: true, requirementId: true, status: true },
    }) : [],
  ]);
  const dup = new Set(screenEvents.filter((e) => e.action.startsWith(DUPLICATE_CHECK_ACTION)).map((e) => e.applicationId));
  const scored = new Set(screenEvents.filter((e) => e.action.startsWith(RESUME_SCORE_ACTION)).map((e) => e.applicationId));
  const lastFrom = new Map();
  lastEvents.forEach((e) => { if (!lastFrom.has(e.applicationId)) lastFrom.set(e.applicationId, e.fromStage); });
  const invByPair = new Map(invoices.map((i) => [`${i.candidateId}|${i.requirementId}`, i]));

  const today = new Date();
  return {
    rows: rows.map((a) => ({
      a,
      ctx: {
        internal: hiringTypeOf(a, a.requirement) === INTERNAL_HIRE,
        duplicateChecked: dup.has(a.id),
        resumeScored: scored.has(a.id) || a.resumeScore != null,
        lastFromStage: lastFrom.get(a.id) || null,
        guaranteeDays: guaranteeDaysOf(a.requirement && a.requirement.client && a.requirement.client.guaranteePeriod),
        today,
        hasInvoice: invByPair.has(`${a.candidateId}|${a.requirementId}`),
        invoice: invByPair.get(`${a.candidateId}|${a.requirementId}`) || null,
      },
    })),
    invoices: [...invByPair.values()].filter((i) => joinedClient.some((a) => a.candidateId === i.candidateId && a.requirementId === i.requirementId)),
  };
}

function countFrom(loaded) {
  const counts = {};
  Object.entries(WORKFLOW_STAGE_GROUPS).forEach(([id, g]) => {
    if (g.entity === 'invoice') {
      counts[id] = loaded.invoices.filter((i) => g.invoiceStatuses.includes(i.status)).length;
      return;
    }
    let n = 0;
    loaded.rows.forEach(({ a, ctx }) => { if (inWorkflowGroup(id, a, ctx)) n += 1; });
    counts[id] = n;
  });
  return counts;
}

// { GROUP_ID: count } for every group in atsVocab.WORKFLOW_STAGE_GROUPS.
async function countWorkflowGroups(user, opts = {}) {
  return countFrom(await loadContexts(user, opts));
}

// Counts + the requirement boxes + the flow with a count on every box.
async function workflowSnapshot(user, opts = {}) {
  const loaded = await loadContexts(user, opts);
  const counts = countFrom(loaded);
  const s = scopeOf(user);
  const rw = requirementWhere(user);
  const reqWhere = (extra) => (Object.keys(rw).length ? { AND: [rw, extra] } : extra);
  const [clientReqs, published, internalReqs] = await Promise.all([
    prisma.requirement.count({ where: reqWhere({ internal: false, status: { in: REQUIREMENT_LIVE_STATUSES } }) }),
    prisma.requirement.count({ where: reqWhere({ internal: false, portalPublished: true, status: { in: REQUIREMENT_LIVE_STATUSES } }) }),
    prisma.requirement.count({ where: reqWhere({ internal: true, status: { in: REQUIREMENT_LIVE_STATUSES } }) }),
  ]);
  const intake = loaded.rows.filter(({ a }) => PRE_ATS_SOURCES.includes(String(a.source || '')));
  const bySource = {};
  intake.forEach(({ a }) => {
    const k = a.source === HR_SOURCING_SOURCE ? HR_SOURCING_SOURCE : (a.firstSource || a.source || 'Job Portal');
    bySource[k] = (bySource[k] || 0) + 1;
  });
  const extra = {
    'requirements.client': clientReqs,
    'requirements.published': published,
    'requirements.internal': internalReqs,
    sources: intake.filter(({ a }) => a.source !== HR_SOURCING_SOURCE).length,
    hrSourced: intake.filter(({ a }) => a.source === HR_SOURCING_SOURCE).length,
  };
  const withCounts = (boxes) => boxes.map((b) => ({
    ...b,
    count: b.group ? counts[b.group] : (b.count ? extra[b.count] : null),
    also: b.also ? { ...b.also, count: counts[b.also.group] } : undefined,
  }));
  return {
    asOf: new Date().toISOString(),
    scope: s.global ? 'All' : (s.atsRole || s.role || ''),
    counts,
    sources: bySource,
    flow: {
      requirement: withCounts(WORKFLOW_FLOW.requirement),
      pre: withCounts(WORKFLOW_FLOW.pre),
      client: withCounts(WORKFLOW_FLOW.client),
      internal: withCounts(WORKFLOW_FLOW.internal),
    },
  };
}

// The applications behind one box, newest first, shaped for a table.
async function listWorkflowGroup(user, groupId, { limit = 200, fresh = false } = {}) {
  const g = WORKFLOW_STAGE_GROUPS[groupId];
  if (!g) return null;
  const loaded = await loadContexts(user, { fresh });
  if (g.entity === 'invoice') {
    const ids = loaded.invoices.filter((i) => g.invoiceStatuses.includes(i.status)).map((i) => i.id);
    const inv = await prisma.invoice.findMany({
      where: { id: { in: ids } },
      include: { client: { select: { name: true } }, candidate: { select: { id: true, name: true } }, requirement: { select: { id: true, title: true } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return {
      group: groupId, label: g.label, entity: 'invoice', total: ids.length,
      rows: inv.map((i) => ({
        id: i.id, invoiceNumber: i.invoiceNumber, client: i.client && i.client.name,
        candidateId: i.candidate && i.candidate.id, candidate: i.candidate && i.candidate.name,
        requirementId: i.requirement && i.requirement.id, requirement: i.requirement && i.requirement.title,
        amount: i.amount, gst: i.gst, tds: i.tds, receivedAmount: i.receivedAmount, status: i.status,
        invoiceDate: i.invoiceDate, dueDate: i.dueDate,
      })),
    };
  }
  const hits = loaded.rows.filter(({ a, ctx }) => inWorkflowGroup(groupId, a, ctx))
    .sort((x, y) => new Date(y.a.updatedAt) - new Date(x.a.updatedAt));
  const page = hits.slice(0, limit);
  const full = await prisma.application.findMany({
    where: { id: { in: page.map((h) => h.a.id) } },
    include: {
      candidate: { select: { id: true, name: true } },
      requirement: { select: { id: true, reqCode: true, title: true, department: true, internal: true, client: { select: { name: true } } } },
    },
  });
  const byId = new Map(full.map((f) => [f.id, f]));
  return {
    group: groupId, label: g.label, entity: 'application', total: hits.length,
    rows: page.map(({ a, ctx }) => {
      const f = byId.get(a.id) || {};
      const end = guaranteeEndOf(a, ctx.guaranteeDays);
      return {
        id: a.id,
        candidateId: f.candidate && f.candidate.id,
        candidate: f.candidate && f.candidate.name,
        requirementId: f.requirement && f.requirement.id,
        requirement: f.requirement && f.requirement.title,
        reqCode: f.requirement && f.requirement.reqCode,
        department: f.requirement && f.requirement.department,
        client: f.requirement ? (f.requirement.internal ? 'TeamLink Internal' : f.requirement.client && f.requirement.client.name) : null,
        hiring: ctx.internal ? 'Internal' : 'Client',
        stage: a.stage,
        stageLabel: stageLabelFor(a.stage, { internal: ctx.internal }),
        nextAction: nextActionForStage(a.stage, { internal: ctx.internal }),
        preAts: isPreAtsApplication(a),
        joiningStatus: a.joiningStatus,
        guaranteeEnds: end ? end.toISOString().slice(0, 10) : null,
        updatedAt: a.updatedAt,
      };
    }),
  };
}

module.exports = {
  guaranteeDaysOf, countWorkflowGroups, workflowSnapshot, listWorkflowGroup, loadContexts,
};
