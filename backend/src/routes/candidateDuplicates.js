// ---------------------------------------------------------------------------
// DUPLICATE CANDIDATES — the worklist, the "Check duplicates" panel and the resolutions.
// Mounted at /api/candidate-duplicates (index.js). Logic: utils/candidateDupResolve.js.
//
//   GET  /status                       { waiting, requests, older } — the header badge "N duplicates waiting"
//   GET  /worklist?tab=&level=&department=&recruiter=&source=&from=&to=&search=&page=&pageSize=
//   GET  /candidate/:id                the panel in the candidate drawer / page
//   GET  /flags/:id/preview?masterId=  field by field + what moves
//   POST /flags/:id/not-duplicate      { reason }
//   POST /flags/:id/same-person        (different job: adds the application to the existing profile)
//   POST /flags/:id/reject             { reason? }
//   POST /flags/:id/request-merge      { masterId?, fieldChoices?, note? }        recruiter
//   POST /flags/:id/merge              { confirm: true, masterId?, fieldChoices? } TL of the team / Admin
//   POST /flags/:id/decline            { note }                                    TL / Admin
//   POST /bulk                         { action: not-duplicate | request-merge | merge, flagIds, reason }
//   GET  /auto-merge                   proposals: same phone + same name + different jobs (a dry-run list)
//   GET  /merges  ·  POST /merges/:id/undo
//   POST /recheck/:candidateId         check this person again
//   GET/POST /settings                 Admin: the first-step hold on / off, undo days
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth, requirePerm, requireProduct } = require('../middleware/auth');
const DUP = require('../utils/candidateDupes');
const R = require('../utils/candidateDupResolve');
const SC = require('../utils/scope');
const prisma = require('../db');

const router = express.Router();
router.use(requireAuth);
router.use(requireProduct('ats'));
router.use(requirePerm('ats', 'candidates', 'Candidate List', 'view'));

const wrap = (fn) => async (req, res, next) => {
  try {
    const out = await fn(req, res);
    if (out && out !== res && !res.headersSent && Number.isInteger(out.status)) return res.status(out.status).json(out.body); // a handler that already answered returns res itself (res.status is a function)
    return undefined;
  } catch (err) { return next(err); }
};

router.get('/status', wrap(async (req, res) => res.json(await R.waitingCount(req.user))));

router.get('/worklist', wrap((req) => R.worklist(req.user, req.query)));

router.get('/candidate/:id', wrap(async (req, res) => {
  const kind = R.actorKind(req.user);
  if (kind.external) return res.status(403).json({ error: 'Not available to this login' });
  // the profile must be inside the viewer's area (the same rule as opening the profile)
  if (!kind.global) {
    const apps = await prisma.application.findMany({ where: { candidateId: req.params.id }, include: { requirement: true } });
    if (!apps.some((a) => SC.applicationInScope(req.user, a))) return res.status(403).json(SC.OUT_OF_SCOPE);
  }
  return res.json(await R.panelFor(req.user, req.params.id, { all: req.query.all === '1' }));
}));

router.get('/flags/:id/preview', wrap((req) => R.preview(req.user, req.params.id, req.query.masterId)));
router.post('/flags/:id/not-duplicate', wrap((req) => R.notDuplicate(req.user, req.params.id, req.body)));
router.post('/flags/:id/same-person', wrap((req) => R.samePersonOtherJob(req.user, req.params.id)));
router.post('/flags/:id/reject', wrap((req) => R.rejectDuplicate(req.user, req.params.id, req.body)));
router.post('/flags/:id/request-merge', wrap((req) => R.requestMerge(req.user, req.params.id, req.body)));
router.post('/flags/:id/merge', wrap((req) => R.doMerge(req.user, req.params.id, req.body)));
router.post('/flags/:id/decline', wrap((req) => R.declineMerge(req.user, req.params.id, req.body)));
router.post('/bulk', wrap((req) => R.bulk(req.user, req.body)));

router.get('/auto-merge', wrap((req) => R.autoMergeProposals(req.user)));
router.post('/auto-merge/approve', wrap(async (req) => {
  const ids = (Array.isArray(req.body && req.body.flagIds) ? req.body.flagIds : []).map(String);
  if (!ids.length) return { status: 400, body: { error: 'Pick the ones you approve.' } };
  // only what is STILL an obvious proposal is merged (the list may have changed)
  const prop = await R.autoMergeProposals(req.user);
  if (prop.status !== 200) return prop;
  const ok = new Set(prop.body.proposals.filter((p) => p.canApprove).map((p) => p.flagId));
  const pick = ids.filter((i) => ok.has(i));
  if (!pick.length) return { status: 403, body: { error: 'Only a TL of the team or an Admin can approve these merges.' } };
  return R.bulk(req.user, { action: 'merge', flagIds: pick });
}));

router.get('/merges', wrap((req) => R.mergesList(req.user)));
router.post('/merges/:id/undo', wrap((req) => R.undo(req.user, req.params.id)));

router.post('/recheck/:candidateId', wrap(async (req) => {
  const kind = R.actorKind(req.user);
  if (!kind.doer) return { status: 403, body: { error: 'Not available to this login' } };
  const out = await DUP.reindex(req.params.candidateId, { door: 'Check again', actor: req.user, quiet: true });
  return { status: 200, body: { ok: out.ok, created: out.created } };
}));

router.get('/settings', wrap(async (req) => {
  const kind = R.actorKind(req.user);
  if (!kind.viewer) return { status: 403, body: { error: 'Not available to this login' } };
  return { status: 200, body: { ...(await DUP.settings()), supported: await DUP.supported(), backfilled: await DUP.backfilled() } };
}));
router.post('/settings', wrap(async (req) => {
  const kind = R.actorKind(req.user);
  if (!kind.global) return { status: 403, body: { error: 'Only a Super Admin or Admin can change this.' } };
  const patch = {};
  if (typeof req.body.gate === 'boolean') patch.gate = req.body.gate;
  if (req.body.undoDays != null) patch.undoDays = Math.min(60, Math.max(1, Number(req.body.undoDays) || 7));
  const next = await DUP.saveSettings(patch, req.user);
  await require('../utils/audit').logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Duplicate settings changed', entity: 'AppSetting', entityId: 'candidate-duplicates', toValue: JSON.stringify(next) }); // eslint-disable-line global-require
  return { status: 200, body: next };
}));

module.exports = router;
