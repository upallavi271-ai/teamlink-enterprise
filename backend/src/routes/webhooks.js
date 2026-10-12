// ---------------------------------------------------------------------------
// /api/webhooks/* — the providers CALL US here (public, no login — each one
// proves itself):
//
//   WhatsApp (Meta Cloud API)   /api/webhooks/whatsapp
//     GET   Meta's one-time check: hub.mode=subscribe, hub.verify_token (must
//           equal "Webhook verify token" on the WhatsApp card), hub.challenge
//           -> we answer the challenge text.
//     POST  X-Hub-Signature-256: sha256=<HMAC-SHA256 of the raw body with the
//           app secret>. Wrong or missing signature -> 403, nothing stored.
//           field "messages": value.statuses[] (sent / delivered / read /
//           failed + errors[]) and value.messages[] (replies).
//
//   SMS delivery reports        /api/webhooks/sms/:provider?key=<secret>
//   Cloud telephony (calls)     /api/webhooks/call/:provider?key=<secret>
//     (added below; each checks its own shared key)
//
// The raw body is kept for the signature check, so this router brings its own
// JSON parser and is mounted BEFORE the global one (index.js).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const express = require('express');
const delivery = require('../utils/messageDelivery');

const router = express.Router();
const keep = (req, _res, buf) => { req.rawBody = buf; };
router.use(express.json({ limit: '1mb', verify: keep }));
router.use(express.urlencoded({ extended: false, limit: '1mb', verify: keep }));

const safeEq = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

// ---- WhatsApp -----------------------------------------------------------------
router.get('/whatsapp', async (req, res) => {
  const cfg = await require('../utils/whatsappCloud').whatsappConfig().catch(() => null); // eslint-disable-line global-require
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (cfg && cfg.verifyToken && mode === 'subscribe' && safeEq(token, cfg.verifyToken)) return res.status(200).type('text/plain').send(String(challenge || ''));
  return res.status(403).type('text/plain').send('Forbidden');
});

async function handleWhatsApp(body) {
  let statuses = 0; let replies = 0;
  const entries = Array.isArray(body && body.entry) ? body.entry : [];
  for (const entry of entries) {
    for (const change of (Array.isArray(entry.changes) ? entry.changes : [])) {
      const v = change && change.value;
      if (!v || change.field !== 'messages') continue; // eslint-disable-line no-continue
      for (const st of (Array.isArray(v.statuses) ? v.statuses : [])) {
        const err = Array.isArray(st.errors) && st.errors[0] ? st.errors[0] : null;
        // eslint-disable-next-line no-await-in-loop
        const out = await delivery.applyStatus({
          channel: 'WhatsApp', providerRef: st.id, status: st.status, at: st.timestamp ? new Date(Number(st.timestamp) * 1000) : new Date(),
          error: err ? `${err.title || err.message || 'Failed'}${err.code ? ` (${err.code})` : ''}${err.error_data && err.error_data.details ? ` — ${err.error_data.details}` : ''}` : null,
        });
        if (out.matched) statuses += 1;
      }
      const names = {};
      (Array.isArray(v.contacts) ? v.contacts : []).forEach((c) => { names[c.wa_id] = c.profile && c.profile.name; });
      for (const m of (Array.isArray(v.messages) ? v.messages : [])) {
        let text = '';
        if (m.type === 'text') text = m.text && m.text.body;
        else if (m.type === 'button') text = m.button && (m.button.text || m.button.payload);
        else if (m.type === 'interactive') text = m.interactive && ((m.interactive.button_reply && m.interactive.button_reply.title) || (m.interactive.list_reply && m.interactive.list_reply.title));
        else text = `[${m.type || 'message'}]`;
        // eslint-disable-next-line no-await-in-loop
        await delivery.applyInbound({ channel: 'WhatsApp', from: m.from, text: text || '', id: m.id, at: m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date(), name: names[m.from] });
        replies += 1;
      }
    }
  }
  return { statuses, replies };
}

