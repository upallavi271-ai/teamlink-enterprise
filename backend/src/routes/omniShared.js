// ---------------------------------------------------------------------------
// /api/omni : the Omni-Channel module's SHARED API, used by Omni-Channel itself AND by the app screens (ATS, Job Portal, HRMS, Accounts).
// It is separate from /api/outreach because HR and Accounts logins have no ATS product (outreach is behind it) but must still reach their own templates,
// campaigns and replies. Every route checks the caller itself (no trust in the screen): the real contact rules (utils/contactAccess.js), the scope engine
// (utils/scope.js), the department of a template / campaign and the owner. A wrong id or a changed query answers 404 (not found) or 403, never data.
//   /library/...        the shared template library (outreach/omni/library.js)
//   /app-campaigns/...  campaigns from app screens (outreach/omni/appCampaigns.js)
//   /sources/...        the people an app screen may offer (job applicants, invoice clients), cut down to what the caller may see
//   /replies/...        Needs review, replies on one record, retry of failed provider events (outreach/omni/replyRouter.js)
//   /connections, /sync-health   honest channel status and the provider-event monitor (outreach/omni/connections.js)
// No provider key, token or secret is ever put in an answer.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../middleware/auth');
const A = require('../outreach/access');
const S = require('../outreach/store');
const Lib = require('../outreach/omni/library');
const App = require('../outreach/omni/appCampaigns');
const Router = require('../outreach/omni/replyRouter');
const Conn = require('../outreach/omni/connections');
const Schema = require('../outreach/omni/schema');
const access = require('../utils/contactAccess');
const convo = require('../utils/conversations');
const scope = require('../utils/scope');

const router = express.Router();
router.use(requireAuth);
const external = (u) => [u.role, u.atsRole].some((r) => ['CLIENT', 'CANDIDATE', 'VENDOR', 'PARTNER'].includes(r));
router.use((req, res, next) => (external(req.user) ? res.status(403).json({ error: 'Not available to this login.' }) : next()));
router.use(async (req, res, next) => { try { await Schema.ensure(); next(); } catch (e) { next(e); } });

const wrap = (fn) => async (req, res, next) => { try { await fn(req, res, next); } catch (e) { next(e); } };
const send = (res, out) => (out && out.error ? res.status(out.status || 400).json({ error: out.error, code: out.code || undefined, template: out.template || undefined }) : res.json(out));
const limit = (n = 120) => {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now(); const l = (hits.get(req.user.id) || []).filter((t) => now - t < 60000);
    if (l.length >= n) return res.status(429).json({ error: 'Too many requests. Wait a minute and try again.' });
    l.push(now); hits.set(req.user.id, l); return next();
  };
};
const isAdmin = (u) => A.isAdmin(u);
const mayAccounts = (u) => isAdmin(u) || (!!u.accountsRole && !['NONE', 'CLIENT'].includes(u.accountsRole));
const key = (req) => decodeURIComponent(String(req.params.key || ''));

// ---- who am I here ------------------------------------------------------------------------------------------
router.get('/me', wrap(async (req, res) => {
  const rules = {};
  for (const a of ['candidates', 'clients', 'employees']) { const r = await access.ruleFor(req.user, a).catch(() => ({ allowed: false })); rules[a] = { allowed: !!r.allowed, masked: r.mode === 'masked', billingOnly: !!r.purposes }; } // eslint-disable-line no-await-in-loop
  res.json({ apps: Lib.APPS, contact: rules, isAdmin: isAdmin(req.user), omniPages: A.pagesFor(req.user) });
}));

