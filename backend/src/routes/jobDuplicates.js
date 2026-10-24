// ---------------------------------------------------------------------------
// DUPLICATE JOBS — Clients & Requirements > Jobs > Duplicate jobs. Mounted at /api/job-duplicates (index.js).
// Logic: utils/jobDupResolve.js (worklist, resolutions) · utils/jobMerge.js (merge / undo) · utils/jobDupes.js (detection)
// · utils/jobDupGuard.js (the creation card).  Roles are enforced there (BDE team and above resolve; the rest only ask).
//
//   GET  /status                       { visible, must, likely, maybe, badge } — the red count on the tab
//   GET  /worklist?tab=must|likely|maybe|done&department=&client=&bde=&tl=&search=&page=&pageSize=
//   POST /merge                        { keptId, extraIds[], openings?: 'max'|'sum', note? }
//   POST /not-duplicate                { jobIds[], reason }
//   POST /close-extra                  { extraId, keptId? }        the extra job has nobody on it
//   GET  /auto-merge                   the obvious ones (CERTAIN, no blocker) as a proposal list
//   POST /auto-merge/approve           { clusterIds[] } or { all: true }
//   GET  /merges   ·  POST /merges/:id/undo
//   GET  /job/:id                      the small note on a job: { twin, with[], canAsk, asked }
//   POST /ask-merge                    { jobId, note? }            TL / Recruiter / Manager: one bell to the client manager
//   POST /check                        the same check the save runs (the Add job form's live card)
//   POST /add-openings                 { jobId, add, note? }       "Add openings to the existing job"
//   GET/POST /settings                 undo days, openings rule (Admin)
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth, requireProduct } = require('../middleware/auth');
const R = require('../utils/jobDupResolve');
const SC = require('../utils/scope');
const prisma = require('../db');

const router = express.Router();
router.use(requireAuth);
router.use(requireProduct('ats'));

const wrap = (fn) => async (req, res, next) => {
  try {
    const o = await fn(req, res);
    if (o && o.status) return res.status(o.status).json(o.body);
    return undefined;
  } catch (e) { return next(e); }
};

router.get('/status', wrap((req) => R.status(req.user)));
router.get('/worklist', wrap((req) => R.worklist(req.user, req.query)));
router.post('/merge', wrap((req) => R.merge(req.user, req.body)));
router.post('/not-duplicate', wrap((req) => R.notDuplicate(req.user, req.body)));
router.post('/close-extra', wrap((req) => R.closeExtra(req.user, req.body)));
router.get('/auto-merge', wrap((req) => R.autoProposals(req.user)));
router.post('/auto-merge/approve', wrap((req) => R.autoApprove(req.user, req.body)));
router.get('/merges', wrap((req) => R.mergesList(req.user)));
router.post('/merges/:id/undo', wrap((req) => R.undo(req.user, req.params.id)));
router.get('/job/:id', wrap(async (req) => {
  const job = await prisma.requirement.findUnique({ where: { id: req.params.id } });
  if (!job) return { status: 404, body: { error: 'This requirement no longer exists.' } };
  if (!SC.matches(job, SC.requirementWhere(req.user))) return { status: 403, body: SC.OUT_OF_SCOPE };
  return R.noteFor(req.user, req.params.id);
}));
router.post('/ask-merge', wrap((req) => R.askMerge(req.user, req.body)));
router.post('/check', wrap((req) => R.checkDraft(req.user, req.body)));
router.post('/add-openings', wrap((req) => R.addOpenings(req.user, req.body)));
router.get('/settings', wrap((req) => R.getSettings(req.user)));
router.post('/settings', wrap((req) => R.setSettings(req.user, req.body)));

module.exports = router;
