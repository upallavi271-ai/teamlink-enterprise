// ---------------------------------------------------------------------------
// CHANNELS — the honest status of Email, SMS and WhatsApp for the "Channels"
// panel: connected or not, what is still missing and the exact steps to fix
// it, and a Test that goes ONLY to the logged-in Admin's own address / number
// (taken from their own employee record, never typed in).
// ---------------------------------------------------------------------------

const prisma = require('../db');
const messaging = require('./messaging');
const mailer = require('./mailer');
const sms = require('./smsGateway');
const wa = require('./whatsappCloud');
const T = require('./messageTemplates');

const WHERE = 'Administration → Integrations → Connections';

async function templateCounts() {
  if (!T.supported()) return { sms: { total: 0, withDlt: 0 }, wa: { total: 0, approved: 0, pending: 0, rejected: 0, none: 0 } };
  const rows = await prisma.messageTemplate.findMany({ where: { active: true, channel: { in: ['SMS', 'WhatsApp'] } }, select: { channel: true, dltTemplateId: true, waStatus: true, waTemplateName: true } });
  const smsRows = rows.filter((r) => r.channel === 'SMS');
  const waRows = rows.filter((r) => r.channel === 'WhatsApp');
  const cnt = (s) => waRows.filter((r) => (r.waStatus || 'None') === s).length;
  return {
    sms: { total: smsRows.length, withDlt: smsRows.filter((r) => r.dltTemplateId).length },
    wa: { total: waRows.length, approved: waRows.filter((r) => r.waStatus === 'Approved' && r.waTemplateName).length, pending: cnt('Pending'), rejected: cnt('Rejected'), none: cnt('None') },
  };
}

const when = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null);
const tick = (label, ok, how) => ({ label, ok, how: how || null }); // ok: true | false | null (cannot be known)

