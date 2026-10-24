// ---------------------------------------------------------------------------
// /api/comm — the Communication Automation module (docs/communication/API.md).
//
//   GET  /overview                       providers per channel, which goes first, caps / usage / health (Admin sees all)
//   GET  /providers?channel=             what a Contact dialog shows: "WhatsApp via ... will be used"
//   PUT  /settings                       Admin: company switches, first provider + fallback, QR / Android caps
//   GET  /status?ref=                    live status ticks of one message (queued -> sent -> delivered -> read / failed)
//   GET  /log  /log.xlsx  /log.pdf       the Communication log (filters + counts + exports)
//   QR   GET /qr/state  POST /qr/enable | disable | start | stop | resume | unlink | kill | clear-queue   (Admin)
//   ANDROID  GET/PUT /android/config  POST /android/test | test-sms | connect | disconnect | register-webhooks   (Admin)
//   GET  /qr/selftest                    Admin: a QR picture of a known address, to prove the picture generator with any phone camera
// Every route needs a login; staff routes need a Contact right somewhere; configuration is Admin / Super Admin only.
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const prisma = require('../db');
const channels = require('../channels');
const settings = require('../channels/settings');
const store = require('../channels/store');
const qr = require('../channels/whatsappQr');
const android = require('../channels/androidSms');
const access = require('../utils/contactAccess');
const T = require('../utils/messageTemplates');
const { scopeOf } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const { integrationById } = require('../utils/adminCatalog');
const { publicValuesFor, writeValues, integrationRow, recordEvent } = require('../utils/integrationStore');
const { limiter } = require('../channels/rateLimit');

const router = express.Router();
router.use(requireAuth);

const external = (u) => ['CLIENT', 'CANDIDATE'].includes(u.role) || ['CLIENT', 'CANDIDATE'].includes(u.atsRole);
const wrap = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };
const adminOnly = (req, res, next) => {
  if (!T.isAdmin(req.user)) return res.status(403).json({ error: 'Only an Admin or Super Admin can change this.' });
  return next();
};
async function mayContactAnyone(user) {
  if (external(user)) return false;
  for (const a of access.AUDIENCES) {
    // eslint-disable-next-line no-await-in-loop
    if ((await access.ruleFor(user, a)).allowed) return true;
  }
  return false;
}
async function staffOnly(req, res, next) {
  try {
    if (T.isAdmin(req.user) || await mayContactAnyone(req.user)) return next();
    return res.status(403).json({ error: 'Not available to this login.' });
  } catch (e) { return next(e); }
}

const webhookBase = (req) => String(process.env.APP_BASE_URL || '').replace(/\/+$/, '') || `${req.protocol}://${req.get('host')}`;
const clean = (p) => ({ id: p.id, label: p.label, short: p.short, ready: p.ready, reason: p.reason, detail: p.detail });

// ---- what a screen needs --------------------------------------------------------
async function cards() {
  const out = {};
  const s = await settings.load({ fresh: true });
  for (const id of Object.keys(settings.LABELS)) {
    // eslint-disable-next-line no-await-in-loop
    const [u, cfg] = await Promise.all([store.usage(id), channels.adapters[id].config().catch(() => ({ configured: false, reason: '' }))]);
    const caps = id === 'whatsapp.qr' ? settings.effectiveQr(s) : (id === 'sms.android' ? s.android : null);
    out[id] = {
      id, label: settings.LABELS[id], short: settings.SHORT[id], ready: !!cfg.configured, reason: cfg.reason || '', detail: cfg.detail || '',
      usage: { sentToday: u.today, sentThisHour: u.hour, waiting: u.queued, failed: u.failed, lastError: u.lastError, replies: u.inbound },
      caps: caps ? { perHour: caps.perHour, perDay: caps.perDay } : null,
    };
  }
  return out;
}

