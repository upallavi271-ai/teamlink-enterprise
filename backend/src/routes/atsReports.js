// ---------------------------------------------------------------------------
// ATS REPORTS — "ATS Reports must measure the whole recruitment process."
//
//   Recruitment · Requirements · Candidates · Recruiters · Sources · Clients ·
//   Interviews · AI Interviews · Follow-ups · Joining · SLA & Aging
//
// The three report families that were here before — Recruitment, Interviews
// and Follow-ups, grouped by Department / Team / Recruiter / TL / STL / BDE /
// Client / Source / Location / Stage (routes/reports.js) — are KEPT, with the
// same groupings and the same headline numbers, and the other eight reports
// sit beside them. routes/reports.js itself is untouched.
//
// ONE PIPELINE. Stages are read through utils/pipelineView.js STAGE_GROUPS —
// the grouping the Candidates screen shows (New → AI Interview → Recruiter
// Review → TL Review → BDE Review → Client Review → Interview → Selected →
// Offer → Joining → Joined, with Hold and Rejected as views) — imported, not
// copied, so a report column and a Candidates tab can never disagree.
//
// SCOPED like the lists, never all-company by default. Every load goes
// through utils/scope.js requirementWhere() / applicationWhere() (see
// reportReqScope / reportAppScope below), so a Medical TL's report is
// Medical's numbers and nothing else, and the filter bar only ever narrows
// that — a filter or a drill-down URL naming something outside the scope
// simply finds nothing. Filters on a column go into the Prisma `where`; the
// few that are attributions (recruiter, TL, STL, BDE, source, joining
// outcome) are pre-narrowed there and matched exactly in loadContext().
//
// EVERY NUMBER IS A LIST. A figure is never a bare count: it is a Cell
// holding the ids behind it, and the report sends the Cell's size. The
// drill-down endpoint reads the SAME snapshot the figure was counted from and
// returns that one Cell's records, so "Pending Client Feedback: 5" opens
// exactly those five. The exports are built from the same structure.
//
// "REACHED" is cumulative: a candidate who got to the interview counts as
// shortlisted and shared as well, because they passed through both. How far
// an application got is the furthest of its current stage, its recorded stage
// events, its interview record (a status or an interview date), its offer
// record and a client-side rejection — imported history has few stage events,
// so without the interview and offer records an imported
// rejection-after-interview would read as a screening rejection.
// ---------------------------------------------------------------------------
const express = require('express');
const PDFDocument = require('pdfkit');
const XLSX = require('xlsx');
const prisma = require('../db');
const { requireAuth, requirePerm, can } = require('../middleware/auth');
const {
  applicationWhere, requirementWhere, scopeLabel, atsScopeOf: scopeOf, CLIENT_SHARED_STAGES, candidateWhere,
} = require('../utils/scope');
const {
  stageLabel, STAGE_OWNER_ACTION, REQUIREMENT_LIVE_STATUSES, requirementStatusLabel,
  normalizeRecommendation, isPortalSource, applicationIsOverdue, applicationDueDate,
  INTERVIEW_STATUS_CODES, interviewStatusLabel, AI_INTERVIEW_STATUSES,
} = require('../utils/atsVocab');
const { STAGE_GROUPS, stageIndex } = require('../utils/pipelineView');
const dateRange = require('../utils/dateRange');
const { didNotJoin } = require('../utils/joining'); // B9.8: one "Did not join" rule
const { toCsv } = require('../utils/tabularExport');
// Who a record is attributed to — the ATS-wide rule, shared with every
// screen's person filter (Candidates, Interviews, Recruiter & BDE …).
const workers = require('../utils/workers');

const router = express.Router();
router.use(requireAuth);

// The existing `reports` matrix decides who reads these (utils/permissions.js):
// view for the leads and BDEs, export for the roles allowed to take data away.
// An Accountant, a Recruiter or HR is refused here unless Role Catalog grants
// it — and if it does, the scope below still holds.
const VIEW = requirePerm(null, 'reports', 'ATS Reports', 'view');
const EXPORT = requirePerm(null, 'reports', 'ATS Reports', 'export');

// --- Report scope ------------------------------------------------------------
// The list helpers, plus the two narrowings a REPORT needs beyond a list:
//   HR       internal hiring only — TeamLink's own openings, not the client
//            pipeline HR can read for other reasons.
//   Client   only candidates actually shared with them, the same rule the
//            Candidates screen applies (CLIENT_SHARED_STAGES, now or ever).
function reportReqScope(user) {
  const s = scopeOf(user);
  const and = [requirementWhere(user)];
  if (!s.global && s.atsRole === 'HR') and.push({ internal: true });
  return { AND: and };
}
function reportAppScope(user) {
  const s = scopeOf(user);
  const and = [applicationWhere(user)];
  if (!s.global && s.atsRole === 'HR') and.push({ requirement: { is: { internal: true } } });
  if (!s.global && s.atsRole === 'CLIENT') {
    and.push({ OR: [{ stage: { in: CLIENT_SHARED_STAGES } }, { stageEvents: { some: { toStage: { in: CLIENT_SHARED_STAGES } } } }] });
  }
  return { AND: and };
}

// --- The pipeline -----------------------------------------------------------
// The Candidates screen's groups, plus Hold and Rejected as the two views.
const PIPE = [
  ...STAGE_GROUPS.map((g) => ({ id: g.id, label: g.label, stages: g.stages })),
  { id: 'hold', label: 'Hold', stages: ['HOLD'] },
  { id: 'rejected', label: 'Rejected', stages: ['REJECTED'] },
];
const PIPE_OF = {};
PIPE.forEach((g) => g.stages.forEach((s) => { PIPE_OF[s] = g; }));
const CLOSED_STAGES = ['REJECTED', 'JOINED', 'HIRED']; // the dashboard's own list
const JOINED_STAGES = ['JOINED', 'HIRED'];
const BEFORE_SELECTED = PIPE.slice(0, PIPE.findIndex((g) => g.id === 'selected')).flatMap((g) => g.stages);

// The steps "reached" is measured at, as positions on the stage chain.
const M = {
  review: stageIndex('RECRUITER_REVIEW'),
  shortlisted: stageIndex('RECRUITER_APPROVED'),
  shared: stageIndex('SHARED_WITH_CLIENT'),
  interview: stageIndex('INTERVIEW_SCHEDULED'),
  selected: stageIndex('SELECTED'),
  offer: stageIndex('OFFER'),
  accepted: stageIndex('OFFER_ACCEPTED'),
  joined: stageIndex('JOINED'),
};

const REQ_STATUS_FILTERS = {
  open: { label: 'Open', statuses: REQUIREMENT_LIVE_STATUSES },
  on_hold: { label: 'On Hold', statuses: ['ON_HOLD'] },
  closed: { label: 'Closed', statuses: ['CLOSED'] },
  draft: { label: 'Draft / Agreement Check', statuses: ['DRAFT', 'AGREEMENT_CHECK'] },
};
// The candidate's life status, as the Candidates screen's views have it.
const CAND_STATUS_FILTERS = {
  active: { label: 'Active (in pipeline)', where: { stage: { notIn: [...CLOSED_STAGES, 'HOLD'] } } },
  hold: { label: 'On Hold', where: { stage: 'HOLD' } },
  rejected: { label: 'Rejected', where: { stage: 'REJECTED' } },
  joined: { label: 'Joined', where: { stage: { in: JOINED_STAGES } } },
};

// The channels the user named, always listed on the Source report — at zero
// if nothing came from them, so an absent channel is visible as absent.
// Review #3 §12: exactly Naukri, Indeed, Shine, LinkedIn, Referral, Recruiter,
// BDE, Job Portal — everything else is "Other" (and still listed under its
// own name in "By source on file").
const CHANNELS = ['Naukri', 'Indeed', 'Shine', 'LinkedIn', 'Referral', 'Recruiter', 'BDE', 'Job Portal'];
// Several imported sheets carried a follow-up note in the source column. A
// sentence is not a source, so anything this long is reported under one
// bucket rather than as a hundred one-row "sources"; the drill-down still
// lists every one of them.
const FREE_TEXT = 'Other (notes in the source field)';
const NO_SOURCE = 'Not recorded';
const INTERNAL_CLIENT = '__internal__';

const DAY = 86400000;
const MIN_SAMPLES = 3; // fewer measured cases than this is "not enough data"
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
const avgOf = (vals) => (vals.length ? Math.round((vals.reduce((s, n) => s + n, 0) / vals.length) * 10) / 10 : null);
const clean = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const nameKey = (v) => clean(v).toLowerCase();

// --- Cells: a number that remembers what it counted -------------------------
class Cell {
  constructor(kind) {
    this.kind = kind; // app | req | cand | fu
    this.ids = new Set();
    this.vals = null; // id -> measured value (days, score) shown in the list
  }

  add(id, val) {
    this.ids.add(id);
    if (val !== undefined && val !== null) {
      if (!this.vals) this.vals = new Map();
      this.vals.set(id, val);
    }
    return this;
  }

  // The figure IS the number of records behind it, so a drill-down list is
  // always exactly as long as the number that was clicked.
  get n() { return this.ids.size; }
}

// A table. Columns with `drill` hold Cells; the rest hold plain values the
// builder sets itself.
function section(id, title, columns, extra = {}) {
  const rows = new Map();
  return {
    id, title, columns, rows, ...extra,
    row(key, init = {}) {
      if (!rows.has(key)) {
        const cells = {};
        columns.forEach((c) => { cells[c.key] = c.drill ? new Cell(c.drill) : null; });
        rows.set(key, { key, cells, refs: {}, ...init });
      }
      return rows.get(key);
    },
  };
}

// The total row: the UNION of every row's Cell per drillable column, which
// is right where one record sits in several rows (a requirement worked by two
// recruiters is still one requirement in the total).
function addTotal(sec, derive) {
  const total = { key: '__total__', cells: {}, refs: {} };
  sec.columns.forEach((c, i) => {
    if (c.drill) {
      const cell = new Cell(c.drill);
      sec.rows.forEach((r) => r.cells[c.key].ids.forEach((id) => {
        cell.add(id, r.cells[c.key].vals ? r.cells[c.key].vals.get(id) : undefined);
      }));
      total.cells[c.key] = cell;
    } else {
      total.cells[c.key] = i === 0 ? 'Total' : null;
    }
  });
  if (derive) derive(total.cells);
  sec.total = total;
}

function tileSet() {
  const tiles = [];
  const add = (key, label, kind, sub) => {
    const cell = new Cell(kind);
    tiles.push({ key, label, cell, sub });
    return cell;
  };
  const push = (key, label, cell, sub) => { tiles.push({ key, label, cell, sub }); };
  const value = (key, label, v, sub, type) => { tiles.push({ key, label, cell: null, value: v, sub, type }); };
  return { tiles, add, push, value };
}

// --- Filters ---------------------------------------------------------------
class BadRequest extends Error {
  constructor(message) { super(message); this.status = 400; }
}

const FILTER_KEYS = [
  'department', 'clientId', 'requirementId', 'recruiter', 'tl', 'stl', 'bde', 'location', 'source',
  'status', 'stage', 'interviewStatus', 'aiStatus', 'joiningStatus', 'positionCode',
  // Recruiter Performance: people=active | former (left in HRMS) | '' (all).
  'people',
];
// The person filters take the ATS-wide values ("id:<userId>" / "name:<name>",
// utils/workers.js) as well as this report's own keys ("u:…" / "n:…").
const PERSON_KEYS = ['recruiter', 'tl', 'stl', 'bde'];
function personKeyOf(v) {
  if (v.startsWith('id:')) return `u:${v.slice(3)}`;
  if (v.startsWith('name:')) return `n:${nameKey(v.slice(5))}`;
  return v;
}

function parseFilters(q = {}) {
  const s = (v) => (typeof v === 'string' ? v.trim() : '');
  const range = s(q.range) || 'all';
  let period = null;
  if (range !== 'all') {
    try {
      period = dateRange.resolve({ range, from: s(q.from), to: s(q.to) });
    } catch (err) {
      throw new BadRequest(err.message);
    }
  }
  const f = { range, period, groupBy: s(q.groupBy) };
  FILTER_KEYS.forEach((k) => { f[k] = s(q[k]); });
  PERSON_KEYS.forEach((k) => { if (f[k]) f[k] = personKeyOf(f[k]); });
  // Status is one dropdown with two families: a requirement's status
  // ("req:open") or a candidate's ("cand:hold").
  const [fam, val] = f.status.split(':');
  f.reqStatuses = fam === 'req' && REQ_STATUS_FILTERS[val] ? REQ_STATUS_FILTERS[val].statuses : null;
  f.candStatus = fam === 'cand' && CAND_STATUS_FILTERS[val] ? CAND_STATUS_FILTERS[val].where : null;
  f.stageCodes = (PIPE.find((g) => g.id === f.stage) || {}).stages || null;
  return f;
}

// The requirement half of the filter bar, as Prisma conditions.
function reqConditions(f) {
  const and = [];
  if (f.department) and.push({ department: f.department });
  if (f.clientId === INTERNAL_CLIENT) and.push({ internal: true });
  else if (f.clientId) and.push({ clientId: f.clientId, internal: false });
  if (f.requirementId) and.push({ id: f.requirementId });
  if (f.location) and.push({ location: f.location });
  if (f.reqStatuses) and.push({ status: { in: f.reqStatuses } });
  return and;
}

function requirementsWhere(user, f) {
  return { AND: [reportReqScope(user), ...reqConditions(f)] };
}

function applicationsWhere(user, f, dateField) {
  const and = [reportAppScope(user)];
  const rc = reqConditions(f);
  if (rc.length) and.push({ requirement: { is: { AND: rc } } });
  if (f.stageCodes) and.push({ stage: { in: f.stageCodes } });
  if (f.candStatus) and.push(f.candStatus);
  if (f.interviewStatus) and.push({ interviewStatus: f.interviewStatus });
  if (f.aiStatus) and.push({ aiInterviewStatus: f.aiStatus });
  if (f.period && dateField) and.push({ [dateField]: dateRange.dateTimeIn(f.period) });
  // A person / seat is an ATTRIBUTION (see loadContext), so the where only
  // narrows to rows that COULD carry them (utils/workers.js
  // attributionWhere / seatWhere, resolved in resolveReportPeople); the exact
  // match is made after the load.
  (f.narrow || []).forEach((w) => and.push(w));
  if (f.joiningStatus) and.push({ stage: { notIn: BEFORE_SELECTED } });
  return { AND: and };
}

// --- Sources ---------------------------------------------------------------
function sourceOf(a) {
  const raw = clean(a.source) || clean(a.firstSource) || clean(a.candidate && a.candidate.source)
    || clean(a.candidate && a.candidate.firstSource);
  if (!raw) return NO_SOURCE;
  if (raw.length > 40) return FREE_TEXT;
  if (isPortalSource(raw)) return 'TeamLink Job Portal';
  return raw;
}

// Which named channel a recorded source belongs to. Only unambiguous
// matches: "Profile screening" could be a portal or a recruiter's own
// sourcing, so it stays "Other" and appears under its own name.
function channelOf(source) {
  const k = source.toLowerCase();
  if (source === NO_SOURCE || source === FREE_TEXT) return 'Other';
  if (/naukr?a?i|nakri/.test(k)) return 'Naukri';
  if (/\bshine\b/.test(k)) return 'Shine';
  if (/indeed/.test(k)) return 'Indeed';
  if (/linked\s*-?\s*in/.test(k)) return 'LinkedIn';
  // The TeamLink website / job portal (isPortalSource() already folds its
  // spellings into "TeamLink Job Portal") and a plain "job portal".
  if (/^teamlink\b|job\s*portal|careers?\s*page|website/.test(k)) return 'Job Portal';
  if (/referr?al|referred|reference/.test(k)) return 'Referral';
  if (/^bde\b|^bd\s/.test(k)) return 'BDE';
  if (/^(recruiter|direct|self[\s-]*sourced)\b/.test(k)) return 'Recruiter';
  return 'Other';
}
// Exported for the tests: the channel a stored source value normalises to.
router.channelOf = (raw) => channelOf(sourceOf({ source: raw }));

// --- Joining outcome: one per selected candidate, so they add up ------------
const JOIN_OUTCOMES = {
  pending: 'Joining date not set',
  scheduled: 'Joining scheduled',
  overdue: 'Date passed, not joined',
  joined: 'Joined',
  noshow: 'Did not join',
  cancelled: 'Cancelled / declined',
  hold: 'On hold',
};
function joiningOutcome(x, today) {
  if (x.joined) return 'joined';
  // B9.8: marked "Did not join" at ANY step (Selected / Offer accepted /
  // Interview done too), one rule with the dashboard (utils/joining.js didNotJoin).
  if (didNotJoin(x.a)) return 'noshow';
  if (x.stage === 'HOLD') return 'hold';
  if (x.stage === 'REJECTED') {
    // They had a date, or had accepted: they did not turn up. Otherwise the
    // selection fell through before a joining was ever fixed.
    return x.a.joiningDate || x.a.offerStatus === 'Offer Accepted'
      ? 'noshow' : 'cancelled';
  }
  if (x.a.joiningDate || x.a.joiningStatus === 'Joining Scheduled') {
    return x.a.joiningDate && x.a.joiningDate < today ? 'overdue' : 'scheduled';
  }
  return 'pending';
}

// --- The scoped load --------------------------------------------------------
const APP_SELECT = {
  id: true, candidateId: true, requirementId: true, stage: true, createdAt: true, updatedAt: true,
  interviewStatus: true, interviewAt: true, interviewRescheduleCount: true, interviewResult: true,
  interviewer: true, interviewMode: true, interviewType: true,
  aiInterviewStatus: true, aiInterviewScore: true,
  offerStatus: true, joiningStatus: true, joiningDate: true,
  joinedAt: true, // spec D: the one joined date (joiningDate, then joinedAt, then the move)
  joinedAt: true, // Time to fill / Results vs target: the dashboard's join date (utils/reportsPlus.js)
  source: true, firstSource: true,
};
const REQ_SELECT = {
  id: true, reqCode: true, title: true, clientId: true, internal: true, department: true,
  location: true, status: true, openings: true, createdAt: true, recruiterId: true,
  bdeId: true, tlId: true, tl: true, stlId: true, stl: true, positionCode: true,
  client: { select: { name: true } },
  // spec D: the master Qualification / Specialisation (Specialization report).
  qualificationId: true, specialisationId: true,
};
const FU_SELECT = {
  id: true, applicationId: true, ownerUserId: true, ownerName: true, ownerPositionCode: true,
  tlName: true, bdeUserId: true, bdeName: true, dueDate: true, completedAt: true, createdAt: true,
  escalationLevel: true, outcome: true, nextAction: true, tlUserId: true,
};

// The person filters, resolved once per load: a name that is a login becomes
// that login's key (the same rule attribute() resolves by), and each person /
// seat adds its pre-narrowing `where` (f.narrow) to the application query.
async function resolveReportPeople(f) {
  if (f.narrow) return;
  f.narrow = [];
  const wanted = [['recruiter', 'RECRUITER'], ['tl', 'TL'], ['stl', null], ['bde', 'BDE']].filter(([k]) => f[k]);
  if (!wanted.length && !f.positionCode) return;
  const dir = await workers.loadDirectory();
  for (const [k, role] of wanted) {
    // eslint-disable-next-line no-await-in-loop
    const p = await workers.resolvePersonValue(f[k], dir);
    if (!p) continue;
    f[k] = p.key;
    if (role) f.narrow.push(workers.attributionWhere(role, p));
  }
  if (f.positionCode) f.narrow.push(workers.seatWhere(f.positionCode));
}

