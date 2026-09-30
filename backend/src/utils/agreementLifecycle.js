// ---------------------------------------------------------------------------
// AGREEMENT LIFECYCLE AUTOMATION (user-approved additions, 2026-09-25)
//
//   1. dispatchSigningLink() "Send" delivers the signing link by Email, SMS
//                            and WhatsApp (each only if configured) and
//                            reports per channel: Sent / Not configured /
//                            Skipped / Failed with the reason.
//   2. maybeAutoActivate()  once the agreement is executed — our seal, the
//                            client's seal AND a verified signature — and the
//                            client has signed, it goes ACTIVE by itself, with
//                            an audit entry, instead of waiting for Activate.
//   3. sweepExpiry()        daily: in-app reminders 30 and 7 days before the
//                            agreement's end date (once each, deduplicated via
//                            the audit log) to the client's BDE owner(s) and
//                            the Admin / Super Admin; EXPIRED after the end.
//   4. sweepSigningReminders() hourly: day-3 and day-7 reminders for an
//                            unsigned link (same channels), and an in-app note
//                            to the owners when the link expires.
//
// THE END DATE. Client.agreementEnd is the contract's end when it is filled.
// No agreement on file has one today, so when it is blank the end is DERIVED
// from agreementStart + the term: the generated agreement (utils/agreement.js,
// clause 2.1) runs twelve months and AUTO-RENEWS for successive twelve-month
// terms. A derived end is therefore a RENEWAL date — it gets the 30 / 7-day
// reminders, but it never expires the agreement, because the contract itself
// says it renews. Only an explicit agreementEnd marks an agreement EXPIRED.
// ---------------------------------------------------------------------------

const prisma = require('../db');
const { logAudit } = require('./audit');
const { notifyUsers } = require('./notify');
const { normalizeAgreementStatus } = require('./atsVocab');

const TERM_MONTHS = 12;
const REMINDER_DAYS = [30, 7];
const DAY = 86400000;

// ---- 1. The signing link, on EVERY configured channel -------------------------
function publicBase(req) {
  if (process.env.APP_BASE_URL) return String(process.env.APP_BASE_URL).replace(/\/+$/, '');
  const origin = req && req.headers && req.headers.origin;
  if (origin) return String(origin).replace(/\/+$/, '');
  return req ? `${req.protocol}://${req.get('host')}`.replace(':4010', ':5183') : 'http://localhost:5183';
}
function signingUrl(req, token) {
  return `${publicBase(req)}/agreement/${token}`;
}

// Where a client is reached: the contact on the client record.
function contactsOf(client) {
  return {
    name: String(client.contactName || client.recruitmentContactName || '').trim() || null,
    email: String(client.contactEmail || client.recruitmentContactEmail || '').trim() || null,
    mobile: String(client.contactPhone || '').trim() || null,
    whatsapp: String(client.contactWhatsApp || client.contactPhone || '').trim() || null,
  };
}

// Sends the signing link by Email, SMS and WhatsApp — each only if that
// channel is configured — and returns one honest line per channel:
//   { Email: { outcome: 'Sent' | 'Not configured' | 'Skipped' | 'Failed',
//              to (masked), error }, SMS: …, WhatsApp: … }
// Never throws. Reserved test domains are refused by the mailer.
async function dispatchSigningLink({ client, url, kind = 'send', days }) {
  // eslint-disable-next-line global-require
  const messaging = require('./messaging');
  // eslint-disable-next-line global-require
  const core = require('./messagingCore');
  const c = contactsOf(client);
  const ref = client.agreementId || 'your service agreement';
  const greet = c.name ? `Dear ${c.name},` : 'Hello,';
  const lead = kind === 'reminder' ? 'Reminder: ' : '';
  const validity = days ? ` The link is valid for ${days} days.` : '';
  const results = {};

  const emailText = [
    greet,
    '',
    `${lead}Please review and e-sign the service agreement ${ref} between ${client.name} and TeamLink Consultants.`,
    '',
    `Open the agreement: ${url}`,
    '',
    'Read the agreement, press "OK, Proceed", sign (type your name, draw, or upload your signature) and confirm',
    `with the one-time code we send to your registered mobile number.${validity}`,
    '',
    'If you were not expecting this, please reply and let us know.',
    '',
    '— TeamLink Consultants',
  ].join('\n');
  const shortText = `${lead}TeamLink: please review and e-sign agreement ${ref} for ${client.name}: ${url}`;

  const email = await messaging.send('Email', {
    to: c.email,
    subject: `${lead}Service agreement ${ref} — please review and sign`,
    text: emailText,
    fromName: '',
  });
  results.Email = { outcome: email.outcome, to: c.email ? core.maskEmail(c.email) : null, error: email.ok ? null : email.error };

  const vars = [c.name || client.name, ref, url];
  const sms = await messaging.send('SMS', { to: c.mobile, kind: 'link', text: shortText, vars });
  results.SMS = { outcome: sms.outcome, to: c.mobile ? core.maskMobile(c.mobile) : null, error: sms.ok ? null : sms.error };
  const wa = await messaging.send('WhatsApp', { to: c.whatsapp, kind: 'link', text: shortText, vars });
  results.WhatsApp = { outcome: wa.outcome, to: c.whatsapp ? core.maskMobile(c.whatsapp) : null, error: wa.ok ? null : wa.error };
  return results;
}

