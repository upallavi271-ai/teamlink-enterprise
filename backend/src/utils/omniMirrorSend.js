// ---------------------------------------------------------------------------
// A WHATSAPP MESSAGE TEAMLINK SENT TO ONE EMPLOYEE ALSO SHOWS IN OMNI-CHANNEL (founder 2026-11-18, from the Organization Chart's Message window:
// "visible like the Omni-Channel WhatsApp chat: I reply and receive").
//
// The person's replies already reach Omni-Channel (Green Start): Meta's webhook points at TeamLink, which hands each call on
// (utils/greenStartWaForward.js). What TeamLink SENDS did not: Meta does not send an outgoing message's words back. So, once a one-person
// WhatsApp message to an employee has really gone, this puts the same words into that person's open thread in Green Start
// (omniwa/gsCampaign.js mirror -> POST /conversations/import-outbound, the helper the WhatsApp AI's replies already use). Nothing is sent again.
//
// Limits, said plainly: Green Start files it only when that person ALREADY has an open WhatsApp chat in the workspace of the sending number
// (they have written to that number once); a first message to somebody who never wrote shows there only from their reply on. Employees only, one-person
// sends only (a bulk send would mean hundreds of calls to Green Start). Never awaited, never throws: the message has already gone. Skipped where
// Omni-Channel is switched off (GREENSTART_ENABLED=false, which is what keeps a second company's copy away from TeamLink's own Green Start).
// ---------------------------------------------------------------------------
const enabled = () => !/^(0|false|no|off)$/i.test(String(process.env.GREENSTART_ENABLED === undefined ? 'true' : process.env.GREENSTART_ENABLED).trim());

// job: the finished send; r: one recipient row of it. deps.mirror / deps.e164Of are only for the tests. -> true when a copy was started.
function afterSend(job, r, deps = {}) {
  try {
    if (!enabled()) return false;
    if (!job || !r || job.audience !== 'employees' || job.kind !== 'individual') return false;
    if (r.channel !== 'WhatsApp' || r.status !== 'sent' || r.sandbox) return false;
    const text = String(r.text || '').trim();
    if (!text) return false;
    const e164Of = deps.e164Of || ((raw) => { const m = require('./messagingCore').normalizeMobile(raw); return m.ok ? m.e164 : ''; }); // eslint-disable-line global-require
    const e164 = e164Of(r.address);
    if (!e164) return false;
    const mirror = deps.mirror || require('../omniwa/gsCampaign').mirror; // eslint-disable-line global-require
    Promise.resolve(mirror(e164, text, r.providerRef || null, r.numberId || job.waNumberId || undefined)).catch(() => {});
    return true;
  } catch { return false; }
}

module.exports = { afterSend, enabled };