async function loadContext(user, f, { appDate = 'createdAt' } = {}) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  await resolveReportPeople(f);
  const appWhere = applicationsWhere(user, f, appDate);
  const [reqRows, appRows, users] = await Promise.all([
    prisma.requirement.findMany({ where: requirementsWhere(user, f), select: REQ_SELECT }),
    prisma.application.findMany({ where: appWhere, select: APP_SELECT }),
    prisma.user.findMany({ select: { id: true, name: true, team: true } }),
  ]);
  // The history rides on the same where through the relation, so no
  // 20,000-id IN list is ever sent.
  const [events, followUps, feedback, candSources] = await Promise.all([
    prisma.applicationStageEvent.findMany({
      where: { application: { is: appWhere } },
      select: {
        applicationId: true, fromStage: true, toStage: true, createdAt: true, actorSide: true,
        actorUserId: true, actorName: true, actorRole: true, actorPositionCode: true,
        // Rejection reasons report (spec 2026-10-03 §A3).
        reasonCategory: true, reasonDetail: true,
      },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.applicationFollowUp.findMany({
      where: { application: { is: appWhere } }, select: FU_SELECT, orderBy: { createdAt: 'asc' },
    }),
    prisma.interviewFeedback.findMany({
      where: { application: { is: appWhere } },
      select: { applicationId: true, kind: true, recommendation: true },
    }),
    // The candidate's source, only where the application carries none — a
    // join on every application cost a second on the full company.
    prisma.candidate.findMany({
      where: { applications: { some: { AND: [appWhere, { source: null, firstSource: null }] } } },
      select: { id: true, source: true, firstSource: true },
    }),
  ]);
  const candSource = new Map(candSources.map((c) => [c.id, c]));
  // Test / demo people (ZZTEST, @example.test) are never counted — the
  // dashboard's own rule (utils/atsHome.js isTest, on the candidate's name).
  const { isTest } = require('../utils/atsHome'); // eslint-disable-line global-require
  const testCands = new Set((await prisma.candidate.findMany({
    where: { OR: [{ name: { contains: 'zztest' } }, { name: { contains: 'example.test' } }] },
    select: { id: true, name: true },
  })).filter((c) => isTest(c.name)).map((c) => c.id));

  // People. A follow-up imported from a tracker names its recruiter as text
  // (some have left and have no login); a name that matches a login IS that
  // login, so one person is never two rows.
  const userById = new Map(users.map((u) => [u.id, u]));
  const userByName = new Map();
  users.forEach((u) => { if (!userByName.has(nameKey(u.name))) userByName.set(nameKey(u.name), u); });
  const person = (id, name) => {
    if (id && userById.has(id)) return { key: `u:${id}`, label: userById.get(id).name, team: userById.get(id).team };
    const u = userByName.get(nameKey(name));
    if (u) return { key: `u:${u.id}`, label: u.name, team: u.team };
    return clean(name) ? { key: `n:${nameKey(name)}`, label: clean(name), team: null } : null;
  };

  const reqMap = new Map();
  reqRows.forEach((r) => {
    reqMap.set(r.id, {
      ...r,
      clientKey: r.internal ? INTERNAL_CLIENT : r.clientId,
      clientName: r.internal ? 'TeamLink Internal' : (r.client && r.client.name) || '—',
      tl: person(r.tlId, r.tl),
      tlText: r.tl,
      stl: person(r.stlId, r.stl),
      recruiter: r.recruiterId ? person(r.recruiterId) : null,
      bde: r.bdeId ? person(r.bdeId) : null,
      ageDays: Math.max(0, Math.floor((now - r.createdAt) / DAY)),
      live: REQUIREMENT_LIVE_STATUSES.includes(r.status),
    });
  });

  const byApp = (rows) => {
    const m = new Map();
    rows.forEach((r) => {
      if (!m.has(r.applicationId)) m.set(r.applicationId, []);
      m.get(r.applicationId).push(r);
    });
    return m;
  };
  const evBy = byApp(events);
  const fuBy = byApp(followUps);
  const fbBy = byApp(feedback);
  const todayStart = new Date(`${today}T00:00:00.000Z`);

  const apps = [];
  appRows.forEach((a) => {
    const r = reqMap.get(a.requirementId);
    if (!r) return;
    if (testCands.has(a.candidateId)) return;
    a.candidate = candSource.get(a.candidateId) || null;
    const evs = evBy.get(a.id) || [];
    const fus = fuBy.get(a.id) || [];

    // How far it got — see the header.
    let reach = Math.max(0, stageIndex(a.stage));
    evs.forEach((e) => { reach = Math.max(reach, stageIndex(e.fromStage), stageIndex(e.toStage)); });
    if (a.interviewStatus || a.interviewAt) reach = Math.max(reach, M.interview);
    if (['Offer Released', 'Offer Declined'].includes(a.offerStatus)) reach = Math.max(reach, M.offer);
    if (a.offerStatus === 'Offer Accepted') reach = Math.max(reach, M.accepted);
    const lastReject = [...evs].reverse().find((e) => e.toStage === 'REJECTED');
    if (lastReject && lastReject.actorSide === 'Client') reach = Math.max(reach, M.shared);
    const joined = JOINED_STAGES.includes(a.stage);
    if (!joined) reach = Math.min(reach, M.accepted);

    // When it entered the stage it is in: its last move INTO that stage, or
    // the day it was added when no move was ever recorded.
    const into = [...evs].reverse().find((e) => e.toStage === a.stage);
    const since = into ? into.createdAt : a.createdAt;
    // The first recorded MOVE across each step. An event with no from-stage
    // is a record being created (or imported) already at that stage; its
    // timestamp is when it was keyed in, not when it happened, and would
    // measure every imported hire as taking seconds.
    const crossedAt = {};
    evs.forEach((e) => {
      if (!e.fromStage) return;
      Object.entries(M).forEach(([k, m]) => {
        if (!crossedAt[k] && stageIndex(e.toStage) >= m && stageIndex(e.fromStage) < m) crossedAt[k] = e.createdAt;
      });
    });

    // Attribution: the application's own follow-up owner (the imported
    // trackers put the recruiter, seat and TL there, including recruiters who
    // have since left), otherwise the requirement's, otherwise a real person
    // who moved it. ONE rule, utils/workers.js attribute(), shared with every
    // ATS screen's person filter so a filtered list and a report agree.
    const { recruiter, seat, tl, bde } = workers.attribute({
      recruiterId: r.recruiterId, tlId: r.tlId, tl: r.tlText, bdeId: r.bdeId, positionCode: r.positionCode,
    }, fus, evs, person);

    const fb = fbBy.get(a.id) || [];
    const clientFb = fb.find((x) => x.kind === 'Client') || fb.find((x) => x.kind === 'Internal');
    const closed = CLOSED_STAGES.includes(a.stage);
    // The dashboard's Past SLA rule, verbatim: the stage's SLA days after
    // the application last changed (utils/atsVocab.js applicationIsOverdue).
    const overdue = !closed && applicationIsOverdue(a);
    const due = overdue ? applicationDueDate(a) : null;

    const x = {
      id: a.id, a, req: r, stage: a.stage, pipe: PIPE_OF[a.stage] || PIPE[0], reach,
      lastReject: a.stage === 'REJECTED' ? (lastReject || null) : null,
      reached: (k) => (k === 'joined' ? joined : reach >= M[k]),
      screened: a.stage !== 'NEW' || reach > 0,
      joined,
      inPipeline: !closed,
      since, daysInStage: Math.max(0, Math.floor((now - since) / DAY)),
      crossedAt,
      source: sourceOf(a),
      recruiter: recruiter || { key: '—', label: 'Unassigned', team: null },
      seat, tl, stl: r.stl, bde,
      evs, // the stage history — Results vs target counts moves in the period (utils/reportsPlus.js)
      recommendation: normalizeRecommendation(clientFb && clientFb.recommendation)
        || normalizeRecommendation(a.interviewResult),
      waitingOnRecruiter: (STAGE_OWNER_ACTION[a.stage] || {}).ownerRole === 'Recruiter' && !closed,
      overdue,
      daysOverdue: due ? Math.max(0, Math.floor((todayStart - new Date(`${due}T00:00:00.000Z`)) / DAY)) : null,
      overdueFollowUp: fus.some((y) => !y.completedAt && y.dueDate && y.dueDate < today),
    };
    x.joinOutcome = x.reached('selected') ? joiningOutcome(x, today) : null;
    apps.push(x);
  });

  // The attribution filters: the exact match.
  const keyIs = (p, want) => !!p && p.key === want;
  let list = apps;
  if (f.recruiter) list = list.filter((x) => keyIs(x.recruiter, f.recruiter));
  if (f.tl) list = list.filter((x) => keyIs(x.tl, f.tl));
  if (f.stl) list = list.filter((x) => keyIs(x.stl, f.stl));
  if (f.bde) list = list.filter((x) => keyIs(x.bde, f.bde));
  // A seat (MED-3): the work attributed to it, whoever sat there.
  // Several seats (a hierarchy Section) come comma-separated.
  const seatSet = f.positionCode ? workers.seatCodes(f.positionCode) : null;
  if (seatSet) list = list.filter((x) => seatSet.includes(x.seat));
  // Case-insensitive, as the Source report merges "Nish technologies" and
  // "Nish Technologies" into one row.
  if (f.source) list = list.filter((x) => x.source.toLowerCase() === f.source.toLowerCase());
  if (f.joiningStatus) list = list.filter((x) => x.joinOutcome === f.joiningStatus);
  const appIds = new Set(list.map((x) => x.id));

  // Requirements the report counts: those raised in the range (when one is
  // set), and — when a person is chosen — those assigned to them or holding
  // one of their candidates. Candidate-only filters (source, stage, interview
  // / AI / joining status) describe candidates, so they do not remove
  // requirements.
  const reqsWithApps = new Set(list.map((x) => x.req.id));
  let reqs = [...reqMap.values()];
  if (f.period) {
    const within = dateRange.dateTimeIn(f.period);
    reqs = reqs.filter((r) => r.createdAt >= within.gte && r.createdAt < within.lt);
  }
  const personReq = (want, pick) => (r) => reqsWithApps.has(r.id) || keyIs(pick(r), want);
  if (f.recruiter) reqs = reqs.filter(personReq(f.recruiter, (r) => r.recruiter));
  if (f.tl) reqs = reqs.filter(personReq(f.tl, (r) => r.tl));
  if (f.stl) reqs = reqs.filter(personReq(f.stl, (r) => r.stl));
  if (f.bde) reqs = reqs.filter(personReq(f.bde, (r) => r.bde));
  if (seatSet) reqs = reqs.filter((r) => reqsWithApps.has(r.id) || seatSet.includes(r.positionCode));

  return {
    now, today, f, apps: list, reqs, reqMap, userById,
    followUps: followUps.filter((y) => appIds.has(y.applicationId)),
  };
}

// --- Shared pieces ---------------------------------------------------------
const AGE_BANDS = [
  { key: '0-2', label: '0–2 days', max: 2 },
  { key: '3-7', label: '3–7 days', max: 7 },
  { key: '8-15', label: '8–15 days', max: 15 },
  { key: '15plus', label: '15+ days', max: Infinity },
];
const REQ_AGE_BANDS = [
  { key: '0-7', label: '0–7 days', max: 7 },
  { key: '8-15', label: '8–15 days', max: 15 },
  { key: '16-30', label: '16–30 days', max: 30 },
  { key: '31-60', label: '31–60 days', max: 60 },
  { key: '60plus', label: '60+ days', max: Infinity },
];
const bandOf = (bands, d) => bands.find((b) => d <= b.max);

function reqStatusTiles(t, reqs) {
  const all = t.add('requirements', 'Total Requirements', 'req');
  const open = t.add('req_open', 'Open', 'req', 'Open, Recruiter Assigned, Sourcing, Candidates Available');
  const hold = t.add('req_hold', 'On Hold', 'req');
  const closed = t.add('req_closed', 'Closed', 'req');
  const draft = new Cell('req');
  reqs.forEach((r) => {
    all.add(r.id);
    if (r.live) open.add(r.id);
    else if (r.status === 'ON_HOLD') hold.add(r.id);
    else if (r.status === 'CLOSED') closed.add(r.id);
    else draft.add(r.id);
  });
  if (draft.ids.size) t.push('req_draft', 'Draft / Agreement Check', draft);
}

// ===========================================================================
// RECRUITMENT — the existing ATS report, kept: one scoped set of
// applications, counted by whichever grouping is asked for, so a department
// total and the sum of its recruiters can never disagree. The columns are
// where each application IS now, in the Candidates screen's own stages.
// ===========================================================================
const RECRUITMENT_GROUPS = {
  department: { label: 'Department / Specialization', of: (x) => x.req.department || '—' },
  team: { label: 'Team', of: (x) => x.recruiter.team || '—' },
  recruiter: { label: 'Recruiter', of: (x) => x.recruiter.label },
  tl: { label: 'TL', of: (x) => (x.tl && x.tl.label) || '—' },
  stl: { label: 'STL', of: (x) => (x.stl && x.stl.label) || '—' },
  bde: { label: 'BDE', of: (x) => (x.bde && x.bde.label) || '—' },
  client: { label: 'Client', of: (x) => x.req.clientName },
  source: { label: 'Source', of: (x) => x.source },
  location: { label: 'Location', of: (x) => clean(x.req.location) || '—' },
  stage: { label: 'Stage', of: (x) => x.pipe.label, order: PIPE.map((g) => g.label) },
};

function buildRecruitment(ctx) {
  const t = tileSet();
  const reqs = t.add('requirements', 'Requirements', 'req');
  const open = t.add('req_open', 'Open Requirements', 'req');
  ctx.reqs.forEach((r) => { reqs.add(r.id); if (r.live) open.add(r.id); });
  const people = t.add('candidates', 'Candidates', 'cand', 'unique people');
  const apps = t.add('applications', 'Applications', 'app');
  const pipeline = t.add('pipeline', 'In Pipeline', 'app', 'not rejected or joined');
  const byPipe = {};
  ['interview', 'selected', 'offer', 'joined', 'rejected', 'hold'].forEach((id) => {
    byPipe[id] = t.add(id, PIPE.find((g) => g.id === id).label, 'app', 'current stage');
  });
  ctx.apps.forEach((x) => {
    people.add(x.a.candidateId);
    apps.add(x.id);
    if (x.inPipeline) pipeline.add(x.id);
    if (byPipe[x.pipe.id]) byPipe[x.pipe.id].add(x.id);
  });
  t.value('conversion', 'Conversion', pct(byPipe.joined.n, apps.n), 'Joined ÷ Applications', 'pct');

  const groupBy = RECRUITMENT_GROUPS[ctx.f.groupBy] ? ctx.f.groupBy : 'department';
  const g = RECRUITMENT_GROUPS[groupBy];
  const derive = (c) => { c.conv = pct(c.joined.n, c.applications.n); };
  const sec = section('recruitment', `By ${g.label.toLowerCase()}`, [
    { key: 'group', label: g.label },
    { key: 'applications', label: 'Applications', drill: 'app' },
    { key: 'pipeline', label: 'In Pipeline', drill: 'app' },
    ...PIPE.map((p) => ({ key: p.id, label: p.label, drill: 'app' })),
    { key: 'conv', label: 'Conversion', type: 'pct' },
  ], {
    sub: 'Where each application is now, in the Candidates screen\'s stages. In Pipeline is everything not rejected or joined (Hold included). Conversion is Joined ÷ Applications.',
    groupBy,
    groupings: Object.entries(RECRUITMENT_GROUPS).map(([id, x]) => ({ id, label: x.label })),
    paged: true,
  });
  if (g.order) g.order.forEach((label) => { sec.row(label).cells.group = label; });
  ctx.apps.forEach((x) => {
    const key = g.of(x);
    const row = sec.row(key);
    row.cells.group = key;
    row.cells.applications.add(x.id);
    if (x.inPipeline) row.cells.pipeline.add(x.id);
    row.cells[x.pipe.id].add(x.id);
  });
  sec.rows.forEach((r) => derive(r.cells));
  if (!g.order) sec.sort = (a, b) => b.cells.applications.n - a.cells.applications.n;
  addTotal(sec, derive);

  // How far they got — cumulative, so the drop between steps is visible.
  const funnel = section('funnel', 'Pipeline conversion', [
    { key: 'step', label: 'Step' },
    { key: 'count', label: 'Reached', drill: 'app' },
    { key: 'ofAll', label: '% of applications', type: 'pct' },
    { key: 'ofPrev', label: '% of previous step', type: 'pct' },
  ], { sub: 'Cumulative — a candidate who reached a later step is counted in every earlier one.' });
  [
    ['applied', 'Applications', () => true],
    ['screened', 'Screened', (x) => x.screened],
    ['shortlisted', 'Recruiter Approved', (x) => x.reached('shortlisted')],
    ['shared', 'Client Shared', (x) => x.reached('shared')],
    ['interview', 'Interview', (x) => x.reached('interview')],
    ['selected', 'Selected', (x) => x.reached('selected')],
    ['offer', 'Offer', (x) => x.reached('offer')],
    ['joined', 'Joined', (x) => x.joined],
  ].forEach(([key, label, test]) => {
    const row = funnel.row(key);
    row.cells.step = label;
    ctx.apps.forEach((x) => { if (test(x)) row.cells.count.add(x.id); });
  });
  let prev = null;
  funnel.rows.forEach((row) => {
    row.cells.ofAll = pct(row.cells.count.n, apps.n);
    row.cells.ofPrev = prev === null ? null : pct(row.cells.count.n, prev);
    prev = row.cells.count.n;
  });

  // Review #3 §12 — the funnel has its own report now (buildFunnel), so the
  // Recruitment tab returns the stage matrix only; the funnel is not drawn
  // twice.
  return { tiles: t.tiles, sections: [sec] };
}

// ===========================================================================
// RECRUITMENT FUNNEL (review #3 §12) — Applications → Screening / Review →
// Shortlisted → Interview → Selected → Joined, with conversion. Cumulative:
// an application that reached a later step is counted in every earlier one,
// so each step is never larger than the one before it.
// ===========================================================================
const FUNNEL_STEPS = [
  { key: 'applied', label: 'Applications', test: () => true },
  { key: 'screened', label: 'Screening / Review', test: (x) => x.joined || x.screened },
  { key: 'shortlisted', label: 'Shortlisted', test: (x) => x.joined || x.reached('shortlisted') },
  { key: 'interview', label: 'Interview', test: (x) => x.joined || x.reached('interview') },
  { key: 'selected', label: 'Selected (incl. joined later)', test: (x) => x.joined || x.reached('selected') },
  { key: 'joined', label: 'Joined', test: (x) => x.joined },
];

function buildFunnel(ctx) {
  const t = tileSet();
  const funnel = section('funnel', 'Recruitment funnel', [
    { key: 'step', label: 'Step' },
    { key: 'count', label: 'Applications', drill: 'app' },
    { key: 'ofAll', label: '% of applications', type: 'pct' },
    { key: 'ofPrev', label: 'Conversion from previous step', type: 'pct' },
  ], { sub: 'Cumulative — an application that reached a later step is counted in every earlier one. Shortlisted = recruiter approved or further.' });
  FUNNEL_STEPS.forEach((st) => {
    const row = funnel.row(st.key);
    row.cells.step = st.label;
    ctx.apps.forEach((x) => { if (st.test(x)) row.cells.count.add(x.id); });
  });
  let prev = null;
  const all = funnel.rows.get('applied').cells.count.n;
  funnel.rows.forEach((row) => {
    row.cells.ofAll = pct(row.cells.count.n, all);
    row.cells.ofPrev = prev === null ? null : pct(row.cells.count.n, prev);
    prev = row.cells.count.n;
    t.push(row.key, row.cells.step, row.cells.count);
  });
  t.value('conversion', 'Conversion', pct(funnel.rows.get('joined').cells.count.n, all), 'Joined ÷ Applications', 'pct');

  const derive = (c) => { c.conv = pct(c.joined.n, c.applied.n); };
  const byDept = section('funnelDept', 'Funnel by department', [
    { key: 'department', label: 'Department' },
    ...FUNNEL_STEPS.map((st) => ({ key: st.key, label: st.label, drill: 'app' })),
    { key: 'conv', label: 'Conversion', type: 'pct' },
  ], { sub: 'The same steps per requirement department. Conversion is Joined ÷ Applications.' });
  ctx.apps.forEach((x) => {
    const d = x.req.department || '—';
    const c = byDept.row(d).cells;
    c.department = d;
    FUNNEL_STEPS.forEach((st) => { if (st.test(x)) c[st.key].add(x.id); });
  });
  byDept.rows.forEach((r) => derive(r.cells));
  byDept.sort = (a, b) => b.cells.applied.n - a.cells.applied.n;
  addTotal(byDept, derive);
  return { tiles: t.tiles, sections: [funnel, byDept] };
}

// ===========================================================================
// DEPARTMENT (review #3 §12) — one row per requirement department; the
// dashboard's old "Applications by department" chart lives here now.
// ===========================================================================
function buildDepartments(ctx) {
  const derive = (c) => { c.conv = pct(c.joined.n, c.applications.n); };
  const sec = section('departments', 'Department performance', [
    { key: 'department', label: 'Department' },
    { key: 'requirements', label: 'Requirements', drill: 'req' },
    { key: 'openReqs', label: 'Open requirements', drill: 'req' },
    { key: 'applications', label: 'Applications', drill: 'app' },
    { key: 'people', label: 'Candidates', drill: 'cand' },
    { key: 'pipeline', label: 'In pipeline', drill: 'app' },
    // v3 §5: Open, Submitted, Interviews, Selected, Joined per department.
    { key: 'shared', label: 'Client shared', drill: 'app' },
    { key: 'interviews', label: 'Interviews', drill: 'app' },
    { key: 'selected', label: 'Selected', drill: 'app' },
    { key: 'joined', label: 'Joined', drill: 'app' },
    { key: 'conv', label: 'Conversion', type: 'pct' },
  ], { sub: 'Requirements by the department they were raised for; applications by their requirement\'s department. Interviews / Selected are cumulative (reached). Conversion is Joined ÷ Applications.' });
  ctx.reqs.forEach((r) => {
    const d = r.department || '—';
    const c = sec.row(d).cells;
    c.department = d;
    c.requirements.add(r.id);
    if (r.live) c.openReqs.add(r.id);
  });
  ctx.apps.forEach((x) => {
    const d = x.req.department || '—';
    const c = sec.row(d).cells;
    c.department = d;
    c.applications.add(x.id);
    c.people.add(x.a.candidateId);
    if (x.inPipeline) c.pipeline.add(x.id);
    if (x.joined || x.reached('shared')) c.shared.add(x.id);
    if (x.joined || x.reached('interview')) c.interviews.add(x.id);
    if (x.joined || x.reached('selected')) c.selected.add(x.id);
    if (x.joined) c.joined.add(x.id);
  });
  sec.rows.forEach((r) => derive(r.cells));
  sec.sort = (a, b) => (a.key === '—') - (b.key === '—') || b.cells.applications.n - a.cells.applications.n;
  addTotal(sec, derive);
  const t = tileSet();
  const tot = sec.total.cells;
  t.value('departments', 'Departments', [...sec.rows.keys()].filter((k) => k !== '—').length);
  t.push('requirements', 'Requirements', tot.requirements);
  t.push('applications', 'Applications', tot.applications);
  t.push('interviews', 'Interviews', tot.interviews);
  t.push('selected', 'Selected', tot.selected);
  t.push('joined', 'Joined', tot.joined);
  t.value('conversion', 'Conversion', tot.conv, 'Joined ÷ Applications', 'pct');
  return { tiles: t.tiles, sections: [sec] };
}

// ===========================================================================
// REQUIREMENTS
// ===========================================================================
function buildRequirements(ctx) {
  const t = tileSet();
  reqStatusTiles(t, ctx.reqs);
  // Openings and Remaining are SUMS of positions, not a count of records, so
  // they are plain figures; the list behind them is the "with openings left"
  // tile, whose number is the count of requirements it opens.
  t.value('openings', 'Openings', 0, 'positions on these requirements');
  t.value('remaining', 'Remaining Openings', 0, 'open / on hold: openings − joined');
  const remaining = t.add('withRemaining', 'Requirements With Openings Left', 'req');
  const old = t.add('aged30', '30+ Days Open', 'req', 'open, raised 30+ days ago');
  const none = t.add('nocands', 'No Candidates Yet', 'req', 'open, nobody on them');

  const sec = section('requirements', 'Requirement-wise', [
    { key: 'code', label: 'Req ID', ref: 'req' },
    { key: 'title', label: 'Requirement', ref: 'req' },
    { key: 'client', label: 'Client' },
    { key: 'department', label: 'Department' },
    { key: 'recruiter', label: 'Recruiter' },
    { key: 'openings', label: 'Openings', type: 'num' },
    { key: 'candidates', label: 'Candidates', drill: 'app' },
    { key: 'interviews', label: 'Interviews', drill: 'app' },
    { key: 'selected', label: 'Selected', drill: 'app' },
    { key: 'joined', label: 'Joined', drill: 'app' },
    { key: 'remaining', label: 'Remaining', type: 'num' },
    { key: 'openDays', label: 'Open days', type: 'num' },
    { key: 'status', label: 'Status' },
  ], {
    sub: 'Openings → Candidates → Selected → Joined → Remaining. Open days run from the day the requirement was raised (no closing date is recorded). Where the requirement names no recruiter, the recruiters its candidates are attributed to are shown.',
    paged: true,
  });
  const inReport = new Set(ctx.reqs.map((r) => r.id));
  ctx.reqs.forEach((r) => {
    const row = sec.row(r.id, { refs: { req: r.id } });
    Object.assign(row.cells, {
      code: r.reqCode || '—', title: r.title, client: r.clientName, department: r.department || '—',
      recruiter: (r.recruiter && r.recruiter.label) || '—', status: requirementStatusLabel(r.status),
      openings: r.openings || 0, openDays: r.ageDays,
    });
  });
  const recruiterSeen = new Map();
  ctx.apps.forEach((x) => {
    if (!inReport.has(x.req.id)) return;
    const c = sec.row(x.req.id).cells;
    c.candidates.add(x.id);
    if (x.reached('interview')) c.interviews.add(x.id);
    if (x.reached('selected')) c.selected.add(x.id);
    if (x.joined) c.joined.add(x.id);
    if (!x.req.recruiter && x.recruiter.key !== '—') {
      if (!recruiterSeen.has(x.req.id)) recruiterSeen.set(x.req.id, new Set());
      recruiterSeen.get(x.req.id).add(x.recruiter.label);
    }
  });

  let openSum = 0;
  let remainingSum = 0;
  ctx.reqs.forEach((r) => {
    const c = sec.row(r.id).cells;
    if (c.recruiter === '—' && recruiterSeen.has(r.id)) c.recruiter = [...recruiterSeen.get(r.id)].sort().join(', ');
    c.remaining = r.live || r.status === 'ON_HOLD' ? Math.max(0, (r.openings || 0) - c.joined.n) : 0;
    openSum += r.openings || 0;
    if (c.remaining > 0) { remaining.add(r.id); remainingSum += c.remaining; }
    if (r.live && r.ageDays > 30) old.add(r.id, r.ageDays);
    if (r.live && c.candidates.n === 0) none.add(r.id);
  });
  t.tiles.find((x) => x.key === 'openings').value = openSum;
  t.tiles.find((x) => x.key === 'remaining').value = remainingSum;
  sec.sort = (a, b) => b.cells.candidates.n - a.cells.candidates.n || b.cells.openDays - a.cells.openDays;

  const aging = section('aging', 'Open requirements by age', [
    { key: 'band', label: 'Open for' },
    { key: 'reqs', label: 'Requirements', drill: 'req' },
    { key: 'openings', label: 'Openings', type: 'num' },
    { key: 'candidates', label: 'Candidates', drill: 'app' },
    { key: 'selected', label: 'Selected', drill: 'app' },
    { key: 'joined', label: 'Joined', drill: 'app' },
    { key: 'remaining', label: 'Remaining', type: 'num' },
  ], { sub: 'Open requirements only. Openings → Candidates → Selected → Joined → Remaining, per age band.' });
  REQ_AGE_BANDS.forEach((b) => Object.assign(aging.row(b.key).cells, { band: b.label, openings: 0, remaining: 0 }));
  ctx.reqs.filter((r) => r.live).forEach((r) => {
    const a = aging.row(bandOf(REQ_AGE_BANDS, r.ageDays).key).cells;
    const c = sec.row(r.id).cells;
    a.reqs.add(r.id, r.ageDays);
    a.openings += r.openings || 0;
    a.remaining += c.remaining;
    ['candidates', 'selected', 'joined'].forEach((k) => c[k].ids.forEach((id) => a[k].add(id)));
  });
  addTotal(aging, (c) => {
    Object.assign(c, { openings: 0, remaining: 0 });
    aging.rows.forEach((r) => { c.openings += r.cells.openings; c.remaining += r.cells.remaining; });
  });

  return { tiles: t.tiles, sections: [aging, sec] };
}

// ===========================================================================
// CANDIDATES — where everyone is, and for how long
// ===========================================================================
function stageAgingSection(ctx, id = 'aging') {
  const sec = section(id, 'Days in current stage', [
    { key: 'stage', label: 'Current stage' },
    { key: 'total', label: 'Candidates', drill: 'app' },
    ...AGE_BANDS.map((b) => ({ key: b.key, label: b.label, drill: 'app' })),
    { key: 'avg', label: 'Average days', type: 'num' },
  ], {
    sub: 'Measured from the last recorded move into the stage; where no move was recorded, from the day the candidate was added.',
  });
  PIPE.filter((g) => !['joined', 'rejected'].includes(g.id)).forEach((g) => { sec.row(g.id).cells.stage = g.label; });
  const days = new Map();
  ctx.apps.forEach((x) => {
    if (!sec.rows.has(x.pipe.id)) return;
    const row = sec.row(x.pipe.id);
    row.cells.total.add(x.id, x.daysInStage);
    row.cells[bandOf(AGE_BANDS, x.daysInStage).key].add(x.id, x.daysInStage);
    days.set(x.id, x.daysInStage);
  });
  const avg = (c) => { c.avg = avgOf([...c.total.ids].map((i) => days.get(i))); };
  sec.rows.forEach((r) => avg(r.cells));
  addTotal(sec, avg);
  return sec;
}

function buildCandidates(ctx) {
  const t = tileSet();
  const byPipe = {};
  PIPE.forEach((g) => { byPipe[g.id] = t.add(g.id, g.label, 'app', g.stages.map(stageLabel).join(', ')); });
  const people = t.add('people', 'Unique Candidates', 'cand');
  ctx.apps.forEach((x) => {
    byPipe[x.pipe.id].add(x.id, x.daysInStage);
    people.add(x.a.candidateId);
  });

  const detail = section('stages', 'Every stage', [
    { key: 'group', label: 'Stage' },
    { key: 'stage', label: 'Detail' },
    { key: 'count', label: 'Candidates', drill: 'app' },
  ], { sub: 'The stage codes folded into each stage, as the Candidates screen\'s detail line shows them.' });
  PIPE.forEach((g) => g.stages.forEach((s) => {
    const row = detail.row(s);
    row.cells.group = g.label;
    row.cells.stage = stageLabel(s);
  }));
  ctx.apps.forEach((x) => { if (detail.rows.has(x.stage)) detail.row(x.stage).cells.count.add(x.id, x.daysInStage); });
  [...detail.rows.keys()].forEach((k) => { if (!detail.rows.get(k).cells.count.n) detail.rows.delete(k); });
  addTotal(detail);

  const LIMIT = 250;
  const waiting = ctx.apps.filter((x) => x.inPipeline).sort((a, b) => b.daysInStage - a.daysInStage);
  const list = section('candidates', 'Candidate-wise current stage', [
    { key: 'candidate', label: 'Candidate', ref: 'cand' },
    { key: 'requirement', label: 'Requirement', ref: 'req' },
    { key: 'client', label: 'Client' },
    { key: 'stage', label: 'Stage' },
    { key: 'detail', label: 'Detail' },
    { key: 'days', label: 'Days in stage', type: 'num' },
    { key: 'recruiter', label: 'Recruiter' },
  ], {
    sub: waiting.length > LIMIT
      ? `The ${LIMIT} longest-waiting of ${waiting.length.toLocaleString('en-IN')} candidates still in the pipeline — click any figure above for its complete list.`
      : 'Every candidate still in the pipeline, longest-waiting first.',
    paged: true,
  });
  waiting.slice(0, LIMIT).forEach((x) => {
    const row = list.row(x.id, { refs: { cand: x.a.candidateId, req: x.req.id } });
    Object.assign(row.cells, {
      candidate: x.a.candidateId, requirement: `${x.req.reqCode ? `${x.req.reqCode} · ` : ''}${x.req.title}`,
      client: x.req.clientName, stage: x.pipe.label, detail: stageLabel(x.stage),
      days: x.daysInStage, recruiter: x.recruiter.label,
    });
  });

  return { tiles: t.tiles, sections: [stageAgingSection(ctx), detail, list] };
}

// ===========================================================================
// RECRUITER PERFORMANCE
// ===========================================================================
function buildRecruiters(ctx) {
  const derive = (c) => { c.conv = pct(c.joined.n, c.candidates.n); };
  const sec = section('recruiters', 'Recruiter-wise', [
    // Review #3 §12 — Requirements, Candidates, Interviews, Selected, Joined,
    // Conversion first; the detail columns after them.
    { key: 'recruiter', label: 'Recruiter' },
    { key: 'requirements', label: 'Requirements', drill: 'req' },
    { key: 'candidates', label: 'Candidates', drill: 'app' },
    { key: 'interviews', label: 'Interviews', drill: 'app' },
    { key: 'selected', label: 'Selected', drill: 'app' },
    { key: 'joined', label: 'Joined', drill: 'app' },
    { key: 'conv', label: 'Conversion', type: 'pct' },
    { key: 'seat', label: 'Seat' },
    { key: 'tl', label: 'TL' },
    // Moved here from Administration → Users: the clients a recruiter works
    // and the requirements still open on their desk.
    { key: 'clients', label: 'Assigned clients' },
    { key: 'open', label: 'Open requirements', drill: 'req' },
    { key: 'approved', label: 'Recruiter approved', drill: 'app' },
    { key: 'shared', label: 'Client shared', drill: 'app' },
    { key: 'pending', label: 'Pending actions', drill: 'app' },
    { key: 'overdue', label: 'Overdue actions', drill: 'app' },
  ], {
    sub: 'Attributed to the recruiter on the candidate\'s own follow-up record where there is one (imported trackers carry the recruiter, seat and TL there — including recruiters who have since left), otherwise to the requirement\'s recruiter. Pending actions: candidates at a stage waiting on the recruiter, or with an overdue follow-up. Overdue actions: those past the stage SLA (the dashboard\'s rule) or with an overdue follow-up.',
  });
  const seats = new Map();
  const tls = new Map();
  const clientsOf = new Map();
  const note = (m, key, v) => { if (!v) return; if (!m.has(key)) m.set(key, new Set()); m.get(key).add(v); };
  // FORMER PEOPLE (user, 2026-10-05): their old work stays theirs. A person
  // who has left HRMS carries "· Former"; ?people=active / former keeps one
  // side only (utils/formerPeople.js formerKeys, set by prepare below).
  const fk = ctx.formerKeys || new Set();
  const wantPeople = (ctx.f && ctx.f.people) || '';
  const isFormerP = (p) => !!p && fk.has(p.key);
  const keepP = (p) => !wantPeople || (wantPeople === 'former' ? isFormerP(p) : !isFormerP(p));
  const tagged = (p, label) => (isFormerP(p) ? `${label} · Former` : label);
  ctx.apps.forEach((x) => {
    if (!keepP(x.recruiter)) return;
    const c = sec.row(x.recruiter.key).cells;
    c.recruiter = tagged(x.recruiter, x.recruiter.label);
    note(seats, x.recruiter.key, x.seat);
    note(tls, x.recruiter.key, x.tl && x.tl.label);
    c.requirements.add(x.req.id);
    if (x.req.clientName && x.req.clientName !== '—') note(clientsOf, x.recruiter.key, x.req.clientName);
    if (x.req.live) c.open.add(x.req.id);
    c.candidates.add(x.id);
    if (x.reached('shortlisted')) c.approved.add(x.id);
    if (x.reached('shared')) c.shared.add(x.id);
    if (x.reached('interview')) c.interviews.add(x.id);
    if (x.reached('selected')) c.selected.add(x.id);
    if (x.joined) c.joined.add(x.id);
    const pending = x.waitingOnRecruiter || x.overdueFollowUp;
    if (pending) c.pending.add(x.id);
    if (pending && (x.overdue || x.overdueFollowUp)) c.overdue.add(x.id, x.daysOverdue);
  });
  // A recruiter's assigned requirements count even before anyone is on them.
  ctx.reqs.forEach((r) => {
    if (!r.recruiter || !keepP(r.recruiter)) return;
    const row = sec.row(r.recruiter.key);
    row.cells.recruiter = tagged(r.recruiter, r.recruiter.label);
    note(seats, r.recruiter.key, r.positionCode);
    note(tls, r.recruiter.key, r.tl && r.tl.label);
    row.cells.requirements.add(r.id);
    if (r.clientName && r.clientName !== '—') note(clientsOf, r.recruiter.key, r.clientName);
    if (r.live) row.cells.open.add(r.id);
  });
  sec.rows.forEach((r) => {
    // "3 · Lords, Methodist, St. Peter's" — the count, then up to three names.
    const names = [...(clientsOf.get(r.key) || [])].sort();
    r.cells.clients = names.length ? `${names.length} · ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3} more` : ''}` : '—';
    r.cells.seat = [...(seats.get(r.key) || [])].sort().join(', ') || '—';
    r.cells.tl = [...(tls.get(r.key) || [])].sort().join(', ') || '—';
    derive(r.cells);
  });
  sec.sort = (a, b) => (a.key === '—') - (b.key === '—') || b.cells.candidates.n - a.cells.candidates.n;
  addTotal(sec, derive);

  // ATS layout v3 §5 (2026-10-03) — Recruiter & BDE performance: the same
  // applications by their client manager (BDE), with the same "reached"
  // rule as the recruiter rows above (the Recruitment report's BDE grouping
  // attributes the same way), so a BDE's Joined and the recruiters' Joined
  // count the same people.
  const bdes = section('bdes', 'Client manager (BDE)-wise', [
    { key: 'bde', label: 'Client manager (BDE)' },
    { key: 'requirements', label: 'Requirements', drill: 'req' },
    { key: 'candidates', label: 'Candidates', drill: 'app' },
    { key: 'shared', label: 'Client shared', drill: 'app' },
    { key: 'interviews', label: 'Interviews', drill: 'app' },
    { key: 'selected', label: 'Selected', drill: 'app' },
    { key: 'joined', label: 'Joined', drill: 'app' },
    { key: 'conv', label: 'Conversion', type: 'pct' },
  ], { sub: 'Attributed to the client manager (BDE) of the job.', paged: true });
  ctx.apps.forEach((x) => {
    if (!keepP(x.bde)) return;
    const b = x.bde || { key: '—', label: 'No BDE' };
    const c = bdes.row(b.key).cells;
    c.bde = tagged(x.bde, b.label);
    c.requirements.add(x.req.id);
    c.candidates.add(x.id);
    if (x.reached('shared')) c.shared.add(x.id);
    if (x.reached('interview')) c.interviews.add(x.id);
    if (x.reached('selected')) c.selected.add(x.id);
    if (x.joined) c.joined.add(x.id);
  });
  ctx.reqs.forEach((r) => {
    if (!r.bde || !keepP(r.bde)) return;
    const c = bdes.row(r.bde.key).cells;
    c.bde = tagged(r.bde, r.bde.label);
    c.requirements.add(r.id);
  });
  bdes.rows.forEach((r) => derive(r.cells));
  bdes.sort = (a, b) => (a.key === '—') - (b.key === '—') || b.cells.candidates.n - a.cells.candidates.n;
  addTotal(bdes, derive);

  const t = tileSet();
  const tot = sec.total.cells;
  t.value('recruiters', 'Recruiters', [...sec.rows.keys()].filter((k) => k !== '—').length);
  t.push('handled', 'Candidates Handled', tot.candidates);
  t.push('approved', 'Recruiter Approved', tot.approved);
  t.push('shared', 'Client Shared', tot.shared);
  t.push('selected', 'Selected', tot.selected);
  t.push('joined', 'Joined', tot.joined);
  t.push('pending', 'Pending Actions', tot.pending, 'waiting on the recruiter');
  t.push('overdue', 'Overdue Actions', tot.overdue, 'past SLA');
  return { tiles: t.tiles, sections: [sec, bdes] };
}

// ===========================================================================
// SOURCE PERFORMANCE — Applications → Shortlisted → Interview → Selected →
// Joined, per channel and per source on file.
// ===========================================================================
function buildSources(ctx) {
  const derive = (c) => {
    c.toSelected = pct(c.selected.n, c.applications.n);
    c.selToJoined = pct(c.joined.n, c.selected.n);
    c.toJoined = pct(c.joined.n, c.applications.n);
  };
  const figures = [
    { key: 'applications', label: 'Applications', drill: 'app' },
    { key: 'people', label: 'Candidates', drill: 'cand' },
    // Screened / Client Shared / Rejected — the columns the Candidates page's
    // Source Analytics had, now that it lives here (review #3 §6 / §12).
    { key: 'screened', label: 'Screened', drill: 'app' },
    { key: 'shortlisted', label: 'Shortlisted', drill: 'app' },
    { key: 'clientShared', label: 'Client Shared', drill: 'app' },
    { key: 'interviews', label: 'Interview', drill: 'app' },
    { key: 'selected', label: 'Selected', drill: 'app' },
    { key: 'rejected', label: 'Rejected', drill: 'app' },
    { key: 'joined', label: 'Joined', drill: 'app' },
    { key: 'toSelected', label: 'Applied → Selected', type: 'pct' },
    { key: 'selToJoined', label: 'Selected → Joined', type: 'pct' },
    { key: 'toJoined', label: 'Applied → Joined', type: 'pct' },
  ];
  const count = (c, x) => {
    c.applications.add(x.id);
    c.people.add(x.a.candidateId);
    if (x.joined || x.screened) c.screened.add(x.id);
    if (x.joined || x.reached('shortlisted')) c.shortlisted.add(x.id);
    if (x.joined || x.reached('shared')) c.clientShared.add(x.id);
    if (x.joined || x.reached('interview')) c.interviews.add(x.id);
    if (x.joined || x.reached('selected')) c.selected.add(x.id);
    if (x.stage === 'REJECTED') c.rejected.add(x.id);
    if (x.joined) c.joined.add(x.id);
  };
  const channels = section('channels', 'Source performance', [{ key: 'channel', label: 'Channel' }, ...figures], {
    sub: 'The channels you named, always listed. A recorded source goes under a channel only on an unambiguous match (Naukri.com → Naukri, TeamLink website / job portal → Job Portal, "BDE …" → BDE, "Employee Referral" → Referral, and so on); everything else is Other and appears under its own name below. Shortlisted = recruiter approved or further.',
  });
  [...CHANNELS, 'Other'].forEach((c) => { channels.row(c).cells.channel = c; });
  const sources = section('sources', 'By source on file', [
    { key: 'source', label: 'Source' }, { key: 'channel', label: 'Channel' }, ...figures,
  ], { sub: 'The application\'s source, else the candidate\'s. Spellings that differ only in case are merged.', paged: true });
  const labelOf = new Map();
  ctx.apps.forEach((x) => {
    const key = x.source.toLowerCase();
    if (!labelOf.has(key)) labelOf.set(key, x.source);
    const row = sources.row(key);
    row.cells.source = labelOf.get(key);
    count(row.cells, x);
    count(channels.row(channelOf(x.source)).cells, x);
  });
  sources.rows.forEach((r) => { r.cells.channel = channelOf(r.cells.source); derive(r.cells); });
  channels.rows.forEach((r) => derive(r.cells));
  sources.sort = (a, b) => b.cells.applications.n - a.cells.applications.n;
  addTotal(sources, derive);
  addTotal(channels, derive);

  // PER CANDIDATE — the Candidates page's old Source Analytics, ported: each
  // person counted ONCE, under the source of their first application in
  // scope, at the furthest point any of their applications reached.
  const reach = [
    { key: 'screened', label: 'Screened', test: (x) => x.joined || x.screened },
    { key: 'shortlisted', label: 'Shortlisted', test: (x) => x.joined || x.reached('shortlisted') },
    { key: 'clientShared', label: 'Client Shared', test: (x) => x.joined || x.reached('shared') },
    { key: 'interviewed', label: 'Interviewed', test: (x) => x.joined || x.reached('interview') },
    { key: 'selected', label: 'Selected', test: (x) => x.joined || x.reached('selected') },
    { key: 'rejected', label: 'Rejected', test: (x) => x.stage === 'REJECTED' },
    { key: 'joined', label: 'Joined', test: (x) => x.joined },
  ];
  const perCand = section('sourceCandidates', 'Per candidate (furthest point reached)', [
    { key: 'channel', label: 'Channel' },
    { key: 'total', label: 'Candidates', drill: 'cand' },
    ...reach.map((r) => ({ key: r.key, label: r.label, drill: 'cand' })),
  ], { sub: 'Each candidate counted once, under the source of their first application in scope, and cumulatively at the furthest point any of their applications reached — someone rejected later still counts as screened and shared. Rejected = any application currently rejected.' });
  [...CHANNELS, 'Other'].forEach((c) => { perCand.row(c).cells.channel = c; });
  const firstApp = new Map();
  ctx.apps.forEach((x) => {
    const cur = firstApp.get(x.a.candidateId);
    if (!cur || x.a.createdAt < cur.a.createdAt) firstApp.set(x.a.candidateId, x);
  });
  ctx.apps.forEach((x) => {
    const c = perCand.row(channelOf(firstApp.get(x.a.candidateId).source)).cells;
    c.total.add(x.a.candidateId);
    reach.forEach((r) => { if (r.test(x)) c[r.key].add(x.a.candidateId); });
  });
  addTotal(perCand);

  const t = tileSet();
  CHANNELS.forEach((c) => t.push(`ch_${c}`, c, channels.row(c).cells.applications, 'applications'));
  t.push('ch_Other', 'Other sources', channels.row('Other').cells.applications, 'applications');
  return { tiles: t.tiles, sections: [channels, perCand, sources] };
}

// ===========================================================================
// CLIENT PERFORMANCE
// ===========================================================================
// Waiting on the client's word: shared and not yet reviewed, or interviewed
// and not yet decided.
const FEEDBACK_STAGES = ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'INTERVIEW_COMPLETED'];
const awaitingClient = (x) => FEEDBACK_STAGES.includes(x.stage)
  || (x.a.interviewStatus === 'PENDING_FEEDBACK' && x.inPipeline);

function buildClients(ctx) {
  const waits = new Map();
  const derive = (c) => { c.aging = avgOf([...c.feedback.ids].map((id) => waits.get(id))); };
  const sec = section('clients', 'Client performance', [
    // Review #3 §12 — Client, Requirements, Candidates, Interviews, Selected,
    // Joined first; the client-desk detail after them.
    { key: 'client', label: 'Client', ref: 'client' },
    { key: 'requirements', label: 'Requirements', drill: 'req' },
    { key: 'candidates', label: 'Candidates', drill: 'app' },
    { key: 'interviews', label: 'Interviews', drill: 'app' },
    { key: 'selected', label: 'Selected', drill: 'app' },
    { key: 'joined', label: 'Joined', drill: 'app' },
    { key: 'openReqs', label: 'Open reqs', drill: 'req' },
    { key: 'shared', label: 'Shared', drill: 'app' },
    { key: 'feedback', label: 'Feedback pending', drill: 'app' },
    { key: 'aging', label: 'Feedback aging (avg days)', type: 'num' },
    { key: 'waiting8', label: 'Waiting 8+ days', drill: 'app' },
    { key: 'rejected', label: 'Rejected', drill: 'app' },
    { key: 'hold', label: 'Hold', drill: 'app' },
  ], {
    sub: 'Feedback pending: shared and not yet reviewed, or interviewed and not yet decided; its aging is how long they have waited in that stage. Rejected and Hold count candidates the client had seen (shared or further) — one TeamLink screened out never reached the client.',
    paged: true,
  });
  const rowFor = (r) => {
    const row = sec.row(r.clientKey, { refs: r.internal ? {} : { client: r.clientId } });
    row.cells.client = r.clientName;
    return row;
  };
  ctx.reqs.forEach((r) => {
    const row = rowFor(r);
    row.cells.requirements.add(r.id);
    if (r.live) row.cells.openReqs.add(r.id);
  });
  ctx.apps.forEach((x) => {
    const c = rowFor(x.req).cells;
    c.candidates.add(x.id);
    if (x.reached('shared')) c.shared.add(x.id);
    if (x.reached('interview')) c.interviews.add(x.id);
    if (awaitingClient(x)) {
      c.feedback.add(x.id, x.daysInStage);
      waits.set(x.id, x.daysInStage);
      if (x.daysInStage >= 8) c.waiting8.add(x.id, x.daysInStage);
    }
    if (x.reached('selected')) c.selected.add(x.id);
    if (x.joined) c.joined.add(x.id);
    if (x.stage === 'REJECTED' && x.reached('shared')) c.rejected.add(x.id);
    if (x.stage === 'HOLD' && x.reached('shared')) c.hold.add(x.id);
  });
  sec.rows.forEach((r) => derive(r.cells));
  sec.sort = (a, b) => b.cells.candidates.n - a.cells.candidates.n || b.cells.requirements.n - a.cells.requirements.n;
  addTotal(sec, derive);

  const t = tileSet();
  const tot = sec.total.cells;
  t.value('clients', 'Clients', sec.rows.size);
  t.push('requirements', 'Requirements', tot.requirements);
  t.push('shared', 'Candidates Shared', tot.shared);
  t.push('interviews', 'Interviews', tot.interviews);
  t.push('feedback', 'Pending Client Feedback', tot.feedback);
  t.value('aging', 'Feedback Aging', tot.aging, 'average days waiting');
  t.push('waiting8', 'Feedback Waiting 8+ Days', tot.waiting8);
  t.push('selected', 'Selected', tot.selected);
  t.push('joined', 'Joined', tot.joined);
  t.push('rejected', 'Rejected (after sharing)', tot.rejected);
  t.push('hold', 'Hold (after sharing)', tot.hold);
  return { tiles: t.tiles, sections: [sec] };
}

// ===========================================================================
// INTERVIEWS — the existing client-interview report, kept: the applications
// with a recorded interview status, grouped as before, dated by the interview
// date. AI interviews are never in here; they have their own report.
// ===========================================================================
const IV_GROUPS = {
  department: { label: 'Department / Specialization', of: (x) => x.req.department || '—' },
  client: { label: 'Client', of: (x) => x.req.clientName },
  interviewer: { label: 'Interviewer', of: (x) => clean(x.a.interviewer) || '—' },
  recruiter: { label: 'Recruiter', of: (x) => x.recruiter.label },
  bde: { label: 'BDE', of: (x) => (x.bde && x.bde.label) || '—' },
  type: { label: 'Interview Type', of: (x) => clean(x.a.interviewType) || '—' },
  mode: { label: 'Mode', of: (x) => clean(x.a.interviewMode) || '—' },
};
const IV_COLS = [
  { key: 'total', label: 'Interviews', drill: 'app' },
  { key: 'scheduled', label: 'Scheduled', drill: 'app' },
  { key: 'confirmed', label: 'of which Confirmed / Started', drill: 'app' },
  { key: 'completed', label: 'Completed', drill: 'app' },
  { key: 'feedback', label: 'Feedback Pending', drill: 'app' },
  { key: 'rescheduled', label: 'Rescheduled', drill: 'app' },
  { key: 'cancelled', label: 'Cancelled', drill: 'app' },
  { key: 'noShow', label: 'No Show', drill: 'app' },
  { key: 'selected', label: 'Selected', drill: 'app' },
  { key: 'rejected', label: 'Rejected', drill: 'app' },
  { key: 'hold', label: 'Hold', drill: 'app' },
];
// The existing report's rules, unchanged: status for where it is, current
// stage for what came of it.
function interviewFacts(x) {
  const s = x.a.interviewStatus;
  const f = { total: true };
  if (['SCHEDULED', 'CONFIRMED', 'STARTED'].includes(s)) f.scheduled = true;
  if (['CONFIRMED', 'STARTED'].includes(s)) f.confirmed = true;
  if (['COMPLETED', 'FEEDBACK_SUBMITTED'].includes(s)) f.completed = true;
  if (s === 'PENDING_FEEDBACK') f.feedback = true;
  if (s === 'RESCHEDULED') f.rescheduled = true;
  if (s === 'CANCELLED') f.cancelled = true;
  if (s === 'NO_SHOW') f.noShow = true;
  if (x.stage === 'SELECTED') f.selected = true;
  if (x.stage === 'REJECTED') f.rejected = true;
  if (x.stage === 'HOLD') f.hold = true;
  return f;
}

// 'Required' is every application's default, so on its own it is not
// evidence of an AI interview; an AI stage, a later status or a score is.
const AI_STAGES = ['AI_INTERVIEW_REQUIRED', 'AI_INTERVIEW_SCHEDULED', 'AI_INTERVIEW_COMPLETED'];
const hadAi = (x) => AI_STAGES.includes(x.stage) || x.a.aiInterviewScore !== null
  || ['Scheduled', 'Started', 'Completed', 'Expired', 'Manual Review Requested'].includes(x.a.aiInterviewStatus);

function buildInterviews(ctx) {
  const list = ctx.apps.filter((x) => x.a.interviewStatus);
  const t = tileSet();
  const tiles = {};
  IV_COLS.forEach((c) => { tiles[c.key] = t.add(c.key, c.label.replace('of which ', ''), 'app'); });
  list.forEach((x) => Object.keys(interviewFacts(x)).forEach((k) => tiles[k].add(x.id)));
  // Imported interviews carry a date but no lifecycle status. They are not
  // silently dropped: this figure opens them.
  const dateOnly = t.add('dateOnly', 'Interview date, no status', 'app', 'imported history — in Recruitment\'s funnel');
  ctx.apps.forEach((x) => { if (!x.a.interviewStatus && x.a.interviewAt) dateOnly.add(x.id); });
  t.value('ai', 'AI Interviews', ctx.apps.filter(hadAi).length, 'separate — see AI Interviews');

  const groupBy = IV_GROUPS[ctx.f.groupBy] ? ctx.f.groupBy : 'department';
  const g = IV_GROUPS[groupBy];
  const sec = section('interviews', `By ${g.label.toLowerCase()}`, [{ key: 'group', label: g.label }, ...IV_COLS], {
    sub: 'Client and internal-panel interviews with a recorded status. Selected / Rejected / Hold are where the candidate is now. The AI interview is a separate report and its score never appears here.',
    groupBy,
    groupings: Object.entries(IV_GROUPS).map(([id, x]) => ({ id, label: x.label })),
    paged: true,
  });
  list.forEach((x) => {
    const key = g.of(x);
    const row = sec.row(key);
    row.cells.group = key;
    Object.keys(interviewFacts(x)).forEach((k) => row.cells[k].add(x.id));
  });
  sec.sort = (a, b) => b.cells.total.n - a.cells.total.n;
  addTotal(sec);

  // Where the interview is, by its exact lifecycle status.
  const st = section('statuses', 'By interview status', [
    { key: 'status', label: 'Interview status' },
    { key: 'count', label: 'Interviews', drill: 'app' },
  ]);
  INTERVIEW_STATUS_CODES.forEach((s) => { st.row(s).cells.status = interviewStatusLabel(s); });
  list.forEach((x) => { if (st.rows.has(x.a.interviewStatus)) st.row(x.a.interviewStatus).cells.count.add(x.id); });
  addTotal(st);
  return { tiles: t.tiles, sections: [sec, st] };
}

// ===========================================================================
// AI INTERVIEWS — kept apart from the client interview on purpose
// ===========================================================================
const SCORE_BANDS = [
  { key: '80', label: '80–100', min: 80 },
  { key: '60', label: '60–79', min: 60 },
  { key: '40', label: '40–59', min: 40 },
  { key: '0', label: 'Below 40', min: -Infinity },
];

function buildAi(ctx) {
  const list = ctx.apps.filter(hadAi);
  const t = tileSet();
  const all = t.add('total', 'AI Interviews', 'app');
  const required = t.add('required', 'Required', 'app', 'at AI Interview Required');
  const sched = t.add('scheduled', 'Scheduled', 'app');
  const started = t.add('started', 'Started', 'app');
  const done = t.add('completed', 'Completed', 'app');
  const expired = t.add('expired', 'Expired / Manual Review', 'app');
  const review = t.add('pending', 'Pending Review', 'app', 'completed, recruiter not yet decided');
  const scored = t.add('scored', 'Scored', 'app');
  const scores = [];
  list.forEach((x) => {
    const s = x.a.aiInterviewStatus;
    all.add(x.id);
    const completed = s === 'Completed' || x.stage === 'AI_INTERVIEW_COMPLETED' || x.a.aiInterviewScore !== null;
    if (x.stage === 'AI_INTERVIEW_REQUIRED' && !['Scheduled', 'Started', 'Completed'].includes(s)) required.add(x.id);
    if (s === 'Scheduled' || (x.stage === 'AI_INTERVIEW_SCHEDULED' && !['Started', 'Completed'].includes(s))) sched.add(x.id);
    if (s === 'Started') started.add(x.id);
    if (completed) done.add(x.id);
    if (s === 'Expired' || s === 'Manual Review Requested') expired.add(x.id);
    if (completed && x.stage === 'AI_INTERVIEW_COMPLETED') review.add(x.id);
    if (x.a.aiInterviewScore !== null) { scored.add(x.id, x.a.aiInterviewScore); scores.push(x.a.aiInterviewScore); }
  });
  t.value('avg', 'Average AI Score', avgOf(scores), 'AI screening only');

  // The AI score beside what the CLIENT later decided — side by side, never
  // one number, so a strong AI score is never read as a client selection.
  const bands = section('bands', 'AI score against the client\'s outcome', [
    { key: 'band', label: 'AI score' },
    { key: 'total', label: 'Candidates', drill: 'app' },
    { key: 'shared', label: 'Shared with client', drill: 'app' },
    { key: 'interviews', label: 'Client interview', drill: 'app' },
    { key: 'selected', label: 'Selected', drill: 'app' },
    { key: 'rejected', label: 'Rejected', drill: 'app' },
    { key: 'hold', label: 'Hold', drill: 'app' },
  ], { sub: 'The AI score is a screening signal. Client feedback and selection are recorded separately and are never derived from it.' });
  [...SCORE_BANDS, { key: 'none', label: 'Not scored' }].forEach((b) => { bands.row(b.key).cells.band = b.label; });
  list.forEach((x) => {
    const score = x.a.aiInterviewScore;
    const c = bands.row(score === null ? 'none' : SCORE_BANDS.find((b) => score >= b.min).key).cells;
    c.total.add(x.id, score);
    if (x.reached('shared')) c.shared.add(x.id);
    if (x.reached('interview')) c.interviews.add(x.id);
    if (x.reached('selected')) c.selected.add(x.id);
    if (x.stage === 'REJECTED') c.rejected.add(x.id);
    if (x.stage === 'HOLD') c.hold.add(x.id);
  });
  addTotal(bands);

  const byStatus = section('statuses', 'By AI interview status', [
    { key: 'status', label: 'AI interview status' },
    { key: 'count', label: 'Candidates', drill: 'app' },
  ]);
  AI_INTERVIEW_STATUSES.forEach((s) => { byStatus.row(s).cells.status = s; });
  list.forEach((x) => {
    const s = x.a.aiInterviewStatus || 'Required';
    const row = byStatus.row(s);
    row.cells.status = s;
    row.cells.count.add(x.id);
  });
  addTotal(byStatus);

  const notes = list.length ? [] : ['No AI interviews are recorded in this scope yet: no application has been moved to an AI interview stage or given an AI score. The figures fill as soon as one is.'];
  return { tiles: t.tiles, sections: [bands, byStatus], notes };
}

// ===========================================================================
// FOLLOW-UPS — the existing follow-up report, kept, with SLA aging added.
// Counted per follow-up record and dated by when it was raised.
// ===========================================================================
const FU_GROUPS = {
  owner: { label: 'Owner', of: (y) => clean(y.ownerName) || 'Unassigned' },
  department: { label: 'Department / Specialization', of: (y, x) => x.req.department || '—' },
  client: { label: 'Client', of: (y, x) => x.req.clientName },
};

function buildFollowUps(ctx) {
  const info = new Map(ctx.apps.map((x) => [x.id, x]));
  let list = ctx.followUps;
  if (ctx.f.period) {
    const w = dateRange.dateTimeIn(ctx.f.period);
    list = list.filter((y) => y.createdAt >= w.gte && y.createdAt < w.lt);
  }
  const lateBy = (y) => Math.floor((new Date(`${ctx.today}T00:00:00.000Z`) - new Date(`${y.dueDate}T00:00:00.000Z`)) / DAY);
  const state = (y) => {
    if (y.completedAt) return 'completed';
    if (y.dueDate && y.dueDate < ctx.today) return 'overdue';
    if (y.dueDate === ctx.today) return 'due';
    return 'upcoming';
  };
  const cols = [
    { key: 'total', label: 'Follow-ups', drill: 'fu' },
    { key: 'due', label: 'Due Today', drill: 'fu' },
    { key: 'overdue', label: 'Overdue', drill: 'fu' },
    ...AGE_BANDS.map((b) => ({ key: `od_${b.key}`, label: `Overdue ${b.label}`, drill: 'fu' })),
    { key: 'completed', label: 'Completed', drill: 'fu' },
    { key: 'escalated', label: 'Escalated', drill: 'fu' },
  ];
  const t = tileSet();
  const tiles = {};
  ['total', 'due', 'overdue', 'completed', 'escalated'].forEach((k) => { tiles[k] = t.add(k, cols.find((c) => c.key === k).label, 'fu'); });

  const groupBy = FU_GROUPS[ctx.f.groupBy] ? ctx.f.groupBy : 'owner';
  const g = FU_GROUPS[groupBy];
  const sec = section('followups', `By ${g.label.toLowerCase()}`, [{ key: 'group', label: g.label }, ...cols], {
    sub: 'Overdue is measured against the date somebody committed to, in days past it. Escalated counts follow-ups that have passed their owner; the owner stays responsible at every rung.',
    groupBy,
    groupings: Object.entries(FU_GROUPS).map(([id, x]) => ({ id, label: x.label })),
    paged: true,
  });
  const outcomes = section('outcomes', 'Outcomes', [
    { key: 'outcome', label: 'What happened' },
    { key: 'count', label: 'Follow-ups', drill: 'fu' },
  ], { sub: 'Whether the chasing is achieving anything, not just happening.' });
  list.forEach((y) => {
    const x = info.get(y.applicationId);
    if (!x) return;
    const key = g.of(y, x);
    const c = sec.row(key).cells;
    c.group = key;
    const hit = (k, v) => { c[k].add(y.id, v); if (tiles[k]) tiles[k].add(y.id, v); };
    hit('total');
    const s = state(y);
    if (s === 'completed') hit('completed');
    if (s === 'due') hit('due');
    if (s === 'overdue') {
      const d = lateBy(y);
      hit('overdue', d);
      c[`od_${bandOf(AGE_BANDS, d).key}`].add(y.id, d);
    }
    if (y.escalationLevel > 0) hit('escalated');
    if (y.outcome) {
      const o = outcomes.row(y.outcome);
      o.cells.outcome = y.outcome;
      o.cells.count.add(y.id);
    }
  });
  sec.sort = (a, b) => b.cells.overdue.n - a.cells.overdue.n || b.cells.total.n - a.cells.total.n;
  outcomes.sort = (a, b) => b.cells.count.n - a.cells.count.n;
  addTotal(sec);
  return { tiles: t.tiles, sections: [sec, outcomes] };
}

// ===========================================================================
// JOINING
// ===========================================================================
function buildJoining(ctx) {
  const list = ctx.apps.filter((x) => x.reached('selected'));
  const derive = (c) => { c.conv = pct(c.joined.n, c.selected.n); };
  const t = tileSet();
  const sel = t.add('selected', 'Selected', 'app', 'reached selection');
  const offer = t.add('offer', 'Offer', 'app', 'offer made');
  const accepted = t.add('accepted', 'Offer Accepted', 'app');
  const out = {};
  Object.entries(JOIN_OUTCOMES).forEach(([k, label]) => { out[k] = t.add(k, label, 'app'); });
  out.noshow.sub = 'had a joining date or accepted the offer';
  out.cancelled.sub = 'offer declined / withdrawn before a date';

  const sec = section('requirements', 'Requirement-wise joining conversion', [
    { key: 'code', label: 'Req ID', ref: 'req' },
    { key: 'title', label: 'Requirement', ref: 'req' },
    { key: 'client', label: 'Client' },
    { key: 'openings', label: 'Openings', type: 'num' },
    { key: 'selected', label: 'Selected', drill: 'app' },
    { key: 'offer', label: 'Offer', drill: 'app' },
    { key: 'accepted', label: 'Offer Accepted', drill: 'app' },
    ...Object.entries(JOIN_OUTCOMES).map(([key, label]) => ({ key, label, drill: 'app' })),
    { key: 'conv', label: 'Joining conversion', type: 'pct' },
  ], {
    sub: 'Every selected candidate has exactly one joining outcome, so the outcome columns add up to Selected. Offer and Offer Accepted are how far the offer got.',
    paged: true,
  });
  list.forEach((x) => {
    const row = sec.row(x.req.id, { refs: { req: x.req.id } });
    const c = row.cells;
    Object.assign(c, { code: x.req.reqCode || '—', title: x.req.title, client: x.req.clientName, openings: x.req.openings || 0 });
    sel.add(x.id);
    c.selected.add(x.id);
    if (x.reached('offer')) { offer.add(x.id); c.offer.add(x.id); }
    if (x.reached('accepted')) { accepted.add(x.id); c.accepted.add(x.id); }
    out[x.joinOutcome].add(x.id);
    c[x.joinOutcome].add(x.id);
  });
  sec.rows.forEach((r) => derive(r.cells));
  sec.sort = (a, b) => b.cells.selected.n - a.cells.selected.n;
  addTotal(sec, derive);
  t.value('conv', 'Joining Conversion', pct(out.joined.n, sel.n), 'Joined ÷ Selected', 'pct');
  return { tiles: t.tiles, sections: [sec] };
}

// ===========================================================================
// SLA & AGING
// ===========================================================================
// The dashboard's Past SLA, broken the same way (routes/dashboard.js §19):
// Reviews past SLA = Candidate + TL + BDE Review below, and every row
// together is the dashboard's Past SLA total, so the two screens agree.
const SLA_ROWS = [
  { key: 'candidate', label: 'Recruiter Review', stages: ['NEW', 'RECRUITER_REVIEW', 'RECRUITER_APPROVED'] },
  { key: 'tl', label: 'TL Review', stages: ['TL_REVIEW'] },
  { key: 'bde', label: 'BDE Review', stages: ['WITH_BDE'] },
  { key: 'client', label: 'Client Review', stages: ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW'] },
  { key: 'feedback', label: 'Interview Feedback', stages: ['INTERVIEW_COMPLETED'] },
  { key: 'joining', label: 'Joining Confirmation', stages: ['SELECTED', 'OFFER', 'OFFER_ACCEPTED'] },
];
const slaRowOf = (stage) => (SLA_ROWS.find((r) => r.stages.includes(stage)) || { key: 'other' }).key;

// Durations come ONLY from recorded stage moves. A step with fewer than
// MIN_SAMPLES measured cases says so rather than printing an average of one.
const TRANSITIONS = [
  { key: 'screen_short', label: 'Screening → Recruiter approved', from: 'review', to: 'shortlisted' },
  { key: 'short_share', label: 'Recruiter approved → Client share', from: 'shortlisted', to: 'shared' },
  { key: 'share_iv', label: 'Client share → Interview', from: 'shared', to: 'interview' },
  { key: 'iv_sel', label: 'Interview → Selection', from: 'interview', to: 'selected' },
  { key: 'sel_join', label: 'Selection → Joining', from: 'selected', to: 'joined' },
  { key: 'hire', label: 'Overall time-to-hire (added → joined)', from: 'added', to: 'joined' },
];

function stats(values) {
  const v = [...values].sort((a, b) => a - b);
  const r1 = (n) => Math.round(n * 10) / 10;
  const mid = Math.floor(v.length / 2);
  return {
    avg: avgOf(v), median: r1(v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2), min: r1(v[0]), max: r1(v[v.length - 1]),
  };
}

function buildSla(ctx) {
  const t = tileSet();
  const past = t.add('pastSla', 'Past SLA', 'app', 'as on the ATS dashboard');
  const reviews = t.add('reviews', 'Reviews past SLA', 'app', 'Candidate + TL + BDE review');
  const tileOf = {};
  SLA_ROWS.slice(3).forEach((r) => { tileOf[r.key] = t.add(r.key, `${r.label} overdue`, 'app'); });

  const sla = section('sla', 'Overdue by SLA', [
    { key: 'what', label: 'Waiting on' },
    { key: 'inStage', label: 'In these stages', drill: 'app' },
    { key: 'overdue', label: 'Overdue', drill: 'app' },
    ...AGE_BANDS.map((b) => ({ key: b.key, label: `${b.label} late`, drill: 'app' })),
  ], {
    sub: 'The dashboard\'s rule: each stage\'s SLA days, counted from the last change to the application. Late = days past that due date.',
  });
  [...SLA_ROWS, { key: 'other', label: 'Other stages' }].forEach((r) => { sla.row(r.key).cells.what = r.label; });
  ctx.apps.forEach((x) => {
    if (!x.inPipeline) return;
    const key = slaRowOf(x.stage);
    const c = sla.row(key).cells;
    c.inStage.add(x.id);
    if (!x.overdue) return;
    c.overdue.add(x.id, x.daysOverdue);
    c[bandOf(AGE_BANDS, x.daysOverdue).key].add(x.id, x.daysOverdue);
    past.add(x.id, x.daysOverdue);
    if (['candidate', 'tl', 'bde'].includes(key)) reviews.add(x.id, x.daysOverdue);
    if (tileOf[key]) tileOf[key].add(x.id, x.daysOverdue);
  });
  addTotal(sla);

  const live = ctx.reqs.filter((r) => r.live);
  const reqAging = section('reqAging', 'Requirement open days', [
    { key: 'band', label: 'Open for' },
    { key: 'reqs', label: 'Open requirements', drill: 'req' },
  ]);
  REQ_AGE_BANDS.forEach((b) => { reqAging.row(b.key).cells.band = b.label; });
  live.forEach((r) => reqAging.row(bandOf(REQ_AGE_BANDS, r.ageDays).key).cells.reqs.add(r.id, r.ageDays));
  addTotal(reqAging);
  t.value('reqAge', 'Avg Requirement Open Days', avgOf(live.map((r) => r.ageDays)), 'open requirements');

  const tr = section('transitions', 'Time between steps', [
    { key: 'step', label: 'Step' },
    { key: 'samples', label: 'Measured cases', drill: 'app' },
    { key: 'avg', label: 'Average days', type: 'num' },
    { key: 'median', label: 'Median days', type: 'num' },
    { key: 'min', label: 'Fastest', type: 'num' },
    { key: 'max', label: 'Slowest', type: 'num' },
    { key: 'status', label: 'Reading' },
  ], {
    sub: `Measured from recorded stage moves only (imported rows carry no move history). Screening starts when the candidate is added unless a move into review was recorded. Fewer than ${MIN_SAMPLES} measured cases reads "Not enough data".`,
  });
  TRANSITIONS.forEach((d) => {
    const row = tr.row(d.key);
    row.cells.step = d.label;
    const vals = [];
    ctx.apps.forEach((x) => {
      const end = d.to === 'joined' ? (x.joined && x.crossedAt.joined) : x.crossedAt[d.to];
      if (!end) return;
      let start = d.from === 'added' ? x.a.createdAt : x.crossedAt[d.from];
      if (!start && d.from === 'review') start = x.a.createdAt;
      if (!start) return;
      const days = (end - start) / DAY;
      if (days < 0) return;
      row.cells.samples.add(x.id, Math.round(days * 10) / 10);
      vals.push(days);
    });
    if (vals.length >= MIN_SAMPLES) Object.assign(row.cells, stats(vals), { status: 'Measured' });
    else Object.assign(row.cells, { avg: null, median: null, min: null, max: null, status: `Not enough data (${vals.length} measured)` });
  });

  // B9.2 — CLIENT PROMISES: each client's own "Feedback within N days" and
  // "Send first profiles within N days" (utils/clientSla.js; blank = the
  // Step-timing default), and how the open jobs stand against them.
  const CS = require('../utils/clientSla'); // eslint-disable-line global-require
  const promises = section('clientSla', 'Client promises (per-client SLA)', [
    { key: 'client', label: 'Client', ref: 'client' },
    { key: 'feedbackDays', label: 'Feedback within (days)', type: 'num' },
    { key: 'firstDays', label: 'First profiles within (days)', type: 'num' },
    { key: 'openJobs', label: 'Open jobs', drill: 'req' },
    { key: 'firstOk', label: 'First profiles sent in time', drill: 'req' },
    { key: 'firstLate', label: 'First profiles late', drill: 'req' },
    { key: 'feedbackWaiting', label: 'Waiting for client feedback', drill: 'app' },
    { key: 'feedbackLate', label: 'Feedback late now', drill: 'app' },
  ], {
    sub: 'A client\'s own numbers (Clients → client → Client promises) or the Step-timing defaults. First profiles = from the day the job was raised to the first profile sent to the client; Feedback late = profiles with the client past that client\'s days.',
    paged: true,
  });
  const firstSharedOf = new Map();
  ctx.apps.forEach((x) => {
    const at = x.crossedAt.shared ? new Date(x.crossedAt.shared).getTime() : null;
    if (at && (!firstSharedOf.has(x.req.id) || at < firstSharedOf.get(x.req.id))) firstSharedOf.set(x.req.id, at);
  });
  const nowMs = Date.now();
  ctx.reqs.filter((r) => r.live && !r.internal && r.clientId).forEach((r) => {
    const row = promises.row(r.clientId, { refs: { client: r.clientId } });
    const c = row.cells;
    if (c.client == null) {
      c.client = r.clientName;
      c.feedbackDays = CS.feedbackDaysNow(r.clientId) ?? CS.defaults().feedbackDays;
      c.firstDays = CS.firstProfilesDaysNow(r.clientId);
    }
    c.openJobs.add(r.id, r.ageDays);
    const limitMs = c.firstDays * DAY;
    const first = firstSharedOf.get(r.id);
    const raised = new Date(r.createdAt).getTime();
    if (first) { if (first - raised <= limitMs) c.firstOk.add(r.id, Math.round((first - raised) / DAY)); else c.firstLate.add(r.id, Math.round((first - raised) / DAY)); } else if (nowMs - raised > limitMs) c.firstLate.add(r.id, r.ageDays);
  });
  ctx.apps.forEach((x) => {
    if (!x.inPipeline || slaRowOf(x.stage) !== 'client' || !x.req.clientId || x.req.internal) return;
    const row = promises.rows.get(x.req.clientId);
    if (!row) return;
    row.cells.feedbackWaiting.add(x.id, x.daysInStage);
    if (x.overdue) row.cells.feedbackLate.add(x.id, x.daysOverdue);
  });
  promises.sort = (a, b) => b.cells.feedbackLate.n - a.cells.feedbackLate.n || b.cells.firstLate.n - a.cells.firstLate.n || b.cells.openJobs.n - a.cells.openJobs.n;
  addTotal(promises);
  promises.total.cells.feedbackDays = null; promises.total.cells.firstDays = null;

  return { tiles: t.tiles, sections: [sla, promises, stageAgingSection(ctx, 'stageAging'), reqAging, tr] };
}

// ===========================================================================
// REJECTION REASONS (spec 2026-10-03 §A3) — why people are rejected, by
// reason, by side (Client / TeamLink / Candidate), by client and by recruiter,
// plus plain-language insights. The record is the existing one: each
// rejected application's latest stage event into REJECTED (reasonCategory,
// actorSide). Date range = the day of the rejection.
// ===========================================================================
const REJ_SIDES = [['Client', 'Client'], ['Internal', 'TeamLink'], ['Candidate', 'Candidate'], ['', 'Not recorded']];
const rejReasonOf = (e) => {
  if (!e) return 'Not recorded';
  if (e.reasonCategory) return clean(e.reasonCategory);
  const d = clean(e.reasonDetail);
  return d && d !== 'Rejected' ? 'Other (free text)' : 'Not recorded';
};
function buildRejections(ctx) {
  let list = ctx.apps.filter((x) => x.stage === 'REJECTED');
  if (ctx.f.period) {
    const within = dateRange.dateTimeIn(ctx.f.period);
    list = list.filter((x) => {
      const at = x.lastReject ? x.lastReject.createdAt : x.a.updatedAt;
      return at >= within.gte && at < within.lt;
    });
  }
  const sideOf = (x) => {
    const s = (x.lastReject && x.lastReject.actorSide) || '';
    return REJ_SIDES.some(([k]) => k === s) ? s : '';
  };
  const t = tileSet();
  const all = t.add('rejected', 'Rejected', 'app', 'Applications rejected in this scope');
  const sideTiles = {};
  REJ_SIDES.forEach(([k, l]) => { sideTiles[k] = t.add(`side_${k || 'none'}`, `By ${l}`, 'app'); });
  list.forEach((x) => { all.add(x.id); sideTiles[sideOf(x)].add(x.id); });

  const sideCols = REJ_SIDES.map(([k, l]) => ({ key: `s_${k || 'none'}`, label: l, drill: 'app' }));
  const share = (c) => { c.share = pct(c.count.n, list.length); };

  const reasons = section('reasons', 'By reason', [
    { key: 'reason', label: 'Reason' },
    { key: 'count', label: 'Rejections', drill: 'app' },
    { key: 'share', label: '% of rejections', type: 'pct' },
    ...sideCols,
  ], { sort: (a, b) => b.cells.count.n - a.cells.count.n });
  const sides = section('sides', 'By side', [
    { key: 'side', label: 'Whose decision' },
    { key: 'count', label: 'Rejections', drill: 'app' },
    { key: 'share', label: '% of rejections', type: 'pct' },
  ], { sort: (a, b) => b.cells.count.n - a.cells.count.n });
  const clients = section('clients', 'By client', [
    { key: 'client', label: 'Client', ref: 'client' },
    { key: 'count', label: 'Rejections', drill: 'app' },
    { key: 'clientSide', label: 'By the client', drill: 'app' },
    { key: 'top', label: 'Client\'s top reason' },
    { key: 'topShare', label: 'Top reason %', type: 'pct' },
  ], { sort: (a, b) => b.cells.count.n - a.cells.count.n, sub: '"Client\'s top reason" counts the client\'s OWN rejections (side = Client).' });
  const depts = section('rjDepartments', 'By department', [
    { key: 'department', label: 'Department' },
    { key: 'count', label: 'Rejections', drill: 'app' },
    { key: 'share', label: '% of rejections', type: 'pct' },
    { key: 'clientSide', label: 'By the client', drill: 'app' },
    { key: 'internal', label: 'By our team', drill: 'app' },
    { key: 'top', label: 'Top reason' },
  ], { sort: (a, b) => b.cells.count.n - a.cells.count.n });
  const recruiters = section('recruiters', 'By recruiter', [
    { key: 'recruiter', label: 'Recruiter' },
    { key: 'count', label: 'Rejections', drill: 'app' },
    { key: 'internal', label: 'Screened out by TeamLink', drill: 'app' },
    { key: 'clientSide', label: 'Rejected by the client', drill: 'app' },
    { key: 'top', label: 'Top reason' },
  ], { sort: (a, b) => b.cells.count.n - a.cells.count.n });

  const tops = new Map(); // row -> Map(reason -> n)
  const bump = (row, reason) => {
    if (!tops.has(row)) tops.set(row, new Map());
    const m = tops.get(row);
    m.set(reason, (m.get(reason) || 0) + 1);
  };
  list.forEach((x) => {
    const reason = rejReasonOf(x.lastReject);
    const side = sideOf(x);
    const rr = reasons.row(reason);
    rr.cells.reason = reason;
    rr.cells.count.add(x.id);
    rr.cells[`s_${side || 'none'}`].add(x.id);
    const sl = REJ_SIDES.find(([k]) => k === side)[1];
    const sr = sides.row(sl);
    sr.cells.side = sl;
    sr.cells.count.add(x.id);
    const cr = clients.row(x.req.clientKey, { refs: x.req.internal ? {} : { client: x.req.clientId } });
    cr.cells.client = x.req.clientName;
    cr.cells.count.add(x.id);
    if (side === 'Client') { cr.cells.clientSide.add(x.id); bump(cr, reason); }
    const dept = x.req.department || '—';
    const dr = depts.row(dept);
    dr.cells.department = dept;
    dr.cells.count.add(x.id);
    if (side === 'Client') dr.cells.clientSide.add(x.id);
    if (side === 'Internal') dr.cells.internal.add(x.id);
    bump(dr, reason);
    const pr = recruiters.row(x.recruiter.key);
    pr.cells.recruiter = x.recruiter.label;
    pr.cells.count.add(x.id);
    if (side === 'Internal') pr.cells.internal.add(x.id);
    if (side === 'Client') pr.cells.clientSide.add(x.id);
    bump(pr, reason);
  });
  const topOf = (row) => {
    const m = tops.get(row);
    if (!m || !m.size) return null;
    return [...m.entries()].sort((a, b) => b[1] - a[1])[0];
  };
  reasons.rows.forEach((r) => share(r.cells));
  sides.rows.forEach((r) => share(r.cells));
  clients.rows.forEach((r) => {
    const top = topOf(r);
    r.cells.top = top ? top[0] : '—';
    r.cells.topShare = top ? pct(top[1], r.cells.clientSide.n) : null;
  });
  recruiters.rows.forEach((r) => { const top = topOf(r); r.cells.top = top ? top[0] : '—'; });
  depts.rows.forEach((r) => { const top = topOf(r); r.cells.top = top ? top[0] : '—'; share(r.cells); });
  addTotal(reasons, share);
  addTotal(sides, share);
  addTotal(clients);
  addTotal(recruiters);
  addTotal(depts, share);

  // INSIGHTS — plain language, only where the numbers are big enough to mean it.
  const notes = [];
  const n = list.length;
  if (!n) notes.push('No rejections in this scope and date range.');
  const recorded = [...reasons.rows.values()].filter((r) => r.cells.reason !== 'Not recorded');
  const recordedN = recorded.reduce((s, r) => s + r.cells.count.n, 0);
  [...clients.rows.values()]
    .filter((r) => r.cells.clientSide.n >= 5 && r.cells.top && r.cells.top !== 'Not recorded' && r.cells.topShare >= 40)
    .sort((a, b) => b.cells.clientSide.n - a.cells.clientSide.n)
    .slice(0, 5)
    .forEach((r) => {
      const why = r.cells.top;
      let advice = 'review what this client keeps saying no to before the next submission.';
      if (/salary|budget|ctc/i.test(why)) advice = 'the BDE should talk budget with the client before more profiles are sent.';
      else if (/skill|experience|profile/i.test(why)) advice = 'the TL and BDE should re-check the job brief with the client — the profiles do not fit what they want.';
      else if (/interview|communication/i.test(why)) advice = 'prepare candidates better before the client interview.';
      else if (/position (closed|filled)|not shortlisted|not selected/i.test(why)) advice = 'check with the client that the opening is still live before sharing more.';
      notes.push(`${r.cells.client} rejects ${r.cells.topShare}% on "${why}" (${r.cells.clientSide.n} client rejections) — ${advice}`);
    });
  const skills = recorded.filter((r) => /skill|profile not matching|insufficient experience|not eligible|failed screening/i.test(r.cells.reason))
    .reduce((s, r) => s + r.cells.count.n, 0);
  if (recordedN >= 10 && skills / recordedN >= 0.25) {
    notes.push(`Skills / profile mismatch is high (${pct(skills, recordedN)}% of rejections with a reason) — recruiters should screen against the job's mandatory skills before submitting.`);
  }
  const dropOut = recorded.filter((r) => /did not attend|offer declined|did not join|not reachable|not interested|withdrew/i.test(r.cells.reason))
    .reduce((s, r) => s + r.cells.count.n, 0);
  if (recordedN >= 10 && dropOut / recordedN >= 0.25) {
    notes.push(`Candidates drop out often (${pct(dropOut, recordedN)}% of rejections with a reason: no-shows, declined offers, did not join) — confirm interviews and offers with the candidate the day before.`);
  }
  const missing = n - recordedN;
  if (n >= 10 && missing / n >= 0.3) {
    notes.push(`${pct(missing, n)}% of these rejections have no reason recorded (mostly imported from the old trackers). Every new reject now asks for one.`);
  }
  return { tiles: t.tiles, sections: [reasons, sides, clients, depts, recruiters], notes };
}

// ===========================================================================
// SPECIALIZATION (spec D, 2026-10-03) — demand vs supply per Department ->
// Specialization: "Dermatology: 12 jobs, only 4 candidates — sourcing needed".
//   Open jobs     live requirements mapped to it (Requirement.specialisationId)
//   Candidates    people whose PROFILE says it (Candidate.specialisationId),
//                 within what this login may see (utils/scope.js candidateWhere)
//   Submitted / Interview / Selected / Joined   applications on its jobs,
//                 cumulative (reached), as on every other report
//   Avg days to fill   job raised -> person joined, over the joins measured
// Jobs and people not mapped yet sit in each department's "Not mapped yet" row.
// ===========================================================================
async function prepareSpecialisations(ctx, user) {
  if (ctx.specPrep) return;
  // eslint-disable-next-line global-require
  const sp = require('../utils/specialisations');
  const [master, cands] = await Promise.all([
    sp.loadMaster(),
    prisma.candidate.findMany({
      where: { AND: [candidateWhere(user), { specialisationId: { not: null } }] },
      select: { id: true, specialisationId: true, name: true, email: true },
    }),
  ]);
  // Test / demo rows never count (the dashboard's rule).
  ctx.specPrep = { master, cands: cands.filter((c) => !SPEC_TEST_RE.test(`${c.name || ''} ${c.email || ''}`)) };
}
const SPEC_TEST_RE = /zztest|example\.test/i;
const specIsTest = (r) => SPEC_TEST_RE.test(`${r.department || ''} ${r.title || ''} ${r.clientName || ''}`);
const SOURCING_RATIO = 3; // fewer than 3 people per open job = sourcing needed
function buildSpecialisations(ctx) {
  const { master, cands } = ctx.specPrep || { master: { specById: new Map() }, cands: [] };
  const wantDept = ctx.f.department ? ctx.f.department.toLowerCase() : '';
  const derive = (c) => {
    const vals = c.joined && c.joined.vals ? [...c.joined.vals.values()] : [];
    c.avgFill = avgOf(vals);
    const jobs = c.openJobs ? c.openJobs.n : 0;
    const people = c.people ? c.people.n : 0;
    if (c.specialisation === 'Not mapped yet') c.hint = 'Map these jobs (Admin → Master lists)';
    else if (jobs && people < jobs * SOURCING_RATIO) c.hint = `Sourcing needed — ${jobs} open job${jobs === 1 ? '' : 's'}, only ${people} ${people === 1 ? 'person' : 'people'}`;
    else if (jobs) c.hint = 'Enough people';
    else c.hint = people ? 'No open jobs' : '';
  };
  const sec = section('specialisations', 'Department → Specialization', [
    { key: 'department', label: 'Department' },
    { key: 'specialisation', label: 'Specialization' },
    { key: 'openJobs', label: 'Open jobs', drill: 'req' },
    { key: 'people', label: 'Candidates', drill: 'cand' },
    { key: 'submitted', label: 'Submitted', drill: 'app' },
    { key: 'interview', label: 'Interview', drill: 'app' },
    { key: 'selected', label: 'Selected', drill: 'app' },
    { key: 'joined', label: 'Joined', drill: 'app' },
    { key: 'avgFill', label: 'Avg days to fill', type: 'num' },
    { key: 'hint', label: 'Supply vs demand' },
  ], {
    sub: `Open jobs = live jobs with this specialization. Candidates = people whose profile says it (your area only). Submitted / Interview / Selected / Joined = people on these jobs who reached that step. Avg days to fill = job raised to person joined. "Sourcing needed" = fewer than ${SOURCING_RATIO} people per open job.`,
  });
  const rowOf = (specId, deptName) => {
    const spec = specId ? master.specById.get(specId) : null;
    const dept = (spec && spec.department) || deptName || '—';
    const key = `${dept}|${spec ? spec.id : 'none'}`;
    const r = sec.row(key);
    r.cells.department = dept;
    r.cells.specialisation = spec ? spec.name : 'Not mapped yet';
    if (spec) r.refs.specialisationId = spec.id;
    return r.cells;
  };
  ctx.reqs.forEach((r) => {
    if (specIsTest(r)) return;
    const c = rowOf(r.specialisationId, r.department);
    if (r.live) c.openJobs.add(r.id);
  });
  cands.forEach((p) => {
    const spec = master.specById.get(p.specialisationId);
    if (!spec || (wantDept && String(spec.department || '').toLowerCase() !== wantDept)) return;
    rowOf(spec.id).people.add(p.id);
  });
  ctx.apps.forEach((x) => {
    if (specIsTest(x.req)) return;
    const c = rowOf(x.req.specialisationId, x.req.department);
    if (x.joined || x.reached('shared')) c.submitted.add(x.id);
    if (x.joined || x.reached('interview')) c.interview.add(x.id);
    if (x.joined || x.reached('selected')) c.selected.add(x.id);
    if (x.joined) {
      // ONE joined date everywhere: joiningDate, then joinedAt, then the first move into Joined.
      let at = null;
      const jd = String(x.a.joiningDate || '').slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(jd)) {
        const d = new Date(`${jd}T00:00:00.000Z`);
        // Imported sheets carry odd dates (typos): only a real year counts.
        if (!Number.isNaN(d.getTime()) && d.getUTCFullYear() >= 2015 && d.getUTCFullYear() <= 2100) at = d;
      }
      if (!at && x.a.joinedAt) at = x.a.joinedAt;
      if (!at && x.crossedAt.joined) at = x.crossedAt.joined;
      const days = at && x.req.createdAt ? Math.round((at - x.req.createdAt) / DAY) : null;
      // A fill measured as negative or over two years is a data slip, not a fill time.
      c.joined.add(x.id, days !== null && days >= 0 && days <= 730 ? days : undefined);
    }
  });
  // A row with nothing in it (a mapped specialization nobody uses yet) is not drawn.
  [...sec.rows.entries()].forEach(([key, r]) => {
    const c = r.cells;
    if (!c.openJobs.n && !c.people.n && !c.submitted.n && !c.joined.n && !c.interview.n) sec.rows.delete(key);
  });
  sec.rows.forEach((r) => derive(r.cells));
  sec.sort = (a, b) => String(a.cells.department).localeCompare(String(b.cells.department))
    || (a.cells.specialisation === 'Not mapped yet') - (b.cells.specialisation === 'Not mapped yet')
    || b.cells.openJobs.n - a.cells.openJobs.n || b.cells.people.n - a.cells.people.n;
  addTotal(sec, (c) => { const v = c.joined.vals ? [...c.joined.vals.values()] : []; c.avgFill = avgOf(v); c.hint = null; });

  const t = tileSet();
  const mapped = [...sec.rows.values()].filter((r) => r.cells.specialisation !== 'Not mapped yet');
  const needs = mapped.filter((r) => /^Sourcing needed/.test(r.cells.hint || ''));
  const openMapped = new Cell('req');
  const openNone = new Cell('req');
  sec.rows.forEach((r) => r.cells.openJobs.ids.forEach((id) => (r.cells.specialisation === 'Not mapped yet' ? openNone : openMapped).add(id)));
  t.value('specs', 'Specializations in use', mapped.length);
  t.push('openMapped', 'Open jobs with a specialization', openMapped);
  t.push('openNone', 'Open jobs not mapped yet', openNone);
  t.push('people', 'Candidates with a specialization', sec.total.cells.people);
  t.value('needs', 'Need sourcing', needs.length, `fewer than ${SOURCING_RATIO} people per open job`);
  const notes = needs
    .sort((a, b) => b.cells.openJobs.n - a.cells.openJobs.n)
    .slice(0, 5)
    .map((r) => `${r.cells.specialisation} (${r.cells.department}): ${r.cells.openJobs.n} open job${r.cells.openJobs.n === 1 ? '' : 's'}, only ${r.cells.people.n} ${r.cells.people.n === 1 ? 'candidate' : 'candidates'} — sourcing needed.`);
  if (!mapped.length) notes.push('No job or candidate has a specialization yet. Admin → Master lists → Suggestions finds them; nothing changes until someone clicks Accept.');
  else if (openNone.n) notes.push(`${openNone.n.toLocaleString('en-IN')} open job${openNone.n === 1 ? ' has' : 's have'} no specialization yet, so they are not counted above. Admin → Master lists → Suggestions can map them.`);
  return { tiles: t.tiles, sections: [sec], notes };
}