router.post('/whatsapp', async (req, res) => {
  try {
    const cfg = await require('../utils/whatsappCloud').whatsappConfig().catch(() => null); // eslint-disable-line global-require
    if (!cfg || !cfg.appSecret) return res.status(403).json({ error: 'WhatsApp webhook is not set up (no app secret saved).' });
    const sent = String(req.get('x-hub-signature-256') || '').replace(/^sha256=/i, '');
    const want = crypto.createHmac('sha256', cfg.appSecret).update(req.rawBody || Buffer.from('')).digest('hex');
    if (!safeEq(sent, want)) return res.status(403).json({ error: 'Bad signature' });
    await delivery.markSeen('whatsapp');
    const out = await handleWhatsApp(req.body);
    // Meta wants a quick 200; anything else makes it retry.
    return res.status(200).json({ ok: true, ...out });
  } catch (err) {
    console.error('[webhook] whatsapp:', err && err.message); // eslint-disable-line no-console
    return res.status(200).json({ ok: true }); // never make Meta retry a bug of ours forever
  }
});

// ---- SMS delivery reports ------------------------------------------------------------
//   /api/webhooks/sms/msg91?key=<Delivery-report webhook secret>      JSON, one POST per recipient
//        { requestId, telNum, status: "1" delivered | "2" failed | "0" sent …, event, failureReason }
//   /api/webhooks/sms/fast2sms?key=<secret>                           POST/GET/PUT, JSON or form
//        { request_id, mobile, status: delivered | failed …, failure_reason, description }
//   /api/webhooks/sms/twilio                                          form, signed (X-Twilio-Signature)
//        { MessageSid, MessageStatus: queued | sent | delivered | undelivered | failed, ErrorCode }
// Sources: docs.msg91.com / msg91.com/help/webhook-new, docs.fast2sms.com/reference/sms-webhook.md,
// twilio.com/docs/messaging/api/message-resource (checked 2026-10-09). The id each provider returns when
// a message is accepted (MSG91 requestId, Fast2SMS request_id, Twilio Sid) is the key; every send here is
// one message per call, so the id is per message.
const MSG91_FAILED = new Set(['2', '9', '16', '17', '20', '25']);
function msg91Status(it) {
  const ev = String(it.event || it.eventName || '').toLowerCase();
  if (/deliver/.test(ev)) return 'delivered';
  if (/fail|reject|block|ndnc/.test(ev)) return 'failed';
  const code = String(it.status == null ? '' : it.status);
  if (code === '1') return 'delivered';
  if (MSG91_FAILED.has(code)) return 'failed';
  if (code === '0') return 'sent';
  return '';
}

function twilioSignatureOk(req, token) {
  const base = process.env.APP_BASE_URL ? String(process.env.APP_BASE_URL).replace(/\/+$/, '') : `${req.protocol}://${req.get('host')}`;
  const url = `${base}${req.originalUrl}`;
  const params = req.body && typeof req.body === 'object' ? req.body : {};
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  const want = crypto.createHmac('sha1', token).update(data).digest('base64');
  return safeEq(req.get('x-twilio-signature'), want);
}

router.all('/sms/:provider', async (req, res) => {
  try {
    const provider = String(req.params.provider || '').toLowerCase();
    if (!['msg91', 'fast2sms', 'twilio'].includes(provider)) return res.status(404).json({ error: 'Unknown provider' });
    const cfg = await require('../utils/smsGateway').smsConfig().catch(() => null); // eslint-disable-line global-require
    if (!cfg) return res.status(403).json({ error: 'SMS is not set up' });
    if (provider === 'twilio') {
      if (!cfg.key || !twilioSignatureOk(req, cfg.key)) return res.status(403).json({ error: 'Bad signature' });
    } else if (!cfg.dlrSecret || !safeEq(req.query.key, cfg.dlrSecret)) {
      return res.status(403).json({ error: 'Bad key' });
    }
    await delivery.markSeen('sms');
    const raw = req.method === 'GET' ? req.query : req.body;
    const items = (Array.isArray(raw) ? raw : [raw]).filter((x) => x && typeof x === 'object');
    let matched = 0;
    for (const it of items) {
      let ref; let status; let error = null; let at = null;
      if (provider === 'msg91') {
        ref = it.requestId || it.request_id; status = msg91Status(it); error = it.failureReason || null; at = it.deliveryTime || it.ts || null;
      } else if (provider === 'fast2sms') {
        ref = it.request_id; status = String(it.status || '').toLowerCase(); error = it.failure_reason || (status === 'failed' ? it.description : null) || null; at = it.delivery_timestamp || null;
      } else {
        ref = it.MessageSid || it.SmsSid; status = String(it.MessageStatus || it.SmsStatus || '').toLowerCase(); error = it.ErrorCode ? `Twilio error ${it.ErrorCode}` : null;
      }
      // eslint-disable-next-line no-await-in-loop
      const out = await delivery.applyStatus({ channel: 'SMS', providerRef: ref, status, at: at && !Number.isNaN(new Date(at).getTime()) ? new Date(at) : new Date(), error });
      matched += out.matched || 0;
    }
    return res.status(200).json({ ok: true, matched });
  } catch (err) {
    console.error('[webhook] sms:', err && err.message); // eslint-disable-line no-console
    return res.status(200).json({ ok: true });
  }
});

