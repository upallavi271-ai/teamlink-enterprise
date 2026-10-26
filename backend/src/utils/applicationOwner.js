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

module.exports = { defaultOwnerOf, onJob, before, csv };
