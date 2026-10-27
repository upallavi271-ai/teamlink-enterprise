// Administration reference lists, taken verbatim from the reference prototype
// (teamlink-enterprise_69.html): INTEGRATION_CATALOG (line 2189),
// INTEGRATION_GROUPS (line 2257), ORG_STRUCTURE_DEFAULT (line 2260) and the
// companySetup policy list (line 407).

// Every outside channel the platform talks to. `fields` is [label, placeholder]
// in the prototype's order — the Configure modal renders them exactly so.
// REAL (utils/whatsappCloud.js, utils/smsGateway.js). The labels are the keys
// the adapters read — change one here and change it there.
const WA_FIELDS = {
  display: 'Business phone number',
  phoneId: 'Phone number ID',
  wabaId: 'WhatsApp Business ID',
  token: 'Permanent access token',
  namespace: 'Template namespace',
  language: 'Template language code',
  linkTpl: 'Template name — agreement link',
  otpTpl: 'Template name — OTP (Authentication)',
  bulkTpl: 'Template name — bulk / general',
  // Webhook (delivery ticks + replies): Meta posts to /api/webhooks/whatsapp.
  appSecret: 'App secret (checks Meta webhook calls)',
  verifyToken: 'Webhook verify token (any text you choose)',
};
const SMS_FIELDS = {
  provider: 'Provider (MSG91 / Fast2SMS / Twilio)', // the label is the stored key: do not rename; type SMSGW or SMS Push Platform to use web.smsgw.in
  sender: 'Sender ID (6 chars) / Twilio From number',
  key: 'API key / Auth token',
  sid: 'Twilio Account SID',
  linkTpl: 'DLT template ID — agreement link',
  otpTpl: 'DLT template ID — OTP',
  bulkTpl: 'DLT template ID — bulk / general',
  // Delivery reports: the provider calls /api/webhooks/sms/<provider>?key=<this text>.
  dlrSecret: 'Delivery-report webhook secret (any text you choose)',
  // SMS Push Platform (web.smsgw.in) only. The password is a secret by its label; the rest are plain settings.
  pushUrl: 'SMS Push Platform: send address (URL)',
  pushUser: 'SMS Push Platform: API username',
  pushPass: 'SMS Push Platform: API password',
  pushPe: 'SMS Push Platform: DLT Principal Entity ID (PE ID)',
  pushNames: 'SMS Push Platform: request field names (advanced, JSON)',
  pushOk: 'SMS Push Platform: how a message id looks in the answer (advanced, pattern)',
  // 2026-10-27 (founder's SMS Push prompt): SMS Push Platform keeps its OWN sender id and DLT template ids, so switching the provider never
  // sends with another provider's sender / templates. The shared fields above stay for MSG91 / Fast2SMS / Twilio, exactly as before.
  pushSender: 'SMS Push Platform: Sender ID',
  pushBulkTpl: 'SMS Push Platform: DLT Template ID — Bulk / General',
  pushLinkTpl: 'SMS Push Platform: DLT Template ID — Agreement Link (optional)',
  pushOtpTpl: 'SMS Push Platform: DLT Template ID — OTP (optional)',
};

// The SMS form's second column is a HINT for these fields (shown greyed in the empty box), never a value: before 2026-10-27 the form filled an
// empty box with it and Save stored "SMS Push Platform only" as a username / "one var: the message" as a template id. The server also treats a
// stored value equal to its hint as empty (utils/smsGateway.js), so rows saved that way read as "not set".
const SMS_PROVIDER_CHOICES = ['MSG91', 'Fast2SMS', 'Twilio', 'SMS Push Platform'];

// SMS through an Android phone with an SMS-gateway app on it (channels/androidSms.js). Labels are the keys the adapter reads.
const ANDROID_FIELDS = {
  mode: 'Where is the phone? (Local / Cloud / Custom)',
  base: 'Phone address (Base URL)',
  login: 'Login method (Basic or Bearer)',
  user: 'Username',
  pass: 'Password or token',
  sendPath: 'Send endpoint',
  healthPath: 'Health endpoint',
  style: 'Gateway app (SMS Gateway for Android / Generic JSON)',
  sim: 'SIM number (1-3, blank = phone default)',
  bodyTpl: 'Generic JSON body (use {{to}} and {{text}})',
  refPath: 'Generic: name of the message id in the reply',
  hook: 'Webhook signing key or shared word',
};
const QR_FIELDS = { label: 'Name for this number (shown to staff)' };

