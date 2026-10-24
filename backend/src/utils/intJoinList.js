// ---------------------------------------------------------------------------
// SERVER PAGING for the three workflow lists: Interview Feedback, Offers and
// Joining (GET /api/ats/feedback | /offers | /joining).
//
// Why: each list used to send EVERY row of the caller's area, fully shaped
// (Offers: 3,900 rows, 3.9 MB, 14-17 s) and let the browser search, filter,
// count and page them. Now the server does that work on a LEAN copy of the
// rows (a few columns, one query) and shapes only the rows of the page that
// is asked for. What the screens show is the same; only less travels.
//
// Asking for the paged form: add `page` to the query (or `idsOnly=1`).
//   page, pageSize   1-based page, default 50, at most 200
//   q                search (candidate name, job, client name)
//   department, client, job, recruiter (id), hiringType, status   the filters
//   view             the tab: Offers prepare|approval|candidate|accepted|all,
//                    Joining waiting|joined|dropped|all (Feedback has none)
//   sort             '' (latest change) | name | newest | oldest
//   window           open (default when paged) | all.   "open" = the work that
//                    is still going on (see OPEN below); `all` adds the old
//                    rows ("Show older").
//   idsOnly=1        { ids } of every row the current filters + view show (the
//                    export asks for it so "This list" means the whole list,
//                    not just the page).
// Without `page` / `idsOnly` the endpoints answer exactly as before (the full
// array) — the Excel export (routes/atsIo.js) calls them that way.
//
// Paged answer:  { rows, total, page, pageSize, pages, counts, facets,
//                  olderCount, window, ...the endpoint's own extras }
//   total   rows in the chosen tab after the filters (what the pager counts)
//   counts  rows per tab after the filters, over the WHOLE window (not the page)
//   facets  the Filters panel's options with counts, cascading (each filter's
//           options are counted with every OTHER filter applied)
//   olderCount  rows that match the filters but are outside the window
//
// OPEN (plain words):
//   Offers    still going on = not joined yet (Selected, Offer sent, Offer accepted)
//   Joining   waiting to join, or joined / did not join in the last 90 days,
//             or a placement that left inside its guarantee (Replacement due)
//   Feedback  waiting for feedback or a decision, or interviewed in the last 90 days
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { applicationWhere } = require('./scope');
const { hiringTypeOf, INTERNAL_HIRE } = require('./joining');
const { stageLabel } = require('./atsVocab');

const DAY = 86400000;
const WINDOW_DAYS = 90;
const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;

const LEAN_SELECT = {
  id: true,
  stage: true,
  updatedAt: true,
  hiringType: true,
  offerStatus: true,
  offerDate: true,
  joiningDate: true,
  joiningStatus: true,
  joinedAt: true,
  offerAcceptedAt: true,
  interviewAt: true,
  interviewStatus: true,
  candidate: { select: { id: true, name: true } },
  requirement: {
    select: {
      id: true,
      title: true,
      department: true,
      internal: true,
      hiringType: true,
      client: { select: { id: true, name: true } },
      recruiter: { select: { id: true, name: true } },
    },
  },
};

// ---- the three screens' own words (mirrors the frontend pages) -------------
const OFFER_PREPARED = 'Offer being prepared';
function offerStepId(app) {
  const st = app.offerStatus || 'Not Issued';
  if (st === OFFER_PREPARED) return 'approval';
  if (st === 'Offer Released') return 'candidate';
  if (st === 'Offer Accepted' || ['OFFER_ACCEPTED', 'JOINED', 'HIRED'].includes(app.stage)) return 'accepted';
  // CLIENT hiring (2026-10-13): the client makes the offer - 'client' = waiting for the client's letter, 'share' = the client released it, the recruiter shares it.
  if (app.clientJob) return app.trackOfferState === 'RELEASED' ? 'share' : 'client';
  return 'prepare'; // not issued / declined / expired (an internal hire: TeamLink prepares it)
}

function waitingToJoin(app) {
  return app.stage === 'OFFER_ACCEPTED' && !['Joined', 'Dropped'].includes(app.joiningStatus);
}
function joiningViewId(app) {
  if (app.joiningStatus === 'Dropped') return 'dropped';
  if (waitingToJoin(app)) return 'waiting';
  if (['JOINED', 'HIRED'].includes(app.stage)) return 'joined';
  return 'all';
}