function describeDispatch(results) {
  return Object.entries(results || {}).map(([ch, r]) => `${ch}: ${r.outcome}`).join(' · ');
}
function dispatchReasons(results) {
  return Object.entries(results || {}).filter(([, r]) => r.error).map(([ch, r]) => `${ch} — ${r.error}`).join(' | ').slice(0, 1000) || null;
}

// ---- 2. Auto-activation --------------------------------------------------------
const isExecuted = (c) => !!(c && c.agreementCompanySealedAt && c.agreementClientSealedAt && c.agreementVerifiedAt);

// Call after any step that can complete execution. Returns the updated client
// when it activated, otherwise null. Idempotent: an ACTIVE agreement is left.
async function maybeAutoActivate(clientId, { actorUserId = null, via = '' } = {}) {
  const c = await prisma.client.findUnique({ where: { id: clientId } });
  if (!c || normalizeAgreementStatus(c.agreementStatus) !== 'SIGNED' || !isExecuted(c)) return null;
  // Conditional update so two racing requests cannot both activate it.
  const res = await prisma.client.updateMany({
    where: { id: c.id, agreementStatus: c.agreementStatus },
    data: { agreementStatus: 'ACTIVE', agreementActivatedAt: new Date() },
  });
  if (!res.count) return null;
  await logAudit({
    userId: actorUserId, action: 'Agreement auto-activated', entity: 'Client', entityId: c.id,
    fromValue: 'SIGNED', toValue: 'ACTIVE',
    reason: `Client signed and confirmed by OTP, and TeamLink countersigned${via ? ` (${via})` : ''}`,
  });
  const updated = await prisma.client.findUnique({ where: { id: c.id } });
  const recipients = await ownersAndAdmins(c.id);
  await notifyUsers(recipients, {
    title: `${c.name} — agreement is now Active`,
    message: `${c.agreementId || 'The agreement'} was signed by the client (OTP-verified) and countersigned by TeamLink, and is now Active automatically. Requirements for this client can go live.`,
    exceptUserId: actorUserId,
  });
  return updated;
}

