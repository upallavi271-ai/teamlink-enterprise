// ---------------------------------------------------------------------------
// REJECTIONS (spec 2026-10-03 §A) — /api/rejections
//
//   GET  /candidate/:id                  the profile's Rejection history +
//                                        "Do not use" state and requests
//   GET  /check?candidateId=&requirementId=   block / same-client warning
//                                        before someone submits or adds
//   GET  /requirement/:id/tabs           [Previously rejected, but match] and
//                                        [Rejected on this job] for the
//                                        requirement's Matching section
//   GET  /do-not-use/pending             "Do not use" requests this login decides
//   POST /do-not-use/:stepId/decide      { decision: approve | decline, note }
//
// Internal logins only: a rejection's reasoning is TeamLink's working record
// and is never served to a client or a candidate. Every list is scoped by
// utils/scope.js; a rejection on another team's job is COUNTED, never
// described. Clients appear by NAME only.
//
// The data is the existing rejection record (utils/rejections.js); the match
// numbers are the ONE scorer (utils/resumeMatch.js threeNumbers).
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm, requireProduct, can } = require('../middleware/auth');
const {
  requirementWhere, candidateWhere, matches, OUT_OF_SCOPE,
} = require('../utils/scope');
const { stageGlobal } = require('../utils/permissions');
const { requirementIsLive, REQUIREMENT_LIVE_STATUSES } = require('../utils/atsVocab');
const { logAudit } = require('../utils/audit');
const { notifyUsers } = require('../utils/notify');
const rm = require('../utils/resumeMatch');
const rj = require('../utils/rejections');

const router = express.Router();
router.use(requireAuth);
router.use(requireProduct('ats'));

const cand = () => require('./candidates'); // eslint-disable-line global-require
function internalOnly(req, res, next) {
  if (cand().viewerKind(req.user) !== 'internal') return res.status(403).json({ error: 'Rejection details are internal to TeamLink.' });
  return next();
}
router.use(internalOnly);

async function requirementInScope(req, res, id) {
  const requirement = await prisma.requirement.findUnique({
    where: { id },
    include: { client: { select: { id: true, name: true } } },
  });
  if (!requirement) { res.status(404).json({ error: 'Requirement not found' }); return null; }
  if (!matches(requirement, requirementWhere(req.user))) { res.status(403).json(OUT_OF_SCOPE); return null; }
  return requirement;
}

