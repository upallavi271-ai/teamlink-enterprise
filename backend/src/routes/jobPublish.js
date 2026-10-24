// ---------------------------------------------------------------------------
// /api/job-publish : publish one job to many portals (Naukri, Foundit, Shine, LinkedIn, Career page).
// Contract with examples: docs/job-publishing/API.md. The old endpoints (posting-sites, by-hand, Indeed feed ...) are untouched.
// Nothing here posts by itself: a request QUEUES work; the worker (npm run posting-worker) does it.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth, requireProduct } = require('../middleware/auth');
const { supported, NOT_READY, q1, json } = require('../jobPublish/db');
const svc = require('../jobPublish/service');
const access = require('../jobPublish/access');
const Q = require('../jobPublish/queue');
const L = require('../jobPublish/logs');
const S = require('../jobPublish/settings');
const Cred = require('../jobPublish/credentials');
const Maps = require('../jobPublish/mappings');
const C = require('../jobPublish/constants');
const shots = require('../playwright/screenshot');
const Diag = require('../jobPublish/diagnostics');
const OTP = require('../jobPublish/otpBridge');

const router = express.Router();
router.use(requireAuth);
router.use(requireProduct('ats'));
router.use(async (req, res, next) => {
  if (access.isClientLogin(req.user)) return res.status(403).json({ error: 'This is internal to TeamLink.' });
  if (req.path === '/health') return next();
  if (!(await supported())) return res.status(503).json({ error: NOT_READY, code: 'NOT_MIGRATED' });
  return next();
});

// a small rate limit on the commands (per login): 40 a minute
const hits = new Map();
function limit(req, res, next) {
  const k = req.user.id; const now = Date.now();
  const list = (hits.get(k) || []).filter((t) => now - t < 60000);
  if (list.length >= 40) return res.status(429).json({ error: 'Too many requests. Wait a minute and try again.', code: 'RATE_LIMIT' });
  list.push(now); hits.set(k, list);
  return next();
}
const wrap = (fn) => async (req, res, next) => { try { await fn(req, res, next); } catch (e) { next(e); } };
const send = (res, out) => (out.error ? res.status(out.status || 400).json({ error: out.error, code: out.code || undefined }) : res.status(out.results && out.queued ? 202 : 200).json(out));
const portalsOf = (b) => (Array.isArray(b && b.portals) ? b.portals.map(String) : (b && b.portal ? [String(b.portal)] : []));
const opts = (req) => ({
  dryRun: !!(req.body && req.body.dryRun), scheduledFor: req.body && req.body.scheduledFor ? req.body.scheduledFor : null,
  idempotencyKey: req.get('Idempotency-Key') || (req.body && req.body.idempotencyKey) || null,
});
const needAdmin = async (req, res) => { if (await access.isCredentialAdmin(req.user)) return true; res.status(403).json({ error: 'Only a Super Admin or an Admin can do this.' }); return false; };

// ---- commands
router.post('/jobs/:id/publish', limit, wrap(async (req, res) => send(res, await svc.publish(req.user, req.params.id, portalsOf(req.body), opts(req)))));
router.post('/jobs/:id/republish', limit, wrap(async (req, res) => send(res, await svc.republish(req.user, req.params.id, portalsOf(req.body), opts(req)))));
router.post('/jobs/:id/unpublish', limit, wrap(async (req, res) => send(res, await svc.unpublish(req.user, req.params.id, portalsOf(req.body), opts(req)))));
router.post('/jobs/:id/update', limit, wrap(async (req, res) => send(res, await svc.update(req.user, req.params.id, portalsOf(req.body), opts(req)))));
router.post('/publish-bulk', limit, wrap(async (req, res) => {
  const b = req.body || {};
  const out = await svc.bulk(req.user, b.jobIds, portalsOf(b), { ...opts(req), action: ['PUBLISH', 'REPUBLISH', 'UNPUBLISH'].includes(b.action) ? b.action : 'PUBLISH' });
  return out.error ? res.status(out.status || 400).json({ error: out.error }) : res.status(202).json(out);
}));
router.put('/jobs/:id/portals/:portal/schedule', limit, wrap(async (req, res) => send(res, await svc.setSchedule(req.user, req.params.id, req.params.portal, req.body || {}))));

