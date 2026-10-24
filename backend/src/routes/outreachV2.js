// ---------------------------------------------------------------------------
// /api/outreach  (v2, 2026-10-17): the access summary (/me), credits + activity per person, the template hub and the connections page.
// Mounted INSIDE routes/outreach.js, so it already sits behind login, the ATS product check and "may use Omni-Channel at all".
// Who may do what is decided by outreach/access.js (one place); the screens only hide.
// ---------------------------------------------------------------------------
const express = require('express');
const { logAudit } = require('../utils/audit');
const A = require('../outreach/access');
const Cr = require('../outreach/credits');
const Hub = require('../outreach/hub');
const Conn = require('../outreach/connections');
const Ov = require('../outreach/overview');
const Ins = require('../outreach/insights');
const S = require('../outreach/store');

const router = express.Router();
const wrap = (fn) => async (req, res, next) => { try { await fn(req, res, next); } catch (e) { next(e); } };
const deny = (res, why = 'Only an Admin can do this.') => res.status(403).json({ error: why });
const send = (res, out) => (out && out.error ? res.status(out.status || 400).json({ error: out.error }) : res.json(out));

// ---- credits (Admin changes the rules) --------------------------------------------------------------------
router.get('/credits/settings', wrap(async (req, res) => {
  if (!A.mayCreditSettings(req.user)) return deny(res);
  return res.json({ settings: await Cr.settings(), channels: Cr.CHANNELS.map((c) => ({ id: c, word: Cr.CHANNEL_WORD[c] })) });
}));
router.put('/credits/settings', wrap(async (req, res) => {
  if (!A.mayCreditSettings(req.user)) return deny(res);
  const saved = await Cr.saveSettings(req.body || {}, req.user);
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Omni-Channel credit rules changed', entity: 'OmniCredits', entityId: 'settings', toValue: `allowance ${saved.allowance}, enforce ${saved.enforce}` });
  return res.json({ settings: saved, ok: 'Saved.' });
}));
router.put('/credits/allowance/:userId', wrap(async (req, res) => {
  if (!A.mayCreditSettings(req.user)) return deny(res);
  const out = await Cr.setAllowance(String(req.params.userId), (req.body || {}).allowance, (req.body || {}).note, req.user);
  if (!out.error) await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Omni-Channel person credits changed', entity: 'OmniCredits', entityId: String(req.params.userId), toValue: out.cleared ? 'back to the default' : String(out.allowance) });
  return send(res, out.error ? { ...out, status: 400 } : { ...out, ok: 'Saved.' });
}));

// ---- activity per person ---------------------------------------------------------------------------------------------------
function activityScope(req) {
  const wantTeam = req.query.scope === 'team';
  if (wantTeam && A.seesTeamActivity(req.user)) return { team: true, ...A.deptScope(req.user), admin: A.isAdmin(req.user) };
  return { team: false, onlyUserId: req.user.id };
}
router.get('/activity', wrap(async (req, res) => {
  const sc = activityScope(req);
  if (req.query.scope === 'team' && !sc.team) return deny(res, 'Team activity is for Admins, Managers and Team Leads.');
  const month = Cr.isMonth(req.query.month) ? req.query.month : Cr.thisMonth();
  const scw = sc.team ? await Ins.scopeOf(req.user) : null; // Team Lead = their team, Department Head = their department, Admin / Manager = everyone
  const act = await Cr.activity(month, sc.team ? Ins.actOpts(scw) : { onlyUserId: sc.onlyUserId });
  const { ids, ...out } = act; // eslint-disable-line no-unused-vars
  res.json({ ...out, scope: sc.team ? 'team' : 'me', scopeWords: sc.team ? scw.words : 'Only you', canExport: sc.team && A.mayExportActivity(req.user) });
}));
router.get('/activity.csv', wrap(async (req, res) => {
  if (!A.mayExportActivity(req.user)) return deny(res, 'You cannot download this list.');
  const month = Cr.isMonth(req.query.month) ? req.query.month : Cr.thisMonth();
  const act = await Cr.activity(month, Ins.actOpts(await Ins.scopeOf(req.user)));
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Omni-Channel activity downloaded', entity: 'OmniActivity', entityId: month, toValue: `${act.rows.length} people` });
  res.set('Content-Disposition', `attachment; filename="omni-activity-${month}.csv"`);
  res.type('text/csv');
  return res.send(Cr.csv(act));
}));

// ---- template hub -------------------------------------------------------------------------------------------------------------------
router.get('/hub/templates', wrap(async (req, res) => res.json(await Hub.list(req.user, { where: req.query.where, q: req.query.q, channel: req.query.channel, approval: req.query.approval }))));
router.put('/hub/templates/:key', wrap(async (req, res) => send(res, await Hub.update(req.user, req.params.key, req.body || {}))));
router.post('/hub/templates', wrap(async (req, res) => send(res, await Hub.create(req.user, req.body || {}))));

// ---- connections (Admin) ------------------------------------------------------------------------------------------------------------------
router.get('/connections', wrap(async (req, res) => { if (!A.isAdmin(req.user)) return deny(res); return res.json(await Conn.status()); }));
router.post('/connections/test/:id', wrap(async (req, res) => {
  if (!A.isAdmin(req.user)) return deny(res);
  const one = await Conn.test(String(req.params.id));
  return one ? res.json({ link: one, checkedAt: new Date().toISOString(), note: 'Only read. Nothing was sent.' }) : res.status(404).json({ error: 'Unknown link.' });
}));
router.post('/connections/sync/hrms', wrap(async (req, res) => { if (!A.isAdmin(req.user)) return deny(res); return send(res, await Conn.syncHrms(req.user)); }));

