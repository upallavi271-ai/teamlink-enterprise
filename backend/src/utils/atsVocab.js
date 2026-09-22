// The ATS vocabulary, taken verbatim from the reference prototype.
//
// Stages are STORED as codes (NEW, AI_INTERVIEW_REQUIRED, ...) so the database
// keeps a stable key, but every string a user ever reads comes from
// STAGE_LABELS below and matches the prototype's ATS_STAGES exactly, including
// spelling and order. Nothing in the UI may derive a label by uppercasing or
// underscore-splitting a code.
//
// Prototype references: ATS_STAGES (line 308), STAGE_OWNER_ACTION (line 312),
// ATS_ROLES (line 9895 — the Users administration catalog, which is the
// superset and the one this app follows).

// --- Pipeline stages -------------------------------------------------------
// The pipeline stages, in order. TL_REVIEW sits between the recruiter and
// the BDE: a recruiter forwards, the TL approves, and only then does it
// reach the BDE. Without that step a recruiter could put a candidate in
// front of a client with nobody above them having looked.
const STAGE_CODES = [
  'NEW',
  'AI_INTERVIEW_REQUIRED',
  'AI_INTERVIEW_SCHEDULED',
  'AI_INTERVIEW_COMPLETED',
  'RECRUITER_REVIEW',
  'RECRUITER_APPROVED',
  'TL_REVIEW',
  'WITH_BDE',
  'BDE_APPROVED',
  'SHARED_WITH_CLIENT',
  'CLIENT_REVIEW',
  'CLIENT_SHORTLISTED',
  'INTERVIEW_SCHEDULED',
  'INTERVIEW_COMPLETED',
  'SELECTED',
  'OFFER',
  'OFFER_ACCEPTED',
  'JOINED',
  'HIRED',
];

// Rejected and Hold sit outside the ordered pipeline — the prototype appends
// them wherever a full list is needed.
const EXTRA_STAGE_CODES = ['REJECTED', 'HOLD'];
const ALL_STAGE_CODES = [...STAGE_CODES, ...EXTRA_STAGE_CODES];

const STAGE_LABELS = {
  NEW: 'New',
  AI_INTERVIEW_REQUIRED: 'AI Interview Required',
  AI_INTERVIEW_SCHEDULED: 'AI Interview Scheduled',
  AI_INTERVIEW_COMPLETED: 'AI Interview Completed',
  RECRUITER_REVIEW: 'Recruiter Review',
  RECRUITER_APPROVED: 'Recruiter Approved',
  TL_REVIEW: 'TL Review',
  WITH_BDE: 'With BDE',
  BDE_APPROVED: 'BDE Approved',
  SHARED_WITH_CLIENT: 'Shared with Client',
  CLIENT_REVIEW: 'Client Review',
  CLIENT_SHORTLISTED: 'Client Shortlisted',
  INTERVIEW_SCHEDULED: 'Interview Scheduled',
  INTERVIEW_COMPLETED: 'Interview Completed',
  SELECTED: 'Selected',
  OFFER: 'Offer',
  OFFER_ACCEPTED: 'Offer Accepted',
  JOINED: 'Joined',
  HIRED: 'Hired',
  REJECTED: 'Rejected',
  HOLD: 'Hold',
};

function stageLabel(code) {
  return STAGE_LABELS[code] || code;
}

