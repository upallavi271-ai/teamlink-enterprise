// ---------------------------------------------------------------------------
// FILTER OPTIONS WITH COUNTS — "Orbit Software (12)", cascading, never a zero
// option (spec 2026-10-03 §B, Filters).
//
//   GET /api/ats-io/facets/:module?<the screen's own filter params>
//   -> { facets: { <param>: [{ value, label, count }] }, total }
//
// Standard faceted counting: each filter's options are counted over the
// caller's SCOPED list with every OTHER active filter applied (its own left
// out), so choosing Medical narrows the Client / TL / Recruiter / BDE
// options to Medical ones, and an option that would show nothing is not
// offered (count 0 is dropped — except the value currently chosen, so the
// screen can still show and remove it).
//
// The lists are the screens' own:
//   requirements  routes/requirements.js listWhere()  (the paged list's where)
//   candidates    routes/candidates.js pipeline rows   (the paged pipeline's rows
//                 and its own row matcher)
// Lists the browser already holds whole (Clients, Recruiter & BDE, the
// Interview Calendar) count their options in the browser instead.
//
// A recruiter sees only the client NAME (user decision 2026-10-03) — that is
// all a client option carries here.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { requirementStatusLabel } = require('./atsVocab');
const { hasPersonQuery, attributedApplications } = require('./workers');

const without = (q, keys) => {
  const out = { ...q };
  keys.forEach((k) => { delete out[k]; });
  return out;
};
const finish = (map, labelOf, chosen) => {
  const list = [...map.entries()]
    .filter(([v, n]) => v !== null && v !== undefined && v !== '' && (n > 0 || String(v) === String(chosen || '')))
    .map(([v, n]) => ({ value: String(v), label: labelOf ? labelOf(v) : String(v), count: n }));
  list.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  // The chosen value stays visible even when the other filters leave it empty.
  if (chosen && !list.some((o) => o.value === String(chosen))) list.unshift({ value: String(chosen), label: labelOf ? labelOf(chosen) : String(chosen), count: 0 });
  return list;
};

// ---- requirements -------------------------------------------------------------
async function requirementFacets(user, q) {
  // eslint-disable-next-line global-require
  const { listWhere } = require('../routes/requirements');
  if (typeof listWhere !== 'function') return { facets: {}, total: null };
  const where = (omit) => listWhere({ user, query: without(q, [...omit, 'page', 'pageSize', 'sort', 'dir']) });
  const group = async (field, omit) => {
    const rows = await prisma.requirement.groupBy({ by: [field], where: await where(omit), _count: { _all: true } });
    return new Map(rows.map((r) => [r[field], r._count._all]));
  };
  const [dept, client, tl, rec, bde, status, prio, loc, internal, total] = await Promise.all([
    group('department', ['department']),
    group('clientId', ['clientId']),
    group('tlId', ['tlId', 'tlName']),
    group('recruiterId', ['recruiterId', 'workedByName']),
    group('bdeId', ['bdeId', 'bdeName']),
    group('status', ['status']),
    group('priority', ['priority']),
    group('location', ['location']),
    group('internal', ['type']),
    prisma.requirement.count({ where: await where([]) }),
  ]);
  // spec D: Qualification / Specialization (master ids), cascading like the
  // rest; a requirement not mapped yet counts under 'none' ("Not mapped yet").
  const [qualF, specF] = await Promise.all([
    group('qualificationId', ['qualificationId']),
    group('specialisationId', ['specialisationId']),
  ]);
  const specLabels = await require('./specialisations').labelsFor(); // eslint-disable-line global-require
  const noneKey = (m) => new Map([...m.entries()].map(([k, n]) => [k == null ? 'none' : k, n]));
  // Deadline buckets (routes/requirements.js listWhere ?deadline=).
  const DEADLINES = [['overdue', 'Overdue'], ['week', 'Due in the next 7 days'], ['month', 'Due in the next 30 days'], ['none', 'No deadline']];
  const deadlineCounts = await Promise.all(DEADLINES.map(async ([k]) => prisma.requirement.count({
    where: await listWhere({ user, query: { ...without(q, ['deadline', 'page', 'pageSize', 'sort', 'dir']), deadline: k } }),
  })));
  const deadline = DEADLINES.map(([k, l], i) => ({ value: k, label: l, count: deadlineCounts[i] }))
    .filter((o) => o.count > 0 || o.value === q.deadline);
  const ids = [...new Set([...tl.keys(), ...rec.keys(), ...bde.keys()].filter(Boolean))];
  const [users, clients] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
    prisma.client.findMany({ where: { id: { in: [...client.keys()].filter(Boolean) } }, select: { id: true, name: true } }),
  ]);
  const uname = new Map(users.map((u) => [u.id, u.name]));
  const cname = new Map(clients.map((c) => [c.id, c.name]));
  const type = new Map([['client', internal.get(false) || 0], ['internal', internal.get(true) || 0]]);
  const live = ['OPEN', 'RECRUITER_ASSIGNED', 'SOURCING', 'CANDIDATES_AVAILABLE'].reduce((n, s) => n + (status.get(s) || 0), 0);
  const statusList = finish(status, (v) => requirementStatusLabel(v) || v, q.status !== 'LIVE' ? q.status : '');
  if (live) statusList.unshift({ value: 'LIVE', label: 'Open (live)', count: live });
  return {
    total,
    facets: {
      department: finish(dept, null, q.department),
      clientId: finish(client, (v) => cname.get(v) || 'Unknown client', q.clientId),
      tlId: finish(tl, (v) => uname.get(v) || 'Unknown', q.tlId),
      recruiterId: finish(rec, (v) => uname.get(v) || 'Unknown', q.recruiterId),
      bdeId: finish(bde, (v) => uname.get(v) || 'Unknown', q.bdeId),
      status: statusList,
      priority: finish(prio, null, q.priority),
      location: finish(loc, null, q.location),
      type: finish(type, (v) => (v === 'internal' ? 'Internal' : 'Client'), q.type),
      deadline,
      qualificationId: finish(noneKey(qualF), (v) => (v === 'none' ? 'Not mapped yet' : specLabels.qual(v) || 'Unknown'), q.qualificationId),
      specialisationId: finish(noneKey(specF), (v) => (v === 'none' ? 'Not mapped yet' : specLabels.spec(v) || 'Unknown'), q.specialisationId),
    },
  };
}

