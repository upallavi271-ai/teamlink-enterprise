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

const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
const MAX = 200;

async function placeCampaign(user, body) {
  const b = body || {};
  const jobId = clip(b.jobId, 80);
  const list = (Array.isArray(b.candidates) ? b.candidates : []).slice(0, 500);
  if (!list.length) return { ok: false, status: 400, code: 'none', error: 'Tick at least one candidate.' };
  if (list.length > MAX) return { ok: false, status: 400, code: 'too_many', error: `Kavya takes up to ${MAX} candidates at a time.` };
  const skipped = [];
  const requirementId = String(jobId).startsWith('tl_') ? String(jobId).slice(3) : '';
  const requirement = requirementId ? await prisma.requirement.findUnique({ where: { id: requirementId }, select: { id: true } }) : null;
  if (!requirement) {
    list.forEach((c) => skipped.push({ candidateId: clip(c && c.id, 80), reason: 'This job is not a TeamLink requirement, so Kavya cannot call about it.' }));
    return { ok: false, status: 422, code: 'no_requirement', error: 'This job is not a TeamLink requirement, so Kavya cannot call about it.', skipped };
  }

  const byApp = new Map(); // applicationId -> portal candidate id
  for (const c of list) { // eslint-disable-line no-restricted-syntax
    const pid = clip(c && c.id, 80);
    // eslint-disable-next-line no-await-in-loop
    const cand = await bridge.findCandidateByContact({ email: c && c.email, phone: c && c.phone });
    if (!cand) { skipped.push({ candidateId: pid, reason: 'Not in TeamLink yet: assign the candidate to this job first (Send to ATS).' }); continue; }
    // eslint-disable-next-line no-await-in-loop
    const app = await prisma.application.findUnique({ where: { candidateId_requirementId: { candidateId: cand.id, requirementId: requirement.id } }, select: { id: true } });
    if (!app) { skipped.push({ candidateId: pid, reason: 'Not applied / assigned to this job in TeamLink yet.' }); continue; }
    if ([...byApp.values()].includes(pid)) continue;
    byApp.set(app.id, pid);
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
