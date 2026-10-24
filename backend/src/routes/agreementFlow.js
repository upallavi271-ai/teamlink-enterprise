// ---------------------------------------------------------------------------
// /api/agreement-flow  -  the AGREEMENT PREPARATION WORKFLOW (user, 2026-10-13). utils/agreementWorkflow.js has
// the rules; this file is the door.
//
//   GET  /waiting                what waits for me (the "Agreements waiting for you" list)
//   GET  /settings               { hrLabel, approvers (Admin), allowHrDesk }       PUT /settings  (Admin)
//   GET  /:id                    the steps, who has it, what I may do, what is missing, history
//   POST /:id/action             { action: send_to_hr | send_to_tl | back_to_bde | back_to_hr, reason }
//   GET  /:id/hr                 Purna Sir's page: client basics (read only) + sections 6, 7, 9 (no fee / terms)
//   PUT  /:id/sections           save sections 6, 7, 9 (the HR approver while "With Purna Sir", Admin any time)
//   GET  /:id/preview            the agreement text WITHOUT fee / guarantee / payment-terms numbers
//   .../documents                section 8 (same handlers as the client documents, HR rule)
//
// Not under /api/clients on purpose: the HR desk is closed out of the client routes (utils/hrDesk.js), and this
// is the ONE door it gets, for the clients that wait for it, with sections 1-5 never sent.
// Sending to the client stays POST /api/clients/:id/agreement/send (gated by the same module).
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth, can } = require('../middleware/auth');
const scope = require('../utils/scope');
const WF = require('../utils/agreementWorkflow');
const profile = require('../utils/clientProfile');
const { logAudit } = require('../utils/audit');
const { findClientDuplicates, describeMatches } = require('../utils/clientDuplicates');
const CLOC = require('../utils/clientLocations'); // one company, many locations (2026-10-22)

const router = express.Router();
router.use(requireAuth);

const LEGACY_TEXT = ['legalName', 'gst', 'pan', 'tan', 'billingContactName', 'billingContactDesignation', 'billingContactPhone', 'billingContactEmail'];
const BASICS = ['id', 'name', 'clientCode', 'industry', 'location', 'state', 'country', 'ownerDepartment', 'bdeOwner', 'contactName', 'website', 'companyType'];

// who may be here at all: Admin / SA, the BDE TL, the BDE desk, the HR approver
router.use(async (req, res, next) => {
  const r = await WF.rolesOf(req.user);
  req.wfRoles = r;
  if (r.admin || r.bdeTl || r.bdeDesk || r.hr) return next();
  return res.status(403).json({ error: 'This is for the BDE team and the person who fills Tax & billing.' });
});

const steps = (stage, cfg) => {
  const order = ['DRAFT', 'WITH_HR', 'WITH_TL', 'SENT', 'SIGNED', 'ACTIVE'];
  const at = order.indexOf(stage);
  return order.map((k, i) => ({ key: k, label: WF.labelOf(k, cfg), state: i < at ? 'done' : (i === at ? 'current' : 'todo') }));
};

router.get('/settings', async (req, res) => {
  const s = await WF.settings({ fresh: true });
  const r = req.wfRoles;
  const canCommercial = await can(req.user, 'ats', 'clients', 'Commercial Terms', 'edit').catch(() => false);
  res.json({ hrLabel: s.hrLabel, allowHrDesk: s.allowHrDesk, canCommercial: !!canCommercial, roles: { admin: r.admin, bdeTl: r.bdeTl, bdeDesk: r.bdeDesk, hr: r.hr }, ...(req.wfRoles.admin ? { approvers: s.approvers, updatedAt: s.updatedAt, updatedByName: s.updatedByName } : {}), canEdit: req.wfRoles.admin });
});
router.put('/settings', async (req, res) => {
  if (!req.wfRoles.admin) return res.status(403).json({ error: 'Only an Admin changes who fills Tax & billing.' });
  const out = await WF.saveSettings(req.body, req.user);
  if (out.error) return res.status(400).json({ error: out.error });
  await logAudit({ userId: req.user.id, action: 'Agreement HR approvers changed', entity: 'Setting', entityId: WF.SETTINGS_KEY, fromValue: out.before.approvers.join(', '), toValue: out.settings.approvers.join(', ') });
  return res.json({ hrLabel: out.settings.hrLabel, allowHrDesk: out.settings.allowHrDesk, approvers: out.settings.approvers, canEdit: true });
});

