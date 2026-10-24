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
const access = require('../utils/contactAccess');
const convo = require('../utils/conversations');

const router = express.Router();
router.use(requireAuth);
// Message templates (own router file): /api/messaging/templates/*
router.use('/templates', require('./messageTemplates'));
// Bulk Call / SMS / WhatsApp / Email from the Candidates list and board: /api/messaging/reach/*
router.use('/reach', require('./messagingReach'));

const maskedFor = async (user, job) => (await access.ruleFor(user, job.audience)).mode === 'masked';
const external = (u) => ['CLIENT', 'CANDIDATE'].includes(u.role) || ['CLIENT', 'CANDIDATE'].includes(u.atsRole);

router.get('/channels', async (req, res) => {
  if (external(req.user)) return res.status(403).json({ error: 'Not available to this login' });
  const status = await messaging.channelStatus();
  // audiences = may I contact ONE person of this kind (the Contact button); bulk = may I send to MANY at once;
  // modes = 'direct' (I see the number) or 'masked' (the server uses it, I see a hint); reasons = the plain sentence when not.
  const audiences = {}; const bulkOk = {}; const modes = {}; const reasons = {}; const purposes = {};
  // eslint-disable-next-line no-restricted-syntax
  for (const a of bulk.AUDIENCES) {
    // eslint-disable-next-line no-await-in-loop
    const rule = await access.ruleFor(req.user, a);
    audiences[a] = rule.allowed;
    modes[a] = rule.mode;
    if (!rule.allowed) reasons[a] = rule.reason;
    if (rule.purposes) purposes[a] = rule.purposes;
    // eslint-disable-next-line no-await-in-loop
    bulkOk[a] = await bulk.mayBulkSend(req.user, a);
  }
  // Calling is separate from Email / SMS / WhatsApp (it is one person at a time, never a bulk send).
  const gw = await require('../utils/callGateway').callConfig().catch(() => ({ configured: false })); // eslint-disable-line global-require
  const quiet = await require('../utils/omniRules').settings().catch(() => null); // eslint-disable-line global-require
  res.json({
    channels: status, audiences, bulk: bulkOk, modes, reasons, purposes, limit: bulk.LIMIT,
    call: { configured: !!gw.configured, provider: gw.configured ? 'Exotel' : null, recording: !!gw.record },
    switchOn: await access.switchOn(req.user), quiet,
  });
});

// Channels panel (Message templates → Channels): honest status + exact setup steps.
router.get('/channels/detail', async (req, res, next) => {
  try {
    if (external(req.user)) return res.status(403).json({ error: 'Not available to this login' });
    const T = require('../utils/messageTemplates'); // eslint-disable-line global-require
    if (!T.canView(req.user)) return res.status(403).json({ error: 'Only an Admin, HR, a Team Lead or a manager can see the channel set-up.' });
    const base = String(process.env.APP_BASE_URL || '').replace(/\/+$/, '') || `${req.protocol}://${req.get('host')}`.replace(':4010', ':5183');
    return res.json({ channels: await require('../utils/messageChannels').detail(base), isAdmin: T.isAdmin(req.user), publicAddressSet: !!process.env.APP_BASE_URL }); // eslint-disable-line global-require
  } catch (err) { return next(err); }
});

// Email domain check: reads the public SPF / DKIM / DMARC records of the From address's domain. Sends nothing.
router.get('/channels/Email/domain-check', async (req, res, next) => {
  try {
    const T = require('../utils/messageTemplates'); // eslint-disable-line global-require
    if (!T.isAdmin(req.user)) return res.status(403).json({ error: 'Only an Admin can check the email domain.' });
    const out = await require('../utils/messageChannels').emailDomainCheck(); // eslint-disable-line global-require
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    return res.json(out);
  } catch (err) { return next(err); }
});

// Test: ONLY to the logged-in Admin's own address / number.
router.post('/channels/:channel/test', async (req, res, next) => {
  try {
    const T = require('../utils/messageTemplates'); // eslint-disable-line global-require
    if (!T.isAdmin(req.user)) return res.status(403).json({ error: 'Only an Admin can send a channel test.' });
    const out = await require('../utils/messageChannels').test(req.user, req.params.channel); // eslint-disable-line global-require
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    return res.json(out);
  } catch (err) { return next(err); }
});

