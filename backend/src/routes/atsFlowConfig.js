// ---------------------------------------------------------------------------
// /api/ats — ATS FLOW SETTINGS (founder ATS audit 2026-11-17; the logic and tables are in utils/atsFlowConfig.js).
// The Admin page is Administration -> Company Setup -> Pipeline & checks (no sidebar item).
//
//   GET    /stage-labels                     every stage's name (+ the built-in words and the sub-statuses)   any login
//   PUT    /stage-labels      { labels }     rename stages (codes never change)                               Super Admin / Admin
//   POST   /stage-labels/reset               the built-in names back                                          Super Admin / Admin
//   GET    /sub-statuses?all=1               the sub-statuses (all = with the switched-off ones)              internal logins
//   POST   /sub-statuses      { stage, label, order }                                                         Super Admin / Admin
//   PUT    /sub-statuses/:sid { label, order, active }                                                        Super Admin / Admin
//   DELETE /sub-statuses/:sid                in use -> switched off, never used -> removed                    Super Admin / Admin
//   POST   /sub-statuses/reset               every sub-status switched off                                    Super Admin / Admin
//   PUT    /applications/:id/sub-status { subStatusId | null }   the stage's owner (permissions.canMoveToStage)
//   GET    /share-checklist/settings  PUT /share-checklist/settings  POST /share-checklist/settings/reset     (PUT/POST: Admin)
//   GET    /share-checklist/:applicationId   what the share to the client needs for this person
//   GET    /fee-slabs/:clientId   PUT /fee-slabs/:clientId { slabs }   Commercial Terms view / edit
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth, can } = require('../middleware/auth');
const { requireInternal, canMoveToStage } = require('../utils/permissions');
const { applicationInScope, OUT_OF_SCOPE } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const { hiringTypeOf } = require('../utils/joining');
const V = require('../utils/atsVocab');
const F = require('../utils/atsFlowConfig');

const router = express.Router();
const isAdmin = (u) => !!u && ['SUPER_ADMIN', 'ADMIN'].includes(u.role) && !u.viewAs;
const ADMIN_ONLY = { error: 'Only a Super Admin or an Admin changes the pipeline settings.' };
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ------------------------------------------------------- one pipeline per industry (utils/deptPipelines.js, ATS audit 2026-11-18)
//   GET  /pipelines                  { stages: [{ code, label, mandatory }], approvers, departments, pipelines: { Department: { CODE: { enabled, approverRole, mandatory } } } }
//                                    any internal login: the web app hides the steps a department does not use
//   PUT  /pipelines/:department      { stages: { CODE: { enabled, approverRole } } }      Super Admin / Admin
//   POST /pipelines/:department/reset                                                    Super Admin / Admin
const DP = require('../utils/deptPipelines');
router.get('/pipelines', requireAuth, requireInternal, wrap(async (req, res) => {
  const cfg = await DP.all({ fresh: true });
  const names = await DP.departments();
  const pipelines = {};
  names.forEach((d) => { pipelines[d] = DP.view(cfg[d]); });
  res.json({
    stages: V.STAGE_CODES.map((code) => ({ code, label: V.STAGE_LABELS[code] || code, mandatory: DP.MANDATORY.includes(code) })),
    approvers: DP.APPROVERS,
    departments: names,
    pipelines,
  });
}));
router.put('/pipelines/:department', requireAuth, wrap(async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json(ADMIN_ONLY);
  const before = (await DP.all({ fresh: true }))[DP.deptKey(req.params.department)] || {};
  const out = await DP.save(req.params.department, (req.body || {}).stages, req.user);
  if (out.error) return res.status(400).json({ error: out.error });
  const off = Object.entries(out.stages).filter(([, s]) => !s.enabled).map(([c]) => V.STAGE_LABELS[c] || c);
  const appr = Object.entries(out.stages).filter(([, s]) => s.approverRole).map(([c, s]) => `${V.STAGE_LABELS[c] || c}: ${s.approverRole}`);
  await logAudit({ userId: req.user.id, action: 'Industry pipeline saved', entity: 'Department', entityId: out.department, fromValue: JSON.stringify(before).slice(0, 300), toValue: `not used: ${off.join(', ') || 'none'}; approval: ${appr.join(', ') || 'none'}`.slice(0, 300) });
  res.json({ ok: true, ...out, message: `${out.department}: ${off.length ? `${off.join(', ')} not used` : 'every step used'}${appr.length ? `; approval on ${appr.join(', ')}` : ''}.` });
}));
router.post('/pipelines/:department/reset', requireAuth, wrap(async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json(ADMIN_ONLY);
  const out = await DP.reset(req.params.department);
  if (out.error) return res.status(400).json({ error: out.error });
  await logAudit({ userId: req.user.id, action: 'Industry pipeline reset', entity: 'Department', entityId: out.department, toValue: 'every step used, no extra approval' });
  res.json({ ok: true, ...out, message: `${out.department}: back to every step, no extra approval.` });
}));

