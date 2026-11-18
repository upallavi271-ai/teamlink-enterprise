// ---------------------------------------------------------------------------
// CANDIDATE DATA routes (founder audit 2026-11-18, round 3) - mounted INSIDE routes/candidates.js (/api/candidates/...), ABOVE GET /:id, so the
// router-wide "Candidate List: view" check and the profile's own scope (loadInScope) apply. TeamLink logins only.
//
//   GET  /:id/extra               address, native place, marital status, languages, father's name, preferred locations (the BDE limited view gets nothing)
//   PUT  /:id/extra               the same (Candidate Master: edit); every changed field is audited
//   GET  /:id/verify              the verify flags of this person (open + decided), the resume read with a confidence per field, and the live checks
//   POST /:id/verify/recheck      checks the saved profile against the latest resume again and stores the flags
//   GET  /:id/history-timeline    every earlier application (with the rejection reason), earlier joinings, reapplies, salary / experience changes
//   POST /:id/reapply             { requirementId, reason }: open a closed / rejected application again (an Admin / TL / STL / Manager confirms)
//   GET  /:id/score-history       every change of a Fit score: date, version of the weights, reason
//   POST /:id/score-history/refresh   score the open applications again now
//   POST /:id/confirm-current     "salary, phone and resume are still right": resets the stale-data clock
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requirePerm, can } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const CD = require('../utils/candidateData');
const RV = require('../utils/resumeVerify');
const SH = require('../utils/scoreHistory');
const FB = require('../utils/fitBreakdown');
const { requirementIsLive } = require('../utils/atsVocab');

const router = express.Router();
const cand = () => require('./candidates'); // eslint-disable-line global-require
const EDIT = requirePerm('ats', 'candidates', 'Candidate Master', 'edit');
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const internalOnly = (req, res) => {
  if (cand().viewerKind(req.user) !== 'internal') { res.status(403).json({ error: 'Only the TeamLink team can see this.' }); return false; }
  return true;
};
async function load(req, res) {
  if (!internalOnly(req, res)) return null;
  return cand().loadInScope(req, res);
}
const audit = (req, action, extra = {}) => logAudit({ userId: req.user.id, actorName: req.user.name, action, entity: 'Candidate', entityId: req.params.id, ...extra });
const dirty = (id) => { try { require('../utils/candidateListCache').markCandidateDirty(id); } catch { /* the list catches up */ } }; // eslint-disable-line global-require
const APPROVER_ROLES = ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'STL', 'TL'];
const isApprover = (u) => [u.role, u.atsRole].some((r) => APPROVER_ROLES.includes(r));
const latestParsed = async (candidateId) => {
  const r = await prisma.candidateResume.findFirst({ where: { candidateId, kind: 'ORIGINAL', hiddenAt: null }, orderBy: { createdAt: 'desc' }, select: { id: true, parsed: true, fileName: true, createdAt: true, text: true } }).catch(() => null);
  let parsed = null;
  try { parsed = r && r.parsed ? JSON.parse(r.parsed) : null; } catch { parsed = null; }
  return { resume: r, parsed };
};
const profileValues = (c) => ({
  name: c.name, email: c.email, phone: c.phone, dob: c.dob || null, experienceYears: c.experienceYears, currentSalary: c.currentSalary, expectedSalary: c.expectedSalary,
  noticePeriod: c.noticePeriod, location: c.location, education: c.education, passingYear: c.passingYear, currentDesignation: c.currentDesignation, currentCompany: c.currentCompany,
});

// ---- personal details + preferred locations -----------------------------------------------------------------------------------
router.get('/:id/extra', wrap(async (req, res) => {
  const loaded = await load(req, res);
  if (!loaded) return undefined;
  // the BDE team's limited view (and any login without "Candidate Contact & Salary") never sees these
  if (FB.isRestricted(req.user)) return res.json({ restricted: true, canEdit: false });
  const [extra, canEdit, stale] = await Promise.all([CD.extraOf(req.params.id), can(req.user, 'ats', 'candidates', 'Candidate Master', 'edit'), CD.staleOf({ limit: 1, candidateWhere: { id: req.params.id } })]);
  // stale: which of salary / phone / resume is older than the Admin's N days (nobody confirmed it) - the profile offers "confirmed current"
  return res.json({ ...extra, canEdit: !!canEdit, maritalOptions: CD.MARITAL, stale: stale.rows[0] ? { days: stale.days, parts: stale.rows[0].stale } : null });
}));
router.put('/:id/extra', EDIT, wrap(async (req, res) => {
  const loaded = await load(req, res);
  if (!loaded) return undefined;
  if (FB.isRestricted(req.user)) return res.status(403).json({ error: "These details are not part of your role's view." });
  const inp = CD.extraInput(req.body || {});
  if (inp.error) return res.status(400).json({ error: inp.error });
  const r = await CD.saveExtra(req.params.id, inp.values, req.user);
  const shown = (v) => (Array.isArray(v) ? v.join(', ') : (v || ''));
  for (const k of Object.keys(inp.values)) {
    if (shown(r.before[k]) !== shown(r.after[k])) {
      // eslint-disable-next-line no-await-in-loop
      await audit(req, 'Candidate field changed', { field: k, fieldLabel: k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()), fromValue: shown(r.before[k]) || '(blank)', toValue: shown(r.after[k]) || '(blank)' });
    }
  }
  dirty(req.params.id);
  return res.json(r.after);
}));

