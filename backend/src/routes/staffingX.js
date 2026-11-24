// ---------------------------------------------------------------------------
// CONTRACT STAFFING API (ATS wave 2, builder X), mounted at /api/ats/staffing. The features live in utils/staffingX/*.js; this
// file is the doors: who may use each one. The record each login reaches is its ATS scope (utils/scope.js applicationWhere).
//   Staff only (client / candidate logins use routes/staffingXPortal.js).   Manager / Assistant Manager: VIEW ONLY.
//   BDE: the bill side only (never a pay rate, cost or margin), no timesheet entry, no shifts.   Accounts: look + billing files.
//   Rates and contract details: Admin, TL, STL, BDE TL.   Approve a timesheet: a lead or the client (Admin setting).
//   Admin switches: Super Admin / Admin.
// THE ACCOUNTS BOUNDARY: nothing here writes into TeamLink Accounts; billing batches are export files (+ an optional push out).
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const scope = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const S = require('../utils/staffingX/store');
const K = require('../utils/staffingX/contracts');
const T = require('../utils/staffingX/timesheets');
const SH = require('../utils/staffingX/shifts');
const B = require('../utils/staffingX/billing');
const V = require('../utils/staffingX/vms');

const router = express.Router();
router.use(requireAuth);

const roleOf = (u) => scope.atsViewRole(u);
const isAdmin = (u) => roleOf(u) === 'admin';
const isBdeTl = (u) => scope.isBdeTl(u);
const isLead = (u) => ['admin', 'tl', 'stl'].includes(roleOf(u)) || isBdeTl(u);
const VIEW_ONLY = { error: 'Your ATS login is view only: you can look, not change.' };
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const send = (res, out, ok = 200) => (out && out.error ? res.status(out.status || 400).json({ error: out.error, ...(out.conflicts ? { conflicts: out.conflicts } : {}), ...(out.blocked ? { blocked: out.blocked } : {}), ...(out.state ? { state: out.state } : {}) }) : res.status(ok).json(out));
const deny = (res, error) => res.status(403).json({ error });

router.use((req, res, next) => {
  if (['client', 'candidate', 'none'].includes(roleOf(req.user))) return deny(res, 'Contract staff is for TeamLink staff.');
  return next();
});
// a change: never a Manager / Assistant Manager (view only), never while viewing as someone else
const act = (req, res, next) => {
  if (roleOf(req.user) === 'mgmt' || (req.user.caps && req.user.caps.atsAct === false && !isAdmin(req.user))) return res.status(403).json(VIEW_ONLY);
  return next();
};
const admin = (req, res, next) => (isAdmin(req.user) ? next() : deny(res, 'Only a Super Admin or an Admin changes this.'));
const lead = (req, res, next) => (isLead(req.user) ? next() : deny(res, 'Rates and contract details are set by an Admin, a team lead or the BDE TL.'));
const notBde = (req, res, next) => (roleOf(req.user) === 'bde' && !isBdeTl(req.user) ? deny(res, 'The BDE team sees the billing side only.') : next());
const worker = (req, res, next) => (['admin', 'tl', 'stl', 'recruiter'].includes(roleOf(req.user)) ? next() : deny(res, 'Timesheets and shifts are kept by the recruiter, the team lead or an Admin.'));
const vmsDesk = (req, res, next) => (isAdmin(req.user) || roleOf(req.user) === 'bde' || isBdeTl(req.user) || ['tl', 'stl'].includes(roleOf(req.user)) ? next() : deny(res, 'The VMS desk is the BDE team, the team leads and Admins.'));
const billing = (req, res, next) => (B.mayBill(req.user) ? next() : deny(res, 'Billing batches are made by an Admin, a team lead, the BDE TL or the accounts team.'));

// ---- what this login may do --------------------------------------------------------------------------------------------------
router.get('/meta', wrap(async (req, res) => {
  const u = req.user; const r = roleOf(u);
  const values = await S.settings({ fresh: true });
  res.json({
    role: r, seesPay: K.seesPay(u), viewOnly: r === 'mgmt', isAdmin: isAdmin(u), mayRates: isLead(u), mayTimesheets: ['admin', 'tl', 'stl', 'recruiter'].includes(r),
    mayApprove: isLead(u) && values['approval.mode'] !== 'client', mayBill: B.mayBill(u), mayVms: isAdmin(u) || r === 'bde' || isBdeTl(u) || ['tl', 'stl'].includes(r),
    units: K.UNITS, payTypes: K.PAY_TYPES, approvalMode: values['approval.mode'], boundary: B.ACCOUNTS_BOUNDARY,
    vms: V.status(await V.config()), push: B.pushStatus(await B.pushConfig()),
  });
}));
router.get('/settings', wrap(async (req, res) => {
  if (!isAdmin(req.user) && roleOf(req.user) !== 'mgmt') return deny(res, 'Only a Super Admin or an Admin changes this.');
  return res.json({ switches: S.switchList(await S.settings({ fresh: true })), mayEdit: isAdmin(req.user) });
}));
router.put('/settings', admin, wrap(async (req, res) => {
  const { key, value } = req.body || {};
  if (!S.SWITCHES[key]) return res.status(400).json({ error: 'Unknown setting.' });
  const before = (await S.settings())[key];
  const out = await S.saveSetting(key, value, req.user);
  if (out.error) return res.status(400).json(out);
  await logAudit({ userId: req.user.id, action: `Contract staffing setting: ${S.SWITCHES[key].label}`, entity: 'StfSetting', entityId: key, fromValue: String(before), toValue: String(out.value) });
  return res.json({ key, value: out.value });
}));