const INTEGRATION_CATALOG = [
  { id: 'whatsapp', name: 'WhatsApp Business', group: 'Messaging', glyph: '\u{1F4AC}',
    desc: 'WhatsApp Cloud API (Meta): agreement links, signing OTPs, candidate updates and bulk messages — approved templates, plain text only inside a 24-hour customer session.',
    fields: [[WA_FIELDS.display, '+91 '], [WA_FIELDS.phoneId, 'from Meta → WhatsApp → API Setup'], [WA_FIELDS.wabaId, ''],
      [WA_FIELDS.token, ''], [WA_FIELDS.namespace, 'optional (legacy)'], [WA_FIELDS.language, 'en'],
      [WA_FIELDS.linkTpl, 'body {{1}} name, {{2}} agreement no., {{3}} link'],
      [WA_FIELDS.otpTpl, 'authentication template, {{1}} code'],
      [WA_FIELDS.bulkTpl, 'body {{1}} = the message'],
      [WA_FIELDS.appSecret, 'Meta app → Settings → Basic → App secret'],
      [WA_FIELDS.verifyToken, 'type any text; paste the same in Meta → Webhooks']] },
  { id: 'whatsapp-qr', name: 'WhatsApp QR-link (prototype)', group: 'Messaging', glyph: '📲',
    desc: 'PROTOTYPE, unofficial: link a spare WhatsApp number by scanning a QR code. Zero cost, but WhatsApp can ban the number. Set up on Integrations > WhatsApp & SMS.',
    fields: [[QR_FIELDS.label, 'e.g. Spare number']] },
  { id: 'sms-android', name: 'SMS via Android phone', group: 'Messaging', glyph: '📟',
    desc: 'Your own SIM sends the SMS: an open-source SMS-gateway app on an Android phone (SMS Gateway for Android, local Wi-Fi or its cloud). Set up on Integrations > WhatsApp & SMS.',
    fields: [[ANDROID_FIELDS.mode, 'Local'], [ANDROID_FIELDS.base, 'http://192.168.1.20:8080'], [ANDROID_FIELDS.login, 'Basic'],
      [ANDROID_FIELDS.user, ''], [ANDROID_FIELDS.pass, ''], [ANDROID_FIELDS.sendPath, '/message'], [ANDROID_FIELDS.healthPath, '/health'],
      [ANDROID_FIELDS.style, 'SMS Gateway for Android'], [ANDROID_FIELDS.sim, ''], [ANDROID_FIELDS.bodyTpl, '{"to":"{{to}}","text":"{{text}}"}'],
      [ANDROID_FIELDS.refPath, 'id'], [ANDROID_FIELDS.hook, 'type any word; the same goes in the phone app']] },
  { id: 'sms', name: 'SMS Gateway', group: 'Messaging', glyph: '\u{1F4F1}',
    desc: 'Transactional SMS (MSG91, Fast2SMS, Twilio or SMS Push Platform / web.smsgw.in) for signing OTPs, agreement links, interview alerts and bulk messages. Send, templates, history and dashboard: Integrations > SMS Push Platform.',
    fields: [[SMS_FIELDS.provider, 'MSG91'], [SMS_FIELDS.sender, 'TMLINK'], [SMS_FIELDS.key, ''],
      [SMS_FIELDS.sid, 'Twilio only (AC…)'],
      [SMS_FIELDS.linkTpl, 'vars: name, agreement no., link'],
      [SMS_FIELDS.otpTpl, 'vars: code, minutes'],
      [SMS_FIELDS.bulkTpl, 'one var: the message'],
      [SMS_FIELDS.dlrSecret, 'type any text; use the same in the delivery-report URL of your SMS provider'],
      [SMS_FIELDS.pushUrl, 'https://web.smsgw.in/smsapi/httpapi.jsp'],
      [SMS_FIELDS.pushUser, 'the API username your provider gave you'],
      [SMS_FIELDS.pushPass, 'the API password, not the portal login password'],
      [SMS_FIELDS.pushSender, 'the DLT-registered header for this account, e.g. 6 letters'],
      [SMS_FIELDS.pushPe, '19 digits, from your DLT registration'],
      [SMS_FIELDS.pushBulkTpl, 'the approved DLT template id (digits) of the campaign message'],
      [SMS_FIELDS.pushLinkTpl, 'only if agreement-link SMS go through this provider'],
      [SMS_FIELDS.pushOtpTpl, 'only if OTP SMS go through this provider'],
      [SMS_FIELDS.pushNames, 'blank = the documented names (username, password, to, from, text, pe_id, template_id)'],
      [SMS_FIELDS.pushOk, 'blank = the documented reply (ackid / msgid)']],
    // hints (greyed text, never saved as a value), the provider dropdown and which fields each provider shows
    hints: [SMS_FIELDS.sid, SMS_FIELDS.linkTpl, SMS_FIELDS.otpTpl, SMS_FIELDS.bulkTpl, SMS_FIELDS.dlrSecret, SMS_FIELDS.pushUser, SMS_FIELDS.pushPass,
      SMS_FIELDS.pushSender, SMS_FIELDS.pushPe, SMS_FIELDS.pushBulkTpl, SMS_FIELDS.pushLinkTpl, SMS_FIELDS.pushOtpTpl, SMS_FIELDS.pushNames, SMS_FIELDS.pushOk],
    choices: { [SMS_FIELDS.provider]: SMS_PROVIDER_CHOICES },
    byProvider: {
      field: SMS_FIELDS.provider,
      shared: [SMS_FIELDS.provider, SMS_FIELDS.dlrSecret],
      groups: {
        MSG91: [SMS_FIELDS.sender, SMS_FIELDS.key, SMS_FIELDS.linkTpl, SMS_FIELDS.otpTpl, SMS_FIELDS.bulkTpl],
        Fast2SMS: [SMS_FIELDS.sender, SMS_FIELDS.key, SMS_FIELDS.linkTpl, SMS_FIELDS.otpTpl, SMS_FIELDS.bulkTpl],
        Twilio: [SMS_FIELDS.sender, SMS_FIELDS.key, SMS_FIELDS.sid],
        'SMS Push Platform': [SMS_FIELDS.pushUrl, SMS_FIELDS.pushUser, SMS_FIELDS.pushPass, SMS_FIELDS.pushSender, SMS_FIELDS.pushPe, SMS_FIELDS.pushBulkTpl,
          SMS_FIELDS.pushLinkTpl, SMS_FIELDS.pushOtpTpl, SMS_FIELDS.pushNames, SMS_FIELDS.pushOk],
      },
    } },
  // REAL. nodemailer talks to this host — see utils/mailer.js. The last two
  // fields were added with the sending worker: "Encryption" chooses SSL vs
  // STARTTLS (587/STARTTLS is the common case, 465/SSL the other), and the
  // from-name is the display name on the envelope sender.
  { id: 'email', name: 'Email (SMTP)', group: 'Email', glyph: '✉️',
    desc: 'Outbound email for candidate messages, offer letters, invoices, payslips and system notifications.',
    fields: [['SMTP host', ''], ['Port', '587'], ['From address', ''], ['Username', ''], ['Password / app key', ''],
      ['Encryption (SSL / STARTTLS / None)', 'STARTTLS'], ['Default from name', '']] },
  { id: 'email-inbox', name: 'Shared Inbox (IMAP)', group: 'Email', glyph: '\u{1F4E5}',
    desc: 'Pull candidate replies and client mail into the requirement timeline.',
    fields: [['IMAP host', ''], ['Port', '993'], ['Mailbox address', ''], ['Password / app key', '']] },
  // REAL (utils/callGateway.js): Exotel click-to-call. The agent's own phone rings first, then
  // the person is connected; the result (answered / no answer / duration / recording link)
  // comes back to /api/webhooks/call/exotel and lands in the call log.
  { id: 'telephony', name: 'Cloud Telephony / IVR', group: 'Calling', glyph: '📞',
    desc: 'Click-to-call through Exotel: your phone rings first, then the person is connected, and the result is logged. Needs an Exotel account with KYC and an ExoPhone (a virtual number). Without it, "Call now" uses the dialler of your own phone and you log how it went.',
    fields: [['Provider (Exotel)', 'Exotel'], ['Account SID', 'Exotel → Settings → API Settings'], ['API key', ''], ['API token', ''],
      ['Region (Mumbai or Singapore)', 'Mumbai'], ['Caller ID (your ExoPhone number)', '0XXXXXXXXXX'], ['Record calls (Yes or No)', 'No'],
      ['Call-result webhook secret (any text you choose)', 'type any text']] },
  { id: 'click-to-call', name: 'Click-to-Call Widget', group: 'Calling', glyph: '\u{1F4F2}',
    desc: 'Dial a candidate or client contact straight from any list or profile page.',
    fields: [['Agent extension prefix', ''], ['Default country code', '+91']] },
  { id: 'video', name: 'Video Interviews', group: 'Calling', glyph: '\u{1F3A5}',
    desc: 'Auto-create meeting links when an interview is scheduled.',
    fields: [['Provider (Meet / Zoom / Teams)', ''], ['Client ID', ''], ['Client secret', '']] },
  { id: 'calendar', name: 'Calendar Sync', group: 'Scheduling', glyph: '\u{1F4C5}',
    // B4 (2026-10-06): REAL for "Create meeting link" on an interview —
    // Google Calendar API (Meet) or Microsoft Graph (Teams). utils/meetingLinks.js
    // has the official doc links and the exact setup steps.
    desc: 'Create real Google Meet / Microsoft Teams links for interviews ("Create meeting link"). Google: Client ID, secret and a refresh token. Microsoft: Tenant ID, Client ID, secret and the organizer mailbox.',
    fields: [['Provider (Google / Outlook)', 'Google or Outlook'], ['Client ID', ''], ['Client secret', ''], ['Default calendar', 'primary'],
      ['Refresh token (Google)', 'Google only'], ['Tenant ID (Microsoft)', 'Microsoft only'], ['Organizer email (Microsoft)', 'Microsoft only, e.g. interviews@yourcompany.com']] },
  { id: 'jobportal', name: 'TeamLink Job Portal', group: 'Job Boards', glyph: '\u{1F517}',
    desc: 'The candidate-facing TeamLink Job Portal — syncs candidates, applications, requirements and requirement status.',
    fields: [['Portal URL / origin', 'file:// or https://'], ['Bridge key', 'tl_job_portal_state_v1'], ['Sync frequency', 'On demand']] },
  { id: 'naukri', name: 'Naukri', group: 'Job Boards', glyph: '\u{1F50D}',
    // SAVE & POST (2026-10-05) — REAL connectors (utils/jobConnectors.js,
    // utils/jobBoards/*.js). The fields are exactly what each board's approved
    // route needs; each list lives with the connector that reads it.
    desc: 'Save & Post sends requirements to Naukri through Naukri\'s ATS integration "Amplify" (Zwayam). Naukri has no public API: buy the job-posting plan with Amplify from your Naukri account manager or amplify@zwayam.com; they give the API key, secret key and job endpoint.',
    fields: require('./jobBoards/partner').naukri.FIELDS }, // eslint-disable-line global-require
  { id: 'linkedin', name: 'LinkedIn Recruiter', group: 'Job Boards', glyph: '\u{1F517}',
    desc: 'Save & Post sends requirements through LinkedIn\'s Job Posting API (approved partners only; LinkedIn is not taking new API partners right now). Ask LinkedIn Talent Solutions for partner access, then enter the company page id, app Client ID / secret, poster email and API version.',
    fields: require('./jobBoards/linkedin').FIELDS }, // eslint-disable-line global-require
  { id: 'indeed', name: 'Indeed', group: 'Job Boards', glyph: '\u{1F4CC}',
    desc: 'Save & Post sends requirements through Indeed\'s Job Sync API. Needs an Indeed partner account: sign the Developer Agreement and apply at partners.indeed.com; the Client ID / secret are in the Indeed Partner Console.',
    fields: require('./jobBoards/indeed').FIELDS }, // eslint-disable-line global-require
  { id: 'shine', name: 'Shine', group: 'Job Boards', glyph: '✨',
    desc: 'Save & Post sends requirements to Shine once Shine gives you an ATS job-posting API account (no public API: ask your Shine employer sales / account manager). Enter the API key and job endpoint they give.',
    fields: require('./jobBoards/partner').shine.FIELDS }, // eslint-disable-line global-require
  { id: 'google-jobs', name: 'Google for Jobs', group: 'Job Boards', glyph: '\u{1F50E}',
    desc: 'Requirements are in our Google Jobs (JobPosting) data at once. With a Google Cloud service account (Indexing API on, added as Owner in Search Console) TeamLink tells Google about each requirement and confirms when Google shows it.',
    fields: require('./jobBoards/google').FIELDS }, // eslint-disable-line global-require
  { id: 'website', name: 'TeamLink Website', group: 'Job Boards', glyph: '\u{1F310}',
    desc: 'Publish openings to the careers page on tmlink.in.',
    fields: [['Careers page URL', ''], ['Publish token', '']] },
  { id: 'social', name: 'Social Media', group: 'Job Boards', glyph: '\u{1F4E3}',
    desc: 'Share openings to LinkedIn, X and Facebook pages.',
    fields: [['Page / handle', ''], ['Access token', '']] },
  { id: 'storage', name: 'Document Storage', group: 'Storage', glyph: '\u{1F5C2}️',
    desc: 'Where resumes, offer letters and employee documents are stored.',
    fields: [['Provider (S3 / Drive)', ''], ['Bucket / folder', ''], ['Access key', ''], ['Secret key', '']] },
  // AADHAAR eSIGN. Only a licensed ASP/ESP may perform one — eMudhra, NSDL,
  // Digio, SignDesk, Leegality. Until this is filled in, the agreement flow
  // completes on a mobile OTP and SAYS SO on the record rather than claiming an
  // Aadhaar eSign that never happened (utils/agreementSigning.js).
  //
  // The same connection signs both sides of a client agreement and an
  // employee's documents, so the fields are the account's, not one document's.
  // Endpoint carries the sandbox or production URL, because getting those two
  // the wrong way round is the usual way a first eSign goes missing.
  // 2026-10-05: REAL for eMudhra — the emSigner SIGNER GATEWAY (no ASP
  // registration needed), see utils/emudhra.js for the official doc links.
  // The client's 4th signing choice on the agreement link appears only when
  // these are filled; Test checks the setup and never calls eMudhra.
  { id: 'esign', name: 'eMudhra eSign (Aadhaar)', group: 'Compliance', glyph: '\u{1F58A}️',
    desc: 'Aadhaar eSign for client agreements through the eMudhra emSigner Signer Gateway. '
      + 'Needs a Signer Gateway subscription from eMudhra (support@emsigner.com).',
    fields: [
      ['Environment', 'Sandbox'],
      ['Gateway URL', 'https://testgateway.emsigner.com/eMsecure/V3_0/Index'],
      ['Status / download API base URL', 'https://testgateway.emsigner.com/api'],
      ['Auth token', ''],
      ['eMudhra public certificate (PEM)', '-----BEGIN CERTIFICATE----- …'],
      ['POST field names (Parameter 1,2,3)', 'Parameter1,Parameter2,Parameter3'],
    ] },
  { id: 'tally', name: 'Tally / Accounting', group: 'Finance', glyph: '\u{1F4D2}',
    desc: 'Push invoices and payments into the accounting ledger.',
    fields: [['Company name in Tally', ''], ['Connector URL', ''], ['Sync frequency', 'Daily']] },
  { id: 'payments', name: 'Payment Gateway', group: 'Finance', glyph: '\u{1F3E6}',
    desc: 'Collect client invoice payments online and auto-reconcile receipts.',
    fields: [['Provider', ''], ['Key ID', ''], ['Key secret', ''], ['Webhook secret', '']] },
  { id: 'biometric', name: 'Biometric / Attendance Device', group: 'Workforce', glyph: '\u{1F590}️',
    desc: 'eSSL device pushing punches to TeamLink over ADMS / iClock — every punch lands in HRMS attendance.',
    // REAL (routes/iclock.js). Save & Connect stores the device in the
    // BiometricDevice table; the connection status comes from its heartbeats.
    fields: [['Vendor', 'eSSL X2008 (ADMS/iClock)'], ['Serial', 'NFZ8250204996'],
      ['Endpoint', 'http://72.61.233.104:8080/iclock'], ['Status', 'Active']] },
  { id: 'webhooks', name: 'Webhooks', group: 'Developer', glyph: '\u{1FA9D}',
    desc: 'Notify your own systems when a candidate joins, an invoice is paid, and similar events.',
    fields: [['Endpoint URL', ''], ['Signing secret', ''], ['Events (comma separated)', 'candidate.joined, invoice.paid']] },
  { id: 'api', name: 'REST API Access', group: 'Developer', glyph: '\u{1F511}',
    desc: 'Issue API keys for external systems to read and write platform data.',
    fields: [['Key label', ''], ['Allowed IP range', ''], ['Scope (read / write)', 'read']] },
  // REAL. The Anthropic key for the AI Assistant / Agent when the server runs
  // with AI_PROVIDER=claude (the default provider is the local Ollama model —
  // see utils/ai.js), and for the weekly-idea screener (utils/ideaAi.js). The
  // key stays on the server: it is encrypted at rest and is never included in
  // any response. The Agent never acts without the user pressing Confirm, and
  // then only through the app's own routes.
  // REAL (ATS-100 B9.5). Cloudflare Turnstile on the public careers apply
  // form (utils/botProtection.js). Until a Site key + Secret key are saved
  // the apply keeps its honeypot + rate limit and is never blocked.
  // Setup: dash.cloudflare.com → Turnstile → Add site → copy Site key +
  // Secret key here → Connect. The secret is encrypted at rest.
  { id: 'turnstile', name: 'Bot protection (Cloudflare Turnstile)', group: 'Developer', glyph: '\u{1F6E1}️',
    desc: 'Stops bots on the public careers apply form. Free Cloudflare account: Turnstile → Add site → paste the Site key and Secret key here. Not configured = honeypot + rate limit only, applies never blocked.',
    fields: [['Site key', '0x4AAAAAAA…'], ['Secret key', '']] },
  { id: 'ai-claude', name: 'AI Assistant (Anthropic Claude)', group: 'AI', glyph: '\u{1F916}',
    desc: 'Claude for the AI Assistant and Agent (when AI_PROVIDER=claude), the weekly-idea screener and reading vendors’ uploaded repair bills (handwritten or printed) — always inside the asking user’s permissions and scope. The same key reads the bills: leave "Bill reading model" empty for the default.',
    fields: [['Anthropic API key', 'sk-ant-...'], ['Model', 'claude-opus-5'],
      ['Max answer tokens', '1500'], ['Questions per user per hour', '30'],
      ['Bill reading model', 'claude-opus-5-5'], ['Bill reads per vendor per day', '30']] },
];