// ---- the shared template library --------------------------------------------------------------------------------
router.get('/library/templates', wrap(async (req, res) => {
  const dept = String(req.query.dept || '').trim();
  if (dept && !isAdmin(req.user) && !A.mayDepartment(req.user, dept)) return res.json({ items: [], total: 0, counts: { all: 0 }, apps: Lib.APPS, channels: {}, waiting: 0, settings: await Lib.settings() }); // another department's templates: nothing
  res.json(await Lib.list(req.user, { app: req.query.app, channel: req.query.channel, q: req.query.q, approval: req.query.approval, dept }));
}));
router.get('/library/settings', wrap(async (req, res) => res.json({ settings: await Lib.settings(), canChange: isAdmin(req.user) })));
router.put('/library/settings', limit(30), wrap(async (req, res) => send(res, await Lib.saveSettings(req.user, req.body || {}))));
router.get('/library/templates/:key', wrap(async (req, res) => {
  const item = await Lib.one(req.user, key(req), req.query.app);
  if (!item) return res.status(404).json({ error: 'This template was not found.' });
  return res.json({ template: item });
}));
router.get('/library/templates/:key/versions', wrap(async (req, res) => send(res, await Lib.versions(req.user, key(req)))));
router.put('/library/templates/:key/scopes', limit(60), wrap(async (req, res) => send(res, await Lib.setScopes(req.user, key(req), (req.body || {}).scopes))));
router.put('/library/templates/:key/department', limit(60), wrap(async (req, res) => send(res, await Lib.setDepartment(req.user, key(req), (req.body || {}).department))));
router.post('/library/templates/:key/approval', limit(60), wrap(async (req, res) => send(res, await Lib.approvalAction(req.user, key(req), String((req.body || {}).action || ''), (req.body || {}).note))));
router.post('/library/check', wrap(async (req, res) => {
  const b = req.body || {};
  if (!Lib.APPS.includes(b.app)) return res.status(400).json({ error: 'Which app?' });
  const g = await Lib.gate(req.user, String(b.key || ''), b.app);
  return g ? res.status(g.status || 400).json({ error: g.error, code: g.code }) : res.json({ ok: true });
}));

// ---- campaigns from the app screens ------------------------------------------------------------------------------
router.get('/app-campaigns', wrap(async (req, res) => res.json(await App.list(req.user, { app: req.query.app, status: req.query.status, q: req.query.q }))));
router.post('/app-campaigns/preview', limit(120), wrap(async (req, res) => send(res, await App.preview(req.user, req.body || {}))));
router.post('/app-campaigns', limit(60), wrap(async (req, res) => send(res, await App.create(req.user, req.body || {}))));
router.post('/app-campaigns/tick', limit(20), wrap(async (req, res) => (isAdmin(req.user) ? res.json(await App.tick()) : res.status(403).json({ error: 'Only an Admin can do this.' }))));
router.get('/app-campaigns/:id', wrap(async (req, res) => send(res, await App.get(req.user, req.params.id, { page: req.query.page, pageSize: req.query.pageSize, status: req.query.status }))));
router.put('/app-campaigns/:id', limit(60), wrap(async (req, res) => send(res, await App.update(req.user, req.params.id, req.body || {}))));
router.delete('/app-campaigns/:id', limit(30), wrap(async (req, res) => send(res, await App.remove(req.user, req.params.id))));
router.post('/app-campaigns/:id/submit', limit(30), wrap(async (req, res) => send(res, await App.submit(req.user, req.params.id))));
router.post('/app-campaigns/:id/approve', limit(30), wrap(async (req, res) => send(res, await App.decide(req.user, req.params.id, true, (req.body || {}).note))));
router.post('/app-campaigns/:id/reject', limit(30), wrap(async (req, res) => send(res, await App.decide(req.user, req.params.id, false, (req.body || {}).note))));
router.post('/app-campaigns/:id/send', limit(20), wrap(async (req, res) => send(res, await App.send(req.user, req.params.id, { when: (req.body || {}).when === 'later' ? 'later' : 'now', at: (req.body || {}).at }))));
['pause', 'resume', 'cancel'].forEach((a) => router.post(`/app-campaigns/:id/${a}`, limit(60), wrap(async (req, res) => send(res, await App.control(req.user, req.params.id, a)))));
router.post('/app-campaigns/:id/retry', limit(20), wrap(async (req, res) => send(res, await App.retryFailed(req.user, req.params.id))));