// ---- status of one job
router.get('/jobs/:id/status', wrap(async (req, res) => {
  const r = await prisma.requirement.findUnique({ where: { id: req.params.id } });
  if (!r) return res.status(404).json({ error: 'Requirement not found' });
  if (!(await access.mayViewStatus(req.user, r))) return res.status(403).json({ error: 'This requirement is not in your area.' });
  return res.json(await svc.jobStatus(req.user, r));
}));

// ---- queue
for (const kind of ['retry', 'cancel', 'discard']) {
  router.post(`/queue/:id/${kind}`, limit, wrap(async (req, res) => {
    const out = await svc.command(req.user, req.params.id, kind);
    return out.error ? res.status(out.status || 400).json({ error: out.error, code: out.code }) : res.json(out);
  }));
}
router.get('/queue', wrap(async (req, res) => {
  if (!access.mayViewLogs(req.user)) return res.status(403).json({ error: 'The queue is for team leads, client managers and Admins.' });
  const ids = await access.scopedIds(req.user);
  const f = { ...req.query, requirementId: req.query.job || req.query.requirementId };
  if (ids) f.requirementIds = ids;
  return res.json(await Q.list(f));
}));
router.get('/dead-letters', wrap(async (req, res) => {
  if (!access.mayViewLogs(req.user)) return res.status(403).json({ error: 'The queue is for team leads, client managers and Admins.' });
  const ids = await access.scopedIds(req.user);
  return res.json(await Q.list({ status: 'DEAD', page: req.query.page, pageSize: req.query.pageSize, ...(ids ? { requirementIds: ids } : {}) }));
}));

// ---- logs (never a secret; no Recruiter)
router.get('/logs', wrap(async (req, res) => {
  if (!access.mayViewLogs(req.user)) return res.status(403).json({ error: 'The logs are for team leads, client managers and Admins.' });
  const ids = await access.scopedIds(req.user);
  const f = { queueId: req.query.queue, requirementId: req.query.job, portal: req.query.portal, level: req.query.level, from: Number(req.query.from) || undefined, to: Number(req.query.to) || undefined, page: req.query.page, pageSize: req.query.pageSize };
  if (ids) f.requirementIds = ids;
  return res.json(await L.list(f));
}));
router.get('/logs/:id/screenshot', wrap(async (req, res) => {
  if (!access.mayViewLogs(req.user)) return res.status(403).json({ error: 'Not allowed.' });
  const row = await q1('SELECT * FROM "PostingLog" WHERE "id" = ?', req.params.id);
  if (!row || !row.screenshotPath) return res.status(404).json({ error: 'No screenshot.' });
  if (row.requirementId) {
    const r = await prisma.requirement.findUnique({ where: { id: row.requirementId } });
    if (!r || !access.inScope(req.user, r)) return res.status(403).json({ error: 'This requirement is not in your area.' });
  } else if (!(await access.isCredentialAdmin(req.user))) return res.status(403).json({ error: 'Only an Admin can see this.' });
  const file = shots.resolve(row.screenshotPath);
  if (!file) return res.status(404).json({ error: 'The file is gone.' });
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  // a page-structure snapshot is plain text (never served as HTML)
  if (shots.kindOfPath(row.screenshotPath) === 'structure') return res.type('text/plain; charset=utf-8').sendFile(file);
  return res.type('image/png').sendFile(file);
}));

