// ---------------------------------------------------------------------------
// The Interview Calendar's AI tab, answered by the database (not by the browser).
//
// Every application carries an AI interview status ("Required" by default), so
// the old GET /ats/calendar sent one row per application in scope for a global
// login (23,632 rows, 6.7 MB of a 7.3 MB answer). Almost all of them are
// "Required" with no score: nothing to read, only to count.
//
//   GET /ats/calendar            `ai` now holds only the rows with something to
//                                say (a status other than Required, or a score,
//                                or a passed deadline = Expired) and `aiCounts`
//                                the real totals. ?fullAi=1 = the old full list
//                                (the Excel export of the AI tab uses it).
//   GET /ats/calendar/ai         the AI tab itself, paged:
//        view     upcoming | today | feedback | completed | cancelled | all
//        status   one status (Required, Scheduled, Started, Completed,
//                 Manual Review Requested, Expired)
//        q        search (name, job or the AI interview ID)
//        sort     '' (oldest first) | deadline | candidate
//        page, pageSize (default 50, at most 200), today (YYYY-MM-DD, the
//        screen's "today"), and the same person filters as /ats/calendar
//        (tl, recruiter, bde, positionCode)
//     -> { rows, total, page, pageSize, pages, counts: {<view>: n},
//          facets: { status: [{value,label,count}] } }
//
// The status a row SHOWS is not always the stored one (withExpiry in
// routes/atsExtras.js): a score means Completed, and a deadline in the past on
// a not-finished interview reads Expired. The fragments below say the same
// thing in SQL so that the counts and the page agree with what is drawn.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const KNOWN = ['Required', 'Scheduled', 'Started', 'Completed', 'Manual Review Requested', 'Expired'];
const AI_OPEN_STAGES = ['NEW', 'AI_INTERVIEW_REQUIRED', 'AI_INTERVIEW_SCHEDULED'];
const VIEWS = ['upcoming', 'today', 'feedback', 'completed', 'cancelled', 'all'];
const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;

// An AI row at all (what the old query selected).
const HAS_AI = { OR: [{ aiInterviewStatus: { not: null } }, { aiInterviewScore: { not: null } }] };

// withExpiry(): `new Date(deadline) < new Date(new Date().toDateString())`. A
// plain date (YYYY-MM-DD) is that midnight in UTC, so the last expired day is
// the one just before today's local midnight.
function lastExpiredDay(now = new Date()) {
  const cutoff = new Date(now.toDateString());
  return new Date(cutoff.getTime() - 1).toISOString().slice(0, 10);
}

function fragments(now = new Date()) {
  const dMax = lastExpiredDay(now);
  const NOT_COMPLETED = { AND: [{ aiInterviewScore: null }, { OR: [{ aiInterviewStatus: null }, { aiInterviewStatus: { not: 'Completed' } }] }] };
  const COMPLETED = { OR: [{ aiInterviewScore: { not: null } }, { aiInterviewStatus: 'Completed' }] };
  const MRR = { AND: [NOT_COMPLETED, { aiInterviewStatus: 'Manual Review Requested' }] };
  const notMrr = { OR: [{ aiInterviewStatus: null }, { aiInterviewStatus: { not: 'Manual Review Requested' } }] };
  const pastDeadline = { AND: [{ aiInterviewDeadline: { not: null } }, { aiInterviewDeadline: { gt: '' } }, { aiInterviewDeadline: { lte: dMax } }] };
  const EXPIRED = { AND: [NOT_COMPLETED, notMrr, pastDeadline] };
  const notExpired = { OR: [{ aiInterviewDeadline: null }, { aiInterviewDeadline: '' }, { aiInterviewDeadline: { gt: dMax } }] };
  // A stored status that is shown as it is stored.
  const plain = (label) => ({
    AND: [NOT_COMPLETED, notMrr, notExpired, label === 'Required'
      ? { OR: [{ aiInterviewStatus: null }, { aiInterviewStatus: 'Required' }] }
      : { aiInterviewStatus: label }],
  });
  const status = (label) => {
    if (label === 'Completed') return COMPLETED;
    if (label === 'Manual Review Requested') return MRR;
    if (label === 'Expired') return EXPIRED;
    return plain(label);
  };
  // Still "owed": before the Recruiter Review and not yet done / expired.
  const owed = { AND: [{ stage: { in: AI_OPEN_STAGES } }, { OR: ['Required', 'Scheduled', 'Started'].map(plain) }] };
  const view = (name, today) => {
    switch (name) {
      case 'upcoming': return owed;
      case 'today': return { AND: [owed, { aiInterviewDeadline: today }] };
      case 'feedback': return { OR: [{ AND: [COMPLETED, { stage: 'AI_INTERVIEW_COMPLETED' }] }, MRR] };
      case 'completed': return COMPLETED;
      case 'cancelled': return EXPIRED;
      default: return {};
    }
  };
  return { status, view, EXPIRED, COMPLETED, NOT_COMPLETED };
}

// The rows worth sending with the calendar: anything but an unscored, unexpired "Required".
function worthSending(row) {
  return row.status !== 'Required' || row.score != null;
}