// ---------------------------------------------------------------- stage names
async function labelsPayload(withAll) {
  const labels = await F.labelsFresh();
  const subs = await F.subStatuses({ all: withAll });
  const byStage = {};
  subs.forEach((s) => { (byStage[s.stage] = byStage[s.stage] || []).push(s); });
  return {
    codes: V.ALL_STAGE_CODES,
    labels,
    defaults: F.DEFAULT_LABELS,
    internal: V.INTERNAL_STAGE_LABELS,
    renamed: V.ALL_STAGE_CODES.filter((c) => labels[c] !== F.DEFAULT_LABELS[c]),
    subStatuses: byStage,
  };
}
router.get('/stage-labels', requireAuth, wrap(async (req, res) => {
  const out = await labelsPayload(false);
  // an outside login reads the names only
  if (require('../utils/permissions').isExternalLogin(req.user)) return res.json({ codes: out.codes, labels: out.labels }); // eslint-disable-line global-require
  return res.json(out);
}));
router.put('/stage-labels', requireAuth, wrap(async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json(ADMIN_ONLY);
  const out = await F.saveLabels(req.body && req.body.labels, req.user.name);
  if (out.error) return res.status(400).json({ error: out.error });
  for (const c of out.changes) { // eslint-disable-line no-restricted-syntax
    // eslint-disable-next-line no-await-in-loop
    await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Stage name changed', entity: 'PipelineStage', entityId: c.code, field: c.code, fieldLabel: F.DEFAULT_LABELS[c.code], fromValue: c.from, toValue: c.to });
  }
  return res.json({ ok: true, changed: out.changes.length, ...(await labelsPayload(true)) });
}));
router.post('/stage-labels/reset', requireAuth, wrap(async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json(ADMIN_ONLY);
  const undone = await F.resetLabels();
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Stage names reset to the defaults', entity: 'PipelineStage', entityId: 'ALL', fromValue: undone.map((u) => `${u.code}: ${u.from}`).join('; ').slice(0, 1000) || 'none renamed', toValue: 'Built-in names' });
  return res.json({ ok: true, reset: undone.length, ...(await labelsPayload(true)) });
}));