// How fast and how many (Admin changes; staff can read).
router.get('/limits', async (req, res, next) => {
  try {
    if (external(req.user)) return res.status(403).json({ error: 'Not available to this login' });
    const lim = require('../utils/messageLimits'); // eslint-disable-line global-require
    const limits = await lim.load({ fresh: true });
    const jobs = bulk.listJobs();
    const usedToday = Object.fromEntries(lim.CHANNELS.map((c) => [c, lim.usedToday(c, jobs)]));
    return res.json({ limits, usedToday, bounds: lim.BOUNDS, canEdit: require('../utils/messageTemplates').isAdmin(req.user) }); // eslint-disable-line global-require
  } catch (err) { return next(err); }
});
router.put('/limits', async (req, res, next) => {
  try {
    if (!require('../utils/messageTemplates').isAdmin(req.user)) return res.status(403).json({ error: 'Only an Admin can change the sending limits.' }); // eslint-disable-line global-require
    const out = await require('../utils/messageLimits').save(req.user, req.body || {}); // eslint-disable-line global-require
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    return res.json({ limits: out.limits });
  } catch (err) { return next(err); }
});

// CALL THROUGH TEAMLINK (Exotel click-to-call, utils/callGateway.js): the caller's own phone rings
// first, then the person is connected. One person per click. Logged as a call on their history; the
// result (answered / no answer / how long) is added when Exotel reports it.
router.post('/call', async (req, res, next) => {
  try {
    const b = req.body || {};
    const audience = ['candidates', 'clients', 'employees'].includes(b.audience) ? b.audience : null;
    if (!audience || !b.id) return res.status(400).json({ error: 'Say who to call.' });
    const rule = await access.ruleFor(req.user, audience);
    if (!rule.allowed) return res.status(403).json({ error: rule.reason || 'Not available to this login' });
    const people = await require('../utils/messageContext').recipientsFor(req.user, audience, [String(b.id)], { applicationId: b.applicationId, contactKind: rule.kind }); // eslint-disable-line global-require
    if (!people.length) return res.status(403).json({ error: 'This person is outside your access.' });
    const person = people[0];
    if (person.doNotContact) return res.status(409).json({ error: 'This person asked not to be contacted.' });
    const own = await require('../utils/messageChannels').ownContact(req.user); // eslint-disable-line global-require
    if (!own.phone) return res.status(409).json({ error: 'Your own phone number is not on your employee profile, so TeamLink does not know which phone to ring first. Add it on your profile.' });
    const gw = require('../utils/callGateway'); // eslint-disable-line global-require
    const base = String(process.env.APP_BASE_URL || '').replace(/\/+$/, '') || null;
    const out = await gw.startCall({ agent: own.phone, to: person.mobile, ref: `${audience}:${person.id}`.slice(0, 120), callbackBase: base });
    if (!out.ok && out.notConfigured) return res.status(409).json({ error: out.error, notConfigured: true });
    if (!out.ok && out.invalid) return res.status(400).json({ error: out.error });
    const detail = out.ok
      ? `Call through TeamLink started: ${own.name}'s phone rings first${out.sandbox ? ' (test server, no real call)' : ''}.${out.recording ? ' Recording is ON.' : ''}`
      : `Call did not start: ${out.error}`;
    if (audience === 'candidates') {
      await require('../db').candidateMessage.create({ data: { // eslint-disable-line global-require
        candidateId: person.id, applicationId: person.applicationId || null, channel: 'Call', template: 'CALL_THROUGH', templateLabel: 'Call through TeamLink', trigger: 'Manual',
        recipient: person.mobile || '', status: out.ok ? 'SENT' : 'FAILED', statusDetail: detail.slice(0, 500), providerRef: out.callSid || null, sentAt: out.ok ? new Date() : null,
        attempts: 1, lastAttemptAt: new Date(), lastError: out.ok ? null : String(out.error).slice(0, 500),
        senderUserId: req.user.id, senderName: req.user.name,
      } }).catch(() => {});
      await convo.recordOut({ personType: 'CANDIDATE', personId: person.id, personName: person.name, channel: 'Call', body: 'Call through TeamLink', templateLabel: 'Call through TeamLink' }).catch(() => {});
      // a contact: the open follow-up moves to "last contacted by Call"
      await require('../db').applicationFollowUp.updateMany({ where: { candidateId: person.id, completedAt: null, ...(person.applicationId ? { applicationId: person.applicationId } : {}) }, data: { lastContactedAt: new Date(), contactMode: 'Call' } }).catch(() => {}); // eslint-disable-line global-require
    } else {
      await require('../utils/audit').logAudit({ userId: req.user.id, actorName: req.user.name, action: out.ok ? 'Call through TeamLink started' : 'Call through TeamLink failed', entity: audience === 'clients' ? 'Client' : 'Employee', entityId: person.id, toValue: (out.callSid ? `${out.callSid} · ` : '') + detail.slice(0, 300) }); // eslint-disable-line global-require
      await convo.recordOut({ personType: convo.TYPES[audience], personId: person.id, personName: person.name, channel: 'Call', body: 'Call through TeamLink', status: out.ok ? 'SENT' : 'FAILED', statusDetail: detail, providerRef: out.callSid || null, templateLabel: 'Call through TeamLink', senderUserId: req.user.id, senderName: req.user.name, address: person.mobile }).catch(() => {});
    }
    if (!out.ok) return res.status(out.transient ? 503 : 502).json({ error: out.error });
    return res.json({ ok: true, callSid: out.callSid, sandbox: !!out.sandbox, recording: !!out.recording, message: `Your phone (${own.name}) will ring first. Pick up, and TeamLink then connects ${person.name}.` });
  } catch (err) { return next(err); }
});