// The status counts for the badge: { total, byStatus }.
async function totals(where, now = new Date()) {
  const f = fragments(now);
  const base = { AND: [where, HAS_AI] };
  const raw = await prisma.application.groupBy({ by: ['aiInterviewStatus'], where: base, _count: { _all: true } }).catch(() => []);
  const labels = [...new Set([...KNOWN, ...raw.map((r) => r.aiInterviewStatus).filter(Boolean)])];
  const counts = await Promise.all(labels.map((l) => prisma.application.count({ where: { AND: [base, f.status(l)] } })));
  const byStatus = {};
  labels.forEach((l, i) => { if (counts[i]) byStatus[l] = counts[i]; });
  const total = await prisma.application.count({ where: base });
  return { total, byStatus };
}

function parseAsk(query) {
  const q = query || {};
  const num = (k, d) => { const n = Math.floor(Number(q[k])); return Number.isFinite(n) && n > 0 ? n : d; };
  const view = VIEWS.includes(q.view) ? q.view : 'upcoming';
  const today = /^\d{4}-\d{2}-\d{2}$/.test(String(q.today || '')) ? String(q.today) : new Date().toISOString().slice(0, 10);
  return {
    view,
    status: q.status ? String(q.status) : '',
    q: String(q.q || '').trim(),
    sort: ['deadline', 'candidate'].includes(q.sort) ? q.sort : '',
    page: num('page', 1),
    pageSize: Math.min(MAX_PAGE_SIZE, num('pageSize', DEFAULT_PAGE_SIZE)),
    today,
  };
}

// The search box: name, job, or the AI interview ID ("AI-XXXXXX" = the last six
// characters of the application id).
function searchWhere(text) {
  if (!text) return null;
  const code = /^ai-([0-9a-z]{6})$/i.exec(text);
  return {
    OR: [
      { candidate: { name: { contains: text } } },
      { requirement: { title: { contains: text } } },
      ...(code ? [{ id: { endsWith: code[1].toLowerCase() } }] : []),
    ],
  };
}

// One page of the AI tab. `where` is the caller's scope (+ person filter).
// `shape(app)` turns a row into what the tab draws (shapeAi + withExpiry).
async function page(where, query, shape) {
  const a = parseAsk(query);
  const now = new Date();
  const f = fragments(now);
  const base = { AND: [where, HAS_AI, ...(searchWhere(a.q) ? [searchWhere(a.q)] : [])] };
  const statusWhere = a.status ? [f.status(a.status)] : [];

  const raw = await prisma.application.groupBy({ by: ['aiInterviewStatus'], where: { AND: [where, HAS_AI] }, _count: { _all: true } });
  const labels = [...new Set([...KNOWN, ...raw.map((r) => r.aiInterviewStatus).filter(Boolean)])];

  const viewWhere = (v) => ({ AND: [base, f.view(v, a.today)] });
  const [viewCounts, statusCounts] = await Promise.all([
    Promise.all(VIEWS.map((v) => prisma.application.count({ where: { AND: [viewWhere(v), ...statusWhere] } }))),
    Promise.all(labels.map((l) => prisma.application.count({ where: { AND: [viewWhere(a.view), f.status(l)] } }))),
  ]);
  const counts = Object.fromEntries(VIEWS.map((v, i) => [v, viewCounts[i]]));
  const STATUS_TEXT = { 'Manual Review Requested': 'Check by recruiter' };
  const status = labels
    .map((l, i) => ({ value: l, label: STATUS_TEXT[l] || l, count: statusCounts[i] }))
    .filter((o) => o.count > 0 || o.value === a.status)
    .sort((x, y) => y.count - x.count || x.label.localeCompare(y.label));

  const total = counts[a.view];
  const pages = Math.max(1, Math.ceil(total / a.pageSize));
  const pageNo = Math.min(a.page, pages);
  const orderBy = a.sort === 'deadline'
    ? [{ aiInterviewDeadline: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }]
    : a.sort === 'candidate' ? [{ candidate: { name: 'asc' } }, { createdAt: 'asc' }] : [{ createdAt: 'asc' }];
  const apps = await prisma.application.findMany({
    where: { AND: [viewWhere(a.view), ...statusWhere] },
    select: {
      id: true, stage: true, aiInterviewStatus: true, aiInterviewDeadline: true, aiInterviewScore: true, aiInterviewFeedback: true,
      candidate: { select: { id: true, name: true } },
      requirement: { select: { id: true, title: true } },
    },
    orderBy,
    skip: (pageNo - 1) * a.pageSize,
    take: a.pageSize,
  });
  const rows = apps.map(shape);
  await addCompletedAt(rows);
  return {
    rows, total, page: pageNo, pageSize: a.pageSize, pages, counts, facets: { status },
  };
}

// "Completed 27 Sep": when the AI interview was completed, from the pipeline history.
async function addCompletedAt(rows) {
  const done = rows.filter((r) => r.status === 'Completed').map((r) => r.id);
  if (!done.length) return;
  const doneAt = new Map();
  for (let i = 0; i < done.length; i += 500) {
    // eslint-disable-next-line no-await-in-loop
    const evs = await prisma.applicationStageEvent.findMany({
      where: { applicationId: { in: done.slice(i, i + 500) }, toStage: 'AI_INTERVIEW_COMPLETED' },
      select: { applicationId: true, createdAt: true },
    });
    evs.forEach((e) => {
      const prev = doneAt.get(e.applicationId);
      if (!prev || e.createdAt > prev) doneAt.set(e.applicationId, e.createdAt);
    });
  }
  rows.forEach((r) => { r.completedAt = doneAt.get(r.id) || null; });
}

module.exports = {
  HAS_AI, fragments, worthSending, totals, page, parseAsk, AI_OPEN_STAGES, VIEWS, KNOWN,
};