// ---- verify -----------------------------------------------------------------------------------------------------------------------
async function verifyView(candidate) {
  const [flags, { resume, parsed }] = await Promise.all([RV.flagsOf(candidate.id), latestParsed(candidate.id)]);
  const open = flags.filter((f) => RV.OPEN_STATES.includes(f.status));
  const sideBySide = (parsed ? Object.keys(parsed.confidence || {}).map((k) => ({
    field: k, confidence: parsed.confidence[k], evidence: (parsed.evidence || {})[k] || null,
  })) : []);
  return {
    needsVerification: open.length > 0, openCount: open.length, flags,
    resume: resume ? { id: resume.id, fileName: resume.fileName, readAt: resume.createdAt } : null,
    read: sideBySide,
    live: RV.checkProfile(profileValues(candidate), parsed).filter((f) => f.kind !== 'low_confidence').slice(0, 30),
  };
}
router.get('/:id/verify', wrap(async (req, res) => {
  const loaded = await load(req, res);
  if (!loaded) return undefined;
  if (FB.isRestricted(req.user)) return res.json({ restricted: true, needsVerification: false, openCount: 0, flags: [] });
  const v = await verifyView(loaded.candidate);
  return res.json({ ...v, canDecide: isApprover(req.user), canCorrect: !!(await can(req.user, 'ats', 'candidates', 'Candidate Master', 'edit')) });
}));
router.post('/:id/verify/recheck', EDIT, wrap(async (req, res) => {
  const loaded = await load(req, res);
  if (!loaded) return undefined;
  const { resume, parsed } = await latestParsed(req.params.id);
  const flags = RV.checkProfile(profileValues(loaded.candidate), parsed);
  await RV.recordFlags(req.params.id, flags, { source: 'recheck', resumeId: resume ? resume.id : null, user: req.user });
  await audit(req, 'Profile checked against the resume', { toValue: flags.length ? `${flags.length} thing(s) to verify` : 'nothing to verify' });
  return res.json({ ...(await verifyView(loaded.candidate)), canDecide: isApprover(req.user), rechecked: flags.length });
}));

