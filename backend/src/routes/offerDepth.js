// ---------------------------------------------------------------------------
// /api/ats - OFFER LETTER TEMPLATES and SALARY BREAKUP (audit 252 / 253). Rules: utils/offerTemplates.js. Admin = Super Admin / Admin.
//
//   GET    /offer-templates                  list (Offers / view)             POST /offer-templates, PUT /offer-templates/:id, DELETE  (Admin)
//   GET    /offer-breakup-settings           the default percent split        PUT /offer-breakup-settings   { basic, hra, pf, gratuity, bonus }  (Admin)
//   GET    /offers/:id/breakup               the saved breakup, else worked out from the CTC     PUT /offers/:id/breakup { components }   DELETE
//   GET    /offers/:id/template              the template this offer uses (and why)              PUT /offers/:id/template { templateId|null }
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm, requireProduct } = require('../middleware/auth');
const { applicationWhere } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const OT = require('../utils/offerTemplates');

const router = express.Router();
router.use(requireAuth);
router.use(requireProduct('ats'));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isAdmin = (u) => ['SUPER_ADMIN', 'ADMIN'].includes(u.role);
const adminOnly = (req, res, next) => (isAdmin(req.user) ? next() : res.status(403).json({ error: 'Only an Admin can change offer letter templates.' }));
const view = requirePerm('ats', 'interviews', 'Offers', 'view');
const edit = requirePerm('ats', 'interviews', 'Offers', 'edit');

router.get('/offer-templates', view, wrap(async (req, res) => {
  res.json({ rows: await OT.list(), tokens: OT.TOKENS, canEdit: isAdmin(req.user) });
}));
router.post('/offer-templates', adminOnly, wrap(async (req, res) => {
  const out = await OT.clean(req.body || {});
  if (out.error) return res.status(400).json({ error: out.error });
  const t = await OT.save(null, out.value, req.user.name);
  await logAudit({ userId: req.user.id, action: 'Offer letter template added', entity: 'OfferTemplate', entityId: t.id, toValue: t.name });
  res.status(201).json(t);
}));
router.put('/offer-templates/:id', adminOnly, wrap(async (req, res) => {
  const before = await OT.get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Template not found' });
  const out = await OT.clean({ ...before, ...(req.body || {}) });
  if (out.error) return res.status(400).json({ error: out.error });
  const t = await OT.save(before.id, out.value, req.user.name);
  await logAudit({ userId: req.user.id, action: 'Offer letter template changed', entity: 'OfferTemplate', entityId: t.id, fromValue: before.body.slice(0, 300), toValue: t.body.slice(0, 300) });
  res.json(t);
}));
router.delete('/offer-templates/:id', adminOnly, wrap(async (req, res) => {
  const before = await OT.get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Template not found' });
  await OT.remove(before.id);
  await logAudit({ userId: req.user.id, action: 'Offer letter template removed', entity: 'OfferTemplate', entityId: before.id, fromValue: before.name });
  res.json({ ok: true });
}));

router.get('/offer-breakup-settings', view, wrap(async (req, res) => {
  const s = await OT.splitSetting();
  res.json({ ...s, parts: OT.PARTS, special: Math.round((100 - Object.values(s.split).reduce((a, b) => a + b, 0)) * 100) / 100, canEdit: isAdmin(req.user) });
}));
router.put('/offer-breakup-settings', adminOnly, wrap(async (req, res) => {
  const out = await OT.saveSplit(req.body || {}, req.user);
  if (out.error) return res.status(400).json({ error: out.error });
  await logAudit({ userId: req.user.id, action: 'Salary breakup split changed', entity: 'AppSetting', entityId: 'offer.breakupSplit', fromValue: JSON.stringify(out.before), toValue: JSON.stringify(out.split) });
  res.json({ ok: true, split: out.split });
}));

async function loadApp(req, res) {
  const app = await prisma.application.findFirst({
    where: { AND: [{ id: req.params.id }, applicationWhere(req.user)] },
    include: { candidate: { select: { name: true } }, requirement: { select: { clientId: true, internal: true, title: true, client: { select: { industry: true, name: true } } } } },
  });
  if (!app) { res.status(404).json({ error: 'Offer not found' }); return null; }
  return app;
}
router.get('/offers/:id/breakup', view, wrap(async (req, res) => {
  const app = await loadApp(req, res); if (!app) return;
  res.json(await OT.getBreakup(app));
}));
router.put('/offers/:id/breakup', edit, wrap(async (req, res) => {
  const app = await loadApp(req, res); if (!app) return;
  const out = await OT.saveBreakup(app, (req.body || {}).components, req.user.name);
  if (out.error) return res.status(400).json({ error: out.error });
  await logAudit({ userId: req.user.id, action: 'Offer salary breakup saved', entity: 'Application', entityId: app.id, toValue: JSON.stringify(out.components) });
  res.json(await OT.getBreakup(app));
}));
router.delete('/offers/:id/breakup', edit, wrap(async (req, res) => {
  const app = await loadApp(req, res); if (!app) return;
  await OT.clearBreakup(app.id);
  await logAudit({ userId: req.user.id, action: 'Offer salary breakup removed', entity: 'Application', entityId: app.id });
  res.json(await OT.getBreakup(app));
}));
router.get('/offers/:id/template', view, wrap(async (req, res) => {
  const app = await loadApp(req, res); if (!app) return;
  const picked = await OT.pick(app, '');
  res.json({ templateId: picked.templateId, templateName: picked.templateName, why: picked.why, templates: (await OT.list({ all: false })).map((t) => ({ id: t.id, name: t.name, clientName: t.clientName, industry: t.industry, isDefault: t.isDefault })) });
}));
router.put('/offers/:id/template', edit, wrap(async (req, res) => {
  const app = await loadApp(req, res); if (!app) return;
  const out = await OT.chooseForOffer(app.id, (req.body || {}).templateId || null, req.user.name);
  if (out.error) return res.status(400).json({ error: out.error });
  await logAudit({ userId: req.user.id, action: 'Offer letter template chosen for an offer', entity: 'Application', entityId: app.id, toValue: String((req.body || {}).templateId || 'automatic') });
  const picked = await OT.pick(app, '');
  res.json({ ok: true, templateId: picked.templateId, templateName: picked.templateName, why: picked.why });
}));

module.exports = router;
