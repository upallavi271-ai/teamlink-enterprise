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
const sms = require('./smsGateway');
const wa = require('./whatsappCloud');
const core = require('./messagingCore');

const CHANNELS = ['Email', 'SMS', 'WhatsApp'];

async function channelStatus() {
  const [e, s, w] = await Promise.all([
    mailer.emailConfig().catch((err) => ({ configured: false, reason: err.message })),
    sms.smsConfig().catch((err) => ({ configured: false, reason: err.message })),
    wa.whatsappConfig().catch((err) => ({ configured: false, reason: err.message })),
  ]);
  return {
    Email: { configured: !!e.configured, reason: e.configured ? null : (e.reason || 'Not configured'), detail: e.configured ? `from ${e.fromAddress} via ${e.host}` : null },
    SMS: { configured: !!s.configured, reason: s.configured ? null : (s.reason || 'Not configured'), detail: s.configured ? `${s.providerLabel}${s.testMode ? ' (test server)' : ''}` : null, provider: s.providerLabel || null },
    WhatsApp: { configured: !!w.configured, reason: w.configured ? null : (w.reason || 'Not configured'), detail: w.configured ? `Cloud API${w.display ? ` · ${w.display}` : ''}${w.testMode ? ' (test server)' : ''}` : null },
  };
}

function shape(result) {
  if (result.ok) return { ...result, outcome: 'Sent' };
  if (result.notConfigured) return { ...result, outcome: 'Not configured' };
  if (result.invalid || result.reserved) return { ...result, outcome: 'Skipped' };
  return { ...result, outcome: 'Failed' };
}

// { to, kind, subject, text, vars, senderEmail, senderName }
async function send(channel, opts = {}) {
  try {
    if (channel === 'Email') {
      const to = String(opts.to || '').trim();
      if (!to) return shape({ ok: false, invalid: true, error: 'No email address on record' });
      if (!core.validEmail(to)) return shape({ ok: false, invalid: true, error: `"${to}" is not a valid email address` });
      if (mailer.isReservedTestAddress(to)) return shape({ ok: false, reserved: true, error: `${to} is a reserved test domain — never transmitted` });
      await core.acquire('Email');
      const r = await mailer.sendMail({
        to,
        subject: opts.subject || '(no subject)',
        text: opts.text || '',
        senderEmail: opts.senderEmail,
        senderName: opts.senderName,
        useEmployeeFrom: !!opts.senderEmail,
        fromName: opts.fromName,
      });
      return shape(r);
    }
    if (channel === 'SMS') return shape(await sms.sendSms(opts));
    if (channel === 'WhatsApp') return shape(await wa.sendWhatsApp(opts));
    return shape({ ok: false, invalid: true, error: `Unknown channel ${channel}` });
  } catch (err) {
    // Defensive: an adapter bug must not take a bulk run or a signing page down.
    return shape({ ok: false, transient: false, error: `Internal error: ${String(err && err.message).slice(0, 200)}` });
  }
}

module.exports = { CHANNELS, channelStatus, send };
