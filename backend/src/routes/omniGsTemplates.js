// /api/outreach/gs/templates : the Templates page (Manage Templates). Behind login + "may use Omni-Channel" (routes/outreach.js).
// WhatsApp / SMS / Email templates are the ones in the template hub (outreach/hub.js over OutreachTemplate and the other stores); nothing is copied.
// Own tables (self-provisioned): RCS assistants + templates, WhatsApp Flows, voice scripts (outreach/tplOwn.js).
// Nothing here sends a message. "Send to Meta" calls Meta only when the WhatsApp Cloud account is connected, never in test mode.
const express = require('express');
const S = require('../outreach/store');
const A = require('../outreach/access');
const T = require('../outreach/templates');
const Hub = require('../outreach/hub');
const P = require('../outreach/tplPolicy');
const Meta = require('../outreach/tplMeta');
const Waba = require('../outreach/tplWaba');
const X = require('../outreach/tplExtra');
const Rcs = require('../outreach/rcs');
const Own = require('../outreach/tplOwn');
const { deptOf } = require('../outreach/chrome');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const send = (res, out) => (out && out.error ? res.status(out.status || 400).json({ error: out.error, problems: out.problems, issues: out.issues, code: out.code, step: out.step }) : res.json(out));
const LANGS = [['en_US', 'English (US)'], ['hi', 'Hindi'], ['te', 'Telugu']];
const needTables = wrap(async (req, res, next) => {
  if (await S.ready()) return next();
  return res.status(503).json({ error: 'Omni-Channel is being set up. Please try again in a little while.', setup: true });
});
const where = (req) => (req.query.where === 'all' ? 'all' : (['ATS', 'Job Portal', 'HRMS / internal', 'Omni-Channel'].includes(req.query.where) ? req.query.where : 'Omni-Channel'));
const deptName = (req) => { const d = deptOf(req.user, req.query.dept); return d === null ? null : d; };
const audienceFor = (u, b) => (A.kind(u) === 'hr' ? 'internal' : (A.isAdmin(u) && b.audience === 'internal' ? 'internal' : 'candidate_lead'));

router.get('/meta', wrap(async (req, res) => {
  const u = req.user;
  res.json({
    categories: T.CATEGORIES, languages: LANGS, variables: P.VARS.map((v) => ({ name: v, words: P.VAR_WORDS[v], example: P.SAMPLE[v] })), codeWords: P.CODE_WORDS, limits: P.LIMITS,
    canEdit: A.has('canEditTemplates')(u), canEditInternal: A.has('canEditInternalTemplates')(u), canWrite: Own.mayWrite(u), isAdmin: A.isAdmin(u), staffOnly: A.kind(u) === 'hr',
    whatsapp: await Meta.state(),
    rcs: { types: Rcs.TYPES, actions: Rcs.ACTION_TYPES, maxActions: Rcs.MAX_ACTIONS, agentCategories: Rcs.AGENT_CATEGORIES, billing: Rcs.BILLING },
    flowTypes: X.FLOW_TYPES, buttonTypes: T.BUTTON_TYPES,
  });
}));

router.get('/tree', needTables, wrap(async (req, res) => { const d = deptName(req); res.json(await X.tree(req.user, { where: where(req), dept: d || '' })); }));
router.get('/list', needTables, wrap(async (req, res) => {
  const d = deptName(req);
  if (d === null) return res.json({ items: [], total: 0 });
  return res.json(await X.list(req.user, { channel: String(req.query.channel || 'whatsapp'), where: where(req), q: req.query.q, approval: req.query.approval, dept: d }));
}));
router.get('/item/:id', needTables, wrap(async (req, res) => {
  const row = await T.get(req.user, req.params.id);
  if (!row) return res.status(404).json({ error: 'This template was not found.' });
  const v = T.view(row);
  return res.json({ template: v, policy: v.channel === 'whatsapp' ? P.check(Meta.policyInput(v)) : null, canEdit: T.canEdit(req.user, row.audience) });
}));