// what waits for me
router.get('/waiting', async (req, res) => {
  const r = req.wfRoles;
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: WF.PREFIX } } });
  const parsed = rows.map((x) => { try { return { id: x.key.slice(WF.PREFIX.length), wf: JSON.parse(x.value) }; } catch { return null; } }).filter(Boolean);
  const want = parsed.filter((p) => ['WITH_HR', 'WITH_TL', 'DRAFT'].includes(p.wf.stage));
  if (!want.length) return res.json({ count: 0, rows: [], hrLabel: r.cfg.hrLabel });
  const scopeW = r.hr && !r.admin && !r.bdeTl && !r.bdeDesk ? {} : scope.clientWhere(req.user);
  const clients = await prisma.client.findMany({ where: { AND: [scopeW, { id: { in: want.map((w) => w.id) } }] }, select: { id: true, name: true, agreementStatus: true, ownerDepartment: true, bdeOwner: true, clientCode: true } });
  const wfOf = new Map(want.map((w) => [w.id, w.wf]));
  const out = [];
  clients.forEach((c) => {
    const wf = wfOf.get(c.id);
    const stage = WF.stageOf(c, wf);
    const last = (wf.history || [])[(wf.history || []).length - 1] || null;
    const mine = (stage === 'WITH_HR' && r.hr) || (stage === 'WITH_TL' && (r.bdeTl || r.admin))
      || (stage === 'DRAFT' && last && String(last.action).startsWith('back_to') && (r.bdeDesk || r.bdeTl));
    if (!mine) return;
    out.push({
      id: c.id, name: c.name, clientCode: c.clientCode || null, department: c.ownerDepartment || null, stage, stageLabel: WF.labelOf(stage, r.cfg),
      todo: stage === 'WITH_HR' ? 'Fill Tax & billing' : (stage === 'WITH_TL' ? 'Check everything and send to the client' : 'Fix what was asked and send it again'),
      since: last ? last.at : null, from: last ? last.byName : null, reason: stage === 'DRAFT' && last ? last.reason || null : null,
    });
  });
  out.sort((a, b) => String(a.since || '').localeCompare(String(b.since || '')));
  return res.json({ count: out.length, rows: out, hrLabel: r.cfg.hrLabel });
});

// one client; the HR approver may open only the ones that reach / reached it
router.param('id', async (req, res, next, id) => {
  const client = await prisma.client.findUnique({ where: { id } });
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const wf = (await WF.loadRow(id)) || { history: [] };
  const r = req.wfRoles;
  let ok = false;
  if (r.admin) ok = true;
  else if (r.bdeTl || r.bdeDesk) ok = !!(await prisma.client.findFirst({ where: { AND: [{ id }, scope.clientWhere(req.user)] }, select: { id: true } }));
  if (!ok && r.hr) ok = WF.stageOf(client, wf) === 'WITH_HR' || (wf.history || []).some((h) => h.by === req.user.id || h.to === 'WITH_HR');
  if (!ok) return res.status(403).json({ error: 'This client is not in your area.' });
  req.client = client; req.wf = wf;
  return next();
});