// ---------------------------------------------------------------- sub-statuses
router.get('/sub-statuses', requireAuth, requireInternal, wrap(async (req, res) => {
  const all = req.query.all === '1' && isAdmin(req.user);
  return res.json({ rows: (await F.subStatuses({ all })).map((s) => ({ ...s, stageLabel: V.stageLabel(s.stage) })) });
}));
router.post('/sub-statuses', requireAuth, wrap(async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json(ADMIN_ONLY);
  const v = F.cleanSub(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const out = await F.addSub(v.value, req.user.name);
  if (out.error) return res.status(409).json({ error: out.error });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Sub-status added', entity: 'PipelineSubStatus', entityId: out.value.id, field: out.value.stage, fieldLabel: V.stageLabel(out.value.stage), toValue: `${out.value.label} (order ${out.value.order})` });
  return res.status(201).json(out.value);
}));
router.post('/sub-statuses/reset', requireAuth, wrap(async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json(ADMIN_ONLY);
  const n = await F.resetSubs();
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Sub-statuses reset to the defaults', entity: 'PipelineSubStatus', entityId: 'ALL', fromValue: `${n} active`, toValue: 'none (every sub-status switched off)' });
  return res.json({ ok: true, switchedOff: n });
}));
router.put('/sub-statuses/:sid', requireAuth, wrap(async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json(ADMIN_ONLY);
  const before = await F.subStatus(req.params.sid);
  if (!before) return res.status(404).json({ error: 'That sub-status is not on file.' });
  const v = F.cleanSub(req.body, before);
  if (v.error) return res.status(400).json({ error: v.error });
  const out = await F.updateSub(before.id, v.value, req.user.name);
  if (out.error) return res.status(409).json({ error: out.error });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Sub-status changed', entity: 'PipelineSubStatus', entityId: before.id, field: before.stage, fieldLabel: V.stageLabel(before.stage), fromValue: `${before.label} (order ${before.order}${before.active ? '' : ', off'})`, toValue: `${out.value.label} (order ${out.value.order}${out.value.active ? '' : ', off'})` });
  return res.json(out.value);
}));
router.delete('/sub-statuses/:sid', requireAuth, wrap(async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json(ADMIN_ONLY);
  const before = await F.subStatus(req.params.sid);
  if (!before) return res.status(404).json({ error: 'That sub-status is not on file.' });
  const out = await F.removeSub(before.id);
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: out.removed ? 'Sub-status removed' : 'Sub-status switched off (in use)', entity: 'PipelineSubStatus', entityId: before.id, field: before.stage, fieldLabel: V.stageLabel(before.stage), fromValue: before.label });
  return res.json({ ok: true, ...out });
}));

// Who may set the sub-status: the owner of the stage the application is at (the one who may move a candidate INTO it).
router.put('/applications/:id/sub-status', requireAuth, requireInternal, wrap(async (req, res) => {
  const app = await prisma.application.findUnique({ where: { id: req.params.id }, include: { candidate: { select: { name: true } }, requirement: true } });
  if (!app) return res.status(404).json({ error: 'Application not found' });
  if (!applicationInScope(req.user, app)) return res.status(403).json(OUT_OF_SCOPE);
  const internal = hiringTypeOf(app, app.requirement) === 'TeamLink Internal Hire';
  const refusal = await canMoveToStage(req.user, app.stage, { fromStage: app.stage, internal });
  if (refusal) {
    return res.status(403).json({ error: `Only the owner of "${V.stageLabelFor(app.stage, { internal })}" sets its sub-status.`, code: 'NOT_STAGE_OWNER' });
  }
  const sid = req.body && req.body.subStatusId ? String(req.body.subStatusId) : null;
  let sub = null;
  if (sid) {
    sub = await F.subStatus(sid);
    if (!sub || !sub.active) return res.status(400).json({ error: 'That sub-status is not available.' });
    if (sub.stage !== app.stage) return res.status(400).json({ error: `"${sub.label}" belongs to ${V.stageLabel(sub.stage)}; ${app.candidate ? app.candidate.name : 'this person'} is at ${V.stageLabel(app.stage)}.` });
  }
  const out = await F.setAppSub(app, sub, req.user);
  if (!out.unchanged) {
    await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Sub-status set', entity: 'Application', entityId: app.id, field: app.stage, fieldLabel: V.stageLabel(app.stage), fromValue: out.before ? out.before.label : null, toValue: sub ? sub.label : '(cleared)' });
  }
  return res.json({ ok: true, unchanged: !!out.unchanged, subStatus: sub ? { id: sub.id, label: sub.label, order: sub.order } : null });
}));

