// ---------------------------------------------------------------------------
// /api/wa-numbers — MANY WHATSAPP NUMBERS (Administration > Integrations > WhatsApp & SMS > WhatsApp numbers). Logic: utils/waNumbers.js.
//
//   GET    /my-numbers          ANY staff login: the numbers it may send from (label + number + switched on?). No ids of credentials, no tokens.
//   -- everything below: Admin / Super Admin ONLY (403 for everybody else, checked here on the server) --
//   GET    /                    the list (Main number shown as "Main number (default)" until moved), counts, settings, departments, roles
//   POST   /                    Add a WhatsApp number { label, displayNumber, phoneNumberId, wabaId, tokenMode, token, appSecret, verifyToken, language,
//                               tplLink, tplOtp, tplBulk, makeDefault, access: { departments, userIds, roles, everyone } }  -> saves, then checks with Meta
//   PUT    /:id                 Edit (a blank token / secret keeps the saved one; "-" clears it)
//   POST   /move-main           put the old single connection into the list ("Main number", credentials stay in the WhatsApp Business form)
//   POST   /:id/reconnect       check with Meta again (+ webhook subscription); at most 6 per number per hour
//   POST   /:id/active          { active: true|false }   switch on / off (Deactivate / Activate)
//   POST   /:id/default         make it the default number
//   PUT    /:id/access          { departments:[names], userIds:[ids], roles:[codes], everyone:bool }  replaces the assignment
//   GET    /:id/effective       who can send from it
//   GET    /:id/history         how many messages / chats (decides Remove vs Deactivate only)
//   DELETE /:id                 remove (only a number with no messages; history is never deleted)
//   GET    /people  /departments   for the Assign window
//   GET|PUT /settings           System messages use <number>; fall back to the default number; admins may use every number
// Secrets are encrypted in the store and are returned by NO route here (only "saved" yes / no).
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const WN = require('../utils/waNumbers');
const T = require('../utils/messageTemplates');

const router = express.Router();
router.use(requireAuth);

const wrap = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };
const external = (u) => ['CLIENT', 'CANDIDATE', 'VENDOR', 'PARTNER'].includes(u.role) || ['CLIENT', 'CANDIDATE'].includes(u.atsRole);
const send = (res, out, okBody) => {
  if (out && out.error) return res.status(out.status || 400).json({ error: out.error, ...(out.code ? { code: out.code } : {}), ...(out.history ? { history: out.history } : {}) });
  return res.json(okBody ? okBody(out) : out);
};

// ---- any staff login ---------------------------------------------------------------------------------------------
router.get('/my-numbers', wrap(async (req, res) => {
  if (external(req.user)) return res.status(403).json({ error: 'Not available to this login.' });
  return res.json(await WN.myNumbers(req.user));
}));

// ---- Admin / Super Admin only --------------------------------------------------------------------------------------
router.use((req, res, next) => {
  if (!T.isAdmin(req.user)) return res.status(403).json({ error: 'Only an Admin or Super Admin can manage WhatsApp numbers.' });
  return next();
});

router.get('/', wrap(async (req, res) => res.json(await WN.adminList())));
router.get('/people', wrap(async (req, res) => res.json({ people: await WN.people() })));
router.get('/departments', wrap(async (req, res) => res.json({ departments: await WN.departmentCounts() })));
router.get('/settings', wrap(async (req, res) => res.json({ settings: await WN.settings(), numbers: (await WN.listRows()).map((r) => ({ id: r.id, label: r.label, active: r.active })) })));
router.put('/settings', wrap(async (req, res) => send(res, await WN.saveSettings(req.user, req.body || {}))));

router.post('/', wrap(async (req, res) => {
  const out = await WN.create(req.user, req.body || {});
  return send(res, out, (o) => ({ ok: true, id: o.row.id, status: o.status }));
}));

router.post('/move-main', wrap(async (req, res) => {
  const out = await WN.importMain(req.user);
  if (out.error) return send(res, out);
  const status = await WN.check(out.row.id, { user: req.user }).catch(() => null);
  return res.json({ ok: true, id: out.row.id, already: !!out.already, status });
}));

// the old single connection, before it is moved: the same plain test as the WhatsApp Business card
router.post('/legacy/test', wrap(async (req, res) => {
  const r = await require('../utils/whatsappCloud').testConnection(); // eslint-disable-line global-require
  return res.json({ ok: !!r.ok, code: r.ok ? 'connected' : 'disconnected', text: r.result });
}));

router.put('/:id', wrap(async (req, res) => send(res, await WN.update(req.user, req.params.id, req.body || {}), (o) => ({ ok: true, id: o.row.id, status: o.status }))));

router.post('/:id/reconnect', wrap(async (req, res) => {
  const row = await WN.getRowFresh(req.params.id);
  if (!row) return res.status(404).json({ error: WN.WORDS.NOT_FOUND });
  if (!WN.reconnectAllowed(row.id)) return res.status(429).json({ error: `Reconnect was pressed too many times for "${row.label}" (${WN.reconnectLimit()} an hour, because every press asks Meta). Try again a little later.` });
  const out = await WN.check(row.id, { user: req.user, subscribe: true });
  return send(res, out);
}));

router.post('/:id/active', wrap(async (req, res) => send(res, await WN.setActive(req.user, req.params.id, (req.body || {}).active !== false), () => ({ ok: true }))));
router.post('/:id/default', wrap(async (req, res) => send(res, await WN.setDefault(req.user, req.params.id), () => ({ ok: true }))));
router.put('/:id/access', wrap(async (req, res) => send(res, await WN.setAccess(req.user, req.params.id, req.body || {}), (o) => ({ ok: true, added: o.added, removed: o.removed }))));
router.get('/:id/effective', wrap(async (req, res) => {
  const out = await WN.effectivePeople(req.params.id);
  if (!out) return res.status(404).json({ error: WN.WORDS.NOT_FOUND });
  return res.json(out);
}));
router.get('/:id/history', wrap(async (req, res) => {
  const row = await WN.getRowFresh(req.params.id);
  if (!row) return res.status(404).json({ error: WN.WORDS.NOT_FOUND });
  return res.json({ ...(await WN.historyCount(row.id)), label: row.label, displayNumber: row.displayNumber });
}));
router.delete('/:id', wrap(async (req, res) => send(res, await WN.remove(req.user, req.params.id), () => ({ ok: true }))));

module.exports = router;