// Owner role, next action and SLA in days for every stage — the prototype's
// STAGE_OWNER_ACTION. Owner and Next Action are derived from the stage so they
// can never drift out of sync with where the candidate actually is.
const STAGE_OWNER_ACTION = {
  NEW: { ownerRole: 'Recruiter', action: 'Screen the resume', days: 1 },
  AI_INTERVIEW_REQUIRED: { ownerRole: 'Recruiter', action: 'Send AI interview invite', days: 1 },
  AI_INTERVIEW_SCHEDULED: { ownerRole: 'Recruiter', action: 'Await candidate completion', days: 2 },
  AI_INTERVIEW_COMPLETED: { ownerRole: 'Recruiter', action: 'Review AI score, then screen', days: 1 },
  RECRUITER_REVIEW: { ownerRole: 'Recruiter', action: 'Review and forward to TL', days: 1 },
  RECRUITER_APPROVED: { ownerRole: 'Recruiter', action: 'Send to TL', days: 1 },
  TL_REVIEW: { ownerRole: 'TL', action: 'Approve or reject', days: 1 },
  WITH_BDE: { ownerRole: 'BDE', action: 'BDE review', days: 2 },
  BDE_APPROVED: { ownerRole: 'BDE', action: 'Share with client', days: 1 },
  SHARED_WITH_CLIENT: { ownerRole: 'Client', action: 'Await client review', days: 3 },
  CLIENT_REVIEW: { ownerRole: 'Client', action: 'Shortlist or reject', days: 3 },
  CLIENT_SHORTLISTED: { ownerRole: 'BDE', action: 'Schedule interview', days: 2 },
  INTERVIEW_SCHEDULED: { ownerRole: 'Client', action: 'Conduct interview', days: 2 },
  INTERVIEW_COMPLETED: { ownerRole: 'Client', action: 'Record the decision', days: 2 },
  SELECTED: { ownerRole: 'BDE', action: 'Record joining / extend offer', days: 3 },
  OFFER: { ownerRole: 'Recruiter', action: 'Await offer acceptance', days: 3 },
  OFFER_ACCEPTED: { ownerRole: 'Recruiter', action: 'Move to hired', days: 2 },
  JOINED: { ownerRole: 'Accountant', action: 'Raise the invoice', days: 6 },
  HIRED: { ownerRole: '—', action: 'Complete', days: 0 },
  REJECTED: { ownerRole: '—', action: 'Closed — rejected', days: 0 },
  HOLD: { ownerRole: 'Recruiter', action: 'Review the hold', days: 5 },
};

// The prototype's appOwner(): the owner ROLE on the stage resolves to the
// actual named person on the requirement.
function applicationOwner(application, requirement) {
  const rule = STAGE_OWNER_ACTION[application.stage] || {};
  if (!requirement) return rule.ownerRole || '—';
  if (rule.ownerRole === 'Recruiter') return (requirement.recruiter && requirement.recruiter.name) || '—';
  if (rule.ownerRole === 'BDE') {
    const bde = requirement.bde && requirement.bde.name;
    return bde || (requirement.recruiter && requirement.recruiter.name) || '—';
  }
  // The TL named on the requirement, falling back to the recruiter's own
  // line manager name where the requirement carries one.
  if (rule.ownerRole === 'TL') return (requirement.tl && requirement.tl.name) || requirement.tl || '—';
  // §5 — AN OWNER IS ALWAYS A PERSON, never a status or a company. This used
  // to return the CLIENT'S NAME whenever the stage was waiting on a client,
  // so the Owner column read "Vertex Industrial Manufacturing" or, worse,
  // "Shared with Client" — neither of which is somebody who can be chased.
  // Waiting on a client is the BDE's job (the recruiter's where no BDE is
  // named); the client is reported separately as waitingOn.
  if (rule.ownerRole === 'Client') {
    const bde = requirement.bde && requirement.bde.name;
    return bde || (requirement.recruiter && requirement.recruiter.name) || '—';
  }
  return rule.ownerRole || '—';
}

// Who the NEXT ACTION is waiting on, where that is somebody outside TeamLink.
// Null on every stage that is waiting on one of our own people — the owner
// already says who that is.
// §4 — DOES THIS STAGE ACTUALLY OWE SOMEBODY A CONTACT?
//
// Every row without a follow-up read "Not set", on every stage, which is
// wrong twice over: it nags about stages that owe nobody a phone call, and it
// makes the stages that DO need one look like all the others. Not every stage
// needs a communication follow-up — a recruiter reviewing a CV owes an action,
// not a conversation.
//
//   required   the stage is waiting on a HUMAN REPLY, so a date is owed
//   optional   a chase may help but nothing is blocked on a reply
//   none       the work is the next step; there is nobody to ring
const FOLLOWUP_NEED = {
  NEW: 'none',
  AI_INTERVIEW_REQUIRED: 'optional',
  AI_INTERVIEW_SCHEDULED: 'optional',
  AI_INTERVIEW_COMPLETED: 'none',
  RECRUITER_REVIEW: 'none',
  RECRUITER_APPROVED: 'none',
  TL_REVIEW: 'none',
  WITH_BDE: 'optional',
  BDE_APPROVED: 'optional',
  SHARED_WITH_CLIENT: 'required',
  CLIENT_REVIEW: 'required',
  CLIENT_SHORTLISTED: 'required',
  INTERVIEW_SCHEDULED: 'required',
  INTERVIEW_COMPLETED: 'required',
  SELECTED: 'required',
  OFFER: 'required',
  OFFER_ACCEPTED: 'required',
  JOINED: 'optional',
  HIRED: 'none',
  REJECTED: 'none',
  HOLD: 'required',
};
function followUpNeed(application) {
  return FOLLOWUP_NEED[application.stage] || 'optional';
}

