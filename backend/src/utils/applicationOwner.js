// ---------------------------------------------------------------------------
// WHOSE CANDIDATE IS IT (founder 2026-10-26): "portal nunchi vachina, ekkada nunchi vachina, ey site nunchi vachina, ahh respective
// recruiter & tl daggara ki vellali. inka evariki kanipinchakudadhu."
//
// Every application has ONE recruiter (Application.ownerRecruiterId). A recruiter, or a TL / STL (2026-11-28), who adds the person owns it. Anything else -
// the Job Portal, the careers page, a job board, the candidate portal, an import, a BDE / Admin adding someone - goes to the
// requirement's own recruiter: the main recruiter, else the first one assigned. Only that recruiter and the requirement's TL (and
// the roles above) see it (utils/scope.js). When the requirement's recruiters change, routes/requirements.js hands the candidates
// of a recruiter who left the job to the main recruiter now.
// ---------------------------------------------------------------------------
const csv = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

// The requirement's recruiter who receives a candidate nobody on the recruiting side added.
function defaultOwnerOf(requirement) {
  if (!requirement) return null;
  return requirement.recruiterId || csv(requirement.recruiterIds)[0] || null;
}
// SHARED EVENLY (founder 2026-11-03: "avaati nunchi vachey responses evariki kanipinchalo, valla ahh recruiters assign
// chestharu"): when the TL chose "share the responses equally" for a requirement (AppSetting respsplit.<requirementId> =
// 'even', set with POST /requirements/:id/assign), a new response goes to the job's recruiter who has the fewest of its
// responses so far, in turn. Otherwise (the default) every response goes to the main recruiter, as before.
const SPLIT_PREFIX = 'respsplit.';
const splitCache = new Map(); // requirementId -> { mode, at }
async function splitModeOf(prisma, requirementId) {
  const hit = splitCache.get(requirementId);
  if (hit && Date.now() - hit.at < 30000) return hit.mode;
  const row = await prisma.appSetting.findUnique({ where: { key: SPLIT_PREFIX + requirementId } }).catch(() => null);
  const mode = row && row.value === 'even' ? 'even' : 'one';
  splitCache.set(requirementId, { mode, at: Date.now() });
  return mode;
}
async function setSplitMode(prisma, requirementId, mode) {
  const key = SPLIT_PREFIX + requirementId;
  if (mode === 'even') await prisma.appSetting.upsert({ where: { key }, create: { key, value: 'even' }, update: { value: 'even' } });
  else await prisma.appSetting.deleteMany({ where: { key } });
  splitCache.set(requirementId, { mode: mode === 'even' ? 'even' : 'one', at: Date.now() });
}
async function evenOwnerOf(prisma, requirementId, requirement) {
  const team = [...new Set([requirement.recruiterId, ...csv(requirement.recruiterIds)].filter(Boolean))];
  if (team.length < 2) return defaultOwnerOf(requirement);
  const counts = await prisma.application.groupBy({ by: ['ownerRecruiterId'], where: { requirementId, ownerRecruiterId: { in: team } }, _count: { _all: true } }).catch(() => []);
  const n = new Map(counts.map((c) => [c.ownerRecruiterId, c._count._all]));
  return team.reduce((best, id) => ((n.get(id) || 0) < (n.get(best) || 0) ? id : best), team[0]);
}
const onJob = (requirement, userId) => !!userId && !!requirement
  && (requirement.recruiterId === userId || csv(requirement.recruiterIds).includes(userId));

// Prisma middleware (db.js): an application created without an owner gets the requirement's recruiter. Never throws.
async function before(prisma, params) {
  if (params.model !== 'Application' || params.action !== 'create') return;
  const data = params.args && params.args.data;
  if (!data) return;
  const reqId = data.requirementId || (data.requirement && data.requirement.connect && data.requirement.connect.id);
  if (!reqId) return;
  // WHO RECEIVES THE RESPONSES (founder 2026-11-20, utils/responseRecipients.js): a response to a job whose TL ticked the
  // recipients goes to one of them (fewest open new responses, ties by name). No recipients -> the rules below, as before.
  try {
    const RR = require('./responseRecipients'); // eslint-disable-line global-require
    if (RR.isInbound(data)) {
      const to = await RR.route(prisma, reqId, data);
      if (to) { data.ownerRecruiterId = to; params.respRouted = { owner: to, requirementId: reqId }; return; }
    }
  } catch { /* the rules below */ }
  if (data.ownerRecruiterId) return;
  const r = await prisma.requirement.findUnique({ where: { id: reqId }, select: { recruiterId: true, recruiterIds: true } });
  let owner = defaultOwnerOf(r);
  try { if (r && (await splitModeOf(prisma, reqId)) === 'even') owner = await evenOwnerOf(prisma, reqId, r); } catch { /* default owner */ }
  if (owner) data.ownerRecruiterId = owner;
}

