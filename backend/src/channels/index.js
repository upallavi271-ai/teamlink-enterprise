// ---------------------------------------------------------------------------
// CHANNEL ADAPTER LAYER — one door for WhatsApp and SMS, whichever provider carries the message.
//
//   whatsapp.cloud   official Meta Cloud API            (utils/whatsappCloud.js, wrapped below)
//   whatsapp.qr      unofficial QR-link PROTOTYPE       (channels/whatsappQr.js + the separate worker)
//   sms.android      an Android phone as SMS gateway    (channels/androidSms.js)
//   sms.gateway      paid gateway MSG91/Fast2SMS/Twilio (utils/smsGateway.js, wrapped below)
//
// Every provider has the same shape:
//   { id, channel, label, config() -> { configured, reason, detail },
//     send(message) -> { ok, providerRef, status, error, retryable, ... }   (never throws)
//     health() -> { ok, message },  test() -> { ok, result } }
// message = { to, kind, text, vars, templateId, senderId, template, media: [{path,name,mime}], meta: {...} }
//
// WHICH provider: Administration > Integrations > WhatsApp & SMS (channels/settings.js): the first provider per channel and
// "try the next one when it is not available". A message that cannot go on the first provider (not connected, phone offline,
// daily cap reached, refused by the provider) goes on the next one. A message that was refused because the PERSON must not get it
// (no consent, STOP, bad number) is never tried elsewhere. When nothing can send, the caller gets
// { ok:false, notConfigured:true } and the screens fall back to "Open in your app". The consent / STOP / quiet-hours / de-dupe /
// daily-cap / test-record rules are applied BEFORE this layer (utils/bulkMessaging.buildPlan), and the STOP + test-record rules again here.
// ---------------------------------------------------------------------------
const settings = require('./settings');
const store = require('./store');
const qr = require('./whatsappQr');
const android = require('./androidSms');

const TEST_RECORD = /zztest|example\.test/i;

// which number a WhatsApp message may leave from (utils/waNumbers.js resolveSender): who sends it, what they chose, or "automatic"
function routingOf(m) {
  const meta = m.meta || {};
  return { numberId: m.numberId || meta.numberId || null, userId: m.actorUserId || meta.senderUserId || null, automatic: !!(m.automatic || meta.automatic), department: m.department || meta.department || null, purpose: meta.purpose || null };
}