const DECIDABLE = ['INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED', 'HOLD'];
const LIVE = ['SCHEDULED', 'CONFIRMED', 'STARTED', 'RESCHEDULED', 'COMPLETED', 'PENDING_FEEDBACK'];
const DECIDED = ['SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED', 'REJECTED'];
function feedbackStepText(app, hasInternal, now) {
  if (!DECIDABLE.includes(app.stage)) return app.stage === 'REJECTED' ? 'Rejected' : `Decided — ${stageLabel(app.stage)}`;
  if (!hasInternal) {
    const late = app.interviewAt && LIVE.includes(app.interviewStatus) && !DECIDED.includes(app.stage)
      && new Date(app.interviewAt).getTime() + DAY < now;
    return late ? 'Feedback late' : 'Needs feedback';
  }
  return 'Needs decision';
}

const ts = (v) => { const n = v ? new Date(v).getTime() : NaN; return Number.isNaN(n) ? null : n; };

const SPECS = {
  offers: {
    views: ['client', 'share', 'prepare', 'approval', 'candidate', 'accepted'],
    viewOf: (it) => offerStepId(it.app),
    dateOf: (it) => it.app.offerDate,
    open: (it) => !['JOINED', 'HIRED'].includes(it.app.stage),
  },
  joining: {
    views: ['waiting', 'joined', 'dropped'],
    viewOf: (it) => joiningViewId(it.app),
    dateOf: (it) => (waitingToJoin(it.app) ? it.app.offerAcceptedAt : (it.app.joinedAt || it.app.joiningDate)),
    open(it, cutoff) {
      const v = joiningViewId(it.app);
      if (v === 'waiting' || v === 'all') return true;
      if (it.app.joiningStatus === 'Replacement Due') return true;
      if (v === 'joined') { const t = ts(it.app.joinedAt || it.app.joiningDate); return t !== null && t >= cutoff; }
      const t = ts(it.app.updatedAt); // did not join
      return t !== null && t >= cutoff;
    },
    // "Waiting to join" is oldest first: the person waiting longest is the risk.
    viewSort(view, rows) {
      if (view !== 'waiting') return rows;
      const t = (it) => ts(it.app.offerAcceptedAt) || 0;
      return [...rows].sort((a, b) => t(a) - t(b));
    },
  },
  feedback: {
    views: [],
    viewOf: () => 'all',
    dateOf: (it) => it.app.interviewAt,
    status: true,
    open(it, cutoff) {
      if (DECIDABLE.includes(it.app.stage)) return true;
      const t = ts(it.app.interviewAt);
      return t !== null && t >= cutoff;
    },
  },
};

// The filter fields in the order the screens draw them. `get` is the value the
// filter compares; `label` is what the Filters panel shows for it.
const hiringLabel = (v) => (v === INTERNAL_HIRE ? 'TeamLink hire' : 'Client hire');
function fieldsFor(spec) {
  return [
    ...(spec.status ? [{ key: 'status', get: (it) => it.statusText, label: (v) => v }] : []),
    { key: 'department', get: (it) => it.department },
    { key: 'client', get: (it) => it.clientShown },
    { key: 'job', get: (it) => it.title },
    { key: 'recruiter', get: (it) => it.recruiterId, label: (v, it) => it.recruiterName },
    { key: 'hiringType', get: (it) => it.hiring, label: hiringLabel },
  ];
}

// ---- the query -----------------------------------------------------------
// null = the old behaviour (full array). Otherwise the parsed ask.
function ask(query) {
  const q = query || {};
  const idsOnly = q.idsOnly === '1' || q.idsOnly === 'true';
  const paged = q.page !== undefined || q.pageSize !== undefined || q.paged === '1';
  if (!paged && !idsOnly) return null;
  const str = (k) => (q[k] === undefined || q[k] === null ? '' : String(q[k]));
  const num = (k, d) => { const n = Math.floor(Number(q[k])); return Number.isFinite(n) && n > 0 ? n : d; };
  return {
    idsOnly,
    page: num('page', 1),
    pageSize: Math.min(MAX_PAGE_SIZE, num('pageSize', DEFAULT_PAGE_SIZE)),
    q: str('q').trim().toLowerCase(),
    filters: {
      status: str('status'), department: str('department'), client: str('client'), job: str('job'), recruiter: str('recruiter'), hiringType: str('hiringType'),
    },
    sort: str('sort'),
    view: str('view') || 'all',
    window: str('window') === 'all' ? 'all' : 'open',
  };
}