router.get('/overview', staffOnly, wrap(async (req, res) => {
  const [wa, sms, s] = await Promise.all([channels.status('WhatsApp'), channels.status('SMS'), settings.load({ fresh: true })]);
  const admin = T.isAdmin(req.user);
  const base = {
    channels: {
      WhatsApp: { configured: wa.configured, via: wa.via, provider: wa.provider, providers: wa.ordered.map(clean), switchOn: s.switches.WhatsApp },
      SMS: { configured: sms.configured, via: sms.via, provider: sms.provider, providers: sms.ordered.map(clean), switchOn: s.switches.SMS },
    },
    isAdmin: admin,
  };
  if (!admin) return res.json(base);
  const [cardList, qrState, health] = await Promise.all([cards(), qr.getState(), android.lastHealth()]);
  return res.json({
    ...base, settings: { ...s, qr: { ...s.qr, effective: settings.effectiveQr(s) } }, bounds: settings.BOUNDS, cards: cardList,
    qr: { state: qrState.state, label: qrState.label, alive: qrState.alive, phone: qr.maskedPhone(qrState.phone), reason: qrState.reason || null },
    android: { lastHealth: health },
    publicAddressSet: !!process.env.APP_BASE_URL,
  });
}));

// For the Contact dialog: which number / provider will carry the message, in plain words.
router.get('/providers', staffOnly, wrap(async (req, res) => {
  const channel = ['WhatsApp', 'SMS'].includes(req.query.channel) ? req.query.channel : null;
  if (!channel) return res.status(400).json({ error: 'Say WhatsApp or SMS.' });
  const st = await channels.status(channel);
  const s = await settings.load();
  const qrFirst = st.provider === 'whatsapp.qr';
  res.json({
    channel, configured: st.configured, provider: st.provider, via: st.via, switchOn: s.switches[channel],
    providers: st.ordered.map(clean),
    prototype: qrFirst, warning: qrFirst ? 'Prototype: unofficial. Do not send to many people at once; the number can get banned.' : null,
    templateRule: st.provider === 'whatsapp.cloud' ? 'Official WhatsApp starts a chat only with an approved template. Plain text works for 24 hours after they write to you.' : null,
    attachments: channel === 'WhatsApp',
    reason: st.configured ? null : st.reason,
  });
}));

router.put('/settings', adminOnly, wrap(async (req, res) => {
  const out = await settings.save(req.user, req.body || {});
  res.json({ settings: out.settings, changed: out.changed });
}));

