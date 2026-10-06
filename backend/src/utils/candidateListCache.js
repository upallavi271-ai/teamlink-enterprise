// ---------------------------------------------------------------------------
// THE CANDIDATE LIST'S WORKING SET — loaded once, kept current by deltas.
//
// GET /candidates used to rebuild every candidate, every application, every
// requirement and every follow-up from the database on every request: 16,935
// candidates / 23,632 applications / 4,347 requirements took 20-30 seconds and
// a 30 MB response before the browser could draw 25 rows. The paged list
// (GET /candidates?paged=1) reads this in-memory copy instead and pages,
// filters and sorts it on the server.
//
// STALENESS IS NOT ALLOWED ("every action updates immediately", spec §32).
// Every read first compares a cheap version stamp — row counts and the newest
// updatedAt of applications, requirements and follow-ups, and the newest
// candidate createdAt — against the one the copy was built at:
//   * nothing changed      -> the copy is used as is
//   * rows were added or   -> only those rows are re-read (updatedAt >= the
//     updated                last stamp) and patched in
//   * a count went DOWN,   -> the whole copy is rebuilt
//     or the day changed
//   * the copy is 10 min   -> the delta as above, and a fresh copy is built in
//     old                    the background and swapped in on a later read
// utils/candidateWarmup.js builds the first copy right after
// the server starts, so the first person in does not wait for it.
// A candidate edited in place (PUT /candidates/:id) has no updatedAt column, so
// that route calls markCandidateDirty() and the next read re-reads that row.
//
// SCOPE IS NOT DECIDED HERE. This holds everything; routes/candidates.js runs
// the same visibleApplications()/decorate() over it per request, so what a
// login sees is exactly what the old list showed it.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { currentFollowUpsByApplication, todayStr } = require('./followups');

const MAX_AGE_MS = 10 * 60 * 1000;
const CHUNK = 500;

// The candidate columns the list reads. The row has sixty; the list needs these.
const CANDIDATE_SELECT = {
  id: true, name: true, email: true, phone: true, location: true,
  source: true, firstSource: true, skills: true, createdAt: true,
  // The Candidates filters Experience / Notice period / Salary (spec 2026-10-03 §B).
  experienceYears: true, noticePeriod: true, expectedSalary: true,
  // ATS layout v3: the list's CTC column (current CTC).
  currentSalary: true,
  // Candidates (2026-10-03 §7): Archived / Do Not Use, and the Qualification /
  // Specialisation masters the Filters panel offers.
  profileStatus: true, qualificationId: true, specialisationId: true,
  // B7: the partner who owns this person (the "Partner: X" badge).
  ownerPartnerId: true, ownerUntil: true,
};
// The application columns decorate(), the list and the filters read.
const APPLICATION_SELECT = {
  id: true, candidateId: true, requirementId: true, stage: true,
  interviewStatus: true, interviewAt: true, createdAt: true, updatedAt: true,
  aiInterviewStatus: true, matchScore: true, resumeScore: true,
  // Candidates structure (2026-09-29): pre-ATS vs in-ATS (source +
  // portalImportedAt), Client vs Internal per application (hiringType), and
  // the client-feedback test (interviewResult / interviewCompletedAt).
  source: true, portalImportedAt: true, hiringType: true,
  interviewResult: true, interviewCompletedAt: true,
};
// The requirement stays whole (scope matching reads a dozen of its fields);
// its relations are narrowed to what the list shows.
const REQUIREMENT_INCLUDE = {
  // bdeOwner: the client's Owner BDE owns a BDE step when the requirement
  // names no BDE (utils/nextAction.js).
  client: { select: { id: true, name: true, bdeOwner: true } },
  recruiter: { select: { id: true, name: true } },
  bde: { select: { id: true, name: true } },
};

let state = null;
let inflight = null;
const dirtyCandidates = new Set();

function markCandidateDirty(id) { if (id) dirtyCandidates.add(String(id)); }