const INTEGRATION_GROUPS = ['Messaging', 'Email', 'AI', 'Calling', 'Scheduling', 'Job Boards', 'Storage', 'Finance', 'Workforce', 'Developer'];

// Channels this app really talks to. Everything else on the Integrations
// screen is still Demo / Simulated and keeps saying so.
const LIVE_CHANNELS = ['email', 'ai-claude', 'biometric', 'jobportal', 'sms', 'whatsapp', 'sms-android', 'whatsapp-qr', 'telephony', 'naukri', 'indeed', 'shine', 'linkedin', 'google-jobs', 'turnstile'];
// The job boards Save & Post really posts to (utils/jobConnectors.js).
const JOB_BOARD_CHANNELS = ['naukri', 'indeed', 'shine', 'linkedin', 'google-jobs'];

const INTEGRATION_STATES = ['Not Connected', 'Connected', 'Expired', 'Reconnect Required'];

// Which entities a channel reports on a Sync Now run.
const SYNC_ENTITIES = {
  jobportal: ['Candidates', 'Applications', 'Requirements', 'Requirement Status'],
};

// The approval & escalation chain the Organization Structure screen seeds with.
const ORG_STRUCTURE_DEFAULT = [
  { name: 'Super Admin', description: 'Company-wide (all branches, all departments)', system: true, paused: false, approveDays: null },
  { name: 'HR Admin', description: 'Company-wide (all branches, all departments)', system: false, paused: false, approveDays: null },
  { name: 'Manager', description: 'All departments, company-wide', system: false, paused: false, approveDays: null },
  { name: 'Assistant Manager', description: 'All departments, company-wide (supporting role)', system: false, paused: false, approveDays: null },
  { name: 'Senior Team Lead (STL)', description: 'Team-A & Team-B (Educational), plus Medical & Manufacturing', system: false, paused: false, approveDays: null },
  { name: 'Team Lead (TL)', description: 'Single team (direct reports only)', system: false, paused: false, approveDays: 2 },
  { name: 'Employee (Self-Service)', description: 'Own record only', system: false, paused: false, approveDays: null },
  { name: 'Accountant', description: 'Payrolls and expenses only', system: false, paused: false, approveDays: null },
];