function applicationWaitingOn(application, requirement) {
  const rule = STAGE_OWNER_ACTION[application.stage] || {};
  if (rule.ownerRole !== 'Client') return null;
  if (!requirement) return 'Client';
  return requirement.internal
    ? 'TeamLink Internal'
    : (requirement.client && requirement.client.name) || 'Client';
}

function applicationNextAction(application) {
  const rule = STAGE_OWNER_ACTION[application.stage] || {};
  return rule.action || '—';
}

// The prototype's appDueDate(): SLA days added to the last stage movement.
function applicationDueDate(application) {
  const rule = STAGE_OWNER_ACTION[application.stage] || {};
  if (!rule.days) return null;
  const base = new Date(application.updatedAt || application.createdAt);
  if (Number.isNaN(base.getTime())) return null;
  base.setDate(base.getDate() + rule.days);
  return base.toISOString().slice(0, 10);
}

function applicationIsOverdue(application) {
  const due = applicationDueDate(application);
  if (!due) return false;
  return new Date(due) < new Date(new Date().toISOString().slice(0, 10));
}

// The prototype's appLifeStatus() vocabulary, used by the Status column and
// the candidate list's "All statuses" filter.
const LIFE_STATUSES = ['Active', 'On Hold', 'Rejected', 'Closed'];
function applicationLifeStatus(application) {
  if (application.stage === 'REJECTED') return 'Rejected';
  if (application.stage === 'HOLD') return 'On Hold';
  if (['JOINED', 'HIRED'].includes(application.stage)) return 'Closed';
  return 'Active';
}

// --- Roles -----------------------------------------------------------------
// The prototype carries TWO ATS role lists that disagree:
//
//   line 2851 (Add Employee quick picker, 9 entries):
//     No Access, Recruiter, BDE, TL, STL, Assistant Manager, Manager, Client, Admin
//   line 9895 (Users administration catalog, 12 entries):
//     Super Admin, Admin, Manager, Assistant Manager, STL, TL, Recruiter, BDE,
//     HR / Internal Hiring, Client, Candidate, No Access
//
// The Users catalog is the superset and the list role assignment actually reads
// from (setUserRole writes the value chosen there), so it is the authority.
//
// This app diverges from it in one respect, deliberately: the prototype gives
// each user THREE independent product roles (hrmsRole / atsRole / accountsRole)
// on one login, whereas this app has a single `role` spanning all three
// products. Under that model "No Access" is expressed by simply not holding an
// ATS role, and the prototype's 'Candidate' role has no equivalent because the
// candidate portal here is deliberately passwordless (see MyApplications.jsx).
// Splitting one role into three would rewrite every HRMS and Accounts route
// guard, so it is out of scope for a content-fidelity pass and is left as is.
//
// ATS_ROLES below is therefore the set this app actually supports; the labels
// are the prototype's exact strings.
const ATS_ROLES = [
  'SUPER_ADMIN',
  'ADMIN',
  'MANAGER',
  'ASSISTANT_MANAGER',
  'STL',
  'TL',
  'RECRUITER',
  'BDE',
  'CLIENT',
];

const ATS_ROLE_LABELS = {
  SUPER_ADMIN: 'Super Admin',
  ADMIN: 'Admin',
  MANAGER: 'Manager',
  ASSISTANT_MANAGER: 'Assistant Manager',
  STL: 'STL',
  TL: 'TL',
  RECRUITER: 'Recruiter',
  BDE: 'BDE',
  CLIENT: 'Client',
  ACCOUNTANT: 'Accountant',
  EMPLOYEE: 'Employee',
};

function atsRoleLabel(code) {
  return ATS_ROLE_LABELS[code] || code;
}