// the live check of a template while it is being written (nothing is saved)
router.post('/check', needTables, wrap(async (req, res) => {
  const b = req.body || {};
  const t = T.fromBody({ ...b, channel: String(b.channel || 'whatsapp') });
  t.audience = audienceFor(req.user, b);
  const problems = T.problems(t);
  const v = { name: t.name, category: T.catOf(t.category, t.promotional), body: t.body, extra: t.extra };
  return res.json({ problems, policy: t.channel === 'whatsapp' ? P.check(Meta.policyInput(v)) : null, preview: T.preview(t), map: t.channel === 'whatsapp' ? P.mapping(t.body) : null, ...T.readiness({ ...t, status: 'active' }) });
}));

// ---- templates (OutreachTemplate through the hub) ---------------------------------------------------------
const signature = (v) => { const e = { ...(v.extra || {}) }; delete e.review; delete e.meta; return JSON.stringify([v.body, v.category, v.subject, e]); };
router.post('/outreach', needTables, wrap(async (req, res) => {
  const b = { ...(req.body || {}) };
  if (!A.isAdmin(req.user)) delete b.waApprovalStatus; // only an Admin (or Meta's own answer) sets the approval
  b.source = 'outreach'; b.channel = String(b.channel || 'email').toLowerCase(); b.audience = audienceFor(req.user, b);
  if (b.channel === 'whatsapp' && !b.waLanguage) b.waLanguage = 'en_US';
  const out = await Hub.create(req.user, b);
  if (out.error) return send(res, out);
  if (b.channel === 'whatsapp' && out.template) { // the Meta name: lowercase with underscores
    const slug = P.slug(out.template.name);
    await S.run('UPDATE "OutreachTemplate" SET waTemplateName = COALESCE(NULLIF(waTemplateName, \'\'), ?) WHERE id = ?', slug, out.template.id);
    out.template = T.view((await S.q('SELECT * FROM "OutreachTemplate" WHERE id = ?', out.template.id))[0]);
  }
  return res.json(out);
}));
router.put('/outreach/:id', needTables, wrap(async (req, res) => {
  const b = { ...(req.body || {}) };
  const row = await T.get(req.user, req.params.id);
  if (!row || row.status !== 'active') return res.status(404).json({ error: 'This template was not found.' });
  const adminSets = A.isAdmin(req.user) && b.waApprovalStatus !== undefined;
  if (!A.isAdmin(req.user)) delete b.waApprovalStatus;
  const before = T.view(row);
  const out = await Hub.update(req.user, `outreach:${req.params.id}`, b);
  if (out.error) return send(res, out);
  let after = T.view((await S.q('SELECT * FROM "OutreachTemplate" WHERE id = ?', req.params.id))[0]);
  let resubmit = false;
  // WhatsApp approved the OLD words. A change to the words, category or layout means WhatsApp has to look again: it goes back to "Not sent to Meta".
  if (after.channel === 'whatsapp' && ['approved', 'pending'].includes(before.waApprovalStatus) && !adminSets && signature(before) !== signature(after)) {
    await S.run('UPDATE "OutreachTemplate" SET waApprovalStatus = \'draft\' WHERE id = ?', req.params.id);
    await Waba.resetFor(req.params.id); // every WhatsApp account has to look at the new words
    after = T.view((await S.q('SELECT * FROM "OutreachTemplate" WHERE id = ?', req.params.id))[0]);
    resubmit = true;
  }
  return res.json({ ok: 'Saved.', template: after, resubmit });
}));
router.post('/outreach/:id/duplicate', needTables, wrap(async (req, res) => send(res, await T.duplicate(req.user, req.params.id))));
router.delete('/outreach/:id', needTables, wrap(async (req, res) => send(res, await T.archive(req.user, req.params.id))));
router.post('/outreach/:id/submit', needTables, wrap(async (req, res) => send(res, await Meta.submit(req.user, req.params.id, { numberId: (req.body || {}).numberId || null }))));
router.post('/outreach/:id/sync', needTables, wrap(async (req, res) => send(res, await Meta.sync(req.user, req.params.id, { numberId: (req.body || {}).numberId || null }))));
// the SAME template for every number (outreach/tplWaba.js): one status per WhatsApp account; an Admin sends it to every account, anybody who edits may ask Meta
router.get('/outreach/:id/accounts', needTables, wrap(async (req, res) => send(res, await Waba.accountsView(req.user, req.params.id))));
router.post('/outreach/:id/submit-all', needTables, wrap(async (req, res) => send(res, await Waba.submitAll(req.user, req.params.id))));
router.post('/outreach/:id/check-all', needTables, wrap(async (req, res) => send(res, await Waba.checkAll(req.user, req.params.id))));
// the older stores (ATS / HRMS message templates, saved jobs ...): edited through their owner's own rules
router.put('/other/:key', needTables, wrap(async (req, res) => {
  const key = String(req.params.key || '');
  if (key.startsWith('outreach:') || key.startsWith('script:')) return res.status(400).json({ error: 'Use the Omni-Channel template route for this one.' });
  const b = { ...(req.body || {}) };
  if (!A.isAdmin(req.user)) delete b.waStatus;
  return send(res, await Hub.update(req.user, key, b));
}));
router.post('/other', needTables, wrap(async (req, res) => send(res, await Hub.create(req.user, { ...(req.body || {}), source: 'message' }))));