// ---- candidates (the pipeline: one row per application) -------------------------
const CAND_FACETS = [
  { key: 'department', get: (r) => r.requirementDepartment },
  { key: 'clientId', get: (r) => r.clientId, label: (r) => r.clientName },
  { key: 'requirementId', get: (r) => r.requirementId, label: (r) => [r.reqCode, r.requirementTitle].filter(Boolean).join(' · ') },
  { key: 'recruiter', get: (r) => (r.recruiterName ? `name:${r.recruiterName}` : null), label: (r) => r.recruiterName, person: true },
  { key: 'tl', get: (r) => (r.tlName ? `name:${r.tlName}` : null), label: (r) => r.tlName, person: true },
  { key: 'bde', get: (r) => (r.bdeName ? `name:${r.bdeName}` : null), label: (r) => r.bdeName, person: true },
  { key: 'stage', get: (r) => (r.stageKey ? `st:${r.stageKey}` : null), label: (r) => r.currentStageLabel || r.stageKey },
  { key: 'source', get: (r) => r.source },
  { key: 'location', get: (r) => r.location },
  { key: 'notice', get: (r) => r.noticePeriod || null },
  // ATS layout v3: Status (Active / Hold / Rejected / Joined), cascading.
  { key: 'status', get: (r) => r.pipelineStatus || null },
  { key: 'hiring', get: (r) => (r.internal ? 'internal' : 'client'), label: (r) => (r.internal ? 'Internal' : 'Client') },
  // spec D: the CANDIDATE's own master qualification / specialisation.
  { key: 'qualificationId', get: (r) => r.qualificationId || 'none', label: (r) => (r.qualificationId ? r.qualificationName || 'Unknown' : 'Not mapped yet') },
  { key: 'specialisationId', get: (r) => r.specialisationId || 'none', label: (r) => (r.specialisationId ? r.specialisationName || 'Unknown' : 'Not mapped yet') },
  // cand7_ (Candidates §7): Owner = whose move it is now; Rejected before; Last
  // contact (a row can sit in several contact buckets, so get() returns a list).
  { key: 'owner', get: (r) => (['Active', 'Hold'].includes(r.pipelineStatus) ? (r.ownerUserId || 'none') : null), label: (r) => (r.ownerUserId ? (r.owner && r.owner !== '—' ? r.owner : 'Name not on file') : 'Nobody named yet') },
  { key: 'rejectedBefore', get: (r) => (r.rejectedCount > 0 ? 'yes' : 'no'), label: (r) => (r.rejectedCount > 0 ? 'Yes, rejected before' : 'Never rejected') },
  { key: 'contact', get: contactBuckets, label: null, labelOf: (v) => CONTACT_LABELS[v] || v },
  // Rejections (spec 2026-10-03 §A1): on rejected rows only — whose decision, and the reason.
  { key: 'rejSide', get: (r) => r.rejSide || null, label: null, labelOf: (v) => REJ_SIDE_LABELS[v] || v },
  { key: 'rejReason', get: (r) => r.rejReason || null },
];
const REJ_SIDE_LABELS = {
  Client: 'Client', Internal: 'Our team', Candidate: 'Candidate said no', none: 'Not recorded',
};
const CONTACT_LABELS = {
  never: 'Never contacted', stale3: 'Not contacted in 3 days', not_followed: 'Not followed up', due_today: 'Follow-up due today', followed: 'Followed up',
};
function contactBuckets(r) {
  const out = [];
  if (!r.lastContactAt) out.push('never');
  if (!r.lastContactAt || r.lastContactDays >= 3) out.push('stale3');
  if (r.contactBadge && CONTACT_LABELS[r.contactBadge.key]) out.push(r.contactBadge.key);
  return out;
}