// --- Agreement lifecycle ---------------------------------------------------
// The full workflow, in order:
//
//   Add Client -> GST / TDS / Payment Terms -> Agreement -> Preview
//     -> Upload / Generate -> Send to Client -> Client View
//     -> Client Confirmation / Signed Copy -> Agreement Active
//
// DRAFT -> SENT -> VIEWED -> CLIENT_CONFIRMATION_PENDING -> SIGNED -> ACTIVE,
// with EXPIRED and REJECTED as terminal states. A client requirement can only
// be activated or posted once the agreement is ACTIVE.
//
// CONFIRMED is the pre-clireq spelling of SIGNED and CANCELLED of REJECTED.
// Both are still ACCEPTED on read (see normalizeAgreementStatus) so a database
// written before this round keeps rendering, but nothing writes them any more.
const AGREEMENT_STATUSES = [
  'DRAFT', 'SENT', 'VIEWED', 'CLIENT_CONFIRMATION_PENDING', 'SIGNED', 'ACTIVE', 'EXPIRED', 'REJECTED',
];
const AGREEMENT_STATUS_LABELS = {
  DRAFT: 'Draft',
  SENT: 'Sent',
  VIEWED: 'Viewed',
  CLIENT_CONFIRMATION_PENDING: 'Client Confirmation Pending',
  SIGNED: 'Signed',
  ACTIVE: 'Active',
  EXPIRED: 'Expired',
  REJECTED: 'Rejected',
  // legacy spellings
  CONFIRMED: 'Signed',
  CANCELLED: 'Rejected',
};
const AGREEMENT_STATUS_ALIASES = { CONFIRMED: 'SIGNED', CANCELLED: 'REJECTED' };
function normalizeAgreementStatus(code) {
  return AGREEMENT_STATUS_ALIASES[code] || code || 'DRAFT';
}
// The one place that answers "has this client actually signed?" — used by the
// agreement routes so a legacy CONFIRMED row behaves exactly like SIGNED.
function agreementIsSigned(code) {
  return ['SIGNED', 'ACTIVE'].includes(normalizeAgreementStatus(code));
}
// The requirement gate. Only ACTIVE lets a client requirement go live.
function agreementIsActive(code) {
  return normalizeAgreementStatus(code) === 'ACTIVE';
}
function agreementStatusLabel(code) {
  return AGREEMENT_STATUS_LABELS[code] || code;
}

// --- Option lists used by the Add/Edit forms -------------------------------
// Every list below is the prototype's <option> set, in the prototype's order.
const DEPTS = ['IT', 'Medical', 'Manufacturing', 'Education', 'BDE', 'HR', 'Accounts', 'R&D'];
const LOCS = ['Hyderabad', 'Bengaluru', 'Pune'];

const REQUIREMENT_TYPES = ['Client Requirement', 'Internal Requirement'];
const PRIORITIES = ['Low', 'Medium', 'High', 'Urgent']; // default Medium
const REQUIREMENT_STATUSES = ['Draft', 'Open', 'On Hold', 'Closed'];

// --- Requirement workflow --------------------------------------------------
// Draft -> Agreement Check -> Open -> Recruiter Assigned -> Sourcing
//   -> Candidates Available -> On Hold / Closed
//
// AGREEMENT_CHECK is the state a client requirement sits in once it has been
// submitted but the client's agreement is not yet Active; OPEN is only ever
// reached through that gate. The three states after OPEN are driven by what
// actually happened to the requirement (a recruiter assigned, sourcing begun,
// candidates in the pipeline), so they are advanced by the routes as well as
// settable by hand.
const REQUIREMENT_STATUS_CODES = [
  'DRAFT', 'AGREEMENT_CHECK', 'OPEN', 'RECRUITER_ASSIGNED', 'SOURCING',
  'CANDIDATES_AVAILABLE', 'ON_HOLD', 'CLOSED',
];
const REQUIREMENT_STATUS_LABELS = {
  DRAFT: 'Draft',
  AGREEMENT_CHECK: 'Agreement Check',
  OPEN: 'Open',
  RECRUITER_ASSIGNED: 'Recruiter Assigned',
  SOURCING: 'Sourcing',
  CANDIDATES_AVAILABLE: 'Candidates Available',
  ON_HOLD: 'On Hold',
  CLOSED: 'Closed',
};
// The states that count as "live" — a requirement past the agreement gate and
// not parked or finished. Everything that used to test `status === 'OPEN'`
// asks this instead, so the four new live states do not silently disappear
// from the Open Requirements list or the job portal.
const REQUIREMENT_LIVE_STATUSES = ['OPEN', 'RECRUITER_ASSIGNED', 'SOURCING', 'CANDIDATES_AVAILABLE'];
function requirementIsLive(status) {
  return REQUIREMENT_LIVE_STATUSES.includes(status);
}
function requirementStatusLabel(code) {
  return REQUIREMENT_STATUS_LABELS[code] || code || '-';
}