// Section 17 (2026-10-03) — Time to fill, Source quality, Results vs target,
// Client revenue, compare periods, filter counts: utils/reportsPlus.js.
const PLUSX = require('../utils/reportsPlus');
const PLUS = PLUSX({ Cell, section, addTotal, tileSet, pct, channelOf, CHANNELS });
const CAMP = require('../utils/campaignReport')({ Cell, section, addTotal, tileSet, pct }); // ATS-100 B6.3
// B8: "Added by override" (utils/fitReports.js).
const FITR = require('../utils/fitReports')({ Cell, section, addTotal, tileSet, pct });
// ATS-100 B9.3: cost per hire (campaign costs + partner payouts + incentives ÷ joinings).
const CPH = require('../utils/costPerHire')({ Cell, section, addTotal, tileSet });
// ATS-100 B9.7: recruiter revenue (invoices net of credit notes, per recruiter) — its own routes below.
const RR = require('../utils/recruiterRevenue');

// ---------------------------------------------------------------------------
const REPORTS = {
  funnel: { title: 'Recruitment Funnel', build: buildFunnel },
  departments: { title: 'Department Performance', build: buildDepartments },
  recruitment: { title: 'Recruitment', build: buildRecruitment },
  requirements: { title: 'Requirements Report', build: buildRequirements },
  candidates: { title: 'Candidate Pipeline', build: buildCandidates },
  recruiters: {
    title: 'Recruiter Performance',
    // Who has left HRMS — for the "· Former" tag and the people filter.
    prepare: async (ctx) => { ctx.formerKeys = await require('../utils/formerPeople').formerKeys(); }, // eslint-disable-line global-require
    build: buildRecruiters,
  },
  sources: { title: 'Source Performance', build: buildSources },
  clients: { title: 'Client Performance', build: buildClients },
  interviews: { title: 'Interviews', build: buildInterviews, appDate: 'interviewAt' },
  ai: { title: 'AI Interviews', build: buildAi },
  followups: { title: 'Follow-ups', build: buildFollowUps, appDate: null },
  joining: { title: 'Joining Report', build: buildJoining },
  sla: { title: 'SLA & Aging', build: buildSla },
  rejections: { title: 'Rejection Reasons', build: buildRejections, appDate: null },
  // spec D: demand (open jobs) vs supply (candidates) by specialization.
  specialisations: { title: 'Specialization Report', build: buildSpecialisations, prepare: prepareSpecialisations },
  // Section 17 (utils/reportsPlus.js).
  timetofill: { title: 'Time to fill', build: PLUS.buildTimeToFill, appDate: null },
  quality: { title: 'Source quality', build: PLUS.buildSourceQuality },
  targets: { title: 'Results vs target', build: PLUS.buildTargets, appDate: null, prepare: PLUS.prepareTargets },
  // B8: people added to a job although they did not meet its rules.
  overrides: { title: 'Added by override', build: FITR.buildOverrides, appDate: null, prepare: FITR.prepareOverrides },
  // ATS-100 B6.3: campaign / campus drive / referral -> joined, with cost (utils/campaignReport.js).
  campaigns: { title: 'Campaign performance', build: CAMP.build, prepare: CAMP.prepare },
  // ATS-100 B9.3 (utils/costPerHire.js): the period's counted joinings and what they cost.
  costperhire: { title: 'Cost per hire', build: CPH.build, prepare: CPH.prepare, appDate: null },
};
const DATE_BASIS = {
  costperhire: 'Date range: the month(s) of the joining (this month when no range is set). Costs sit in the month of the joining they produced.',
  // Section 17 (utils/reportsPlus.js).
  timetofill: 'Date range: the day the person joined.',
  targets: 'Date range: the day the work was done (this month when no range is set).',
  quality: 'Date range: the day the person was added to the job.',
  campaigns: 'Date range: the day the person applied (was added to the job).',
  rejections: 'Date range: the day the candidate was rejected.',
  overrides: 'Date range: the day the person was added by override.',
  interviews: 'Date range: the interview date.',
  followups: 'Date range: the day the follow-up was raised.',
  sla: 'Date range: candidates by the day they were added, requirements by the day they were raised. The dashboard\'s Past SLA is all time — use All Time to match it.',
};

