// ---------------------------------------------------------------------------
// /api/wa - WhatsApp click-to-chat (free wa.me links; utils/waChat.js). NOTHING is sent from the server: the browser opens wa.me.
//
//   GET    /config                       settings + what THIS login may do (master switch, per-module, may edit / export, safety note)
//   PUT    /settings                     Admin / HR / Accounts: default country code, master switch, per-module switches, daily bulk limit
//   GET    /templates?module=            every staff login (the picker)          POST / PUT /:id / DELETE /:id   Admin / HR / Accounts
//   POST   /recipients                   { entityType, ids[], requirementId?, applicationId? } -> who can be messaged, number, {placeholder} values
//   POST   /log                          one individual "Opened" (append-only)
//   GET    /log   /log/export.csv        the WhatsApp Log (rows and number masking per role); export = Admin / HR / Accounts, audited
//   POST   /optin                        { entityType: candidate|vendor, ids[], optedIn, source }
//   POST   /bulk  GET /bulk/active  GET /bulk/:id  POST /bulk/:id/sent  POST /bulk/:id/finish|discard      the queue ("Open next")
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const WA = require('../utils/waChat');

const router = express.Router();
// create the tables through the app's own connection at start (non-fatal: a failure is logged and the screens say "being set up")
WA.ensureTables().catch(() => {});
router.use(requireAuth);

const guarded = (fn) => async (req, res, next) => { try { return await fn(req, res); } catch (err) { return next(err); } };
const noViewAs = (req, res) => (req.viewAs ? (res.status(403).json({ error: 'You are looking at this as someone else. Switch back to change anything.' }), true) : false);
const external = (u) => !u || ['CLIENT', 'CANDIDATE'].includes(u.role) || ['CLIENT', 'CANDIDATE'].includes(u.atsRole);
const notReady = (res) => res.status(503).json({ error: WA.NOT_READY, ready: false });

router.use((req, res, next) => (external(req.user) ? res.status(403).json({ error: 'Not available to this login.' }) : next()));

router.get('/config', guarded(async (req, res) => {
  const ready = await WA.ready();
  const st = await WA.settings();
  const u = req.user;
  const gates = {};
  for (const t of WA.ENTITY_TYPES) { const g = await WA.gate(u, t); gates[t] = { ok: !!g.ok, reason: g.ok ? null : g.reason }; } // eslint-disable-line no-await-in-loop
  return res.json({
    ready, message: ready ? null : WA.NOT_READY, settings: st, gates, safetyNote: WA.SAFETY_NOTE,
    mayEditSettings: WA.mayEditSettings(u) && !req.viewAs, mayEditTemplates: WA.mayEditTemplates(u) && !req.viewAs, mayExport: WA.mayExport(u),
    optInTypes: ['candidate', 'vendor'],
  });
}));

router.put('/settings', guarded(async (req, res) => {
  if (noViewAs(req, res)) return null;
  if (!WA.mayEditSettings(req.user)) return res.status(403).json({ error: 'Only Admin, HR and Accounts can change these settings.' });
  const r = await WA.saveSettings(req.body, req.user);
  if (r.error) return res.status(r.status || 400).json({ error: r.error });
  return res.json({ ok: true, settings: r.settings, message: 'Saved.' });
}));

// ---- templates
router.get('/templates', guarded(async (req, res) => {
  if (!(await WA.ready())) return notReady(res);
  return res.json({ templates: await WA.listTemplates({ module: WA.MODULES.includes(req.query.module) ? req.query.module : undefined }), placeholders: require('../utils/waLink').WA_PLACEHOLDERS });
}));
router.post('/templates', guarded(async (req, res) => {
  if (noViewAs(req, res)) return null;
  if (!(await WA.ready())) return notReady(res);
  if (!WA.mayEditTemplates(req.user)) return res.status(403).json({ error: 'Only Admin, HR and Accounts can change templates.' });
  const r = await WA.createTemplate(req.body, req.user);
  return res.status(r.error ? (r.status || 400) : 201).json(r.error ? { error: r.error } : r);
}));
router.put('/templates/:id', guarded(async (req, res) => {
  if (noViewAs(req, res)) return null;
  if (!(await WA.ready())) return notReady(res);
  if (!WA.mayEditTemplates(req.user)) return res.status(403).json({ error: 'Only Admin, HR and Accounts can change templates.' });
  const r = await WA.updateTemplate(req.params.id, req.body || {}, req.user);
  return res.status(r.error ? (r.status || 400) : 200).json(r.error ? { error: r.error } : r);
}));
router.delete('/templates/:id', guarded(async (req, res) => {
  if (noViewAs(req, res)) return null;
  if (!(await WA.ready())) return notReady(res);
  if (!WA.mayEditTemplates(req.user)) return res.status(403).json({ error: 'Only Admin, HR and Accounts can change templates.' });
  const r = await WA.removeTemplate(req.params.id, req.user);
  return res.status(r.error ? (r.status || 400) : 200).json(r.error ? { error: r.error } : r);
}));

