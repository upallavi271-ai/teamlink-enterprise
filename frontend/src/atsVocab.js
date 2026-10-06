// ESM mirror of backend/src/utils/atsVocab.js — the ATS vocabulary taken
// WORKFLOW STAGE GROUPS (2026-09-29): WORKFLOW_STAGE_GROUPS / WORKFLOW_FLOW /
// inWorkflowGroup / stageLabelFor at the END of this file mirror the backend
// block (the user's actual workflow: Job Portal screening -> Send to ATS ->
// client / internal hiring chains).
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
  // Mirrors the backend list: the TL approves between recruiter and BDE.
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

export const EXTRA_STAGE_CODES = ['REJECTED', 'HOLD'];
export const ALL_STAGE_CODES = [...STAGE_CODES, ...EXTRA_STAGE_CODES];

export const STAGE_LABELS = {
  // Everyday words (simplicity pass 2026-10-03, spec section 2): "Check by
  // recruiter / team lead" instead of "Recruiter Review / TL Review". Labels
  // only — the stage CODES (keys) are what the API and the DB use.
  NEW: 'New',
  AI_INTERVIEW_REQUIRED: 'AI interview needed',
  AI_INTERVIEW_SCHEDULED: 'AI interview booked',
  AI_INTERVIEW_COMPLETED: 'AI interview done',
  RECRUITER_REVIEW: 'Check by recruiter',
  RECRUITER_APPROVED: 'Approved by recruiter',
  TL_REVIEW: 'Check by team lead',
  WITH_BDE: 'Check by client manager',
  BDE_APPROVED: 'Ready to send to client',
  SHARED_WITH_CLIENT: 'Sent to client',
  CLIENT_REVIEW: 'Client checking',
  CLIENT_SHORTLISTED: 'Client shortlisted',
  INTERVIEW_SCHEDULED: 'Interview booked',
  INTERVIEW_COMPLETED: 'Interview done',
  SELECTED: 'Selected',
  OFFER: 'Offer',
  OFFER_ACCEPTED: 'Offer accepted',
  JOINED: 'Joined',
  HIRED: 'Hired',
  REJECTED: 'Rejected',
  HOLD: 'Hold',
};

export function stageLabel(code) {
  return STAGE_LABELS[code] || code || '—';
}

// §31 ONE TERMINOLOGY for pending work — mirrors backend utils/atsVocab.js
// WORKFLOW_TERMS. Dashboard, candidate page, notifications, reports and
// pending actions all say exactly these words.
export const WORKFLOW_TERMS = {
  RECRUITER_REVIEW: 'Check by recruiter',
  TL_REVIEW: 'Check by team lead',
  BDE_REVIEW: 'Check by client manager',
  CLIENT_REVIEW: 'Client checking',
  INTERVIEW_FEEDBACK: 'Interview feedback',
  JOINING_CONFIRMATION: 'Waiting to join',
};
const PENDING_TERM_OF_STAGE = {
  NEW: WORKFLOW_TERMS.RECRUITER_REVIEW,
  AI_INTERVIEW_COMPLETED: WORKFLOW_TERMS.RECRUITER_REVIEW,
  RECRUITER_REVIEW: WORKFLOW_TERMS.RECRUITER_REVIEW,
  RECRUITER_APPROVED: WORKFLOW_TERMS.RECRUITER_REVIEW,
  TL_REVIEW: WORKFLOW_TERMS.TL_REVIEW,
  WITH_BDE: WORKFLOW_TERMS.BDE_REVIEW,
  BDE_APPROVED: WORKFLOW_TERMS.BDE_REVIEW,
  SHARED_WITH_CLIENT: WORKFLOW_TERMS.CLIENT_REVIEW,
  CLIENT_REVIEW: WORKFLOW_TERMS.CLIENT_REVIEW,
  INTERVIEW_COMPLETED: WORKFLOW_TERMS.INTERVIEW_FEEDBACK,
  SELECTED: WORKFLOW_TERMS.JOINING_CONFIRMATION,
  OFFER: WORKFLOW_TERMS.JOINING_CONFIRMATION,
  OFFER_ACCEPTED: WORKFLOW_TERMS.JOINING_CONFIRMATION,
};
export function pendingTermOfStage(code) {
  return PENDING_TERM_OF_STAGE[code] || null;
}

