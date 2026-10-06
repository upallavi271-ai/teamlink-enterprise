// The ATS vocabulary, taken verbatim from the reference prototype.
//
// WORKFLOW STAGE GROUPS (2026-09-29): the user's actual workflow — Job Portal
// screening (pre-ATS) -> Send to ATS -> client / internal hiring chains — is
// defined as named groups over the stage codes in WORKFLOW_STAGE_GROUPS (near
// the end of this file, documented there): PRE_ATS, SCREENING_PENDING,
// DUPLICATE_CHECK_PENDING, RESUME_SCORE_PENDING, AI_INTERVIEW_PENDING,
// AI_SCORE_READY, RECRUITER_REVIEW_PENDING, SENT_TO_ATS (timestamp
// Application.portalImportedAt), RECRUITER_REVIEW, TL_REVIEW, TL_RETURNED,
// BDE_READY_TO_SUBMIT, CLIENT_SUBMISSION, CLIENT_DECISION_PENDING,
// CLIENT_DECISION, INTERVIEW, FEEDBACK_PENDING, SELECTED, REJECTED, HOLD, OFFER,
// OFFER_ACCEPTED, JOINED, GUARANTEE_RUNNING, GUARANTEE_COMPLETED, REPLACEMENT,
// ACCOUNTS_PENDING, INVOICE_RAISED, PAYMENT_RECEIVED and the INTERNAL_* chain.
// Count them with utils/workflowFlow.js — never re-derive a stage list.
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
  // Everyday words (simplicity pass 2026-10-03) — LABELS ONLY; the codes
  // (keys) are what the DB, imports and facets use. Mirrors frontend/src/atsVocab.js.
  NEW: 'New',
  AI_INTERVIEW_REQUIRED: 'AI interview needed',
  AI_INTERVIEW_SCHEDULED: 'AI interview booked',
  AI_INTERVIEW_COMPLETED: 'AI interview done',
  RECRUITER_REVIEW: 'Check by recruiter',
  RECRUITER_APPROVED: 'Approved by recruiter',
  TL_REVIEW: 'Check by team lead',
  // §31 one terminology: the stage a BDE acts on reads "BDE Review" on every
  // screen (the code stays WITH_BDE in the database).
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

function stageLabel(code) {
  return STAGE_LABELS[code] || code;
}