// ---- contractors, rates, pay & bill (11.16) -----------------------------------------------------------------------------------------
router.get('/contractors', wrap(async (req, res) => res.json({ rows: await K.list(req.user, { status: req.query.status || null, clientId: req.query.clientId || null }) })));
// joined client placements that are not contractors yet (to mark one)
router.get('/placements', lead, wrap(async (req, res) => {
  const prisma = require('../db'); // eslint-disable-line global-require
  const have = new Set((await K.list(req.user)).map((c) => c.applicationId));
  const apps = await prisma.application.findMany({ where: { AND: [scope.applicationWhere(req.user), { stage: { in: K.PLACED } }, { requirement: { internal: false } }] }, select: { id: true, joiningDate: true, candidate: { select: { name: true } }, requirement: { select: { title: true, client: { select: { name: true } } } } }, orderBy: { updatedAt: 'desc' }, take: 300 });
  res.json({ rows: apps.filter((a) => !have.has(a.id)).map((a) => ({ applicationId: a.id, name: a.candidate.name, requirement: a.requirement.title, client: a.requirement.client && a.requirement.client.name, joined: a.joiningDate || null })) });
}));
router.put('/contractors/:id', act, lead, wrap(async (req, res) => send(res, await K.saveContract(req.user, req.params.id, req.body))));
router.get('/contractors/:id/rates', wrap(async (req, res) => send(res, await K.rateHistory(req.user, req.params.id))));
router.post('/contractors/:id/rates', act, lead, notBde, wrap(async (req, res) => send(res, await K.saveRate(req.user, req.params.id, req.body), 201)));
router.get('/paybill', wrap(async (req, res) => res.json(await K.payBill(req.user, { from: req.query.from, to: req.query.to }))));

// ---- timesheets (11.15) --------------------------------------------------------------------------------------------------------
router.get('/timesheets', wrap(async (req, res) => res.json(await T.list(req.user, { status: req.query.status || null, from: req.query.from || null, to: req.query.to || null, clientId: req.query.clientId || null }))));
router.get('/timesheets/missing', wrap(async (req, res) => res.json(await T.missing(req.user))));
router.post('/timesheets/remind', act, admin, wrap(async (req, res) => send(res, await T.sendReminders(req.user, { force: !!(req.body && req.body.force) }))));
router.get('/contractors/:id/weeks', wrap(async (req, res) => send(res, await T.weeksOf(req.user, req.params.id, { weeks: Number(req.query.weeks) || 8 }))));
router.put('/contractors/:id/weeks/:week', act, worker, wrap(async (req, res) => send(res, await T.save(req.user, req.params.id, { ...(req.body || {}), weekStart: req.params.week }))));
router.get('/contractors/:id/weeks/:week/from-shifts', wrap(async (req, res) => send(res, await T.fromShifts(req.user, req.params.id, req.params.week))));
router.post('/timesheets/:id/recall', act, worker, wrap(async (req, res) => send(res, await T.recall(req.user, req.params.id))));
router.post('/timesheets/:id/decision', act, wrap(async (req, res) => send(res, await T.decide(req.user, req.params.id, { approve: !!(req.body && req.body.approve), reason: req.body && req.body.reason }))));
router.post('/timesheets/:id/reopen', act, admin, wrap(async (req, res) => send(res, await T.reopen(req.user, req.params.id, req.body && req.body.reason))));

// ---- shifts (11.17) --------------------------------------------------------------------------------------------------------------
router.get('/shifts', wrap(async (req, res) => res.json(await SH.list(req.user, { from: req.query.from, to: req.query.to, clientId: req.query.clientId || null, applicationId: req.query.applicationId || null }))));
router.post('/shifts', act, worker, wrap(async (req, res) => send(res, await SH.create(req.user, req.body), 201)));
router.put('/shifts/:id', act, worker, wrap(async (req, res) => send(res, await SH.update(req.user, req.params.id, req.body))));
router.delete('/shifts/:id', act, worker, wrap(async (req, res) => send(res, await SH.remove(req.user, req.params.id))));
router.get('/shifts/:id/suggestions', wrap(async (req, res) => send(res, await SH.suggestions(req.user, req.params.id))));

