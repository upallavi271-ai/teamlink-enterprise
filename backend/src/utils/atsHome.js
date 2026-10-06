// ---------------------------------------------------------------------------
// THE ATS HOME — ONE dashboard for every role (user's dashboard review
// 2026-10-03, scratchpad dashboard-review-final.md A–C, and the user's direct
// requests of the same day). There are no Operations / Management / Admin
// tabs any more: every login gets this one page, built for its role and its
// scope ("your area"):
//   1. FIVE NUMBERS on top (`top`), each labelled 'now' or 'range'
//   2. WHAT DO I DO NOW (`attention`): problem lines with ONE button each
//      (Super Admin / Admin / Manager / Asst Manager / STL / BDE / HR), or the
//      short work list a TL ("Needs my check") or a Recruiter ("Do this now")
//      acts on directly
//   3. one small trend (or, for Super Admin / Admin, section C's panels:
//      Money, People today, Departments, Hiring funnel, Busiest recruiters,
//      Recruiter activity)
//
// EVERY NUMBER OPENS ITS OWN LIST RIGHT THERE: `drill` names a set that
// GET /api/dashboard/ats/home/list returns — counted by this same code, so
// the count always equals the rows. That list has its own search, filters
// (cascading, with counts) and Export (homeList / exportList below).
//
// ONE NUMBER, ONE MEANING (spec §4): a count here is a count of the same
// rows the Candidates list and the Jobs list show for the same filter —
//   Open jobs        = Jobs › Open (live statuses, V.REQUIREMENT_LIVE_STATUSES)
//   People in process= Candidates › Active: one row per candidate + job in
//                      the ATS (not Rejected / Hold / Joined; Job Portal rows
//                      only after Send to ATS). Different people are given
//                      as the small line under it.
//   Selected         = Candidates › Selected (Selected / Offer / Offer Accepted)
//
// DUE DATES, LATE AND STALE come from utils/nextAction.js (one rule for the
// whole app; the default days per step are Admin settings —
// utils/atsAlertSettings.js). A Stale row (nothing happening for 30+ days —
// the old imported backlog) is never counted Late; it has its own panel and a
// Super Admin / Admin can bulk-close it (closeStale below).
//
// SPEED: the role scope's rows (applications, jobs, who worked on them, due
// status) are read ONCE into a "world" (worldFor) shared by every login with
// the same scope, and reused while the data has not changed; every filter
// and every number is then worked out in memory.
// Test / demo rows (ZZTEST, @example.test) are never shown.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const V = require('./atsVocab');
const NA = require('./nextAction');
const AS = require('./atsAlertSettings');
const {
  applicationWhere, requirementWhere, clientWhere, atsScopeOf: scopeOf, employeeWhere, invoiceWhere,
} = require('./scope');
const A = require('./accounts');
const dateRange = require('./dateRange');

const DAY = 86400000;
const TEST_RE = /zztest|example\.test/i;
const isTest = (s) => TEST_RE.test(String(s || ''));
const CLOSED = ['REJECTED', 'JOINED', 'HIRED'];
const NOT_ACTIVE = ['REJECTED', 'HOLD', 'JOINED', 'HIRED'];
const JOINED = ['JOINED', 'HIRED'];
const SELECTED_NOT_JOINED = ['SELECTED', 'OFFER', 'OFFER_ACCEPTED'];
const CLIENT_DECISION = ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW'];
const CLIENT_CHAIN = ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'CLIENT_SHORTLISTED', 'INTERVIEW_SCHEDULED',
  'INTERVIEW_COMPLETED', 'SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED'];
const INTERVIEW_ON = ['INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED', 'SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED'];
const SELECTED_ON = ['SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED'];
const REVIEW_STAGES = ['NEW', 'AI_INTERVIEW_COMPLETED', 'RECRUITER_REVIEW', 'RECRUITER_APPROVED'];
const DEAD_INTERVIEW = ['CANCELLED', 'NO_SHOW'];
const INTERNAL_HIRE = 'TeamLink Internal Hire';
// What a bulk "Close stale…" may move rows to — existing terminal / hold stages only.
const STALE_TARGETS = { REJECTED: 'Rejected (closed)', HOLD: 'On Hold' };

// THE STEP IN EVERYDAY WORDS (spec §2: Step, not Stage; Check by recruiter …).
const STEP_WORDS = {
  NEW: 'New',
  AI_INTERVIEW_REQUIRED: 'AI interview',
  AI_INTERVIEW_SCHEDULED: 'AI interview',
  AI_INTERVIEW_COMPLETED: 'Waiting for recruiter review',
  RECRUITER_REVIEW: 'Waiting for recruiter review',
  RECRUITER_APPROVED: 'Waiting for recruiter review',
  TL_REVIEW: 'Waiting for team lead review',
  WITH_BDE: 'Check by client manager (BDE)',
  BDE_APPROVED: 'Check by client manager (BDE)',
  SHARED_WITH_CLIENT: 'Sent to client',
  CLIENT_REVIEW: 'Sent to client',
  CLIENT_SHORTLISTED: 'Client shortlisted',
  INTERVIEW_SCHEDULED: 'Interview fixed',
  INTERVIEW_COMPLETED: 'Interview done',
  SELECTED: 'Selected',
  OFFER: 'Offer',
  OFFER_ACCEPTED: 'Waiting to join',
  JOINED: 'Joined',
  HIRED: 'Joined',
  HOLD: 'On hold',
  REJECTED: 'Rejected',
};
const stepWord = (stage) => STEP_WORDS[stage] || V.stageLabel(stage) || stage || '—';
const STEP_ORDER = [...new Set(Object.values(STEP_WORDS))];
const DUE_WORDS = { overdue: 'Late', due_today: 'Due today', upcoming: 'Coming up', stale: 'Not moving', no_due: 'No due date', closed: 'Done' };
const DUE_ORDER = ['overdue', 'due_today', 'upcoming', 'stale', 'no_due', 'closed'];

const and = (...parts) => {
  const p = parts.filter((x) => x && Object.keys(x).length);
  if (!p.length) return {};
  return p.length === 1 ? p[0] : { AND: p };
};
const istStart = (day) => new Date(`${day}T00:00:00+05:30`);
const addDays = (day, n) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const fmtN = (n) => Number(n || 0).toLocaleString('en-IN');
const plural = (n, one, many) => `${fmtN(n)} ${n === 1 ? one : many}`;
const msOf = (v) => { if (!v) return 0; const t = new Date(v).getTime(); return Number.isNaN(t) ? 0 : t; };
const chunked = async (list, fn, size = 900) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(...await fn(list.slice(i, i + size))); // eslint-disable-line no-await-in-loop
  return out;
};

// Which page a login gets.
function layoutOf(user) {
  const s = scopeOf(user);
  const r = s.atsRole;
  if (r === 'SUPER_ADMIN') return 'superadmin';
  if (r === 'ADMIN') return 'admin';
  if (r === 'MANAGER') return 'manager';
  if (r === 'ASSISTANT_MANAGER') return 'asstmanager';
  if (r === 'STL') return 'stl';
  if (r === 'TL') return 'tl';
  if (r === 'BDE') return 'bde';
  if (r === 'HR') return 'hr';
  if (r === 'RECRUITER') return 'recruiter';
  return s.global ? 'admin' : 'recruiter';
}
const TITLES = {
  superadmin: 'Company',
  admin: 'Company',
  manager: 'My Area',
  asstmanager: 'My Teams',
  stl: 'My Section',
  tl: 'My Team',
  recruiter: 'My Work',
  bde: 'My Clients',
  hr: 'Internal Hiring',
};
// The one question each page answers (spec §3 — "the first 5 seconds").
const QUESTIONS = {
  superadmin: 'How is the company doing, and where is the problem?',
  admin: 'How is the company doing, and where is the problem?',
  manager: 'Which of my departments is slow?',
  asstmanager: 'Which of my teams has work waiting?',
  stl: 'Which recruiter in my section has work waiting?',
  tl: 'Who in my team is waiting for my check?',
  recruiter: 'What do I do first today?',
  bde: 'Which clients have not given feedback?',
  hr: 'Who is waiting for my check, offers and joinings?',
};
// What the page shows, in one plain line under the title (user, 2026-10-05:
// a brand-new person must get the page in 20–30 seconds).
const ABOUT = {
  superadmin: 'All jobs and candidates in the company: what is late, who works on what.',
  admin: 'All jobs and candidates in the company: what is late, who works on what.',
  manager: 'Your departments: jobs, candidates, team leads and what is late.',
  asstmanager: 'Your teams: jobs, candidates, team leads and what is late.',
  stl: 'Your section: jobs, candidates, team leads and what is late.',
  tl: 'Your team: who needs your check, your recruiters and your open jobs.',
  recruiter: 'Your work for today, your interviews and your jobs.',
  bde: 'Your clients: feedback to chase, agreements and open jobs.',
  hr: 'Internal hiring: people to check, offers and joinings.',
};
const COMPANY = ['superadmin', 'admin'];
// Screening (the Job Portal step) is the recruiter's / HR's only.
const SCREENING = ['recruiter', 'hr'];

const toneOfDue = { overdue: 'red', due_today: 'amber', upcoming: 'green' };
function dueExtra(na) {
  if (!na) return {};
  if (na.dueStatus === 'stale') return { note: `Not moving${na.staleDays != null ? ` · ${na.staleDays} days` : ' · old import'}`, tone: 'amber', dueKey: 'stale' };
  return { due: na.dueAt, tone: toneOfDue[na.dueStatus] || null, dueKey: na.dueStatus };
}
const extraOf = (list) => new Map(list.map((x) => [x.a.id, dueExtra(x.na)]));

// ---- the board ---------------------------------------------------------------
function newBoard(layout) {
  return {
    layout, title: TITLES[layout], question: QUESTIONS[layout], about: ABOUT[layout], top: [], attention: { title: 'Needs attention', lines: [], rows: null },
    stale: null, side: [], departments: null, funnel: null, busiest: null, activity: null, workload: null,
    clients: null, trend: null, extras: [], sets: new Map(),
  };
}
const addSet = (b, id, def) => { b.sets.set(id, { id, ...def }); return id; };
const tile = (id, label, value, basis, extra = {}) => ({ id, label, value, basis, ...extra });
const line = (id, label, count, extra = {}) => ({ id, label, count, ...extra });

// ===========================================================================
// THE WORLD — the role scope's rows, read once, shared, reused
// ===========================================================================
const APP_SELECT = {
  id: true, candidateId: true, requirementId: true, stage: true, createdAt: true, updatedAt: true,
  source: true, portalImportedAt: true, hiringType: true, interviewAt: true, interviewStatus: true,
  interviewResult: true, interviewCompletedAt: true, joiningDate: true, joinedAt: true,
  // v3 dashboard: "Today's interviews" shows the round and the mode.
  interviewRound: true, interviewMode: true,
};
const REQ_SELECT = {
  id: true, title: true, reqCode: true, department: true, recruiterId: true, recruiterIds: true, tlId: true, bdeId: true,
  internal: true, hiringType: true, clientId: true, status: true, positionCode: true, tl: true, priority: true,
  openings: true, createdAt: true, recruiter: { select: { name: true } },
};
const WORLDS = new Map(); // scope key -> { key, stamp, at, w, building }
const WORLD_MAX = 24;
const WORLD_MAX_AGE_MS = 10 * 60 * 1000;
// While a fresher copy is being read, a copy this young is still served
// (and the page says "as of HH:MM").
const WORLD_STALE_OK_MS = 120 * 1000;

let STAMP = { at: 0, v: '', snap: '' };
async function dataStamp() {
  // Never wait for nextAction's own re-read when a copy exists: it runs
  // behind, and the next request sees the change.
  const pending = NA.ensureNextActionContext();
  if (!NA.snapshot().loaded) await pending;
  const snap = NA.snapshot().stamp;
  if (Date.now() - STAMP.at < 5000 && STAMP.snap === snap) return STAMP.v;
  const r = await prisma.requirement.aggregate({ _count: { _all: true }, _max: { updatedAt: true } });
  const v = [snap, AS.alertSettingsVersion(), r._count._all, msOf(r._max.updatedAt)].join('#');
  STAMP = { at: Date.now(), v, snap };
  return v;
}

// A whole table, plain columns (names come from our own select lists, never
// from a request). DateTime columns come back as Date objects, like Prisma's.
const APP_DATES = ['createdAt', 'updatedAt', 'portalImportedAt', 'interviewAt', 'interviewCompletedAt', 'joinedAt'];
const toDate = (v) => {
  if (v === null || v === undefined || v instanceof Date) return v ?? null;
  const d = new Date(typeof v === 'bigint' ? Number(v) : v);
  return Number.isNaN(d.getTime()) ? null : d;
};
async function rawAll(table, cols, dateCols, orderBy = null) {
  if (!/^[A-Za-z]+$/.test(table) || !cols.every((x) => /^[A-Za-z]+$/.test(x))) throw new Error('bad raw read');
  const rows = await prisma.$queryRawUnsafe(`SELECT ${cols.map((x) => `"${x}"`).join(', ')} FROM "${table}"${orderBy ? ` ORDER BY "${orderBy}" ASC` : ''}`);
  if (dateCols.length) rows.forEach((r) => { dateCols.forEach((k) => { r[k] = toDate(r[k]); }); });
  return rows;
}

async function loadWorld(appWhere, reqWhere, today) {
  const t0 = Date.now();
  // The whole company (no scope filter): plain SQL reads, ~3x faster than
  // the same rows through Prisma's object mapping.
  const global = !Object.keys(appWhere || {}).length;
  const [apps, reqs] = await Promise.all([
    global ? rawAll('Application', Object.keys(APP_SELECT), APP_DATES) : prisma.application.findMany({ where: appWhere, select: APP_SELECT }),
    prisma.requirement.findMany({ where: reqWhere, select: REQ_SELECT }),
  ]);
  const reqById = new Map(reqs.map((r) => [r.id, r]));
  const missing = [...new Set(apps.map((a) => a.requirementId).filter((id) => id && !reqById.has(id)))];
  (await chunked(missing, (part) => prisma.requirement.findMany({ where: { id: { in: part } }, select: REQ_SELECT }))).forEach((r) => reqById.set(r.id, r));
  const clientIds = [...new Set([...reqById.values()].map((r) => r.clientId).filter(Boolean))];
  const candIds = [...new Set(apps.map((a) => a.candidateId))];
  const appIds = apps.map((a) => a.id);
  // Everything in the company: read the tables whole (faster than id lists).
  const whole = appIds.length > 4000;
  const idIn = (part) => ({ applicationId: { in: part } });
  // eslint-disable-next-line global-require
  const W = require('./workers');
  const FU_SELECT = { applicationId: true, ownerUserId: true, ownerName: true, ownerPositionCode: true, tlUserId: true, tlName: true, bdeUserId: true, bdeName: true, createdAt: true };
  const EV_SELECT = { applicationId: true, fromStage: true, toStage: true, actorUserId: true, actorName: true, actorRole: true, actorPositionCode: true, actorSide: true, createdAt: true };
  const [clients, cands, dir, fus, evs] = await Promise.all([
    chunked(clientIds, (part) => prisma.client.findMany({ where: { id: { in: part } }, select: { id: true, name: true, bdeOwner: true, ownerDepartment: true } })),
    whole ? rawAll('Candidate', ['id', 'name'], []) : chunked(candIds, (part) => prisma.candidate.findMany({ where: { id: { in: part } }, select: { id: true, name: true } })),
    W.loadDirectory(),
    whole
      ? rawAll('ApplicationFollowUp', Object.keys(FU_SELECT), ['createdAt'], 'createdAt')
      : chunked(appIds, (part) => prisma.applicationFollowUp.findMany({ where: idIn(part), select: FU_SELECT, orderBy: { createdAt: 'asc' } })),
    whole
      ? rawAll('ApplicationStageEvent', Object.keys(EV_SELECT), ['createdAt'], 'createdAt')
      : chunked(appIds, (part) => prisma.applicationStageEvent.findMany({ where: idIn(part), select: EV_SELECT, orderBy: { createdAt: 'asc' } })),
  ]);
  const clientById = new Map(clients.map((x) => [x.id, x]));
  reqById.forEach((r) => { r.client = clientById.get(r.clientId) || null; });
  const candName = new Map(cands.map((x) => [x.id, x.name]));
  const group = (list) => { const m = new Map(); list.forEach((x) => { if (!m.has(x.applicationId)) m.set(x.applicationId, []); m.get(x.applicationId).push(x); }); return m; };
  const fuBy = group(fus);
  const evBy = group(evs);
  const recruiterOfReq = (r) => (r && (r.recruiterId || String(r.recruiterIds || '').split(',').filter(Boolean)[0])) || null;
  const rows = apps.map((a) => {
    const r = reqById.get(a.requirementId) || null;
    a.requirement = r; // nextAction / isInternal read it
    const req = r || {};
    const who = W.attribute({ recruiterId: recruiterOfReq(r), tlId: req.tlId, tl: req.tl, bdeId: req.bdeId, positionCode: req.positionCode }, fuBy.get(a.id) || [], evBy.get(a.id) || [], dir.person);
    const live = !CLOSED.includes(a.stage);
    return {
      a,
      who: { recruiter: who.recruiter || null, tl: who.tl || null, bde: who.bde || null },
      live,
      pre: V.isPreAtsApplication(a),
      internal: NA.isInternal(a),
      na: live ? NA.nextActionFor(a, { today }) : null,
      cand: candName.get(a.candidateId) || '—',
      evs: (evBy.get(a.id) || []).map((e) => ({ to: e.toStage, from: e.fromStage, at: msOf(e.createdAt), actor: e.actorUserId || null, actorName: e.actorName || null, side: e.actorSide || null, role: e.actorRole || null })),
    };
  });
  // Per job: who worked on it and the sources on it (the person / source filters on jobs).
  const reqPeople = new Map();
  const reqSources = new Map();
  rows.forEach((x) => {
    const id = x.a.requirementId;
    if (!reqPeople.has(id)) reqPeople.set(id, { recruiter: new Set(), tl: new Set(), bde: new Set() });
    const p = reqPeople.get(id);
    ['recruiter', 'tl', 'bde'].forEach((k) => { if (x.who[k]) p[k].add(x.who[k].key); });
    if (x.a.source) { if (!reqSources.has(id)) reqSources.set(id, new Set()); reqSources.get(id).add(x.a.source); }
  });
  return {
    rows, byId: new Map(rows.map((x) => [x.a.id, x])), reqs, reqById, reqPeople, reqSources,
    builtAt: Date.now(), buildMs: Date.now() - t0, today,
  };
}