// ---------------------------------------------------------------- share checklist
router.get('/share-checklist/settings', requireAuth, requireInternal, wrap(async (req, res) => {
  res.json({ items: F.SHARE_ITEMS, on: await F.checklistSettings() });
}));
router.put('/share-checklist/settings', requireAuth, wrap(async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json(ADMIN_ONLY);
  const { before, after } = await F.saveChecklistSettings(req.body && (req.body.on || req.body));
  const changed = F.SHARE_ITEMS.filter((i) => before[i.key] !== after[i.key]);
  for (const i of changed) { // eslint-disable-line no-restricted-syntax
    // eslint-disable-next-line no-await-in-loop
    await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Share checklist item switched', entity: 'ShareChecklist', entityId: i.key, field: i.key, fieldLabel: i.label, fromValue: before[i.key] ? 'On' : 'Off', toValue: after[i.key] ? 'On' : 'Off' });
  }
  res.json({ ok: true, items: F.SHARE_ITEMS, on: after });
}));
router.post('/share-checklist/settings/reset', requireAuth, wrap(async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json(ADMIN_ONLY);
  const { before, after } = await F.resetChecklistSettings();
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Share checklist reset to the defaults', entity: 'ShareChecklist', entityId: 'ALL', fromValue: F.SHARE_ITEMS.filter((i) => !before[i.key]).map((i) => `${i.label}: Off`).join('; ') || 'all on', toValue: 'all on' });
  res.json({ ok: true, items: F.SHARE_ITEMS, on: after });
}));
router.get('/share-checklist/:applicationId', requireAuth, requireInternal, wrap(async (req, res) => {
  const app = await prisma.application.findUnique({ where: { id: req.params.applicationId }, include: { candidate: true, requirement: { include: { client: true } } } });
  if (!app) return res.status(404).json({ error: 'Application not found' });
  if (!applicationInScope(req.user, app)) return res.status(403).json(OUT_OF_SCOPE);
  const needed = F.needsShareChecklist(app, 'SHARED_WITH_CLIENT');
  const items = needed ? await F.shareChecklistFor(app) : [];
  // the BDE team never reads salary figures: only "filled / not filled"
  return res.json({ needed: needed && items.length > 0, items: items.map((i) => ({ key: i.key, label: i.label, fact: i.fact || null, factOk: i.factOk, ticked: !!i.ticked })) });
}));

// ---------------------------------------------------------------- fee slabs
router.get('/fee-slabs/:clientId', requireAuth, requireInternal, wrap(async (req, res) => {
  if (!(await can(req.user, 'ats', 'clients', 'Commercial Terms', 'view'))) return res.status(403).json({ error: "The client's commercial terms are not part of your access." });
  const c = await prisma.client.findUnique({ where: { id: req.params.clientId }, select: { id: true, feeType: true, feeAmount: true, agreementFeePercent: true } });
  if (!c) return res.status(404).json({ error: 'Client not found' });
  const slabs = await F.slabsOf(c.id);
  return res.json({ feeType: c.feeType || 'PERCENT_CTC', feeAmount: c.feeAmount, feePercent: c.agreementFeePercent, slabs: slabs || [], text: slabs ? F.slabText(slabs) : '', types: F.FEE_TYPES.map((t) => ({ id: t, label: F.FEE_TYPE_LABELS[t] })) });
}));
router.put('/fee-slabs/:clientId', requireAuth, requireInternal, wrap(async (req, res) => {
  if (!(await can(req.user, 'ats', 'clients', 'Commercial Terms', 'edit'))) return res.status(403).json({ error: 'Changing the commercial terms needs Commercial Terms edit permission.' });
  const c = await prisma.client.findUnique({ where: { id: req.params.clientId }, select: { id: true, name: true } });
  if (!c) return res.status(404).json({ error: 'Client not found' });
  const v = F.cleanSlabs(req.body && req.body.slabs);
  if (v.error) return res.status(400).json({ error: v.error });
  const before = await F.slabsOf(c.id);
  await F.saveSlabs(c.id, v.value, req.user.name);
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Fee slabs changed', entity: 'Client', entityId: c.id, field: 'feeSlabs', fieldLabel: 'Fee slabs', fromValue: before ? F.slabText(before) : '—', toValue: F.slabText(v.value) });
  return res.json({ ok: true, slabs: v.value, text: F.slabText(v.value) });
}));

module.exports = router;
