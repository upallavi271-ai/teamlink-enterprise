// ---------------------------------------------------------------------------
// MESSAGING — one door for Email, SMS and WhatsApp.
//
//   channelStatus()   { Email, SMS, WhatsApp } -> { configured, reason, … }
//                     read fresh every call; this is what every screen shows
//   send(channel, …)  one message on one channel, with the channel's own
//                     rate limit. Returns a RESULT, never throws:
//                       { ok, outcome: 'Sent' | 'Not configured' | 'Skipped'
//                                   | 'Failed', error, transient, providerRef }
//
// "Not configured" is a real outcome, reported as such — never a silent
// success and never a crash. Reserved test domains (example.test, *.invalid …)
// are refused by the mailer and reported as Skipped.
// ---------------------------------------------------------------------------

const mailer = require('./mailer');
const channels = require('../channels');
const core = require('./messagingCore');

const CHANNELS = ['Email', 'SMS', 'WhatsApp'];

async function channelStatus() {
  const [e, s, w] = await Promise.all([
    mailer.emailConfig().catch((err) => ({ configured: false, reason: err.message })),
    channels.status('SMS').catch((err) => ({ configured: false, reason: err.message, ordered: [], ready: [] })),
    channels.status('WhatsApp').catch((err) => ({ configured: false, reason: err.message, ordered: [], ready: [] })),
  ]);
  // SMS / WhatsApp: "configured" = at least one provider of the channel is ready (channels/index.js). provider / via say which one goes first.
  const shapeMsg = (st, detail) => ({
    configured: !!st.configured, reason: st.configured ? null : (st.reason || 'Not configured'), detail: st.configured ? detail : null,
    providerId: st.provider || null, via: st.via || null, providers: st.ordered || [], ready: st.ready || [],
  });
  return {
    Email: { configured: !!e.configured, reason: e.configured ? null : (e.reason || 'Not configured'), detail: e.configured ? `from ${e.fromAddress} via ${e.host}` : null },
    SMS: { ...shapeMsg(s, s.detail), provider: s.providerLabel || (s.configured ? s.via : null) },
    WhatsApp: shapeMsg(w, w.detail),
  };
}

function shape(result) {
  if (result.ok) return { ...result, outcome: 'Sent' };
  if (result.notConfigured) return { ...result, outcome: 'Not configured' };
  if (result.invalid || result.reserved) return { ...result, outcome: 'Skipped' };
  return { ...result, outcome: 'Failed' };
}

// { to, kind, subject, text, vars, senderEmail, senderName }
async function sendInner(channel, opts = {}) {
  try {
    if (channel === 'Email') {
      const to = String(opts.to || '').trim();
      if (!to) return shape({ ok: false, invalid: true, error: 'No email address on record' });
      if (!core.validEmail(to)) return shape({ ok: false, invalid: true, error: `"${to}" is not a valid email address` });
      if (mailer.isReservedTestAddress(to)) return shape({ ok: false, reserved: true, error: `${to} is a reserved test domain — never transmitted` });
      await core.acquire('Email');
      // OPEN / CLICK TRACKING of candidate emails (market wave 2026-11-21, utils/mkt/comms.js): only when the Admin switch is on;
      // an HTML copy with a 1-pixel image and links through TeamLink, the plain text unchanged. Never blocks the send.
      let trackedHtml = null; let trackToken = null;
      if (!opts.html && opts.meta && opts.meta.audience === 'candidates' && opts.meta.personId) {
        try {
          const MC = require('./mkt/comms'); // eslint-disable-line global-require
          if (await MC.trackingOn()) { const w = await MC.wrapEmail({ to, subject: opts.subject, text: opts.text, candidateId: opts.meta.personId }); trackedHtml = w.html; trackToken = w.token; }
        } catch { trackedHtml = null; }
      }
      const r = await mailer.sendMail({
        ...(trackedHtml ? { html: trackedHtml } : {}),
        to,
        subject: opts.subject || '(no subject)',
        text: opts.text || '',
        ...(opts.html ? { html: opts.html } : {}), // a styled body (AI Marketing: the Approve / Reject buttons in the approval email)
        senderEmail: opts.senderEmail,
        senderName: opts.senderName,
        useEmployeeFrom: !!opts.senderEmail,
        fromName: opts.fromName,
        // copies (the CRM invoice email, 2026-11-17): valid addresses only, reserved test domains dropped like the To
        ...(Array.isArray(opts.cc) && opts.cc.length ? { cc: opts.cc.map((a) => String(a || '').trim()).filter((a) => core.validEmail(a) && !mailer.isReservedTestAddress(a)) } : {}),
        // files to attach (e.g. the agreement PDF to eSign in DigiLocker, 2026-10-31): [{ filename, content: Buffer, contentType }]
        ...(Array.isArray(opts.attachments) && opts.attachments.length ? { attachments: opts.attachments } : {}),
      });
      if (trackToken && !(r && r.ok)) await require('./mkt/comms').dropTrack(trackToken).catch(() => {}); // eslint-disable-line global-require
      return shape(r);
    }
    // SMS / WhatsApp: the adapter layer picks the provider (channels/index.js): cloud / QR-link / Android phone / paid gateway.
    if (channel === 'SMS' || channel === 'WhatsApp') return shape(await channels.send(channel, opts));
    return shape({ ok: false, invalid: true, error: `Unknown channel ${channel}` });
  } catch (err) {
    // Defensive: an adapter bug must not take a bulk run or a signing page down.
    return shape({ ok: false, transient: false, error: `Internal error: ${String(err && err.message).slice(0, 200)}` });
  }
}

// OMNI-CHANNEL CREDITS (outreach/credits.js): the ONE hook for every Email / SMS / WhatsApp send in the app. The person is opts.actorUserId or
// opts.meta.senderUserId (bulk jobs, the Inbox reply box). A real send by a person whose monthly credits are used up is refused here with a plain
// message; every send is written to the ledger (Test / sandbox sends apart). Never throws; a send with no known person is only recorded.
async function send(channel, opts = {}) {
  let credits = null;
  try { credits = require('../outreach/credits'); } catch { credits = null; } // eslint-disable-line global-require
  const actor = (opts && (opts.actorUserId || (opts.meta && opts.meta.senderUserId))) || null;
  const key = String(channel || '').toLowerCase();
  if (credits && actor) {
    const g = await credits.guard({ userId: actor, channel: key, mode: 'live' });
    if (!g.ok) return shape({ ok: false, invalid: true, creditsBlocked: true, error: g.message });
  }
  const res = await sendInner(channel, opts);
  if (credits && res && ['Sent', 'Failed'].includes(res.outcome)) {
    const sandbox = !!res.sandbox || /sandbox/i.test(String(res.providerRef || res.response || ''));
    // a campaign send says which campaign it was (meta.campaignId) and that it came from a campaign (meta.source): the ONE ledger row carries both
    credits.record({ userId: actor, channel: key, mode: sandbox ? 'test' : 'live', ok: res.outcome === 'Sent', campaignId: (opts.meta && opts.meta.campaignId) || null, templateLabel: opts.meta && (opts.meta.template || opts.meta.purpose), source: (opts.meta && opts.meta.source) || 'messaging' }).catch(() => {});
  }
  return res;
}

module.exports = { CHANNELS, channelStatus, send };
