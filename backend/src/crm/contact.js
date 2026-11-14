// ---------------------------------------------------------------------------
// CRM - CALL, WHATSAPP AND EMAIL FROM A LEAD / DEAL / CUSTOMER (founder 2026-11-14: "call, mail, wtsp dheyni meedha click chesina work avvali; integration
// related information kavali anna integrations lo vuntadhi, akkada nundi techukoni configure chesko; naaku proper ga integrate avvali").
//
// The three buttons use whatever Administration -> Integrations has connected, nothing is asked again here:
//   Email     Email (SMTP) channel (utils/mailer.js), from the person's own address with the company relay, replies go to them
//   WhatsApp  the WhatsApp channels (channels/index.js: Business API number / QR-linked number, the person's own number when they have one)
//   Call      Cloud Telephony (Exotel click-to-call, utils/callGateway.js): the person's own phone (employee profile) rings first, then the customer
//             is connected; the result (answered / not / how long) is written on the timeline when Exotel reports it.
// When a channel is not connected the screen says so and offers the person's own app (mail app / wa.me / the phone's dialler), and says that
// TeamLink cannot see whether that was sent. EVERY contact is written on the record's timeline (CrmActivity), which also makes a New lead Contacted.
// Self-contained: only the CRM's own records are read; the integrations are the company's shared services (not ATS data).
// ---------------------------------------------------------------------------
const DB = require('./schema');
const S = require('./service');

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const KINDS = ['lead', 'deal', 'account', 'contact'];
const CH = { Email: 'email', WhatsApp: 'whatsapp' };

// who the message goes to: the record's own details, else the contact who decides on the account
async function recipientOf(user, kind, id) {
  const r = S.roleOf(user);
  if (!KINDS.includes(kind)) return { error: S.fail(400, 'Say whose record this is.') };
  const row = await S.getRow(kind, id);
  if (!row || !S.canEditRow(user, r, row)) return { error: S.fail(404, 'This record is not there, or it is not yours.') };
  const firstContact = async (accountId) => (accountId ? DB.one('SELECT * FROM "CrmContact" WHERE "accountId" = ? ORDER BY CASE "role" WHEN \'Decision maker\' THEN 0 WHEN \'HR\' THEN 1 ELSE 2 END, "createdAt" LIMIT 1', accountId).catch(() => null) : null);
  let company = ''; let contactName = ''; let phone = ''; let email = '';
  if (kind === 'lead') { company = row.company; contactName = row.contactName; phone = row.phone; email = row.email; }
  if (kind === 'contact') {
    const a = row.accountId ? await S.getRow('account', row.accountId) : null;
    company = (a && a.name) || ''; contactName = row.name; phone = row.phone; email = row.email;
  }
  if (kind === 'account' || kind === 'deal') {
    const accountId = kind === 'account' ? row.id : row.accountId;
    const a = kind === 'account' ? row : (accountId ? await S.getRow('account', accountId) : null);
    const c = (kind === 'deal' && row.contactId ? await S.getRow('contact', row.contactId) : null) || await firstContact(accountId);
    company = (a && a.name) || (kind === 'deal' ? row.title : ''); contactName = (c && c.name) || '';
    phone = (c && c.phone) || (a && a.phone) || ''; email = (c && c.email) || (a && a.email) || '';
  }
  return { row, kind, company: company || '', contactName: contactName || '', name: contactName || company || '', phone: phone || '', email: email || '' };
}

// What is connected right now, for the screen (no secret ever leaves here).
async function ready(user) {
  const out = {};
  try {
    const ec = await require('../utils/mailer').emailConfig(); // eslint-disable-line global-require
    out.email = { ready: !!ec.configured, reason: ec.configured ? '' : (ec.reason || 'Email is not connected.'), from: ec.configured ? (ec.fromAddress || null) : null };
  } catch (e) { out.email = { ready: false, reason: 'Email is not connected.', from: null }; }
  try {
    const ws = await require('../channels').status('WhatsApp'); // eslint-disable-line global-require
    out.whatsapp = { ready: !!ws.configured, via: ws.via || null, reason: ws.configured ? '' : (ws.reason || 'WhatsApp is not connected.') };
  } catch (e) { out.whatsapp = { ready: false, via: null, reason: 'WhatsApp is not connected.' }; }
  try {
    const gw = await require('../utils/callGateway').callConfig(); // eslint-disable-line global-require
    const own = await require('../utils/messageChannels').ownContact(user); // eslint-disable-line global-require
    out.call = { clickToCall: !!gw.configured, provider: gw.configured ? 'Exotel' : null, reason: gw.configured ? '' : (gw.reason || 'Cloud Telephony is not connected.'), myPhone: !!own.phone, recording: !!gw.record };
  } catch (e) { out.call = { clickToCall: false, provider: null, reason: 'Cloud Telephony is not connected.', myPhone: false, recording: false }; }
  return S.okBody(out);
}