async function worldFor(user, { fresh = false } = {}) {
  const appWhere = applicationWhere(user);
  const reqWhere = requirementWhere(user);
  const today = NA.todayIst();
  const key = crypto.createHash('md5').update(JSON.stringify([appWhere, reqWhere, today])).digest('hex');
  const stamp = await dataStamp();
  const hit = WORLDS.get(key);
  const age = hit && hit.w ? Date.now() - hit.at : Infinity;
  if (!fresh && hit && hit.w && hit.stamp === stamp && age < WORLD_MAX_AGE_MS) return hit.w;
  const start = () => {
    const entry = WORLDS.get(key) || {};
    if (entry.building) return entry.building;
    const p = loadWorld(appWhere, reqWhere, today).then((w) => {
      WORLDS.delete(key);
      WORLDS.set(key, { key, stamp, at: Date.now(), w, building: null });
      while (WORLDS.size > WORLD_MAX) WORLDS.delete(WORLDS.keys().next().value);
      return w;
    }).catch((err) => { const e = WORLDS.get(key); if (e) e.building = null; throw err; });
    WORLDS.set(key, { ...entry, key, building: p });
    return p;
  };
  // Changed since: serve the young copy and read a fresh one behind it.
  if (!fresh && hit && hit.w && age < WORLD_STALE_OK_MS) {
    start().catch((err) => console.error('[atsHome] world refresh failed:', err.message)); // eslint-disable-line no-console
    return hit.w;
  }
  return start();
}

// Warm the company-wide copy shortly after start-up, so the first Super
// Admin / Admin dashboard after a restart does not wait for it.
// SPEED (2026-10-03): it now starts after 0.5 s instead of 6 s, and it
// registers itself as the copy being built — a dashboard request that comes
// in meanwhile JOINS this read (worldFor's start() returns entry.building)
// instead of reading the whole company a second time alongside it. Then the
// board is built once for a real Super Admin, so its code is compiled when
// the first person asks. Same functions, same rows: nothing is computed
// differently. utils/candidateWarmup.js waits for this before its own work.
let WARM = null;
function warmCompanyWorld() {
  if (WARM) return WARM;
  WARM = (async () => {
    await NA.ensureNextActionContext();
    const today = NA.todayIst();
    const key = crypto.createHash('md5').update(JSON.stringify([{}, {}, today])).digest('hex');
    if (!WORLDS.has(key)) {
      const stamp = await dataStamp();
      const p = loadWorld({}, {}, today).then((w) => {
        const e = WORLDS.get(key);
        // A request may have finished a newer copy meanwhile: keep that one.
        if (!e || e.building === p) WORLDS.set(key, { key, stamp, at: Date.now(), w, building: null });
        return w;
      }).catch((err) => { const e = WORLDS.get(key); if (e && e.building === p) WORLDS.delete(key); throw err; });
      if (!WORLDS.has(key)) WORLDS.set(key, { key, building: p });
      await p;
    }
    const sa = (await prisma.user.findMany({
      where: { role: 'SUPER_ADMIN', status: 'Active' }, select: { id: true, name: true, email: true }, take: 20,
    })).find((u) => !/zztest|example\.test/i.test(`${u.name} ${u.email}`));
    // eslint-disable-next-line global-require
    const user = sa ? await require('./identity').resolveIdentity(sa.id) : null;
    if (user) await buildHome(user, { query: { range: 'this_month' } });
  })().catch((err) => console.error('[atsHome] warm-up failed:', err.message)); // eslint-disable-line no-console
  return WARM;
}
setTimeout(warmCompanyWorld, 500).unref?.();

// ===========================================================================
// THE DASHBOARD FILTERS (user feedback 2026-10-03 #4 + the FILTER RULE)
// ===========================================================================
// Date range (only the "In range" cards) · Department · Client · TL ·
// Recruiter · BDE · Job · Hiring type · Priority · Source. Each one only
// NARROWS the login's role scope; the URL carries them. The options are
// worked out from the rows matching every OTHER filter (cascading), with
// counts, never a zero option. People filters use the Recruiter & BDE
// attribution (utils/workers.js), so they match the names on the rows.
const FILTER_KEYS = ['department', 'clientId', 'tl', 'recruiter', 'bde', 'requirementId', 'hiring', 'priority', 'source'];
// Filters a role does not get: a recruiter never picks (or sees) other people.
const HIDDEN_FILTERS = {
  recruiter: ['recruiter', 'tl', 'bde'],
  hr: ['recruiter', 'tl', 'bde', 'clientId'],
  bde: ['bde'],
  tl: ['tl'],
};
function readFilters(layout, q) {
  const s = (v) => (typeof v === 'string' ? v.trim() : '');
  const f = {};
  FILTER_KEYS.forEach((k) => { if (s(q[k]) && !(HIDDEN_FILTERS[layout] || []).includes(k)) f[k] = s(q[k]).slice(0, 200); });
  // The v3 filter bar (components/ui/PageFilterBar.jsx) sends ONE person as
  // recruiterId / bdeId: a user id, or an attribution key ("n:…") as is.
  const asKey = (v) => (v.includes(':') ? v : `u:${v}`);
  [['recruiterId', 'recruiter'], ['bdeId', 'bde']].forEach(([qk, k]) => {
    if (s(q[qk]) && !f[k] && !(HIDDEN_FILTERS[layout] || []).includes(k)) f[k] = asKey(s(q[qk]).slice(0, 200));
  });
  if (f.hiring && !['client', 'internal'].includes(f.hiring)) delete f.hiring;
  return f;
}
// An application row against the filters (except some).
function rowMatches(x, f, except = []) {
  const { a } = x;
  const r = a.requirement || {};
  const on = (k) => !!f[k] && !except.includes(k);
  if (on('department') && (f.department === '__none__' ? !!r.department : r.department !== f.department)) return false;
  if (on('clientId') && r.clientId !== f.clientId) return false;
  if (on('requirementId') && a.requirementId !== f.requirementId) return false;
  if (on('hiring') && x.internal !== (f.hiring === 'internal')) return false;
  if (on('priority') && r.priority !== f.priority) return false;
  if (on('source') && a.source !== f.source) return false;
  for (const k of ['recruiter', 'tl', 'bde']) if (on(k) && !(x.who && x.who[k] && x.who[k].key === f[k])) return false;
  return true;
}
// A job against the filters: its own fields, or (people / source) the
// applications on it — a job counts for a person who worked on it, or who it names.
const PERSON_FIELD = { recruiter: 'recruiterId', tl: 'tlId', bde: 'bdeId' };
function reqMatches(w, r, f, except = []) {
  const on = (k) => !!f[k] && !except.includes(k);
  if (on('department') && (f.department === '__none__' ? !!r.department : r.department !== f.department)) return false;
  if (on('clientId') && r.clientId !== f.clientId) return false;
  if (on('requirementId') && r.id !== f.requirementId) return false;
  if (on('hiring') && (!!r.internal || r.hiringType === INTERNAL_HIRE) !== (f.hiring === 'internal')) return false;
  if (on('priority') && r.priority !== f.priority) return false;
  if (on('source') && !(w.reqSources.get(r.id) || new Set()).has(f.source)) return false;
  for (const k of ['recruiter', 'tl', 'bde']) {
    if (!on(k)) continue;
    const worked = (w.reqPeople.get(r.id) || {})[k];
    const named = f[k].startsWith('u:') && (r[PERSON_FIELD[k]] === f[k].slice(2) || (k === 'recruiter' && String(r.recruiterIds || '').split(',').includes(f[k].slice(2))));
    if (!(worked && worked.has(f[k])) && !named) return false;
  }
  return true;
}
const isLiveReq = (r) => V.REQUIREMENT_LIVE_STATUSES.includes(r.status);
const recruiterOf = (r) => (r && (r.recruiterId || String(r.recruiterIds || '').split(',').filter(Boolean)[0])) || null;
const ids = (list) => list.map((x) => (x.a ? x.a.id : x.id));

function filterOptions(c, base) {
  const hidden = HIDDEN_FILTERS[c.layout] || [];
  const facet = (key, valueOf, labelOf, { limit = 300 } = {}) => {
    if (hidden.includes(key)) return null;
    const m = new Map();
    base.forEach((x) => {
      if (!rowMatches(x, c.f, [key])) return;
      const v = valueOf(x);
      if (!v) return;
      const label = labelOf(x);
      if (isTest(label)) return;
      const e = m.get(v) || { value: v, label, count: 0 };
      e.count += 1;
      m.set(v, e);
    });
    const list = [...m.values()].sort((x, y) => y.count - x.count || String(x.label).localeCompare(String(y.label)));
    const out = list.slice(0, limit);
    // The picked value always stays listed, so its chip can be read.
    if (c.f[key] && !out.some((o) => o.value === c.f[key])) out.push({ value: c.f[key], label: (list.find((o) => o.value === c.f[key]) || {}).label || c.f[key], count: 0 });
    return out;
  };
  const r = (x) => x.a.requirement || {};
  const person = (k) => (x) => (x.who && x.who[k] ? x.who[k].key : null);
  const personLabel = (k) => (x) => x.who[k].label;
  return {
    department: facet('department', (x) => r(x).department || '__none__', (x) => r(x).department || 'No department'),
    clientId: facet('clientId', (x) => (!x.internal && r(x).clientId) || null, (x) => (r(x).client ? r(x).client.name : '—')),
    tl: facet('tl', person('tl'), personLabel('tl')),
    recruiter: facet('recruiter', person('recruiter'), personLabel('recruiter')),
    bde: facet('bde', person('bde'), personLabel('bde')),
    requirementId: facet('requirementId', (x) => x.a.requirementId, (x) => r(x).title || '—'),
    hiring: facet('hiring', (x) => (x.internal ? 'internal' : 'client'), (x) => (x.internal ? 'Internal hiring' : 'Client hiring')),
    priority: facet('priority', (x) => r(x).priority || null, (x) => r(x).priority),
    source: facet('source', (x) => (x.a.source && x.a.source.length <= 60 ? x.a.source : null), (x) => x.a.source),
  };
}

// ---- the request ----------------------------------------------------------------------
// ONE GLOBAL DATE FILTER (dashboard review #2): Today / This week / This
// month (default). It moves every "what happened" number (interviews,
// joinings, money, funnel, new jobs); the "as it stands" numbers (open jobs,
// in process, late…) are always now — and they say so in their own words.
const PERIODS = ['today', 'this_week', 'this_month'];
// The v3 filter bar's Date range also offers these (and a custom From → To).
const MORE_PERIODS = ['yesterday', 'last_7', 'last_month', 'this_quarter', 'this_year'];
const PERIOD_WORD = { today: 'today', this_week: 'this week', this_month: 'this month', yesterday: 'yesterday', last_7: 'in the last 7 days', last_30: 'in the last 30 days', last_month: 'last month', this_quarter: 'this quarter', this_year: 'this year', all: 'so far' };
const PREV_WORD = { today: 'yesterday', this_week: 'last week', this_month: 'last month', yesterday: 'the day before', last_7: 'the 7 days before', last_30: 'the 30 days before', last_month: 'the month before', this_quarter: 'last quarter', this_year: 'last year', all: '' };
function previousPeriod(p) {
  if (p.key === 'last_month') {
    const [y, m] = p.from.split('-').map(Number);
    return { from: new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10), to: new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10), key: 'prev' };
  }
  if (p.key === 'this_quarter' || p.key === 'this_year') {
    const [y, m] = p.from.split('-').map(Number);
    const back = p.key === 'this_year' ? 12 : 3;
    const from = new Date(Date.UTC(y, m - 1 - back, 1)).toISOString().slice(0, 10);
    const end = new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
    const len = Math.round((new Date(`${p.to}T00:00:00Z`) - new Date(`${p.from}T00:00:00Z`)) / DAY);
    const to = addDays(from, len);
    return { from, to: to < end ? to : end, key: 'prev' };
  }
  if (p.key === 'this_month') {
    const [y, m] = p.from.split('-').map(Number);
    const from = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
    const end = new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
    const sameDay = `${from.slice(0, 8)}${p.to.slice(8, 10)}`;
    return { from, to: sameDay < end ? sameDay : end, key: 'prev' };
  }
  const len = Math.round((new Date(`${p.to}T00:00:00Z`) - new Date(`${p.from}T00:00:00Z`)) / DAY) + 1;
  const shift = p.key === 'this_week' ? 7 : len;
  return { from: addDays(p.from, -shift), to: addDays(p.to, -shift), key: 'prev' };
}

async function context(user, req) {
  const { can } = require('../middleware/auth'); // eslint-disable-line global-require
  const s = scopeOf(user);
  const layout = layoutOf(user);
  const q = (req && req.query) || {};
  const today = NA.todayIst();
  const f = readFilters(layout, q);
  // The v3 filter bar's ranges: week / month / 30d / custom / all ("Any time").
  const RANGE_ALIAS = { week: 'this_week', month: 'this_month' };
  const qRange = RANGE_ALIAS[q.range] || q.range;
  const utcToday = new Date().toISOString().slice(0, 10);
  const custom = (qRange === 'custom' || !qRange) && q.from && q.to;
  const key = PERIODS.includes(qRange) || MORE_PERIODS.includes(qRange) || ['last_30', '30d', 'all'].includes(qRange) ? (qRange === '30d' ? 'last_30' : qRange) : custom ? 'custom' : 'this_month';
  let period;
  if (key === 'last_30') period = { from: addDays(utcToday, -29), to: utcToday };
  else if (key === 'all') period = { from: '2000-01-01', to: utcToday };
  else period = dateRange.resolve(key === 'custom' ? { range: 'custom', from: String(q.from), to: String(q.to) } : { range: key });
  period.key = key;
  const noPrev = key === 'all';
  const prev = noPrev ? { from: '1900-01-01', to: '1900-01-01', key: 'prev' } : previousPeriod(period);
  const [clientDesk, mayMoney, systemAlerts] = await Promise.all([
    can(user, null, 'clients', 'Client List', 'view'),
    can(user, 'accounts', 'accounts', 'Invoices', 'view'),
    // Integration / AI-credit alerts: Super Admin by default; an Admin only
    // when Role Catalog grants Dashboard / System Alerts.
    can(user, null, 'dashboard', 'System Alerts', 'view'),
  ]);
  return {
    user, s, layout, today, f, dept: f.department || '', period, prev, noPrev, clientDesk, mayMoney, systemAlerts,
    word: PERIOD_WORD[key] || `in ${period.label || `${period.from} – ${period.to}`}`, prevWord: PREV_WORD[key] || 'the period before',
    screening: SCREENING.includes(layout),
    monthStart: `${today.slice(0, 7)}-01`, yearStart: `${today.slice(0, 4)}-01-01`,
  };
}

const inDay = (ms, day) => ms >= istStart(day).getTime() && ms < istStart(day).getTime() + DAY;
const BOUNDS = new Map();
const inPeriod = (ms, p) => {
  const k = `${p.from}|${p.to}`;
  let bd = BOUNDS.get(k);
  if (!bd) { bd = [istStart(p.from).getTime(), istStart(addDays(p.to, 1)).getTime()]; BOUNDS.set(k, bd); if (BOUNDS.size > 200) BOUNDS.clear(); }
  return ms >= bd[0] && ms < bd[1];
};
const liveInterview = (a) => !DEAD_INTERVIEW.includes(a.interviewStatus);
const joinedSince = (a, dayFrom, dayTo) => {
  if (!JOINED.includes(a.stage)) return false;
  const jd = String(a.joiningDate || '').slice(0, 10);
  if (jd) return jd >= dayFrom && jd <= dayTo;
  return a.joinedAt ? NA.istDay(a.joinedAt) >= dayFrom && NA.istDay(a.joinedAt) <= dayTo : false;
};
const enteredIn = (x, stages, p) => x.evs.some((e) => stages.includes(e.to) && !(e.from && stages.includes(e.from)) && inPeriod(e.at, p));

// ▲▼ against the period before ("▲ 12 vs last month").
function delta(c, cur, prev) {
  if (prev === null || prev === undefined || c.noPrev) return null;
  const d = cur - prev;
  // pct: the % change the v3 StatCard draws (null when the period before had none).
  if (!d) return { dir: 'same', text: `same as ${c.prevWord}`, pct: 0, prev };
  return { dir: d > 0 ? 'up' : 'down', text: `${d > 0 ? '▲' : '▼'} ${fmtN(Math.abs(d))} vs ${c.prevWord}`, pct: prev > 0 ? Math.round((d / prev) * 1000) / 10 : null, prev };
}

// A job is BACKLOG when it has been open 30+ days, or came in with a bulk
// import (an IST day with hundreds of rows — utils/nextAction.js bulkDays):
// the imported trackers name no recruiter, so those are not today's work.
function isBacklogJob(r) {
  const bulk = NA.snapshot().bulkDays || new Set();
  return msOf(r.createdAt) < Date.now() - 30 * DAY || bulk.has(NA.istDay(r.createdAt));
}

// ---- the cleanup bucket (Administration → Company Setup → Data cleanup) ---------------
// The old backlog is OFF the dashboard (review #2): nothing happening for
// 30+ days (Stale) and jobs open 30+ days with no recruiter. The sets are
// still built here, so Data cleanup opens the same lists.
function cleanupSets(c, b, k) {
  const stale = k.rows.filter((x) => x.na.dueStatus === 'stale');
  const byStage = new Map();
  stale.forEach(({ a }) => byStage.set(a.stage, (byStage.get(a.stage) || 0) + 1));
  const days = NA.staleAfterDays();
  addSet(b, 'stale', { kind: 'app', title: `Not moving (${days}+ days)`, ids: ids(stale), extra: extraOf(stale) });
  const oldUnassigned = k.jobsNoRecruiter.filter(isBacklogJob);
  addSet(b, 'old-unassigned', { kind: 'req', title: 'Old jobs with no recruiter (imported or open 30+ days)', ids: oldUnassigned.map((r) => r.id) });
  b.cleanup = {
    stale: stale.length,
    days,
    oldUnassigned: oldUnassigned.length,
    stages: [...byStage.entries()].sort((x, y) => y[1] - x[1]).map(([stage, n]) => ({ stage, label: stepWord(stage), count: n })),
    canClose: COMPANY.includes(c.layout),
    targets: Object.entries(STALE_TARGETS).map(([id, label]) => ({ id, label })),
    to: COMPANY.includes(c.layout) ? '/admin/data-cleanup' : null,
  };
}

