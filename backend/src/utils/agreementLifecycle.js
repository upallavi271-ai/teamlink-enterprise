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
    // a label typed into the name box ("Name:", "Name", "-") is not a name (2026-10-31: the email said "Dear Name:,")
    // and a label stuck on the end ("vasu chitturi Name:") is dropped
    name: ((v) => (/^(name|contact|contact name|mr|ms|sir|madam|na|n\/a|-+)\W*$/i.test(v) ? '' : v))(String(client.contactName || client.recruitmentContactName || '').replace(/\s+(?:name|designation|title)\s*:.*$/i, '').trim()) || null,
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

  void validity; // the online signing link is no longer offered (signing is DigiLocker only, 2026-10-31)
  // THE CLIENT'S STAMP PAGE (founder 2026-10-31: "client ey stamp veyyali"): the link opens a page where the client puts their
  // company stamp on and downloads the agreement to eSign WITH both stamps printed (routes/agreementSeal.js GET /token/:token/esign-pdf).
  // So the PDF to sign is not attached any more - an attached copy would have no client stamp.
  const stampUrl = url ? `${String(url).replace(/\/+$/, '')}/stamp` : null;
  const pdf = null;
  const fileName = `${String(client.agreementId || 'Agreement').replace(/[^\w.-]/g, '')}-${String(client.name || 'client').replace(/[^\w.-]+/g, '-').slice(0, 40)}.pdf`;
  // TEAMLINK'S OWN eSIGNED COPY (DigiLocker), for the client's records: TeamLink signs first (2026-10-31)
  let ours = null;
  try {
    const SF = require('../routes/agreementSignedFiles'); // eslint-disable-line global-require
    const f = (await SF.filesOf(client.id)).filter((x) => x.kind === 'TeamLink eSigned copy (DigiLocker)' && x.esign && x.esign.valid).sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt))[0];
    if (f) {
      const d = await prisma.clientDocument.findUnique({ where: { id: f.id }, select: { fileStored: true } });
      const fp = d ? require('./attachments').resolveStored(d.fileStored) : null; // eslint-disable-line global-require
      if (fp) ours = { filename: fileName.replace(/\.pdf$/, '-signed-by-TeamLink.pdf'), content: require('fs').readFileSync(fp), contentType: 'application/pdf' }; // eslint-disable-line global-require
    }
  } catch { ours = null; }

  const emailText = [
    greet,
    '',
    `${lead}Here is the service agreement ${ref} between ${client.name} and TeamLink Consultants.`,
    ...(ours ? [`TeamLink has already signed it with Aadhaar eSign: our signed copy is attached too (${ours.filename}) for your records.`] : []),
    'Kindly put your company stamp on it and sign it with your Aadhaar eSign in DigiLocker (free, government of India):',
    '',
    `1. Open this link: ${stampUrl || '(ask your TeamLink contact for the link)'}`,
    '2. Upload a photo or scan of your company stamp there.',
    '3. Press "Download agreement PDF to eSign": the agreement comes with your stamp and ours printed on it.',
    '4. Open https://www.digilocker.gov.in and sign in with your Aadhaar (your Aadhaar must be linked to your mobile). Go to Drive, press Upload and choose that PDF.',
    '5. On the uploaded file, press eSign and enter the Aadhaar OTP sent to your mobile.',
    '6. Download the signed PDF and upload it on the same page (step 4): check the preview and press Submit. (You can also reply to this email with that file attached, as it is.)',
    '',
    'Please do not edit, merge, print or compress the signed file - that would remove the digital signature.',
    ours ? "Your signed copy and TeamLink's signed copy together form the agreement." : 'TeamLink signs its own copy the same way. Both signed copies together form the agreement.',
    '',
    'If you were not expecting this, please reply and let us know.',
    '',
    '— TeamLink Consultants',
  ].join('\n');
  const shortText = `${lead}TeamLink: agreement ${ref} for ${client.name} is in your email${c.email ? ` (${core.maskEmail(c.email)})` : ''}. Put your company stamp on it${stampUrl ? ` here: ${stampUrl}` : ''}, then eSign it with Aadhaar in DigiLocker and upload the signed PDF on the same page.`;

  const email = await messaging.send('Email', {
    to: c.email,
    subject: `${lead}Service agreement ${ref} — please eSign with Aadhaar (DigiLocker)`,
    text: emailText,
    fromName: '',
    attachments: [...(pdf ? [{ filename: fileName, content: pdf, contentType: 'application/pdf' }] : []), ...(ours ? [ours] : [])],
  });
  results.Email = { outcome: email.outcome, to: c.email ? core.maskEmail(c.email) : null, error: email.ok ? null : (email.error || null), attached: !!pdf, teamlinkCopy: !!ours, stampLink: !!stampUrl };

  // a short note by SMS / WhatsApp that the agreement is in the email (no link: the PDF travels by email)
  const sms = await messaging.send('SMS', { to: c.mobile, kind: 'text', text: shortText });
  results.SMS = { outcome: sms.outcome, to: c.mobile ? core.maskMobile(c.mobile) : null, error: sms.ok ? null : sms.error };
  const wa = await messaging.send('WhatsApp', { to: c.whatsapp, kind: 'text', text: shortText });
  results.WhatsApp = { outcome: wa.outcome, to: c.whatsapp ? core.maskMobile(c.whatsapp) : null, error: wa.ok ? null : wa.error };
  return results;
}