// THE SNAPSHOT. Opening a report loads afresh and keeps what it loaded for a
// few minutes; the drill-down and the exports of that report read the same
// snapshot, so the list behind a figure is the list that WAS counted even if
// somebody moved a candidate in between — and a click does not pay for a
// second full load. Keyed by the login, every field its scope is resolved
// from, and every filter, so one person's snapshot is never another's.
const SNAPSHOT_MS = 10 * 60 * 1000;
const snapshots = new Map();
function snapshotKey(user, f, appDate) {
  const u = user || {};
  return JSON.stringify([
    u.id, u.role, u.atsRole, u.hrmsRole, u.accountsRole, u.atsScopeDepartments, u.atsScopeTeams,
    u.atsScopeClients, u.department, u.team, u.clientId, u.candidateId,
    appDate, f.period && [f.period.from, f.period.to], ...FILTER_KEYS.map((k) => f[k]),
  ]);
}

async function contextFor(user, f, appDate, fresh) {
  const key = snapshotKey(user, f, appDate);
  const now = Date.now();
  snapshots.forEach((v, k) => { if (now - v.at > SNAPSHOT_MS) snapshots.delete(k); });
  const hit = snapshots.get(key);
  if (hit && !fresh) return hit.ctx;
  const ctx = await loadContext(user, f, { appDate });
  snapshots.set(key, { at: now, ctx });
  // Bounded: a busy morning of reports must not become a memory leak.
  while (snapshots.size > 40) snapshots.delete(snapshots.keys().next().value);
  return ctx;
}