// The lean rows by ONE joined SQL query (the Prisma nested select below takes
// ~1.4 s for 4,000 rows because it runs one query per relation and decodes the
// wide Application row). Scope still comes from Prisma: the caller's
// application ids are taken with applicationWhere() first, so a row outside the
// caller's area can never be read here. Same shape as LEAN_SELECT gives.
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
async function leanApps(req, where, kind) {
  const idRows = await prisma.application.findMany({
    where: { AND: [applicationWhere(req.user), where] },
    select: { id: true },
  });
  const ids = idRows.map((r) => r.id);
  if (ids.some((id) => !SAFE_ID.test(id))) throw new Error('unexpected id');
  const out = [];
  for (let i = 0; i < ids.length; i += 4000) {
    const list = ids.slice(i, i + 4000).filter((id) => /^[A-Za-z0-9_-]+$/.test(String(id))).map((id) => `'${id}'`).join(',');
    // eslint-disable-next-line no-await-in-loop
    const rows = await prisma.$queryRawUnsafe(
      `SELECT a.id, a.stage, a.updatedAt, a.hiringType, a.offerStatus, a.offerDate, a.joiningDate, a.joiningStatus, a.joinedAt,
              a.offerAcceptedAt, a.interviewAt, a.interviewStatus,
              c.id AS cId, c.name AS cName,
              r.id AS rId, r.title AS rTitle, r.department AS rDepartment, r.internal AS rInternal, r.hiringType AS rHiringType,
              cl.id AS clId, cl.name AS clName, u.id AS uId, u.name AS uName
              ${kind === 'feedback' ? ", EXISTS(SELECT 1 FROM InterviewFeedback f WHERE f.applicationId = a.id AND f.kind = 'Internal') AS hasInternal" : ''}
         FROM Application a
         LEFT JOIN Candidate c ON c.id = a.candidateId
         LEFT JOIN Requirement r ON r.id = a.requirementId
         LEFT JOIN Client cl ON cl.id = r.clientId
         LEFT JOIN User u ON u.id = r.recruiterId
        WHERE a.id IN (${list})`,
    );
    rows.forEach((x) => out.push({
      id: x.id,
      stage: x.stage,
      updatedAt: x.updatedAt,
      hiringType: x.hiringType,
      offerStatus: x.offerStatus,
      offerDate: x.offerDate,
      joiningDate: x.joiningDate,
      joiningStatus: x.joiningStatus,
      joinedAt: x.joinedAt,
      offerAcceptedAt: x.offerAcceptedAt,
      interviewAt: x.interviewAt,
      interviewStatus: x.interviewStatus,
      candidate: x.cId ? { id: x.cId, name: x.cName } : null,
      requirement: x.rId ? {
        id: x.rId,
        title: x.rTitle,
        department: x.rDepartment,
        internal: !!x.rInternal,
        hiringType: x.rHiringType,
        client: x.clId ? { id: x.clId, name: x.clName } : null,
        recruiter: x.uId ? { id: x.uId, name: x.uName } : null,
      } : null,
      ...(kind === 'feedback' ? { interviewFeedbacks: Number(x.hasInternal) ? [{ id: 'x' }] : [] } : {}),
    }));
  }
  const t = (v) => (v ? new Date(v).getTime() : 0);
  return out.sort((a, b) => t(b.updatedAt) - t(a.updatedAt) || (a.id < b.id ? -1 : 1));
}

// One lean row per application in the caller's area.
async function leanItems(req, where, kind) {
  const select = kind === 'feedback'
    ? { ...LEAN_SELECT, interviewFeedbacks: { where: { kind: 'Internal' }, select: { id: true } } }
    : LEAN_SELECT;
  let apps;
  try {
    apps = await leanApps(req, where, kind);
  } catch (e) {
    // Anything unexpected: the slower, plain Prisma read (same rows, same shape).
    apps = await prisma.application.findMany({
      where: { AND: [applicationWhere(req.user), where] },
      select,
      orderBy: { updatedAt: 'desc' },
    });
  }
  const now = Date.now();
  const aliasByName = await require('./clientSearch').aliasNameMap().catch(() => new Map()); // eslint-disable-line global-require
  const tracks = kind === 'offers' ? await require('./clientTrack').loadAll().catch(() => new Map()) : null; // eslint-disable-line global-require
  return apps.map((app) => {
    const r = app.requirement || {};
    const hiring = hiringTypeOf(app, r);
    if (tracks) {
      app.clientJob = hiring !== INTERNAL_HIRE;
      const tr = tracks.get(app.id);
      app.trackOfferState = tr && tr.offer ? tr.offer.state : null;
    }
    const it = {
      id: app.id,
      app,
      name: app.candidate ? app.candidate.name : '',
      title: r.title || '',
      department: r.department || null,
      clientName: r.client ? r.client.name : '',
      // the client's OLD names (ClientAlias): the search box matches them; nothing shows them
      clientOldNames: r.client ? (aliasByName.get(String(r.client.name || '').trim().toLowerCase()) || []).join(' ') : '',
      clientShown: hiring === INTERNAL_HIRE ? 'TeamLink (internal)' : (r.client ? r.client.name : null),
      recruiterId: r.recruiter ? r.recruiter.id : null,
      recruiterName: r.recruiter ? r.recruiter.name : '',
      hiring,
    };
    if (kind === 'feedback') it.statusText = feedbackStepText(app, (app.interviewFeedbacks || []).length > 0, now);
    return it;
  });
}

