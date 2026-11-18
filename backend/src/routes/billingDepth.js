// ---------------------------------------------------------------------------
// /api/ats-billing - BILLING DEPTH (audit 2026-11-18). Rules: utils/billingDepth.js. Accounts / ATS logins with Accounts rights.
//
//   GET  /settings                         the switches (Admin sees and changes)       PUT /settings { overdueReminders, remindClient, paymentApproval }
//   POST /overdue-reminders/run            Admin: { dryRun } what the daily worker does, now
//   GET  /client-profitability ?from&to    per client margin incl. recruiter salary cost (when the HRMS has it)
//   GET  /payment-approvals ?state=        receipts waiting / decided                  POST /payment-approvals/:id/approve   POST .../reject { reason }
//   GET  /freelancer-report ?type=         per Freelancer / Agency partner: revenue vs cost
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth, can } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const BD = require('../utils/billingDepth');

const router = express.Router();
router.use(requireAuth);
const DENIED = { error: "This action isn't included in your role's permissions" };
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isAdmin = (u) => ['SUPER_ADMIN', 'ADMIN'].includes(u.role);
const mayAccounts = (u) => can(u, 'accounts', 'accounts', 'Invoices', 'view');

async function settingsPayload(user) {
  const o = await BD.getSetting('overdue'); const a = await BD.getSetting('approval');
  return { overdueReminders: !!o.enabled, remindClient: !!o.client, everyDays: o.everyDays, paymentApproval: !!a.enabled, mayEdit: isAdmin(user) };
}
router.get('/settings', wrap(async (req, res) => {
  if (!(await mayAccounts(req.user)) && !isAdmin(req.user)) return res.status(403).json(DENIED);
  res.json(await settingsPayload(req.user));
}));
router.put('/settings', wrap(async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only an Admin can change these switches.' });
  const b = req.body || {};
  for (const k of ['overdueReminders', 'remindClient', 'paymentApproval']) if (b[k] !== undefined && typeof b[k] !== 'boolean') return res.status(400).json({ error: `${k} must be true or false.` });
  const log = (name, from, to) => logAudit({ userId: req.user.id, action: `Setting changed: ${name}`, entity: 'AppSetting', entityId: name, fromValue: String(from), toValue: String(to) });
  if (b.overdueReminders !== undefined) { const r = await BD.setSetting('overdue', { enabled: b.overdueReminders }, req.user); await log('Overdue payment reminders', r.before.enabled, b.overdueReminders); }
  if (b.remindClient !== undefined) { const r = await BD.setSetting('overdue', { client: b.remindClient }, req.user); await log('Overdue reminders also go to the client', r.before.client, b.remindClient); }
  if (b.paymentApproval !== undefined) { const r = await BD.setSetting('approval', { enabled: b.paymentApproval }, req.user); await log('Payment approval', r.before.enabled, b.paymentApproval); }
  res.json(await settingsPayload(req.user));
}));
router.post('/overdue-reminders/run', wrap(async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only an Admin can run the reminders now.' });
  res.json(await BD.runOverdueReminders({ dryRun: !!(req.body || {}).dryRun }));
}));

router.get('/client-profitability', wrap(async (req, res) => {
  if (!(await mayAccounts(req.user))) return res.status(403).json(DENIED);
  const ok = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : undefined);
  res.json(await BD.clientProfitability(req.user, { from: ok(req.query.from), to: ok(req.query.to) }));
}));

router.get('/payment-approvals', wrap(async (req, res) => {
  if (!(await can(req.user, 'accounts', 'accounts', 'Payments', 'view'))) return res.status(403).json(DENIED);
  const state = ['Pending', 'Approved', 'Rejected'].includes(req.query.state) ? req.query.state : null;
  res.json({ rows: await BD.listApprovals(state), enabled: await BD.approvalOn(), mayDecide: isAdmin(req.user) || (await can(req.user, 'accounts', 'accounts', 'Payments', 'create')) });
}));
const decider = async (req, res) => {
  if (!isAdmin(req.user) && !(await can(req.user, 'accounts', 'accounts', 'Payments', 'create'))) { res.status(403).json(DENIED); return false; }
  return true;
};
router.post('/payment-approvals/:id/approve', wrap(async (req, res) => {
  if (!(await decider(req, res))) return;
  const out = await BD.approve(req.params.id, req.user);
  if (out.error) return res.status(out.status || 400).json({ error: out.error });
  res.json({ ok: true, paymentId: out.payment.id });
}));
router.post('/payment-approvals/:id/reject', wrap(async (req, res) => {
  if (!(await decider(req, res))) return;
  const out = await BD.reject(req.params.id, req.user, (req.body || {}).reason);
  if (out.error) return res.status(out.status || 400).json({ error: out.error });
  res.json({ ok: true });
}));

router.get('/freelancer-report', wrap(async (req, res) => {
  if (!(await mayAccounts(req.user))) return res.status(403).json(DENIED);
  res.json(await BD.freelancerReport({ type: req.query.type }));
}));

module.exports = router;