// the first words of a message the person can change: greeting by first name, the person's name at the foot
async function draftFor(user, kind, id) {
  const x = await recipientOf(user, kind, id);
  if (x.error) return x.error;
  const first = String(x.contactName || '').split(/\s+/)[0];
  const me = user.name || 'TeamLink';
  return S.okBody({
    to: { name: x.name, company: x.company, phone: x.phone, email: x.email },
    email: { subject: `TeamLink Consultants: recruitment support${x.company ? ` for ${x.company}` : ''}`, text: `Hello${first ? ` ${first}` : ''},\n\n\n\nRegards,\n${me}\nTeamLink Consultants` },
    whatsapp: { text: `Hello${first ? ` ${first}` : ''}, this is ${me} from TeamLink Consultants. ` },
  });
}

// One email or WhatsApp message, really sent, then written on the timeline.
async function send(user, { kind, id, channel, to, subject, text } = {}) {
  if (!CH[channel]) return S.fail(400, 'Pick Email or WhatsApp.');
  const x = await recipientOf(user, kind, id);
  if (x.error) return x.error;
  const body = clip(text, 4000);
  if (!body) return S.fail(400, 'Write the message first.');
  let result;
  if (channel === 'Email') {
    const addr = clip(to || x.email, 200);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) return S.fail(400, x.email || to ? 'That email address does not look right.' : 'This record has no email address. Type one in the To box.');
    const CMP = require('./campaigns'); // eslint-disable-line global-require
    if (await CMP.optedOut('email', addr).catch(() => false)) return S.fail(409, 'This address asked not to be emailed (unsubscribed). TeamLink does not send to it.');
    const subj = clip(subject, 200);
    if (!subj) return S.fail(400, 'Write the subject.');
    const own = await require('../utils/messageChannels').ownContact(user); // eslint-disable-line global-require
    result = await require('../utils/mailer').sendMail({ to: addr, subject: subj, text: body, senderEmail: own.email || undefined, senderName: own.name || user.name }); // eslint-disable-line global-require
    if (!result.ok) return S.fail(result.notConfigured ? 409 : 502, result.notConfigured ? `Email is not connected: ${result.error}` : `The email was not sent: ${result.error || 'the mail server refused it.'}`, { notConfigured: !!result.notConfigured });
    await S.addActivity(user, { kind: 'email', [`${kind}Id`]: id, subject: `Email sent: ${subj}`, note: `To ${addr}\n\n${body}` });
    return S.okBody({ ok: true, channel, to: addr, via: 'Email (SMTP)', deduped: !!result.deduped });
  }
  // WhatsApp
  const m = require('../utils/messagingCore').normalizeMobile(to || x.phone); // eslint-disable-line global-require
  if (!m.ok) return S.fail(400, (to || x.phone) ? `That number does not look right: ${m.reason}` : 'This record has no phone number. Type one in the To box.');
  const CMP = require('./campaigns'); // eslint-disable-line global-require
  if (await CMP.optedOut('whatsapp', m.e164).catch(() => false)) return S.fail(409, 'This number asked not to be messaged on WhatsApp. TeamLink does not send to it.');
  result = await require('../channels/send').sendWhatsApp({ // eslint-disable-line global-require
    to: m.e164, text: body, kind: 'direct', meta: { audience: 'crm', personName: x.name, senderUserId: user.id, senderName: user.name, purpose: 'CRM message' },
  });
  if (!result.ok) {
    const why = result.notConfigured ? 'WhatsApp is not connected.' : (result.error || 'WhatsApp refused the message.');
    return S.fail(result.notConfigured ? 409 : 502, `The WhatsApp message was not sent: ${why}`, { notConfigured: !!result.notConfigured, outsideWindow: /24|re-?engage|template|131047/i.test(String(result.error || '')) });
  }
  await S.addActivity(user, { kind: 'whatsapp', [`${kind}Id`]: id, subject: 'WhatsApp message sent', note: `To +${m.e164}\n\n${body}` });
  return S.okBody({ ok: true, channel, to: `+${m.e164}`, via: result.provider || 'WhatsApp' });
}

