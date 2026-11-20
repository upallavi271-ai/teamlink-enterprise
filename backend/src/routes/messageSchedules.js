// ---------------------------------------------------------------------------
// COMMUNICATION -> SCHEDULED MESSAGES (founder 2026-11-20). Mounted on /api/ats/scheduled-messages. The rules are in utils/messageSchedules.js.
//
//   GET    /                 the page: counts (Total, Completed, Upcoming, Failed, Active, Paused, Cancelled), the tab, the filters, the rows
//   GET    /export           the same rows as Excel / CSV (the filters of the screen), audited like every export
//   GET    /options          the screen's choices (ways, templates, placeholders, time zones, limits)
//   POST   /preview          the live "Schedule summary", computed by the engine
//   POST   /                 create: one candidate or many (one schedule per candidate)
//   GET    /candidate/:id    one candidate's schedules and every message (the candidate tab, the communication history)
//   GET    /triggers         the ATS triggers (everyone sees them; only an Admin changes them)
//   PUT    /triggers
//   GET    /:id              one schedule and its messages
//   PATCH  /:id              edit (waiting messages are planned again, sent ones stay)
//   POST   /:id/pause | /:id/resume | /:id/cancel
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth, requireProduct } = require('../middleware/auth');
const MS = require('../utils/messageSchedules');
const { sendBook, formatOf } = require('../utils/exportKit');

const router = express.Router();
router.use(requireAuth);
router.use(requireProduct('ats'));

const reply = (res, out) => {
  const { status = 200, ...rest } = out || {};
  return res.status(status).json(rest);
};
const wrap = (fn) => async (req, res) => {
  try { return await fn(req, res); } catch (err) {
    console.error('[scheduled-messages route]', err.message); // eslint-disable-line no-console
    return res.status(500).json({ error: 'Something went wrong with the scheduled messages. Please try again.' });
  }
};

router.get('/', wrap(async (req, res) => reply(res, await MS.listAll(req.user, req.query || {}))));
router.get('/export', wrap(async (req, res) => {
  const format = formatOf({ format: req.query.format === 'pdf' ? 'xlsx' : req.query.format });
  if (!format) return res.status(400).json({ error: 'Choose Excel or CSV.' });
  const out = await MS.listAll(req.user, req.query || {}, { exportAll: true });
  if (out.status !== 200) return reply(res, out);
  if (out.countOnly) return res.status(403).json({ error: 'Your team sees only the numbers of the scheduled messages, so there is nothing to download.' });
  const P = require('../utils/permissions'); // eslint-disable-line global-require
  const role = P.stageRoleOf(req.user);
  return sendBook(req, res, {
    format, name: `scheduled-messages-${out.tab}`, entity: 'Candidate', what: `Scheduled messages (${out.tab})`, scope: out.scope || role || 'own', period: null,
    sheets: [{ name: 'Scheduled messages', headers: MS.EXPORT_HEADERS, rows: MS.exportRows(out.rows) }],
  });
}));
router.get('/options', wrap(async (req, res) => reply(res, await MS.options(req.user))));
router.post('/preview', wrap(async (req, res) => reply(res, await MS.preview(req.user, req.body || {}))));
router.post('/', wrap(async (req, res) => reply(res, await MS.create(req.user, req.body || {}))));
router.get('/candidate/:id', wrap(async (req, res) => reply(res, await MS.forCandidate(req.user, req.params.id))));
router.get('/triggers', wrap(async (req, res) => {
  const P = require('../utils/permissions'); // eslint-disable-line global-require
  if (!req.user || P.isExternalLogin(req.user)) return res.status(403).json({ error: 'Not available to this login.' });
  const t = await MS.loadTriggers();
  const isAdmin = ['SUPER_ADMIN', 'ADMIN'].includes(req.user.role) || ['SUPER_ADMIN', 'ADMIN'].includes(req.user.atsRole);
  return res.json({
    ...t, canEdit: isAdmin,
    definitions: MS.TRIGGERS.map((d) => ({ key: d.key, label: d.label, event: d.event, mode: d.mode, group: d.group, noResponse: !!d.noResponse, defaultBody: d.body })),
    tokens: ['interview_date', 'interview_time', 'joining_date'],
  });
}));
router.put('/triggers', wrap(async (req, res) => reply(res, await MS.saveTriggers(req.user, (req.body && req.body.triggers) || {}))));
router.get('/:id', wrap(async (req, res) => reply(res, await MS.getOne(req.user, req.params.id))));
router.patch('/:id', wrap(async (req, res) => reply(res, await MS.edit(req.user, req.params.id, req.body || {}))));
router.post('/:id/pause', wrap(async (req, res) => reply(res, await MS.pause(req.user, req.params.id, req.body && req.body.reason))));
router.post('/:id/resume', wrap(async (req, res) => reply(res, await MS.resume(req.user, req.params.id))));
router.post('/:id/cancel', wrap(async (req, res) => reply(res, await MS.cancel(req.user, req.params.id, req.body && req.body.reason))));

module.exports = router;