// ---- 1b. THANK YOU, once both sides have signed (founder 2026-10-31: "mottham complete ayyaka thank you ani raavali client ki") ----
// Email: a thank-you with the client's signed copy, TeamLink's signed copy and the signature summary attached; SMS / WhatsApp: a
// short thank-you saying the copies are in the email. Same channel rules and result shape as dispatchSigningLink. Never throws.
// base: the address the summary's "click to open" links start with (none = the copies are only attached)
async function dispatchThankYou(clientId, { base: linkBase = null } = {}) {
  const messaging = require('./messaging'); // eslint-disable-line global-require
  const core = require('./messagingCore'); // eslint-disable-line global-require
  const SF = require('../routes/agreementSignedFiles'); // eslint-disable-line global-require
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client) return {};
  const c = contactsOf(client);
  const ref = client.agreementId || 'the service agreement';
  const base = `${String(client.agreementId || 'Agreement').replace(/[^\w.-]/g, '')}-${String(client.name || 'client').replace(/[^\w.-]+/g, '-').slice(0, 40)}`;
  const copies = await SF.esignCopies(clientId, linkBase || (process.env.APP_BASE_URL ? String(process.env.APP_BASE_URL).replace(/\/+$/, '') : null)).catch(() => ({}));
  const attachments = [];
  if (copies.them) attachments.push({ filename: `${base}-signed-by-client.pdf`, content: copies.them.buf, contentType: 'application/pdf' });
  if (copies.us) attachments.push({ filename: `${base}-signed-by-TeamLink.pdf`, content: copies.us.buf, contentType: 'application/pdf' });
  try {
    if (copies.us || copies.them) attachments.push({ filename: `${base}-signature-summary.pdf`, content: await SF.summaryBuffer(client, copies), contentType: 'application/pdf' });
  } catch (e) { console.error('[agreement thank-you] summary not made:', e.message); } // eslint-disable-line no-console
  const day = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : null);
  const since = day(client.agreementActivatedAt || new Date());
  const text = [
    c.name ? `Dear ${c.name},` : 'Hello,',
    '',
    `Thank you for signing the service agreement ${ref} with Aadhaar eSign.`,
    `Both sides have now signed: the agreement between ${client.legalName || client.name} and TeamLink Consultants is active from ${since}.`,
    '',
    'Attached for your records:',
    ...(copies.them ? ['- your signed copy (Aadhaar eSign)'] : []),
    ...(copies.us ? ["- TeamLink's signed copy (Aadhaar eSign)"] : []),
    '- the signature summary: both signatures on one page, each checked valid',
    '',
    'Both signed copies together form the agreement. Please keep them as they are: editing, merging or printing a copy removes its digital signature.',
    '',
    `We look forward to working with you.${client.bdeOwner ? ` ${client.bdeOwner} from our team will be in touch about your hiring needs.` : ''}`,
    '',
    '— TeamLink Consultants',
  ].join('\n');
  const shortText = `TeamLink: thank you! Agreement ${ref} is signed by both sides and active. The signed copies are in your email${c.email ? ` (${core.maskEmail(c.email)})` : ''}.`;
  const results = {};
  const email = await messaging.send('Email', { to: c.email, subject: `Thank you - agreement ${ref} is signed and active`, text, fromName: '', attachments });
  results.Email = { outcome: email.outcome, to: c.email ? core.maskEmail(c.email) : null, error: email.ok ? null : (email.error || null), attached: attachments.length };
  const sms = await messaging.send('SMS', { to: c.mobile, kind: 'text', text: shortText });
  results.SMS = { outcome: sms.outcome, to: c.mobile ? core.maskMobile(c.mobile) : null, error: sms.ok ? null : sms.error };
  const wa = await messaging.send('WhatsApp', { to: c.whatsapp, kind: 'text', text: shortText });
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
// 2026-10-05 (user): Active only when BOTH sides have a signature AND a company
// stamp, and the client's signature was confirmed with the code.
function missingSeals(c) {
  const teamlink = [];
  const client = [];
  if (!c) return { teamlink: ['signature', 'stamp'], client: ['signature', 'stamp'] };
  if (!c.agreementCompanySignFile) teamlink.push('signature');
  if (!c.agreementCompanyStampFile) teamlink.push('stamp');
  if (!c.agreementClientSignFile && !(c.agreementEsignProvider === 'eMudhra' && c.agreementEsignTxnId)) client.push('signature');
  if (!c.agreementClientStampFile) client.push('stamp');
  if (!c.agreementVerifiedAt) client.push('code');
  return { teamlink, client };
}
const isExecuted = (c) => {
  const m = missingSeals(c);
  return !!(c && c.agreementCompanySealedAt && c.agreementClientSealedAt && !m.teamlink.length && !m.client.length);
};

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
  // Jobs parked at Agreement Check go live + their TLs are told (e2e gap 7).
  // eslint-disable-next-line global-require
  await require('./openParkedJobs').openParkedJobs(c.id, { actorUserId });
  return updated;
}

