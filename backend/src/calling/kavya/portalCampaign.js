// ---------------------------------------------------------------------------
// The Job Portal's bulk "Start AI Calls" button, answered by Kavya (2026-11-14).
//
// The portal page sends { jobId: 'tl_<requirementId>', candidates: [{ id, name, phone, email }] } through the portal door
// (/api/ai-calling/portal/kavya-campaign: bridge secret + the signed-in recruiter's e-mail, so every role / scope / consent /
// DND / Off-Test-Live / test-number rule of AI Calling applies to THAT recruiter).
// Portal candidates are mapped to TeamLink applications by phone / e-mail (the same match the bridge uses when an application
// arrives); Kavya's createRuns() then judges each person. The answer says, per portal candidate, what happened:
//   { campaign: { id, jobId, queued, skipped }, queued: [{ candidateId, applicationId }], skipped: [{ candidateId, reason }] }
// ---------------------------------------------------------------------------
const prisma = require('../../db');
const bridge = require('../../utils/jobPortalBridge');
const kavya = require('./service');

const { PORTAL_APPLICATION_SOURCE } = require('../../utils/atsVocab');

const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
const MAX = 200;

// The requirement Kavya talks about: the TeamLink requirement behind a "tl_<id>" portal job, otherwise an OPEN internal requirement made
// once per portal job (reqCode PORTAL-<job id>) from the job's own details, so the Job Portal's own jobs can be called too.
async function ensureRequirement(user, jobId, job) {
  const tl = String(jobId).startsWith('tl_') ? String(jobId).slice(3) : '';
  if (tl) {
    const r = await prisma.requirement.findUnique({ where: { id: tl }, include: { client: true } });
    if (r) return r;
  }
  const code = `PORTAL-${clip(jobId, 60)}`;
  const had = await prisma.requirement.findUnique({ where: { reqCode: code }, include: { client: true } });
  if (had) return had;
  const title = clip(job.title, 160);
  if (title.length < 2) throw new Error('the job title is missing');
  let client = await prisma.client.findFirst({ where: { name: 'Job Portal (own jobs)' } });
  if (!client) client = await prisma.client.create({ data: { name: 'Job Portal (own jobs)' } });
  const skills = Array.isArray(job.skills) ? job.skills.filter(Boolean).join(', ') : clip(job.skills, 400);
  return prisma.requirement.create({
    data: {
      title, clientId: client.id, status: 'OPEN', internal: true, hiringType: 'TeamLink Internal Hire', reqCode: code,
      location: clip(job.location, 120) || null, experience: clip(job.experience, 40) || null, salary: clip(job.salary, 60) || null,
      employmentType: clip(job.employmentType, 40) || undefined, skills: skills || null, education: clip(job.education, 120) || undefined,
      description: clip(job.description, 4000) || null, recruiterId: user.id,
    },
    include: { client: true },
  });
}

async function placeCampaign(user, body) {
  const b = body || {};
  const jobId = clip(b.jobId, 80);
  const list = (Array.isArray(b.candidates) ? b.candidates : []).slice(0, 500);
  if (!list.length) return { ok: false, status: 400, code: 'none', error: 'Tick at least one candidate.' };
  if (list.length > MAX) return { ok: false, status: 400, code: 'too_many', error: `Kavya takes up to ${MAX} candidates at a time.` };
  const skipped = [];
  const job = b.job && typeof b.job === 'object' ? b.job : {};
  let requirement = null;
  try { requirement = await ensureRequirement(user, jobId, job); } catch (err) {
    list.forEach((c) => skipped.push({ candidateId: clip(c && c.id, 80), reason: `The job could not be prepared for Kavya: ${err.message}` }));
    return { ok: false, status: 422, code: 'no_requirement', error: `The job could not be prepared for Kavya: ${err.message}`, skipped };
  }

  const byApp = new Map(); // applicationId -> portal candidate id
  for (const c of list) { // eslint-disable-line no-restricted-syntax
    const pid = clip(c && c.id, 80);
    try {
      // eslint-disable-next-line no-await-in-loop
      let cand = await bridge.findCandidateByContact({ email: c && c.email, phone: c && c.phone });
      // eslint-disable-next-line no-await-in-loop
      if (!cand) cand = await prisma.candidate.create({ data: { name: clip(c && c.name, 120) || 'Candidate', email: clip(c && c.email, 200) || null, phone: clip(c && c.phone, 30) || null, source: 'Job Portal', firstSource: PORTAL_APPLICATION_SOURCE, location: clip(c && c.location, 120) || null, currentDesignation: clip(c && c.title, 120) || null } });
      // eslint-disable-next-line no-await-in-loop
      let app = await prisma.application.findUnique({ where: { candidateId_requirementId: { candidateId: cand.id, requirementId: requirement.id } }, select: { id: true } });
      // eslint-disable-next-line no-await-in-loop
      if (!app) app = await prisma.application.create({ data: { candidateId: cand.id, requirementId: requirement.id, stage: 'NEW', source: PORTAL_APPLICATION_SOURCE, ownerRecruiterId: user.id }, select: { id: true } });
      if ([...byApp.values()].includes(pid)) continue;
      byApp.set(app.id, pid);
    } catch (err) { skipped.push({ candidateId: pid, reason: `Could not be added to the job in TeamLink: ${clip(err.message, 120)}` }); }
  }
  if (!byApp.size) return { ok: false, status: 422, code: 'nobody', error: 'Nobody on the list can be called by Kavya.', skipped };

  const r = await kavya.createRuns(user, { applicationIds: [...byApp.keys()], source: 'portal', start: true });
  const back = (arr) => (arr || []).map((s) => ({ candidateId: byApp.get(s.applicationId) || clip(s.applicationId, 80), reason: s.reason || r.error || 'Not allowed.' }));
  if (r.ok === false) return { ok: false, status: r.status || 422, code: r.code, error: r.error, skipped: [...skipped, ...back(r.skipped)] };
  const skippedApps = new Set((r.skipped || []).map((s) => s.applicationId));
  const queued = [...byApp.entries()].filter(([appId]) => !skippedApps.has(appId)).map(([appId, pid]) => ({ candidateId: pid, applicationId: appId, runId: r.id }));
  const allSkipped = [...skipped, ...back(r.skipped)];
  return { ok: true, campaign: { id: r.id, jobId, queued: queued.length, skipped: allSkipped.length }, queued, skipped: allSkipped, note: r.note || '' };
}

module.exports = { placeCampaign };
