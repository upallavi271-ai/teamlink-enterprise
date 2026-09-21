// Administration reference lists, taken verbatim from the reference prototype
// (teamlink-enterprise_69.html): INTEGRATION_CATALOG (line 2189),
// INTEGRATION_GROUPS (line 2257), ORG_STRUCTURE_DEFAULT (line 2260) and the
// companySetup policy list (line 407).

// Every outside channel the platform talks to. `fields` is [label, placeholder]
// in the prototype's order — the Configure modal renders them exactly so.
const INTEGRATION_CATALOG = [
  { id: 'whatsapp', name: 'WhatsApp Business', group: 'Messaging', glyph: '\u{1F4AC}',
    desc: 'Send candidate updates, interview reminders and client approvals over WhatsApp.',
    fields: [['Business phone number', '+91 '], ['WhatsApp Business ID', ''], ['Permanent access token', ''], ['Template namespace', '']] },
  { id: 'sms', name: 'SMS Gateway', group: 'Messaging', glyph: '\u{1F4F1}',
    desc: 'Transactional SMS for OTPs, interview alerts and offer notifications.',
    fields: [['Provider', ''], ['Sender ID (6 chars)', ''], ['API key', ''], ['DLT template ID', '']] },
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
    desc: 'Two-way sync of interview slots with Google or Outlook calendars.',
    fields: [['Provider (Google / Outlook)', ''], ['Client ID', ''], ['Client secret', ''], ['Default calendar', '']] },
  { id: 'jobportal', name: 'TeamLink Job Portal', group: 'Job Boards', glyph: '\u{1F517}',
    desc: 'The candidate-facing TeamLink Job Portal — syncs candidates, applications, requirements and job status.',
    fields: [['Portal URL / origin', 'file:// or https://'], ['Bridge key', 'tl_job_portal_state_v1'], ['Sync frequency', 'On demand']] },
  { id: 'naukri', name: 'Naukri', group: 'Job Boards', glyph: '\u{1F50D}',
    desc: 'Post requirements and pull applicant responses into the candidate database.',
    fields: [['Recruiter account email', ''], ['API key', '']] },
  { id: 'linkedin', name: 'LinkedIn Recruiter', group: 'Job Boards', glyph: '\u{1F517}',
    desc: 'Publish jobs and import candidate profiles.',
    fields: [['Organization ID', ''], ['Client ID', ''], ['Client secret', '']] },
  { id: 'indeed', name: 'Indeed', group: 'Job Boards', glyph: '\u{1F4CC}',
    desc: 'Publish requirements to Indeed and pull applicant responses.',
    fields: [['Employer account email', ''], ['API key', '']] },
  { id: 'shine', name: 'Shine', group: 'Job Boards', glyph: '✨',
    desc: 'Publish requirements to Shine and pull applicant responses.',
    fields: [['Recruiter account email', ''], ['API key', '']] },
  { id: 'website', name: 'TeamLink Website', group: 'Job Boards', glyph: '\u{1F310}',
    desc: 'Publish openings to the careers page on tmlink.in.',
    fields: [['Careers page URL', ''], ['Publish token', '']] },
  { id: 'social', name: 'Social Media', group: 'Job Boards', glyph: '\u{1F4E3}',
    desc: 'Share openings to LinkedIn, X and Facebook pages.',
    fields: [['Page / handle', ''], ['Access token', '']] },
  { id: 'storage', name: 'Document Storage', group: 'Storage', glyph: '\u{1F5C2}️',
    desc: 'Where resumes, offer letters and employee documents are stored.',
    fields: [['Provider (S3 / Drive)', ''], ['Bucket / folder', ''], ['Access key', ''], ['Secret key', '']] },
  { id: 'esign', name: 'e-Signature', group: 'Storage', glyph: '\u{1F58A}️',
    desc: 'Send offer letters and client agreements for signature.',
    fields: [['Provider', ''], ['API key', '']] },
  { id: 'tally', name: 'Tally / Accounting', group: 'Finance', glyph: '\u{1F4D2}',
    desc: 'Push invoices and payments into the accounting ledger.',
    fields: [['Company name in Tally', ''], ['Connector URL', ''], ['Sync frequency', 'Daily']] },
  { id: 'payments', name: 'Payment Gateway', group: 'Finance', glyph: '\u{1F3E6}',
    desc: 'Collect client invoice payments online and auto-reconcile receipts.',
    fields: [['Provider', ''], ['Key ID', ''], ['Key secret', ''], ['Webhook secret', '']] },
  { id: 'biometric', name: 'Biometric / Attendance Device', group: 'Workforce', glyph: '\u{1F590}️',
    desc: 'Import daily punch data from attendance devices into HRMS.',
    fields: [['Device vendor', ''], ['Device / site ID', ''], ['Sync endpoint', '']] },
  { id: 'webhooks', name: 'Webhooks', group: 'Developer', glyph: '\u{1FA9D}',
    desc: 'Notify your own systems when a candidate joins, an invoice is paid, and similar events.',
    fields: [['Endpoint URL', ''], ['Signing secret', ''], ['Events (comma separated)', 'candidate.joined, invoice.paid']] },
  { id: 'api', name: 'REST API Access', group: 'Developer', glyph: '\u{1F511}',
    desc: 'Issue API keys for external systems to read and write platform data.',
    fields: [['Key label', ''], ['Allowed IP range', ''], ['Scope (read / write)', 'read']] },
  // REAL. The AI Assistant's free-text Q&A calls the Anthropic API with this
  // key — see utils/aiAgent.js. The key stays on the server: it is encrypted
  // at rest and is never included in any response.
  { id: 'ai-claude', name: 'AI Assistant (Anthropic Claude)', group: 'AI', glyph: '\u{1F916}',
    desc: 'Free-text questions in the AI Assistant, answered from this app’s own data — always inside the asking user’s permissions and scope.',
    fields: [['Anthropic API key', 'sk-ant-...'], ['Model', 'claude-opus-5'],
      ['Max answer tokens', '1500'], ['Questions per user per hour', '30']] },
];

const INTEGRATION_GROUPS = ['Messaging', 'Email', 'AI', 'Calling', 'Scheduling', 'Job Boards', 'Storage', 'Finance', 'Workforce', 'Developer'];

// Channels this app really talks to. Everything else on the Integrations
// screen is still Demo / Simulated and keeps saying so.
const LIVE_CHANNELS = ['email', 'ai-claude'];

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
};
