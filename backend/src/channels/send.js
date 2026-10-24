// ---------------------------------------------------------------------------
// channels/send.js — the stable, small door other modules (e.g. the job-broadcast campaign) call.
//
//   sendWhatsApp({ to, text, template: { name, language, vars }, meta, media, providerOnly })
//   sendSms({ to, text, templateId, senderId, vars, meta })
//     -> { ok, providerRef, provider, via, queued, status, error, transient, retryable, notConfigured, invalid, attempts }
//
// Same provider choice, fallback, STOP / test-record rules and Communication-log record as every other send (channels/index.js).
// The caller is responsible for consent, quiet hours, de-dupe and caps before calling (utils/bulkMessaging does so for people lists);
// meta = { audience, personId, personName, senderUserId, senderName, purpose, campaignId, jobId } feeds the log.
// ---------------------------------------------------------------------------
const channels = require('./index');

async function sendWhatsApp(input = {}) {
  const t = input.template || null;
  return channels.send('WhatsApp', {
    to: input.to, kind: input.kind || 'bulk', text: input.text, vars: (t && t.vars) || input.vars || [input.text],
    template: t && t.name ? { name: t.name, language: t.language } : undefined,
    media: input.media, meta: input.meta || {}, providerOnly: input.providerOnly, numberId: input.numberId || undefined, automatic: input.automatic || undefined,
  });
}

async function sendSms(input = {}) {
  return channels.send('SMS', {
    to: input.to, kind: input.kind || 'bulk', text: input.text, vars: input.vars || [input.text], templateId: input.templateId, senderId: input.senderId,
    meta: input.meta || {}, providerOnly: input.providerOnly,
  });
}

module.exports = { sendWhatsApp, sendSms };