// The call script for one person (Call window).
router.post('/script', async (req, res, next) => {
  try {
    const out = await bulk.renderScript(req.user, req.body || {});
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    return res.json(out.script);
  } catch (err) { return next(err); }
});

// Look before you send: who gets what, who is skipped or blocked and why.
router.post('/preview', async (req, res, next) => {
  try {
    const out = await bulk.preview(req.user, req.body || {});
    if (out.error) return res.status(out.status || 400).json({ error: out.error, ...(out.code ? { code: out.code } : {}) });
    return res.json(out.preview);
  } catch (err) { return next(err); }
});

// ONE person: build, send and answer with the outcome (Sent / Failed / Blocked).
router.post('/send', require('../channels/rateLimit').limiter(), async (req, res, next) => {
  try {
    const out = await bulk.sendIndividual(req.user, req.body || {});
    if (out.error) return res.status(out.status || 400).json({ error: out.error, ...(out.code ? { code: out.code } : {}) });
    return res.json(out);
  } catch (err) { return next(err); }
});

// Someone opened the message in their OWN app (mail / WhatsApp) for a client contact or an
// employee: record it in that person's history. (A candidate's own log is /followups/quick-log.)
router.post('/device-log', async (req, res, next) => {
  try {
    const b = req.body || {};
    const audience = ['clients', 'employees'].includes(b.audience) ? b.audience : null;
    const channel = ['Email', 'SMS', 'WhatsApp', 'Call'].includes(b.channel) ? b.channel : null;
    if (!audience || !channel || !b.id) return res.status(400).json({ error: 'Say who and how.' });
    if (audience === 'employees' && channel === 'WhatsApp' && !access.mayWhatsAppEmployees(req.user)) return res.status(403).json({ error: access.WA_EMPLOYEE_DENIED });
    const rule = await access.ruleFor(req.user, audience);
    if (!rule.allowed) return res.status(403).json({ error: rule.reason || 'Not available to this login' });
    const people = await require('../utils/messageContext').recipientsFor(req.user, audience, [String(b.id)], { contactKind: rule.kind }); // eslint-disable-line global-require
    if (!people.length) return res.status(403).json({ error: 'This person is outside your access.' });
    await require('../utils/audit').logAudit({ // eslint-disable-line global-require
      userId: req.user.id, actorName: req.user.name, action: `${channel} opened in the sender's own app: ${String(b.purpose || 'Message').slice(0, 80)}`,
      entity: audience === 'clients' ? 'Client' : 'Employee', entityId: String(b.id), toValue: 'The app cannot see whether it was sent',
    });
    await convo.recordOut({
      personType: convo.TYPES[audience], personId: String(b.id), personName: people[0].name, channel,
      body: channel === 'Call' ? String(b.purpose || 'Call') : String(b.purpose || 'Message'), status: channel === 'Call' ? 'LOGGED' : 'OPENED_ON_DEVICE',
      statusDetail: channel === 'Call' ? 'Call logged' : 'Opened in the sender own app - the app cannot see whether it was sent', templateLabel: String(b.purpose || '').slice(0, 120) || null,
      senderUserId: req.user.id, senderName: req.user.name,
    }).catch(() => {});
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

router.post('/bulk', async (req, res, next) => {
  try {
    const out = await bulk.createJob(req.user, req.body || {});
    if (out.error) return res.status(out.status || 400).json({ error: out.error, ...(out.code ? { code: out.code } : {}) });
    return res.status(202).json(out.job);
  } catch (err) { return next(err); }
});

router.get('/bulk', async (req, res, next) => {
  try {
    const global = scopeOf(req.user).global;
    const jobs = bulk.listJobs()
      .filter((j) => global || (j.createdBy && j.createdBy.id === req.user.id))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, 30);
    const out = [];
    for (const j of jobs) out.push(bulk.summary(j, { masked: await maskedFor(req.user, j) })); // eslint-disable-line no-await-in-loop
    res.json(out);
  } catch (err) { next(err); }
});

function loadVisible(req, res) {
  const job = bulk.readJob(req.params.id);
  if (!job) { res.status(404).json({ error: 'No such bulk send' }); return null; }
  if (!bulk.canSee(req.user, job)) { res.status(403).json({ error: 'Only the sender or an Admin can see this bulk send' }); return null; }
  return job;
}

router.get('/bulk/:id', async (req, res, next) => {
  try {
    const job = loadVisible(req, res);
    if (!job) return undefined;
    return res.json(bulk.summary(job, { withRecipients: true, masked: await maskedFor(req.user, job) }));
  } catch (err) { return next(err); }
});

router.get('/bulk/:id/report.csv', async (req, res, next) => {
  try {
    const job = loadVisible(req, res);
    if (!job) return undefined;
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="bulk-send-${job.id}.csv"`);
    return res.send(`﻿${bulk.reportCsv(job, await maskedFor(req.user, job))}`);
  } catch (err) { return next(err); }
});

router.get('/bulk/:id/report.xlsx', async (req, res, next) => {
  try {
    const job = loadVisible(req, res);
    if (!job) return undefined;
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="message-result-${job.id}.xlsx"`);
    return res.send(bulk.reportXlsx(job, await maskedFor(req.user, job)));
  } catch (err) { return next(err); }
});

// Continue a send that is waiting (its WhatsApp number was switched off): the sender or an Admin.
router.post('/bulk/:id/resume', async (req, res, next) => {
  try {
    const job = loadVisible(req, res);
    if (!job) return undefined;
    const out = await bulk.resumeJob(job.id);
    return res.json(bulk.summary(out || job, { masked: await maskedFor(req.user, job) }));
  } catch (err) { return next(err); }
});

router.post('/bulk/:id/cancel', async (req, res, next) => {
  try {
    const job = loadVisible(req, res);
    if (!job) return undefined;
    const out = bulk.cancelJob(job.id);
    return res.json(bulk.summary(out || job, { masked: await maskedFor(req.user, job) }));
  } catch (err) { return next(err); }
});

router.post('/bulk/:id/retry-failed', async (req, res, next) => {
  try {
    const job = loadVisible(req, res);
    if (!job) return undefined;
    const out = await bulk.retryFailed(job.id, req.user);
    if (out.error) return res.status(409).json({ error: out.error });
    return res.json({ ...bulk.summary(out.job, { masked: await maskedFor(req.user, out.job) }), retried: out.retried });
  } catch (err) { return next(err); }
});

// The worker starts with the router (the API process), polling every second.
bulk.start();

module.exports = router;
