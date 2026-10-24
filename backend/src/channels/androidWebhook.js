// ---------------------------------------------------------------------------
// /api/webhooks/sms-android — what the Android phone app tells us (SMS Gateway for Android webhooks).
//   envelope  { deviceId, event, id, payload, webhookId }
//   events    sms:sent | sms:delivered | sms:failed | sms:cancelled | sms:received | sms:batch:received | system:ping
//   proof     X-Signature = hex HMAC-SHA256(signing key, rawBody + X-Timestamp), timestamp within 5 minutes;
//             or, when the app cannot sign, ?key=<the same word> on the URL. Neither valid -> 403.
// A status event moves the SAME message (providerRef "and:<messageId>") on: Queued -> Sent -> Delivered / Failed.
// A received SMS goes to the Inbox like any other reply; STOP opts the person out.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const android = require('./androidSms');
const delivery = require('../utils/messageDelivery');

const safeEq = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

function verify(req, hook) {
  if (!hook) return { ok: false, why: 'The phone webhook has no signing key / shared word saved in TeamLink.' };
  const sig = req.get('x-signature');
  if (sig) {
    const ts = String(req.get('x-timestamp') || '');
    const age = Math.abs(Date.now() / 1000 - Number(ts));
    if (!Number.isFinite(age) || age > 300) return { ok: false, why: 'Stale or missing timestamp' };
    const want = crypto.createHmac('sha256', hook).update(Buffer.concat([req.rawBody || Buffer.from(''), Buffer.from(ts)])).digest('hex');
    return safeEq(sig, want) ? { ok: true } : { ok: false, why: 'Bad signature' };
  }
  return safeEq(req.query.key, hook) ? { ok: true } : { ok: false, why: 'Bad key' };
}

async function handle(req) {
  const cfg = await android.androidConfig().catch(() => null);
  if (!cfg) return { status: 403, body: { error: 'The Android phone is not set up' } };
  const v = verify(req, cfg.hook);
  if (!v.ok) return { status: 403, body: { error: v.why } };
  await delivery.markSeen('sms-android');
  const b = req.body || {};
  const ev = String(b.event || '');
  const p = b.payload || {};
  let matched = 0; let stored = 0;
  const status = async (st, extra = {}) => {
    const out = await delivery.applyStatus({ channel: 'SMS', providerRef: `and:${p.messageId}`, status: st, at: p.deliveredAt || p.sentAt || p.failedAt || new Date(), ...extra });
    matched += out.matched || 0;
  };
  if (ev === 'sms:sent') await status('sent');
  else if (ev === 'sms:delivered') await status('delivered');
  else if (ev === 'sms:failed') await status('failed', { error: `The phone could not send it: ${String(p.reason || 'unknown reason').slice(0, 200)}` });
  else if (ev === 'sms:cancelled') await status('failed', { error: 'The message was cancelled on the phone.' });
  else if (ev === 'sms:received' || ev === 'sms:batch:received') {
    const list = ev === 'sms:batch:received' ? (Array.isArray(p.messages) ? p.messages : []) : [p];
    for (const m of list) {
      if (!m || !m.sender) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      const out = await delivery.applyInbound({ channel: 'SMS', from: m.sender, text: m.message || '', id: m.messageId ? `and:${m.messageId}` : null, at: m.receivedAt ? new Date(m.receivedAt) : new Date(), provider: android.ID });
      if (out && out.stored) stored += 1;
    }
  } else if (ev === 'system:ping') {
    await delivery.markSeen('sms-android-ping');
  }
  return { status: 200, body: { ok: true, matched, stored } };
}

module.exports = { handle, verify };
