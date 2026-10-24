// ---------------------------------------------------------------------------
// /api/job-dist : the "Distribute" tab of a job (Posting Kit, tracked links, Posted tracker) and its settings.
//   GET  /jobs/:id                              every platform as a card (text, tracked link, state)       anyone who may see the job
//   GET  /jobs/:id/platforms/:key/text          the ready text of one platform
//   PUT  /jobs/:id/platforms/:key/text          { text, title }  the poster's own edit                       who may post the job
//   DELETE /jobs/:id/platforms/:key/text        Reset to auto                                                who may post the job
//   POST /jobs/:id/platforms/:key/posted        Mark as posted { postUrl, postedAt, postedBy, expiresAt, noExpiry, notes }
//   POST /jobs/:id/platforms/:key/taken-down    "I took it down"
//   DELETE /jobs/:id/platforms/:key/posted      I marked the wrong place
//   GET  /jobs/:id/sources                      applicants per platform (counts only)
//   GET  /tracker                               the Posting tracker (where posted / pending / expired)
//   GET/PUT /settings, GET/POST/PUT/DELETE /platforms ...      Admin
//   GET/PUT/DELETE /google-indexing, POST /jobs/:id/google-indexing    optional, OFF by default (Admin)
// Nothing here posts to a website: the automatic Telegram / Facebook posts go through /api/job-publish (the same engine).
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth, requireProduct } = require('../middleware/auth');
const access = require('../jobPublish/access');
const Plat = require('../jobDist/platforms');
const T = require('../jobDist/text');
const Track = require('../jobDist/tracker');
const Svc = require('../jobDist/service');
const G = require('../jobDist/googleIndexing');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);
router.use(requireProduct('ats'));
router.use(async (req, res, next) => {
  if (access.isClientLogin(req.user)) return res.status(403).json({ error: 'This is internal to TeamLink.' });
  if (!(await Plat.ready())) return res.status(503).json({ error: Plat.NOT_READY, code: 'NOT_MIGRATED' });
  return next();
});

const hits = new Map();
function limit(req, res, next) {
  const k = req.user.id; const now = Date.now();
  const list = (hits.get(k) || []).filter((t) => now - t < 60000);
  if (list.length >= 60) return res.status(429).json({ error: 'Too many requests. Wait a minute and try again.', code: 'RATE_LIMIT' });
  list.push(now); hits.set(k, list);
  return next();
}
const wrap = (fn) => async (req, res, next) => { try { await fn(req, res, next); } catch (e) { next(e); } };
const baseOf = (req) => String(process.env.APP_BASE_URL || '').replace(/\/+$/, '') || `${req.protocol}://${req.get('host')}`.replace(':4010', ':5183').replace(':4011', ':5184');
const needAdmin = async (req, res) => { if (await access.isCredentialAdmin(req.user)) return true; res.status(403).json({ error: 'Only a Super Admin or an Admin can do this.' }); return false; };

// the job, and what this login may do with it
async function jobFor(req, res, { post = false } = {}) {
  const job = await prisma.requirement.findUnique({ where: { id: req.params.id } });
  if (!job) { res.status(404).json({ error: 'Requirement not found' }); return null; }
  if (!(await access.mayViewJob(req.user, job))) { res.status(403).json({ error: 'This requirement is not in your area.' }); return null; }
  if (post && !(await access.mayPost(req.user, job))) {
    res.status(403).json({ error: 'Posting requirements is done by your team lead or the client manager. You can read this page.', code: 'POSTING_NOT_YOURS' }); return null;
  }
  return job;
}
async function platformFor(req, res) {
  const p = await Plat.get(req.params.key);
  if (!p) { res.status(404).json({ error: 'This place is not in the list.' }); return null; }
  return p;
}

