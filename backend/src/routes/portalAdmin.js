// ---------------------------------------------------------------------------
// /api/portal-admin — the Job Portal's own Integrations settings, managed from TeamLink
// Administration -> Integrations -> "Job Portal settings" (founder, 2026-10-29).
//
// The settings live in the Job Portal and are used by it; TeamLink stores nothing. Each call goes server to server
// through the portal bridge (job-portal-app/embed/teamlink-integration.mjs, JOB_PORTAL_SYNC_TOKEN), which runs the
// portal's own routes unchanged. Only these administrator endpoints are reachable from here:
//
//   Job sites (portal "Integrations": Naukri / Shine / Indeed by authorized API or feed; routes/job-publishing.js)
//     GET  /job-sites                 PUT /job-sites/:dest            POST /job-sites/:dest/test
//     POST /job-sites/:dest/publish-pending                          GET  /job-sites/:dest/events
//   Notifications (the portal's Email (SMTP), SMS and WhatsApp; routes/integration-channels.js)
//     GET  /channels                  PUT /channels/:ch               POST /channels/:ch/connect | disconnect | test
//     GET  /channels/:ch/events
//   AI screening (portal "AI Settings": the standard screening questions; routes/screening.js)
//     GET  /screening                 PUT /screening
//
// No response carries a credential: the portal answers "saved" and at most the last four characters.
// Super Admin and Admin (Integrations: view to read, configure to change). Every change is in TeamLink's audit log
// (what changed, never a value).
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requirePerm } = require('../utils/permissions');
const { logAudit } = require('../utils/audit');
const { portalFetch } = require('../utils/jobPortalBridge');

const router = express.Router();
router.use(requireAuth);

const view = requirePerm(null, 'administration', 'Integrations', 'view');
const change = requirePerm(null, 'administration', 'Integrations', 'configure');
const T = '/integrations/teamlink';
const DEST = /^[A-Za-z0-9_]{1,40}$/;
const CHANNELS = ['email', 'sms', 'whatsapp'];

// The portal's answer, passed on as it is (its words, its field errors); "not running / not set up" said plainly.
function send(res, err) {
  if (err && err.status && err.portalError) return res.status(err.status).json({ error: err.portalError });
  const message = err && err.notConfigured
    ? `The Job Portal is not linked to TeamLink on this server (${err.message}).`
    : `The Job Portal could not be reached: ${(err && err.message) || 'no answer'}.`;
  return res.status(err && err.notConfigured ? 503 : 502).json({ error: { code: 'PORTAL_UNAVAILABLE', message } });
}
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => send(res, err));
const bad = (res, message) => res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
const audit = (req, action, entityId, toValue) => logAudit({
  userId: req.user.id, action, entity: 'PortalSetting', entityId, toValue,
});
const dest = (req) => (DEST.test(String(req.params.dest || '')) ? String(req.params.dest) : null);
const channel = (req) => (CHANNELS.includes(String(req.params.ch || '').toLowerCase()) ? String(req.params.ch).toLowerCase() : null);
// which secret fields a body sets or clears - for the audit, never their values
const secretNames = (obj) => Object.keys((obj && typeof obj === 'object') ? obj : {}).filter((k) => obj[k] !== '' && obj[k] != null);

/* ---- Job sites ---- */
router.get('/job-sites', view, wrap(async (req, res) => {
  res.json(await portalFetch(`${T}/job-sites/admin/integrations`, { timeoutMs: 20000 }));
}));
router.get('/job-sites/:dest/events', view, wrap(async (req, res) => {
  const d = dest(req); if (!d) return bad(res, 'Unknown job site.');
  return res.json(await portalFetch(`${T}/job-sites/admin/integrations/${d}/events`, { timeoutMs: 20000 }));
}));
router.put('/job-sites/:dest', change, wrap(async (req, res) => {
  const d = dest(req); if (!d) return bad(res, 'Unknown job site.');
  const b = req.body || {};
  const out = await portalFetch(`${T}/job-sites/admin/integrations/${d}`, { method: 'PUT', body: b, timeoutMs: 30000 });
  const secrets = secretNames(b.secrets);
  await audit(req, 'Job Portal job site saved', d, [b.enabled ? 'on' : 'off', b.connectionType || '',
    secrets.length ? `secrets set: ${secrets.join(', ')}` : '', (b.clearSecrets || []).length ? `cleared: ${b.clearSecrets.join(', ')}` : '']
    .filter(Boolean).join(' · '));
  return res.json(out);
}));
router.post('/job-sites/:dest/test', change, wrap(async (req, res) => {
  const d = dest(req); if (!d) return bad(res, 'Unknown job site.');
  return res.json(await portalFetch(`${T}/job-sites/admin/integrations/${d}/test`, { method: 'POST', body: {}, timeoutMs: 60000 }));
}));
router.post('/job-sites/:dest/publish-pending', change, wrap(async (req, res) => {
  const d = dest(req); if (!d) return bad(res, 'Unknown job site.');
  const out = await portalFetch(`${T}/job-sites/admin/integrations/${d}/publish-pending`, { method: 'POST', body: {}, timeoutMs: 180000 });
  await audit(req, 'Job Portal waiting jobs published', d, `${out.queued || 0} queued`);
  return res.json(out);
}));