async function build(req, reportId, { fresh = false } = {}) {
  const spec = Object.prototype.hasOwnProperty.call(REPORTS, reportId) ? REPORTS[reportId] : null;
  if (!spec) return null;
  // A compare (?compare=month) and a Team are turned into the plain filters first.
  const f = parseFilters(await PLUSX.expandQuery(req.query));
  const ctx = await contextFor(req.user, f, spec.appDate === undefined ? 'createdAt' : spec.appDate, fresh);
  if (spec.prepare) await spec.prepare(ctx, req.user);
  const out = spec.build(ctx);
  out.sections.forEach((s) => {
    s.list = [...s.rows.values()];
    if (s.sort) s.list.sort(s.sort);
  });
  return { spec, f, ctx, out };
}

// Numbers only — the Cells stay on the server. A row's values go out as an
// array in column order: the requirement table is four thousand rows, and
// repeating a dozen key names on every one of them doubled the payload.
function serialize(reportId, { spec, f, ctx, out }, user) {
  // Everyday words on every label (spec §2: Job, Step, Late, People in process).
  const W = PLUSX.plainWords;
  const val = (v) => (v instanceof Cell ? v.n : v);
  const cellsOf = (row, columns) => columns.map((c) => val(row.cells[c.key]));
  // The Clients rule: outside the client desk a client is a NAME only — no
  // link to a client record the reader cannot open.
  const clientDesk = !!(user && user.caps && user.caps.clientDetail);
  const refsOf = (refs) => {
    if (clientDesk || !refs || !refs.client) return refs;
    const { client, ...rest } = refs; // eslint-disable-line no-unused-vars
    return rest;
  };
  return {
    report: reportId,
    title: spec.title,
    scope: scopeLabel(user, 'ats'),
    period: out.period || (f.period ? { key: f.period.key, label: f.period.label, from: f.period.from, to: f.period.to } : { key: 'all', label: 'All time' }),
    dateBasis: DATE_BASIS[reportId] || 'Date range: candidates by the day they were added to the requirement; requirements by the day they were raised.',
    tiles: out.tiles.map((tl) => ({
      key: tl.key, label: W(tl.label), sub: W(tl.sub) || null, type: tl.type || 'num',
      value: tl.cell ? tl.cell.n : tl.value, drill: !!tl.cell, target: tl.target ?? null,
    })),
    sections: out.sections.map((s) => ({
      id: s.id, title: W(s.title), sub: W(s.sub) || null, paged: !!s.paged,
      groupBy: s.groupBy || null, groupings: s.groupings || null,
      columns: s.columns.map((c) => ({ key: c.key, label: W(c.label), type: c.type || (c.drill ? 'num' : 'text'), drill: !!c.drill, ref: c.ref === 'client' && !clientDesk ? null : (c.ref || null), of: c.of || null, hidden: !!c.hidden })),
      rows: s.list.map((r) => ({ key: r.key, refs: refsOf(r.refs), c: cellsOf(r, s.columns) })),
      total: s.total ? cellsOf(s.total, s.columns) : null,
    })),
    notes: (out.notes || []).map(W),
    plain: !!out.plain,
    counts: { applications: ctx.apps.length, requirements: ctx.reqs.length },
  };
}

