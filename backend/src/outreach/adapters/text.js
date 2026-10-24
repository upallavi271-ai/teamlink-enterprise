// ---------------------------------------------------------------------------
// TEXT CHANNEL ADAPTER FACTORY (WhatsApp and SMS campaigns, 2026-10-17). Same shape as the email adapter:
//   status()                 { ready, live, testMode, dailyCap, sentToday, reason }  is the channel connected (channels/index.js), and is it only in Test mode
//   sentToday(mode, now)     messages today (India day), counted from OutreachSendLog per mode
//   send(contact, message, opts) -> { status: 'sent' | 'test_captured' | 'refused' | 'failed', providerId?, reason?, error?, transient?, notConfigured? }   NEVER throws
//
// TEST MODE (opts.settings.emailTestMode, the global Test mode flag: the runner forces it ON for a rehearsal campaign): the message is written to
// OutreachSendLog as 'test_captured' and NOTHING is handed to any provider. Only with Test mode OFF is utils/messaging.js send() called (which uses the
// provider chosen in Administration > Integrations, the credit guard and the credit ledger: that ONE ledger row carries meta.campaignId / meta.source).
//   * the data layer's own consent check runs first (consent.canMessage), as in the email adapter; opts.allowNoOptIn = the Admin's "applied to our job" rule
//   * a daily limit per channel (settings waDailyCap / smsDailyCap) is enforced here too
// Logs hold the MASKED phone only.
// message: { text, vars (positional array), template: { name, language } | null, templateId (SMS DLT), senderId, kind, actorUserId, meta }
// opts.messageSender (a test mock) replaces utils/messaging.js send(): it is called ONLY with Test mode off.
// ---------------------------------------------------------------------------
const core = require('../../utils/messagingCore');
const S = require('../store');
const C = require('../consent');

const IST = 5.5 * 3600 * 1000;
const dayStart = (now = Date.now()) => Math.floor((now + IST) / 86400000) * 86400000 - IST;

module.exports = function makeTextAdapter({ channel, label, messagingName, capKey }) {
  async function log(row) {
    const id = S.newId('osl');
    await S.run('INSERT INTO "OutreachSendLog" (id, channel, contactId, toMasked, status, mode, reason, providerId, subject, headers, at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      id, channel, row.contactId || null, row.toMasked || null, row.status, row.mode || null, row.reason || null, row.providerId || null, S.clip(row.subject, 200) || null, null, row.at || Date.now());
    return id;
  }
  async function sentToday(mode, now) {
    const st = mode === 'test' ? 'test_captured' : 'sent';
    return S.num((await S.q('SELECT COUNT(*) n FROM "OutreachSendLog" WHERE channel = ? AND status = ? AND at >= ?', channel, st, dayStart(now)))[0].n);
  }
  async function status() {
    const st = await S.settings();
    let cfg = { configured: false, reason: `${label} is not connected.` };
    try { cfg = await require('../../channels').status(messagingName); } catch { /* keep default */ } // eslint-disable-line global-require
    return {
      ready: !!cfg.configured, live: !!cfg.configured && !st.emailTestMode, testMode: st.emailTestMode, dailyCap: st[capKey], via: cfg.via || null,
      reason: cfg.configured ? '' : (cfg.reason || `${label} is not connected in Administration > Integrations.`), sentToday: await sentToday(st.emailTestMode ? 'test' : 'live'),
    };
  }
  async function send(contact, message, opts = {}) {
    const now = opts.now || Date.now();
    const st = opts.settings || await S.settings();
    const mode = st.emailTestMode ? 'test' : 'live';
    const toMasked = core.maskMobile(contact && (contact.phoneE164 || contact.phone)) || null;
    const refuse = async (reason) => { await log({ contactId: contact && contact.id, toMasked, status: 'refused', mode, reason, subject: message && message.subject, at: now }); return { status: 'refused', reason }; };
    try {
      if (!contact || !contact.id) return await refuse('no_contact');
      if (message.kind === 'job_promotion' && contact.contactType === 'internal') return await refuse('internal_contact');
      const can = await C.canMessage(contact.id, channel);
      if (!can.ok && !(opts.allowNoOptIn && can.reason === 'no_opt_in')) return await refuse(can.reason);
      if (can.contactType === 'internal' && message.kind === 'job_promotion') return await refuse('internal_contact');
      if (!String(contact.phoneE164 || '').replace(/\D/g, '')) return await refuse('no_address');
      if ((await sentToday(mode, now)) >= (Number.isFinite(opts.dailyCap) ? opts.dailyCap : st[capKey])) return await refuse('daily_cap');
      if (st.emailTestMode) { // REHEARSAL: nothing is handed to any provider
        const providerId = `test-${S.newId('m')}`;
        await log({ contactId: contact.id, toMasked, status: 'test_captured', mode, providerId, at: now });
        return { status: 'test_captured', providerId };
      }
      const sender = opts.messageSender || require('../../utils/messaging').send; // eslint-disable-line global-require
      const input = channel === 'whatsapp'
        ? { to: contact.phoneE164, text: message.text, vars: message.vars && message.vars.length ? message.vars : [message.text], template: message.template || undefined, kind: 'bulk', actorUserId: message.actorUserId || null, ...(message.numberId ? { numberId: message.numberId } : {}), meta: message.meta || {} }
        : { to: contact.phoneE164, text: message.text, vars: [message.text], templateId: message.templateId || undefined, senderId: message.senderId || undefined, kind: 'bulk', actorUserId: message.actorUserId || null, meta: message.meta || {} };
      const r = await sender(messagingName, input);
      if (r && (r.ok || r.outcome === 'Sent')) {
        await log({ contactId: contact.id, toMasked, status: 'sent', mode, providerId: r.providerRef || null, at: now });
        return { status: 'sent', providerId: r.providerRef || null };
      }
      const error = S.clip((r && r.error) || `${label} did not accept it.`, 200);
      await log({ contactId: contact.id, toMasked, status: 'failed', mode, reason: error, at: now });
      return { status: 'failed', error, transient: !!(r && (r.transient || r.retryable)), notConfigured: !!(r && r.notConfigured), invalid: !!(r && (r.invalid || r.reserved)), creditsBlocked: !!(r && r.creditsBlocked) };
    } catch (e) {
      return { status: 'failed', error: S.clip(e && e.message, 200) };
    }
  }
  // delivery / read reports arrive through events.applyDelivery(), called by the provider webhooks
  function parseWebhook() { return []; }
  return { channel, label, status, send, parseWebhook, sentToday, dayStart, log };
};