// ---- dashboard, portals, health
router.get('/dashboard', wrap(async (req, res) => res.json(await svc.dashboard(req.user))));
router.get('/portals', wrap(async (req, res) => res.json(await svc.portalsOverview(req.user))));
router.get('/health', wrap(async (req, res) => {
  const ready = await supported();
  const worker = ready ? await S.workerState() : { running: false };
  const counts = ready ? await Q.counts() : null;
  const kill = ready ? await S.killState(null) : {};
  return res.json({ ok: ready, migrated: ready, worker, queue: counts, killAll: !!kill.killedAll, paused: !!kill.paused, hint: worker.running ? null : 'The worker is not running. Start it with: npm run posting-worker' });
}));

// ---- mappings
router.get('/mappings', wrap(async (req, res) => {
  if (!access.mayViewLogs(req.user) && !(await access.isCredentialAdmin(req.user))) return res.status(403).json({ error: 'Not allowed.' });
  await Maps.ensureDefaults();
  return res.json({ fields: Maps.FIELDS, rows: await Maps.list({ portal: req.query.portal, field: req.query.field }) });
}));
router.put('/mappings', limit, wrap(async (req, res) => {
  if (!(await needAdmin(req, res))) return undefined;
  const out = await Maps.upsertMany(req.body && req.body.rows, req.user);
  return out.error ? res.status(out.status || 400).json({ error: out.error }) : res.json(out);
}));

// ---- credentials (Admin / Super Admin only; no secret is ever in an answer)
router.get('/credentials', wrap(async (req, res) => { if (!(await needAdmin(req, res))) return undefined; return res.json({ credentials: await Cred.list() }); }));
// A person who may post (TL, BDE, BDE TL) sees only whether a login is saved and how the last check went: no username, no secret.
router.get('/credentials/:portal/status', wrap(async (req, res) => {
  if (!C.PORTALS[req.params.portal]) return res.status(404).json({ error: 'Unknown portal' });
  if (!(await access.isCredentialAdmin(req.user)) && !(await access.isPoster(req.user))) return res.status(403).json({ error: 'Only the people who post requirements can see this.' });
  return res.json({ credential: await Cred.posterView(req.params.portal), worker: await S.workerState() });
}));
// SAVE: an Admin / Super Admin may save or replace the login any time. A person who may post may save the FIRST login only
// (user rule 2026-10-13: poster = create + test; Admin = view status / replace / delete). Their body is cut to username + password
// (+ optional secret), so they can never switch posting on or change limits from here.
router.put('/credentials/:portal', limit, wrap(async (req, res) => {
  const admin = await access.isCredentialAdmin(req.user);
  let body = req.body;
  if (!admin) {
    if (!(await access.isPoster(req.user))) return res.status(403).json({ error: 'Only a Super Admin or an Admin can do this.' });
    if (!C.PORTALS[req.params.portal]) return res.status(404).json({ error: 'Unknown portal' });
    const have = await Cred.posterView(req.params.portal);
    if (have.hasLogin) return res.status(403).json({ error: 'A login is already saved for this site. Only an Admin can change it.', code: 'LOGIN_EXISTS' });
    const b = req.body || {};
    body = { username: b.username, password: b.password, secret: b.secret };
    if (!String(body.username || '').trim() || !String(body.password || '').trim()) return res.status(400).json({ error: 'Type the username and the password.' });
  }
  const out = await Cred.save(req.params.portal, body, req.user);
  return out.error ? res.status(out.status || 400).json({ error: out.error, problems: out.problems, warnings: out.warnings }) : res.json(admin ? out : { ok: true, credential: await Cred.posterView(req.params.portal), warnings: out.warnings });
}));
router.post('/credentials/:portal/verify', limit, wrap(async (req, res) => {
  if (!(await access.isCredentialAdmin(req.user)) && !(await access.isPoster(req.user))) return res.status(403).json({ error: 'Only a Super Admin or an Admin can do this.' });
  const out = await Cred.requestVerify(req.params.portal, req.user);
  return out.error ? res.status(out.status || 400).json({ error: out.error }) : res.status(out.inline ? 200 : 202).json(out);
}));
// Telegram / Facebook: ONE real test message to the channel (a separate, explicit button; only while the channel is switched ON).
router.post('/credentials/:portal/test-post', limit, wrap(async (req, res) => {
  if (!(await access.isCredentialAdmin(req.user)) && !(await access.isPoster(req.user))) return res.status(403).json({ error: 'Only the people who post requirements can do this.' });
  const out = await Cred.sendTestPost(req.params.portal, req.user);
  return out.error ? res.status(out.status || 400).json({ error: out.error }) : res.json(out);
}));
router.post('/credentials/:portal/switch', limit, wrap(async (req, res) => {
  if (!(await needAdmin(req, res))) return undefined;
  const out = await Cred.setEnabled(req.params.portal, !!(req.body && req.body.enabled), req.user);
  return out.error ? res.status(out.status || 400).json({ error: out.error }) : res.json(out);
}));
router.delete('/credentials/:portal', limit, wrap(async (req, res) => {
  if (!(await needAdmin(req, res))) return undefined;
  const out = await Cred.remove(req.params.portal, req.user);
  return out.error ? res.status(out.status || 400).json({ error: out.error }) : res.json(out);
}));