// ---- money (Super Admin) --------------------------------------------------------------
async function moneyPanel(c, b) {
  if (!c.mayMoney) return null;
  // The Client / Department filters apply to money too (the client's owning department).
  const invWhere = and(invoiceWhere(c.user), c.f.clientId ? { clientId: c.f.clientId } : null,
    c.f.department && c.f.department !== '__none__' ? { client: { is: { ownerDepartment: c.f.department } } } : null);
  // RECEIVED = utils/moneyFacts.js (the same rule as Reports): payment rows,
  // else receivedAmount of a Paid / Partially paid invoice (old imports), on its paid date.
  const MF = require('./moneyFacts'); // eslint-disable-line global-require
  const invs = await prisma.invoice.findMany({
    where: invWhere,
    select: {
      ...MF.INVOICE_SELECT, invoiceNumber: true, amount: true, gst: true, tds: true, dueDate: true, client: { select: { name: true } },
      payments: { select: { id: true, date: true, amount: true, method: true, reference: true } },
    },
  });
  const payById = new Map(invs.flatMap((i) => (i.payments || []).map((p) => [p.id, p])));
  const pays = invs.flatMap((i) => MF.receiptsOf(i).map((r) => {
    const p = payById.get(r.id) || {};
    return { id: r.id, date: r.date, amount: r.amount, method: p.method || (r.from === 'invoice' ? 'Marked paid' : null), reference: p.reference || null, invoiceId: i.id, invoice: { invoiceNumber: i.invoiceNumber, client: i.client } };
  })).sort((x, y) => String(y.date).localeCompare(String(x.date)));
  const live = invs.filter((i) => A.deriveInvoiceStatus(i) !== 'Cancelled');
  const day = (v) => String(v || '').slice(0, 10);
  const within = (v, p) => day(v) >= p.from && day(v) <= p.to;
  const inRange = live.filter((i) => within(i.invoiceDate, c.period));
  const prevInv = live.filter((i) => within(i.invoiceDate, c.prev));
  const paid = pays.filter((p) => within(p.date, c.period));
  const prevPaid = pays.filter((p) => within(p.date, c.prev));
  const pending = live.filter((i) => A.invoiceOutstanding(i) > 0.5);
  const late = pending.filter((i) => i.dueDate && A.daysOverdue(i.dueDate) > 0);
  const invRow = (i) => ({ id: i.id, invoiceNumber: i.invoiceNumber, client: i.client ? i.client.name : '—', invoiceDate: i.invoiceDate, dueDate: i.dueDate, amount: A.ROUND(Number(i.amount || 0)), outstanding: A.invoiceOutstanding(i), status: A.deriveInvoiceStatus(i), daysOverdue: A.daysOverdue(i.dueDate), to: `/invoices/${i.id}` });
  addSet(b, 'money-invoiced', { kind: 'inv', title: `Invoiced ${c.word}`, rows: inRange.map(invRow).sort((x, y) => String(y.invoiceDate).localeCompare(String(x.invoiceDate))) });
  addSet(b, 'money-received', { kind: 'pay', title: `Received ${c.word}`, rows: paid.map((p) => ({ id: p.id, date: p.date, amount: p.amount, method: p.method, reference: p.reference, invoiceId: p.invoiceId, invoiceNumber: p.invoice ? p.invoice.invoiceNumber : null, client: p.invoice && p.invoice.client ? p.invoice.client.name : null, to: `/invoices/${p.invoiceId}` })) });
  addSet(b, 'money-pending', { kind: 'inv', title: 'Pending payments', rows: pending.map(invRow).sort((x, y) => (y.daysOverdue || 0) - (x.daysOverdue || 0)) });
  const sum = (list, f) => A.ROUND(list.reduce((s, x) => s + Number(f(x) || 0), 0));
  const markedPaid = new Set(paid.filter((p) => String(p.id).startsWith('inv:')).map((p) => p.invoiceId)).size;
  const tracked = invs.length > 0;
  const inv = sum(inRange, (i) => i.amount);
  const rec = sum(paid, (p) => p.amount);
  const pend = sum(pending, (i) => A.invoiceOutstanding(i));
  const moneyDelta = (cur, prev) => { const d = delta(c, Math.round(cur), Math.round(prev)); if (d && d.dir !== 'same') d.text = `${d.dir === 'up' ? '▲' : '▼'} ₹${Math.abs(Math.round(cur - prev)).toLocaleString('en-IN')} vs ${c.prevWord}`; return d; };
  return {
    id: 'money', type: 'money', size: 'narrow', title: 'Money',
    rows: [
      { id: 'invoiced', label: `Invoiced ${c.word}`, value: inv, money: true, drill: 'money-invoiced', delta: moneyDelta(inv, sum(prevInv, (i) => i.amount)), zero: tracked ? `No invoices ${c.word}` : 'Not tracked yet' },
      { id: 'received', label: `Received ${c.word}`, value: rec, money: true, drill: 'money-received', delta: moneyDelta(rec, sum(prevPaid, (p) => p.amount)), zero: tracked ? `Nothing received ${c.word}` : 'Not tracked yet', sub: markedPaid ? `Includes ${plural(markedPaid, 'invoice', 'invoices')} marked paid without a payment entry` : null },
      { id: 'pending', label: 'Pending', value: pend, money: true, drill: 'money-pending', sub: late.length ? `${plural(late.length, 'invoice', 'invoices')} past due` : null, tone: late.length ? 'red' : null, zero: tracked ? 'Nothing pending' : 'Not tracked yet' },
    ],
  };
}

// Integration / system errors — the Admin health dot (top bar) and the Admin board.
async function healthRows() {
  const since30 = new Date(Date.now() - 30 * DAY);
  const [integrations, syncFailed, portalFailed] = await Promise.all([
    prisma.integration.findMany({ select: { id: true, recordsFailed: true, state: true, error: true } }),
    prisma.syncLog.count({ where: { status: 'Failed', createdAt: { gte: since30 } } }),
    prisma.requirement.findMany({ where: { portalSyncStatus: 'Failed' }, select: { id: true, title: true, reqCode: true } }),
  ]);
  const intFailed = integrations.filter((i) => i.recordsFailed > 0 || /reconnect|expired/i.test(i.state) || i.error);
  const rows = [
    ...intFailed.map((i) => ({ id: `int-${i.id}`, what: `Integration: ${i.id}`, detail: i.error || i.state || `${fmtN(i.recordsFailed)} records failed`, to: '/admin/integrations' })),
    ...(syncFailed ? [{ id: 'sync', what: 'Sync failures (last 30 days)', detail: plural(syncFailed, 'failed sync', 'failed syncs'), to: '/admin/integrations' }] : []),
    ...portalFailed.map((r) => ({ id: `job-${r.id}`, what: `Job did not post: ${r.title || r.reqCode || 'job'}`, detail: 'Job portal posting failed', to: `/requirements/${r.id}` })),
  ];
  // One problem per failing thing, not one per failed record.
  return { problems: intFailed.length + (syncFailed ? 1 : 0) + portalFailed.length, rows };
}

// Departments (review #2: max 5 columns — Open jobs, Active, Late, Selected,
// Joined). Shown in the "All departments" view only (deptsWidget — user,
// 2026-10-05: a picked department shows ONLY that department); the rows are
// every department in the login's area, the counts follow the other filters.
function departmentsTable(c, b, k) {
  const { w, all, inAts } = k;
  const nd = all.filter((x) => rowMatches(x, c.f, ['department']));
  const ndReqs = w.reqs.filter((r) => reqMatches(w, r, c.f, ['department']));
  const t = new Map();
  const METRICS = ['openJobs', 'active', 'interviews', 'late', 'selected', 'joined'];
  const row = (d) => {
    const key = d || '';
    if (!t.has(key)) t.set(key, { department: key || null, ...Object.fromEntries(METRICS.map((m) => [m, []])) });
    return t.get(key);
  };
  w.reqs.forEach((r) => { if (r.department) row(r.department); });
  ndReqs.filter(isLiveReq).forEach((r) => { row(r.department).openJobs.push(r.id); });
  nd.forEach((x) => {
    const dep = (x.a.requirement && x.a.requirement.department) || '';
    if (!x.pre && !NOT_ACTIVE.includes(x.a.stage)) row(dep).active.push(x.a.id);
    if (!x.pre && x.a.interviewAt && liveInterview(x.a) && inPeriod(msOf(x.a.interviewAt), c.period)) row(dep).interviews.push(x.a.id);
    if (x.live && inAts(x)) {
      if (x.na.dueStatus === 'overdue') row(dep).late.push(x.a.id);
      if (SELECTED_NOT_JOINED.includes(x.a.stage)) row(dep).selected.push(x.a.id);
    }
    if (joinedSince(x.a, c.period.from, c.period.to)) row(dep).joined.push(x.a.id);
  });
  const TITLE = { openJobs: 'Open jobs', active: 'People in process', interviews: `Interviews ${c.word}`, late: 'Late', selected: 'Selected, not joined', joined: `Joined ${c.word}` };
  const out = [...t.values()]
    .filter((r) => !isTest(r.department))
    .filter((r) => r.department || METRICS.some((m) => r[m].length))
    .sort((x, y) => (!x.department) - (!y.department) || y.active.length - x.active.length || String(x.department).localeCompare(String(y.department)))
    .map((r, i) => {
      const name = r.department || 'No department';
      const drills = {};
      METRICS.forEach((m) => {
        drills[m] = addSet(b, `dept-${i}-${m}`, { kind: m === 'openJobs' ? 'req' : 'app', title: `${name} — ${TITLE[m]}`, ids: r[m], extra: m === 'late' ? extraOf(r[m].map((id) => w.byId.get(id)).filter(Boolean)) : null });
      });
      return {
        department: r.department, fixNeeded: !r.department, picked: !!c.f.department && c.f.department === (r.department || '__none__'),
        ...Object.fromEntries(METRICS.map((m) => [m, r[m].length])), drills,
      };
    });
  return { id: 'departments', type: 'depts', size: 'full', title: "What's happening in the company", joinedWord: c.word, rows: out };
}

// Per-person waiting / due today / late (Stale left out).
function perPersonLoad(rows, keyOf, b = null, prefix = 'load') {
  const m = new Map();
  rows.forEach((x) => {
    if (x.na.dueStatus === 'stale') return;
    const p = keyOf(x);
    if (!p || !p.key || isTest(p.label)) return;
    const e = m.get(p.key) || { key: p.key, userId: p.userId || null, name: p.label, pending: [], overdue: [], dueToday: [] };
    e.pending.push(x);
    if (x.na.dueStatus === 'overdue') e.overdue.push(x);
    if (x.na.dueStatus === 'due_today') e.dueToday.push(x);
    m.set(p.key, e);
  });
  return [...m.values()].map((e) => {
    const drills = {};
    if (b) {
      [['pending', 'waiting'], ['dueToday', 'due today'], ['overdue', 'late']].forEach(([k, word]) => {
        drills[k] = addSet(b, `${prefix}-${e.key}-${k}`, { kind: 'app', title: `${e.name} — ${word}`, ids: ids(e[k]), extra: extraOf(e[k]) });
      });
    }
    return { key: e.key, userId: e.userId, name: e.name, pending: e.pending.length, overdue: e.overdue.length, dueToday: e.dueToday.length, drills };
  }).sort((x, y) => y.overdue - x.overdue || y.pending - x.pending || String(x.name).localeCompare(String(y.name)));
}
// Top 5 + "View all N recruiters →" (the full table lives in Recruiter & BDE).
function teamSnapshot(c, b, k, { title = 'Team snapshot', who = 'Recruiter', keyOf = (x) => x.who.recruiter } = {}) {
  const rows = perPersonLoad(k.live, keyOf, b, 'team');
  return { id: 'team', type: 'people', size: 'full', title, who, rows: rows.slice(0, 5), total: rows.length, to: '/ats/team', toLabel: `View all ${fmtN(rows.length)} →` };
}

// "Activity not logged" — ONE banner (review #2), not a row per recruiter.
function activityBanner(c, k) {
  const users = NA.snapshot().activeUsers || new Map();
  const worked = new Map();
  const moved = new Set();
  k.sel.forEach((x) => {
    const r = x.who.recruiter;
    if (r && r.key && !isTest(r.label) && (inPeriod(msOf(x.a.createdAt), c.period) || (x.a.interviewAt && inPeriod(msOf(x.a.interviewAt), c.period)))) worked.set(r.key, r.label);
    x.evs.forEach((e) => { if (e.from && e.actor && e.from !== e.to && inPeriod(e.at, c.period) && users.has(e.actor)) moved.add(`u:${e.actor}`); });
  });
  const n = [...worked.keys()].filter((key) => !moved.has(key)).length;
  if (!n) return null;
  return { id: 'banner', type: 'banner', size: 'full', text: `${plural(n, 'recruiter', 'recruiters')} worked ${c.word} but moved no step in TeamLink.`, to: '/reports/ats?tab=daily', toLabel: 'See the daily report →' };
}

// Hiring funnel (in the date filter): applications ADDED in the period and
// how far each one got. The imported trackers carry no step history for
// rejected rows, so an interview DATE counts as proof the person was sent
// and interviewed (definitions in `def`).
function funnel(c, b, sel, { title = 'Hiring progress' } = {}) {
  const apps = sel.filter((x) => !x.pre && inPeriod(msOf(x.a.createdAt), c.period));
  const hit = (x, set) => set.includes(x.a.stage) || x.evs.some((e) => set.includes(e.to));
  const interviewed = (x) => !!x.a.interviewAt && liveInterview(x.a);
  const steps = [
    ['Added', () => true, `People added ${c.word}.`],
    ['Sent to client', (x) => hit(x, CLIENT_CHAIN) || interviewed(x), 'Reached "Sent to client" or any later step, or has an interview date.'],
    ['Interview', (x) => hit(x, INTERVIEW_ON) || interviewed(x), 'Has an interview date, or reached "Interview fixed" or later.'],
    ['Selected', (x) => hit(x, SELECTED_ON), 'Reached Selected, Offer, Waiting to join or Joined.'],
    ['Joined', (x) => hit(x, JOINED), 'Joined.'],
  ];
  const n0 = apps.length;
  return {
    id: 'funnel', type: 'funnel', size: 'half', title, period: c.word,
    rows: steps.map(([label, test, def], i) => {
      const list = apps.filter(test);
      const drill = addSet(b, `funnel-${i}`, { kind: 'app', title: `${label} — of people added ${c.word}`, ids: ids(list) });
      return { label, value: list.length, pct: n0 && i ? Math.round((list.length / n0) * 100) : null, drill, def };
    }),
    zero: `Nobody added ${c.word}`,
  };
}