// ---- one job
router.get('/jobs/:id', wrap(async (req, res) => {
  const job = await jobFor(req, res); if (!job) return undefined;
  Track.maybeSweep();
  return res.json(await Svc.distribute(req.user, job, baseOf(req)));
}));
router.get('/jobs/:id/platforms/:key/text', wrap(async (req, res) => {
  const job = await jobFor(req, res); if (!job) return undefined;
  const p = await platformFor(req, res); if (!p) return undefined;
  const out = await T.forPlatform(job.id, p.key, { base: baseOf(req) });
  const { job: _j, platform: _p, ...kit } = out; // eslint-disable-line no-unused-vars
  return res.json({ kit });
}));
router.put('/jobs/:id/platforms/:key/text', limit, wrap(async (req, res) => {
  const job = await jobFor(req, res, { post: true }); if (!job) return undefined;
  const p = await platformFor(req, res); if (!p) return undefined;
  const out = await Svc.saveText(req.user, job, p.key, req.body, baseOf(req));
  if (out.error) return res.status(out.status || 400).json({ error: out.error });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Posting kit text saved', entity: 'JobDistribution', entityId: job.id, fromValue: p.name, toValue: `${out.kit.chars} characters` });
  return res.json({ ok: 'Saved. This text is kept for this requirement.', kit: out.kit });
}));
router.delete('/jobs/:id/platforms/:key/text', limit, wrap(async (req, res) => {
  const job = await jobFor(req, res, { post: true }); if (!job) return undefined;
  const p = await platformFor(req, res); if (!p) return undefined;
  const out = await Svc.saveText(req.user, job, p.key, { text: '' }, baseOf(req));
  if (out.error) return res.status(out.status || 400).json({ error: out.error });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Posting kit text reset', entity: 'JobDistribution', entityId: job.id, fromValue: p.name, toValue: 'Back to the text TeamLink wrote' });
  return res.json({ ok: 'Back to the text TeamLink wrote.', kit: out.kit });
}));

router.post('/jobs/:id/platforms/:key/posted', limit, wrap(async (req, res) => {
  const job = await jobFor(req, res, { post: true }); if (!job) return undefined;
  const p = await platformFor(req, res); if (!p) return undefined;
  const body = { ...(req.body || {}) };
  // keep the text that was posted, for the record
  if (body.keepText) { const kit = await T.forPlatform(job.id, p.key, { base: baseOf(req) }); body.text = kit && kit.text; }
  const out = await Track.markPosted(req.user, job, p, body);
  if (out.error) return res.status(out.status || 400).json({ error: out.error });
  return res.json({ ok: `Saved. Marked as posted on ${p.name}.`, posting: out.posting });
}));
router.post('/jobs/:id/platforms/:key/taken-down', limit, wrap(async (req, res) => {
  const job = await jobFor(req, res, { post: true }); if (!job) return undefined;
  const p = await platformFor(req, res); if (!p) return undefined;
  const out = await Track.markTakenDown(req.user, job, p);
  if (out.error) return res.status(out.status || 400).json({ error: out.error });
  return res.json({ ok: `Saved. Taken down from ${p.name}.`, posting: out.posting });
}));
router.delete('/jobs/:id/platforms/:key/posted', limit, wrap(async (req, res) => {
  const job = await jobFor(req, res, { post: true }); if (!job) return undefined;
  const p = await platformFor(req, res); if (!p) return undefined;
  const out = await Track.undo(req.user, job, p);
  return res.json({ ok: `Done. ${p.name} reads Not posted again.`, ...out });
}));
router.get('/jobs/:id/sources', wrap(async (req, res) => {
  const job = await jobFor(req, res); if (!job) return undefined;
  return res.json({ sources: await Svc.jobSources(job) });
}));

// ---- the Posting tracker
router.get('/tracker', wrap(async (req, res) => {
  Track.maybeSweep();
  const ids = await access.scopedIds(req.user);
  return res.json(await Track.tracker(req.user, { status: req.query.status, platform: req.query.platform, q: req.query.q, limit: req.query.limit }, ids));
}));
router.post('/sweep', limit, wrap(async (req, res) => {
  if (!(await needAdmin(req, res))) return undefined;
  return res.json(await Track.sweep());
}));