// ---- 3. Expiry / renewal reminders ------------------------------------------
async function ownersAndAdmins(clientId) {
  const bdes = await prisma.requirement.findMany({
    where: { clientId, bdeId: { not: null } }, select: { bdeId: true }, distinct: ['bdeId'],
  });
  const admins = await prisma.user.findMany({
    where: {
      status: 'Active',
      OR: [{ role: { in: ['SUPER_ADMIN', 'ADMIN'] } }, { atsRole: { in: ['SUPER_ADMIN', 'ADMIN'] } }, { hrmsRole: { in: ['SUPER_ADMIN', 'ADMIN'] } }],
    },
    select: { id: true },
  });
  const bdeUsers = bdes.length
    ? await prisma.user.findMany({ where: { id: { in: bdes.map((b) => b.bdeId) }, status: 'Active' }, select: { id: true } })
    : [];
  return [...new Set([...bdeUsers.map((u) => u.id), ...admins.map((u) => u.id)])];
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const dayOf = (s) => new Date(`${s}T00:00:00Z`);
const ymd = (d) => d.toISOString().slice(0, 10);
function addMonths(d, n) {
  const x = new Date(d.getTime());
  const day = x.getUTCDate();
  x.setUTCDate(1);
  x.setUTCMonth(x.getUTCMonth() + n);
  const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate();
  x.setUTCDate(Math.min(day, last));
  return x;
}

// { end: 'YYYY-MM-DD', explicit } or null. A derived end is the current
// term's renewal date: the first start + 12k months that is today or later.
function endOf(client, today) {
  if (YMD.test(String(client.agreementEnd || ''))) return { end: client.agreementEnd, explicit: true };
  if (!YMD.test(String(client.agreementStart || ''))) return null;
  const start = dayOf(client.agreementStart);
  let k = 1;
  let end = addMonths(start, TERM_MONTHS);
  while (end < today && k < 200) { k += 1; end = addMonths(start, TERM_MONTHS * k); }
  return { end: ymd(end), explicit: false, term: k };
}

const REMIND_ACTION = (days) => `Agreement expiry reminder (${days} days)`;

// One pass. `onlyClientIds` limits it (tests); `now` is injectable.
async function sweepExpiry({ now = new Date(), onlyClientIds = null } = {}) {
  const today = dayOf(ymd(now));
  const clients = await prisma.client.findMany({
    where: {
      agreementStatus: { in: ['ACTIVE', 'SIGNED', 'CONFIRMED'] },
      ...(onlyClientIds ? { id: { in: onlyClientIds } } : {}),
    },
    select: {
      id: true, name: true, agreementId: true, agreementStatus: true, agreementStart: true, agreementEnd: true,
    },
  });
  const out = { checked: clients.length, reminded: [], expired: [] };
  for (const c of clients) {
    const e = endOf(c, today);
    if (!e) continue;
    const daysLeft = Math.round((dayOf(e.end) - today) / DAY);

    if (e.explicit && daysLeft < 0) {
      // eslint-disable-next-line no-await-in-loop
      const res = await prisma.client.updateMany({ where: { id: c.id, agreementStatus: c.agreementStatus }, data: { agreementStatus: 'EXPIRED' } });
      if (res.count) {
        // eslint-disable-next-line no-await-in-loop
        await logAudit({
          action: 'Agreement expired', entity: 'Client', entityId: c.id,
          fromValue: normalizeAgreementStatus(c.agreementStatus), toValue: 'EXPIRED', reason: `End date ${e.end} has passed (daily sweep)`,
        });
        // eslint-disable-next-line no-await-in-loop
        await notifyUsers(await ownersAndAdmins(c.id), {
          title: `${c.name} — agreement expired`,
          message: `${c.agreementId || 'The agreement'} ended on ${e.end} and is now Expired. Requirements for this client cannot go live until it is renewed.`,
        });
        out.expired.push({ id: c.id, name: c.name, end: e.end });
      }
      continue;
    }
    if (daysLeft < 0 || daysLeft > REMINDER_DAYS[0]) continue;

    // The most urgent reminder that applies — a client first seen at 5 days
    // out gets the 7-day one, not a stale 30-day one as well.
    const stage = [...REMINDER_DAYS].sort((a, b) => a - b).find((d) => daysLeft <= d);
    // eslint-disable-next-line no-await-in-loop
    const sent = await prisma.auditLog.findFirst({
      where: { action: REMIND_ACTION(stage), entityId: c.id, toValue: e.end }, select: { id: true },
    });
    if (sent) continue;
    // eslint-disable-next-line no-await-in-loop
    const recipients = await ownersAndAdmins(c.id);
    const what = e.explicit ? 'ends' : 'renews (12-month term)';
    // eslint-disable-next-line no-await-in-loop
    await notifyUsers(recipients, {
      title: `${c.name} — agreement ${e.explicit ? 'expires' : 'renews'} in ${daysLeft} day(s)`,
      message: `${c.agreementId || 'The service agreement'} ${what} on ${e.end}.${e.explicit ? ' Renew it before then or requirements for this client stop going live.' : ' Review the terms before the renewal date.'}`,
    });
    // eslint-disable-next-line no-await-in-loop
    await logAudit({
      action: REMIND_ACTION(stage), entity: 'Client', entityId: c.id, toValue: e.end,
      reason: `${daysLeft} day(s) left · ${e.explicit ? 'agreement end date' : 'derived renewal date (start + 12-month term)'} · ${recipients.length} recipient(s)`,
    });
    out.reminded.push({ id: c.id, name: c.name, end: e.end, explicit: e.explicit, daysLeft, stage, recipients: recipients.length });
  }
  return out;
}

// ---- 4. Reminders for unsigned agreements -----------------------------------
// Day 3 and day 7 after the link went out, on the same channels as the send,
// once each per link (deduplicated through the audit trail with the send time
// as the key). When the link expires the BDE owner(s) and Admins are told in
// the app, once, so somebody resends it.
const SIGN_REMINDER_DAYS = [3, 7];

async function sweepSigningReminders({ now = new Date(), onlyClientIds = null, req = null } = {}) {
  // eslint-disable-next-line global-require
  const signing = require('./agreementSigning');
  const clients = await prisma.client.findMany({
    where: {
      agreementStatus: { in: signing.OUT_FOR_SIGNATURE },
      esignToken: { not: null },
      agreementSentAt: { not: null },
      ...(onlyClientIds ? { id: { in: onlyClientIds } } : {}),
    },
  });
  const out = { checked: clients.length, reminded: [], expired: [] };
  for (const c of clients) {
    const sentAt = new Date(c.agreementSentAt);
    const key = sentAt.toISOString();
    const age = (now - sentAt) / DAY;
    const expiresAt = signing.linkExpiresAt(c);
    if (expiresAt && expiresAt < now) {
      // eslint-disable-next-line no-await-in-loop
      const told = await prisma.auditLog.findFirst({ where: { action: signing.ACTION.expiredLink, entityId: c.id, toValue: key }, select: { id: true } });
      if (!told) {
        // eslint-disable-next-line no-await-in-loop
        await logAudit({ action: signing.ACTION.expiredLink, entity: 'Client', entityId: c.id, toValue: key, reason: `Sent ${key.slice(0, 10)}, unsigned after ${signing.LINK_DAYS} days` });
        // eslint-disable-next-line no-await-in-loop
        await notifyUsers(await ownersAndAdmins(c.id), {
          title: `${c.name} — agreement signing link expired`,
          message: `${c.agreementId || 'The agreement'} was not signed within ${signing.LINK_DAYS} days. Open the client's Agreement tab and press Resend to send a new link.`,
        });
        out.expired.push({ id: c.id, name: c.name });
      }
      continue;
    }
    const due = SIGN_REMINDER_DAYS.filter((d) => age >= d).pop();
    if (!due) continue;
    // eslint-disable-next-line no-await-in-loop
    const sent = await prisma.auditLog.findFirst({ where: { action: signing.ACTION.reminder(due), entityId: c.id, toValue: key }, select: { id: true } });
    if (sent) continue;
    // eslint-disable-next-line no-await-in-loop
    const results = await dispatchSigningLink({ client: c, url: signingUrl(req, c.esignToken), kind: 'reminder' });
    // eslint-disable-next-line no-await-in-loop
    await logAudit({
      action: signing.ACTION.reminder(due), entity: 'Client', entityId: c.id, toValue: key,
      reason: `${describeDispatch(results)}${dispatchReasons(results) ? ` · ${dispatchReasons(results)}` : ''}`.slice(0, 1000),
    });
    out.reminded.push({ id: c.id, name: c.name, day: due, results });
  }
  return out;
}

let timer = null;
function startExpirySweep() {
  if (timer) return;
  const run = () => sweepExpiry()
    .then((r) => { if (r.reminded.length || r.expired.length) console.log(`[agreement sweep] ${r.reminded.length} reminder(s), ${r.expired.length} expired`); })
    .catch((e) => console.error('[agreement sweep]', e.message));
  setTimeout(run, 120000).unref?.();
  timer = setInterval(run, DAY);
  if (timer.unref) timer.unref();
  // Unsigned-agreement reminders and link expiry: hourly.
  const remind = () => sweepSigningReminders()
    .then((r) => { if (r.reminded.length || r.expired.length) console.log(`[agreement reminders] ${r.reminded.length} reminder(s), ${r.expired.length} expired link(s)`); })
    .catch((e) => console.error('[agreement reminders]', e.message));
  setTimeout(remind, 180000).unref?.();
  const hourly = setInterval(remind, 3600000);
  if (hourly.unref) hourly.unref();
}

module.exports = {
  signingUrl, contactsOf, dispatchSigningLink, describeDispatch, dispatchReasons,
  isExecuted, maybeAutoActivate, endOf, sweepExpiry, startExpirySweep, ownersAndAdmins,
  sweepSigningReminders, SIGN_REMINDER_DAYS,
};
