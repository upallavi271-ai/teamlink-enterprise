// ---------------------------------------------------------------------------
// CHANNEL ADAPTERS (pluggable). Same shape for every channel:
//   adapter = {
//     channel:  'email' | 'whatsapp' | 'sms',     (and 'call', which is not a sender: see call.js; get('call') only)
//     label:    people words,
//     status(): Promise<{ ready, live, reason }>        is the channel set up, and is it really sending or only in test mode
//     send(contact, message, opts): Promise<{ status, providerId?, reason?, error? }>
//         status: 'sent' | 'test_captured' | 'refused' | 'failed'.  Never throws.
//     parseWebhook(req): [{ providerId, event, at }]    delivery / bounce / reply parser (delivery reports go through events.applyDelivery)
//   }
// Email (Phase 2), WhatsApp and SMS (2026-10-17, text.js) are REAL adapters. Each one writes OutreachSendLog and, with Test mode ON (the default), NEVER hands
// anything to a provider. Credentials are not stored here: they stay in Administration > Integrations (the existing, encrypted store).
// ---------------------------------------------------------------------------
const email = require('./email');
const whatsapp = require('./whatsapp');
const sms = require('./sms');
const call = require('./call');

const registry = { email, whatsapp, sms };
const get = (channel) => registry[channel] || (channel === 'call' ? call : null);
const all = () => Object.values(registry);

module.exports = { get, all, registry };
