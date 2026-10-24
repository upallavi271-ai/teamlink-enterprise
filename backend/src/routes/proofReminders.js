// ---------------------------------------------------------------------------
// /api/proof-reminders - the daily WhatsApp + e-mail proof reminders (utils/proofReminders.js).
// The module itself is Accounts -> Dashboard -> Proof reminder; this is its automatic part.
//
//   GET  /status            settings, the two rounds, who would be told, channel health, the message preview, the last runs
//   PUT  /settings          { enabled, time1, time2, recipients[], alsoAdmin }      Accounts desk: Accountant, Admin, Super Admin
//                           alsoAdmin ("also send the Accounts reminders to the Admin", default OFF) can be changed by Admin / Super Admin only
//   POST /test              send a test to the logged-in person's OWN number / address
//   POST /run               { slot?, force? }   Admin / Super Admin: send this round now (once per person per channel per day unless force)
//   GET  /runs?day=&limit=  the log
// Money screens are for the Accounts desk only (like /api/dashboard/accounts/control): anyone else gets a 403.
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth, requireProduct } = require('../middleware/auth');
const PERMS = require('../utils/permissions');
const { logAudit } = require('../utils/audit');
const PR = require('../utils/proofReminders');

const router = express.Router();
router.use(requireAuth);
router.use(requireProduct('accounts'));
router.use((req, res, next) => (PERMS.SET.ACCOUNTS.includes(PERMS.roleForProduct(req.user, 'accounts'))
  ? next()
  : res.status(403).json({ error: 'Proof reminders are open to Accounts, Admin and Super Admin only.' })));

const guarded = (fn) => async (req, res, next) => { try { return await fn(req, res); } catch (err) { return next(err); } };
const mayRun = (user) => ['ADMIN', 'SUPER_ADMIN'].includes(PERMS.roleForProduct(user, 'accounts'));
const noViewAs = (req, res) => (req.viewAs ? (res.status(403).json({ error: 'You are looking at this as someone else. Switch back to send or change anything.' }), true) : false);

router.get('/status', guarded(async (req, res) => {
  const out = await PR.status();
  return res.json({ ...out, mayRun: mayRun(req.user) });
}));

router.put('/settings', guarded(async (req, res) => {
  if (noViewAs(req, res)) return null;
  // 'Also send to the Admin' changes who the money reminders reach: only an Admin / Super Admin may switch it (founder, 2026-10-19).
  if (req.body && req.body.alsoAdmin !== undefined && !mayRun(req.user)) return res.status(403).json({ error: 'Only an Admin or Super Admin can choose whether the Admin also gets these reminders.' });
  const r = await PR.saveSettings(req.body || {}, req.user);
  if (r.error) return res.status(400).json({ error: r.error });
  const b = r.before; const a = r.settings;
  const changed = [];
  if (b.enabled !== a.enabled) changed.push(`switch ${b.enabled ? 'ON' : 'OFF'} -> ${a.enabled ? 'ON' : 'OFF'}`);
  if (b.time1 !== a.time1 || b.time2 !== a.time2) changed.push(`times ${b.time1}/${b.time2} -> ${a.time1}/${a.time2}`);
  if (b.alsoAdmin !== a.alsoAdmin) changed.push(`Admin also gets Accounts reminders ${b.alsoAdmin ? 'ON' : 'OFF'} -> ${a.alsoAdmin ? 'ON' : 'OFF'}`);
  if (b.recipients.join() !== a.recipients.join()) changed.push(`recipients ${a.recipients.length ? `${a.recipients.length} picked` : 'the record accountant / Accounts desk'}`);
  if (changed.length) await logAudit({ userId: req.user.id, actorName: req.user.name || null, action: 'Proof reminder settings changed', entity: 'AccountsDashboard', toValue: changed.join('; ') });
  return res.json({ ok: true, settings: a, message: a.enabled ? 'Saved. The daily reminders are ON.' : 'Saved. The daily reminders are OFF - nothing is sent.' });
}));

router.post('/test', guarded(async (req, res) => {
  if (noViewAs(req, res)) return null;
  const r = await PR.sendTest({ user: req.user });
  return res.status(r.status).json(r.body);
}));

router.post('/run', guarded(async (req, res) => {
  if (noViewAs(req, res)) return null;
  if (!mayRun(req.user)) return res.status(403).json({ error: 'Only an Admin or Super Admin can send the reminders now.' });
  const b = req.body || {};
  const r = await PR.runNow({ user: req.user, slot: b.slot, force: b.force === true || b.force === 'true' });
  return res.status(r.status).json(r.body);
}));

router.get('/runs', guarded(async (req, res) => {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.day || '')) ? String(req.query.day) : null;
  return res.json({ runs: await PR.listRuns({ limit: Number(req.query.limit) || 60, day }) });
}));

module.exports = router;