// --- Job portal sync -------------------------------------------------------
const PORTAL_SYNC_STATUSES = ['Not Synced', 'Pending', 'Synced', 'Failed'];

// The value written onto Application.source when an application comes in
// through a job-portal form rather than a recruiter keying it in. ONE
// canonical string, and a wider match list so rows written before this name
// existed (Candidate.source has said 'Job Portal' since the first seed) are
// still recognised as portal intake rather than quietly disappearing from the
// workspace.
const PORTAL_APPLICATION_SOURCE = 'TeamLink Job Portal';
// Deliberately NOT 'TeamLink Website': that is Candidate.source's default, so
// treating it as portal intake would count every seeded candidate as an
// arriving application and the workspace's numbers would be a lie.
const PORTAL_APPLICATION_SOURCES = ['TeamLink Job Portal', 'Job Portal'];
const isPortalSource = (value) => PORTAL_APPLICATION_SOURCES.includes(String(value || ''));
const EDUCATION_LEVELS = [
  'Any Degree', 'B.Tech', 'B.E', 'MCA', 'MBA', 'M.Tech', 'MBBS', 'B.Pharm', 'B.Sc', 'M.Sc', 'Diploma', 'Other',
];
const EMPLOYMENT_TYPES = ['Full Time', 'Part Time', 'Contract', 'Temporary', 'Internship'];
const WORK_MODES = ['Work From Office', 'Hybrid', 'Remote'];
const JOINING_TIMELINES = ['Immediate', 'Within 7 Days', 'Within 15 Days', 'Within 30 Days', '30–60 Days', '60+ Days']; // default Within 15 Days
const NOTICE_PERIODS_MAX = ['Immediate', '7 Days', '15 Days', '30 Days', '60 Days', '90 Days']; // default 30 Days
const JOB_PREFERENCES = ['Permanent', 'Contract', 'Full Time', 'Part Time', 'Remote', 'Hybrid', 'Office'];
const SALARY_TYPES = ['Annual CTC', 'Monthly', 'Hourly'];
const CURRENCIES = ['INR', 'USD'];

// Candidate-side lists (prototype openAddCandidateModal, line 8150).
const CANDIDATE_GENDERS = ['Prefer not to say', 'Female', 'Male', 'Other'];
const CANDIDATE_NOTICE_PERIODS = ['Immediate', '15 Days', '30 Days', '60 Days', '90 Days']; // default 30 Days
const CANDIDATE_AVAILABILITY = [
  'Available immediately', 'Available after notice period', 'Not actively looking',
]; // default Available after notice period
const CANDIDATE_JOB_PREFERENCES = ['Permanent', 'Contract', 'Full Time', 'Part Time', 'Remote'];
const CANDIDATE_EMPLOYMENT_TYPES = ['Full Time', 'Part Time', 'Contract', 'Internship'];
const CANDIDATE_WORK_MODES = ['Work From Office', 'Hybrid', 'Remote']; // default Hybrid
const CANDIDATE_EDUCATION = ['B.Tech', 'B.E', 'MCA', 'MBA', 'M.Tech', 'B.Sc', 'M.Sc', 'Diploma', 'Other'];

// Candidate source: the Add Candidate modal's list, and the (longer) list on
// the candidate list filter row — the prototype's two lists differ, so both
// are kept as-is.
const CANDIDATE_SOURCES = [
  'Direct', 'Referral', 'Job Portal', 'Naukri', 'Indeed', 'Shine', 'LinkedIn', 'TeamLink Website', 'Social Media',
];
const CANDIDATE_FIRST_SOURCES = ['Direct', 'Referral', 'Job Portal', 'Naukri', 'Indeed', 'LinkedIn'];
const CANDIDATE_FILTER_SOURCES = [
  'Job Portal', 'Naukri', 'Indeed', 'Shine', 'Referral', 'Direct', 'LinkedIn', 'TeamLink Website', 'Social Media',
];
const APPLICATION_METHODS = ['Manual', 'Auto-Apply'];