// ---- kill switch, pause, limits, resume after a person signed in (Admin only)
router.put('/switches', limit, wrap(async (req, res) => {
  if (!(await needAdmin(req, res))) return undefined;
  const b = req.body || {};
  if (b.pauseAll !== undefined) { await S.setPause(!!b.pauseAll, req.user); await svc.audit(req.user, `Pause all ${b.pauseAll ? 'ON' : 'OFF'}`, null, null, ''); }
  if (b.killAll !== undefined) { await S.setKill(null, !!b.killAll, b.reason, req.user); await svc.audit(req.user, `Kill switch (all) ${b.killAll ? 'ON' : 'OFF'}`, null, null, b.reason || ''); }
  if (b.portal && b.kill !== undefined) {
    if (!C.PORTALS[b.portal]) return res.status(400).json({ error: 'Unknown portal' });
    await S.setKill(b.portal, !!b.kill, b.reason, req.user); await svc.audit(req.user, `Kill switch ${b.kill ? 'ON' : 'OFF'}`, null, b.portal, b.reason || '');
  }
  const k = await S.killState(null);
  return res.json({ killAll: k.killedAll, paused: k.paused });
}));
router.put('/portals/:portal/limits', limit, wrap(async (req, res) => {
  if (!(await needAdmin(req, res))) return undefined;
  const p = req.params.portal === 'all' ? null : req.params.portal;
  if (p && !C.PORTALS[p]) return res.status(404).json({ error: 'Unknown portal' });
  const limits = await S.setLimits(p, req.body || {}, req.user);
  await svc.audit(req.user, 'Posting limits changed', null, p, JSON.stringify(req.body || {}).slice(0, 200));
  return res.json({ limits });
}));
router.post('/portals/:portal/resume', limit, wrap(async (req, res) => {
  if (!(await needAdmin(req, res))) return undefined;
  if (!C.PORTALS[req.params.portal]) return res.status(404).json({ error: 'Unknown portal' });
  await S.clearHumanHold(req.params.portal);
  await svc.audit(req.user, 'Portal resumed after a person signed in', null, req.params.portal, '');
  return res.json({ ok: true });
}));