// --- "Still a good fit for": other OPEN jobs a rejected person matches -------
// The ONE scorer (utils/resumeMatch.js threeNumbers, each job's own minimum
// Fit %), over the open jobs inside this login's area. A job the person is
// already on is left out; a job whose CLIENT rejected them before is not
// offered as a fit — that client is named apart, in red. Client NAME only.
const FIT_REQ_SELECT = {
  id: true, reqCode: true, title: true, internal: true, location: true, status: true,
  skills: true, goodToHaveSkills: true, experience: true, education: true, workMode: true, employmentType: true,
  salary: true, joiningTimeline: true, jobPreference: true, clientId: true, specialisationId: true,
  department: true,
  client: { select: { name: true } },
};
const openJobsCache = new Map(); // scope key -> { at, rows }
async function openJobsFor(user) {
  const key = JSON.stringify([user.id, user.role, user.atsRole, user.atsScopeDepartments, user.atsScopeTeams, user.atsScopeClients, user.department, user.team]);
  const hit = openJobsCache.get(key);
  if (hit && Date.now() - hit.at < 2 * 60 * 1000) return hit.rows;
  const rows = await prisma.requirement.findMany({
    where: { AND: [{ status: { in: REQUIREMENT_LIVE_STATUSES } }, requirementWhere(user)] },
    select: { ...FIT_REQ_SELECT, ...(rm.minFitSupported() ? { minFit: true } : {}) },
  });
  if (openJobsCache.size > 200) openJobsCache.clear();
  openJobsCache.set(key, { at: Date.now(), rows });
  return rows;
}
async function stillFits(user, candidateIds, perCandidate = 3) {
  const ids = [...new Set(candidateIds)].slice(0, 50);
  if (!ids.length) return new Map();
  const [jobs, cands, apps, evidence, ix] = await Promise.all([
    openJobsFor(user),
    prisma.candidate.findMany({ where: { AND: [{ id: { in: ids } }, candidateWhere(user)] }, select: MATCH_SELECT }),
    prisma.application.findMany({ where: { candidateId: { in: ids } }, select: { candidateId: true, requirementId: true, requirement: { select: { department: true } } } }),
    rm.currentResumeEvidence(ids),
    rj.index(),
  ]);
  const onJob = new Map();
  // Only the departments this person was put forward in (a nurse is not "a
  // good fit" for every IT opening just because the job lists no skills) —
  // the same rule as the profile's "still eligible for" card.
  const depts = new Map();
  apps.forEach((a) => {
    if (!onJob.has(a.candidateId)) onJob.set(a.candidateId, new Set());
    onJob.get(a.candidateId).add(a.requirementId);
    const d = a.requirement && a.requirement.department;
    if (d) { if (!depts.has(a.candidateId)) depts.set(a.candidateId, new Set()); depts.get(a.candidateId).add(d); }
  });
  const out = new Map();
  cands.forEach((c) => {
    const blocked = c.profileStatus === rj.DNU_STATUS;
    const recs = ix.byCandidate.get(c.id) || [];
    const rejecting = new Map();
    recs.forEach((x) => { if (x.clientId && x.side === 'Client' && !rejecting.has(x.clientId)) rejecting.set(x.clientId, x); });
    const mine = onJob.get(c.id) || new Set();
    const myDepts = depts.get(c.id) || null;
    const fits = [];
    const sameClient = new Map();
    if (!blocked) {
      jobs.forEach((r) => {
        if (mine.has(r.id)) return;
        if (myDepts && !myDepts.has(r.department)) return;
        const m = rm.threeNumbers(c, r, evidence.get(c.id));
        // ELIGIBLE only (change list §9): Fit at or above the job's minimum,
        // no must-have skill missing, location fits.
        if (!m.eligible) return;
        const clientName = r.internal ? 'TeamLink internal' : (r.client && r.client.name) || null;
        if (!r.internal && r.clientId && rejecting.has(r.clientId)) {
          if (!sameClient.has(r.clientId)) sameClient.set(r.clientId, { clientName, warning: rj.sameClientWarning(rejecting.get(r.clientId)), jobs: 0 });
          sameClient.get(r.clientId).jobs += 1;
          return;
        }
        fits.push({
          requirementId: r.id, reqCode: r.reqCode, title: r.title, clientName, location: r.location,
          overall: m.overall, eligible: m.eligible,
        });
      });
    }
    fits.sort((a, b) => (Number(b.eligible) - Number(a.eligible)) || (b.overall - a.overall));
    out.set(c.id, {
      blocked,
      total: fits.length,
      clients: new Set(fits.map((f) => f.clientName)).size,
      top: fits.slice(0, perCandidate),
      rejectedClients: [...sameClient.values()],
    });
  });
  return out;
}
router.get('/still-fits', async (req, res) => {
  const ids = String(req.query.ids || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 50);
  const per = Math.min(10, Math.max(1, Number(req.query.per) || 3));
  const fits = await stillFits(req.user, ids, per);
  return res.json({ rows: Object.fromEntries(fits) });
});

// --- Candidate profile: Rejection history -----------------------------------
router.get('/candidate/:id', async (req, res) => {
  const loaded = await cand().loadInScope(req, res);
  if (!loaded) return undefined;
  const { candidate } = loaded;
  const hist = (await rj.scopedHistory(req.user, [candidate.id])).get(candidate.id)
    || { count: 0, visible: [], hiddenCount: 0, doNotUse: null };
  // The live "Do not use" requests on this person, with who may decide.
  const ix = await rj.index();
  const all = ix.byCandidate.get(candidate.id) || [];
  const requests = [];
  for (const x of all) {
    if (!x.dnu || x.dnu.status !== 'Pending') continue;
    // eslint-disable-next-line no-await-in-loop
    const step = await prisma.approvalStep.findUnique({ where: { id: x.dnu.stepId } });
    // eslint-disable-next-line no-await-in-loop
    const mayDecide = await rj.canDecide(req.user, step);
    requests.push({
      stepId: x.dnu.stepId, requirementTitle: x.requirementTitle, clientName: x.clientName,
      reason: x.reason, detail: x.detail, requestedBy: x.by, at: x.at, approverName: x.dnu.approverName, canDecide: mayDecide,
    });
  }
  return res.json({
    candidateId: candidate.id,
    name: candidate.name,
    profileStatus: candidate.profileStatus,
    doNotUse: hist.doNotUse,
    total: hist.count,
    hiddenCount: hist.hiddenCount,
    history: hist.visible,
    requests,
    dnuReasons: rj.DNU_REASONS,
    canLift: candidate.profileStatus === rj.DNU_STATUS && stageGlobal(req.user),
  });
});