// ---- people
router.post('/recipients', guarded(async (req, res) => {
  if (!(await WA.ready())) return notReady(res);
  const b = req.body || {};
  if (!Array.isArray(b.ids)) return res.status(400).json({ error: 'Pick who to message.' });
  const r = await WA.recipients(req.user, String(b.entityType || ''), b.ids, { requirementId: b.requirementId ? String(b.requirementId) : undefined, applicationId: b.applicationId ? String(b.applicationId) : undefined });
  if (r.error) return res.status(r.status || 400).json({ error: r.error });
  return res.json({ recipients: r.recipients, settings: { defaultCountryCode: r.settings.defaultCountryCode }, module: r.module, safetyNote: WA.SAFETY_NOTE });
}));

// ---- one send
router.post('/log', guarded(async (req, res) => {
  if (noViewAs(req, res)) return null;
  if (!(await WA.ready())) return notReady(res);
  const b = req.body || {};
  const r = await WA.logSingle(req.user, { entityType: String(b.entityType || ''), entityId: String(b.entityId || ''), number: b.number, templateId: b.templateId || null, messageLength: b.messageLength, requirementId: b.requirementId });
  if (r.error) return res.status(r.status || 400).json({ error: r.error });
  return res.status(201).json(r);
}));

router.get('/log', guarded(async (req, res) => {
  if (!(await WA.ready())) return notReady(res);
  const r = await WA.listLog(req.user, req.query);
  return res.json({ ...r, note: 'WhatsApp does not tell us whether a message was delivered or read. "Opened" means the person opened WhatsApp from TeamLink.', mayExport: WA.mayExport(req.user) });
}));
router.get('/log/export.csv', guarded(async (req, res) => {
  if (!(await WA.ready())) return notReady(res);
  if (!WA.mayExport(req.user)) return res.status(403).json({ error: 'Only Admin, HR and Accounts can export the WhatsApp log.' });
  const r = await WA.logCsv(req.user, req.query);
  await logAudit({ userId: req.user.id, actorName: req.user.name || null, action: 'WhatsApp log exported', entity: 'WaLog', toValue: `${r.count} rows` });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="whatsapp-log.csv"');
  return res.send(r.csv);
}));

// ---- opt-in
router.post('/optin', guarded(async (req, res) => {
  if (noViewAs(req, res)) return null;
  if (!(await WA.ready())) return notReady(res);
  const b = req.body || {};
  if (!Array.isArray(b.ids) || !b.ids.length) return res.status(400).json({ error: 'Pick who to change.' });
  const r = await WA.setOptIn(req.user, String(b.entityType || ''), b.ids.slice(0, 2000), b.optedIn === true || b.optedIn === 'true', b.source);
  if (r.error) return res.status(r.status || 400).json({ error: r.error });
  return res.json({ ...r, message: b.optedIn ? `Marked ${r.changed} as opted in.` : `Removed the opt-in of ${r.changed}.` });
}));

// ---- bulk queue
router.post('/bulk', guarded(async (req, res) => {
  if (noViewAs(req, res)) return null;
  if (!(await WA.ready())) return notReady(res);
  const b = req.body || {};
  if (!Array.isArray(b.ids) || !b.ids.length) return res.status(400).json({ error: 'Pick who to message.' });
  const r = await WA.startBulk(req.user, { entityType: String(b.entityType || ''), ids: b.ids, templateId: b.templateId, requirementId: b.requirementId ? String(b.requirementId) : undefined });
  if (r.error) return res.status(r.status || 400).json({ error: r.error });
  return res.status(201).json(r);
}));
router.get('/bulk/active', guarded(async (req, res) => {
  if (!(await WA.ready())) return res.json({ session: null, ready: false });
  return res.json(await WA.activeBulk(req.user));
}));
router.get('/bulk/:id', guarded(async (req, res) => {
  if (!(await WA.ready())) return notReady(res);
  const r = await WA.getBulk(req.user, req.params.id);
  return res.status(r.error ? (r.status || 400) : 200).json(r.error ? { error: r.error } : r);
}));
router.post('/bulk/:id/sent', guarded(async (req, res) => {
  if (noViewAs(req, res)) return null;
  if (!(await WA.ready())) return notReady(res);
  const r = await WA.markSent(req.user, req.params.id, String((req.body || {}).personId || ''));
  return res.status(r.error ? (r.status || 400) : 200).json(r.error ? { error: r.error } : r);
}));
router.post('/bulk/:id/finish', guarded(async (req, res) => {
  if (!(await WA.ready())) return notReady(res);
  const r = await WA.closeBulk(req.user, req.params.id, 'done');
  return res.status(r.error ? (r.status || 400) : 200).json(r.error ? { error: r.error } : r);
}));
router.post('/bulk/:id/discard', guarded(async (req, res) => {
  if (!(await WA.ready())) return notReady(res);
  const r = await WA.closeBulk(req.user, req.params.id, 'discarded');
  return res.status(r.error ? (r.status || 400) : 200).json(r.error ? { error: r.error } : r);
}));

module.exports = router;