// Joinings — last 6 months (a line).
function joinTrend(c, b, sel) {
  const [y, m] = c.today.split('-').map(Number);
  const months = Array.from({ length: 6 }, (_, i) => {
    const d0 = new Date(Date.UTC(y, m - 6 + i, 1));
    const from = d0.toISOString().slice(0, 10);
    const to = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    return { from, to, label: d0.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' }) };
  });
  return {
    id: 'joinTrend', type: 'line', size: 'half', title: 'Joinings — last 6 months',
    points: months.map((mo, i) => {
      const list = sel.filter((x) => joinedSince(x.a, mo.from, mo.to));
      return { label: mo.label, value: list.length, drill: addSet(b, `joins-${i}`, { kind: 'app', title: `Joined in ${mo.label}`, ids: ids(list) }) };
    }),
  };
}

// A short list widget: the top 5 rows + "See all N".
function listWidget(b, id, title, list, { size = 'half', zero, setId, setTitle, row } = {}) {
  const sid = addSet(b, setId || `w-${id}`, { kind: 'app', title: setTitle || title, ids: ids(list), extra: extraOf(list.filter((x) => x.na)) });
  return {
    id, type: 'list', size, title, total: list.length, drill: sid, zero,
    rows: list.slice(0, 5).map((x) => (row ? row(x) : workRow(x))),
  };
}

// "N candidates not followed up yet" — the follow-ups agent's rule
// (utils/followupVisibility.js notFollowedUpSummary), on the same rows.
async function notFollowed(c, b, sel) {
  // eslint-disable-next-line global-require
  const FV = require('./followupVisibility');
  const snap = NA.snapshot();
  const [idx, rules] = await Promise.all([FV.contactIndex(snap.stamp), FV.loadRules()]);
  const seen = new Set();
  const pick = [];
  sel.forEach((x) => {
    const { a } = x;
    if (!x.live || a.stage === 'HOLD' || x.pre || seen.has(a.candidateId)) return;
    const fu = snap.openFu.get(a.id) || null;
    const st = FV.contactStatus({
      stage: a.stage, contact: FV.lastContactOf(idx, a.id, a.candidateId), followUpDue: fu && fu.dueDate, rules,
      enteredAt: NA.stageEnteredAt(a, snap), interviewAt: a.interviewAt, joiningDate: a.joiningDate, today: c.today,
    });
    if (st.contactBadge && st.contactBadge.key === 'not_followed') { seen.add(a.candidateId); pick.push({ x, why: st.contactBadge.why }); }
  });
  addSet(b, 'not-followed', { kind: 'app', title: 'Candidates not followed up yet', ids: pick.map((p) => p.x.a.id), extra: new Map(pick.map((p) => [p.x.a.id, { note: p.why || 'Not followed up', tone: 'amber' }])) });
  return pick.length;
}

const workRow = (x) => ({
  id: x.a.id, candidateId: x.a.candidateId, candidate: x.cand, requirementId: x.a.requirementId,
  requirement: x.a.requirement ? x.a.requirement.title : '—',
  client: x.internal ? 'TeamLink Internal' : (x.a.requirement && x.a.requirement.client ? x.a.requirement.client.name : null),
  step: stepWord(x.a.stage), action: x.na ? x.na.action : null, ...(x.na ? dueExtra(x.na) : {}),
  at: x.a.interviewAt || null,
});

async function targetFor(user, month) {
  if (!user.employeeId) return { joinings: null };
  const rows = await prisma.employeeRecord.findMany({ where: { type: 'TARGET', employeeId: user.employeeId, date: { startsWith: month } }, select: { title: true, unit: true, amount: true } });
  const hit = rows.filter((r) => /join|placement|hire/i.test(`${r.unit || ''} ${r.title || ''}`));
  return { joinings: hit.length ? hit.reduce((n, r) => n + (Number(r.amount) || 0), 0) : null };
}

// ===========================================================================
// THE BUILDERS — one widget list per role (review #2: a widget registry +
// role config, max 5 widgets after the numbers; the browser draws each type
// from one registry, components/dashboard/AtsHome.jsx).
// ===========================================================================
// ATS_HOME_PROFILE=1 logs where the time goes.
const profiler = () => { const t0 = Date.now(); let t = t0; const marks = []; return { mark: (n) => { const now = Date.now(); marks.push(`${n} ${now - t}`); t = now; }, done: (who) => { if (process.env.ATS_HOME_PROFILE) console.log(`[atsHome] ${who} ${Date.now() - t0} ms: ${marks.join(' · ')}`); } }; }; // eslint-disable-line no-console
const SCOPE_CHIP = { recruiter: 'Me', hr: 'Me', bde: 'My clients', tl: 'My team', stl: 'My team', asstmanager: 'My team', manager: 'My team', superadmin: 'All', admin: 'All' };

async function buildHome(user, req) {
  const P = profiler();
  const c = await context(user, req);
  P.mark('context');
  // ?fresh=1 right after a bulk action: read the rows again, now.
  const w = await worldFor(user, { fresh: !!(req && req.query && req.query.fresh === '1') });
  P.mark('world');
  const b = newBoard(c.layout);
  b.world = w;
  b.clientDesk = c.clientDesk;
  b.scopeChip = SCOPE_CHIP[c.layout] || 'Me';
  b.department = c.dept ? (c.dept === '__none__' ? 'No department' : c.dept) : null;
  b.period = { from: c.period.from, to: c.period.to, key: c.period.key, word: c.word, prevWord: c.prevWord, noPrev: !!c.noPrev };
  b.periods = PERIODS.map((k) => ({ id: k, label: { today: 'Today', this_week: 'This week', this_month: 'This month' }[k] }));
  b.today = c.today;
  b.asOf = new Date(w.builtAt).toISOString();
  const inAts = (x) => c.screening || !x.pre;
  const all = w.rows.filter((x) => !isTest(x.cand));
  const sel = all.filter((x) => rowMatches(x, c.f)); // filtered, every stage
  const base = all.filter((x) => x.live && inAts(x)); // role scope, live
  const rows = base.filter((x) => rowMatches(x, c.f)); // filtered, live
  const live = rows.filter((x) => x.na.dueStatus !== 'stale');
  b.filters = c.f;
  b.filterOptions = filterOptions(c, base);
  b.filtersHidden = HIDDEN_FILTERS[c.layout] || [];
  const reqs = w.reqs.filter((r) => reqMatches(w, r, c.f));
  const openJobs = reqs.filter(isLiveReq);
  const people = sel.filter((x) => !x.pre && !NOT_ACTIVE.includes(x.a.stage));
  const interviewsIn = (p) => sel.filter((x) => !x.pre && x.a.interviewAt && liveInterview(x.a) && inPeriod(msOf(x.a.interviewAt), p))
    .sort((x, y) => msOf(x.a.interviewAt) - msOf(y.a.interviewAt));
  const interviews = interviewsIn(c.period);
  const joined = sel.filter((x) => joinedSince(x.a, c.period.from, c.period.to));
  const joinedPrev = sel.filter((x) => joinedSince(x.a, c.prev.from, c.prev.to)).length;
  const selected = rows.filter(({ a }) => SELECTED_NOT_JOINED.includes(a.stage));
  const everTracked = sel.some((x) => x.a.interviewAt);
  addSet(b, 'interviews', { kind: 'app', title: `Interviews ${c.word}`, ids: ids(interviews) });
  addSet(b, 'open-jobs', { kind: 'req', title: 'Open jobs', ids: openJobs.map((r) => r.id) });
  addSet(b, 'people', { kind: 'app', title: 'People in process', ids: ids(people), extra: extraOf(people.filter((x) => x.na)) });
  addSet(b, 'selected', { kind: 'app', title: 'Selected — not joined yet', ids: ids(selected), extra: extraOf(selected) });
  addSet(b, 'joined', { kind: 'app', title: `Joined ${c.word}`, ids: ids(joined) });
  // "New" / "added" never count a bulk import's own rows (they are not work).
  const bulk = NA.snapshot().bulkDays || new Set();
  const real = (v) => !bulk.has(NA.istDay(v));
  const newJobs = (p) => reqs.filter((r) => inPeriod(msOf(r.createdAt), p) && real(r.createdAt)).length;
  const added = (p) => sel.filter((x) => !x.pre && inPeriod(msOf(x.a.createdAt), p) && real(x.a.createdAt)).length;
  const selectedIn = (p) => sel.filter((x) => x.evs.some((e) => SELECTED_ON.includes(e.to) && !(e.from && SELECTED_ON.includes(e.from)) && inPeriod(e.at, p) && real(e.at))).length;
  const T = {
    openJobs: (label = 'Open jobs') => tile('open-jobs', label, openJobs.length, 'now', { drill: 'open-jobs', sub: newJobs(c.period) ? `${fmtN(newJobs(c.period))} new ${c.word}` : null, delta: delta(c, newJobs(c.period), newJobs(c.prev)), zero: 'No open jobs' }),
    people: (label = 'In process') => tile('people', label, people.length, 'now', { drill: 'people', sub: added(c.period) ? `${fmtN(added(c.period))} added ${c.word}` : null, delta: delta(c, added(c.period), added(c.prev)), zero: 'Nobody in process' }),
    interviews: (label = `Interviews ${c.word}`) => tile('interviews', label, interviews.length, 'range', { drill: 'interviews', delta: delta(c, interviews.length, interviewsIn(c.prev).length), zero: everTracked ? 'No interviews scheduled' : 'Not tracked yet' }),
    selected: (label = 'Selected, not joined') => tile('selected', label, selected.length, 'now', { drill: 'selected', sub: selectedIn(c.period) ? `${fmtN(selectedIn(c.period))} selected ${c.word}` : null, delta: delta(c, selectedIn(c.period), selectedIn(c.prev)), zero: 'Nobody waiting to join' }),
    joined: (label = `Joined ${c.word}`) => tile('joined', label, joined.length, 'range', { drill: 'joined', delta: delta(c, joined.length, joinedPrev), zero: `No joinings ${c.word}` }),
  };

  // Shared problem sets.
  const jobsNoRecruiter = openJobs.filter((r) => !recruiterOf(r));
  const newUnassigned = jobsNoRecruiter.filter((r) => !isBacklogJob(r));
  addSet(b, 'new-unassigned', { kind: 'req', title: 'New jobs without a recruiter (last 30 days)', ids: newUnassigned.map((r) => r.id) });
  const clientDecision = live.filter((x) => CLIENT_DECISION.includes(x.a.stage) && !x.internal);
  addSet(b, 'client-feedback', { kind: 'app', title: 'Client feedback pending', ids: ids(clientDecision), extra: extraOf(clientDecision) });
  const overdueRows = live.filter((x) => x.na.dueStatus === 'overdue');
  addSet(b, 'overdue', { kind: 'app', title: 'Late', ids: ids(overdueRows), extra: extraOf(overdueRows) });
  const reviewWaiting = live.filter(({ a }) => [...REVIEW_STAGES, 'TL_REVIEW'].includes(a.stage));
  addSet(b, 'review-waiting', { kind: 'app', title: 'Waiting for a review (recruiter / team lead)', ids: ids(reviewWaiting), extra: extraOf(reviewWaiting) });
  P.mark('common');

  // Sent to the client in a period: a step move INTO "Sent to client" or later
  // (not a bulk import's own rows) — the v3 Department overview "Submitted".
  const submittedIn = (x, p) => !x.pre && x.evs.some((e) => CLIENT_CHAIN.includes(e.to) && !(e.from && CLIENT_CHAIN.includes(e.from)) && inPeriod(e.at, p) && real(e.at));
  const k = {
    P, w, all, sel, base, rows, live, reqs, openJobs, people, interviews, selected, inAts, T,
    jobsNoRecruiter, newUnassigned, clientDecision, overdueRows, reviewWaiting, submittedIn,
  };
  // Team leads / Open jobs / one job read this request's filters + rows (never sent).
  b.kx = { c, k };
  cleanupSets(c, b, k);
  // The department chooser on top (shown when the login has 2+ departments).
  b.deptChoices = deptChoices(c, k);
  // While the new page is being built, the old one stays the default (?v3=1 opts in).
  if (V3.includes(c.layout) && (V3_DEFAULT ? (req && req.query && req.query.v3) !== '0' : (req && req.query && req.query.v3) === '1')) await v3Home(c, b, k);
  else if (COMPANY.includes(c.layout)) await companyHome(c, b, k);
  else if (c.layout === 'manager' || c.layout === 'asstmanager' || c.layout === 'stl' || c.layout === 'tl') await leadHome(c, b, k);
  else if (c.layout === 'bde') await bdeHome(c, b, k);
  else if (c.layout === 'hr') await hrHome(c, b, k);
  else await recruiterHome(c, b, k);
  P.mark('layout');
  // The follow-ups line: "N candidates not followed up yet" (the role views;
  // the v3 page keeps to its fixed layout — max 6 cards).
  if (!b.v3) {
    try {
      const nf = await notFollowed(c, b, sel);
      b.extras.unshift({ id: 'not-followed', label: nf ? 'candidates not followed up yet' : 'Everyone is followed up', value: nf, drill: nf ? 'not-followed' : null, tone: nf ? 'blue' : 'green' });
    } catch (err) {
      console.error('[atsHome] not-followed line failed:', err.message); // eslint-disable-line no-console
    }
  }
  // The ? on every card: what the number means, in plain words.
  (b.top || []).forEach((t) => { if (!t.help && TILE_HELP[t.id]) t.help = TILE_HELP[t.id]; });
  b.main = b.v3 ? b.main : mainButton(c, b);
  P.mark('followups');
  P.done(c.layout);
  return b;
}

// Needs attention: ranked by impact (red — late — first, then the biggest),
// top 5 only. Normal lines are blue; only urgent work is red.
function topLines(lines, max = 5) {
  const live = lines.filter((l) => l.count > 0).sort((x, y) => ((y.tone === 'red') - (x.tone === 'red')) || y.count - x.count);
  return { lines: live.slice(0, max), more: Math.max(0, live.length - max) };
}

// THE ONE BIG BUTTON (spec §3): what to open first, by role.
function mainButton(c, b) {
  const L = c.layout;
  const att = (b.widgets || []).find((x) => x.type === 'lines' || x.type === 'review');
  if (L === 'recruiter') {
    const t = (b.widgets || []).find((x) => x.type === 'tasks');
    const r = t && t.rows[0];
    return r ? { label: 'Do this now', to: `/candidates/${r.candidateId}` } : null;
  }
  if (L === 'tl' && att && att.type === 'review' && att.total) return { label: 'Check now', drill: att.drill };
  if (['tl', 'stl', 'asstmanager'].includes(L)) {
    const team = (b.widgets || []).find((x) => x.type === 'people');
    const p = team && (team.rows.find((r) => r.overdue) || team.rows.find((r) => r.pending));
    if (p) return { label: L === 'tl' ? 'Open team tasks' : L === 'stl' ? 'Open section' : 'Open team', drill: p.overdue ? p.drills.overdue : p.drills.pending };
  }
  if (L === 'manager') {
    const d = (b.widgets || []).find((x) => x.type === 'depts');
    const slow = d && d.rows.filter((r) => r.late > 0).sort((x, y) => y.late - x.late)[0];
    if (slow) return { label: 'Open slow department', drill: slow.drills.late };
  }
  const first = att && att.type === 'lines' ? att.lines[0] : null;
  if (!first || !first.drill) return null;
  const label = {
    superadmin: 'Open the biggest problem', admin: 'Open the biggest problem', manager: 'Open the biggest problem',
    asstmanager: 'Open team', stl: 'Open section', tl: 'Open team tasks', bde: 'Follow up', hr: 'Review now',
  }[L] || 'Open';
  return { label, drill: first.drill };
}
const kpis = (list) => ({ id: 'kpis', type: 'kpis', size: 'full', tiles: list });

// ---- SIMPLER DASHBOARD (user, 2026-10-05: "simplify the dashboard even more … when a
// department is selected, ONLY that department must open") -----------------------------
// First screen = greeting with the real pending numbers · max 5 cards · Needs
// attention (top 5) · Team snapshot (top 5) · Departments (All view only, and
// only when the login has 2+ departments). Everything else is marked `more`
// and sits in the collapsed "More" section (components/dashboard/AtsHome.jsx).
const moreOf = (list) => list.filter(Boolean).map((x) => ({ ...x, more: true }));
// The Departments table only in the "All departments" view (a picked
// department's numbers are the cards themselves).
function deptsWidget(c, b, k) {
  if (c.f.department) return null;
  const d = departmentsTable(c, b, k);
  return d.rows.length > 1 ? d : null;
}
const TILE_HELP = {
  'open-jobs': 'Jobs open now that still need people.',
  people: 'People on a job right now (not rejected, on hold or joined).',
  interviews: 'Client interviews in the dates you picked.',
  selected: 'People selected or given an offer who have not joined yet.',
  joined: 'People who started work in the dates you picked.',
  'my-review': 'People waiting for a team lead check.',
  overdue: 'Work that is past its due date.',
  clients: 'The clients you look after.',
  submitted: 'People sent to your clients who are still in process.',
  'client-feedback': 'People sent to the client with no reply yet.',
  positions: 'Open jobs inside TeamLink.',
  'to-review': 'People waiting for your check.',
  'iv-internal': 'Interviews for TeamLink jobs today.',
  offers: 'Offers made, waiting for a yes.',
  joining: 'Said yes, waiting for the joining day.',
};
// The sections shown directly under the first screen (user feedback 2026-10-05):
// Today · What's happening (All view) · Team leads · Open jobs. The Team leads
// and Open jobs rows load on their own (homeList "__tls" / "__jobs").
function sectionsOf(c, b, k, dep, { today = true } = {}) {
  return [
    today ? todayWidget(c, b, k) : null,
    dep,
    { id: 'tls', type: 'tls', size: 'full', title: c.layout === 'tl' ? 'My team' : (b.department ? `Team leads in ${b.department}` : 'Team leads'), word: c.word },
    { id: 'openjobs', type: 'openjobs', size: 'full', title: b.department ? `Open jobs in ${b.department}` : 'Open jobs', total: k.openJobs.length, drill: 'open-jobs', steps: STEP5 },
  ].filter(Boolean);
}
// The greeting's numbers ("12 late, 30 client feedback pending"), each opening its list.
function greetingOf(items) {
  return { items: items.filter((x) => x && x.value > 0).map((x) => ({ ...x })), any: items.some((x) => x && x.value > 0) };
}
// The department chooser: the departments in the login's area, with how many
// people are in process there (= the "In process" card once it is picked), or
// the open jobs when nobody is in process yet. Cascades with the other filters.
function deptChoices(c, k) {
  const m = new Map();
  const add = (d, key) => {
    const v = d || '__none__';
    if (isTest(v)) return;
    const e = m.get(v) || { value: v, label: d || 'No department', count: 0, jobs: 0 };
    e[key] += 1;
    m.set(v, e);
  };
  k.all.forEach((x) => {
    if (x.pre || NOT_ACTIVE.includes(x.a.stage) || !rowMatches(x, c.f, ['department'])) return;
    add(x.a.requirement && x.a.requirement.department, 'count');
  });
  k.w.reqs.forEach((r) => { if (isLiveReq(r) && reqMatches(k.w, r, c.f, ['department'])) add(r.department, 'jobs'); });
  const out = [...m.values()].sort((x, y) => (x.value === '__none__') - (y.value === '__none__') || y.count - x.count || y.jobs - x.jobs || String(x.label).localeCompare(String(y.label)));
  if (c.f.department && !m.has(c.f.department)) out.push({ value: c.f.department, label: c.f.department === '__none__' ? 'No department' : c.f.department, count: 0, jobs: 0 });
  return out;
}

// Needs attention (top 5) — Super Admin / Admin / Manager / Asst Manager / STL.
async function attentionWidget(c, b, k, { unsigned: withUnsigned = true } = {}) {
  const { live, openJobs, newUnassigned, clientDecision, overdueRows } = k;
  const fb7 = live.filter(({ a, na, internal }) => (NA.isClientFeedbackPending(a) || (internal && a.stage === 'INTERVIEW_COMPLETED'))
    && (NA.feedbackWait(a, na, c.today).daysWaiting || 0) > 7);
  addSet(b, 'feedback-7', { kind: 'app', title: 'Interview feedback late (7+ days)', ids: ids(fb7), extra: new Map(fb7.map((x) => [x.a.id, { note: `Waiting ${NA.feedbackWait(x.a, x.na, c.today).daysWaiting} days`, tone: 'red', dueKey: x.na.dueStatus }])) });
  const joinStuck = live.filter(({ a, na }) => SELECTED_NOT_JOINED.includes(a.stage) && na.dueStatus === 'overdue');
  addSet(b, 'joining-stuck', { kind: 'app', title: 'Waiting to join — past the date', ids: ids(joinStuck), extra: extraOf(joinStuck) });
  let unsigned = [];
  if (withUnsigned) {
    const clientIds = [...new Set(openJobs.filter((r) => !r.internal && r.clientId).map((r) => r.clientId))];
    const clients = clientIds.length ? await chunked(clientIds, (part) => prisma.client.findMany({ where: and(clientWhere(c.user), { id: { in: part } }), select: { id: true, name: true, agreementStatus: true, bdeOwner: true, status: true } })) : [];
    unsigned = clients.filter((x) => !V.agreementIsSigned(x.agreementStatus) && (x.status || 'Active') === 'Active' && !isTest(x.name));
    const jobsPer = new Map();
    openJobs.forEach((r) => { if (r.clientId) jobsPer.set(r.clientId, (jobsPer.get(r.clientId) || 0) + 1); });
    addSet(b, 'unsigned', { kind: 'client', title: 'Clients with open jobs and no signed agreement', rows: unsigned.map((x) => ({ id: x.id, name: x.name, agreement: V.agreementStatusLabel(x.agreementStatus), owner: x.bdeOwner, openJobs: jobsPer.get(x.id) || 0 })).sort((x, y) => y.openJobs - x.openJobs) });
    // 2026-10-05 (user): the client signed — TeamLink still has to sign & stamp
    // and make it Active.
    const waitingActive = (await prisma.client.findMany({ where: and(clientWhere(c.user), { agreementStatus: 'SIGNED' }), select: { id: true, name: true, agreementStatus: true, bdeOwner: true, status: true, agreementSignedAt: true } }))
      .filter((x) => !isTest(x.name) && (x.status || 'Active') !== 'Archived');
    b.signedWaiting = waitingActive.length;
    addSet(b, 'signed-waiting', { kind: 'client', title: 'Signed agreements waiting to be made Active', rows: waitingActive.map((x) => ({ id: x.id, name: x.name, agreement: `Signed ${x.agreementSignedAt ? new Date(x.agreementSignedAt).toISOString().slice(0, 10) : ''} — waiting`, owner: x.bdeOwner, openJobs: jobsPer.get(x.id) || 0 })) });
  }
  const lines = topLines([
    line('overdue', 'Late', overdueRows.length, { sub: 'past the due date', button: 'Open', drill: 'overdue', tone: 'red' }),
    line('feedback-7', 'Feedback late (7+ days)', fb7.length, { button: 'Chase', drill: 'feedback-7', tone: 'blue' }),
    line('joining-stuck', 'Waiting to join — past the date', joinStuck.length, { button: 'Confirm', drill: 'joining-stuck', tone: 'blue' }),
    line('client-feedback', 'Client feedback pending', clientDecision.length, { button: 'Chase', drill: 'client-feedback', tone: 'blue' }),
    line('new-unassigned', 'New jobs without a recruiter', newUnassigned.length, { sub: 'opened in the last 30 days', button: 'Assign', drill: 'new-unassigned', tone: 'blue' }),
    withUnsigned ? line('unsigned', 'Clients with unsigned agreement', unsigned.length, { button: 'Review', drill: 'unsigned', tone: 'blue' }) : null,
    withUnsigned ? line('signed-waiting', 'Signed agreements waiting to be made Active', b.signedWaiting || 0, { button: 'Make active', drill: 'signed-waiting', tone: 'red' }) : null,
  ].filter(Boolean));
  return { id: 'attention', type: 'lines', size: 'half', title: 'Needs attention', ...lines, empty: 'Nothing needs attention. All caught up 🎉' };
}

// ---- Super Admin / Admin ---------------------------------------------------------------
async function companyHome(c, b, k) {
  const { T, clientDecision, overdueRows } = k;
  b.top = [T.openJobs(), T.people(), T.interviews(), T.selected(), T.joined()];
  b.greeting = greetingOf([
    { id: 'late', label: 'late', value: overdueRows.length, drill: 'overdue', tone: 'red' },
    { id: 'client-feedback', label: 'client feedback pending', value: clientDecision.length, drill: 'client-feedback', tone: 'amber' },
  ]);
  b.moreExtras = true;
  const att = await attentionWidget(c, b, k);
  const team = { ...teamSnapshot(c, b, k), size: 'half' };
  const dep = deptsWidget(c, b, k);
  const happening = sectionsOf(c, b, k, dep);
  if (c.layout === 'superadmin') {
    const money = await memoPanel('money', c, b, moneyPanel);
    b.widgets = [
      kpis(b.top), att, team, ...happening,
      ...moreOf([money && { ...money, size: 'half' }, funnel(c, b, k.sel), joinTrend(c, b, k.sel), activityBanner(c, k)]),
    ].filter(Boolean);
  } else {
    // Admin / Ops — "is the system and data healthy?" (no revenue).
    const h = c.systemAlerts ? await healthRows() : null;
    if (h) addSet(b, 'health', { kind: 'integ', title: 'System problems', rows: h.rows });
    b.widgets = [
      kpis(b.top), att, team, ...happening,
      ...moreOf([{ id: 'cleanup', type: 'cleanup', size: 'half', title: 'Data cleanup', stale: b.cleanup.stale, oldUnassigned: b.cleanup.oldUnassigned, days: b.cleanup.days, to: b.cleanup.to, health: h ? { problems: h.problems, drill: h.problems ? 'health' : null } : null }]),
    ].filter(Boolean);
  }
}

// ===========================================================================
// ATS LAYOUT v3 (user, 2026-10-03 — scratchpad ats-layout-spec-v3.md §1 and
// USER DECISION 4): Super Admin / Admin / Manager / Asst Manager get this
// page, top → bottom:
//   greeting with the real pending numbers + ONE button
//   6 cards (▲▼ vs the period before) · Needs attention (4 red / yellow cards)
//   3 charts: Pipeline funnel · Joinings (6 months) · Rejections by side
//   Department overview · Today's interviews · Team snapshot · Money · Activity
// Every number names a set (`drill`) that /ats/home/list opens — counted by
// this same code, so the number always equals its rows. Colours: green good ·
// yellow pending · red late / rejected · blue in process · grey closed.
// ===========================================================================
const V3 = ['superadmin', 'admin', 'manager', 'asstmanager'];
const V3_DEFAULT = false; // user, 2026-10-03: "dashboard ... previous laaga marchu" — back to the earlier layout (v3 only with ?v3=1)

// THE FUNNEL STEPS (decision 1: the TL check stays). A person counts on a step
// when they reached it OR ANY LATER STEP (now, or in their step history) — so
// the bars never grow downwards. An interview date counts as proof of
// "Interview" (the imported trackers carry no step history).
const FUNNEL_V3 = [
  ['Sourced', [], 'Every person added in the period.'],
  ['Verified', ['RECRUITER_APPROVED', 'TL_REVIEW'], 'The recruiter checked the person and sent them on (to the team lead check or later).'],
  ['TL check', ['WITH_BDE', 'BDE_APPROVED'], 'The team lead approved the person (reached the client manager (BDE) check or later).'],
  ['Shared', ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'CLIENT_SHORTLISTED'], 'Sent to the client, or any later step.'],
  ['Interview', ['INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED'], 'Has an interview date, or reached "Interview fixed" or later.'],
  ['Selected', ['SELECTED', 'OFFER', 'OFFER_ACCEPTED'], 'Reached Selected, Offer, Waiting to join or Joined.'],
  ['Joined', ['JOINED', 'HIRED'], 'Joined.'],
];
const FUNNEL_LEVEL = new Map(FUNNEL_V3.flatMap(([, stages], i) => stages.map((s) => [s, i])));
function funnelLevel(x) {
  let lv = 0;
  const up = (s) => { const v = FUNNEL_LEVEL.get(s); if (v !== undefined && v > lv) lv = v; };
  up(x.a.stage);
  x.evs.forEach((e) => up(e.to));
  if (x.a.interviewAt && liveInterview(x.a) && lv < 4) lv = 4;
  return lv;
}
function funnelV3(c, b, sel) {
  // A bulk import's own rows are not sourcing work (the same rule as "N added").
  const bulk = NA.snapshot().bulkDays || new Set();
  const apps = sel.filter((x) => !x.pre && inPeriod(msOf(x.a.createdAt), c.period) && !bulk.has(NA.istDay(x.a.createdAt)));
  const lv = new Map(apps.map((x) => [x.a.id, funnelLevel(x)]));
  const n0 = apps.length;
  return {
    id: 'funnel', type: 'funnel3', size: 'third', title: 'Pipeline funnel', period: c.word,
    note: `People added ${c.word} (not bulk imports) and how far each one got`,
    rows: FUNNEL_V3.map(([label, , def], i) => {
      const list = apps.filter((x) => lv.get(x.a.id) >= i);
      const drill = addSet(b, `funnel-${i}`, { kind: 'app', title: `${label} — of people added ${c.word}`, ids: ids(list), extra: extraOf(list.filter((x) => x.na)) });
      return { label, value: list.length, pct: n0 && i ? Math.round((list.length / n0) * 100) : null, drill, def };
    }),
    zero: `Nobody added ${c.word}`,
  };
}