// ---- rejoin / reapply timeline ---------------------------------------------------------------------------------------------------
router.get('/:id/history-timeline', wrap(async (req, res) => {
  const loaded = await load(req, res);
  if (!loaded) return undefined;
  const visible = (loaded.decorated.applications || []).map((a) => a.id);
  const [hist, events] = await Promise.all([CD.applicationHistory(req.params.id, { scopeAppIds: visible }), CD.eventsOf(req.params.id, { limit: 100 })]);
  // earlier joinings: with the same client as an open application, or with another
  const openClients = new Set((loaded.decorated.applications || []).filter((a) => !['REJECTED', 'JOINED', 'HIRED'].includes(a.stage)).map((a) => a.requirement && a.requirement.client && a.requirement.client.id).filter(Boolean));
  const joined = hist.joined.map((j) => ({ ...j, sameClientAsOpenApplication: !!(j.clientId && openClients.has(j.clientId)) }));
  const restricted = FB.isRestricted(req.user);
  const mayReapply = isApprover(req.user);
  return res.json({
    applications: hist.rows,
    previousJoinings: joined,
    events: restricted ? [] : events.map((e) => ({ id: e.id, kind: e.kind, title: e.title, detail: e.detail, reason: e.reason, at: e.at, byName: e.byName, applicationId: e.applicationId })),
    canReapply: mayReapply,
    reapplyNote: 'A closed or rejected application can be opened again when an Admin or team lead confirms "reapply". The old rejection stays in the history.',
  });
}));
router.post('/:id/reapply', wrap(async (req, res) => {
  const loaded = await load(req, res);
  if (!loaded) return undefined;
  if (!isApprover(req.user)) return res.status(403).json({ error: 'Only an Admin or a team lead can confirm a reapply.' });
  if (!(await can(req.user, 'ats', 'candidates', 'Applications', 'edit'))) return res.status(403).json({ error: "This action isn't included in your role's permissions" });
  const reason = String((req.body && req.body.reason) || '').replace(/\s+/g, ' ').trim();
  if (reason.length < 3) return res.status(400).json({ error: 'Say why this person may apply again.' });
  const requirementId = String((req.body && req.body.requirementId) || '');
  const app = (loaded.decorated.applications || []).find((a) => a.requirementId === requirementId);
  if (!app) return res.status(404).json({ error: 'This person has no earlier application on that requirement (or it is outside your reach). Add them normally instead.' });
  const row = await prisma.application.findUnique({ where: { id: app.id }, include: { requirement: { include: { client: { select: { id: true, name: true, status: true } } } } } });
  if (!row) return res.status(404).json({ error: 'Application not found.' });
  if (row.stage !== 'REJECTED') return res.status(409).json({ error: 'That application is still open, so there is nothing to reapply.' });
  if (!requirementIsLive(row.requirement.status)) return res.status(409).json({ error: 'That requirement is not open any more. Reopen it first, then confirm the reapply.', code: 'JOB_NOT_OPEN' });
  if (loaded.candidate.profileStatus === 'Do Not Use') return res.status(409).json({ error: `${loaded.candidate.name} is marked "Do not use" and cannot be added to any requirement.`, code: 'DO_NOT_USE' });
  const before = row.stage;
  await prisma.application.update({ where: { id: row.id }, data: { stage: 'NEW' } });
  await prisma.applicationStageEvent.create({
    data: {
      applicationId: row.id, candidateId: row.candidateId, fromStage: before, toStage: 'NEW', action: 'Reapplied (confirmed)', comment: reason.slice(0, 500), actorUserId: req.user.id, actorName: req.user.name, actorRole: req.user.atsRole || req.user.role,
    },
  });
  await CD.addEvent(req.params.id, { kind: 'reapply', title: `Applied again to ${row.requirement.reqCode || row.requirement.title}`, detail: `Earlier application was closed (${before}).`, reason, applicationId: row.id }, req.user);
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Reapply confirmed', entity: 'Application', entityId: row.id, fromValue: before, toValue: 'NEW', reason });
  try { require('../utils/rejections').invalidate(); } catch { /* the rejection index refreshes on its own */ } // eslint-disable-line global-require
  dirty(req.params.id);
  try { await SH.rescoreCandidate(req.params.id, 'Applied again (reapply confirmed)', req.user); } catch { /* the score catches up */ }
  return res.status(201).json({ ok: true, applicationId: row.id, message: 'Opened again at the first step. The earlier rejection stays in the history.' });
}));

// ---- score history ------------------------------------------------------------------------------------------------------------------
router.get('/:id/score-history', wrap(async (req, res) => {
  const loaded = await load(req, res);
  if (!loaded) return undefined;
  if (FB.isRestricted(req.user)) return res.json({ restricted: true, rows: [] }); // the BDE team never sees internal scores
  const appIds = (loaded.decorated.applications || []).map((a) => a.id);
  return res.json({ rows: await SH.historyOf({ appIds }), note: 'Every change of the Fit score. The latest one is the score used everywhere.' });
}));
router.post('/:id/score-history/refresh', EDIT, wrap(async (req, res) => {
  const loaded = await load(req, res);
  if (!loaded) return undefined;
  if (FB.isRestricted(req.user)) return res.status(403).json({ error: "This action isn't included in your role's permissions" });
  const changed = await SH.rescoreCandidate(req.params.id, SH.REASONS.manual, req.user);
  const appIds = (loaded.decorated.applications || []).map((a) => a.id);
  return res.json({ changed, rows: await SH.historyOf({ appIds }) });
}));

// ---- stale data: "confirmed current" ----------------------------------------------------------------------------------------------------
router.post('/:id/confirm-current', EDIT, wrap(async (req, res) => {
  const loaded = await load(req, res);
  if (!loaded) return undefined;
  const at = await CD.confirmCurrent(req.params.id, req.user);
  await audit(req, 'Profile data confirmed current', { toValue: 'salary, phone and resume' });
  return res.json({ ok: true, confirmedCurrentAt: at });
}));

module.exports = router;
module.exports.profileValues = profileValues;
module.exports.latestParsed = latestParsed;