// ---- OTP: a PERSON types the one-time code the site sent to them. It goes straight to the waiting run (memory only):
// never stored, never logged, never in an answer. Same people as Retry (post rights on the job; an Admin for a login check).
const otpTries = new Map();
router.post('/queue/:id/otp', limit, wrap(async (req, res) => {
  const row = await Q.byId(req.params.id);
  if (!row) return res.status(404).json({ error: 'No such queue entry' });
  if (row.requirementId) {
    const r = await prisma.requirement.findUnique({ where: { id: row.requirementId } });
    if (!r || !access.inScope(req.user, r)) return res.status(403).json({ error: 'This requirement is not in your area.' });
    if (!(await access.mayPost(req.user, r))) return res.status(403).json({ error: 'Posting requirements is done by your team lead or the client manager.', code: 'POSTING_NOT_YOURS' });
  } else if (!(await access.isCredentialAdmin(req.user)) && !(await access.isPoster(req.user))) return res.status(403).json({ error: 'Only the people who post requirements can do this.' });
  const waiting = json(row.resultJson, {}) && json(row.resultJson, {}).waiting;
  if (row.status !== 'RUNNING' || !waiting || waiting.kind !== 'OTP') return res.status(409).json({ error: 'It is not waiting for a code right now. The code box only works while the site is asking.', code: 'NOT_WAITING' });
  const code = String((req.body && req.body.code) || '').trim();
  if (!OTP.validCode(code)) return res.status(400).json({ error: 'Type the code exactly as it was sent: 4 to 10 letters or digits, no spaces.', code: 'BAD_FORMAT' });
  const n = (otpTries.get(row.id) || 0) + 1;
  if (n > 3) return res.status(429).json({ error: 'The code was typed too many times for this requirement. Start the check again.', code: 'TOO_MANY' });
  otpTries.set(row.id, n);
  if (otpTries.size > 500) otpTries.delete(otpTries.keys().next().value);
  const out = await OTP.deliver(row.id, waiting.port, code);
  await svc.audit(req.user, out.ok ? 'OTP typed by a person' : 'OTP could not be delivered', row.requirementId, row.portal, `queue ${row.id}${out.ok ? '' : `: ${out.why}`}`); // never the code
  if (!out.ok) {
    const words = { NOT_WAITING: 'It stopped waiting just now.', UNREACHABLE: 'The posting helper could not be reached from here (it must run on the same computer as TeamLink). Sign in yourself with the portal session command instead.', BAD_FORMAT: 'That code does not look right.', BAD_SIGNATURE: 'The posting helper refused the code.', NO_SECRET: 'The server has no secret key, so the code cannot be handed over.' }[out.why] || 'The code could not be handed over.';
    return res.status(out.why === 'NOT_WAITING' ? 409 : 502).json({ error: words, code: out.why });
  }
  return res.json({ ok: true, message: 'The code was handed to the posting helper.' });
}));

// ---- diagnostics (Health screens): team leads / client managers / Admins; login details only for an Admin
router.get('/diagnostics', wrap(async (req, res) => {
  if (!access.mayViewLogs(req.user) && !(await access.isCredentialAdmin(req.user))) return res.status(403).json({ error: 'The health screen is for team leads, client managers and Admins.' });
  return res.json(await Diag.overview(req.user, { days: req.query.days }));
}));
router.get('/diagnostics/attempts/:id', wrap(async (req, res) => {
  if (!access.mayViewLogs(req.user) && !(await access.isCredentialAdmin(req.user))) return res.status(403).json({ error: 'Not allowed.' });
  const out = await Diag.attempt(req.user, req.params.id);
  return out.error ? res.status(out.status || 400).json({ error: out.error }) : res.json(out);
}));
router.put('/diagnostics/retention', limit, wrap(async (req, res) => {
  if (!(await needAdmin(req, res))) return undefined;
  const out = await Diag.setRetention(req.user, req.body && req.body.days);
  if (out.error) return res.status(out.status || 400).json({ error: out.error });
  await svc.audit(req.user, 'Picture retention changed', null, null, `${out.days} days`);
  return res.json(out);
}));
router.post('/diagnostics/sweep', limit, wrap(async (req, res) => {
  if (!(await needAdmin(req, res))) return undefined;
  const out = await Diag.sweepPictures({ force: true });
  await svc.audit(req.user, 'Old pictures cleaned', null, null, `${out.removed} removed (older than ${out.days} days)`);
  return res.json(out);
}));

module.exports = router;