// Candidate names for a section that lists candidates as rows.
async function fillNames(payload) {
  const ids = new Set();
  payload.sections.forEach((s) => s.columns.forEach((c, i) => {
    if (c.ref === 'cand') s.rows.forEach((r) => ids.add(r.c[i]));
  }));
  if (!ids.size) return;
  const names = new Map((await prisma.candidate.findMany({
    where: { id: { in: [...ids] } }, select: { id: true, name: true },
  })).map((c) => [c.id, c.name]));
  payload.sections.forEach((s) => s.columns.forEach((c, i) => {
    if (c.ref === 'cand') s.rows.forEach((r) => { r.c[i] = names.get(r.c[i]) || '—'; });
  }));
}

// Answers a thrown BadRequest as a 400; anything else goes to the app's
// error handler.
const guarded = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    return next(err);
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// FILTER OPTIONS — cascading. Drawn from what this login can see, narrowed by
// the department and client already chosen, so choosing Medical offers
// Medical's clients, requirements, recruiters, TLs and locations only.
// ---------------------------------------------------------------------------
router.get('/options', VIEW, guarded(async (req, res) => {
  const q = req.query || {};
  const department = typeof q.department === 'string' ? q.department.trim() : '';
  const clientId = typeof q.clientId === 'string' ? q.clientId.trim() : '';
  const scopeReq = reportReqScope(req.user);
  const narrowed = { AND: [scopeReq] };
  if (department) narrowed.AND.push({ department });
  const byClient = { AND: [...narrowed.AND] };
  if (clientId === INTERNAL_CLIENT) byClient.AND.push({ internal: true });
  else if (clientId) byClient.AND.push({ clientId, internal: false });
  const appsOf = { AND: [reportAppScope(req.user), { requirement: { is: byClient } }] };

  const [allReqs, reqs, users, followUps, appSources, candSources] = await Promise.all([
    prisma.requirement.findMany({ where: scopeReq, select: { department: true } }),
    prisma.requirement.findMany({ where: byClient, select: REQ_SELECT }),
    prisma.user.findMany({ select: { id: true, name: true } }),
    prisma.applicationFollowUp.findMany({
      where: { application: { is: appsOf } },
      select: { ownerUserId: true, ownerName: true, bdeUserId: true, bdeName: true, tlName: true },
    }),
    prisma.application.groupBy({ by: ['source', 'firstSource'], where: appsOf, _count: { _all: true } }),
    prisma.candidate.groupBy({
      by: ['source', 'firstSource'],
      where: { applications: { some: { AND: [appsOf, { source: null, firstSource: null }] } } },
      _count: { _all: true },
    }),
  ]);
  // Clients come from the department-narrowed set, not the client-narrowed one.
  const clientReqs = clientId
    ? await prisma.requirement.findMany({ where: narrowed, select: { clientId: true, internal: true, client: { select: { name: true } } } })
    : reqs;

  // The same person resolution loadContext() makes, so an option's key is the
  // key the report filters on.
  const userById = new Map(users.map((u) => [u.id, u]));
  const userByName = new Map();
  users.forEach((u) => { if (!userByName.has(nameKey(u.name))) userByName.set(nameKey(u.name), u); });
  const addPerson = (map, id, name) => {
    const u = (id && userById.get(id)) || userByName.get(nameKey(name));
    if (u) map.set(`u:${u.id}`, u.name);
    else if (clean(name)) map.set(`n:${nameKey(name)}`, clean(name));
  };
  const recruiters = new Map();
  const bdes = new Map();
  const tls = new Map();
  const stls = new Map();
  reqs.forEach((r) => {
    if (r.recruiterId) addPerson(recruiters, r.recruiterId);
    if (r.bdeId) addPerson(bdes, r.bdeId);
    if (r.tlId || r.tl) addPerson(tls, r.tlId, r.tl);
    if (r.stlId || r.stl) addPerson(stls, r.stlId, r.stl);
  });
  followUps.forEach((fu) => {
    if (fu.ownerUserId || fu.ownerName) addPerson(recruiters, fu.ownerUserId, fu.ownerName);
    if (fu.bdeUserId || fu.bdeName) addPerson(bdes, fu.bdeUserId, fu.bdeName);
    if (fu.tlName) addPerson(tls, null, fu.tlName);
  });

  const clients = new Map();
  clientReqs.forEach((r) => {
    if (r.internal) clients.set(INTERNAL_CLIENT, 'TeamLink Internal');
    else clients.set(r.clientId, (r.client && r.client.name) || '—');
  });
  const sources = new Map();
  const addSource = (x) => { if (!sources.has(x.toLowerCase())) sources.set(x.toLowerCase(), x); };
  appSources.forEach((g) => { if (g.source || g.firstSource) addSource(sourceOf(g)); });
  candSources.forEach((g) => addSource(sourceOf({ candidate: g })));
  const listOf = (m) => [...m.entries()].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));

  res.json({
    departments: [...new Set(allReqs.map((r) => r.department).filter(Boolean))].sort(),
    clients: listOf(clients),
    requirements: reqs.map((r) => ({
      id: r.id, label: `${r.reqCode ? `${r.reqCode} · ` : ''}${r.title}${r.internal ? '' : ` — ${(r.client && r.client.name) || ''}`}`,
    })).sort((a, b) => a.label.localeCompare(b.label)),
    recruiters: listOf(recruiters),
    tls: listOf(tls),
    stls: listOf(stls),
    bdes: listOf(bdes),
    locations: [...new Set(reqs.map((r) => r.location).filter((l) => clean(l)))].sort(),
    sources: [...sources.values()].sort((a, b) => a.localeCompare(b)),
    statuses: [
      ...Object.entries(REQ_STATUS_FILTERS).map(([id, s]) => ({ id: `req:${id}`, label: s.label, group: 'Requirement status' })),
      ...Object.entries(CAND_STATUS_FILTERS).map(([id, s]) => ({ id: `cand:${id}`, label: s.label, group: 'Candidate status' })),
    ],
    stages: PIPE.map((g) => ({ id: g.id, label: g.label })),
    interviewStatuses: INTERVIEW_STATUS_CODES.map((s) => ({ id: s, label: interviewStatusLabel(s) })),
    aiStatuses: AI_INTERVIEW_STATUSES.map((s) => ({ id: s, label: s })),
    joiningStatuses: Object.entries(JOIN_OUTCOMES).map(([id, label]) => ({ id, label })),
  });
}));

