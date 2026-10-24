// ---------------------------------------------------------------------------
// /api/outreach/gs/admin : the ADMINISTRATION pages of the Green Start rebuild (Team & Roles, Billing, Super Admin, Settings, organisations).
// Auto-mounted by routes/outreach.js behind login + "may use Omni-Channel". The server decides who may do what (outreach/access.js); the screens hide.
//   Team & Roles   GET /team/members, /team/roles, /team/audit, /team/audit.csv             (Admin, Department Head, Team Lead = pagesFor 'team')
//   Billing        GET /billing/summary, /billing/usage.csv                                  (everybody; company part Admin + Finance) [omniGsAdminEarly.js]
//   Super Admin    GET /super/organisations, /super/organisations.csv, POST /super/grant     (Admin)
//   Switches       GET /switches, PUT /switches                                              (Admin): approval, "applied = job messages", bots; test mode + sending
//                  master are the existing PUT /api/outreach/settings (it keeps the "I understand" tick)
//   Settings       GET /settings/health, POST /settings/health/:id/test, GET + PUT /settings/wa-numbers, PUT /settings/sending, GET /settings/optouts, /settings/optouts.csv
//   Organisations  GET /org/overview, POST /org  [omniGsAdminEarly.js]
// Nothing here sends a message.
// ---------------------------------------------------------------------------
const express = require('express');
const A = require('../outreach/access');
const Ad = require('../outreach/adminApi');
const Pol = require('../outreach/policy');
const Chrome = require('../outreach/chrome');

const router = express.Router();
const wrap = (fn) => async (req, res, next) => { try { await fn(req, res, next); } catch (e) { next(e); } };
const deny = (res, why = 'Only an Admin can do this.') => res.status(403).json({ error: why });
const send = (res, out) => (out && out.error ? res.status(out.status || 400).json({ error: out.error }) : res.json(out));
const adminOnly = (req, res, next) => (A.isAdmin(req.user) ? next() : deny(res));
const needTeam = (req, res, next) => (Ad.mayTeam(req.user) ? next() : deny(res, 'Team & Roles is for Admins, Department Heads and Team Leads.'));
const csvOut = (res, name, csv) => { res.set('Content-Disposition', `attachment; filename="${name}"`); res.type('text/csv; charset=utf-8'); return res.send(csv); };

router.use(require('./omniGsAdminEarly')); // billing + organisations (also reachable before the gate)

// ---- Team & Roles ----------------------------------------------------------------------------------------------------------------
router.get('/team/members', needTeam, wrap(async (req, res) => {
  const dept = Chrome.deptOf(req.user, req.query.dept);
  if (dept === null) return res.json({ rows: [], totals: { people: 0, used: 0, sent: 0, testSent: 0 }, hiddenNoAccess: 0, months: [], scopeWords: 'Nothing' });
  return res.json(await Ad.members(req.user, { month: req.query.month, dept, q: req.query.q }));
}));
router.get('/team/roles', needTeam, wrap(async (req, res) => res.json(await Ad.rolesView(req.user))));
router.get('/team/audit', needTeam, wrap(async (req, res) => res.json(await Ad.auditRows(req.user, { q: req.query.q, from: req.query.from, to: req.query.to, page: req.query.page, pageSize: req.query.pageSize }))));
router.get('/team/audit.csv', needTeam, wrap(async (req, res) => {
  if (!A.isAdmin(req.user)) return deny(res, 'Only an Admin can download the audit log.');
  const out = await Ad.auditCsv(req.user, { q: req.query.q, from: req.query.from, to: req.query.to });
  return csvOut(res, 'omni-audit-log.csv', out.csv);
}));

// ---- Super Admin ---------------------------------------------------------------------------------------------------------------------
router.get('/super/organisations', adminOnly, wrap(async (req, res) => res.json(await Ad.superOrgs(req.user, req.query.month))));
router.get('/super/organisations.csv', adminOnly, wrap(async (req, res) => { const out = await Ad.superCsv(req.user, req.query.month); return csvOut(res, `omni-organisations-${out.month}.csv`, out.csv); }));
router.post('/super/grant', adminOnly, wrap(async (req, res) => send(res, await Ad.grant(req.user, req.body || {}))));
router.get('/switches', adminOnly, wrap(async (req, res) => res.json(await Ad.switches())));
router.put('/switches', adminOnly, wrap(async (req, res) => {
  const b = req.body || {};
  ['atsAppliedMeansJobAllowed', 'approvalRequired', 'botsEnabled'].forEach((k) => { if (b[k] !== undefined && typeof b[k] !== 'boolean') b[k] = b[k] === true || b[k] === 'true'; });
  return res.json(await Ad.saveSwitches(req.user, b));
}));

// ---- Settings ----------------------------------------------------------------------------------------------------------------------------
router.get('/settings/health', adminOnly, wrap(async (req, res) => res.json(await Ad.health())));
router.post('/settings/health/:id/test', adminOnly, wrap(async (req, res) => {
  const one = await Ad.healthOne(String(req.params.id));
  return one ? res.json({ ...one, note: 'Only read. Nothing was sent.' }) : res.status(404).json({ error: 'Unknown connection.' });
}));
router.get('/settings/wa-numbers', adminOnly, wrap(async (req, res) => res.json(await Ad.waNumbers())));
router.put('/settings/wa-numbers', adminOnly, wrap(async (req, res) => send(res, await Pol.saveWaNumbers(req.user, (req.body || {}).numbers))));
router.put('/settings/sending', adminOnly, wrap(async (req, res) => send(res, await Ad.sendingExtra(req.user, req.body || {}))));
router.get('/settings/optouts', adminOnly, wrap(async (req, res) => res.json(await Ad.optouts())));
router.get('/settings/optouts.csv', adminOnly, wrap(async (req, res) => {
  const out = await Ad.optoutsCsv(req.user);
  if (out.error) return send(res, out);
  return csvOut(res, 'omni-opt-outs.csv', out.csv);
}));

module.exports = router;
