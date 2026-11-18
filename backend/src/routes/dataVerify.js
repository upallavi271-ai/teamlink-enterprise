// ---------------------------------------------------------------------------
// DATA VERIFY routes (founder audit 2026-11-18, round 3), mounted at /api/ats/data-verify. TeamLink logins that work with candidates; the BDE team's
// limited view gets nothing.
//
//   GET  /queue?status=open|wait_tl|all    the verify queue (what the resume says vs what is saved), limited to the people this login can reach
//   GET  /count                            { open, waitingForTl } for the badge on the Candidates screen
//   POST /flags/:id/resolve                { action: approve | correct | dismiss, value, note }  a recruiter corrects / marks checked; a TL approves
//   GET  /settings                         the switches (auto-create staff uploads, stale after N days) + the pick list for "why is it changing"
//   PUT  /settings                         Admin only
//   GET  /stale                            profiles whose salary / phone / resume is older than N days (team leads and above)
//   GET  /similar-titles?title=            titles on file that mean nearly the same ("Sr. Java Dev" ~ "Senior Java Developer")
//   GET  /parse-quality                    the stored accuracy runs (Admin)
//   POST /parse-quality/run                measure now and store the run (Admin)
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth, can } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { candidateWhere } = require('../utils/scope');
const CD = require('../utils/candidateData');
const RV = require('../utils/resumeVerify');
const PQ = require('../utils/parseQuality');
const PD = require('../utils/candidateProfileDepth');
const FB = require('../utils/fitBreakdown');
const { roleForProduct } = require('../utils/permissions');

const router = express.Router();
router.use(requireAuth);
router.use(require('../utils/permissions').requireInternal);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const has = (u, list) => [u.role, u.atsRole, roleForProduct(u, 'ats')].filter(Boolean).some((r) => list.includes(r));
const isAdmin = (u) => has(u, ['SUPER_ADMIN', 'ADMIN']);
const isApprover = (u) => has(u, ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'STL', 'TL']);
const dirty = (id) => { try { require('../utils/candidateListCache').markCandidateDirty(id); } catch { /* the list catches up */ } }; // eslint-disable-line global-require

// who may use the queue: not the BDE team's limited view, and someone who works candidate profiles
async function mayUse(req, res) {
  if (FB.isRestricted(req.user)) { res.status(403).json({ error: "This isn't included in your role's permissions." }); return false; }
  if (isAdmin(req.user) || isApprover(req.user) || await can(req.user, 'ats', 'candidates', 'Candidate Master', 'edit')) return true;
  res.status(403).json({ error: "This isn't included in your role's permissions." });
  return false;
}
// the candidate ids (of `ids`) this login can reach: the normal record scope, the people this login added, and - for a team lead and above, who approve
// uploads - a person from an upload who is not on any requirement yet (nobody's scope reaches them until they are)
async function reachable(user, ids) {
  if (!ids.length) return new Set();
  const out = new Set();
  const mine = await require('../utils/candidateAddedBy').idsOf(user.id).catch(() => new Set()); // eslint-disable-line global-require
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    // eslint-disable-next-line no-await-in-loop
    const rows = await prisma.candidate.findMany({ where: { AND: [{ id: { in: part } }, candidateWhere(user)] }, select: { id: true } });
    rows.forEach((r) => out.add(r.id));
    part.forEach((id) => { if (mine.has(id)) out.add(id); });
    if (isApprover(user)) {
      // eslint-disable-next-line no-await-in-loop
      const loose = await prisma.candidate.findMany({ where: { id: { in: part.filter((id) => !out.has(id)) }, applications: { none: {} } }, select: { id: true } });
      loose.forEach((r) => out.add(r.id));
    }
  }
  return out;
}
async function flaggedIds(status) {
  await RV.ensure();
  const states = status === 'wait_tl' ? ['WAIT_TL'] : ['OPEN', 'WAIT_TL'];
  const rows = await prisma.$queryRawUnsafe(`SELECT DISTINCT "candidateId" FROM "ResumeFlag" WHERE "status" IN (${states.map(() => '?').join(',')})`, ...states);
  return rows.map((r) => r.candidateId);
}

