// ---------------------------------------------------------------------------
// /api/accounts-reminders - "Who gets each Accounts reminder" (utils/accountsReminderSettings.js). Admin / Super Admin only.
//
//   GET  /                  the table: one row per reminder kind (+ the role list and the proof reminder's next / last status)
//   GET  /people?q=         type-to-search the people who can be chosen (active logins; hasAccounts says if they may be)
//   PUT  /preset            { preset: 'also-admin' | 'accountant-only' }   the earlier single tick, as a preset
//   PUT  /:kind             { on, roles[], people[], owner, channels[], timing{} }   400 with a plain message when something is missing
//   POST /:kind/reset       back to the default of that row
//   POST /:kind/test        a clearly marked TEST to the Admin who clicked, only
// Everything changed is audited with old -> new (names).
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const PERMS = require('../utils/permissions');
const RS = require('../utils/accountsReminderSettings');

const router = express.Router();
router.use(requireAuth);
const guarded = (fn) => async (req, res, next) => { try { return await fn(req, res); } catch (err) { return next(err); } };
const isAdmin = (user) => ['ADMIN', 'SUPER_ADMIN'].includes(PERMS.roleForProduct(user, 'accounts')) && !!(user.products && user.products.accounts);
const adminOnly = (req, res, next) => (isAdmin(req.user) ? next() : res.status(403).json({ error: 'Only an Admin or Super Admin can choose who gets the Accounts reminders.' }));
const noViewAs = (req, res) => (req.viewAs ? (res.status(403).json({ error: 'You are looking at this as someone else. Switch back to change anything.' }), true) : false);

router.get('/', adminOnly, guarded(async (req, res) => {
  const PR = require('../utils/proofReminders'); // eslint-disable-line global-require
  const st = await PR.status().catch(() => null);
  return res.json({
    rows: await RS.rows(req.user),
    roles: RS.ROLE_OPTIONS,
    proof: st ? { automatic: st.automatic, rounds: st.rounds, timezone: st.timezone } : null,
    mayEdit: true,
  });
}));

router.get('/people', adminOnly, guarded(async (req, res) => res.json({ people: await RS.searchPeople(req.query.q) })));

router.put('/preset', adminOnly, guarded(async (req, res) => {
  if (noViewAs(req, res)) return null;
  const r = await RS.preset(String((req.body || {}).preset || ''), req.user);
  return res.status(r.status).json(r.body);
}));

router.put('/:kind', adminOnly, guarded(async (req, res) => {
  if (noViewAs(req, res)) return null;
  const r = await RS.save(req.params.kind, req.body || {}, req.user);
  return res.status(r.status).json(r.body);
}));
router.post('/:kind/reset', adminOnly, guarded(async (req, res) => {
  if (noViewAs(req, res)) return null;
  const r = await RS.reset(req.params.kind, req.user);
  return res.status(r.status).json(r.body);
}));
router.post('/:kind/test', adminOnly, guarded(async (req, res) => {
  if (noViewAs(req, res)) return null;
  const r = await RS.sendTest(req.params.kind, req.user);
  return res.status(r.status).json(r.body);
}));

module.exports = router;
