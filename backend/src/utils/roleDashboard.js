// ---------------------------------------------------------------------------
// ROLE DASHBOARDS (user spec 2026-09-29, scratchpad dashboards-spec.md).
//
// Every role's board has four parts: (A) top counts, (B) pending actions,
// (C) lists / widgets, (D) quick buttons. This file builds them, server side
// and in the reader's own scope:
//
//   recruiter   Recruiter (and HR for internal hiring, internal wording)
//   tl          TL, and STL at department scope (scope.js does the widening)
//   bde         BDE / Client Manager
//   management  Manager / Assistant Manager (read-only), Super Admin / Admin
//   admin       Super Admin / Admin
//   accounts    the Accountant's desk (routes/dashboard.js /accounts/desk)
//   today       the top bar's "Today's tasks"
//
// COUNTS COME FROM THE WORKFLOW STAGE GROUPS (utils/atsVocab.js
// WORKFLOW_STAGE_GROUPS, counted per application by utils/workflowFlow.js
// loadContexts — the same loaded rows and the same inWorkflowGroup() test the
// Workflow view uses). Nothing here re-derives a stage list for a group.
//
// EVERY COUNT OPENS EXACTLY ITS LIST. A count either links to a list page
// whose own filter reproduces it (`to`), or names a SET (`drill`) that
// GET /api/dashboard/ats/role/list?view=&set= returns row by row — built by
// the very same function, so the number and the list cannot disagree.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const V = require('./atsVocab');
const {
  applicationWhere, requirementWhere, scopeOf, invoiceWhere,
} = require('./scope');
const { loadContexts, listWorkflowGroup, guaranteeDaysOf } = require('./workflowFlow');
const { hiringTypeOf, INTERNAL_HIRE } = require('./joining');
const A = require('./accounts');
const dateRange = require('./dateRange');

const DAY = 86400000;
const iso = (d) => d.toISOString().slice(0, 10);
const dt = (s) => new Date(`${s}T00:00:00.000Z`);
const addDays = (s, n) => iso(new Date(dt(s).getTime() + n * DAY));

// UTC days, the same "today" the rest of the app (and the follow-ups) use.
function days() {
  const t = iso(new Date());
  const tDate = dt(t);
  const y = tDate.getUTCFullYear();
  const m = tDate.getUTCMonth();
  return {
    t,
    todayStart: tDate,
    tomorrowStart: dt(addDays(t, 1)),
    weekStart: addDays(t, -((tDate.getUTCDay() + 6) % 7)),
    weekEnd: addDays(addDays(t, -((tDate.getUTCDay() + 6) % 7)), 6),
    monthStart: iso(new Date(Date.UTC(y, m, 1))),
    monthKey: t.slice(0, 7),
    prevMonthStart: iso(new Date(Date.UTC(y, m - 1, 1))),
    prevMonthEnd: iso(new Date(Date.UTC(y, m, 0))),
    prevMonthKey: iso(new Date(Date.UTC(y, m - 1, 1))).slice(0, 7),
    quarterStart: iso(new Date(Date.UTC(y, m - (m % 3), 1))),
    y,
    m,
  };
}

const LIVE_REQ = V.REQUIREMENT_LIVE_STATUSES;
const REVIEW_STAGES = ['NEW', 'AI_INTERVIEW_REQUIRED', 'AI_INTERVIEW_SCHEDULED', 'AI_INTERVIEW_COMPLETED',
  'RECRUITER_REVIEW', 'RECRUITER_APPROVED'];
// "Submission" = the application ENTERED the client chain (Client
// Submission, or any later client step for a row that skipped it).
const CLIENT_CHAIN = ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'CLIENT_SHORTLISTED', 'INTERVIEW_SCHEDULED',
  'INTERVIEW_COMPLETED', 'SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED'];
const INTERVIEW_ON = ['INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED', 'SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED'];
const SELECTED_ON = ['SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED'];
const JOINED_STAGES = ['JOINED', 'HIRED'];
const CLOSED = ['REJECTED', 'HOLD', 'JOINED', 'HIRED'];
const LIVE_INTERVIEW = { OR: [{ interviewStatus: null }, { interviewStatus: { notIn: ['CANCELLED', 'NO_SHOW'] } }] };
const LEFT_STATUSES = [V.JOINING_REPLACEMENT_DUE, V.JOINING_REPLACED, V.JOINING_LEFT_AFTER_GUARANTEE, 'Dropped'];

const and = (...parts) => {
  const p = parts.filter((x) => x && Object.keys(x).length);
  if (!p.length) return {};
  return p.length === 1 ? p[0] : { AND: p };
};
const fmtN = (n) => Number(n || 0).toLocaleString('en-IN');
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

// ---- the board: counts, lists, widgets, quick buttons, drillable sets -----
function newBoard(view, title) {
  return {
    view, title, counts: [], pending: [], widgets: [], quick: [], notes: [],
    sets: new Map(),
  };
}
// kind: 'group' (a workflow group, listed by workflowFlow.listWorkflowGroup)
//       'app' | 'req' | 'inv' | 'pay' | 'user' | 'cand' (ids, shaped below)
function addSet(b, id, def) { b.sets.set(id, { id, ...def }); return id; }

function toneFor(due, t) {
  if (!due) return 'green';
  if (due < t) return 'red';
  if (due === t) return 'amber';
  return 'green';
}

// ---- row shaping ------------------------------------------------------------
async function shapeApps(ids, { extra = new Map(), clientDesk = false, limit = 300 } = {}) {
  const page = ids.slice(0, limit);
  if (!page.length) return [];
  const full = [];
  for (let i = 0; i < page.length; i += 900) {
    // eslint-disable-next-line no-await-in-loop
    full.push(...await prisma.application.findMany({
      where: { id: { in: page.slice(i, i + 900) } },
      select: {
        id: true, candidateId: true, requirementId: true, stage: true, updatedAt: true, createdAt: true,
        resumeScore: true, matchScore: true, aiInterviewScore: true, interviewAt: true, interviewStatus: true,
        joiningDate: true, joiningStatus: true, hiringType: true, source: true,
        candidate: { select: { name: true, resumeScore: true } },
        requirement: {
          select: {
            title: true, reqCode: true, internal: true, hiringType: true, clientId: true,
            client: { select: { name: true } }, recruiter: { select: { name: true } }, bde: { select: { name: true } },
          },
        },
      },
    }));
  }
  const byId = new Map(full.map((f) => [f.id, f]));
  return page.map((id) => {
    const f = byId.get(id);
    if (!f) return null;
    const r = f.requirement || {};
    const internal = hiringTypeOf(f, r) === INTERNAL_HIRE;
    return {
      id: f.id,
      candidateId: f.candidateId,
      candidate: f.candidate ? f.candidate.name : '—',
      requirementId: f.requirementId,
      requirement: r.title || '—',
      reqCode: r.reqCode || null,
      client: internal ? 'TeamLink Internal' : (r.client ? r.client.name : null),
      clientId: clientDesk && !internal ? r.clientId || null : null,
      recruiter: r.recruiter ? r.recruiter.name : null,
      bde: r.bde ? r.bde.name : null,
      internal,
      stage: f.stage,
      stageLabel: V.stageLabelFor(f.stage, { internal }),
      resumeScore: f.resumeScore ?? f.matchScore ?? (f.candidate ? f.candidate.resumeScore : null) ?? null,
      aiScore: f.aiInterviewScore ?? null,
      interviewAt: f.interviewAt,
      joiningDate: f.joiningDate,
      joiningStatus: f.joiningStatus,
      updatedAt: f.updatedAt,
      createdAt: f.createdAt,
      ...(extra.get(id) || {}),
    };
  }).filter(Boolean);
}

