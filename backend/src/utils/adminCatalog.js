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
};
const SMS_FIELDS = {
  provider: 'Provider (MSG91 / Fast2SMS / Twilio)',
  sender: 'Sender ID (6 chars) / Twilio From number',
  key: 'API key / Auth token',
  sid: 'Twilio Account SID',
  linkTpl: 'DLT template ID — agreement link',
  otpTpl: 'DLT template ID — OTP',
  bulkTpl: 'DLT template ID — bulk / general',
};

const INTEGRATION_CATALOG = [
  { id: 'whatsapp', name: 'WhatsApp Business', group: 'Messaging', glyph: '\u{1F4AC}',
    desc: 'WhatsApp Cloud API (Meta): agreement links, signing OTPs, candidate updates and bulk messages — approved templates, plain text only inside a 24-hour customer session.',
    fields: [[WA_FIELDS.display, '+91 '], [WA_FIELDS.phoneId, 'from Meta → WhatsApp → API Setup'], [WA_FIELDS.wabaId, ''],
      [WA_FIELDS.token, ''], [WA_FIELDS.namespace, 'optional (legacy)'], [WA_FIELDS.language, 'en'],
      [WA_FIELDS.linkTpl, 'body {{1}} name, {{2}} agreement no., {{3}} link'],
      [WA_FIELDS.otpTpl, 'authentication template, {{1}} code'],
      [WA_FIELDS.bulkTpl, 'body {{1}} = the message']] },
  { id: 'sms', name: 'SMS Gateway', group: 'Messaging', glyph: '\u{1F4F1}',
    desc: 'Transactional SMS (MSG91, Fast2SMS or Twilio) for signing OTPs, agreement links, interview alerts and bulk messages.',
    fields: [[SMS_FIELDS.provider, 'MSG91'], [SMS_FIELDS.sender, 'TMLINK'], [SMS_FIELDS.key, ''],
      [SMS_FIELDS.sid, 'Twilio only (AC…)'],
      [SMS_FIELDS.linkTpl, 'vars: name, agreement no., link'],
      [SMS_FIELDS.otpTpl, 'vars: code, minutes'],
      [SMS_FIELDS.bulkTpl, 'one var: the message']] },
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
  { id: 'telephony', name: 'Cloud Telephony / IVR', group: 'Calling', glyph: '\u{1F4DE}',
    desc: 'Click-to-call from a candidate profile, IVR routing and call recording.',
    fields: [['Provider', ''], ['Account SID', ''], ['Auth token', ''], ['Caller ID number', ''], ['Recording storage URL', '']] },
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
    desc: 'The candidate-facing TeamLink Job Portal — syncs candidates, applications, requirements and job status.',
    fields: [['Portal URL / origin', 'file:// or https://'], ['Bridge key', 'tl_job_portal_state_v1'], ['Sync frequency', 'On demand']] },
  { id: 'naukri', name: 'Naukri', group: 'Job Boards', glyph: '\u{1F50D}',
    // SAVE & POST (2026-10-05) — REAL connectors (utils/jobConnectors.js,
    // utils/jobBoards/*.js). The fields are exactly what each board's approved
    // route needs; each list lives with the connector that reads it.
    desc: 'Save & Post sends jobs to Naukri through Naukri\'s ATS integration "Amplify" (Zwayam). Naukri has no public API: buy the job-posting plan with Amplify from your Naukri account manager or amplify@zwayam.com; they give the API key, secret key and job endpoint.',
    fields: require('./jobBoards/partner').naukri.FIELDS }, // eslint-disable-line global-require
  { id: 'linkedin', name: 'LinkedIn Recruiter', group: 'Job Boards', glyph: '\u{1F517}',
    desc: 'Save & Post sends jobs through LinkedIn\'s Job Posting API (approved partners only; LinkedIn is not taking new API partners right now). Ask LinkedIn Talent Solutions for partner access, then enter the company page id, app Client ID / secret, poster email and API version.',
    fields: require('./jobBoards/linkedin').FIELDS }, // eslint-disable-line global-require
  { id: 'indeed', name: 'Indeed', group: 'Job Boards', glyph: '\u{1F4CC}',
    desc: 'Save & Post sends jobs through Indeed\'s Job Sync API. Needs an Indeed partner account: sign the Developer Agreement and apply at partners.indeed.com; the Client ID / secret are in the Indeed Partner Console.',
    fields: require('./jobBoards/indeed').FIELDS }, // eslint-disable-line global-require
  { id: 'shine', name: 'Shine', group: 'Job Boards', glyph: '✨',
    desc: 'Save & Post sends jobs to Shine once Shine gives you an ATS job-posting API account (no public API: ask your Shine employer sales / account manager). Enter the API key and job endpoint they give.',
    fields: require('./jobBoards/partner').shine.FIELDS }, // eslint-disable-line global-require
  { id: 'google-jobs', name: 'Google for Jobs', group: 'Job Boards', glyph: '\u{1F50E}',
    desc: 'Jobs are in our Google Jobs (JobPosting) data at once. With a Google Cloud service account (Indexing API on, added as Owner in Search Console) TeamLink tells Google about each job and confirms when Google shows it.',
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
    desc: 'Claude for the AI Assistant and Agent (when AI_PROVIDER=claude) and the weekly-idea screener — always inside the asking user’s permissions and scope.',
    fields: [['Anthropic API key', 'sk-ant-...'], ['Model', 'claude-opus-5'],
      ['Max answer tokens', '1500'], ['Questions per user per hour', '30']] },
];

const INTEGRATION_GROUPS = ['Messaging', 'Email', 'AI', 'Calling', 'Scheduling', 'Job Boards', 'Storage', 'Finance', 'Workforce', 'Developer'];

// Channels this app really talks to. Everything else on the Integrations
// screen is still Demo / Simulated and keeps saying so.
const LIVE_CHANNELS = ['email', 'ai-claude', 'biometric', 'jobportal', 'sms', 'whatsapp', 'naukri', 'indeed', 'shine', 'linkedin', 'google-jobs', 'turnstile'];
// The job boards Save & Post really posts to (utils/jobConnectors.js).
const JOB_BOARD_CHANNELS = ['naukri', 'indeed', 'shine', 'linkedin', 'google-jobs'];

const INTEGRATION_STATES = ['Not Connected', 'Connected', 'Expired', 'Reconnect Required'];

// Which entities a channel reports on a Sync Now run.
const SYNC_ENTITIES = {
  jobportal: ['Candidates', 'Applications', 'Requirements', 'Job Status'],
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

function integrationById(id) {
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
};