async function candidateFacets(user, q) {
  // eslint-disable-next-line global-require
  const cand = require('../routes/candidates');
  if (typeof cand.pipelineRowsFor !== 'function') return { facets: {}, total: null };
  const built = await cand.pipelineRowsFor(user);
  let rows = built.rows || [];
  // The sub-tab the screen is on (Active / Hold / Selected …) narrows the
  // counted rows too, so an option count matches what the tab can show.
  if (typeof cand.inPipelineSub === 'function' && typeof cand.normaliseViewSub === 'function' && q.view !== 'master') {
    const { sub } = cand.normaliseViewSub(q.view, q.sub);
    rows = rows.filter((r) => cand.inPipelineSub(sub, r));
  }
  const search = String(q.search || '').trim().toLowerCase();
  // Person filters resolve through attribution (utils/workers.js) — once per
  // distinct combination.
  const attCache = new Map();
  const personIds = async (qq) => {
    if (!hasPersonQuery(qq)) return null;
    const key = JSON.stringify([qq.recruiter, qq.tl, qq.bde, qq.positionCode]);
    if (!attCache.has(key)) attCache.set(key, attributedApplications(user, qq).then((a) => (a ? a.ids : null)));
    return attCache.get(key);
  };
  const match = (r, qq, ctx) => cand.pipelineRowMatches(r, qq, ctx);
  const facets = {};
  for (const f of CAND_FACETS) {
    const qq = without(q, f.key === 'recruiter' ? ['recruiter', 'positionCode'] : [f.key]);
    // eslint-disable-next-line no-await-in-loop
    const ctx = { search, personIds: await personIds(qq) };
    const counts = new Map();
    const labels = new Map();
    rows.forEach((r) => {
      if (!match(r, qq, ctx)) return;
      const got = f.get(r);
      (Array.isArray(got) ? got : [got]).forEach((v) => {
        if (v === null || v === undefined || v === '') return;
        counts.set(v, (counts.get(v) || 0) + 1);
        if (f.label && !labels.has(v)) labels.set(v, f.label(r) || String(v));
      });
    });
    facets[f.key] = finish(counts, (v) => labels.get(v) || (f.labelOf ? f.labelOf(v) : String(v)), q[f.key]);
  }
  const ctxAll = { search, personIds: await personIds(q) };
  const total = rows.filter((r) => match(r, q, ctxAll)).length;
  return { facets, total };
}

async function facetsFor(module, user, q) {
  if (module === 'requirements') return requirementFacets(user, q);
  if (module === 'candidates') return candidateFacets(user, q);
  // Reports (section 17): counted over the report's own rows — routes/atsReports.js.
  if (module === 'reports') return require('../routes/atsReports').reportFacets(user, q); // eslint-disable-line global-require
  return null;
}

module.exports = { facetsFor };