// WHOSE DECISION A REJECTION WAS (the donut). The reject popup saves the side
// (Client / Candidate / TeamLink) and the person's role; a TeamLink rejection
// with no role saved goes to the owner of the step it was rejected at.
const REJ_SIDE_ORDER = ['Recruiter', 'TL', 'BDE', 'Client', 'Candidate', 'Not recorded'];
const STEP_OWNER = (stage) => {
  if (stage === 'TL_REVIEW') return 'TL';
  if (['WITH_BDE', 'BDE_APPROVED', ...CLIENT_CHAIN].includes(stage)) return 'BDE';
  return 'Recruiter';
};
function rejectionSide(x) {
  const e = [...x.evs].reverse().find((v) => v.to === 'REJECTED');
  if (!e || !e.side) return 'Not recorded';
  if (e.side === 'Client' || e.side === 'Candidate') return e.side;
  const r = String(e.role || '').toUpperCase();
  if (/RECRUITER/.test(r)) return 'Recruiter';
  if (/^(S?TL|TEAM ?LEAD|SENIOR TL)/.test(r)) return 'TL';
  if (/BDE|CLIENT MANAGER/.test(r)) return 'BDE';
  return STEP_OWNER(e.from);
}
function rejectedAt(x) {
  const e = [...x.evs].reverse().find((v) => v.to === 'REJECTED');
  return e ? e.at : msOf(x.a.updatedAt);
}
function rejectionDonut(c, b, sel) {
  // A bulk import's rejected rows are old history, not decisions made in the period.
  const bulk = NA.snapshot().bulkDays || new Set();
  const list = sel.filter((x) => { if (x.pre || x.a.stage !== 'REJECTED') return false; const at = rejectedAt(x); return inPeriod(at, c.period) && !bulk.has(NA.istDay(at)); });
  const by = new Map(REJ_SIDE_ORDER.map((s) => [s, []]));
  list.forEach((x) => by.get(rejectionSide(x)).push(x));
  return {
    id: 'rejections', type: 'donut', size: 'half', title: 'Rejections — whose decision', period: c.word,
    total: list.length,
    totalDrill: addSet(b, 'rej-all', { kind: 'app', title: `Rejected ${c.word}`, ids: ids(list) }),
    slices: REJ_SIDE_ORDER.map((side) => {
      const rowsOf = by.get(side);
      return { label: side === 'TL' ? 'Team lead' : side === 'BDE' ? 'Client manager (BDE)' : side, key: side, value: rowsOf.length, tone: side === 'Not recorded' ? 'grey' : null, drill: addSet(b, `rej-${side}`, { kind: 'app', title: `Rejected ${c.word} — ${side}`, ids: ids(rowsOf) }) };
    }).filter((s) => s.value > 0),
    zero: `Nobody rejected ${c.word}`,
  };
}

// DEPARTMENT OVERVIEW (v3): Open · Submitted · Interviews · Selected · Joined ·
// Late. The rows are every department in the login's area; the counts follow
// every filter but the department one, and each column means exactly what
// its card means (Submitted = sent to the client in the period).
function departmentsV3(c, b, k) {
  const { w, all, inAts } = k;
  const nd = all.filter((x) => rowMatches(x, c.f, ['department']));
  const ndReqs = w.reqs.filter((r) => reqMatches(w, r, c.f, ['department']));
  const METRICS = ['openJobs', 'submitted', 'interviews', 'selected', 'joined', 'late'];
  const t = new Map();
  const row = (d) => {
    const key = d || '';
    if (!t.has(key)) t.set(key, { department: key || null, ...Object.fromEntries(METRICS.map((m) => [m, []])) });
    return t.get(key);
  };
  w.reqs.forEach((r) => { if (r.department) row(r.department); });
  ndReqs.filter(isLiveReq).forEach((r) => { row(r.department).openJobs.push(r.id); });
  nd.forEach((x) => {
    const dep = (x.a.requirement && x.a.requirement.department) || '';
    if (k.submittedIn(x, c.period)) row(dep).submitted.push(x.a.id);
    if (!x.pre && x.a.interviewAt && liveInterview(x.a) && inPeriod(msOf(x.a.interviewAt), c.period)) row(dep).interviews.push(x.a.id);
    if (x.live && inAts(x)) {
      if (x.na.dueStatus === 'overdue') row(dep).late.push(x.a.id);
      if (SELECTED_NOT_JOINED.includes(x.a.stage)) row(dep).selected.push(x.a.id);
    }
    if (joinedSince(x.a, c.period.from, c.period.to)) row(dep).joined.push(x.a.id);
  });
  const TITLE = { openJobs: 'Open jobs', submitted: `Sent to client ${c.word}`, interviews: `Interviews ${c.word}`, selected: 'Selected, not joined', joined: `Joined ${c.word}`, late: 'Late' };
  const out = [...t.values()]
    .filter((r) => !isTest(r.department))
    .filter((r) => r.department || METRICS.some((m) => r[m].length))
    .sort((x, y) => (!x.department) - (!y.department) || y.openJobs.length - x.openJobs.length || String(x.department).localeCompare(String(y.department)))
    .map((r, i) => {
      const name = r.department || 'No department';
      const drills = {};
      METRICS.forEach((m) => {
        drills[m] = addSet(b, `dept-${i}-${m}`, { kind: m === 'openJobs' ? 'req' : 'app', title: `${name} — ${TITLE[m]}`, ids: r[m], extra: ['late', 'selected'].includes(m) ? extraOf(r[m].map((id) => w.byId.get(id)).filter(Boolean)) : null });
      });
      return {
        department: r.department, fixNeeded: !r.department, picked: !!c.f.department && c.f.department === (r.department || '__none__'),
        ...Object.fromEntries(METRICS.map((m) => [m, r[m].length])), drills,
      };
    });
  const max = Object.fromEntries(METRICS.map((m) => [m, Math.max(0, ...out.map((r) => r[m]))]));
  return {
    id: 'departments', type: 'depts3', size: 'full', title: 'Department overview', word: c.word,
    columns: METRICS.map((m) => ({ key: m, label: { openJobs: 'Open', submitted: 'Submitted', interviews: 'Interviews', selected: 'Selected', joined: 'Joined', late: 'Late' }[m], hint: TITLE[m], tone: m === 'late' ? 'red' : m === 'joined' ? 'green' : m === 'selected' ? 'yellow' : 'blue' })),
    max, rows: out,
  };
}

// TODAY'S INTERVIEWS (always today, whatever the date filter): time,
// candidate, client, round.
function todaysInterviews(c, b, sel) {
  const list = sel.filter((x) => !x.pre && x.a.interviewAt && liveInterview(x.a) && inDay(msOf(x.a.interviewAt), c.today))
    .sort((x, y) => msOf(x.a.interviewAt) - msOf(y.a.interviewAt));
  const drill = addSet(b, 'iv-today', { kind: 'app', title: 'Interviews today', ids: ids(list) });
  return {
    id: 'iv-today', type: 'interviews', size: 'half', title: "Today's interviews", total: list.length, drill,
    zero: 'No interviews today',
    rows: list.slice(0, 6).map((x) => ({
      id: x.a.id, candidateId: x.a.candidateId, candidate: x.cand, at: x.a.interviewAt,
      client: x.internal ? 'TeamLink Internal' : (x.a.requirement && x.a.requirement.client ? x.a.requirement.client.name : null),
      job: x.a.requirement ? x.a.requirement.title : null,
      round: Number(x.a.interviewRound) || 1, mode: x.a.interviewMode || null,
      done: x.a.stage !== 'INTERVIEW_SCHEDULED' || ['COMPLETED', 'PENDING_FEEDBACK'].includes(x.a.interviewStatus),
    })),
  };
}

// TEAM SNAPSHOT (v3): recruiters AND client managers (BDE) — Waiting, Due
// today, Late (Not-moving rows left out) and an "on time" bar
// (= waiting that is not late). Top 5 of each + "View all".
function teamV3(c, b, k) {
  const pack = (keyOf, role, prefix) => perPersonLoad(k.live, keyOf, b, prefix).map((r) => ({
    ...r, role, onTime: r.pending ? Math.round(((r.pending - r.overdue) / r.pending) * 100) : 100,
  }));
  const recs = pack((x) => x.who.recruiter, 'Recruiter', 'team');
  const bdes = pack((x) => x.who.bde, 'Client manager (BDE)', 'teamb');
  return {
    id: 'team', type: 'team', size: 'half', title: 'Team snapshot',
    groups: [
      { id: 'rec', title: 'Recruiters', total: recs.length, rows: recs.slice(0, 5) },
      { id: 'bde', title: 'Client managers (BDE)', total: bdes.length, rows: bdes.slice(0, 5) },
    ].filter((g) => g.total),
    to: '/ats/team', toLabel: `View all ${fmtN(recs.length + bdes.length)} →`,
    zero: 'Nobody has work waiting. All caught up',
  };
}

// RECENT ACTIVITY: "Ravi sent Suresh to Apollo" — real step moves made by a
// person in the period (imports, which carry no person, are left out).
function activityText(e, x) {
  const who = e.actorName;
  const cand = x.cand;
  const client = x.internal ? 'TeamLink Internal' : (x.a.requirement && x.a.requirement.client ? x.a.requirement.client.name : 'the client');
  const job = x.a.requirement ? x.a.requirement.title : 'the job';
  switch (e.to) {
    case 'SHARED_WITH_CLIENT': case 'CLIENT_REVIEW': return { text: `${who} sent ${cand} to ${client}`, tone: 'blue' };
    case 'CLIENT_SHORTLISTED': return { text: `${client} shortlisted ${cand} (${who})`, tone: 'blue' };
    case 'INTERVIEW_SCHEDULED': return { text: `${who} fixed an interview for ${cand} at ${client}`, tone: 'blue' };
    case 'INTERVIEW_COMPLETED': return { text: `${cand} finished the interview at ${client}`, tone: 'blue' };
    case 'SELECTED': case 'OFFER': return { text: `${cand} was selected at ${client} (${who})`, tone: 'green' };
    case 'OFFER_ACCEPTED': return { text: `${cand} accepted the offer from ${client}`, tone: 'green' };
    case 'JOINED': case 'HIRED': return { text: `${cand} joined ${client}`, tone: 'green' };
    case 'REJECTED': return { text: `${who} rejected ${cand} for ${job}`, tone: 'red' };
    case 'HOLD': return { text: `${who} put ${cand} on hold for ${job}`, tone: 'grey' };
    case 'TL_REVIEW': return { text: `${who} verified ${cand} and sent them for the team lead check`, tone: 'blue' };
    case 'WITH_BDE': case 'BDE_APPROVED': return { text: `${who} passed ${cand} to the client manager (BDE)`, tone: 'blue' };
    default: return { text: `${who} moved ${cand} to ${stepWord(e.to)}`, tone: 'blue' };
  }
}
function activityV3(c, b, sel) {
  const ev = [];
  sel.forEach((x) => {
    x.evs.forEach((e, i) => {
      if (!e.from || e.from === e.to || !e.actor || !e.actorName || /^imported\b/i.test(e.actorName) || isTest(e.actorName) || !inPeriod(e.at, c.period)) return;
      ev.push({ x, e, i });
    });
  });
  ev.sort((p, q) => q.e.at - p.e.at);
  const top = ev.slice(0, 500);
  const rows = top.map(({ x, e, i }) => ({
    id: `${x.a.id}:${i}`, candidateId: x.a.candidateId, candidate: x.cand, requirement: x.a.requirement ? x.a.requirement.title : '—',
    from: stepWord(e.from), to: stepWord(e.to), at: new Date(e.at).toISOString(), by: e.actorName,
  }));
  const drill = addSet(b, 'activity', { kind: 'event', title: `Recent activity ${c.word}${ev.length > 500 ? ' (latest 500)' : ''}`, rows });
  return {
    id: 'activity', type: 'activity', size: 'full', title: 'Recent activity', total: ev.length, drill,
    zero: `Nobody moved a step ${c.word}`,
    rows: top.slice(0, 8).map(({ x, e, i }) => ({ id: `${x.a.id}:${i}`, candidateId: x.a.candidateId, at: new Date(e.at).toISOString(), ...activityText(e, x) })),
  };
}

