// ---------------------------------------------------------------------------
// /api/messaging — channel status and BULK SEND (utils/bulkMessaging.js).
//
//   GET  /channels               Email / SMS / WhatsApp: configured? why not?
//   POST /bulk                   { audience: candidates|clients|employees, ids,
//                                  channels, purpose, subject, body } -> 202 job
//   GET  /bulk                   my recent jobs (all jobs for SA / Admin)
//   GET  /bulk/:id               progress + per-recipient status
//   GET  /bulk/:id/report.csv    the downloadable result report
//   POST /bulk/:id/cancel        stop sending what has not gone yet
//
// Who may send to whom is decided in bulkMessaging.mayBulkSend() + the scope
// helpers — the ids a browser sends are only a request.
// ---------------------------------------------------------------------------

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const messaging = require('../utils/messaging');
const bulk = require('../utils/bulkMessaging');
const { scopeOf } = require('../utils/scope');

const router = express.Router();
router.use(requireAuth);

const external = (u) => ['CLIENT', 'CANDIDATE'].includes(u.role) || ['CLIENT', 'CANDIDATE'].includes(u.atsRole);

router.get('/channels', async (req, res) => {
  if (external(req.user)) return res.status(403).json({ error: 'Not available to this login' });
  const status = await messaging.channelStatus();
  const audiences = {};
  // eslint-disable-next-line no-restricted-syntax
  for (const a of bulk.AUDIENCES) {
    // eslint-disable-next-line no-await-in-loop
    audiences[a] = await bulk.mayBulkSend(req.user, a);
  }
  res.json({ channels: status, audiences, limit: bulk.LIMIT });
});

router.post('/bulk', async (req, res, next) => {
  try {
    const out = await bulk.createJob(req.user, req.body || {});
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    return res.status(202).json(out.job);
  } catch (err) { return next(err); }
});

router.get('/bulk', (req, res) => {
  const global = scopeOf(req.user).global;
  const jobs = bulk.listJobs()
    .filter((j) => global || (j.createdBy && j.createdBy.id === req.user.id))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 30)
    .map((j) => bulk.summary(j));
  res.json(jobs);
});

function loadVisible(req, res) {
  const job = bulk.readJob(req.params.id);
  if (!job) { res.status(404).json({ error: 'No such bulk send' }); return null; }
  if (!bulk.canSee(req.user, job)) { res.status(403).json({ error: 'Only the sender or an Admin can see this bulk send' }); return null; }
  return job;
}

router.get('/bulk/:id', (req, res) => {
  const job = loadVisible(req, res);
  if (!job) return undefined;
  return res.json(bulk.summary(job, { withRecipients: true }));
});

router.get('/bulk/:id/report.csv', (req, res) => {
  const job = loadVisible(req, res);
  if (!job) return undefined;
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="bulk-send-${job.id}.csv"`);
  return res.send(`﻿${bulk.reportCsv(job)}`);
});

router.post('/bulk/:id/cancel', (req, res) => {
  const job = loadVisible(req, res);
  if (!job) return undefined;
  const out = bulk.cancelJob(job.id);
  return res.json(bulk.summary(out || job));
});

router.post('/bulk/:id/retry-failed', async (req, res, next) => {
  try {
    const job = loadVisible(req, res);
    if (!job) return undefined;
    const out = await bulk.retryFailed(job.id, req.user);
    if (out.error) return res.status(409).json({ error: out.error });
    return res.json({ ...bulk.summary(out.job), retried: out.retried });
  } catch (err) { return next(err); }
});

// The worker starts with the router (the API process), polling every second.
bulk.start();

module.exports = router;