// ---- 3. Expiry / renewal reminders ------------------------------------------
// Never a test login (ZZTEST / example.test) as a recipient of a real alert.
const NOT_TEST_USER = [{ name: { contains: 'zztest' } }, { email: { contains: 'example.test' } }];

async function ownersAndAdmins(clientId) {
  const bdes = await prisma.requirement.findMany({
    where: { clientId, bdeId: { not: null } }, select: { bdeId: true }, distinct: ['bdeId'],
  });
  // Spec 6: the client's OWNER BDE (Client.bdeOwner holds the name) too.
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { bdeOwner: true } });
  const ownerName = String((client && client.bdeOwner) || '').trim();
  const admins = await prisma.user.findMany({
    where: {
      status: 'Active',
      NOT: NOT_TEST_USER,
      OR: [{ role: { in: ['SUPER_ADMIN', 'ADMIN'] } }, { atsRole: { in: ['SUPER_ADMIN', 'ADMIN'] } }, { hrmsRole: { in: ['SUPER_ADMIN', 'ADMIN'] } }],
    },
    select: { id: true },
  });
  const bdeOr = [
    ...(bdes.length ? [{ id: { in: bdes.map((b) => b.bdeId) } }] : []),
    ...(ownerName ? [{ name: ownerName, OR: [{ atsRole: 'BDE' }, { role: 'BDE' }] }] : []),
    // The BDE TL works every client's agreement (2026-10-09): told too.
    { atsRole: 'TL', OR: [{ atsDepartment: 'BDE' }, { atsScopeDepartments: { contains: 'BDE' } }] },
  ];
  const bdeUsers = bdeOr.length
    ? await prisma.user.findMany({ where: { status: 'Active', NOT: NOT_TEST_USER, OR: bdeOr }, select: { id: true } })
    : [];
  return [...new Set([...bdeUsers.map((u) => u.id), ...admins.map((u) => u.id)])];
}