async function v3Home(c, b, k) {
  const { live, openJobs, T, clientDecision, overdueRows } = k;
  // Needs attention — the same rows the old Super Admin board used.
  const fb7 = live.filter(({ a, na, internal }) => (NA.isClientFeedbackPending(a) || (internal && a.stage === 'INTERVIEW_COMPLETED'))
    && (NA.feedbackWait(a, na, c.today).daysWaiting || 0) > 7);
  addSet(b, 'feedback-7', { kind: 'app', title: 'Interview feedback late (7+ days)', ids: ids(fb7), extra: new Map(fb7.map((x) => [x.a.id, { note: `Waiting ${NA.feedbackWait(x.a, x.na, c.today).daysWaiting} days`, tone: 'red', dueKey: x.na.dueStatus }])) });
  const clientIds = [...new Set(openJobs.filter((r) => !r.internal && r.clientId).map((r) => r.clientId))];
  const clients = clientIds.length ? await chunked(clientIds, (part) => prisma.client.findMany({ where: and(clientWhere(c.user), { id: { in: part } }), select: { id: true, name: true, agreementStatus: true, bdeOwner: true, status: true } })) : [];
  const unsigned = clients.filter((x) => !V.agreementIsSigned(x.agreementStatus) && (x.status || 'Active') === 'Active' && !isTest(x.name));
  const jobsPer = new Map();
  openJobs.forEach((r) => { if (r.clientId) jobsPer.set(r.clientId, (jobsPer.get(r.clientId) || 0) + 1); });
  addSet(b, 'unsigned', { kind: 'client', title: 'Clients with open jobs and no signed agreement', rows: unsigned.map((x) => ({ id: x.id, name: x.name, agreement: V.agreementStatusLabel(x.agreementStatus), owner: x.bdeOwner, openJobs: jobsPer.get(x.id) || 0 })).sort((x, y) => y.openJobs - x.openJobs) });

  // The 6 cards. "Late" ▲▼: how many went late in this period vs the one
  // before (among the rows that are late now — a lower arrow is better).
  const wentLate = (p) => overdueRows.filter((x) => { if (!x.na.dueAt) return false; const d = addDays(String(x.na.dueAt).slice(0, 10), 1); return d >= p.from && d <= p.to; }).length;
  const lateTile = tile('overdue', 'Late', overdueRows.length, 'now', {
    drill: 'overdue', tone: overdueRows.length ? 'red' : 'green', delta: delta(c, wentLate(c.period), wentLate(c.prev)),
    sub: wentLate(c.period) ? `${fmtN(wentLate(c.period))} went late ${c.word}` : null, zero: 'Nothing is late', goodWhen: 'down',
  });
  const tone = (t, tn) => ({ ...t, tone: tn });
  b.top = [
    tone(T.openJobs(), 'blue'), tone(T.people(), 'blue'), tone(T.interviews(), 'blue'),
    tone(T.selected(), 'yellow'), tone(T.joined(), 'green'), lateTile,
  ];
  b.top.forEach((t) => { if (!t.goodWhen) t.goodWhen = 'up'; });

  const attention = {
    id: 'attention', type: 'alerts', size: 'full', title: 'Needs attention',
    cards: [
      { id: 'overdue', label: 'Late', hint: 'Past the due date of their step', value: overdueRows.length, tone: 'red', drill: 'overdue', button: 'Open', zero: 'Nothing is late' },
      { id: 'feedback-7', label: 'Feedback late', hint: 'Interview done 7+ days ago, no feedback yet', value: fb7.length, tone: 'red', drill: 'feedback-7', button: 'Chase', zero: 'No late feedback' },
      { id: 'unsigned', label: 'Unsigned agreement', hint: 'Clients with open jobs and no signed agreement', value: unsigned.length, tone: 'yellow', drill: 'unsigned', button: 'Review', zero: 'All agreements signed' },
      { id: 'client-feedback', label: 'Client feedback pending', hint: 'Sent to the client, no reply yet', value: clientDecision.length, tone: 'yellow', drill: 'client-feedback', button: 'Chase', zero: 'No feedback pending' },
    ],
  };
  // The greeting line: the real pending numbers ("19 late, 77 feedback
  // pending" = the Late and Feedback late cards) + one button.
  b.greeting = {
    late: overdueRows.length, lateDrill: overdueRows.length ? 'overdue' : null,
    feedback: fb7.length, feedbackDrill: fb7.length ? 'feedback-7' : null,
  };
  b.main = overdueRows.length ? { label: 'Open late work', drill: 'overdue' }
    : fb7.length ? { label: 'Chase feedback', drill: 'feedback-7' }
      : clientDecision.length ? { label: 'Chase client feedback', drill: 'client-feedback' } : null;

  const money = COMPANY.includes(c.layout) && c.mayMoney ? await memoPanel('money', c, b, moneyPanel) : null;
  b.widgets = [
    kpis(b.top), attention,
    funnelV3(c, b, k.sel), { ...joinTrend(c, b, k.sel), type: 'bars', size: 'third' }, { ...rejectionDonut(c, b, k.sel), size: 'third' },
    departmentsV3(c, b, k),
    todaysInterviews(c, b, k.sel), teamV3(c, b, k),
    ...(money ? [{ ...money, type: 'money3', size: 'full' }] : []),
    activityV3(c, b, k.sel),
  ];
  b.v3 = true;
}

// ---- Leads: Manager / Asst Manager / STL / TL — "is my team on target?" ------------------
async function leadHome(c, b, k) {
  const { live, T, rows } = k;
  const L = c.layout;
  const weekP = dateRange.resolve({ range: 'this_week' });
  const weekEnd = addDays(weekP.from, 6);
  const week = k.sel.filter((x) => !x.pre && x.a.interviewAt && liveInterview(x.a) && inPeriod(msOf(x.a.interviewAt), { from: weekP.from, to: weekEnd }))
    .sort((x, y) => msOf(x.a.interviewAt) - msOf(y.a.interviewAt));
  const review = live.filter(({ a }) => (L === 'tl' ? a.stage === 'TL_REVIEW' : [...REVIEW_STAGES, 'TL_REVIEW'].includes(a.stage)))
    .sort((x, y) => String(x.na.dueAt || '9999').localeCompare(String(y.na.dueAt || '9999')));
  addSet(b, 'my-review', { kind: 'app', title: L === 'tl' ? 'Waiting for my check' : 'Waiting for a review', ids: ids(review), extra: extraOf(review) });
  b.top = [
    T.openJobs(), T.people(),
    tile('my-review', L === 'tl' ? 'Waiting for my check' : 'Waiting for a review', review.length, 'now', { drill: 'my-review', zero: 'Nothing to check' }),
    T.interviews(), T.selected(),
  ];
  const workload = { ...teamSnapshot(c, b, k, { title: L === 'tl' ? 'My recruiters' : 'Team snapshot' }), size: 'half' };
  const weekW = listWidget(b, 'week', 'Interviews this week', week, { size: 'half', zero: 'No interviews scheduled this week', setTitle: 'Interviews this week' });
  const fun = funnel(c, b, k.sel, { title: L === 'manager' ? 'My departments — progress' : 'Team progress' });
  if (L === 'tl') {
    // The TL keeps its own short page (user, 2026-10-05).
    b.greeting = greetingOf([
      { id: 'late', label: 'late', value: k.overdueRows.length, drill: 'overdue', tone: 'red' },
      { id: 'my-review', label: 'waiting for your check', value: review.length, drill: 'my-review', tone: 'amber' },
    ]);
    const second = { id: 'review', type: 'review', size: 'full', title: 'Waiting for my check', total: review.length, drill: 'my-review', rows: review.slice(0, 5).map(workRow), empty: 'Nothing is waiting for your check.' };
    b.widgets = [kpis(b.top), second, workload, ...sectionsOf(c, b, k, null, { today: false }), ...moreOf([weekW, fun])];
    return;
  }
  // Manager / Asst Manager / STL: the same short first screen as the Super Admin.
  b.greeting = greetingOf([
    { id: 'late', label: 'late', value: k.overdueRows.length, drill: 'overdue', tone: 'red' },
    { id: 'client-feedback', label: 'client feedback pending', value: k.clientDecision.length, drill: 'client-feedback', tone: 'amber' },
  ]);
  b.moreExtras = true;
  // Clients (agreements) are for Manager / Asst Manager only, not an STL.
  const att = await attentionWidget(c, b, k, { unsigned: L !== 'stl' });
  b.widgets = [kpis(b.top), att, workload, ...sectionsOf(c, b, k, deptsWidget(c, b, k)), ...moreOf([weekW, fun])].filter(Boolean);
  void rows;
}

// ---- Recruiter — "what do I do today?" (a to-do checklist, not charts) --------------------
async function recruiterHome(c, b, k) {
  const { live, sel, openJobs } = k;
  const me = { id: c.user.id, atsRole: c.s.atsRole };
  const mine = live.filter(({ a, na }) => NA.needsActionBy(a, na, me));
  const ORDER = { overdue: 0, due_today: 1, upcoming: 2, no_due: 3 };
  mine.sort((x, y) => (ORDER[x.na.dueStatus] - ORDER[y.na.dueStatus]) || String(x.na.dueAt || '9999').localeCompare(String(y.na.dueAt || '9999')));
  addSet(b, 'my-action', { kind: 'app', title: 'My tasks', ids: ids(mine), extra: extraOf(mine) });
  // My follow-ups due today (calls).
  const fus = await prisma.applicationFollowUp.findMany({
    where: { completedAt: null, ownerUserId: c.user.id, dueDate: { startsWith: c.today } },
    select: { applicationId: true, nextAction: true, purpose: true },
  });
  const fuRows = [...new Map(fus.map((f) => [f.applicationId, f])).values()]
    .map((f) => ({ f, x: k.w.byId.get(f.applicationId) })).filter(({ x }) => x && x.live && rowMatches(x, c.f));
  addSet(b, 'followups-today', { kind: 'app', title: 'My follow-ups due today', ids: fuRows.map(({ x }) => x.a.id) });
  const today = mine.filter((x) => ['overdue', 'due_today'].includes(x.na.dueStatus));
  const taskRows = [
    ...fuRows.map(({ f, x }) => ({ ...workRow(x), kind: 'call', action: f.nextAction || f.purpose || 'Call — follow-up due', tone: 'amber', due: c.today, dueKey: 'due_today' })),
    ...today.map((x) => ({ ...workRow(x), kind: 'step' })),
  ];
  const tasks = { id: 'tasks', type: 'tasks', size: 'full', title: 'My tasks today', total: taskRows.length, drill: 'my-action', more: mine.length, rows: taskRows.slice(0, 8), empty: 'Nothing is due today. 🎉' };
  // My interviews today.
  const ivToday = sel.filter((x) => !x.pre && x.a.interviewAt && liveInterview(x.a) && inDay(msOf(x.a.interviewAt), c.today)).sort((x, y) => msOf(x.a.interviewAt) - msOf(y.a.interviewAt));
  const iv = listWidget(b, 'iv-today', 'My interviews today', ivToday, { zero: 'No interviews today' });
  // Feedback pending.
  const feedback = live.filter(({ a }) => NA.isClientFeedbackPending(a));
  const fb = listWidget(b, 'feedback', 'Feedback pending', feedback, { zero: 'No feedback pending' });
  // My jobs by priority.
  const PRI = { Urgent: 0, High: 1, Medium: 2, Low: 3 };
  const perJob = new Map();
  k.people.forEach((x) => perJob.set(x.a.requirementId, (perJob.get(x.a.requirementId) || []).concat(x)));
  const jobs = [...openJobs].sort((x, y) => ((PRI[x.priority] ?? 2) - (PRI[y.priority] ?? 2)) || ((perJob.get(y.id) || []).length - (perJob.get(x.id) || []).length));
  const jobsW = {
    id: 'jobs', type: 'jobs', size: 'half', title: 'My jobs by priority', total: jobs.length, drill: 'open-jobs', zero: 'No open jobs',
    rows: jobs.slice(0, 5).map((r) => ({
      id: r.id, title: r.title, client: r.internal ? 'TeamLink Internal' : (r.client ? r.client.name : null), priority: r.priority || 'Medium',
      inProcess: (perJob.get(r.id) || []).length, drill: addSet(b, `job-${r.id}`, { kind: 'app', title: `${r.title} — people in process`, ids: ids(perJob.get(r.id) || []) }),
    })),
  };
  // My joins this month vs target.
  const month = c.today.slice(0, 7);
  let myJoinIds = ids(sel.filter((x) => joinedSince(x.a, `${month}-01`, c.today)));
  const tg = await targetFor(c.user, month);
  // Recruiter joinings (utils/recruiterJoinings.js) — the SAME count as the
  // HRMS popup / Recruiter joinings tab, credited to this recruiter, and its
  // target (4 unless Super Admin set another) when no Monthly Target is set.
  try {
    const own = await require('./recruiterJoinings').ownFigure(c.user, month); // eslint-disable-line global-require
    if (own) {
      myJoinIds = own.appIds;
      if (tg.joinings == null) tg.joinings = own.target;
    }
  } catch { /* the dashboard's own count stands */ }
  addSet(b, 'my-joins', { kind: 'app', title: 'My joinings this month', ids: myJoinIds });
  const target = { id: 'target', type: 'target', size: 'half', title: 'My joinings this month', value: myJoinIds.length, target: tg.joinings, drill: 'my-joins', zero: 'No joinings yet this month', noTarget: 'No target set yet' };
  b.top = [];
  b.widgets = [tasks, iv, fb, jobsW, target];
  b.extras.push({ id: 'daily-report', label: 'My daily report', button: true, to: '/reports/my-results' });
}

// ---- BDE — "are my clients happy?" -------------------------------------------------------
async function bdeHome(c, b, k) {
  const { rows, sel, openJobs, T, clientDecision } = k;
  // A picked department: only clients of that department (their own department,
  // or a job of theirs in it) — user, 2026-10-05.
  const wantDept = c.f.department ? (c.f.department === '__none__' ? '' : c.f.department) : null;
  const deptClients = wantDept === null ? null : new Set(k.w.reqs.filter((r) => (r.department || '') === wantDept).map((r) => r.clientId));
  const myClients = (await prisma.client.findMany({ where: clientWhere(c.user), select: { id: true, name: true, agreementStatus: true, status: true, createdAt: true, ownerDepartment: true } })).filter((x) => !isTest(x.name))
    .filter((x) => !c.f.clientId || x.id === c.f.clientId)
    .filter((x) => !deptClients || (x.ownerDepartment || '') === wantDept || deptClients.has(x.id));
  const submitted = rows.filter((x) => CLIENT_CHAIN.includes(x.a.stage) && !x.internal);
  addSet(b, 'submitted', { kind: 'app', title: 'People sent to clients (in process)', ids: ids(submitted), extra: extraOf(submitted) });
  addSet(b, 'my-clients', { kind: 'client', title: 'My clients', rows: myClients.map((x) => ({ id: x.id, name: x.name, agreement: V.agreementStatusLabel(x.agreementStatus) })) });
  b.top = [
    tile('clients', 'My clients', myClients.length, 'now', { drill: 'my-clients', zero: 'No clients yet' }),
    T.openJobs(),
    tile('submitted', 'Sent to client', submitted.length, 'now', { drill: 'submitted', zero: 'Nobody sent yet' }),
    tile('client-feedback', 'Client feedback pending', clientDecision.length, 'now', { drill: 'client-feedback', zero: 'No feedback pending' }),
    T.selected('Selected'),
  ];
  const liveJobClientIds = new Set(openJobs.filter((r) => !r.internal).map((r) => r.clientId));
  const unsigned = myClients.filter((x) => liveJobClientIds.has(x.id) && !V.agreementIsSigned(x.agreementStatus));
  const jobsPer = new Map();
  openJobs.forEach((r) => { if (r.clientId) jobsPer.set(r.clientId, (jobsPer.get(r.clientId) || []).concat(r.id)); });
  addSet(b, 'agreement-pending', { kind: 'client', title: 'Unsigned agreements (clients with open jobs)', rows: unsigned.map((x) => ({ id: x.id, name: x.name, agreement: V.agreementStatusLabel(x.agreementStatus), openJobs: (jobsPer.get(x.id) || []).length })) });
  const fbW = listWidget(b, 'client-fb', 'Client feedback pending', clientDecision.sort((x, y) => String(x.na.dueAt || '').localeCompare(String(y.na.dueAt || ''))), { zero: 'No feedback pending', setId: 'client-feedback-list' });
  const unsignedW = {
    id: 'unsigned', type: 'clients', size: 'half', title: 'Unsigned agreements', total: unsigned.length, drill: 'agreement-pending', zero: 'All agreements are signed',
    rows: unsigned.slice(0, 5).map((x) => ({ id: x.id, name: x.name, sub: V.agreementStatusLabel(x.agreementStatus), to: c.clientDesk ? `/clients/${x.id}` : null })),
  };
  const perClient = myClients.map((x) => ({ id: x.id, name: x.name, jobs: jobsPer.get(x.id) || [] })).filter((x) => x.jobs.length).sort((x, y) => y.jobs.length - x.jobs.length);
  const perW = {
    id: 'per-client', type: 'clients', size: 'half', title: 'Open jobs per client', total: perClient.length, zero: 'No open jobs',
    rows: perClient.slice(0, 5).map((x) => ({ id: x.id, name: x.name, count: x.jobs.length, drill: addSet(b, `cl-${x.id}-jobs`, { kind: 'req', title: `${x.name} — open jobs`, ids: x.jobs }) })),
  };
  const leads = myClients.filter((x) => inPeriod(msOf(x.createdAt), c.period));
  addSet(b, 'new-clients', { kind: 'client', title: `New clients ${c.word}`, rows: leads.map((x) => ({ id: x.id, name: x.name, agreement: V.agreementStatusLabel(x.agreementStatus) })) });
  const leadsW = {
    id: 'leads', type: 'clients', size: 'half', title: `New clients ${c.word}`, total: leads.length, drill: 'new-clients', zero: `No new clients ${c.word}`,
    rows: leads.slice(0, 5).map((x) => ({ id: x.id, name: x.name, sub: V.agreementStatusLabel(x.agreementStatus), to: c.clientDesk ? `/clients/${x.id}` : null })),
  };
  b.widgets = [kpis(b.top), fbW, unsignedW, perW, leadsW];
  void sel;
}