// ---- SMS REPLIES (the person texts back) ------------------------------------------------------------
// /api/webhooks/sms-inbound/:provider?key=<same secret as the delivery reports>   (Twilio: signed, no key)
//   twilio:    form { From, Body, MessageSid }
//   msg91 / fast2sms / anything else that forwards replies: JSON or form with a sender number
//              (mobile | from | sender | msisdn | telNum | number) and the words (message | text | body | content | Body).
// The reply lands in the person's conversation (Inbox) and opens the unread count; STOP is honoured.
router.all('/sms-inbound/:provider', async (req, res) => {
  try {
    const provider = String(req.params.provider || '').toLowerCase();
    if (!['msg91', 'fast2sms', 'twilio', 'other'].includes(provider)) return res.status(404).json({ error: 'Unknown provider' });
    const cfg = await require('../utils/smsGateway').smsConfig().catch(() => null); // eslint-disable-line global-require
    if (!cfg) return res.status(403).json({ error: 'SMS is not set up' });
    if (provider === 'twilio') {
      if (!cfg.key || !twilioSignatureOk(req, cfg.key)) return res.status(403).json({ error: 'Bad signature' });
    } else if (!cfg.dlrSecret || !safeEq(req.query.key, cfg.dlrSecret)) {
      return res.status(403).json({ error: 'Bad key' });
    }
    await delivery.markSeen('sms-inbound');
    const raw = req.method === 'GET' ? req.query : req.body;
    const items = (Array.isArray(raw) ? raw : [raw]).filter((x) => x && typeof x === 'object');
    let stored = 0;
    for (const it of items) {
      const pick = (...keys) => { for (const k of keys) { if (it[k] != null && it[k] !== '') return String(it[k]); } return ''; };
      const from = pick('From', 'from', 'mobile', 'sender', 'msisdn', 'telNum', 'number', 'customerNumber');
      const text = pick('Body', 'body', 'message', 'text', 'content', 'Message');
      if (!from) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      const out = await delivery.applyInbound({ channel: 'SMS', from, text, id: pick('MessageSid', 'SmsSid', 'id', 'requestId', 'request_id') || null, at: new Date() });
      if (out.stored) stored += 1;
    }
    return res.status(200).json({ ok: true, stored });
  } catch (err) {
    console.error('[webhook] sms-inbound:', err && err.message); // eslint-disable-line no-console
    return res.status(200).json({ ok: true });
  }
});

// ---- Call results (Exotel) -----------------------------------------------------------
// POST /api/webhooks/call/exotel?key=<Call-result webhook secret>   JSON (we ask for it) or form
//   { CallSid, Status: completed | failed | busy | no-answer, ConversationDuration, RecordingUrl, CustomField }
router.post('/call/exotel', async (req, res) => {
  try {
    const gw = require('../utils/callGateway'); // eslint-disable-line global-require
    const cfg = await gw.callConfig().catch(() => null);
    if (!cfg || !cfg.secret || !safeEq(req.query.key, cfg.secret)) return res.status(403).json({ error: 'Bad key' });
    await delivery.markSeen('call');
    const r = gw.readCallback(req.body);
    const out = await delivery.applyCall({ callSid: r.callSid, status: r.status, seconds: r.seconds, recordingUrl: r.recordingUrl, ref: r.ref, answeredBy: r.answeredBy });
    return res.status(200).json({ ok: true, matched: out.matched });
  } catch (err) {
    console.error('[webhook] call:', err && err.message); // eslint-disable-line no-console
    return res.status(200).json({ ok: true });
  }
});

module.exports = router;
module.exports.handleWhatsApp = handleWhatsApp;