// ---- SHOWING IT (founder 2026-10-29: "owner Sneha ithey, D Sony ani endhuku vasthundhi ... ilaanti issues inka evari
// dagara repeat avvakudadhu"): wherever ONE candidate's recruiter is shown (profile, interviews, joining, owner columns),
// it is the application's OWNER, never the requirement's main recruiter. Names come from a small cache of every login
// (refreshed each minute; the routers that show candidates warm it per request, so the first request is right too).
let NAMES = new Map();
let namesAt = 0;
let loading = null;
function warmNames(maxAgeMs = 60000) {
  if (NAMES.size && Date.now() - namesAt < maxAgeMs) return Promise.resolve(NAMES);
  if (!loading) {
    loading = require('../db').user.findMany({ select: { id: true, name: true } }) // eslint-disable-line global-require
      .then((us) => { NAMES = new Map(us.map((u) => [u.id, u.name])); namesAt = Date.now(); return NAMES; })
      .catch(() => NAMES)
      .finally(() => { loading = null; });
  }
  return loading;
}
// THE SEAT NEXT TO THE NAME (founder 2026-10-30: "recruiter names correct ga ney vasthunnai, but positions wrong - EDU-3 ...
// proper ga data cross check cheskoni"): the seat shown beside a recruiter is the one THAT recruiter held (HRMS > Positions,
// PositionAssignment) on the day of the application - not the requirement's seat, which may be another recruiter's.
let SEATS = new Map(); // userId -> [{ code, from, to }]
let seatsAt = 0;
let seatsLoading = null;
function warmSeats(maxAgeMs = 60000) {
  if (seatsAt && Date.now() - seatsAt < maxAgeMs) return Promise.resolve(SEATS);
  if (!seatsLoading) {
    seatsLoading = require('../db').positionAssignment.findMany({ // eslint-disable-line global-require
      select: { fromDate: true, toDate: true, position: { select: { code: true } }, employee: { select: { userId: true } } },
    })
      .then((rows) => {
        const m = new Map();
        rows.forEach((x) => {
          const uid = x.employee && x.employee.userId;
          if (!uid || !x.position) return;
          if (!m.has(uid)) m.set(uid, []);
          m.get(uid).push({ code: x.position.code, from: String(x.fromDate || '').slice(0, 10), to: x.toDate ? String(x.toDate).slice(0, 10) : null });
        });
        SEATS = m; seatsAt = Date.now(); return SEATS;
      })
      .catch(() => SEATS)
      .finally(() => { seatsLoading = null; });
  }
  return seatsLoading;
}
// the seat this login held on that day (else the one they hold now, else the latest they held); null = no seat on record
function seatOf(userId, on) {
  const list = userId ? SEATS.get(userId) : null;
  if (!list || !list.length) return null;
  const day = (on ? new Date(on) : new Date()).toISOString().slice(0, 10);
  const then = list.find((s) => s.from <= day && (!s.to || s.to >= day));
  if (then) return then.code;
  const now = list.find((s) => !s.to);
  if (now) return now.code;
  return list.slice().sort((a, b) => String(b.to).localeCompare(String(a.to)))[0].code;
}
// Express: warm the names and seats before a router shapes candidate rows (never blocks on an error).
const warmMiddleware = (req, res, next) => { Promise.all([warmNames(), warmSeats()]).then(() => next(), () => next()); };
// { id, name } of the recruiter of THIS application: its owner; the requirement's recruiter only when it has no owner.
function ownerRecruiter(app) {
  if (!app) return null;
  const id = app.ownerRecruiterId || null;
  const name = app.ownerRecruiterName || (id && NAMES.get(id)) || null;
  if (id && name) return { id, name };
  const r = app.requirement;
  return r && r.recruiter && r.recruiter.name ? { id: r.recruiter.id || r.recruiterId || null, name: r.recruiter.name } : null;
}

// a login's name from the cache (null when not known yet)
const nameOf = (id) => (id && NAMES.get(id)) || null;

module.exports = {
  nameOf, splitModeOf, setSplitMode, defaultOwnerOf, onJob, before, csv, warmNames, warmSeats, seatOf, warmMiddleware, ownerRecruiter };