const adapters = {
  'whatsapp.cloud': {
    id: 'whatsapp.cloud', channel: 'WhatsApp',
    async config() {
      const c = await require('../utils/whatsappCloud').whatsappConfig(); // eslint-disable-line global-require
      let configured = !!c.configured; let reason = c.reason || ''; let more = '';
      // WhatsApp numbers list (utils/waNumbers.js): the channel is ready when ANY number of the list can send
      try {
        const WN = require('../utils/waNumbers'); // eslint-disable-line global-require
        if (await WN.hasNumbers()) { const a = await WN.anyUsable(); configured = a.ok; reason = a.ok ? '' : (a.reason || reason); more = ` · ${a.count} number${a.count === 1 ? '' : 's'}`; }
      } catch { /* the old reading stands */ }
      return { configured, reason, detail: `Cloud API${c.display ? ` · ${c.display}` : ''}${more}${c.testMode ? ' (test server)' : ''}`, raw: c };
    },
    async send(m) {
      const wa = require('../utils/whatsappCloud'); // eslint-disable-line global-require
      const cloud = require('./cloud'); // eslint-disable-line global-require
      // WHICH NUMBER: the person sending (meta.senderUserId / actorUserId), the number they chose, or - for system messages - the system number (utils/waNumbers.js)
      const route = routingOf(m);
      const r = m.media && m.media.length ? await cloud.sendWithMedia({ ...m, ...route }) : await wa.sendWhatsApp({ to: m.to, kind: m.kind, text: m.text, vars: m.vars, template: m.template, meta: m.meta, ...route });
      return { ...r, retryable: !!r.transient, unavailable: !!(r.notConfigured || r.transient), status: r.ok ? 'sent' : 'failed' };
    },
    async health() { const t = await require('../utils/whatsappCloud').testConnection(); return { ok: !!t.ok, message: t.result }; }, // eslint-disable-line global-require
    async test() { return require('../utils/whatsappCloud').testConnection(); }, // eslint-disable-line global-require
  },
  'whatsapp.qr': {
    id: 'whatsapp.qr', channel: 'WhatsApp',
    async config() { const c = await qr.qrConfig(); return { configured: c.configured, reason: c.reason, detail: `QR-linked ${qr.maskedPhone(c.state.phone) || 'number'} (prototype)` }; },
    send: (m) => qr.send(m), health: () => qr.health(),
    async test() { const h = await qr.health(); return { ok: h.ok, result: h.message }; },
  },
  'sms.android': {
    id: 'sms.android', channel: 'SMS',
    async config() { const c = await android.androidConfig(); return { configured: c.configured, reason: c.reason, detail: `Android phone (${c.mode})${c.testMode ? ' (test server)' : ''}` }; },
    send: (m) => android.send(m), health: () => android.health(), test: () => android.test(),
  },
  'sms.gateway': {
    id: 'sms.gateway', channel: 'SMS',
    async config() {
      const c = await require('../utils/smsGateway').smsConfig(); // eslint-disable-line global-require
      return { configured: !!c.configured, reason: c.reason || '', detail: `${c.providerLabel || ''}${c.testMode ? ' (test server)' : ''}`.trim(), provider: c.providerLabel || null, raw: c };
    },
    async send(m) {
      const r = await require('../utils/smsGateway').sendSms({ to: m.to, kind: m.kind, text: m.text, vars: m.vars, templateId: m.templateId, senderId: m.senderId }); // eslint-disable-line global-require
      return { ...r, retryable: !!r.transient, unavailable: !!(r.notConfigured || r.transient), status: r.ok ? 'sent' : 'failed' };
    },
    async health() { const t = await require('../utils/smsGateway').testConnection(); return { ok: !!t.ok, message: t.result }; }, // eslint-disable-line global-require
    async test() { return require('../utils/smsGateway').testConnection(); }, // eslint-disable-line global-require
  },
};

const channelOf = (id) => (adapters[id] ? adapters[id].channel : null);

// Ordered providers of a channel with their readiness: [{ id, label, short, ready, reason, detail }]
async function providers(channel) {
  const s = await settings.load();
  const ids = settings.order(s, channel);
  const out = [];
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    const c = await adapters[id].config().catch((e) => ({ configured: false, reason: String(e.message) }));
    out.push({ id, label: settings.LABELS[id], short: settings.SHORT[id], ready: !!c.configured, reason: c.reason || '', detail: c.detail || '', provider: c.provider || null, raw: c.raw });
  }
  return out;
}

// What a screen / the planner needs to know about one channel.
async function status(channel) {
  const list = await providers(channel);
  const first = list.find((p) => p.ready) || null;
  return {
    channel, ordered: list.map(({ raw, ...p }) => p), ready: list.filter((p) => p.ready).map((p) => p.id),
    configured: !!first, provider: first ? first.id : null, via: first ? first.label : null,
    detail: first ? first.detail : null, providerLabel: first && first.provider ? first.provider : null,
    reason: first ? null : ((list[0] && list[0].reason) || 'Not set up'), reasons: list.map((p) => `${p.short}: ${p.reason || 'ready'}`),
    list,
  };
}

function usage(id) { return store.usage(id); }

// Which part of TeamLink a message came from (reports group by this). A caller can say it (meta.module); else it is read from who the message was for.
function moduleOf(meta) {
  if (meta.jobId) return 'Omnichannel';
  if (meta.audience === 'employee') return 'HRMS';
  if (meta.audience === 'candidate' || meta.audience === 'client') return 'ATS';
  return 'Other';
}