// The person opened their own app instead (mail app / wa.me / the phone's dialler): TeamLink cannot see whether it was sent, and says so on the timeline.
async function opened(user, { kind, id, channel, note } = {}) {
  const ch = { Email: 'email', WhatsApp: 'whatsapp', Call: 'call' }[channel];
  if (!ch) return S.fail(400, 'Say how.');
  const x = await recipientOf(user, kind, id);
  if (x.error) return x.error;
  const word = { Email: 'Mail app opened', WhatsApp: 'WhatsApp opened', Call: 'Call placed from the phone' }[channel];
  await S.addActivity(user, { kind: ch, [`${kind}Id`]: id, subject: `${word} for ${x.name || 'this contact'}`, note: clip(note, 1000) || (channel === 'Call' ? '' : 'Opened in the person\'s own app: TeamLink cannot see whether it was sent.') });
  return S.okBody({ ok: true });
}

// Click-to-call through Cloud Telephony: the person's own phone rings first, then the customer.
async function call(user, { kind, id, to } = {}) {
  const x = await recipientOf(user, kind, id);
  if (x.error) return x.error;
  const gw = require('../utils/callGateway'); // eslint-disable-line global-require
  const own = await require('../utils/messageChannels').ownContact(user); // eslint-disable-line global-require
  const number = clip(to || x.phone, 40);
  if (!number) return S.fail(400, 'This record has no phone number. Type one in the number box.');
  if (!own.phone) return S.fail(409, 'Your own phone number is not on your employee profile, so TeamLink does not know which phone to ring first. Add it on your profile.', { needsMyPhone: true });
  const cfg = await gw.callConfig().catch(() => ({ configured: false, reason: 'Cloud Telephony is not connected.' }));
  if (!cfg.configured) return S.fail(409, cfg.reason || 'Cloud Telephony is not connected.', { notConfigured: true });
  const norm = require('../utils/messagingCore').normalizeMobile(number); // eslint-disable-line global-require
  if (!norm.ok) return S.fail(400, `That number does not look right: ${norm.reason}`);
  // the timeline line is made first so its id can travel with the call and the result can be written on it
  const act = await S.addActivity(user, { kind: 'call', [`${kind}Id`]: id, subject: `Call through TeamLink to ${x.name || number}`, note: 'Calling... (the result is added when the call ends)' });
  const actId = act.body && act.body.activity ? act.body.activity.id : null;
  const base = String(process.env.APP_BASE_URL || '').replace(/\/+$/, '') || null;
  const out = await gw.startCall({ agent: own.phone, to: number, ref: actId ? `crm:${actId}` : undefined, callbackBase: base });
  if (!out.ok) {
    if (actId) await DB.run('UPDATE "CrmActivity" SET "note" = ? WHERE "id" = ?', `The call did not start: ${out.error}`, actId);
    return S.fail(out.notConfigured ? 409 : (out.invalid ? 400 : (out.transient ? 503 : 502)), out.error, { notConfigured: !!out.notConfigured });
  }
  if (actId) await DB.run('UPDATE "CrmActivity" SET "note" = ? WHERE "id" = ?', `Your phone (${own.name}) rings first, then ${x.name || number} is connected.${out.recording ? ' Recording is ON.' : ''}${out.sandbox ? ' (test server, no real call)' : ''}`, actId);
  return S.okBody({ ok: true, callSid: out.callSid, sandbox: !!out.sandbox, recording: !!out.recording, activityId: actId, message: `Your phone (${own.name}) will ring first. Pick up, and TeamLink then connects ${x.name || number}.` });
}

// Exotel reported how the call ended (utils/messageDelivery.js applyCall hands CRM calls here): written on the call's timeline line.
async function applyCallResult(ref, detail) {
  const m = /^crm:(.+)$/.exec(String(ref || ''));
  if (!m) return 0;
  const row = await DB.one('SELECT "id", "note" FROM "CrmActivity" WHERE "id" = ?', m[1]).catch(() => null);
  if (!row) return 0;
  await DB.run('UPDATE "CrmActivity" SET "note" = ? WHERE "id" = ?', clip(detail, 1000), row.id);
  return 1;
}

module.exports = { ready, draftFor, send, opened, call, applyCallResult };