// ---- status ticks ------------------------------------------------------------------
const LABEL = { queued: 'Queued', sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Failed' };
async function canSeeRecord(user, rec) {
  if (T.isAdmin(user) || scopeOf(user).global) return true;
  return !!rec.senderUserId && rec.senderUserId === user.id;
}
function shapeRecord(rec, masked) {
  return {
    id: rec.id, at: rec.at, direction: rec.direction, channel: rec.channel, provider: rec.provider, providerLabel: settings.SHORT[rec.provider] || rec.provider,
    via: settings.LABELS[rec.provider] || null, to: masked ? access.maskAddress(rec.channel, rec.to) : rec.to, personType: rec.personType, personId: rec.personId, personName: rec.personName,
    senderName: rec.senderName, senderUserId: rec.senderUserId, template: rec.template, status: rec.status, statusLabel: LABEL[rec.status] || rec.status, error: rec.error,
    retries: rec.retries || 0, attachments: rec.attachments || [], jobId: rec.jobId, cost: rec.cost, history: (rec.history || []).map((h) => ({ ...h, label: LABEL[h.status] || h.status })),
  };
}
const maskedFor = async (user) => {
  for (const a of access.AUDIENCES) {
    // eslint-disable-next-line no-await-in-loop
    const r = await access.ruleFor(user, a);
    if (r.allowed && r.mode === 'masked') return true;
  }
  return false;
};

router.get('/status', staffOnly, wrap(async (req, res) => {
  const ref = String(req.query.ref || '').slice(0, 200);
  let rec = await store.byRef(ref);
  if (!rec) return res.status(404).json({ error: 'No record of this message.' });
  if (!(await canSeeRecord(req.user, rec))) return res.status(403).json({ error: 'This message is not yours.' });
  // The phone could not reach our webhook? Ask it (only for an old, still-queued Android message).
  if (rec.provider === 'sms.android' && ['queued', 'sent'].includes(rec.status) && Date.now() - new Date(rec.at).getTime() > 15000) {
    const polled = await android.pollStatus(ref).catch(() => null);
    if (polled) {
      await require('../utils/messageDelivery').applyStatus({ channel: 'SMS', providerRef: ref, status: polled.status, error: polled.error }); // eslint-disable-line global-require
      rec = await store.byRef(ref);
    }
  }
  return res.json({ message: shapeRecord(rec, await maskedFor(req.user)) });
}));

// ---- Communication log -------------------------------------------------------------
function filtersOf(q) {
  return {
    from: q.from || null, to: q.to ? new Date(`${String(q.to).slice(0, 10)}T23:59:59`) : null, channel: ['WhatsApp', 'SMS'].includes(q.channel) ? q.channel : null,
    provider: settings.LABELS[q.provider] ? q.provider : null, status: ['queued', 'sent', 'delivered', 'read', 'failed'].includes(q.status) ? q.status : null,
    senderId: q.sender || null, personId: q.candidate || q.person || null, q: q.q || null, direction: ['OUT', 'IN'].includes(q.direction) ? q.direction : null,
  };
}
async function logRows(req) {
  const f = filtersOf(req.query);
  const global = T.isAdmin(req.user) || scopeOf(req.user).global;
  let rows = await store.list({ ...f, from: f.from ? new Date(`${String(f.from).slice(0, 10)}T00:00:00`) : null, senderId: global ? f.senderId : req.user.id });
  if (!global) rows = rows.filter((r) => r.direction === 'OUT' ? r.senderUserId === req.user.id : false);
  const masked = await maskedFor(req.user);
  return { rows: rows.map((r) => shapeRecord(r, masked)), global };
}
const count = (rows, key) => rows.reduce((m, r) => { m[r[key] || 'unknown'] = (m[r[key] || 'unknown'] || 0) + 1; return m; }, {});

router.get('/log', staffOnly, wrap(async (req, res) => {
  const { rows, global } = await logRows(req);
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(200, Math.max(10, Number(req.query.size) || 50));
  // sender choices for the filter (only people who really sent)
  const senders = global ? [...new Map(rows.filter((r) => r.senderUserId).map((r) => [r.senderUserId, r.senderName || 'Unknown'])).entries()].map(([id, name]) => ({ id, name })) : [];
  res.json({
    total: rows.length, page, size, rows: rows.slice((page - 1) * size, page * size), senders,
    counts: { status: count(rows, 'status'), provider: count(rows, 'provider'), channel: count(rows, 'channel') }, scope: global ? 'all' : 'mine',
  });
}));

const EXPORT_HEAD = ['When', 'Direction', 'Channel', 'Provider', 'To', 'Person', 'Sent by', 'Template', 'Status', 'Retries', 'Attachments', 'Problem'];
const exportRows = (rows) => rows.map((r) => [new Date(r.at).toLocaleString('en-IN'), r.direction === 'IN' ? 'Received' : 'Sent', r.channel, r.providerLabel || '', r.to || '', r.personName || '', r.senderName || '', r.template || '', r.statusLabel, r.retries, (r.attachments || []).join(', '), r.error || '']);

router.get('/log.xlsx', staffOnly, wrap(async (req, res) => {
  const { rows } = await logRows(req);
  const buf = await require('../utils/tabularExport').toXlsx(EXPORT_HEAD, exportRows(rows), 'Communication log'); // eslint-disable-line global-require
  res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="communication-log.xlsx"' });
  res.send(Buffer.from(buf));
}));
router.get('/log.pdf', staffOnly, wrap(async (req, res) => {
  const { rows } = await logRows(req);
  const buf = await require('../utils/tabularExport').toPdf(EXPORT_HEAD, exportRows(rows), { title: 'Communication log', subtitle: `${rows.length} messages` }); // eslint-disable-line global-require
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="communication-log.pdf"' });
  res.send(Buffer.from(buf));
}));

// ---- QR-link prototype (Admin) -----------------------------------------------------------
const QR_ID = 'whatsapp-qr';
async function qrView() {
  const [c, st, s, svg, u, waiting] = await Promise.all([qr.qrConfig(), qr.getState(), settings.load({ fresh: true }), qr.qrSvg(), store.usage('whatsapp.qr'), qr.queueRows('queued')]);
  const sc = await qr.sentCounts();
  return {
    enabled: c.enabled, ack: s.qr.ack, killSwitch: s.qr.killSwitch, state: st.state, label: st.state === 'connected' && st.phone ? `Connected as ${qr.maskedPhone(st.phone)}` : st.label,
    phone: qr.maskedPhone(st.phone), alive: st.alive, reason: st.reason || null, paused: !!st.paused, qrSvg: svg, caps: settings.effectiveQr(s), settings: s.qr,
    usage: { sentToday: sc.day, sentThisHour: sc.hour, waiting: waiting.length, failed: u.failed, lastError: u.lastError, replies: u.inbound },
    warning: 'Prototype: unofficial, can get the number banned, use a spare number.', configured: c.configured, problems: c.problems,
  };
}
router.get('/qr/state', adminOnly, wrap(async (req, res) => res.json(await qrView())));

router.post('/qr/enable', adminOnly, wrap(async (req, res) => {
  if (!(req.body && req.body.understand === true)) return res.status(400).json({ error: 'Tick "I understand" first: this is unofficial and the number can get banned.' });
  await settings.acknowledgeQr(req.user);
  await integrationRow(QR_ID);
  const label = String((req.body && req.body.label) || '').slice(0, 60);
  await prisma.integration.update({ where: { id: QR_ID }, data: { enabled: true, connected: false, state: 'Not Connected', error: null, ...(label ? { values: JSON.stringify({ [require('../utils/adminCatalog').QR_FIELDS.label]: label }) } : {}) } }); // eslint-disable-line global-require
  await recordEvent(QR_ID, { action: 'Enabled', by: req.user.name, result: 'Switched on after the "I understand" confirmation' });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'WhatsApp QR prototype switched on', entity: 'Integration', entityId: QR_ID, toValue: 'on' });
  res.json(await qrView());
}));
router.post('/qr/disable', adminOnly, wrap(async (req, res) => {
  await integrationRow(QR_ID);
  await prisma.integration.update({ where: { id: QR_ID }, data: { enabled: false, connected: false, state: 'Not Connected' } });
  await qr.stop();
  await recordEvent(QR_ID, { action: 'Disabled', by: req.user.name, result: 'Switched off' });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'WhatsApp QR prototype switched off', entity: 'Integration', entityId: QR_ID, toValue: 'off' });
  res.json(await qrView());
}));
router.post('/qr/start', adminOnly, wrap(async (req, res) => {
  const out = await qr.start();
  if (!out.ok) return res.status(out.running ? 409 : 400).json({ error: out.error });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'WhatsApp QR worker started', entity: 'Integration', entityId: QR_ID, toValue: `pid ${out.pid}` });
  return res.json({ ...(await qrView()), started: true });
}));
router.post('/qr/stop', adminOnly, wrap(async (req, res) => {
  await qr.stop();
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'WhatsApp QR worker stop requested', entity: 'Integration', entityId: QR_ID });
  res.json(await qrView());
}));
router.post('/qr/resume', adminOnly, wrap(async (req, res) => {
  await qr.sendControl('resume');
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'WhatsApp QR sending resumed', entity: 'Integration', entityId: QR_ID });
  res.json(await qrView());
}));
router.post('/qr/unlink', adminOnly, wrap(async (req, res) => {
  await qr.sendControl('logout');
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'WhatsApp QR number unlinked', entity: 'Integration', entityId: QR_ID });
  res.json(await qrView());
}));
router.post('/qr/kill', adminOnly, wrap(async (req, res) => {
  const on = !!(req.body && req.body.on);
  await settings.save(req.user, { qr: { killSwitch: on } });
  if (on) { await qr.sendControl('stop'); await qr.cancelWaiting(); }
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: `WhatsApp QR kill switch ${on ? 'ON' : 'off'}`, entity: 'Integration', entityId: QR_ID, toValue: on ? 'on' : 'off' });
  res.json(await qrView());
}));
router.post('/qr/clear-queue', adminOnly, wrap(async (req, res) => {
  const n = await qr.cancelWaiting();
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'WhatsApp QR waiting messages cancelled', entity: 'Integration', entityId: QR_ID, toValue: `${n} cancelled` });
  res.json({ ...(await qrView()), cancelled: n });
}));
router.get('/qr/selftest', adminOnly, wrap(async (req, res) => {
  res.type('image/svg+xml').send(require('../utils/qrCode').toSvg('https://www.example.com/teamlink-qr-selftest', { ecc: 'M', border: 3, scale: 6 })); // eslint-disable-line global-require
}));

