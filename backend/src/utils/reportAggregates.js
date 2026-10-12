// ---------------------------------------------------------------------------
// REPORT AGGREGATES — one shared, short-lived copy of the data every ATS
// report is built from (routes/atsReports.js loadContext).
//
// Before: every report, for every login, re-read ALL applications, ALL stage
// events, ALL follow-ups ... from the database (9-75 s on the full company)
// and then threw them away. Now the company-wide rows are read ONCE, kept in
// memory, and each login's scope is applied AFTER that, on the shared copy:
//
//   * the scope itself is still the Prisma `where` of utils/scope.js — but it
//     only has to answer "which ids?" (a few hundred ms), so the role rules
//     (TL own team, BDE own clients, Recruiter own work, Manager everything)
//     are exactly the rules the lists use, not a second copy of them;
//   * everything that depends on the clock (days in step, overdue, ...) is
//     still worked out per request from these rows, so a number is the number
//     a from-scratch computation gives right now.
//
// NEVER STALE. The copy is checked against the database on every request with
// one cheap fingerprint (row count + newest createdAt / updatedAt of every
// table it reads). A stage move, an offer, a joining, a new requirement, a
// follow-up, a feedback ... changes a fingerprint, so the
// very next report rebuilds the copy first. Candidates carry no updatedAt, so
// a candidate write made through this API (Prisma middleware below) also
// invalidates, and a copy is never older than TTL_MS whatever happens (a
// script writing the database from another process).
//
// Not cached here (cheap, and read fresh every request): users (a login or a profile
// edit touches User.updatedAt all day long and must not rebuild everything) and client
// names. What is derived from the users is keyed on their names and teams instead.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const TTL_MS = 10 * 60 * 1000;

// --- Candidate writes (no updatedAt on Candidate to fingerprint) -------------
let candVersion = 0;
const WRITE_ACTIONS = new Set(['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']);
try {
  prisma.$use(async (params, next) => {
    const out = await next(params);
    if (params.model === 'Candidate' && WRITE_ACTIONS.has(params.action)) candVersion += 1;
    return out;
  });
} catch { /* a client without middleware: the TTL and the fingerprint still hold */ }

// --- The fingerprint -------------------------------------------------------
const t = (d) => (d ? new Date(d).getTime() : 0);
async function readStamp() {
  const agg = (model, field) => prisma[model].aggregate({ _count: { _all: true }, _max: { [field]: true } });
  const [app, req, ev, fu, fb, cand] = await Promise.all([
    agg('application', 'updatedAt'),
    agg('requirement', 'updatedAt'),
    agg('applicationStageEvent', 'createdAt'),
    agg('applicationFollowUp', 'updatedAt'),
    agg('interviewFeedback', 'updatedAt'),
    agg('candidate', 'createdAt'),
  ]);
  const part = (a, f) => `${a._count._all}:${t(a._max[f])}`;
  return {
    main: [part(app, 'updatedAt'), part(req, 'updatedAt'), part(ev, 'createdAt'), part(fu, 'updatedAt'), part(fb, 'updatedAt')].join('|'),
    cand: `${part(cand, 'createdAt')}|v${candVersion}`,
  };
}

// --- The rows ------------------------------------------------------------------
const APP_SELECT = {
  id: true, candidateId: true, requirementId: true, stage: true, createdAt: true, updatedAt: true,
  interviewStatus: true, interviewAt: true, interviewRescheduleCount: true, interviewResult: true,
  interviewer: true, interviewMode: true, interviewType: true,
  aiInterviewStatus: true, aiInterviewScore: true,
  offerStatus: true, joiningStatus: true, joiningDate: true,
  joinedAt: true,
  source: true, firstSource: true,
};
const REQ_SELECT = {
  id: true, reqCode: true, title: true, clientId: true, internal: true, department: true,
  location: true, status: true, openings: true, createdAt: true, recruiterId: true,
  bdeId: true, tlId: true, tl: true, stlId: true, stl: true, positionCode: true,
  qualificationId: true, specialisationId: true,
};
const EVENT_SELECT = {
  applicationId: true, fromStage: true, toStage: true, createdAt: true, actorSide: true,
  actorUserId: true, actorName: true, actorRole: true, actorPositionCode: true,
  reasonCategory: true, reasonDetail: true,
};
const FU_SELECT = {
  id: true, applicationId: true, ownerUserId: true, ownerName: true, ownerPositionCode: true,
  tlName: true, bdeUserId: true, bdeName: true, dueDate: true, completedAt: true, createdAt: true,
  escalationLevel: true, outcome: true, nextAction: true, tlUserId: true,
};

function groupBy(rows, key) {
  const m = new Map();
  rows.forEach((r) => {
    const k = r[key];
    const list = m.get(k);
    if (list) list.push(r); else m.set(k, [r]);
  });
  return m;
}