// ---- Internal HR (internal hiring) ------------------------------------------------------------
async function hrHome(c, b, k) {
  const { rows, sel, openJobs } = k;
  const internal = rows.filter((x) => x.internal);
  const liveInt = internal.filter((x) => x.na.dueStatus !== 'stale');
  const positions = openJobs.filter((r) => r.internal || r.hiringType === INTERNAL_HIRE);
  addSet(b, 'positions', { kind: 'req', title: 'Open internal positions', ids: positions.map((r) => r.id) });
  const toReview = liveInt.filter(({ a }) => REVIEW_STAGES.includes(a.stage) || a.stage === 'AI_INTERVIEW_REQUIRED' || a.stage === 'AI_INTERVIEW_SCHEDULED');
  addSet(b, 'to-review', { kind: 'app', title: 'People to check', ids: ids(toReview), extra: extraOf(toReview) });
  const offers = internal.filter(({ a }) => ['SELECTED', 'OFFER'].includes(a.stage));
  addSet(b, 'offers', { kind: 'app', title: 'Offers pending', ids: ids(offers), extra: extraOf(offers) });
  const joining = internal.filter(({ a }) => a.stage === 'OFFER_ACCEPTED');
  addSet(b, 'joining', { kind: 'app', title: 'Waiting to join', ids: ids(joining), extra: extraOf(joining) });
  const ivInt = sel.filter((x) => x.internal && x.a.interviewAt && liveInterview(x.a) && inDay(msOf(x.a.interviewAt), c.today));
  addSet(b, 'iv-internal', { kind: 'app', title: 'Internal interviews today', ids: ids(ivInt) });
  b.top = [
    tile('positions', 'Open positions', positions.length, 'now', { drill: 'positions', zero: 'No open positions' }),
    tile('to-review', 'People to check', toReview.length, 'now', { drill: 'to-review', zero: 'Nobody to check' }),
    tile('iv-internal', 'Interviews today', ivInt.length, 'now', { drill: 'iv-internal', zero: 'No interviews today' }),
    tile('offers', 'Offers pending', offers.length, 'now', { drill: 'offers', zero: 'No offers pending' }),
    tile('joining', 'Waiting to join', joining.length, 'now', { drill: 'joining', zero: 'Nobody waiting to join' }),
  ];
  const att = { id: 'attention', type: 'lines', size: 'half', title: 'Needs attention', ...topLines([
    line('offers', 'Offers pending', offers.length, { button: 'Open', drill: 'offers', tone: 'blue' }),
    line('joining', 'Waiting to join', joining.length, { button: 'Confirm', drill: 'joining', tone: 'blue' }),
  ]), empty: 'Nothing needs attention. All caught up 🎉' };
  const weekEnd = addDays(c.today, 6);
  const thisWeek = internal.filter(({ a }) => { const d = String(a.joiningDate || '').slice(0, 10); return d >= c.today && d <= weekEnd; });
  const jw = listWidget(b, 'joining-week', 'Joining this week', thisWeek, { zero: 'Nobody joins this week' });
  b.widgets = [kpis(b.top), att, jw, funnel(c, b, sel, { title: 'Internal hiring progress' })];
}

// Money is slow to change: one read per login + filters per minute (its lists
// are kept with it, so the numbers still open them).
const PANEL_MEMO = new Map();
async function memoPanel(name, c, b, fn) {
  const key = `${name}|${c.user.id}|${JSON.stringify(c.f)}|${c.period.from}|${c.period.to}`;
  const hit = PANEL_MEMO.get(key);
  if (hit && Date.now() - hit.at < 60000) {
    hit.sets.forEach((v, kk) => b.sets.set(kk, v));
    return hit.panel;
  }
  const before = new Set(b.sets.keys());
  const panel = await fn(c, b);
  const sets = new Map([...b.sets.entries()].filter(([kk]) => !before.has(kk)));
  PANEL_MEMO.set(key, { at: Date.now(), panel, sets });
  if (PANEL_MEMO.size > 60) PANEL_MEMO.delete(PANEL_MEMO.keys().next().value);
  return panel;
}

// The Admin health dot (top bar): problems + where to fix them.
async function healthDot(user) {
  const { can } = require('../middleware/auth'); // eslint-disable-line global-require
  if (!await can(user, null, 'dashboard', 'System Alerts', 'view')) return { show: false };
  const h = await healthRows();
  return { show: true, problems: h.problems, rows: h.rows.slice(0, 8), to: '/admin/integrations' };
}

// ===========================================================================
// WHAT'S HAPPENING (user feedback 2026-10-05 on Company · Education: "when I
// select a department, the TLs should come, the open requirements should
// come; clicking a requirement should show who is handling it; everything
// happening in the whole company should be on the dashboard"). Shown on the
// page, not in More: Today · Departments (All view) · Team leads · Open jobs.
// The Team leads rows, the Open jobs rows and one job's detail load on their
// own through homeList's special sets "__tls", "__jobs" and "__job:<id>",
// from the same board (b.kx = this request's filters + rows), so a number
// and its list are always the same rows.
// ===========================================================================
const STEP5 = ['Added', 'Sent to client', 'Interview', 'Selected', 'Joined'];
// How far a person on a job got (0 Added … 4 Joined): now OR in their history;
// an interview date counts as proof of the interview (old imported trackers).
function stepLevel(x) {
  const hit = (set) => set.includes(x.a.stage) || x.evs.some((e) => set.includes(e.to));
  if (hit(JOINED)) return 4;
  if (hit(SELECTED_ON)) return 3;
  if (hit(INTERVIEW_ON) || (x.a.interviewAt && liveInterview(x.a))) return 2;
  if (hit(CLIENT_CHAIN)) return 1;
  return 0;
}
const stepCounts = (apps) => {
  const s = [0, 0, 0, 0, 0];
  apps.forEach((x) => { const lv = stepLevel(x); for (let i = 0; i <= lv; i += 1) s[i] += 1; });
  return s;
};
const userName = (id) => (id ? (NA.snapshot().activeUsers || new Map()).get(id) || null : null);

// TODAY: what happened today (always today, whatever the date filter), each opening its list.
function todayWidget(c, b, k) {
  const day = { from: c.today, to: c.today };
  const bulk = NA.snapshot().bulkDays || new Set();
  const sel = k.sel.filter((x) => !x.pre);
  const list = [
    ['added', 'Added today', 'People added to a job today (not bulk imports).', sel.filter((x) => inDay(msOf(x.a.createdAt), c.today) && !bulk.has(NA.istDay(x.a.createdAt))), 'blue'],
    ['sent', 'Sent to client today', 'People moved to "Sent to client" today.', sel.filter((x) => k.submittedIn(x, day)), 'blue'],
    ['interviews', 'Interviews today', 'Interviews booked for today.', sel.filter((x) => x.a.interviewAt && liveInterview(x.a) && inDay(msOf(x.a.interviewAt), c.today)), 'blue'],
    ['offers', 'Selected / offer today', 'People selected or given an offer today.', sel.filter((x) => enteredIn(x, SELECTED_NOT_JOINED, day)), 'orange'],
    ['joined', 'Joined today', 'People who joined today.', k.sel.filter((x) => joinedSince(x.a, c.today, c.today)), 'green'],
  ];
  const dept = b.department;
  return {
    id: 'today', type: 'today', size: 'full', title: dept ? `Today in ${dept}` : 'Today in the company',
    items: list.map(([id, label, hint, rows, tone]) => ({
      id, label, hint, tone, value: rows.length,
      drill: addSet(b, `today-${id}`, { kind: 'app', title: label, ids: ids(rows), extra: extraOf(rows.filter((x) => x.na)) }),
    })),
  };
}

// THE OPEN JOBS rows (one per open job = the "Open jobs" card = Jobs › Open
// with the same filters), with the people on each job by step.
function jobsIndex(b) {
  if (b._jobs) return b._jobs;
  const { k } = b.kx;
  const by = new Map();
  k.sel.forEach((x) => {
    if (x.pre) return;
    const id = x.a.requirementId;
    if (!by.has(id)) by.set(id, []);
    by.get(id).push(x);
  });
  b._jobApps = by;
  b._jobs = k.openJobs.map((r) => {
    const apps = by.get(r.id) || [];
    const internal = !!r.internal || r.hiringType === INTERNAL_HIRE;
    const recIds = [...new Set([r.recruiterId, ...String(r.recruiterIds || '').split(',')].map((v) => String(v || '').trim()).filter(Boolean))];
    return {
      id: r.id, reqCode: r.reqCode || null, title: r.title || '—', department: r.department || null, priority: r.priority || null,
      client: internal ? 'TeamLink Internal' : (r.client ? r.client.name : null),
      clientId: b.clientDesk && !internal ? r.clientId || null : null,
      tlId: r.tlId || null, tl: userName(r.tlId) || (typeof r.tl === 'string' ? r.tl : null) || null,
      recruiters: recIds.map((id) => userName(id) || (r.recruiterId === id && r.recruiter ? r.recruiter.name : null)).filter((n) => n && !isTest(n)),
      createdAt: r.createdAt, ageDays: r.createdAt ? Math.max(0, Math.floor((Date.now() - msOf(r.createdAt)) / DAY)) : null,
      openings: r.openings ?? null,
      steps: stepCounts(apps),
      inProcess: apps.filter((x) => !NOT_ACTIVE.includes(x.a.stage)).length,
      late: apps.filter((x) => x.live && x.na && x.na.dueStatus === 'overdue').length,
    };
  });
  return b._jobs;
}
const JOB_SORTS = {
  late: (x, y) => y.late - x.late || y.inProcess - x.inProcess,
  busy: (x, y) => y.inProcess - x.inProcess || y.late - x.late,
  newest: (x, y) => msOf(y.createdAt) - msOf(x.createdAt),
  oldest: (x, y) => msOf(x.createdAt) - msOf(y.createdAt),
  title: (x, y) => String(x.title).localeCompare(String(y.title)),
};
async function jobsList(user, b, q) {
  const s = (v) => (typeof v === 'string' ? v.trim().slice(0, 200) : '');
  const all = jobsIndex(b);
  let rows = all;
  const tlId = s(q.d_tlid);
  let title = 'Open jobs';
  if (tlId) {
    const t = await tlsList(user, b);
    const set = b._tlJobs.get(tlId);
    rows = rows.filter((r) => (set ? set.has(r.id) : r.tlId === tlId));
    const who = t.rows.find((r) => r.id === tlId);
    title = `Open jobs — ${who ? who.name : 'team lead'}`;
  }
  const scoped = rows.length;
  const term = s(q.d_q).toLowerCase();
  if (term) rows = rows.filter((r) => [r.title, r.reqCode, r.client, r.tl, ...r.recruiters].some((v) => v && String(v).toLowerCase().includes(term)));
  const sort = JOB_SORTS[s(q.d_sort)] ? s(q.d_sort) : 'late';
  rows = [...rows].sort((x, y) => JOB_SORTS[sort](x, y) || String(x.title).localeCompare(String(y.title)));
  const size = Math.max(5, Math.min(100, Number(q.d_size) || 5));
  const page = Math.max(1, Math.min(10000, Number(q.d_page) || 1));
  return {
    id: '__jobs', kind: 'jobs', title, total: scoped, filtered: rows.length, page, pageSize: size, sort, search: term,
    steps: STEP5, rows: rows.slice((page - 1) * size, page * size), _all: rows,
  };
}

// THE TEAM LEADS: the same team and the same sets as Reports & Team › Team
// (utils/teamWorkload.js — a TL's team = the recruiters whose seat reports to
// them; their jobs = live jobs they lead or their recruiters hold; their work
// = applications attributed to them or their recruiters), counted on this
// dashboard's rows, so every filter applies and every number opens its list.
async function tlsList(user, b) {
  if (b._tls) return b._tls;
  // eslint-disable-next-line global-require
  const TW = require('./teamWorkload');
  const { c, k } = b.kx;
  const tw = await TW.teamWorld(user);
  const open = new Set(k.openJobs.map((r) => r.id));
  const work = k.sel.filter((x) => !x.pre);
  const anyOther = ['clientId', 'tl', 'recruiter', 'bde', 'requirementId', 'hiring', 'priority', 'source'].some((key) => c.f[key]);
  b._tlJobs = new Map();
  const counts = (prefix, name, test, reqIds) => {
    const mine = work.filter(test);
    const sets = {
      openJobs: { kind: 'req', ids: reqIds.filter((id) => open.has(id)), title: 'Open jobs' },
      inProcess: { kind: 'app', ids: ids(mine.filter((x) => !NOT_ACTIVE.includes(x.a.stage))), title: 'People in process' },
      interviews: { kind: 'app', ids: ids(mine.filter((x) => x.a.interviewAt && liveInterview(x.a) && inPeriod(msOf(x.a.interviewAt), c.period))), title: `Interviews ${c.word}` },
      selected: { kind: 'app', ids: ids(mine.filter((x) => SELECTED_NOT_JOINED.includes(x.a.stage))), title: 'Selected, not joined' },
      joined: { kind: 'app', ids: ids(mine.filter((x) => joinedSince(x.a, c.period.from, c.period.to))), title: `Joined ${c.word}` },
      late: { kind: 'app', ids: ids(mine.filter((x) => x.live && x.na && x.na.dueStatus === 'overdue')), title: 'Late' },
    };
    const out = { drills: {} };
    Object.entries(sets).forEach(([m, st]) => {
      out[m] = st.ids.length;
      const extra = st.kind === 'app' ? extraOf(st.ids.map((id) => b.world.byId.get(id)).filter((x) => x && x.na)) : null;
      out.drills[m] = addSet(b, `${prefix}-${m}`, { kind: st.kind, title: `${name} — ${st.title}`, ids: st.ids, extra });
    });
    return out;
  };
  const people = tw.people.filter((p) => p.status === 'Active' && !isTest(p.name));
  const want = c.f.department ? (c.f.department === '__none__' ? '' : c.f.department) : null;
  const rows = people.filter((p) => p.role === 'TL').map((p) => {
    const team = people.filter((r) => r.roleGroup === 'RECRUITER' && r.tlUserId === p.id);
    const teamIds = new Set(team.map((r) => r.id));
    const reqIds = TW.personSets(tw, p).requirements.ids;
    b._tlJobs.set(p.id, new Set(reqIds.filter((id) => open.has(id))));
    const own = counts(`tl-${p.id}`, p.name, (x) => (x.who.tl && x.who.tl.userId === p.id) || (x.who.recruiter && teamIds.has(x.who.recruiter.userId)), reqIds);
    const recruiters = team.map((r) => ({
      id: r.id, name: r.name,
      ...counts(`tlr-${r.id}`, r.name, (x) => !!(x.who.recruiter && x.who.recruiter.userId === r.id), TW.personSets(tw, r).openRequirements.ids),
    })).sort((x, y) => y.late - x.late || y.inProcess - x.inProcess || String(x.name).localeCompare(String(y.name)));
    return { id: p.id, name: p.name, department: p.department || null, teamSize: team.length, ...own, recruiters };
  }).filter((r) => {
    const busy = r.openJobs + r.inProcess + r.interviews + r.selected + r.joined + r.late > 0;
    if (want !== null && (r.department || '') !== want && !busy) return false;
    if (anyOther && !busy) return false;
    return true;
  }).sort((x, y) => String(x.department || '~').localeCompare(String(y.department || '~')) || y.late - x.late || y.inProcess - x.inProcess || String(x.name).localeCompare(String(y.name)));
  const groups = [];
  rows.forEach((r) => {
    const d = r.department || 'No department';
    let g = groups.find((x) => x.department === d);
    if (!g) { g = { department: d, rows: [] }; groups.push(g); }
    g.rows.push(r);
  });
  b._tls = { id: '__tls', kind: 'tls', title: 'Team leads', total: rows.length, word: c.word, rows, groups, _all: rows };
  return b._tls;
}

// ONE JOB, opened in place: who is handling it, the people on it by step,
// the coming interviews and the last 5 things that happened.
function jobDetail(b, reqId) {
  const w = b.world;
  const r = w.reqs.find((x) => x.id === reqId);
  if (!r) return null;
  jobsIndex(b);
  const apps = (b._jobApps.get(reqId) || []).slice();
  const internal = !!r.internal || r.hiringType === INTERNAL_HIRE;
  const assigned = [...new Set([r.recruiterId, ...String(r.recruiterIds || '').split(',')].map((v) => String(v || '').trim()).filter(Boolean))];
  const byRec = new Map();
  apps.forEach((x) => {
    const p = x.who.recruiter;
    const key = p ? p.key : '__none__';
    if (!byRec.has(key)) byRec.set(key, { key, userId: p ? p.userId : null, name: p ? p.label : 'Nobody named yet', apps: [] });
    byRec.get(key).apps.push(x);
  });
  const allRecruiters = assigned.map((id) => {
    const e = byRec.get(`u:${id}`);
    if (e) byRec.delete(`u:${id}`);
    return { id, name: userName(id) || (e && e.name) || (r.recruiterId === id && r.recruiter ? r.recruiter.name : 'Recruiter'), assigned: true, apps: e ? e.apps : [] };
  }).concat([...byRec.values()].map((e) => ({ id: e.userId, name: e.name, assigned: false, apps: e.apps })))
    .filter((x) => !isTest(x.name))
    .map((x) => ({
      id: x.id, name: x.name, assigned: x.assigned, steps: stepCounts(x.apps),
      inProcess: x.apps.filter((a) => !NOT_ACTIVE.includes(a.a.stage)).length,
      late: x.apps.filter((a) => a.live && a.na && a.na.dueStatus === 'overdue').length,
    }));
  // Everyone assigned, then the 8 busiest who only worked on it ('Nobody named yet' last).
  const others = allRecruiters.filter((x) => !x.assigned).sort((x, y) => (!x.id) - (!y.id) || y.inProcess - x.inProcess || y.steps[0] - x.steps[0]);
  const recruiters = [...allRecruiters.filter((x) => x.assigned), ...others.slice(0, 8)];
  const othersMore = Math.max(0, others.length - 8);
  const bdeName = internal ? null : (userName(r.bdeId) || (r.client && r.client.bdeOwner) || null);
  const ORDER = [...STEP_ORDER.filter((s) => !['On hold', 'Rejected', 'Joined'].includes(s)), 'Joined', 'On hold', 'Rejected'];
  const steps = new Map();
  apps.forEach((x) => {
    const sw = stepWord(x.a.stage);
    if (!steps.has(sw)) steps.set(sw, []);
    steps.get(sw).push(x);
  });
  const pipeline = [...steps.entries()].sort((x, y) => ORDER.indexOf(x[0]) - ORDER.indexOf(y[0])).map(([step, list]) => ({
    step, count: list.length,
    people: list.sort((x, y) => msOf(y.a.updatedAt) - msOf(x.a.updatedAt)).slice(0, 20).map((x) => ({
      id: x.a.id, candidateId: x.a.candidateId, name: x.cand, recruiter: x.who.recruiter ? x.who.recruiter.label : null,
      late: !!(x.live && x.na && x.na.dueStatus === 'overdue'),
    })),
  }));
  const now = Date.now();
  const interviews = apps.filter((x) => x.a.interviewAt && liveInterview(x.a) && msOf(x.a.interviewAt) >= now - 2 * 3600000)
    .sort((x, y) => msOf(x.a.interviewAt) - msOf(y.a.interviewAt)).slice(0, 8)
    .map((x) => ({ id: x.a.id, candidateId: x.a.candidateId, name: x.cand, at: x.a.interviewAt, round: Number(x.a.interviewRound) || 1, mode: x.a.interviewMode || null }));
  const ev = [];
  apps.forEach((x) => x.evs.forEach((e) => {
    if (!e.from || e.from === e.to || !e.actorName || /^imported\b/i.test(e.actorName) || isTest(e.actorName)) return;
    ev.push({ x, e });
  }));
  ev.sort((p, q) => q.e.at - p.e.at);
  const activity = ev.slice(0, 5).map(({ x, e }) => ({ id: `${x.a.id}:${e.at}`, candidateId: x.a.candidateId, applicationId: x.a.id, at: new Date(e.at).toISOString(), by: e.actorName, ...activityText(e, x) }));
  const row = (b._jobs || []).find((j) => j.id === reqId);
  const tlName = userName(r.tlId) || (typeof r.tl === 'string' ? r.tl : null);
  return {
    id: `__job:${reqId}`, kind: 'job', title: r.title || 'Job',
    job: row || { id: r.id, reqCode: r.reqCode || null, title: r.title, client: internal ? 'TeamLink Internal' : (r.client ? r.client.name : null), steps: stepCounts(apps) },
    status: V.requirementStatusLabel(r.status) || r.status,
    handlers: { tl: tlName, tlWorked: [...new Set(apps.map((x) => x.who.tl && x.who.tl.label).filter((n) => n && !isTest(n) && n !== tlName))].slice(0, 3), bde: bdeName, recruiters, othersMore },
    steps: STEP5, pipeline, interviews, activity, total: apps.length,
    _all: [],
  };
}

