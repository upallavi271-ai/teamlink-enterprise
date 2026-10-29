// ---------------------------------------------------------------------------
// WHOSE CANDIDATE IS IT (founder 2026-10-26): "portal nunchi vachina, ekkada nunchi vachina, ey site nunchi vachina, ahh respective
// recruiter & tl daggara ki vellali. inka evariki kanipinchakudadhu."
//
// Every application has ONE recruiter (Application.ownerRecruiterId). A recruiter who adds the person owns it. Anything else -
// the Job Portal, the careers page, a job board, the candidate portal, an import, a TL / BDE / Admin adding someone - goes to the
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
const onJob = (requirement, userId) => !!userId && !!requirement
  && (requirement.recruiterId === userId || csv(requirement.recruiterIds).includes(userId));

// Prisma middleware (db.js): an application created without an owner gets the requirement's recruiter. Never throws.
async function before(prisma, params) {
  if (params.model !== 'Application' || params.action !== 'create') return;
  const data = params.args && params.args.data;
  if (!data || data.ownerRecruiterId) return;
  const reqId = data.requirementId || (data.requirement && data.requirement.connect && data.requirement.connect.id);
  if (!reqId) return;
  const r = await prisma.requirement.findUnique({ where: { id: reqId }, select: { recruiterId: true, recruiterIds: true } });
  const owner = defaultOwnerOf(r);
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
// Express: warm the names before a router shapes candidate rows (never blocks on an error).
const warmMiddleware = (req, res, next) => { warmNames().then(() => next(), () => next()); };
// { id, name } of the recruiter of THIS application: its owner; the requirement's recruiter only when it has no owner.
function ownerRecruiter(app) {
  if (!app) return null;
  const id = app.ownerRecruiterId || null;
  const name = app.ownerRecruiterName || (id && NAMES.get(id)) || null;
  if (id && name) return { id, name };
  const r = app.requirement;
  return r && r.recruiter && r.recruiter.name ? { id: r.recruiter.id || r.recruiterId || null, name: r.recruiter.name } : null;
}

module.exports = { defaultOwnerOf, onJob, before, csv, warmNames, warmMiddleware, ownerRecruiter };