// --- Before submitting / adding: block + same-client warning ----------------
router.get('/check', async (req, res) => {
  const { candidateId, requirementId } = req.query;
  if (!candidateId || !requirementId) return res.status(400).json({ error: 'candidateId and requirementId are required' });
  const requirement = await requirementInScope(req, res, String(requirementId));
  if (!requirement) return undefined;
  const c = await prisma.candidate.findFirst({ where: { AND: [{ id: String(candidateId) }, candidateWhere(req.user)] }, select: { id: true, name: true } });
  if (!c) return res.status(403).json(OUT_OF_SCOPE);
  const chk = await rj.checkCandidateFor(c.id, requirement);
  return res.json({
    candidateId: c.id,
    requirementId: requirement.id,
    doNotUse: chk.doNotUse,
    blocked: chk.doNotUse === 'approved',
    sameClient: chk.sameClient.map((x) => ({ clientName: x.clientName, requirementTitle: x.requirementTitle, reason: x.reason, at: x.at, sideLabel: x.sideLabel })),
    warning: chk.warning,
  });
});

// --- Requirement → Matching Candidates: the two NEW tabs --------------------
const MATCH_SELECT = {
  id: true, name: true, location: true, preferredLocation: true, experienceYears: true, relevantExperienceYears: true,
  skills: true, education: true, availability: true, currentSalary: true, expectedSalary: true, jobPreference: true,
  noticePeriod: true, preferredEmploymentType: true, preferredWorkMode: true, profileStatus: true,
  specialisationId: true, // spec D: exact specialisation match bonus
  specialization: true, // free-text specialisation: the job's must-have when it lists no skills (matching.js)
};
router.get('/requirement/:id/tabs', requirePerm('ats', 'requirements', 'Matching Candidates', 'view'), async (req, res) => {
  const requirement = await requirementInScope(req, res, req.params.id);
  if (!requirement) return undefined;
  const opts = rm.listOptions(req.query);
  const ix = await rj.index();

  // [Rejected on this job] — the post-mortem.
  const here = (ix.byRequirement.get(requirement.id) || []).slice().sort((a, b) => new Date(b.at) - new Date(a.at));
  const hereNames = new Map((here.length ? await prisma.candidate.findMany({
    where: { id: { in: here.map((x) => x.candidateId).slice(0, 2000) } }, select: { id: true, name: true },
  }) : []).map((c) => [c.id, c.name]));
  const count = (list, key) => {
    const m = new Map();
    list.forEach((x) => { const k = key(x) || 'Not recorded'; m.set(k, (m.get(k) || 0) + 1); });
    return [...m.entries()].map(([label, n]) => ({ label, count: n })).sort((a, b) => b.count - a.count);
  };
  const rejectedHere = {
    total: here.length,
    byReason: count(here, (x) => x.reason),
    bySide: count(here, (x) => x.sideLabel),
    rows: here.slice(0, 200).map((x) => ({
      candidateId: x.candidateId, name: hereNames.get(x.candidateId) || '—', ...rj.publicRecord(x),
    })),
  };

  // [Previously rejected, but match] — rejected on ANOTHER requirement, not
  // already on this one, inside this login's candidate scope.
  const linked = new Set((await prisma.application.findMany({
    where: { requirementId: requirement.id }, select: { candidateId: true },
  })).map((a) => a.candidateId));
  const prevIds = [];
  ix.byCandidate.forEach((list, cid) => {
    if (linked.has(cid)) return;
    if (list.some((x) => x.requirementId !== requirement.id)) prevIds.push(cid);
  });
  const pool = [];
  for (let i = 0; i < prevIds.length; i += 400) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await prisma.candidate.findMany({
      where: { AND: [{ id: { in: prevIds.slice(i, i + 400) } }, candidateWhere(req.user)] },
      select: MATCH_SELECT,
    });
    pool.push(...rows);
  }
  const evidence = await rm.currentResumeEvidence(pool.map((c) => c.id));
  let scored = pool.map((c) => ({ c, match: rm.threeNumbers(c, requirement, evidence.get(c.id)) }))
    .filter((x) => x.match.overall >= opts.minMatch);
  const total = scored.length;
  if (opts.eligibleOnly) scored = scored.filter((x) => x.match.eligible);
  rm.sortRows(scored, opts.sort);
  const page = scored.slice(0, opts.limit);
  const hist = await rj.scopedHistory(req.user, page.map((x) => x.c.id));
  const canAdd = requirementIsLive(requirement.status) && await can(req.user, 'ats', 'candidates', 'Applications', 'create');
  const rows = page.map(({ c, match }) => {
    const h = hist.get(c.id) || { visible: [], hiddenCount: 0, count: 0, doNotUse: null };
    const allRecs = (ix.byCandidate.get(c.id) || []).filter((x) => x.requirementId !== requirement.id);
    const same = requirement.internal ? [] : allRecs.filter((x) => x.side === 'Client' && x.clientId && x.clientId === requirement.clientId);
    const latest = h.visible[0] || null;
    const latestRaw = latest ? allRecs.find((x) => x.applicationId === latest.applicationId) : null;
    const doNotUse = c.profileStatus === rj.DNU_STATUS ? 'approved' : (h.doNotUse || null);
    return {
      id: c.id,
      name: c.name,
      location: c.location,
      experienceYears: c.experienceYears,
      match,
      rejections: h.visible.slice(0, 5),
      rejectedTimes: h.count,
      hiddenCount: h.hiddenCount,
      doNotUse,
      blocked: doNotUse === 'approved',
      sameClient: same.length ? rj.sameClientWarning(same[0]) : null,
      mayNotApply: latestRaw && !same.length ? rj.reasonMayNotApply(latestRaw, requirement, c) : null,
    };
  });
  return res.json({
    requirementId: requirement.id,
    threshold: rm.ELIGIBLE_THRESHOLD,
    ...opts,
    canAdd,
    previouslyRejected: { total, shown: rows.length, rows },
    rejectedHere,
  });
});