async function buildMain() {
  stats.builds += 1;
  const [reqRows, appRows, events, followUps, feedback] = await Promise.all([
    prisma.requirement.findMany({ select: REQ_SELECT }),
    prisma.application.findMany({ select: APP_SELECT }),
    prisma.applicationStageEvent.findMany({ select: EVENT_SELECT, orderBy: { createdAt: 'asc' } }),
    prisma.applicationFollowUp.findMany({ select: FU_SELECT, orderBy: { createdAt: 'asc' } }),
    prisma.interviewFeedback.findMany({ select: { applicationId: true, kind: true, recommendation: true } }),
  ]);
  return {
    reqRows, appRows, followUps,
    // By id, so a scope's ids can be turned back into rows in the ORDER the database gave them (idsWhere).
    reqById: new Map(reqRows.map((r) => [r.id, r])),
    appById: new Map(appRows.map((a) => [a.id, a])),
    serial: stats.builds,
    evBy: groupBy(events, 'applicationId'),
    fuBy: groupBy(followUps, 'applicationId'),
    fbBy: groupBy(feedback, 'applicationId'),
  };
}

// Candidate side: the source of every candidate (used only where an
// application carries none) and the test / demo people who are never counted.
async function buildCand() {
  const { isTest } = require('./atsHome'); // eslint-disable-line global-require
  const [cands, testRows] = await Promise.all([
    prisma.candidate.findMany({ select: { id: true, source: true, firstSource: true } }),
    prisma.candidate.findMany({
      where: { OR: [{ name: { contains: 'zztest' } }, { name: { contains: 'example.test' } }] },
      select: { id: true, name: true },
    }),
  ]);
  return {
    candSerial: (stats.candBuilds = (stats.candBuilds || 0) + 1),
    candById: new Map(cands.map((c) => [c.id, c])),
    testCands: new Set(testRows.filter((c) => isTest(c.name)).map((c) => c.id)),
  };
}

// One slot per part: { key, at, data } and the build in flight for it.
function slot(builder) {
  let cur = null;
  let busy = null;
  return async function get(key) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (cur && cur.key === key && Date.now() - cur.at < TTL_MS) return cur.data;
      if (busy) {
        // eslint-disable-next-line no-await-in-loop
        await busy.promise.catch(() => null); // one build at a time; then look again
      } else {
        const entry = { key, at: Date.now(), promise: null };
        entry.promise = builder().then((data) => {
          cur = { key, at: entry.at, data };
          return data;
        });
        busy = entry;
        // eslint-disable-next-line no-await-in-loop
        const data = await entry.promise.finally(() => { if (busy === entry) busy = null; });
        return data;
      }
    }
    return builder(); // never reached in practice: build on its own rather than fail
  };
}
const stats = { builds: 0 }; // how many times the company-wide rows were re-read (for tests)
const mainSlot = slot(buildMain);
const candSlot = slot(buildCand);

// The shared base: { reqRows, appRows, followUps, evBy, fbBy, candById, testCands, key }.
async function getBase() {
  const stamp = await readStamp(); stats.last = stamp.main + '#' + stamp.cand; // BEFORE the rows: a write in between only makes the copy newer than its key
  const [main, cand] = await Promise.all([mainSlot(stamp.main), candSlot(stamp.cand)]);
  // `key` also carries which build of each part this is, so anything derived from the rows (atsReports.js DERIVED)
  // starts again when the rows are re-read, even when the fingerprint did not move (a TTL rebuild).
  return { ...main, ...cand, key: `${stamp.main}#${stamp.cand}#${main.serial}.${cand.candSerial}` };
}

// A Prisma where that selects nothing in particular ({}, {AND:[{}]} ...).
function isTrivialWhere(w) {
  if (!w) return true;
  if (typeof w !== 'object') return false;
  const keys = Object.keys(w);
  if (!keys.length) return true;
  return keys.length === 1 && keys[0] === 'AND' && Array.isArray(w.AND) && w.AND.every(isTrivialWhere);
}
// The ids a where selects (null = everything, no query needed): { set, list } — `list` keeps the order the
// database returned them in, so the rows come back in the same order the old per-scope query gave them
// (equal-valued rows in a sorted table then tie-break exactly as before).
async function idsWhere(model, where) {
  if (isTrivialWhere(where)) return null;
  const list = (await model.findMany({ where, select: { id: true } })).map((r) => r.id);
  return { set: new Set(list), list };
}

// Small per-fingerprint memo for report-specific extras (e.g. the override
// rows): same fingerprint -> same answer, anything written -> recomputed.
const memos = new Map();
async function memo(name, fn) {
  const stamp = await readStamp();
  const key = `${stamp.main}#${stamp.cand}`;
  const hit = memos.get(name);
  if (hit && hit.key === key && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = await fn();
  memos.set(name, { key, at: Date.now(), value });
  return value;
}

module.exports = { getBase, idsWhere, isTrivialWhere, memo, stats, TTL_MS };