// Filter, count, sort and cut the page. Pure; mirrors the browser code it replaces
// (useIntJoinList / useLocalFacets in the pages' shared file).
function run(items, kind, a) {
  const spec = SPECS[kind];
  const fields = fieldsFor(spec);
  const cutoff = Date.now() - WINDOW_DAYS * DAY;
  const inWindow = a.window === 'all' ? items : items.filter((it) => spec.open(it, cutoff));
  const textOk = (it) => !a.q || `${it.name} ${it.title} ${it.clientName} ${it.clientOldNames || ''}`.toLowerCase().includes(a.q);
  const fieldOk = (it, skip) => fields.every((f) => f.key === skip || !a.filters[f.key] || String(f.get(it) ?? '') === a.filters[f.key]);
  const searched = inWindow.filter(textOk);

  // The Filters panel: each field counted with every OTHER field applied.
  const facets = {};
  fields.forEach((f) => {
    const counts = new Map();
    const labels = new Map();
    searched.forEach((it) => {
      if (!fieldOk(it, f.key)) return;
      const v = f.get(it);
      if (v === null || v === undefined || v === '' || v === '—') return;
      counts.set(String(v), (counts.get(String(v)) || 0) + 1);
      if (f.label && !labels.has(String(v))) labels.set(String(v), f.label(v, it));
    });
    facets[f.key] = [...counts.entries()]
      .map(([value, count]) => ({ value, label: labels.get(value) || value, count }))
      .sort((x, y) => y.count - x.count || String(x.label).localeCompare(String(y.label)));
  });

  let filtered = searched.filter((it) => fieldOk(it, null));
  if (a.sort === 'name') {
    filtered = [...filtered].sort((x, y) => String(x.name).localeCompare(String(y.name)));
  } else if (a.sort === 'oldest' || a.sort === 'newest') {
    const t = (it) => ts(spec.dateOf(it));
    filtered = [...filtered].sort((x, y) => {
      const p = t(x); const q = t(y);
      if (p === null && q === null) return 0;
      if (p === null) return 1; // no date: last, either way
      if (q === null) return -1;
      return a.sort === 'oldest' ? p - q : q - p;
    });
  }

  const counts = { all: filtered.length };
  spec.views.forEach((v) => { counts[v] = 0; });
  filtered.forEach((it) => { const v = spec.viewOf(it); if (v !== 'all') counts[v] = (counts[v] || 0) + 1; });

  let shown = a.view === 'all' ? filtered : filtered.filter((it) => spec.viewOf(it) === a.view);
  if (spec.viewSort) shown = spec.viewSort(a.view, shown);

  const olderCount = a.window === 'all' ? 0 : items.filter((it) => !spec.open(it, cutoff) && textOk(it) && fieldOk(it, null)).length;
  return { shown, counts, facets, olderCount };
}

// Everything the endpoint needs: the ids of this page, or all ids (idsOnly).
async function pageOf(req, where, kind, a) {
  const items = await leanItems(req, where, kind);
  const out = run(items, kind, a);
  if (a.idsOnly) return { ids: out.shown.map((it) => it.id) };
  const total = out.shown.length;
  const pages = Math.max(1, Math.ceil(total / a.pageSize));
  const page = Math.min(a.page, pages);
  const slice = out.shown.slice((page - 1) * a.pageSize, page * a.pageSize);
  return {
    ids: slice.map((it) => it.id),
    meta: {
      total, page, pageSize: a.pageSize, pages, counts: out.counts, facets: out.facets, olderCount: out.olderCount, window: a.window,
    },
  };
}

module.exports = {
  ask, pageOf, leanItems, run, WINDOW_DAYS, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE,
};