async function stampNow() {
  const [a, c, r, f] = await Promise.all([
    prisma.application.aggregate({ _count: { _all: true }, _max: { updatedAt: true } }),
    prisma.candidate.aggregate({ _count: { _all: true }, _max: { createdAt: true } }),
    prisma.requirement.aggregate({ _count: { _all: true }, _max: { updatedAt: true } }),
    prisma.applicationFollowUp.aggregate({ _count: { _all: true }, _max: { updatedAt: true } }),
  ]);
  const t = (d) => (d ? new Date(d).getTime() : 0);
  return {
    apps: a._count._all, appsMax: t(a._max.updatedAt),
    cands: c._count._all, candsMax: t(c._max.createdAt),
    reqs: r._count._all, reqsMax: t(r._max.updatedAt),
    fus: f._count._all, fusMax: t(f._max.updatedAt),
  };
}

function sortCandidates(list) {
  list.sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt));
}

// Build a whole copy from the database. Returns the new state WITHOUT
// installing it; fullBuild() installs it at once, the background rebuild only
// once it is done (the old copy keeps serving meanwhile).
async function buildState(stamp) {
  // SPEED (2026-10-03): the follow-ups used to be read AFTER the other three
  // (they need the application ids), which made the cold build the sum of four
  // reads. The ids alone are a quick read, so the follow-ups now load in
  // parallel with the rest, through the very same currentFollowUpsByApplication()
  // — same rows, same "current follow-up" rule. An application added between the
  // id read and the full read has updatedAt >= the stamp, so the first delta
  // re-reads its follow-up (applyDelta step 4).
  const appIds = (await prisma.application.findMany({ select: { id: true } })).map((a) => a.id);
  const [candidates, applications, requirements, followUps] = await Promise.all([
    prisma.candidate.findMany({ select: CANDIDATE_SELECT, orderBy: { createdAt: 'desc' } }),
    prisma.application.findMany({ select: APPLICATION_SELECT }),
    prisma.requirement.findMany({ include: REQUIREMENT_INCLUDE }),
    currentFollowUpsByApplication(appIds),
  ]);
  const reqs = new Map(requirements.map((r) => [r.id, r]));
  const byId = new Map();
  candidates.forEach((c) => { c.applications = []; byId.set(c.id, c); });
  const apps = new Map();
  applications.forEach((a) => {
    a.requirement = reqs.get(a.requirementId) || null;
    apps.set(a.id, a);
    const c = byId.get(a.candidateId);
    if (c) c.applications.push(a);
  });
  // Exactly the applications this copy holds (one deleted between the two
  // reads must not leave a follow-up behind).
  followUps.forEach((_v, k) => { if (!apps.has(k)) followUps.delete(k); });
  return { built: Date.now(), day: todayStr(), stamp, candidates, byId, apps, reqs, followUps };
}

function install(next) {
  // Bumped whenever the copy changes, so a caller can memoise work over it.
  next.version = (state ? state.version : 0) + 1;
  state = next;
  return state;
}

async function fullBuild(stamp) {
  dirtyCandidates.clear();
  return install(await buildState(stamp));
}

// THE 10-MINUTE SAFETY REBUILD RUNS IN THE BACKGROUND (2026-10-03). It used to
// block whichever request found the copy too old — a 6-20 s wait every ten
// minutes. Now that request is answered from the copy brought up to date by
// the ordinary delta (exactly what the database holds), and a fresh copy is
// built alongside. It is swapped in at the start of the NEXT refresh (refresh
// calls never overlap, so a delta never runs half on the old copy and half on
// the new), and that refresh then applies every change since the new copy's
// stamp. Dirty candidates are left marked, so they are simply re-read.
let rebuilding = null;
let ready = null;
function rebuildInBackground() {
  if (rebuilding || ready) return;
  rebuilding = (async () => {
    const stamp = await stampNow();
    ready = await buildState(stamp);
  })().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[candidateListCache] background rebuild failed:', err.message);
  }).finally(() => { rebuilding = null; });
}

async function refreshFollowUps(appIds) {
  if (!appIds.length) return;
  for (let i = 0; i < appIds.length; i += CHUNK) {
    const ids = appIds.slice(i, i + CHUNK);
    // eslint-disable-next-line no-await-in-loop
    const fresh = await currentFollowUpsByApplication(ids);
    ids.forEach((id) => {
      if (fresh.has(id)) state.followUps.set(id, fresh.get(id));
      else state.followUps.delete(id);
    });
  }
}