router.get('/queue', wrap(async (req, res) => {
  if (!(await mayUse(req, res))) return undefined;
  const status = ['open', 'wait_tl', 'all'].includes(req.query.status) ? req.query.status : 'open';
  await RV.ensure();
  let scope = null;
  if (status === 'all') {
    const rows = await prisma.$queryRawUnsafe('SELECT DISTINCT "candidateId" FROM "ResumeFlag"');
    scope = await reachable(req.user, rows.map((r) => r.candidateId));
  } else scope = await reachable(req.user, await flaggedIds(status));
  const q = await RV.listQueue({ status, candidateIdIn: scope, limit: 300 });
  return res.json({ ...q, status, canApprove: isApprover(req.user), me: req.user.id });
}));

router.get('/count', wrap(async (req, res) => {
  if (FB.isRestricted(req.user)) return res.json({ open: 0, waitingForTl: 0, show: false });
  if (!(isAdmin(req.user) || isApprover(req.user) || await can(req.user, 'ats', 'candidates', 'Candidate Master', 'edit'))) return res.json({ open: 0, waitingForTl: 0, show: false });
  const ids = await flaggedIds('open');
  const scope = await reachable(req.user, ids);
  let waiting = 0;
  if (scope.size) {
    const w = await reachable(req.user, await flaggedIds('wait_tl'));
    waiting = w.size;
  }
  return res.json({ open: scope.size, waitingForTl: waiting, show: true });
}));

router.post('/flags/:id/resolve', wrap(async (req, res) => {
  if (!(await mayUse(req, res))) return undefined;
  await RV.ensure();
  const [flag] = await prisma.$queryRawUnsafe('SELECT "candidateId" FROM "ResumeFlag" WHERE "id" = ?', req.params.id);
  if (!flag) return res.status(404).json({ error: 'Flag not found.' });
  if (!(await reachable(req.user, [flag.candidateId])).has(flag.candidateId)) return res.status(403).json({ error: "This isn't included in your role's permissions." });
  const body = req.body || {};
  // approving or dismissing is the TL's call; a recruiter corrects the value or marks it checked (it then waits for the TL on an upload)
  const approver = isApprover(req.user);
  if (['approve', 'dismiss'].includes(body.action) && !approver && !(await can(req.user, 'ats', 'candidates', 'Candidate Master', 'edit'))) return res.status(403).json({ error: 'Only a team lead can approve this.' });
  if (body.action === 'correct' && !approver && !(await can(req.user, 'ats', 'candidates', 'Candidate Master', 'edit'))) return res.status(403).json({ error: "This isn't included in your role's permissions." });
  const r = await RV.resolve(req.params.id, body, req.user, { isApprover: approver });
  if (r.error) return res.status(r.status || 400).json({ error: r.error });
  await logAudit({
    userId: req.user.id,
    actorName: req.user.name,
    action: `Verify flag ${r.waitingForTl ? 'checked (waits for the team lead)' : r.state.toLowerCase()}: ${r.label}`,
    entity: 'Candidate',
    entityId: r.candidateId,
    field: body.action === 'correct' ? r.field : undefined,
    fromValue: r.before || '',
    toValue: r.newValue || body.action,
    reason: body.note ? String(body.note).slice(0, 300) : (body.action === 'correct' ? 'Corrected in the verify queue' : null),
  });
  if (body.action === 'correct') {
    await CD.addEvent(r.candidateId, { kind: 'data_change', title: `${r.label} corrected in the verify queue: ${r.before || '(blank)'} -> ${r.newValue}`, reason: body.note || 'Verify queue correction' }, req.user);
    dirty(r.candidateId);
  }
  return res.json(r);
}));

// ---- switches -----------------------------------------------------------------------------------------------------------------------
router.get('/settings', wrap(async (req, res) => {
  const s = await CD.settings();
  return res.json({
    ...s, canChange: isAdmin(req.user), changeReasons: CD.CHANGE_REASONS, changeFields: CD.CHANGE_FIELDS,
    sampleDirSet: !!process.env.RESUME_SAMPLE_DIR,
  });
}));
router.put('/settings', wrap(async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only a Super Admin or Admin can change this.' });
  const r = await CD.saveSettings(req.body || {}, req.user);
  if (r.error) return res.status(400).json({ error: r.error });
  const label = { autoCreateStaffUploads: 'Auto-create candidates from staff uploads when nothing is flagged', staleDays: 'Stale profile data after (days)' };
  for (const k of Object.keys(r.settings)) {
    if (String(r.settings[k]) !== String(r.old[k])) {
      // eslint-disable-next-line no-await-in-loop
      await logAudit({
        userId: req.user.id, actorName: req.user.name, action: 'Candidate data setting changed', entity: 'Setting', entityId: 'candidate-data', field: k, fieldLabel: label[k], fromValue: String(r.old[k]), toValue: String(r.settings[k]),
      });
    }
  }
  return res.json({ ...r.settings, canChange: true });
}));

