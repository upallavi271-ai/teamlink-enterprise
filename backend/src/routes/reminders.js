// ---------------------------------------------------------------------------
// SCHEDULED REMINDERS TO THE CANDIDATE (interview + joining): the plan, the panel, the dashboard card and the Admin switches.
// Mounted on /api/ats/reminders. All the rules are in utils/scheduledReminders.js (read its header).
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth, requireProduct } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const SR = require('../utils/scheduledReminders');

const router = express.Router();
router.use(requireAuth);
router.use(requireProduct('ats'));

const isAdminLogin = (u) => !!u && (['SUPER_ADMIN', 'ADMIN'].includes(u.role) || ['SUPER_ADMIN', 'ADMIN'].includes(u.atsRole));
const reply = (res, out) => {
  const { status = 200, ...rest } = out || {};
  return res.status(status).json(rest);
};
const wrap = (fn) => async (req, res) => {
  try { return await fn(req, res); } catch (err) {
    console.error('[reminders route]', err.message); // eslint-disable-line no-console
    return res.status(500).json({ error: 'Something went wrong with the reminders. Please try again.' });
  }
};

// ---- the Admin switches and the words
router.get('/settings', wrap(async (req, res) => {
  const [settings, templates] = await Promise.all([SR.loadSettings(), SR.loadTemplates()]);
  const chans = await require('../utils/messaging').channelStatus().catch(() => ({})); // eslint-disable-line global-require
  const sms = await (async () => { try { const g = require('../utils/smsGateway'); const c = await g.smsConfig(); return { configured: !!c.configured, reason: c.reason || '' }; } catch { return { configured: false, reason: '' }; } })(); // eslint-disable-line global-require
  const departments = await require('../db').requirement.findMany({ distinct: ['department'], select: { department: true } }).then((r) => r.map((x) => x.department).filter(Boolean).sort()).catch(() => []); // eslint-disable-line global-require
  res.json({
    settings, templates, tokens: SR.TOKENS, templateKeys: SR.TEMPLATE_KEYS, defaults: SR.DEFAULT_STEPS, max: SR.MAX_STEPS, canEdit: isAdminLogin(req.user), departments,
    channels: SR.CHANNELS.map((c) => ({ channel: c, ready: !!(chans[c] && chans[c].configured), reason: (chans[c] && chans[c].reason) || (c === 'SMS' ? sms.reason : '') })),
    sandbox: require('../utils/sandbox').isSandbox(), // eslint-disable-line global-require
  });
}));
router.put('/settings', wrap(async (req, res) => {
  if (!isAdminLogin(req.user)) return res.status(403).json({ error: 'Only an Admin can change the reminder settings.' });
  const r = await SR.saveSettings(req.body || {}, req.user);
  if (r.error) return res.status(400).json({ error: r.error });
  await logAudit({
    userId: req.user.id, actorName: req.user.name, action: 'Candidate reminder settings changed', entity: 'AppSetting', entityId: SR.SETTINGS_KEY,
    fromValue: JSON.stringify({ enabled: r.before.enabled, channels: r.before.channels }).slice(0, 300), toValue: JSON.stringify({ enabled: r.settings.enabled, channels: r.settings.channels, hours: [r.settings.earliestHour, r.settings.latestHour] }).slice(0, 300),
  });
  const on = r.settings.enabled;
  res.json({ settings: r.settings, message: on ? 'Saved. Reminders are ON: due messages now go out (every 5 minutes).' : 'Saved. Reminders are off: plans are made and shown, nothing is sent.' });
}));
router.put('/templates', wrap(async (req, res) => {
  if (!isAdminLogin(req.user)) return res.status(403).json({ error: 'Only an Admin can change the reminder words.' });
  const r = await SR.saveTemplates(req.body && req.body.templates, req.user);
  if (r.error) return res.status(400).json({ error: r.error });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Candidate reminder wording changed', entity: 'AppSetting', entityId: SR.TEMPLATES_KEY });
  res.json({ templates: r.templates, message: 'Saved.' });
}));
router.post('/test', wrap(async (req, res) => {
  if (!isAdminLogin(req.user)) return res.status(403).json({ error: 'Only an Admin can send a test reminder.' });
  return reply(res, await SR.sendTest(req.user, req.body || {}));
}));

// ---- the booking / joining window
router.post('/suggest', wrap(async (req, res) => {
  const b = req.body || {};
  const eventAt = b.eventAt || (b.date && b.time ? new Date(`${String(b.date).slice(0, 10)}T${String(b.time).slice(0, 5)}:00+05:30`).toISOString() : null);
  if (!eventAt) return res.status(400).json({ error: 'Pick the date and time first.' });
  return reply(res, await SR.suggest(req.user, { applicationId: b.applicationId, kind: b.kind, eventAt, mode: b.mode, details: b.details }));
}));
router.post('/preview', wrap(async (req, res) => reply(res, await SR.previewOne(req.user, req.body || {}))));

// ---- one application / candidate
router.get('/application/:id', wrap(async (req, res) => reply(res, await SR.panel(req.user, req.params.id))));
router.get('/interview/:id', wrap(async (req, res) => reply(res, await SR.forInterview(req.user, req.params.id))));
router.get('/candidate/:id', wrap(async (req, res) => res.json({ applications: await SR.listForCandidate(req.user, req.params.id) })));
router.post('/application/:id/rows', wrap(async (req, res) => reply(res, await SR.addRow(req.user, req.params.id, req.body))));
router.post('/application/:id/cancel-all', wrap(async (req, res) => reply(res, await SR.cancelAll(req.user, req.params.id, req.body))));
router.put('/application/:id/details', wrap(async (req, res) => reply(res, await SR.saveDetails(req.user, req.params.id, (req.body || {}).kind, (req.body || {}).details))));
router.patch('/rows/:rid', wrap(async (req, res) => reply(res, await SR.patchRow(req.user, req.params.rid, req.body))));
router.post('/rows/:rid/send-now', wrap(async (req, res) => reply(res, await SR.sendNow(req.user, req.params.rid))));

// ---- schedule ANY message to one candidate (the candidate profile's "Schedule a message" tab; utils/scheduledMessages.js)
const SM = require('../utils/scheduledMessages');
router.get('/messages/candidate/:cid', wrap(async (req, res) => reply(res, await SM.list(req.user, req.params.cid, { applicationId: req.query.applicationId || null }))));
router.post('/messages/candidate/:cid', wrap(async (req, res) => reply(res, await SM.create(req.user, req.params.cid, req.body))));
router.patch('/messages/:id', wrap(async (req, res) => reply(res, await SM.edit(req.user, req.params.id, req.body))));
router.delete('/messages/:id', wrap(async (req, res) => reply(res, await SM.cancel(req.user, req.params.id, (req.body && req.body.reason) || req.query.reason))));

// ---- the dashboard card
router.get('/upcoming', wrap(async (req, res) => reply(res, await SR.upcoming(req.user))));

// ---- the sandbox's simulated clock (tests only: the real server never takes a clock from a request)
router.post('/run', wrap(async (req, res) => {
  if (!isAdminLogin(req.user)) return res.status(403).json({ error: 'Only an Admin can run the reminders by hand.' });
  const sandbox = require('../utils/sandbox').isSandbox(); // eslint-disable-line global-require
  const now = sandbox && req.body && req.body.now ? new Date(req.body.now) : new Date();
  if (Number.isNaN(now.getTime())) return res.status(400).json({ error: 'now is not a date' });
  const out = await SR.run({ now });
  res.json(out);
}));

module.exports = router;