// Patch the copy with whatever changed since `state.stamp`. Returns false when
// a full rebuild is the only safe answer.
async function applyDelta(now) {
  const was = state.stamp;
  if (now.apps < was.apps || now.cands < was.cands || now.reqs < was.reqs || now.fus < was.fus) return false;

  // 1. Requirements (their assignment decides scope, so they come first).
  if (now.reqsMax > was.reqsMax || now.reqs !== state.reqs.size) {
    const rows = await prisma.requirement.findMany({
      where: { updatedAt: { gte: new Date(was.reqsMax) } }, include: REQUIREMENT_INCLUDE,
    });
    const changed = new Set();
    rows.forEach((r) => { state.reqs.set(r.id, r); changed.add(r.id); });
    if (changed.size) {
      state.apps.forEach((a) => { if (changed.has(a.requirementId)) a.requirement = state.reqs.get(a.requirementId); });
    }
  }

  // 2. Candidates: new ones, and any edited in place.
  if (now.candsMax > was.candsMax || now.cands !== state.byId.size || dirtyCandidates.size) {
    const dirty = [...dirtyCandidates];
    dirtyCandidates.clear();
    const rows = await prisma.candidate.findMany({
      where: { OR: [{ createdAt: { gte: new Date(was.candsMax) } }, ...(dirty.length ? [{ id: { in: dirty } }] : [])] },
      select: CANDIDATE_SELECT,
    });
    let added = false;
    rows.forEach((row) => {
      const existing = state.byId.get(row.id);
      if (existing) Object.assign(existing, row);
      else {
        row.applications = [];
        state.byId.set(row.id, row);
        state.candidates.push(row);
        added = true;
      }
    });
    if (added) sortCandidates(state.candidates);
  }

  // 3. Applications: new ones and moved ones (a stage move stamps updatedAt).
  const touchedApps = new Set();
  if (now.appsMax > was.appsMax || now.apps !== state.apps.size) {
    const rows = await prisma.application.findMany({
      where: { updatedAt: { gte: new Date(was.appsMax) } }, select: APPLICATION_SELECT,
    });
    for (const row of rows) {
      row.requirement = state.reqs.get(row.requirementId) || null;
      const existing = state.apps.get(row.id);
      if (existing) {
        Object.assign(existing, row);
      } else {
        const c = state.byId.get(row.candidateId);
        if (!c) return false;
        state.apps.set(row.id, row);
        c.applications.push(row);
      }
      touchedApps.add(row.id);
    }
  }

  // 4. Follow-ups: re-read the current one for every application whose
  //    follow-ups changed (and for every application that just moved — a
  //    move can close its follow-up).
  if (now.fusMax > was.fusMax || now.fus !== was.fus || touchedApps.size) {
    const rows = now.fusMax > was.fusMax || now.fus !== was.fus
      ? await prisma.applicationFollowUp.findMany({
        where: { updatedAt: { gte: new Date(was.fusMax) } }, select: { applicationId: true },
      })
      : [];
    rows.forEach((r) => touchedApps.add(r.applicationId));
    await refreshFollowUps([...touchedApps]);
  }

  // The copy must now hold exactly what the database holds.
  if (state.apps.size !== now.apps || state.byId.size !== now.cands || state.reqs.size !== now.reqs) return false;
  state.stamp = now;
  state.version += 1;
  return true;
}

async function refresh() {
  // A background rebuild finished: swap it in BEFORE the stamp is read, so the
  // check below brings it up to date from its own stamp.
  if (ready) {
    const next = ready;
    ready = null;
    if (next.day === todayStr() && (!state || next.built >= state.built)) install(next);
  }
  const now = await stampNow();
  if (!state || state.day !== todayStr()) return fullBuild(now);
  if (Date.now() - state.built > MAX_AGE_MS) rebuildInBackground();
  const was = state.stamp;
  const same = !dirtyCandidates.size && ['apps', 'appsMax', 'cands', 'candsMax', 'reqs', 'reqsMax', 'fus', 'fusMax']
    .every((k) => was[k] === now[k]);
  if (same) return state;
  const ok = await applyDelta(now);
  return ok ? state : fullBuild(await stampNow());
}

// The current working set. Concurrent callers share one refresh.
async function getListState() {
  if (inflight) return inflight;
  inflight = refresh().finally(() => { inflight = null; });
  return inflight;
}

module.exports = { getListState, markCandidateDirty };