// ---- stale data ------------------------------------------------------------------------------------------------------------------------
router.get('/stale', wrap(async (req, res) => {
  if (!isApprover(req.user)) return res.status(403).json({ error: 'The stale data list is for team leads and above.' });
  const s = await CD.settings();
  const days = req.query.days ? Math.max(7, Math.min(1500, Number(req.query.days) || s.staleDays)) : s.staleDays;
  const r = req.query.candidateId ? await CD.staleOf({ days, limit: 5, candidateWhere: { id: String(req.query.candidateId) } }) : await CD.staleOf({ days, limit: 20000 });
  const ids = r.rows.map((x) => x.id);
  const scope = await reachable(req.user, ids);
  const rows = r.rows.filter((x) => scope.has(x.id)).slice(0, 200);
  return res.json({ days, total: scope.size, rows });
}));

// ---- similar titles --------------------------------------------------------------------------------------------------------------------
router.get('/similar-titles', wrap(async (req, res) => {
  if (!(await mayUse(req, res))) return undefined;
  const title = String(req.query.title || '').trim().slice(0, 120);
  if (title.length < 2) return res.status(400).json({ error: 'Type a job title.' });
  const [cand, emp, reqs] = await Promise.all([
    prisma.candidate.groupBy({ by: ['currentDesignation'], where: { currentDesignation: { not: null } }, _count: { _all: true }, orderBy: { currentDesignation: 'asc' }, take: 4000 }).catch(() => []),
    PD.ensure().then(() => prisma.$queryRawUnsafe('SELECT "title", COUNT(*) AS n FROM "CandidateEmployment" WHERE "title" IS NOT NULL GROUP BY "title" LIMIT 4000')).catch(() => []),
    prisma.requirement.groupBy({ by: ['title'], _count: { _all: true }, orderBy: { title: 'asc' }, take: 4000 }).catch(() => []),
  ]);
  const seen = new Map();
  const add = (t, n, where) => {
    const k = String(t || '').trim(); if (!k) return;
    const sim = RV.titleSimilarity(title, k);
    if (sim < 0.4) return;
    const e = seen.get(k.toLowerCase()) || { title: k, similarity: sim, candidates: 0, requirements: 0, standard: PD.normaliseTitle(k) };
    e[where] += Number(n || 0); seen.set(k.toLowerCase(), e);
  };
  cand.forEach((r) => add(r.currentDesignation, r._count._all, 'candidates'));
  emp.forEach((r) => add(r.title, r.n, 'candidates'));
  reqs.forEach((r) => add(r.title, r._count._all, 'requirements'));
  const rows = [...seen.values()].sort((a, b) => b.similarity - a.similarity || (b.candidates + b.requirements) - (a.candidates + a.requirements)).slice(0, 25);
  return res.json({ title, standard: PD.normaliseTitle(title), rows });
}));

// ---- parsing quality ---------------------------------------------------------------------------------------------------------------------
router.get('/parse-quality', wrap(async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only a Super Admin or Admin can see this.' });
  return res.json({ runs: await PQ.list(30), sampleDirSet: !!process.env.RESUME_SAMPLE_DIR });
}));
router.post('/parse-quality/run', wrap(async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only a Super Admin or Admin can do this.' });
  const r = await PQ.runAndStore(req.user);
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Resume parsing quality measured', entity: 'Setting', entityId: 'parse-quality', toValue: `${r.overall}% over ${r.samples} sample(s)${r.files ? ` + ${r.files} file(s)` : ''}` });
  return res.status(201).json({ ...r, runs: await PQ.list(30) });
}));

module.exports = router;