// ---- Android phone gateway (Admin) ---------------------------------------------------------
const AND_ID = 'sms-android';
async function androidView(req) {
  const channel = integrationById(AND_ID);
  const row = await integrationRow(AND_ID);
  const pub = publicValuesFor(channel, row);
  const [cfg, health, u] = await Promise.all([android.androidConfig(), android.lastHealth(), store.usage('sms.android')]);
  const s = await settings.load({ fresh: true });
  const root = webhookBase(req);
  return {
    fields: channel.fields, values: pub.values, secretHints: pub.secretHints, secretFields: pub.secretFields, enabled: row.enabled, state: row.state,
    configured: cfg.configured, problems: cfg.problems, mode: cfg.mode, health, lastTest: row.lastTest, lastTestResult: row.lastTestResult,
    caps: s.android, usage: { sentToday: u.today, sentThisHour: u.hour, failed: u.failed, lastError: u.lastError, replies: u.inbound },
    webhook: { url: `${root}/api/webhooks/sms-android`, keyUrl: `${root}/api/webhooks/sms-android?key=<your shared word>`, publicAddressSet: !!process.env.APP_BASE_URL },
  };
}
router.get('/android/config', adminOnly, wrap(async (req, res) => res.json(await androidView(req))));
router.put('/android/config', adminOnly, wrap(async (req, res) => {
  let written;
  try { written = await writeValues(AND_ID, (req.body && req.body.values) || {}); } catch (err) {
    if (err && err.code === 'NO_SECRET_KEY') return res.status(400).json({ error: err.message });
    throw err;
  }
  if (!written.filled) return res.status(400).json({ error: 'Type the phone address and the login first.' });
  await integrationRow(AND_ID);
  await prisma.integration.update({ where: { id: AND_ID }, data: { values: JSON.stringify(written.values), enabled: true, connected: true, state: 'Connected', connectedAt: new Date(), error: null } });
  await recordEvent(AND_ID, { action: 'Connected', by: req.user.name, result: 'Settings saved (password encrypted at rest)' });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Android SMS phone configured', entity: 'Integration', entityId: AND_ID, toValue: 'Connected' });
  res.json(await androidView(req));
}));
router.post('/android/connect', adminOnly, wrap(async (req, res) => {
  const row = await integrationRow(AND_ID);
  if (!row.values) return res.status(400).json({ error: 'Save the phone settings first.' });
  await prisma.integration.update({ where: { id: AND_ID }, data: { enabled: true, connected: true, state: 'Connected', error: null } });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Android SMS phone connected', entity: 'Integration', entityId: AND_ID, toValue: 'Connected' });
  res.json(await androidView(req));
}));
router.post('/android/disconnect', adminOnly, wrap(async (req, res) => {
  await integrationRow(AND_ID);
  await prisma.integration.update({ where: { id: AND_ID }, data: { enabled: false, connected: false, state: 'Not Connected' } });
  await recordEvent(AND_ID, { action: 'Disconnected', by: req.user.name, result: 'OK' });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Android SMS phone disconnected', entity: 'Integration', entityId: AND_ID, toValue: 'Not Connected' });
  res.json(await androidView(req));
}));
router.post('/android/test', adminOnly, wrap(async (req, res) => {
  const probe = await android.test();
  await integrationRow(AND_ID);
  await prisma.integration.update({ where: { id: AND_ID }, data: { lastTest: new Date(), lastTestResult: probe.result.slice(0, 480), error: probe.ok ? null : probe.result.slice(0, 480) } });
  await recordEvent(AND_ID, { action: 'Test Connection', by: req.user.name, result: probe.result.slice(0, 480) });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Android SMS phone test', entity: 'Integration', entityId: AND_ID, toValue: probe.ok ? 'OK' : 'Failed' });
  res.status(probe.ok ? 200 : 502).json({ ok: probe.ok, result: probe.result });
}));
// "Send a test SMS to my own number": the number is TYPED by the Admin, goes only through the Android phone, one at a time.
router.post('/android/test-sms', adminOnly, limiter({ perMinute: 5 }), wrap(async (req, res) => {
  const to = String((req.body && req.body.to) || '').trim();
  if (!to) return res.status(400).json({ error: 'Type your own mobile number.' });
  const text = `TeamLink test SMS sent by ${req.user.name} through the Android phone. If you read this, it works.`;
  const out = await channels.send('SMS', { to, kind: 'manual', text, vars: [text], providerOnly: 'sms.android', meta: { purpose: 'Test SMS', senderUserId: req.user.id, senderName: req.user.name, personName: 'Admin test' } });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Android SMS test message', entity: 'Integration', entityId: AND_ID, toValue: out.ok ? 'queued on the phone' : String(out.error).slice(0, 200) });
  if (!out.ok) return res.status(out.notConfigured ? 409 : 502).json({ error: out.error, offline: !!out.offline });
  return res.json({ ok: true, providerRef: out.providerRef, note: out.sandbox ? 'Test server: the phone was not contacted.' : 'The phone has the message. Watch the Sent / Delivered ticks in the Communication log.' });
}));
// Ask the phone app to call our webhook for sent / delivered / failed / received (SMS Gateway for Android: POST /webhooks).
router.post('/android/register-webhooks', adminOnly, wrap(async (req, res) => {
  const cfg = await android.androidConfig();
  if (!cfg.configured) return res.status(409).json({ error: cfg.reason });
  if (cfg.style !== 'smsgate') return res.status(400).json({ error: 'Webhook registration works with the SMS Gateway for Android app. For other apps paste the link in their own settings.' });
  if (!process.env.APP_BASE_URL) return res.status(409).json({ error: 'Set APP_BASE_URL in the backend environment to the address the PHONE can reach this server on (for example http://192.168.1.10:4010), then try again.' });
  const core = require('../utils/messagingCore'); // eslint-disable-line global-require
  const base = String(process.env.APP_BASE_URL).replace(/\/+$/, '');
  const url = `${base}/api/webhooks/sms-android${cfg.hook ? `?key=${encodeURIComponent(cfg.hook)}` : ''}`;
  const results = [];
  for (const event of ['sms:sent', 'sms:delivered', 'sms:failed', 'sms:received']) {
    // eslint-disable-next-line no-await-in-loop
    const r = await core.httpJson(`${cfg.base}${cfg.mode === 'cloud' ? '/3rdparty/v1' : ''}/webhooks`, { method: 'POST', headers: android.authHeaders(cfg), body: JSON.stringify({ id: `teamlink-${event.replace(':', '-')}`, url, event }), timeoutMs: 8000 });
    results.push({ event, ok: r.ok, error: r.ok ? null : (r.networkError || (r.json && (r.json.message || r.json.error)) || `HTTP ${r.status}`) });
  }
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Android SMS webhooks registered on the phone', entity: 'Integration', entityId: AND_ID, toValue: results.map((x) => `${x.event}:${x.ok ? 'ok' : 'failed'}`).join(' ') });
  res.json({ results, url: url.replace(/key=[^&]+/, 'key=***') });
}));

module.exports = router;