// ===========================================================================
// THE ROWS BEHIND A NUMBER — with their own search, filters and Export
// (the user: "veetilo kuda filters raavali"). The server filters WITHIN the
// set (which is already inside the role scope and the dashboard filters).
// Query: d_q (search) · d_client · d_job · d_rec · d_tl · d_step · d_due ·
// d_dept · d_page. The filters cascade: each one's options are counted over
// the rows matching every other one, and an option with nothing behind it
// is not offered.
// ===========================================================================
const DRILL_PAGE = 25;
const DRILL_KEYS = ['d_client', 'd_job', 'd_rec', 'd_tl', 'd_step', 'd_due', 'd_dept'];
// Which drill filters a role gets (a recruiter never sees other people).
const DRILL_HIDDEN = { recruiter: ['d_rec', 'd_tl'], hr: ['d_rec', 'd_tl', 'd_client'], tl: ['d_tl'] };

function appRowOf(x, extra, clientDesk) {
  const r = x.a.requirement || {};
  return {
    id: x.a.id,
    candidateId: x.a.candidateId,
    candidate: x.cand,
    requirementId: x.a.requirementId,
    requirement: r.title || '—',
    reqCode: r.reqCode || null,
    department: r.department || null,
    client: x.internal ? 'TeamLink Internal' : (r.client ? r.client.name : null),
    clientKey: x.internal ? '__internal__' : (r.clientId || null),
    clientId: clientDesk && !x.internal ? r.clientId || null : null,
    recruiter: x.who.recruiter ? x.who.recruiter.label : null,
    recKey: x.who.recruiter ? x.who.recruiter.key : null,
    tl: x.who.tl ? x.who.tl.label : null,
    tlKey: x.who.tl ? x.who.tl.key : null,
    stage: x.a.stage,
    step: stepWord(x.a.stage),
    stageLabel: V.stageLabelFor(x.a.stage, { internal: x.internal }),
    interviewAt: x.a.interviewAt,
    joiningDate: x.a.joiningDate,
    updatedAt: x.a.updatedAt,
    createdAt: x.a.createdAt,
    ...(x.na ? dueExtra(x.na) : { dueKey: 'closed' }),
    ...(extra || {}),
  };
}
function reqRowOf(w, r, clientDesk) {
  const internal = !!r.internal || r.hiringType === INTERNAL_HIRE;
  const users = NA.snapshot().activeUsers || new Map();
  const rid = recruiterOf(r);
  return {
    id: r.id, title: r.title, reqCode: r.reqCode, status: V.requirementStatusLabel(r.status) || r.status,
    openings: r.openings, department: r.department || null,
    client: internal ? 'TeamLink Internal' : (r.client ? r.client.name : null),
    clientKey: internal ? '__internal__' : (r.clientId || null),
    clientId: clientDesk && !internal ? r.clientId : null,
    recruiter: rid ? ((r.recruiter && r.recruiter.name) || users.get(rid) || 'Named') : null,
    recKey: rid ? `u:${rid}` : '__none__',
    createdAt: r.createdAt,
  };
}

// The drill facets each list kind offers.
function facetDefs(kind) {
  if (kind === 'app') {
    return [
      ['d_client', 'Client', (r) => r.clientKey, (r) => r.client || '—'],
      ['d_job', 'Job', (r) => r.requirementId, (r) => r.requirement],
      ['d_rec', 'Recruiter', (r) => r.recKey || '__none__', (r) => r.recruiter || 'Nobody named'],
      ['d_tl', 'Team lead', (r) => r.tlKey || '__none__', (r) => r.tl || 'Nobody named'],
      ['d_step', 'Step', (r) => r.step, (r) => r.step],
      ['d_due', 'Due', (r) => r.dueKey || 'no_due', (r) => DUE_WORDS[r.dueKey || 'no_due']],
    ];
  }
  if (kind === 'req') {
    return [
      ['d_client', 'Client', (r) => r.clientKey, (r) => r.client || '—'],
      ['d_dept', 'Department', (r) => r.department || '__none__', (r) => r.department || 'No department'],
      ['d_rec', 'Recruiter', (r) => r.recKey, (r) => r.recruiter || 'No recruiter'],
      ['d_step', 'Status', (r) => r.status, (r) => r.status],
    ];
  }
  return [];
}
const SEARCH_OF = {
  app: (r) => [r.candidate, r.requirement, r.reqCode, r.client, r.recruiter, r.tl],
  req: (r) => [r.title, r.reqCode, r.client, r.recruiter, r.department],
  client: (r) => [r.name, r.owner, r.agreement],
  inv: (r) => [r.invoiceNumber, r.client, r.status],
  pay: (r) => [r.invoiceNumber, r.client, r.method, r.reference],
  emp: (r) => [r.name, r.department, r.designation, r.status],
  user: (r) => [r.name, r.role],
  event: (r) => [r.candidate, r.requirement, r.from, r.to, r.by],
  integ: (r) => [r.what, r.detail],
};

async function setRows(user, b, set) {
  const w = b.world;
  if (set.kind === 'app') {
    const extra = set.extra || new Map();
    return set.ids.map((id) => w.byId.get(id)).filter(Boolean).map((x) => appRowOf(x, extra.get(x.a.id), b.clientDesk));
  }
  if (set.kind === 'req') {
    const missing = set.ids.filter((id) => !w.reqById.has(id));
    if (missing.length) (await chunked(missing, (part) => prisma.requirement.findMany({ where: { id: { in: part } }, select: REQ_SELECT }))).forEach((r) => w.reqById.set(r.id, r));
    return set.ids.map((id) => w.reqById.get(id)).filter(Boolean).map((r) => reqRowOf(w, r, b.clientDesk));
  }
  if (set.kind === 'user') {
    const us = await prisma.user.findMany({ where: { id: { in: set.ids.slice(0, 2000) } }, select: { id: true, name: true, role: true, atsRole: true, lastLoginAt: true, status: true }, orderBy: { lastLoginAt: 'desc' } });
    return us.map((u) => ({ id: u.id, name: u.name, role: u.atsRole && u.atsRole !== 'NONE' ? u.atsRole : u.role, at: u.lastLoginAt, status: u.status }));
  }
  if (set.kind === 'client') return set.rows.map((r) => ({ ...r, to: b.clientDesk ? `/clients/${r.id}` : null }));
  return set.rows || [];
}

async function homeList(user, b, setId, q = {}) {
  // The sections that load on their own (Team leads · Open jobs · one job).
  if (setId === '__tls' && b.kx) return tlsList(user, b);
  if (setId === '__jobs' && b.kx) return jobsList(user, b, q);
  if (setId.startsWith('__job:') && b.kx) return jobDetail(b, setId.slice(6));
  // A Team leads number on a board rebuilt since: make its sets again.
  if (!b.sets.has(setId) && /^tlr?-/.test(setId) && b.kx) await tlsList(user, b);
  const set = b.sets.get(setId);
  if (!set) return null;
  const layout = b.layout;
  const all = await setRows(user, b, set);
  const s = (v) => (typeof v === 'string' ? v.trim().slice(0, 200) : '');
  const hidden = DRILL_HIDDEN[layout] || [];
  const picked = {};
  DRILL_KEYS.forEach((k) => { if (s(q[k]) && !hidden.includes(k)) picked[k] = s(q[k]); });
  const term = s(q.d_q).toLowerCase();
  const search = SEARCH_OF[set.kind] || (() => []);
  const searched = term ? all.filter((r) => search(r).some((v) => v && String(v).toLowerCase().includes(term))) : all;
  const defs = facetDefs(set.kind).filter(([k]) => !hidden.includes(k));
  const matches = (r, except) => defs.every(([k, , val]) => k === except || !picked[k] || String(val(r) ?? '') === picked[k]);
  const rows = searched.filter((r) => matches(r, null));
  // Cascading options with counts; none at zero (the picked one stays).
  const facets = {};
  defs.forEach(([k, label, val, lab]) => {
    const m = new Map();
    searched.forEach((r) => {
      if (!matches(r, k)) return;
      const v = val(r);
      if (v === null || v === undefined || v === '') return;
      const e = m.get(String(v)) || { value: String(v), label: lab(r), count: 0 };
      e.count += 1;
      m.set(String(v), e);
    });
    let opts = [...m.values()];
    if (k === 'd_step') opts.sort((x, y) => (STEP_ORDER.indexOf(x.value) - STEP_ORDER.indexOf(y.value)) || y.count - x.count);
    else if (k === 'd_due') opts.sort((x, y) => DUE_ORDER.indexOf(x.value) - DUE_ORDER.indexOf(y.value));
    else opts.sort((x, y) => y.count - x.count || String(x.label).localeCompare(String(y.label)));
    opts = opts.filter((o) => !isTest(o.label)).slice(0, 300);
    if (picked[k] && !opts.some((o) => o.value === picked[k])) opts.push({ value: picked[k], label: picked[k], count: 0 });
    if (opts.length) facets[k] = { label, options: opts };
  });
  const page = Math.max(1, Math.min(10000, Number(q.d_page) || 1));
  const size = Math.max(10, Math.min(200, Number(q.d_size) || DRILL_PAGE));
  return {
    id: setId, title: set.title, kind: set.kind === 'event' ? 'event' : set.kind,
    total: all.length, filtered: rows.length, page, pageSize: size,
    rows: rows.slice((page - 1) * size, page * size).map(({ clientKey, recKey, tlKey, ...r }) => r), // eslint-disable-line no-unused-vars
    facets, picked, search: term, searchable: !!SEARCH_OF[set.kind],
    _all: rows,
  };
}

// The same list as a file (Excel / CSV), exactly the filtered rows.
const DAYF = (v) => { if (!v) return ''; const d = new Date(v); return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 10); };
const EXPORT_COLUMNS = {
  app: [['Candidate', (r) => r.candidate], ['Job', (r) => r.requirement], ['Job code', (r) => r.reqCode || ''], ['Client', (r) => r.client || ''], ['Department', (r) => r.department || ''],
    ['Recruiter', (r) => r.recruiter || ''], ['Team lead', (r) => r.tl || ''], ['Step', (r) => r.step], ['Due', (r) => (r.note ? r.note : `${DUE_WORDS[r.dueKey || 'no_due']}${r.due ? ` · ${r.due}` : ''}`)],
    ['Interview', (r) => DAYF(r.interviewAt)], ['Joining date', (r) => DAYF(r.joiningDate)], ['Updated', (r) => DAYF(r.updatedAt)]],
  req: [['Job', (r) => r.title], ['Job code', (r) => r.reqCode || ''], ['Client', (r) => r.client || ''], ['Department', (r) => r.department || ''], ['Recruiter', (r) => r.recruiter || 'No recruiter'], ['Status', (r) => r.status], ['Openings', (r) => r.openings ?? ''], ['Created', (r) => DAYF(r.createdAt)]],
  client: [['Client', (r) => r.name], ['Agreement', (r) => r.agreement || ''], ['Client manager (BDE)', (r) => r.owner || ''], ['Open jobs', (r) => r.openJobs ?? '']],
  inv: [['Invoice', (r) => r.invoiceNumber || ''], ['Client', (r) => r.client], ['Invoice date', (r) => DAYF(r.invoiceDate)], ['Due', (r) => DAYF(r.dueDate)], ['Status', (r) => r.status], ['Amount (before GST)', (r) => r.amount], ['Unpaid', (r) => r.outstanding]],
  pay: [['Date', (r) => DAYF(r.date)], ['Invoice', (r) => r.invoiceNumber || ''], ['Client', (r) => r.client || ''], ['Method', (r) => r.method || ''], ['Reference', (r) => r.reference || ''], ['Amount', (r) => r.amount]],
  emp: [['Employee', (r) => r.name], ['Department', (r) => r.department || ''], ['Designation', (r) => r.designation || ''], ['Today', (r) => r.status || '']],
  user: [['User', (r) => r.name], ['Role', (r) => r.role], ['Last sign-in', (r) => DAYF(r.at)]],
  event: [['Candidate', (r) => r.candidate], ['Job', (r) => r.requirement], ['From step', (r) => r.from], ['To step', (r) => r.to], ['By', (r) => r.by || ''], ['When', (r) => DAYF(r.at)]],
  integ: [['What', (r) => r.what], ['Detail', (r) => r.detail]],
  jobs: [['Job ID', (r) => r.reqCode || ''], ['Job', (r) => r.title], ['Client', (r) => r.client || ''], ['Department', (r) => r.department || ''], ['Team lead', (r) => r.tl || ''], ['Recruiters', (r) => (r.recruiters || []).join(', ')], ['Opened', (r) => DAYF(r.createdAt)], ['Days open', (r) => r.ageDays ?? ''],
    ...['Added', 'Sent to client', 'Interview', 'Selected', 'Joined'].map((l, i) => [l, (r) => r.steps[i]]), ['In process', (r) => r.inProcess], ['Late', (r) => r.late]],
  tls: [['Team lead', (r) => r.name], ['Department', (r) => r.department || ''], ['Recruiters', (r) => r.teamSize], ['Open jobs', (r) => r.openJobs], ['In process', (r) => r.inProcess], ['Interviews', (r) => r.interviews], ['Selected', (r) => r.selected], ['Joined', (r) => r.joined], ['Late', (r) => r.late]],
};
function exportTable(list) {
  const cols = EXPORT_COLUMNS[list.kind] || [['Item', (r) => r.name || r.id]];
  return { headers: cols.map((c) => c[0]), rows: (list._all || []).map((r) => cols.map((c) => { const v = c[1](r); return v === undefined || v === null ? '' : v; })) };
}

function publicHome(b) {
  const out = { ...b };
  delete out.sets;
  delete out.world;
  ["kx", "_jobs", "_jobApps", "_tls", "_tlJobs"].forEach((key) => { delete out[key]; });
  return out;
}

// ===========================================================================
// BULK "CLOSE STALE…" (Super Admin / Admin) — moves the stale rows to an
// existing terminal / hold stage. Never deletes. Each moved application gets a
// Progress history row (who, when, why) and one audit row records the batch.
// No candidate message and no notification is sent (a clean-up, not a
// hiring decision); open follow-ups of a closed (Rejected) row are completed.
// ===========================================================================
async function closeStale(user, { target, reason, stages, expected }) {
  const layout = layoutOf(user);
  if (!COMPANY.includes(layout)) return { status: 403, error: 'Only a Super Admin or Admin can close old applications.' };
  if (!STALE_TARGETS[target]) return { status: 400, error: 'Pick what they become: Rejected or On Hold.' };
  const why = String(reason || '').trim();
  if (why.length < 5) return { status: 400, error: 'Write a reason (5+ letters). It is saved on each one.' };
  const w = await worldFor(user, { fresh: true });
  const rows = w.rows.filter((x) => x.live && !x.pre && x.na.dueStatus === 'stale' && x.a.stage !== target && !isTest(x.cand)
    && (!Array.isArray(stages) || !stages.length || stages.includes(x.a.stage)));
  if (expected != null && Number(expected) !== rows.length) {
    return { status: 409, error: `The list changed: ${fmtN(rows.length)} now, ${fmtN(expected)} before. Open it again.`, count: rows.length };
  }
  if (!rows.length) return { status: 200, moved: 0 };
  const now = new Date();
  const label = STALE_TARGETS[target];
  const CHUNK = 400;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    const partIds = part.map((x) => x.a.id);
    // eslint-disable-next-line no-await-in-loop
    await prisma.$transaction([
      prisma.application.updateMany({ where: { id: { in: partIds } }, data: { stage: target } }),
      prisma.applicationStageEvent.createMany({
        data: part.map(({ a, internal }) => ({
          applicationId: a.id, candidateId: a.candidateId, fromStage: a.stage, toStage: target,
          action: `Closed as stale — ${label}`, comment: why,
          actorUserId: user.id, actorName: user.name, actorRole: user.atsRole || user.role, actorSide: 'Internal',
          requirementId: a.requirementId, requirementTitle: a.requirement ? a.requirement.title : null,
          clientId: a.requirement ? a.requirement.clientId : null,
          clientName: internal ? 'TeamLink Internal' : (a.requirement && a.requirement.client ? a.requirement.client.name : null),
          reasonCategory: 'Stale — no activity', reasonDetail: why, createdAt: now,
        })),
      }),
      ...(target === 'REJECTED' ? [prisma.applicationFollowUp.updateMany({
        where: { applicationId: { in: partIds }, completedAt: null },
        data: { completedAt: now, completedById: user.id, completedNote: 'Closed automatically — application closed as stale.' },
      })] : []),
    ]);
  }
  const byStage = {};
  rows.forEach(({ a }) => { byStage[a.stage] = (byStage[a.stage] || 0) + 1; });
  await prisma.auditLog.create({
    data: {
      userId: user.id, actorName: user.name, action: 'Bulk closed stale applications', entity: 'Application', entityId: 'bulk',
      fromValue: Object.entries(byStage).map(([st, n]) => `${stepWord(st)} ${n}`).join(', '),
      toValue: `${rows.length} → ${label}`, reason: why,
    },
  }).catch((err) => console.error('[atsHome] audit failed:', err.message)); // eslint-disable-line no-console
  return { status: 200, moved: rows.length, target: label };
}

module.exports = {
  healthDot, buildHome, homeList, exportTable, publicHome, closeStale, layoutOf, worldFor, STALE_TARGETS, STEP_WORDS, stepWord, DUE_WORDS,
  warmCompanyWorld, // utils/candidateWarmup.js runs after it (the dashboard is the first page)
  // Reports hide test / demo rows by this same rule (routes/atsReports.js, 2026-10-03).
  isTest,
};