// Company Setup -> Employment Policies, each rendered with an Active chip.
const COMPANY_POLICIES = [
  'Leave Policy', 'WFH / Hybrid Policy', 'Recruiter Incentive Policy',
  'Client Agreement Template', 'Data Privacy Policy',
];

const COMPANY_DEFAULTS = {
  name: 'TeamLink Consultants OPC Pvt. Ltd.',
  email: 'info@tmlink.in',
  phone: '+91 90000 00000',
  hq: 'Hyderabad, Telangana',
  address: 'TeamLink Consultants, Hyderabad, Telangana, India',
};

// Add Employee modal option lists (prototype lines 2847-2852).
const EMP_TYPES = ['Full Time', 'Part Time', 'Contract', 'Intern', 'Consultant'];
const EMP_STATUSES = ['Active', 'Probation', 'Notice Period', 'Inactive', 'Suspended'];
const EMP_GENDERS = ['—', 'Female', 'Male', 'Other', 'Prefer not to say'];
// The Employee Management status filter (prototype line 9778) — a shorter list
// than the create form's, exactly as in the prototype.
const EMP_MGMT_STATUS_FILTER = ['Active', 'Notice Period', 'Relieved', 'Inactive'];

// EXOTEL AI CALLING (2026-10-22): a HIDDEN channel. It is not in the catalogue list above (the generic Connections list must not
// show a second Exotel card); it has its own Administration > Integrations > "AI Calling" tab (routes/aiCalling.js, calling/*).
// It exists here only so utils/integrationStore.js can store its secrets encrypted, like every other channel.
const AI_CALLING_CHANNEL = {
  id: 'exotel-ai', name: 'Exotel AI Calling', group: 'Calling', glyph: '\u{1F916}', hidden: true,
  desc: 'AI recruitment assistant calls through Exotel (screening, shortlist notices, interview notices and reminders).',
  fields: require('../calling/exotelConfig').FIELD_LIST, // eslint-disable-line global-require
};

function integrationById(id) {
  if (id === AI_CALLING_CHANNEL.id) return AI_CALLING_CHANNEL;
  return INTEGRATION_CATALOG.find((c) => c.id === id) || null;
}

module.exports = {
  INTEGRATION_CATALOG,
  INTEGRATION_GROUPS,
  LIVE_CHANNELS,
  JOB_BOARD_CHANNELS,
  INTEGRATION_STATES,
  SYNC_ENTITIES,
  ORG_STRUCTURE_DEFAULT,
  COMPANY_POLICIES,
  COMPANY_DEFAULTS,
  EMP_TYPES,
  EMP_STATUSES,
  EMP_GENDERS,
  EMP_MGMT_STATUS_FILTER,
  integrationById,
  WA_FIELDS,
  SMS_FIELDS,
  SMS_PROVIDER_CHOICES,
  ANDROID_FIELDS,
  QR_FIELDS,
};