// ---------------------------------------------------------------------------
// §30 STATUS COLOURS — one fixed vocabulary, the same meaning on every page.
//   Green  active / open / completed / selected         -> .status.active
//   Amber  pending / hold / waiting / agreement pending -> .status.pending
//   Red    overdue / rejected / cancelled               -> .status.rejected
//   Blue   the current workflow stage / informational   -> .status.new
// Every *Class() helper in this file returns one of those four colours; a
// screen that needs a colour for a word with no helper asks toneClass().
// ---------------------------------------------------------------------------
export const STATUS_TONE = { green: 'active', amber: 'pending', red: 'rejected', blue: 'new' };
const GREEN_WORDS = ['active', 'open', 'completed', 'complete', 'selected', 'joined', 'hired', 'approved', 'accepted',
  'offer accepted', 'verified', 'signed', 'paid', 'invoiced', 'feedback submitted'];
const AMBER_WORDS = ['pending', 'hold', 'on hold', 'waiting', 'waiting to join','agreement pending', 'agreement check', 'draft',
  'due today', 'rescheduled', 'pending feedback', 'offer released', 'not scheduled', 'billing pending', 'required',
  'submitted', 'sent', 'viewed', 'client confirmation pending', 'manual review requested'];
const RED_WORDS = ['overdue', 'late', 'rejected', 'cancelled', 'canceled', 'no show', 'expired', 'declined', 'offer declined',
  'dropped', 'failed'];
