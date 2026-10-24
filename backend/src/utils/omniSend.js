// ---------------------------------------------------------------------------
// OMNI SEND — "Send on the best channel", and the single-channel send used by the Inbox reply box.
//
//   send(user, input) -> {
//     ok, channel,                the channel the message really went on
//     attempts: [{ channel, status: sent | blocked | skipped | failed, reason }],   why a fallback happened
//     jobId, result,              the one-person send (utils/bulkMessaging.js)
//     fallback                    when NOTHING could be sent: { text, subject, canOpenOwnApp } for copy / open-in-app
//   }
//
// Order for "best": the person's preferred channel first (Conversation.preferredChannel, else the client's
// "primary way" on the client card), then WhatsApp -> SMS -> Email. Each step is a complete dry run of the
// normal one-person send (bulkMessaging.buildPlan), so EVERY rule applies exactly as it does everywhere else:
// consent withdrawn, STOP replies, the WhatsApp template / 24-hour window, daily caps, the "Candidate emails"
// switch, quiet hours for promotional kinds, test records, missing numbers. A step that cannot go is recorded
// with its reason and the next one is tried; a step that goes out and fails at the provider is too.
//
// The reason trail is saved on the message itself ("WhatsApp not used (…); sent on SMS"), so the
// conversation shows which channel was used and why.
// ---------------------------------------------------------------------------

const bulk = require('./bulkMessaging');
const convo = require('./conversations');
const access = require('./contactAccess');
const ctx = require('./messageContext');

const LABEL = { Email: 'Mail', WhatsApp: 'WhatsApp', SMS: 'SMS', Call: 'Call' };
const AUTO = ['WhatsApp', 'SMS', 'Email'];
// The client card says "Email | WhatsApp | Phone"; Phone cannot be sent automatically.
const FROM_CARD = { Email: 'Email', WhatsApp: 'WhatsApp', SMS: 'SMS' };

function orderFor(preferred) {
  const first = FROM_CARD[preferred];
  return first ? [first, ...AUTO.filter((c) => c !== first)] : [...AUTO];
}

async function send(user, input = {}) {
  const audience = ['candidates', 'clients', 'employees'].includes(input.audience) ? input.audience : null;
  if (!audience || !input.id) return { error: 'Say who to write to.', status: 400 };
  const rule = await access.ruleFor(user, audience);
  if (!rule.allowed) return { error: rule.reason || 'Not available to this login.', status: 403 };
  const wantsBest = input.channel === 'Best';
  if (!wantsBest && !['Email', 'WhatsApp', 'SMS'].includes(input.channel)) return { error: 'Choose Mail, WhatsApp, SMS or "best channel".', status: 400 };

  const people = await ctx.recipientsFor(user, audience, [String(input.id)], { applicationId: input.applicationId, requirementId: input.requirementId, contactKind: rule.kind });
  if (!people.length) return { error: 'This person is outside your access.', status: 403 };
  const person = people[0];
  const type = convo.TYPES[audience];

  let order = [input.channel];
  if (wantsBest) {
    const thread = await convo.getThread(type, input.id).catch(() => null);
    order = orderFor((thread && thread.preferredChannel) || person.commPrimary || null);
  }

  const base = {
    audience, ids: [String(input.id)], kind: 'individual', applicationId: input.applicationId, requirementId: input.requirementId,
    purposeKey: input.purposeKey, purpose: input.purpose, language: input.language, perChannel: input.perChannel, subject: input.subject, body: input.body, urgent: !!input.urgent,
    waNumberId: input.waNumberId || undefined, // the WhatsApp number the sender chose (utils/waNumbers.js)
    attachments: input.attachments, sessionText: input.sessionText === true, // the WhatsApp chat screen: a resume as a file, plain words inside the 24-hour window
  };
  const attempts = [];
  let firstText = null;
  const trail = () => attempts.filter((a) => a.status !== 'sent').map((a) => `${LABEL[a.channel]} not used (${String(a.reason || a.status).replace(/\.$/, '')})`).join('; ');

  for (const ch of order) {
    // 1. dry run of the normal one-person send for this channel
    // eslint-disable-next-line no-await-in-loop
    const plan = await bulk.buildPlan(user, { ...base, channels: [ch], ...(input.perChannel && input.perChannel[ch] ? {} : {}) });
    if (plan.error) {
      if (plan.status === 403 && !attempts.length && !wantsBest) return { error: plan.error, status: 403 };
      if (plan.status === 400 && !wantsBest) return { error: plan.error, status: 400 };
      if (plan.status === 409 && plan.code && !wantsBest) return { error: plan.error, status: 409, code: plan.code }; // no WhatsApp number for this sender
      attempts.push({ channel: ch, status: 'blocked', reason: plan.error });
      continue; // eslint-disable-line no-continue
    }
    const r = plan.plan.recipients[0];
    if (r && !firstText) firstText = { text: r.text, subject: r.subject, channel: ch };
    if (!r || r.status !== 'queued') {
      attempts.push({ channel: ch, status: r ? r.status : 'blocked', reason: r ? r.reason : 'Nothing to send' });
      continue; // eslint-disable-line no-continue
    }
    // 2. send it for real
    const note = wantsBest ? `Best channel${attempts.length ? `: ${trail()}; sent on ${LABEL[ch]}` : `: ${LABEL[ch]}${input.preferredFirst ? ' (preferred)' : ''}`}` : null;
    // eslint-disable-next-line no-await-in-loop
    const out = await bulk.sendIndividual(user, { ...base, id: String(input.id), channel: ch, omniNote: note });
    if (out.error) { attempts.push({ channel: ch, status: 'blocked', reason: out.error }); continue; } // eslint-disable-line no-continue
    const row = out.result;
    if (row && row.status === 'sent') {
      attempts.push({ channel: ch, status: 'sent' });
      let wait = null;
      if (input.awaitReply && input.awaitReply.value) {
        // eslint-disable-next-line no-await-in-loop
        wait = await convo.setAwait(user, type, String(input.id), { ...input.awaitReply, channel: ch, applicationId: input.applicationId });
      }
      return {
        ok: true, channel: ch, attempts, jobId: out.jobId, result: row, masked: !!out.masked, best: wantsBest,
        waiting: wait && !wait.error ? { until: wait.until } : null, waitError: wait && wait.error ? wait.error : null,
      };
    }
    if (row && row.status === 'queued') {
      // still sending after the wait: it is going out, say so
      return { ok: true, channel: ch, attempts: [...attempts, { channel: ch, status: 'sending' }], jobId: out.jobId, result: row, masked: !!out.masked, best: wantsBest, stillSending: true };
    }
    attempts.push({ channel: ch, status: row ? row.status : 'failed', reason: row ? row.reason : 'The message could not be sent' });
  }

  const direct = rule.mode === 'direct';
  const asked = wantsBest ? null : attempts[0];
  return {
    ok: false, channel: null, attempts, best: wantsBest,
    error: asked && asked.reason ? asked.reason : 'Nothing could be sent from here. Copy the message, or ask a colleague.',
    fallback: firstText ? { text: firstText.text, subject: firstText.subject, canOpenOwnApp: direct } : null,
    status: 200,
  };
}

module.exports = { send, orderFor, LABEL };
