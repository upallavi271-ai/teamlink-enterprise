// ---------------------------------------------------------------------------
// /api/messaging/templates — the Message templates screen and the pickers.
//
//   GET    /                the list (+ who may edit)                 view roles
//   GET    /tokens          the details a message can contain, with samples
//   GET    /usable          active templates for a picker (channel / purpose /
//                           audience / language)                      any staff login
//   GET    /:id             one template + its versions              view roles
//   POST   /                create                                   Admin / HR / TL
//   PUT    /:id             edit = a NEW VERSION (old ones kept)     Admin / HR / TL
//   POST   /:id/restore     put an old version's wording back (as a new version)
//   DELETE /:id             delete a template somebody created (built-in: switch off)
//
// The WhatsApp template name + approval status and the SMS DLT id + sender id
// can be changed by an Admin only: they are copied from the Meta console / the
// SMS provider, never made up here.
// ---------------------------------------------------------------------------

const express = require('express');
const prisma = require('../db');
const T = require('../utils/messageTemplates');

const router = express.Router();

const staff = (u) => !['CLIENT', 'CANDIDATE'].includes(u.role) && !['CLIENT', 'CANDIDATE'].includes(u.atsRole);
const needSetup = (res) => res.status(503).json({ error: 'Message templates are being set up on this server. The built-in wording is used until then.' });

router.get('/tokens', async (req, res) => {
  if (!staff(req.user)) return res.status(403).json({ error: 'Not available to this login' });
  const extra = await T.extraLanguages().catch(() => []);
  return res.json({ tokens: T.TOKENS.map(({ key, label, sample, group, aliases }) => ({ key, label, sample, group, aliases })), languages: [...T.LANGUAGES, ...extra], channels: T.CHANNELS, maxBody: T.MAX_BODY });
});

router.get('/usable', async (req, res, next) => {
  try {
    if (!staff(req.user)) return res.status(403).json({ error: 'Not available to this login' });
    if (!T.supported()) return res.json({ templates: [], setup: false });
    let rows = await T.list({ channel: req.query.channel, purpose: req.query.purpose, language: req.query.language, audience: req.query.audience, activeOnly: true });
    // The Accountant may use the payment reminder templates only (utils/contactAccess.js).
    const rule = await require('../utils/contactAccess').ruleFor(req.user, 'clients').catch(() => null); // eslint-disable-line global-require
    if (rule && rule.allowed && rule.purposes) rows = rows.filter((t) => rule.purposes.includes(t.purpose));
    return res.json({
      setup: true,
      templates: rows.map((t) => ({
        id: t.id, purpose: t.purpose, purposeLabel: t.purposeLabel, audience: t.audience, channel: t.channel, language: t.language, name: t.name,
        subject: t.subject, body: t.body, isDefault: t.isDefault, version: t.version, waStatus: t.waStatus, waTemplateName: t.waTemplateName, dltTemplateId: t.dltTemplateId,
        locked: (t.channel === 'WhatsApp' && t.waStatus === 'Approved') || (t.channel === 'SMS' && !!t.dltTemplateId),
      })),
    });
  } catch (err) { return next(err); }
});

// THE TEMPLATES META APPROVED FOR ONE NUMBER (founder 2026-11-04: "only ahh number templates matrame kanipinchali"): the names Meta
// lists as APPROVED in that number's own WhatsApp account, so the message box offers only what that number can really send.
// { known: false } when Meta cannot be asked (the box then shows every template, as before). Kept 5 minutes per account.
const approvedCache = new Map();
router.get('/wa-approved', async (req, res, next) => {
  try {
    if (!staff(req.user)) return res.status(403).json({ error: 'Not available to this login' });
    const numberId = String(req.query.numberId || '');
    const cfg = await require('../utils/whatsappCloud').whatsappConfig(numberId ? { numberId } : undefined); // eslint-disable-line global-require
    if (!cfg || !cfg.configured || !cfg.wabaId || require('../utils/whatsappCloud').simulated(cfg)) return res.json({ known: false }); // eslint-disable-line global-require
    const k = String(cfg.wabaId);
    const c = approvedCache.get(k);
    if (c && Date.now() - c.at < 5 * 60 * 1000) return res.json(c.v);
    const got = await require('../outreach/tplFromMeta').listAt(cfg); // eslint-disable-line global-require
    const v = got.error ? { known: false } : { known: true, names: [...new Set(got.list.filter((t) => String(t.status).toUpperCase() === 'APPROVED').map((t) => t.name))] };
    if (!got.error) approvedCache.set(k, { at: Date.now(), v });
    return res.json(v);
  } catch (err) { return next(err); }
});

router.get('/', async (req, res, next) => {
  try {
    if (!T.canView(req.user)) return res.status(403).json({ error: 'Only an Admin, HR, a Team Lead or a manager can open Message templates.' });
    if (!T.supported()) return needSetup(res);
    const rows = await T.list({ channel: req.query.channel, language: req.query.language, audience: req.query.audience, q: req.query.q });
    return res.json({
      canEdit: T.canEdit(req.user), isAdmin: T.isAdmin(req.user),
      templates: rows, purposes: await T.purposes(), languages: [...T.LANGUAGES, ...(await T.extraLanguages())],
    });
  } catch (err) { return next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    if (!T.canView(req.user)) return res.status(403).json({ error: 'Only an Admin, HR, a Team Lead or a manager can open Message templates.' });
    if (!T.supported()) return needSetup(res);
    const t = await T.get(req.params.id);
    if (!t) return res.status(404).json({ error: 'No such template.' });
    return res.json({ ...t, canEdit: T.canEdit(req.user), isAdmin: T.isAdmin(req.user) });
  } catch (err) { return next(err); }
});

const mustEdit = (req, res) => {
  if (!T.canEdit(req.user)) { res.status(403).json({ error: 'Only an Admin, HR or a Team Lead can change message templates.' }); return false; }
  if (!T.supported()) { needSetup(res); return false; }
  return true;
};

router.post('/', async (req, res, next) => {
  try {
    if (!mustEdit(req, res)) return undefined;
    const out = await T.create(req.user, req.body || {});
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    if (out.template && out.template.channel === 'SMS') require('../utils/smsOmniSync').pullSoon(); // eslint-disable-line global-require -- shows in Omni-Channel too
    return res.status(201).json(out.template);
  } catch (err) { return next(err); }
});

router.put('/:id', async (req, res, next) => {
  try {
    if (!mustEdit(req, res)) return undefined;
    const out = await T.update(req.user, req.params.id, req.body || {});
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    if (out.template && out.template.channel === 'SMS' && !out.unchanged) require('../utils/smsOmniSync').pullSoon(); // eslint-disable-line global-require
    return res.json({ ...out.template, unchanged: !!out.unchanged });
  } catch (err) { return next(err); }
});

router.post('/:id/restore', async (req, res, next) => {
  try {
    if (!mustEdit(req, res)) return undefined;
    const out = await T.restore(req.user, req.params.id, (req.body || {}).version);
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    return res.json(out.template);
  } catch (err) { return next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    if (!mustEdit(req, res)) return undefined;
    const row = await prisma.messageTemplate.findUnique({ where: { id: req.params.id } }).catch(() => null);
    const out = await T.remove(req.user, req.params.id);
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    // a template that came from Omni-Channel stays deleted here (the next copy run does not bring it back)
    const O = require('../utils/smsOmniSync'); // eslint-disable-line global-require
    if (row && row.channel === 'SMS' && O.isFromOmni(row)) await O.forget(row.dltTemplateId);
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

module.exports = router;
