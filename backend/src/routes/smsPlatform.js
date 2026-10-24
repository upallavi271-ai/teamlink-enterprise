// ---------------------------------------------------------------------------
// /api/sms-platform — the SMS Push Platform screens (Administration > Integrations > SMS Push Platform).
//
//   GET  /overview              provider, state (Connected / Not connected / Configuration Required), last test, last accepted SMS, report address
//   POST /test-connection       the safe check (no SMS is sent unless the provider has a documented read call)
//   POST /preview               the exact words one recipient would get + characters / parts
//   POST /send                  Admin: single / several / CSV list; needs an approved template; bulk needs a confirm; never twice for one key
//   GET  /history               one row per SMS (filters, pages) + /history.csv       GET /history/detail?ref=|id=   one SMS with its status ticks
//   GET  /dashboard             real counts from the records, by status and by source module
//
// The sending itself is the SAME channel layer every module uses (channels.send, provider sms.gateway), so rate limits, opt-outs, the
// communication log and delivery reports are not duplicated. Configuration is edited where it always was (Integrations > SMS Gateway);
// no secret is ever sent to a screen. Templates are the Message templates (channel SMS: DLT template id + sender id live there).
// A status is only what the provider told us: "Submitted" is NOT "Delivered".
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const prisma = require('../db');
const channels = require('../channels');
const store = require('../channels/store');
const core = require('../utils/messagingCore');
const T = require('../utils/messageTemplates');
const sms = require('../utils/smsGateway');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);

const BULK_MAX = Math.max(1, Number(process.env.SMS_PLATFORM_BULK_MAX) || 500);
const BULK_CONFIRM_OVER = 1; // more than one recipient asks for a confirm
const REPEAT_WINDOW_MS = 2 * 60 * 1000;
const PROVIDER_ID = 'sms.gateway';
const wrap = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };
// Sending to ANY number is an Admin / Super Admin right. Everyone else keeps using the scoped Contact buttons (candidates, clients, employees).
const adminOnly = (req, res, next) => (T.isAdmin(req.user) ? next() : res.status(403).json({ error: 'Only an Admin or Super Admin can use the SMS Push Platform screens.' }));
router.use(adminOnly);

const webhookBase = (req) => String(process.env.APP_BASE_URL || '').replace(/\/+$/, '') || `${req.protocol}://${req.get('host')}`;
const STATUS_WORD = { queued: 'Queued', sent: 'Submitted', delivered: 'Delivered', read: 'Delivered', failed: 'Failed' };
// a message the provider ACCEPTED and later reported as not delivered was still submitted: only a first tick of 'failed' is a failed submission
const submissionFailed = (r) => !!(r.history && r.history[0] && r.history[0].status === 'failed') || (!r.history && r.status === 'failed');
const statusOf = (r) => (r.status === 'failed' && r.unknown ? 'Unknown' : STATUS_WORD[r.status] || 'Unknown');

function shapeRow(r) {
  return {
    id: r.id, at: r.at, recipient: r.to, recipientName: r.personName || null, module: r.module || 'Other', template: r.template || null,
    preview: r.preview || null, senderId: r.senderIdUsed || null, dltTemplateId: r.dltTemplateId || null, providerRef: r.providerRef || null,
    submission: submissionFailed(r) ? (r.unknown ? 'Unknown' : 'Failed') : 'Submitted', delivery: statusOf(r),
    errorCode: null, error: r.error || null, retries: r.retries || 0, by: r.senderName || null,
  };
}

async function smsRecords({ from, to, status, module, template, q }) {
  const rows = (await store.list({ channel: 'SMS', provider: PROVIDER_ID, from, to, direction: 'OUT' }, { limit: 20000 }))
    .filter((r) => (!module || (r.module || 'Other') === module)
      && (!template || String(r.template || '') === template)
      && (!status || statusOf(r) === status));
  const needle = String(q || '').replace(/\D/g, '');
  return needle ? rows.filter((r) => String(r.to || '').replace(/\D/g, '').includes(needle)) : rows;
}

