// ---------------------------------------------------------------------------
// /api/portal-mailboxes — Administration -> Integrations -> "Naukri & Shine mailboxes" (founder, 2026-10-29).
//
// The mailbox that receives Naukri responses, and the one that receives Shine responses, each connected to ONE
// recruiter. The engine is the Job Portal's own (Naukri & Shine Email Import, 0135): it logs in to the mailbox for
// real (IMAP over SSL) BEFORE anything is saved, seals the app password and never sends it back, reads the mail and
// imports the applications into that recruiter's records. TeamLink reaches it server to server through the portal
// bridge (job-portal-app/embed/teamlink-integration.mjs, .../mailboxes, JOB_PORTAL_SYNC_TOKEN); nothing is stored here.
//
//   GET  /                     connections + recruiters (department, employee id, active) + departments
//   POST /                     connect { source, department, recruiterId, address, provider, username?, appPassword, host?, port?, takeOver? }
//   POST /:id/sync | /:id/reconnect { appPassword? } | /:id/disconnect | /:id/reassign { recruiterId, confirm }
//   GET  /:id/logs
//
// Super Admin and Admin (Integrations: view to read, configure to change). Every change is also in TeamLink's audit log.
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requirePerm } = require('../utils/permissions');
const { logAudit } = require('../utils/audit');
const { portalFetch } = require('../utils/jobPortalBridge');

const router = express.Router();
router.use(requireAuth);

const view = requirePerm(null, 'administration', 'Integrations', 'view');
const change = requirePerm(null, 'administration', 'Integrations', 'configure');
const BASE = '/integrations/teamlink/mailboxes';
const CONN = `${BASE}/intake/source-connections`;
const BOARD = { naukri: 'Naukri', shine: 'Shine' };

// The portal's answer, passed on as it is (its words, its field errors); "not running / not set up" said plainly.
function send(res, err) {
  if (err && err.status && err.portalError) return res.status(err.status).json({ error: err.portalError });
  const message = err && err.notConfigured
    ? `The Job Portal is not linked to TeamLink on this server (${err.message}).`
    : `The Job Portal could not be reached: ${(err && err.message) || 'no answer'}.`;
  return res.status(err && err.notConfigured ? 503 : 502).json({ error: { code: 'PORTAL_UNAVAILABLE', message } });
}
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => send(res, err));
const idPath = (id) => `${CONN}/${encodeURIComponent(String(id))}`;
const audit = (req, action, entityId, toValue) => logAudit({
  userId: req.user.id, action, entity: 'PortalMailbox', entityId: entityId ? String(entityId) : undefined, toValue,
});

router.get('/', view, wrap(async (req, res) => {
  // a Recruiter / TL added in HRMS just now is in the list too (utils/jobPortalRecruiters.js); waits at most 15 s, never fails the screen
  await Promise.race([require('../utils/jobPortalRecruiters').ensureQuietly(), new Promise((r) => { setTimeout(r, 15000); })]); // eslint-disable-line global-require
  const [conns, recs] = await Promise.all([portalFetch(CONN, { timeoutMs: 20000 }), portalFetch(`${BASE}/recruiters`, { timeoutMs: 20000 })]);
  const dept = new Map((recs.recruiters || []).map((r) => [r.id, r.department]));
  res.json({
    connections: (conns.connections || []).map((c) => ({ ...c, recruiterDepartment: dept.get(c.recruiterId) || undefined })),
    recruiters: recs.recruiters || [],
    departments: recs.departments || [],
    providers: conns.providers || [],
    canStoreCredentials: conns.canStoreCredentials,
  });
}));

router.post('/', change, wrap(async (req, res) => {
  const b = req.body || {};
  const body = {
    source: b.source, department: b.department || undefined, recruiterId: b.recruiterId, address: b.address, provider: b.provider,
    username: b.username || undefined, appPassword: b.appPassword, host: b.host || undefined, port: b.port || undefined,
    takeOver: b.takeOver === true ? true : undefined,
  };
  // the mail server is asked to log in before anything is saved: allow it its own wait (60 s) and a little more
  const out = await portalFetch(CONN, { method: 'POST', body, timeoutMs: 75000 });
  await audit(req, `${BOARD[b.source] || 'Portal'} mailbox connected`, out.connection && out.connection.id,
    `${b.address} -> ${(out.connection && out.connection.recruiterName) || b.recruiterId}`);
  res.status(201).json(out);
}));

router.post('/:id/sync', change, wrap(async (req, res) => {
  res.json(await portalFetch(`${idPath(req.params.id)}/sync`, { method: 'POST', body: {}, timeoutMs: 180000 }));
}));

router.post('/:id/reconnect', change, wrap(async (req, res) => {
  const pw = req.body && req.body.appPassword;
  const out = await portalFetch(`${idPath(req.params.id)}/reconnect`, { method: 'POST', body: pw ? { appPassword: pw } : {}, timeoutMs: 75000 });
  await audit(req, 'Portal mailbox reconnected', req.params.id);
  res.json(out);
}));

router.post('/:id/disconnect', change, wrap(async (req, res) => {
  const out = await portalFetch(`${idPath(req.params.id)}/disconnect`, { method: 'POST', body: {} });
  await audit(req, 'Portal mailbox disconnected', req.params.id);
  res.json(out);
}));

router.post('/:id/reassign', change, wrap(async (req, res) => {
  const b = req.body || {};
  const out = await portalFetch(`${idPath(req.params.id)}/reassign`, { method: 'POST', body: { recruiterId: b.recruiterId, confirm: b.confirm === true } });
  await audit(req, 'Portal mailbox reassigned', req.params.id, String(b.recruiterId || ''));
  res.json(out);
}));

router.get('/:id/logs', view, wrap(async (req, res) => {
  res.json(await portalFetch(`${idPath(req.params.id)}/logs`, { timeoutMs: 20000 }));
}));

module.exports = router;