// ---- people an app screen may offer -----------------------------------------------------------------------------------
router.get('/sources/job-applicants', wrap(async (req, res) => {
  const rule = await access.ruleFor(req.user, 'candidates').catch(() => ({ allowed: false }));
  if (!rule.allowed) return res.status(403).json({ error: rule.reason || 'Your role does not follow up candidates.' });
  const rid = String(req.query.requirementId || '');
  const rq = rid ? await prisma.requirement.findFirst({ where: { AND: [{ id: rid }, scope.requirementWhere(req.user)] }, select: { id: true, title: true } }) : null;
  if (!rq) return res.status(404).json({ error: 'This requirement was not found.' });
  const portal = require('../utils/atsVocab').PORTAL_APPLICATION_SOURCE;
  const apps = await prisma.application.findMany({ where: { AND: [{ requirementId: rq.id }, { source: portal }, scope.applicationWhere(req.user)] }, select: { id: true, candidateId: true }, take: 600 });
  const ids = [...new Set(apps.map((a) => a.candidateId))];
  return res.json({ requirementId: rq.id, title: rq.title, ids, count: ids.length });
}));
router.post('/sources/invoice-clients', wrap(async (req, res) => {
  const rule = await access.ruleFor(req.user, 'clients').catch(() => ({ allowed: false }));
  if (!rule.allowed) return res.status(403).json({ error: rule.reason || 'Not available to this login.' });
  const ids = [...new Set((Array.isArray((req.body || {}).invoiceIds) ? req.body.invoiceIds : []).map(String))].slice(0, 500);
  if (!ids.length) return res.status(400).json({ error: 'Pick at least one invoice.' });
  const rows = await prisma.invoice.findMany({ where: { AND: [{ id: { in: ids } }, scope.invoiceWhere(req.user)] }, select: { id: true, clientId: true } });
  const clientIds = [...new Set(rows.map((r) => r.clientId))];
  return res.json({ ids: clientIds, count: clientIds.length, invoices: rows.length, outsideYourAccess: ids.length - rows.length });
}));

// ---- replies --------------------------------------------------------------------------------------------------------------------
router.get('/replies/review', wrap(async (req, res) => res.json(await Router.reviewList(req.user, { status: req.query.status === 'done' ? 'done' : 'open', page: req.query.page, pageSize: req.query.pageSize }))));
router.post('/replies/review/:id/resolve', limit(60), wrap(async (req, res) => send(res, await Router.resolve(req.user, req.params.id, req.body || {}))));
router.post('/replies/review/:id/dismiss', limit(60), wrap(async (req, res) => send(res, await Router.dismiss(req.user, req.params.id, (req.body || {}).reason))));
router.post('/replies/retry', limit(10), wrap(async (req, res) => (isAdmin(req.user) ? res.json(await Router.retryDue({ all: true })) : res.status(403).json({ error: 'Only an Admin can do this.' }))));
// the replies matched to one record (a candidate, client contact, employee or vendor), for the source app's own screen
router.get('/replies/of/:audience/:id', wrap(async (req, res) => {
  const aud = String(req.params.audience);
  const id = String(req.params.id || '');
  if (aud === 'vendors') {
    if (!mayAccounts(req.user)) return res.status(403).json({ error: 'Vendor replies are for Accounts.' });
    const v = await prisma.officeVendor.findUnique({ where: { id }, select: { id: true } }).catch(() => null);
    if (!v) return res.status(404).json({ error: 'This vendor was not found.' });
    return res.json({ replies: await Router.repliesOf('VENDOR', id) });
  }
  const type = convo.TYPES[aud];
  if (!type) return res.status(404).json({ error: 'Unknown kind of person.' });
  const rule = await access.ruleFor(req.user, aud).catch(() => ({ allowed: false }));
  if (!rule.allowed) return res.status(403).json({ error: rule.reason || 'Not available to this login.' });
  const vis = await convo.visibleIds(req.user, type, [id]);
  if (!vis.has(id)) return res.status(403).json({ error: 'This person is outside your access.' });
  return res.json({ replies: await Router.repliesOf(type, id), masked: rule.mode === 'masked' });
}));

// ---- channel connections + sync health -------------------------------------------------------------------------------------------------
router.get('/connections', wrap(async (req, res) => {
  if (!A.pagesFor(req.user).includes('connections') && !isAdmin(req.user)) return res.status(403).json({ error: 'Not available to this login.' });
  return res.json(await Conn.channels(req.user));
}));
router.get('/sync-health', wrap(async (req, res) => {
  if (!A.pagesFor(req.user).includes('connections') && !isAdmin(req.user)) return res.status(403).json({ error: 'Not available to this login.' });
  const h = await Conn.syncHealth();
  if (!isAdmin(req.user)) { h.events.failedList = []; } // the failure details are for an Admin
  return res.json({ ...h, canRetry: isAdmin(req.user) });
}));

router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[omni-shared]', err && err.message); // eslint-disable-line no-console
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

module.exports = router;