// ---------------------------------------------------------------------------
// §31 ONE TERMINOLOGY for the work a stage is waiting on. Dashboard queues,
// pending actions, notifications and reports name the pending work with
// exactly these six words — never "Candidate Review", "Client Decision",
// "Feedback pending" or "With BDE".
// ---------------------------------------------------------------------------
const WORKFLOW_TERMS = {
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
function pendingTermOfStage(code) {
  return PENDING_TERM_OF_STAGE[code] || null;
}

// ---------------------------------------------------------------------------
// §12 THE CHAIN IS ENFORCED, not just drawn.
//
//   Client:   Recruiter Review → TL Review → BDE Review → Client Submission /
//             Decision → Interview → Feedback → Selected → Offer → Offer
//             Accepted → Joining
//   Internal: HR Review → Dept Head / TL → Interview → Feedback → Selected
//             → Offer → Joining → HRMS
//
// STAGE_OWNERS (utils/permissions.js) says WHO may move a candidate into a
// stage; this says FROM WHERE. Without it a recruiter — who owns Interview,
// Offer and Joined — could move a brand-new candidate straight to Joined and
// raise a client invoice with nobody above them having looked. A forward move
// may advance at most ONE phase; moving back, Hold and Reject are always
// allowed. Both kinds of hire go through Offer (2026-09-29 workflow); an
// internal hire skips the BDE and client phases.
// Super Admin / Admin are exempt (data correction) — the route decides that.
// ---------------------------------------------------------------------------
const STAGE_PHASE = {
  NEW: 0,
  AI_INTERVIEW_REQUIRED: 0,
  AI_INTERVIEW_SCHEDULED: 0,
  AI_INTERVIEW_COMPLETED: 0,
  RECRUITER_REVIEW: 0,
  RECRUITER_APPROVED: 0,
  TL_REVIEW: 1,
  WITH_BDE: 2,
  BDE_APPROVED: 2,
  SHARED_WITH_CLIENT: 3,
  CLIENT_REVIEW: 3,
  CLIENT_SHORTLISTED: 3,
  INTERVIEW_SCHEDULED: 4,
  INTERVIEW_COMPLETED: 4,
  SELECTED: 5,
  OFFER: 6,
  OFFER_ACCEPTED: 6,
  JOINED: 7,
  HIRED: 7,
};
const PHASE_ENTRY = ['NEW', 'TL_REVIEW', 'WITH_BDE', 'SHARED_WITH_CLIENT', 'INTERVIEW_SCHEDULED', 'SELECTED', 'OFFER', 'JOINED'];
// The stages a phase may be ENTERED at, indexed by phase.
const PHASE_ENTRIES = [
  null,
  ['TL_REVIEW'],
  ['WITH_BDE'],
  ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW'],
  ['INTERVIEW_SCHEDULED'],
  ['SELECTED'],
  ['OFFER'],
  ['JOINED'],
];

// null when the move is fine, otherwise the sentence to show. `resumeFrom` is
// the stage a HOLD / REJECTED candidate was at before it (from the stage
// history) — a re-open may go back there, or one phase on from it.
function stageMoveProblem(fromStage, toStage, { internal = false, resumeFrom = null } = {}) {
  if (!toStage || fromStage === toStage) return null;
  if (EXTRA_STAGE_CODES.includes(toStage)) return null; // Hold / Reject: always
  let base = fromStage;
  if (EXTRA_STAGE_CODES.includes(fromStage)) {
    // No history (an imported / legacy Hold or Rejected row): we don't know
    // where it stood, so treat it as at "Check by recruiter" (phase 0) and the
    // normal one-phase-at-a-time rule applies (e2e gap 1, 2026-10-03). Before,
    // such a row could jump straight to Joined and raise an invoice.
    base = (resumeFrom && STAGE_PHASE[resumeFrom] != null) ? resumeFrom : 'RECRUITER_REVIEW';
  }
  const from = STAGE_PHASE[base];
  const to = STAGE_PHASE[toStage];
  if (from == null || to == null) return null;
  if (to <= from) return null;
  // INTERNAL HIRING has no BDE or client phases (the actual workflow, 2026-09-29):
  // HR Review → Dept Head / TL → Interview. The Dept Head / TL's approval
  // (phase 1) leads straight to Interview (phase 4).
  if (internal && from === STAGE_PHASE.TL_REVIEW && toStage === 'INTERVIEW_SCHEDULED') return null;
  // Entering the NEXT phase lands on its first step: BDE Review before BDE
  // Approved, Shared with Client / Client Review before Client Shortlisted.
  if (to === from + 1) {
    if ((PHASE_ENTRIES[to] || [toStage]).includes(toStage)) return null;
    return `${stageLabel(toStage)} can't be reached from ${stageLabel(fromStage)} — `
      + `the candidate has to go through ${stageLabel(PHASE_ENTRIES[to][0])} first.`;
  }
  // The actual workflow runs a CLIENT placement through Offer → Offer
  // Accepted → Joining too (the client's offer, recorded by the recruiter), so
  // the old Selected → Joined shortcut for client placements is gone.
  const missing = PHASE_ENTRY[from + 1];
  return `${stageLabel(toStage)} can't be reached from ${stageLabel(fromStage)} — `
    + `the candidate has to go through ${stageLabel(missing)} first.`;
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
  WITH_BDE: { ownerRole: 'BDE', action: 'Review and share with the client', days: 2 },
  BDE_APPROVED: { ownerRole: 'BDE', action: 'Share with client', days: 1 },
  SHARED_WITH_CLIENT: { ownerRole: 'Client', action: 'Await client review', days: 3 },
  CLIENT_REVIEW: { ownerRole: 'Client', action: 'Shortlist or reject', days: 3 },
  CLIENT_SHORTLISTED: { ownerRole: 'BDE', action: 'Schedule interview', days: 2 },
  INTERVIEW_SCHEDULED: { ownerRole: 'Client', action: 'Conduct interview', days: 2 },
  INTERVIEW_COMPLETED: { ownerRole: 'Client', action: 'Record interview feedback and the decision', days: 2 },
  // 2026-09-29 workflow: Selected → Offer → Offer Accepted → Joining for BOTH
  // kinds of hire (a client placement records the client's offer).
  SELECTED: { ownerRole: 'Recruiter', action: "Record the offer (the client's offer, or TeamLink's for an internal hire)", days: 3 },
  OFFER: { ownerRole: 'Recruiter', action: 'Await offer acceptance', days: 3 },
  OFFER_ACCEPTED: { ownerRole: 'Recruiter', action: 'Confirm the joining', days: 2 },
  // Joining hands a client placement to Accounts (invoice) and starts the
  // guarantee period; an internal hire goes on to HRMS.
  JOINED: { ownerRole: 'Accountant', action: 'Raise the invoice; track the guarantee period', days: 6 },
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

// ---------------------------------------------------------------------------
// ATS review #2 §5 — THE NEXT ACTION, BY STAGE. The ONE source for the short
// action every screen shows (dashboard queue, bell, Candidates "Next Action",
// Team, AI panel). The user's table, verbatim:
//   New → Review Candidate · Recruiter Review → Send to TL · TL Review →
//   Approve / Reject · BDE Review → Client Decision · Client Review → Follow
//   Up · Interview Scheduled → Confirm Interview · Feedback Pending → Record
//   Feedback · Selected → Start Joining Process · Offer → Follow Up Offer ·
//   Offer Accepted → Confirm Joining · Hold → Review Hold · Rejected → No Action
// The stages the table does not name follow the same pattern. Mirrored in
// frontend/src/atsVocab.js — keep the two in step. STAGE_OWNER_ACTION.action
// above stays the long "what to do" sentence (follow-up defaults).
// ---------------------------------------------------------------------------
const NEXT_ACTION_BY_STAGE = {
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
// The internal chain's own words where they differ (HR Review → Dept Head /
// TL → Interview → … → Offer → Joining → HRMS).
const NEXT_ACTION_INTERNAL = {
  NEW: 'Check by HR',
  RECRUITER_REVIEW: 'Send to dept head / team lead',
  RECRUITER_APPROVED: 'Send to dept head / team lead',
  TL_REVIEW: 'Approve for interview / Reject',
  SELECTED: 'Send offer',
  JOINED: 'Add as employee',
};
function nextActionForStage(stage, { internal = false } = {}) {
  if (internal && NEXT_ACTION_INTERNAL[stage]) return NEXT_ACTION_INTERNAL[stage];
  return NEXT_ACTION_BY_STAGE[stage] || '—';
}

function applicationNextAction(application) {
  return nextActionForStage(application && application.stage);
}

// THE DUE DATE (2026-09-29): utils/nextAction.js registers the one rule here
// (open follow-up due date, else stage SLA from the REAL stage-entry time,
// else none) so every SLA counter reads it. The legacy body below (SLA days
// from updatedAt) only runs before that module is loaded.
let DUE_RESOLVER = null;
let TODAY_FN = null;
let OVERDUE_FN = null; // utils/nextAction.js: a Stale row (past due, idle 30+ days) is not Overdue
function setDueDateResolver(fn, todayFn, overdueFn) { DUE_RESOLVER = fn || null; TODAY_FN = todayFn || null; OVERDUE_FN = overdueFn || null; }
// The prototype's appDueDate(): SLA days added to the last stage movement.
function applicationDueDate(application) {
  if (DUE_RESOLVER) return DUE_RESOLVER(application);
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
  if (OVERDUE_FN) return !!OVERDUE_FN(application);
  if (TODAY_FN) return due < TODAY_FN();
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
  PENDING_FEEDBACK: 'Waiting for feedback',
  FEEDBACK_SUBMITTED: 'Feedback in',
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

// ATS review #2 §16 — four interview types: AI Interview · Recruiter
// Interview · TL Interview · Client Interview. The AI interview is its own
// record (aiInterview* fields, the calendar's AI tab), so the SLOT types that
// can be stored in Application.interviewType are the other three. "Internal
// Panel" is the older value, still accepted and read back as-is when the
// panel (recruiter or TL) cannot be told from the record.
const INTERVIEW_KINDS = ['AI Interview', 'Recruiter Interview', 'TL Interview', 'Client Interview'];
const INTERVIEW_SLOT_TYPES = ['Client Interview', 'Recruiter Interview', 'TL Interview'];
const INTERVIEW_TYPES = [...INTERVIEW_SLOT_TYPES, 'Internal Panel'];
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

// ---------------------------------------------------------------------------
// WHOSE DECISION A REJECTION WAS.
//
// Three sides, and they mean three different things for what happens next:
//   Client     the client said no      -> the profile may suit another client
//   Internal   TeamLink screened it out (shown as "TeamLink")
//   Candidate  the candidate said no   -> not interested, no-show, declined
//
// This is ASKED, never inferred from who pressed the button. It used to be
// derived from the actor's role, which recorded every rejection a BDE typed
// in on a client's behalf as "Internal" — and a candidate declining had no
// side at all. The one exception is a client login rejecting on its own
// portal: that is the client's decision by definition.
// ---------------------------------------------------------------------------
const REJECTED_BY = ['Client', 'Internal', 'Candidate'];
const REJECTED_BY_LABEL = { Client: 'Client', Internal: 'TeamLink', Candidate: 'Candidate' };

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
// Mirrored (without the Prisma fragments) in frontend/src/atsVocab.js.
// ===========================================================================
const PRE_ATS_SOURCES = ['TeamLink Job Portal', 'Job Portal', 'HR Sourcing'];
const HR_SOURCING_SOURCE = 'HR Sourcing';
const SENT_TO_ATS_ACTION = 'Sent to ATS';
const DUPLICATE_CHECK_ACTION = 'Duplicate check';
const RESUME_SCORE_ACTION = 'Resume scored';
// Guarantee / replacement live on the existing Application.joiningStatus
// string (no schema change). A client placement who leaves INSIDE the
// client's guarantee period is 'Replacement Due'; after it, 'Left after
// Guarantee'. 'Replaced' closes a replacement once a new candidate joins.
const JOINING_REPLACEMENT_DUE = 'Replacement Due';
const JOINING_REPLACED = 'Replaced';
const JOINING_LEFT_AFTER_GUARANTEE = 'Left after Guarantee';

const PRE_ATS_STAGES = ['NEW', 'AI_INTERVIEW_REQUIRED', 'AI_INTERVIEW_SCHEDULED', 'AI_INTERVIEW_COMPLETED',
  'RECRUITER_REVIEW', 'RECRUITER_APPROVED', 'HOLD'];
const REVIEW_STAGES = ['NEW', 'AI_INTERVIEW_REQUIRED', 'AI_INTERVIEW_SCHEDULED', 'AI_INTERVIEW_COMPLETED',
  'RECRUITER_REVIEW', 'RECRUITER_APPROVED'];

const WORKFLOW_STAGE_GROUPS = {
  // ---- Job Portal (pre-ATS) ------------------------------------------------
  CANDIDATE_APPLICATIONS: { label: 'Candidate Applications', side: 'pre', hiring: 'any', stages: [...PRE_ATS_STAGES, 'REJECTED'] },
  PRE_ATS: { label: 'In Job Portal screening (not sent to ATS)', side: 'pre', hiring: 'any', stages: PRE_ATS_STAGES },
  DUPLICATE_CHECK_PENDING: { label: 'Duplicate Check', side: 'pre', hiring: 'any', stages: ['NEW'], rule: 'DUPLICATE_CHECK_PENDING' },
  RESUME_SCORE_PENDING: { label: 'Resume Parsing / Score', side: 'pre', hiring: 'any', stages: ['NEW'], rule: 'RESUME_SCORE_PENDING' },
  AI_INTERVIEW_PENDING: { label: 'AI Interview', side: 'pre', hiring: 'any', stages: ['NEW', 'AI_INTERVIEW_REQUIRED', 'AI_INTERVIEW_SCHEDULED'], rule: 'AI_INTERVIEW_PENDING' },
  AI_SCORE_READY: { label: 'AI Interview Score', side: 'pre', hiring: 'any', stages: ['AI_INTERVIEW_COMPLETED'] },
  SCREENING_PENDING: { label: 'Screening pending', side: 'pre', hiring: 'any', stages: ['NEW', 'AI_INTERVIEW_REQUIRED', 'AI_INTERVIEW_SCHEDULED', 'AI_INTERVIEW_COMPLETED'] },
  RECRUITER_REVIEW_PENDING: { label: 'Recruiter Review (ready to send to ATS)', side: 'pre', hiring: 'any', stages: ['RECRUITER_REVIEW', 'RECRUITER_APPROVED'] },
  PRE_ATS_REJECTED: { label: 'Screened out in the Job Portal', side: 'pre', hiring: 'any', stages: ['REJECTED'] },
  SENT_TO_ATS: { label: 'Sent to ATS', side: 'ats', hiring: 'any', stages: null, rule: 'SENT_TO_ATS', timestampField: 'portalImportedAt' },

  // ---- Client hiring (ATS) -------------------------------------------------
  RECRUITER_REVIEW: { label: 'Recruiter Review', side: 'ats', hiring: 'client', stages: REVIEW_STAGES },
  TL_REVIEW: { label: 'TL Review', side: 'ats', hiring: 'client', stages: ['TL_REVIEW'] },
  TL_RETURNED: { label: 'Returned by TL (changes needed)', side: 'ats', hiring: 'any', stages: ['RECRUITER_REVIEW', 'RECRUITER_APPROVED'], rule: 'TL_RETURNED' },
  BDE_READY_TO_SUBMIT: { label: 'BDE Review', side: 'ats', hiring: 'client', stages: ['WITH_BDE', 'BDE_APPROVED'] },
  CLIENT_SUBMISSION: { label: 'Client Submission', side: 'ats', hiring: 'client', stages: ['SHARED_WITH_CLIENT'] },
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
function guaranteeEndOf(application, guaranteeDays) {
  if (!guaranteeDays) return null;
  const from = application.joiningDate || application.joinedAt;
  const d = from ? new Date(from) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + guaranteeDays * 86400000);
}
const LEFT_STATUSES = [JOINING_REPLACEMENT_DUE, JOINING_REPLACED, JOINING_LEFT_AFTER_GUARANTEE, 'Dropped'];
const WORKFLOW_RULES = {
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
function isPreAtsApplication(a) {
  return !!a && !a.portalImportedAt && PRE_ATS_SOURCES.includes(String(a.source || ''));
}
// Prisma fragments for the same test (backend only).
const PRE_ATS_WHERE = { portalImportedAt: null, source: { in: PRE_ATS_SOURCES } };
const IN_ATS_WHERE = { OR: [{ portalImportedAt: { not: null } }, { source: null }, { source: { notIn: PRE_ATS_SOURCES } }] };
const INTERNAL_APP_WHERE = {
  OR: [
    { hiringType: 'TeamLink Internal Hire' },
    { AND: [{ hiringType: null }, { requirement: { is: { OR: [{ internal: true }, { hiringType: 'TeamLink Internal Hire' }] } } }] },
  ],
};
const CLIENT_APP_WHERE = { NOT: INTERNAL_APP_WHERE };

// Does application `a` belong to group `id`? ctx as above.
function inWorkflowGroup(id, a, ctx = {}) {
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
const WORKFLOW_FLOW = {
  requirement: [
    { id: 'client_requirement', label: 'Client Requirement', count: 'requirements.client' },
    { id: 'job_posting', label: 'Job Posting', count: 'requirements.published' },
    { id: 'multiple_sources', label: 'Multiple Sources', count: 'sources' },
    { id: 'internal_requirement', label: 'Internal Requirement', count: 'requirements.internal' },
    { id: 'hr_sourcing', label: 'HR Sourcing', count: 'hrSourced' },
  ],
  pre: [
    { id: 'applications', label: 'Candidate Applications', group: 'CANDIDATE_APPLICATIONS' },
    { id: 'duplicate_check', label: 'Duplicate Check', group: 'DUPLICATE_CHECK_PENDING' },
    { id: 'resume_score', label: 'Resume Parsing / Score', group: 'RESUME_SCORE_PENDING' },
    { id: 'ai_interview', label: 'AI Interview', group: 'AI_INTERVIEW_PENDING' },
    { id: 'ai_score', label: 'AI Interview Score', group: 'AI_SCORE_READY' },
    { id: 'recruiter_review_pre', label: 'Recruiter Review', group: 'RECRUITER_REVIEW_PENDING' },
    { id: 'send_to_ats', label: 'Send to ATS', group: 'SENT_TO_ATS' },
  ],
  client: [
    { id: 'recruiter_review', label: 'Recruiter Review', group: 'RECRUITER_REVIEW' },
    { id: 'tl_review', label: 'TL Review', group: 'TL_REVIEW' },
    { id: 'bde_review', label: 'BDE Review', group: 'BDE_READY_TO_SUBMIT' },
    { id: 'client_submission', label: 'Client Submission', group: 'CLIENT_SUBMISSION' },
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
const INTERNAL_STAGE_LABELS = {
  RECRUITER_REVIEW: 'Check by HR',
  RECRUITER_APPROVED: 'Check by HR',
  TL_REVIEW: 'Check by dept head / team lead',
  HIRED: 'Employee record made',
};
function stageLabelFor(code, { internal = false } = {}) {
  if (internal && INTERNAL_STAGE_LABELS[code]) return INTERNAL_STAGE_LABELS[code];
  return stageLabel(code);
}

module.exports = {
  // THE ACTUAL WORKFLOW stage groups (see the block above module.exports).
  PRE_ATS_SOURCES,
  HR_SOURCING_SOURCE,
  SENT_TO_ATS_ACTION,
  DUPLICATE_CHECK_ACTION,
  RESUME_SCORE_ACTION,
  JOINING_REPLACEMENT_DUE,
  JOINING_REPLACED,
  JOINING_LEFT_AFTER_GUARANTEE,
  WORKFLOW_STAGE_GROUPS,
  WORKFLOW_RULES,
  WORKFLOW_FLOW,
  inWorkflowGroup,
  isPreAtsApplication,
  guaranteeEndOf,
  PRE_ATS_WHERE,
  IN_ATS_WHERE,
  INTERNAL_APP_WHERE,
  CLIENT_APP_WHERE,
  INTERNAL_STAGE_LABELS,
  stageLabelFor,
  REJECTED_BY,
  REJECTED_BY_LABEL,
  STAGE_CODES,
  EXTRA_STAGE_CODES,
  ALL_STAGE_CODES,
  STAGE_LABELS,
  stageLabel,
  WORKFLOW_TERMS,
  PENDING_TERM_OF_STAGE,
  pendingTermOfStage,
  STAGE_PHASE,
  stageMoveProblem,
  STAGE_OWNER_ACTION,
  applicationOwner,
  applicationWaitingOn,
  followUpNeed,
  FOLLOWUP_NEED,
  applicationNextAction,
  NEXT_ACTION_BY_STAGE,
  NEXT_ACTION_INTERNAL,
  nextActionForStage,
  applicationDueDate,
  applicationIsOverdue,
  setDueDateResolver,
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
  INTERVIEW_KINDS,
  INTERVIEW_SLOT_TYPES,
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