// ---------------------------------------------------------------------------
// THE REPORT
// ---------------------------------------------------------------------------
// MY RESULTS (per-role spec 2026-10-03) — a recruiter's own numbers:
// submitted, interviews, selected, joined. Own scope only
// (utils/ownResults.js -> applicationWhere). ?format=csv needs export.
router.get('/my-results', requirePerm(null, 'reports', 'My Results', 'view'), guarded(async (req, res) => {
  // eslint-disable-next-line global-require
  const own = require('../utils/ownResults');
  const report = await own.myResults(req.user, req.query || {});
  if (String((req.query || {}).format || '') === 'csv') {
    if (!(await can(req.user, null, 'reports', 'My Results', 'export'))) return res.status(403).json({ error: "This action isn't included in your role's permissions" });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="my-results.csv"');
    return res.send(own.toCsvRows(report));
  }
  return res.json(report);
}));

// ---------------------------------------------------------------------------
// SECTION 17 (2026-10-03, utils/reportsPlus.js) — the report cards a login may
// open, the filter counts, and CLIENT REVENUE: Super Admin / Admin / Accounts
// only, refused HERE for everyone else whatever a screen shows. Registered
// before '/:report' so these names are never read as a report id.
// ---------------------------------------------------------------------------
router.get('/catalog', guarded(async (req, res) => {
  const [view, exp, mine, portal, accounts] = await Promise.all([
    can(req.user, null, 'reports', 'ATS Reports', 'view'),
    can(req.user, null, 'reports', 'ATS Reports', 'export'),
    can(req.user, null, 'reports', 'My Results', 'view'),
    can(req.user, null, 'reports', 'Job Portal Reports', 'view'),
    can(req.user, null, 'reports', 'Accounts Reports', 'view'),
  ]);
  res.json({
    view, export: exp, revenue: PLUSX.mayRevenue(req.user), myResults: mine, jobPortal: portal, accounts,
    recruiterRevenue: PLUSX.mayRevenue(req.user), // B9.7: the same gate as Client revenue
    scope: view ? scopeLabel(req.user, 'ats') : null,
  });
}));

// The filter options with counts (utils/atsFacets.js module 'reports' calls
// this): counted over the report's own rows with every OTHER filter applied.
async function reportFacets(user, q0) {
  const q = q0 || {};
  if (String(q.report || '') === 'revenue') {
    if (!PLUSX.mayRevenue(user)) return { facets: {}, total: null };
    const b = await PLUS.revenueBuild(user, await PLUSX.expandQuery({ ...q, clientId: '', department: '' }));
    return { facets: PLUS.revenueFacets(b, q), total: b.options.invs.length };
  }
  if (String(q.report || '') === 'recruiter-revenue') { // B9.7
    if (!PLUSX.mayRevenue(user)) return { facets: {}, total: null };
    const b = await RR.build(user, await PLUSX.expandQuery({ ...q, clientId: '', department: '', recruiter: '' }));
    return { facets: RR.facets(b, q), total: b.options.invs.length };
  }
  if (!(await can(user, null, 'reports', 'ATS Reports', 'view'))) return { facets: {}, total: null };
  const spec = Object.prototype.hasOwnProperty.call(REPORTS, q.report) ? REPORTS[q.report] : REPORTS.funnel;
  const base = { ...q };
  [...PLUS.FACET_KEYS, 'positionCode', 'section', 'report'].forEach((k) => { delete base[k]; });
  const f = parseFilters(await PLUSX.expandQuery(base));
  const ctx = await contextFor(user, f, spec.appDate === undefined ? 'createdAt' : spec.appDate, false);
  return PLUS.facetCounts(ctx, q, await PLUSX.positions());
}
router.reportFacets = reportFacets;

const REVENUE_DENIED = 'Client revenue is only for Super Admin, Admin and Accounts.';
async function revenueFor(req, extra = {}) {
  return PLUS.revenueBuild(req.user, await PLUSX.expandQuery({ ...req.query, ...extra }));
}
router.get('/revenue', guarded(async (req, res) => {
  if (!PLUSX.mayRevenue(req.user)) return res.status(403).json({ error: REVENUE_DENIED });
  const payload = PLUS.revenuePayload(req.user, await revenueFor(req));
  const kind = PLUSX.compareKind(req.query);
  if (kind) {
    const prev = PLUS.revenuePayload(req.user, await revenueFor(req, { comparePrev: '1' }));
    PLUSX.mergeCompare(payload, prev, kind, PLUSX.compareRanges(kind));
  }
  return res.json(payload);
}));
router.get('/revenue/drill', guarded(async (req, res) => {
  if (!PLUSX.mayRevenue(req.user)) return res.status(403).json({ error: REVENUE_DENIED });
  const data = await PLUS.revenueDrill(await revenueFor(req), req.query || {});
  if (!data) return res.status(404).json({ error: 'That figure is not on this report any more — refresh the report.' });
  if (req.query.format === 'csv') {
    const csv = toCsv(data.columns.map((c) => c.label), data.rows.map((r) => data.columns.map((c) => r.cells[c.key])));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="client-revenue-${fileBase(data.title)}.csv"`);
    return res.send(`﻿${csv}`);
  }
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  return res.json({ ...data, report: 'Client revenue', section: null, offset, limit, rows: data.rows.slice(offset, offset + limit) });
}));
router.get('/revenue/export', guarded(async (req, res) => {
  if (!PLUSX.mayRevenue(req.user)) return res.status(403).json({ error: REVENUE_DENIED });
  const b = await revenueFor(req);
  const payload = PLUS.revenuePayload(req.user, b);
  const q = req.query || {};
  const parts = [];
  if (b.P) parts.push(`Date: ${b.P.label}`);
  if (q.department) parts.push(`Department: ${q.department}`);
  if (q.clientId) parts.push(`Client: ${(payload.sections[0].rows[0] || { c: ['—'] }).c[0]}`);
  const meta = { filters: parts.length ? parts.join(' · ') : 'No filters', generated: new Date().toISOString().slice(0, 16).replace('T', ' ') };
  const base = `teamlink-client-revenue-${new Date().toISOString().slice(0, 10)}`;
  const format = String(q.format || 'xlsx');
  if (format === 'pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.pdf"`);
    return exportPdf(payload, meta, res);
  }
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.csv"`);
    return res.send(exportCsv(payload, meta));
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${base}.xlsx"`);
  return res.send(exportXlsx(payload, meta));
}));

// ATS-100 B9.7 — RECRUITER REVENUE (utils/recruiterRevenue.js): invoices net
// of credit notes, per recruiter / month / client. Same gate as Client revenue.
async function recruiterRevenueFor(req, extra = {}) {
  return RR.build(req.user, await PLUSX.expandQuery({ ...req.query, ...extra }));
}
router.get('/recruiter-revenue', guarded(async (req, res) => {
  if (!PLUSX.mayRevenue(req.user)) return res.status(403).json({ error: REVENUE_DENIED });
  const payload = RR.payload(req.user, await recruiterRevenueFor(req));
  const kind = PLUSX.compareKind(req.query);
  if (kind) {
    const prev = RR.payload(req.user, await recruiterRevenueFor(req, { comparePrev: '1' }));
    PLUSX.mergeCompare(payload, prev, kind, PLUSX.compareRanges(kind));
  }
  return res.json(payload);
}));
router.get('/recruiter-revenue/drill', guarded(async (req, res) => {
  if (!PLUSX.mayRevenue(req.user)) return res.status(403).json({ error: REVENUE_DENIED });
  const data = RR.drill(await recruiterRevenueFor(req), req.query || {});
  if (!data) return res.status(404).json({ error: 'That figure is not on this report any more — refresh the report.' });
  if (req.query.format === 'csv') {
    const csv = toCsv(data.columns.map((c) => c.label), data.rows.map((r) => data.columns.map((c) => r.cells[c.key])));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="recruiter-revenue-${fileBase(data.title)}.csv"`);
    return res.send(`﻿${csv}`);
  }
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  return res.json({ ...data, report: 'Recruiter revenue', section: null, offset, limit, rows: data.rows.slice(offset, offset + limit) });
}));
router.get('/recruiter-revenue/export', guarded(async (req, res) => {
  if (!PLUSX.mayRevenue(req.user)) return res.status(403).json({ error: REVENUE_DENIED });
  const payload = RR.payload(req.user, await recruiterRevenueFor(req));
  const q = req.query || {};
  const only = typeof q.section === 'string' ? q.section : '';
  if (only) {
    const sec = payload.sections.find((s) => s.id === only);
    if (!sec) return res.status(404).json({ error: 'That table is not on this report.' });
    payload.sections = [sec]; payload.tiles = []; payload.title = `${payload.title} — ${sec.title}`;
  }
  const parts = [];
  if (payload.period && payload.period.key !== 'all') parts.push(`Date: ${payload.period.label}`);
  ['department', 'clientId', 'recruiter'].forEach((k) => { if (q[k]) parts.push(`${k}: ${q[k]}`); });
  const meta = { filters: parts.length ? parts.join(' · ') : 'No filters', generated: new Date().toISOString().slice(0, 16).replace('T', ' ') };
  const base = `teamlink-recruiter-revenue-${new Date().toISOString().slice(0, 10)}`;
  const format = String(q.format || 'xlsx');
  if (format === 'pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.pdf"`);
    return exportPdf(payload, meta, res);
  }
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.csv"`);
    return res.send(exportCsv(payload, meta));
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${base}.xlsx"`);
  return res.send(exportXlsx(payload, meta));
}));

router.get('/:report', VIEW, guarded(async (req, res) => {
  const built = await build(req, req.params.report, { fresh: true });
  if (!built) return res.status(404).json({ error: 'No such report' });
  const payload = serialize(req.params.report, built, req.user);
  await fillNames(payload);
  // Compare periods (section 17): the same report for the previous span, so
  // every number can show its change.
  const kind = PLUSX.compareKind(req.query);
  if (kind) {
    const prevBuilt = await build({ user: req.user, query: { ...req.query, comparePrev: '1' } }, req.params.report, { fresh: true });
    PLUSX.mergeCompare(payload, serialize(req.params.report, prevBuilt, req.user), kind, PLUSX.compareRanges(kind));
  }
  return res.json(payload);
}));

// ---------------------------------------------------------------------------
// DRILL-DOWN — the list behind one number.
//
//   GET /api/ats-reports/:report/drill?section=&row=&col=&<the same filters>
//
// section is 'tiles' for a tile (row empty, col = the tile's key). The list
// comes from the report's own snapshot (rebuilt with the same filters and
// scope if it has expired), so it is by construction the records the figure
// counted — and nothing outside the caller's scope can be in it. `format=csv`
// returns every row as a file instead of a page.
// ---------------------------------------------------------------------------
function findCell(out, sectionId, row, col) {
  if (sectionId === 'tiles') {
    const tile = out.tiles.find((x) => x.key === col);
    return tile && tile.cell ? { cell: tile.cell, title: tile.label } : null;
  }
  const sec = out.sections.find((s) => s.id === sectionId);
  if (!sec) return null;
  const r = row === '__total__' ? sec.total : sec.rows.get(row);
  const column = sec.columns.find((c) => c.key === col);
  if (!r || !column || !(r.cells[col] instanceof Cell)) return null;
  const rowLabel = row === '__total__' ? 'Total' : r.cells[sec.columns[0].key];
  return { cell: r.cells[col], title: `${rowLabel} · ${column.label}`, sectionTitle: sec.title };
}

const VALUE_LABEL = { ai: 'AI score', clients: 'Days waiting', requirements: 'Open days', time: 'Days' };
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—');