// ---- places and settings
router.get('/platforms', wrap(async (req, res) => {
  const admin = await access.isCredentialAdmin(req.user);
  return res.json({ platforms: await Plat.list({ all: admin && req.query.all === '1' }), canEdit: admin, settings: await Track.settings() });
}));
router.post('/platforms', limit, wrap(async (req, res) => {
  if (!(await needAdmin(req, res))) return undefined;
  const out = await Plat.save(null, req.body, req.user, { create: true });
  if (out.error) return res.status(out.status || 400).json({ error: out.error });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Posting place added', entity: 'JobDistribution', entityId: out.platform.key, toValue: out.platform.name });
  return res.status(201).json({ ok: 'Saved. The place is in the list.', platform: out.platform });
}));
router.put('/platforms/:key', limit, wrap(async (req, res) => {
  if (!(await needAdmin(req, res))) return undefined;
  const out = await Plat.save(req.params.key, req.body, req.user);
  if (out.error) return res.status(out.status || 400).json({ error: out.error });
  require('../jobDist/attribution').forget(); // eslint-disable-line global-require
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Posting place changed', entity: 'JobDistribution', entityId: out.platform.key, toValue: JSON.stringify(req.body || {}).slice(0, 300) });
  return res.json({ ok: 'Saved.', platform: out.platform });
}));
router.post('/platforms/:key/reset', limit, wrap(async (req, res) => {
  if (!(await needAdmin(req, res))) return undefined;
  const out = await Plat.reset(req.params.key, req.user);
  if (out.error) return res.status(out.status || 400).json({ error: out.error });
  require('../jobDist/attribution').forget(); // eslint-disable-line global-require
  return res.json({ ok: 'Back to the default settings.', platform: out.platform });
}));
router.delete('/platforms/:key', limit, wrap(async (req, res) => {
  if (!(await needAdmin(req, res))) return undefined;
  const out = await Plat.remove(req.params.key);
  if (out.error) return res.status(out.status || 400).json({ error: out.error });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Posting place deleted', entity: 'JobDistribution', entityId: req.params.key, toValue: '' });
  return res.json({ ok: 'Deleted.' });
}));
router.get('/settings', wrap(async (req, res) => res.json({ settings: await Track.settings(), canEdit: await access.isCredentialAdmin(req.user) })));
router.put('/settings', limit, wrap(async (req, res) => {
  if (!(await needAdmin(req, res))) return undefined;
  const out = await Track.saveSettings(req.body, req.user);
  return out.error ? res.status(out.status || 400).json({ error: out.error }) : res.json({ ok: 'Saved.', ...out });
}));

// ---- Google Indexing API (optional, OFF by default; Admin only)
router.get('/google-indexing', wrap(async (req, res) => {
  if (!(await needAdmin(req, res))) return undefined;
  return res.json(await G.status());
}));
router.put('/google-indexing', limit, wrap(async (req, res) => {
  if (!(await needAdmin(req, res))) return undefined;
  const b = req.body || {};
  let out = null;
  if (b.key !== undefined && String(b.key).trim()) { out = await G.saveKey(b.key, req.user); if (out.error) return res.status(out.status || 400).json({ error: out.error }); }
  if (b.enabled !== undefined) { out = await G.setEnabled(!!b.enabled, req.user); if (out.error) return res.status(out.status || 400).json({ error: out.error }); }
  return res.json({ ok: 'Saved.', ...(out || { status: await G.status() }) });
}));
router.delete('/google-indexing', limit, wrap(async (req, res) => {
  if (!(await needAdmin(req, res))) return undefined;
  return res.json({ ok: 'The key was removed.', ...(await G.removeKey(req.user)) });
}));
router.post('/jobs/:id/google-indexing', limit, wrap(async (req, res) => {
  const job = await jobFor(req, res, { post: true }); if (!job) return undefined;
  const url = `${baseOf(req)}${require('../utils/jobSlug').careersPath(job)}`; // eslint-disable-line global-require
  const out = await G.notify(url, req.body && req.body.type === 'URL_DELETED' ? 'URL_DELETED' : 'URL_UPDATED');
  if (!out.ok) return res.status(out.refused ? 409 : 502).json({ error: out.error });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Google told about a requirement page', entity: 'JobDistribution', entityId: job.id, toValue: url });
  return res.json({ ok: 'Google was told about this requirement page.' });
}));

module.exports = router;