function recordArgs(channel, m, id, res, extra = {}) {
  const meta = m.meta || {};
  return {
    channel, provider: id, to: m.to, personType: meta.audience || null, personId: meta.personId || null, personName: meta.personName || null,
    senderUserId: meta.senderUserId || null, senderName: meta.senderName || null, template: meta.template || meta.purpose || null, purpose: meta.purpose || null,
    status: res.ok ? (res.queued ? 'queued' : 'sent') : 'failed', error: res.ok ? null : res.error, providerRef: res.providerRef || null,
    jobId: meta.jobId || null, attachments: (m.media || []).map((x) => x.name), retries: meta.attempt ? Math.max(0, meta.attempt - 1) : 0, masked: !!meta.masked,
    detail: extra.detail || null, numberId: res.numberId || null, numberLabel: res.numberLabel || null,
    module: meta.module || moduleOf(meta), preview: meta.preview || null, dltTemplateId: m.templateId || null, senderIdUsed: m.senderId || null, unknown: !!res.unknown,
    // SMS Push Platform: the acknowledgement id its Pull DLR API is asked with (utils/smsPushDlr.js)
    ackId: res.ackId || null,
  };
}

// opts: { to, kind, text, vars, templateId, senderId, template, media, meta, providerOnly }
// Returns { ok, provider, via, providerRef, queued, status, error, retryable, transient, notConfigured, invalid, attempts[] } - never throws.
async function send(channel, opts = {}) {
  const attempts = [];
  try {
    const s = await settings.load();
    const meta = opts.meta || {};
    if (!require('../utils/sandbox').isSandbox() && (TEST_RECORD.test(String(meta.personName || '')) || TEST_RECORD.test(String(opts.to || '')))) { // eslint-disable-line global-require
      return { ok: false, invalid: true, transient: false, retryable: false, error: 'Test record: never messaged', attempts };
    }
    const ids = opts.providerOnly && adapters[opts.providerOnly] && channelOf(opts.providerOnly) === channel
      ? [opts.providerOnly] : settings.order(s, channel);
    let last = null;
    for (const id of ids) {
      const a = adapters[id];
      // eslint-disable-next-line no-await-in-loop
      const cfg = await a.config().catch((e) => ({ configured: false, reason: String(e.message) }));
      if (!cfg.configured) { attempts.push({ provider: id, status: 'skipped', reason: cfg.reason }); last = last || { notConfigured: true, error: cfg.reason, provider: id }; continue; } // eslint-disable-line no-continue
      let res;
      try {
        // eslint-disable-next-line no-await-in-loop
        res = await a.send({ ...opts, media: id === 'sms.android' || id === 'sms.gateway' ? [] : opts.media });
      } catch (e) { res = { ok: false, retryable: false, error: `Internal error: ${String(e && e.message).slice(0, 200)}` }; }
      if (res.ok) {
        attempts.push({ provider: id, status: res.queued ? 'queued' : 'sent' });
        const detail = attempts.filter((x) => x.status === 'skipped' || x.status === 'failed').map((x) => `${settings.SHORT[x.provider]}: ${x.reason}`).join(' | ');
        // eslint-disable-next-line no-await-in-loop
        await store.record(recordArgs(channel, opts, id, res, { detail: detail ? `Sent on ${settings.SHORT[id]} after: ${detail}` : null }));
        return { ...res, provider: id, via: res.numberLabel ? `${settings.LABELS[id]} - ${res.numberLabel}` : settings.LABELS[id], attempts, notConfigured: false };
      }
      attempts.push({ provider: id, status: 'failed', reason: res.error });
      last = { ...res, provider: id };
      if (res.invalid) break; // the PERSON cannot be messaged: no other provider will change that
    }
    const out = last || { notConfigured: true, error: 'Nothing is connected for this channel.' };
    // every provider was only "not set up": say it like before (Not configured), with the first provider's reason
    const onlySkipped = attempts.length > 0 && attempts.every((x) => x.status === 'skipped');
    const res = { ok: false, ...out, notConfigured: onlySkipped || !!out.notConfigured && !out.transient, attempts, error: onlySkipped ? (attempts[0].reason || out.error) : out.error };
    if (!onlySkipped && !res.invalid) {
      await store.record(recordArgs(channel, opts, out.provider || ids[0], { ok: false, error: res.error }, { detail: attempts.map((x) => `${settings.SHORT[x.provider]}: ${x.reason || x.status}`).join(' | ') }));
    }
    return res;
  } catch (err) {
    return { ok: false, transient: false, retryable: false, error: `Internal error: ${String(err && err.message).slice(0, 200)}`, attempts };
  }
}

module.exports = { adapters, providers, status, send, usage, channelOf, TEST_RECORD };
