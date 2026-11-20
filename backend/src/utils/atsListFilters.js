// ---------------------------------------------------------------------------
// THE EXTRA FILTERS OF THE OTHER ATS LISTS (founder 2026-11-18: "every list in the ATS should have its filters").
// Every function only NARROWS what the list's own scope already allows; none widens it. The candidate lists are in
// utils/candidateFilters.js. Parameters (all optional):
//
//   Requirements   daysOpenMin daysOpenMax  openLeftMin openLeftMax  ctcMin ctcMax (lakh, overlaps the job's band)
//                  industry (csv, client industry)  posted=yes|no  workMode (csv)
//   Clients        priority (csv)  agreementStatus (csv)  industry (csv)  reqMin reqMax  hasJoinings=yes|no  createdFrom createdTo
//   Interviews     ivFrom ivTo  ivStatus ivRound ivMode (csv)  ivInterviewer  ivClient  ivRecruiter
//   Follow-ups     fuDue=today|overdue|week|none  fuType (csv, how it was done)  fuPriority (csv)  fuOwner (csv user ids)
//                  fuFrom fuTo (a due-date range, IST days, both ends included)  fuCandidate  fuRequirement
//   Job Portal     jpSource (csv)  jpFrom jpTo  jpStatus (csv)  jpRecruiter  jpLocation
//   Call lists     source (name / file)  from to (the list's day)  owner  -- in calllist/service.js
// ---------------------------------------------------------------------------
const prisma = require('../db');