export function toneClass(word) {
  const w = String(word || '').trim().toLowerCase();
  if (RED_WORDS.includes(w)) return STATUS_TONE.red;
  if (AMBER_WORDS.includes(w)) return STATUS_TONE.amber;
  if (GREEN_WORDS.includes(w)) return STATUS_TONE.green;
  return STATUS_TONE.blue;
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
// §30: Open and the live states green; On Hold / Draft / Agreement Check
// (= agreement pending) amber; Closed is informational blue — closing a
// requirement is not a rejection and must not read red.
export function requirementBadgeClass(code) {
  if (code === 'CLOSED') return 'new';
  if (['ON_HOLD', 'DRAFT', 'AGREEMENT_CHECK'].includes(code)) return 'pending';
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
// ROLES ARE DATA (Role Catalog -> Add Role). A custom role's code
// (CUSTOM_SENIOR_RECRUITER) is labelled by its name once a screen has loaded
// GET /admin/roles; ATS_ROLE_LABELS above is only the system roles' fallback.
const DYNAMIC_ROLE_LABELS = {};
export function registerRoleLabels(list) {
  (list || []).forEach((r) => { if (r && r.code) DYNAMIC_ROLE_LABELS[r.code] = r.name || r.code; });
}
export function atsRoleLabel(code) {
  return ATS_ROLE_LABELS[code] || DYNAMIC_ROLE_LABELS[code] || code || '—';
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
  PENDING_FEEDBACK: 'Waiting for feedback',
  FEEDBACK_SUBMITTED: 'Feedback in',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'No show',
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

// ATS review #2 §16 — AI Interview · Recruiter Interview · TL Interview ·
// Client Interview. The AI interview is its own record (the calendar's AI
// tab); the three slot types are what Schedule Interview offers and what
// Application.interviewType stores. "Internal Panel" is the older value, read
// back as-is (backend/src/utils/atsVocab.js keeps accepting it).
export const INTERVIEW_KINDS = ['AI Interview', 'Recruiter Interview', 'TL Interview', 'Client Interview'];
export const INTERVIEW_TYPES = ['Client Interview', 'Recruiter Interview', 'TL Interview'];

// ATS review #2 §17 — the interview lifecycle, and the exception statuses
// shown apart from it (none of them rejects the candidate).
export const INTERVIEW_LIFECYCLE = [
  ['SHORTLISTED', 'Client Shortlisted'], ['SCHEDULED', 'Scheduled'], ['CONFIRMED', 'Confirmed'],
  ['STARTED', 'Started'], ['COMPLETED', 'Completed'], ['FEEDBACK_PENDING', 'Waiting for feedback'],
  ['SELECTED', 'Selected'], ['REJECTED', 'Rejected'], ['HOLD', 'Hold'],
];
export const INTERVIEW_EXCEPTIONS = [['CANCELLED', 'Cancelled'], ['NO_SHOW', 'No Show'], ['RESCHEDULED', 'Rescheduled']];

// ATS review #2 §5 — THE NEXT ACTION, BY STAGE. Mirrors NEXT_ACTION_BY_STAGE
// in backend/src/utils/atsVocab.js (the server sends it as `nextAction` on
// every list row); this copy is for screens that only hold a stage code.
export const NEXT_ACTION_BY_STAGE = {
  NEW: 'Check candidate',
  AI_INTERVIEW_REQUIRED: 'Send AI interview',
  AI_INTERVIEW_SCHEDULED: 'Wait for AI interview',
  AI_INTERVIEW_COMPLETED: 'Check candidate',
  RECRUITER_REVIEW: 'Send to team lead',
  RECRUITER_APPROVED: 'Send to team lead',
  TL_REVIEW: 'Approve / Reject / Hold',
  // 2026-09-29 workflow: BDE Review → Client Submission → Client Decision.
  WITH_BDE: 'Send to client',
  BDE_APPROVED: 'Send to client',
  SHARED_WITH_CLIENT: 'Ask client for a decision',
  CLIENT_REVIEW: 'Ask client for a decision',
  CLIENT_SHORTLISTED: 'Book client interview',
  INTERVIEW_SCHEDULED: 'Confirm interview',
  INTERVIEW_COMPLETED: 'Add feedback',
  SELECTED: 'Send offer',
  OFFER: 'Follow up offer',
  OFFER_ACCEPTED: 'Confirm joining',
  JOINED: 'Raise invoice / watch guarantee',
  HIRED: 'No Action',
  HOLD: 'Check the hold',
  REJECTED: 'No Action',
};
// Mirrors backend NEXT_ACTION_INTERNAL — the internal chain's own words.
export const NEXT_ACTION_INTERNAL = {
  NEW: 'Check by HR',
  RECRUITER_REVIEW: 'Send to dept head / team lead',
  RECRUITER_APPROVED: 'Send to dept head / team lead',
  TL_REVIEW: 'Approve for interview / Reject',
  SELECTED: 'Send offer',
  JOINED: 'Add as employee',
};
export function nextActionForStage(stage, { internal = false } = {}) {
  if (internal && NEXT_ACTION_INTERNAL[stage]) return NEXT_ACTION_INTERNAL[stage];
  return NEXT_ACTION_BY_STAGE[stage] || '—';
}
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
// §30 — accepted green; released (waiting on the candidate) amber; declined
// red; not issued informational blue.
export function offerStatusClass(value) {
  if (value === 'Offer Accepted') return 'selected';
  if (value === 'Offer Released') return 'pending';
  if (value === 'Offer Declined') return 'rejected';
  return 'new';
}
// §30 — joined green; not scheduled (Joining Confirmation pending) amber;
// dropped red; scheduled (the current step) blue.
export function joiningStatusClass(value) {
  if (value === 'Joined') return 'joined';
  if (value === 'Joining Scheduled') return 'new';
  if (value === 'Dropped') return 'rejected';
  return 'pending';
}

// Reuses the existing badge palette rather than the prototype's inline colours.
// §30 — Completed / Feedback Submitted green; Pending Feedback / Rescheduled
// amber; Cancelled / No Show red; Scheduled / Confirmed / Started (the
// interview is the current step) blue.
export function interviewStatusClass(code) {
  if (['COMPLETED', 'FEEDBACK_SUBMITTED'].includes(code)) return 'active';
  if (['CANCELLED', 'NO_SHOW'].includes(code)) return 'rejected';
  if (['PENDING_FEEDBACK', 'RESCHEDULED'].includes(code)) return 'pending';
  return 'new';
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
  'Direct', 'Referral', 'Campus', 'Job Portal', 'Naukri', 'Indeed', 'Shine', 'LinkedIn', 'TeamLink Website', 'Social Media',
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
// §30: every in-flight stage is "the current workflow stage" and reads blue;
// Selected / Offer Accepted / Joined / Hired green; Hold amber; Rejected red.
// (Unlisted codes, e.g. the AI-interview stages, fall through to blue.)
const STAGE_BADGE_CLASSES = {
  NEW: 'new',
  SELECTED: 'selected',
  OFFER_ACCEPTED: 'selected',
  JOINED: 'joined',
  HIRED: 'joined',
  REJECTED: 'rejected',
  HOLD: 'hold',
};
export function stageBadgeClass(code) {
  return STAGE_BADGE_CLASSES[code] || 'new';
}
// The Status column: Active / On Hold / Rejected / Closed.
// §30 — Closed is Joined / Hired, i.e. completed: green, not amber.
export function lifeStatusClass(status) {
  if (status === 'Active') return 'active';
  if (status === 'On Hold') return 'pending';
  if (status === 'Rejected') return 'rejected';
  return 'active';
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
// WHOSE DECISION A REJECTION WAS — asked on every rejection, never inferred
// from who pressed the button. Stored as Client / Internal / Candidate;
// "Internal" is shown as TeamLink. Mirrors backend utils/atsVocab.js.
export const REJECTED_BY_OPTIONS = [
  { value: 'Client', label: 'Client', hint: 'the client said no' },
  { value: 'Internal', label: 'TeamLink', hint: 'we screened them out' },
  { value: 'Candidate', label: 'Candidate', hint: 'not interested, no-show, declined' },
];
export const REJECTED_BY_LABEL = { Client: 'Client', Internal: 'TeamLink', Candidate: 'Candidate' };

// The reasons that make sense for each side. "Did not attend the interview"
// is never a client's reason; "Skills mismatch" is never the candidate's.
// Offering only the relevant ones is what keeps the category honest.
export const REJECTION_REASONS_BY_SIDE = {
  Client: [
    'Skills Mismatch', 'Insufficient Experience', 'Interview Performance', 'Communication',
    'Salary Expectation', 'Location / Relocation', 'Notice Period', 'Culture Fit',
    'Not Shortlisted', 'Not Selected', 'Position Filled', 'Position Closed', 'Other',
  ],
  Internal: [
    'Profile Not Matching', 'Skills Mismatch', 'Insufficient Experience', 'Communication',
    'Salary Expectation', 'Location / Relocation', 'Notice Period', 'Culture Fit',
    'Not Eligible', 'Failed Screening', 'Low AI Interview Score',
    'Duplicate Profile', 'Background / Documentation', 'Other',
  ],
  Candidate: [
    'Not Interested', 'Did Not Attend Interview', 'Offer Declined', 'Did Not Join',
    'Accepted Another Offer', 'Salary Expectation', 'Notice Period', 'Location / Relocation',
    'Not Reachable', 'Other',
  ],
};

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

// --- THE DEPARTMENT DROPDOWN, SCOPED ---------------------------------------
// DEPTS above is the full catalogue. It is the right list for a Super Admin,
// an Admin or the HR desk, and the WRONG one for everybody else: a Medical TL
// opening Jobs / Requirements was offered IT, Manufacturing, Education, BDE,
// HR and Accounts in the filter. Picking one never widened what the server
// returned — every list is filtered by utils/scope.js — but naming the other
// departments at all is what "vallaki option kuda visible avvakudadhu" rules
// out.
//
// `user.scope.departments` is computed SERVER-SIDE by utils/scope.js
// departmentsOf() and sent with the session, so this can never drift from what
// the API will actually answer. null there means unrestricted.
export function deptOptions(user) {
  const allowed = user && user.scope ? user.scope.departments : null;
  if (!allowed) return DEPTS;
  // The scope list holds REAL department names off the master, which is the
  // authority — DEPTS is only a fallback catalogue and spells one of them
  // differently ('Education' vs 'Educational'), so the scope wins outright
  // rather than being used to filter DEPTS.
  return allowed;
}

// ===========================================================================
// THE ACTUAL WORKFLOW (2026-09-29) — STAGE GROUPS every dashboard counts on.
//
//   REQUIREMENT -> Client requirement -> Job posting -> multiple sources ┐
//               -> Internal requirement -> HR sourcing -> candidates     ┘
//   -> JOB PORTAL (pre-ATS): Candidate Applications -> Duplicate Check
//        -> Resume Parsing/Score -> AI Interview -> AI Interview Score
//        -> Recruiter Review -> SEND TO ATS
//   -> CLIENT HIRING: Recruiter Review -> TL Review -> BDE Review
//        -> Client Submission -> Client Decision -> Interview -> Feedback
//        -> Selected/Rejected -> Offer -> Offer Accepted -> Joining
//        -> Guarantee/Replacement -> Accounts -> Invoice -> Payment -> Reports
//   -> INTERNAL HIRING: HR Review -> Dept Head/TL -> Interview -> Feedback
//        -> Selected/Rejected -> Offer -> Joining -> HRMS (employee record)
//
// NO NEW STAGE CODES. Every box is a group over the stage codes above plus,
// where a stage alone cannot tell, one existing column:
//   side      'pre'  = still in the Job Portal screening (NOT sent to ATS):
//                      Application.source is a screening intake source
//                      (PRE_ATS_SOURCES) AND Application.portalImportedAt is null.
//             'ats'  = everything else (sent, or keyed in / imported straight
//                      into the ATS — every historic row is 'ats').
//             'any'  = both.
//   hiring    'client' | 'internal' | 'any' — utils/joining.js hiringTypeOf():
//             stored Application.hiringType, else the requirement's
//             hiringType / internal flag.
//   rule      an extra condition a stage list cannot express (see
//             WORKFLOW_RULES below). A group without a rule is a plain count
//             of `stages` on that side / hiring type.
//
// "Sent to ATS" is Application.portalImportedAt (+ portalImportedBy), written
// by POST /api/job-portal/applications/:id/send-to-ats (the old "Import to
// ATS"); the same moment is an ApplicationStageEvent whose action starts with
// SENT_TO_ATS_ACTION. "Sent this week" = portalImportedAt >= start of week.
//
// Dashboards: count with utils/workflowFlow.js countWorkflowGroups(user) — it
// applies the user's scope (utils/scope.js applicationWhere) and these rules
// in one place. Use the group ids below, never re-derive a stage list.
// Mirror of backend/src/utils/atsVocab.js (the backend copy also carries the
// Prisma where-fragments). Keep the two in step.
// ===========================================================================
export const PRE_ATS_SOURCES = ['TeamLink Job Portal', 'Job Portal', 'HR Sourcing'];
export const HR_SOURCING_SOURCE = 'HR Sourcing';
export const SENT_TO_ATS_ACTION = 'Sent to ATS';
export const DUPLICATE_CHECK_ACTION = 'Duplicate check';
export const RESUME_SCORE_ACTION = 'Resume scored';
// Guarantee / replacement live on the existing Application.joiningStatus
// string (no schema change). A client placement who leaves INSIDE the
// client's guarantee period is 'Replacement Due'; after it, 'Left after
// Guarantee'. 'Replaced' closes a replacement once a new candidate joins.
export const JOINING_REPLACEMENT_DUE = 'Replacement Due';
export const JOINING_REPLACED = 'Replaced';
export const JOINING_LEFT_AFTER_GUARANTEE = 'Left after Guarantee';

export const PRE_ATS_STAGES = ['NEW', 'AI_INTERVIEW_REQUIRED', 'AI_INTERVIEW_SCHEDULED', 'AI_INTERVIEW_COMPLETED',
  'RECRUITER_REVIEW', 'RECRUITER_APPROVED', 'HOLD'];
const REVIEW_STAGES = ['NEW', 'AI_INTERVIEW_REQUIRED', 'AI_INTERVIEW_SCHEDULED', 'AI_INTERVIEW_COMPLETED',
  'RECRUITER_REVIEW', 'RECRUITER_APPROVED'];

export const WORKFLOW_STAGE_GROUPS = {
  // ---- Job Portal (pre-ATS) ------------------------------------------------
  CANDIDATE_APPLICATIONS: { label: 'Candidate Applications', side: 'pre', hiring: 'any', stages: [...PRE_ATS_STAGES, 'REJECTED'] },
  PRE_ATS: { label: 'In Job Portal screening (not sent to ATS)', side: 'pre', hiring: 'any', stages: PRE_ATS_STAGES },
  DUPLICATE_CHECK_PENDING: { label: 'Duplicate Check', side: 'pre', hiring: 'any', stages: ['NEW'], rule: 'DUPLICATE_CHECK_PENDING' },
  RESUME_SCORE_PENDING: { label: 'Resume Parsing / Score', side: 'pre', hiring: 'any', stages: ['NEW'], rule: 'RESUME_SCORE_PENDING' },
  AI_INTERVIEW_PENDING: { label: 'AI Interview', side: 'pre', hiring: 'any', stages: ['NEW', 'AI_INTERVIEW_REQUIRED', 'AI_INTERVIEW_SCHEDULED'], rule: 'AI_INTERVIEW_PENDING' },
  AI_SCORE_READY: { label: 'AI Interview Score', side: 'pre', hiring: 'any', stages: ['AI_INTERVIEW_COMPLETED'] },
  SCREENING_PENDING: { label: 'Screening pending', side: 'pre', hiring: 'any', stages: ['NEW', 'AI_INTERVIEW_REQUIRED', 'AI_INTERVIEW_SCHEDULED', 'AI_INTERVIEW_COMPLETED'] },
  RECRUITER_REVIEW_PENDING: { label: 'Check by recruiter (ready to send to ATS)',side: 'pre', hiring: 'any', stages: ['RECRUITER_REVIEW', 'RECRUITER_APPROVED'] },
  PRE_ATS_REJECTED: { label: 'Screened out in the Job Portal', side: 'pre', hiring: 'any', stages: ['REJECTED'] },
  SENT_TO_ATS: { label: 'Sent to ATS', side: 'ats', hiring: 'any', stages: null, rule: 'SENT_TO_ATS', timestampField: 'portalImportedAt' },

  // ---- Client hiring (ATS) -------------------------------------------------
  RECRUITER_REVIEW: { label: 'Check by recruiter', side: 'ats', hiring: 'client', stages: REVIEW_STAGES },
  TL_REVIEW: { label: 'Check by team lead', side: 'ats', hiring: 'client', stages: ['TL_REVIEW'] },
  TL_RETURNED: { label: 'Sent back by team lead (changes needed)', side: 'ats', hiring: 'any', stages: ['RECRUITER_REVIEW', 'RECRUITER_APPROVED'], rule: 'TL_RETURNED' },
  BDE_READY_TO_SUBMIT: { label: 'Check by client manager', side: 'ats', hiring: 'client', stages: ['WITH_BDE', 'BDE_APPROVED'] },
  CLIENT_SUBMISSION: { label: 'Sent to client',side: 'ats', hiring: 'client', stages: ['SHARED_WITH_CLIENT'] },
  CLIENT_DECISION_PENDING: { label: 'Client Decision pending', side: 'ats', hiring: 'client', stages: ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW'] },
  CLIENT_DECISION: { label: 'Client Decision', side: 'ats', hiring: 'client', stages: ['CLIENT_REVIEW', 'CLIENT_SHORTLISTED'] },
  INTERVIEW: { label: 'Interview', side: 'ats', hiring: 'client', stages: ['INTERVIEW_SCHEDULED'] },
  FEEDBACK_PENDING: { label: 'Feedback', side: 'ats', hiring: 'client', stages: ['INTERVIEW_COMPLETED'] },
  SELECTED: { label: 'Selected', side: 'ats', hiring: 'client', stages: ['SELECTED'] },
  REJECTED: { label: 'Rejected', side: 'ats', hiring: 'client', stages: ['REJECTED'] },
  HOLD: { label: 'Hold', side: 'ats', hiring: 'any', stages: ['HOLD'] },
  OFFER: { label: 'Offer', side: 'ats', hiring: 'client', stages: ['OFFER'] },
  OFFER_ACCEPTED: { label: 'Offer Accepted', side: 'ats', hiring: 'client', stages: ['OFFER_ACCEPTED'] },
  JOINED: { label: 'Joining', side: 'ats', hiring: 'client', stages: ['JOINED', 'HIRED'] },
  GUARANTEE_RUNNING: { label: 'Guarantee running', side: 'ats', hiring: 'client', stages: ['JOINED', 'HIRED'], rule: 'GUARANTEE_RUNNING' },
  GUARANTEE_COMPLETED: { label: 'Guarantee completed', side: 'ats', hiring: 'client', stages: ['JOINED', 'HIRED'], rule: 'GUARANTEE_COMPLETED' },
  REPLACEMENT: { label: 'Replacement due', side: 'ats', hiring: 'client', stages: ['JOINED', 'HIRED'], rule: 'REPLACEMENT' },
  ACCOUNTS_PENDING: { label: 'Accounts (invoice to raise)', side: 'ats', hiring: 'client', stages: ['JOINED', 'HIRED'], rule: 'ACCOUNTS_PENDING' },
  // Invoice / Payment are counted on the Invoice table (entity 'invoice'):
  // invoices raised from a joining (candidateId + requirementId set).
  INVOICE_RAISED: { label: 'Invoice', entity: 'invoice', invoiceStatuses: ['Pending', 'Partially Paid', 'Overdue'] },
  PAYMENT_RECEIVED: { label: 'Payment', entity: 'invoice', invoiceStatuses: ['Paid'] },

  // ---- Internal hiring (ATS) -----------------------------------------------
  INTERNAL_HR_REVIEW: { label: 'HR Review', side: 'ats', hiring: 'internal', stages: REVIEW_STAGES },
  INTERNAL_DEPT_HEAD_REVIEW: { label: 'Dept Head / TL', side: 'ats', hiring: 'internal', stages: ['TL_REVIEW'] },
  INTERNAL_INTERVIEW: { label: 'Interview', side: 'ats', hiring: 'internal', stages: ['INTERVIEW_SCHEDULED'] },
  INTERNAL_FEEDBACK_PENDING: { label: 'Feedback', side: 'ats', hiring: 'internal', stages: ['INTERVIEW_COMPLETED'] },
  INTERNAL_SELECTED: { label: 'Selected', side: 'ats', hiring: 'internal', stages: ['SELECTED'] },
  INTERNAL_REJECTED: { label: 'Rejected', side: 'ats', hiring: 'internal', stages: ['REJECTED'] },
  INTERNAL_OFFER: { label: 'Offer', side: 'ats', hiring: 'internal', stages: ['OFFER', 'OFFER_ACCEPTED'] },
  INTERNAL_JOINED: { label: 'Joining', side: 'ats', hiring: 'internal', stages: ['JOINED'] },
  INTERNAL_HRMS: { label: 'HRMS (employee record)', side: 'ats', hiring: 'internal', stages: ['HIRED'] },
};

// The rules, as plain predicates over one application and a context the
// counter supplies ({ internal, duplicateChecked, resumeScored,
// lastFromStage, guaranteeDays, today, hasInvoice }).
export function guaranteeEndOf(application, guaranteeDays) {
  if (!guaranteeDays) return null;
  const from = application.joiningDate || application.joinedAt;
  const d = from ? new Date(from) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + guaranteeDays * 86400000);
}
const LEFT_STATUSES = [JOINING_REPLACEMENT_DUE, JOINING_REPLACED, JOINING_LEFT_AFTER_GUARANTEE, 'Dropped'];
export const WORKFLOW_RULES = {
  DUPLICATE_CHECK_PENDING: (a, ctx) => !ctx.duplicateChecked,
  RESUME_SCORE_PENDING: (a, ctx) => !!ctx.duplicateChecked && !ctx.resumeScored,
  AI_INTERVIEW_PENDING: (a, ctx) => a.stage !== 'NEW' || (!!ctx.duplicateChecked && !!ctx.resumeScored),
  SENT_TO_ATS: (a) => !!a.portalImportedAt,
  TL_RETURNED: (a, ctx) => ctx.lastFromStage === 'TL_REVIEW',
  GUARANTEE_RUNNING: (a, ctx) => {
    if (LEFT_STATUSES.includes(a.joiningStatus)) return false;
    const end = guaranteeEndOf(a, ctx.guaranteeDays);
    return !!end && end >= (ctx.today || new Date());
  },
  GUARANTEE_COMPLETED: (a, ctx) => {
    if (LEFT_STATUSES.includes(a.joiningStatus)) return false;
    const end = guaranteeEndOf(a, ctx.guaranteeDays);
    return !end || end < (ctx.today || new Date());
  },
  REPLACEMENT: (a) => a.joiningStatus === JOINING_REPLACEMENT_DUE,
  // Only joinings the ATS handed to Accounts (billingStatus 'Billing Pending',
  // written on JOINED since the hand-off existed). Historic imported joinings
  // carry no billing status and are not counted as owed invoices.
  ACCOUNTS_PENDING: (a, ctx) => !ctx.hasInvoice && a.billingStatus === 'Billing Pending',
};

// Is this application still in the Job Portal screening (not sent to ATS)?
export function isPreAtsApplication(a) {
  return !!a && !a.portalImportedAt && PRE_ATS_SOURCES.includes(String(a.source || ''));
}

// Does application `a` belong to group `id`? ctx as above.
export function inWorkflowGroup(id, a, ctx = {}) {
  const g = WORKFLOW_STAGE_GROUPS[id];
  if (!g || g.entity || !a) return false;
  const pre = isPreAtsApplication(a);
  if (g.side === 'pre' && !pre) return false;
  if (g.side === 'ats' && pre) return false;
  if (g.hiring === 'internal' && !ctx.internal) return false;
  if (g.hiring === 'client' && ctx.internal) return false;
  if (g.stages && !g.stages.includes(a.stage)) return false;
  if (g.rule && !WORKFLOW_RULES[g.rule](a, ctx)) return false;
  return true;
}

// The flow diagram — boxes in order, each naming the group it counts.
export const WORKFLOW_FLOW = {
  requirement: [
    { id: 'client_requirement', label: 'Client job', count: 'requirements.client' },
    { id: 'job_posting', label: 'Job Posting', count: 'requirements.published' },
    { id: 'multiple_sources', label: 'Multiple Sources', count: 'sources' },
    { id: 'internal_requirement', label: 'Internal job', count: 'requirements.internal' },
    { id: 'hr_sourcing', label: 'HR Sourcing', count: 'hrSourced' },
  ],
  pre: [
    { id: 'applications', label: 'Candidate Applications', group: 'CANDIDATE_APPLICATIONS' },
    { id: 'duplicate_check', label: 'Duplicate Check', group: 'DUPLICATE_CHECK_PENDING' },
    { id: 'resume_score', label: 'Resume Parsing / Score', group: 'RESUME_SCORE_PENDING' },
    { id: 'ai_interview', label: 'AI Interview', group: 'AI_INTERVIEW_PENDING' },
    { id: 'ai_score', label: 'AI Interview Score', group: 'AI_SCORE_READY' },
    { id: 'recruiter_review_pre', label: 'Check by recruiter', group: 'RECRUITER_REVIEW_PENDING' },
    { id: 'send_to_ats', label: 'Send to ATS', group: 'SENT_TO_ATS' },
  ],
  client: [
    { id: 'recruiter_review', label: 'Check by recruiter', group: 'RECRUITER_REVIEW' },
    { id: 'tl_review', label: 'Check by team lead', group: 'TL_REVIEW' },
    { id: 'bde_review', label: 'Check by client manager', group: 'BDE_READY_TO_SUBMIT' },
    { id: 'client_submission', label: 'Sent to client', group: 'CLIENT_SUBMISSION' },
    { id: 'client_decision', label: 'Client Decision', group: 'CLIENT_DECISION' },
    { id: 'interview', label: 'Interview', group: 'INTERVIEW' },
    { id: 'feedback', label: 'Feedback', group: 'FEEDBACK_PENDING' },
    { id: 'selected', label: 'Selected', group: 'SELECTED', also: { id: 'rejected', label: 'Rejected', group: 'REJECTED' } },
    { id: 'offer', label: 'Offer', group: 'OFFER' },
    { id: 'offer_accepted', label: 'Offer Accepted', group: 'OFFER_ACCEPTED' },
    { id: 'joining', label: 'Joining', group: 'JOINED' },
    { id: 'guarantee', label: 'Guarantee / Replacement', group: 'GUARANTEE_RUNNING', also: { id: 'replacement', label: 'Replacement due', group: 'REPLACEMENT' } },
    { id: 'accounts', label: 'Accounts', group: 'ACCOUNTS_PENDING' },
    { id: 'invoice', label: 'Invoice', group: 'INVOICE_RAISED' },
    { id: 'payment', label: 'Payment', group: 'PAYMENT_RECEIVED' },
    { id: 'reports', label: 'Reports', link: '/reports/ats' },
  ],
  internal: [
    { id: 'hr_review', label: 'HR Review', group: 'INTERNAL_HR_REVIEW' },
    { id: 'dept_head', label: 'Dept Head / TL', group: 'INTERNAL_DEPT_HEAD_REVIEW' },
    { id: 'int_interview', label: 'Interview', group: 'INTERNAL_INTERVIEW' },
    { id: 'int_feedback', label: 'Feedback', group: 'INTERNAL_FEEDBACK_PENDING' },
    { id: 'int_selected', label: 'Selected', group: 'INTERNAL_SELECTED', also: { id: 'int_rejected', label: 'Rejected', group: 'INTERNAL_REJECTED' } },
    { id: 'int_offer', label: 'Offer', group: 'INTERNAL_OFFER' },
    { id: 'int_joining', label: 'Joining', group: 'INTERNAL_JOINED' },
    { id: 'hrms', label: 'HRMS (employee record)', group: 'INTERNAL_HRMS' },
  ],
};

// Stage names on an INTERNAL hire read the internal chain's words: the
// recruiter's review is HR's, the TL's approval is the Dept Head / TL's.
export const INTERNAL_STAGE_LABELS = {
  RECRUITER_REVIEW: 'Check by HR',
  RECRUITER_APPROVED: 'Check by HR',
  TL_REVIEW: 'Check by dept head / team lead',
  HIRED: 'Employee record made',
};
export function stageLabelFor(code, { internal = false } = {}) {
  if (internal && INTERNAL_STAGE_LABELS[code]) return INTERNAL_STAGE_LABELS[code];
  return stageLabel(code);
}