// ---- the billing check (09.15) + billing from timesheets (06.12) + the accounting file / push (06.11, 14.08) ----------------------
router.get('/audit', wrap(async (req, res) => res.json(await B.audit(req.user, { clientId: req.query.clientId || null }))));
router.post('/audit/:id/explain', wrap(async (req, res) => send(res, await B.explain(req.user, req.params.id, { useAi: !!(req.body && req.body.useAi) }))));
router.get('/billing/unbilled', wrap(async (req, res) => res.json(await B.unbilled(req.user, { clientId: req.query.clientId || null }))));
router.get('/billing/batches', wrap(async (req, res) => res.json(await B.batches(req.user))));
router.post('/billing/batches', act, billing, wrap(async (req, res) => send(res, await B.createBatch(req.user, req.body || {}), 201)));
router.get('/billing/batches/:id', wrap(async (req, res) => send(res, await B.batchDetail(req.user, req.params.id))));
router.post('/billing/batches/:id/cancel', act, billing, wrap(async (req, res) => send(res, await B.cancelBatch(req.user, req.params.id, req.body && req.body.reason))));
router.post('/billing/batches/:id/push', act, billing, wrap(async (req, res) => send(res, await B.push(req.user, req.params.id))));
router.post('/billing/batches/:id/post-to-accounts', (req, res) => res.status(409).json({ error: B.ACCOUNTS_BOUNDARY, needsFounderDecision: true }));
const file = (res, out) => {
  if (out.error) return res.status(out.status || 400).json({ error: out.error });
  res.setHeader('Content-Type', out.type);
  res.setHeader('Content-Disposition', `attachment; filename="${out.name.replace(/[^\w.-]/g, '_')}"`);
  return res.send(out.body);
};
router.get('/billing/batches/:id/export', billing, wrap(async (req, res) => file(res, await B.exportBatch(req.user, req.params.id, ['csv', 'zoho', 'tally', 'json'].includes(req.query.format) ? req.query.format : 'csv'))));
router.get('/billing/pay-register', billing, wrap(async (req, res) => file(res, await B.payRegister(req.user, { from: req.query.from, to: req.query.to }))));
router.post('/accounting/test', act, admin, wrap(async (req, res) => {
  const c = await B.pushConfig(); const st = B.pushStatus(c);
  if (!st.ready) return res.json({ ok: false, message: st.state });
  if (!st.webhook) return res.json({ ok: true, message: 'Zoho Books keys are saved. The first batch you send makes a draft invoice there.' });
  const H = require('../utils/staffingX/http'); // eslint-disable-line global-require
  const crypto = require('crypto'); // eslint-disable-line global-require
  const raw = JSON.stringify({ id: S.newId(), event: 'ping', at: S.now(), data: { message: 'TeamLink contract billing test' } });
  try {
    const r = await H.send(c.url, { method: 'POST', headers: { 'x-teamlink-event': 'ping', ...(c.secret ? { 'x-teamlink-signature': `sha256=${crypto.createHmac('sha256', c.secret).update(raw).digest('hex')}` } : {}) }, body: raw });
    return res.json({ ok: r.ok, message: r.ok ? `Delivered (HTTP ${r.status}).` : `HTTP ${r.status}` });
  } catch (e) { return res.json({ ok: false, message: e.message }); }
}));

// ---- VMS (02.15 / 06.14 / 14.14) ---------------------------------------------------------------------------------------------------
router.get('/vms', wrap(async (req, res) => res.json({ status: V.status(await V.config()), jobs: await V.jobs(), submissions: await V.submissions(req.user), log: isAdmin(req.user) ? await V.log({ limit: 30 }) : undefined })));
router.post('/vms/test', act, admin, wrap(async (req, res) => res.json(await V.testConnection(req.user))));
router.post('/vms/pull', act, vmsDesk, wrap(async (req, res) => send(res, await V.pullJobs(req.user))));
router.post('/vms/jobs/:id/import', act, vmsDesk, wrap(async (req, res) => send(res, await V.importJob(req.user, req.params.id, { clientId: req.body && req.body.clientId }), 201)));
router.post('/vms/jobs/:id/dismiss', act, vmsDesk, wrap(async (req, res) => send(res, await V.dismissJob(req.user, req.params.id))));
router.get('/vms/jobs/:id/candidates', vmsDesk, wrap(async (req, res) => send(res, await V.candidatesFor(req.user, req.params.id))));
router.post('/vms/submit/:applicationId', act, vmsDesk, wrap(async (req, res) => send(res, await V.submit(req.user, req.params.applicationId, req.body || {}), 201)));
router.post('/vms/sync', act, vmsDesk, wrap(async (req, res) => send(res, await V.syncStatuses(req.user))));

module.exports = router;