// ---- voice scripts -----------------------------------------------------------------------------------------
router.post('/voice', wrap(async (req, res) => send(res, await X.voiceCreate(req.user, req.body || {}, deptName(req) || ''))));
router.put('/voice/:id', wrap(async (req, res) => send(res, await X.voiceUpdate(req.user, req.params.id, req.body || {}))));
router.delete('/voice/:id', wrap(async (req, res) => send(res, await X.voiceRemove(req.user, req.params.id))));

// ---- WhatsApp Flows ---------------------------------------------------------------------------------------
router.get('/flows', wrap(async (req, res) => res.json({ flows: await X.flowList(req.user), flowTypes: X.FLOW_TYPES })));
router.post('/flows', wrap(async (req, res) => send(res, await X.flowCreate(req.user, req.body || {}, deptName(req) || ''))));
router.put('/flows/:id', wrap(async (req, res) => send(res, await X.flowUpdate(req.user, req.params.id, req.body || {}))));
router.delete('/flows/:id', wrap(async (req, res) => send(res, await X.flowRemove(req.user, req.params.id))));

// ---- RCS ------------------------------------------------------------------------------------------------------------
router.get('/rcs/agents', wrap(async (req, res) => res.json({ agents: await Rcs.agents(req.user) })));
router.post('/rcs/agents', wrap(async (req, res) => send(res, await Rcs.createAgent(req.user, req.body || {}, deptName(req) || ''))));
router.put('/rcs/agents/:id', wrap(async (req, res) => send(res, await Rcs.updateAgent(req.user, req.params.id, req.body || {}))));
router.delete('/rcs/agents/:id', wrap(async (req, res) => send(res, await Rcs.removeAgent(req.user, req.params.id))));
router.post('/rcs/agents/check', wrap(async (req, res) => {
  const d = Rcs.cleanAgent((req.body || {}).data || req.body);
  const step = Number((req.body || {}).step) || 0;
  const errors = step ? Rcs.agentErrors(d, step) : [1, 2, 3, 4].flatMap((s) => Rcs.agentErrors(d, s));
  return res.json({ errors, byStep: [1, 2, 3, 4].map((n) => Rcs.agentErrors(d, n)) });
}));
router.get('/rcs/templates', wrap(async (req, res) => res.json({ templates: await Rcs.templates(req.user, { agentId: req.query.agentId, q: req.query.q, type: req.query.type }) })));
router.post('/rcs/templates', wrap(async (req, res) => send(res, await Rcs.createTemplate(req.user, req.body || {}, deptName(req) || ''))));
router.put('/rcs/templates/:id', wrap(async (req, res) => send(res, await Rcs.updateTemplate(req.user, req.params.id, req.body || {}))));
router.post('/rcs/templates/:id/duplicate', wrap(async (req, res) => send(res, await Rcs.duplicateTemplate(req.user, req.params.id))));
router.delete('/rcs/templates/:id', wrap(async (req, res) => send(res, await Rcs.removeTemplate(req.user, req.params.id))));
router.post('/rcs/payload', wrap(async (req, res) => {
  const b = req.body || {}; const type = Object.keys(Rcs.TYPES).includes(b.type) ? b.type : 'text';
  return res.json({ payload: Rcs.payload(type, Rcs.cleanForm(type, b.form), String(process.env.APP_BASE_URL || '').replace(/\/+$/, '')) });
}));

module.exports = router;