async function shapeReqs(ids, { clientDesk = false, limit = 300 } = {}) {
  const page = ids.slice(0, limit);
  if (!page.length) return [];
  const rows = await prisma.requirement.findMany({
    where: { id: { in: page } },
    select: {
      id: true, title: true, reqCode: true, status: true, openings: true, internal: true, clientId: true, createdAt: true,
      department: true, client: { select: { name: true } }, recruiter: { select: { name: true } },
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return page.map((id) => byId.get(id)).filter(Boolean).map((r) => ({
    id: r.id, title: r.title, reqCode: r.reqCode, status: V.requirementStatusLabel(r.status),
    openings: r.openings, department: r.department,
    client: r.internal ? 'TeamLink Internal' : (r.client ? r.client.name : null),
    clientId: clientDesk && !r.internal ? r.clientId : null,
    recruiter: r.recruiter ? r.recruiter.name : null, createdAt: r.createdAt,
  }));
}

// ---- shared reads -------------------------------------------------------------
async function baseCtx(user, { rows = true } = {}) {
  const { can } = require('../middleware/auth'); // eslint-disable-line global-require
  const s = scopeOf(user);
  const [loaded, clientDesk] = await Promise.all([
    rows ? loadContexts(user) : { rows: [], invoices: [] },
    can(user, null, 'clients', 'Client List', 'view'),
  ]);
  return {
    user, s, loaded, D: days(), clientDesk,
    appScope: applicationWhere(user), reqScope: requirementWhere(user),
  };
}
const inGroup = (c, id) => c.loaded.rows.filter((r) => V.inWorkflowGroup(id, r.a, r.ctx));
const idsOf = (rows) => rows.map((r) => r.a.id);

// Applications that ENTERED the client chain (or, for internal hires, the
// Dept Head / TL review) between `from` and `to` (inclusive days).
async function submissionIds(c, from, to, { internal = false } = {}) {
  const target = internal ? ['TL_REVIEW'] : CLIENT_CHAIN;
  const evs = await prisma.applicationStageEvent.findMany({
    where: {
      createdAt: { gte: dt(from), lt: dt(addDays(to, 1)) },
      toStage: { in: target },
      application: { is: c.appScope },
    },
    select: { applicationId: true, fromStage: true },
  });
  return [...new Set(evs.filter((e) => !e.fromStage || !target.includes(e.fromStage)).map((e) => e.applicationId))];
}

// Joinings dated in [from, to]: by the joining date, joinedAt only where none.
function joinedIn(c, from, to, rows = c.loaded.rows) {
  return rows.filter(({ a }) => {
    if (!JOINED_STAGES.includes(a.stage)) return false;
    const d = a.joiningDate ? String(a.joiningDate).slice(0, 10) : (a.joinedAt ? iso(new Date(a.joinedAt)) : null);
    return !!d && d >= from && d <= to;
  });
}

async function targetFor(user, month) {
  if (!user.employeeId) return { submissions: null, joinings: null };
  const rows = await prisma.employeeRecord.findMany({
    where: { type: 'TARGET', employeeId: user.employeeId, date: { startsWith: month } },
    select: { title: true, unit: true, amount: true },
  });
  const pick = (re) => {
    const hit = rows.filter((r) => re.test(`${r.unit || ''} ${r.title || ''}`));
    return hit.length ? hit.reduce((n, r) => n + (Number(r.amount) || 0), 0) : null;
  };
  return { submissions: pick(/submi/i), joinings: pick(/join|placement|hire/i) };
}

// ===========================================================================
// RECRUITER (and HR — internal hiring wording)
// ===========================================================================
async function recruiterBoard(c, req) {
  const { can } = require('../middleware/auth'); // eslint-disable-line global-require
  const internal = c.s.atsRole === 'HR';
  const b = newBoard('recruiter', internal ? 'Internal Hiring — My Work' : 'My Work');
  b.internal = internal;
  const { D } = c;
  const me = c.user.id;

  const [newToday, subIds, openReqCount, openReqs, returnedRejected, followUps, unmappedCount, target] = await Promise.all([
    prisma.application.findMany({
      where: and(c.appScope, { source: { in: V.PRE_ATS_SOURCES } }, { createdAt: { gte: D.todayStart } }),
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    }),
    submissionIds(c, D.monthStart, D.t, { internal }),
    prisma.requirement.count({ where: and(c.reqScope, { status: { in: LIVE_REQ } }) }),
    prisma.requirement.findMany({
      where: and(c.reqScope, { status: { in: LIVE_REQ } }),
      select: { id: true },
      orderBy: { createdAt: 'desc' },
      take: 8,
    }),
    // TL "Rejected" in the last 7 days (the "Changes needed" half is the
    // TL_RETURNED workflow group, below).
    prisma.applicationStageEvent.findMany({
      where: {
        fromStage: 'TL_REVIEW', toStage: 'REJECTED', createdAt: { gte: dt(addDays(D.t, -7)) },
        application: { is: and(c.appScope, { stage: 'REJECTED' }) },
      },
      select: { applicationId: true, comment: true, reasonCategory: true, reasonDetail: true, actorName: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.applicationFollowUp.findMany({
      where: {
        completedAt: null, ownerUserId: me, dueDate: { lte: D.t },
        application: { is: and(c.appScope, { stage: { notIn: ['REJECTED', 'JOINED', 'HIRED'] } }) },
      },
      select: { id: true, applicationId: true, dueDate: true, nextAction: true, purpose: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }),
    c.s.global ? prisma.candidate.count({ where: { applications: { none: {} } } }) : Promise.resolve(null),
    targetFor(c.user, D.monthKey),
  ]);

  // ---- (A) counts ----
  const reviewPending = inGroup(c, 'RECRUITER_REVIEW_PENDING');
  const screening = inGroup(c, 'SCREENING_PENDING');
  const sentWeek = c.loaded.rows.filter(({ a }) => a.portalImportedAt && iso(new Date(a.portalImportedAt)) >= D.weekStart);
  addSet(b, 'new-today', { kind: 'app', title: 'New applications today', ids: newToday.map((x) => x.id) });
  addSet(b, 'review-pending', { kind: 'group', group: 'RECRUITER_REVIEW_PENDING', title: 'Review pending (ready to send to ATS)' });
  addSet(b, 'sent-week', { kind: 'app', title: 'Sent to ATS this week', ids: idsOf(sentWeek) });
  addSet(b, 'screening', { kind: 'group', group: 'SCREENING_PENDING', title: 'Screening pending' });
  addSet(b, 'submissions-month', { kind: 'app', title: internal ? 'Sent to Dept Head / TL this month' : 'Client submissions this month', ids: subIds });
  b.counts.push(
    { id: 'new-today', label: 'New applications', value: newToday.length, sub: 'today', drill: 'new-today' },
    { id: 'review-pending', label: 'Review pending', value: reviewPending.length, sub: 'in Job Portal screening', drill: 'review-pending', tone: reviewPending.length ? 'amber' : null },
    { id: 'sent-week', label: 'Sent to ATS', value: sentWeek.length, sub: 'this week', drill: 'sent-week' },
    { id: 'screening', label: 'Screening pending', value: screening.length, sub: 'resume / AI interview', drill: 'screening' },
    { id: 'submissions-month', label: internal ? 'Sent to Dept Head' : 'Submissions', value: subIds.length, sub: 'this month', drill: 'submissions-month' },
  );

  // ---- (B) My Queue ----
  // 1. Applicants with Resume Score + AI Interview Score, HIGH SCORE FIRST.
  const scored = c.loaded.rows
    .filter(({ a, ctx }) => V.isPreAtsApplication(a) && a.stage !== 'HOLD' && a.stage !== 'REJECTED' && (!internal || ctx.internal))
    .sort((x, y) => (y.a.aiInterviewScore ?? -1) - (x.a.aiInterviewScore ?? -1)
      || (y.a.resumeScore ?? y.a.matchScore ?? -1) - (x.a.resumeScore ?? x.a.matchScore ?? -1));
  addSet(b, 'q-scored', { kind: 'app', title: 'New applicants — high score first', ids: idsOf(scored), keepOrder: true });
  b.pending.push({
    id: 'q-scored', title: 'New applicants — high score first', kind: 'scored', total: scored.length, drill: 'q-scored',
    rows: await shapeApps(idsOf(scored.slice(0, 10)), { clientDesk: c.clientDesk }),
    empty: 'No applicant is waiting in Job Portal screening.',
  });
  // 2. In ATS but not mapped to a requirement.
  if (unmappedCount !== null) {
    b.pending.push({
      id: 'q-unmapped', title: 'Candidates in ATS without a requirement', kind: 'count', total: unmappedCount,
      to: '/candidates?status=None', hint: 'Candidate Master → "No application". Open one and use Assign to Requirement.',
    });
  }
  // 3. Came back from the TL: returned (changes needed) + rejected at TL.
  const returned = inGroup(c, 'TL_RETURNED');
  const retExtra = new Map();
  returned.forEach(({ a }) => retExtra.set(a.id, { note: 'Changes needed', tone: 'amber' }));
  const rejIds = [];
  returnedRejected.forEach((e) => {
    if (retExtra.has(e.applicationId)) return;
    rejIds.push(e.applicationId);
    retExtra.set(e.applicationId, { note: `Rejected by TL${e.reasonCategory ? ` — ${e.reasonCategory}` : ''}`, tone: 'red' });
  });
  const retIds = [...idsOf(returned), ...rejIds];
  addSet(b, 'q-returned', { kind: 'app', title: 'Back from TL — Rejected / Changes needed', ids: retIds, extra: retExtra });
  b.pending.push({
    id: 'q-returned', title: 'Back from TL — Rejected / Changes needed', kind: 'app', total: retIds.length, drill: 'q-returned',
    rows: await shapeApps(retIds.slice(0, 8), { extra: retExtra, clientDesk: c.clientDesk }),
    empty: 'Nothing came back from your TL.',
  });
  // 4. Follow-ups due today (and overdue) that are MINE.
  const seen = new Set();
  const fuRows = followUps.filter((f) => (seen.has(f.applicationId) ? false : seen.add(f.applicationId)));
  const fuExtra = new Map();
  fuRows.forEach((f) => fuExtra.set(f.applicationId, {
    due: f.dueDate.slice(0, 10), tone: toneFor(f.dueDate.slice(0, 10), D.t), note: f.nextAction || f.purpose || 'Follow up',
  }));
  const fuSorted = [...fuRows].sort((x, y) => String(y.dueDate).localeCompare(String(x.dueDate)));
  const fuToday = fuSorted.filter((f) => f.dueDate.slice(0, 10) === D.t);
  const fuOver = fuSorted.filter((f) => f.dueDate.slice(0, 10) < D.t);
  addSet(b, 'q-followups', { kind: 'app', title: 'My follow-ups due today / overdue', ids: [...fuToday, ...fuOver].map((f) => f.applicationId), extra: fuExtra });
  b.pending.push({
    id: 'q-followups', title: 'My follow-ups — due today', kind: 'app', total: fuToday.length + fuOver.length,
    sub: `${fmtN(fuToday.length)} due today · ${fmtN(fuOver.length)} overdue`, drill: 'q-followups',
    rows: await shapeApps([...fuToday, ...fuOver].slice(0, 8).map((f) => f.applicationId), { extra: fuExtra, clientDesk: c.clientDesk }),
    empty: 'No follow-up of yours is due today.',
    more: '/ats/followups',
  });

  // ---- (C) widgets ----
  b.widgets.push({
    id: 'my-reqs', type: 'reqs', title: internal ? 'Open internal requirements' : 'My open requirements',
    total: openReqCount, to: '/requirements?view=open&mine=1',
    rows: await withReqProgress(c, await shapeReqs(openReqs.map((r) => r.id), { clientDesk: c.clientDesk })),
  });
  const pipeGroups = internal
    ? ['PRE_ATS', 'INTERNAL_HR_REVIEW', 'INTERNAL_DEPT_HEAD_REVIEW', 'INTERNAL_INTERVIEW', 'INTERNAL_FEEDBACK_PENDING', 'INTERNAL_SELECTED', 'INTERNAL_OFFER', 'INTERNAL_JOINED', 'HOLD']
    : ['SCREENING_PENDING', 'RECRUITER_REVIEW_PENDING', 'RECRUITER_REVIEW', 'TL_REVIEW', 'BDE_READY_TO_SUBMIT', 'CLIENT_DECISION_PENDING', 'INTERVIEW', 'FEEDBACK_PENDING', 'SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'HOLD'];
  b.widgets.push({ id: 'pipeline', type: 'pipeline', title: 'My pipeline — stage-wise', rows: pipelineRows(c, b, pipeGroups) });
  const joinedMonth = joinedIn(c, D.monthStart, D.t);
  addSet(b, 'joined-month', { kind: 'app', title: 'Joined this month', ids: idsOf(joinedMonth) });
  b.widgets.push({
    id: 'target', type: 'target', title: 'Target vs Achieved — this month',
    rows: [
      { id: 'submissions', label: internal ? 'Sent to Dept Head' : 'Submissions', achieved: subIds.length, target: target.submissions, drill: 'submissions-month' },
      { id: 'joinings', label: 'Joinings', achieved: joinedMonth.length, target: target.joinings, drill: 'joined-month' },
    ],
    to: '/performance',
    note: target.submissions == null && target.joinings == null ? 'No target set for this month (Performance → Monthly Targets).' : null,
  });

  // ---- (D) quick buttons ----
  const [mayAdd, maySend] = await Promise.all([
    can(c.user, 'ats', 'candidates', 'Add Candidate', 'create'),
    can(c.user, 'ats', 'requirements', 'Job Portal Applications', 'create'),
  ]);
  if (mayAdd) b.quick.push({ id: 'add', label: '+ Add Candidate', to: '/candidates?add=1', primary: true });
  if (maySend) b.quick.push({ id: 'send', label: 'Send to ATS', to: '/candidates?view=job-portal' });
  b.quick.push({ id: 'search', label: 'Search Candidate', to: '/ats/search' });
  if (unmappedCount === null) b.notes.push('Candidates with no requirement are visible to Super Admin / Admin only (Candidate Master → No application).');
  return b;
}

// Candidates and submissions per requirement, for "open requirements" rows.
async function withReqProgress(c, reqRows) {
  if (!reqRows.length) return reqRows;
  const ids = reqRows.map((r) => r.id);
  const per = new Map(ids.map((id) => [id, { candidates: 0, submitted: 0, joined: 0 }]));
  c.loaded.rows.forEach(({ a }) => {
    const p = per.get(a.requirementId);
    if (!p) return;
    p.candidates += 1;
    if (CLIENT_CHAIN.includes(a.stage)) p.submitted += 1;
    if (JOINED_STAGES.includes(a.stage)) p.joined += 1;
  });
  return reqRows.map((r) => ({ ...r, ...per.get(r.id) }));
}

function pipelineRows(c, b, groups) {
  return groups.map((g) => {
    const def = V.WORKFLOW_STAGE_GROUPS[g];
    const n = inGroup(c, g).length;
    addSet(b, `g-${g}`, { kind: 'group', group: g, title: def.label });
    return { id: g, label: def.label, value: n, drill: `g-${g}` };
  });
}

// ===========================================================================
// TL (STL = same at department scope — scope.js widens the rows)
// ===========================================================================
async function tlBoard(c, req) {
  const { can } = require('../middleware/auth'); // eslint-disable-line global-require
  const stl = c.s.atsRole === 'STL';
  const b = newBoard('tl', stl ? 'My Departments' : 'My Team');
  const { D } = c;
  const inactiveDays = Math.min(60, Math.max(1, Number(req.query.inactiveDays) || 3));
  b.inactiveDays = inactiveDays;

  const liveRows = c.loaded.rows.filter(({ a }) => !V.isPreAtsApplication(a) && !CLOSED.includes(a.stage));
  const [tlEventsToday, subIds, lastFu, reqs] = await Promise.all([
    prisma.applicationStageEvent.findMany({
      where: { fromStage: 'TL_REVIEW', createdAt: { gte: D.todayStart }, application: { is: c.appScope } },
      select: { applicationId: true, toStage: true },
    }),
    submissionIds(c, D.monthStart, D.t),
    prisma.applicationFollowUp.groupBy({
      by: ['applicationId'],
      where: { application: { is: and(c.appScope, { stage: { notIn: CLOSED } }) } },
      _max: { updatedAt: true },
    }).catch(() => []),
    prisma.requirement.findMany({
      where: c.reqScope,
      select: { id: true, title: true, reqCode: true, openings: true, status: true, recruiterId: true, clientId: true, internal: true, client: { select: { name: true } } },
    }),
  ]);
  const reqById = new Map(reqs.map((r) => [r.id, r]));

  // ---- (A) ----
  const tlQueue = [...inGroup(c, 'TL_REVIEW'), ...inGroup(c, 'INTERNAL_DEPT_HEAD_REVIEW')]
    .sort((x, y) => new Date(x.a.updatedAt) - new Date(y.a.updatedAt));
  const approved = [...new Set(tlEventsToday.filter((e) => !['REJECTED', 'HOLD', 'RECRUITER_REVIEW', 'RECRUITER_APPROVED', 'TL_REVIEW'].includes(e.toStage)).map((e) => e.applicationId))];
  const rejected = [...new Set(tlEventsToday.filter((e) => ['REJECTED', 'RECRUITER_REVIEW', 'RECRUITER_APPROVED'].includes(e.toStage)).map((e) => e.applicationId))];
  const joinedMonth = joinedIn(c, D.monthStart, D.t);
  addSet(b, 'tl-queue', { kind: 'app', title: 'TL Review pending', ids: idsOf(tlQueue), keepOrder: true });
  addSet(b, 'approved-today', { kind: 'app', title: 'Approved by TL today', ids: approved });
  addSet(b, 'rejected-today', { kind: 'app', title: 'Rejected / returned by TL today', ids: rejected });
  addSet(b, 'submissions-month', { kind: 'app', title: 'Team client submissions this month', ids: subIds });
  addSet(b, 'joined-month', { kind: 'app', title: 'Team joinings this month', ids: idsOf(joinedMonth) });
  const overdueTl = tlQueue.filter(({ a }) => { const d = V.applicationDueDate(a); return d && d < D.t; }).length;
  b.counts.push(
    { id: 'tl-queue', label: 'TL Review pending', value: tlQueue.length, sub: overdueTl ? `${fmtN(overdueTl)} overdue` : 'waiting for you', tone: overdueTl ? 'red' : (tlQueue.length ? 'amber' : null), drill: 'tl-queue' },
    { id: 'approved-today', label: 'Approved', value: approved.length, sub: 'today', drill: 'approved-today' },
    { id: 'rejected-today', label: 'Rejected / returned', value: rejected.length, sub: 'today', drill: 'rejected-today' },
    { id: 'submissions-month', label: 'Team submissions', value: subIds.length, sub: 'this month', drill: 'submissions-month' },
    { id: 'joined-month', label: 'Team joinings', value: joinedMonth.length, sub: 'this month', drill: 'joined-month' },
  );

  // ---- (B) ----
  const qExtra = new Map();
  tlQueue.forEach(({ a }) => {
    const due = V.applicationDueDate(a);
    qExtra.set(a.id, { due, tone: toneFor(due, D.t), waitingDays: Math.max(0, Math.floor((Date.now() - new Date(a.updatedAt)) / DAY)) });
  });
  b.setExtra = { 'tl-queue': qExtra };
  b.sets.get('tl-queue').extra = qExtra;
  const queueRows = await shapeApps(idsOf(tlQueue.slice(0, 10)), { extra: qExtra, clientDesk: c.clientDesk });
  b.pending.push({
    id: 'tl-queue', title: 'TL review queue', kind: 'tlqueue', total: tlQueue.length, drill: 'tl-queue', rows: queueRows,
    empty: 'Nothing is waiting for your review.',
  });
  b.firstQueueItem = queueRows[0] ? { candidateId: queueRows[0].candidateId, applicationId: queueRows[0].id } : null;

  const fuAt = new Map(lastFu.map((g) => [g.applicationId, g._max.updatedAt]));
  const cutoff = Date.now() - inactiveDays * DAY;
  const inactive = liveRows
    .map(({ a }) => {
      const last = Math.max(new Date(a.updatedAt).getTime(), fuAt.get(a.id) ? new Date(fuAt.get(a.id)).getTime() : 0);
      return { a, last };
    })
    .filter((x) => x.last < cutoff)
    .sort((x, y) => x.last - y.last);
  const inExtra = new Map();
  inactive.forEach(({ a, last }) => {
    const idle = Math.floor((Date.now() - last) / DAY);
    inExtra.set(a.id, { idleDays: idle, lastAction: iso(new Date(last)), tone: idle >= inactiveDays * 2 ? 'red' : 'amber' });
  });
  addSet(b, 'inactive', { kind: 'app', title: `No action for ${inactiveDays}+ days`, ids: inactive.map((x) => x.a.id), extra: inExtra, keepOrder: true });
  b.pending.push({
    id: 'inactive', title: `Inactive candidates — no action for ${inactiveDays}+ days`, kind: 'inactive', total: inactive.length, drill: 'inactive',
    rows: await shapeApps(inactive.slice(0, 10).map((x) => x.a.id), { extra: inExtra, clientDesk: c.clientDesk }),
    empty: 'Every live candidate has had an action recently.',
  });

  // ---- (C) ----
  const [monthEvents] = await Promise.all([
    prisma.applicationStageEvent.findMany({
      where: { createdAt: { gte: dt(D.monthStart) }, application: { is: c.appScope } },
      select: { applicationId: true, fromStage: true, toStage: true },
    }),
  ]);
  const reqOfApp = new Map(c.loaded.rows.map(({ a }) => [a.id, a.requirementId]));
  const recOf = (appId) => { const r = reqById.get(reqOfApp.get(appId)); return r ? r.recruiterId : null; };
  const perf = new Map();
  const bump = (uid, k, id) => {
    if (!uid) return;
    const e = perf.get(uid) || { userId: uid, screened: new Set(), submitted: new Set(), selected: new Set(), joined: new Set(), active: 0 };
    if (k === 'active') e.active += 1; else e[k].add(id);
    perf.set(uid, e);
  };
  monthEvents.forEach((e) => {
    if (REVIEW_STAGES.includes(e.fromStage) && !REVIEW_STAGES.includes(e.toStage)) bump(recOf(e.applicationId), 'screened', e.applicationId);
    if (e.toStage === 'SELECTED') bump(recOf(e.applicationId), 'selected', e.applicationId);
  });
  subIds.forEach((id) => bump(recOf(id), 'submitted', id));
  joinedMonth.forEach(({ a }) => bump(recOf(a.id), 'joined', a.id));
  liveRows.forEach(({ a }) => bump(recOf(a.id), 'active', a.id));
  const names = perf.size ? await prisma.user.findMany({ where: { id: { in: [...perf.keys()] } }, select: { id: true, name: true } }) : [];
  const nameOf = new Map(names.map((u) => [u.id, u.name]));
  const perfRows = [...perf.values()].filter((e) => nameOf.has(e.userId)).map((e) => {
    const setIds = {};
    ['screened', 'submitted', 'selected', 'joined'].forEach((k) => {
      setIds[k] = addSet(b, `perf-${e.userId}-${k}`, { kind: 'app', title: `${nameOf.get(e.userId)} — ${k} this month`, ids: [...e[k]] });
    });
    return {
      userId: e.userId, name: nameOf.get(e.userId), active: e.active,
      screened: e.screened.size, submitted: e.submitted.size, selected: e.selected.size, joined: e.joined.size, drills: setIds,
      to: `/candidates?recruiter=id:${e.userId}`,
    };
  }).sort((x, y) => y.joined - x.joined || y.submitted - x.submitted || y.active - x.active || x.name.localeCompare(y.name));
  b.widgets.push({ id: 'recruiters', type: 'recruiters', title: 'Recruiter-wise performance — this month', rows: perfRows, to: '/reports/ats?tab=recruiters' });

  const everSubmitted = new Set((await prisma.applicationStageEvent.findMany({
    where: { toStage: { in: CLIENT_CHAIN }, application: { is: and(c.appScope, { requirement: { is: { status: { in: LIVE_REQ } } } }) } },
    select: { applicationId: true },
  })).map((e) => e.applicationId));
  const progress = new Map();
  c.loaded.rows.forEach(({ a }) => {
    const r = reqById.get(a.requirementId);
    if (!r || !LIVE_REQ.includes(r.status)) return;
    const p = progress.get(r.id) || { candidates: 0, submitted: 0, joined: 0 };
    p.candidates += 1;
    if (CLIENT_CHAIN.includes(a.stage) || everSubmitted.has(a.id)) p.submitted += 1;
    if (JOINED_STAGES.includes(a.stage)) p.joined += 1;
    progress.set(r.id, p);
  });
  const liveReqs = reqs.filter((r) => LIVE_REQ.includes(r.status));
  const reqRows = liveReqs.map((r) => {
    const p = progress.get(r.id) || { candidates: 0, submitted: 0, joined: 0 };
    return {
      id: r.id, title: r.title, reqCode: r.reqCode, openings: r.openings || 0, ...p,
      remaining: Math.max(0, (r.openings || 0) - p.joined),
      client: r.internal ? 'TeamLink Internal' : (r.client ? r.client.name : null),
      clientId: c.clientDesk && !r.internal ? r.clientId : null,
    };
  }).sort((x, y) => y.remaining - x.remaining || y.submitted - x.submitted).slice(0, 10);
  b.widgets.push({ id: 'req-progress', type: 'reqprogress', title: 'Requirement-wise progress', total: liveReqs.length, rows: reqRows, to: '/requirements?view=open' });

  b.widgets.push({
    id: 'funnel', type: 'funnel', title: 'Team pipeline',
    rows: pipelineRows(c, b, ['RECRUITER_REVIEW', 'TL_REVIEW', 'BDE_READY_TO_SUBMIT', 'CLIENT_DECISION_PENDING', 'INTERVIEW', 'FEEDBACK_PENDING', 'SELECTED', 'OFFER', 'OFFER_ACCEPTED']),
  });

  // ---- (D) ----
  const mayAssign = await can(c.user, 'ats', 'requirements', 'Requirement Detail', 'assign');
  b.quick.push({ id: 'next', label: 'Review Next', to: b.firstQueueItem ? `/candidates/${b.firstQueueItem.candidateId}` : null, primary: true, disabledHint: 'Nothing is waiting for your review' });
  if (mayAssign) b.quick.push({ id: 'assign', label: 'Assign Requirement', to: '/requirements?view=open' });
  b.quick.push({ id: 'report', label: 'Team Report', to: '/reports/ats?tab=recruiters' });
  return b;
}

// ===========================================================================
// BDE / CLIENT MANAGER
// ===========================================================================
async function bdeBoard(c) {
  const { can } = require('../middleware/auth'); // eslint-disable-line global-require
  const b = newBoard('bde', 'My Clients — Work');
  const { D } = c;
  const weekEndNext = dt(addDays(D.weekEnd, 1));
  const [openReqCount, ivToday, ivWeek, ivNext7, ivPast, rejectedMonth, reqCounts] = await Promise.all([
    prisma.requirement.count({ where: and(c.reqScope, { status: { in: LIVE_REQ } }) }),
    prisma.application.findMany({ where: and(c.appScope, { interviewAt: { gte: D.todayStart, lt: D.tomorrowStart } }, LIVE_INTERVIEW), select: { id: true }, orderBy: { interviewAt: 'asc' } }),
    prisma.application.findMany({ where: and(c.appScope, { interviewAt: { gte: dt(D.weekStart), lt: weekEndNext } }, LIVE_INTERVIEW), select: { id: true }, orderBy: { interviewAt: 'asc' } }),
    prisma.application.findMany({
      where: and(c.appScope, { interviewAt: { gte: D.todayStart, lt: dt(addDays(D.t, 7)) } }, LIVE_INTERVIEW),
      select: { id: true, interviewAt: true }, orderBy: { interviewAt: 'asc' }, take: 40,
    }),
    prisma.application.findMany({
      where: and(c.appScope, { stage: 'INTERVIEW_SCHEDULED', interviewAt: { lt: new Date() } }, LIVE_INTERVIEW),
      select: { id: true },
    }),
    prisma.applicationStageEvent.findMany({
      where: { toStage: 'REJECTED', fromStage: { in: CLIENT_CHAIN }, createdAt: { gte: dt(D.monthStart) }, application: { is: c.appScope } },
      select: { applicationId: true },
    }),
    prisma.requirement.groupBy({ by: ['clientId'], where: and(c.reqScope, { status: { in: LIVE_REQ }, internal: false }), _count: { _all: true } }),
  ]);

  // ---- (A) ----
  const decision = inGroup(c, 'CLIENT_DECISION_PENDING');
  const feedback = inGroup(c, 'FEEDBACK_PENDING');
  const offers = [...inGroup(c, 'SELECTED'), ...inGroup(c, 'OFFER')];
  const expected = inGroup(c, 'OFFER_ACCEPTED');
  addSet(b, 'decision', { kind: 'group', group: 'CLIENT_DECISION_PENDING', title: 'Submissions pending client decision' });
  addSet(b, 'iv-week', { kind: 'app', title: 'Interviews this week', ids: ivWeek.map((x) => x.id), keepOrder: true });
  addSet(b, 'iv-today', { kind: 'app', title: 'Interviews today', ids: ivToday.map((x) => x.id), keepOrder: true });
  addSet(b, 'feedback', { kind: 'group', group: 'FEEDBACK_PENDING', title: 'Interview feedback pending' });
  addSet(b, 'offers', { kind: 'app', title: 'Offers pending (Selected / Offer)', ids: idsOf(offers) });
  addSet(b, 'expected', { kind: 'group', group: 'OFFER_ACCEPTED', title: 'Joinings expected (offer accepted)' });
  b.counts.push(
    { id: 'open-reqs', label: 'Open requirements', value: openReqCount, sub: 'live now', to: '/requirements?view=open&mine=1' },
    { id: 'decision', label: 'Pending client decision', value: decision.length, sub: 'submitted, no decision', drill: 'decision', tone: decision.length ? 'amber' : null },
    { id: 'iv-today', label: 'Interviews today', value: ivToday.length, sub: `${fmtN(ivWeek.length)} this week`, to: '/ats/calendar?view=today', drill: 'iv-today', subDrill: 'iv-week' },
    { id: 'feedback', label: 'Feedback pending', value: feedback.length, sub: 'interview done', drill: 'feedback', tone: feedback.length ? 'amber' : null },
    { id: 'offers', label: 'Offers pending', value: offers.length, sub: 'selected / offered', drill: 'offers' },
    { id: 'expected', label: 'Joinings expected', value: expected.length, sub: 'offer accepted', drill: 'expected' },
  );

  // ---- (B) ----
  const ready = inGroup(c, 'BDE_READY_TO_SUBMIT').sort((x, y) => new Date(x.a.updatedAt) - new Date(y.a.updatedAt));
  const readyExtra = new Map();
  ready.forEach(({ a }) => { const due = V.applicationDueDate(a); readyExtra.set(a.id, { due, tone: toneFor(due, D.t) }); });
  addSet(b, 'ready', { kind: 'app', title: 'TL-approved — submit to client', ids: idsOf(ready), extra: readyExtra, keepOrder: true });
  b.pending.push({ id: 'ready', title: 'TL-approved — submit to the client', kind: 'app', total: ready.length, drill: 'ready', rows: await shapeApps(idsOf(ready.slice(0, 8)), { extra: readyExtra, clientDesk: c.clientDesk }), empty: 'Nothing is waiting to be submitted.' });

  const silentExtra = new Map();
  const silent = decision
    .map(({ a }) => ({ a, age: Math.floor((Date.now() - new Date(a.updatedAt)) / DAY) }))
    .filter((x) => x.age >= 2)
    .sort((x, y) => y.age - x.age);
  silent.forEach(({ a, age }) => silentExtra.set(a.id, { waitingDays: age, tone: age >= 3 ? 'red' : 'amber', note: `No client response for ${age} days` }));
  addSet(b, 'silent', { kind: 'app', title: 'No client response for 2+ days', ids: silent.map((x) => x.a.id), extra: silentExtra, keepOrder: true });
  b.pending.push({ id: 'silent', title: 'No client response — 2 to 3+ days', kind: 'app', total: silent.length, drill: 'silent', sub: `${fmtN(silent.filter((x) => x.age >= 3).length)} overdue (3+ days)`, rows: await shapeApps(silent.slice(0, 8).map((x) => x.a.id), { extra: silentExtra, clientDesk: c.clientDesk }), empty: 'Every client has answered within 2 days.' });

  const fbIds = [...new Set([...idsOf(feedback), ...ivPast.map((x) => x.id)])];
  const fbExtra = new Map();
  ivPast.forEach((x) => fbExtra.set(x.id, { note: 'Interview time passed — not marked done', tone: 'red' }));
  addSet(b, 'collect', { kind: 'app', title: 'Interview feedback to collect', ids: fbIds, extra: fbExtra });
  b.pending.push({ id: 'collect', title: 'Interview feedback to collect', kind: 'app', total: fbIds.length, drill: 'collect', rows: await shapeApps(fbIds.slice(0, 8), { extra: fbExtra, clientDesk: c.clientDesk }), empty: 'No feedback is outstanding.' });

  const joinRows = [...offers, ...expected];
  const joinExtra = new Map();
  joinRows.forEach(({ a }) => {
    const jd = a.joiningDate ? String(a.joiningDate).slice(0, 10) : null;
    joinExtra.set(a.id, { due: jd, tone: jd ? toneFor(jd, D.t) : 'amber', note: jd ? `Joining ${jd}` : 'Joining date not confirmed' });
  });
  const joinSorted = [...joinRows].sort((x, y) => String(x.a.joiningDate || '9999').localeCompare(String(y.a.joiningDate || '9999')));
  addSet(b, 'joining', { kind: 'app', title: 'Offer follow-ups & joining confirmations', ids: idsOf(joinSorted), extra: joinExtra, keepOrder: true });
  b.pending.push({ id: 'joining', title: 'Offer follow-ups & joining-date confirmations', kind: 'app', total: joinSorted.length, drill: 'joining', rows: await shapeApps(idsOf(joinSorted.slice(0, 8)), { extra: joinExtra, clientDesk: c.clientDesk }), empty: 'No offer or joining to chase.' });

  // ---- (C) ----
  const perClient = new Map();
  const everSub = new Set((await prisma.applicationStageEvent.findMany({ where: { toStage: { in: CLIENT_CHAIN }, application: { is: c.appScope } }, select: { applicationId: true } })).map((e) => e.applicationId));
  c.loaded.rows.forEach(({ a, ctx }) => {
    if (ctx.internal || !a.requirement) return;
    const k = a.requirement.clientId;
    const e = perClient.get(k) || { clientId: k, requirements: 0, submissions: 0, selections: 0 };
    if (CLIENT_CHAIN.includes(a.stage) || everSub.has(a.id)) e.submissions += 1;
    if (SELECTED_ON.includes(a.stage)) e.selections += 1;
    perClient.set(k, e);
  });
  reqCounts.forEach((g) => {
    const e = perClient.get(g.clientId) || { clientId: g.clientId, requirements: 0, submissions: 0, selections: 0 };
    e.requirements = g._count._all;
    perClient.set(g.clientId, e);
  });
  const topClients = [...perClient.values()].filter((e) => e.requirements || e.submissions)
    .sort((x, y) => y.requirements - x.requirements || y.submissions - x.submissions).slice(0, 10);
  const cNames = topClients.length ? await prisma.client.findMany({ where: { id: { in: topClients.map((x) => x.clientId) } }, select: { id: true, name: true } }) : [];
  const cName = new Map(cNames.map((x) => [x.id, x.name]));
  b.widgets.push({
    id: 'clients', type: 'clients', title: 'Client-wise summary',
    rows: topClients.map((e) => ({ ...e, client: cName.get(e.clientId) || '—', clientId: c.clientDesk ? e.clientId : null, to: `/requirements?clientId=${e.clientId}` })),
    to: c.clientDesk ? '/clients' : null,
  });
  const cal = await shapeApps(ivNext7.map((x) => x.id), { clientDesk: c.clientDesk, limit: 40 });
  b.widgets.push({ id: 'calendar', type: 'calendar', title: 'Interview calendar — next 7 days', rows: cal, to: '/ats/calendar?view=upcoming' });
  const selectedNow = inGroup(c, 'SELECTED');
  const holdNow = inGroup(c, 'HOLD');
  const rejIds = [...new Set(rejectedMonth.map((e) => e.applicationId))];
  addSet(b, 'sel-now', { kind: 'group', group: 'SELECTED', title: 'Selected (now)' });
  addSet(b, 'rej-month', { kind: 'app', title: 'Rejected after submission — this month', ids: rejIds });
  addSet(b, 'hold-now', { kind: 'group', group: 'HOLD', title: 'On hold (now)' });
  b.widgets.push({
    id: 'outcomes', type: 'outcomes', title: 'Selected / Rejected / Hold',
    rows: [
      { id: 'sel', label: 'Selected', sub: 'now', value: selectedNow.length, tone: 'green', drill: 'sel-now' },
      { id: 'rej', label: 'Rejected', sub: 'after submission, this month', value: rejIds.length, tone: 'red', drill: 'rej-month' },
      { id: 'hold', label: 'Hold', sub: 'now', value: holdNow.length, tone: 'amber', drill: 'hold-now' },
    ],
  });
  const soon = guaranteeSoon(c.loaded.rows, D, 15);
  const gExtra = new Map(soon.map((x) => [x.a.id, { due: x.end, tone: x.end <= addDays(D.t, 3) ? 'amber' : 'green', note: `Guarantee ends ${x.end}` }]));
  addSet(b, 'guarantee', { kind: 'app', title: 'Guarantee expiring in 15 days', ids: soon.map((x) => x.a.id), extra: gExtra, keepOrder: true });
  b.widgets.push({ id: 'guarantee', type: 'apps', title: 'Guarantee expiring soon (15 days)', total: soon.length, drill: 'guarantee', rows: await shapeApps(soon.slice(0, 8).map((x) => x.a.id), { extra: gExtra, clientDesk: c.clientDesk }), empty: 'No guarantee period ends in the next 15 days.' });

  // ---- (D) ----
  const [mayReq, mayMove] = await Promise.all([
    can(c.user, 'ats', 'requirements', 'Create Requirement', 'create'),
    can(c.user, 'ats', 'candidates', 'Pipeline Stages', 'edit'),
  ]);
  if (mayReq) b.quick.push({ id: 'new-req', label: '+ New Requirement', to: '/requirements?new=1', primary: true });
  b.quick.push({ id: 'submit', label: 'Submit to Client', to: '/candidates?stage=WITH_BDE,BDE_APPROVED' });
  if (mayMove) b.quick.push({ id: 'schedule', label: 'Schedule Interview', to: '/ats/calendar?schedule=1' });
  return b;
}

// Client placements whose guarantee ends within `within` days from today.
function guaranteeSoon(rows, D, within) {
  const limit = addDays(D.t, within);
  return rows
    .filter(({ a, ctx }) => V.inWorkflowGroup('GUARANTEE_RUNNING', a, ctx))
    .map(({ a, ctx }) => {
      const end = V.guaranteeEndOf(a, ctx.guaranteeDays);
      return { a, end: end ? iso(end) : null };
    })
    .filter((x) => x.end && x.end >= D.t && x.end <= limit)
    .sort((x, y) => x.end.localeCompare(y.end));
}

// ===========================================================================
// MANAGEMENT — read-only; charts live here. Filters: Date · Client · Team ·
// Source. Money only for logins that may read Accounts invoices.
// ===========================================================================
async function managementBoard(c, req) {
  const { can } = require('../middleware/auth'); // eslint-disable-line global-require
  const b = newBoard('management', 'Management Overview');
  b.readOnly = true;
  const { D } = c;
  const q = req.query || {};
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const period = dateRange.resolve({ range: str(q.range) || 'this_month', from: str(q.from), to: str(q.to) });
  const f = { clientId: str(q.clientId), department: str(q.department), source: str(q.source) };
  b.period = period;
  b.filters = f;
  const mayMoney = await can(c.user, 'accounts', 'accounts', 'Invoices', 'view');
  b.money = mayMoney;

  const reqFilter = and(f.clientId ? { clientId: f.clientId } : null, f.department ? { department: f.department } : null);
  const appFilter = and(
    c.appScope,
    Object.keys(reqFilter).length ? { requirement: { is: reqFilter } } : null,
    f.source ? { source: f.source } : null,
  );
  const inPeriod = { gte: dt(period.from), lt: dt(addDays(period.to, 1)) };
  const appsWhere = and(appFilter, { createdAt: inPeriod });

  const [apps, events, openReqCount, joinedApps, reqRows, clients, depts, sourceGroups] = await Promise.all([
    prisma.application.findMany({ where: appsWhere, select: { id: true, stage: true, source: true, createdAt: true, requirementId: true, offerStatus: true, joiningStatus: true } }),
    prisma.applicationStageEvent.findMany({ where: { application: { is: appsWhere } }, select: { applicationId: true, fromStage: true, toStage: true, createdAt: true } }),
    prisma.requirement.count({ where: and(c.reqScope, reqFilter, { status: { in: LIVE_REQ } }) }),
    prisma.application.findMany({
      where: and(appFilter, { stage: { in: JOINED_STAGES } }, { OR: [{ joiningDate: dateRange.dayStringIn(period) }, { joiningDate: null, joinedAt: inPeriod }] }),
      select: { id: true, requirementId: true, joiningDate: true, joinedAt: true, joiningStatus: true, createdAt: true },
    }),
    prisma.requirement.findMany({ where: and(c.reqScope, reqFilter), select: { id: true, recruiterId: true, tlId: true, bdeId: true, createdAt: true, clientId: true } }),
    prisma.client.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.requirement.groupBy({ by: ['department'], where: c.reqScope, _count: { _all: true } }),
    prisma.application.groupBy({ by: ['source'], where: c.appScope, _count: { _all: true }, orderBy: { _count: { source: 'desc' } }, take: 12 }),
  ]);
  const reqById = new Map(reqRows.map((r) => [r.id, r]));
  const reached = new Map();
  events.forEach((e) => {
    if (!reached.has(e.applicationId)) reached.set(e.applicationId, new Set());
    reached.get(e.applicationId).add(e.toStage);
  });
  const hit = (a, set) => set.includes(a.stage) || [...(reached.get(a.id) || [])].some((s) => set.includes(s));
  const steps = [
    { key: 'applications', label: 'Applications', test: () => true },
    { key: 'submission', label: 'Submission', test: (a) => hit(a, CLIENT_CHAIN) },
    { key: 'interview', label: 'Interview', test: (a) => hit(a, INTERVIEW_ON) },
    { key: 'selection', label: 'Selection', test: (a) => hit(a, SELECTED_ON) },
    { key: 'joined', label: 'Joined', test: (a) => hit(a, JOINED_STAGES) },
  ];
  const stepIds = {};
  steps.forEach((st) => {
    stepIds[st.key] = apps.filter((a) => st.test(a)).map((a) => a.id);
    addSet(b, `funnel-${st.key}`, { kind: 'app', title: `${st.label} — applications added ${period.name}`, ids: stepIds[st.key] });
  });
  const n = (k) => stepIds[k].length;
  const funnelRows = steps.map((st, i) => ({
    id: st.key, label: st.label, value: n(st.key), drill: `funnel-${st.key}`,
    ofAll: pct(n(st.key), n('applications')), ofPrev: i ? pct(n(st.key), n(steps[i - 1].key)) : null,
  }));

  // money
  let money = null;
  if (mayMoney) {
    const invs = await prisma.invoice.findMany({
      where: and(invoiceWhere(c.user), f.clientId ? { clientId: f.clientId } : null),
      select: { id: true, clientId: true, amount: true, gst: true, tds: true, receivedAmount: true, status: true, invoiceDate: true, dueDate: true, client: { select: { name: true } } },
    });
    const live = invs.filter((i) => A.deriveInvoiceStatus(i) !== 'Cancelled');
    const billing = (list) => A.ROUND(list.reduce((s, i) => s + Number(i.amount || 0), 0));
    const inDays = (i, from, to) => { const d = String(i.invoiceDate || '').slice(0, 10); return d >= from && d <= to; };
    const month = live.filter((i) => inDays(i, D.monthStart, D.t));
    const quarter = live.filter((i) => inDays(i, D.quarterStart, D.t));
    const inRangeInv = live.filter((i) => inDays(i, period.from, period.to));
    const byClient = new Map();
    inRangeInv.forEach((i) => {
      const k = i.client ? i.client.name : '—';
      byClient.set(k, A.ROUND((byClient.get(k) || 0) + Number(i.amount || 0)));
    });
    const fq = (() => { const mm = D.m + 1; const fy = mm >= 4 ? D.y : D.y - 1; const qn = mm >= 4 && mm <= 6 ? 1 : mm <= 9 && mm >= 7 ? 2 : mm >= 10 ? 3 : 4; return `Q${qn}:${fy}`; })();
    money = {
      month: billing(month), monthCount: month.length, monthTo: `/invoices?period=M:${D.monthKey}`,
      quarter: billing(quarter), quarterCount: quarter.length, quarterTo: `/invoices?period=${fq}`,
      outstanding: A.ROUND(live.filter((i) => A.invoiceOutstanding(i) > 0.5).reduce((s, i) => s + A.invoiceOutstanding(i), 0)),
      outstandingCount: live.filter((i) => A.invoiceOutstanding(i) > 0.5).length,
      byClient: [...byClient.entries()].map(([client, value]) => ({ label: client, value })).sort((x, y) => y.value - x.value).slice(0, 10),
    };
  }

  // ---- (A) ----
  addSet(b, 'joined', { kind: 'app', title: `Joinings — ${period.name}`, ids: joinedApps.map((a) => a.id) });
  if (money) {
    b.counts.push({ id: 'rev-month', label: 'Revenue — this month', value: money.month, money: true, sub: `${fmtN(money.monthCount)} invoices · quarter ₹${fmtN(money.quarter)}`, to: money.monthTo, subTo: money.quarterTo });
  }
  b.counts.push(
    { id: 'joined', label: 'Total joinings', value: joinedApps.length, sub: period.name, drill: 'joined' },
    { id: 'open-reqs', label: 'Open requirements', value: openReqCount, sub: 'live now', to: `/requirements?view=open${f.department ? `&department=${encodeURIComponent(f.department)}` : ''}${f.clientId ? `&clientId=${f.clientId}` : ''}` },
    {
      id: 'conversion', label: 'Conversion', value: pct(n('joined'), n('applications')), unit: '%',
      sub: `App → Sub ${pct(n('submission'), n('applications')) ?? '—'}% · Sub → Sel ${pct(n('selection'), n('submission')) ?? '—'}% · Sel → Join ${pct(n('joined'), n('selection')) ?? '—'}%`,
      to: '/reports/ats?tab=funnel',
    },
  );
  if (money) b.counts.push({ id: 'outstanding', label: 'Outstanding payments', value: money.outstanding, money: true, sub: `${fmtN(money.outstandingCount)} open invoices`, to: '/reports/accounts', tone: money.outstanding > 0 ? 'red' : null });

  // ---- (C) ----
  b.widgets.push({ id: 'funnel', type: 'funnelchart', title: `Hiring funnel — applications added ${period.name}`, rows: funnelRows, to: '/reports/ats?tab=funnel' });

  // Leaderboards: joinings and submissions in the period, by the requirement's person.
  const subInPeriod = new Set(events.filter((e) => e.createdAt >= dt(period.from) && e.createdAt < dt(addDays(period.to, 1))
    && CLIENT_CHAIN.includes(e.toStage) && (!e.fromStage || !CLIENT_CHAIN.includes(e.fromStage))).map((e) => e.applicationId));
  const appReq = new Map(apps.map((a) => [a.id, a.requirementId]));
  const board = (field) => {
    const m = new Map();
    const add = (uid, k) => { if (!uid) return; const e = m.get(uid) || { userId: uid, joined: 0, submitted: 0 }; e[k] += 1; m.set(uid, e); };
    joinedApps.forEach((a) => { const r = reqById.get(a.requirementId); if (r) add(r[field], 'joined'); });
    subInPeriod.forEach((id) => { const r = reqById.get(appReq.get(id)); if (r) add(r[field], 'submitted'); });
    return m;
  };
  const boards = { recruiter: board('recruiterId'), tl: board('tlId'), bde: board('bdeId') };
  const uids = new Set(); Object.values(boards).forEach((m) => m.forEach((_, k) => uids.add(k)));
  const users = uids.size ? await prisma.user.findMany({ where: { id: { in: [...uids] } }, select: { id: true, name: true } }) : [];
  const uName = new Map(users.map((u) => [u.id, u.name]));
  const top = (m) => [...m.values()].filter((e) => uName.has(e.userId)).map((e) => ({ ...e, name: uName.get(e.userId) }))
    .sort((x, y) => y.joined - x.joined || y.submitted - x.submitted).slice(0, 5);
  b.widgets.push({ id: 'leaderboard', type: 'leaderboard', title: `Leaderboard — ${period.name}`, groups: [
    { id: 'recruiter', label: 'Recruiters', rows: top(boards.recruiter) },
    { id: 'tl', label: 'TLs', rows: top(boards.tl) },
    { id: 'bde', label: 'BDEs', rows: top(boards.bde) },
  ], to: '/reports/ats?tab=recruiters' });
  if (money) b.widgets.push({ id: 'client-revenue', type: 'barchart', title: `Client-wise revenue (before GST) — ${period.name}`, unit: 'money', rows: money.byClient, to: '/reports/accounts' });

  // Source quality
  const bySrc = new Map();
  apps.forEach((a) => {
    const k = a.source || 'Not recorded';
    const e = bySrc.get(k) || { source: k, applications: 0, submitted: 0, joined: 0 };
    e.applications += 1;
    if (hit(a, CLIENT_CHAIN)) e.submitted += 1;
    if (hit(a, JOINED_STAGES)) e.joined += 1;
    bySrc.set(k, e);
  });
  const srcAll = [...bySrc.values()].sort((x, y) => y.applications - x.applications);
  const srcTop = srcAll.slice(0, 8);
  const rest = srcAll.slice(8).reduce((e, s) => ({ source: `All other (${srcAll.length - 8})`, applications: e.applications + s.applications, submitted: e.submitted + s.submitted, joined: e.joined + s.joined }), { applications: 0, submitted: 0, joined: 0 });
  if (rest.applications) srcTop.push(rest);
  b.widgets.push({
    id: 'sources', type: 'sources', title: `Job-source quality — applications added ${period.name}`,
    rows: srcTop.map((s) => ({ ...s, submitPct: pct(s.submitted, s.applications), joinPct: pct(s.joined, s.applications) })),
    to: '/reports/ats?tab=sources',
  });

  // Time-to-fill / time-to-submit (recorded moves only)
  const firstJoin = new Map();
  joinedApps.forEach((a) => {
    const d = a.joiningDate ? dt(String(a.joiningDate).slice(0, 10)) : (a.joinedAt ? new Date(a.joinedAt) : null);
    if (!d || Number.isNaN(d.getTime())) return;
    const cur = firstJoin.get(a.requirementId);
    if (!cur || d < cur) firstJoin.set(a.requirementId, d);
  });
  const fill = [];
  firstJoin.forEach((d, rid) => { const r = reqById.get(rid); if (!r) return; const x = (d - new Date(r.createdAt)) / DAY; if (x >= 0 && x < 3650) fill.push(x); });
  const appCreated = new Map(apps.map((a) => [a.id, a.createdAt]));
  const submit = [];
  events.forEach((e) => {
    if (!e.fromStage || CLIENT_CHAIN.includes(e.fromStage) || !CLIENT_CHAIN.includes(e.toStage)) return;
    const x = (new Date(e.createdAt) - new Date(appCreated.get(e.applicationId))) / DAY;
    if (x >= 0) submit.push(x);
  });
  const avg = (v) => (v.length ? Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 10) / 10 : null);
  b.widgets.push({
    id: 'timing', type: 'kv', title: 'Speed', to: '/reports/ats?tab=sla',
    rows: [
      { label: 'Average time-to-fill', value: fill.length >= 5 ? `${avg(fill)} days` : `Not enough data (${fill.length})`, sub: 'requirement raised → first joining, joinings in the period' },
      { label: 'Average time-to-submit', value: submit.length >= 5 ? `${avg(submit)} days` : `Not enough data (${submit.length})`, sub: 'application added → client submission (recorded moves only)' },
    ],
  });

  // Replacement / dropout
  const droppedAfterSel = new Set(events.filter((e) => ['SELECTED', 'OFFER', 'OFFER_ACCEPTED'].includes(e.fromStage) && e.toStage === 'REJECTED').map((e) => e.applicationId));
  const dropIds = apps.filter((a) => a.offerStatus === 'Offer Declined' || a.joiningStatus === 'Dropped' || droppedAfterSel.has(a.id)).map((a) => a.id);
  const replIds = joinedApps.filter((a) => [V.JOINING_REPLACEMENT_DUE, V.JOINING_REPLACED, V.JOINING_LEFT_AFTER_GUARANTEE].includes(a.joiningStatus)).map((a) => a.id);
  addSet(b, 'dropouts', { kind: 'app', title: `Dropouts after selection — ${period.name}`, ids: dropIds });
  addSet(b, 'replacements', { kind: 'app', title: `Joined then left — ${period.name}`, ids: replIds });
  b.widgets.push({
    id: 'attrition', type: 'rates', title: 'Replacement / dropout rate',
    rows: [
      { label: 'Dropout rate', value: pct(dropIds.length, n('selection')), sub: `${fmtN(dropIds.length)} of ${fmtN(n('selection'))} selections declined / dropped`, drill: 'dropouts', tone: 'red' },
      { label: 'Replacement rate', value: pct(replIds.length, joinedApps.length), sub: `${fmtN(replIds.length)} of ${fmtN(joinedApps.length)} joinings left (replacement due / replaced)`, drill: 'replacements', tone: 'amber' },
    ],
  });

  b.filterOptions = {
    clients: c.clientDesk ? clients : [],
    departments: depts.map((d) => d.department).filter(Boolean).sort(),
    sources: sourceGroups.map((g) => g.source).filter((s) => s && s.length <= 60),
  };
  b.quick.push({ id: 'reports', label: 'ATS Reports', to: '/reports/ats' });
  if (money) b.quick.push({ id: 'acc-reports', label: 'Accounts Reports', to: '/reports/accounts' });
  return b;
}

// ===========================================================================
// ADMIN
// ===========================================================================
const IMPORTANT = /role|permission|access|delete|remov|merge|import|password|status|approv|reject|login|user|scope|seat|position|lock/i;
async function adminBoard(c) {
  const b = newBoard('admin', 'Administration');
  const { D } = c;
  const since30 = new Date(Date.now() - 30 * DAY);
  const [users, activeToday, candidates, requirements, recent, audit, integrations, syncFailed, syncFailedBy, portalFailed, portalPending, profileReview, editRequests, leavePending] = await Promise.all([
    prisma.user.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.user.findMany({ where: { lastLoginAt: { gte: D.todayStart } }, select: { id: true }, orderBy: { lastLoginAt: 'desc' } }),
    prisma.candidate.count(),
    prisma.requirement.count(),
    prisma.user.findMany({ where: { lastLoginAt: { not: null } }, select: { id: true, name: true, role: true, atsRole: true, lastLoginAt: true, status: true }, orderBy: { lastLoginAt: 'desc' }, take: 10 }),
    prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 150, select: { id: true, action: true, entity: true, entityId: true, fromValue: true, toValue: true, actorName: true, createdAt: true, user: { select: { name: true } } } }),
    prisma.integration.findMany({ select: { id: true, enabled: true, connected: true, state: true, lastSync: true, recordsSynced: true, recordsFailed: true, error: true } }),
    prisma.syncLog.count({ where: { status: 'Failed', createdAt: { gte: since30 } } }),
    prisma.syncLog.groupBy({ by: ['entity'], where: { status: 'Failed', createdAt: { gte: since30 } }, _count: { _all: true } }),
    prisma.requirement.count({ where: { portalSyncStatus: 'Failed' } }),
    prisma.requirement.count({ where: { portalSyncStatus: 'Pending' } }),
    prisma.employee.findMany({ where: { pendingChanges: { not: null } }, select: { id: true, name: true, department: true, updatedAt: true }, orderBy: { updatedAt: 'asc' }, take: 20 }),
    prisma.employee.findMany({ where: { unlockRequestStatus: 'Pending' }, select: { id: true, name: true, department: true, unlockRequestReason: true, updatedAt: true }, orderBy: { updatedAt: 'asc' }, take: 20 }),
    prisma.leaveRequest.count({ where: { status: 'Pending' } }),
  ]);
  const totalUsers = users.reduce((s, g) => s + g._count._all, 0);
  const activeUsers = (users.find((g) => g.status === 'Active') || { _count: { _all: 0 } })._count._all;
  addSet(b, 'active-today', { kind: 'user', title: 'Signed in today', ids: activeToday.map((u) => u.id) });
  const intFailed = integrations.filter((i) => i.recordsFailed > 0 || /reconnect|expired/i.test(i.state) || i.error).length;
  const syncIssues = syncFailed + portalFailed + intFailed;
  b.counts.push(
    { id: 'users', label: 'Total users', value: totalUsers, sub: `${fmtN(activeUsers)} active`, to: '/admin/users' },
    { id: 'active-today', label: 'Active today', value: activeToday.length, sub: 'signed in today', drill: 'active-today' },
    { id: 'candidates', label: 'Candidates in ATS', value: candidates, sub: 'Candidate Master', to: '/candidates?view=master' },
    { id: 'requirements', label: 'Requirements', value: requirements, sub: 'all statuses', to: '/requirements?view=all' },
    {
      id: 'failed', label: 'Failed / duplicate entries', value: syncIssues, sub: 'sync failures + duplicate groups', to: '/admin/integrations',
      parts: [
        { id: 'sync', label: 'Job-portal sync failures (30 days)', value: syncFailed, to: '/admin/integrations?tab=jobportal' },
        { id: 'portal', label: 'Requirements failed to post', value: portalFailed, to: '/admin/integrations?tab=jobportal' },
        { id: 'integrations', label: 'Integrations with errors', value: intFailed, to: '/admin/integrations' },
        // Filled in the browser from the existing admin endpoints
        // (/candidates/duplicates/summary, /client-merge/count).
        { id: 'dup-candidates', label: 'Duplicate candidate groups', value: null, to: '/candidates/duplicates', fetch: '/candidates/duplicates/summary' },
        { id: 'dup-clients', label: 'Duplicate client groups', value: null, to: '/clients/duplicates', fetch: '/client-merge/count' },
      ],
    },
  );
  b.widgets.push({
    id: 'logins', type: 'logins', title: 'Recent logins', to: '/admin/users',
    rows: recent.map((u) => ({ id: u.id, name: u.name, role: u.atsRole && u.atsRole !== 'NONE' ? u.atsRole : u.role, at: u.lastLoginAt, status: u.status, today: u.lastLoginAt >= D.todayStart })),
  });
  b.widgets.push({
    id: 'audit', type: 'audit', title: 'Audit log — recent important changes', to: '/admin/audit',
    rows: audit.filter((x) => IMPORTANT.test(`${x.action} ${x.entity}`)).slice(0, 12).map((x) => ({
      id: x.id, action: x.action, entity: x.entity, who: x.actorName || (x.user ? x.user.name : 'System'), at: x.createdAt,
      detail: [x.fromValue, x.toValue].filter(Boolean).join(' → ').slice(0, 140),
    })),
  });
  b.widgets.push({
    id: 'sync', type: 'sync', title: 'Job source sync status', to: '/admin/integrations?tab=jobportal',
    rows: integrations.map((i) => ({
      id: i.id, state: i.state, enabled: i.enabled, lastSync: i.lastSync, synced: i.recordsSynced, failed: i.recordsFailed, error: i.error,
      tone: i.recordsFailed > 0 || i.error || /reconnect|expired/i.test(i.state) ? 'red' : (i.connected ? 'green' : 'grey'),
    })),
    extra: { syncFailed, byEntity: syncFailedBy.map((g) => ({ entity: g.entity, failed: g._count._all })), portalFailed, portalPending },
  });
  b.widgets.push({
    id: 'approvals', type: 'approvals', title: 'Pending approvals / requests',
    rows: [
      ...profileReview.map((e) => ({ id: `p-${e.id}`, kind: 'Profile changes to review', who: e.name, department: e.department, since: e.updatedAt, to: `/employees/${e.id}` })),
      ...editRequests.map((e) => ({ id: `u-${e.id}`, kind: 'Edit-access request', who: e.name, department: e.department, note: e.unlockRequestReason, since: e.updatedAt, to: `/employees/${e.id}` })),
    ],
    extra: { leavePending, leaveTo: '/leave' },
    note: 'Role-change requests are not recorded in the app today — roles are changed directly in Users / Role Catalog.',
  });
  b.quick.push(
    { id: 'add-user', label: 'Add User', to: '/admin/users', primary: true },
    { id: 'roles', label: 'Manage Roles', to: '/admin/roles' },
    { id: 'm-clients', label: 'Masters: Clients', to: '/clients' },
    { id: 'm-sources', label: 'Masters: Sources', to: '/admin/integrations', gap: 'No Sources master yet — job sources are configured under Integrations.' },
    { id: 'm-stages', label: 'Masters: Stages', to: '/ats/workflow', gap: 'No Stages master yet — the stage workflow is fixed; see the Workflow view.' },
  );
  return b;
}

// ===========================================================================
// ACCOUNTS DESK
// ===========================================================================
async function accountsDesk(user) {
  const { can } = require('../middleware/auth'); // eslint-disable-line global-require
  const b = newBoard('accounts', 'Accounts Desk');
  const D = days();
  const iw = invoiceWhere(user);
  const [invoices, joinedApps, payments, mayCreate, mayPay, mayReport] = await Promise.all([
    prisma.invoice.findMany({ where: iw, select: { id: true, invoiceNumber: true, clientId: true, candidateId: true, requirementId: true, amount: true, gst: true, tds: true, receivedAmount: true, status: true, invoiceDate: true, dueDate: true, client: { select: { name: true } }, candidate: { select: { name: true } } } }),
    prisma.application.findMany({
      where: { stage: { in: JOINED_STAGES } },
      select: {
        id: true, candidateId: true, requirementId: true, stage: true, hiringType: true, joiningDate: true, joinedAt: true, joiningStatus: true, billingStatus: true, offeredCtc: true,
        candidate: { select: { name: true } },
        requirement: { select: { title: true, internal: true, hiringType: true, clientId: true, client: { select: { name: true, guaranteePeriod: true, agreementFeePercent: true } } } },
      },
    }),
    prisma.invoicePayment.findMany({ where: { date: { gte: D.prevMonthStart }, invoice: { is: iw } }, select: { id: true, invoiceId: true, date: true, amount: true, method: true, reference: true } }),
    can(user, 'accounts', 'accounts', 'Invoices', 'create'),
    can(user, 'accounts', 'accounts', 'Payments', 'create'),
    can(user, null, 'reports', 'Accounts Reports', 'view'),
  ]);
  const live = invoices.filter((i) => A.deriveInvoiceStatus(i) !== 'Cancelled');

  // Joinings waiting for an invoice — the NewJoinModal's own rule
  // (routes/invoices.js pendingJoinGroups): joined client placements, not
  // marked Invoiced, with no invoice for that candidate + requirement (or
  // candidate + client for an invoice that names no requirement).
  const allInv = await prisma.invoice.findMany({ select: { candidateId: true, requirementId: true, clientId: true } });
  const billedPair = new Set(allInv.filter((i) => i.candidateId && i.requirementId).map((i) => `${i.candidateId}|${i.requirementId}`));
  const billedLoose = new Set(allInv.filter((i) => i.candidateId && !i.requirementId).map((i) => `${i.candidateId}|${i.clientId}`));
  const clientJoins = joinedApps.filter((a) => hiringTypeOf(a, a.requirement) !== INTERNAL_HIRE);
  const waiting = clientJoins.filter((a) => a.billingStatus !== 'Invoiced'
    && !billedPair.has(`${a.candidateId}|${a.requirementId}`)
    && !billedLoose.has(`${a.candidateId}|${a.requirement && a.requirement.clientId}`))
    // Newest joining first; a date in the future (a typo such as 2203) last.
    .sort((x, y) => {
      const fx = String(x.joiningDate || '') > D.t; const fy = String(y.joiningDate || '') > D.t;
      return (fx - fy) || String(y.joiningDate || '').localeCompare(String(x.joiningDate || ''));
    });
  const waitingMonth = waiting.filter((a) => String(a.joiningDate || '').slice(0, 7) === D.monthKey);

  const raisedMonth = live.filter((i) => String(i.invoiceDate || '').slice(0, 7) === D.monthKey);
  const open = live.filter((i) => A.invoiceOutstanding(i) > 0.5);
  const outstanding = A.ROUND(open.reduce((s, i) => s + A.invoiceOutstanding(i), 0));
  const paidMonth = payments.filter((p) => String(p.date).slice(0, 7) === D.monthKey);
  const paidPrev = payments.filter((p) => String(p.date).slice(0, 7) === D.prevMonthKey);
  const sumAmt = (list) => A.ROUND(list.reduce((s, x) => s + Number(x.amount || 0), 0));

  const gCtx = (a) => ({ guaranteeDays: guaranteeDaysOf(a.requirement && a.requirement.client && a.requirement.client.guaranteePeriod), today: new Date(), internal: false });
  const running = clientJoins.filter((a) => V.WORKFLOW_RULES.GUARANTEE_RUNNING(a, gCtx(a)))
    .map((a) => ({ a, end: iso(V.guaranteeEndOf(a, gCtx(a).guaranteeDays)) }))
    .sort((x, y) => x.end.localeCompare(y.end));

  addSet(b, 'waiting-month', { kind: 'accjoin', title: 'Joined this month — invoice pending', rows: waitingMonth });
  addSet(b, 'paid-month', { kind: 'pay', title: 'Payments received this month', ids: paidMonth.map((p) => p.id) });
  addSet(b, 'guarantee', { kind: 'accapp', title: 'Guarantee period running', rows: running });
  b.counts.push(
    { id: 'waiting-month', label: 'Joined this month', value: waitingMonth.length, sub: `invoice pending · ${fmtN(waiting.length)} waiting in all`, to: '/invoices?join=new', drill: 'waiting-month', tone: waitingMonth.length ? 'amber' : null },
    { id: 'raised', label: 'Invoices raised', value: raisedMonth.length, sub: `this month · ₹${fmtN(A.ROUND(raisedMonth.reduce((s, i) => s + Number(i.amount || 0), 0)))} before GST`, to: `/invoices?period=M:${D.monthKey}` },
    { id: 'pending', label: 'Payments pending', value: outstanding, money: true, sub: `${fmtN(open.length)} open invoices`, to: '/reports/accounts', tone: outstanding > 0 ? 'red' : null },
    { id: 'received', label: 'Payments received', value: sumAmt(paidMonth), money: true, sub: `this month · ${fmtN(paidMonth.length)} receipts`, drill: 'paid-month' },
    { id: 'guarantee', label: 'Guarantee period running', value: running.length, sub: 'placements still in guarantee', drill: 'guarantee' },
  );

  // ---- (B) ----
  b.pending.push({
    id: 'to-invoice', title: 'Joined candidates needing an invoice', kind: 'accjoin', total: waiting.length, to: '/invoices?join=new',
    rows: waiting.slice(0, 10).map((a) => accJoinRow(a)), empty: 'Every joining has its invoice.',
  });
  const bucket3 = (i) => {
    const bk = A.ageBucket(i);
    if (bk === '0–30 days') return '0-30';
    if (bk === '31–60 days') return '31-60';
    if (bk === '61–90 days' || bk === '90+ days') return '60+';
    return null;
  };
  const aging = { '0-30': { count: 0, amount: 0 }, '31-60': { count: 0, amount: 0 }, '60+': { count: 0, amount: 0 } };
  const overdue = [];
  open.forEach((i) => {
    const k = bucket3(i);
    if (!k) return;
    aging[k].count += 1;
    aging[k].amount = A.ROUND(aging[k].amount + A.invoiceOutstanding(i));
    overdue.push(i);
  });
  overdue.sort((x, y) => (A.daysOverdue(y.dueDate) || 0) - (A.daysOverdue(x.dueDate) || 0));
  b.pending.push({
    id: 'overdue', title: 'Overdue payments — aging', kind: 'aging', total: overdue.length,
    buckets: Object.entries(aging).map(([k, v]) => ({ id: k, label: `${k} days`, ...v, to: `/invoices?age=${encodeURIComponent(k)}`, tone: k === '0-30' ? 'amber' : 'red' })),
    rows: overdue.slice(0, 8).map((i) => ({ id: i.id, invoiceNumber: i.invoiceNumber, client: i.client ? i.client.name : '—', candidate: i.candidate ? i.candidate.name : null, dueDate: i.dueDate, daysOverdue: A.daysOverdue(i.dueDate), outstanding: A.invoiceOutstanding(i), to: `/invoices/${i.id}` })),
    empty: 'No payment is overdue.',
  });
  const replacements = clientJoins.filter((a) => a.joiningStatus === V.JOINING_REPLACEMENT_DUE);
  const invByPair = new Map(invoices.filter((i) => i.candidateId && i.requirementId).map((i) => [`${i.candidateId}|${i.requirementId}`, i]));
  b.pending.push({
    id: 'replacements', title: 'Replacement cases — credit note', kind: 'replacement', total: replacements.length,
    rows: replacements.slice(0, 10).map((a) => {
      const inv = invByPair.get(`${a.candidateId}|${a.requirementId}`);
      return { ...accJoinRow(a), invoiceId: inv ? inv.id : null, invoiceNumber: inv ? inv.invoiceNumber : null, invoiceStatus: inv ? A.deriveInvoiceStatus(inv) : null };
    }),
    empty: 'No candidate has left inside the guarantee period.',
    note: 'There is no credit-note document in the app yet: open the invoice to record the adjustment.',
  });

  // ---- (C) ----
  const byClient = new Map();
  open.forEach((i) => {
    const k = i.client ? i.client.name : '—';
    const e = byClient.get(k) || { client: k, outstanding: 0, invoices: 0, oldest: 0 };
    e.outstanding = A.ROUND(e.outstanding + A.invoiceOutstanding(i));
    e.invoices += 1;
    e.oldest = Math.max(e.oldest, A.daysOverdue(i.dueDate) || 0);
    byClient.set(k, e);
  });
  b.widgets.push({ id: 'client-outstanding', type: 'clientout', title: 'Client-wise outstanding', total: byClient.size, rows: [...byClient.values()].sort((x, y) => y.outstanding - x.outstanding).slice(0, 10).map((e) => ({ ...e, to: `/invoices?client=${encodeURIComponent(e.client)}` })), to: '/reports/accounts' });
  const billed = (mk) => A.ROUND(live.filter((i) => String(i.invoiceDate || '').slice(0, 7) === mk).reduce((s, i) => s + Number(i.amount || 0), 0));
  b.widgets.push({
    id: 'revenue', type: 'revenue', title: 'Revenue — this month vs last month', unit: 'money',
    rows: [
      { label: `${A.monthLabel(D.monthKey)} (this month)`, billed: billed(D.monthKey), received: sumAmt(paidMonth), to: `/invoices?period=M:${D.monthKey}` },
      { label: `${A.monthLabel(D.prevMonthKey)} (last month)`, billed: billed(D.prevMonthKey), received: sumAmt(paidPrev), to: `/invoices?period=M:${D.prevMonthKey}` },
    ],
    note: 'Billed = invoice value before GST by invoice date; received = receipts by payment date.',
  });
  const cal = running.filter((x) => x.end <= addDays(D.t, 30));
  b.widgets.push({ id: 'guarantee-cal', type: 'guaranteecal', title: 'Guarantee expiry — next 30 days', total: cal.length, rows: cal.slice(0, 20).map((x) => ({ ...accJoinRow(x.a), guaranteeEnds: x.end, tone: x.end <= addDays(D.t, 7) ? 'amber' : 'green' })) });

  // ---- (D) ----
  if (mayCreate) b.quick.push({ id: 'gen', label: 'Generate Invoice', to: '/invoices?join=new', primary: true });
  if (mayPay) b.quick.push({ id: 'pay', label: 'Record Payment', to: '/invoices?pay=1' });
  if (mayReport) b.quick.push({ id: 'report', label: 'Outstanding Report', to: '/reports/accounts' });
  b.paymentsById = new Map(payments.map((p) => [p.id, p]));
  b.invoicesById = new Map(invoices.map((i) => [i.id, i]));
  return b;
}
function accJoinRow(a) {
  const cli = a.requirement && a.requirement.client;
  const fee = cli ? cli.agreementFeePercent : null;
  return {
    id: a.id, applicationId: a.id, candidateId: a.candidateId, candidate: a.candidate ? a.candidate.name : '—',
    client: cli ? cli.name : '—', requirement: a.requirement ? a.requirement.title : null,
    joiningDate: a.joiningDate, offeredCtc: a.offeredCtc, feePercent: fee,
    billing: a.offeredCtc != null && fee != null ? A.ROUND((Number(a.offeredCtc) * Number(fee)) / 100) : null,
    generateTo: `/invoices?join=${a.id}`,
  };
}

// ===========================================================================
// WHICH BOARDS A LOGIN GETS
// ===========================================================================
function viewsFor(user) {
  const s = scopeOf(user);
  const r = s.atsRole;
  if (['SUPER_ADMIN', 'ADMIN'].includes(r)) return ['overview', 'management', 'admin'];
  if (['MANAGER', 'ASSISTANT_MANAGER'].includes(r)) return ['management', 'overview'];
  if (r === 'TL' || r === 'STL') return ['tl'];
  if (r === 'BDE') return ['bde'];
  if (r === 'RECRUITER' || r === 'HR') return ['recruiter'];
  return s.global ? ['overview', 'management'] : ['recruiter'];
}

async function buildBoard(user, view, req) {
  const c = await baseCtx(user, { rows: view !== 'admin' });
  const build = { recruiter: recruiterBoard, tl: tlBoard, bde: bdeBoard, management: managementBoard, admin: adminBoard }[view];
  if (!build) return null;
  const b = await build(c, req);
  b.clientDesk = c.clientDesk;
  b.scopeLabel = c.s.global ? 'All Company' : null;
  return b;
}

// The board as JSON (sets stay on the server).
function publicBoard(b, views) {
  const out = { ...b, views };
  delete out.sets;
  delete out.setExtra;
  delete out.paymentsById;
  delete out.invoicesById;
  return out;
}

// The rows behind one set — the same set the count was taken from.
async function drillRows(user, b, setId, { limit = 300 } = {}) {
  const set = b.sets.get(setId);
  if (!set) return null;
  const clientDesk = !!b.clientDesk;
  if (set.kind === 'group') {
    const out = await listWorkflowGroup(user, set.group, { limit });
    return { id: setId, title: set.title, kind: 'workflow', total: out ? out.total : 0, rows: out ? out.rows : [] };
  }
  if (set.kind === 'app') {
    return { id: setId, title: set.title, kind: 'app', total: set.ids.length, rows: await shapeApps(set.ids, { extra: set.extra || new Map(), clientDesk, limit }) };
  }
  if (set.kind === 'req') return { id: setId, title: set.title, kind: 'req', total: set.ids.length, rows: await shapeReqs(set.ids, { clientDesk, limit }) };
  if (set.kind === 'user') {
    const us = await prisma.user.findMany({ where: { id: { in: set.ids.slice(0, limit) } }, select: { id: true, name: true, role: true, atsRole: true, lastLoginAt: true, status: true }, orderBy: { lastLoginAt: 'desc' } });
    return { id: setId, title: set.title, kind: 'user', total: set.ids.length, rows: us.map((u) => ({ id: u.id, name: u.name, role: u.atsRole && u.atsRole !== 'NONE' ? u.atsRole : u.role, at: u.lastLoginAt, status: u.status })) };
  }
  if (set.kind === 'pay') {
    const rows = set.ids.slice(0, limit).map((id) => b.paymentsById.get(id)).filter(Boolean).map((p) => {
      const inv = b.invoicesById.get(p.invoiceId);
      return { id: p.id, date: p.date, amount: p.amount, method: p.method, reference: p.reference, invoiceId: p.invoiceId, invoiceNumber: inv ? inv.invoiceNumber : null, client: inv && inv.client ? inv.client.name : null };
    }).sort((x, y) => String(y.date).localeCompare(String(x.date)));
    return { id: setId, title: set.title, kind: 'pay', total: set.ids.length, rows };
  }
  if (set.kind === 'accjoin') return { id: setId, title: set.title, kind: 'accjoin', total: set.rows.length, rows: set.rows.slice(0, limit).map(accJoinRow) };
  if (set.kind === 'accapp') return { id: setId, title: set.title, kind: 'accjoin', total: set.rows.length, rows: set.rows.slice(0, limit).map((x) => ({ ...accJoinRow(x.a), guaranteeEnds: x.end })) };
  return null;
}

// ===========================================================================
// TODAY'S TASKS (top bar) — my follow-ups due today, my interviews today, my
// pending actions due today; Accounts: invoices falling due today.
// ===========================================================================
async function todayTasks(user) {
  const { can } = require('../middleware/auth'); // eslint-disable-line global-require
  const s = scopeOf(user);
  const D = days();
  const me = user.id;
  const ats = !!(user.products && user.products.ats) || !!user.atsAccess;
  const [mayAts, mayInv] = await Promise.all([
    can(user, 'ats', 'candidates', 'Applications', 'view'),
    can(user, 'accounts', 'accounts', 'Invoices', 'view'),
  ]);
  const out = { date: D.t, followUps: [], interviews: [], actions: [], invoices: [], counts: {} };
  if (ats && mayAts) {
    const appScope = applicationWhere(user);
    const mine = { OR: [{ recruiterId: me }, { recruiterIds: { contains: me } }, { bdeId: me }, { tlId: me }, { stlId: me }] };
    const [fus, ivs, waiting] = await Promise.all([
      prisma.applicationFollowUp.findMany({
        where: { completedAt: null, ownerUserId: me, dueDate: { lte: D.t }, application: { is: and(appScope, { stage: { notIn: ['REJECTED', 'JOINED', 'HIRED'] } }) } },
        select: { id: true, applicationId: true, candidateId: true, dueDate: true, dueTime: true, nextAction: true, purpose: true, createdAt: true, application: { select: { candidate: { select: { name: true } }, requirement: { select: { title: true } } } } },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.application.findMany({
        where: and(appScope, { interviewAt: { gte: D.todayStart, lt: D.tomorrowStart } }, LIVE_INTERVIEW, { requirement: { is: mine } }),
        select: { id: true, candidateId: true, interviewAt: true, interviewStatus: true, interviewRound: true, candidate: { select: { name: true } }, requirement: { select: { title: true } } },
        orderBy: { interviewAt: 'asc' },
        take: 30,
      }),
      prisma.application.findMany({
        where: and(appScope, { stage: { notIn: CLOSED } }, { requirement: { is: mine } }),
        select: { id: true, candidateId: true, stage: true, updatedAt: true, createdAt: true, source: true, portalImportedAt: true, candidate: { select: { name: true } }, requirement: { select: { title: true, recruiterId: true, bdeId: true, tlId: true, recruiterIds: true } } },
      }),
    ]);
    const seen = new Set();
    out.followUps = fus.filter((f) => (seen.has(f.applicationId) ? false : seen.add(f.applicationId))).map((f) => ({
      id: f.id, candidateId: f.candidateId, candidate: f.application && f.application.candidate ? f.application.candidate.name : '—',
      requirement: f.application && f.application.requirement ? f.application.requirement.title : null,
      due: f.dueDate.slice(0, 10), time: f.dueTime || null, what: f.nextAction || f.purpose || 'Follow up',
      tone: f.dueDate.slice(0, 10) < D.t ? 'red' : 'amber', to: `/candidates/${f.candidateId}`,
    })).sort((x, y) => (x.tone === y.tone ? 0 : x.tone === 'amber' ? -1 : 1));
    out.interviews = ivs.map((a) => ({
      id: a.id, candidateId: a.candidateId, candidate: a.candidate ? a.candidate.name : '—', requirement: a.requirement ? a.requirement.title : null,
      at: a.interviewAt, round: a.interviewRound, status: a.interviewStatus, tone: new Date(a.interviewAt) < new Date() && ['SCHEDULED', 'RESCHEDULED', null].includes(a.interviewStatus) ? 'red' : 'amber', to: `/candidates/${a.candidateId}`,
    }));
    // My pending actions: the stage's owner role is mine and its SLA falls due today.
    const roleWord = { RECRUITER: 'Recruiter', BDE: 'BDE', TL: 'TL', STL: 'TL', HR: 'Recruiter' }[s.atsRole] || null;
    out.actions = waiting.filter((a) => {
      if (V.isPreAtsApplication(a) && s.atsRole !== 'RECRUITER' && s.atsRole !== 'HR') return false;
      const rule = V.STAGE_OWNER_ACTION[a.stage] || {};
      const owner = rule.ownerRole;
      const r = a.requirement || {};
      const isMine = (owner === 'Recruiter' && (r.recruiterId === me || String(r.recruiterIds || '').split(',').includes(me)))
        || ((owner === 'BDE' || owner === 'Client') && r.bdeId === me)
        || (owner === 'TL' && r.tlId === me)
        || (!!roleWord && owner === roleWord && s.global);
      return isMine && V.applicationDueDate(a) === D.t;
    }).slice(0, 30).map((a) => ({
      id: a.id, candidateId: a.candidateId, candidate: a.candidate ? a.candidate.name : '—', requirement: a.requirement ? a.requirement.title : null,
      stage: V.stageLabel(a.stage), what: V.nextActionForStage(a.stage), tone: 'amber', to: `/candidates/${a.candidateId}`,
    }));
  }
  if (mayInv) {
    const invs = await prisma.invoice.findMany({
      where: and(invoiceWhere(user), { dueDate: { startsWith: D.t } }),
      select: { id: true, invoiceNumber: true, amount: true, gst: true, tds: true, receivedAmount: true, status: true, dueDate: true, invoiceDate: true, client: { select: { name: true } } },
    });
    out.invoices = invs.filter((i) => A.invoiceOutstanding(i) > 0.5).map((i) => ({
      id: i.id, invoiceNumber: i.invoiceNumber, client: i.client ? i.client.name : '—', outstanding: A.invoiceOutstanding(i), tone: 'amber', to: `/invoices/${i.id}`,
    }));
  }
  const overdueFu = out.followUps.filter((f) => f.tone === 'red').length;
  out.counts = {
    followUpsToday: out.followUps.length - overdueFu,
    followUpsOverdue: overdueFu,
    interviews: out.interviews.length,
    actions: out.actions.length,
    invoices: out.invoices.length,
  };
  out.total = out.followUps.length + out.interviews.length + out.actions.length + out.invoices.length;
  return out;
}

module.exports = {
  viewsFor, buildBoard, publicBoard, drillRows, accountsDesk, todayTasks, days,
};
