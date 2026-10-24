// ---------------------------------------------------------------------------
// EMAIL ADAPTER (reuses utils/mailer.js: the SMTP set up in Administration > Integrations; the sandbox swaps in its fake transport).
//   * TEST MODE is ON by default (AppSetting outreach.settings.emailTestMode). In test mode NOTHING is handed to the mail server: the
//     message is built (headers and all), written to OutreachSendLog as 'test_captured', and that is all. Only an Admin switches it off.
//   * DAILY CAP: at most outreach.settings.emailDailyCap emails per (Indian) day, counted per mode; over it the message is refused.
//   * EVERY promotion carries the unsubscribe link in the text (a footer is added when the template did not place it) and the headers
//       List-Unsubscribe: <https://.../u/<token>>      List-Unsubscribe-Post: List-Unsubscribe=One-Click
//   * The data layer's own check runs first: an opted-out / suppressed / no-permission contact, and an INTERNAL contact for a job
//     promotion, are refused here even if a caller forgot.
//   * opts.mailSender (a test mock) replaces the real sender; the real one is only reached with test mode OFF.
// Logs hold the MASKED address only.
// ---------------------------------------------------------------------------
const core = require('../../utils/messagingCore');
const S = require('../store');
const C = require('../consent');
const L = require('../links');

const IST = 5.5 * 3600 * 1000;
const dayStart = (now = Date.now()) => Math.floor((now + IST) / 86400000) * 86400000 - IST;

async function log(row) {
  const id = S.newId('osl');
  await S.run('INSERT INTO "OutreachSendLog" (id, channel, contactId, toMasked, status, mode, reason, providerId, subject, headers, at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    id, 'email', row.contactId || null, row.toMasked || null, row.status, row.mode || null, row.reason || null, row.providerId || null, S.clip(row.subject, 200) || null, row.headers ? JSON.stringify(row.headers) : null, row.at || Date.now());
  return id;
}
async function sentToday(mode, now) {
  const st = mode === 'test' ? 'test_captured' : 'sent';
  return S.num((await S.q('SELECT COUNT(*) n FROM "OutreachSendLog" WHERE channel = \'email\' AND status = ? AND at >= ?', st, dayStart(now)))[0].n);
}

async function status() {
  const st = await S.settings();
  let cfg = { configured: false, reason: 'Email is not set up.' };
  try { cfg = await require('../../utils/mailer').emailConfig(); } catch { /* keep default */ } // eslint-disable-line global-require
  return {
    ready: !!cfg.configured, live: !!cfg.configured && !st.emailTestMode, testMode: st.emailTestMode, dailyCap: st.emailDailyCap, reason: cfg.configured ? '' : (cfg.reason || 'Email is not set up in Administration > Integrations.'),
    sentToday: await sentToday(st.emailTestMode ? 'test' : 'live'),
  };
}

// contact: { id, contactType, name, email }   message: { subject, body, kind, promotional, unsubscribeUrl, html? }
async function send(contact, message, opts = {}) {
  const now = opts.now || Date.now();
  const st = opts.settings || await S.settings();
  const mode = st.emailTestMode ? 'test' : 'live';
  const toMasked = core.maskEmail(contact && contact.email) || null;
  const refuse = async (reason) => { await log({ contactId: contact && contact.id, toMasked, status: 'refused', mode, reason, subject: message && message.subject, at: now }); return { status: 'refused', reason }; };
  try {
    if (!contact || !contact.id) return await refuse('no_contact');
    if (message.kind === 'job_promotion' && contact.contactType === 'internal') return await refuse('internal_contact');
    // Phase 3: a "test to myself" goes to the SENDER's own address only (opts.selfTest); it is not a contact, so there is no consent to check.
    // It is never a promotion and it still obeys test mode and the daily limit.
    if (opts.selfTest) { if (message.promotional !== false || message.kind === 'job_promotion') return await refuse('self_test_only'); } else {
      const can = await C.canMessage(contact.id, 'email');
      if (!can.ok && !(opts.allowNoOptIn && can.reason === 'no_opt_in')) return await refuse(can.reason); // allowNoOptIn: the Admin's "applied to our job" rule (suppress.decide basis 'ats_applied'); an opt-out always wins
      if (can.contactType === 'internal' && message.kind === 'job_promotion') return await refuse('internal_contact');
    }
    if (!core.validEmail(contact.email)) return await refuse('no_address');
    if (message.promotional !== false && !message.unsubscribeUrl) return await refuse('no_unsubscribe_link');
    if ((await sentToday(mode, now)) >= st.emailDailyCap) return await refuse('daily_cap');

    let text = String(message.body || '');
    const url = message.unsubscribeUrl;
    if (message.promotional !== false && url && !text.includes(url)) text += `\n\n--\nYou get this because you shared your details with TeamLink. To stop these emails: ${url}`;
    const headers = { ...(message.promotional !== false && url ? { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {}), ...(message.extraHeaders || {}) };
    const snapshot = { ...headers, From: st.fromName || null, 'Reply-To': st.replyTo || null };

    if (st.emailTestMode) {
      const providerId = `test-${S.newId('m')}`;
      await log({ contactId: contact.id, toMasked, status: 'test_captured', mode, providerId, subject: message.subject, headers: snapshot, at: now });
      return { status: 'test_captured', providerId, headers };
    }
    const sender = opts.mailSender || require('../../utils/mailer').sendMail; // eslint-disable-line global-require
    const r = await sender({ to: contact.email, subject: message.subject, text, ...(message.html ? { html: message.html } : {}), fromName: st.fromName || undefined, senderEmail: st.replyTo || undefined, useEmployeeFrom: false, headers });
    if (r && r.ok) {
      await log({ contactId: contact.id, toMasked, status: 'sent', mode, providerId: r.providerRef || null, subject: message.subject, headers: snapshot, at: now });
      return { status: 'sent', providerId: r.providerRef || null, headers };
    }
    await log({ contactId: contact.id, toMasked, status: 'failed', mode, reason: S.clip(r && r.error, 200), subject: message.subject, at: now });
    return { status: 'failed', error: (r && r.error) || 'The mail server did not accept it.', transient: !!(r && r.transient) };
  } catch (e) {
    return { status: 'failed', error: S.clip(e && e.message, 200) };
  }
}

// bounce / complaint / delivered webhooks arrive in Phase 3 (needs the ESP). Nothing to parse yet.
function parseWebhook() { return []; }

module.exports = { channel: 'email', label: 'Email', status, send, parseWebhook, sentToday, dayStart, log, unsubscribeToken: L.mintUnsubscribe };