// Client-side lists (prototype openAddClientModal, line 7296).
const CLIENT_INDUSTRIES = [
  'IT', 'Healthcare', 'Manufacturing', 'Education', 'Finance', 'Retail', 'Logistics', 'Other',
];
const CLIENT_STATUSES = ['Active', 'Inactive', 'Suspended']; // default Active
const CLIENT_TYPES = ['Direct', 'Vendor', 'Partner'];
const CLIENT_PRIORITIES = ['High', 'Medium', 'Low']; // default High
const COMM_MODES = ['Email', 'WhatsApp', 'Phone'];
const COMM_CHANNELS = ['Email', 'WhatsApp', 'SMS'];
const BUSINESS_TYPES = ['Private Limited', 'Public Limited', 'LLP', 'Partnership', 'Startup', 'Other'];
const PAYMENT_TERMS = [
  'Invoice 6 days after joining; payment due within 6 days of invoice',
  '15 Days', '30 Days', '45 Days', '60 Days',
];
const INVOICE_TRIGGERS = ['Candidate Joining', 'Custom'];
const AGREEMENT_TEMPLATES = ['Standard Recruitment / Staffing', 'Contract Staffing', 'Executive Search'];
const RISK_FLAGS = ['None', 'Watch', 'High Risk'];
const INDIAN_STATES = ['Telangana', 'Karnataka', 'Maharashtra', 'Tamil Nadu', 'Delhi'];

// Commercial defaults, from the prototype's Add Client form.
const DEFAULT_FEE_PERCENT = 8.33;
const DEFAULT_GST_PERCENT = 18;
const DEFAULT_TDS_PERCENT = 10;
const DEFAULT_GUARANTEE_PERIOD = '30 Days';
const DEFAULT_PAYMENT_DUE = '6 days after invoice';
const DEFAULT_PAYMENT_TERMS = PAYMENT_TERMS[0];


// ---------------------------------------------------------------------------
// Recruitment / client interview lifecycle (prototype INTERVIEW_STATUSES +
// IV_NEXT, line 9200). Stored as codes; the labels below are the exact strings
// the prototype shows. Scheduled -> Confirmed -> Started -> Completed ->
// Pending Feedback, with Cancelled / No Show / Rescheduled tracked separately.
// ---------------------------------------------------------------------------
const INTERVIEW_STATUS_CODES = [
  'SCHEDULED', 'CONFIRMED', 'STARTED', 'COMPLETED', 'PENDING_FEEDBACK',
  'FEEDBACK_SUBMITTED', 'CANCELLED', 'NO_SHOW', 'RESCHEDULED',
];

const INTERVIEW_STATUS_LABELS = {
  SCHEDULED: 'Scheduled',
  CONFIRMED: 'Confirmed',
  STARTED: 'Started',
  COMPLETED: 'Completed',
  PENDING_FEEDBACK: 'Pending Feedback',
  FEEDBACK_SUBMITTED: 'Feedback Submitted',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'No Show',
  RESCHEDULED: 'Rescheduled',
};

// The only forward move allowed from each status — no skipping.
const INTERVIEW_NEXT = {
  SCHEDULED: 'CONFIRMED',
  CONFIRMED: 'STARTED',
  STARTED: 'COMPLETED',
  COMPLETED: 'PENDING_FEEDBACK',
  // A rescheduled interview is re-confirmed into the same chain — the
  // calendar has always offered that button; without this entry the API
  // refused it.
  RESCHEDULED: 'CONFIRMED',
};

// Statuses an interview cannot be advanced out of — it must be rescheduled.
const INTERVIEW_TERMINAL = ['CANCELLED', 'NO_SHOW'];

const INTERVIEW_TYPES = ['Client Interview', 'Internal Panel'];
const INTERVIEW_MODES = ['Online', 'In Person', 'Telephonic'];
const INTERVIEW_RESULTS = ['Recommended', 'Hold', 'Not Selected'];

// STATUS is where the interview IS; RESULT is what it DECIDED. They are two
// different columns and are never mixed: an interview can be Feedback
// Submitted with a result of Hold, or Cancelled with no result at all.
// The recommendation a feedback form records — and therefore the Result
// column — is one of exactly these three.
const INTERVIEW_RECOMMENDATIONS = ['Selected', 'Rejected', 'Hold'];