// Spec 6 — the renewal alert by E-MAIL as well, only when Agreement settings
// say so (renewalEmail, OFF by default). One mail per recipient with an
// address; never throws. In the test sandbox the mailer is a fake transport.
async function emailRenewal(userIds, { subject, text }) {
  const settings = await require('./agreementSettings').agreementSettings(); // eslint-disable-line global-require
  if (!settings.renewalEmail || !userIds.length) return { emailed: 0, skipped: true };
  const mailer = require('./mailer'); // eslint-disable-line global-require
  const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { email: true } });
  let emailed = 0;
  for (const u of users) {
    if (!u.email) continue;
    // eslint-disable-next-line no-await-in-loop
    const r = await mailer.sendMail({ to: u.email, subject, text, useEmployeeFrom: false, fromName: '' }).catch(() => ({ ok: false }));
    if (r && r.ok) emailed += 1;
  }
  return { emailed, skipped: false };
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
  // Spec 6 — the alert days are an Admin setting (default 30 and 7).
  const reminderDays = (await require('./agreementSettings').agreementSettings()).renewalDays || REMINDER_DAYS; // eslint-disable-line global-require
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
    if (daysLeft < 0 || daysLeft > Math.max(...reminderDays)) continue;

    // The most urgent reminder that applies — a client first seen at 5 days
    // out gets the 7-day one, not a stale 30-day one as well.
    const stage = [...reminderDays].sort((a, b) => a - b).find((d) => daysLeft <= d);
    // eslint-disable-next-line no-await-in-loop
    const sent = await prisma.auditLog.findFirst({
      where: { action: REMIND_ACTION(stage), entityId: c.id, toValue: e.end }, select: { id: true },
    });
    if (sent) continue;
    // eslint-disable-next-line no-await-in-loop
    const recipients = await ownersAndAdmins(c.id);
    const what = e.explicit ? 'ends' : 'renews (12-month term)';
    const alert = {
      title: `${c.name} — agreement ${e.explicit ? 'expires' : 'renews'} in ${daysLeft} day(s)`,
      message: `${c.agreementId || 'The service agreement'} ${what} on ${e.end}.${e.explicit ? ' Renew it before then or requirements for this client stop going live.' : ' Review the terms before the renewal date.'}`,
    };
    // eslint-disable-next-line no-await-in-loop
    await notifyUsers(recipients, alert);
    // eslint-disable-next-line no-await-in-loop
    const mail = await emailRenewal(recipients, { subject: alert.title, text: `${alert.message}

Open TeamLink → Clients → ${c.name} → Agreement.

— TeamLink` });
    // eslint-disable-next-line no-await-in-loop
    await logAudit({
      action: REMIND_ACTION(stage), entity: 'Client', entityId: c.id, toValue: e.end,
      reason: `${daysLeft} day(s) left · ${e.explicit ? 'agreement end date' : 'derived renewal date (start + 12-month term)'} · ${recipients.length} recipient(s)${mail.skipped ? '' : ` · ${mail.emailed} e-mailed`}`,
    });
    out.reminded.push({ id: c.id, name: c.name, end: e.end, explicit: e.explicit, daysLeft, stage, recipients: recipients.length, emailed: mail.emailed });
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
        await logAudit({ action: signing.ACTION.expiredLink, entity: 'Client', entityId: c.id, toValue: key, reason: `Sent ${key.slice(0, 10)}, unsigned after ${signing.linkMeta(c).days} days` });
        // eslint-disable-next-line no-await-in-loop
        await notifyUsers(await ownersAndAdmins(c.id), {
          title: `${c.name} — agreement signing link expired`,
          message: `${c.agreementId || 'The agreement'} was not signed within ${signing.linkMeta(c).days} days. Open the client's Agreement tab and make a new link.`,
        });
        out.expired.push({ id: c.id, name: c.name });
      }
      continue;
    }
    // A link made with "Create agreement link" is shared by the user; nothing
    // goes to the client by itself (2026-10-05). The expiry notice above still does.
    if (signing.linkMeta(c).manual) continue;
    const due = SIGN_REMINDER_DAYS.filter((d) => age >= d).pop();
    if (!due) continue;
    // eslint-disable-next-line no-await-in-loop
    const sent = await prisma.auditLog.findFirst({ where: { action: signing.ACTION.reminder(due), entityId: c.id, toValue: key }, select: { id: true } });
    if (sent) continue;
    // eslint-disable-next-line no-await-in-loop
    // The link token is stored hashed; the server re-derives it (utils/agreementSigning.js).
    const linkToken = signing.tokenFor(c);
    if (!linkToken) continue;
    // eslint-disable-next-line no-await-in-loop
    const results = await dispatchSigningLink({ client: c, url: signingUrl(req, linkToken), kind: 'reminder' });
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
  // "Make it Active" reminders (2026-10-05): checked every 15 minutes; each
  // client is reminded once per due day, at the time in Agreement settings.
  // eslint-disable-next-line global-require
  const activeRemind = () => require('./agreementActivateReminders').sweepActivateReminders()
    .then((r) => { if (r.reminded && r.reminded.length) console.log(`[agreement make-Active reminders] ${r.reminded.length} sent`); })
    .catch((e) => console.error('[agreement make-Active reminders]', e.message));
  setTimeout(activeRemind, 240000).unref?.();
  const quarter = setInterval(activeRemind, 15 * 60000);
  if (quarter.unref) quarter.unref();
}

// May this login make and send the agreement link for this client WITHOUT being
// an Admin? (user, 2026-10-09: the BDE team gets the agreement ready and sends
// it.) The client's own BDE - own client, or a desk client with no BDE yet - and
// the BDE TL for any client. Editing the agreement and TeamLink's own seal stay
// with the Admin.
async function bdeMayLink(user, client) {
  if (!user || !client) return false;
  const scope = require('./scope'); // eslint-disable-line global-require
  const access = await require('./agreementSigning').agreementAccess(user, client); // eslint-disable-line global-require
  if (access.as === 'tl') return scope.isBdeTl(user);
  if (access.as !== 'bde') return false;
  const owner = String(client.bdeOwner || '').trim().toLowerCase();
  const me = String(user.name || '').trim().toLowerCase();
  return !owner || owner === me || (scope.atsScopeOf(user).bdeOwnClientIds || []).includes(client.id);
}

module.exports = {
  bdeMayLink, signingUrl, contactsOf, dispatchSigningLink, dispatchThankYou, describeDispatch, dispatchReasons,
  isExecuted, missingSeals, maybeAutoActivate, endOf, sweepExpiry, startExpirySweep, ownersAndAdmins,
  sweepSigningReminders, SIGN_REMINDER_DAYS, emailRenewal,
};
