// ESM mirror of backend/src/utils/atsVocab.js — the ATS vocabulary taken
// verbatim from the reference prototype. Keep the two files in step: the
// backend copy is the authority for validation, this one for rendering.
//
// Every label here is the exact string the prototype shows. No screen may
// derive a label by uppercasing or underscore-splitting a stored code.

export const STAGE_CODES = [
  'NEW',
  'AI_INTERVIEW_REQUIRED',
  'AI_INTERVIEW_SCHEDULED',
  'AI_INTERVIEW_COMPLETED',
  'RECRUITER_REVIEW',
  'RECRUITER_APPROVED',
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

export const EXTRA_STAGE_CODES = ['REJECTED', 'HOLD'];
export const ALL_STAGE_CODES = [...STAGE_CODES, ...EXTRA_STAGE_CODES];

export const STAGE_LABELS = {
  NEW: 'New',
  AI_INTERVIEW_REQUIRED: 'AI Interview Required',
  AI_INTERVIEW_SCHEDULED: 'AI Interview Scheduled',
  AI_INTERVIEW_COMPLETED: 'AI Interview Completed',
  RECRUITER_REVIEW: 'Recruiter Review',
  RECRUITER_APPROVED: 'Recruiter Approved',
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

export function stageLabel(code) {
  return STAGE_LABELS[code] || code || '—';
}

export const LIFE_STATUSES = ['Active', 'On Hold', 'Rejected', 'Closed'];

// Requirement status is stored as a code but shown the prototype's way.
// Requirement workflow:
//   Draft → Agreement Check → Open → Recruiter Assigned → Sourcing
//     → Candidates Available → On Hold / Closed
export const REQUIREMENT_STATUS_CODES = [
  'DRAFT', 'AGREEMENT_CHECK', 'OPEN', 'RECRUITER_ASSIGNED', 'SOURCING',
  'CANDIDATES_AVAILABLE', 'ON_HOLD', 'CLOSED',
];
export const REQUIREMENT_STATUS_LABELS = {
  DRAFT: 'Draft',
  AGREEMENT_CHECK: 'Agreement Check',
  OPEN: 'Open',
  RECRUITER_ASSIGNED: 'Recruiter Assigned',
  SOURCING: 'Sourcing',
  CANDIDATES_AVAILABLE: 'Candidates Available',
  ON_HOLD: 'On Hold',
  CLOSED: 'Closed',
};
// A requirement past the agreement gate and neither parked nor finished.
export const REQUIREMENT_LIVE_STATUSES = ['OPEN', 'RECRUITER_ASSIGNED', 'SOURCING', 'CANDIDATES_AVAILABLE'];
export const requirementIsLive = (status) => REQUIREMENT_LIVE_STATUSES.includes(status);
export function requirementStatusLabel(code) {
  return REQUIREMENT_STATUS_LABELS[code] || code || '—';
}
export function requirementBadgeClass(code) {
  if (code === 'CLOSED') return 'rejected';
  if (code === 'ON_HOLD') return 'pending';
  if (['DRAFT', 'AGREEMENT_CHECK'].includes(code)) return 'new';
  if (code === 'CANDIDATES_AVAILABLE') return 'shortlist';
  return 'active';
}

// Agreement workflow:
//   Draft → Sent → Viewed → Client Confirmation Pending → Signed → Active,
//   with Expired and Rejected terminal. CONFIRMED / CANCELLED are the
//   pre-clireq spellings and are still rendered, never written.
export const AGREEMENT_STATUS_CODES = [
  'DRAFT', 'SENT', 'VIEWED', 'CLIENT_CONFIRMATION_PENDING', 'SIGNED', 'ACTIVE', 'EXPIRED', 'REJECTED',
];
export const AGREEMENT_STATUS_LABELS = {
  DRAFT: 'Draft',
  SENT: 'Sent',
  VIEWED: 'Viewed',
  CLIENT_CONFIRMATION_PENDING: 'Client Confirmation Pending',
  SIGNED: 'Signed',
  ACTIVE: 'Active',
  EXPIRED: 'Expired',
  REJECTED: 'Rejected',
  CONFIRMED: 'Signed',
  CANCELLED: 'Rejected',
};
export const normalizeAgreementStatus = (code) =>
  ({ CONFIRMED: 'SIGNED', CANCELLED: 'REJECTED' }[code] || code || 'DRAFT');
export const agreementIsSigned = (code) => ['SIGNED', 'ACTIVE'].includes(normalizeAgreementStatus(code));
export const agreementIsActive = (code) => normalizeAgreementStatus(code) === 'ACTIVE';
export function agreementStatusLabel(code) {
  return AGREEMENT_STATUS_LABELS[code] || code || '—';
}
export const PORTAL_SYNC_STATUSES = ['Not Synced', 'Pending', 'Synced', 'Failed'];

// Labels are the prototype's exact strings from its Users administration
// catalog (line 9895). See backend/src/utils/atsVocab.js for why this app's
// role set is narrower than the prototype's.
export const ATS_ROLE_LABELS = {
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
export function atsRoleLabel(code) {
  return ATS_ROLE_LABELS[code] || code || '—';
}

// --- Recruitment / client interview lifecycle ------------------------------
// The prototype's INTERVIEW_STATUSES + IV_NEXT (line 9200). Mirrors
// backend/src/utils/atsVocab.js — keep the two in step.
export const INTERVIEW_STATUS_CODES = [
  'SCHEDULED', 'CONFIRMED', 'STARTED', 'COMPLETED', 'PENDING_FEEDBACK',
  'FEEDBACK_SUBMITTED', 'CANCELLED', 'NO_SHOW', 'RESCHEDULED',
];

export const INTERVIEW_STATUS_LABELS = {
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

export function interviewStatusLabel(code) {
  return INTERVIEW_STATUS_LABELS[code] || code || '—';
}

// Only one forward move is allowed from each status — no skipping.
export const INTERVIEW_NEXT = {
  SCHEDULED: 'CONFIRMED',
  CONFIRMED: 'STARTED',
  STARTED: 'COMPLETED',
  COMPLETED: 'PENDING_FEEDBACK',
  // A rescheduled interview is re-confirmed into the same chain — the
  // calendar has always offered that button; without this entry the API
  // refused it.
  RESCHEDULED: 'CONFIRMED',
};

export const INTERVIEW_TYPES = ['Client Interview', 'Internal Panel'];
export const INTERVIEW_MODES = ['Online', 'In Person', 'Telephonic'];
export const INTERVIEW_RESULTS = ['Recommended', 'Hold', 'Not Selected'];

// STATUS is where the interview IS; RESULT is what it DECIDED. Two columns,
// never mixed. A feedback recommendation is one of exactly these three.
export const INTERVIEW_RECOMMENDATIONS = ['Selected', 'Rejected', 'Hold'];

export const FEEDBACK_CRITERIA = [
  { key: 'technical', label: 'Technical Skills' },
  { key: 'communication', label: 'Communication' },
  { key: 'experience', label: 'Experience' },
  { key: 'roleFit', label: 'Role Fit' },
];

// --- Interviews & Joining --------------------------------------------------
export const CLIENT_PLACEMENT = 'Client Placement';
export const INTERNAL_HIRE = 'TeamLink Internal Hire';
export const HIRING_TYPES = [CLIENT_PLACEMENT, INTERNAL_HIRE];
export const OFFER_STATUSES = ['Not Issued', 'Offer Released', 'Offer Accepted', 'Offer Declined'];
export const DOCUMENT_STATUSES = ['Pending', 'Submitted', 'Verified'];
export const JOINING_STATUSES = ['Not Scheduled', 'Joining Scheduled', 'Joined', 'Dropped'];

export function resultClass(value) {
  if (value === 'Selected') return 'selected';
  if (value === 'Rejected') return 'rejected';
  if (value === 'Hold') return 'hold';
  return '';
}
export function offerStatusClass(value) {
  if (value === 'Offer Accepted') return 'selected';
  if (value === 'Offer Released') return 'offer';
  if (value === 'Offer Declined') return 'rejected';
  return '';
}
export function joiningStatusClass(value) {
  if (value === 'Joined') return 'joined';
  if (value === 'Joining Scheduled') return 'interview';
  if (value === 'Dropped') return 'rejected';
  return '';
}

// Reuses the existing badge palette rather than the prototype's inline colours.
export function interviewStatusClass(code) {
  if (['COMPLETED', 'FEEDBACK_SUBMITTED'].includes(code)) return 'priority-low';
  if (['CANCELLED', 'NO_SHOW'].includes(code)) return 'priority-high';
  if (['PENDING_FEEDBACK', 'RESCHEDULED'].includes(code)) return 'priority-medium';
  return '';
}

// --- Option lists used by the Add/Edit forms -------------------------------
export const DEPTS = ['IT', 'Medical', 'Manufacturing', 'Education', 'BDE', 'HR', 'Accounts', 'R&D'];
export const LOCS = ['Hyderabad', 'Bengaluru', 'Pune'];

export const REQUIREMENT_TYPES = ['Client Requirement', 'Internal Requirement'];
export const PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];
export const REQUIREMENT_STATUSES = ['Draft', 'Open', 'On Hold', 'Closed'];
export const EDUCATION_LEVELS = [
  'Any Degree', 'B.Tech', 'B.E', 'MCA', 'MBA', 'M.Tech', 'MBBS', 'B.Pharm', 'B.Sc', 'M.Sc', 'Diploma', 'Other',
];
export const EMPLOYMENT_TYPES = ['Full Time', 'Part Time', 'Contract', 'Temporary', 'Internship'];
export const WORK_MODES = ['Work From Office', 'Hybrid', 'Remote'];
export const JOINING_TIMELINES = ['Immediate', 'Within 7 Days', 'Within 15 Days', 'Within 30 Days', '30–60 Days', '60+ Days'];
export const NOTICE_PERIODS_MAX = ['Immediate', '7 Days', '15 Days', '30 Days', '60 Days', '90 Days'];
export const JOB_PREFERENCES = ['Permanent', 'Contract', 'Full Time', 'Part Time', 'Remote', 'Hybrid', 'Office'];
export const SALARY_TYPES = ['Annual CTC', 'Monthly', 'Hourly'];
export const CURRENCIES = ['INR', 'USD'];

export const CANDIDATE_GENDERS = ['Prefer not to say', 'Female', 'Male', 'Other'];
export const CANDIDATE_NOTICE_PERIODS = ['Immediate', '15 Days', '30 Days', '60 Days', '90 Days'];
export const CANDIDATE_AVAILABILITY = [
  'Available immediately', 'Available after notice period', 'Not actively looking',
];
export const CANDIDATE_JOB_PREFERENCES = ['Permanent', 'Contract', 'Full Time', 'Part Time', 'Remote'];
export const CANDIDATE_EMPLOYMENT_TYPES = ['Full Time', 'Part Time', 'Contract', 'Internship'];
export const CANDIDATE_WORK_MODES = ['Work From Office', 'Hybrid', 'Remote'];
export const CANDIDATE_EDUCATION = ['B.Tech', 'B.E', 'MCA', 'MBA', 'M.Tech', 'B.Sc', 'M.Sc', 'Diploma', 'Other'];

export const CANDIDATE_SOURCES = [
  'Direct', 'Referral', 'Job Portal', 'Naukri', 'Indeed', 'Shine', 'LinkedIn', 'TeamLink Website', 'Social Media',
];
export const CANDIDATE_FIRST_SOURCES = ['Direct', 'Referral', 'Job Portal', 'Naukri', 'Indeed', 'LinkedIn'];
export const CANDIDATE_FILTER_SOURCES = [
  'Job Portal', 'Naukri', 'Indeed', 'Shine', 'Referral', 'Direct', 'LinkedIn', 'TeamLink Website', 'Social Media',
];
export const APPLICATION_METHODS = ['Manual', 'Auto-Apply'];

export const CLIENT_INDUSTRIES = [
  'IT', 'Healthcare', 'Manufacturing', 'Education', 'Finance', 'Retail', 'Logistics', 'Other',
];
export const CLIENT_STATUSES = ['Active', 'Inactive', 'Suspended'];
export const CLIENT_TYPES = ['Direct', 'Vendor', 'Partner'];
export const CLIENT_PRIORITIES = ['High', 'Medium', 'Low'];
export const COMM_MODES = ['Email', 'WhatsApp', 'Phone'];
export const COMM_CHANNELS = ['Email', 'WhatsApp', 'SMS'];
export const BUSINESS_TYPES = ['Private Limited', 'Public Limited', 'LLP', 'Partnership', 'Startup', 'Other'];
export const PAYMENT_TERMS = [
  'Invoice 6 days after joining; payment due within 6 days of invoice',
  '15 Days', '30 Days', '45 Days', '60 Days',
];
export const INVOICE_TRIGGERS = ['Candidate Joining', 'Custom'];
export const AGREEMENT_TEMPLATES = ['Standard Recruitment / Staffing', 'Contract Staffing', 'Executive Search'];
export const RISK_FLAGS = ['None', 'Watch', 'High Risk'];
export const INDIAN_STATES = ['Telangana', 'Karnataka', 'Maharashtra', 'Tamil Nadu', 'Delhi'];

// The prototype's POSTING_SOURCES (line 8720) — the checkboxes in section
// "G. Job Posting" of the Create Requirement form.
export const POSTING_SOURCES = [
  'TeamLink Job Portal', 'Naukri', 'Indeed', 'Shine', 'TeamLink Website', 'Social Media',
];

// Badge classes the prototype uses for these two columns. Its own priority
// ternary leaves Urgent looking like Low; Urgent is shown as High here.
export function priorityBadgeClass(priority) {
  if (priority === 'High' || priority === 'Urgent') return 'rejected';
  if (priority === 'Medium') return 'review';
  return 'applied';
}
// agreementBadgeClass() (line 6294).
export function agreementBadgeClass(code) {
  const label = AGREEMENT_STATUS_LABELS[code] || code;
  if (label === 'Active') return 'active';
  if (label === 'Signed') return 'approved';
  if (['Cancelled', 'Expired', 'Rejected'].includes(label)) return 'rejected';
  return 'pending';
}

// The prototype's statusBadge() (line 6164) — the pill colour per pipeline
// stage. Its map has no entry for the AI-interview stages, so those fall
// through to 'new' exactly as they do there.
const STAGE_BADGE_CLASSES = {
  NEW: 'new',
  RECRUITER_REVIEW: 'review',
  RECRUITER_APPROVED: 'approved',
  WITH_BDE: 'review',
  BDE_APPROVED: 'approved',
  SHARED_WITH_CLIENT: 'review',
  CLIENT_REVIEW: 'review',
  CLIENT_SHORTLISTED: 'shortlist',
  INTERVIEW_SCHEDULED: 'interview',
  INTERVIEW_COMPLETED: 'interview',
  SELECTED: 'selected',
  OFFER: 'offer',
  OFFER_ACCEPTED: 'offer',
  JOINED: 'joined',
  HIRED: 'joined',
  REJECTED: 'rejected',
  HOLD: 'hold',
};
export function stageBadgeClass(code) {
  return STAGE_BADGE_CLASSES[code] || 'new';
}
// The Status column: Active / On Hold / Rejected / Closed.
export function lifeStatusClass(status) {
  if (status === 'Active') return 'active';
  if (status === 'On Hold') return 'pending';
  if (status === 'Rejected') return 'rejected';
  return 'review';
}
// ---------------------------------------------------------------------------
// FOLLOW-UPS — the Follow-up column, the candidate detail panel and the
// dashboard rows all read this one vocabulary.
//
// The four statuses are DERIVED on the server from the due date
// (backend/src/utils/followups.js), never stored, so nothing here has to
// recompute them and the two cannot disagree.
// ---------------------------------------------------------------------------
export const FOLLOWUP_STATUSES = ['Upcoming', 'Due Today', 'Overdue', 'Completed'];
export const CONTACT_MODES = ['Call', 'Email', 'WhatsApp', 'SMS', 'In Person', 'Video Call'];

export function followUpStatusClass(status) {
  if (status === 'Overdue') return 'rejected';
  if (status === 'Due Today') return 'pending';
  if (status === 'Completed') return 'active';
  return 'new';
}

// ---------------------------------------------------------------------------
// REJECTION AND HOLD REASONS.
//
// Recorded as a CATEGORY plus a detailed reason, and kept for ever on the
// ApplicationStageEvent alongside who decided, their role and which SIDE they
// were on. A rejected candidate is never deleted — nothing in this app
// deletes a candidate or an application — so these read back in full.
// ---------------------------------------------------------------------------
export const REJECTION_REASON_CATEGORIES = [
  'Skills Mismatch',
  'Insufficient Experience',
  'Salary Expectation',
  'Notice Period',
  'Location / Relocation',
  'Communication',
  'Interview Performance',
  'Candidate Withdrew',
  'Position Filled',
  'Position Closed',
  'Duplicate Profile',
  'Background / Documentation',
  'Other',
];
export const HOLD_REASON_CATEGORIES = [
  'Awaiting Client Feedback',
  'Requirement On Hold',
  'Budget On Hold',
  'Candidate Unavailable',
  'Candidate Reconsidering',
  'Documentation Pending',
  'Better Fit Elsewhere',
  'Other',
];
export const DECISION_SIDES = ['Internal', 'Client'];

// The AI Interview column.
export function aiStatusClass(status) {
  if (status === 'Completed') return 'active';
  if (status === 'Expired') return 'rejected';
  return 'pending';
}
// The prototype renders dates as "20 Sept 2026".
export function protoDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
export function initials(name) {
  if (!name) return '?';
  return name.replace(/\(.*\)/, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}
