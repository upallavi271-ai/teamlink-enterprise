// ---------------------------------------------------------------------------
// /api/outreach/gs/campaigns : the Green Start "Campaigns" area of Omni-Channel (the list, the 5-step Create wizard, the campaign command center, analytics,
// live message logs, approval, call tasks). Auto-mounted by routes/outreach.js behind login + "may use Omni-Channel" (+ the ATS gate), so req.user is always a staff login.
// All logic lives in outreach/gsCampaigns.js (groups of campaign rows) on top of the ONE engine (campaigns.js); old /api/outreach/campaigns* routes are untouched.
// The server decides who may do what; nothing here sends a real message unless an Admin has switched Test mode off (and then only the engine's own send path does).
// Errors are { error: 'plain words' }. Phone / email are never in an audit row; the CSV of logs is for the roles that may export and masked for the masked roles.
// ---------------------------------------------------------------------------
const express = require('express');
const S = require('../outreach/store');
const A = require('../outreach/access');
const Camp = require('../outreach/campaigns');
const Gs = require('../outreach/gsCampaigns');
const Appr = require('../outreach/approval');
const MLog = require('../outreach/messageLog');
const { deptOf } = require('../outreach/chrome');
const { logAudit } = require('../utils/audit');

const router = express.Router();
const wrap = (fn) => async (req, res, next) => { try { await fn(req, res, next); } catch (e) { if (e instanceof S.OutreachError) return res.status(e.status).json({ error: e.message, code: e.code }); return next(e); } return undefined; };
const fail = (res, out) => res.status(out.status || 400).json({ error: out.error, code: out.code || undefined, problems: out.problems || undefined, results: out.results || undefined, credits: out.credits || undefined });
const send = (res, out) => (out && out.error ? fail(res, out) : res.json(out));
const limit = (n = 240) => {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const l = (hits.get(req.user.id) || []).filter((t) => now - t < 60000);
    if (l.length >= n) return res.status(429).json({ error: 'Too many requests. Wait a minute and try again.' });
    l.push(now); hits.set(req.user.id, l);
    return next();
  };
};
const ready = wrap(async (req, res, next) => {
  if (await S.campaignsReady()) return next();
  return res.status(503).json({ error: 'Campaigns are being set up. Please try again in a little while.', setup: true });
});
router.use(ready);
// Finance and the logins with no recruitment access never get here (the parent router refuses them), but a login that may only use Omni-Channel for something else is refused too
router.use((req, res, next) => (A.hubsFor(req.user).campaigns ? next() : res.status(403).json({ error: 'Campaigns are not open for your login.' })));
const filtersOf = (req) => ({ channel: req.query.channel, status: req.query.status, q: req.query.q, objective: req.query.objective, sort: req.query.sort, dir: req.query.dir === 'asc' ? 'asc' : 'desc', page: req.query.page, pageSize: req.query.pageSize, dept: deptOf(req.user, req.query.dept) });
const mustCreate = (req, res) => { if (A.mayCampaign(req.user) || A.kind(req.user) === 'hr' || A.isAdmin(req.user)) return true; res.status(403).json({ error: 'You can look at campaigns, but only the BDE team, Team Leads and Admins can make or send them.' }); return false; };

// ---- the list ------------------------------------------------------------------------------------------------------------------------
router.get('/list', limit(), wrap(async (req, res) => res.json(await Gs.list(req.user, filtersOf(req)))));
router.get('/export', limit(30), wrap(async (req, res) => {
  const out = await Gs.exportCsv(req.user, filtersOf(req));
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Omni campaigns list downloaded', entity: 'OutreachCampaign', entityId: 'list', toValue: `${out.count} campaigns` });
  res.set('Content-Disposition', 'attachment; filename="campaigns_export.csv"');
  res.type('text/csv; charset=utf-8');
  return res.send(out.csv);
}));
router.get('/approvals', limit(), wrap(async (req, res) => res.json({ approvals: await Appr.pendingList(req.user) })));

// ---- the wizard's helpers ----------------------------------------------------------------------------------------------------------------
router.get('/options', limit(), wrap(async (req, res) => res.json(await Gs.options(req.user, { audience: req.query.audience }))));
router.get('/jobs', limit(), wrap(async (req, res) => res.json(await Camp.jobs(req.user, { q: req.query.q }))));
router.post('/plan', limit(120), wrap(async (req, res) => send(res, await Gs.planAudience(req.user, req.body || {}))));
router.post('/review', limit(60), wrap(async (req, res) => send(res, await Gs.review(req.user, req.body || {}))));
router.post('/create', limit(30), wrap(async (req, res) => { if (!mustCreate(req, res)) return undefined; return send(res, await Gs.createGroup(req.user, req.body || {})); }));