// ---- overview --------------------------------------------------------------
router.get('/overview', wrap(async (req, res) => {
  const cfg = await sms.smsConfig();
  const last = await sms.pushLastAccepted();
  const test = await prisma.appSetting.findUnique({ where: { key: 'smspush.lasttest' } }).catch(() => null);
  let lastTest = null; try { lastTest = test ? JSON.parse(test.value) : null; } catch { lastTest = null; }
  const isPush = cfg.provider === 'SMSGW';
  const proven = isPush ? !!last : cfg.configured;
  const state = !cfg.configured ? 'Configuration Required' : proven ? 'Connected' : 'Not connected';
  res.json({
    provider: cfg.providerLabel || null, isPush, configured: cfg.configured, problems: cfg.problems, state,
    stateNote: !cfg.configured ? cfg.reason
      : (isPush && !last ? 'Saved but not proven: no SMS has been accepted by the provider yet. Press "Send test SMS".' : null),
    senderId: cfg.sender || null, peId: isPush ? cfg.push.pe || null : null, sendAddress: isPush ? cfg.push.url : null,
    hasPassword: isPush ? !!cfg.push.pass : !!cfg.key, // only that one is stored, never the secret itself
    lastTest, lastAccepted: last,
    reportAddress: `${webhookBase(req)}/api/webhooks/sms/${isPush ? 'smsgw' : String(cfg.provider || 'msg91').toLowerCase()}?key=<your delivery-report secret>`,
    reportSecretSet: !!cfg.dlrSecret,
    limits: { bulkMax: BULK_MAX },
    settingsHint: 'Provider, login, Sender ID, PE ID and the delivery-report secret are set in Integrations > Connections > SMS Gateway > Configure.',
  });
}));

router.post('/test-connection', wrap(async (req, res) => {
  const out = await sms.testConnection();
  const rec = { at: new Date().toISOString(), ok: !!out.ok, result: String(out.result || '').slice(0, 300), by: req.user.name };
  await prisma.appSetting.upsert({ where: { key: 'smspush.lasttest' }, create: { key: 'smspush.lasttest', value: JSON.stringify(rec) }, update: { value: JSON.stringify(rec) } }).catch(() => {});
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'SMS connection test', entity: 'Integration', entityId: 'sms', toValue: rec.ok ? 'ok' : 'not proven' });
  res.json({ ...out, needsConfirmation: !!out.needsConfirmation });
}));

// ---- one message, worded -----------------------------------------------------
async function templateFor(id) {
  if (!id) return { error: 'Choose an approved template. A message that is not in an approved DLT template will not be delivered in India.' };
  const t = await prisma.messageTemplate.findUnique({ where: { id } }).catch(() => null);
  if (!t || t.channel !== 'SMS') return { error: 'That is not an SMS template.' };
  if (!t.active) return { error: 'That template is switched off.' };
  if (!t.dltTemplateId) return { error: `The template "${t.name}" has no DLT Template ID yet. Add the approved id in Message templates before sending.` };
  return { t };
}
function wording(t, recipient, variables) {
  const values = { ...(variables || {}), ...(recipient.name ? { name: recipient.name, candidateName: recipient.name, employeeName: recipient.name } : {}) };
  const r = T.render(t.body, values);
  return { text: r.text, missing: r.missing, info: T.smsInfo(r.text) };
}

router.post('/preview', wrap(async (req, res) => {
  const { t, error } = await templateFor(req.body && req.body.templateId);
  if (error) return res.status(400).json({ error });
  const w = wording(t, { name: (req.body.recipientName || '').trim() }, req.body.variables);
  return res.json({ text: w.text, missing: w.missing, chars: w.info.chars, segments: w.info.segments, encoding: w.info.encoding, dltTemplateId: t.dltTemplateId, senderId: t.senderId || null });
}));

// ---- send ------------------------------------------------------------------------
const IDEM = 'smspush.idem.';
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 24);
async function recent(key) {
  const row = await prisma.appSetting.findUnique({ where: { key } }).catch(() => null);
  if (!row) return null;
  try { const v = JSON.parse(row.value); return Date.now() - new Date(v.at).getTime() < v.ttl ? v : null; } catch { return null; }
}
const remember = (key, value) => prisma.appSetting.upsert({ where: { key }, create: { key, value: JSON.stringify(value) }, update: { value: JSON.stringify(value) } }).catch(() => {});