router.get('/:id', async (req, res) => {
  const { client, wf } = req;
  const r = req.wfRoles;
  const rights = await WF.rightsFor(req.user, client, wf);
  const stage = rights.stage;
  const names = new Map();
  const people = [...new Set((wf.history || []).map((h) => h.by).filter(Boolean))];
  if (people.length) (await prisma.user.findMany({ where: { id: { in: people } }, select: { id: true, name: true } })).forEach((u) => names.set(u.id, u.name));
  const profileMiss = require('../utils/clientProfile').missingRequired(client).map((m) => m.label);
  const taxMiss = WF.missingTax(client);
  const waiting = { DRAFT: 'the BDE', WITH_HR: r.cfg.hrLabel, WITH_TL: 'the BDE team lead', SENT: 'the client', SIGNED: 'TeamLink', ACTIVE: null }[stage] || null;
  res.json({
    clientId: client.id, name: client.name, stage, stageLabel: WF.labelOf(stage, r.cfg), colour: WF.colourOf(stage), steps: steps(stage, r.cfg),
    waitingOn: waiting, hrLabel: r.cfg.hrLabel,
    rights: { seesHr: rights.seesHr, editHr: rights.editHr, editCommercial: rights.editCommercial, lockedCommercial: rights.lockedCommercial, ...rights.can, roles: rights.roles },
    missing: { commercial: profileMiss, tax: taxMiss },
    hasDocument: !!client.agreementDocument,
    history: (wf.history || []).slice().reverse().map((h) => ({ at: h.at, who: names.get(h.by) || h.byName || '', from: WF.labelOf(h.from, r.cfg), to: WF.labelOf(h.to, r.cfg), action: h.action, reason: h.reason || null })),
    lastBackReason: stage === 'DRAFT' || stage === 'WITH_HR' ? ((wf.history || []).slice().reverse().find((h) => String(h.action).startsWith('back_to')) || {}).reason || null : null,
  });
});

router.post('/:id/action', async (req, res) => {
  const out = await WF.move(req.user, req.client, String((req.body || {}).action || ''), req.body || {});
  if (!out.ok) return res.status(out.status || 400).json({ error: out.error, missing: out.missing || undefined, needReason: out.needReason || undefined });
  return res.json({ ok: true, stage: out.stage, stageLabel: out.label, told: out.told });
});

// ---- Purna Sir's page --------------------------------------------------------------
function hrPayload(client) {
  const out = {};
  BASICS.forEach((k) => { out[k] = client[k] === undefined ? null : client[k]; });
  WF.HR_KEYS.forEach((k) => { if (client[k] !== undefined) out[k] = client[k]; });
  delete out.bankAccountNoEnc;
  out.bankAccountMasked = client.bankAccountLast4 ? `XXXX${client.bankAccountLast4}` : null;
  if (out.billingSameAsAddress === null || out.billingSameAsAddress === undefined) out.billingSameAsAddress = true;
  return out;
}
router.get('/:id/hr', async (req, res) => {
  const rights = await WF.rightsFor(req.user, req.client, req.wf);
  if (!rights.seesHr) return res.status(403).json({ error: 'Tax & billing is filled by the HR step. Ask an Admin.' });
  return res.json({ client: hrPayload(req.client), editable: rights.editHr, stage: rights.stage });
});