// ---- one campaign (the key = the campaign's key from the list) ------------------------------------------------------------------------------
const key = (req) => String(req.params.key || '');
router.get('/campaign/:key', limit(), wrap(async (req, res) => send(res, await Gs.detail(req.user, key(req)))));
router.get('/campaign/:key/edit', limit(), wrap(async (req, res) => send(res, await Gs.editShape(req.user, key(req)))));
router.put('/campaign/:key', limit(30), wrap(async (req, res) => { if (!mustCreate(req, res)) return undefined; return send(res, await Gs.updateGroup(req.user, key(req), req.body || {})); }));
router.put('/campaign/:key/master', limit(60), wrap(async (req, res) => send(res, await Gs.saveMaster(req.user, key(req), (req.body || {}).text, (req.body || {}).cta))));
router.get('/campaign/:key/audience', limit(), wrap(async (req, res) => send(res, await Gs.audience(req.user, key(req), { page: req.query.page, pageSize: req.query.pageSize, q: req.query.q }))));
router.get('/campaign/:key/replies', limit(), wrap(async (req, res) => send(res, await Gs.replies(req.user, key(req)))));
router.get('/campaign/:key/analytics', limit(), wrap(async (req, res) => send(res, await Gs.analytics(req.user, key(req)))));
router.get('/campaign/:key/analytics.csv', limit(30), wrap(async (req, res) => {
  const out = await Gs.analyticsCsv(req.user, key(req));
  if (out.error) return fail(res, out);
  res.set('Content-Disposition', `attachment; filename="${String(out.name || 'campaign').replace(/[^\w.-]+/g, '_').slice(0, 50)}_analytics.csv"`);
  res.type('text/csv; charset=utf-8');
  return res.send(out.csv);
}));
router.get('/campaign/:key/export.csv', limit(60), wrap(async (req, res) => {
  const out = await Gs.exportRow(req.user, key(req));
  if (out.error) return fail(res, out);
  res.set('Content-Disposition', `attachment; filename="${String(out.name || 'campaign').toLowerCase().replace(/\W+/g, '-').slice(0, 50)}.csv"`);
  res.type('text/csv; charset=utf-8');
  return res.send(out.csv);
}));
router.get('/campaign/:key/logs', limit(), wrap(async (req, res) => send(res, await Gs.logs(req.user, key(req), { status: req.query.status, q: req.query.q, channel: req.query.channel, page: req.query.page, pageSize: req.query.pageSize }))));
router.get('/campaign/:key/logs.csv', limit(20), wrap(async (req, res) => {
  const out = await Gs.logsCsv(req.user, key(req), { status: req.query.status, q: req.query.q, channel: req.query.channel });
  if (out.error) return fail(res, out);
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Omni campaign message log downloaded', entity: 'OutreachMessage', entityId: key(req), toValue: `${out.count} rows; ${out.filterWords}` });
  res.set('Content-Disposition', `attachment; filename="${String(key(req)).replace(/[^\w.-]+/g, '_').slice(0, 40)}_message_logs.csv"`);
  res.type('text/csv; charset=utf-8');
  return res.send(out.csv);
}));

// ---- actions ---------------------------------------------------------------------------------------------------------------------------------
router.post('/campaign/:key/send', limit(30), wrap(async (req, res) => send(res, await Gs.sendGroup(req.user, key(req), { when: (req.body || {}).when, at: (req.body || {}).at }))));
router.post('/campaign/:key/schedule', limit(30), wrap(async (req, res) => send(res, await Gs.sendGroup(req.user, key(req), { when: 'at', at: (req.body || {}).at }))));
['pause', 'resume', 'stop'].forEach((a) => router.post(`/campaign/:key/${a}`, limit(60), wrap(async (req, res) => send(res, await Gs.controlGroup(req.user, key(req), a)))));
router.post('/campaign/:key/resend', limit(30), wrap(async (req, res) => send(res, await Gs.resendGroup(req.user, key(req)))));
router.post('/campaign/:key/duplicate', limit(30), wrap(async (req, res) => { if (!mustCreate(req, res)) return undefined; return send(res, await Gs.duplicateGroup(req.user, key(req), (req.body || {}).name)); }));
router.delete('/campaign/:key', limit(30), wrap(async (req, res) => send(res, await Gs.removeGroup(req.user, key(req)))));
// approval
router.post('/campaign/:key/submit', limit(30), wrap(async (req, res) => send(res, await Appr.submit(req.user, key(req)))));
router.post('/campaign/:key/approve', limit(30), wrap(async (req, res) => send(res, await Appr.approve(req.user, key(req), (req.body || {}).note))));
router.post('/campaign/:key/reject', limit(30), wrap(async (req, res) => send(res, await Appr.reject(req.user, key(req), (req.body || {}).note))));
// call tasks (a call campaign): the list, and logging one call
router.get('/campaign/:key/calls', limit(), wrap(async (req, res) => {
  const f = await Gs.loadOne(req.user, key(req));
  if (f.error) return fail(res, f);
  const row = f.group.rows.find((r) => Camp.chanOf(r) === 'call');
  if (!row) return res.status(400).json({ error: 'This campaign has no calls.' });
  return send(res, await Camp.callTasks(req.user, row.id, { status: req.query.status, q: req.query.q, page: req.query.page, pageSize: req.query.pageSize }));
}));
router.post('/calls/:messageId/mark', limit(300), wrap(async (req, res) => send(res, await Camp.markCall(req.user, req.params.messageId, { outcome: (req.body || {}).outcome, minutes: (req.body || {}).minutes, note: (req.body || {}).note }))));

module.exports = router;
void MLog;