/* ---- Notifications: Email (SMTP), SMS, WhatsApp ---- */
router.get('/channels', view, wrap(async (req, res) => {
  res.json(await portalFetch(`${T}/channels/admin/integration-channels`, { timeoutMs: 20000 }));
}));
router.get('/channels/:ch/events', view, wrap(async (req, res) => {
  const ch = channel(req); if (!ch) return bad(res, 'Unknown channel.');
  return res.json(await portalFetch(`${T}/channels/admin/integration-channels/${ch}/events`, { timeoutMs: 20000 }));
}));
router.put('/channels/:ch', change, wrap(async (req, res) => {
  const ch = channel(req); if (!ch) return bad(res, 'Unknown channel.');
  const b = req.body || {};
  const body = { config: b.config || {}, secrets: b.secrets || {}, connect: b.connect !== false };
  const out = await portalFetch(`${T}/channels/admin/integration-channels/${ch}`, { method: 'PUT', body, timeoutMs: 60000 });
  const secrets = secretNames(body.secrets);
  await audit(req, 'Job Portal channel saved', ch, secrets.length ? `secret ${body.secrets[secrets[0]] === '-' ? 'cleared' : 'set'}` : 'settings');
  return res.json(out);
}));
router.post('/channels/:ch/:act(connect|disconnect)', change, wrap(async (req, res) => {
  const ch = channel(req); if (!ch) return bad(res, 'Unknown channel.');
  const out = await portalFetch(`${T}/channels/admin/integration-channels/${ch}/${req.params.act}`, { method: 'POST', body: {}, timeoutMs: 60000 });
  await audit(req, `Job Portal channel ${req.params.act === 'connect' ? 'connected' : 'disconnected'}`, ch);
  return res.json(out);
}));
router.post('/channels/:ch/test', change, wrap(async (req, res) => {
  const ch = channel(req); if (!ch) return bad(res, 'Unknown channel.');
  // the portal's own default (the signed-in portal user's address) has no user here: default to this person's email
  let to = String((req.body && req.body.to) || '').trim();
  if (!to && ch === 'email') {
    const me = await prisma.user.findUnique({ where: { id: req.user.id }, select: { email: true } }).catch(() => null);
    to = (me && me.email) || '';
  }
  const out = await portalFetch(`${T}/channels/admin/integration-channels/${ch}/test`, { method: 'POST', body: { to }, timeoutMs: 60000 });
  await audit(req, 'Job Portal channel test message', ch, out.ok ? 'sent' : 'failed');
  return res.json(out);
}));

/* ---- AI screening questions ---- */
router.get('/screening', view, wrap(async (req, res) => {
  res.json(await portalFetch(`${T}/screening/screening/settings`, { timeoutMs: 20000 }));
}));
router.put('/screening', change, wrap(async (req, res) => {
  const b = req.body || {};
  const body = { standard: b.standard, answerWeight: b.answerWeight, askOnAiCalls: b.askOnAiCalls };
  const out = await portalFetch(`${T}/screening/screening/settings`, { method: 'PUT', body, timeoutMs: 30000 });
  await audit(req, 'Job Portal screening settings saved', 'screening', `answer weight ${b.answerWeight}%, AI calls ${b.askOnAiCalls ? 'ask' : 'do not ask'}`);
  return res.json(out);
}));

module.exports = router;