router.put('/:id/sections', async (req, res) => {
  const { client } = req;
  const rights = await WF.rightsFor(req.user, client, req.wf);
  if (!rights.editHr) {
    return res.status(403).json({ error: rights.roles.hr ? `Only while it is with ${req.wfRoles.cfg.hrLabel}. It is "${WF.labelOf(rights.stage, req.wfRoles.cfg)}" now.` : 'Only the HR step or an Admin fills these.' });
  }
  const body = {};
  Object.keys(req.body || {}).forEach((k) => { if (WF.HR_KEYS.includes(k)) body[k] = req.body[k]; });
  const bad = profile.formatErrors(body);
  if (bad.length) return res.status(400).json({ error: bad[0].error, errors: bad });
  const data = {};
  LEGACY_TEXT.forEach((k) => {
    if (body[k] === undefined) return;
    const v = String(body[k] === null ? '' : body[k]).trim();
    data[k] = ['gst', 'pan', 'tan'].includes(k) ? (v.toUpperCase() || null) : (v || null);
  });
  let picked;
  try { picked = profile.pickProfile(body); } catch (err) {
    return res.status(500).json({ error: err.code === 'NO_SECRET_KEY' ? 'The bank account cannot be saved until the server has its secret key set.' : 'Could not save the bank account.' });
  }
  Object.assign(data, picked.data);
  if (data.billingSameAsAddress) data.billingAddress = null;
  const same = (a, b) => String(a ?? '').trim() === String(b ?? '').trim();
  const changed = Object.keys(data).filter((k) => !same(data[k], client[k]));
  // the same duplicate guard as the client form: GSTIN / PAN / name of ANOTHER client
  const identity = changed.filter((k) => ['legalName', 'gst', 'pan'].includes(k));
  if (identity.length) {
    const probe = {}; identity.forEach((k) => { probe[k] = data[k]; });
    let dup = await findClientDuplicates(probe, { excludeId: client.id });
    // Another LOCATION of the same company shares the legal name (and often the GSTIN / PAN): expected, never a stop.
    dup = CLOC.withoutOtherLocations(dup, client, await CLOC.siblingsOf(client), null);
    if (dup.blocking && (req.body || {}).allowDuplicate !== true && (req.body || {}).confirmSeparate !== true) {
      return res.status(409).json({ error: 'Another client already has this GST number / PAN / legal name. If it is another location of the same company, press Save anyway.', code: 'DUPLICATE_CLIENT', duplicates: dup.matches, blocking: true });
    }
    if (dup.total > 0 && (req.body || {}).allowDuplicate === true) {
      await logAudit({ userId: req.user.id, action: 'Client saved despite possible duplicate', entity: 'Client', entityId: client.id, toValue: describeMatches(dup.matches).slice(0, 1000), reason: 'HR step: Save anyway' });
    }
  }
  const updated = Object.keys(data).length ? await prisma.client.update({ where: { id: client.id }, data }) : client;
  const names = changed.map((k) => (k === 'bankAccountNoEnc' ? 'bank account' : k));
  await logAudit({ userId: req.user.id, action: 'Client updated', entity: 'Client', entityId: client.id, toValue: (names.length ? `Tax & billing step: ${names.join(', ')}` : 'No field changed').slice(0, 1000) });
  return res.json({ ok: true, saved: names.length, client: hrPayload(updated), missing: WF.missingTax(updated), pendingFields: picked.pending });
});

// the agreement text WITHOUT the commercial numbers (fee, guarantee, payment terms)
router.get('/:id/preview', async (req, res) => {
  const rights = await WF.rightsFor(req.user, req.client, req.wf);
  if (!rights.seesHr) return res.status(403).json({ error: 'Not available for your role.' });
  const A = require('../utils/agreement');
  const c = {
    ...req.client, feeType: 'PERCENT_CTC', agreementFeePercent: 77.77, feeAmount: null, guaranteePeriod: '777 Days', replacementTerms: '', specialTerms: '',
    paymentTerms: 'Invoice 777 days after joining; payment due within 777 days of invoice', paymentDue: '777 days after invoice', invoiceTrigger: 'After joining + 777 days',
  };
  let text = '';
  try { text = A.buildAgreementDocument(c, await A.consultantParty(), { preview: true }); } catch { text = ''; }
  text = String(text).replace(/77\.77|\b7{3}\b|\b7{3,}\b/g, '(set by the BDE)');
  return res.json({ text, note: 'The fee, guarantee and payment terms are set by the BDE and checked by the BDE team lead. You do not see them.' });
});

// ---- section 8: documents -----------------------------------------------------------
require('./clientDocumentRoutes')(router, {
  async mayRead(req, res) {
    if (!profile.docsAvailable()) { res.status(503).json({ error: 'Documents can be added after the database update. Please try again later.' }); return false; }
    const rights = await WF.rightsFor(req.user, req.client, req.wf);
    if (!rights.seesHr) { res.status(403).json({ error: 'The documents are added by the HR step. Ask an Admin.' }); return false; }
    return true;
  },
  async mayEdit(req, res) {
    if (!profile.docsAvailable()) { res.status(503).json({ error: 'Documents can be added after the database update. Please try again later.' }); return false; }
    const rights = await WF.rightsFor(req.user, req.client, req.wf);
    if (!rights.editHr) { res.status(403).json({ error: 'Only the HR step (while it is with them) or an Admin adds documents.' }); return false; }
    return true;
  },
  async canEdit(req) { return (await WF.rightsFor(req.user, req.client, req.wf)).editHr; },
});

module.exports = router;