async function detail(base) {
  const root = String(base || process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  const hook = (p) => (root ? `${root}/api/webhooks/${p}` : `/api/webhooks/${p}`);
  const delivery = require('./messageDelivery'); // eslint-disable-line global-require
  const [seenWa, seenSms] = await Promise.all([delivery.seenOf('whatsapp'), delivery.seenOf('sms')]);
  const [status, e, s, w, counts] = await Promise.all([
    messaging.channelStatus(),
    mailer.emailConfig().catch(() => ({ configured: false, reason: 'Could not read the email settings' })),
    sms.smsConfig().catch(() => ({ configured: false, problems: [] })),
    wa.whatsappConfig().catch(() => ({ configured: false, problems: [] })),
    templateCounts(),
  ]);

  const email = {
    channel: 'Email', configured: !!status.Email.configured, summary: status.Email.configured ? `Connected: ${status.Email.detail}` : 'Not connected yet',
    problems: e.problems || [],
    checks: [
      tick('SMTP server and From address saved', !!status.Email.configured, 'Integrations → Email (SMTP)'),
      tick('Mail is accepted by the server', null, 'Press "Send a test to me" and check your inbox.'),
      tick('SPF, DKIM and DMARC are set on your domain', null, 'Press "Check my email domain".'),
    ],
    canCheckDomain: true,
    limits: 'Google Workspace allows about 2,000 mails a day per user and Microsoft 365 about 10,000 recipients a day. Gmail and Yahoo reject bulk mail without SPF + DKIM + DMARC, so set those first.',
    steps: status.Email.configured ? [] : [
      `Open ${WHERE} → Email (SMTP) → Configure.`,
      'Google Workspace: host smtp.gmail.com, port 587, STARTTLS, your work address and an App password (turn on 2-Step Verification first; ordinary passwords no longer work).',
      'Microsoft 365: host smtp.office365.com, port 587, STARTTLS. Ask your Microsoft admin to switch on "SMTP AUTH" for that mailbox. Microsoft is switching off password sign-in for this in 2026-2027, so plan for a change later.',
      'Press Save & Connect, then "Send a test to me" and "Check my email domain" here.',
      'For many mails a day, add SPF, DKIM and DMARC for your domain first (Gmail and Yahoo reject bulk mail without them).',
    ],
  };

  const smsReady = !!status.SMS.configured;
  const smsProblems = [...(s.problems || [])];
  if (smsReady && s.provider !== 'TWILIO' && !(s.templates && s.templates.bulk) && counts.sms.withDlt === 0) {
    smsProblems.push(`${s.providerLabel} sends only DLT-registered text: add a "DLT template ID — bulk / general" in Integrations, or a DLT template id on an SMS template.`);
  }
  const smsOut = {
    channel: 'SMS', configured: smsReady, provider: s.providerLabel || null,
    summary: smsReady ? `Connected: ${s.providerLabel}${s.testMode ? ' (test server)' : ''}` : 'Not connected yet',
    dlt: s.provider === 'TWILIO' ? { needed: false } : {
      needed: true, senderId: !!s.sender, bulkTemplate: !!(s.templates && s.templates.bulk), templatesWithDlt: counts.sms.withDlt, templatesTotal: counts.sms.total,
      ready: !!s.sender && (!!(s.templates && s.templates.bulk) || counts.sms.withDlt > 0),
    },
    problems: smsProblems,
    checks: [
      tick('Provider chosen and API key saved', smsReady, 'Integrations → SMS Gateway'),
      ...(s.provider === 'TWILIO' ? [] : [
        tick('Sender ID (header) saved', !!s.sender, 'The 6-letter name registered on the DLT portal, e.g. TMLINK.'),
        tick('At least one DLT template id saved', !!(s.templates && s.templates.bulk) || counts.sms.withDlt > 0, 'Bulk template id on the SMS card, or a DLT id on an SMS template.'),
      ]),
      tick('Delivery-report secret saved', s.provider === 'TWILIO' ? true : !!s.dlrSecret, 'A word you choose on the SMS card; the provider calls the link below with the same word.'),
      tick('Delivery reports are reaching us', seenSms ? true : null, seenSms ? `Last one ${when(seenSms.at)} (${seenSms.count} so far)` : 'In your SMS provider panel, set the delivery-report URL to the link below.'),
    ],
    webhook: {
      label: 'Delivery-report link for your SMS provider',
      url: s.provider === 'TWILIO' ? hook('sms/twilio') : `${hook(s.provider === 'FAST2SMS' ? 'sms/fast2sms' : 'sms/msg91')}?key=${s.dlrSecret || '<your secret word>'}`,
      note: s.provider === 'FAST2SMS'
        ? 'Fast2SMS dashboard → Webhook → Create → service SMS, events all, method POST, content type JSON.'
        : s.provider === 'TWILIO' ? 'TeamLink sends this link to Twilio with every message; nothing to paste. (Needs the site public address.)'
          : 'MSG91 dashboard → SMS → Webhook (New) → Create → event "On Report Received", JSON.',
    },
    steps: smsReady && !smsProblems.length ? [] : [
      'India (TRAI rule): register the company once as a "Principal Entity" on one telecom DLT portal (Jio, Airtel, Vi or BSNL). About Rs 5,900 + GST, 2-7 working days. You get a 19-digit Entity ID.',
      'On the same portal register your sender name (6 letters, e.g. TMLINK) and each message text as a "template" (variables as {#var#}). You get a Template ID for each. Every link in a text must be whitelisted too. Approval takes 1-3 days.',
      'Create an account with MSG91 or Fast2SMS (about Rs 0.15-0.25 per SMS). Ask them to bind your Entity ID to their account ("PE-TM chain"). Without that, SMS is dropped.',
      `Open ${WHERE} → SMS Gateway → Configure: pick the provider, paste the API key and the Sender ID, and the template id. MSG91: its own Flow template id. Fast2SMS: the "Message ID" shown in its DLT Manager (not the 19-digit number).`,
      'In Message templates, open an SMS template and type its template id (Admin only). Type a "delivery-report secret word" on the SMS card and put the link shown here into the provider panel.',
      'Press Save & Connect, then "Send a test to me" here. Wait for the delivery tick: a text can be accepted and still be dropped by the operator if the wording does not match the template exactly.',
    ],
  };

  const waReady = !!status.WhatsApp.configured;
  const waProblems = [...(w.problems || [])];
  if (waReady && counts.wa.approved === 0 && !(w.templates && w.templates.bulk)) {
    waProblems.push('No WhatsApp template is Approved yet, so no WhatsApp message can start a chat. Create the templates in the Meta console and mark them Approved in Message templates after Meta approves them.');
  }
  const waOut = {
    channel: 'WhatsApp', configured: waReady, summary: waReady ? `Connected: ${status.WhatsApp.detail}` : 'Not connected yet',
    templates: counts.wa, problems: waProblems,
    checks: [
      tick('Phone number ID and access token saved', waReady, 'Integrations → WhatsApp Business'),
      tick('App secret saved (so we can trust Meta calls)', !!w.appSecret, 'Meta app → Settings → Basic → App secret'),
      tick('Webhook verify token saved', !!w.verifyToken, 'Any text you choose; paste the same in Meta → Webhooks'),
      tick('Meta is calling our webhook (delivery ticks, replies)', seenWa ? true : null, seenWa ? `Last call ${when(seenWa.at)} (${seenWa.count} so far)` : 'In Meta → WhatsApp → Configuration, set the callback URL below and subscribe to "messages".'),
      tick('At least one template is Approved', counts.wa.approved > 0, 'Create it in Meta, then mark it Approved in Message templates.'),
    ],
    webhook: { label: 'Callback URL to paste in Meta', url: hook('whatsapp'), note: 'Meta → WhatsApp → Configuration → Webhook → Edit. Verify token = the text saved on the WhatsApp card. Subscribe to the "messages" field.' },
    windowNote: 'A WhatsApp chat can start only with an approved template. Once the person writes back, plain text is allowed for 24 hours (TeamLink opens that window by itself when Meta tells it about the reply).',
    steps: waReady && !waProblems.length ? [] : [
      'Create a Meta Business account (business.facebook.com) in the company legal name and verify the business (GST or incorporation certificate; 1-3 days). Make a "Business" app at developers.facebook.com and add the WhatsApp product.',
      'Use a phone number that is NOT on the WhatsApp or WhatsApp Business app (a new SIM or landline is fine). Add it, choose the display name (Meta reviews it) and confirm with the code. India accounts must be billed in rupees (INR): choose INR when you create the WhatsApp account.',
      'Business settings → System users → make one, give it your app, and make a token with the permissions whatsapp_business_management and whatsapp_business_messaging. Choose "never expires".',
      `Open ${WHERE} → WhatsApp Business → Configure and enter the Phone number ID, WhatsApp Business ID and the token. Also paste the App secret (Meta app → Settings → Basic) and any word as "Webhook verify token".`,
      'Meta app → WhatsApp → Configuration → Webhook → Edit: paste the callback URL shown here and the same verify token, then subscribe to "messages". Now delivery ticks and replies reach TeamLink.',
      'WhatsApp Manager → Message templates: create each template (utility for things like interview and document requests; marketing for job alerts). Meta checks them within about a day.',
      'Back in Message templates, open the WhatsApp template, type its exact name and set the status to Approved (Admin only). We never mark one Approved ourselves.',
      'Press Save & Connect, then "Send a test to me" here. A new account may message 250 people a day; the limit rises as your quality stays high.',
      'Every person must have agreed to get WhatsApp messages from you (say so on your apply form). TeamLink stops messaging anyone who replies STOP.',
    ],
  };
  const callCfg = await require('./callGateway').callConfig().catch(() => ({ configured: false, problems: [] })); // eslint-disable-line global-require
  const seenCall = await delivery.seenOf('call');
  const callOut = {
    channel: 'Call', configured: !!callCfg.configured,
    summary: callCfg.configured ? `Connected: Exotel (${callCfg.region === 'mumbai' ? 'Mumbai' : 'Singapore'})${callCfg.record ? ', calls are recorded' : ''}` : 'Not connected: "Call now" uses the dialler of your own phone',
    problems: callCfg.configured ? [] : (callCfg.problems || []),
    checks: [
      tick('Exotel account SID, API key and token saved', callCfg.configured, 'Integrations → Cloud Telephony / IVR (Exotel → Settings → API Settings)'),
      tick('Caller ID (ExoPhone) saved', !!callCfg.callerId, 'The virtual number Exotel gives you after KYC.'),
      tick('Call-result secret saved', !!callCfg.secret, 'A word you choose; used in the link below.'),
      tick('Exotel is reporting call results to us', seenCall ? true : null, seenCall ? `Last report ${when(seenCall.at)} (${seenCall.count} so far)` : 'TeamLink sends the link to Exotel with every call (needs the site public address).'),
    ],
    webhook: { label: 'Call-result link (sent to Exotel with every call)', url: `${hook('call/exotel')}?key=${callCfg.secret || '<your secret word>'}`, note: 'Nothing to paste: TeamLink adds this to each call. It is shown so you can see it.' },
    windowNote: 'How it works: you press "Call through TeamLink", your own phone rings first, you pick up, and then the person is called and connected. Each call is logged with the result. Recording is off unless you turn it on; if you do, tell the person.',
    limits: 'Exotel allows about 20 call starts a minute. One person per click: there is no automatic dialling of a list, because promotional auto-dialling needs a registered 140-series number.',
    steps: callCfg.configured ? [] : [
      'Create an Exotel account (exotel.com). Do the KYC (PAN, GST, signatory ID): about 30 minutes to 3 days.',
      'Buy a plan with one ExoPhone (a virtual number). Bundles from about Rs 9,999 for 5 months; the per-minute rate is on request. An outgoing click-to-call is charged for both legs.',
      'Exotel dashboard → Settings → API Settings: copy the Account SID, API key and API token. Note whether your account is Mumbai or Singapore.',
      `Open ${WHERE} → Cloud Telephony / IVR → Configure and fill them in, with your ExoPhone as the Caller ID and a secret word.`,
      'Make sure each caller has their own mobile number on their employee profile: that is the phone that rings first.',
      'Press Save & Connect, then "Check connection" here. It places no call.',
    ],
  };
  return { Email: email, SMS: smsOut, WhatsApp: waOut, Call: callOut };
}

// The Admin's own address / number, from their employee record.
async function ownContact(user) {
  let emp = null;
  try { emp = await prisma.employee.findUnique({ where: { userId: user.id } }); } catch { emp = null; }
  return { email: (emp && emp.email) || user.email || null, phone: (emp && emp.phone) || null, name: (emp && emp.name) || user.name };
}

async function test(user, channel) {
  if (channel === 'Call') {
    const r = await require('./callGateway').testConnection(); // eslint-disable-line global-require
    return { ok: !!r.ok, sandbox: false, outcome: r.ok ? 'Connected' : 'Not connected', message: r.result, to: null };
  }
  if (!messaging.CHANNELS.includes(channel)) return { error: 'Unknown channel.', status: 400 };
  const own = await ownContact(user);
  const to = channel === 'Email' ? own.email : own.phone;
  if (!to) return { error: `Your own ${channel === 'Email' ? 'email address' : 'phone number'} is not on your employee record, so there is nowhere to send the test. Add it on your profile first.`, status: 409 };
  const text = `TeamLink test message (${channel}) for ${own.name}. If you can read this, ${channel} works. Nothing else was sent.`;
  const res = await messaging.send(channel, { to, kind: 'bulk', subject: 'TeamLink test message', text, vars: [text] });
  const sandbox = !!res.sandbox || /sandbox/i.test(String(res.providerRef || res.response || ''));
  let say;
  if (res.ok) say = sandbox ? 'Test server: the app accepted the test, but nothing was really sent (this is a safe test copy).' : `Sent to your own ${channel === 'Email' ? 'email' : 'number'}. Please check it arrived.`;
  else if (res.outcome === 'Not configured') say = `Not set up yet: ${res.error}`;
  else say = `Did not go: ${res.error}`;
  return { ok: !!res.ok, sandbox, outcome: res.outcome, message: say, to: channel === 'Email' ? to.replace(/^(.).*(@.*)$/, '$1•••$2') : `•••${String(to).replace(/\D/g, '').slice(-4)}` };
}

// EMAIL DOMAIN CHECK — does the sender's domain publish the three records big
// mailboxes (Gmail, Yahoo, Outlook) look for? Reads public DNS only; nothing is
// sent. SPF (v=spf1) and DMARC (_dmarc) are certain; DKIM lives under a selector
// name only the mail provider knows, so the common ones are tried and "not found"
// is reported as "could not find" (never "missing").
async function emailDomainCheck() {
  const e = await mailer.emailConfig().catch(() => null);
  const from = e && e.fromAddress ? e.fromAddress : '';
  const domain = (from.split('@')[1] || '').toLowerCase().trim();
  if (!domain) return { error: 'Save the Email (SMTP) From address first; the domain is read from it.', status: 409 };
  const dns = require('dns').promises; // eslint-disable-line global-require
  const txt = async (name) => { try { return (await dns.resolveTxt(name)).map((x) => x.join('')); } catch { return null; } };
  const [root, dmarc] = await Promise.all([txt(domain), txt(`_dmarc.${domain}`)]);
  const spf = (root || []).find((x) => /^v=spf1/i.test(x)) || null;
  const dm = (dmarc || []).find((x) => /^v=DMARC1/i.test(x)) || null;
  let dkim = null;
  for (const sel of ['google', 'selector1', 'selector2', 'default', 'k1', 'mail', 's1', 'dkim']) {
    // eslint-disable-next-line no-await-in-loop
    const r = await txt(`${sel}._domainkey.${domain}`);
    if (r && r.some((x) => /v=DKIM1|k=rsa|p=/i.test(x))) { dkim = sel; break; }
  }
  const policy = dm ? (/p=(reject|quarantine|none)/i.exec(dm) || [])[1] || null : null;
  const items = [
    { label: 'SPF record (says which servers may send for you)', ok: !!spf, detail: spf ? spf.slice(0, 160) : `Not found on ${domain}. Add a TXT record "v=spf1 include:<your mail provider> ~all" (Google: include:_spf.google.com).` },
    { label: 'DKIM signature (proves the mail was not changed)', ok: !!dkim, detail: dkim ? `Found (selector "${dkim}").` : 'Could not find one under the common names. In Google Workspace: Admin → Apps → Gmail → Authenticate email → Generate record, add it, press Start authentication. If you already did, ignore this.' },
    { label: 'DMARC record (what to do with mail that fails the checks)', ok: !!dm, detail: dm ? `${dm.slice(0, 160)}${policy ? '' : ''}` : `Not found. Add a TXT record on _dmarc.${domain}: "v=DMARC1; p=none; rua=mailto:${from}" (start with p=none).` },
  ];
  return { domain, from, items, allGood: items.every((i) => i.ok), checkedAt: new Date().toISOString() };
}

module.exports = { detail, test, emailDomainCheck, ownContact };