// Feedback submitted before this vocabulary existed used the prototype's older
// three words. They are read back as the new ones; nothing is rewritten.
const LEGACY_RESULT_MAP = { Recommended: 'Selected', 'Not Selected': 'Rejected', Hold: 'Hold' };
function normalizeRecommendation(value) {
  if (!value) return null;
  if (INTERVIEW_RECOMMENDATIONS.includes(value)) return value;
  return LEGACY_RESULT_MAP[value] || null;
}

// The interview feedback form, field for field.
const FEEDBACK_CRITERIA = [
  { key: 'technical', label: 'Technical Skills' },
  { key: 'communication', label: 'Communication' },
  { key: 'experience', label: 'Experience' },
  { key: 'roleFit', label: 'Role Fit' },
];
const FEEDBACK_KINDS = ['Internal', 'Client'];

// AI interview tab. An expired AI interview never rejects the candidate.
const AI_INTERVIEW_STATUSES = ['Required', 'Scheduled', 'Started', 'Completed', 'Expired', 'Manual Review Requested'];

function interviewStatusLabel(code) {
  return INTERVIEW_STATUS_LABELS[code] || code || '—';
}

module.exports = {
  STAGE_CODES,
  EXTRA_STAGE_CODES,
  ALL_STAGE_CODES,
  STAGE_LABELS,
  stageLabel,
  STAGE_OWNER_ACTION,
  applicationOwner,
  applicationWaitingOn,
  followUpNeed,
  FOLLOWUP_NEED,
  applicationNextAction,
  applicationDueDate,
  applicationIsOverdue,
  LIFE_STATUSES,
  applicationLifeStatus,
  ATS_ROLES,
  ATS_ROLE_LABELS,
  atsRoleLabel,
  AGREEMENT_STATUSES,
  AGREEMENT_STATUS_LABELS,
  AGREEMENT_STATUS_ALIASES,
  normalizeAgreementStatus,
  agreementIsSigned,
  agreementIsActive,
  agreementStatusLabel,
  REQUIREMENT_STATUS_CODES,
  REQUIREMENT_STATUS_LABELS,
  REQUIREMENT_LIVE_STATUSES,
  requirementIsLive,
  requirementStatusLabel,
  PORTAL_SYNC_STATUSES,
  PORTAL_APPLICATION_SOURCE,
  PORTAL_APPLICATION_SOURCES,
  isPortalSource,
  DEPTS,
  LOCS,
  REQUIREMENT_TYPES,
  INTERVIEW_STATUS_CODES,
  INTERVIEW_STATUS_LABELS,
  INTERVIEW_NEXT,
  INTERVIEW_TERMINAL,
  INTERVIEW_TYPES,
  INTERVIEW_MODES,
  INTERVIEW_RESULTS,
  INTERVIEW_RECOMMENDATIONS,
  normalizeRecommendation,
  FEEDBACK_CRITERIA,
  FEEDBACK_KINDS,
  AI_INTERVIEW_STATUSES,
  interviewStatusLabel,
  PRIORITIES,
  REQUIREMENT_STATUSES,
  EDUCATION_LEVELS,
  EMPLOYMENT_TYPES,
  WORK_MODES,
  JOINING_TIMELINES,
  NOTICE_PERIODS_MAX,
  JOB_PREFERENCES,
  SALARY_TYPES,
  CURRENCIES,
  CANDIDATE_GENDERS,
  CANDIDATE_NOTICE_PERIODS,
  CANDIDATE_AVAILABILITY,
  CANDIDATE_JOB_PREFERENCES,
  CANDIDATE_EMPLOYMENT_TYPES,
  CANDIDATE_WORK_MODES,
  CANDIDATE_EDUCATION,
  CANDIDATE_SOURCES,
  CANDIDATE_FIRST_SOURCES,
  CANDIDATE_FILTER_SOURCES,
  APPLICATION_METHODS,
  CLIENT_INDUSTRIES,
  CLIENT_STATUSES,
  CLIENT_TYPES,
  CLIENT_PRIORITIES,
  COMM_MODES,
  COMM_CHANNELS,
  BUSINESS_TYPES,
  PAYMENT_TERMS,
  INVOICE_TRIGGERS,
  AGREEMENT_TEMPLATES,
  RISK_FLAGS,
  INDIAN_STATES,
  DEFAULT_FEE_PERCENT,
  DEFAULT_GST_PERCENT,
  DEFAULT_TDS_PERCENT,
  DEFAULT_GUARANTEE_PERIOD,
  DEFAULT_PAYMENT_DUE,
  DEFAULT_PAYMENT_TERMS,
};
