// ---------------------------------------------------------------------------
// /api/outreach/gs/external : the external-service shells (Social Media, Facebook, Instagram, Facebook Catalogs, Shopify, Ads Manager,
// Google Campaigns, Google Ads, Google Analytics). Mounted by routes/outreach.js (behind login + "may use Omni-Channel").
// Who: Admin, Department Head and Marketing may LOOK and keep plain records; only an Admin connects / disconnects / changes the page settings.
// No secret is ever returned (a masked hint only). Nothing is posted, created or spent at an outside service.
// ---------------------------------------------------------------------------
const express = require('express');
const { logAudit } = require('../utils/audit');
const A = require('../outreach/access');
const X = require('../outreach/external');
const { deptOf } = require('../outreach/chrome');

const router = express.Router();
const wrap = (fn) => async (req, res, next) => {
  try { await fn(req, res, next); } catch (e) {
    if (e && e.plain) return res.status(e.status || 400).json({ error: e.message });
    return next(e);
  }
};
const mayLook = (u) => ['admin', 'depthead', 'marketing'].includes(A.level(u));
router.use((req, res, next) => (mayLook(req.user) ? next() : res.status(403).json({ error: 'These pages are for Admins, Department Heads and Marketing.' })));
const admin = (req, res) => { if (A.isAdmin(req.user)) return true; res.status(403).json({ error: 'Only an Admin can do this. You can look, but not change it.' }); return false; };
const audit = (req, action, entityId, toValue) => logAudit({ userId: req.user.id, actorName: req.user.name, action, entity: 'OmniExternal', entityId, toValue });
const svc = (req, res) => { const d = X.defOf(req.params.id); if (!d) { res.status(404).json({ error: 'Unknown service.' }); return null; } return d; };

// ---- connections -----------------------------------------------------------------------------------------------
router.get('/connections', wrap(async (req, res) => {
  await X.ensure();
  const isA = A.isAdmin(req.user);
  const out = []; for (const id of X.IDS) out.push(await X.publicState(id, isA)); // eslint-disable-line no-await-in-loop
  res.json({ connections: out, canConnect: isA, sandbox: X.sandbox(), settings: await X.settings() });
}));
router.get('/connection/:id', wrap(async (req, res) => {
  if (!svc(req, res)) return;
  res.json({ connection: await X.publicState(req.params.id, A.isAdmin(req.user)), canConnect: A.isAdmin(req.user), settings: await X.settings() });
}));
router.put('/connection/:id', wrap(async (req, res) => {
  if (!svc(req, res) || !admin(req, res)) return;
  const out = await X.save(req.user, req.params.id, (req.body && req.body.values) || {});
  await audit(req, 'Omni-Channel service keys saved', req.params.id, `${out.state.statusWords}; ${out.changed.length} field(s) changed`);
  res.json({ connection: out.state, canConnect: true });
}));
router.post('/connection/:id/check', wrap(async (req, res) => {
  if (!svc(req, res) || !admin(req, res)) return;
  const state = await X.runCheck(req.params.id, req.user);
  await audit(req, 'Omni-Channel service checked', req.params.id, state.statusWords);
  res.json({ connection: state, canConnect: true });
}));
router.delete('/connection/:id', wrap(async (req, res) => {
  if (!svc(req, res) || !admin(req, res)) return;
  const state = await X.disconnect(req.user, req.params.id);
  await audit(req, 'Omni-Channel service disconnected', req.params.id, 'Keys deleted');
  res.json({ connection: state, canConnect: true });
}));

// ---- page settings (display name, toggles) and the planned Google budget -------------------------------------------------
router.get('/settings', wrap(async (req, res) => res.json({ settings: await X.settings(), canChange: A.isAdmin(req.user) })));
router.put('/settings/:key', wrap(async (req, res) => {
  if (!admin(req, res)) return;
  const s = await X.saveSettings(req.user, req.params.key, req.body || {});
  await audit(req, 'Omni-Channel page settings saved', req.params.key, Object.keys(req.body || {}).join(', ').slice(0, 120));
  res.json({ settings: s });
}));
router.put('/google-budget', wrap(async (req, res) => {
  const s = await X.saveGoogleBudget(req.user, (req.body || {}).amount);
  await audit(req, 'Omni-Channel Google monthly budget planned', 'google-budget', String(s.googleBudget.amount));
  res.json({ settings: s });
}));

// ---- social posts: saved only ---------------------------------------------------------------------------------------
const NOTE = 'Posting to the network is planned: nothing is published.';
router.get('/social/posts', wrap(async (req, res) => {
  const out = await X.listPosts(deptOf(req.user, req.query.dept), { tab: String(req.query.tab || ''), limit: req.query.limit });
  res.json({ ...out, note: NOTE });
}));
router.get('/social/posts/:id', wrap(async (req, res) => {
  const p = await X.getPost(req.params.id);
  if (!p) return res.status(404).json({ error: 'That post was not found.' });
  return res.json({ post: p, insights: { views: null, likes: null, comments: null, followers: null, visits: null, interactions: null, words: 'Not synced yet' }, note: NOTE });
}));
router.post('/social/posts', wrap(async (req, res) => {
  const dept = deptOf(req.user, req.query.dept || (req.body || {}).dept);
  if (dept === null) return res.status(403).json({ error: 'You cannot post for that department.' });
  const post = await X.createPost(req.user, dept, req.body || {});
  await audit(req, post.status === 'scheduled' ? 'Omni-Channel social post scheduled (not published)' : 'Omni-Channel social post saved (not published)', post.id, `#${post.postNumber} ${post.platforms.join('+')}`);
  res.json({ post, note: NOTE });
}));
router.delete('/social/posts/:id', wrap(async (req, res) => {
  const p = await X.deletePost(req.user, A.isAdmin(req.user), req.params.id);
  if (!p) return res.status(404).json({ error: 'That post was not found.' });
  await audit(req, 'Omni-Channel social post deleted', p.id, `#${p.postNumber}`);
  return res.json({ ok: true });
}));

// ---- campaign plans: saved, nothing created at Meta / Google ----------------------------------------------------------------
router.get('/items', wrap(async (req, res) => res.json({ items: await X.listItems(deptOf(req.user, req.query.dept), String(req.query.kind || '')) })));
router.post('/items', wrap(async (req, res) => {
  const dept = deptOf(req.user, req.query.dept || (req.body || {}).dept);
  if (dept === null) return res.status(403).json({ error: 'You cannot add a plan for that department.' });
  const item = await X.createItem(req.user, dept, req.body || {});
  await audit(req, 'Omni-Channel campaign plan saved (nothing created outside)', item.id, item.kind);
  res.json({ item });
}));
router.delete('/items/:id', wrap(async (req, res) => {
  const it = await X.deleteItem(req.user, A.isAdmin(req.user), req.params.id);
  if (!it) return res.status(404).json({ error: 'That plan was not found.' });
  await audit(req, 'Omni-Channel campaign plan removed', it.id, it.kind);
  return res.json({ ok: true });
}));

module.exports = router;