async function drillRows(ids, cell, ctx, reportId) {
  if (cell.kind === 'req') {
    const counts = new Map();
    const joined = new Map();
    ctx.apps.forEach((x) => {
      counts.set(x.req.id, (counts.get(x.req.id) || 0) + 1);
      if (x.joined) joined.set(x.req.id, (joined.get(x.req.id) || 0) + 1);
    });
    const rows = ids.map((id) => ctx.reqMap.get(id)).filter(Boolean).map((r) => ({
      refs: { req: r.id },
      cells: {
        code: r.reqCode || '—', title: r.title, client: r.clientName, department: r.department || '—',
        location: clean(r.location) || '—', status: requirementStatusLabel(r.status), openings: r.openings || 0,
        candidates: counts.get(r.id) || 0, joined: joined.get(r.id) || 0,
        remaining: r.live || r.status === 'ON_HOLD' ? Math.max(0, (r.openings || 0) - (joined.get(r.id) || 0)) : 0,
        openDays: r.ageDays, recruiter: (r.recruiter && r.recruiter.label) || '—',
      },
    }));
    return {
      columns: [
        { key: 'code', label: 'Req ID', ref: 'req' }, { key: 'title', label: 'Requirement', ref: 'req' },
        { key: 'client', label: 'Client' }, { key: 'department', label: 'Department' },
        { key: 'location', label: 'Location' }, { key: 'status', label: 'Status' },
        { key: 'openings', label: 'Openings', type: 'num' }, { key: 'candidates', label: 'Candidates', type: 'num' },
        { key: 'joined', label: 'Joined', type: 'num' }, { key: 'remaining', label: 'Remaining', type: 'num' },
        { key: 'openDays', label: 'Open days', type: 'num' }, { key: 'recruiter', label: 'Recruiter' },
      ],
      rows,
    };
  }

  if (cell.kind === 'cand') {
    const apps = new Map();
    const srcs = new Map();
    ctx.apps.forEach((x) => {
      apps.set(x.a.candidateId, (apps.get(x.a.candidateId) || 0) + 1);
      if (!srcs.has(x.a.candidateId)) srcs.set(x.a.candidateId, x.source);
    });
    const people = new Map((await prisma.candidate.findMany({
      where: { id: { in: ids } }, select: { id: true, name: true, phone: true, email: true, location: true },
    })).map((c) => [c.id, c]));
    return {
      columns: [
        { key: 'name', label: 'Candidate', ref: 'cand' }, { key: 'phone', label: 'Phone' },
        { key: 'email', label: 'Email' }, { key: 'location', label: 'Location' },
        { key: 'source', label: 'Source' }, { key: 'applications', label: 'Applications', type: 'num' },
      ],
      rows: ids.map((id) => people.get(id)).filter(Boolean).map((c) => ({
        refs: { cand: c.id },
        cells: {
          name: c.name, phone: c.phone || '—', email: c.email || '—', location: c.location || '—',
          source: srcs.get(c.id) || '—', applications: apps.get(c.id) || 0,
        },
      })),
    };
  }

  const info = new Map(ctx.apps.map((x) => [x.id, x]));
  if (cell.kind === 'fu') {
    const fus = new Map(ctx.followUps.map((y) => [y.id, y]));
    const list = ids.map((id) => fus.get(id)).filter((y) => y && info.get(y.applicationId));
    const people = new Map((await prisma.candidate.findMany({
      where: { id: { in: [...new Set(list.map((y) => info.get(y.applicationId).a.candidateId))] } },
      select: { id: true, name: true },
    })).map((c) => [c.id, c.name]));
    const status = (y) => {
      if (y.completedAt) return 'Completed';
      if (y.dueDate && y.dueDate < ctx.today) return 'Overdue';
      if (y.dueDate === ctx.today) return 'Due Today';
      return y.dueDate ? 'Upcoming' : 'No date';
    };
    return {
      columns: [
        { key: 'candidate', label: 'Candidate', ref: 'cand' }, { key: 'requirement', label: 'Requirement', ref: 'req' },
        { key: 'client', label: 'Client' }, { key: 'stage', label: 'Stage' }, { key: 'owner', label: 'Owner' },
        { key: 'due', label: 'Due' }, { key: 'status', label: 'Status' }, { key: 'late', label: 'Days late', type: 'num' },
        { key: 'next', label: 'Next action' }, { key: 'outcome', label: 'Outcome' }, { key: 'escalation', label: 'Escalation', type: 'num' },
      ],
      rows: list.map((y) => {
        const x = info.get(y.applicationId);
        return {
          refs: { cand: x.a.candidateId, req: x.req.id },
          cells: {
            candidate: people.get(x.a.candidateId) || '—',
            requirement: `${x.req.reqCode ? `${x.req.reqCode} · ` : ''}${x.req.title}`, client: x.req.clientName,
            stage: x.pipe.label, owner: y.ownerName || '—', due: y.dueDate || '—', status: status(y),
            late: cell.vals ? cell.vals.get(y.id) : null, next: y.nextAction || '—', outcome: y.outcome || '—',
            escalation: y.escalationLevel || 0,
          },
        };
      }),
    };
  }

  // Applications.
  const list = ids.map((id) => info.get(id)).filter(Boolean);
  const people = new Map((await prisma.candidate.findMany({
    where: { id: { in: [...new Set(list.map((x) => x.a.candidateId))] } },
    select: { id: true, name: true, phone: true },
  })).map((c) => [c.id, c]));
  const columns = [
    { key: 'candidate', label: 'Candidate', ref: 'cand' }, { key: 'phone', label: 'Phone' },
    { key: 'requirement', label: 'Requirement', ref: 'req' }, { key: 'client', label: 'Client' },
    { key: 'stage', label: 'Stage' }, { key: 'detail', label: 'Detail' }, { key: 'days', label: 'Days in stage', type: 'num' },
    { key: 'recruiter', label: 'Recruiter' }, { key: 'seat', label: 'Seat' }, { key: 'source', label: 'Source' },
    { key: 'added', label: 'Added' },
  ];
  if (['interviews', 'clients', 'recruitment'].includes(reportId)) columns.push({ key: 'interviewAt', label: 'Interview' });
  if (reportId === 'interviews') columns.push({ key: 'ivStatus', label: 'Interview status' });
  if (reportId === 'joining') columns.push({ key: 'joiningDate', label: 'Joining date' }, { key: 'offer', label: 'Offer' }, { key: 'outcome', label: 'Joining outcome' });
  if (reportId === 'ai') columns.push({ key: 'aiStatus', label: 'AI status' }, { key: 'aiScore', label: 'AI score (not client feedback)', type: 'num' });
  if (reportId === 'sla' || reportId === 'recruiters') columns.push({ key: 'late', label: 'Days past SLA', type: 'num' });
  if (cell.vals && !['ai', 'candidates', 'sla', 'recruiters'].includes(reportId)) {
    columns.push({ key: 'value', label: VALUE_LABEL[reportId] || 'Days', type: 'num' });
  }
  if (reportId === 'sla' && cell.vals) columns.push({ key: 'value', label: 'Days (measured)', type: 'num' });
  return {
    columns,
    rows: list.map((x) => {
      const c = people.get(x.a.candidateId) || {};
      return {
        refs: { cand: x.a.candidateId, req: x.req.id },
        cells: {
          candidate: c.name || '—', phone: c.phone || '—',
          requirement: `${x.req.reqCode ? `${x.req.reqCode} · ` : ''}${x.req.title}`, client: x.req.clientName,
          stage: x.pipe.label, detail: stageLabel(x.stage), days: x.daysInStage, recruiter: x.recruiter.label,
          seat: x.seat || '—', source: x.source, added: day(x.a.createdAt), interviewAt: day(x.a.interviewAt),
          ivStatus: x.a.interviewStatus ? interviewStatusLabel(x.a.interviewStatus) : '—',
          joiningDate: x.a.joiningDate || '—', offer: x.a.offerStatus || '—',
          outcome: x.joinOutcome ? JOIN_OUTCOMES[x.joinOutcome] : '—',
          aiStatus: x.a.aiInterviewStatus || '—', aiScore: x.a.aiInterviewScore,
          late: x.daysOverdue, value: cell.vals ? cell.vals.get(x.id) : null,
        },
      };
    }),
  };
}

// The order a list is read in: the measured value (days late, days waiting,
// score) largest first where there is one, newest first otherwise.
async function orderIds(cell, ctx) {
  const ids = [...cell.ids];
  if (cell.vals) return ids.sort((a, b) => (cell.vals.get(b) ?? -1) - (cell.vals.get(a) ?? -1));
  if (cell.kind === 'app') {
    const info = new Map(ctx.apps.map((x) => [x.id, x]));
    return ids.sort((a, b) => info.get(b).a.createdAt - info.get(a).a.createdAt);
  }
  if (cell.kind === 'req') return ids.sort((a, b) => ctx.reqMap.get(b).ageDays - ctx.reqMap.get(a).ageDays);
  if (cell.kind === 'fu') {
    const fus = new Map(ctx.followUps.map((y) => [y.id, y]));
    return ids.sort((a, b) => String(fus.get(a).dueDate || '9999').localeCompare(String(fus.get(b).dueDate || '9999')));
  }
  const names = new Map((await prisma.candidate.findMany({
    where: { id: { in: ids } }, select: { id: true, name: true },
  })).map((c) => [c.id, c.name || '']));
  return ids.sort((a, b) => (names.get(a) || '').localeCompare(names.get(b) || ''));
}

router.get('/:report/drill', VIEW, guarded(async (req, res) => {
  const reportId = req.params.report;
  const q = req.query || {};
  const asCsv = q.format === 'csv';
  if (asCsv && !(await can(req.user, null, 'reports', 'ATS Reports', 'export'))) {
    return res.status(403).json({ error: 'Exporting ATS Reports is not included in your role’s permissions.' });
  }
  const built = await build(req, reportId);
  if (!built) return res.status(404).json({ error: 'No such report' });
  const found = findCell(built.out, String(q.section || ''), String(q.row || ''), String(q.col || ''));
  if (!found) return res.status(404).json({ error: 'That figure is not on this report any more — refresh the report.' });

  const offset = Math.max(0, Number(q.offset) || 0);
  const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
  const ordered = await orderIds(found.cell, built.ctx);
  // Only the page is hydrated — unless the whole list is being exported.
  const ids = asCsv ? ordered : ordered.slice(offset, offset + limit);
  const drilled = await drillRows(ids, found.cell, built.ctx, reportId);
  const { rows } = drilled;
  // Everyday words on the list's headings too (Job, Step, Late).
  const columns = drilled.columns.map((c) => ({ ...c, label: PLUSX.plainWords(c.label) }));
  found.title = PLUSX.plainWords(found.title);

  if (asCsv) {
    const csv = toCsv(columns.map((c) => c.label), rows.map((r) => columns.map((c) => r.cells[c.key])));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileBase(built.spec.title)}-${fileBase(found.title)}.csv"`);
    return res.send(`﻿${csv}`);
  }
  return res.json({
    title: found.title, section: found.sectionTitle || null, report: built.spec.title,
    kind: found.cell.kind, total: found.cell.ids.size, offset, limit, columns, rows,
  });
}));

// ---------------------------------------------------------------------------
// EXPORT — Excel, CSV, PDF and a print page, all from the one payload the
// screen shows, with the filters in force printed on it.
// ---------------------------------------------------------------------------
function fileBase(s) {
  return String(s || 'report').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 60) || 'report';
}
const fmtCell = (v, type) => {
  if (v === null || v === undefined || v === '') return type === 'pct' || type === 'num' ? '—' : '';
  if (type === 'pct') return `${v}%`;
  return v;
};

// The filters in force, in words.
function filterLine(f, ctx) {
  const parts = [];
  if (f.period) parts.push(`Date: ${f.period.label}`);
  if (f.department) parts.push(`Department: ${f.department}`);
  if (f.clientId) {
    const r = [...ctx.reqMap.values()].find((x) => x.clientKey === f.clientId);
    parts.push(`Client: ${r ? r.clientName : '(outside your scope)'}`);
  }
  if (f.requirementId) {
    const r = ctx.reqMap.get(f.requirementId);
    parts.push(`Requirement: ${r ? `${r.reqCode || ''} ${r.title}`.trim() : '(outside your scope)'}`);
  }
  const who = (key, pick) => {
    const x = ctx.apps.find((a) => pick(a) && pick(a).key === key);
    if (x) return pick(x).label;
    if (key.startsWith('u:') && ctx.userById.get(key.slice(2))) return ctx.userById.get(key.slice(2)).name;
    return key.slice(2);
  };
  if (f.recruiter) parts.push(`Recruiter: ${who(f.recruiter, (a) => a.recruiter)}`);
  if (f.tl) parts.push(`TL: ${who(f.tl, (a) => a.tl)}`);
  if (f.stl) parts.push(`STL: ${who(f.stl, (a) => a.stl)}`);
  if (f.bde) parts.push(`BDE: ${who(f.bde, (a) => a.bde)}`);
  if (f.positionCode) parts.push(`Position: ${f.positionCode}`);
  if (f.location) parts.push(`Location: ${f.location}`);
  if (f.source) parts.push(`Source: ${f.source}`);
  if (f.status) {
    const [fam, v] = f.status.split(':');
    parts.push(`Status: ${((fam === 'req' ? REQ_STATUS_FILTERS : CAND_STATUS_FILTERS)[v] || {}).label || f.status}`);
  }
  if (f.stage) parts.push(`Stage: ${(PIPE.find((g) => g.id === f.stage) || {}).label || f.stage}`);
  if (f.interviewStatus) parts.push(`Interview status: ${interviewStatusLabel(f.interviewStatus)}`);
  if (f.aiStatus) parts.push(`AI interview: ${f.aiStatus}`);
  if (f.joiningStatus) parts.push(`Joining: ${JOIN_OUTCOMES[f.joiningStatus] || f.joiningStatus}`);
  return parts.length ? parts.join(' · ') : 'No filters';
}

function tablesOf(payload) {
  return payload.sections.map((s) => ({
    title: s.title,
    headers: s.columns.map((c) => c.label),
    rows: [
      ...s.rows.map((r) => s.columns.map((c, i) => fmtCell(r.c[i], c.type))),
      ...(s.total ? [s.columns.map((c, i) => (i === 0 ? 'Total' : fmtCell(s.total[i], c.type)))] : []),
    ],
    types: s.columns.map((c) => c.type),
  }));
}
const tileRows = (payload) => payload.tiles.map((t) => [
  t.label, t.value === null || t.value === undefined ? '—' : (t.type === 'pct' ? `${t.value}%` : t.value), t.sub || '',
]);

function exportCsv(payload, meta) {
  const blocks = [
    toCsv([`TeamLink ATS Reports — ${payload.title}`], [[`Scope: ${payload.scope}`], [meta.filters], [`Generated: ${meta.generated}`]]),
    ...(payload.tiles.length ? [toCsv(['Figure', 'Value', 'Note'], tileRows(payload))] : []),
    ...tablesOf(payload).map((t) => `${toCsv([t.title], [])}\r\n${toCsv(t.headers, t.rows)}`),
  ];
  return `﻿${blocks.join('\r\n\r\n')}`;
}

function exportXlsx(payload, meta) {
  const wb = XLSX.utils.book_new();
  const summary = XLSX.utils.aoa_to_sheet([
    [`TeamLink ATS Reports — ${payload.title}`], [`Scope: ${payload.scope}`], [meta.filters], [`Generated: ${meta.generated}`], [],
    ...(payload.tiles.length ? [['Figure', 'Value', 'Note'], ...tileRows(payload)] : []),
  ]);
  summary['!cols'] = [{ wch: 32 }, { wch: 14 }, { wch: 48 }];
  XLSX.utils.book_append_sheet(wb, summary, 'Summary');
  const used = new Set(['Summary']);
  tablesOf(payload).forEach((t) => {
    let name = t.title.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31).trim() || 'Sheet';
    let i = 2;
    while (used.has(name)) { name = `${name.slice(0, 28)} ${i}`; i += 1; }
    used.add(name);
    // Numbers arrive as numbers, so the sheet can be summed.
    const ws = XLSX.utils.aoa_to_sheet([t.headers, ...t.rows]);
    ws['!cols'] = t.headers.map((h, ci) => ({
      wch: Math.min(48, Math.max(10, String(h).length + 2, ...t.rows.slice(0, 200).map((r) => String(r[ci] ?? '').length + 2))),
    }));
    XLSX.utils.book_append_sheet(wb, ws, name);
  });
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// pdfkit's built-in Helvetica is Latin-1 only; everything else is spelled out.
const pdfText = (v) => String(v ?? '')
  .replace(/[–—]/g, '-').replace(/→/g, '->').replace(/×/g, 'x').replace(/÷/g, '/')
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/₹/g, 'Rs ')
  .replace(/[^\x09\x0A\x0D\x20-\xFF]/g, '');

const PDF_ROW_CAP = 1500;
function exportPdf(payload, meta, out) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28, info: { Title: `TeamLink ${payload.title}` } });
  doc.pipe(out);
  const W = doc.page.width - 56;
  const bottom = () => doc.page.height - 36;
  doc.font('Helvetica-Bold').fontSize(15).fillColor('#1f2a44').text(pdfText(`TeamLink ATS Reports — ${payload.title}`));
  doc.font('Helvetica').fontSize(9).fillColor('#5b6474')
    .text(pdfText(`Scope: ${payload.scope}   |   ${meta.filters}   |   Generated ${meta.generated}`));
  doc.moveDown(0.6);

  // Tiles, five to a line.
  const tw = W / 5;
  const tiles = tileRows(payload);
  for (let i = 0; i < tiles.length; i += 5) {
    const y = doc.y;
    tiles.slice(i, i + 5).forEach(([label, value], j) => {
      doc.font('Helvetica-Bold').fontSize(13).fillColor('#111').text(pdfText(value), 28 + j * tw, y, { width: tw - 8 });
      doc.font('Helvetica').fontSize(8).fillColor('#5b6474').text(pdfText(label), 28 + j * tw, y + 16, { width: tw - 8 });
    });
    doc.y = y + 32;
  }

  tablesOf(payload).forEach((t) => {
    if (doc.y > bottom() - 60) doc.addPage();
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#1f2a44').text(pdfText(t.title), 28, doc.y);
    doc.moveDown(0.3);
    // Column widths from the longest value, text columns given more room.
    const sample = [t.headers, ...t.rows.slice(0, 300)];
    const want = t.headers.map((_, ci) => Math.min(t.types[ci] === 'text' ? 34 : 12,
      Math.max(6, ...sample.map((r) => String(r[ci] ?? '').length))));
    const sum = want.reduce((s, n) => s + n, 0);
    const widths = want.map((n) => (n / sum) * W);
    const size = t.headers.length > 12 ? 6 : t.headers.length > 9 ? 6.8 : 7.5;
    const lineH = size + 5;
    const fit = (s, w) => {
      const txt = pdfText(s);
      const max = Math.max(1, Math.floor(w / (size * 0.5)));
      return txt.length > max ? `${txt.slice(0, max - 1)}.` : txt;
    };
    const drawRow = (cells, bold, shade) => {
      if (doc.y + lineH > bottom()) { doc.addPage(); drawRow(t.headers, true, true); }
      const y = doc.y;
      if (shade) doc.rect(28, y - 1, W, lineH).fill('#eef1f6');
      let x = 28;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor('#111');
      cells.forEach((c, ci) => {
        const align = t.types[ci] === 'text' ? 'left' : 'right';
        doc.text(fit(c, widths[ci] - 4), x + 2, y + 1, { width: widths[ci] - 4, align, lineBreak: false });
        x += widths[ci];
      });
      doc.y = y + lineH;
    };
    drawRow(t.headers, true, true);
    t.rows.slice(0, PDF_ROW_CAP).forEach((r) => drawRow(r, r[0] === 'Total', false));
    if (t.rows.length > PDF_ROW_CAP) {
      doc.font('Helvetica-Oblique').fontSize(8).fillColor('#5b6474')
        .text(`First ${PDF_ROW_CAP} of ${t.rows.length} rows - the Excel export carries all of them.`, 28, doc.y + 2);
    }
  });
  payload.notes.forEach((n) => { doc.moveDown(0.5); doc.font('Helvetica-Oblique').fontSize(8).fillColor('#5b6474').text(pdfText(n), 28); });
  doc.end();
}

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function exportHtml(payload, meta) {
  const tables = tablesOf(payload).map((t) => `
<h2>${esc(t.title)}</h2>
<table><thead><tr>${t.headers.map((h, i) => `<th class="${t.types[i] === 'text' ? '' : 'n'}">${esc(h)}</th>`).join('')}</tr></thead>
<tbody>${t.rows.map((r) => `<tr${r[0] === 'Total' ? ' class="t"' : ''}>${r.map((c, i) => `<td class="${t.types[i] === 'text' ? '' : 'n'}">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>TeamLink ATS Reports — ${esc(payload.title)}</title>
<style>
@page{size:A4 landscape;margin:12mm}
body{font:11px/1.4 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111;margin:0;padding:16px}
h1{font-size:18px;margin:0 0 2px}.meta{color:#5b6474;margin-bottom:12px}
.tiles{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-bottom:12px}
.tile{border:1px solid #d6dae2;border-radius:6px;padding:6px 9px;break-inside:avoid}.tile b{font-size:16px;display:block}.tile span{color:#5b6474;font-size:10px}
h2{font-size:13px;margin:14px 0 6px;break-after:avoid}
table{border-collapse:collapse;width:100%}tr{break-inside:avoid}
thead{display:table-header-group}th,td{border:1px solid #d6dae2;padding:3px 5px;text-align:left;vertical-align:top}
th{background:#eef1f6}.n{text-align:right;white-space:nowrap}tr.t td{font-weight:600;background:#f6f7fa}
.note{color:#5b6474;font-style:italic;margin-top:8px}
</style></head><body>
<h1>TeamLink ATS Reports — ${esc(payload.title)}</h1>
<div class="meta">Scope: ${esc(payload.scope)} · ${esc(meta.filters)} · Generated ${esc(meta.generated)}</div>
<div class="tiles">${tileRows(payload).map(([l, v]) => `<div class="tile"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('')}</div>
${tables}
${payload.notes.map((n) => `<div class="note">${esc(n)}</div>`).join('')}
</body></html>`;
}

router.get('/:report/export', EXPORT, guarded(async (req, res) => {
  const reportId = req.params.report;
  const built = await build(req, reportId);
  if (!built) return res.status(404).json({ error: 'No such report' });
  const payload = serialize(reportId, built, req.user);
  // Review #3 §12 — export ONE table: ?section=<id> keeps just that table
  // (and leaves the summary tiles out).
  const only = typeof req.query.section === 'string' ? req.query.section : '';
  if (only) {
    const sec = payload.sections.find((s) => s.id === only);
    if (!sec) return res.status(404).json({ error: 'That table is not on this report.' });
    payload.sections = [sec];
    payload.tiles = [];
    payload.title = `${payload.title} — ${sec.title}`;
  }
  await fillNames(payload);
  const meta = { filters: filterLine(built.f, built.ctx), generated: new Date().toISOString().slice(0, 16).replace('T', ' ') };
  const base = `teamlink-ats-${fileBase(payload.title)}-${new Date().toISOString().slice(0, 10)}`;
  const format = String(req.query.format || 'xlsx');
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.csv"`);
    return res.send(exportCsv(payload, meta));
  }
  if (format === 'pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.pdf"`);
    return exportPdf(payload, meta, res);
  }
  if (format === 'html') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(exportHtml(payload, meta));
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${base}.xlsx"`);
  return res.send(exportXlsx(payload, meta));
}));

module.exports = router;
