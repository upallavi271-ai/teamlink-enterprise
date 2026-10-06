// ---------------------------------------------------------------------------
// OWN-RESULT REPORTS (per-role spec 2026-10-03).
//
//   myResults(user, range)     a RECRUITER's "My Results" — submitted,
//                              interviews, selected, joined — over the
//                              applications in their own scope
//                              (utils/scope.js applicationWhere: their jobs).
//   clientReport(user, range)  a CLIENT's own company numbers for the portal —
//                              only requirements of their company and only
//                              candidates actually SHARED with them.
//
// A metric counts an application ONCE when it reached that point (a stage
// event into one of the stages, or — for history without events — its current
// stage), inside the date range when one is given.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { applicationWhere, CLIENT_SHARED_STAGES } = require('./scope');

const METRICS = {
  submittedToTl: ['TL_REVIEW', 'WITH_BDE', 'BDE_APPROVED'],
  submittedToClient: CLIENT_SHARED_STAGES,
  interviews: ['INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED'],
  selected: ['SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED'],
  joined: ['JOINED', 'HIRED'],
};
// Pipeline order, so "reached Selected" also counts an application that is
// now Joined even when no Selected event was recorded.
const ORDER = ['NEW', 'AI_INTERVIEW_REQUIRED', 'AI_INTERVIEW_SCHEDULED', 'AI_INTERVIEW_COMPLETED', 'RECRUITER_REVIEW',
  'RECRUITER_APPROVED', 'TL_REVIEW', 'WITH_BDE', 'BDE_APPROVED', 'SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'CLIENT_SHORTLISTED',
  'INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED', 'SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED'];
const rank = (s) => ORDER.indexOf(s);

function parseRange(q = {}) {
  const ok = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const from = ok(q.from) ? new Date(`${q.from}T00:00:00`) : null;
  const to = ok(q.to) ? new Date(`${q.to}T23:59:59.999`) : null;
  return { from, to, label: from || to ? `${ok(q.from) ? q.from : '…'} to ${ok(q.to) ? q.to : '…'}` : 'All time' };
}
const inRange = (d, r) => (!r.from || d >= r.from) && (!r.to || d <= r.to);

async function countMetrics(apps, range) {
  const ids = apps.map((a) => a.id);
  const all = [...new Set(Object.values(METRICS).flat())];
  const events = ids.length ? await prisma.applicationStageEvent.findMany({
    where: { applicationId: { in: ids }, toStage: { in: all } },
    select: { applicationId: true, toStage: true, createdAt: true },
  }) : [];
  const out = {};
  Object.entries(METRICS).forEach(([k, stages]) => {
    const hit = new Set();
    events.forEach((e) => { if (stages.includes(e.toStage) && inRange(e.createdAt, range)) hit.add(e.applicationId); });
    // History without events: the current stage, dated by the last update.
    const floor = Math.min(...stages.map(rank).filter((n) => n >= 0));
    apps.forEach((a) => {
      if (hit.has(a.id)) return;
      if (rank(a.stage) >= floor && inRange(a.updatedAt, range) && !events.some((e) => e.applicationId === a.id && stages.includes(e.toStage))) hit.add(a.id);
    });
    out[k] = hit.size;
  });
  out.interviews = Math.max(out.interviews, apps.filter((a) => a.interviewAt && inRange(a.interviewAt, range)).length);
  return out;
}

async function myResults(user, query) {
  const range = parseRange(query);
  const apps = await prisma.application.findMany({
    where: applicationWhere(user),
    select: { id: true, stage: true, updatedAt: true, createdAt: true, interviewAt: true },
  });
  const sourced = apps.filter((a) => inRange(a.createdAt, range)).length;
  const m = await countMetrics(apps, range);
  return {
    range: range.label,
    scope: 'My jobs',
    cards: [
      { key: 'sourced', label: 'Candidates added', value: sourced },
      { key: 'submittedToTl', label: 'Submitted to TL', value: m.submittedToTl },
      { key: 'submittedToClient', label: 'Submitted to client', value: m.submittedToClient },
      { key: 'interviews', label: 'Interviews', value: m.interviews },
      { key: 'selected', label: 'Selected', value: m.selected },
      { key: 'joined', label: 'Joined', value: m.joined },
    ],
  };
}

async function clientReport(user, query) {
  const range = parseRange(query);
  const clientId = user.clientId || '__none__';
  const reqs = await prisma.requirement.findMany({
    where: { clientId, internal: false },
    select: { id: true, status: true, openings: true },
  });
  const reqIds = reqs.map((r) => r.id);
  const apps = reqIds.length ? await prisma.application.findMany({
    where: { requirementId: { in: reqIds } },
    select: { id: true, stage: true, updatedAt: true, createdAt: true, interviewAt: true },
  }) : [];
  // Only what was SHARED with the client (now or ever) is theirs to count.
  const everShared = new Set((apps.length ? await prisma.applicationStageEvent.findMany({
    where: { applicationId: { in: apps.map((a) => a.id) }, toStage: { in: CLIENT_SHARED_STAGES } },
    select: { applicationId: true },
  }) : []).map((e) => e.applicationId));
  const shared = apps.filter((a) => CLIENT_SHARED_STAGES.includes(a.stage) || everShared.has(a.id));
  const m = await countMetrics(shared, range);
  const LIVE = ['OPEN', 'RECRUITER_ASSIGNED', 'SOURCING', 'CANDIDATES_AVAILABLE'];
  const open = reqs.filter((r) => LIVE.includes(r.status));
  return {
    range: range.label,
    scope: 'Your company',
    cards: [
      { key: 'openRequirements', label: 'Open requirements', value: open.length },
      { key: 'openPositions', label: 'Open positions', value: open.reduce((n, r) => n + (r.openings || 0), 0) },
      { key: 'submitted', label: 'Candidates sent to you', value: m.submittedToClient },
      { key: 'awaitingDecision', label: 'Waiting for your decision', value: shared.filter((a) => ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW'].includes(a.stage)).length },
      { key: 'interviews', label: 'Interviews', value: m.interviews },
      { key: 'selected', label: 'Selected', value: m.selected },
      { key: 'joined', label: 'Joined', value: m.joined },
    ],
  };
}

function toCsvRows(report) {
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  return [['Metric', 'Value', 'Period'], ...report.cards.map((c) => [c.label, c.value, report.range])]
    .map((r) => r.map(esc).join(',')).join('\r\n');
}

module.exports = { myResults, clientReport, toCsvRows, parseRange };