const DAY = 86400000;
const csv = (v) => String(v === undefined || v === null ? '' : v).split(',').map((x) => x.trim()).filter(Boolean);
const num = (v) => { if (v === undefined || v === null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const inRange = (n, lo, hi) => (lo === null && hi === null) || (n !== null && n !== undefined && (lo === null || n >= lo) && (hi === null || n <= hi));
const DAY_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const istStart = (d) => new Date(`${d}T00:00:00+05:30`);
const istEnd = (d) => new Date(`${d}T23:59:59.999+05:30`);
const istDay = (v) => { const t = new Date(v).getTime(); return Number.isFinite(t) ? new Date(t + 5.5 * 3600e3).toISOString().slice(0, 10) : null; };
const idTerm = (ids) => ({ id: { in: ids.length ? ids : ['__none__'] } });
const JOINED = ['JOINED', 'HIRED'];
// "₹14L - ₹20L", "14-20 LPA", "12 LPA" -> [14, 20]; null when no number
function bandOf(text) {
  const nums = [];
  String(text || '').toLowerCase().replace(/,/g, '').replace(/₹/g, '').split(/\s*(?:-|–|to)\s*/).forEach((part) => {
    const m = /(\d+(?:\.\d+)?)\s*(l|lakh|lpa|k|cr)?/.exec(part);
    if (!m) return;
    let n = Number(m[1]);
    if (m[2] === 'cr') n *= 100;
    else if (m[2] === 'k') n = (n * 1000 * 12) / 100000;
    else if (!m[2] && n >= 1000) n /= 100000;
    nums.push(n);
  });
  return nums.length ? [Math.min(...nums), Math.max(...nums)] : null;
}

// ---- Requirements -------------------------------------------------------------------------------------------------
async function requirementTerms(q, user) {
  const and = [];
  const dMin = num(q.daysOpenMin); const dMax = num(q.daysOpenMax);
  if (dMin !== null) and.push({ createdAt: { lte: new Date(Date.now() - dMin * DAY) } });
  if (dMax !== null) and.push({ createdAt: { gt: new Date(Date.now() - (dMax + 1) * DAY) } });
  const lMin = num(q.openLeftMin); const lMax = num(q.openLeftMax);
  const cMin = num(q.ctcMin); const cMax = num(q.ctcMax);
  if (lMin !== null || lMax !== null || cMin !== null || cMax !== null) {
    // eslint-disable-next-line global-require
    const { requirementWhere } = require('./scope');
    const [reqs, joined] = await Promise.all([
      prisma.requirement.findMany({ where: requirementWhere(user), select: { id: true, openings: true, salary: true } }),
      lMin !== null || lMax !== null ? prisma.application.groupBy({ by: ['requirementId'], where: { stage: { in: JOINED } }, _count: { _all: true } }) : [],
    ]);
    const joinedBy = new Map(joined.map((j) => [j.requirementId, j._count._all]));
    const ids = reqs.filter((r) => {
      if (lMin !== null || lMax !== null) {
        const left = Math.max(0, (r.openings || 1) - (joinedBy.get(r.id) || 0));
        if (!inRange(left, lMin, lMax)) return false;
      }
      if (cMin !== null || cMax !== null) {
        const b = bandOf(r.salary);
        if (!b) return false;
        if ((cMin !== null && b[1] < cMin) || (cMax !== null && b[0] > cMax)) return false;
      }
      return true;
    }).map((r) => r.id);
    and.push(idTerm(ids));
  }
  const ind = csv(q.industry);
  if (ind.length) and.push({ OR: ind.map((i) => ({ client: { is: { industry: { contains: i } } } })) });
  if (q.workMode) and.push({ workMode: { in: csv(q.workMode) } });
  if (q.posted === 'yes' || q.posted === 'no') {
    const po = await require('../jobPublish/postedOn').idsFor(q.posted === 'yes' ? 'any' : 'none').catch(() => null); // eslint-disable-line global-require
    if (po && po.include) and.push(idTerm(po.include));
    else if (po && po.exclude) and.push({ id: { notIn: po.exclude } });
  }
  return and;
}

// ---- Clients -------------------------------------------------------------------------------------------------------
async function clientTerms(q, user) {
  const and = [];
  // eslint-disable-next-line global-require
  const level = require('./clientRedact').clientLevelFor(user);
  const mayOverview = ['full', 'basics', 'names'].includes(level);
  // eslint-disable-next-line global-require
  const blind = require('./agreementPrivacy').blindTo(user);
  if (mayOverview && q.priority) and.push({ priority: { in: csv(q.priority) } });
  if (mayOverview && q.industry) and.push({ OR: csv(q.industry).map((i) => ({ industry: { contains: i } })) });
  if (!blind && q.agreementStatus) and.push({ agreementStatus: { in: csv(q.agreementStatus) } });
  // the day the client was added (IST days, both ends included)
  if (q.createdFrom && DAY_RE.test(String(q.createdFrom))) and.push({ createdAt: { gte: istStart(q.createdFrom) } });
  if (q.createdTo && DAY_RE.test(String(q.createdTo))) and.push({ createdAt: { lte: istEnd(q.createdTo) } });
  const rMin = num(q.reqMin); const rMax = num(q.reqMax);
  if (rMin !== null || rMax !== null) {
    // eslint-disable-next-line global-require
    const { requirementWhere } = require('./scope');
    const by = await prisma.requirement.groupBy({ by: ['clientId'], where: requirementWhere(user), _count: { _all: true } });
    const counts = new Map(by.map((b) => [b.clientId, b._count._all]));
    if (rMin !== null && rMin > 0) and.push(idTerm([...counts.entries()].filter(([, n]) => inRange(n, rMin, rMax)).map(([id]) => id)));
    else {
      // "0 to N": clients with no requirement count too -> exclude the ones above N
      const tooMany = [...counts.entries()].filter(([, n]) => !inRange(n, rMin, rMax)).map(([id]) => id);
      if (tooMany.length) and.push({ id: { notIn: tooMany } });
    }
  }
  if (q.hasJoinings === 'yes' || q.hasJoinings === 'no') {
    // eslint-disable-next-line global-require
    const { applicationWhere } = require('./scope');
    const apps = await prisma.application.findMany({ where: { AND: [applicationWhere(user), { stage: { in: JOINED } }] }, select: { requirement: { select: { clientId: true } } } });
    const ids = [...new Set(apps.map((a) => a.requirement && a.requirement.clientId).filter(Boolean))];
    and.push(q.hasJoinings === 'yes' ? idTerm(ids) : { id: { notIn: ids } });
  }
  return and;
}

// ---- Interviews (the calendar's recruitment interviews) --------------------------------------------------------------
function calendarTerms(q) {
  const and = [];
  if (q.ivFrom && DAY_RE.test(String(q.ivFrom))) and.push({ interviewAt: { gte: istStart(q.ivFrom) } });
  if (q.ivTo && DAY_RE.test(String(q.ivTo))) and.push({ interviewAt: { lte: istEnd(q.ivTo) } });
  if (q.ivStatus) and.push({ interviewStatus: { in: csv(q.ivStatus) } });
  const rounds = csv(q.ivRound).map(Number).filter(Number.isFinite);
  if (rounds.length) and.push({ interviewRound: { in: rounds } });
  if (q.ivMode) and.push({ interviewMode: { in: csv(q.ivMode) } });
  if (q.ivInterviewer) and.push({ interviewer: { contains: String(q.ivInterviewer).trim() } });
  if (q.ivClient) and.push({ requirement: { is: { clientId: String(q.ivClient) } } });
  if (q.ivRecruiter) and.push({ OR: [{ ownerRecruiterId: String(q.ivRecruiter) }, { requirement: { is: { recruiterId: String(q.ivRecruiter) } } }] });
  return and;
}

// ---- Follow-ups --------------------------------------------------------------------------------------------------------
const FU_KEYS = ['fuDue', 'fuFrom', 'fuTo', 'fuType', 'fuPriority', 'fuOwner', 'fuCandidate', 'fuRequirement'];
function followUpFilter(q, rows) {
  if (!FU_KEYS.some((k) => q[k])) return rows;
  const today = istDay(new Date());
  const week = istDay(Date.now() + 7 * DAY);
  const types = csv(q.fuType).map((x) => x.toLowerCase());
  const prios = csv(q.fuPriority).map((x) => x.toLowerCase());
  const owners = csv(q.fuOwner);
  const cand = String(q.fuCandidate || '').trim().toLowerCase();
  const req = String(q.fuRequirement || '').trim().toLowerCase();
  return rows.filter((f) => {
    const due = f.dueDate ? String(f.dueDate).slice(0, 10) : '';
    if (q.fuDue === 'today' && due !== today) return false;
    if (q.fuDue === 'overdue' && !(f.status === 'Overdue' || (due && due < today && f.status !== 'Completed'))) return false;
    if (q.fuDue === 'week' && !(due && due >= today && due <= week)) return false;
    if (q.fuDue === 'none' && due) return false;
    // a due-date range (IST days, both ends included): a follow-up without a due date is in no range
    if ((q.fuFrom && DAY_RE.test(String(q.fuFrom))) || (q.fuTo && DAY_RE.test(String(q.fuTo)))) {
      if (!due || (q.fuFrom && DAY_RE.test(String(q.fuFrom)) && due < String(q.fuFrom)) || (q.fuTo && DAY_RE.test(String(q.fuTo)) && due > String(q.fuTo))) return false;
    }
    if (types.length && !types.includes(String(f.contactMode || 'not set').toLowerCase())) return false;
    if (prios.length && !prios.includes(String(f.requirementPriority || '').toLowerCase())) return false;
    if (owners.length && !owners.includes(f.ownerUserId)) return false;
    if (cand && !(`${f.candidateName || ''} ${f.candidateId || ''}`.toLowerCase().includes(cand))) return false;
    if (req && !(`${f.requirementTitle || ''} ${f.requirementCode || ''} ${f.requirementId || ''}`.toLowerCase().includes(req))) return false;
    return true;
  });
}

// ---- Job Portal applications (the rows GET /job-portal/applications builds) -------------------------------------------------
function portalFilter(q, rows) {
  if (!['jpSource', 'jpFrom', 'jpTo', 'jpStatus', 'jpRecruiter', 'jpLocation'].some((k) => q[k])) return rows;
  const src = csv(q.jpSource).map((x) => x.toLowerCase());
  const st = csv(q.jpStatus);
  const loc = String(q.jpLocation || '').trim().toLowerCase();
  return rows.filter((r) => {
    if (src.length && !src.includes(String(r.sourceKey || r.source || '').toLowerCase())) return false;
    const day = r.appliedAt ? istDay(r.appliedAt) : null;
    if (q.jpFrom && DAY_RE.test(String(q.jpFrom)) && !(day && day >= q.jpFrom)) return false;
    if (q.jpTo && DAY_RE.test(String(q.jpTo)) && !(day && day <= q.jpTo)) return false;
    if (st.length && !st.includes(r.portalTab)) return false;
    if (q.jpRecruiter && r.recruiterId !== String(q.jpRecruiter)) return false;
    if (loc && !String(r.location || '').toLowerCase().includes(loc)) return false;
    return true;
  });
}

module.exports = {
  requirementTerms, clientTerms, calendarTerms, followUpFilter, portalFilter, FU_KEYS, bandOf, istDay, csv, num,
};