// --- "Do not use": the TL's decision -----------------------------------------
async function pendingFor(user) {
  const steps = await prisma.approvalStep.findMany({
    where: { workflow: rj.DNU_WORKFLOW, status: 'Pending' },
    orderBy: { createdAt: 'asc' },
  });
  const out = [];
  for (const s of steps) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await rj.canDecide(user, s))) continue;
    // eslint-disable-next-line no-await-in-loop
    const ev = await prisma.applicationStageEvent.findUnique({
      where: { id: s.recordId },
      select: {
        candidateId: true, requirementTitle: true, clientName: true, reasonCategory: true, reasonDetail: true, actorName: true, createdAt: true,
        candidate: { select: { name: true } },
      },
    });
    if (!ev) continue;
    out.push({
      stepId: s.id, candidateId: ev.candidateId, candidateName: ev.candidate ? ev.candidate.name : '—',
      requirementTitle: ev.requirementTitle, clientName: ev.clientName, reason: ev.reasonCategory, detail: ev.reasonDetail,
      requestedBy: ev.actorName, at: ev.createdAt,
    });
  }
  return out;
}
router.get('/do-not-use/pending', async (req, res) => {
  res.json({ rows: await pendingFor(req.user) });
});

router.post('/do-not-use/:stepId/decide', async (req, res) => {
  const decision = String((req.body && req.body.decision) || '').toLowerCase();
  if (!['approve', 'decline'].includes(decision)) return res.status(400).json({ error: 'decision must be approve or decline' });
  const note = String((req.body && req.body.note) || '').trim().slice(0, 500) || null;
  const step = await prisma.approvalStep.findUnique({ where: { id: req.params.stepId } });
  if (!step || step.workflow !== rj.DNU_WORKFLOW) return res.status(404).json({ error: 'Request not found' });
  if (step.status !== 'Pending') return res.status(409).json({ error: `This request was already ${step.status.toLowerCase()}.` });
  if (!(await rj.canDecide(req.user, step))) {
    return res.status(403).json({ error: 'Only the TL of this requirement\'s team, a Super Admin or an Admin can decide a "Do not use" request.' });
  }
  const ev = await prisma.applicationStageEvent.findUnique({
    where: { id: step.recordId },
    select: { candidateId: true, actorUserId: true, requirementTitle: true, reasonCategory: true, candidate: { select: { name: true, profileStatus: true } } },
  });
  if (!ev) return res.status(404).json({ error: 'The rejection behind this request no longer exists.' });
  const approved = decision === 'approve';
  const now = new Date();
  await prisma.approvalStep.update({
    where: { id: step.id },
    data: {
      status: approved ? 'Approved' : 'Rejected',
      actedAt: now,
      actedByUserId: req.user.id,
      actedByName: req.user.name,
      note,
      direct: stageGlobal(req.user) && step.approverUserId !== req.user.id,
    },
  });
  if (approved) {
    await prisma.candidate.update({ where: { id: ev.candidateId }, data: { profileStatus: rj.DNU_STATUS } });
    try {
      // eslint-disable-next-line global-require
      require('../utils/candidateListCache').markCandidateDirty(ev.candidateId);
    } catch { /* the list re-reads on its own schedule */ }
  }
  rj.invalidate();
  await logAudit({
    userId: req.user.id,
    action: approved ? 'Candidate marked "Do not use" (approved)' : '"Do not use" request declined',
    entity: 'Candidate',
    entityId: ev.candidateId,
    fromValue: ev.candidate ? ev.candidate.profileStatus : null,
    toValue: approved ? rj.DNU_STATUS : (ev.candidate ? ev.candidate.profileStatus : null),
    reason: [ev.reasonCategory, note].filter(Boolean).join(' — ') || undefined,
  });
  if (ev.actorUserId && ev.actorUserId !== req.user.id) {
    try {
      await notifyUsers([ev.actorUserId], {
        title: approved ? `"Do not use" approved — ${ev.candidate ? ev.candidate.name : 'candidate'}` : `"Do not use" declined — ${ev.candidate ? ev.candidate.name : 'candidate'}`,
        message: approved
          ? `${req.user.name} approved it. The candidate is now blocked from every match list.`
          : `${req.user.name} declined it${note ? `: ${note}` : ''}. The reject stays as "Not suitable for this job".`,
      });
    } catch { /* never undoes the decision */ }
  }
  return res.json({ ok: true, status: approved ? 'Approved' : 'Rejected', candidateId: ev.candidateId });
});