// ---- overview, reports, contact timeline (360 audit) ----------------------------------------------------------------------------------
router.get('/overview', wrap(async (req, res) => res.json(await Ov.overview(req.user))));
router.get('/reports', wrap(async (req, res) => res.json(await Ov.reports(req.user, { days: req.query.days }))));
router.get('/reports.csv', wrap(async (req, res) => {
  if (!A.mayExportReport(req.user)) return deny(res, 'You cannot download reports.');
  const rep = await Ov.reports(req.user, { days: req.query.days });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Omni-Channel report downloaded', entity: 'OmniReport', entityId: 'campaigns', toValue: `${(rep.campaigns || []).length} campaigns` });
  res.set('Content-Disposition', 'attachment; filename="omni-report.csv"');
  res.type('text/csv');
  return res.send(Ov.reportCsv(rep));
}));
router.get('/contacts/:id/timeline', wrap(async (req, res) => {
  const out = await Ov.timeline(req.user, req.params.id);
  return out ? res.json(out) : res.status(404).json({ error: 'This person was not found.' });
}));

// ---- structure plan 2026-10-17: dashboard, insights, automations, communication, configuration, candidate timeline -------------------------------
const Dash = require('../outreach/dashboard');
const Seq = require('../outreach/sequences');
const Comm = require('../outreach/communication');
const Cfg = require('../outreach/config');
const Tl = require('../outreach/timeline');
Seq.start(); // the automations tick (every minute; does nothing for automations that are off)

router.get('/dashboard', wrap(async (req, res) => {
  if (!A.hubsFor(req.user).dashboard) return deny(res, 'There is no dashboard for your login.');
  return res.json(await Dash.dashboard(req.user));
}));

const needInsight = (tab) => (req, res, next) => (A.hubsFor(req.user).insights.includes(tab) ? next() : deny(res, 'This part of Insights is not for your login.'));
const monthOf = (req) => (Cr.isMonth(req.query.month) ? req.query.month : Cr.thisMonth());
router.get('/insights/performance', needInsight('performance'), wrap(async (req, res) => res.json(await Ins.performance(req.user, monthOf(req)))));
router.get('/insights/roi', needInsight('roi'), wrap(async (req, res) => res.json(await Ins.roi(req.user, monthOf(req)))));
router.get('/insights/funnel', needInsight('reports'), wrap(async (req, res) => res.json(await Ins.funnel(req.user, req.query.days))));

// automations (sequences)
router.get('/automations', wrap(async (req, res) => res.json(await Seq.list(req.user))));
router.get('/automations/tasks', wrap(async (req, res) => res.json(await Seq.tasks(req.user))));
router.post('/automations/tasks/:id/done', wrap(async (req, res) => send(res, await Seq.doneTask(req.user, req.params.id))));
router.post('/automations', wrap(async (req, res) => send(res, await Seq.save(req.user, null, req.body || {}))));
router.put('/automations/:id', wrap(async (req, res) => send(res, await Seq.save(req.user, req.params.id, req.body || {}))));
router.post('/automations/:id/on', wrap(async (req, res) => send(res, await Seq.toggle(req.user, req.params.id, true))));
router.post('/automations/:id/off', wrap(async (req, res) => send(res, await Seq.toggle(req.user, req.params.id, false))));
router.delete('/automations/:id', wrap(async (req, res) => send(res, await Seq.remove(req.user, req.params.id))));
router.post('/automations/:id/enrol', wrap(async (req, res) => send(res, await Seq.enrol(req.user, req.params.id, (req.body || {}).contactIds))));
router.get('/automations/:id/runs', wrap(async (req, res) => send(res, await Seq.runs(req.user, req.params.id))));

// communication desks
router.get('/communication/log', wrap(async (req, res) => send(res, await Comm.log(req.user, req.query.channel))));
router.post('/communication/send', wrap(async (req, res) => send(res, await Comm.quickSend(req.user, req.body || {}))));

// configuration hub (Admin only)
const adminOnly = (req, res, next) => (A.isAdmin(req.user) ? next() : deny(res));
router.get('/config/meta', adminOnly, wrap(async (req, res) => res.json({ account: await Cfg.account(), departments: await Cfg.departments(), templates: await Cfg.approvals(req.user) })));
router.post('/config/meta/check', adminOnly, wrap(async (req, res) => res.json(await Cfg.check())));
router.put('/config/departments', adminOnly, wrap(async (req, res) => send(res, await Cfg.saveDepartments(req.user, req.body || {}))));
router.get('/config/department-names', adminOnly, wrap(async (req, res) => res.json({ names: (await Cfg.departments()).rows.map((r) => r.name) })));
router.get('/config/people', adminOnly, wrap(async (req, res) => res.json({ people: await Cfg.people() })));
router.get('/config/permissions', adminOnly, wrap(async (req, res) => res.json(await Cfg.permissions(req.user))));
router.put('/config/permissions/marketing', adminOnly, wrap(async (req, res) => send(res, await Cfg.setMarketing(req.user, (req.body || {}).userIds))));

// the candidate page: one communication timeline (labels and times only)
router.get('/candidate-timeline/:id', wrap(async (req, res) => {
  const out = await Tl.candidateTimeline(req.user, req.params.id);
  return out ? res.json(out) : res.status(404).json({ error: 'This candidate was not found.' });
}));

module.exports = router;