router.post('/send', wrap(async (req, res) => {
  const b = req.body || {};
  const list = Array.isArray(b.recipients) ? b.recipients : [];
  if (!list.length) return res.status(400).json({ error: 'Add at least one recipient.' });
  if (list.length > BULK_MAX) return res.status(400).json({ error: `At most ${BULK_MAX} recipients at a time (the limit protects the provider account).` });
  if (list.length > BULK_CONFIRM_OVER && b.confirm !== true) {
    return res.status(409).json({ code: 'CONFIRM_BULK', error: `This sends ${list.length} SMS. Confirm to continue.`, count: list.length });
  }
  const { t, error } = await templateFor(b.templateId);
  if (error) return res.status(400).json({ error });
  const cfg = await sms.smsConfig();
  if (!cfg.configured) return res.status(400).json({ error: `SMS is not ready: ${cfg.reason}` });
  const idemKey = String(b.idempotencyKey || '').trim().slice(0, 80);
  if (idemKey) {
    const seen = await recent(`${IDEM}${hash(idemKey)}`);
    if (seen) return res.json({ ...seen.result, repeated: true });
  }
  const moduleName = ['HRMS', 'ATS', 'Job Portal', 'Omnichannel', 'Test', 'Other'].includes(b.module) ? b.module : 'Other';
  const results = []; const seenNumbers = new Set();
  for (const r of list) {
    const m = core.normalizeMobile(r && r.mobile);
    const name = String((r && r.name) || '').trim().slice(0, 80);
    if (!m.ok) { results.push({ to: String((r && r.mobile) || ''), name, status: 'Skipped', error: m.reason }); continue; } // eslint-disable-line no-continue
    if (seenNumbers.has(m.e164)) { results.push({ to: m.e164, name, status: 'Skipped', error: 'Same number twice in this list: sent once.' }); continue; } // eslint-disable-line no-continue
    seenNumbers.add(m.e164);
    const w = wording(t, { name }, b.variables);
    if (w.missing.length) { results.push({ to: m.e164, name, status: 'Skipped', error: `A value is missing for: ${w.missing.join(', ')}.` }); continue; } // eslint-disable-line no-continue
    // the same words to the same number within two minutes are one SMS, not two (a double click, a retried request)
    const repeatKey = `${IDEM}r.${hash(`${m.e164}|${w.text}`)}`;
    // eslint-disable-next-line no-await-in-loop
    if (!b.allowRepeat && await recent(repeatKey)) { results.push({ to: m.e164, name, status: 'Skipped', error: 'The same message went to this number a moment ago, so it was not sent again.' }); continue; } // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const out = await channels.send('SMS', {
      to: m.e164, kind: 'bulk', text: w.text, templateId: t.dltTemplateId, senderId: t.senderId || undefined, providerOnly: PROVIDER_ID,
      meta: { module: moduleName, personName: name || null, senderUserId: req.user.id, senderName: req.user.name, template: t.name, purpose: 'SMS_PLATFORM', preview: w.text },
    });
    if (out.ok) {
      // eslint-disable-next-line no-await-in-loop
      await remember(repeatKey, { at: new Date().toISOString(), ttl: REPEAT_WINDOW_MS });
      results.push({ to: m.e164, name, status: out.queued ? 'Queued' : 'Submitted', providerRef: out.providerRef || null, sandbox: !!out.sandbox });
    } else {
      results.push({ to: m.e164, name, status: out.unknown ? 'Unknown' : (out.invalid ? 'Skipped' : 'Failed'), error: out.error || 'Not sent' });
    }
  }
  const counts = results.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
  const body = { ok: !!(counts.Submitted || counts.Queued), count: results.length, counts, results, template: t.name };
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: `SMS sent from the SMS Push Platform (${moduleName})`, entity: 'Sms', entityId: t.id, toValue: `${results.length} recipient(s): ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}` });
  if (idemKey) await remember(`${IDEM}${hash(idemKey)}`, { at: new Date().toISOString(), ttl: 10 * 60 * 1000, result: body });
  res.json(body);
}));