// --- Lift an approved "Do not use" (Super Admin / Admin only) ---------------
// The block was a person's decision; so is lifting it, with a reason, audited.
router.post('/do-not-use/candidate/:id/lift', async (req, res) => {
  if (!stageGlobal(req.user)) return res.status(403).json({ error: 'Only a Super Admin or an Admin can lift a "Do not use" block.' });
  const reason = String((req.body && req.body.reason) || '').trim().slice(0, 500);
  if (!reason) return res.status(400).json({ error: 'Say why the block is being lifted.' });
  const c = await prisma.candidate.findUnique({ where: { id: req.params.id }, select: { id: true, name: true, profileStatus: true } });
  if (!c) return res.status(404).json({ error: 'Candidate not found' });
  if (c.profileStatus !== rj.DNU_STATUS) return res.status(409).json({ error: `${c.name} is not marked "Do not use".` });
  // Back to what the profile said before the block, else Active.
  const before = await prisma.auditLog.findFirst({
    where: { entity: 'Candidate', entityId: c.id, toValue: rj.DNU_STATUS },
    orderBy: { createdAt: 'desc' },
    select: { fromValue: true },
  });
  const restore = before && before.fromValue && before.fromValue !== rj.DNU_STATUS ? before.fromValue : 'Active';
  await prisma.candidate.update({ where: { id: c.id }, data: { profileStatus: restore } });
  try {
    // eslint-disable-next-line global-require
    require('../utils/candidateListCache').markCandidateDirty(c.id);
  } catch { /* the list re-reads on its own schedule */ }
  rj.invalidate();
  await logAudit({
    userId: req.user.id, action: '"Do not use" block lifted', entity: 'Candidate', entityId: c.id,
    fromValue: rj.DNU_STATUS, toValue: restore, reason,
  });
  return res.json({ ok: true, profileStatus: restore });
});

// --- The same-client rule: warn and ask (default) or block -------------------
router.get('/settings', async (req, res) => {
  res.json({ ...(await rj.rejectionRules()), canEdit: stageGlobal(req.user) });
});
router.put('/settings', async (req, res) => {
  if (!stageGlobal(req.user)) return res.status(403).json({ error: 'Only a Super Admin or an Admin can change this rule.' });
  const out = await rj.saveRejectionRules({ sameClient: req.body && req.body.sameClient });
  if (out.error) return res.status(400).json({ error: out.error });
  if (out.before.sameClient !== out.settings.sameClient) {
    await logAudit({
      userId: req.user.id, action: 'Same-client rejection rule changed', entity: 'Setting', entityId: rj.RULES_ID,
      fromValue: out.before.sameClient, toValue: out.settings.sameClient,
    });
  }
  return res.json({ ...out.settings, canEdit: true });
});

module.exports = router;