// ---- history -------------------------------------------------------------------------
const range = (q) => {
  const to = q.to ? new Date(`${q.to}T23:59:59`) : new Date();
  const from = q.from ? new Date(`${q.from}T00:00:00`) : new Date(Date.now() - 6 * 86400000);
  return { from, to };
};
router.get('/history', wrap(async (req, res) => {
  const { from, to } = range(req.query);
  const rows = (await smsRecords({ from, to, status: req.query.status, module: req.query.module, template: req.query.template, q: req.query.q }))
    .filter((r) => !req.query.submission || shapeRow(r).submission === req.query.submission);
  const page = Math.max(1, Number(req.query.page) || 1); const size = Math.min(100, Math.max(5, Number(req.query.size) || 25));
  res.json({ total: rows.length, page, size, rows: rows.slice((page - 1) * size, page * size).map(shapeRow) });
}));

router.get('/history.csv', wrap(async (req, res) => {
  const { from, to } = range(req.query);
  const rows = (await smsRecords({ from, to, status: req.query.status, module: req.query.module, template: req.query.template, q: req.query.q })).map(shapeRow);
  const esc = (v) => { let s = String(v == null ? '' : v); if (/^[=+\-@]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; }; // a cell can never run as a formula
  const head = ['Date and time', 'Recipient', 'Source module', 'Template', 'Message preview', 'Sender ID', 'Provider message id', 'Submission', 'Delivery', 'Error', 'Retries', 'Sent by'];
  const lines = [head.map(esc).join(',')].concat(rows.map((r) => [new Date(r.at).toLocaleString('en-IN'), r.recipient, r.module, r.template, r.preview, r.senderId, r.providerRef, r.submission, r.delivery, r.error, r.retries, r.by].map(esc).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="sms-history.csv"');
  res.send(`﻿${lines.join('\r\n')}`);
}));

router.get('/history/detail', wrap(async (req, res) => {
  let rec = req.query.ref ? await store.byRef(String(req.query.ref)) : null;
  if (!rec && req.query.id) {
    const all = await store.list({ channel: 'SMS', provider: PROVIDER_ID, from: new Date(Date.now() - 119 * 86400000), to: new Date() }, { limit: 20000 });
    rec = all.find((r) => r.id === String(req.query.id)) || null;
  }
  if (!rec) return res.status(404).json({ error: 'No such SMS record.' });
  const { _key, ...clean } = rec; // eslint-disable-line no-unused-vars
  return res.json({ ...shapeRow(clean), history: (clean.history || []).map((h) => ({ at: h.at, status: STATUS_WORD[h.status] || h.status, detail: h.detail || null })) });
}));

// ---- dashboard --------------------------------------------------------------------------
router.get('/dashboard', wrap(async (req, res) => {
  const { from, to } = range(req.query);
  const rows = await smsRecords({ from, to, module: req.query.module });
  const by = (f) => rows.filter(f).length;
  const total = rows.length;
  const delivered = by((r) => ['delivered', 'read'].includes(r.status));
  const failed = by((r) => r.status === 'failed' && !r.unknown);
  const unknown = by((r) => r.status === 'failed' && r.unknown);
  const accepted = by((r) => !submissionFailed(r));
  const pending = by((r) => ['queued', 'sent'].includes(r.status));
  const modules = {};
  rows.forEach((r) => { const k = r.module || 'Other'; modules[k] = (modules[k] || 0) + 1; });
  const cfg = await sms.smsConfig();
  res.json({
    from: from.toISOString(), to: to.toISOString(),
    counts: { requests: total, submitted: accepted, delivered, failed, unknown, pendingReports: pending },
    successRate: accepted ? Math.round((delivered / accepted) * 1000) / 10 : null,
    note: 'Counts are what TeamLink recorded. "Delivered" appears only when the provider\'s own delivery report says so.',
    credits: null,
    creditsNote: cfg.provider === 'SMSGW' ? 'The provider has no documented balance call, so no balance is shown. Check the provider portal.' : 'Balance is shown on the Test connection result when the provider supports it.',
    byModule: Object.entries(modules).map(([module, count]) => ({ module, count })).sort((a, b) => b.count - a.count),
    recent: rows.slice(0, 10).map(shapeRow),
  });
}));

module.exports = router;
